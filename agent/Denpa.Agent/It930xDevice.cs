using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>ブリッジの I2C の 1 本のバス (<see cref="It930xBridge.I2cWrite"/>・<see cref="It930xBridge.I2cRead"/>)</summary>
internal sealed class It930xI2cBus(It930xBridge bridge, byte bus) : ICxdBus
{
    public void Write(byte address, ReadOnlySpan<byte> data) => bridge.I2cWrite(bus, address, data);

    public void Read(byte address, Span<byte> data) => bridge.I2cRead(bus, address, data.Length).CopyTo(data);
}

/// <summary>
/// 受信機 1 つの後ろのチップ (復調器とチューナー)。機材 (<see cref="It930xDevice"/>) とチューナー (<see cref="It930xTuner"/>) は、どのチップかを見ずにこれだけを使う。
/// CXD2856ER + CXD2858ER は <see cref="CxdReceiver"/>、TC90522 + R850・RT710 は <see cref="Tc90522Frontend"/> の派生
/// </summary>
public interface IIt930xFrontend
{
    /// <summary>記録に出すチップの名前 (読み出して見分けた種類を含む)</summary>
    string Chips { get; }

    /// <summary>
    /// 選局して、ロックを待つ。ロックしなければ false (例外にしない。スキャンで続くため)。
    /// 受けられない方式・範囲の外の周波数は、何も書かずに <see cref="IOException"/>。I2C の失敗も <see cref="IOException"/>
    /// </summary>
    bool Tune(ChannelTable.Tuning tuning);

    /// <summary>
    /// 復調器の TS の端子を出す・止める (TC90522 の仕様書 3.5・9)。受信を始めるときに出し、終えるときに止める。
    /// CXD2856ER は端子を操作しない (ブリッジの入力の開け閉めだけで止める) ので何もしない
    /// </summary>
    void Stream(bool on);

    /// <summary>受信の状態と C/N。選局していなければ null</summary>
    TunerSignal? Signal();

    /// <summary>衛星で受けているとき、TMCC から読んだ相対 TS 0〜7 の TSID。読めなければ null</summary>
    ushort[]? SatelliteStreams();

    /// <summary>最後の選局で、ロックを確かめ始めてからロックするまで (ms)。ロックしなければ -1</summary>
    long LockMs { get; }

    /// <summary>衛星で最後に <see cref="Signal"/> を読んだときの強度 (dB。CXD2856ER だけ)。<c>--tune</c> だけが出す</summary>
    double? SatelliteLevelDb => null;

    /// <summary>最後の J.83B の選局で受けた周波数 (Hz)。J.83B でなければ null</summary>
    uint? CableFrequency => null;

    /// <summary>最後の J.83B の選局で読んだ変調。<c>--tune</c> だけが出す</summary>
    string? CableModulation => null;

    /// <summary>最後の J.83B の選局で読んだ PER。<c>--tune</c> だけが出す</summary>
    double? CablePer => null;

    /// <summary>
    /// 最後の ISDB-C の選局で、ほかに読めた値 (CXD2856 の仕様書 9.5。CXD2856ER だけ)。<c>--tune</c> だけが出す。
    /// J.83B と ISDB-C を選局できるのは CXD2856ER の受信機だけで、ほかの受信機の <see cref="Tune"/> は何も書かずに断る
    /// </summary>
    CxdIsdbcDetail? IsdbcDetail => null;

    /// <summary><c>--tune</c> だけに出す、チップごとの読み値 (1 行ずつ)。機材から読むので、受け終えたあとに呼ぶ</summary>
    IReadOnlyList<string> Notes() => [];

    /// <summary>
    /// 選局のあと、ロックしたかによらずに <c>--tune</c> に出す行 (失敗の原因を切り分けるため)。チューナーに書いた値と PLL の状態、ロックの判定で読む復調器のレジスタ。
    /// 選局の書き込みを始めていなければ空。機材から読む
    /// </summary>
    IReadOnlyList<string> Diagnose() => [];
}

/// <summary>
/// 機材 1 台の受信機の組 (チップの系統ごとの、開く・閉じるの順)。機材 (<see cref="It930xDevice"/>) は機種の表からこれを 1 つ作る。
/// <see cref="CxdBoard"/> (CXD2856ER の機種)、<see cref="Tc90522Board"/> (Q3・W3 系)、<see cref="Tc90522Single"/> (受信機が 1 つの機種)
/// </summary>
internal interface IIt930xBoard
{
    /// <summary>受信機を開いて返す。開いていれば、そのまま返す。開けなければ <see cref="IOException"/> (次の呼び出しでもう一度試す)</summary>
    IIt930xFrontend Open(int receiver);

    /// <summary>受信機を閉じる (止めてスリープにする)。開いていなければ何もしない</summary>
    void Close(int receiver);
}

/// <summary>
/// CXD2856ER + CXD2858ER の受信機 (CXD2856 の仕様書)。<see cref="Cxd2856Frontend"/> に、選局表の値からの振り分けと、J.83B の周波数の試し方を足す
/// </summary>
internal sealed class CxdReceiver(Cxd2856Frontend frontend, Action keepMatching) : IIt930xFrontend
{
    /// <summary>
    /// J.83B と ISDB-C で、ずらして送られることがあるチャンネル (<see cref="ChannelTable.Tuning.ShiftedFrequency"/>) の、最後にロックした周波数 (Hz)。
    /// 選局表の周波数をキーにする。次の選局はこちらを先に試す (毎回 1 秒の時間切れを待たないため。仕様書に無い)
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<uint, uint> CableLocked = new();

    public Cxd2856Frontend Chip => frontend;

    /// <summary>初期化の前に読んだチューナーの 62 も出す (CXD2856 の仕様書 10.3)。前に ISDB-C か J.83B を選局していて 10 なら、電源が切れていなかったと推定する</summary>
    public string Chips => $"復調器 0x{frontend.ChipId:X2}、初期化の前のチューナーの 62 は {frontend.PowerProbe:X2}";

    public long LockMs => frontend.LockMs;

    /// <summary>地上波は、選局の経過 (プリセットを使ったか、ロックのビットが立った時刻、TMCC) とモードとガードインターバル (CXD2856 の仕様書 5.8)</summary>
    public IReadOnlyList<string> Notes() => frontend.IsdbtNotes();

    /// <summary>地上波は、ロックしなかった選局の経過 (機材からは読まない)</summary>
    public IReadOnlyList<string> Diagnose() => frontend.TuneLines();

    public double? SatelliteLevelDb => frontend.SatelliteLevelDb;

    public uint? CableFrequency { get; private set; }

    public string? CableModulation => frontend.CableModulation;

    public double? CablePer => frontend.CablePer;

    public CxdIsdbcDetail? IsdbcDetail => frontend.IsdbcDetail;

    public bool Tune(ChannelTable.Tuning tuning)
    {
        CableFrequency = null;
        // 衛星は選局表の周波数が IF の kHz (CXD2856 の仕様書 6.1)
        if (tuning.Satellite) return frontend.TuneIsdbs(tuning.Frequency, CxdStream.From(tuning.StreamId));
        if (tuning.Cable)
        {
            keepMatching();
            return TuneCable(tuning, frontend.TuneJ83b);
        }
        if (tuning.IsdbC)
        {
            /*
             * ISDB-C (CXD2856 の仕様書 8.4)。手順 1 の「ブリッジが NULL パケットを落とさないようにする」(IT930x の仕様書 6.2) は、denpa のブリッジの層が
             * どの方式でも PID で落とす設定を使っていないので、切り替える書き込みは無い。
             * 整合を保つ設定 (CXD2856 の仕様書 4.8) は J.83B と同じく、最初の選局で全受信機に立てる。TSMF で TS を選ぶのは <see cref="It930xTuner"/>
             */
            keepMatching();
            return TuneCable(tuning, frontend.TuneIsdbc);
        }
        return frontend.TuneIsdbt(It930xTuner.Khz(tuning.Frequency));
    }

    /// <summary>
    /// J.83B を選局する (CXD2856 の仕様書 7.4)。ずらして送られることがあるチャンネル (CXD2856 の仕様書 7.1) は、選局表の周波数とずらした周波数の両方を試し、
    /// 前にロックしたほうを先にする。どちらもロックしなければ false
    /// </summary>
    private bool TuneCable(ChannelTable.Tuning tuning, Func<uint, bool> tune)
    {
        uint[] tries = tuning.ShiftedFrequency is { } shifted
            ? CableLocked.TryGetValue(tuning.Frequency, out var last) && last == shifted ? [shifted, tuning.Frequency] : [tuning.Frequency, shifted]
            : [tuning.Frequency];
        foreach (var hertz in tries)
        {
            if (!tune(It930xTuner.Khz(hertz))) continue;
            if (tuning.ShiftedFrequency is not null) CableLocked[tuning.Frequency] = hertz;
            CableFrequency = hertz;
            return true;
        }
        return false;
    }

