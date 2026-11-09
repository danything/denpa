using System.Globalization;

namespace Denpa.Agent;

/*
 * IT930x の USB ブリッジを積んだ機材を、px4d を使わずにエージェントが直に持つための層 (#1578 の段階 1)。
 *
 * ブリッジ (It930xBridge.cs)、受信機ごとに TS を分ける層 (It930xTs.cs)、復調器とチューナー (Cxd2856.cs・Cxd2858.cs)、
 * 機材とチューナー (It930xDevice.cs)、実機で試す入口 (It930xProbe.cs の --it930x-probe と、Probe.cs の --tune it930x:…) がある。
 * いまは地上波だけ。設定の device に it930x:<USB のポート>:<受信機> と書いたときだけエージェントが持ち、自動検出は px4d のまま (持ち主の決まりは下の Claim)。
 * 受信機ごとの割り当ては仕様書 (denpa-spec の mlt5/spec.md) の 1.2 から。
 */

/// <summary>
/// 受信機 1 つの割り当て (仕様書 1.2)。<paramref name="DemodAddress"/> は復調器の T のアドレス (7 ビット)。X のアドレスは T + 2 (仕様書 1.1)、
/// チューナーはどの受信機も <see cref="Cxd2858.Address"/>
/// </summary>
/// <param name="Index">受信機の番号 (設定の <c>it930x:&lt;ポート&gt;:&lt;Index&gt;</c>)。ブリッジの「次の段の I2C」の欄もこの番号で並ぶ (仕様書 1.3)</param>
/// <param name="TsInput">ブリッジの TS 入力 (0〜4)。同期バイトはこの入力の番号で決まる (<see cref="It930xBridge.SyncBytes"/>)</param>
/// <param name="I2cBus">ブリッジの I2C のバス</param>
public sealed record It930xReceiver(int Index, int TsInput, byte I2cBus, byte DemodAddress);

/// <summary>
/// IT930x を積んだ機材 1 機種。受信機ごとの割り当ては仕様書 1.2 の表。
/// LNB の給電とカードの GPIO は、衛星とカードを足すときに足す (#1578)
/// </summary>
public sealed record It930xModel(int Vendor, int Product, string Name, IReadOnlyList<It930xReceiver> Receivers);

/// <summary>IT930x を積んだ機材の識別と、挿さっているものを探す・開く。設定の <c>device</c> の形と、px4d との持ち主の決まり</summary>
public static class It930x
{
    /// <summary>PX-MLT5PE・DTV02A-5TS-P の割り当て (仕様書 1.2)。T のアドレスとバスは 3 機種で同じで、TS 入力は受信機の番号と同じ</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt5pe =
    [
        new(0, 0, 3, 0x65),
        new(1, 1, 1, 0x6C),
        new(2, 2, 1, 0x64),
        new(3, 3, 3, 0x6C),
        new(4, 4, 3, 0x64),
    ];

    /// <summary>PX-MLT5U の割り当て (仕様書 1.2)。TS 入力の番号だけが PX-MLT5PE と違う</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt5u =
    [
        new(0, 4, 3, 0x65),
        new(1, 3, 1, 0x6C),
        new(2, 1, 1, 0x64),
        new(3, 2, 3, 0x6C),
        new(4, 0, 3, 0x64),
    ];

    /// <summary>
    /// いま扱う機種 (MLT5 系の 3 機種)。どれも IT930x に復調器とチューナーの組が 5 つと、内蔵のカードリーダーが付く。
    /// USB の ID と割り当ては実機ではまだ確かめていない。DTV02A-5TS-P は PX-MLT5PE と同じ割り当てとして扱う (仕様書 1.2 も未確認としている)
    /// </summary>
    public static readonly IReadOnlyList<It930xModel> Family =
    [
        new(0x0511, 0x084E, "PLEX PX-MLT5U", Mlt5u),
        new(0x0511, 0x024E, "PLEX PX-MLT5PE", Mlt5pe),
        new(0x0511, 0x924E, "e-Better DTV02A-5TS-P", Mlt5pe),
    ];

    /// <summary>機材をまとめて呼ぶ名前 (見つからないときの文言)</summary>
    public const string Model = "IT930x の機材 (PX-MLT5U・PX-MLT5PE・DTV02A-5TS-P)";

    /// <summary>USB の ID から。扱う機種でなければ null</summary>
    public static It930xModel? Find(int vendor, int product) =>
        Family.FirstOrDefault(model => model.Vendor == vendor && model.Product == product);

    /// <summary>設定の <c>device</c> の接頭辞 (<c>it930x:4-12.1:0</c>。USB のポートと受信機の番号)</summary>
    public const string Scheme = "it930x:";

