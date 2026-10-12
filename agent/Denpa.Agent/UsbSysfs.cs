namespace Denpa.Agent;

/// <summary>
/// USB デバイスが並ぶ sysfs (Linux)。挿し口ごとのディレクトリに、属性が1つずつファイルで置かれている。
/// 機材を探すところ (<see cref="AsicenUserland"/>・<see cref="Ccid"/>・<see cref="SianoUserland"/>) で同じ読み方をする
/// </summary>
public static class UsbSysfs
{
    public const string Devices = "/sys/bus/usb/devices";

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
