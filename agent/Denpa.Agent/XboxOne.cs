using System.Security.Cryptography;

namespace Denpa.Agent;

/*
 * Microsoft Xbox One Digital TV Tuner (USB 045e:02d5) で ISDB-C (日本のケーブルテレビ。J.83 Annex C) を受ける。エージェントが USB を直に持つ。
 * DVB-T/T2 は扱わない。
 *
 * 中身は DiB0700 の USB ブリッジ (Dib0700.cs)・MN88472 の復調 (Mn88472.cs)・TDA18250 のチューナー (Tda18250.cs)。
 * クリーンルームで、仕様書 (GPL のドライバから事実だけを抜き出した仕様書) だけから書いた。Linux のドライバのコードは読んでいない。
 * TS の受け取りは DVB の機材の ISDB-C と同じ部品 (DvbCable・TsmfSelector・SplitTlv) を使う。作りと確かめていないことは docs/tuner-xbox-one.md。
 *
 * 設定の device は xbox:<USB のポート> (xbox:1-2。シリアルは使わない)。挿さっていれば Detect が見つける。Linux では、
 * カーネルの dvb_usb_dib0700 が使っている機材は並べない (UsbHost.Scan)。
 */

/// <summary>Xbox One Digital TV Tuner の見つけ方・ファームウェア・開き方</summary>
public static class XboxOne
{
    public const string Scheme = "xbox:";
    public const int Vendor = 0x045E;
    public const int Product = 0x02D5;
    public const string Model = "Microsoft Xbox One Digital TV Tuner";

    /// <summary>ブリッジのファームウェア。エージェントに埋め込む (linux-firmware のファイルをそのまま。firmware/README.md)</summary>
    public const string BridgeFirmwareName = "dvb-usb-dib0700-1.20.fw";

    /// <summary>埋め込んだブリッジのファームウェアの SHA-256 (33,768 バイト)。違えば使わない</summary>
    internal const string BridgeFirmwareSha256 = "74f5ffeb43767e1af6d379d6cc2e0efeaa54455d030bcd71d95f0f2a908c672a";

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>xbox:1-2</c> からポートを取る。形式が違えば null</summary>
    public static string? Parse(string device) => UsbSysfs.PortOf(device, Scheme);

    internal static List<string> Ports(IUsbHost host, Action<string>? warn) =>
        [.. UsbHost.Scan(host, [Model], _ => new UsbId(Vendor, Product), model => model, warn).Select(found => found.Found.Port)];

