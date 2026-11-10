using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>ブリッジの I2C の 1 本のバス (<see cref="It930xBridge.I2cWrite"/>・<see cref="It930xBridge.I2cRead"/>)</summary>
internal sealed class It930xI2cBus(It930xBridge bridge, byte bus) : ICxdBus
{
    public void Write(byte address, ReadOnlySpan<byte> data) => bridge.I2cWrite(bus, address, data);

    public void Read(byte address, Span<byte> data) => bridge.I2cRead(bus, address, data.Length).CopyTo(data);
}

/// <summary>
/// IT930x の機材 1 台 (USB のポート 1 つ)。開く (ファームウェア・ブリッジの設定・電源)、受信機ごとの復調器とチューナー、EP 0x84 の読み、閉じる。
///
/// <para>
/// **初めて要るときに開き、使っている側がいる間は開いたまま。** チューナー (<see cref="It930xTuner"/>) は最初の選局で取り、捨てるときに返す。
/// 誰も使わなくなったら閉じて電源を切る (<see cref="CloseIfIdle"/>)。内蔵カードリーダーは受信機と同じ電源なので (仕様書 1.5)、
/// カード (<see cref="It930xCard"/>) も使う側として数え、カードを使っている間は受信機を全部閉じても電源を切らない。
/// </para>
///
/// <para>
/// 受信機の初期化は、その受信機を初めて使うときに 1 回 (仕様書 2.2)。初期化に失敗した受信機だけを使えなくし、ほかの受信機はそのまま使う。
/// 失敗した受信機は、次の選局でもう一度試す。
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
    private readonly Func<long> _nowMs;
    private readonly Lock _gate = new();
    private readonly Dictionary<byte, Lock> _buses = [];
    private readonly Cxd2856Frontend?[] _frontends;
    private readonly Lock[] _receiverGates;
    private readonly It930xTsDemux _demux = new(It930xBridge.SyncBytes);
    private readonly Lock _lnbGate = new();
    private readonly HashSet<int> _lnbUsers = [];
    private Thread? _reader;
    private volatile bool _stopping;
    private int _users;
    private bool _closed;
    private volatile bool _faulted;

    /// <summary>待機中の地上波の RF 入力の整合を保つ設定にしたか (仕様書 4.7。<see cref="KeepMatching"/>)。電源を切るまで (この機材を閉じるまで) 立てたまま</summary>
    private volatile bool _matching;

    public string Port { get; }
    public It930xModel Model { get; }
    public It930xBridge Bridge { get; }

    /// <summary>開くのにかかった時間 (ファームウェアの起動から電源を入れるまで)</summary>
    public long OpenMs { get; private set; }

    /// <summary>USB が抜けたなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted => _faulted;

    private It930xDevice(string port, It930xModel model, IUsbDevice usb, It930xBridge bridge, Action<int> sleep, Func<long> nowMs)
    {
        Port = port;
        Model = model;
        _usb = usb;
        Bridge = bridge;
        _sleep = sleep;
        _nowMs = nowMs;
        _frontends = new Cxd2856Frontend?[model.Receivers.Count];
        _receiverGates = [.. model.Receivers.Select(_ => new Lock())];
        foreach (var receiver in model.Receivers) _buses.TryAdd(receiver.I2cBus, new Lock());
    }

    private string Label => $"{Model.Name} {Port}";

    /// <summary>
    /// 取る。開いていなければ、そのとき開く。**返すのは <see cref="Release"/>**。
    /// px4d がそのポートの筐体を使っていれば開かずに断る (持ち主の決まり。<see cref="It930x.Claim"/>)
    /// </summary>
    public static It930xDevice Acquire(string port) => Acquire(port, () =>
    {
        if (Px4Daemon.Owned().Any(enclosure => enclosure.Places.Contains(port)))
        {
            throw new IOException($"USB のポート {port} の機材は px4d が使っています (設定から px4: の受信機を外してください)");
        }
        var model = It930x.Identify(port) ?? throw new IOException($"USB のポート {port} に {It930x.Model} が見当たりません");
        return (It930x.OpenUsb(port, model), model);
    }, Thread.Sleep, () => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency, () => It930xFirmware.Code);

    /// <param name="open">USB を開いて機種と一緒に返す。テストは偽の機材を返す</param>
    /// <param name="firmware">確かめたファームウェア (<see cref="It930xFirmware.Code"/>)</param>
    /// <param name="waiting">機材の一覧のロックを取る直前に呼ぶ (テストが、閉じている途中の開き直しを確かめるため)</param>
    internal static It930xDevice Acquire(
        string port, Func<(IUsbDevice Usb, It930xModel Model)> open, Action<int> sleep, Func<long> nowMs, Func<byte[]> firmware, Action? waiting = null)
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
            device = Open(port, open, sleep, nowMs, firmware);
            device._users = 1;
            Devices[port] = device;
            return device;
        }
    }

    /// <summary>
    /// 開く。ファームウェアを起動し、次の段の I2C と GPIO と TS の経路を設定して、受信機の電源を入れる (仕様書 1.3・1.5)。
    /// REBOOT で USB がつなぎ直されたときは、機材が戻るのを待って 1 回だけ開き直す
    /// </summary>
    private static It930xDevice Open(string port, Func<(IUsbDevice Usb, It930xModel Model)> open, Action<int> sleep, Func<long> nowMs, Func<byte[]> firmware)
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
            var device = new It930xDevice(port, model, usb, bridge, sleep, nowMs);
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

    /// <summary>ブリッジの設定と電源 (仕様書 1.3・1.5)。そのあと EP 0x84 を読み始める</summary>
    private void Setup()
    {
        if (Bridge.ConfigureReceivers(Model.Receivers) == 0)
        {
            Log.Write($"[{Label}] EEPROM の設定を読めていません (0x{It930xBridge.EepromValid:X4} が 0)。続けます");
        }
        // 開いたとき (仕様書 1.5): 電源を切り (GPIOH7 = 1)、リセット中 (GPIOH2 = 0)、LNB を切る (GPIOH11 = 0)。そのあと 20 ms 待つ (仕様書 11)
        Bridge.GpioSetup(7, true);
        Bridge.GpioSetup(2, false);
        Bridge.GpioSetup(11, false);
        _sleep(20);
        // 受信機の TS 入力はどれもシリアル (仕様書 1.2・3.4)
        Bridge.ConfigureTs(new bool[It930xBridge.TsInputs]);
        // 電源を入れる (仕様書 1.5): GPIOH7 ← 0、80 ms、GPIOH2 ← 1 (リセットを解く)、20 ms
        Bridge.Gpio(7, false);
        _sleep(80);
        Bridge.Gpio(2, true);
        _sleep(20);
        _reader = new Thread(ReadTs) { IsBackground = true, Name = "it930x-ts" };
        _reader.Start();
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
            // EP 0x84 の読みは 5 つの受信機で 1 本なので、読めなくなったら機材ごと使えないものとし、次の選局で開き直す
            _faulted = true;
            Log.Write($"[{Label}] TS を読めなくなりました: {UsbDevices.Reason(error)}");
            for (var input = 0; input < It930xBridge.TsInputs; input++) _demux.Detach(input)?.Complete(error.Message);
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> の復調器とチューナー。初めてのときに初期化する (仕様書 2.2)。
    /// 初期化に失敗したら <see cref="IOException"/> (その受信機だけ。次の呼び出しでもう一度試す)
    /// </summary>
    public Cxd2856Frontend Frontend(int receiver)
    {
        var wiring = Wiring(receiver);
        lock (_receiverGates[receiver])
        {
            if (_frontends[receiver] is { } ready) return ready;
            var frontend = new Cxd2856Frontend(new It930xI2cBus(Bridge, wiring.I2cBus), _buses[wiring.I2cBus], wiring.DemodAddress, _sleep, _nowMs);
            try
            {
                // 整合を保つ設定にしたあとに初めて使う受信機は、その設定で初期化する (仕様書 4.7)
                if (_matching) frontend.KeepMatching(standby: false);
                frontend.Init();
            }
            catch (IOException error)
            {
                Fail(error);
                throw new IOException($"{Label} の受信機 {receiver} を初期化できません: {error.Message}", error);
            }
            Log.Write($"[{Label}] 受信機 {receiver} を初期化しました (復調器 0x{frontend.ChipId:X2})");
            return _frontends[receiver] = frontend;
        }
    }

    /// <summary>
    /// 待機中の地上波の RF 入力の整合を保つ設定を、機材の全受信機で立てる (仕様書 4.7)。電源を入れてから最初に J.83B か ISDB-C を選局するときに、
    /// その受信機 (<paramref name="receiver"/>) のチューナーが呼ぶ。2 回目からは何もしない。
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
        Log.Write($"[{Label}] J.83B か ISDB-C を選局するので、全受信機を待機中の RF 入力の整合を保つ設定にします");
        foreach (var other in Model.Receivers.Select(item => item.Index))
        {
            try
            {
                lock (_receiverGates[other])
                {
                    // まだ使っていない受信機は、整合を保つ設定で初期化して待機させる (Frontend の中で設定を立てる)
                    if (_frontends[other] is { } frontend) frontend.KeepMatching(standby: other != receiver);
                    else Frontend(other);
                }
            }
            catch (IOException error)
            {
                Fail(error);
                Log.Write($"[{Label}] 受信機 {other} を整合を保つ設定にできませんでした ({error.Message})");
            }
        }
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
    /// 使い終えた受信機のチューナーを止め、復調器をスリープにして、LNB の給電の要求を取り下げる (仕様書 10.3 の手順 2〜4)。
    /// スリープが失敗しても給電の要求は取り下げる
    /// </summary>
    public void Rest(int receiver)
    {
        Cxd2856Frontend? frontend;
        lock (_receiverGates[receiver]) frontend = _frontends[receiver];
        try
        {
            frontend?.Sleep();
        }
        finally
        {
            Lnb(receiver, false);
        }
    }

    /// <summary>
    /// 受信機 <paramref name="receiver"/> が LNB の給電を要求する・要求を取り下げる (仕様書 9)。給電は 5 つの受信機で 1 つ (ブリッジの GPIOH11。1 で入る) なので、
    /// 給電を要求している受信機の数が 0 から 1 になるときに入れ、1 から 0 になるときに切る。書き込みに失敗したら、要求している受信機の数は書く前に戻す
    /// </summary>
    public void Lnb(int receiver, bool on)
    {
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
            foreach (var device in Devices.Values) device.Close();
            Devices.Clear();
        }
    }

    /// <summary>
    /// 受信機を全部スリープにし、電源を切って (仕様書 1.5: GPIOH2 ← 0、GPIOH7 ← 1)、USB を閉じる。抜けていれば書かずに閉じる
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
                for (var receiver = 0; receiver < _frontends.Length; receiver++) Rest(receiver);
                Bridge.Gpio(2, false);
                Bridge.Gpio(7, true);
            }
            catch (IOException error)
            {
                Log.Write($"[{Label}] 電源を切れませんでした ({error.Message})");
            }
        }
        _usb.Dispose();
        Log.Write($"[{Label}] 閉じました");
    }
}

