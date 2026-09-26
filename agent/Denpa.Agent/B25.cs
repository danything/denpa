using System.Buffers;
using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// ARIB STD-B25 を解く。**TS を読んで ECM を拾い、鍵を貰って MULTI2 で解く** (Cas.cs)。
///
/// <para>
/// 道筋は PAT → PMT → CA 記述子。PMT の CA 記述子 (番組全体、または ES ごと) が
/// 「この ES の鍵はこの PID の ECM から」を教えてくれるので、ES の PID から ECM を引く表を作る。
/// ECM の中身が変わったら <see cref="IKeySource.Ecm"/> に渡して鍵を貰い直す。
/// </para>
///
/// <para>
/// **解けないものは落とさずに素通しする。** 録れないよりまし、で、解けなかったことは
/// <see cref="Undecodable"/> と <see cref="LastError"/> で分かる。鍵の相手が失敗しても
/// 投げない — 次に ECM が変わったとき (数秒後) にもう一度聞く。
/// </para>
///
/// <para>
/// 1つの実体は**1本の読み手からだけ**呼ぶ。実体どうしで共有するものは何も無いので、
/// チューナーが何本あっても互いに壊し合わない (libaribb25 の頃は1つの実体に2本入って
/// プロセスごと落ちた)。数え (<see cref="Decoded"/> など) だけは他のスレッドから覗いてよい。
/// </para>
/// </summary>
public sealed class Descrambler(IKeySource source)
{
    private const int PacketSize = 188;
    private const byte SyncByte = 0x47;

    /// <summary>
    /// 初めに鍵を待って溜める上限。**これを超えたら、鍵が無くてもそのまま流し始める。**
    ///
    /// <para>
    /// 溜めるのは、録画の頭が掛かったままにならないようにするため。PAT・PMT・ECM は
    /// どれも 0.1 秒ほどの間隔で来るので、普通は 1MB も溜まらずに揃う。揃わないのは
    /// カードに合わない局か壊れた TS で、そのときに待ち続けると何も出てこなくなる。
    /// 8MB は衛星の中継器まるごと (6MB/秒ほど) でも 1 秒ちょっと
    /// </para>
    /// </summary>
    public const int HoldLimit = 8 * 1024 * 1024;

    /// <summary>B-CAS の CA_system_id。カードから聞けるまではこれで CA 記述子を選ぶ</summary>
    private const int BcasSystemId = 0x0005;

    private readonly byte[] _carry = new byte[PacketSize * 2];
    private readonly byte[] _joint = new byte[PacketSize * 4];
    private int _carryLength;
    private bool _synced;

    private bool _holding = true;
    private byte[]? _held;
    private int _heldLength;
    private bool _sectionSeen;
    private bool _pmtRepeated;
    private bool _ecmRepeated;

    private readonly Section _pat = new(null);
    private byte[]? _patLast;
    /// <summary>program_number → PMT の PID (PAT の中身)</summary>
    private readonly Dictionary<int, int> _programs = [];
    /// <summary>PMT の PID → 組み立て中の節。**1つの PID に複数の番組が乗ることもある**</summary>
    private readonly Dictionary<int, Section> _pmtSections = [];
    /// <summary>program_number → 最後に受けた PMT。CA の番号が変わったら読み直せるように丸ごと持つ</summary>
    private readonly Dictionary<int, byte[]> _pmts = [];
    /// <summary>ECM の PID → 鍵</summary>
    private readonly Dictionary<int, Ecm> _ecms = [];
    /// <summary>ES の PID → 鍵。8192 本の表を引くだけにして、パケットごとの手間を無くす</summary>
    private readonly Ecm?[] _route = new Ecm?[8192];
    /// <summary>ECM が1本だけなら、PMT に載っていない PID が掛かっていてもそれで解く</summary>
    private Ecm? _only;

    private CardInit? _init;
    private int _caSystemId = BcasSystemId;
    private string? _logged;

    private long _decoded;
    private long _undecodable;
    private long _dropped;

    /// <summary>解いたパケットの数</summary>
    public long Decoded => Volatile.Read(ref _decoded);

    /// <summary>掛かっていたのに鍵が無くて**そのまま流した**パケットの数</summary>
    public long Undecodable => Volatile.Read(ref _undecodable);

    /// <summary>188 バイトの並びに乗らず捨てたバイト数 (途中から読み始めた頭や、壊れたところ)</summary>
    public long Dropped => Volatile.Read(ref _dropped);

