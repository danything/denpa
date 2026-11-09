using System.Globalization;

namespace Denpa.Agent;

/*
 * IT930x の USB ブリッジを積んだ機材を、px4d を使わずにエージェントが直に持つための層 (#1578 の段階 1)。
 *
 * いまはブリッジ (It930xBridge.cs) と、実機で試す入口 (It930xProbe.cs の --it930x-probe) だけがある。
 * 自動検出 (DeviceProbe) とチューナーの取り合い (TunerPool) にはまだつないでいないので、この機材はいままでどおり px4d が持つ。
 * 復調器とチューナー (CXD2856ER・CXD2858ER) の層は、仕様書から別に書く。
 */

/// <summary>
/// IT930x を積んだ機材 1 機種。受信機の数は tuner-px4.md (MLT5 系は 5 つで、どれも地上波と衛星の両方)。
/// 受信機ごとの割り当て (ブリッジの入力のポート・I2C のバスとアドレス・LNB の給電・カードの GPIO) は実機で確かめてから足す (#1578)
/// </summary>
public sealed record It930xModel(int Vendor, int Product, string Name, int Receivers);

/// <summary>IT930x を積んだ機材の識別と、挿さっているものを探す・開く</summary>
public static class It930x
{
    /// <summary>
    /// いま扱う機種 (MLT5 系の 3 機種)。どれも IT930x に復調器とチューナーの組が 5 つと、内蔵のカードリーダーが付く。
    /// USB の ID は実機ではまだ確かめていない
    /// </summary>
    public static readonly IReadOnlyList<It930xModel> Family =
    [
        new(0x0511, 0x084E, "PLEX PX-MLT5U", 5),
        new(0x0511, 0x024E, "PLEX PX-MLT5PE", 5),
        new(0x0511, 0x924E, "e-Better DTV02A-5TS-P", 5),
    ];

    /// <summary>機材をまとめて呼ぶ名前 (見つからないときの文言)</summary>
    public const string Model = "IT930x の機材 (PX-MLT5U・PX-MLT5PE・DTV02A-5TS-P)";

    /// <summary>USB の ID から。扱う機種でなければ null</summary>
    public static It930xModel? Find(int vendor, int product) =>
        Family.FirstOrDefault(model => model.Vendor == vendor && model.Product == product);

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
