using System.Diagnostics;
using System.Globalization;
using System.IO.Pipelines;

namespace Denpa.Agent;

/// <summary>
/// Sony CECH-ZD1 J (PS3 の torne の地デジチューナー。USB <c>054c:04b2</c>)。**外のデーモンを置かず、エージェントが USB を直に持つ。**
///
/// <para>
/// 中身は富士通 MB86H47A の USB ブリッジ (Mb86h47.cs) と DiB8096 (Dib8096.cs)。ファームウェアは要らず、
/// ホストがメモリ要求でレジスタを叩く。B-CAS の差し込み口もブリッジの UART で、CCID ではない (<see cref="Zd1jCard"/>)。
/// 作りは docs/agent.md「CECH-ZD1 J の作り」。USB は Linux の usbfs・Windows の WinUSB (Zadig で当てる)・macOS の IOKit。
/// </para>
///
/// <para>
/// 設定の <c>device</c> は <c>zd1j:&lt;USB のポート&gt;</c> (<c>zd1j:4-12.1</c>。シリアルは無い)。Windows と macOS でも同じ形の
/// 名前を作る (<see cref="UsbDevices.WindowsPort"/>・<see cref="UsbDevices.MacPort"/>)。
/// 刺さっていれば <see cref="Detect"/> が見つけるので、普通は書かなくてよい。挿すポートを変えると別のチューナーになる。
/// </para>
/// </summary>
public static class Zd1j
{
    public const string Scheme = "zd1j:";
    public const int Vendor = 0x054C;
    public const int Product = 0x04B2;
    public const string Model = "Sony CECH-ZD1 J";

    private const string DevUsb = "/dev/bus/usb";

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>zd1j:4-12.1</c> からポートを取る。形式が違えば null</summary>
    public static string? Parse(string device)
    {
        if (!Is(device)) return null;
        var port = device[Scheme.Length..];
        return UsbSysfs.IsPort(port) ? port : null;
    }

    /// <summary>
    /// 刺さっている CECH-ZD1 J のポート。**開かない** (開くと他から使えなくなり、ブリッジの起動もしてしまう)。
    /// カーネルのドライバが使っているものは並べない (usbfs はこちらが開いている印なので並べる)
    /// </summary>
    internal static List<string> Ports(string sysfs, Action<string>? warn = null)
    {
        var found = new List<string>();
        if (!Directory.Exists(sysfs)) return found;
        var vendor = Vendor.ToString("x4", CultureInfo.InvariantCulture);
        var product = Product.ToString("x4", CultureInfo.InvariantCulture);
        foreach (var dir in Directory.EnumerateFileSystemEntries(sysfs).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(dir);
            if (!UsbSysfs.IsPort(port)) continue;
            if (UsbSysfs.Read(dir, "idVendor") != vendor || UsbSysfs.Read(dir, "idProduct") != product) continue;
            var driver = UsbSysfs.Driver(sysfs, port);
            if (driver is not (null or "usbfs"))
            {
                warn?.Invoke($"{Model} {port} はカーネルのドライバ ({driver}) が使っているので使いません");
                continue;
            }
            found.Add(port);
        }
        return found;
    }

