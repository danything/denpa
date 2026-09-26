using System.Buffers;
using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// ARIB STD-B25 を解く。**TS を読んで ECM を拾い、鍵を貰って MULTI2 で解く** (Cas.cs)。
///
/// <para>
/// 道筋は PAT → PMT → CA 記述子。CA 記述子 (番組全体、または ES ごと) が「この ES の鍵は
/// この PID の ECM から」を教えてくれるので、ES の PID から ECM を引く表を作る。
/// **libaribb25 と同じく、流れの順に1パケットずつ読み、ECM の中身が変わったらその場で鍵を貰う**
/// (<see cref="IKeySource.Ecm"/>)。後ろのパケットはその鍵で解く。答えを待つあいだ次のパケットへ
/// 進まないので、鍵と流れの位置が食い違いようがない。カードが固まっても読み手を止めないのは
/// 呼ぶ側の仕事 (TunerPool.cs は読み手と別のスレッドで解く)。
/// </para>
///
/// <para>
/// **解けないものは落とさずに素通しする。** 録れないよりまし、で、解けなかったことは
/// <see cref="Undecodable"/> と <see cref="LastError"/> で分かる。鍵の相手が失敗しても投げない —
/// 鍵を捨てて素通しし (古い鍵で化けたものを「解けた」として流さない)、少し置いて同じ ECM を聞き直す。
/// </para>
///
/// <para>
/// 1つの実体は**1本の流れからだけ**呼ぶ。実体どうしで共有するものは無いので、チューナーが
/// 何本あっても壊し合わない (libaribb25 の頃は1つの実体に2本入ってプロセスごと落ちた)。
/// 数え (<see cref="Decoded"/> など) だけは他のスレッドから覗いてよい。
/// </para>
/// </summary>
public sealed class Descrambler(IKeySource source)
{
    private const int PacketSize = 188;
    private const byte SyncByte = 0x47;

    /// <summary>
    /// 頭で溜める上限。**超えたら揃うのを待たずに流し始める。** PAT・PMT・ECM はどれも 0.1 秒ほどの
    /// 間隔で来るので普通は 1MB も溜まらない。揃わないのはカードに合わない局か壊れた TS で、
    /// 待ち続けると何も出てこなくなる。8MB は衛星の中継器まるごと (6MB/秒ほど) でも 1 秒ちょっと
    /// </summary>
    public const int HoldLimit = 8 * 1024 * 1024;

    /// <summary>B-CAS の CA_system_id。カードから聞けるまではこれで CA 記述子を選ぶ</summary>
    private const int BcasSystemId = 0x0005;

    /// <summary>
    /// 貰えなかった ECM を同じ中身のまま聞き直すまでのパケット数 (地上波の 2 秒ほど)。**時計ではなく
    /// 読んだ量で数える** — ファイルは実時間より速く読むので、時計で待つと数分ぶんが掛かったまま残る
    /// </summary>
    private const long RetryPackets = 25_000;

    private byte[] _carry = new byte[PacketSize * 2];
    private int _carryLength;
    private bool _synced;
    private long _packets;

    /// <summary>頭で溜めている間は true。溜めたパケットは <see cref="_hold"/> に <see cref="_held"/> 個</summary>
    private bool _holding = true;
    private byte[]? _hold;
    private int _held;

