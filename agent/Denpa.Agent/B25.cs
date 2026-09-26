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
/// **パケットは、流れの中でその位置より前に来た ECM の中身の鍵で解く** (libaribb25 と同じ)。
/// 受け口 (<see cref="Receive"/>) は届いた順に節を読み、掛かったパケットごとに「どの ECM の、
/// どの中身の鍵が要るか」をその時点の表で決めて札を付ける。出口 (<see cref="Drain"/>) は
/// 順番を崩さず、要る答えが来ていればすぐ解き、まだなら**そこから先を溜めて答えを待つ**。
/// 答えはその中身の札が付いたパケットにしか当てないので、**後から来た鍵で前のパケットを解く
/// ことは起きようがない** (化けたものを「解けた」として流さない)。
/// </para>
///
/// <para>
/// **解けないものは落とさずに素通しする。** 録れないよりまし、で、解けなかったことは
/// <see cref="Undecodable"/> と <see cref="LastError"/> で分かる。鍵の相手が失敗しても
/// 投げない — 少し置いて同じ ECM をもう一度聞く。
/// </para>
///
/// <para>
/// **鍵は読み手の外で貰う。** カードや配り役が固まると1回の問い合わせに何秒もかかり、
/// 読み手がそこで待つとデバイスの溜め (3.5 秒ぶん) が溢れて**録画が欠ける**。
/// 欠けたものは後から解いても戻らない。待つのは出口だけで、受け口は読み続ける。
/// </para>
///
/// <para>
/// 1つの実体は**1本の読み手からだけ**呼ぶ。実体どうしで共有するものは何も無いので、
/// チューナーが何本あっても互いに壊し合わない (libaribb25 の頃は1つの実体に2本入って
/// プロセスごと落ちた)。数え (<see cref="Decoded"/> など) だけは他のスレッドから覗いてよい。
/// </para>
/// </summary>
/// <param name="background">
/// false なら鍵をその場で貰う (単体テストと、急がない後からの解除用)
/// </param>
public sealed class Descrambler(IKeySource source, bool background = true)
{
    private const int PacketSize = 188;
    private const byte SyncByte = 0x47;

    /// <summary>
    /// 答えを待って溜める上限。**これを超えたら、その答えは待たずに流し始める。**
    ///
    /// <para>
    /// 溜めるのは、録画の頭や鍵の変わり目が掛かったままにならないようにするため。PAT・PMT・ECM は
    /// どれも 0.1 秒ほどの間隔で来るので、普通は 1MB も溜まらずに揃う。揃わないのは
    /// カードに合わない局か壊れた TS か固まったカードで、そのときに待ち続けると何も出てこなくなる。
    /// 8MB は衛星の中継器まるごと (6MB/秒ほど) でも 1 秒ちょっと
    /// </para>
    /// </summary>
    public const int HoldLimit = 8 * 1024 * 1024;

    /// <summary>B-CAS の CA_system_id。カードから聞けるまではこれで CA 記述子を選ぶ</summary>
    private const int BcasSystemId = 0x0005;

    /// <summary>鍵を貰えなかった ECM を、同じ中身のまま聞き直すまでの間</summary>
    private const long RetryMs = 2000;

    /// <summary>
    /// 後からの解除 (background でない) で聞き直すまでのパケット数。**時計ではなく読んだ量で数える** —
    /// ファイルは実時間より速く読むので、時計で待つと数分ぶんが掛かったまま残り、
    /// 待たないと同じ ECM (0.1 秒おきに来る) のたびに固まった相手を待つ。地上波の 2 秒ほど
    /// </summary>
    private const long RetryPackets = 25_000;

    /// <summary>読んだパケットの数。**流れの中の位置**として札に書き、聞き直しの間隔も数える</summary>
    private long _packets;

    private readonly byte[] _carry = new byte[PacketSize * 2];
    private readonly byte[] _joint = new byte[PacketSize * 4];
    private int _carryLength;
    private bool _synced;

    /// <summary>出口で順番を待っているパケットと、その札。<see cref="_head"/> から <see cref="_tail"/> まで</summary>
    private byte[]? _queue;
    private Mark[]? _marks;
    private int _head;
    private int _tail;
    /// <summary>溜めの中の、まだ ECM を決められないパケットの数 (<see cref="Need.Unrouted"/>)</summary>
    private int _unrouted;
    /// <summary>PMT を待ちきれずに流した。PAT が変わるまでは、表に無いものを待たない</summary>
    private bool _unroutedGaveUp;

