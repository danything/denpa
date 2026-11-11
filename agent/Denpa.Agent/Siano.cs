using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipelines;

namespace Denpa.Agent;

/*
 * Siano RIO 系の ISDB-T 用 USB チューナー (PLEX PX-S1UD など。地上波だけ) を、エージェントが USB を直に持って使う入口。
 *
 * クリーンルームで、仕様書 (denpa-spec の siano/spec.md) だけから書いた。Linux カーネルの Siano のドライバと siano-userland のコードは読んでいない。
 * 機材を動かす手順は SianoDevice.cs。ここは、対象の機材の表 (仕様書 1.1)、自動検出、チューナー (ITuneDevice)、TS を読む側へ渡すバッファ。
 * **実機では確かめていない** (docs/tuner-px-s1ud.md)。
 *
 * **カーネルが使っている機材には触らない。** PX-S1UD は mainline の smsusb + smsdvb で Linux DVB になり、そちらで使える (DvbTuner)。
 * 自動検出ではどのドライバにも繋がっていない機材だけを並べる (blacklist の手順は docs/tuner-px-s1ud.md)。
 * 設定の device は siano:<USB のポート> (siano:1-2.3。S1UD にはシリアルが無い)。以前は同じ形式の設定で siano-userland (siano-ts) を起動していた。
 * 挿さっていれば Detect が見つけて組み立てるので、普通は書かなくてよい。
 */

/// <summary>対象の機材 1 機種 (仕様書 1.1)</summary>
public sealed record SianoModel(int Vendor, int Product, string Name);

/// <summary>エージェントが直に持つ Siano の機材の表・自動検出・開き方</summary>
public static class Siano
{
    /// <summary>設定の <c>device</c> の接頭辞。これで始まっていれば Siano の機材として開く</summary>
    public const string Scheme = "siano:";

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>siano:1-2.3</c> からポートを取る。形式が違えば null</summary>
    public static string? Parse(string device) => UsbSysfs.PortOf(device, Scheme);

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string port) => $"{model} {port}";

    /// <summary>そのポートの機材のチューナー</summary>
    public static ITuneDevice Open(string port) => new SianoTuner(port);

    /// <summary>
    /// 対象の機材 (仕様書 1.1)。資料で受信が確かめられているのは PX-S1UD だけで、<c>187f:0600</c> は同じ手順で扱うが記録が無い。
    /// <c>187f:0302</c> は資料で扱いが食い違うので対象にしない。VID が同じでも、この表に無い PID の機材は開かない
    /// </summary>
    public static readonly IReadOnlyList<SianoModel> Models =
    [
        new(0x3275, 0x0080, "PLEX PX-S1UD"),
        new(0x187F, 0x0600, "Siano RIO"),
    ];

    /// <summary>機材をまとめて呼ぶ名前 (見つからないときの文言)</summary>
    public const string Family = "Siano の機材 (PX-S1UD など)";

    public static SianoModel? Find(int vendor, int product) =>
        Models.FirstOrDefault(model => model.Vendor == vendor && model.Product == product);

    /// <summary>
    /// 挿さっているポートと機種。**開かない。** Linux はカーネルのドライバ (smsusb) が使っているものを並べない
    /// (動いているドライバから機材を取ると、カーネルの側で異常が出た記録がある。仕様書 1.4)
    /// </summary>
    public static List<(string Port, SianoModel Model)> Found(Action<string>? warn = null)
    {
        try
        {
            return OperatingSystem.IsLinux()
                ? Found(UsbSysfs.Devices, warn)
                : [.. Models.SelectMany(model => UsbDevices.List(model.Vendor, model.Product).Select(found => (found.Port, model)))];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            warn?.Invoke($"{Family} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<(string Port, SianoModel Model)> Found(string sysfs, Action<string>? warn) =>
        UsbDevices.Scan(sysfs, dir => Identify(sysfs, Path.GetFileName(dir)), model => model.Name, warn);

    internal static SianoModel? Identify(string sysfs, string port)
    {
        var dir = Path.Combine(sysfs, port);
        return Hex(UsbSysfs.Read(dir, "idVendor")) is { } vendor && Hex(UsbSysfs.Read(dir, "idProduct")) is { } product ? Find(vendor, product) : null;
    }

    /// <summary>そのポートの機種 (Linux は sysfs、Windows・macOS は OS に問い合わせる)。**開かない**</summary>
    public static SianoModel? Identify(string port) =>
        OperatingSystem.IsLinux() ? Identify(UsbSysfs.Devices, port) : Found().FirstOrDefault(item => item.Port == port).Model;

    private static int? Hex(string? text) =>
        int.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value) ? value : null;

    /// <summary>設定に書いたのと同じ形式で (<c>siano:&lt;USB のポート&gt;</c>)。種別は地上波だけ</summary>
    public static List<TunerSpec> Detect() => Specs(Found(Log.Write));

    internal static List<TunerSpec> Specs(IEnumerable<(string Port, SianoModel Model)> found) =>
        [.. found.Select(item => new TunerSpec(Name(item.Model.Name, item.Port), ["GR"], false, Device(item.Port)))];

    /// <summary>
    /// 開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)。インターフェース 0 を確保する。代替設定は選び直さない (仕様書 2.1・12.3)。
    /// ほかのソフトやカーネルのドライバが使っていれば、OS の理由のまま失敗する (横から取らない)
    /// </summary>
    internal static IUsbDevice OpenUsb(string port, SianoModel model) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, UsbSysfs.DevUsb, port, model.Vendor, model.Product, selectAlternate: false)
            : UsbDevices.Open(port, model.Vendor, model.Product, selectAlternate: false);

    /// <summary>未確認の値を記録に出したポート。エージェントが動いている間、ポートごとに 1 回だけ出す</summary>
    private static readonly HashSet<string> Described = [];

    /// <summary>そのポートの機材を開いて起動する (ファームウェアが入っていなければ送る)</summary>
    internal static SianoDevice OpenDevice(string port)
    {
        var model = Identify(port) ?? throw new IOException($"USB のポート {port} に {Family} が見当たりません (抜けたか、挿し替えた?)");
        bool describe;
        lock (Described) describe = Described.Add(port);
        var usb = OpenUsb(port, model);
        var device = new SianoDevice(usb, Name(model.Name, port), SianoFirmware.Default, describe: describe);
        try
        {
            device.Start();
            return device;
        }
        catch
        {
            device.Dispose();
            throw;
        }
    }
}

