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
    /// 復調器の TS の端子を出す・止める (px4 の仕様書 4.5・11)。受信を始めるときに出し、終えるときに止める。
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
    /// 最後の ISDB-C の選局で、ほかに読めた値 (MLT5 の仕様書 8.4A。CXD2856ER だけ)。<c>--tune</c> だけが出す。
    /// J.83B と ISDB-C を選局できるのは CXD2856ER の受信機だけで、ほかの受信機の <see cref="Tune"/> は何も書かずに断る
    /// </summary>
    CxdIsdbcDetail? IsdbcDetail => null;

    /// <summary><c>--tune</c> だけに出す、チップごとの読み値 (1 行ずつ)。機材から読むので、受け終えたあとに呼ぶ</summary>
    IReadOnlyList<string> Notes() => [];
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
/// CXD2856ER + CXD2858ER の受信機 (MLT5 の仕様書)。<see cref="Cxd2856Frontend"/> に、選局表の値からの振り分けと、J.83B の周波数の試し方を足す
/// </summary>
internal sealed class CxdReceiver(Cxd2856Frontend frontend, Action keepMatching) : IIt930xFrontend
{
    /// <summary>
    /// J.83B と ISDB-C で、ずらして送られることがあるチャンネル (<see cref="ChannelTable.Tuning.ShiftedFrequency"/>) の、最後にロックした周波数 (Hz)。
    /// 選局表の周波数をキーにする。次の選局はこちらを先に試す (毎回 1 秒の時間切れを待たないため。仕様書に無い)
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<uint, uint> CableLocked = new();

    public Cxd2856Frontend Chip => frontend;

    public string Chips => $"復調器 0x{frontend.ChipId:X2}";

    public long LockMs => frontend.LockMs;

    public double? SatelliteLevelDb => frontend.SatelliteLevelDb;

    public uint? CableFrequency { get; private set; }

    public string? CableModulation => frontend.CableModulation;

    public double? CablePer => frontend.CablePer;

    public CxdIsdbcDetail? IsdbcDetail => frontend.IsdbcDetail;

    public bool Tune(ChannelTable.Tuning tuning)
    {
        CableFrequency = null;
        // 衛星は選局表の周波数が IF の kHz (MLT5 の仕様書 6.1)
        if (tuning.Satellite) return frontend.TuneIsdbs(tuning.Frequency, CxdStream.From(tuning.StreamId));
        if (tuning.Cable)
        {
            keepMatching();
            return TuneCable(tuning, frontend.TuneJ83b);
        }
        if (tuning.IsdbC)
        {
            /*
             * ISDB-C (MLT5 の仕様書 7A.4)。手順 1 の「ブリッジが NULL パケットを落とさないようにする」(仕様書 3.4) は、denpa のブリッジの層が
             * どの方式でも PID で落とす設定を使っていないので、切り替える書き込みは無い。
             * 整合を保つ設定 (仕様書 4.7) は J.83B と同じく、最初の選局で全受信機に立てる。TSMF で TS を選ぶのは <see cref="It930xTuner"/>
             */
            keepMatching();
            return TuneCable(tuning, frontend.TuneIsdbc);
        }
        return frontend.TuneIsdbt(It930xTuner.Khz(tuning.Frequency));
    }

    /// <summary>
    /// J.83B を選局する (MLT5 の仕様書 7.4)。ずらして送られることがあるチャンネル (仕様書 7.1) は、選局表の周波数とずらした周波数の両方を試し、
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
/// 受信機の初期化は、その受信機を初めて使うときに 1 回 (MLT5 の仕様書 2.2)。初期化に失敗した受信機だけを使えなくし、ほかの受信機はそのまま使う。
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

