namespace Denpa.Agent;

/// <summary>
/// USB デバイスが並ぶ sysfs (Linux)。USB ポートごとのディレクトリに、属性が 1 つずつファイルで置かれている。
/// 機材を探すところ (<see cref="AsicenUserland"/>・<see cref="Ccid"/>・<see cref="SianoUserland"/>・<see cref="Zd1j"/>・<see cref="Dt295"/>・<see cref="It930x"/>) と
/// 開くところ (<see cref="UsbFsDevice"/>) で同じ読み方をする
/// </summary>
public static class UsbSysfs
{
    public const string Devices = "/sys/bus/usb/devices";

    /// <summary>usbfs の機材の置き場 (<c>/dev/bus/usb/BBB/DDD</c>)</summary>
    public const string DevUsb = "/dev/bus/usb";

    /// <summary>
    /// USB のポートの名前 (<c>1-2</c>、<c>1-2.3.1</c>)。インターフェース (<c>1-2:1.0</c>) やルートハブは違う。
    /// 設定の <c>siano:</c>・<c>zd1j:</c>・<c>dt295:</c>・<c>it930x:</c>・<c>asicen:</c> の機材もこの形で指す (Windows・macOS でも同じ形に作る)
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

    /// <summary>
    /// ポートの電源を切って入れ直し、機材を挿し直したのと同じ状態にする (ハブのポートの <c>port/disable</c> に 1 を書いてから 0 を書く)。
    /// 機材がもう一度つながるまで待つ。<c>authorized</c> を書き換えるだけでは機材の中は戻らない (PIX-DT295 で確かめた)。
    /// sysfs に書けなければ <see cref="IOException"/>
    /// </summary>
    public static void PowerCycle(string sysfs, string port, TimeSpan wait)
    {
        // 電源を切ると機材のディレクトリごと消えるので、先にハブの側のポート (<c>3-0:1.0/usb3-port5</c>) をたどっておく
        string disable;
        string? before;
        try
        {
            var link = new DirectoryInfo(Path.Combine(sysfs, port, "port"));
            var hub = link.LinkTarget is { } target ? Path.GetFullPath(Path.Combine(sysfs, port, target)) : link.FullName;
            disable = Path.Combine(hub, "disable");
            before = Read(Path.Combine(sysfs, port), "devnum");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new IOException($"USB のポート {port} のハブの側が見当たりません ({error.Message})。機材を挿し直してください", error);
        }
        try
        {
            File.WriteAllText(disable, "1");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new IOException($"USB のポート {port} の電源を切れません ({error.Message})。機材を挿し直してください", error);
        }
        try
        {
            Thread.Sleep(500);
        }
        finally
        {
            // 切ったあとは、途中で何が起きても入れ直しを試す (切れたままにしない)
            try
            {
                File.WriteAllText(disable, "0");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw new IOException($"USB のポート {port} の電源を入れ直せず、切れたままです ({error.Message})。機材を挿し直してください", error);
            }
        }
        var deadline = DateTime.UtcNow + wait;
        var gone = before is null;
        while (DateTime.UtcNow < deadline)
        {
            // 前の機材が消えたのを見たか、前と違う番号の devnum が出たら、つながり直した (同じ番号が振り直されることもある)
            var now = Read(Path.Combine(sysfs, port), "devnum");
            if (now is null) gone = true;
            else if (now.Length > 0 && (gone || now != before)) return;
            Thread.Sleep(100);
        }
        throw new IOException($"USB のポート {port} の電源を入れ直したあと、機材が {wait.TotalSeconds:0} 秒のうちにつながりませんでした");
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