/// <summary>
/// エージェントが直に持つ Siano の機材のチューナー (地上波だけ)。**機材は最初の選局で開き、捨てられるまで開いたままにする。**
///
/// <para>
/// 選局し直すときは、開いたまま選局のメッセージを送り直すだけで、止める手順は挟まない (仕様書 5.4)。
/// 選局し直しを始めたら TS を渡すのをやめ、ロックを確かめてから新しいバッファへ渡す (前のチャンネルの TS を混ぜない。仕様書 6.3)。
/// ロックしなかったときは機材を開いたままにする。機材が応答しなかった・送れなかった・抜かれたときは閉じて、次の選局で開き直す
/// (バージョンの問い合わせからやり直せば、ファームウェアが残っていても消えていても動く。仕様書 8)。
/// </para>
/// </summary>
public sealed class SianoTuner : ITuneDevice
{
    private readonly string _name;
    private readonly Func<SianoDevice> _open;
    private readonly Lock _gate = new();
    private SianoDevice? _device;
    private SianoStream? _stream;

    public SianoTuner(string port)
        : this($"siano {port}", () => Siano.OpenDevice(port))
    {
    }

    /// <summary>開き方を差し替える (テスト。偽の USB の上の機材を返す)</summary>
    internal SianoTuner(string name, Func<SianoDevice> open)
    {
        _name = name;
        _open = open;
    }

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false } && _device is { Faulted: false };
        }
    }

    public void Tune(ChannelTable.Tuning tuning)
    {
        if (tuning.Delivery != ChannelTable.SysIsdbt) throw new IOException($"Siano の機材は地上波だけです ({tuning.Type} は受けられません)");
        lock (_gate)
        {
            StopStream();
            if (_device is { Faulted: true }) Close();
            bool locked;
            try
            {
                _device ??= _open();
                locked = _device.Tune(tuning.Frequency);
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException or NotSupportedException or PlatformNotSupportedException)
            {
                // 機材の状態が分からないので閉じる。次の選局で開き直す
                Close();
                if (error is UsbGoneException) throw new IOException($"{error.Message}。挿し直してください");
                if (error is IOException) throw;
                throw new IOException(UsbDevices.Reason(error), error);
            }
            if (!locked) throw new IOException(ITuneDevice.SyncFailed);
            var stream = new SianoStream(_name, () => Task.Run(Stall));
            _device.Attach(stream.Push, stream.Fail);
            _stream = stream;
        }
    }

    /// <summary>
    /// 受信の状態と C/N と強度。統計の要求を 1 回送って応答を読む (仕様書 7)。C/N は応答の SNR (dB)、強度は帯域の中の受信電力 (dBm)。
    /// どちらの欄も、仕様書では 1 つの資料だけによる位置で、実機で確かめていない
    /// </summary>
    public TunerSignal? Signal()
    {
        lock (_gate)
        {
            if (_stream is not { Ended: false } || _device is not { Faulted: false } device) return null;
            try
            {
                return device.ReadStats() is { } stats ? new TunerSignal(stats.Locked, stats.SnrDb, TunerSignal.Db, StrengthDbm: stats.PowerDbm) : null;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                // 送れなかった・抜かれた。TS の側が同じ理由で終わるので、ここでは測れなかったことだけを返す
                return null;
            }
        }
    }

    /// <summary>読む側がいなくなった。TS を渡すのをやめる (機材は開いたまま。機材には何も送らない。仕様書 6.4)</summary>
    private void Stall()
    {
        lock (_gate)
        {
            if (_stream is { Ended: true }) StopStream();
        }
    }

    private void StopStream()
    {
        var stream = _stream;
        _stream = null;
        _device?.Detach();
        stream?.Stop();
    }

    private void Close()
    {
        var device = _device;
        _device = null;
        device?.Dispose();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            StopStream();
            Close();
        }
    }
}