/// <summary>
/// IT930x の機材の受信機 1 つ (設定の <c>it930x:&lt;USB のポート&gt;:&lt;受信機&gt;</c>)。地上波 (ISDB-T)・衛星 (ISDB-S)・J.83B (スカパー！プレミアムサービス光)・ISDB-C (ケーブルテレビのトランスモジュレーション方式) を同じ受信機で切り替えて選局する。
/// J.83B の TS はスクランブルされたまま流す (スカパー！プレミアムのカードはまだ扱わない。<see cref="Lease"/> は B-CAS のカードに問い合わせない)。
/// 機材 (<see cref="It930xDevice"/>) は最初の選局で取り、捨てるときに返す。
/// 選局のたびに新しい出口 (<see cref="It930xTsOutput"/>。Pipe と DeviceStream) を作り、前の選局のパケットと混ぜない
/// </summary>
public sealed class It930xTuner : ITuneDevice
{
    /// <summary>LNB の給電の設定で受け付ける値。給電は 15 V だけ (仕様書 9。0 か 15 V のほかは断る)</summary>
    public const string Lnb15v = "15v";

    private readonly string _name;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly Func<It930xDevice> _acquire;
    private readonly Action? _closeIdle;
    private readonly Lock _gate = new();
    private It930xDevice? _device;
    private Cxd2856Frontend? _frontend;
    private It930xTsOutput? _output;

