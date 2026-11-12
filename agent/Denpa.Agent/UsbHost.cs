using System.Globalization;
using System.Runtime.Versioning;

namespace Denpa.Agent;

/*
 * 挿さっている USB の機材を並べる・開く・抜き差しを受け取る、OS との境目 (IUsbHost)。機材ごとのコード (Zd1j・Dt295・Siano・It930x・
 * Ccid・AsicenUserland) と DeviceWatch は、ここだけを通して USB の機材を探し、開く。OS を見分けるのは UsbHost.Current の 1 か所だけ。
 * 実装は SysfsUsbHost (Linux の sysfs と usbfs)・WinUsbHost (Windows の WinUSB)・IoKitUsbHost (macOS の IOKit)。
 */

/// <summary>USB の ID (idVendor と idProduct)</summary>
public readonly record struct UsbId(int Vendor, int Product)
{
    /// <summary><c>1738:5211</c> の形 (16 進 4 桁ずつ) から。形式が違えば投げる</summary>
    public static UsbId Parse(string text)
    {
        var colon = text.IndexOf(':');
        return new UsbId(
            int.Parse(text.AsSpan(0, colon), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture),
            int.Parse(text.AsSpan(colon + 1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
    }
}

/// <summary>挿さっている機材 1 台。並べただけで、開いていない</summary>
/// <param name="Port">ポートの名前。Linux の sysfs と同じ形 (<c>1-2.3</c>)。Windows・macOS でもこの形に作る</param>
/// <param name="Serial">USB のシリアル番号。無い・読めないなら null (macOS は読まない)</param>
/// <param name="Manufacturer">作り手の名前 (文字列ディスクリプタ)。読まない OS では null</param>
/// <param name="ProductName">製品名 (文字列ディスクリプタ)。読まない OS では null</param>
/// <param name="Driver">カーネルのドライバの名前。使っていない・分からないなら null (usbfs はこちらが開いている印)</param>
/// <param name="Interfaces">(構成の値, インターフェースの番号, bInterfaceClass) の並び。読まない OS では空</param>
public sealed record UsbFound(string Port, int Vendor, int Product, string? Serial, string? Manufacturer,
    string? ProductName, string? Driver, IReadOnlyList<(int Config, int Number, int Class)> Interfaces);

/// <summary>挿さっている USB の機材を並べる・開く・抜き差しを受け取る。OS ごとに 1 つ (<see cref="UsbHost.Current"/>)</summary>
public interface IUsbHost
{
    /// <summary>
    /// 挿さっている機材のうち、ID が <paramref name="ids"/> のどれかのもの。**開かない。** カーネルのドライバが使っているものも並べる (<see cref="UsbFound.Driver"/>)。
    /// 並びは、sysfs ならポートの名前の順、Windows・macOS は <paramref name="ids"/> の順に OS が返した順
    /// </summary>
    IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids);

    /// <summary>
    /// そのポートの機材だけを、並べ直さずに読む (ID は問わない)。挿さっていなければ null。
    /// 1 台だけを読む手段の無い OS (Windows・macOS は ID ごとに並べるしかない) は、挿さっていても null (呼ぶ側は <see cref="List"/> で探す)
    /// </summary>
    UsbFound? Peek(string port);

    /// <summary>
    /// CCID のインターフェース (bInterfaceClass 0x0b) を持つ機材 (ポートの名前の順)。**開かない。**
    /// カードリーダーを自前の CCID で開かない OS (Windows・macOS は PC/SC を使う) は null
    /// </summary>
    IReadOnlyList<UsbFound>? Readers();

    /// <summary>
    /// そのポートの機材を開き、USB の ID を確かめ、インターフェース 0 を確保する。無い・別の機材になっている・ほかのソフトが使っていれば <see cref="IOException"/>
    /// </summary>
    /// <param name="selectAlternate">
    /// 代替設定 0 を選ぶ (SET_INTERFACE)。IT930x は、ファームウェアが動いているときに選び直すと最初のコマンドに応答しなくなる
    /// (PX-MLT5PE の実機で確かめた) ので選ばない。Siano も選び直さない
    /// </param>
    IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true);

    /// <summary>
    /// CCID のインターフェースを開いて確保する (<see cref="Readers"/> が並べたもの)。USB の ID も確かめる。
    /// <see cref="Readers"/> が null の OS では投げる
    /// </summary>
    ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber);

    /// <summary>ポートの電源を入れ直し、機材がつながり直すまで待つ手段 (ポート, 待つ上限)。できない OS (Windows・macOS) は null</summary>
    Action<string, TimeSpan>? PowerCycle { get; }

    /// <summary>
    /// 抜き差しを受け取り始める。挿した・抜いたらしいときに <paramref name="changed"/> を呼ぶ (続けて呼ぶことがあり、まとめるのは呼ぶ側。DeviceWatch)。
    /// 止めるときは Dispose
    /// </summary>
    IDisposable Watch(Action changed);
}