    /// <summary>刺さっているポート (OS ごと)。Windows・macOS は OS の並べたもの</summary>
    private static List<string> Ports(Action<string>? warn = null)
    {
        try
        {
            return OperatingSystem.IsLinux() ? Ports(UsbSysfs.Devices, warn) : [.. UsbDevices.List(Vendor, Product).Select(found => found.Port)];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            warn?.Invoke($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>設定に書いたのと同じ形式で。種別は地上波だけ</summary>
    public static List<TunerSpec> Detect() =>
        [.. Ports(Log.Write).Select(port => new TunerSpec($"{Model} {port}", ["GR"], false, Device(port)))];

    /// <summary>内蔵の差し込み口 (カードリーダー)。**開くまでは何も開かない**</summary>
    public static IReadOnlyList<CardLinkCandidate> Cards() => [.. Ports().Select(Card)];

    /// <summary>そのポートの内蔵の差し込み口。**開くまでは何も開かない**</summary>
    public static CardLinkCandidate Card(string port)
    {
        var name = $"{Model} {port} Internal Card Reader";
        return new CardLinkCandidate(name, () => new Zd1jCard(name, () => Zd1jBoard.Acquire(port)));
    }

    /// <summary>開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)</summary>
    internal static IUsbDevice OpenUsb(string port) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, DevUsb, port, Vendor, Product)
            : UsbDevices.Open(port, Vendor, Product);
}

/// <summary>
/// CECH-ZD1 J 1台ぶんの持ち主。**USB のハンドルは1台に1つだけ**で、チューナーとカードが取って使う。
///
/// <para>
/// **温めておく。** ブリッジの起動と DiB8096 の初期化は開くときの1回だけ (DiB8096 はチューナーが初めて使うとき)。
/// **エージェントが動いている間ずっと開いたまま** (PT3 などのデバイスを TunerPool が開きっぱなしにするのと同じ扱い。
/// 開き直すとブリッジの起動と DiB8096 の初期化で 1 秒ほどかかり、選局が冷えた状態からになる)。
/// 閉じるのは、定義が変わってチューナーが捨てられたとき (<see cref="CloseIfIdle"/>)・止めるとき (<see cref="CloseAll"/>)・USB が抜けたとき。
/// </para>
/// </summary>
public sealed class Zd1jBoard : IDibTime
{
    /// <summary>
    /// 起動の様子と、選局のたびのロックまでの内訳 (段ごとの時間と待ち) を渡す先。<c>--tune</c> (試験用のコマンド) だけが決め、
    /// 常駐のときは出さない
    /// </summary>
    public static Action<string>? Trace { get; set; }

    /// <summary>
    /// チャンネルごとに覚えたロックの値。**ボードを閉じても、エージェントを起こし直しても残す** (ファイル。ポートごと)。
    /// 起動するときに設定の置き場で決める (Program.cs・Probe.cs)。決めていなければ覚えるのはメモリの上だけ
    /// </summary>
    public static Zd1jLocks Locks { get; set; } = new(null);

    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, Zd1jBoard> Boards = [];

    private readonly Lock _gate = new();
    private Dib8096? _demod;
    private int _users;
    private bool _closed;
    public string Port { get; }
    public IUsbDevice Usb { get; }
    public Mb86h47 Bridge { get; }

    /// <summary>冷えた状態から開くのにかかった時間 (ブリッジの起動まで)</summary>
    public long OpenMs { get; private set; }

    /// <summary>DiB8096 の初期化にかかった時間 (まだなら -1)</summary>
    public long DemodMs { get; private set; } = -1;

    /// <summary>USB が抜けたなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted { get; private set; }

    internal Zd1jBoard(string port, IUsbDevice usb)
    {
        Port = port;
        Usb = usb;
        Bridge = new Mb86h47(usb, Trace);
    }

    /// <summary>
    /// 取る。開いていなければ、そのとき開いてブリッジを起動する。**返すのは <see cref="Release"/>**
    /// </summary>
    public static Zd1jBoard Acquire(string port) => Acquire(port, () => Zd1j.OpenUsb(port));

    internal static Zd1jBoard Acquire(string port, Func<IUsbDevice> open)
    {
        lock (Registry)
        {
            if (Boards.TryGetValue(port, out var board) && !board.Faulted)
            {
                lock (board._gate) board._users++;
                return board;
            }
            Boards.Remove(port);

            var started = Stopwatch.StartNew();
            var usb = open();
            board = new Zd1jBoard(port, usb);
            try
            {
                board.Bridge.Start();
            }
            catch
            {
                usb.Dispose();
                throw;
            }
            board.OpenMs = started.ElapsedMilliseconds;
            board._users = 1;
            Boards[port] = board;
            Log.Write($"[{Zd1j.Model} {port}] 開きました ({board.OpenMs}ms)");
            return board;
        }
    }

    /// <summary>返す。開いたままにする (USB が抜けていれば閉じる)</summary>
    public void Release()
    {
        lock (_gate)
        {
            if (--_users > 0) return;
        }
        if (Faulted) Close();
    }

    /// <summary>
    /// 誰も使っていなければ閉じる (チューナーが捨てられたとき。定義が変わった・止める)。カードが使っていれば開いたまま
    /// </summary>
    public static void CloseIfIdle(string port)
    {
        Zd1jBoard? board;
        lock (Registry)
        {
            if (!Boards.TryGetValue(port, out board)) return;
            lock (board._gate)
            {
                if (board._users > 0) return;
            }
            Boards.Remove(port);
        }
        board.Close();
    }

    /// <summary>失敗が USB の抜けなら印を付ける (次に取る側は開き直す)</summary>
    public void Fail(Exception error)
    {
        if (error is UsbGoneException) Faulted = true;
    }

    /// <summary>DiB8096。初めてのときに電源を入れて初期化する (仕様書 4.6・4.7・6)</summary>
    public Dib8096 Demod
    {
        get
        {
            lock (_gate)
            {
                if (_demod is not null) return _demod;
                var started = Stopwatch.StartNew();
                Bridge.ResetDemodulator(Sleep);
                var demod = new Dib8096(Bridge, this, Trace, Locks.For(Port));
                demod.Initialize();
                Bridge.Flush();
                DemodMs = started.ElapsedMilliseconds;
                Log.Write($"[{Zd1j.Model} {Port}] DiB8096 を初期化しました ({DemodMs}ms、DiB8000 0x{demod.Version:X4}、"
                    + $"DiB0090 0x{demod.TunerVersion:X2}{(demod.P1g ? " P1G" : "")})");
                return _demod = demod;
            }
        }
    }

    public double NowMs => Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency;

    /// <summary>
    /// 待つ。**溜めた I2C を流してから、待ちの間に流し始めの準備を回す** (<see cref="Mb86h47.Idle"/>)。
    /// メモリ要求が遅いホストでは、選局の待ちの間に準備が済む
    /// </summary>
    public void Sleep(int ms)
    {
        var until = Stopwatch.GetTimestamp() + ms * Stopwatch.Frequency / 1000;
        Bridge.Flush();
        Bridge.Idle(until);
        var left = (until - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
        if (left > 0) Thread.Sleep((int)left);
    }

    /// <summary>眠らせて (DiB8096 を初期化していれば。LED は緑に)、USB を閉じる</summary>
    private void Close()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            try
            {
                if (_demod is { } demod && !Faulted)
                {
                    demod.Sleep();
                    demod.Led(false);
                    // 書き込みは溜めてあるので、閉じる前に届ける
                    Bridge.Flush();
                }
            }
            catch (IOException error)
            {
                Log.Write($"[{Zd1j.Model} {Port}] 眠らせられませんでした ({error.Message})");
            }
            Usb.Dispose();
            Log.Write($"[{Zd1j.Model} {Port}] 閉じました");
        }
    }

    /// <summary>全部閉じる (エージェントを止めるとき。<c>--tune</c> の終わり)。使っている側がいても閉じる</summary>
    public static void CloseAll()
    {
        List<Zd1jBoard> boards;
        lock (Registry)
        {
            boards = [.. Boards.Values];
            Boards.Clear();
        }
        foreach (var board in boards) board.Close();
    }
}

/// <summary>1回の選局でかかった時間 (ms)。<c>--tune</c> が出す</summary>
/// <param name="OpenMs">ボードを取って DiB8096 を使えるようにするまで (冷えていればブリッジの起動と DiB8096 の初期化。温かければほぼ 0)</param>
/// <param name="LockMs">選局からロックまで</param>
/// <param name="FirstTsMs">ロックから最初の TS まで (まだ来ていなければ -1)</param>
public sealed record Zd1jTimings(long OpenMs, long LockMs, long FirstTsMs);

/// <summary>
/// CECH-ZD1 J のチューナー (地上波だけ)。**選局しなおしは周波数まわりだけ。** ボードは流している間だけ取る。
///
/// <para>
/// 前面の LED は流している間ずっと赤、止めたら緑 (点滅なし)。読む側がいないまま <see cref="StallLimit"/> 経ったら
/// 流すのをやめて LED を緑にし、ボードを返す (TunerPool はデバイスを開きっぱなしにするので、ここで見切る)。
/// </para>
/// </summary>
public sealed class Zd1jTuner : ITuneDevice
{
    /// <summary>
    /// 読む側がいないまま、溜めが空かずに待つ上限。TunerPool が誰も読まなくなってから選局を畳むまでの間
    /// (<see cref="TunerPool.Linger"/>) と同じ 5 秒にそろえる (それより早く見切ると、TunerPool が畳む前に TS が途切れる)
    /// </summary>
    internal static TimeSpan StallLimit { get; set; } = TunerPool.Linger;