    private readonly Section _pat = new(null);
    private byte[]? _patLast;
    /// <summary>program_number → PMT の PID (PAT の中身)</summary>
    private readonly Dictionary<int, int> _programs = [];
    /// <summary>PMT の PID → 組み立て中の節。**1つの PID に複数の番組が乗ることもある**</summary>
    private readonly Dictionary<int, Section> _pmtSections = [];
    /// <summary>program_number → 最後に受けた PMT。CA の番号が変わったら読み直せるように丸ごと持つ</summary>
    private readonly Dictionary<int, byte[]> _pmts = [];
    /// <summary>PAT の番組の PMT がみな来た</summary>
    private bool _allPmts;
    /// <summary>PAT が変わってから、同じ PMT がもう一度来た。**1周で来ない PMT は来ない**</summary>
    private bool _pmtRepeated;
    /// <summary>ECM の PID → 鍵</summary>
    private readonly Dictionary<int, Ecm> _ecms = [];
    /// <summary>ES の PID → 鍵。8192 本の表を引くだけにして、パケットごとの手間を無くす</summary>
    private readonly Ecm?[] _route = new Ecm?[8192];
    /// <summary>
    /// ECM が1本だけなら、PMT に載っていない PID が掛かっていてもそれで解く。
    /// **PAT の PMT がみな来てから** — 来ていない番組の ES を別の ECM の鍵で解かない
    /// </summary>
    private Ecm? _only;
    /// <summary>答えを待っている中身</summary>
    private readonly List<Content> _asking = [];

    private CardInit? _init;
    private int _caSystemId = BcasSystemId;
    private string? _logged;

    private long _decoded;
    private long _undecodable;
    private long _unentitled;
    private long _dropped;

    /// <summary>解いたパケットの数</summary>
    public long Decoded => Volatile.Read(ref _decoded);

    /// <summary>掛かっていたのに鍵が無くて**そのまま流した**パケットの数 (契約の無いものは数えない)</summary>
    public long Undecodable => Volatile.Read(ref _undecodable);

    /// <summary>
    /// **契約が無くて**そのまま流したパケットの数。解けなかったのではなく、解く資格が無い。
    /// 1つの TS には契約していない局も乗っている (CS・BS の有料局)
    /// </summary>
    public long Unentitled => Volatile.Read(ref _unentitled);

    /// <summary>188 バイトの並びに乗らず捨てたバイト数 (途中から読み始めた頭や、壊れたところ)</summary>
    public long Dropped => Volatile.Read(ref _dropped);

    /// <summary>最後に鍵を貰えなかった理由。**録画が掛かったままだったときに見せる**</summary>
    public string? LastError { get; private set; }

    /// <summary>
    /// 読んだぶんを解いて <paramref name="output"/> に書く。
    ///
    /// <para>
    /// 入れた長さと出る長さは揃わない。188 バイトに満たない尻尾は次の呼び出しまで残し、
    /// 鍵の答えを待つ間は溜める (<see cref="HoldLimit"/>)。
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