    private readonly Section _pat = new(null);
    private byte[]? _patLast;
    /// <summary>program_number → PMT の PID</summary>
    private readonly Dictionary<int, int> _programs = [];
    /// <summary>PMT の PID → 組み立て中の節 (1つの PID に複数の番組が乗ることもある)</summary>
    private readonly Dictionary<int, Section> _pmtSections = [];
    /// <summary>program_number → 最後に受けた PMT。CA の方式が変わったら読み直せるように丸ごと持つ</summary>
    private readonly Dictionary<int, byte[]> _pmts = [];
    /// <summary>PAT の PMT がみな来た / PAT が変わってから同じ PMT がもう一度来た (1周で来ない PMT は来ない)</summary>
    private bool _allPmts, _pmtRepeated;
    private readonly Dictionary<int, Ecm> _ecms = [];
    /// <summary>ES の PID → 鍵。表を引くだけにして、パケットごとの手間を無くす</summary>
    private readonly Ecm?[] _route = new Ecm?[8192];
    /// <summary>
    /// ECM が1本だけなら、PMT に載っていない PID もそれで解く。**PAT の PMT がみな来てから** —
    /// 来ていない番組の ES を別の ECM の鍵で解かない
    /// </summary>
    private Ecm? _only;

    private CardInit? _init;
    private int _caSystemId = BcasSystemId;
    private string? _logged;
    private long _decoded, _undecodable, _unentitled, _dropped;

    /// <summary>解いたパケットの数</summary>
    public long Decoded => Volatile.Read(ref _decoded);

    /// <summary>掛かっていたのに鍵が無くて**そのまま流した**パケットの数 (契約の無いものは数えない)</summary>
    public long Undecodable => Volatile.Read(ref _undecodable);

    /// <summary>**契約が無くて**そのまま流した数。解けなかったのではなく資格が無い (同じ TS に乗る有料局)</summary>
    public long Unentitled => Volatile.Read(ref _unentitled);

    /// <summary>188 バイトの並びに乗らず捨てたバイト数 (途中から読み始めた頭や、壊れたところ)</summary>
    public long Dropped => Volatile.Read(ref _dropped);

    /// <summary>最後に鍵を貰えなかった理由。**録画が掛かったままだったときに見せる**</summary>
    public string? LastError { get; private set; }

    /// <summary>
    /// 読んだぶんを解いて <paramref name="output"/> に書く。入れた長さと出る長さは揃わない —
    /// 188 バイトに満たない尻尾は次まで残し、頭は揃うまで溜める (<see cref="HoldLimit"/>)
    /// </summary>
    public void Decode(ReadOnlySpan<byte> input, IBufferWriter<byte> output)
    {
        if (_carryLength > 0)
        {
            // 前の尻尾 (188 バイト以下) に続けて読む
            var total = _carryLength + input.Length;
            if (total > _carry.Length) Array.Resize(ref _carry, total);
            input.CopyTo(_carry.AsSpan(_carryLength));
            input = _carry.AsSpan(0, total);
        }
        var used = Scan(input, output);
        input[used..].CopyTo(_carry);
        _carryLength = input.Length - used;
    }

    /// <summary>溜めているぶんを吐き出す。**終わりに1回**。尻尾の半端なバイトは捨てる</summary>
    public void Flush(IBufferWriter<byte> output)
    {
        var whole = _carryLength >= PacketSize && _carry[0] == SyncByte;
        if (whole) Take(_carry.AsSpan(0, PacketSize), output);
        _dropped += _carryLength - (whole ? PacketSize : 0);
        _carryLength = 0;
        if (_holding) Settle();
        Release(output);
    }

    /// <summary>
    /// 中身を忘れる。**チャンネルを変えたとき** — 前の PMT と鍵が残っていると、次の ECM まで前の鍵で
    /// 解こうとする。数えも溜めも捨てる。カードの定数 (<see cref="CardInit"/>) だけは持ち越す
    /// </summary>
    public void Reset()
    {
        _carryLength = _held = 0;
        _synced = _allPmts = _pmtRepeated = false;
        _holding = true;
        _hold = _patLast = null;
        _pat.Drop();
        _programs.Clear();
        _pmtSections.Clear();
        _pmts.Clear();
        _ecms.Clear();
        Array.Clear(_route);
        _only = null;
        _logged = LastError = null;
        Volatile.Write(ref _decoded, 0);
        Volatile.Write(ref _undecodable, 0);
        Volatile.Write(ref _unentitled, 0);
        Volatile.Write(ref _dropped, 0);
    }