    /// <summary>
    /// 挿さっている機材を、設定に書くのと同じ形式で返す。**開かない。** 受けられるのはケーブルだけなので、
    /// DVB-C だけの DVB の機材と同じく <c>CATV</c> を選んで「使う」をオフにして並べる (<see cref="DeviceProbe.Frontend"/>)
    /// </summary>
    public static List<TunerSpec> Detect()
    {
        try
        {
            return [.. Ports(UsbHost.Current, Log.Write).Select(port => new TunerSpec($"{Model} {port}", [ChannelTable.Catv], true, Device(port)))];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Write($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>埋め込んだブリッジのファームウェア (Denpa.Agent.csproj の LogicalName)。SHA-256 を確かめる</summary>
    internal static byte[] BridgeFirmware()
    {
        using var stream = typeof(XboxOne).Assembly.GetManifestResourceStream(BridgeFirmwareName)
            ?? throw new IOException($"同梱の {BridgeFirmwareName} が実行ファイルに入っていません");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        var code = buffer.ToArray();
        var sha = Convert.ToHexStringLower(SHA256.HashData(code));
        if (sha != BridgeFirmwareSha256) throw new IOException($"同梱の {BridgeFirmwareName} の SHA-256 が違います ({sha})");
        return code;
    }

    /// <summary>
    /// 復調のファームウェアを探す場所。tuners.json の隣の <c>firmware/</c> と、Linux なら <c>/lib/firmware</c>。
    /// 復調のファームウェアは再配布の条件が分からないので同梱せず、利用者が置いたものを読む
    /// </summary>
    internal static IReadOnlyList<string> FirmwareDirs() =>
    [
        Path.Combine(Config.FromEnvironment().Dir, "firmware"),
        .. OperatingSystem.IsLinux() && !UsbHost.Brokered ? ["/lib/firmware"] : Array.Empty<string>(),
    ];

    /// <summary>
    /// 復調のファームウェア (<see cref="Mn88472.FirmwareName"/>) を <paramref name="dirs"/> の順に探して読む。
    /// 無いか、仕様書のファイルと違えば、どこに何を置けばよいかを理由にして例外を送出する (この機材だけが使えない)
    /// </summary>
    internal static byte[] DemodFirmware(IReadOnlyList<string> dirs)
    {
        foreach (var dir in dirs)
        {
            var path = Path.Combine(dir, Mn88472.FirmwareName);
            if (!File.Exists(path)) continue;
            var code = File.ReadAllBytes(path);
            if (Mn88472.CheckFirmware(code) is { } wrong) throw new IOException($"{path} は使えません ({wrong})");
            return code;
        }
        throw new IOException(
            $"復調のファームウェア {Mn88472.FirmwareName} がありません。{string.Join(" か ", dirs)} に置いてください (同梱していません。docs/tuner-xbox-one.md)");
    }

    /// <summary>そのポートの機材を開いて、ブリッジのファームウェアを動かし、チップを初期化する</summary>
    internal static XboxOneDevice OpenDevice(string port, string name)
    {
        if (UsbHost.Identify(UsbHost.Current, [Model], _ => new UsbId(Vendor, Product), port) is null)
        {
            throw new IOException($"USB のポート {port} に {Model} が見当たりません (抜けたか、挿し替えた?)");
        }
        // 代替設定は選び直さない (元のドライバはインタフェース 0・代替設定 0 のまま使うと仕様書は推定している)
        var device = new XboxOneDevice(UsbHost.Current.Open(port, Vendor, Product, selectAlternate: false), name);
        try
        {
            device.Start(BridgeFirmware, () => DemodFirmware(FirmwareDirs()));
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
/// 開いた機材 1 台。ブリッジのファームウェア・電源・チップの確認と初期化 (<see cref="Start"/>)、選局 (<see cref="Tune"/>)、TS の出力、
/// 信号の読み取り、スリープ (<see cref="Dispose"/>)。**同時には 1 つのスレッドからだけ呼ぶ** (<see cref="XboxOneTuner"/> が順番にする)
/// </summary>
internal sealed class XboxOneDevice : IDisposable
{
    /// <summary>1 回の bulk 転送に入れる TS パケットの数</summary>
    public const int TsPackets = 21;

    /// <summary>
    /// 出したままにする TS の転送要求の数。元のドライバは 4 本。ユーザー空間から出すと次の要求を出すまでの間が長くなるので多めにした (仕様書に無い。実機で確かめていない)
    /// </summary>
    public const int Depth = 16;

    /// <summary>選局してからロックを待つ上限と、読む間隔。元の報告では約 0.6〜0.7 秒でロックしている (上限と間隔は仕様書に無い)</summary>
    internal const int LockMs = 2_000;
    internal const int LockPollMs = 100;

    private readonly IUsbDevice _usb;
    private readonly string _name;
    private readonly Action<int> _sleep;
    private readonly Action<string> _log;
    private IUsbInStream? _in;
    private int _transferSize;

    public Dib0700 Bridge { get; }
    public Mn88472 Demod { get; }
    public Tda18250 Tuner { get; }

    /// <summary>動いているブリッジのファームウェアのバージョン (<see cref="Start"/> のあと)</summary>
    public Dib0700Version Version { get; private set; }

    public XboxOneDevice(IUsbDevice usb, string name, Action<int>? sleep = null, Action<string>? log = null)
    {
        _usb = usb;
        _name = name;
        _sleep = sleep ?? Thread.Sleep;
        _log = log ?? Log.Write;
        Bridge = new Dib0700(usb, _sleep);
        Demod = new Mn88472(Bridge);
        Tuner = new Tda18250(Bridge, _sleep);
    }

    private void Note(string message) => _log($"[{_name}] {message}");

    /// <summary>
    /// 開いたあとの手順: 記述子から TS の端点を確かめ、ブリッジのファームウェアを動かし (仕様書「ブリッジのファームウェア」)、
    /// 電源を入れてリセットし (「電源とリセット」)、チップを確かめ (「見つける」)、復調、チューナーの順に初期化する (「初期化」)
    /// </summary>
    public void Start(Func<byte[]> bridgeFirmware, Func<byte[]> demodFirmware)
    {
        // 記述子は資料で確かめられていない。読んだものを記録に出し、TS の端点の wMaxPacketSize から転送の大きさを決める
        var pipes = _usb.Pipes();
        Note($"端点: {(pipes.Count == 0 ? "無し" : UsbDevices.DescribePipes(pipes.Select(pipe => (pipe.Endpoint, pipe.Type, pipe.MaxPacket))))}");
        var ts = pipes.FirstOrDefault(pipe => pipe.Endpoint == Dib0700.TsIn && pipe.Bulk);
        if (ts == default) throw new IOException($"インターフェース 0 にバルク IN の EP 0x{Dib0700.TsIn:X2} (TS) がありません");
        if (!pipes.Any(pipe => pipe.Endpoint == Dib0700.FirmwareOut && pipe.Bulk))
        {
            Note($"記述子にバルク OUT の EP 0x{Dib0700.FirmwareOut:X2} がありません。EP 0x{Dib0700.FirmwareOut:X2} に送ります");
        }

        Version = Bridge.Boot(bridgeFirmware, records => Note($"ブリッジのファームウェアを送りました ({records} レコード)"));
        Note($"ブリッジのバージョン: {Version}");
        // 1 回の転送の大きさ: 転送の長さを指定できるファームウェアは 21 パケットぶん、できなければ wMaxPacketSize の倍数 (仕様書の 512 なら 3,584 バイト)
        var packet = ts.MaxPacket > 0 ? ts.MaxPacket : 512;
        _transferSize = Version.TakesTsLength ? TsSync.Packet * TsPackets : TsSync.Packet * TsPackets / packet * packet;

        Bridge.PowerUp();
        Demod.Identify();
        Tuner.Identify();
        if (Demod.Init(demodFirmware)) Note($"復調のファームウェア ({Mn88472.FirmwareName}) を送りました");
        Tuner.Init();
    }

    /// <summary>チューナーを合わせ、復調を ISDB-C にして始め、ロックを待つ。期限までにロックしなければ false</summary>
    public bool Tune(uint hertz)
    {
        Tuner.Tune(hertz);
        Demod.Tune(Tda18250.IfKhz * 1000);
        for (var waited = 0; waited < LockMs; waited += LockPollMs)
        {
            _sleep(LockPollMs);
            if (Demod.Locked()) return true;
        }
        return false;
    }

    /// <summary>TS の出力を始め、bulk IN の転送要求を出したままにする (仕様書「TS の取り出し」の 1.〜3.)</summary>
    public IUsbInStream StartTs()
    {
        if (Version.TakesTsLength) Bridge.TsLength(TsPackets);
        Bridge.TsOutput(true);
        try
        {
            _usb.ClearHalt(Dib0700.TsIn);
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            Note($"EP 0x{Dib0700.TsIn:X2} のストールをクリアできませんでした ({error.Message})。続けます");
        }
        return _in = _usb.OpenInStream(Dib0700.TsIn, _transferSize, Depth);
    }

    /// <summary>読み出しを取り消してから、TS の出力を止める (仕様書「TS の取り出し」の 5.)</summary>
    public void StopTs()
    {
        var input = _in;
        _in = null;
        if (input is null) return;
        input.Dispose();
        Bridge.TsOutput(false);
    }

    /// <summary>ロックと C/N (dB。ロックしていなければ null)</summary>
    public (bool Locked, double? Cn) Signal() => Demod.Locked() ? (true, Demod.Cn()) : (false, null);

    /// <summary>TS を止め、チューナー、復調の順にスリープにしてから閉じる (仕様書「スリープ」)。機材が抜けていても閉じる</summary>
    public void Dispose()
    {
        try
        {
            StopTs();
            Tuner.Sleep();
            Demod.Sleep();
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            Note($"スリープにできませんでした ({error.Message})");
        }
        _in?.Dispose();
        _usb.Dispose();
    }
}

/// <summary>
/// Xbox One Digital TV Tuner のチューナー (ケーブル (ISDB-C) だけ)。**機材は最初の選局で開き、捨てられるまで開いたままにする。**
/// 選局し直すときは TS を止めてから合わせ直す。ロックしなかったときは開いたまま。機材に読み書きできなかったときは閉じて、次の選局で開き直す。
/// 開けないとき (ファームウェアが無いなど) は、理由を設定の画面に出す (<see cref="TunerNotice"/>)
/// </summary>
public sealed class XboxOneTuner : ITuneDevice
{
    /// <summary>ロックしたのに TSMF の判定の時間切れまで TS が届かなかったときの文</summary>
    internal const string TsMissing = "ロックしましたが、TS が 1 パケットも届きません";

    /// <summary>TS の読み出しが失敗したときに読む側へ伝える文</summary>
    internal const string TsEnded = "機材から TS を読めなくなりました";

    private readonly string _name;
    private readonly string _key;
    private readonly Func<XboxOneDevice> _open;
    private readonly Lock _gate = new();
    private XboxOneDevice? _device;
    private DvbCable? _cable;
    private volatile bool _broken;

    public XboxOneTuner(string port, string? name = null)
        : this(name ??= $"{XboxOne.Model} {port}", () => XboxOne.OpenDevice(port, name), XboxOne.Device(port))
    {
    }

    /// <summary>開き方を差し替える (テスト。偽の USB の上の機材を返す)</summary>
    internal XboxOneTuner(string name, Func<XboxOneDevice> open, string? key = null)
    {
        _name = name;
        _open = open;
        _key = key ?? name;
    }

    public Stream Output => _cable?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _cable is { Closed: false };
        }
    }

    /// <summary>受けられるのは ISDB-C だけ</summary>
    public bool Accepts(ChannelTable.Tuning tuning) => tuning.IsdbC;

    public TsmfSelector? Tsmf { get; private set; }

    public StreamFormat Format => Tsmf?.Format ?? StreamFormat.Ts;

    public void Tune(ChannelTable.Tuning tuning)
    {
        if (!Accepts(tuning)) throw new IOException(TunerPool.Unaccepted(null, tuning));
        lock (_gate)
        {
            StopStream();
            if (_broken) Close();
            Tsmf = null;
            XboxOneDevice device;
            try
            {
                device = _device ??= _open();
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or NotSupportedException or PlatformNotSupportedException)
            {
                var reason = UsbDevices.Reason(error);
                TunerNotice.Set(_key, this, reason);
                throw new IOException(reason, error);
            }
            TunerNotice.Clear(_key, this);

            // ずらして送られることがあるチャンネルは、中心周波数でロックしなければ、ずらした周波数も試す (DVB の機材と同じ)
            uint[] frequencies = tuning.ShiftedFrequency is { } shifted ? [tuning.Frequency, shifted] : [tuning.Frequency];
            IUsbInStream? input;
            try
            {
                input = frequencies.Any(device.Tune) ? device.StartTs() : null;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
            {
                // 機材の状態が分からないので閉じる。次の選局で開き直す
                Close();
                if (error is UsbGoneException) throw new IOException($"{error.Message}。挿し直してください", error);
                throw new IOException(UsbDevices.Reason(error), error);
            }

            // ロックしなかったときは機材を開いたままにする (次の選局を受け付ける)
            if (input is null) throw new IOException(ITuneDevice.SyncFailed);
            var tsmf = new TsmfSelector(tuning.TsmfIndex);
            Tsmf = tsmf;
            _cable = new DvbCable((buffer, offset, count, giveUp) => Read(input, buffer, offset, count, giveUp), tsmf, new SplitTlv(), _name, TsEnded);
            var decision = tsmf.Wait(TsmfSelector.TimeoutMs);
            if (decision is TsmfDecision.Selected or TsmfDecision.Passthrough) return;
            StopStream();
            throw new IOException(It930xTuner.TsmfFailure(tsmf, decision, TsMissing));
        }
    }

    /// <summary>TS を読む (<see cref="DvbCable.Source"/>)。止める合図を 200 ms ごとに確かめる。読めなくなったら、次の選局で機材を開き直す</summary>
    private int Read(IUsbInStream input, byte[] buffer, int offset, int count, Func<bool> giveUp)
    {
        while (!giveUp())
        {
            int got;
            try
            {
                got = input.Read(buffer.AsSpan(offset, count), 200);
            }
            catch (IOException)
            {
                _broken = true;
                throw;
            }
            if (got > 0) return got;
        }
        return 0;
    }

    /// <summary>受信の状態と C/N (dB)。強度は相対値しか分からないので出さない</summary>
    public TunerSignal? Signal()
    {
        lock (_gate)
        {
            if (_cable is not { Closed: false } || _device is not { } device) return null;
            try
            {
                var (locked, cn) = device.Signal();
                return new TunerSignal(locked, cn, TunerSignal.Db);
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                return null;
            }
        }
    }

    private void StopStream()
    {
        var cable = _cable;
        _cable = null;
        if (cable is null) return;
        cable.Stop();
        try
        {
            _device?.StopTs();
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            _broken = true;
        }
    }

    private void Close()
    {
        var device = _device;
        _device = null;
        _broken = false;
        device?.Dispose();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            StopStream();
            Close();
        }
        TunerNotice.Clear(_key, this);
    }
}
