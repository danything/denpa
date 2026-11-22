using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;

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

    /// <summary>最後の J.83B か ISDB-C の選局で受けた周波数 (Hz)。どちらでもなければ null</summary>
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

    /// <summary>
    /// 最後の選局で、ISDB-C がロックしなかった周波数ごとの状態 (<see cref="CxdIsdbcLockFailure"/>。CXD2856ER だけ)。ずらした周波数も試したときは試した順に 2 つ。
    /// 常駐の記録 (<see cref="TunerPool"/>) と <c>--tune</c> が出す
    /// </summary>
    IReadOnlyList<CxdIsdbcLockFailure> IsdbcLockFailures => [];

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
/// CXD2856ER + CXD2858ER の受信機 (CXD2856 の仕様書)。<see cref="Cxd2856Frontend"/> に、選局表の値からの振り分けと、J.83B と ISDB-C の周波数の試し方を足す
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

    private readonly List<CxdIsdbcLockFailure> _isdbcLockFailures = [];

    public IReadOnlyList<CxdIsdbcLockFailure> IsdbcLockFailures => [.. _isdbcLockFailures];

    public bool Tune(ChannelTable.Tuning tuning)
    {
        CableFrequency = null;
        _isdbcLockFailures.Clear();
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
    /// J.83B か ISDB-C を選局する (CXD2856 の仕様書 7.4・8.4)。ずらして送られることがあるチャンネル (CXD2856 の仕様書 7.1・8.2) は、選局表の周波数とずらした周波数の両方を試し、
    /// 前にロックしたほうを先にする。どちらもロックしなければ false
    /// </summary>
    private bool TuneCable(ChannelTable.Tuning tuning, Func<uint, bool> tune)
    {
        uint[] tries = tuning.ShiftedFrequency is { } shifted
            ? CableLocked.TryGetValue(tuning.Frequency, out var last) && last == shifted ? [shifted, tuning.Frequency] : [tuning.Frequency, shifted]
            : [tuning.Frequency];
        foreach (var hertz in tries)
        {
            if (!tune(It930xTuner.Khz(hertz)))
            {
                // ISDB-C がロックしなかったときの状態 (J.83B では null)
                if (frontend.IsdbcLockFailure is { } failure) _isdbcLockFailures.Add(failure);
                continue;
            }
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
/// IT930x の仕様書 2.1 の受信機の番号 0〜7 は、側 1 の 0〜3 と側 2 の 0〜3 に当たる。設定の形式とポートの見つけ方がほかの機種と同じになり、片側だけが見えていても使える。
/// 電源は、受信機を開いている間、もう片方の側の機材も取っておいて連動させる (IT930x の仕様書 7.4。機材を開いている間は電源が入る)。
/// 連動で電源だけが入った側は、チップを初期化していない。その側の受信機を最初に開くときに初期化する。
/// もう片方の側が見つからない・開けないときは、記録に出して見つかった側だけを使う (IT930x の仕様書 11.3 の「片側だけ見えている Q3」)。
/// </para>
///
/// <para>
/// **ロックの順。** 受信機は並べて選局されるので (常駐のスキャン)、ロックは次の順でだけ取り、逆には取らない。
/// <c>Registry</c> → この機材の <c>_gate</c> (使っている側の数)。
/// <see cref="It930xTuner"/> の <c>_gate</c> → 受信機ごとの <c>_receiverGates</c> (<see cref="Frontend"/>・<see cref="CxdBoard.KeepMatching"/>) → <see cref="Cxd2856Frontend"/> の受信機の操作 →
/// 同じバスの受信機で 1 つのバスのロック (<c>_buses</c>) → <see cref="It930xBridge"/> のコマンドのロック。<see cref="RestartStream"/> は <c>_gate</c> を持ったままブリッジのコマンドを送り、読み出しのスレッドが止まるのを待つ (読み出しのスレッドは <c>_gate</c> を取らない) (<c>_gate</c> → ブリッジのコマンドのロック)。LNB の給電の <c>_lnbGate</c> → ブリッジのコマンドのロック。
/// <see cref="CxdBoard.KeepMatching"/> はほかの受信機の <c>_receiverGates</c> と受信機の操作を取るが、その受信機の <see cref="It930xTuner"/> の <c>_gate</c> は取らない
/// (選局の途中なら、受信機の操作のロックで選局が終わるのを待つ)。I2C の並びが同じバスで交わらないことは It930xConcurrencyTests.cs で確かめる
/// </para>
/// </summary>
public sealed class It930xDevice
{
    /// <summary>EP 0x84 の 1 回の読み出しの待ち</summary>
    private const int TsReadTimeoutMs = 200;

    /// <summary>電源を切ったあと (GPIOH7 ← 1 のあと) の待ち (ms。IT930x の仕様書 7.2・10)</summary>
    internal const int PowerOffSettleMs = 100;

    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, It930xDevice> Devices = [];

    /// <summary>
    /// プロセスが終わるとき (SIGTERM で終わる <c>--tune</c> などの CLI も) と、捕まえていない例外でプロセスが落ちるときに機材を閉じる。
    /// 開けたままの入力に読む側がいなくなると、ブリッジのバッファが溢れ、電源を抜くまで TS が届かなくなるため (<see cref="It930xOverflow"/>)。
    /// エージェントは止まるときに閉じ終えている (<see cref="Shutdown()"/>) ので何もしない。SIGKILL (Pod の猶予切れ・OOM) で終わるときは、どちらも呼ばれない
    /// </summary>
    static It930xDevice()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => CloseBeforeExit();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => CloseBeforeExit();
    }

    /// <summary>終わる前に閉じ始めたか (<see cref="CloseBeforeExit"/> を 1 回だけ通す)</summary>
    private static int _closingBeforeExit;

    /// <summary>
    /// 終わる前に全部閉じ、それからは開かない (<see cref="Shutdown()"/>)。別のスレッドで閉じ、<see cref="ExitCloseLimit"/> で待つのをやめる。
    /// 落ちたスレッドが機材の一覧やブリッジのコマンドのロックを持ったまま止まっていても、プロセスが終わらなくならないため
    /// </summary>
    private static void CloseBeforeExit()
    {
        // 落ちるときは UnhandledException のあとに ProcessExit も来る。2 回目は待たない
        if (Interlocked.Exchange(ref _closingBeforeExit, 1) != 0) return;
        var closing = new Thread(() =>
        {
            if (!Registry.TryEnter(ExitCloseLimit)) return;
            try
            {
                Shutdown();
            }
            catch (Exception error)
            {
                Log.Write($"終わる前に {It930x.Model} を閉じられませんでした ({error.Message})");
            }
            finally
            {
                Registry.Exit();
            }
        })
        { IsBackground = true, Name = "it930x-exit" };
        closing.Start();
        closing.Join(ExitCloseLimit);
    }

    /// <summary>
    /// 終わる前に閉じるのを待つ上限 (<see cref="CloseBeforeExit"/>)。閉じるときは入力を閉じる 10 ms、EP 0x84 の読み出しが止まるまで (1 回の読み出しの待ちは 200 ms)、
    /// 電源を切ったあとの 100 ms を待つ。機材が数台でも収まる長さにする
    /// </summary>
    private static readonly TimeSpan ExitCloseLimit = TimeSpan.FromSeconds(5);

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
    /// <summary>
    /// 開いている受信機。**それ自身をロックして触る** (<see cref="_openGate"/> を取らない <see cref="Close"/> も、受信機をスリープにするときに外すため)
    /// </summary>
    private readonly HashSet<int> _openReceivers = [];

    private bool AnyOpen
    {
        get
        {
            lock (_openReceivers) return _openReceivers.Count > 0;
        }
    }

    private bool AddOpen(int receiver)
    {
        lock (_openReceivers) return _openReceivers.Add(receiver);
    }

    /// <summary>Q3 のもう片方の側の機材を取る (無ければ null を返す)。Q3 でなければ null</summary>
    private readonly Func<It930xDevice?>? _link;

    /// <summary>電源の連動のために取っている、Q3 のもう片方の側 (IT930x の仕様書 7.4)</summary>
    private It930xDevice? _linked;

    private Thread? _reader;
    private readonly ManualResetEventSlim _readerOpened = new();
    private volatile bool _readerRunning;

    /// <summary>開くときに EP 0x84 の転送要求を出し終えるのを待つ長さ</summary>
    private static readonly TimeSpan ReaderStartTimeout = TimeSpan.FromSeconds(2);
    private volatile bool _stopping;

    /// <summary>閉じ始めた (<see cref="Close"/>)。読み出しのスレッドは、閉じる側が入力を閉じるので自分では閉じない (電源を切ったあとにブリッジへ書かない)</summary>
    private volatile bool _closing;
    private int _users;
    private bool _closed;
    private volatile bool _faulted;

    /// <summary>USB が抜けた (<see cref="UsbGoneException"/>)。閉じるときに何も書かない。抜けていない失敗なら、閉じるときに受信機をスリープにして電源を切る</summary>
    private volatile bool _gone;

    public string Port { get; }
    public It930xModel Model { get; }
    public It930xBridge Bridge { get; }

    /// <summary>開くのにかかった時間 (ファームウェアの起動から電源を入れるまで)</summary>
    public long OpenMs { get; private set; }

    private long _tsBytes;
    private long _tsReads;

    /// <summary>EP 0x84 から読んだバイトの数 (開いてから。<c>--tune</c> が出す)</summary>
    public long TsBytes => Interlocked.Read(ref _tsBytes);

    /// <summary>EP 0x84 の読み出しで、1 バイト以上届いた回数</summary>
    public long TsReads => Interlocked.Read(ref _tsReads);

    /// <summary>
    /// 前に溢れの変化を記録に出してから、読み出しのスレッドが EP 0x84 の Read の外にいた時間のいちばん長いもの (ms)。
    /// 転送要求は Read の中でしか出し直さないので、これが長いと、出してある転送要求 (<see cref="It930xBridge.TsDepth"/> 個) が全部埋まり、
    /// ブリッジのバッファが溢れる。溢れの記録に添え、読み出しが止まったのか、ブリッジの中で溢れたのかを分ける (#2805)
    /// </summary>
    private long _longestAway;

    /// <summary>
    /// 読み出しのスレッドが Read から戻った時刻 (<see cref="Environment.TickCount64"/>)。Read に入ったら 0。
    /// 溢れを記録に出すときに、まだ Read の外で止まっていれば、その時間も数える (戻ってからでないと <see cref="_longestAway"/> に入らない)
    /// </summary>
    private long _awaySince;

    /// <summary>今の時点までの、Read の外にいたいちばん長い時間 (ms)。数え直す</summary>
    private long TakeLongestAway()
    {
        var since = Interlocked.Read(ref _awaySince);
        var now = since == 0 ? 0 : Environment.TickCount64 - since;
        return Math.Max(Interlocked.Exchange(ref _longestAway, 0), now);
    }

    private void RecordAway(long ms)
    {
        var seen = Interlocked.Read(ref _longestAway);
        while (ms > seen)
        {
            var was = Interlocked.CompareExchange(ref _longestAway, ms, seen);
            if (was == seen) return;
            seen = was;
        }
    }

    /// <summary>
    /// EP 0x84 の読み出しの数え (<c>--tune</c> が出す)。EP 0x84 からバイトが届いているのに入力ごとのパケットが増えなければ、ブリッジは流しているが分け方で揃っていない。
    /// バイトが増えなければ、ブリッジから先で止まっている
    /// </summary>
    public string DescribeTsCounters() =>
        $"EP 0x84: {TsReads} 回で {TsBytes} バイト  入力ごとのパケット {string.Join(" ", _demux.Packets)}  "
        + $"揃え直しで飛ばした {_demux.Skipped} バイト  知らない同期バイト {_demux.Unknown}  揃え直し {_demux.Lost} 回";

    /// <summary>USB が抜けたなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted => _faulted;

    /// <summary>閉じた (<see cref="Shutdown()"/> で、使っている側がいるまま閉じたときも)。閉じた機材の受信機には書かない</summary>
    public bool Closed => Volatile.Read(ref _closed);

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
            // 止めるときに閉じたあとは開かない (Shutdown)。開くと、プロセスが終わるときに入力を開けたまま読み出しが止まる
            if (_stopped?.Invoke(port) == true) throw new IOException($"エージェントを止めているので、{It930x.Model} ({port}) を開きません");
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
            // 開いたときに前のファームウェアが動いていたか (REBOOT した)。REBOOT で USB がつなぎ直されたときは、開き直したあとの起動では動いていないと読むので、ここで覚える
            bool rebooted;
            try
            {
                boot = bridge.Start(code);
                rebooted = boot.Rebooted;
            }
            catch (UsbGoneException) when (bridge.RebootSent)
            {
                usb.Dispose();
                usb = It930xProbe.Reopen(() => open().Usb, sleep);
                bridge = new It930xBridge(usb, sleep);
                boot = bridge.Start(code);
                rebooted = true;
            }
            var device = new It930xDevice(port, model, usb, bridge, sleep, nowMs, link);
            device.Setup(rebooted);
            device.OpenMs = started.ElapsedMilliseconds;
            Log.Write($"[{device.Label}] 開きました (ファームウェア {It930xBoot.Format(boot.Version)}{(rebooted ? "、REBOOT した" : "")}、{device.OpenMs} ms)");
            return device;
        }
        catch
        {
            usb.Dispose();
            throw;
        }
    }

    /// <summary>
    /// ブリッジの設定と電源 (IT930x の仕様書 4.2・5・7.2・7.3)。そのあと受信を始める (<see cref="StartStream"/>)。
    /// 入力は、最初の受信機を開いたときに機種が使うものを全部開ける (<see cref="OpenInputs"/>)
    /// </summary>
    /// <param name="rebooted">開いたときに前のファームウェアが動いていた (REBOOT した)。溢れていたときに記録に出す (<see cref="RecoverOverflow"/>)</param>
    private void Setup(bool rebooted)
    {
        if (Bridge.ConfigureReceivers(Model.Receivers) == 0)
        {
            Log.Write($"[{Label}] EEPROM の設定を読めていません (0x{It930xBridge.EepromValid:X4} が 0)。続けます");
        }
        SetupGpio(Bridge, Model, _sleep);
        // 受信機の TS 入力はどれもシリアル (IT930x の仕様書 5・6.1)。同期バイトが 0 の入力は使わないので、開けない (IT930x の仕様書 5)
        Bridge.ConfigureTs(new bool[It930xBridge.TsInputs], Model.SyncBytes);
        RecoverOverflow(rebooted);
        if (Model.PowerWhileOpen) Power(true);
        try
        {
            StartStream();
        }
        catch
        {
            // 開くのに失敗した機材は呼ぶ側が USB を閉じるので、その前に読み出しを止める
            StopReader();
            throw;
        }
    }

    /// <summary>
    /// 受信を始める (IT930x の仕様書 6.4 の「受信の始め」)。ブリッジの TS のバッファを捨て (<see cref="It930xBridge.PurgeTs"/>)、EP 0x84 をリセットし
    /// (<see cref="It930xBridge.ResetTsEndpoint"/>)、転送要求を全部出す (<see cref="StartReader"/>)。復調器の TS の端子は、受信機ごとに選局したときに出す。
    ///
    /// <para>
    /// 仕様書の公開の実装は、受信している受信機が 0 から 1 になるたびにこれをし、最後の受信機が止めるときに転送要求を取り消す。
    /// こちらは機材を開いている間ずっと転送要求を出しておくので、機材を開くたびと、受信をやり直すとき (<see cref="RestartStream"/>) にする。
    /// 開くときも受信をやり直すときも、入力を閉じたままで捨てる (開くときは PLEX の公開ドライバーと同じ時期。仕様書 6.4 の [P])
    /// </para>
    /// <para>
    /// **捨てる読み出しで何も届かなくても、受信は始める** (仕様書の公開の実装は受信の開始を失敗にする。仕様書と違う所)。
    /// 開くのを失敗にすると内蔵カードリーダーも使えなくなるが、TS が届かないかは、選局でロックしたあとに確かめられる (<see cref="It930xTuner"/>) ため。読んだバイトの数は記録に出す
    /// </para>
    /// </summary>
    private void StartStream()
    {
        int purged;
        try
        {
            purged = Bridge.PurgeTs();
        }
        catch (IOException error) when (error is not (UsbGoneException or It930xException))
        {
            // EP 0x84 の読み出しの失敗 (ストールなど)。このあと EP 0x84 をリセットする
            purged = -1;
            Log.Write($"[{Label}] 受信の始めに、ブリッジの TS のバッファを捨てる読み出しが失敗しました ({error.Message})。EP 0x84 をリセットして続けます");
        }
        if (purged >= 0)
        {
            Log.Write(purged > 0
                ? $"[{Label}] 受信の始めに、ブリッジの TS のバッファを捨てました (EP 0x84 から {purged} バイト)"
                : $"[{Label}] 受信の始めにブリッジの TS のバッファを捨てる読み出しで、EP 0x84 から {It930xBridge.PurgeTimeoutMs} ms 待っても何も届きませんでした。続けます");
        }
        try
        {
            Bridge.ResetTsEndpoint();
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            Log.Write($"[{Label}] EP 0x84 をリセットできませんでした ({error.Message})。そのまま転送要求を出します");
        }
        StartReader();
    }

    /// <summary>
    /// 読み出しのスレッドを始め、EP 0x84 の転送要求を出し終える (読み出しのスレッドが OpenInStream から戻る) まで待つ。
    /// 出せなかったら <see cref="IOException"/> (読み出しのスレッドが、開けていた入力を閉じている)
    /// </summary>
    private void StartReader()
    {
        _stopping = false;
        _readerRunning = false;
        _readerOpened.Reset();
        _reader = new Thread(ReadTs) { IsBackground = true, Name = "it930x-ts" };
        _reader.Start();
        if (!_readerOpened.Wait(ReaderStartTimeout) || !_readerRunning)
        {
            throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読み出しを始められませんでした");
        }
        if (_faulted) throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読み出しが、開いている間に失敗しました");
    }

    /// <summary>読み出しのスレッドを止め、転送要求を取り消し終えるまで待つ。止まれば true</summary>
    private bool StopReader()
    {
        _stopping = true;
        return _reader?.Join(TimeSpan.FromSeconds(2)) ?? true;
    }

    /// <summary>
    /// 受信をやり直す (IT930x の仕様書 6.4・6.5)。入力を開けていれば全部閉じ (<see cref="CloseInputs"/>)、転送要求を全部取り消してから、受信を始める手順 (<see cref="StartStream"/>) をし、
    /// 閉じた入力を開け直す。仕様書の公開の実装で、溢れたあとにブリッジの側で戻す操作は受信の始めのバッファを捨てることだけで、そのあと TS が戻るかは確かめられていない (仕様書 12)。
    /// 流しているほかの受信機の TS も、その間は欠ける。閉じた機材・読み出しが失敗した機材では何もせずに false を返す。
    /// 途中で失敗したら、読む側のいない入力を閉じ、機材を使えないものにしてから例外を送出する
    /// </summary>
    /// <remarks>
    /// **入力を閉じてから読み出しを止める** (閉じるとき (<see cref="Close"/>) と同じ順)。前は入力を開けたまま読み出しを止め、受信機が TS を出している間に、
    /// 転送要求を取り消してから出し直すまで (読み出しが止まるのを待つ最大 200 ms と、バッファを捨てる読み出しの最大 2 秒) EP 0x84 を誰も読まなかった。
    /// 仕様書 6.4 の公開の実装が受信の始めの手順をするのは、受信している受信機が 0 から 1 になるとき (ほかの受信機が流していないとき) だけ。
    /// PX-W3PE5 で、やり直したあとに、確かめていた受信機の入力の溢れが立った (2026-11-22。#1578)。やり直しがその溢れを立てたと推定している (確かめてはいない)。
    /// 閉じたあとは、開くときと同じく入力を閉じたままバッファを捨てる (<see cref="StartStream"/>)
    /// </remarks>
    /// <param name="why">記録に出すきっかけ (「受信機 0 の TS が届かないため」)</param>
    public bool RestartStream(string why)
    {
        lock (_gate)
        {
            if (_closed || _faulted) return false;
            Log.Write($"[{Label}] {why}、受信をやり直します (入力を閉じ、転送要求を取り消し、ブリッジの TS のバッファを捨て、EP 0x84 をリセットして出し直し、入力を開け直す)");
            try
            {
                // 欠けを数えているほかの受信機は、ここから数え直す (It930xTuner.Watch)。止める前に足すので、やり直しの飛びは数え直したあとに来る
                Interlocked.Increment(ref _restarts);
                if (_inputsOpen)
                {
                    if (!CloseInputs()) throw new IOException($"{Label} の TS の入力を閉じられませんでした");
                    // やり直す前の溢れを記録に残す (このあとに読む溢れと比べ、やり直しの間に立ったのかを分ける)
                    WatchOverflow("受信をやり直すために TS の入力を閉じたとき");
                }
                if (!StopReader()) throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読み出しを止められませんでした");
                StartStream();
                if (_inputsOpen)
                {
                    Bridge.EnableTsInputs();
                    // 開け直す前後に読み出しが失敗していたら、読む側のいない入力を開けたままにしない (下で閉じる。OpenInputs と同じ)
                    if (_faulted) throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読み出しが、受信をやり直している間に失敗しました");
                }
                return true;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                /*
                 * やり直せなかったら、機材を使えないものにして入力を閉じる。読み出しのスレッドが止まらなかった・転送要求を出し終えるのを待ちきれなかったときも、
                 * 止める印を立てて終わらせる (残ったスレッドが転送要求を出し続けていても、読む側として当てにしない)。次に取る側が開き直す。
                 * 読み出しのスレッドが失敗して先に閉じていても、もう一度閉じるだけ
                 */
                _stopping = true;
                var faulted = _faulted;
                _faulted = true;
                if (error is UsbGoneException) _gone = true;
                else CloseInputs();
                if (!faulted)
                {
                    for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete(error.Message);
                }
                throw;
            }
        }
    }

    private int _restarts;

    /// <summary>受信をやり直した回数 (<see cref="RestartStream"/>)。TS の欠けを数えている受信機が、やり直しで欠けたぶんを数え直すため (<see cref="It930xTuner"/>)</summary>
    internal int Restarts => Volatile.Read(ref _restarts);

    /// <summary>受信をやり直した溢れ (<see cref="RestartOnce"/>。同じ溢れのままでは 1 回だけ)。<c>_gate</c> の中で読み書きする</summary>
    private It930xOverflow? _restartedFor;

    /// <summary>
    /// 全体の溢れが立ったままで、ロックした受信機の TS が届かないときに、受信を 1 回だけやり直す (<see cref="RestartStream"/>)。
    /// 同じ溢れのまま前にやり直していれば、やり直さずに false を返す
    /// </summary>
    internal bool RestartOnce(It930xOverflow overflow, string why)
    {
        lock (_gate)
        {
            if (overflow.SameAs(_restartedFor)) return false;
            _restartedFor = overflow;
            return RestartStream(why);
        }
    }

    /// <summary>
    /// 開くときに TS のバッファの溢れ (<see cref="It930xOverflow"/>) が立っていたら、記録に出して TS の経路をリセットし直す (<see cref="It930xBridge.ResetTs"/>)。
    /// EP 0x84 の転送要求を出す前に呼ぶ。リセットしても立ったままなら、記録に出して開くのは続ける (カードは EP 0x84 を使わないので読める)。
    /// 全体の溢れが立ったままなら、次の選局でロックしたあとに TS が届くかを確かめる (<see cref="Unconfirmed"/>)。溢れの値が何を表すかは brRegister.h の名前からの推定。
    /// 溢れていたときの行には、TS の経路の状態 (<see cref="It930xBridge.ReadTsStatus"/>) と、開いたときに前のファームウェアが動いていたか (<paramref name="rebooted"/>) を添える。
    /// 前のドライバーかプロセスがファームウェアを動かしたまま離れたのか、ファームウェアが止まったあとも印が残っていたのかを、記録から分けるため
    /// </summary>
    private void RecoverOverflow(bool rebooted)
    {
        var overflow = Bridge.ReadOverflow();
        _overflow = overflow;
        var previous = Remember(overflow, "開くとき");
        if (!overflow.Any)
        {
            // 電源を入れ直して戻った機材は、また溢れたら denpa に送り直す
            ForgetFaults();
            return;
        }
        string status;
        try
        {
            status = Bridge.ReadTsStatus().Describe();
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            // 記録に添えるだけなので、読めなくても開くのは続ける
            status = $"ブリッジの TS の経路の状態を読めませんでした ({error.Message})";
        }
        var firmware = rebooted ? "開いたとき、前のファームウェアが動いていました (REBOOT した)" : "開いたとき、ファームウェアは動いていませんでした";
        FaultOnce("open", $"[{Label}] 開いたときに TS のバッファが溢れていました ({overflow}{Receivers(overflow)})。{firmware}。{status}。{previous}。TS の経路をリセットし直します");
        overflow = Bridge.ResetTs();
        _overflow = overflow;
        Remember(overflow, "開くときに TS の経路をリセットし直したあと");
        if (!overflow.Any) ForgetFaults();
        Log.Write(overflow switch
        {
            { System: true } => $"[{Label}] リセットしても溢れたままです ({overflow})。次の選局で、ロックしたあとに TS が届くかを確かめます",
            { Any: true } => $"[{Label}] リセットしても溢れたままです ({overflow})。TS が届かなければ、機材の電源を抜いて入れ直してください (REBOOT や受信機の電源の入れ直しでは戻りません)",
            _ => $"[{Label}] 溢れが下りました",
        });
    }

    /// <summary>denpa に送った機材の異常の種類と機材 (<see cref="FaultOnce"/>)</summary>
    private static readonly HashSet<(string Kind, string Port)> ReportedFaults = [];

    /// <summary>
    /// 機材の異常の行を、同じ機材の同じ種類 (<paramref name="kind"/>) ではプロセスで 1 回だけ denpa に送る (<see cref="Log.Fault"/>)。2 回目からは記録に出すだけ。
    /// 溢れたままの機材は、使う側がいなくなって閉じたあと、次の選局で開き直すたびに同じ行を出すため
    /// </summary>
    private void FaultOnce(string kind, string message)
    {
        bool first;
        lock (ReportedFaults) first = ReportedFaults.Add((kind, Port));
        if (first) Log.Fault(message);
        else Log.Write(message);
    }

    /// <summary>
    /// この機材の送った印 (<see cref="FaultOnce"/>) を外す。開いたときに溢れていなかった (電源を入れ直して戻った) ときに呼ぶ。
    /// エージェントを入れ替えないまま同じ機材がまた詰まっても、そのときの行を denpa に残すため
    /// </summary>
    private void ForgetFaults()
    {
        lock (ReportedFaults) ReportedFaults.RemoveWhere(key => key.Port == Port);
    }

    private readonly Lock _overflowGate = new();

    /// <summary>最後に読んだ溢れ (変わったときだけ記録に出すため)</summary>
    private volatile It930xOverflow? _overflow;

    /// <summary>全体の溢れが立ったままで、ロックしたあとに TS が届かなかったときの溢れ (<see cref="Confirm"/>)。同じ溢れのままほかの受信機に TS が届いたときのほかは、閉じるまで下ろさない</summary>
    private volatile It930xOverflow? _blocked;

    /// <summary>全体の溢れが立ったままでも、ロックしたあとに TS が届いたときの溢れ (<see cref="Confirm"/>)。溢れが変わったら確かめ直す</summary>
    private volatile It930xOverflow? _flowing;

    /// <summary>
    /// **全体の溢れ (<c>0xDA39</c>) が立ったままで、TS が届かないか欠けて届くと確かめた溢れ。確かめていなければ null。** この間は、どの受信機の選局も断る (<see cref="It930xTuner"/>)。
    /// 立ったままの機材では、PX-MLT5PE (2026-11-11) でも PX-MLT8PE (2026-11-12) でも、ロックしても EP 0x84 から TS が届かず、電源を抜くまで戻らなかった。
    /// 電源を抜くと USB から外れるので、次に開くのは新しい機材として読み直す
    /// </summary>
    internal It930xOverflow? Jammed => _blocked;

    /// <summary>
    /// **全体の溢れ (<c>0xDA39</c>) が立っていて、TS が届くかをまだ確かめていない溢れ。** 確かめたあとに溢れが変わったときも返す。
    /// 選局はロックしたあとに、その受信機の TS が届くかを確かめる (<see cref="It930xTuner"/>)。
    /// 印だけでは断らない。PX-W3PE5 で、開いたときに全体の溢れだけが立ち、入力ごとの溢れは 0 で、TS が届くかを確かめないまま全部の選局を断ったため (2026-11-15)。
    /// PX-W3U4 (2026-11-14。#2805) も、流している間に印を読んだあとは、TS が届くかを確かめずに断っていた
    /// </summary>
    internal It930xOverflow? Unconfirmed =>
        _blocked is null && _overflow is { System: true } overflow && !overflow.SameAs(_flowing) ? overflow : null;

    /// <summary>EP 0x84 から受信機 <paramref name="receiver"/> の入力に分けたパケットの数 (開いてから)</summary>
    internal long InputPackets(int receiver) => _demux.PacketsOf(Wiring(receiver).TsInput);

    /// <summary>
    /// 全体の溢れが立ったままの機材で、受信機 <paramref name="receiver"/> がロックしたあとに TS が欠けずに届いたか (<paramref name="flowing"/>) を記録に出し、覚える。
    /// 届かないか欠けて届けば、閉じるまでどの受信機の選局も断る (<see cref="Jammed"/>)。
    /// 並べて選局した受信機が前後して確かめても食い違わないよう、<c>_gate</c> の中で読み書きする
    /// </summary>
    /// <param name="loss">
    /// 欠けを数えた結果 (<see cref="It930xTsLoss.Describe"/>)。届いたときは記録に添え、届かなかったときに渡せば「欠けて届いた」として記録に出す。数えていなければ null
    /// </param>
    /// <returns>この機材の選局を断るようにしたか。同じ溢れのまま、並べて選局したほかの受信機で TS が届いたと確かめてあれば、断らずに false を返す</returns>
    internal bool Confirm(int receiver, It930xOverflow overflow, bool flowing, long waitedMs, string? loss = null)
    {
        lock (_gate)
        {
            if (flowing)
            {
                _flowing = overflow;
                // 先にほかの受信機が届かないと確かめて断るようにしていても、同じ溢れのまま TS が届いたなら、ブリッジからは TS が出ている。断るのをやめる
                if (overflow.SameAs(_blocked)) _blocked = null;
                Log.Write($"[{Label}] 全体の溢れは立ったままですが ({overflow})、受信機 {receiver} の TS が届きました{(loss is null ? "" : $" ({loss})")}。この機材の受信機で選局を続けます");
                return false;
            }
            // ほかの受信機に TS が届いたなら、ブリッジからは TS が出ている。この受信機だけの失敗にする
            if (overflow.SameAs(_flowing)) return false;
            _blocked = overflow;
        }
        var what = loss is null
            ? $"受信機 {receiver} がロックしてから {waitedMs} ms 待っても TS が届きませんでした"
            : $"受信機 {receiver} の TS が欠けて届きました ({loss})";
        FaultOnce("jammed",
            $"[{Label}] 全体の溢れが立ったままで ({overflow})、{what}。"
            + "機材の電源を抜いて入れ直すまで、この機材の受信機では選局しません (REBOOT や受信機の電源の入れ直しでは戻りません)");
        return true;
    }

    /// <summary>
    /// TS のバッファの溢れを読み、前に読んだときから変わっていれば記録に出す (選局したあと、流し始める・止めるとき、LNB の給電を切り替えたあと、閉じるとき)。
    /// 読んだ溢れを返す。読めなければ何もせずに null を返す (抜けたかどうかは EP 0x84 の読み出しとほかの操作が決める)
    /// </summary>
    internal It930xOverflow? WatchOverflow(string when)
    {
        It930xOverflow overflow;
        try
        {
            overflow = Bridge.ReadOverflow();
        }
        catch (IOException)
        {
            return null;
        }
        // 比べて書くまでを 1 つずつ通す (並べて選局した受信機が同時に読むと、同じ溢れを 2 回送ることがあった)
        lock (_overflowGate) return Note(overflow, when);
    }

    /// <summary><see cref="WatchOverflow"/> が読んだ溢れを覚え、変わっていれば記録に出す。<see cref="_overflowGate"/> の中で呼ぶ</summary>
    private It930xOverflow Note(It930xOverflow overflow, string when)
    {
        var before = _overflow;
        _overflow = overflow;
        var previous = Remember(overflow, when);
        if (overflow.SameAs(before)) return overflow;
        if (!overflow.Any && before is not { Any: true }) return overflow;
        // 全体の溢れが前から立っていて、TS が届くと確かめていなければ、EP 0x84 から TS が出ずに入力にも溜まって溢れたと読む。読み出しの遅れとは分ける (PX-MLT8PE。2026-11-12)
        var cause = before is { System: true } && !before.SameAs(_flowing)
            ? "全体の溢れが前から立っていて EP 0x84 から TS が出ないため、入力にも溜まったと推定します"
            : "EP 0x84 の読み出しが追いつかなかったと推定します";
        // 前に記録に出してから今までに、読み出しのスレッドが Read の外にいたいちばん長い時間。溢れが下りたと出すときも数え直す
        var away = TakeLongestAway();
        if (!overflow.Any)
        {
            Log.Write($"[{Label}] {when}に TS のバッファの溢れが下りていました");
            return overflow;
        }
        var line = $"[{Label}] {when}に TS のバッファが溢れていました ({overflow}{Receivers(overflow)})。{cause}。読み出しのスレッドが EP 0x84 の読み出しを離れていた時間は、いちばん長くて {away} ms です。{previous}";
        // 溢れていなかったところから溢れたときと、全体の溢れが新しく立ったときは denpa に送って残させる (溢れた瞬間の記録)。立ったままの値が変わっただけなら記録に出すだけ
        if (before is not { Any: true } || (overflow.System && !before.System)) Log.Fault(line);
        else Log.Write(line);
        return overflow;
    }

    /// <summary>
    /// USB のポートごとの、最後に溢れを読んだときの操作・時刻 (<see cref="Environment.TickCount64"/>)・値 (<see cref="Remember"/>)。
    /// 機材を閉じて開き直しても残す (開いたときの溢れを、このプロセスで前に閉じたときと比べるため)
    /// </summary>
    private static readonly Dictionary<string, (string When, long AtMs, It930xOverflow Overflow)> LastReads = [];

    /// <summary>
    /// 読んだ溢れを、このポートで最後に読んだものとして覚え、その前に読んだときのことを記録に添える文にして返す
    /// (「前に溢れを読んだのは 1200 ms 前 (受信機 2 の TS を流し始めるとき) で、そのときは溢れていませんでした」)。
    /// 溢れは選局や止めるときにしか読まないので、初めて立ったのが、前に読んだときからこの操作までの間だと記録から分かるようにする
    /// </summary>
    private string Remember(It930xOverflow overflow, string when)
    {
        var now = Environment.TickCount64;
        bool found;
        (string When, long AtMs, It930xOverflow Overflow) last;
        lock (LastReads)
        {
            found = LastReads.TryGetValue(Port, out last);
            LastReads[Port] = (when, now, overflow);
        }
        if (!found) return "このプロセスでは、前に溢れを読んでいません";
        var state = last.Overflow.Any ? $"{last.Overflow} でした" : "溢れていませんでした";
        return $"前に溢れを読んだのは {now - last.AtMs} ms 前 ({last.When}) で、そのときは{state}";
    }

    /// <summary>溢れた入力の受信機 (「、受信機 2」)</summary>
    private string Receivers(It930xOverflow overflow)
    {
        var receivers = overflow.Overflowed
            .SelectMany(input => Model.Receivers.Where(receiver => receiver.TsInput == input).Select(receiver => receiver.Index))
            .ToList();
        return receivers.Count == 0 ? "" : $"、受信機 {string.Join("・", receivers)}";
    }

    /// <summary>受信機の基板の電源を入れる・切る (<see cref="Power(It930xBridge, It930xModel, bool, Action{int})"/>)</summary>
    internal void Power(bool on) => Power(Bridge, Model, on, _sleep);

    /// <summary>
    /// 開いたときの GPIO。電源を切り (GPIOH7 か GPIOH3 = 1)、リセット中 (GPIOH2 = 0)、LNB を切る (GPIOH11 = 0)。そのあと 20 ms 待つ (CXD2856 の仕様書 11)。
    /// 受信機が 1 つの機種は GPIOH11 を設定も操作もしない (IT930x の仕様書 8)。機材を開くときと <c>--it930x-probe --chips</c> が使う
    /// </summary>
    internal static void SetupGpio(It930xBridge bridge, It930xModel model, Action<int> sleep)
    {
        bridge.GpioSetup(model.PowerPin, true);
        bridge.GpioSetup(2, false);
        if (model.Lnb) bridge.GpioSetup(11, false);
        sleep(20);
    }

    /// <summary>
    /// 受信機の基板の電源を入れる・切る (IT930x の仕様書 7.2・7.3)。機材と <c>--it930x-probe --chips</c> が使う。
    /// 入れる: 電源の GPIOH ← 0、80 ms (GPIOH3 の機種は 100 ms)、GPIOH2 ← 1 (リセットを解除する)、20 ms。切る: GPIOH2 ← 0、電源の GPIOH ← 1
    /// </summary>
    internal static void Power(It930xBridge bridge, It930xModel model, bool on, Action<int> sleep)
    {
        if (on)
        {
            bridge.Gpio(model.PowerPin, false);
            sleep(model.PowerWaitMs);
            bridge.Gpio(2, true);
            sleep(20);
        }
        else
        {
            bridge.Gpio(2, false);
            bridge.Gpio(model.PowerPin, true);
        }
    }

    /// <summary>EP 0x84 を読み、受信機ごとの出口に分ける。閉じるか、読めなくなるまで</summary>
    private void ReadTs()
    {
        try
        {
            using var input = _usb.OpenInStream(It930xBridge.TsIn, It930xBridge.TsRequestSize, It930xBridge.TsDepth);
            _readerRunning = true;
            _readerOpened.Set();
            var buffer = new byte[It930xBridge.TsRequestSize];
            while (!_stopping)
            {
                // 転送要求を出し直すのは Read の中だけ。Read の外にいた時間 (受信機ごとに分ける処理・スレッドが止められていた間) を測る
                var returned = Interlocked.Exchange(ref _awaySince, 0);
                if (returned != 0) RecordAway(Environment.TickCount64 - returned);
                var got = input.Read(buffer, TsReadTimeoutMs);
                Interlocked.Exchange(ref _awaySince, Environment.TickCount64);
                if (got <= 0) continue;
                Interlocked.Add(ref _tsBytes, got);
                Interlocked.Increment(ref _tsReads);
                _demux.Push(buffer.AsSpan(0, got));
            }
        }
        catch (Exception error)
        {
            // 止めている途中・閉じている途中の失敗 (転送要求の取り消し、入力を閉じて EP 0x84 をリセットした読み出し) は、止める側・閉じる側が片付ける
            if (_stopping || _closing) return;
            // IOException でない失敗 (受信機ごとに分ける処理の不具合など) も同じく片付ける。スレッドごと落ちると、入力を開けたまま読む側がいなくなる
            // EP 0x84 の読み出しは全部の受信機で 1 本なので、読めなくなったら機材ごと使えないものとし、次の選局で開き直す
            _faulted = true;
            if (error is UsbGoneException) _gone = true;
            Log.Fault($"[{Label}] TS を読めなくなりました: {UsbDevices.Reason(error)}");
            // 読む側がいないまま入力を開けておくと、ブリッジのバッファが溢れ、電源を抜くまで TS が届かなくなる (It930xOverflow)。
            // 閉じるのは使っている側が返してからなので、それまで待たずにここで入力を閉じる
            if (error is not UsbGoneException) CloseInputs();
            for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete(error.Message);
        }
        finally
        {
            // どの終わり方でも、転送要求を出し終えるのを待っている StartReader を待たせたままにしない (読み出しを始められていなければ _readerRunning は false のまま)
            _readerOpened.Set();
            // 読み出しを終えたあとは、Read の外にいる時間として数えない (`TakeLongestAway`)
            Interlocked.Exchange(ref _awaySince, 0);
        }
    }

    /// <summary>入力を全部閉じて EP 0x84 をリセットする (<see cref="It930xBridge.DisableTsInputs"/>)。閉じられなければ記録に出して false</summary>
    private bool CloseInputs()
    {
        try
        {
            Bridge.DisableTsInputs();
            return true;
        }
        catch (IOException error)
        {
            Log.Write($"[{Label}] TS の入力を閉じられませんでした ({error.Message})");
            return false;
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
            if (!AnyOpen) Link();
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
                if (AddOpen(receiver)) Log.Write($"[{Label}] 受信機 {receiver} を開きました ({frontend.Chips})");
                return frontend;
            }
            catch (IOException error)
            {
                Fail(error);
                if (!AnyOpen) Unlink();
                throw new IOException($"{Label} の受信機 {receiver} を初期化できません: {error.Message}", error);
            }
        }
    }

    /// <summary>ブリッジの入力を開けたか (<see cref="OpenInputs"/>)。<c>_gate</c> の中で読み書きする</summary>
    private bool _inputsOpen;

    /// <summary>
    /// 機種が使う入力を全部開ける (<see cref="It930xBridge.EnableTsInputs"/>)。最初の受信機を開いたときの 1 回で、閉じるまで開けたままにし、受信機ごとには開け閉めしない
    /// (SDK も受信を始める・止めるときは EP 0x84 の転送要求だけを出し入れする)。
    /// 機材を開いただけ (Q3 でもう片方の側に電源を入れるため、カードのため) では開けない。PX-Q3PE4 で、電源を入れただけで初期化していない TC90522 の入力が溢れ、
    /// そのブリッジは電源を抜くまで TS を出さなくなった (2026-11-11。受信機を開いた側は、初期化のあとに入力を開けても溢れなかった)
    /// </summary>
    private void OpenInputs()
    {
        lock (_gate)
        {
            if (_inputsOpen || _closed) return;
            Bridge.EnableTsInputs();
            _inputsOpen = true;
            // 開ける前後に読み出しが失敗していたら、読む側のいない入力を開けたままにしない (読み出しのスレッドが閉じるのと前後しても、最後に閉じる)
            if (_faulted)
            {
                CloseInputs();
                throw new IOException($"{Label} の TS (EP 0x{It930xBridge.TsIn:X2}) の読み出しが、開いている間に失敗しました");
            }
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
        if (AnyOpen) return false;
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
    /// 取っていたもう片方の側を返す (この側の受信機が全部閉じたときと、この側を閉じるとき)。そちらも誰も使っていなければ、待たずに閉じる (電源が切れる)。
    /// もう片方の側は電源を連動させるために取っていただけなので、<see cref="IdleGrace"/> を待たない
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
    /// 受信機の TS を <paramref name="output"/> に流し始める。ブリッジには書かない (入力は最初の受信機を開いたときから全部開いている。<see cref="OpenInputs"/>)。
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
            lock (_openReceivers) _openReceivers.Remove(receiver);
            try
            {
                if (!lnbFirst) Lnb(receiver, false);
            }
            finally
            {
                if (linked && !AnyOpen) Unlink();
            }
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> が LNB の給電を要求する・要求を取り下げる (IT930x の仕様書 8)。給電は機材 (Q3 は側) の受信機で 1 つ (ブリッジの GPIOH11。1 で入る) なので、
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
            // PX-Q3PE4 で衛星を選局したときだけブリッジの出力が止まったので、給電の切り替えがきっかけかを記録で絞る (2026-11-11)
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
        if (error is not UsbGoneException && error.InnerException is not UsbGoneException) return;
        _gone = true;
        _faulted = true;
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
    /// 待つ間に取り直されたら閉じない
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
    /// 本番では、カードの状態を確かめるたび (使っていない内蔵カードリーダーを開いて閉じる) に電源を切って入れ直し、続けて 13 回オン/オフしたあと、
    /// 全受信機の TS が電源を抜くまで止まった (CXD2856 の仕様書 12.5)。短い間のオン/オフを、いちばん疑っている
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
    /// 0 にするのは、待たずにオン/オフを繰り返した前の動きを再現する <c>--it930x-cycle --no-wait</c> だけ
    /// </summary>
    internal int PowerOffWaitMs { get; set; } = PowerOffSettleMs;

    /// <summary>全部閉じる (<c>--tune</c> の終わりなど)。使っている側がいても閉じる。エージェントを止めるときは <see cref="Shutdown()"/></summary>
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

    /// <summary>止めたポートか (<see cref="Shutdown(Func{string, bool})"/>)。Registry の中で読み書きする</summary>
    private static Func<string, bool>? _stopped;

    /// <summary>
    /// **エージェントを止めるときに、ほかの何よりも先に呼ぶ** (Program.cs の <c>ApplicationStopping</c>。<c>ApplicationStopped</c> とプロセスが終わるときにも呼ぶ)。
    /// 機材を全部閉じ (入力を閉じる → EP 0x84 の読み出しを止める → 受信機をスリープにして電源を切る → USB を閉じる)、それからは開かない (<see cref="Acquire(string)"/> が断る)。
    /// 選局を離す処理 (<see cref="TunerPool.CloseAll"/>) やほかの機材を閉じる処理のあとに置くと、そちらが終わらないまま SIGKILL で止められたときに、
    /// 入力を開けたまま読み出しが止まり、ブリッジのバッファが溢れる。選局が流しているままでも閉じてよい (出口を終わらせる。選局はあとで離す)
    /// </summary>
    public static void Shutdown() => Shutdown(_ => true);

    /// <summary><see cref="Shutdown()"/> の本体。テストは自分のポートだけを渡す</summary>
    internal static void Shutdown(Func<string, bool> which)
    {
        lock (Registry)
        {
            var before = _stopped;
            _stopped = before is null ? which : port => before(port) || which(port);
            var open = Devices.Keys.Where(which).ToList();
            if (open.Count > 0) Log.Write($"止めるので、{It930x.Model} を閉じます (USB のポート {string.Join("、", open)})");
            CloseAll(which);
        }
    }

    /// <summary>
    /// ブリッジの入力を全部閉じ、受信機を全部スリープにし、電源を切って (GPIOH2 ← 0、電源の GPIOH ← 1)、USB を閉じる。抜けていれば書かずに閉じる。
    /// 電源が GPIOH3 の機種は、受信機を閉じたときに電源を切っている。閉じるのを待っていたら、その待ちはやめる。Registry の中で呼ぶ。
    /// **EP 0x84 の読み出しを止めるのは、入力を閉じたあと。** 入力を閉じられなかったときは、受信機をスリープにして電源を切ってから止める (入力に TS が入らないように)
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
        /*
         * USB が抜けた機材には何も書かない。読み出しが失敗しただけの機材は書く (入力はもう閉じてあるが、閉じ直すだけ)。
         * 書かずに閉じると、受信機の電源と LNB の給電が入ったまま残る
         */
        var write = !_gone;
        // 入力を閉じて EP 0x84 をリセットしてから読み出しを止める (SDK の DRV_ResetRxPort)。読む側がいないまま、ブリッジに TS を溜めない
        var inputsClosed = write && CloseInputs();
        if (inputsClosed)
        {
            // 次に開いたときに溢れていたら、閉じる前から溢れていたのか、閉じたあとに溢れたのかを記録で分ける
            var overflow = WatchOverflow("閉じるとき");
            Log.Write($"[{Label}] TS の入力を閉じました ({overflow?.ToString() ?? "溢れは読めませんでした"})。EP 0x84 の読み出しを止めます");
        }
        else if (write)
        {
            Log.Write($"[{Label}] TS の入力を閉じられなかったので、受信機をスリープにして電源を切ってから EP 0x84 の読み出しを止めます");
            Quiet();
        }
        StopReader();
        for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete();
        if (inputsClosed) Quiet();
        _usb.Dispose();
        Log.Write($"[{Label}] 閉じました");
        // 取っていたもう片方の側を返す (USB を閉じたあと。一覧のロックは持っている)
        Unlink();
    }

    /// <summary>受信機を全部スリープにし、電源を切る (<see cref="Close"/>)。受信機 1 つのスリープに失敗しても、ほかの受信機と電源は切る</summary>
    private void Quiet()
    {
        // USB が抜けたときは、電源を切る書き込みも失敗して下で記録に出る
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
    /// <summary>LNB の給電の設定で受け付ける値。給電は 15 V だけ (IT930x の仕様書 8。0 か 15 V のほかは断る)</summary>
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
    public It930xTuner(string port, int receiver, string? lnb = null, string? name = null)
        : this(name ?? It930x.Name(port, receiver), receiver, () => It930xDevice.Acquire(port), () => It930xDevice.CloseIfIdle(port), lnb, () => It930x.Identify(port))
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

    /// <summary>どの方式も受け付ける。受信機が受けられない方式は、<see cref="Tune"/> が機種の表で機材に触る前に断る</summary>
    public bool Accepts(ChannelTable.Tuning tuning) => true;

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

    /// <summary>受信をやり直す (IT930x の仕様書 6.4。<see cref="It930xDevice.RestartStream"/>)。<c>--tune</c> が、TS が届かないときに試す</summary>
    public void RestartStream()
    {
        lock (_gate) _device?.RestartStream("TS が届かないため");
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
                return _attempted && _device is { Faulted: false, Closed: false } ? _frontend?.Diagnose() ?? [] : [];
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
        ChannelTable.Catv => "ケーブル",
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
        // 給電は 15 V だけ (IT930x の仕様書 8)。11 V は機材を開く前に断る
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
            IsdbcLockFailures = [];
            // 抜けた・TS を読めなくなった・止めるときに閉じた機材は返して、開き直す (止めたあとは開かずに断る)
            if (_device is { Faulted: true } or { Closed: true }) Drop();
            try
            {
                _device ??= _acquire();
                if (_model != _device.Model)
                {
                    _model = _device.Model;
                    Check(tuning, _model);
                }
                // 全体の溢れが立ったまま TS が届かないと確かめた機材は、受信機に触らずに断り、30 秒待たせずにほかのチューナーへ回させる (TunerPool)。
                // 使っている側 (ほかの受信機・カード) がいなくなって閉じたあとに取るときは、開き直して溢れを読み直す
                if (_device.Jammed is { } jammed) Refuse(jammed);
                _frontend = _device.Frontend(_receiver);
                // 給電を入れてから選局する (順は IT930x の仕様書 8。LNB が出力を出すまでの待ちは仕様書に無く、ロックの待ち (3 秒) に含める)
                _device.Lnb(_receiver, tuning.Satellite && _lnb == Lnb15v);
                _attempted = true;
                var locked = _frontend.Tune(tuning);
                if (tuning.IsdbC) IsdbcLocked = locked;
                // ずらした周波数でロックしたときは、表の周波数の失敗を残さない (選局は成功したので記録に出さない)
                if (tuning.IsdbC && !locked) IsdbcLockFailures = _frontend.IsdbcLockFailures;
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
                var before = _device.InputPackets(_receiver);
                _device.Attach(_receiver, output);
                _output = output;
                // 受信を始めるときに、復調器の TS の端子を出す (TC90522 の仕様書 9.1)
                _frontend.Stream(true);
                // 全体の溢れが立っていて、TS が届くかを確かめていなければ、この受信機の TS が届くかを確かめる (流し始める前に読んだ溢れで決める)
                if (_device.Unconfirmed is { } suspect) Probe(_device, suspect, output, before, countLoss: tsmf is null);
                if (tsmf is not null) WaitTsmf(_frontend, tsmf);
            }
            catch (ObjectDisposedException error) when (_device is { Closed: true } device)
            {
                // 選局の途中で、止めるために機材を閉じられた (Shutdown は選局が終わるのを待たない)。閉じた USB に書いた失敗は、止めたことが分かる文にして返す
                throw new IOException($"止めるので、選局の途中で {device.Model.Name} ({device.Port}) を閉じました", error);
            }
            catch (IOException error)
            {
                if (_device is { } device)
                {
                    /*
                     * 選局できなかった受信機は給電の要求を取り下げる (受けていない受信機のために LNB を入れたままにしない。IT930x の仕様書 8 は前の指定に戻すと書く)。
                     * 止めるために閉じた機材には書かない (閉じたときに電源を切っている)。確かめたあとに閉じられて書けなくても、元の失敗を返す
                     */
                    try
                    {
                        if (!device.Closed) device.Lnb(_receiver, false);
                    }
                    catch (Exception cleanup) when (cleanup is IOException or ObjectDisposedException)
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

    /// <summary>最後の J.83B か ISDB-C の選局で受けた周波数 (Hz。<c>--tune</c> が出す)。どちらでもなければ null</summary>
    public uint? CableFrequency => _frontend?.CableFrequency;

    /// <summary>最後の J.83B の選局で読んだ変調 (<c>256QAM</c> など。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public string? CableModulation => _frontend?.CableModulation;

    /// <summary>最後の J.83B の選局で読んだ PER (<see cref="Signal"/> を読んだあと。J.83B で値が正しいかは未確認)。<c>--tune</c> だけが出す</summary>
    public double? CablePer => _frontend?.CablePer;

    /// <summary>ISDB-C で「指定した TS が無い」ときの失敗の文の先頭 (CXD2856 の仕様書 8.7。ロックしないときの <see cref="ITuneDevice.SyncFailed"/> とは別の失敗)</summary>
    public const string TsmfMissing = "指定した TS がありません";

    /// <summary>
    /// ロックしたのに TS が 1 パケットも届かなかったときの失敗の文 (IT930x の仕様書 6.3)。ISDB-C で TSMF の判定の時間切れまで届かなかったときと、
    /// 全体の溢れが立ったままの機材で <see cref="TsProbeMs"/> 待っても届かなかったとき (<see cref="Probe"/>) に使う
    /// </summary>
    public const string TsMissing = "ロックしましたが、TS が 1 パケットも届きません (ブリッジから先で TS が止まっています)";

    /// <summary>TSMF の判定の時間切れ (ms。CXD2856 の仕様書 8.7・11 の 3 秒)。変えるのはテストのため</summary>
    internal int TsmfTimeoutMs { get; init; } = TsmfSelector.TimeoutMs;

    /// <summary>最後の選局が ISDB-C で、復調器がロックしたか (<c>--tune</c> が出す)</summary>
    public bool IsdbcLocked { get; private set; }

    /// <summary>最後に ISDB-C を選局したときの TSMF の判定 (<c>--tune</c> が出す)。選局に失敗したあとも残す。ISDB-C でないか、ロックしなかったなら null</summary>
    public TsmfSelector? Tsmf { get; private set; }

    /// <summary>最後の ISDB-C の選局で、分割 TLV を組み立てる処理 (<c>--tune</c> が数を出す)。選んだ TS が MPEG-2 TS なら何も数えない。ISDB-C でなければ null</summary>
    public SplitTlv? Tlv { get; private set; }

    /// <summary>流しているバイト列の形式。TSMF から選んだ TS が分割 TLV なら <see cref="StreamFormat.Tlv"/> (<see cref="TsmfSelector.Format"/>)</summary>
    public StreamFormat Format => Tsmf?.Format ?? StreamFormat.Ts;

    /// <summary>ISDB-C でロックしたあと TSMF の判定で失敗したときに、TS を止める前に読んだ信号品質 (<c>--tune</c> が出す)。読めなければ null</summary>
    public TunerSignal? IsdbcFailedSignal { get; private set; }

    /// <summary>
    /// 最後の ISDB-C の選局がロックしなかったときに、周波数ごとに読んだ復調器の状態 (<see cref="CxdIsdbcLockFailure"/>)。
    /// 常駐の記録 (<see cref="TunerPool"/>) と <c>--tune</c> が 1 つ 1 行で出す。ロックしたか、ISDB-C でなければ空
    /// </summary>
    public IReadOnlyList<CxdIsdbcLockFailure> IsdbcLockFailures { get; private set; } = [];

    /// <summary>最後の ISDB-C の選局で、ほかに読めた値 (CXD2856 の仕様書 9.5。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public CxdIsdbcDetail? IsdbcDetail => _frontend?.IsdbcDetail;

    /// <summary>
    /// 全体の溢れが立ったままの機材で、ロックしたあとに受信機の TS が届くのを待つ長さ (ms。<see cref="Probe"/>)。
    /// ロックしてから最初の TS までは、PX-W3U4 の常駐の記録で 4〜20 ms だった (#2805)。EP 0x84 の 1 回の転送 (65,424 バイト) は、地上波 1 本 (約 17 Mbps) でも約 31 ms で埋まる。
    /// その 30 倍ほどにする。変えるのはテストのため
    /// </summary>
    internal int TsProbeMs { get; init; } = 1000;

    /// <summary>
    /// 全体の溢れが立ったままの機材で、TS が届いたあとに欠けを数える長さ (ms。最初のパケットから。<see cref="Probe"/>)。
    /// 溢れていない機材では、<c>--tune</c> が数える連続性の飛び (最初の 1 秒は数えない) が、90 秒流しても 0 個だった (PX-MLT5PE の受信機 5 つの地上波。docs/tuner-it930x.md)。
    /// 待つのは全体の溢れが立っていて、まだ確かめていない溢れのときだけなので、選局が遅くなるのもそのときだけ。変えるのはテストのため
    /// </summary>
    internal int TsLossMs { get; init; } = 1000;

    /// <summary>
    /// 欠けて届くと決める、飛んだ区間 (<see cref="It930xTsLoss.SlotMs"/> ごと) の数。
    /// 前の選局のパケットがブリッジに残っていると、つなぎ目で 1 区間飛ぶので、1 区間は許す。電波の誤りの飛びは数えない (<see cref="It930xTsLoss"/>)。
    /// PX-W3PE4 で全体の溢れが立ったまま届いた地上波は、ライブの ffmpeg が AAC のデコードの失敗を数秒おきに出して止まった (#1578)。
    /// 1 秒のうちに 2 区間飛べば、つなぎ目のほかにも欠けていると読む。数秒に 1 回より少ない欠けは見逃す
    /// </summary>
    internal const int TsLossSlots = 2;

    /// <summary>ロックしたあとに届いた TS が欠けていたときの失敗の文 (<see cref="Probe"/>)</summary>
    public const string TsLossy = "ロックしましたが、TS が欠けて届きます (ブリッジから先で TS のパケットが落ちています)";

    /// <summary>
    /// 全体の溢れが立ったままの機材で、ロックした受信機の TS が EP 0x84 から届くかと、欠けていないかを確かめる (流し始めたあと)。
    /// <paramref name="before"/> (流し始める前に数えた、この受信機の入力のパケット) から増え、そのあと <see cref="TsLossMs"/> の間に欠けが
    /// <see cref="TsLossSlots"/> 区間に達しなければ、印は立ったままでも TS は届くので、この機材を使い続ける (PX-W3PE5 の「印だけで断らない」。<see cref="It930xDevice.Unconfirmed"/>)。
    /// <see cref="TsProbeMs"/> 待っても増えないか、欠けて届けば、受信を 1 回だけやり直して (<see cref="It930xDevice.RestartOnce"/>。IT930x の仕様書 6.4 の受信の始めの手順)、もう一度確かめる。
    /// それでも同じなら、閉じるまでこの機材の選局を断り (<see cref="It930xDevice.Jammed"/>)、この選局も断る。欠けて届くときも、届かないときと同じに扱う。
    /// 同じ溢れのまま、並べて選局したほかの受信機に TS が届いていれば、この選局だけを <see cref="TsMissing"/> か <see cref="TsLossy"/> で失敗にする
    /// (<see cref="TunerStalledException"/>。プールはほかのチューナーで選局し直す)。
    /// 欠けを数えるのは TSMF を通さない方式だけ (<paramref name="countLoss"/>。<see cref="It930xTsOutput.WatchLoss"/>)。ISDB-C は届くかだけを確かめる
    /// </summary>
    private void Probe(It930xDevice device, It930xOverflow suspect, It930xTsOutput output, long before, bool countLoss)
    {
        var waited = Stopwatch.StartNew();
        var check = Watch(device, output, before, countLoss);
        if (!check.Good)
        {
            var why = check.Arrived
                ? $"受信機 {_receiver} の TS が欠けて届くため ({check.Detail})"
                : $"受信機 {_receiver} がロックしてから {TsProbeMs} ms 待っても TS が届かないため";
            if (device.RestartOnce(suspect, $"全体の溢れが立ったままで、{why}")) check = Watch(device, output, device.InputPackets(_receiver), countLoss);
        }
        if (check.Good)
        {
            device.Confirm(_receiver, suspect, flowing: true, waited.ElapsedMilliseconds, check.Detail);
            return;
        }
        var blocked = device.Confirm(_receiver, suspect, flowing: false, waited.ElapsedMilliseconds, check.Arrived ? check.Detail : null);
        StopOutput();
        if (blocked) Refuse(suspect);
        throw new TunerStalledException(check.Arrived ? TsLossy : TsMissing);
    }

    /// <summary>確かめた結果 (<see cref="Watch"/>)。<see cref="Detail"/> は欠けを数えたときの記録の中身 (<see cref="It930xTsLoss.Describe"/>)</summary>
    private readonly record struct TsCheck(bool Arrived, bool Lossy, string? Detail)
    {
        public bool Good => Arrived && !Lossy;
    }

    /// <summary>
    /// この受信機の入力のパケットが <paramref name="before"/> から <see cref="TsProbeMs"/> のうちに増えたかを確かめ、増えたら最初のパケットから
    /// <see cref="TsLossMs"/> の間、欠けを数える (<paramref name="countLoss"/> のとき)。欠けが <see cref="TsLossSlots"/> 区間に達したら、そこで決める。
    /// 数えている間に、並べて確かめているほかの受信機が受信をやり直したら (<see cref="It930xDevice.Restarts"/>)、そこから数え直す。
    /// やり直しの間はこの受信機の TS も欠けるので、前の選局とのつなぎ目と合わせて 2 区間になり、欠けていない受信機まで断るため
    /// </summary>
    private TsCheck Watch(It930xDevice device, It930xTsOutput output, long before, bool countLoss)
    {
        // 数え始めてから届いたパケットだけを数える (前の確かめの数を持ち越さない)。確かめ終えたら、流している間は数えない
        var restarts = device.Restarts;
        var loss = countLoss ? output.WatchLoss() : null;
        try
        {
            var waited = Stopwatch.StartNew();
            while (device.InputPackets(_receiver) == before)
            {
                if (waited.ElapsedMilliseconds >= TsProbeMs) return new(false, false, null);
                Thread.Sleep(5);
            }
            if (loss is null) return new(true, false, null);
            var counting = Stopwatch.StartNew();
            while (true)
            {
                if (device.Restarts != restarts)
                {
                    restarts = device.Restarts;
                    loss = output.WatchLoss();
                    counting.Restart();
                }
                var span = loss.Span(Environment.TickCount64);
                if (loss.Slots >= TsLossSlots) return new(true, true, loss.Describe(span));
                // 数え始める前に届いた 1 回ぶんのあと、パケットが続かなければ、最初のパケットを待たずに数え終える (30 秒届かないときの扱いに任せる)
                if (span >= TsLossMs || counting.ElapsedMilliseconds >= TsProbeMs + TsLossMs) return new(true, false, loss.Describe(span));
                Thread.Sleep(5);
            }
        }
        finally
        {
            if (loss is not null) output.StopLoss();
        }
    }

    /// <summary>
    /// TS が届かないか欠けて届く機材の選局を断る (<see cref="TunerUnusableException"/>)。開いた受信機は閉じてから (LNB の給電の要求も取り下げて)、機材を返す。
    /// カードもほかの受信機も使っていなければ、待ってから閉じる
    /// </summary>
    [DoesNotReturn]
    private void Refuse(It930xOverflow overflow)
    {
        if (_device is { } device && _frontend is not null) Rest(device);
        Drop();
        _closeIdle?.Invoke();
        throw new TunerUnusableException($"ブリッジの TS のバッファが溢れたままで、TS が届かないか欠けています ({overflow})。機材の電源を抜いて入れ直してください");
    }

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
        throw new IOException(TsmfFailure(tsmf, decision, TsMissing));
    }

    /// <summary>
    /// TSMF の判定で失敗したときの文 (<see cref="DvbTuner"/> も使う)。判定が決まらないうちに時間切れなら、1 パケットも届かなかったときは
    /// <paramref name="noPackets"/>、届いていればロックしないときと同じ文。指定した TS が無ければ <see cref="TsmfMissing"/> で始まる文
    /// </summary>
    internal static string TsmfFailure(TsmfSelector tsmf, TsmfDecision decision, string noPackets)
    {
        if (decision == TsmfDecision.Pending) return tsmf.Received == 0 ? noPackets : ITuneDevice.SyncFailed;
        var detail = tsmf.FirstHeader is { } header
            ? $"TSMF の有効な TS は {header.ValidStreams.Count} 本で、{tsmf.Index} 本目 (0 から数える) を指定した"
            : $"TSMF を使わない搬送波で、TS は 0 本目だけ。{tsmf.Index} 本目を指定した";
        return $"{TsmfMissing} ({detail})";
    }

    /// <summary>
    /// 流している TS を止める (出口を外してから、復調器の TS の端子を止める。TC90522 の仕様書 9.2)。ブリッジの入力は開けたままで、EP 0x84 の読み出しも続ける
    /// (入力を閉じるのは機材を閉じるとき。<see cref="It930xDevice.Detach"/>)
    /// </summary>
    private void StopOutput()
    {
        if (_output is null) return;
        _output = null;
        try
        {
            _device?.Detach(_receiver);
            if (_device is { Faulted: false, Closed: false }) _frontend?.Stream(false);
        }
        catch (IOException error)
        {
            _device?.Fail(error);
            Log.Write($"[{_name}] TS を止められませんでした ({error.Message})");
        }
    }

    /// <summary>受信機を閉じ、LNB の給電の要求を取り下げる (<see cref="It930xDevice.Rest(int)"/>)。失敗は機材に記録して続ける (このあと機材を返すため)</summary>
    private void Rest(It930xDevice device)
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
            if (_device is { Faulted: false, Closed: false } device) Rest(device);
            Drop();
        }
        _closeIdle?.Invoke();
    }
}
