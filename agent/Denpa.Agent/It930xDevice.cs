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
/// カードを足すときはカードも使う側として数え、カードを使っている間は受信機を全部閉じても電源を切らない。
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
    internal static It930xDevice Acquire(string port, Func<(IUsbDevice Usb, It930xModel Model)> open, Action<int> sleep, Func<long> nowMs, Func<byte[]> firmware)
    {
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

    /// <summary>使い終えた受信機のチューナーを止め、復調器をスリープにする (仕様書 10.3)</summary>
    public void Rest(int receiver)
    {
        Cxd2856Frontend? frontend;
        lock (_receiverGates[receiver]) frontend = _frontends[receiver];
        frontend?.Sleep();
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
/// IT930x の機材の受信機 1 つ (設定の <c>it930x:&lt;USB のポート&gt;:&lt;受信機&gt;</c>)。**いまは地上波だけ** (衛星はまだ断る)。
/// 機材 (<see cref="It930xDevice"/>) は最初の選局で取り、捨てるときに返す。
/// 選局のたびに新しい出口 (<see cref="It930xTsOutput"/>。Pipe と DeviceStream) を作り、前の選局のパケットと混ぜない
/// </summary>
public sealed class It930xTuner : ITuneDevice
{
    private readonly string _name;
    private readonly int _receiver;
    private readonly Func<It930xDevice> _acquire;
    private readonly Action? _closeIdle;
    private readonly Lock _gate = new();
    private It930xDevice? _device;
    private Cxd2856Frontend? _frontend;
    private It930xTsOutput? _output;

    public It930xTuner(string port, int receiver)
        : this($"{It930x.Model} {port} #{receiver}", receiver, () => It930xDevice.Acquire(port), () => It930xDevice.CloseIfIdle(port))
    {
    }

    internal It930xTuner(string name, int receiver, Func<It930xDevice> acquire, Action? closeIdle = null)
    {
        _name = name;
        _receiver = receiver;
        _acquire = acquire;
        _closeIdle = closeIdle;
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

    public void Tune(ChannelTable.Tuning tuning)
    {
        if (tuning.Satellite) throw new IOException($"{_name} は衛星をまだ受けられません (いまは地上波だけ。#1578)");
        lock (_gate)
        {
            StopOutput();
            // 抜けた・TS を読めなくなった機材は返して、開き直す
            if (_device is { Faulted: true }) Drop();
            try
            {
                _device ??= _acquire();
                _frontend = _device.Frontend(_receiver);
                if (!_frontend.TuneIsdbt(Khz(tuning.Frequency))) throw new IOException(ITuneDevice.SyncFailed);
                var output = new It930xTsOutput();
                _device.Attach(_receiver, output);
                _output = output;
            }
            catch (IOException error)
            {
                if (_device is { } device)
                {
                    device.Fail(error);
                    if (device.Faulted) Drop();
                }
                if (error is UsbGoneException) throw new IOException($"{error.Message}。挿し直してください", error);
                throw;
            }
        }
    }

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