/// <summary>今の OS の <see cref="IUsbHost"/></summary>
public static class UsbHost
{
    /// <summary>起動のときに 1 回だけ選ぶ。Windows・macOS 以外は Linux の sysfs (Android の bionic も OS は Linux と答える)</summary>
    public static IUsbHost Current { get; } =
        OperatingSystem.IsWindows() ? new WinUsbHost()
        : OperatingSystem.IsMacOS() ? new IoKitUsbHost()
        : new SysfsUsbHost(UsbSysfs.Devices, UsbSysfs.DevUsb);

    /// <summary>
    /// <paramref name="models"/> の機材が挿さっているポートと、その機材。**開かない。**
    /// カーネルのドライバが使っているものは <paramref name="warn"/> に出して並べない (usbfs はこちらが開いている印なので並べる)
    /// </summary>
    /// <param name="id">機材の USB の ID。同じ ID が 2 つあれば先のもの</param>
    /// <param name="name">記録に出す機材の名前</param>
    internal static List<(UsbFound Found, T Model)> Scan<T>(IUsbHost host, IReadOnlyList<T> models, Func<T, UsbId> id, Func<T, string> name, Action<string>? warn)
        where T : class
    {
        var found = new List<(UsbFound, T)>();
        foreach (var item in host.List([.. models.Select(id).Distinct()]))
        {
            if (Model(models, id, item) is not { } model) continue;
            if (item.Driver is not (null or "usbfs"))
            {
                warn?.Invoke($"{name(model)} {item.Port} はカーネルのドライバ ({item.Driver}) が使っているので使いません");
                continue;
            }
            found.Add((item, model));
        }
        return found;
    }

    /// <summary>
    /// そのポートの機材 (<paramref name="models"/> のどれか)。カーネルのドライバが使っていても返す。**開かない。**
    /// 1 台だけを読める OS (<see cref="IUsbHost.Peek"/>) はそのポートだけを読み、ほかは並べて探す
    /// </summary>
    internal static T? Identify<T>(IUsbHost host, IReadOnlyList<T> models, Func<T, UsbId> id, string port)
        where T : class
    {
        var found = host.Peek(port) ?? host.List([.. models.Select(id).Distinct()]).FirstOrDefault(item => item.Port == port);
        return found is null ? null : Model(models, id, found);
    }

    private static T? Model<T>(IReadOnlyList<T> models, Func<T, UsbId> id, UsbFound found)
        where T : class =>
        models.FirstOrDefault(model => id(model) == new UsbId(found.Vendor, found.Product));
}

/// <summary>止めるものが無いときの <see cref="IDisposable"/></summary>
internal sealed class NoWatch : IDisposable
{
    public void Dispose()
    {
    }
}