    /// <summary>188 バイトずつ切り出す。読み進めたバイト数を返す (残りは 188 バイト以下)</summary>
    private int Scan(ReadOnlySpan<byte> data, IBufferWriter<byte> output)
    {
        var at = 0;
        while (data.Length - at >= PacketSize)
        {
            if (_synced && data[at] == SyncByte)
            {
                Take(data.Slice(at, PacketSize), output);
                at += PacketSize;
                continue;
            }
            // 並びが崩れた。**0x47 が 188 バイトおきに2つ続くところ**で合わせ直す (1つだけだと中身の 0x47 に釣られる)
            _synced = false;
            var found = at;
            while (found + PacketSize < data.Length && (data[found] != SyncByte || data[found + PacketSize] != SyncByte)) found++;
            _dropped += found - at;
            at = found;
            // 最後の 188 バイトの中の 0x47 は、次が来るまで本物か分からない
            if (found + PacketSize >= data.Length) return at;
            _synced = true;
        }
        return at;
    }

    /// <summary>
    /// 1 パケット。節を読み (ECM ならここで鍵を貰う)、溜めている間は溜めの後ろへ、
    /// そうでなければ出口へ写してその場で解く (**写すのは1回だけ**)
    /// </summary>
    private void Take(ReadOnlySpan<byte> packet, IBufferWriter<byte> output)
    {
        _packets++;
        // 誤りの印が立っているものは中身を信じない
        if ((packet[1] & 0x80) == 0 && packet[3] >> 6 == 0) Parse(packet);

        var held = _holding;
        if (held)
        {
            _hold ??= new byte[PacketSize * 1024];
            if ((_held + 1) * PacketSize > _hold.Length) Array.Resize(ref _hold, _hold.Length * 2);
            packet.CopyTo(_hold.AsSpan(_held++ * PacketSize));
            // ECM のあとで最初に来た、その鍵の ES のパケット (Settle)
            if ((packet[1] & 0x80) == 0 && packet[3] >> 6 != 0 && Route(packet) is { Seen: >= 0, After: int.MaxValue } ecm) ecm.After = _held - 1;
            if (Ready()) Settle();
        }
        Release(output);
        if (held) return;

        var room = output.GetSpan(PacketSize)[..PacketSize];
        packet.CopyTo(room);
        Unscramble(room, Route(room), usable: true);
        output.Advance(PacketSize);
    }

    private Ecm? Route(ReadOnlySpan<byte> packet) => _route[((packet[1] & 0x1F) << 8) | packet[2]] ?? _only;

    /// <summary>掛かっていたら解く。誤りの印が立っているものは触らない</summary>
    private void Unscramble(Span<byte> packet, Ecm? ecm, bool usable)
    {
        if ((packet[1] & 0x80) != 0 || packet[3] >> 6 == 0) return;
        var start = PayloadStart(packet);
        if (start == PacketSize)
        {
            // 中身の無いパケット (アダプテーションだけ) は、印を下ろすだけで済む
            packet[3] &= 0x3F;
            _decoded++;
        }
        else if (ecm is { Unentitled: true }) _unentitled++;
        else if (start < 0 || !usable || ecm?.Cipher is not { HasKeys: true } cipher) _undecodable++;
        else
        {
            // 0b10 が偶数、0b11 が奇数 (0b01 は使われないが、奇数の鍵で解く)
            cipher.Decrypt(packet[3] >> 6 == 2, packet[start..]);
            packet[3] &= 0x3F;
            _decoded++;
        }
    }