/// <summary>
/// TS を 1 回流すぶん。機材の読みのスレッドから受けた TS のメッセージの中身を上限つきのキューに入れ、別のスレッドで 188 バイトに揃えて
/// <see cref="Pipe"/> に詰める。読み出し側は <see cref="DeviceStream"/> (CECH-ZD1 J と同じ形)。
///
/// <para>
/// **機材の読みのスレッドは待たせない。** 制御の応答も同じ端点に届くので、読む側が詰まっても読みは止めず、
/// キューに入りきらない TS を捨てて数える (仕様書 6.3。キューの深さも仕様書の 16,384 バイト × 256 個)
/// </para>
/// </summary>
internal sealed class SianoStream
{
    /// <summary>キューに溜めるメッセージの数の上限 (仕様書 6.3)</summary>
    internal const int QueueDepth = 256;

    private readonly Pipe _pipe = TsBuffer.New();
    private readonly BlockingCollection<(byte[] Buffer, int Length)> _queue = new(new ConcurrentQueue<(byte[], int)>(), QueueDepth);
    private readonly SianoTsAligner _aligner = new();
    private readonly string _name;
    private readonly Action _stalled;
    private readonly Thread _writer;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;
    private long _dropped;
    private long _droppedLogged;

    public DeviceStream Output { get; }

    /// <summary>流し終わった (抜けた・読む側がいない・止めた)</summary>
    public bool Ended => _ended;

    /// <summary>キューに入りきらずに捨てた TS のバイト数</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    /// <param name="stalled">読む側がいないまま <see cref="Zd1jTuner.StallLimit"/> 経ったときに呼ぶ</param>
    public SianoStream(string name, Action stalled)
    {
        _name = name;
        _stalled = stalled;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        _writer = new Thread(Write) { IsBackground = true, Name = $"{name} TS" };
        _writer.Start();
    }

    /// <summary>TS のメッセージの中身を受ける (機材の読みのスレッドから)。待たない</summary>
    public void Push(ReadOnlySpan<byte> ts)
    {
        if (_ended || ts.Length == 0) return;
        var buffer = ArrayPool<byte>.Shared.Rent(ts.Length);
        ts.CopyTo(buffer);
        if (_queue.TryAdd((buffer, ts.Length))) return;
        ArrayPool<byte>.Shared.Return(buffer);
        Interlocked.Add(ref _dropped, ts.Length);
    }

    /// <summary>機材の読みが失敗した (抜かれたなど)。理由を読む側に渡して終える</summary>
    public void Fail(string reason)
    {
        if (_stopped) return;
        _reason = reason;
        _ended = true;
    }

    private void Write()
    {
        var writer = _pipe.Writer;
        Action<ReadOnlySpan<byte>> sink = packets => writer.Write(packets);
        try
        {
            while (!_stopped && !_ended)
            {
                if (!_queue.TryTake(out var chunk, 200)) continue;
                var before = _aligner.Packets;
                _aligner.Push(chunk.Buffer.AsSpan(0, chunk.Length), sink);
                ArrayPool<byte>.Shared.Return(chunk.Buffer);
                ReportDropped();
                if (_aligner.Packets == before) continue;
                if (!Zd1jTuner.Flush(writer, () => _stopped || _ended, () =>
                    {
                        _ended = true;
                        _stalled();
                    }))
                {
                    return;
                }
            }
        }
        finally
        {
            _ended = true;
            writer.Complete();
        }
    }

    /// <summary>捨てた TS が増えていれば、1 MB ごとに記録に出す</summary>
    private void ReportDropped()
    {
        var dropped = Dropped;
        if (dropped - _droppedLogged < 1024 * 1024) return;
        _droppedLogged = dropped;
        Log.Write($"[{_name}] 読む側が追いつかず、TS を捨てています (これまでに {dropped} バイト)");
    }

    /// <summary>止める。書くスレッドが戻り、読んでいる途中の呼び出しが戻ってからバッファを閉じる</summary>
    public void Stop()
    {
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        _writer.Join(TimeSpan.FromSeconds(2));
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
        while (_queue.TryTake(out var chunk)) ArrayPool<byte>.Shared.Return(chunk.Buffer);
    }
}