    private readonly string _name;
    private readonly Func<Zd1jBoard> _acquire;
    private readonly Lock _gate = new();
    private Zd1jBoard? _board;
    private Zd1jStream? _stream;
    private bool _red;
    private long _lockedAt;
    private long _openMs;
    private long _lockMs;

    public Zd1jTuner(string port) : this($"{Zd1j.Model} {port}", () => Zd1jBoard.Acquire(port), () => Zd1jBoard.CloseIfIdle(port))
    {
    }

    internal Zd1jTuner(string name, Func<Zd1jBoard> acquire, Action? closeIdle = null)
    {
        _name = name;
        _acquire = acquire;
        _closeIdle = closeIdle;
    }

    /// <summary>捨てられたとき、ボードを誰も使っていなければ閉じる</summary>
    private readonly Action? _closeIdle;

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false };
        }
    }

    /// <summary>最後にロックした時刻 (Stopwatch)。<c>--tune</c> が最初の復号できたパケットまでを測る</summary>
    public long LockedAt => _lockedAt;

    /// <summary>いまのボード (<c>--tune</c> が数を出す)。流していなければ null</summary>
    public Zd1jBoard? Board => _board;

    /// <summary>最後の選局の時間</summary>
    public Zd1jTimings Timings
    {
        get
        {
            var first = _stream?.FirstAt ?? 0;
            return new Zd1jTimings(_openMs, _lockMs, first == 0 ? -1 : (long)Stopwatch.GetElapsedTime(_lockedAt, first).TotalMilliseconds);
        }
    }

    /// <summary>電波の強さと C/N (いまは API には出さない。<c>--tune</c> が出す)</summary>
    public DibSignal? Signal()
    {
        lock (_gate) return _board?.Demod.Signal();
    }

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        if (tuning.Satellite) throw new IOException($"{Zd1j.Model} は地上波だけです ({tuning.Type} は受けられません)");
        lock (_gate)
        {
            Stop(keepLed: true);
            var started = Stopwatch.StartNew();
            try
            {
                _board ??= _acquire();
                var demod = _board.Demod;
                _openMs = started.ElapsedMilliseconds;

                var tuneStarted = Stopwatch.GetTimestamp();
                _board.Bridge.PrepareStream();
                var result = demod.Tune(tuning.Frequency);
                _lockedAt = Stopwatch.GetTimestamp();
                _lockMs = (long)Stopwatch.GetElapsedTime(tuneStarted, _lockedAt).TotalMilliseconds;
                // 選局ごとに1行 (常駐のときも)。仕様書の外の工夫の数字を本番の記録で見直すため
                Log.Write($"[{_name}] {demod.LastSummary}");
                if (result == DibLock.Failed) throw new IOException(ITuneDevice.SyncFailed);

                if (!_red)
                {
                    demod.Led(true);
                    _red = true;
                }
                _stream = Zd1jStream.Start(_board, _name, () => Task.Run(() => Stall()));
            }
            catch (Exception error)
            {
                _board?.Fail(error);
                Stop(keepLed: false);
                if (error is UsbGoneException) throw new IOException($"{error.Message}。挿し直してください");
                throw;
            }
        }
    }

    /// <summary>読む側がいなくなった。流すのをやめてボードを返す (ボードは開いたままなので、次の選局も温かい)</summary>
    private void Stall()
    {
        lock (_gate)
        {
            if (_stream is not { Ended: true }) return;
            Stop(keepLed: false);
        }
    }

    /// <summary>流し終わり (仕様書 9.5) と、ボードを返す。<paramref name="keepLed"/> なら LED は赤のまま (選局しなおし)</summary>
    private void Stop(bool keepLed)
    {
        var stream = _stream;
        _stream = null;
        var board = _board;
        if (board is null) return;
        try
        {
            if (stream is not null)
            {
                stream.Stop();
                board.Bridge.StopStream();
                // 選局しなおしなら、選局が自分でハイインピーダンスにする
                if (!keepLed) board.Demod.Output(false);
            }
            if (!keepLed && _red)
            {
                board.Demod.Led(false);
                _red = false;
            }
        }
        catch (IOException error)
        {
            board.Fail(error);
            Log.Write($"[{_name}] 流し終われませんでした ({error.Message})");
        }
        if (keepLed) return;
        _board = null;
        board.Release();
    }

    /// <summary>捨てる (定義が変わった・止める)。ボードはカードが使っていなければ閉じる</summary>
    public void Dispose()
    {
        lock (_gate) Stop(keepLed: false);
        _closeIdle?.Invoke();
    }
}