    /// <summary>待機中の地上波の RF 入力の整合を保つ設定にしたか (MLT5 の仕様書 4.7。<see cref="KeepMatching"/>)。電源を切るまで (この機材を閉じるまで) 立てたまま</summary>
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
        // 中継を開けてから閉じるまでを、バスごとに 1 つの区切りにする (MLT5 の仕様書 1.4)
        foreach (var receiver in model.Receivers) _buses.TryAdd(receiver.I2cBus, new Lock());
    }

    /// <summary>受信機の復調器とチューナー。初めてのときに初期化する (MLT5 の仕様書 2.2)</summary>
    public IIt930xFrontend Open(int receiver)
    {
        var wiring = _model.Receivers[receiver];
        lock (_receiverGates[receiver])
        {
            if (_frontends[receiver] is { } ready) return ready;
            var frontend = new Cxd2856Frontend(new It930xI2cBus(_bridge, wiring.I2cBus), _buses[wiring.I2cBus], wiring.DemodAddress, _sleep, _nowMs);
            // 整合を保つ設定にしたあとに初めて使う受信機は、その設定で初期化する (MLT5 の仕様書 4.7)
            if (_matching) frontend.KeepMatching(standby: false);
            frontend.Init();
            return _frontends[receiver] = new CxdReceiver(frontend, () => KeepMatching(receiver));
        }
    }

    /// <summary>使い終えた受信機のチューナーを止め、復調器をスリープにする (MLT5 の仕様書 10.3 の手順 2〜3)</summary>
    public void Close(int receiver)
    {
        CxdReceiver? frontend;
        lock (_receiverGates[receiver]) frontend = _frontends[receiver];
        frontend?.Chip.Sleep();
    }

    /// <summary>
    /// 待機中の地上波の RF 入力の整合を保つ設定を、機材の全受信機で立てる (MLT5 の仕様書 4.7)。電源を入れてから最初に J.83B か ISDB-C を選局するときに、
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
/// 誰も使わなくなったら閉じて電源を切る (<see cref="CloseIfIdle"/>)。電源が GPIOH7 の機種は、内蔵カードリーダーが受信機と同じ電源なので
/// (MLT5 の仕様書 1.5、px4 の仕様書 2.5)、カード (<see cref="It930xCard"/>) も使う側として数え、カードを使っている間は受信機を全部閉じても電源を切らない。
/// 電源が GPIOH3 の機種 (受信機が 1 つの機種) は、受信機を開いている間だけ電源を入れ、カードのためには入れない (px4 の仕様書 13.3)。
/// </para>
///
/// <para>
/// **Q3 は、2 つの USB デバイスをそれぞれ別の機材として持つ** (<c>it930x:&lt;側 1 のポート&gt;:0〜3</c> と <c>it930x:&lt;側 2 のポート&gt;:0〜3</c>)。
/// px4 の仕様書 1.5 の受信機の番号 0〜7 は、側 1 の 0〜3 と側 2 の 0〜3 に当たる。設定の形とポートの見つけ方がほかの機種と同じになり、片側だけが見えていても使える。
/// 電源の連動 (px4 の仕様書 2.6) は、受信機を開いている間、もう片方の側の機材も取っておくことで行う (機材を開いている間は電源が入る)。
/// 連動で電源だけが入った側は、チップを初期化していない。その側の受信機を最初に開くときに初期化する。
/// もう片方の側が見つからない・開けないときは、記録に出して見つかった側だけを使う (px4 の仕様書 15.3 の「片側だけ見えている Q3」)。
/// </para>
/// </summary>
public sealed class It930xDevice
{
    /// <summary>EP 0x84 の 1 回の読みの待ち</summary>
    private const int TsReadTimeoutMs = 200;

    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, It930xDevice> Devices = [];

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

    /// <summary>電源の連動のために取っている、Q3 のもう片方の側 (px4 の仕様書 2.6)</summary>
    private It930xDevice? _linked;

    private Thread? _reader;
    private volatile bool _stopping;
    private int _users;
    private bool _closed;
    private volatile bool _faulted;

    public string Port { get; }
    public It930xModel Model { get; }
    public It930xBridge Bridge { get; }

    /// <summary>開くのにかかった時間 (ファームウェアの起動から電源を入れるまで)</summary>
    public long OpenMs { get; private set; }

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
            // Q3・W3 系は 4 つの受信機がどれもバス 2 にある (px4 の仕様書 2.1)
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
    /// 開く。ファームウェアを起動し、次の段の I2C と GPIO と TS の経路を設定する (MLT5 の仕様書 1.3・1.5、px4 の仕様書 2.3・2.5)。
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