    /// <summary>TS はブリッジの入力の開け閉めで止める (復調器の端子は操作しない)</summary>
    public void Stream(bool on)
    {
    }

    public TunerSignal? Signal() => frontend.Signal();

    public ushort[]? SatelliteStreams() => frontend.SatelliteStreams();
}

/// <summary>
/// CXD2856ER の機種の受信機の組 (MLT5 系・PX-MLT8PE・DTV02A-4TS-P)。
/// 受信機の初期化は、その受信機を初めて使うときに 1 回 (CXD2856 の仕様書 2.2)。初期化に失敗した受信機だけを使えなくし、ほかの受信機はそのまま使う。
/// 失敗した受信機は、次の選局でもう一度試す。閉じるときはチューナーを止めて復調器をスリープにする
/// </summary>
internal sealed class CxdBoard : IIt930xBoard
{
    private readonly It930xBridge _bridge;
    private readonly It930xModel _model;
    private readonly string _label;
    private readonly Action<int> _sleep;
    private readonly Func<long> _nowMs;
    private readonly Action<Exception> _fail;
    private readonly Lock _gate = new();
    private readonly Dictionary<byte, Lock> _buses = [];
    private readonly CxdReceiver?[] _frontends;
    private readonly Lock[] _receiverGates;

    /// <summary>待機中の地上波の RF 入力の整合を保つ設定にしたか (CXD2856 の仕様書 4.8。<see cref="KeepMatching"/>)。電源を切るまで (この機材を閉じるまで) 立てたまま</summary>
    private volatile bool _matching;

    /// <param name="fail">I2C の失敗を機材に伝える (USB の抜けなら機材を使えないものとする)</param>
    public CxdBoard(It930xBridge bridge, It930xModel model, string label, Action<int> sleep, Func<long> nowMs, Action<Exception> fail)
    {
        _bridge = bridge;
        _model = model;
        _label = label;
        _sleep = sleep;
        _nowMs = nowMs;
        _fail = fail;
        _frontends = new CxdReceiver?[model.Receivers.Count];
        _receiverGates = [.. model.Receivers.Select(_ => new Lock())];
        // 中継を開けてから閉じるまでを、バスごとに 1 つの区切りにする (CXD2856 の仕様書 1.4)
        foreach (var receiver in model.Receivers) _buses.TryAdd(receiver.I2cBus, new Lock());
    }

    /// <summary>受信機の復調器とチューナー。初めてのときに初期化する (CXD2856 の仕様書 2.2)</summary>
    public IIt930xFrontend Open(int receiver)
    {
        var wiring = _model.Receivers[receiver];
        lock (_receiverGates[receiver])
        {
            if (_frontends[receiver] is { } ready) return ready;
            var frontend = new Cxd2856Frontend(new It930xI2cBus(_bridge, wiring.I2cBus), _buses[wiring.I2cBus], wiring.DemodAddress, _sleep, _nowMs);
            // 整合を保つ設定にしたあとに初めて使う受信機は、その設定で初期化する (CXD2856 の仕様書 4.8)
            if (_matching) frontend.KeepMatching(standby: false);
            frontend.Init();
            return _frontends[receiver] = new CxdReceiver(frontend, () => KeepMatching(receiver));
        }
    }

    /// <summary>使い終えた受信機のチューナーを止め、復調器をスリープにする (CXD2856 の仕様書 10.3 の手順 2〜3)</summary>
    public void Close(int receiver)
    {
        CxdReceiver? frontend;
        lock (_receiverGates[receiver]) frontend = _frontends[receiver];
        frontend?.Chip.Sleep();
    }

    /// <summary>
    /// 待機中の地上波の RF 入力の整合を保つ設定を、機材の全受信機で立てる (CXD2856 の仕様書 4.8)。電源を入れてから最初に J.83B か ISDB-C を選局するときに、
    /// その受信機 (<paramref name="receiver"/>) が呼ぶ。2 回目からは何もしない。
    /// 地上波・ケーブルの RF 入力は全チューナーに分配しているので、あるチューナーが待機と動作を切り替えると隣の受信機の 256QAM に誤りが出たため。
    /// 閉じている受信機 (スリープか、まだ使っていない) は初期化し直して待機させ、動作中の受信機は設定だけを立てて止めるときに書く。
    /// 選局する受信機は、このあと動作させるので初期化し直さない。ほかの受信機の失敗は記録に出して続ける (その受信機は次の選局でもう一度初期化する)
    /// </summary>
    public void KeepMatching(int receiver)
    {
        lock (_gate)
        {
            if (_matching) return;
            _matching = true;
        }
        Log.Write($"[{_label}] J.83B か ISDB-C を選局するので、全受信機を待機中の RF 入力の整合を保つ設定にします");
        foreach (var other in _model.Receivers.Select(item => item.Index))
        {
            try
            {
                lock (_receiverGates[other])
                {
                    // まだ使っていない受信機は、整合を保つ設定で初期化して待機させる (Open の中で設定を立てる)
                    if (_frontends[other] is { } frontend) frontend.Chip.KeepMatching(standby: other != receiver);
                    else Open(other);
                }
            }
            catch (IOException error)
            {
                _fail(error);
                Log.Write($"[{_label}] 受信機 {other} を整合を保つ設定にできませんでした ({error.Message})");
            }
        }
    }
}

/// <summary>
/// IT930x の機材 1 台 (USB のポート 1 つ)。開く (ファームウェア・ブリッジの設定・電源)、受信機ごとのチップ、EP 0x84 の読み、閉じる。
/// 受信機の後ろのチップは機種の表 (<see cref="It930xModel"/>) から決めた組 (<see cref="IIt930xBoard"/>) に任せ、ここではどのチップかを見ない。
///
/// <para>
/// **初めて要るときに開き、使っている側がいる間は開いたまま。** チューナー (<see cref="It930xTuner"/>) は最初の選局で取り、捨てるときに返す。
/// 誰も使わなくなったら、30 秒 (<see cref="IdleGrace"/>) 待ってから閉じて電源を切る (<see cref="CloseIfIdle(string)"/>)。その間に取り直せば開いたまま使う。
/// エージェントを止めるとき (<see cref="CloseAll"/>) はすぐ閉じる。電源が GPIOH7 の機種は、内蔵カードリーダーが受信機と同じ電源なので
/// (IT930x の仕様書 7.2)、カード (<see cref="It930xCard"/>) も使う側として数え、カードを使っている間は受信機を全部閉じても電源を切らない。
/// 電源が GPIOH3 の機種 (受信機が 1 つの機種) は、受信機を開いている間だけ電源を入れ、カードのためには入れない (IT930x の仕様書 7.3)。
/// </para>
///
/// <para>
/// **Q3 は、2 つの USB デバイスをそれぞれ別の機材として持つ** (<c>it930x:&lt;側 1 のポート&gt;:0〜3</c> と <c>it930x:&lt;側 2 のポート&gt;:0〜3</c>)。
/// IT930x の仕様書 2.1 の受信機の番号 0〜7 は、側 1 の 0〜3 と側 2 の 0〜3 に当たる。設定の形とポートの見つけ方がほかの機種と同じになり、片側だけが見えていても使える。
/// 電源の連動 (IT930x の仕様書 7.4) は、受信機を開いている間、もう片方の側の機材も取っておくことで行う (機材を開いている間は電源が入る)。
/// 連動で電源だけが入った側は、チップを初期化していない。その側の受信機を最初に開くときに初期化する。
/// もう片方の側が見つからない・開けないときは、記録に出して見つかった側だけを使う (TC90522 の仕様書 13.3 の「片側だけ見えている Q3」)。
/// </para>
///
/// <para>
/// **ロックの順。** 受信機は並べて選局されるので (常駐のスキャン)、ロックは次の順でだけ取り、逆には取らない。
/// <c>Registry</c> → この機材の <c>_gate</c> (使っている側の数)。
/// <see cref="It930xTuner"/> の <c>_gate</c> → 受信機ごとの <c>_receiverGates</c> (<see cref="Frontend"/>・<see cref="KeepMatching"/>) → <see cref="Cxd2856Frontend"/> の受信機の操作 →
/// 同じバスの受信機で 1 つのバスのロック (<c>_buses</c>) → <see cref="It930xBridge"/> のコマンドのロック。<see cref="FlushTs"/> は <c>_gate</c> を持ったままブリッジのコマンドを送る (<c>_gate</c> → ブリッジのコマンドのロック)。LNB の給電の <c>_lnbGate</c> → ブリッジのコマンドのロック。
/// <see cref="KeepMatching"/> はほかの受信機の <c>_receiverGates</c> と受信機の操作を取るが、その受信機の <see cref="It930xTuner"/> の <c>_gate</c> は取らない
/// (選局の途中なら、受信機の操作のロックで選局が終わるのを待つ)。I2C の並びが同じバスで交わらないことは It930xConcurrencyTests.cs で確かめる
/// </para>
/// </summary>
public sealed class It930xDevice
{
    /// <summary>EP 0x84 の 1 回の読みの待ち</summary>
    private const int TsReadTimeoutMs = 200;