/// <summary>
/// TS を1回流すぶん。EP 0x81 の読みを 16 本出しっぱなしにして、192 バイトの単位をほどき、
/// <see cref="Pipe"/> (8MB) に詰める。読み出し側は <see cref="DeviceStream"/> (px4d から受けるときと同じ形)
/// </summary>
internal sealed class Zd1jStream
{
    private const byte Endpoint = 0x81;

    /// <summary>
    /// 1本の読みの大きさ。仕様書 9.4 の「1536 バイト (192 と 512 の公倍数) の倍数」で、64KB に収まるいちばん大きいもの (64,512 バイト)
    /// </summary>
    private const int TransferSize = 42 * 1536;

    /// <summary>
    /// 出しっぱなしにする読みの数。仕様書 9.3 の例 (64KB を 16 本)。地上波 (約 17Mbps) で約 0.5 秒ぶんで、読む側が少し遅れても抜けない
    /// </summary>
    private const int Depth = 16;

    /// <summary>1回の読みの待ち。出力はばらばらに来るので短すぎないように (仕様書 9.4 の 300ms。読みは裏で出したまま)</summary>
    private const int ReadTimeoutMs = 300;

    private readonly Pipe _pipe = Px4Stream.NewBuffer();

    private readonly IUsbInStream _in;
    private readonly string _name;
    private readonly Action _stalled;
    private readonly Thread _pump;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    public DeviceStream Output { get; }