    /// <param name="lnb">設定の LNB (<c>15v</c> なら衛星を選局するときに給電する。空か null なら給電しない。<c>11v</c> などは衛星の選局で断る)</param>
    public It930xTuner(string port, int receiver, string? lnb = null)
        : this($"{It930x.Model} {port} #{receiver}", receiver, () => It930xDevice.Acquire(port), () => It930xDevice.CloseIfIdle(port), lnb)
    {
    }

    internal It930xTuner(string name, int receiver, Func<It930xDevice> acquire, Action? closeIdle = null, string? lnb = null)
    {
        _name = name;
        _receiver = receiver;
        _acquire = acquire;
        _closeIdle = closeIdle;
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

    /// <summary>周波数 (Hz) を kHz に丸める (チューナーに渡すのは中心周波数の kHz。仕様書 5.1)</summary>
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

    public void Tune(ChannelTable.Tuning tuning)
    {
        // 給電は 15 V だけ (仕様書 9)。11 V は機材を開く前に断る
        if (tuning.Satellite && _lnb is not null && _lnb != Lnb15v)
        {
            throw new IOException($"{_name} の LNB の給電は 15V だけです (設定は {_lnb})");
        }
        lock (_gate)
        {
            StopOutput();
            CableFrequency = null;
            IsdbcLocked = false;
            Tsmf = null;
            IsdbcFailedSignal = null;
            // 抜けた・TS を読めなくなった機材は返して、開き直す
            if (_device is { Faulted: true }) Drop();
            try
            {
                _device ??= _acquire();
                _frontend = _device.Frontend(_receiver);
                bool locked;
                if (tuning.Satellite)
                {
                    // 給電を入れてから選局する (順は仕様書に無い。LNB が出力を出すまでの待ちも仕様書に無く、ロックの待ち (3 秒) に含める)
                    _device.Lnb(_receiver, _lnb == Lnb15v);
                    // 衛星は選局表の周波数が IF の kHz (仕様書 6.1)
                    locked = _frontend.TuneIsdbs(tuning.Frequency, CxdStream.From(tuning.StreamId));
                }
                else if (tuning.Cable)
                {
                    _device.Lnb(_receiver, false);
                    _device.KeepMatching(_receiver);
                    locked = TuneCable(tuning, _frontend.TuneJ83b);
                }
                else if (tuning.IsdbC)
                {
                    /*
                     * ISDB-C (仕様書 7A.4)。手順 1 の「ブリッジが NULL パケットを落とさないようにする」(仕様書 3.4) は、denpa のブリッジの層が
                     * どの方式でも PID で落とす設定を使っていないので、切り替える書き込みは無い。TSMF の判定の状態は、選局のたびに TsmfSelector を作り直して最初に戻す。
                     * 整合を保つ設定 (仕様書 4.7) は J.83B と同じく、最初の選局で全受信機に立てる
                     */
                    _device.Lnb(_receiver, false);
                    _device.KeepMatching(_receiver);
                    locked = TuneCable(tuning, _frontend.TuneIsdbc);
                    IsdbcLocked = locked;
                }
                else
                {
                    _device.Lnb(_receiver, false);
                    locked = _frontend.TuneIsdbt(Khz(tuning.Frequency));
                }
                if (!locked) throw new IOException(ITuneDevice.SyncFailed);
                // TSMF で TS を選ぶ処理は ISDB-C のときだけ通す (仕様書 10.1)。ロックのあとで作る (仕様書 7A.7 の「パケットごとの処理」の 1)
                var tsmf = tuning.IsdbC ? new TsmfSelector(tuning.TsmfIndex) : null;
                Tsmf = tsmf;
                var output = new It930xTsOutput(tsmf);
                _device.Attach(_receiver, output);
                _output = output;
                if (tsmf is not null) WaitTsmf(_frontend, tsmf);
            }
            catch (IOException error)
            {
                if (_device is { } device)
                {
                    // 選局できなかった受信機は給電の要求を取り下げる (受けていない受信機のために LNB を入れたままにしない。仕様書に無い)
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

    /// <summary>
    /// J.83B と ISDB-C で、ずらして送られることがあるチャンネル (<see cref="ChannelTable.Tuning.ShiftedFrequency"/>) の、最後にロックした周波数 (Hz)。
    /// 選局表の周波数をキーにする。次の選局はこちらを先に試す (毎回 1 秒の時間切れを待たないため。仕様書に無い)
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<uint, uint> CableLocked = new();

    /// <summary>最後の J.83B か ISDB-C の選局で受けた周波数 (Hz。<c>--tune</c> が出す)。ロックしなかったか、ほかの方式なら null</summary>
    public uint? CableFrequency { get; private set; }

    /// <summary>
    /// J.83B か ISDB-C を選局する (仕様書 7.4・7A.4)。<paramref name="tune"/> は中心周波数の kHz を受け取って選局し、ロックしたかを返す。
    /// ずらして送られることがあるチャンネル (仕様書 7.1。ISDB-C の C24〜C27 は仕様書 7A.2 の推定の使い方) は、選局表の周波数とずらした周波数の両方を試し、
    /// 前にロックしたほうを先にする。どちらもロックしなければ false
    /// </summary>
    private bool TuneCable(ChannelTable.Tuning tuning, Func<uint, bool> tune)
    {
        CableFrequency = null;
        uint[] tries = tuning.ShiftedFrequency is { } shifted
            ? CableLocked.TryGetValue(tuning.Frequency, out var last) && last == shifted ? [shifted, tuning.Frequency] : [tuning.Frequency, shifted]
            : [tuning.Frequency];
        foreach (var hertz in tries)
        {
            if (!tune(Khz(hertz))) continue;
            if (tuning.ShiftedFrequency is not null) CableLocked[tuning.Frequency] = hertz;
            CableFrequency = hertz;
            return true;
        }
        return false;
    }

    /// <summary>ISDB-C で「指定した TS が無い」ときの失敗の文の先頭 (仕様書 7A.7。ロックしないときの <see cref="ITuneDevice.SyncFailed"/> とは別の失敗)</summary>
    public const string TsmfMissing = "指定した TS がありません";

    /// <summary>TSMF の判定の時間切れ (ms。仕様書 7A.7・11 の 3 秒)。変えるのはテストのため</summary>
    internal int TsmfTimeoutMs { get; init; } = TsmfSelector.TimeoutMs;

    /// <summary>最後の選局が ISDB-C で、復調器がロックしたか (<c>--tune</c> が出す)</summary>
    public bool IsdbcLocked { get; private set; }

    /// <summary>最後の ISDB-C の選局の TSMF の判定 (<c>--tune</c> が出す)。選局に失敗したあとも残す。ISDB-C でないか、ロックしなかったなら null</summary>
    public TsmfSelector? Tsmf { get; private set; }

    /// <summary>ISDB-C でロックしたあと TSMF の判定で失敗したときに、TS を止める前に読んだ信号品質 (<c>--tune</c> が出す)。読めなければ null</summary>
    public TunerSignal? IsdbcFailedSignal { get; private set; }

    /// <summary>
    /// TSMF の判定を待つ (仕様書 7A.4 の手順 6・7A.7 の「判定の待ち」)。判定には TS が要るので、ブリッジの入力を開けてから呼ぶ。
    /// 3 秒で決まらなければロックしないときと同じ失敗、「指定した TS が無い」は別の失敗にして、TS を止める
    /// </summary>
    private void WaitTsmf(Cxd2856Frontend frontend, TsmfSelector tsmf)
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

    /// <summary>最後の J.83B か ISDB-C の選局で読んだ変調 (<c>256QAM</c> など。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public string? CableModulation => _frontend?.CableModulation;

    /// <summary>最後の J.83B か ISDB-C の選局で読んだ PER (<see cref="Signal"/> を読んだあと。値が正しいかは未確認)。<c>--tune</c> だけが出す</summary>
    public double? CablePer => _frontend?.CablePer;

    /// <summary>最後の ISDB-C の選局で、ほかに読めた値 (仕様書 8.4A。<see cref="Signal"/> を読んだあと)。<c>--tune</c> だけが出す</summary>
    public CxdIsdbcDetail? IsdbcDetail => _frontend?.IsdbcDetail;

    /// <summary>流している TS を止める</summary>
    private void StopOutput()
    {
        if (_output is null) return;
        _output = null;
        try
        {
            _device?.Detach(_receiver);
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
        device?.Release();
    }

    /// <summary>捨てる (定義が変わった・止める)。チューナーを止めて復調器をスリープにし、機材を返す。誰も使っていなければ機材を閉じる</summary>
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
