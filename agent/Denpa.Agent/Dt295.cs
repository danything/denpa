using System.Globalization;

namespace Denpa.Agent;

/*
 * PIXELA PIX-DT295 (USB 06b8:103b。MB86 系の ASSP に地上波・衛星の復調器と B-CAS の差し込み口)。
 *
 * **試験的。** 設定の device は dt295:<USB のポート>。mAgicVISION のファームウェアを機材に入れて動かす (常駐方式)。
 * 機材の中では復号せず、スクランブルのままの TS を受けて、エージェントの B25 で復号する。差し込み口のカードも、ほかのチューナーの復号に使う。
 * ここは機材の識別と探す・開くだけ。常駐イメージとのやり取りは Dt295Resident*.cs、チューナーとカードは Dt295ResidentTuner.cs。
 * 同じ公式ドライバーの機材 (PIX-DT295 W・DT420・DT410 など。<see cref="Dt295.Family"/>) は見つけるが、未確認なので開かずに断る。
 */

/// <summary>
/// 公式ドライバー <c>pxmb86m0x_usb</c> が受け持つ機材 1 つ (その INF に並ぶ USB の ID)。
/// <paramref name="Unconfirmed"/> が null でないものは見つけても使わず、その理由で断る
/// </summary>
public sealed record Dt295Model(int Vendor, int Product, string Name, string? Unconfirmed)
{
    public bool Supported => Unconfirmed is null;

    /// <summary>使わない機材を開こうとしたときの断り</summary>
    public string Refusal(string port) =>
        $"{Name} ({Vendor:x4}:{Product:x4}、{port}) は未確認なので使いません ({Unconfirmed})。動かせるのはいまは PIX-DT295 だけです";
}

/// <summary>PIX-DT295 (と同じドライバーの機材) の識別と、挿さっているものを探す・開く</summary>
public static class Dt295
{
    public const int Vendor = 0x06B8;
    public const int Product = 0x103B;
    public const string Model = "PIXELA PIX-DT295";

    /// <summary>
    /// 公式 INF (<c>pxmb86m0x_usb.inf</c>) に並ぶ機材。INF はどれにも同じ idle・TRC イメージ 7 つを入れ、どのイメージを使うかは
    /// 書いていない。DT295 W・DT420・DT410 には DT295 に無い基板の設定 (CapacitanceOfSystem1・2) が付き、その扱いは仕様書に無い。
    /// PIX-DTxxx は SPI モードの構成で、TS の出口の登録も 1 つだけ。どれも中身を推し量らずに未確認として断る
    /// </summary>
    public static readonly IReadOnlyList<Dt295Model> Family =
    [
        new(Vendor, Product, Model, null),
        new(0x06B8, 0x103C, "PIXELA PIX-DT295 W", "公式 INF で DT295 に無い基板の設定が付いていて、その扱いが分かっていない"),
        new(0x06B8, 0x1038, "PIXELA PIX-DT420", "公式 INF で DT295 に無い基板の設定が付いていて、その扱いが分かっていない"),
        new(0x06B8, 0x1039, "PIXELA PIX-DT410", "公式 INF で DT295 に無い基板の設定が付いていて、その扱いが分かっていない"),
        new(0x04C5, 0x202F, "PIX-DTxxx (SPI モード)", "公式 INF で DT295 と構成が違う (SPI モード)"),
    ];

    /// <summary>USB の ID から。同じドライバーの機材でなければ null</summary>
    public static Dt295Model? Find(int vendor, int product) =>
        Family.FirstOrDefault(model => model.Vendor == vendor && model.Product == product);

    /// <summary>設定の <c>device</c> の接頭辞 (<c>dt295:4-12.1</c>。シリアルは使わずポートで指す。<see cref="Zd1j"/> と同じ形)</summary>
    public const string Scheme = "dt295:";

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>dt295:4-12.1</c> からポートを取る。形式が違えば null</summary>
    public static string? Parse(string device) => UsbSysfs.PortOf(device, Scheme);