    /// <summary>
    /// 溜めるのをやめてよいか。**PAT と、その PMT がみな来て、どの ECM も1回は答えを貰った** (libaribb25 と同じ)
    /// うえで、ECM のあとにその鍵の ES のパケットが1つ来た (<see cref="Settle"/>)。
    /// 来ない PMT は1周で見切り、同じ ECM が2回来たら来ない ECM も見切る (<see cref="OnEcm"/>)
    /// </summary>
    private bool Ready()
    {
        if ((long)_held * PacketSize >= HoldLimit)
        {
            Log.Write($"PAT・PMT・ECM が揃う前に {HoldLimit / 1024 / 1024}MB 溜まったので、待たずに流します");
            return true;
        }
        if (_patLast is null || !(_allPmts || _pmtRepeated)) return false;
        foreach (var ecm in _ecms.Values)
        {
            if (ecm.Last is null || (ecm.Seen >= 0 && ecm.After == int.MaxValue)) return false;
        }
        return true;
    }

    /// <summary>
    /// 溜めたぶんを最初の鍵で解いておく (出すのは <see cref="Release"/>)。溜めている間に来る中身は
    /// ECM ごとに1つだけ (2つ目が来る前にここへ来る) なので、鍵は取り違えない。
    ///
    /// <para>
    /// **ECM より前のパケットは、ECM を挟んで続いている偶奇の並びだけ解く。** ECM が持つのは今と次の
    /// 鍵で、ECM のあとに流れる鍵はそのどちらか。並びが途切れる前は前の鍵かもしれず、解くと化けたものを
    /// 「解けた」として流す (libaribb25 は溜めた頭を丸ごと解いていた)。ECM の手前で途切れた並びも解かない —
    /// 切り替わった直後に来た ECM は、もう前の鍵を持っていない。後ろから読み、ECM ごとに「この先で最初に
    /// 偶奇が変わる位置」を持って、それが ECM のあとの最初のパケット (<see cref="Ecm.After"/>) より後ろなら
    /// 解く。**並びは ES ごとでなく ECM ごとに見る** — 音声のように疎らな ES だけ見ると、偶奇が行って
    /// 戻ったのを見逃す
    /// </para>
    /// </summary>
    private void Settle()
    {
        _holding = false;
        for (var at = _held - 1; at >= 0; at--)
        {
            var packet = _hold.AsSpan(at * PacketSize, PacketSize);
            var control = packet[3] >> 6;
            if ((packet[1] & 0x80) != 0 || control == 0) continue;
            var ecm = Route(packet);
            if (ecm is not null)
            {
                if (ecm.Parity != control) ecm.Change = ecm.Next;
                ecm.Parity = control;
                ecm.Next = at;
            }
            Unscramble(packet, ecm, ecm is { Seen: >= 0 } && (at > ecm.Seen || ecm.Change > ecm.After));
        }
    }

    private void Release(IBufferWriter<byte> output)
    {
        if (_holding || _held == 0) return;
        output.Write(_hold.AsSpan(0, _held * PacketSize));
        _hold = null;
        _held = 0;
    }

    /// <summary>中身の始まり。中身が無ければ 188、アダプテーションの長さが壊れていれば -1</summary>
    private static int PayloadStart(ReadOnlySpan<byte> packet)
    {
        var control = (packet[3] >> 4) & 0x03;
        if ((control & 0x01) == 0) return PacketSize;
        if ((control & 0x02) == 0) return 4;
        var start = 5 + packet[4];
        return start <= PacketSize ? start : -1;
    }

    private void Parse(ReadOnlySpan<byte> packet)
    {
        var start = PayloadStart(packet);
        if (start is < 0 or PacketSize) return;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        var section = pid == 0 ? _pat
            : _pmtSections.TryGetValue(pid, out var pmt) ? pmt
            : _ecms.TryGetValue(pid, out var ecm) ? ecm.Section : null;
        if (section is not null) Feed(section, pid, packet[start..], (packet[1] & 0x40) != 0);
    }