    /// <summary>最後に鍵を貰えなかった理由。**録画が掛かったままだったときに見せる**</summary>
    public string? LastError { get; private set; }

    /// <summary>
    /// 読んだぶんを解いて <paramref name="output"/> に書く。
    ///
    /// <para>
    /// 入れた長さと出る長さは揃わない。188 バイトに満たない尻尾は次の呼び出しまで残し、
    /// 初めのうちは鍵が揃うまで溜める (<see cref="HoldLimit"/>)。
    /// </para>
    /// </summary>
    public void Decode(ReadOnlySpan<byte> input, IBufferWriter<byte> output)
    {
        /*
         * 前の尻尾があれば、入力の頭を少し足して続きから読む。尻尾は 188 バイト以下で、
         * 足したあとは 564 バイト以上あるので、並びが合っていれば尻尾は必ず出ていく
         */
        while (_carryLength > 0 && !input.IsEmpty)
        {
            var take = Math.Min(input.Length, _joint.Length - _carryLength);
            _carry.AsSpan(0, _carryLength).CopyTo(_joint);
            input[..take].CopyTo(_joint.AsSpan(_carryLength));
            var total = _carryLength + take;
            var used = Scan(_joint.AsSpan(0, total), output);
            if (used >= _carryLength)
            {
                input = input[(used - _carryLength)..];
                _carryLength = 0;
            }
            else
            {
                // 読み切れなかったのは入力が短いときだけ。残りを丸ごと尻尾にする
                _joint.AsSpan(used, total - used).CopyTo(_carry);
                _carryLength = total - used;
                input = [];
            }
        }

        var consumed = Scan(input, output);
        input[consumed..].CopyTo(_carry.AsSpan(_carryLength));
        _carryLength += input.Length - consumed;
    }

    /// <summary>溜めているぶんを吐き出す。**終わりに1回**。尻尾の半端なバイトは捨てる</summary>
    public void Flush(IBufferWriter<byte> output)
    {
        if (_carryLength >= PacketSize && _carry[0] == SyncByte)
        {
            Take(_carry.AsSpan(0, PacketSize), output);
            _dropped += _carryLength - PacketSize;
        }
        else
        {
            _dropped += _carryLength;
        }
        _carryLength = 0;
        if (_holding) Release(output);
    }

    /// <summary>
    /// 中身を忘れる。**チャンネルを変えたとき。**
    ///
    /// <para>
    /// 前のチャンネルの PMT と鍵が残っていると、次の ECM が来るまで前の鍵で解こうとする。
    /// 数えも 0 に戻す。カードの定数 (<see cref="CardInit"/>) だけはカードが同じなので持ち越す。
    /// </para>
    /// </summary>
    public void Reset()
    {
        _carryLength = 0;
        _synced = false;
        _holding = true;
        _held = null;
        _heldLength = 0;
        _sectionSeen = _pmtRepeated = _ecmRepeated = false;
        _pat.Drop();
        _patLast = null;
        _programs.Clear();
        _pmtSections.Clear();
        _pmts.Clear();
        _ecms.Clear();
        Array.Clear(_route);
        _only = null;
        _logged = null;
        LastError = null;
        Volatile.Write(ref _decoded, 0);
        Volatile.Write(ref _undecodable, 0);
        Volatile.Write(ref _dropped, 0);
    }

    /// <summary>
    /// 188 バイトずつ切り出す。**並びが崩れたら、0x47 が 188 バイトおきに2つ続く
    /// ところを探して合わせ直す** (1つだけだと中身の 0x47 に釣られる)。
    /// 読み進めたバイト数を返す。残りは 188 バイト以下
    /// </summary>
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

