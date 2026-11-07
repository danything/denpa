using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 1 台ぶんの持ち主。**USB のハンドルと機材の設定は 1 台に 1 つだけ**で、チューナー (<see cref="Dt295NativeTuner"/>) と
/// カード (<see cref="Dt295NativeCard"/>) が取って使う。ホストが 0xBC のメモリ要求でレジスタを書いて機材を設定し (<see cref="Dt295NativeBoard"/>)、
/// I2C で復調・チューナーを動かし (<see cref="Dt295NativeFrontend"/>)、機材の中では TS を送る小さなプログラムだけを動かす (<see cref="Dt295NativePrograms"/>)。
///
/// <para>
/// 開くときは起動直後の機材に設定を書く。起動直後でなければ (途中で止まった自前の hook が残っている、ほかのファームウェアが動いたあと)、
/// Linux はポートの電源を 1 回入れ直してからやり直し、ほかの OS は挿し直しを求めて断る。
/// 閉じるときは書いたものを逆順に戻すので、続けて開き直せる (実機で確かめた)。エージェントが動いている間は開いたまま (Zd1jBoard と同じ)
/// </para>
/// </summary>
public sealed class Dt295NativeDevice
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, Dt295NativeDevice> Devices = [];

    private readonly Lock _gate = new();
    private readonly Stack<(string Name, Action Undo)> _undo;
    private int _users;
    private bool _closed;
    private bool _faulted;

    public string Port { get; }
    public IUsbDevice Usb { get; }
    public Dt295NativeLink Link { get; }
    public Dt295NativeBoard Board { get; }
    public Dt295NativeFrontend Frontend { get; }

    /// <summary>リングが空のまま待つ回数の上限 (取り込みが止まっているとき、要求を返させる)。実機の試験の値。テストは偽の機材が速く返るよう小さくする</summary>
    internal const uint IdlePollsDefault = 1_000_000;

    internal uint IdlePolls { get; }

    /// <summary>時間の内訳を取るとき (--dt295-probe)。取らなければ null</summary>
    internal Dt295Timeline? Timeline { get; }

    /// <summary>設定の書き込みにかかった時間と、そのときの制御転送の数 (記録と比較用)</summary>
    public (TimeSpan Time, long Controls) SetUp { get; }

    private Dt295NativeDevice(string port, IUsbDevice usb, Dt295NativeLink link, Dt295NativeBoard board, Dt295NativeFrontend frontend,
        Stack<(string, Action)> undo, (TimeSpan, long) setUp, uint idlePolls, Dt295Timeline? timeline)
    {
        Port = port;
        Usb = usb;
        Link = link;
        Board = board;
        Frontend = frontend;
        _undo = undo;
        SetUp = setUp;
        IdlePolls = idlePolls;
        Timeline = timeline;
    }

    /// <summary>USB が抜けた・制御転送が通らなくなったなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted => _faulted || Link.Dead;

    /// <summary>取る。開いていなければ、そのとき開いて設定する。**返すのは <see cref="Release"/>**</summary>
    public static Dt295NativeDevice Acquire(string port, Dt295Timeline? timeline = null) =>
        Acquire(port, () => Dt295.OpenUsb(port), OperatingSystem.IsLinux() ? () => UsbSysfs.PowerCycle(UsbSysfs.Devices, port, TimeSpan.FromSeconds(10)) : null, timeline: timeline);

    /// <param name="open">USB を開く</param>
    /// <param name="powerCycle">ポートの電源を入れ直す (Linux)。null なら挿し直しを求めて断る</param>
    internal static Dt295NativeDevice Acquire(string port, Func<IUsbDevice> open, Action? powerCycle, Action<int>? sleep = null, uint idlePolls = IdlePollsDefault, Dt295Timeline? timeline = null)
    {
        // 開く間 (電源の入れ直しは最大 10 秒) は同じポートだけを待たせる。別のポートの DT295 は待たない
        lock (PortGate(port))
        {
            Dt295NativeDevice? stale;
            lock (Registry)
            {
                Devices.TryGetValue(port, out var current);
                if (current is not null && !current.Faulted)
                {
                    lock (current._gate) current._users++;
                    return current;
                }
                stale = current;
                Devices.Remove(port);
            }
            stale?.Close();
            Dt295NativeDevice device;
            try
            {
                device = Open(port, open, sleep, idlePolls, timeline);
            }
            catch (Dt295NativeWarmException error)
            {
                if (powerCycle is null)
                {
                    throw new IOException($"{Dt295.Model} {port} は起動直後の状態ではありません ({error.Message})。USB を挿し直してください", error);
                }
                // 前の実行が途中で止まった・ほかのファームウェアが動いたあとの機材。ポートの電源を入れ直すと、起動直後の状態に戻る
                Log.Write($"[{Dt295.Model} {port}] {error.Message}。USB のポートの電源を入れ直します");
                powerCycle();
                device = Open(port, open, sleep, idlePolls, timeline);
            }
            device._users = 1;
            lock (Registry) Devices[port] = device;
            Log.Write($"[{Dt295.Model} {port}] 開きました (設定 {device.SetUp.Time.TotalMilliseconds:F0}ms、制御転送 {device.SetUp.Controls} 回)");
            return device;
        }
    }

    private static readonly Dictionary<string, object> PortGates = [];

    private static object PortGate(string port)
    {
        lock (PortGates)
        {
            if (!PortGates.TryGetValue(port, out var gate)) PortGates[port] = gate = new object();
            return gate;
        }
    }
    private static Dt295NativeDevice Open(string port, Func<IUsbDevice> open, Action<int>? sleep, uint idlePolls, Dt295Timeline? timeline)
    {
        using var opening = timeline.Step("機材を開いて設定する");
        IUsbDevice usb;
        using (timeline.Step("USB を開く")) usb = open();
        var link = new Dt295NativeLink(usb);
        var undo = new Stack<(string, Action)>();
        var clock = Stopwatch.StartNew();
        try
        {
            // 書いてよい USB コアのレジスタは、I2C の準備の 4 つだけ (許可したものしか書けない。Dt295NativeLink.AllowedCoreWrites)
            foreach (var register in Dt295NativeI2c.ClockRegisters) link.AllowedCoreWrites.Add(register);
            var board = new Dt295NativeBoard(link, timeline: timeline);
            var i2c = new Dt295NativeI2c(link);
            if (timeline is not null)
            {
                timeline.Controls = () => link.Controls;
                timeline.Transfers = () => i2c.Transfers;
            }
            var frontend = new Dt295NativeFrontend(i2c, sleep ?? Thread.Sleep, timeline);
            using (timeline.Step("窓を既定にする", "仕様書 3.1")) link.ResetWindows();
            using (timeline.Step("起動直後の確認", "仕様書 3.1。hook と 0x82008 を読む")) board.Preflight();
            using (timeline.Step("外部メモリーの有効化", "仕様書 3.3")) board.EnableExternalMemory();
            using (timeline.Step("body と hook を書く", "仕様書 3.2。書いて読み戻す")) board.InstallBody(Dt295NativePrograms.Build());
            undo.Push(("hook を元に戻す", board.RemoveHook));
            using (timeline.Step("0xF10080〜0xF10098 に書く", "仕様書に無い。実機の観測。読まない")) board.SetUpF10080();
            undo.Push(("0xF10080〜0xF10098 を戻す", board.RestoreF10080));
            Dt295NativeBoard.Saved chip;
            using (timeline.Step("チップの設定 (INITIALIZE)", "仕様書 6 章")) chip = board.Initialize();
            undo.Push(("チップの設定を戻す", () => board.Restore(chip)));
            using (timeline.Step("0xF10018・0xF1001C を立てる", "仕様書 6 章。実機の観測")) board.EnableAfterInitialize();
            using (timeline.Step("USB のレジスタ", "仕様書 8.4。書いて読み戻す")) board.SetUpUsb();
            uint f10114;
            using (timeline.Step("0xF10114 のビット 21", "仕様書に無い。実機の観測")) f10114 = board.SetUpF10114();
            undo.Push(("0xF10114 を戻す", () => board.RestoreF10114(f10114)));
            IReadOnlyList<(uint Address, uint Value)> i2cSaved;
            using (timeline.Step("I2C の準備", "仕様書 6.4。書いて読み戻す")) i2cSaved = i2c.Prepare();
            undo.Push(("I2C の設定を戻す", () => i2c.Restore(i2cSaved)));
            if (!i2c.Alive) throw new Dt295NativeException("I2C のレジスタが書いた値で読めません");
            // 機材の中の I2C の順次実行が使えれば使う。使えなければ、ホストが 1 つずつ行う
            using (timeline.Step("I2C の順次実行の確認", "転送 0 個の要求と、操作列の置き場の読み書き"))
            {
                i2c.UseSequencer = link.ProbeI2cSequencer();
            }
            using (timeline.Step("復調とチューナーの初期化 (INITIALIZE の I2C)", "仕様書 7.1")) frontend.Initialize();
            undo.Push(("地上波側を休ませる", frontend.RestTerrestrial));
            return new Dt295NativeDevice(port, usb, link, board, frontend, undo, (clock.Elapsed, link.Controls), idlePolls, timeline);
        }
        catch
        {
            Undo(undo, link, port);
            usb.Dispose();
            throw;
        }
    }

    /// <summary>設定を逆順に戻す。USB の制御が止まっていれば省く。失敗しても続ける</summary>
    private static void Undo(Stack<(string Name, Action Undo)> undo, Dt295NativeLink link, string port)
    {
        while (undo.TryPop(out var item))
        {
            if (link.Dead) continue;
            try
            {
                item.Undo();
            }
            catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
            {
                Log.Write($"[{Dt295.Model} {port}] {item.Name}: 失敗しました ({error.Message})");
            }
        }
        if (link.Dead) return;
        try
        {
            link.RestoreWindows();
        }
        catch (Exception error) when (error is IOException or TimeoutException)
        {
            Log.Write($"[{Dt295.Model} {port}] 窓を既定に戻せません ({error.Message})");
        }
    }

    /// <summary>失敗が USB の抜けなら、使えない印を付ける (次に取る側は開き直す)。制御転送が通らなくなったときは <see cref="Dt295NativeLink.Dead"/> が印になる</summary>
    public void Fail(Exception error)
    {
        if (error is UsbGoneException) _faulted = true;
    }

    /// <summary>返す。開いたままにする (使えなくなっていれば閉じる)</summary>
    public void Release()
    {
        lock (_gate)
        {
            if (--_users > 0) return;
        }
        if (!Faulted) return;
        lock (Registry)
        {
            if (Devices.TryGetValue(Port, out var current) && current == this) Devices.Remove(Port);
        }
        Close();
    }

    /// <summary>誰も使っていなければ閉じる (チューナーが捨てられたとき)。カードが使っていれば開いたまま</summary>
    public static void CloseIfIdle(string port)
    {
        Dt295NativeDevice? device;
        lock (Registry)
        {
            if (!Devices.TryGetValue(port, out device)) return;
            lock (device._gate)
            {
                if (device._users > 0) return;
            }
            Devices.Remove(port);
        }
        device.Close();
    }

    /// <summary>全部閉じる (エージェントを止めるとき)。使っている側がいても閉じる</summary>
    public static void CloseAll()
    {
        List<Dt295NativeDevice> devices;
        lock (Registry)
        {
            devices = [.. Devices.Values];
            Devices.Clear();
        }
        foreach (var device in devices) device.Close();
    }

    /// <summary>設定を戻して USB を閉じる。機材は起動直後の状態に戻るので、続けて開き直せる</summary>
    private void Close()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            Undo(_undo, Link, Port);
            Usb.Dispose();
            Log.Write($"[{Dt295.Model} {Port}] 閉じました");
        }
    }
}