    public static string Device(string port, int receiver) => $"{Scheme}{port}:{receiver}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>it930x:4-12.1:0</c> からポートと受信機の番号を取る。形式が違うか、受信機の番号が 0〜4 でなければ null</summary>
    public static (string Port, int Receiver)? Parse(string? device)
    {
        if (!Is(device)) return null;
        var rest = device![Scheme.Length..];
        var colon = rest.LastIndexOf(':');
        if (colon <= 0) return null;
        var port = rest[..colon];
        if (!UsbSysfs.IsPort(port)) return null;
        if (!int.TryParse(rest[(colon + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var receiver) || receiver is < 0 or > 4) return null;
        return (port, receiver);
    }

    /// <summary>
    /// **エージェントが持つポート。** 設定に <c>it930x:&lt;ポート&gt;:&lt;受信機&gt;</c> のチューナーが 1 つでも「使う」になっていれば、そのポートの機材はエージェントが持つ。
    /// px4d はそのポートの筐体を挙げず (<see cref="Px4Userland.Detect"/>)、起動もしない (<see cref="Px4Daemon.Ensure"/>)。
    /// 自動検出には出さないので、書いていなければ px4d が持つ
    /// </summary>
    public static IReadOnlySet<string> Claimed(IEnumerable<TunerSpec> specs) => specs
        .Where(spec => !spec.Disabled)
        .Select(spec => Parse(spec.Device)?.Port)
        .OfType<string>()
        .ToHashSet(StringComparer.Ordinal);

    private static volatile IReadOnlySet<string> _claimed = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>いまエージェントが持つポート (<see cref="Claim"/> で決めたもの)</summary>
    public static IReadOnlySet<string> Ports => _claimed;

    /// <summary>設定のチューナーから、エージェントが持つポートを決め直す (起動したときと、定義を書き換えたとき。Program.cs)</summary>
    public static void Claim(IEnumerable<TunerSpec> specs)
    {
        var next = Claimed(specs);
        var before = _claimed;
        _claimed = next;
        foreach (var port in next.Except(before)) Log.Write($"[{Model}] USB のポート {port} の機材はエージェントが持ちます (設定の {Scheme})");
    }

    /// <summary>筐体の USB の位置 (<see cref="Px4Userland.Enclosure.Places"/>) のどれかをエージェントが持つか</summary>
    public static bool ClaimsAny(IEnumerable<string> places, IReadOnlySet<string> claimed) => places.Any(claimed.Contains);

    /// <summary>
    /// 挿さっているポートと機種。**開かない** (開くと px4d から使えなくなる)。Linux はカーネルのドライバが使っているものを並べない。
    /// 探せなければ (USB の一覧を読めない・ライブラリが無い) <paramref name="warn"/> に出して空
    /// </summary>
    public static List<(string Port, It930xModel Model)> Found(Action<string>? warn = null)
    {
        try
        {
            return OperatingSystem.IsLinux()
                ? Found(UsbSysfs.Devices, warn)
                : [.. Family.SelectMany(model => UsbDevices.List(model.Vendor, model.Product).Select(found => (found.Port, model)))];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            warn?.Invoke($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<(string Port, It930xModel Model)> Found(string sysfs, Action<string>? warn) =>
        UsbDevices.Scan(sysfs, dir => Identify(sysfs, Path.GetFileName(dir)), model => model.Name, warn);

    /// <summary>sysfs のそのポートの機種。扱う機種でなければ null</summary>
    internal static It930xModel? Identify(string sysfs, string port)
    {
        var dir = Path.Combine(sysfs, port);
        return Hex(UsbSysfs.Read(dir, "idVendor")) is { } vendor && Hex(UsbSysfs.Read(dir, "idProduct")) is { } product ? Find(vendor, product) : null;
    }

    /// <summary>そのポートの機種 (Linux は sysfs、Windows・macOS は OS に問い合わせる)。**開かない**</summary>
    public static It930xModel? Identify(string port) =>
        OperatingSystem.IsLinux() ? Identify(UsbSysfs.Devices, port) : Found().FirstOrDefault(item => item.Port == port).Model;

    private static int? Hex(string? text) =>
        int.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value) ? value : null;

    /// <summary>
    /// 開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)。インターフェース 0 を確保する。
    /// px4d などほかのソフトが使っていれば、OS の理由のまま失敗する
    /// </summary>
    public static IUsbDevice OpenUsb(string port, It930xModel model) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, UsbSysfs.DevUsb, port, model.Vendor, model.Product)
            : UsbDevices.Open(port, model.Vendor, model.Product);
}