/// <summary>
/// Linux の sysfs (<c>/sys/bus/usb/devices</c>) で並べ、usbfs (<c>/dev/bus/usb</c>) で開く。
/// 並べるのは sysfs のポートごとのディレクトリの <c>idVendor</c>・<c>idProduct</c>・<c>serial</c>・<c>manufacturer</c>・<c>product</c> と、
/// インターフェース (<c>4-11:1.0</c>) の <c>bInterfaceNumber</c>・<c>bInterfaceClass</c>・<c>driver</c>。
/// 抜き差しは <c>/dev/bus/usb</c> の下にファイルができる・消えるのを inotify で受け取る (<see cref="FileSystemWatcher"/>)。
/// カーネルの uevent はコンテナのネットワーク名前空間には届かないので、コンテナでも届くファイルの変化を使う
/// </summary>
/// <param name="sysfs">sysfs の置き場 (渡せるのはテストのため)</param>
/// <param name="devUsb">usbfs の置き場 (渡せるのはテストのため)</param>
public sealed class SysfsUsbHost(string sysfs, string devUsb = UsbSysfs.DevUsb) : IUsbHost
{
    public IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids)
    {
        var found = new List<UsbFound>();
        foreach (var port in Ports())
        {
            if (Read(port, ids) is { } item) found.Add(item);
        }
        return found;
    }

    public UsbFound? Peek(string port) => UsbSysfs.IsPort(port) ? Read(port, null) : null;

    public IReadOnlyList<UsbFound> Readers()
    {
        var found = new List<UsbFound>();
        foreach (var port in Ports())
        {
            // 開くときに /dev/bus/usb/BBB/DDD を組み立てるので、番号が読めないものは並べない
            var dir = Path.Combine(sysfs, port);
            if (!int.TryParse(UsbSysfs.Read(dir, "busnum"), out _) || !int.TryParse(UsbSysfs.Read(dir, "devnum"), out _)) continue;
            if (Read(port, null) is { } item && item.Interfaces.Any(entry => entry.Class == Ccid.InterfaceClass)) found.Add(item);
        }
        return found;
    }

    public IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true) =>
        UsbFsDevice.Open(sysfs, devUsb, port, vendor, product, selectAlternate);

    public ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber)
    {
        var dir = Path.Combine(sysfs, port);
        if (!int.TryParse(UsbSysfs.Read(dir, "busnum"), out var bus) || !int.TryParse(UsbSysfs.Read(dir, "devnum"), out var address))
        {
            throw new IOException($"USB のポート {port} に機材がありません (抜かれたか、コンテナに /sys が見えていません)");
        }
        return UsbFsPipe.Open($"{devUsb}/{bus:000}/{address:000}", vendor, product, config, interfaceNumber);
    }

    public Action<string, TimeSpan>? PowerCycle => (port, wait) => UsbSysfs.PowerCycle(sysfs, port, wait);

    public IDisposable Watch(Action changed)
    {
        if (!Directory.Exists(devUsb)) return new NoWatch();
        var files = new FileSystemWatcher(devUsb) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName };
        files.Created += (_, _) => changed();
        files.Deleted += (_, _) => changed();
        files.EnableRaisingEvents = true;
        return files;
    }

    /// <summary>sysfs に並ぶ USB のポート (ポートの名前の順)。sysfs が無ければ空</summary>
    private IEnumerable<string> Ports() =>
        Directory.Exists(sysfs)
            ? Directory.EnumerateFileSystemEntries(sysfs).Order(StringComparer.Ordinal).Select(entry => Path.GetFileName(entry)).Where(UsbSysfs.IsPort)
            : [];

    /// <summary>ポート 1 つ。ID が読めない・<paramref name="ids"/> のどれでもなければ null (<paramref name="ids"/> が null なら ID は問わない)</summary>
    private UsbFound? Read(string port, IReadOnlyCollection<UsbId>? ids)
    {
        var dir = Path.Combine(sysfs, port);
        if (Hex(UsbSysfs.Read(dir, "idVendor")) is not { } vendor || Hex(UsbSysfs.Read(dir, "idProduct")) is not { } product) return null;
        if (ids is not null && !ids.Contains(new UsbId(vendor, product))) return null;
        return new UsbFound(port, vendor, product, Text(dir, "serial"), Text(dir, "manufacturer"), Text(dir, "product"),
            UsbSysfs.Driver(sysfs, port), Interfaces(port));
    }

    /// <summary>そのポートのインターフェース (<c>4-11:1.0</c> の <c>1</c> が構成の値。番号と種類は中の属性から)。読めないものは飛ばす</summary>
    private List<(int Config, int Number, int Class)> Interfaces(string port)
    {
        var found = new List<(int, int, int)>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs, $"{port}:*").Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(entry);
            var colon = name.IndexOf(':');
            var dot = name.IndexOf('.', colon + 1);
            if (dot < 0 || !int.TryParse(name.AsSpan(colon + 1, dot - colon - 1), out var config)) continue;
            if (Hex(UsbSysfs.Read(entry, "bInterfaceNumber")) is not { } number || Hex(UsbSysfs.Read(entry, "bInterfaceClass")) is not { } kind) continue;
            found.Add((config, number, kind));
        }
        return found;
    }

    private static string? Text(string dir, string name) => UsbSysfs.Read(dir, name) is { Length: > 0 } text ? text : null;

    private static int? Hex(string? text) =>
        int.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value) ? value : null;
}