    /// <summary>ブリッジの設定と電源 (MLT5 の仕様書 1.3・1.5、px4 の仕様書 2.3・2.5・13.3)。そのあと EP 0x84 を読み始める</summary>
    private void Setup()
    {
        if (Bridge.ConfigureReceivers(Model.Receivers) == 0)
        {
            Log.Write($"[{Label}] EEPROM の設定を読めていません (0x{It930xBridge.EepromValid:X4} が 0)。続けます");
        }
        // 開いたとき: 電源を切り (GPIOH7 か GPIOH3 = 1)、リセット中 (GPIOH2 = 0)、LNB を切る (GPIOH11 = 0)。そのあと 20 ms 待つ (MLT5 の仕様書 11)。
        // 受信機が 1 つの機種は GPIOH11 を設定も操作もしない (px4 の仕様書 13.3)
        Bridge.GpioSetup(Model.PowerPin, true);
        Bridge.GpioSetup(2, false);
        if (Model.Lnb) Bridge.GpioSetup(11, false);
        _sleep(20);
        // 受信機の TS 入力はどれもシリアル (MLT5 の仕様書 1.2・3.4、px4 の仕様書 2.3)
        var syncBytes = Model.SyncBytes;
        Bridge.ConfigureTs(new bool[It930xBridge.TsInputs], syncBytes);
        // 使わない入力は閉じておく (px4 の仕様書 2.3・13)。使う入力は、受信を始めるときに開ける (Attach)
        for (var input = 0; input < It930xBridge.TsInputs; input++)
        {
            if (syncBytes[input] == 0) Bridge.EnableTsInput(input, false);
        }
        if (Model.PowerWhileOpen) Power(true);
        _reader = new Thread(ReadTs) { IsBackground = true, Name = "it930x-ts" };
        _reader.Start();
    }