    /// <summary>流し終わった (抜けた・読む側がいない・止めた)</summary>
    public bool Ended => _ended;

    /// <summary>最初の TS を詰めた時刻 (Stopwatch)。まだなら 0</summary>
    public long FirstAt { get; private set; }

    private Zd1jStream(IUsbInStream input, string name, Action stalled)
    {
        _in = input;
        _name = name;
        _stalled = stalled;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        _pump = new Thread(Pump) { IsBackground = true, Name = $"{name} TS" };
    }

    /// <summary>流し始め (仕様書 9.3)。復調器はもうパラレルで出力している</summary>
    public static Zd1jStream Start(Zd1jBoard board, string name, Action stalled)
    {
        board.Bridge.StartStream();
        var stream = new Zd1jStream(board.Usb.OpenInStream(Endpoint, TransferSize, Depth), name, stalled);
        stream._pump.Start();
        return stream;
    }

    private void Pump()
    {
        var raw = new byte[TransferSize * 4];
        var framer = new Mb86h47Framer();
        var writer = _pipe.Writer;
        try
        {
            while (!_stopped)
            {
                var got = _in.Read(raw, ReadTimeoutMs);
                if (got == 0 || framer.Feed(raw.AsSpan(0, got), writer) == 0) continue;
                if (FirstAt == 0) FirstAt = Stopwatch.GetTimestamp();
                if (!Flush(writer)) return;
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            End(error is UsbGoneException ? $"{error.Message}。挿し直してください" : $"TS を読めません ({error.Message})");
        }
        finally
        {
            _ended = true;
            writer.Complete();
        }
    }

    /// <summary>書いたぶんを渡す。溜めが空かないまま <see cref="Zd1jTuner.StallLimit"/> 経ったら、読む側がいないとみて終わる</summary>
    private bool Flush(PipeWriter writer)
    {
        var flushing = writer.FlushAsync();
        if (!flushing.IsCompleted)
        {
            var waiting = flushing.AsTask();
            var stalled = Stopwatch.StartNew();
            while (!waiting.Wait(50))
            {
                if (_stopped)
                {
                    writer.CancelPendingFlush();
                    return false;
                }
                if (stalled.Elapsed >= Zd1jTuner.StallLimit)
                {
                    writer.CancelPendingFlush();
                    End(null);
                    _ended = true;
                    _stalled();
                    return false;
                }
            }
            return !waiting.Result.IsCompleted;
        }
        return !flushing.Result.IsCompleted;
    }

    private void End(string? reason)
    {
        if (_stopped || reason is null) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>止める。読みを取り消し、読みかけの読む側が戻ってから溜めを閉じる</summary>
    public void Stop()
    {
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        _pump.Join(TimeSpan.FromSeconds(2));
        _in.Dispose();
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}

/// <summary>
/// CECH-ZD1 J の内蔵の差し込み口。ブリッジの UART を叩き、**T=1 の枠組みはこちらで組む** (<see cref="T1Protocol"/>)。
/// リセットと IFSD の取り決めは1回だけで、あとはつないだまま。並ぶ順は USB のリーダー → px4d → asicend → これ (CardLinks)
/// </summary>
public sealed class Zd1jCard : ICardLink
{
    /// <summary>ATR を待つ上限 (仕様書 13.7 の「1 秒まで」)</summary>
    private static readonly TimeSpan AtrTimeout = TimeSpan.FromSeconds(1);

    /// <summary>ATR を受けるときの速さのクロック数 (9600 ボー)。カードのクロックは 9600 × 372 Hz</summary>
    private const double CardClock = 9600.0 * 372;

    private readonly Func<Zd1jBoard> _acquire;
    private Zd1jBoard? _board;
    private T1Protocol? _t1;
    /// <summary>1 ブロックの待ち (仕様書 13.7 の「500ms から。ATR の BWI で変わる」)</summary>
    private int _blockWaitMs = 500;

    public string Name { get; }

    public Zd1jCard(string name, Func<Zd1jBoard> acquire)
    {
        Name = name;
        _acquire = acquire;
    }

    private Mb86h47 Bridge => (_board ??= _acquire()).Bridge;

    public byte[] Reset()
    {
        _t1 = null;
        try
        {
            if (!Bridge.CardPresent()) throw new CardAbsentException($"{Name} にカードが挿さっていません");
            byte[]? raw = null;
            Atr? atr = null;
            // 前の会話の残りが混ざって崩れたら、もう一度だけリセットから
            for (var attempt = 0; attempt < 2 && atr is null; attempt++)
            {
                Bridge.CardReset();
                raw = ReadAtr();
                try
                {
                    atr = Atr.Parse(raw);
                }
                catch (IOException) when (attempt == 0)
                {
                }
            }
            if (!atr!.T1) throw new IOException($"T=1 に対応していないカードです (ATR {Convert.ToHexString(raw!)})");

            var (baud, control, cwt, bwt, rate) = Speed(atr);
            Bridge.CardSpeed(baud, control, cwt, bwt);
            _blockWaitMs = Math.Min(3000, 500 << Math.Max(0, atr.Bwi - 4));
            _t1 = new T1Protocol(atr, Exchange);
            _t1.NegotiateIfsd(rate >= 38400 ? 254 : 251);
            return raw!;
        }
        catch (Exception error)
        {
            _board?.Fail(error);
            throw;
        }
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_t1 is null) throw new IOException($"{Name} のカードに繋いでいません (Reset を先に)");
        try
        {
            // 抜き差しの知らせは無いので、APDU の前ごとに見る (仕様書 13.3)
            if (!Bridge.CardPresent())
            {
                _t1 = null;
                throw new CardAbsentException($"{Name} のカードが抜かれました");
            }
            return _t1.Transmit(apdu);
        }
        catch (Exception error)
        {
            _board?.Fail(error);
            throw;
        }
    }

    private static readonly int[] FiTable = [372, 372, 558, 744, 1116, 1488, 1860, 0, 0, 512, 768, 1024, 1536, 2048, 0, 0];
    private static readonly int[] DiTable = [0, 1, 2, 4, 8, 16, 32, 64, 12, 20, 0, 0, 0, 0, 0, 0];

    /// <summary>
    /// TA1 から UART の4つのレジスタ (仕様書 13.2)。B-CAS は TA1 = 0x12 (F 372 / D 2) で 19200 ボー。
    /// <c>N = F / D</c>、速さ = <c>(N &lt;&lt; 7) | min(N &gt;&gt; 1, 0x7F)</c>、CWT = <c>3 × 2^CWI + 11</c>、
    /// BWT = <c>6,800,000 × D / F</c> (16 ビットまで)、制御 = <c>TC1 &lt;&lt; 16</c> (TC1 が 0xFF なら 1)
    /// </summary>
    internal static (uint Baud, uint Control, uint Cwt, uint Bwt, int Rate) Speed(Atr atr)
    {
        var f = FiTable[atr.FiDi >> 4];
        var d = DiTable[atr.FiDi & 0xF];
        if (f == 0 || d == 0 || f % d != 0) throw new IOException($"ATR の速さ (TA1 0x{atr.FiDi:X2}) に対応していません");
        var n = (uint)(f / d);
        var baud = (n << 7) | Math.Min(n >> 1, 0x7F);
        var cwt = (uint)(3 * (1 << atr.Cwi) + 11);
        var bwt = (uint)Math.Min(0xFFFF, 6_800_000L * d / f);
        var control = (uint)(atr.GuardN == 0xFF ? 1 : atr.GuardN) << 16;
        return (baud, control, cwt, bwt, (int)(CardClock / n));
    }

    /// <summary>ATR を 1 秒まで受ける。長さは T0 と TDi から決まる</summary>
    private byte[] ReadAtr()
    {
        var received = new List<byte>();
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < AtrTimeout)
        {
            var got = Bridge.CardRead(33 - received.Count);
            received.AddRange(got);
            if (AtrLength(received) is { } length && received.Count >= length) return [.. received.Take(length)];
            if (got.Length == 0) Thread.Sleep(2);
        }
        if (received.Count == 0) throw new IOException($"{Name} のカードが ATR を返しません");
        return [.. received];
    }

    /// <summary>ATR の長さ。まだ決まらなければ null</summary>
    internal static int? AtrLength(IReadOnlyList<byte> atr)
    {
        if (atr.Count < 2) return null;
        var y = atr[1] >> 4;
        var historical = atr[1] & 0x0F;
        var at = 2;
        var tck = false;
        for (; ; )
        {
            var td = (y & 8) != 0;
            at += int.PopCount(y & 7) + (td ? 1 : 0);
            if (!td) break;
            if (at > atr.Count) return null;
            var d = atr[at - 1];
            if ((d & 0x0F) != 0) tck = true;
            y = d >> 4;
        }
        return at + historical + (tck ? 1 : 0);
    }

    /// <summary>
    /// T=1 のブロックを1つ送って1つ受ける。受けは「受けた数が 0 でなくなる」だけを合図に頭 3 バイトを読み、
    /// 長さぶんと LRC を読む。時間切れは null (T1Protocol が送り直す)
    /// </summary>
    private byte[]? Exchange(byte[] block, byte wtx)
    {
        Bridge.CardWrite(block);
        var limit = TimeSpan.FromMilliseconds(_blockWaitMs * Math.Max(1, (int)wtx));
        var received = new List<byte>();
        var since = Stopwatch.StartNew();
        while (since.Elapsed < limit)
        {
            var want = received.Count < 3 ? 3 - received.Count : received[2] + 4 - received.Count;
            if (want <= 0) return [.. received];
            var got = Bridge.CardRead(want);
            received.AddRange(got);
            if (got.Length == 0) Thread.Sleep(1);
        }
        return null;
    }

    public void Dispose()
    {
        _t1 = null;
        var board = _board;
        _board = null;
        board?.Release();
    }
}

/// <summary>
/// CECH-ZD1 J がチャンネルごとに覚えたロックの値のファイル (<c>zd1j-locks.json</c>。tuners.json の隣)。
/// 中身は選局で段 3 に渡した値だけで、**消してよい** (次の選局で探索からやり直して、また覚える)。
///
/// <para>
/// 形は <c>{ "version": 1, "boards": { "&lt;USB のポート&gt;": { "&lt;kHz&gt;": { … } } } }</c> (<see cref="DibMemory.ToJson"/>)。
/// 読めない・壊れている・バージョンが違うときは、警告を1行残して全部捨てる。書くのは値が変わったときだけ
/// (ロックして新しい値になった・合わなかった値を捨てた)。
/// </para>
/// </summary>
public sealed class Zd1jLocks
{
    private const int Version = 1;