    /// <summary>
    /// パケットの中身を節に組み立てる。節はパケットを跨ぐし、1つのパケットに
    /// 幾つも入ることもある (pointer_field が次の節の頭を指す)
    /// </summary>
    private void Feed(Section section, int pid, ReadOnlySpan<byte> payload, bool unitStart)
    {
        if (!unitStart)
        {
            if (section.Active) Fill(section, pid, payload);
            return;
        }
        var pointer = payload[0];
        payload = payload[1..];
        // pointer_field の手前は前の節の続き。そこで揃わなければ捨てる
        if (section.Active && pointer <= payload.Length) Fill(section, pid, payload[..pointer]);
        section.Drop();
        if (pointer > payload.Length) return;
        // 揃った節は捨てられるので、揃わない節 (次のパケットへ続く) に当たるまで読む。0xFF は詰め物で、その先に節は無い
        for (payload = payload[pointer..]; !payload.IsEmpty && payload[0] != 0xFF && !section.Active;)
        {
            section.Start();
            payload = payload[Fill(section, pid, payload)..];
        }
    }

    /// <summary>節に足し、揃ったら読む。取り込んだバイト数を返す</summary>
    private int Fill(Section section, int pid, ReadOnlySpan<byte> data)
    {
        var taken = section.Append(data);
        if (section.Complete) Complete(section, pid);
        return taken;
    }

    private void Complete(Section section, int pid)
    {
        var bytes = section.Bytes;
        section.Drop();
        // PAT・PMT・ECM はどれも CRC を持つ形。**化けた節で鍵を聞き直さない**
        if ((bytes[1] & 0x80) == 0 || bytes.Length < 12 || Crc32(bytes) != 0) return;
        if (pid == 0) OnPat(bytes);
        else if (section.Owner is { } ecm) OnEcm(ecm, bytes);
        else OnPmt(pid, bytes);
    }