    /// <summary>
    /// 設定に書いたのと同じ形式で。**開かない** (開くと常駐イメージを機材に入れてしまう)。
    /// 受けられる種別は地上波・BS・CS (TS を出すのは 1 つずつ)
    /// </summary>
    public static List<TunerSpec> Detect()
    {
        try
        {
            return [.. Ports(Log.Write).Select(port => new TunerSpec($"{Model} {port}", ["GR", "BS", "CS"], false, Device(port)))];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Write($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>
    /// 使えるもの (<see cref="Dt295Model.Supported"/>) が挿さっているポート。**開かない**。未確認の機材は <paramref name="warn"/> に出して並べない。
    /// Linux はカーネルのドライバが使っているものを並べない
    /// </summary>
    public static List<string> Ports(Action<string>? warn = null) => Usable(Found(warn), warn);

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<string> Ports(string sysfs, Action<string>? warn) => Usable(Found(sysfs, warn), warn);

    private static List<string> Usable(List<(string Port, Dt295Model Model)> found, Action<string>? warn)
    {
        foreach (var (port, model) in found.Where(item => !item.Model.Supported))
        {
            warn?.Invoke($"{model.Name} {port} を見つけましたが、未確認なので使いません ({model.Unconfirmed})");
        }
        return [.. found.Where(item => item.Model.Supported).Select(item => item.Port)];
    }

    /// <summary>同じドライバーの機材 (<see cref="Family"/>) が挿さっているポートと、その機材。未確認のものも含む。**開かない**</summary>
    public static List<(string Port, Dt295Model Model)> Found(Action<string>? warn = null) =>
        OperatingSystem.IsLinux()
            ? Found(UsbSysfs.Devices, warn)
            : [.. Family.SelectMany(model => UsbDevices.List(model.Vendor, model.Product).Select(found => (found.Port, model)))];

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<(string Port, Dt295Model Model)> Found(string sysfs, Action<string>? warn)
    {
        var found = new List<(string, Dt295Model)>();
        if (!Directory.Exists(sysfs)) return found;
        foreach (var dir in Directory.EnumerateFileSystemEntries(sysfs).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(dir);
            if (!UsbSysfs.IsPort(port)) continue;
            if (Identify(sysfs, port) is not { } model) continue;
            var driver = UsbSysfs.Driver(sysfs, port);
            if (driver is not (null or "usbfs"))
            {
                warn?.Invoke($"{model.Name} {port} はカーネルのドライバ ({driver}) が使っているので使いません");
                continue;
            }
            found.Add((port, model));
        }
        return found;
    }

    /// <summary>sysfs のそのポートの機材。同じドライバーの機材でなければ null</summary>
    internal static Dt295Model? Identify(string sysfs, string port)
    {
        var dir = Path.Combine(sysfs, port);
        return Hex(UsbSysfs.Read(dir, "idVendor")) is { } vendor && Hex(UsbSysfs.Read(dir, "idProduct")) is { } product ? Find(vendor, product) : null;
    }

    private static int? Hex(string? text) =>
        int.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value) ? value : null;

    /// <summary>そのポートの機材 (Linux は sysfs、Windows・macOS は OS に聞く)。**開かない**</summary>
    public static Dt295Model? Identify(string port) =>
        OperatingSystem.IsLinux() ? Identify(UsbSysfs.Devices, port) : Found().FirstOrDefault(item => item.Port == port).Model;

    /// <summary>
    /// 開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)。インターフェース 0 を確保する。
    /// 構成 1 を選ぶ操作はしない (構成は 1 つだけで、OS が選んだまま使う)。未確認の機材は開かずに断る
    /// </summary>
    public static IUsbDevice OpenUsb(string port) =>
        OpenUsb(port, Identify, model => OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, UsbSysfs.DevUsb, port, model.Vendor, model.Product)
            : UsbDevices.Open(port, model.Vendor, model.Product));

    /// <summary>機材を見分けてから開く (見分け方と開き方を渡せるのはテストのため)</summary>
    internal static IUsbDevice OpenUsb(string port, Func<string, Dt295Model?> identify, Func<Dt295Model, IUsbDevice> open)
    {
        var model = identify(port) ?? throw new IOException($"USB のポート {port} に {Model} が見当たりません");
        if (!model.Supported) throw new IOException(model.Refusal(port));
        return open(model);
    }

    /// <summary>差し込み口 (カードリーダー)。**開くまでは何も開かない** (開くと常駐イメージを機材に入れる)</summary>
    public static IReadOnlyList<CardLinkCandidate> Cards()
    {
        try
        {
            return [.. Ports().Select(Card)];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Write($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>そのポートの差し込み口。**開くまでは何も開かない**</summary>
    public static CardLinkCandidate Card(string port)
    {
        var name = $"{Model} {port} Card Reader";
        return new CardLinkCandidate(name, () => new Dt295ResidentCard(name, () => Dt295ResidentBoard.Acquire(port)));
    }
}