    private readonly string? _path;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, DibMemory> _boards = [];

    /// <param name="path">ファイル。null なら書かない (メモリの上だけ)</param>
    public Zd1jLocks(string? path)
    {
        _path = path;
        if (path is null || !File.Exists(path)) return;
        try
        {
            var root = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path)) as System.Text.Json.Nodes.JsonObject
                ?? throw new FormatException("オブジェクトではありません");
            var version = root["version"]?.GetValue<int>();
            if (version != Version) throw new FormatException($"バージョンが {version?.ToString(CultureInfo.InvariantCulture) ?? "無し"} です ({Version} を読みます)");
            if (root["boards"] is not System.Text.Json.Nodes.JsonObject boards) throw new FormatException("boards がありません");
            var loaded = new Dictionary<string, DibMemory>();
            foreach (var (port, node) in boards)
            {
                if (!UsbSysfs.IsPort(port) || node is not System.Text.Json.Nodes.JsonObject channels) throw new FormatException($"ポート「{port}」が読めません");
                loaded[port] = DibMemory.FromJson(channels);
            }
            foreach (var (port, memory) in loaded) Watch(port, memory);
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or FormatException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            Log.Write($"{path} を読めないので捨てて、探索からやり直します: {error.Message}");
            _boards.Clear();
        }
    }

    /// <summary>そのポートの覚えた値。無ければ空のものを作る</summary>
    public DibMemory For(string port)
    {
        lock (_gate)
        {
            if (_boards.TryGetValue(port, out var memory)) return memory;
            return Watch(port, new DibMemory());
        }
    }

    private DibMemory Watch(string port, DibMemory memory)
    {
        _boards[port] = memory;
        memory.Changed += Save;
        return memory;
    }

    /// <summary>全部書く (置き換えは tuners.json と同じく、書きかけを読ませない形で)</summary>
    private void Save()
    {
        if (_path is null) return;
        lock (_gate)
        {
            var boards = new System.Text.Json.Nodes.JsonObject();
            foreach (var (port, memory) in _boards.OrderBy(pair => pair.Key, StringComparer.Ordinal)) boards[port] = memory.ToJson();
            try
            {
                Config.WriteAtomic(_path, new System.Text.Json.Nodes.JsonObject { ["version"] = Version, ["boards"] = boards });
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // 書けなくても選局は続ける。次に変わったときにまた書く
                Log.Write($"{_path} に書けません: {error.Message}");
            }
        }
    }
}