    /// <summary>電源を切ったあと (GPIOH7 ← 1 のあと) の待ち (ms。IT930x の仕様書 7.2・10)</summary>
    internal const int PowerOffSettleMs = 100;

    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, It930xDevice> Devices = [];

    /// <summary>
    /// プロセスが終わるとき (SIGTERM で終わる <c>--tune</c> などの CLI も) に機材を閉じる。開けたままの入力に読む側がいなくなると、
    /// ブリッジのバッファが溢れ、電源を抜くまで TS が届かなくなるため (<see cref="It930xOverflow"/>)。エージェントは止まるときに閉じ終えているので何もしない。
    /// ほかのスレッドが機材の一覧を持ったまま止まっていたら、終わるのを待たせないように 2 秒であきらめる
    /// </summary>
    static It930xDevice()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            if (!Registry.TryEnter(TimeSpan.FromSeconds(2))) return;
            try
            {
                CloseAll();
            }
            finally
            {
                Registry.Exit();
            }
        };
    }

    private readonly IUsbDevice _usb;
    private readonly Action<int> _sleep;
    private readonly Lock _gate = new();
    private readonly IIt930xBoard _board;
    private readonly It930xTsDemux _demux;
    private readonly Lock _lnbGate = new();
    private readonly HashSet<int> _lnbUsers = [];

    /// <summary>
    /// 受信機を開く・閉じるを 1 つずつ通す。**ロックの順は「これ → 機材の一覧 (Registry)」** (Q3 のもう片方の側を取る・返すときに一覧のロックを取る)。
    /// 機材を閉じる側 (<see cref="Close"/>) は一覧のロックを持っているので、これを取らない
    /// </summary>
    private readonly Lock _openGate = new();
    private readonly HashSet<int> _openReceivers = [];

    /// <summary>Q3 のもう片方の側の機材を取る (無ければ null を返す)。Q3 でなければ null</summary>
    private readonly Func<It930xDevice?>? _link;

    /// <summary>電源の連動のために取っている、Q3 のもう片方の側 (IT930x の仕様書 7.4)</summary>
    private It930xDevice? _linked;

    private Thread? _reader;
    private readonly ManualResetEventSlim _readerOpened = new();
    private volatile bool _readerRunning;

    /// <summary>開くときに EP 0x84 の読みを出し終えるのを待つ長さ</summary>
    internal static readonly TimeSpan ReaderStartTimeout = TimeSpan.FromSeconds(2);
    private volatile bool _stopping;

    /// <summary>閉じ始めた (<see cref="Close"/>)。読みのスレッドは、閉じる側が入力を閉じるので自分では閉じない (電源を切ったあとにブリッジへ書かない)</summary>
    private volatile bool _closing;
    private int _users;
    private bool _closed;
    private volatile bool _faulted;

    public string Port { get; }
    public It930xModel Model { get; }
    public It930xBridge Bridge { get; }

    /// <summary>開くのにかかった時間 (ファームウェアの起動から電源を入れるまで)</summary>
    public long OpenMs { get; private set; }

    private long _tsBytes;
    private long _tsReads;

    /// <summary>EP 0x84 から読んだバイトの数 (開いてから。<c>--tune</c> が出す)</summary>
    public long TsBytes => Interlocked.Read(ref _tsBytes);

    /// <summary>EP 0x84 の読みで、1 バイト以上届いた回数</summary>
    public long TsReads => Interlocked.Read(ref _tsReads);

    /// <summary>
    /// EP 0x84 の読みの数え (<c>--tune</c> が出す)。EP 0x84 からバイトが届いているのに入力ごとのパケットが増えなければ、ブリッジは流しているが分け方で揃っていない。
    /// バイトが増えなければ、ブリッジから先で止まっている
    /// </summary>
    public string DescribeTsCounters() =>
        $"EP 0x84: {TsReads} 回で {TsBytes} バイト  入力ごとのパケット {string.Join(" ", _demux.Packets)}  "
        + $"揃え直しで飛ばした {_demux.Skipped} バイト  知らない同期バイト {_demux.Unknown}  揃え直し {_demux.Lost} 回";

    /// <summary>USB が抜けたなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted => _faulted;

    private It930xDevice(string port, It930xModel model, IUsbDevice usb, It930xBridge bridge, Action<int> sleep, Func<long> nowMs, Func<It930xDevice?>? link)
    {
        Port = port;
        Model = model;
        _usb = usb;
        Bridge = bridge;
        _sleep = sleep;
        _link = model.Paired ? link : null;
        _demux = new It930xTsDemux(model.SyncBytes);
        _board = model.Demod switch
        {
            It930xDemod.Cxd2856 => new CxdBoard(bridge, model, Label, sleep, nowMs, Fail),
            // Q3・W3 系は 4 つの受信機がどれもバス 2 にある (TC90522 の仕様書 1.1)
            It930xDemod.Tc90522T or It930xDemod.Tc90522S =>
                new Tc90522Board(new It930xI2cBus(bridge, model.Receivers[0].I2cBus), new Lock(), model, sleep, nowMs),
            _ => new Tc90522Single(new It930xI2cBus(bridge, model.Receivers[0].I2cBus), new Lock(), model.Receivers[0], Power, sleep, nowMs),
        };
    }

    private string Label => $"{Model.Name} {Port}";

    /// <summary>
    /// 取る。開いていなければ、そのとき開く。**返すのは <see cref="Release"/>**。
    /// </summary>
    public static It930xDevice Acquire(string port) => Acquire(port, () =>
    {
        var model = It930x.Identify(port) ?? throw new IOException($"USB のポート {port} に {It930x.Model} が見当たりません");
        return (It930x.OpenUsb(port, model), model);
    }, Thread.Sleep, () => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency, () => It930xFirmware.Code,
        link: () => It930x.Partner(port) is { } other ? Acquire(other) : null);

    /// <param name="open">USB を開いて機種と一緒に返す。テストは偽の機材を返す</param>
    /// <param name="firmware">確かめたファームウェア (<see cref="It930xFirmware.Code"/>)</param>
    /// <param name="waiting">機材の一覧のロックを取る直前に呼ぶ (テストが、閉じている途中の開き直しを確かめるため)</param>
    /// <param name="link">Q3 のもう片方の側の機材を取る (見つからなければ null を返す)。Q3 でない機種では呼ばない</param>
    internal static It930xDevice Acquire(
        string port, Func<(IUsbDevice Usb, It930xModel Model)> open, Action<int> sleep, Func<long> nowMs, Func<byte[]> firmware, Action? waiting = null,
        Func<It930xDevice?>? link = null)
    {
        waiting?.Invoke();
        lock (Registry)
        {
            if (Devices.TryGetValue(port, out var device))
            {
                if (!device.Faulted)
                {
                    // 閉じるのを待っている間に取り直したら、開いて電源の入ったままの機材を使う
                    device.CancelIdle();
                    lock (device._gate) device._users++;
                    return device;
                }
                // 抜けたなどで使えなくなったもの。閉じてから開き直す (同じ USB を 2 つ開かない)
                Devices.Remove(port);
                device.Close();
            }
            device = Open(port, open, sleep, nowMs, firmware, link);
            device._users = 1;
            Devices[port] = device;
            return device;
        }
    }

    /// <summary>
    /// 開く。ファームウェアを起動し、次の段の I2C と GPIO と TS の経路を設定する (IT930x の仕様書 4.2・5・7.2)。
    /// REBOOT で USB がつなぎ直されたときは、機材が戻るのを待って 1 回だけ開き直す
    /// </summary>
    private static It930xDevice Open(
        string port, Func<(IUsbDevice Usb, It930xModel Model)> open, Action<int> sleep, Func<long> nowMs, Func<byte[]> firmware, Func<It930xDevice?>? link)
    {
        byte[] code;
        try
        {
            code = firmware();
        }
        catch (InvalidDataException error)
        {
            throw new IOException(error.Message, error);
        }
        var started = Stopwatch.StartNew();
        var (usb, model) = open();
        try
        {
            var bridge = new It930xBridge(usb, sleep);
            It930xBoot boot;
            try
            {
                boot = bridge.Start(code);
            }
            catch (UsbGoneException) when (bridge.RebootSent)
            {
                usb.Dispose();
                usb = It930xProbe.Reopen(() => open().Usb, sleep);
                bridge = new It930xBridge(usb, sleep);
                boot = bridge.Start(code);
            }
            var device = new It930xDevice(port, model, usb, bridge, sleep, nowMs, link);
            device.Setup();
            device.OpenMs = started.ElapsedMilliseconds;
            Log.Write($"[{device.Label}] 開きました (ファームウェア {It930xBoot.Format(boot.Version)}{(boot.Rebooted ? "、REBOOT した" : "")}、{device.OpenMs} ms)");
            return device;
        }
        catch
        {
            usb.Dispose();
            throw;
        }
    }

    /// <summary>
    /// ブリッジの設定と電源 (IT930x の仕様書 4.2・5・7.2・7.3)。そのあと EP 0x84 を読み始める。
    /// 入力は、最初の受信機を開いたときに機種が使うものを全部開ける (<see cref="OpenInputs"/>)
    /// </summary>
    private void Setup()
    {
        if (Bridge.ConfigureReceivers(Model.Receivers) == 0)
        {
            Log.Write($"[{Label}] EEPROM の設定を読めていません (0x{It930xBridge.EepromValid:X4} が 0)。続けます");
        }
        // 開いたとき: 電源を切り (GPIOH7 か GPIOH3 = 1)、リセット中 (GPIOH2 = 0)、LNB を切る (GPIOH11 = 0)。そのあと 20 ms 待つ (CXD2856 の仕様書 11)。
        // 受信機が 1 つの機種は GPIOH11 を設定も操作もしない (IT930x の仕様書 8)
        Bridge.GpioSetup(Model.PowerPin, true);
        Bridge.GpioSetup(2, false);
        if (Model.Lnb) Bridge.GpioSetup(11, false);
        _sleep(20);
        // 受信機の TS 入力はどれもシリアル (IT930x の仕様書 5・6.1)。同期バイトが 0 の入力は使わないので、開けない (IT930x の仕様書 5)
        Bridge.ConfigureTs(new bool[It930xBridge.TsInputs], Model.SyncBytes);
        RecoverOverflow();
        if (Model.PowerWhileOpen) Power(true);
        // SDK (IT930x_probe) と同じく、EP 0x84 の読みを出して残りを読み捨ててから入力を開ける。ブリッジに来たパケットは読み続け、出口の無い入力のものは捨てる
        _reader = new Thread(ReadTs) { IsBackground = true, Name = "it930x-ts" };
        _reader.Start();
        try
        {
            // 読みを出し終える (読みのスレッドが OpenInStream から戻る) まで待つ。出せなかったら、入力を開けずに開くのを失敗にする
            if (!_readerOpened.Wait(ReaderStartTimeout) || !_readerRunning)
            {
                throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読みを始められませんでした");
            }
            if (_faulted) throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読みが、開いている間に失敗しました");
        }
        catch
        {
            // 開くのに失敗した機材は呼ぶ側が USB を閉じるので、その前に読みを止める
            _stopping = true;
            _reader.Join(TimeSpan.FromSeconds(2));
            throw;
        }
    }

    /// <summary>
    /// 開くときに TS のバッファの溢れ (<see cref="It930xOverflow"/>) が立っていたら、記録に出して TS の経路をリセットし直す (<see cref="It930xBridge.ResetTs"/>)。
    /// EP 0x84 の読みを出す前に呼ぶ。リセットしても立ったままなら、電源を抜くように記録に出して開くのは続ける
    /// (TS が届くかは選局してから分かる。溢れの値が何を表すかは brRegister.h の名前からの推定)
    /// </summary>
    private void RecoverOverflow()
    {
        var overflow = Bridge.ReadOverflow();
        _overflow = overflow;
        if (!overflow.Any) return;
        Log.Write($"[{Label}] 開いたときに TS のバッファが溢れていました ({overflow}{Receivers(overflow)})。TS の経路をリセットし直します");
        overflow = Bridge.ResetTs();
        _overflow = overflow;
        Log.Write(overflow.Any
            ? $"[{Label}] リセットしても溢れたままです ({overflow})。TS が届かなければ、機材の電源を抜いて入れ直してください (REBOOT や受信機の電源の入れ直しでは戻りません)"
            : $"[{Label}] 溢れが下りました");
    }

    /// <summary>最後に読んだ溢れ (変わったときだけ記録に出すため)</summary>
    private volatile It930xOverflow? _overflow;

    /// <summary>
    /// TS のバッファの溢れを読み、前に読んだときから変わっていれば記録に出す (選局したあと、流し始める・止めるとき、LNB の給電を切り替えたあと、閉じるとき)。
    /// 読めなければ何もしない (抜けたかどうかは EP 0x84 の読みとほかの操作が決める)
    /// </summary>
    internal void WatchOverflow(string when)
    {
        It930xOverflow overflow;
        try
        {
            overflow = Bridge.ReadOverflow();
        }
        catch (IOException)
        {
            return;
        }
        var before = _overflow;
        _overflow = overflow;
        if (before is not null && before.System == overflow.System && before.Inputs.SequenceEqual(overflow.Inputs)) return;
        if (!overflow.Any && before is not { Any: true }) return;
        Log.Write(overflow.Any
            ? $"[{Label}] {when}に TS のバッファが溢れていました ({overflow}{Receivers(overflow)})。EP 0x84 の読みが追いつかなかったと推定します"
            : $"[{Label}] {when}に TS のバッファの溢れが下りていました");
    }

    /// <summary>溢れた入力の受信機 (「、受信機 2」)</summary>
    private string Receivers(It930xOverflow overflow)
    {
        var receivers = overflow.Overflowed
            .SelectMany(input => Model.Receivers.Where(receiver => receiver.TsInput == input).Select(receiver => receiver.Index))
            .ToList();
        return receivers.Count == 0 ? "" : $"、受信機 {string.Join("・", receivers)}";
    }

    /// <summary>
    /// 受信機の基板の電源を入れる・切る (IT930x の仕様書 7.2・7.3)。
    /// 入れる: 電源の GPIOH ← 0、80 ms (GPIOH3 の機種は 100 ms)、GPIOH2 ← 1 (リセットを解く)、20 ms。切る: GPIOH2 ← 0、電源の GPIOH ← 1
    /// </summary>
    internal void Power(bool on)
    {
        if (on)
        {
            Bridge.Gpio(Model.PowerPin, false);
            _sleep(Model.PowerWaitMs);
            Bridge.Gpio(2, true);
            _sleep(20);
        }
        else
        {
            Bridge.Gpio(2, false);
            Bridge.Gpio(Model.PowerPin, true);
        }
    }

    /// <summary>EP 0x84 を読み、受信機ごとの出口に分ける。閉じるか、読めなくなるまで</summary>
    private void ReadTs()
    {
        try
        {
            using var input = _usb.OpenInStream(It930xBridge.TsIn, It930xBridge.TsTransferSize, It930xBridge.TsDepth);
            _readerRunning = true;
            _readerOpened.Set();
            var buffer = new byte[It930xBridge.TsTransferSize];
            while (!_stopping)
            {
                var got = input.Read(buffer, TsReadTimeoutMs);
                if (got <= 0) continue;
                Interlocked.Add(ref _tsBytes, got);
                Interlocked.Increment(ref _tsReads);
                _demux.Push(buffer.AsSpan(0, got));
            }
        }
        catch (IOException error)
        {
            // 閉じている途中の失敗 (入力を閉じて EP 0x84 をリセットした読み) は、閉じる側が片付ける
            if (_stopping || _closing) return;
            // EP 0x84 の読みは全部の受信機で 1 本なので、読めなくなったら機材ごと使えないものとし、次の選局で開き直す
            _faulted = true;
            Log.Write($"[{Label}] TS を読めなくなりました: {UsbDevices.Reason(error)}");
            // 読む側がいないまま入力を開けておくと、ブリッジのバッファが溢れ、電源を抜くまで TS が届かなくなる (It930xOverflow)。
            // 閉じるのは使っている側が返してからなので、それまで待たずにここで入力を閉じる
            if (error is not UsbGoneException) CloseInputs();
            for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete(error.Message);
        }
        finally
        {
            // どの終わり方でも、開くのを待っている Setup を待たせたままにしない (読みを始められていなければ _readerRunning は false のまま)
            _readerOpened.Set();
        }
    }

    /// <summary>入力を全部閉じて EP 0x84 をリセットする (<see cref="It930xBridge.DisableTsInputs"/>)。閉じられなければ記録に出す</summary>
    private void CloseInputs()
    {
        try
        {
            Bridge.DisableTsInputs();
        }
        catch (IOException error)
        {
            Log.Write($"[{Label}] TS の入力を閉じられませんでした ({error.Message})");
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> を開いて、後ろのチップを返す。開いていれば、そのまま返す。
    /// 開けなければ <see cref="IOException"/> (その受信機だけ。次の呼び出しでもう一度試す)。
    /// Q3 は、この側で最初の受信機を開くときに、もう片方の側の機材も取る (電源の連動。IT930x の仕様書 7.4)
    /// </summary>
    public IIt930xFrontend Frontend(int receiver)
    {
        Wiring(receiver);
        lock (_openGate)
        {
            if (_openReceivers.Count == 0) Link();
            try
            {
                IIt930xFrontend frontend;
                try
                {
                    frontend = _board.Open(receiver);
                }
                catch (IOException error) when (CanRepower(error))
                {
                    /*
                     * 電源を入れた直後の初期化に失敗したら、電源を入れ直して 1 回だけやり直す (仕様書に無い)。リセットが足りずにチップが応答しないまま、
                     * 機材を閉じるまで直らないことを避ける。切る → 20 ms → 入れる、の順と待ちは開くときと同じ (IT930x の仕様書 7.2)。
                     * 電源が GPIOH3 の機種は、開くのに失敗したときに電源を切ってあり、開き直すと入れ直す
                     */
                    Log.Write($"[{Label}] 受信機 {receiver} を初期化できませんでした ({error.Message})。電源を入れ直して、もう一度試します");
                    if (Model.PowerWhileOpen)
                    {
                        Power(false);
                        _sleep(20);
                        Power(true);
                    }
                    frontend = _board.Open(receiver);
                }
                OpenInputs();
                if (_openReceivers.Add(receiver)) Log.Write($"[{Label}] 受信機 {receiver} を開きました ({frontend.Chips})");
                return frontend;
            }
            catch (IOException error)
            {
                Fail(error);
                if (_openReceivers.Count == 0) Unlink();
                throw new IOException($"{Label} の受信機 {receiver} を初期化できません: {error.Message}", error);
            }
        }
    }

    /// <summary>ブリッジの入力を開けたか (<see cref="OpenInputs"/>)。<c>_gate</c> の中で読み書きする</summary>
    private bool _inputsOpen;

    /// <summary>
    /// 機種が使う入力を全部開ける (<see cref="It930xBridge.EnableTsInputs"/>)。最初の受信機を開いたときの 1 回で、閉じるまで開けたままにし、受信機ごとには開け閉めしない
    /// (SDK も受信を始める・止めるときは EP 0x84 の読みだけを出し入れする)。
    /// 機材を開いただけ (Q3 のもう片方の側の電源のため、カードのため) では開けない。PX-Q3PE4 で、電源を入れただけで初期化していない TC90522 の入力が溢れ、
    /// そのブリッジは電源を抜くまで TS を出さなくなった (2026-11-11。受信機を開いた側は、初期化のあとに入力を開けても溢れなかった)
    /// </summary>
    private void OpenInputs()
    {
        lock (_gate)
        {
            if (_inputsOpen || _closed) return;
            Bridge.EnableTsInputs();
            _inputsOpen = true;
            // 開ける前後に読みが失敗していたら、読む側のいない入力を開けたままにしない (読みのスレッドが閉じるのと前後しても、最後に閉じる)
            if (_faulted)
            {
                CloseInputs();
                throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読みが、開いている間に失敗しました");
            }
        }
    }

    /// <summary>
    /// ブリッジの TS のバッファを捨てる (IT930x の仕様書 6.3)。SDK の <c>DRV_ResetRxPort</c> と同じく、入力を全部閉じ、10 ms 待ってから <c>0xDA1D</c> に 1 と 0 を書き、
    /// 入力を全部開け直す。流しているほかの受信機の TS も、その間は欠ける。ロックしているのに TS が届かないときに <c>--tune</c> が試す。
    /// 閉じた機材では何もしない (閉じる処理が閉じた入力を開け直さない)。閉じる処理とは <c>_gate</c> で交わらないようにする
    /// </summary>
    public void FlushTs()
    {
        lock (_gate)
        {
            if (_closed) return;
            // 閉じるのに失敗したら、そのまま投げる。閉じきったか分からない入力を開け直さず、元の失敗を隠さない
            Bridge.DisableTsInputs();
            if (_inputsOpen) Bridge.EnableTsInputs();
        }
    }

    /// <summary>
    /// 初期化の失敗のあと、電源を入れ直してよいか。この機材で開いている受信機が無く、使っている側がいまの 1 つだけのとき
    /// (カードや、Q3 のもう片方の側の受信機が使っていれば、その側の動作を止めてしまうので入れ直さない)。USB が抜けたときは入れ直さない。
    /// CXD2856ER の機種は、受信機ごとに初期化して、失敗した受信機だけを次の選局でやり直すので、入れ直さない (CXD2856 の仕様書 2.2)
    /// </summary>
    private bool CanRepower(IOException error)
    {
        if (Model.Demod == It930xDemod.Cxd2856 || error is UsbGoneException || error.InnerException is UsbGoneException) return false;
        if (_openReceivers.Count > 0) return false;
        lock (_gate) return _users == 1;
    }

    /// <summary>Q3 のもう片方の側を取る。見つからない・開けないときは、記録に出して見つかった側だけを使う</summary>
    private void Link()
    {
        if (_link is null || _linked is not null) return;
        try
        {
            _linked = _link();
            if (_linked is null) Log.Write($"[{Label}] 同じ筐体のもう片方の側が見つからないか、USB のシリアル番号を読めません。この側だけを使います (電源は連動しません)");
        }
        catch (IOException error)
        {
            Log.Write($"[{Label}] 同じ筐体のもう片方の側を開けませんでした ({error.Message})。この側だけを使います (電源は連動しません)");
        }
    }

    /// <summary>
    /// 取っていたもう片方の側を返す。そちらも誰も使っていなければ、待たずに閉じる (電源が切れる)。
    /// この側は閉じる前に <see cref="IdleGrace"/> を待ち終えていて、もう片方の側はこの側の電源のために取っていただけなので、もう一度は待たない
    /// </summary>
    private void Unlink()
    {
        if (Interlocked.Exchange(ref _linked, null) is not { } partner) return;
        partner.Release();
        CloseIfIdle(partner.Port, TimeSpan.Zero);
    }

    private It930xReceiver Wiring(int receiver) =>
        Model.Receivers.FirstOrDefault(item => item.Index == receiver)
        ?? throw new IOException($"{Model.Name} に受信機 {receiver} はありません (0〜{Model.Receivers.Count - 1})");

    /// <summary>
    /// 受信機の TS を <paramref name="output"/> に流し始める。ブリッジには書かない (入力は開いたときから全部開いている。<see cref="Setup"/>)。
    /// 5 つの入力は 1 つの経路にまとまるので、ほかの受信機が流している間にブリッジの TS の経路を書き換えないため。
    /// 流し始める前に溢れを読み、立っていれば記録に出す (<see cref="WatchOverflow"/>)
    /// </summary>
    internal void Attach(int receiver, It930xTsOutput output)
    {
        var input = Wiring(receiver).TsInput;
        WatchOverflow($"受信機 {receiver} の TS を流し始めるとき");
        _demux.Attach(input, output)?.Complete();
    }

    /// <summary>受信機の TS を止める (出口を外して止める)。ブリッジには書かず、その入力のパケットはこのあと捨てる。止めたあとに溢れを読む</summary>
    public void Detach(int receiver)
    {
        var input = Wiring(receiver).TsInput;
        if (_demux.Detach(input) is { } output)
        {
            output.Complete();
            WatchOverflow($"受信機 {receiver} の TS を止めるとき");
        }
    }

    /// <summary>
    /// 使い終えた受信機を閉じ、LNB の給電の要求を取り下げる。
    /// CXD2856ER の機種は、チューナーを止めて復調器をスリープにしてから取り下げる (CXD2856 の仕様書 10.3 の手順 2〜4)。
    /// TC90522 の機種は、取り下げてから閉じる (TC90522 の仕様書 9.3 の 1〜3)。閉じるのに失敗しても給電の要求は取り下げる
    /// </summary>
    public void Rest(int receiver)
    {
        lock (_openGate) Rest(receiver, linked: true);
    }

    private void Rest(int receiver, bool linked)
    {
        // この機種に無い番号 (設定の番号が機種の受信機の数を超えている) は、開いていないので何もしない
        if (Model.Receivers.All(item => item.Index != receiver)) return;
        var lnbFirst = Model.Demod != It930xDemod.Cxd2856;
        try
        {
            if (lnbFirst) Lnb(receiver, false);
            _board.Close(receiver);
        }
        finally
        {
            _openReceivers.Remove(receiver);
            try
            {
                if (!lnbFirst) Lnb(receiver, false);
            }
            finally
            {
                if (linked && _openReceivers.Count == 0) Unlink();
            }
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> が LNB の給電を要求する・要求を取り下げる (IT930x の仕様書 8、IT930x の仕様書 8)。給電は機材 (Q3 は側) の受信機で 1 つ (ブリッジの GPIOH11。1 で入る) なので、
    /// 給電を要求している受信機の数が 0 から 1 になるときに入れ、1 から 0 になるときに切る。書き込みに失敗したら、要求している受信機の数は書く前に戻す
    /// </summary>
    public void Lnb(int receiver, bool on)
    {
        if (on && !Model.Lnb) throw new IOException($"{Model.Name} は LNB に給電できません");
        lock (_lnbGate)
        {
            if (on == _lnbUsers.Contains(receiver)) return;
            var before = _lnbUsers.Count;
            if (on) _lnbUsers.Add(receiver);
            else _lnbUsers.Remove(receiver);
            var after = _lnbUsers.Count;
            if ((before == 0) == (after == 0)) return;
            try
            {
                Bridge.Gpio(11, after > 0);
            }
            catch
            {
                if (on) _lnbUsers.Remove(receiver);
                else _lnbUsers.Add(receiver);
                throw;
            }
            Log.Write($"[{Label}] LNB の給電を{(after > 0 ? "入れました" : "切りました")}");
            // PX-Q3PE4 で衛星の選局のときだけブリッジの出力が止まったので、給電の切り替えがきっかけかを記録で絞る (2026-11-11)
            WatchOverflow($"LNB の給電を{(after > 0 ? "入れた" : "切った")}あと");
        }
    }

    /// <summary>LNB の給電を要求している受信機の数 (テストのため)</summary>
    internal int LnbUsers
    {
        get
        {
            lock (_lnbGate) return _lnbUsers.Count;
        }
    }

    /// <summary>
    /// LNB に給電している間の、短絡の検出の入力 (IT930x の仕様書 8。GPIOH10 を有効にして入力にし、値を読む。true で正常、false で短絡)。
    /// 検出の端子が無い機種と、給電していないときは null。<c>--tune</c> の出力にだけ使う (実機で確かめた記録の無い値)
    /// </summary>
    public bool? LnbSense()
    {
        if (Model.LnbSensePin is not { } pin) return null;
        lock (_lnbGate) return _lnbUsers.Count == 0 ? null : Bridge.GpioRead(pin);
    }

    /// <summary>電源の連動のために、Q3 のもう片方の側を取っているか (テストのため)</summary>
    internal bool Linked => _linked is not null;

    /// <summary>失敗が USB の抜けなら使えないものとする (次に取る側は開き直す)</summary>
    public void Fail(Exception error)
    {
        if (error is UsbGoneException || error.InnerException is UsbGoneException) _faulted = true;
    }

    /// <summary>返す。開いたままにする (USB が抜けていれば閉じる)</summary>
    public void Release()
    {
        lock (_gate)
        {
            if (--_users > 0) return;
        }
        if (!Faulted) return;
        // 閉じ終わるまで Registry を持つ。同じポートを開き直す Acquire は、古いほうが電源を切り終えてから開く
        lock (Registry)
        {
            if (Devices.TryGetValue(Port, out var current) && current == this) Devices.Remove(Port);
            Close();
        }
    }

    /// <summary>
    /// 誰も使っていなければ、<see cref="IdleGrace"/> のあとに閉じる (チューナーが捨てられたとき・カードを閉じたとき)。
    /// 待つ間に取り直されたら閉じない。すぐには電源を切らない (下の <paramref name="grace"/>)
    /// </summary>
    public static void CloseIfIdle(string port) => CloseIfIdle(port, IdleGrace);

    /// <summary>
    /// 誰も使っていなければ、<paramref name="grace"/> のあとに閉じる。0 ならすぐ閉じる (テストと <c>--it930x-cycle</c>)。
    /// 閉じ終わるまで Registry を持つので、同じポートの Acquire は閉じ終えてから開く (古いほうの電源を切る書き込みが、新しく開いた機材に届かない)。
    /// 待つ間に <see cref="Acquire(string)"/> が取り直せば、開いて電源の入ったままの機材をそのまま使う
    /// </summary>
    internal static void CloseIfIdle(string port, TimeSpan grace)
    {
        lock (Registry)
        {
            if (!Devices.TryGetValue(port, out var device)) return;
            lock (device._gate)
            {
                if (device._users > 0) return;
            }
            if (grace > TimeSpan.Zero)
            {
                device.ScheduleIdle(grace);
                return;
            }
            Devices.Remove(port);
            device.Close();
        }
    }

    /// <summary>
    /// 最後の利用者が返してから閉じるまでの間。**電源を切って入れ直すのを続けて繰り返さない。**
    /// 本番では、カードの状態を確かめるたび (使っていない内蔵カードリーダーを開いて閉じる) に電源を切って入れ直し、続けて 13 回入り切りしたあと、
    /// 全受信機の TS が電源を抜くまで止まった (CXD2856 の仕様書 12.5)。短い間の入り切りを、いちばん疑っている
    /// </summary>
    public static readonly TimeSpan IdleGrace = TimeSpan.FromSeconds(30);

    /// <summary>閉じるのを待っている間の時計 (取り直したら止める)。Registry の中で読み書きする</summary>
    private Timer? _idle;

    /// <summary><paramref name="grace"/> のあとに、まだ誰も使っていなければ閉じる。前に待っていたものは置き換える。Registry の中で呼ぶ</summary>
    private void ScheduleIdle(TimeSpan grace)
    {
        CancelIdle();
        Timer? timer = null;
        timer = new Timer(_ =>
        {
            lock (Registry)
            {
                // 取り直されたか、置き換えられたか、もう閉じた
                if (_idle != timer || !Devices.TryGetValue(Port, out var current) || current != this) return;
                _idle = null;
                timer!.Dispose();
                lock (_gate)
                {
                    if (_users > 0) return;
                }
                Devices.Remove(Port);
                Close();
            }
        });
        _idle = timer;
        timer.Change(grace, Timeout.InfiniteTimeSpan);
    }

    /// <summary>閉じるのを待っているのをやめる (取り直したとき・すぐ閉じるとき)。Registry の中で呼ぶ</summary>
    private void CancelIdle()
    {
        _idle?.Dispose();
        _idle = null;
    }

    /// <summary>
    /// 電源を切ったあと USB を閉じるまでの待ち (ms。ふだんは <see cref="PowerOffSettleMs"/>)。
    /// 0 にするのは、待たずに入り切りを繰り返した前の動きを再現する <c>--it930x-cycle --no-wait</c> だけ
    /// </summary>
    internal int PowerOffWaitMs { get; set; } = PowerOffSettleMs;

    /// <summary>全部閉じる (エージェントを止めるとき。<c>--tune</c> の終わり)。使っている側がいても閉じる</summary>
    public static void CloseAll() => CloseAll(_ => true);

    /// <summary>
    /// <paramref name="which"/> のポートを、閉じるのを待っている間でもすぐ閉じる (<see cref="CloseAll()"/> の本体。
    /// テストは、並んで走るほかのテストの機材を閉じないように自分のポートだけを渡す)
    /// </summary>
    internal static void CloseAll(Func<string, bool> which)
    {
        lock (Registry)
        {
            // 閉じる途中で、Q3 のもう片方の側を返して一覧から外すことがあるので、写しを回す
            foreach (var (port, device) in Devices.Where(entry => which(entry.Key)).ToList())
            {
                device.Close();
                Devices.Remove(port);
            }
        }
    }

    /// <summary>
    /// ブリッジの入力を全部閉じ、受信機を全部スリープにし、電源を切って (GPIOH2 ← 0、電源の GPIOH ← 1)、USB を閉じる。抜けていれば書かずに閉じる。
    /// 電源が GPIOH3 の機種は、受信機を閉じたときに電源を切っている。閉じるのを待っていたら、その待ちはやめる。Registry の中で呼ぶ
    /// </summary>
    private void Close()
    {
        CancelIdle();
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
        }
        _closing = true;
        // 入力を閉じて EP 0x84 をリセットしてから読みを止める (SDK の DRV_ResetRxPort)。読む側がいないまま、ブリッジに TS を溜めない
        if (!Faulted)
        {
            CloseInputs();
            WatchOverflow("閉じるとき");
        }
        _stopping = true;
        _reader?.Join(TimeSpan.FromSeconds(2));
        for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete();
        if (!Faulted)
        {
            // 受信機 1 つのスリープに失敗しても、ほかの受信機と電源は切る (USB が抜けたときは、電源を切る書き込みも失敗して下で記録に出る)
            foreach (var receiver in Model.Receivers)
            {
                try
                {
                    Rest(receiver.Index, linked: false);
                }
                catch (IOException error)
                {
                    Log.Write($"[{Label}] 受信機 {receiver.Index} をスリープにできませんでした ({error.Message})");
                }
            }
            try
            {
                if (Model.PowerWhileOpen)
                {
                    Power(false);
                    // 電源が落ちきる前に入れ直さないよう、USB を閉じる前に待つ (IT930x の仕様書 7.2・10、CXD2856 の仕様書 10.3)。閉じている間は Registry を持っているので、
                    // 同じポートを開き直す Acquire (次に電源を入れる書き込み) もこの待ちのあとになる
                    _sleep(PowerOffWaitMs);
                }
            }
            catch (IOException error)
            {
                Log.Write($"[{Label}] 電源を切れませんでした ({error.Message})");
            }
        }
        _usb.Dispose();
        Log.Write($"[{Label}] 閉じました");
        // 取っていたもう片方の側を返す (USB を閉じたあと。一覧のロックは持っている)
        Unlink();
    }
}

/// <summary>
/// IT930x の機材の受信機 1 つ (設定の <c>it930x:&lt;USB のポート&gt;:&lt;受信機&gt;</c>)。受信機が受けられる方式 (機種の表の <see cref="It930xReceiver.Types"/>) を選局する。
/// 受けられない種別と、給電できない機種への 15V の指定は、機材に触る前に断る。
/// J.83B の TS はスクランブルされたまま流す (スカパー！プレミアムのカードはまだ扱わない。<see cref="Lease"/> は B-CAS のカードに問い合わせない)。
/// 機材 (<see cref="It930xDevice"/>) は最初の選局で取り、捨てるときに返す。
/// 選局のたびに新しい出口 (<see cref="It930xTsOutput"/>。Pipe と DeviceStream) を作り、前の選局のパケットと混ぜない
/// </summary>
public sealed class It930xTuner : ITuneDevice
{
    /// <summary>LNB の給電の設定で受け付ける値。給電は 15 V だけ (IT930x の仕様書 8、IT930x の仕様書 8。0 か 15 V のほかは断る)</summary>
    public const string Lnb15v = "15v";

    private readonly string _name;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly Func<It930xDevice> _acquire;
    private readonly Action? _closeIdle;
    private readonly Func<It930xModel?>? _identify;
    private readonly Lock _gate = new();
    private It930xDevice? _device;
    private It930xModel? _model;
    private IIt930xFrontend? _frontend;
    private It930xTsOutput? _output;

    /// <summary>最後の選局で、受信機の選局 (チップへの書き込み) まで進んだ。<see cref="Diagnose"/> が前の選局の値を出さないようにする</summary>
    private bool _attempted;

    /// <param name="lnb">設定の LNB (<c>15v</c> なら衛星を選局するときに給電する。空か null なら給電しない。<c>11v</c> などは衛星の選局で断る)</param>
    public It930xTuner(string port, int receiver, string? lnb = null)
        : this($"{It930x.Model} {port} #{receiver}", receiver, () => It930xDevice.Acquire(port), () => It930xDevice.CloseIfIdle(port), lnb, () => It930x.Identify(port))
    {
    }

    /// <param name="identify">機材を開かずに機種を調べる (受けられない種別を、機材に触る前に断るため)。分からなければ null を返す</param>
    internal It930xTuner(string name, int receiver, Func<It930xDevice> acquire, Action? closeIdle = null, string? lnb = null, Func<It930xModel?>? identify = null)
    {
        _name = name;
        _receiver = receiver;
        _acquire = acquire;
        _closeIdle = closeIdle;
        _identify = identify;
        _lnb = string.IsNullOrEmpty(lnb) ? null : lnb;
    }

    public Stream Output => _output?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    /// <summary>いまの出口が、読む側が詰まって捨てたパケットの数 (<c>--tune --steps</c> が出す)</summary>
    public long Dropped => _output?.Dropped ?? 0;

    public bool Tuned
    {
        get
        {
            lock (_gate) return _output is { Closed: false };
        }
    }

    /// <summary>最後の選局で、ロックを確かめ始めてからロックするまで (ms)。<c>--tune</c> が出す</summary>
    public long LockMs => _frontend?.LockMs ?? -1;

    /// <summary>衛星で最後に <see cref="Signal"/> を読んだときの強度 (dB。dBm として扱えるかは未確認)。<c>--tune</c> だけが出す</summary>
    public double? SatelliteLevelDb => _frontend?.SatelliteLevelDb;

    /// <summary>いまの機材 (<c>--tune</c> が開くのにかかった時間を出す)。選局していなければ null</summary>
    public It930xDevice? Device => _device;

    /// <summary>受信の状態と C/N と強度。選局の最中 (ロックを待っている間) は待たずに null を返す</summary>
    public TunerSignal? Signal()
    {
        if (!_gate.TryEnter()) return null;
        try
        {
            if (_frontend is not { } frontend || _output is null) return null;
            return frontend.Signal();
        }
        catch (IOException error)
        {
            _device?.Fail(error);
            return null;
        }
        finally
        {
            _gate.Exit();
        }
    }

    /// <summary>TS を止める復調器のレジスタ 4 つ (CXD2856 の仕様書 3.5)。ロックしているのに TS が届かないときに <c>--tune</c> が出す。CXD2856ER の機種で初期化していなければ null</summary>
    public CxdTsOutput? ReadTsOutput()
    {
        lock (_gate) return (_frontend as CxdReceiver)?.Chip.ReadTsOutput();
    }

    /// <summary>ブリッジの TS のバッファを捨てる (IT930x の仕様書 6.3。<see cref="It930xDevice.FlushTs"/>)。<c>--tune</c> が、TS が届かないときに試す</summary>
    public void FlushTs()
    {
        lock (_gate) _device?.FlushTs();
    }

    /// <summary>初期化の前に読んだチューナーの <c>62</c> (CXD2856 の仕様書 10.3。<see cref="Cxd2856Frontend.PowerProbe"/>)。<c>--tune</c> が出す。CXD2856ER の機種だけ</summary>
    public byte? PowerProbe => (_frontend as CxdReceiver)?.Chip.PowerProbe;

    /// <summary>周波数 (Hz) を kHz に丸める (チューナーに渡すのは中心周波数の kHz。CXD2856 の仕様書 5.1、TC90522 の仕様書 4.1)</summary>
    internal static uint Khz(uint hertz) => (uint)((hertz + 500L) / 1000);

    /// <summary>衛星で受けているとき、TMCC から読んだ相対 TS 0〜7 の TSID (<c>--tune</c> が出す)。読めなければ null</summary>
    public ushort[]? SatelliteStreams()
    {
        lock (_gate)
        {
            try
            {
                return _output is null ? null : _frontend?.SatelliteStreams();
            }
            catch (IOException error)
            {
                _device?.Fail(error);
                return null;
            }
        }
    }

    /// <summary><c>--tune</c> だけに出す、チップごとの読み値 (<see cref="IIt930xFrontend.Notes"/>)。受けていなければ空</summary>
    public IReadOnlyList<string> Notes()
    {
        lock (_gate)
        {
            try
            {
                if (_output is null || _frontend is null || _device is null) return [];
                var notes = _frontend.Notes();
                // 給電しているときは、短絡の検出の入力も出す (TC90522 の仕様書 12 の 15)
                return _device.LnbSense() is { } ok
                    ? [.. notes, $"LNB の短絡の検出 (GPIOH10)  {(ok ? "1 (正常)" : "0 (短絡)")}  (未確認の値)"]
                    : notes;
            }
            catch (IOException error)
            {
                _device?.Fail(error);
                return [];
            }
        }
    }

    /// <summary>
    /// 選局に失敗したあとに <c>--tune</c> が出す行 (<see cref="IIt930xFrontend.Diagnose"/>)。受信機を開く前に失敗したときは空。CXD2856ER の受信機は地上波の選局の経過だけ。
    /// 選局に失敗しても受信機は開いたままなので、チューナーと復調器を読める
    /// </summary>
    public IReadOnlyList<string> Diagnose()
    {
        lock (_gate)
        {
            try
            {
                return _attempted && _device is { Faulted: false } ? _frontend?.Diagnose() ?? [] : [];
            }
            catch (IOException error)
            {
                _device?.Fail(error);
                return [];
            }
        }
    }

    /// <summary>種別の、画面と同じ呼び方 (docs/writing.md)</summary>
    private static string TypeName(string type) => type switch
    {
        "GR" => "地上波",
        ChannelTable.Sky => "スカパー！プレミアム",
        ChannelTable.Catv => "ISDB-C (ケーブルテレビ)",
        _ => type,
    };

    /// <summary>文に入れるとき、半角の英数字で始まる・終わる側に半角の空白を足す (「は BS を」「は地上波を」。docs/writing.md)</summary>
    private static string Spaced(string text) => (char.IsAscii(text[0]) ? " " : "") + text + (char.IsAscii(text[^1]) ? " " : "");

    /// <summary>
    /// その機種のこの受信機で選局できるかを確かめる。受けられない種別と、給電できない機種への 15V の指定を断る。
    /// 機材を開く前 (機種が分かっていれば) と、開いたあと受信機に触る前に呼ぶ
    /// </summary>
    private void Check(ChannelTable.Tuning tuning, It930xModel model)
    {
        if (model.Receivers.FirstOrDefault(item => item.Index == _receiver) is not { } wiring)
        {
            throw new IOException($"{model.Name} に受信機 {_receiver} はありません (0〜{model.Receivers.Count - 1})");
        }
        if (!wiring.Takes(tuning))
        {
            throw new IOException(
                $"{_name} ({model.Name} の受信機 {_receiver}) は{Spaced(TypeName(tuning.Type))}を受けられません (受けられるのは{Spaced(string.Join("・", wiring.Types.Select(TypeName))).TrimEnd()})");
        }
        if (tuning.Satellite && _lnb == Lnb15v && !model.Lnb)
        {
            throw new IOException($"{_name} ({model.Name}) は LNB に給電できません。設定の LNB を空にして、ほかの機器から給電してください");
        }
    }

    public void Tune(ChannelTable.Tuning tuning)
    {
        // 給電は 15 V だけ (IT930x の仕様書 8、IT930x の仕様書 8)。11 V は機材を開く前に断る
        if (tuning.Satellite && _lnb is not null && _lnb != Lnb15v)
        {
            throw new IOException($"{_name} の LNB の給電は 15V だけです (設定は {_lnb})");
        }
        lock (_gate)
        {
            _attempted = false;
            // 受けられない種別は、機材に触る前に断る。機種は開かずに調べ、分からなければ開いたあとに確かめる
            _model ??= _device?.Model ?? _identify?.Invoke();
            if (_model is { } known) Check(tuning, known);
            StopOutput();
            IsdbcLocked = false;
            Tsmf = null;
            Tlv = null;
            IsdbcFailedSignal = null;
            // 抜けた・TS を読めなくなった機材は返して、開き直す
            if (_device is { Faulted: true }) Drop();
            try
            {
                _device ??= _acquire();
                if (_model != _device.Model)
                {
                    _model = _device.Model;
                    Check(tuning, _model);
                }
                _frontend = _device.Frontend(_receiver);
                // 給電を入れてから選局する (順は IT930x の仕様書 8。LNB が出力を出すまでの待ちは仕様書に無く、ロックの待ち (3 秒) に含める)
                _device.Lnb(_receiver, tuning.Satellite && _lnb == Lnb15v);
                _attempted = true;
                var locked = _frontend.Tune(tuning);
                if (tuning.IsdbC) IsdbcLocked = locked;
                if (!locked) throw new IOException(ITuneDevice.SyncFailed);
                // 選局 (起動・RT710・ロック) のあいだに溢れが立ったかを、流し始める前に記録で絞る (PX-Q3PE4 の衛星。2026-11-11)
                _device.WatchOverflow($"受信機 {_receiver} を選局したあと");
                // TSMF で TS を選ぶ処理は ISDB-C のときだけ通す (CXD2856 の仕様書 10.1)。ロックのあとで作る (CXD2856 の仕様書 8.7 の「パケットごとの処理」の 1)。
                // TSMF の判定の状態は、選局のたびに TsmfSelector を作り直して最初に戻す
                var tsmf = tuning.IsdbC ? new TsmfSelector(tuning.TsmfIndex) : null;
                Tsmf = tsmf;
                // 選んだ TS が分割 TLV なら TLV パケットに組み立てる (どちらかは TSMF の判定で決まるので、ISDB-C なら作っておく)
                var tlv = tsmf is null ? null : new SplitTlv();
                Tlv = tlv;
                var output = new It930xTsOutput(tsmf, tlv);
                _device.Attach(_receiver, output);
                _output = output;
                // 受信を始めるときに、復調器の TS の端子を出す (TC90522 の仕様書 9.1)
                _frontend.Stream(true);
                if (tsmf is not null) WaitTsmf(_frontend, tsmf);
            }
            catch (IOException error)
            {
                if (_device is { } device)
                {
                    // 選局できなかった受信機は給電の要求を取り下げる (受けていない受信機のために LNB を入れたままにしない。IT930x の仕様書 8 は前の指定に戻すと書く)
                    try
                    {
                        device.Lnb(_receiver, false);
                    }
                    catch (IOException)
                    {
                        // 元の失敗を返す
                    }
                    device.Fail(error);
                    if (device.Faulted) Drop();
                }
                if (error is UsbGoneException) throw new IOException($"{error.Message}。挿し直してください", error);
                throw;
            }
        }
    }

    /// <summary>最後の J.83B の選局で受けた周波数 (Hz。<c>--tune</c> が出す)。J.83B でなければ null</summary>
    public uint? CableFrequency => _frontend?.CableFrequency;

    /// <summary>最後の J.83B の選局で読んだ変調 (<c>256QAM</c> など。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public string? CableModulation => _frontend?.CableModulation;

    /// <summary>最後の J.83B の選局で読んだ PER (<see cref="Signal"/> を読んだあと。J.83B で値が正しいかは未確認)。<c>--tune</c> だけが出す</summary>
    public double? CablePer => _frontend?.CablePer;

    /// <summary>ISDB-C で「指定した TS が無い」ときの失敗の文の先頭 (CXD2856 の仕様書 8.7。ロックしないときの <see cref="ITuneDevice.SyncFailed"/> とは別の失敗)</summary>
    public const string TsmfMissing = "指定した TS がありません";

    /// <summary>ISDB-C でロックしたのに、TSMF の判定の時間切れまで TS が 1 パケットも届かなかったときの失敗の文 (IT930x の仕様書 6.3)</summary>
    public const string TsMissing = "ロックしましたが、TS が 1 パケットも届きません (ブリッジから先で TS が止まっています)";

    /// <summary>TSMF の判定の時間切れ (ms。CXD2856 の仕様書 8.7・11 の 3 秒)。変えるのはテストのため</summary>
    internal int TsmfTimeoutMs { get; init; } = TsmfSelector.TimeoutMs;

    /// <summary>最後の選局が ISDB-C で、復調器がロックしたか (<c>--tune</c> が出す)</summary>
    public bool IsdbcLocked { get; private set; }

    /// <summary>最後の ISDB-C の選局の TSMF の判定 (<c>--tune</c> が出す)。選局に失敗したあとも残す。ISDB-C でないか、ロックしなかったなら null</summary>
    public TsmfSelector? Tsmf { get; private set; }

    /// <summary>最後の ISDB-C の選局で、分割 TLV を組み立てる処理 (<c>--tune</c> が数を出す)。選んだ TS が MPEG-2 TS なら何も数えない。ISDB-C でなければ null</summary>
    public SplitTlv? Tlv { get; private set; }

    /// <summary>流しているバイト列の形式。TSMF から選んだ TS が分割 TLV なら <see cref="StreamFormat.Tlv"/> (<see cref="TsmfSelector.Format"/>)</summary>
    public StreamFormat Format => Tsmf?.Format ?? StreamFormat.Ts;

    /// <summary>ISDB-C でロックしたあと TSMF の判定で失敗したときに、TS を止める前に読んだ信号品質 (<c>--tune</c> が出す)。読めなければ null</summary>
    public TunerSignal? IsdbcFailedSignal { get; private set; }

    /// <summary>最後の ISDB-C の選局で、ほかに読めた値 (CXD2856 の仕様書 9.5。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public CxdIsdbcDetail? IsdbcDetail => _frontend?.IsdbcDetail;

    /// <summary>
    /// TSMF の判定を待つ (CXD2856 の仕様書 8.4 の手順 6・8.7 の「判定の待ち」)。判定には TS が要るので、受信機の出口を付けてから呼ぶ。
    /// 3 秒で決まらなければロックしないときと同じ失敗、「指定した TS が無い」は別の失敗にして、TS を止める
    /// </summary>
    private void WaitTsmf(IIt930xFrontend frontend, TsmfSelector tsmf)
    {
        var decision = tsmf.Wait(TsmfTimeoutMs);
        if (decision is TsmfDecision.Selected or TsmfDecision.Passthrough) return;
        // --tune が失敗の様子を出せるよう、止める前に変調と C/N を読んでおく
        try
        {
            IsdbcFailedSignal = frontend.Signal();
        }
        catch (IOException)
        {
            // 元の失敗を返す
        }
        StopOutput();
        // 1 パケットも届かなかったときは、電波ではなくブリッジから先で TS が止まっている (IT930x の仕様書 6.3)。同期しなかった文 (放送休止と読まれる) と分ける
        if (decision == TsmfDecision.Pending && tsmf.Received == 0) throw new IOException(TsMissing);
        if (decision == TsmfDecision.Pending) throw new IOException(ITuneDevice.SyncFailed);
        var detail = tsmf.FirstHeader is { } header
            ? $"TSMF の有効な TS は {header.ValidStreams.Count} 本で、{tsmf.Index} 本目 (0 から数える) を指定した"
            : $"TSMF を使わない搬送波で、TS は 0 本目だけ。{tsmf.Index} 本目を指定した";
        throw new IOException($"{TsmfMissing} ({detail})");
    }

    /// <summary>流している TS を止める (ブリッジの入力を閉じてから、復調器の TS の端子を止める。TC90522 の仕様書 9.2)</summary>
    private void StopOutput()
    {
        if (_output is null) return;
        _output = null;
        try
        {
            _device?.Detach(_receiver);
            if (_device is { Faulted: false }) _frontend?.Stream(false);
        }
        catch (IOException error)
        {
            _device?.Fail(error);
            Log.Write($"[{_name}] TS を止められませんでした ({error.Message})");
        }
    }

    /// <summary>機材を返す (使えなくなったとき・捨てるとき)</summary>
    private void Drop()
    {
        var device = _device;
        _device = null;
        _frontend = null;
        _model = null;
        device?.Release();
    }

    /// <summary>捨てる (定義が変わった・止める)。受信機を閉じ、機材を返す。誰も使っていなければ機材を閉じる</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            StopOutput();
            if (_device is { Faulted: false } device)
            {
                try
                {
                    device.Rest(_receiver);
                }
                catch (IOException error)
                {
                    device.Fail(error);
                    Log.Write($"[{_name}] スリープにできませんでした ({error.Message})");
                }
            }
            Drop();
        }
        _closeIdle?.Invoke();
    }
}