    private void OnPat(ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x00 || (_patLast is not null && section.SequenceEqual(_patLast))) return;
        _patLast = section.ToArray();
        _programs.Clear();
        var loop = section[8..^4];
        for (var at = 0; at + 4 <= loop.Length; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(loop[at..]);
            // 番組 0 は NIT の在りか。PMT ではない
            if (number != 0) _programs[number] = BinaryPrimitives.ReadUInt16BigEndian(loop[(at + 2)..]) & 0x1FFF;
        }
        foreach (var pid in _pmtSections.Keys.Except(_programs.Values).ToList()) _pmtSections.Remove(pid);
        foreach (var pid in _programs.Values) _pmtSections.TryAdd(pid, new Section(null));
        foreach (var number in _pmts.Keys.Except(_programs.Keys).ToList()) _pmts.Remove(number);
        // 番組が変わった。来ていない PMT をもう一度待つ
        _pmtRepeated = false;
        Rebuild();
    }

    private void OnPmt(int pid, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x02) return;
        var number = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        if (!_programs.TryGetValue(number, out var expected) || expected != pid) return;
        if (_pmts.TryGetValue(number, out var last) && section.SequenceEqual(last))
        {
            _pmtRepeated = true;
            return;
        }
        _pmts[number] = section.ToArray();
        Rebuild();
    }

    /// <summary>
    /// ES → ECM の表を作り直す。PAT か PMT が変わったとき (まれ) だけ。
    /// 引き続き要る ECM は鍵ごと残す — 作り直すと次の ECM が来るまで解けなくなる
    /// </summary>
    private void Rebuild()
    {
        var streams = new List<(int Es, int Ecm)>();
        var wanted = new HashSet<int>();
        foreach (var pmt in _pmts.Values) Streams(pmt, _caSystemId, streams, wanted);
        foreach (var pid in _ecms.Keys.Except(wanted).ToList()) _ecms.Remove(pid);
        foreach (var pid in wanted) _ecms.TryAdd(pid, new Ecm());
        Array.Clear(_route);
        foreach (var (es, ecm) in streams) _route[es] = _ecms[ecm];
        _allPmts = _patLast is not null && _programs.Keys.All(_pmts.ContainsKey);
        _only = _allPmts && _ecms.Count == 1 ? _ecms.Values.First() : null;
    }

    /// <summary>PMT から、掛かっている ES とその ECM の PID を拾う。**ES ごとの CA 記述子が番組全体のものより優先する**</summary>
    private static void Streams(ReadOnlySpan<byte> pmt, int caSystemId, List<(int Es, int Ecm)> streams, HashSet<int> ecms)
    {
        var end = pmt.Length - 4;
        var at = 12 + (BinaryPrimitives.ReadUInt16BigEndian(pmt[10..]) & 0x0FFF);
        if (at > end) return;
        var common = CaPid(pmt[12..at], caSystemId);
        if (common >= 0) ecms.Add(common);
        while (at + 5 <= end)
        {
            var es = BinaryPrimitives.ReadUInt16BigEndian(pmt[(at + 1)..]) & 0x1FFF;
            var length = BinaryPrimitives.ReadUInt16BigEndian(pmt[(at + 3)..]) & 0x0FFF;
            at += 5;
            if (at + length > end) return;
            var own = CaPid(pmt.Slice(at, length), caSystemId);
            at += length;
            var ecm = own >= 0 ? own : common;
            if (ecm < 0) continue;
            ecms.Add(ecm);
            streams.Add((es, ecm));
        }
    }

    /// <summary>CA 記述子 (0x09) から、このカードの方式の ECM の PID。無ければ -1</summary>
    private static int CaPid(ReadOnlySpan<byte> descriptors, int caSystemId)
    {
        for (var at = 0; at + 2 <= descriptors.Length; at += 2 + descriptors[at + 1])
        {
            var length = descriptors[at + 1];
            var body = descriptors[(at + 2)..];
            if (descriptors[at] != 0x09 || length < 4 || length > body.Length) continue;
            if (BinaryPrimitives.ReadUInt16BigEndian(body) != caSystemId) continue;
            var pid = BinaryPrimitives.ReadUInt16BigEndian(body[2..]) & 0x1FFF;
            // 0x1FFF は「無い」の意味で置かれる
            return pid is 0 or 0x1FFF ? -1 : pid;
        }
        return -1;
    }

    /// <summary>
    /// ECM を受けた。**中身が変わっていたら、その場で鍵を貰う。** 同じ中身なら、貰えなかったものだけ
    /// 少し置いて聞き直す。溜めている間に同じ PID の ECM がもう一度来たら、そこで溜めるのをやめる —
    /// 1周しても来ない ECM は来ないし、中身が変わる前に溜めを最初の鍵で解いておく (<see cref="Settle"/>)
    /// </summary>
    private void OnEcm(Ecm ecm, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x82) return;
        if (_holding && ecm.Last is not null) Settle();
        if (ecm.Last is { } last && section.SequenceEqual(last))
        {
            if (_packets >= ecm.RetryAt) Ask(ecm);
            return;
        }
        ecm.Last = section.ToArray();
        if (_holding) ecm.Seen = _held;
        Ask(ecm);
    }

    /// <summary>
    /// 鍵を貰って入れる。**失敗したら鍵を捨てる** — 古い鍵で解き続けると化けたものを流す。
    /// **渡すのは節の頭 8 バイトと末尾の CRC 4 バイトを除いた中身** — libaribb25 と同じ切り方で、
    /// 拠点を跨いで鍵を貰う線 (CardShare.cs) もこれを運ぶ。変えると古いエージェントと話が通じなくなる
    /// </summary>
    private void Ask(Ecm ecm)
    {
        ecm.RetryAt = long.MaxValue;
        ecm.Unentitled = false;
        ecm.Cipher?.Clear();
        try
        {
            if (_init is null)
            {
                _init = source.Init();
                // A-CAS など B-CAS 以外のカードなら、CA 記述子を選び直す (この ECM はもう要らないかもしれない)
                if (_init.CaSystemId != _caSystemId)
                {
                    _caSystemId = _init.CaSystemId;
                    ecm.Last = null;
                    Rebuild();
                    return;
                }
            }
            var section = ecm.Last!;
            var answer = source.Ecm(section.AsSpan(8, section.Length - 12));
            // 0x0200・0x0400・0x0800 が「見てよい」。それ以外は契約が無い
            if (answer.Code is not (0x0200 or 0x0400 or 0x0800))
            {
                ecm.Unentitled = true;
                Report($"カードが鍵を出しません (契約が無いか、別の方式の局: 0x{answer.Code:X4})");
                return;
            }
            ecm.Cipher ??= new Multi2(_init.SystemKey, _init.InitCbc);
            ecm.Cipher.SetKeys(answer.Odd, answer.Even);
            if (_logged is not null) Log.Write("鍵を貰えるようになりました");
            _logged = null;
        }
        catch (Exception error)
        {
            ecm.RetryAt = _packets + RetryPackets;
            Report(error.Message);
        }
    }

    private void Report(string message)
    {
        LastError = message;
        if (_logged != message) Log.Write($"鍵を貰えません: {message}");
        _logged = message;
    }

    /// <summary>MPEG-2 の CRC32。節の末尾の CRC まで含めて回すと 0 になる</summary>
    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in data) crc = (crc << 8) ^ CrcTable[(crc >> 24) ^ value];
        return crc;
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(index =>
    {
        var crc = (uint)index << 24;
        for (var bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        return crc;
    }).ToArray();

    /// <summary>1本の ECM と、その鍵</summary>
    private sealed class Ecm
    {
        public Ecm() => Section = new Section(this);

        public Section Section { get; }
        /// <summary>最後に受けた中身 (その鍵を貰った・貰おうとした中身)</summary>
        public byte[]? Last;
        /// <summary>鍵。貰えなかったら空 (<see cref="Multi2.HasKeys"/>)</summary>
        public Multi2? Cipher;
        /// <summary>カードが「契約が無い」と答えた</summary>
        public bool Unentitled;
        /// <summary>貰えなかった。読んだパケットの数がここを過ぎたら、同じ中身でも聞き直す</summary>
        public long RetryAt = long.MaxValue;
        /// <summary>溜めている間に最初の中身を受けた位置 (溜めの中の番号)。まだなら -1</summary>
        public int Seen = -1;
        /// <summary>そのあとで最初に来た、この鍵の ES のパケットの位置</summary>
        public int After = int.MaxValue;
        /// <summary><see cref="Settle"/> が後ろから読む間だけ使う。すぐ後ろの偶奇と位置、その先で最初に偶奇が変わる位置</summary>
        public int Parity, Next = int.MaxValue, Change = int.MaxValue;
    }

    /// <summary>組み立て中の節。長さは頭 3 バイトで決まる (最長 3 + 4095)。長さが -1 なら組み立てていない</summary>
    private sealed class Section(Ecm? owner)
    {
        private readonly byte[] _buffer = new byte[3 + 0x0FFF];
        private int _length = -1;

        public Ecm? Owner => owner;
        public bool Active => _length >= 0;
        private int Total => _length < 3 ? 3 : 3 + (((_buffer[1] & 0x0F) << 8) | _buffer[2]);
        public bool Complete => _length >= 3 && _length == Total;
        public ReadOnlySpan<byte> Bytes => _buffer.AsSpan(0, _length);
        public void Start() => _length = 0;
        public void Drop() => _length = -1;

        /// <summary>要るぶんだけ取り込み、取り込んだバイト数を返す</summary>
        public int Append(ReadOnlySpan<byte> data)
        {
            var taken = 0;
            while (taken < data.Length && _length < Total) _buffer[_length++] = data[taken++];
            return taken;
        }
    }
}
