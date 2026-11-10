using System.Globalization;

namespace Denpa.Agent;

/*
 * IT930x の USB ブリッジを積んだ機材を、px4d を使わずにエージェントが直に持つための層 (#1578 の段階 1)。
 *
 * ブリッジ (It930xBridge.cs)、受信機ごとに TS を分ける層 (It930xTs.cs)、復調器とチューナー (Cxd2856.cs・Cxd2858.cs)、
 * 機材とチューナー (It930xDevice.cs)、実機で試す入口 (It930xProbe.cs の --it930x-probe と、Probe.cs の --tune it930x:… と --card it930x:…) がある。
 * 地上波と衛星と J.83B (スカパー！プレミアムサービス光。種別は SKY) と内蔵カードリーダー (It930xCard.cs) を扱う。
 * **この表の機種 (Family) は、いつもエージェントが持つ。** 自動検出 (Detect) が it930x:<USB のポート>:<受信機> で挙げ、px4d は挙げず、起動もしない (Px4Userland.ParseJson)。
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
/// LNB の給電は 3 機種とも同じブリッジの GPIOH11 (仕様書 1.5・9)、カードは SDK の GPIOH6・GPIOH14 (It930xCard.cs。PX-MLT5PE の実機でカードを読めた。ほかの 2 機種は確かめていない) なので、表には持たない
/// </summary>
public sealed record It930xModel(int Vendor, int Product, string Name, IReadOnlyList<It930xReceiver> Receivers);

/// <summary>IT930x を積んだ機材の識別と、挿さっているものを探す・開く。設定の <c>device</c> の形と、自動検出</summary>
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
    /// PX-MLT5PE は、USB の ID と受信機 0〜4 の割り当てを実機で確かめた (5 台とも選局できた)。
    /// PX-MLT5U と DTV02A-5TS-P は、USB の ID も割り当ても実機で確かめていない。DTV02A-5TS-P は PX-MLT5PE と同じ割り当てとして扱う (仕様書 1.2 も未確認としている)
    /// </summary>
    public static readonly IReadOnlyList<It930xModel> Family =
    [
        new(0x0511, 0x084E, "PLEX PX-MLT5U", Mlt5u),
        new(0x0511, 0x024E, "PLEX PX-MLT5PE", Mlt5pe),
        new(0x0511, 0x924E, "e-Better DTV02A-5TS-P", Mlt5pe),
    ];

    /// <summary>
    /// 受信機が受けられる種別 (<c>GET /denpa/tuners</c> の <c>receivable</c>)。どの受信機も ISDB-T・ISDB-S・J.83B を受けられる (仕様書 1.2)。
    /// <c>SKY</c> (スカパー！プレミアムサービス光) を受けられるのは、いまはこの機材だけ
    /// </summary>
    public static readonly IReadOnlyList<string> Types = ["GR", "BS", "CS", ChannelTable.Sky];

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
    /// <c>px4d --list-json</c> の筐体が、この表の機種か。**この表の機種は px4d に持たせない** (<see cref="Px4Userland.ParseJson"/>)。
    /// USB の ID (<c>0511:024e</c>) で見分ける。ID が読めなかったときだけ、機種の名前 (<c>PX-MLT5PE</c>) で見分ける
    /// </summary>
    public static It930xModel? Listed(string? usb, string? model)
    {
        if (usb?.Split(':') is [var vendor, var product] && Hex(vendor) is { } vid && Hex(product) is { } pid) return Find(vid, pid);
        return model is { Length: > 0 } ? Family.FirstOrDefault(known => known.Name.EndsWith(model, StringComparison.OrdinalIgnoreCase)) : null;
    }

    /// <summary>画面に出す受信機の名前 (<c>PLEX PX-MLT5PE 4-12.1 #0</c>)</summary>
    public static string Name(It930xModel model, string port, int receiver) => $"{model.Name} {port} #{receiver}";

    /// <summary>
    /// 挿さっている機材の受信機を、設定に書いたのと同じ形式で。並べるだけで開かない (開くとファームウェアを起動して電源を入れる)。
    /// どの受信機も <see cref="Types"/> を受けられ、最初に選ぶのは <see cref="DetectedTypes"/>
    /// </summary>
    public static List<TunerSpec> Detect() => Specs(Found(Log.Write));

    /// <summary>
    /// 自動で見つけた受信機に付ける種別。<c>SKY</c> は受けられる種別 (<see cref="Types"/>) には入るが、最初からは選ばない
    /// (光の回線でしか受けられず、選ぶとチャンネルスキャンに H01〜H105 が足される。J.83B は実機で確かめていない)
    /// </summary>
    public static readonly IReadOnlyList<string> DetectedTypes = ["GR", "BS", "CS"];

    /// <summary>挿さっている機材から設定の形式に組み立てる (渡せるのはテストのため)</summary>
    internal static List<TunerSpec> Specs(IEnumerable<(string Port, It930xModel Model)> found) =>
    [
        .. found.SelectMany(item => item.Model.Receivers.Select(receiver =>
            new TunerSpec(Name(item.Model, item.Port, receiver.Index), [.. DetectedTypes], false, Device(item.Port, receiver.Index)))),
    ];

    /// <summary><c>--card it930x:4-12.1</c> (内蔵のカードリーダー。受信機の番号は付けない) からポートを取る。形式が違えば null</summary>
    public static string? CardPort(string? device) =>
        Is(device) && device![Scheme.Length..] is var port && UsbSysfs.IsPort(port) ? port : null;

    /// <summary>内蔵のカードリーダー。挿さっている機材のぶん。**開くまでは何も開かない**</summary>
    public static IReadOnlyList<CardLinkCandidate> Cards() => Cards(Found());

    /// <summary>挿さっている機材から (渡せるのはテストのため)</summary>
    internal static IReadOnlyList<CardLinkCandidate> Cards(IEnumerable<(string Port, It930xModel Model)> found) =>
        [.. found.Select(item => Card(item.Port, item.Model))];

    /// <summary>カードリーダーの名前 (<c>PLEX PX-MLT5PE 4-12.1 Card Reader</c>。画面の「使う」の設定もこの名前で持つ)</summary>
    public static string CardName(string port, It930xModel model) => $"{model.Name} {port} Card Reader";

    /// <summary>そのポートの内蔵のカードリーダー。**開くまでは何も開かない**</summary>
    public static CardLinkCandidate Card(string port, It930xModel model)
    {
        var name = CardName(port, model);
        return new CardLinkCandidate(name, () => new It930xCard(name, port));
    }

    /// <summary>
    /// 挿さっているポートと機種。**開かない。** Linux はカーネルのドライバが使っているものを並べない。
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
    /// ほかのソフトが使っていれば、OS の理由のまま失敗する
    /// </summary>
    public static IUsbDevice OpenUsb(string port, It930xModel model) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, UsbSysfs.DevUsb, port, model.Vendor, model.Product, selectAlternate: false)
            : UsbDevices.Open(port, model.Vendor, model.Product);
}