    /// <summary>
    /// 受信機の基板の電源を入れる・切る (MLT5 の仕様書 1.5、px4 の仕様書 2.5・13.3)。
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
            var buffer = new byte[It930xBridge.TsTransferSize];
            while (!_stopping)
            {
                var got = input.Read(buffer, TsReadTimeoutMs);
                if (got > 0) _demux.Push(buffer.AsSpan(0, got));
            }
        }
        catch (IOException error)
        {
            if (_stopping) return;
            // EP 0x84 の読みは全部の受信機で 1 本なので、読めなくなったら機材ごと使えないものとし、次の選局で開き直す
            _faulted = true;
            Log.Write($"[{Label}] TS を読めなくなりました: {UsbDevices.Reason(error)}");
            for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete(error.Message);
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> を開いて、後ろのチップを返す。開いていれば、そのまま返す。
    /// 開けなければ <see cref="IOException"/> (その受信機だけ。次の呼び出しでもう一度試す)。
    /// Q3 は、この側で最初の受信機を開くときに、もう片方の側の機材も取る (電源の連動。px4 の仕様書 2.6)
    /// </summary>
    public IIt930xFrontend Frontend(int receiver)
    {
        Wiring(receiver);
        lock (_openGate)
        {
            if (_openReceivers.Count == 0) Link();
            try
            {
                var frontend = _board.Open(receiver);
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

    /// <summary>Q3 のもう片方の側を取る。見つからない・開けないときは、記録に出して見つかった側だけを使う</summary>
    private void Link()
    {
        if (_link is null || _linked is not null) return;
        try
        {
            _linked = _link();
            if (_linked is null) Log.Write($"[{Label}] 同じ筐体のもう片方の側が見つかりません。見つかった側だけを使います (電源は連動しません)");
        }
        catch (IOException error)
        {
            Log.Write($"[{Label}] 同じ筐体のもう片方の側を開けませんでした ({error.Message})。この側だけを使います (電源は連動しません)");
        }
    }

    /// <summary>取っていたもう片方の側を返す。そちらも誰も使っていなければ閉じる (電源が切れる)</summary>
    private void Unlink()
    {
        if (Interlocked.Exchange(ref _linked, null) is not { } partner) return;
        partner.Release();
        CloseIfIdle(partner.Port);
    }

    private It930xReceiver Wiring(int receiver) =>
        Model.Receivers.FirstOrDefault(item => item.Index == receiver)
        ?? throw new IOException($"{Model.Name} に受信機 {receiver} はありません (0〜{Model.Receivers.Count - 1})");

    /// <summary>受信機の TS を <paramref name="output"/> に流し始める (ブリッジの入力を開ける)</summary>
    internal void Attach(int receiver, It930xTsOutput output)
    {
        var input = Wiring(receiver).TsInput;
        _demux.Attach(input, output)?.Complete();
        Bridge.EnableTsInput(input, true);
    }

    /// <summary>受信機の TS を止める (ブリッジの入力を閉じ、出口を止める)</summary>
    public void Detach(int receiver)
    {
        var input = Wiring(receiver).TsInput;
        try
        {
            Bridge.EnableTsInput(input, false);
        }
        finally
        {
            _demux.Detach(input)?.Complete();
        }
    }

    /// <summary>
    /// 使い終えた受信機を閉じ、LNB の給電の要求を取り下げる。
    /// CXD2856ER の機種は、チューナーを止めて復調器をスリープにしてから取り下げる (MLT5 の仕様書 10.3 の手順 2〜4)。
    /// TC90522 の機種は、取り下げてから閉じる (px4 の仕様書 11.3 の 1〜3)。閉じるのに失敗しても給電の要求は取り下げる
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
    /// 受信機 <paramref name="receiver"/> が LNB の給電を要求する・要求を取り下げる (MLT5 の仕様書 9、px4 の仕様書 10)。給電は機材 (Q3 は側) の受信機で 1 つ (ブリッジの GPIOH11。1 で入る) なので、
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
    /// LNB に給電している間の、短絡の検出の入力 (px4 の仕様書 10。GPIOH10 を有効にして入力にし、値を読む。true で正常、false で短絡)。
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
    /// 誰も使っていなければ閉じる (チューナーが捨てられたとき。定義が変わった・止める)。
    /// 閉じ終わるまで Registry を持つので、同じポートの Acquire は閉じ終えてから開く (古いほうの電源を切る書き込みが、新しく開いた機材に届かない)
    /// </summary>
    public static void CloseIfIdle(string port)
    {
        lock (Registry)
        {
            if (!Devices.TryGetValue(port, out var device)) return;
            lock (device._gate)
            {
                if (device._users > 0) return;
            }
            Devices.Remove(port);
            device.Close();
        }
    }

    /// <summary>全部閉じる (エージェントを止めるとき。<c>--tune</c> の終わり)。使っている側がいても閉じる</summary>
    public static void CloseAll()
    {
        lock (Registry)
        {
            // 閉じる途中で、Q3 のもう片方の側を返して一覧から外すことがあるので、写しを回す
            var devices = Devices.Values.ToList();
            Devices.Clear();
            foreach (var device in devices) device.Close();
        }
    }

    /// <summary>
    /// 受信機を全部閉じ、電源を切って (GPIOH2 ← 0、電源の GPIOH ← 1)、USB を閉じる。抜けていれば書かずに閉じる。
    /// 電源が GPIOH3 の機種は、受信機を閉じたときに電源を切っている
    /// </summary>
    private void Close()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
        }
        _stopping = true;
        _reader?.Join(TimeSpan.FromSeconds(2));
        for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete();
        if (!Faulted)
        {
            try
            {
                foreach (var receiver in Model.Receivers) Rest(receiver.Index, linked: false);
                if (Model.PowerWhileOpen) Power(false);
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
    /// <summary>LNB の給電の設定で受け付ける値。給電は 15 V だけ (MLT5 の仕様書 9、px4 の仕様書 10。0 か 15 V のほかは断る)</summary>
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

    /// <summary>周波数 (Hz) を kHz に丸める (チューナーに渡すのは中心周波数の kHz。MLT5 の仕様書 5.1、px4 の仕様書 5.1)</summary>
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
                // 給電しているときは、短絡の検出の入力も出す (px4 の仕様書 14 の 15)
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
        // 給電は 15 V だけ (MLT5 の仕様書 9、px4 の仕様書 10)。11 V は機材を開く前に断る
        if (tuning.Satellite && _lnb is not null && _lnb != Lnb15v)
        {
            throw new IOException($"{_name} の LNB の給電は 15V だけです (設定は {_lnb})");
        }
        lock (_gate)
        {
            // 受けられない種別は、機材に触る前に断る。機種は開かずに調べ、分からなければ開いたあとに確かめる
            _model ??= _device?.Model ?? _identify?.Invoke();
            if (_model is { } known) Check(tuning, known);
            StopOutput();
            IsdbcLocked = false;
            Tsmf = null;
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
                // 給電を入れてから選局する (順は px4 の仕様書 10。LNB が出力を出すまでの待ちは仕様書に無く、ロックの待ち (3 秒) に含める)
                _device.Lnb(_receiver, tuning.Satellite && _lnb == Lnb15v);
                var locked = _frontend.Tune(tuning);
                if (tuning.IsdbC) IsdbcLocked = locked;
                if (!locked) throw new IOException(ITuneDevice.SyncFailed);
                // TSMF で TS を選ぶ処理は ISDB-C のときだけ通す (MLT5 の仕様書 10.1)。ロックのあとで作る (仕様書 7A.7 の「パケットごとの処理」の 1)。
                // TSMF の判定の状態は、選局のたびに TsmfSelector を作り直して最初に戻す
                var tsmf = tuning.IsdbC ? new TsmfSelector(tuning.TsmfIndex) : null;
                Tsmf = tsmf;
                var output = new It930xTsOutput(tsmf);
                _device.Attach(_receiver, output);
                _output = output;
                // 受信を始めるときに、復調器の TS の端子を出す (px4 の仕様書 11.1)
                _frontend.Stream(true);
                if (tsmf is not null) WaitTsmf(_frontend, tsmf);
            }
            catch (IOException error)
            {
                if (_device is { } device)
                {
                    // 選局できなかった受信機は給電の要求を取り下げる (受けていない受信機のために LNB を入れたままにしない。px4 の仕様書 10 は前の指定に戻すと書く)
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

    /// <summary>ISDB-C で「指定した TS が無い」ときの失敗の文の先頭 (MLT5 の仕様書 7A.7。ロックしないときの <see cref="ITuneDevice.SyncFailed"/> とは別の失敗)</summary>
    public const string TsmfMissing = "指定した TS がありません";

    /// <summary>TSMF の判定の時間切れ (ms。MLT5 の仕様書 7A.7・11 の 3 秒)。変えるのはテストのため</summary>
    internal int TsmfTimeoutMs { get; init; } = TsmfSelector.TimeoutMs;

    /// <summary>最後の選局が ISDB-C で、復調器がロックしたか (<c>--tune</c> が出す)</summary>
    public bool IsdbcLocked { get; private set; }

    /// <summary>最後の ISDB-C の選局の TSMF の判定 (<c>--tune</c> が出す)。選局に失敗したあとも残す。ISDB-C でないか、ロックしなかったなら null</summary>
    public TsmfSelector? Tsmf { get; private set; }

    /// <summary>ISDB-C でロックしたあと TSMF の判定で失敗したときに、TS を止める前に読んだ信号品質 (<c>--tune</c> が出す)。読めなければ null</summary>
    public TunerSignal? IsdbcFailedSignal { get; private set; }

    /// <summary>最後の ISDB-C の選局で、ほかに読めた値 (MLT5 の仕様書 8.4A。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public CxdIsdbcDetail? IsdbcDetail => _frontend?.IsdbcDetail;

    /// <summary>
    /// TSMF の判定を待つ (MLT5 の仕様書 7A.4 の手順 6・7A.7 の「判定の待ち」)。判定には TS が要るので、ブリッジの入力を開けてから呼ぶ。
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
        if (decision == TsmfDecision.Pending) throw new IOException(ITuneDevice.SyncFailed);
        var detail = tsmf.FirstHeader is { } header
            ? $"TSMF の有効な TS は {header.ValidStreams.Count} 本で、{tsmf.Index} 本目 (0 から数える) を指定した"
            : $"TSMF を使わない搬送波で、TS は 0 本目だけ。{tsmf.Index} 本目を指定した";
        throw new IOException($"{TsmfMissing} ({detail})");
    }

    /// <summary>流している TS を止める (ブリッジの入力を閉じてから、復調器の TS の端子を止める。px4 の仕様書 11.2)</summary>
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