/// <summary>
/// Windows の WinUSB で並べて開く (<see cref="WinUsbDevice"/>)。WinUSB でないものも並ぶ (開けるかは開くまで分からない)。
/// シリアル番号はデバイスのパスから (<see cref="UsbDevices.WindowsSerial"/>)。カードリーダーは PC/SC で開く。
/// 抜き差しは、挿さっている USB 機材のパス (<see cref="WinUsbDevice.Fingerprint"/>) を 2 秒ごとに見比べる
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WinUsbHost : IUsbHost
{
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(2);

    public IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids) =>
    [
        .. ids.SelectMany(id => WinUsbDevice.List(id.Vendor, id.Product)
            .Select(location => new UsbFound(location.Port, id.Vendor, id.Product, UsbDevices.WindowsSerial(location.Path), null, null, null, []))),
    ];

    public UsbFound? Peek(string port) => null;

    public IReadOnlyList<UsbFound>? Readers() => null;

    public IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true)
    {
        var found = WinUsbDevice.List(vendor, product).FirstOrDefault(location => location.Port == port)
            ?? throw new IOException($"USB のポート {port} に {vendor:x4}:{product:x4} が見当たりません");
        return WinUsbDevice.Open(found, selectAlternate);
    }

    public ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber) =>
        throw new PlatformNotSupportedException("Windows のカードリーダーは PC/SC で開きます");

    public Action<string, TimeSpan>? PowerCycle => null;

    public IDisposable Watch(Action changed)
    {
        var gate = new Lock();
        var last = WinUsbDevice.Fingerprint();
        return new Timer(_ =>
        {
            var now = WinUsbDevice.Fingerprint();
            lock (gate)
            {
                if (now == last) return;
                last = now;
            }
            changed();
        }, null, Poll, Poll);
    }
}

/// <summary>
/// macOS の IOKit で並べて開く (<see cref="IoKitDevice"/>)。シリアル番号・文字列ディスクリプタ・インターフェースは読まない。カードリーダーは PC/SC で開く。
/// 抜き差しは受け取らず、10 秒ごとに <c>changed</c> を呼ぶ (探した結果を前回と比べ、増えた機材だけを足す。Config.Additions)
/// </summary>
[SupportedOSPlatform("macos")]
public sealed class IoKitUsbHost : IUsbHost
{
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(10);

    public IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids) =>
    [
        .. ids.SelectMany(id => IoKitDevice.List(id.Vendor, id.Product)
            .Select(location => new UsbFound(location.Port, id.Vendor, id.Product, null, null, null, null, []))),
    ];

    public UsbFound? Peek(string port) => null;

    public IReadOnlyList<UsbFound>? Readers() => null;

    public IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true)
    {
        var found = IoKitDevice.List(vendor, product).FirstOrDefault(location => location.Port == port)
            ?? throw new IOException($"USB のポート {port} に {vendor:x4}:{product:x4} が見当たりません");
        return IoKitDevice.Open(found, vendor, product, selectAlternate);
    }

    public ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber) =>
        throw new PlatformNotSupportedException("macOS のカードリーダーは PC/SC で開きます");

    public Action<string, TimeSpan>? PowerCycle => null;

    public IDisposable Watch(Action changed) => new Timer(_ => changed(), null, Poll, Poll);
}