    /// <summary>
    /// 溜めているぶんを吐き出す。**終わりに1回**。尻尾の半端なバイトは捨て、
    /// まだ来ていない答えは待たない (来ていない鍵の要るものは掛かったまま出る)
    /// </summary>
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
        // もう来ている答えは拾ってから
        if (_asking.Count > 0) Poll();
        Drain(output, final: true);
    }

    /// <summary>
    /// 中身を忘れる。**チャンネルを変えたとき。**
    ///
    /// <para>
    /// 前のチャンネルの PMT と鍵が残っていると、次の ECM が来るまで前の鍵で解こうとする。
    /// 数えも 0 に戻す。カードの定数 (<see cref="CardInit"/>) だけはカードが同じなので持ち越す。
    /// 溜めていたぶんも捨てる (前のチャンネルの続きは要らない)。
    /// </para>
    /// </summary>
    public void Reset()
    {
        _carryLength = 0;
        _synced = false;
        _queue = null;
        _marks = null;
        _head = _tail = _unrouted = 0;
        _unroutedGaveUp = false;
        _pat.Drop();
        _patLast = null;
        _programs.Clear();
        _pmtSections.Clear();
        _pmts.Clear();
        _allPmts = _pmtRepeated = false;
        _ecms.Clear();
        Array.Clear(_route);
        _only = null;
        // 聞いている最中の答えは、来ても誰も拾わない
        _asking.Clear();
        _logged = null;
        LastError = null;
        Volatile.Write(ref _decoded, 0);
        Volatile.Write(ref _undecodable, 0);
        Volatile.Write(ref _unentitled, 0);
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

    /// <summary>
    /// 1 パケット。受け口で札を付け、何も溜まっていなくて鍵もあればその場で解いて出す
    /// (**速い道。写すのは出口への1回だけ**)。そうでなければ溜めの後ろに並べる
    /// </summary>
    private void Take(ReadOnlySpan<byte> packet, IBufferWriter<byte> output)
    {
        _packets++;
        if (_asking.Count > 0) Poll();
        if (_tail > _head) Drain(output, final: false);

        var mark = Receive(packet);
        if (_tail == _head)
        {
            var step = Decide(mark, final: false, out var cipher);
            if (step != Step.Wait)
            {
                var room = output.GetSpan(PacketSize)[..PacketSize];
                packet.CopyTo(room);
                Emit(step, cipher, room);
                output.Advance(PacketSize);
                return;
            }
        }
        Enqueue(packet, mark);
        Drain(output, final: false);
    }

    /// <summary>
    /// 受け口。**流れの順に**節を読み、掛かったパケットには要る鍵の札を付ける。
    /// 表はこの位置のもの — あとで PMT や ECM が変わっても、札は変わらない
    /// </summary>
    private Mark Receive(ReadOnlySpan<byte> packet)
    {
        // 誤りの印が立っているものは中身を信じない。触らずに流す
        if ((packet[1] & 0x80) != 0) return new Mark(Need.None);

        var control = packet[3] >> 6;
        if (control == 0)
        {
            Parse(packet);
            return new Mark(Need.None);
        }

        var start = PayloadStart(packet);
        if (start < 0) return new Mark(Need.Undecodable);
        // 中身の無いパケット (アダプテーションだけ) は、印を下ろすだけで済む
        if (start == PacketSize) return new Mark(Need.Bare);

        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        var ecm = _route[pid];
        if (ecm is null)
        {
            // PMT がまだなら、どの ECM か決められない。来たところで決める (Resolve)
            if (!_allPmts && !_pmtRepeated && !_unroutedGaveUp) return new Mark(Need.Unrouted) { Seq = _packets };
            ecm = _only;
            if (ecm is null) return new Mark(Need.Undecodable);
        }
        return Annotate(ecm, control == 2 ? 2 : 3, _packets);
    }

    /// <summary>
    /// ECM の札を付ける。いまの中身の鍵が要る。まだ中身を1つも見ていなければ「頭」
    /// (<see cref="Need.Head"/>)。偶奇の変わり目もここで数える
    /// </summary>
    private static Mark Annotate(Ecm ecm, int parity, long seq)
    {
        if (ecm.Parity != parity)
        {
            if (ecm.Parity != 0 && ecm.Current is { } current && current.Flips++ == 0) current.FlipHeard = ecm.Heard;
            ecm.Parity = parity;
            ecm.RunStart = seq;
        }
        if (ecm.Current is not { } content) return new Mark(Need.Head) { Ecm = ecm, Seq = seq };
        /*
         * **中身を見たあとに偶奇が2回変わったら、その中身の鍵ではない。** 中身が持つのは今と次の
         * 鍵だけで、次の次へ切り替わる前には次の中身が来る。来ないのは ECM が見えていないとき
         * (PMT より先に ECM の PID が移った、など)。古い中身の鍵で解くと化ける
         */
        if (content.Flips >= 2) return new Mark(Need.Undecodable);
        return new Mark(Need.Content)
        {
            Content = content,
            // 答えが来ないときに前の中身の鍵で解いてよいか (Decide)。**見た時点の偶奇が続いている間だけ**
            Fallback = content.Flips == 0 && parity == content.SeenParity,
            Confirm = content.Flips == 1,
        };
    }

    /// <summary>
    /// パケットをどうするか決める。<see cref="Step.Wait"/> なら答えを待つ。
    /// <paramref name="final"/> なら待たない (<see cref="Flush"/>)
    /// </summary>
    private Step Decide(in Mark mark, bool final, out Multi2? cipher)
    {
        cipher = null;
        switch (mark.Need)
        {
            case Need.None:
                return Step.Pass;
            case Need.Bare:
                return Step.Bare;
            case Need.Undecodable:
                return Step.Undecodable;
            case Need.Unrouted:
                return _unroutedGaveUp || final ? Step.Undecodable : Step.Wait;
            case Need.Head:
            {
                /*
                 * **ECM より前のパケットは、最初の中身を見た時点で続いていた偶奇の並びだけ
                 * 最初の鍵で解く。** 中身が持つのは今と次の鍵で、見た時点で流れている鍵は
                 * そのどちらか。並びが途切れる前は前の鍵かもしれない
                 */
                var ecm = mark.Ecm!;
                if (ecm.First is not { } first) return ecm.HeadGaveUp || ecm.Removed || final ? Step.Undecodable : Step.Wait;
                if (first.State == State.Unentitled) return Step.Unentitled;
                if (mark.Seq < first.RunStart) return Step.Undecodable;
                if (first.State == State.Answered)
                {
                    cipher = first.Cipher;
                    return Step.Decrypt;
                }
                return first.Waitable && !final ? Step.Wait : Step.Undecodable;
            }
            default:
            {
                var content = mark.Content!;
                if (content.State == State.Unentitled) return Step.Unentitled;
                /*
                 * **中身を見たあとに偶奇が変わったら、その PID で次の ECM を受けるまで待つ。** ふつうは
                 * 次の鍵への切り替わりで、中身の鍵のうち。ただ中身を見たのが切り替わりのあと
                 * (録り始めなど) だと、変わった先は次の中身の鍵になる。その ECM は切り替わりの前に
                 * 来るはずなので、切り替わりのあとに何か受ければ前者と分かる。何も来ないまま
                 * PMT から外れたら、ECM の PID が PMT より先に移っていた — 解かない
                 */
                if (mark.Confirm && content.Owner.Heard == content.FlipHeard)
                {
                    return content.Owner.Removed || content.GaveUp || final ? Step.Undecodable : Step.Wait;
                }
                if (content.State == State.Answered)
                {
                    cipher = content.Cipher;
                    return Step.Decrypt;
                }
                if (content.Waitable && !final) return Step.Wait;
                /*
                 * **待てないなら、前の中身の鍵で解けるものだけ解く。** 前と今の中身で共通なのは、
                 * 今の中身を見た時点で流れていた鍵だけ。その偶奇が一度も途切れていない
                 * パケットに限る (札を付けたときに決めてある)
                 */
                if (mark.Fallback && content.Prev is { } prev)
                {
                    if (prev.State == State.Answered)
                    {
                        cipher = prev.Cipher;
                        return Step.Decrypt;
                    }
                    if (prev.State == State.Unentitled) return Step.Unentitled;
                }
                return Step.Undecodable;
            }
        }
    }

    private void Emit(Step step, Multi2? cipher, Span<byte> packet)
    {
        switch (step)
        {
            case Step.Undecodable:
                _undecodable++;
                return;
            case Step.Unentitled:
                _unentitled++;
                return;
            case Step.Decrypt:
                // 0b10 が偶数、0b11 が奇数 (0b01 は使われないが、奇数の鍵で解く)
                cipher!.Decrypt(packet[3] >> 6 == 2, packet[PayloadStart(packet)..]);
                packet[3] &= 0x3F;
                _decoded++;
                return;
            case Step.Bare:
                packet[3] &= 0x3F;
                _decoded++;
                return;
        }
    }

    private void Enqueue(ReadOnlySpan<byte> packet, Mark mark)
    {
        if (_queue is null || _marks is null)
        {
            _queue = new byte[PacketSize * 1024];
            _marks = new Mark[1024];
        }
        else if (_tail == _marks.Length)
        {
            if (_head > 0)
            {
                // 出たぶんを詰める
                _queue.AsSpan(_head * PacketSize, (_tail - _head) * PacketSize).CopyTo(_queue);
                Array.Copy(_marks, _head, _marks, 0, _tail - _head);
                Array.Clear(_marks, _tail - _head, _head);
                _tail -= _head;
                _head = 0;
            }
            if (_tail == _marks.Length)
            {
                Array.Resize(ref _queue, _queue.Length * 2);
                Array.Resize(ref _marks, _marks.Length * 2);
            }
        }
        packet.CopyTo(_queue.AsSpan(_tail * PacketSize));
        _marks[_tail++] = mark;
        if (mark.Need == Need.Unrouted) _unrouted++;
    }

    /// <summary>
    /// 出口。溜めの頭から**順に**出し、答えを待つパケットに当たったらそこで止まる。
    /// 溜めが <see cref="HoldLimit"/> を超えていたら、その答えは待つのをやめて先へ進む (<see cref="GiveUp"/>)
    /// </summary>
    private void Drain(IBufferWriter<byte> output, bool final)
    {
        while (_head < _tail)
        {
            ref var mark = ref _marks![_head];
            var step = Decide(mark, final, out var cipher);
            if (step == Step.Wait)
            {
                if ((_tail - _head) * PacketSize < HoldLimit) return;
                GiveUp(mark);
                continue;
            }
            var room = output.GetSpan(PacketSize)[..PacketSize];
            _queue.AsSpan(_head * PacketSize, PacketSize).CopyTo(room);
            Emit(step, cipher, room);
            output.Advance(PacketSize);
            if (mark.Need == Need.Unrouted) _unrouted--;
            mark = default;
            _head++;
        }

        // 空になった。大きく育った溜め (初めの鍵待ちなど) は手放す
        _head = _tail = 0;
        if (_marks is { Length: > 8192 })
        {
            _queue = null;
            _marks = null;
        }
    }

    /// <summary>待ちきれなかった。**そのとき待っていたもの**だけ、この先も待たない</summary>
    private void GiveUp(in Mark mark)
    {
        string what;
        switch (mark.Need)
        {
            case Need.Unrouted:
                _unroutedGaveUp = true;
                what = "PMT";
                break;
            case Need.Head when mark.Ecm!.First is { } first:
                first.GaveUp = true;
                what = "鍵";
                break;
            case Need.Head:
                mark.Ecm!.HeadGaveUp = true;
                what = "ECM";
                break;
            default:
                mark.Content!.GaveUp = true;
                what = "鍵";
                break;
        }
        Log.Write($"{what}を待つ間に {HoldLimit / 1024 / 1024}MB 溜まったので、待たずに流します");
    }

    /// <summary>
    /// PMT が来て ES から ECM を引けるようになった。**溜めの中の、決められずにいたパケットに
    /// 流れの順で札を付け直す。** 付け直せるのはまだ何も札を付けていない ECM だけ — 他の番組から
    /// もう札を付けている ECM に割り込むと、偶奇の並びと中身の順が崩れる (そのときは解かない)
    /// </summary>
    private void Resolve()
    {
        if (_unrouted == 0) return;
        foreach (var ecm in _ecms.Values) ecm.Fresh = ecm.Parity == 0 && ecm.Current is null;
        for (var index = _head; index < _tail; index++)
        {
            ref var mark = ref _marks![index];
            if (mark.Need != Need.Unrouted) continue;
            var packet = _queue.AsSpan(index * PacketSize, PacketSize);
            var pid = ((packet[1] & 0x1F) << 8) | packet[2];
            var ecm = _route[pid] ?? _only;
            if (ecm is null && !_allPmts && !_pmtRepeated) continue;
            mark = ecm is { Fresh: true } ? Annotate(ecm, packet[3] >> 6 == 2 ? 2 : 3, mark.Seq) : new Mark(Need.Undecodable);
            _unrouted--;
        }
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
        var payload = packet[start..];
        var unitStart = (packet[1] & 0x40) != 0;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];

        if (pid == 0) Feed(_pat, pid, payload, unitStart);
        else if (_pmtSections.TryGetValue(pid, out var pmt)) Feed(pmt, pid, payload, unitStart);
        else if (_ecms.TryGetValue(pid, out var ecm)) Feed(ecm.Section, pid, payload, unitStart);
    }

    /// <summary>
    /// パケットの中身を節に組み立てる。節はパケットを跨ぐし、1つのパケットに
    /// 幾つも入ることもある (pointer_field が次の節の頭を指す)
    /// </summary>
    private void Feed(Section section, int pid, ReadOnlySpan<byte> payload, bool unitStart)
    {
        if (!unitStart)
        {
            if (!section.Active) return;
            section.Append(payload);
            if (section.Complete) Complete(section, pid);
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
            if (section.Complete) Complete(section, pid);
            else section.Drop();
        }
        rest = rest[pointer..];

        // 0xFF は詰め物。そこから先に節は無い
        while (!rest.IsEmpty && rest[0] != 0xFF)
        {
            section.Start();
            rest = rest[section.Append(rest)..];
            if (!section.Complete) return;
            Complete(section, pid);
        }
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
        // 番組が変わった。来ていない PMT をもう一度待つ
        _pmtRepeated = _unroutedGaveUp = false;
        Rebuild();
    }

    private void OnPmt(int pid, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x02) return;
        var number = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        if (!_programs.TryGetValue(number, out var expected) || expected != pid) return;
        if (_pmts.TryGetValue(number, out var last) && section.SequenceEqual(last))
        {
            if (!_pmtRepeated)
            {
                // 1周した。まだ来ていない PMT は待たない
                _pmtRepeated = true;
                Resolve();
            }
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

        foreach (var pid in _ecms.Keys.Where(pid => !wanted.Contains(pid)).ToList())
        {
            // 溜めの札はまだこの ECM を指している。もう ECM は来ないので、それを待たない (Decide)
            _ecms[pid].Removed = true;
            _ecms.Remove(pid);
        }
        foreach (var pid in wanted)
        {
            if (!_ecms.ContainsKey(pid)) _ecms[pid] = new Ecm();
        }

        Array.Clear(_route);
        foreach (var (es, ecm) in streams) _route[es] = _ecms[ecm];
        _allPmts = _patLast is not null && _programs.Keys.All(_pmts.ContainsKey);
        _only = _allPmts && _ecms.Count == 1 ? _ecms.Values.First() : null;
        Resolve();
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
    /// ECM の中身が変わった。**この先のパケットはこの中身の鍵で解く** (札は <see cref="Annotate"/>)。
    /// 見た時点の偶奇と、その偶奇がいつから続いているかを覚えておく (<see cref="Decide"/>)。
    /// 聞くのは1本につき1つずつで、聞いている間に来たものは順に並べておく
    /// (<see cref="Ecm.Next"/>)
    /// </summary>
    private void OnEcm(Ecm ecm, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x82) return;
        ecm.Heard++;
        if (ecm.Current is { } current && section.SequenceEqual(current.Section))
        {
            // 同じ中身。貰えなかったものは、少し置いてから聞き直す
            if (current.State == State.Failed && ecm.Asking is null && Now() >= current.RetryAt)
            {
                Ask(current);
                if (!background) Poll();
            }
            return;
        }

        var content = new Content(ecm, section.ToArray())
        {
            Prev = ecm.Current,
            SeenParity = ecm.Parity,
            RunStart = ecm.RunStart,
        };
        // 何も溜まっていなければ、前の中身の札はもう無い。**前の前へ遡る鎖を切って**持ち続けない
        if (_tail == _head && ecm.Current is { } previous) previous.Prev = null;
        ecm.Current = content;
        ecm.First ??= content;
        if (ecm.Asking is null)
        {
            Ask(content);
            if (!background) Poll();
            return;
        }
        // 前の答えを待っている。後ろに並べる
        content.State = State.Queued;
        ecm.Prune();
        ecm.Next.Add(content);
    }

    /// <summary>聞き直しの間隔を測る物差し。流れなら時計、後からの解除なら読んだ量</summary>
    private long Now() => background ? Environment.TickCount64 : _packets;

    /// <summary>
    /// カードに聞き始める。**待たない** (<see cref="background"/>)。答えは次の
    /// パケットのときに拾う (<see cref="Poll"/>)。
    ///
    /// <para>
    /// **渡すのは節の頭 8 バイトと末尾の CRC 4 バイトを除いた中身。** libaribb25 が
    /// カードへ渡していたのと同じ切り方で、拠点を跨いで鍵を貰う線 (CardShare.cs) も
    /// この切り方で運んでいる。変えると古いエージェントと話が通じなくなる。
    /// </para>
    /// </summary>
    private void Ask(Content content)
    {
        var known = _init;
        var section = content.Section;
        (CardInit, EcmAnswer) Fetch() =>
            (known ?? source.Init(), source.Ecm(section.AsSpan(8, section.Length - 12)));

        content.State = State.Asking;
        content.Owner.Asking = content;
        if (background)
        {
            // **専用のスレッドで。** カードや配り役が固まると何秒も塞ぐので、共用の池から借りると
            // チューナー × ECM の本数ぶん池が埋まり、HTTP の口まで待たされる
            content.Pending = Task.Factory.StartNew(
                Fetch, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }
        else
        {
            try
            {
                content.Pending = Task.FromResult(Fetch());
            }
            catch (Exception error)
            {
                content.Pending = Task.FromException<(CardInit, EcmAnswer)>(error);
            }
        }
        _asking.Add(content);
    }

    /// <summary>
    /// 答えが来ていたら中身に鍵を入れる。**読み手の側で**やるので錠は要らない。
    /// 待っている間に次の中身が来ていたら、見終えてから聞く (回している途中で
    /// <see cref="_asking"/> を触らない)
    /// </summary>
    private void Poll()
    {
        while (true)
        {
            List<Content>? again = null;
            for (var index = _asking.Count - 1; index >= 0; index--)
            {
                var content = _asking[index];
                if (content.Pending is not { IsCompleted: true } done) continue;
                _asking.RemoveAt(index);
                content.Pending = null;
                var ecm = content.Owner;
                if (ecm.Asking == content) ecm.Asking = null;
                // PAT・PMT が変わって要らなくなった ECM でも、中身には鍵を入れる (溜めの札が待っている)
                var live = _ecms.ContainsValue(ecm);
                Apply(content, done, live);
                if (live && ecm.Asking is null)
                {
                    ecm.Prune();
                    if (ecm.Next.Count > 0)
                    {
                        (again ??= []).Add(ecm.Next[0]);
                        ecm.Next.RemoveAt(0);
                    }
                }
            }
            if (again is null) return;
            foreach (var next in again) Ask(next);
            // 待たずに聞いたなら、もう答えは出ている
            if (background) return;
        }
    }

    private void Apply(Content content, Task<(CardInit Init, EcmAnswer Answer)> done, bool live)
    {
        try
        {
            var (init, answer) = done.GetAwaiter().GetResult();
            if (_init is null)
            {
                _init = init;
                // A-CAS など B-CAS 以外のカードなら、CA 記述子を選び直す
                if (init.CaSystemId != _caSystemId)
                {
                    _caSystemId = init.CaSystemId;
                    Rebuild();
                }
            }
            // 答えが来れば、前の中身の鍵に頼ることはもう無い
            content.Prev = null;

            // 0x0200・0x0400・0x0800 が「見てよい」。それ以外は契約が無い
            if (answer.Code is not (0x0200 or 0x0400 or 0x0800))
            {
                content.State = State.Unentitled;
                if (live) Report($"カードが鍵を出しません (契約が無いか、別の方式の局: 0x{answer.Code:X4})");
                return;
            }
            var cipher = new Multi2(_init.SystemKey, _init.InitCbc);
            cipher.SetKeys(answer.Odd, answer.Even);
            content.Cipher = cipher;
            content.State = State.Answered;

            if (_logged is not null) Log.Write("鍵を貰えるようになりました");
            _logged = null;
        }
        catch (Exception error)
        {
            // 待っている札は待たずに前の鍵へ回し (Decide)、少し置いて同じ中身を聞き直す (OnEcm)
            content.State = State.Failed;
            content.GaveUp = true;
            content.RetryAt = Now() + (background ? RetryMs : RetryPackets);
            if (live) Report(error.Message);
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

    /// <summary>パケットに要るもの (札の種類)</summary>
    private enum Need : byte
    {
        /// <summary>掛かっていない (か、誤りの印が立っている)。そのまま流す</summary>
        None,
        /// <summary>掛かっているが中身が無い。印を下ろすだけ</summary>
        Bare,
        /// <summary>解きようがない (アダプテーションが壊れている・ECM が無い)</summary>
        Undecodable,
        /// <summary>PMT がまだで ECM を決められない (<see cref="Resolve"/>)</summary>
        Unrouted,
        /// <summary>ECM の中身をまだ1つも見ていない (<see cref="Ecm.First"/> を待つ)</summary>
        Head,
        /// <summary>この中身の鍵</summary>
        Content,
    }

    private enum Step : byte { Wait, Pass, Bare, Undecodable, Unentitled, Decrypt }

    /// <summary>パケットに付ける札。付けたときの表で決まり、あとから変わらない</summary>
    private readonly record struct Mark(Need Need)
    {
        public Content? Content { get; init; }
        public Ecm? Ecm { get; init; }
        /// <summary>流れの中の位置 (<see cref="_packets"/>)</summary>
        public long Seq { get; init; }
        /// <summary>答えが来ないとき、前の中身の鍵で解いてよい</summary>
        public bool Fallback { get; init; }
        /// <summary>中身を見たあとに偶奇が1回変わったあと。次の ECM を受けるまで待つ (<see cref="Decide"/>)</summary>
        public bool Confirm { get; init; }
    }

    private enum State : byte
    {
        /// <summary>前の答えを待っていて、まだ聞いていない</summary>
        Queued,
        Asking,
        Answered,
        /// <summary>カードが「契約が無い」と答えた</summary>
        Unentitled,
        /// <summary>貰えなかった。<see cref="Content.RetryAt"/> を過ぎたら聞き直す</summary>
        Failed,
        /// <summary>聞く前に待つのをやめ、次の中身も来た。もう誰も要らないので聞かない</summary>
        Skipped,
    }

    /// <summary>ECM の1つの中身と、その答え</summary>
    private sealed class Content(Ecm owner, byte[] section)
    {
        public Ecm Owner => owner;
        public byte[] Section => section;
        public State State;
        public Task<(CardInit Init, EcmAnswer Answer)>? Pending;
        public Multi2? Cipher;
        /// <summary>1つ前の中身。答えを待てないときに、その鍵で解けるものだけ解く</summary>
        public Content? Prev;
        /// <summary>見た時点の偶奇 (0 はまだパケットが来ていない) と、その偶奇が続いている頭</summary>
        public int SeenParity;
        public long RunStart;
        /// <summary>見たあとに偶奇が変わった回数。変わったら前の中身の鍵では解かず、2回で自分の鍵でもなくなる</summary>
        public int Flips;
        /// <summary>1回目に変わった時点の <see cref="Ecm.Heard"/>。それより後に ECM を受けたら、変わった先も中身の鍵</summary>
        public long FlipHeard;
        /// <summary>待ちきれなかったか、貰えなかった。この中身の札は待たない</summary>
        public bool GaveUp;
        public long RetryAt;

        /// <summary>答えを待てば来るかもしれない</summary>
        public bool Waitable => !GaveUp && State is State.Queued or State.Asking;
    }

    private sealed class Ecm
    {
        public Ecm() => Section = new Section(this);

        public Section Section { get; }
        /// <summary>最後に見た中身 (この先のパケットの札になる) と、最初に見た中身</summary>
        public Content? Current;
        public Content? First;
        /// <summary>いま聞いている中身と、その答えを待つ間に来た中身 (来た順)</summary>
        public Content? Asking;
        public List<Content> Next { get; } = [];
        /// <summary>最後に札を付けたパケットの偶奇 (2 が偶数、3 が奇数) と、その偶奇が続いている頭</summary>
        public int Parity;
        public long RunStart;
        /// <summary>最初の中身を待ちきれなかった。頭のパケットは待たない</summary>
        public bool HeadGaveUp;
        /// <summary>受けた ECM の節の数 (同じ中身の繰り返しも数える)</summary>
        public long Heard;
        /// <summary>PAT・PMT が変わって要らなくなった。この先 ECM は来ない</summary>
        public bool Removed;
        /// <summary>まだ何も札を付けていない (<see cref="Resolve"/> の間だけ使う)</summary>
        public bool Fresh;

        /// <summary>
        /// 並んでいる中身のうち、**もう答えを待つ札が無いもの**を外す。待つのをやめていて
        /// (<see cref="Content.GaveUp"/>)、この先の札にもならない (次の中身が来ている) もの。
        /// 札が待っている中身は飛ばさない — 最新だけ聞くと、その札が掛かったまま出る
        /// </summary>
        public void Prune()
        {
            foreach (var content in Next)
            {
                if (content.GaveUp && content != Current) content.State = State.Skipped;
            }
            Next.RemoveAll(content => content.State == State.Skipped);
        }
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