            _synced = false;
            var found = -1;
            for (var probe = at; probe + PacketSize < data.Length; probe++)
            {
                var next = data[probe..(data.Length - PacketSize)].IndexOf(SyncByte);
                if (next < 0) break;
                probe += next;
                if (data[probe + PacketSize] == SyncByte)
                {
                    found = probe;
                    break;
                }
            }
            if (found < 0)
            {
                // 最後の 188 バイトの中の 0x47 は、次が来るまで本物か分からない
                var keep = Math.Max(at, data.Length - PacketSize);
                _dropped += keep - at;
                return keep;
            }
            _dropped += found - at;
            at = found;
            _synced = true;
        }
        return at;
    }

    private void Take(ReadOnlySpan<byte> packet, IBufferWriter<byte> output)
    {
        if (_holding)
        {
            Hold(packet, output);
            return;
        }
        var room = output.GetSpan(PacketSize)[..PacketSize];
        packet.CopyTo(room);
        Process(room);
        output.Advance(PacketSize);
    }

    /// <summary>
    /// 鍵が揃うまで溜める。溜めている間も PAT・PMT・ECM は読み進め、揃ったら頭から解いて出す。
    ///
    /// <para>
    /// **揃う**とは、PAT の番組の PMT がみな来て、PMT が指す ECM をみなカードに聞き終えたこと。
    /// どれかが2周目に入ったら、来ないものは待たない (1周で来ないものは来ない)。
    /// 聞いた結果が失敗でも揃ったことにする — 待っても鍵は来ない。
    /// </para>
    /// </summary>
    private void Hold(ReadOnlySpan<byte> packet, IBufferWriter<byte> output)
    {
        if (_held is null || _heldLength + PacketSize > _held.Length)
        {
            Array.Resize(ref _held, Math.Max(PacketSize * 1024, (_held?.Length ?? 0) * 2));
        }
        packet.CopyTo(_held.AsSpan(_heldLength));
        _heldLength += PacketSize;

        if ((packet[1] & 0x80) == 0 && packet[3] >> 6 == 0) Parse(packet, scanning: true);

        if (_sectionSeen)
        {
            _sectionSeen = false;
            if (Ready())
            {
                Release(output);
                return;
            }
        }
        if (_heldLength >= HoldLimit)
        {
            Log.Write($"鍵が揃わないまま {HoldLimit / 1024 / 1024}MB 溜まったので、そのまま流します");
            Release(output);
        }
    }

    private bool Ready()
    {
        if (_patLast is null) return false;
        if (!_pmtRepeated)
        {
            foreach (var number in _programs.Keys)
            {
                if (!_pmts.ContainsKey(number)) return false;
            }
        }
        if (!_ecmRepeated)
        {
            foreach (var ecm in _ecms.Values)
            {
                if (!ecm.Attempted) return false;
            }
        }
        return true;
    }

    /// <summary>
    /// 溜めたぶんを頭から流す。**節の組み立ては初めからやり直す**が、最後に受けた中身は
    /// 覚えているので、同じ PAT・PMT・ECM はもう一度読まない (カードにも聞き直さない)。
    /// ECM は今と次の鍵を両方持っているので、ECM より前のパケットもその鍵で解ける
    /// </summary>
    private void Release(IBufferWriter<byte> output)
    {
        _holding = false;
        _pat.Drop();
        foreach (var section in _pmtSections.Values) section.Drop();
        foreach (var ecm in _ecms.Values) ecm.Section.Drop();

        var held = _held;
        var length = _heldLength;
        _held = null;
        _heldLength = 0;
        for (var at = 0; at < length; at += PacketSize) Take(held.AsSpan(at, PacketSize), output);
    }

    /// <summary>1 パケットをその場で解く。掛かっていないものは中の節を読む</summary>
    private void Process(Span<byte> packet)
    {
        // 誤りの印が立っているものは中身を信じない。触らずに流す
        if ((packet[1] & 0x80) != 0) return;

        var control = packet[3] >> 6;
        if (control == 0)
        {
            Parse(packet, scanning: false);
            return;
        }

        var start = PayloadStart(packet);
        if (start < 0)
        {
            _undecodable++;
            return;
        }
        if (start < PacketSize)
        {
            var pid = ((packet[1] & 0x1F) << 8) | packet[2];
            var cipher = (_route[pid] ?? _only)?.Cipher;
            if (cipher is not { HasKeys: true })
            {
                _undecodable++;
                return;
            }
            // 0b10 が偶数、0b11 が奇数 (0b01 は使われないが、奇数の鍵で解く)
            cipher.Decrypt(control == 2, packet[start..]);
        }
        // 中身の無いパケット (アダプテーションだけ) は、印を下ろすだけで済む
        packet[3] &= 0x3F;
        _decoded++;
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

    private void Parse(ReadOnlySpan<byte> packet, bool scanning)
    {
        var start = PayloadStart(packet);
        if (start is < 0 or PacketSize) return;
        var payload = packet[start..];
        var unitStart = (packet[1] & 0x40) != 0;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];

        if (pid == 0) Feed(_pat, pid, payload, unitStart, scanning);
        else if (_pmtSections.TryGetValue(pid, out var pmt)) Feed(pmt, pid, payload, unitStart, scanning);
        else if (_ecms.TryGetValue(pid, out var ecm)) Feed(ecm.Section, pid, payload, unitStart, scanning);
    }

    /// <summary>
    /// パケットの中身を節に組み立てる。節はパケットを跨ぐし、1つのパケットに
    /// 幾つも入ることもある (pointer_field が次の節の頭を指す)
    /// </summary>
    private void Feed(Section section, int pid, ReadOnlySpan<byte> payload, bool unitStart, bool scanning)
    {
        if (!unitStart)
        {
            if (!section.Active) return;
            section.Append(payload);
            if (section.Complete) Complete(section, pid, scanning);
            return;
        }

        var pointer = payload[0];
        var rest = payload[1..];
        if (pointer > rest.Length)
        {
            section.Drop();
            return;
        }
        if (section.Active)
        {
            section.Append(rest[..pointer]);
            if (section.Complete) Complete(section, pid, scanning);
            else section.Drop();
        }
        rest = rest[pointer..];

        // 0xFF は詰め物。そこから先に節は無い
        while (!rest.IsEmpty && rest[0] != 0xFF)
        {
            section.Start();
            rest = rest[section.Append(rest)..];
            if (!section.Complete) return;
            Complete(section, pid, scanning);
        }
    }

    private void Complete(Section section, int pid, bool scanning)
    {
        var bytes = section.Bytes;
        section.Drop();
        // PAT・PMT・ECM はどれも CRC を持つ形。**化けた節で鍵を聞き直さない**
        if ((bytes[1] & 0x80) == 0 || bytes.Length < 12 || Crc32(bytes) != 0) return;

        _sectionSeen = true;
        if (pid == 0) OnPat(bytes);
        else if (section.Owner is { } ecm) OnEcm(ecm, bytes, scanning);
        else OnPmt(pid, bytes, scanning);
    }

    private void OnPat(ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x00) return;
        if (_patLast is not null && section.SequenceEqual(_patLast)) return;
        _patLast = section.ToArray();

        _programs.Clear();
        var loop = section[8..^4];
        for (var at = 0; at + 4 <= loop.Length; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(loop[at..]);
            var pid = BinaryPrimitives.ReadUInt16BigEndian(loop[(at + 2)..]) & 0x1FFF;
            // 番組 0 は NIT の在りか。PMT ではない
            if (number != 0) _programs[number] = pid;
        }

        foreach (var pid in _pmtSections.Keys.Where(pid => !_programs.ContainsValue(pid)).ToList())
        {
            _pmtSections.Remove(pid);
        }
        foreach (var pid in _programs.Values) _pmtSections.TryAdd(pid, new Section(null));
        foreach (var number in _pmts.Keys.Where(number => !_programs.ContainsKey(number)).ToList())
        {
            _pmts.Remove(number);
        }
        Rebuild();
    }

    private void OnPmt(int pid, ReadOnlySpan<byte> section, bool scanning)
    {
        if (section[0] != 0x02) return;
        var number = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        if (!_programs.TryGetValue(number, out var expected) || expected != pid) return;
        if (_pmts.TryGetValue(number, out var last) && section.SequenceEqual(last))
        {
            if (scanning) _pmtRepeated = true;
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

        foreach (var pid in _ecms.Keys.Where(pid => !wanted.Contains(pid)).ToList()) _ecms.Remove(pid);
        foreach (var pid in wanted)
        {
            if (!_ecms.ContainsKey(pid)) _ecms[pid] = new Ecm();
        }

        Array.Clear(_route);
        foreach (var (es, ecm) in streams) _route[es] = _ecms[ecm];
        _only = _ecms.Count == 1 ? _ecms.Values.First() : null;
    }

    /// <summary>
    /// PMT を読んで、掛かっている ES と その ECM の PID を拾う。
    /// **ES ごとの CA 記述子が、番組全体のものより優先する**
    /// </summary>
    private static void Streams(ReadOnlySpan<byte> pmt, int caSystemId, List<(int Es, int Ecm)> streams, HashSet<int> ecms)
    {
        var end = pmt.Length - 4;
        var infoLength = BinaryPrimitives.ReadUInt16BigEndian(pmt[10..]) & 0x0FFF;
        var at = 12 + infoLength;
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
        var at = 0;
        while (at + 2 <= descriptors.Length)
        {
            var tag = descriptors[at];
            var length = descriptors[at + 1];
            var body = descriptors[(at + 2)..];
            at += 2 + length;
            if (tag != 0x09 || length < 4 || length > body.Length) continue;
            if (BinaryPrimitives.ReadUInt16BigEndian(body) != caSystemId) continue;
            var pid = BinaryPrimitives.ReadUInt16BigEndian(body[2..]) & 0x1FFF;
            // 0x1FFF は「無い」の意味で置かれる
            return pid is 0 or 0x1FFF ? -1 : pid;
        }
        return -1;
    }

    /// <summary>
    /// ECM が変わったらカードに聞く。
    ///
    /// <para>
    /// **渡すのは節の頭 8 バイトと末尾の CRC 4 バイトを除いた中身。** libaribb25 が
    /// カードへ渡していたのと同じ切り方で、拠点を跨いで鍵を貰う線 (CardShare.cs) も
    /// この切り方で運んでいる。変えると古いエージェントと話が通じなくなる。
    /// </para>
    /// </summary>
    private void OnEcm(Ecm ecm, ReadOnlySpan<byte> section, bool scanning)
    {
        if (section[0] != 0x82) return;
        // 溜めている間は1本につき1回だけ聞く。2つ目が来たら1周したということ (Hold)
        if (scanning && ecm.Attempted)
        {
            _ecmRepeated = true;
            return;
        }
        if (ecm.Last is not null && section.SequenceEqual(ecm.Last)) return;
        ecm.Last = section.ToArray();
        ecm.Attempted = true;

        try
        {
            if (_init is null)
            {
                _init = source.Init();
                // A-CAS など B-CAS 以外のカードなら、CA 記述子を選び直す
                if (_init.CaSystemId != _caSystemId)
                {
                    _caSystemId = _init.CaSystemId;
                    Rebuild();
                }
            }
            ecm.Cipher ??= new Multi2(_init.SystemKey, _init.InitCbc);

            var answer = source.Ecm(section[8..^4]);
            // 0x0200・0x0400・0x0800 が「見てよい」。それ以外は契約が無い
            if (answer.Code is not (0x0200 or 0x0400 or 0x0800))
            {
                throw new IOException($"カードが鍵を出しません (契約が無いか、別の方式の局: 0x{answer.Code:X4})");
            }
            ecm.Cipher.SetKeys(answer.Odd, answer.Even);

            if (_logged is not null) Log.Write("鍵を貰えるようになりました");
            _logged = null;
        }
        catch (Exception error)
        {
            // **古い鍵で解き続けない。** 掛かったまま流れれば、数えで分かる
            ecm.Cipher?.Clear();
            LastError = error.Message;
            if (_logged != error.Message) Log.Write($"鍵を貰えません: {error.Message}");
            _logged = error.Message;
        }
    }

    /// <summary>MPEG-2 の CRC32。節の末尾の CRC まで含めて回すと 0 になる</summary>
    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in data) crc = (crc << 8) ^ CrcTable[(crc >> 24) ^ value];
        return crc;
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (var index = 0u; index < 256; index++)
        {
            var crc = index << 24;
            for (var bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
            table[index] = crc;
        }
        return table;
    }

    private sealed class Ecm
    {
        public Ecm() => Section = new Section(this);

        public Section Section { get; }
        public byte[]? Last;
        public bool Attempted;
        public Multi2? Cipher;
    }

    /// <summary>組み立て中の節。長さは頭 3 バイトで決まる (最長 3 + 4095)</summary>
    private sealed class Section(Ecm? owner)
    {
        private readonly byte[] _buffer = new byte[3 + 0x0FFF];
        private int _length;

        public Ecm? Owner => owner;
        public bool Active { get; private set; }

        private int Total => 3 + (((_buffer[1] & 0x0F) << 8) | _buffer[2]);

        public bool Complete => _length >= 3 && _length == Total;

        public ReadOnlySpan<byte> Bytes => _buffer.AsSpan(0, _length);

        public void Start()
        {
            Active = true;
            _length = 0;
        }

        public void Drop()
        {
            Active = false;
            _length = 0;
        }

        /// <summary>要るぶんだけ取り込み、取り込んだバイト数を返す</summary>
        public int Append(ReadOnlySpan<byte> data)
        {
            var taken = 0;
            if (_length < 3)
            {
                taken = Math.Min(3 - _length, data.Length);
                data[..taken].CopyTo(_buffer.AsSpan(_length));
                _length += taken;
                if (_length < 3) return taken;
            }
            var more = Math.Min(Total - _length, data.Length - taken);
            data.Slice(taken, more).CopyTo(_buffer.AsSpan(_length));
            _length += more;
            return taken + more;
        }
    }
}
