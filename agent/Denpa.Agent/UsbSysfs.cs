namespace Denpa.Agent;

/// <summary>
/// USB デバイスが並ぶ sysfs (Linux)。USB ポートごとのディレクトリに、属性が 1 つずつファイルで置かれている。
/// 機材を探すところ (<see cref="AsicenUserland"/>・<see cref="Ccid"/>・<see cref="SianoUserland"/>・<see cref="Zd1j"/>・<see cref="Dt295"/>) と
/// 開くところ (<see cref="UsbFsDevice"/>) で同じ読み方をする
/// </summary>
public static class UsbSysfs
{
    public const string Devices = "/sys/bus/usb/devices";

    /// <summary>usbfs の機材の置き場 (<c>/dev/bus/usb/BBB/DDD</c>)</summary>
    public const string DevUsb = "/dev/bus/usb";

    /// <summary>
    /// USB のポートの名前 (<c>1-2</c>、<c>1-2.3.1</c>)。インターフェース (<c>1-2:1.0</c>) やルートハブは違う。
    /// 設定の <c>siano:</c>・<c>zd1j:</c>・<c>dt295:</c>・<c>asicen:</c> の機材もこの形で指す (Windows・macOS でも同じ形に作る)
    /// </summary>
    public static bool IsPort(string name)
    {
        var dash = name.IndexOf('-');
        if (dash <= 0 || dash == name.Length - 1) return false;
        return name[..dash].All(char.IsAsciiDigit)
            && name[(dash + 1)..].Split('.').All(part => part.Length > 0 && part.All(char.IsAsciiDigit));
    }

    /// <summary>設定の device (<c>zd1j:4-12.1</c>) から接頭辞の後ろのポートを取る。接頭辞かポートの形式が違えば null</summary>
    public static string? PortOf(string? device, string scheme) =>
        device?.StartsWith(scheme, StringComparison.Ordinal) == true && IsPort(device[scheme.Length..]) ? device[scheme.Length..] : null;

    /// <summary>そのポートのどれかのインターフェースを使っているドライバの名前。誰も使っていなければ null</summary>
    public static string? Driver(string sysfs, string port)
    {
        // sysfs が無い (Linux でない) ならカーネルのドライバも無い
        if (!Directory.Exists(sysfs)) return null;
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs, $"{port}:*").Order(StringComparer.Ordinal))
        {
            var driver = Path.Combine(entry, "driver");
            if (!Directory.Exists(driver)) continue;
            var target = new DirectoryInfo(driver).LinkTarget;
            return Path.GetFileName((target ?? driver).TrimEnd('/'));
        }
        return null;
    }

    /// <summary>属性を 1 つ読む (前後の空白を落とす)。無い・読めなければ null</summary>
    public static string? Read(string dir, string name)
    {
        try
        {
            return File.ReadAllText(Path.Combine(dir, name)).Trim();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
