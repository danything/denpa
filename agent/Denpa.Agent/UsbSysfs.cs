namespace Denpa.Agent;

/// <summary>
/// USB デバイスが並ぶ sysfs (Linux)。USB ポートごとのディレクトリに、属性が1つずつファイルで置かれている。
/// 機材を探すところ (<see cref="AsicenUserland"/>・<see cref="Ccid"/>・<see cref="SianoUserland"/>・<see cref="Zd1j"/>) で同じ読み方をする
/// </summary>
public static class UsbSysfs
{
    public const string Devices = "/sys/bus/usb/devices";

    /// <summary>
    /// USB のポートの名前 (<c>1-2</c>、<c>1-2.3.1</c>)。インターフェース (<c>1-2:1.0</c>) やルートハブは違う。
    /// 設定の <c>siano:</c>・<c>zd1j:</c>・<c>asicen:</c> の機材もこの形で指す (Windows・macOS でも同じ形に作る)
    /// </summary>
    public static bool IsPort(string name)
    {
        var dash = name.IndexOf('-');
        if (dash <= 0 || dash == name.Length - 1) return false;
        return name[..dash].All(char.IsAsciiDigit)
            && name[(dash + 1)..].Split('.').All(part => part.Length > 0 && part.All(char.IsAsciiDigit));
    }

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

    /// <summary>属性を1つ読む (前後の空白を落とす)。無い・読めなければ null</summary>
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
