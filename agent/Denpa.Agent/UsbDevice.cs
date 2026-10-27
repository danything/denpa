namespace Denpa.Agent;

/*
 * エージェントが USB を直に持つ機材 (いまは CECH-ZD1 J) のための小さな抽象。OS ごとの実装は
 * UsbFsDevice (Linux の usbfs)・WinUsbDevice (Windows の WinUSB)・IoKitDevice (macOS の IOKit)。どれも P/Invoke だけで、
 * 外のライブラリ (libusb など) は使わない。iso の転送は持たない (要る機材が無い)。
 */

/// <summary>開いた USB の機材1台。インターフェース 0 の代替設定 0 を選んだところから使う</summary>
public interface IUsbDevice : IDisposable
{
    /// <summary>記録に出す名前</summary>
    string Name { get; }

    /// <summary>EP0 の IN の制御転送。受けたバイト数を返す</summary>
    int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs);

    /// <summary>EP0 の OUT の制御転送</summary>
    void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>bulk の IN を1回。時間切れなら 0</summary>
    int BulkRead(byte endpoint, Span<byte> buffer, int timeoutMs);

    /// <summary>bulk の OUT を1回 (全部送れなければ投げる)</summary>
    void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>interrupt の IN を1回。時間切れなら 0</summary>
    int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs);

    /// <summary>
    /// IN の読みを <paramref name="depth"/> 本出しっぱなしにする。読みが出ていない間に来たものは抜ける機材 (TS) 向け。
    /// 止める (Dispose) と出していた読みを取り消して全部回収する
    /// </summary>
    IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth);
}

/// <summary>出しっぱなしの IN の読み</summary>
public interface IUsbInStream : IDisposable
{
    /// <summary>済んだ転送から順に詰めて返す。<paramref name="timeoutMs"/> の間に何も来なければ 0</summary>
    int Read(Span<byte> buffer, int timeoutMs);
}

/// <summary>機材が抜けた (挿し直すまで使えない)</summary>
public sealed class UsbGoneException(string message) : IOException(message);

/// <summary>刺さっている機材の場所。<see cref="Port"/> は Linux の sysfs の名前と同じ形 (<c>1-2.3</c>)</summary>
/// <param name="Path">OS が開くときに使う名前 (Windows のデバイスのパス・macOS の locationID)</param>
public sealed record UsbLocation(string Port, string Path);

/// <summary>OS ごとの、刺さっている機材を並べる・開く</summary>
public static class UsbDevices
{
    /// <summary>
    /// 刺さっている機材を並べる (Windows・macOS)。**開かない。** Windows は WinUSB でないものも並ぶ (開けるかは開くまで分からない)。
    /// Linux は呼ぶ側が sysfs で探すので空 (<see cref="Zd1j.Detect"/>)
    /// </summary>
    public static IReadOnlyList<UsbLocation> List(int vendor, int product)
    {
        if (OperatingSystem.IsWindows()) return WinUsbDevice.List(vendor, product);
        if (OperatingSystem.IsMacOS()) return IoKitDevice.List(vendor, product);
        return [];
    }

    /// <summary>
    /// Windows の場所の文字列 (<c>PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(2)</c>) からポートの名前 (<c>1-3.2</c>)。
    /// 頭の数は、ホストコントローラーの場所の文字列を並べた <paramref name="controllers"/> の何番目か (1 から)。分からなければ null
    /// </summary>
    public static string? WindowsPort(string location, IReadOnlyList<string> controllers)
    {
        var root = location.IndexOf("#USBROOT(", StringComparison.OrdinalIgnoreCase);
        if (root < 0) return null;
        var controller = location[..root];
        var bus = 0;
        for (var i = 0; i < controllers.Count && bus == 0; i++)
        {
            if (string.Equals(controllers[i], controller, StringComparison.OrdinalIgnoreCase)) bus = i + 1;
        }
        if (bus == 0) return null;
        var ports = new List<int>();
        foreach (var part in location[(root + 1)..].Split('#').Skip(1))
        {
            if (!part.StartsWith("USB(", StringComparison.OrdinalIgnoreCase) || !part.EndsWith(')')
                || !int.TryParse(part[4..^1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port)
                || port <= 0)
            {
                return null;
            }
            ports.Add(port);
        }
        return ports.Count == 0 ? null : $"{bus}-{string.Join('.', ports)}";
    }

    /// <summary>
    /// macOS の locationID からポートの名前。上の 8 ビット = バスの番号、続く 4 ビットずつ = ハブのポートを根から (0 で終わり)。
    /// <c>0x14320000</c> → <c>20-3.2</c>。根のハブそのもの (ポートが無い) は null
    /// </summary>
    public static string? MacPort(uint location)
    {
        var ports = new List<uint>();
        for (var shift = 20; shift >= 0; shift -= 4)
        {
            var port = (location >> shift) & 0xF;
            if (port == 0) break;
            ports.Add(port);
        }
        return ports.Count == 0 ? null : $"{location >> 24}-{string.Join('.', ports)}";
    }

    /// <summary>そのポートの機材を開く (Windows・macOS)。無ければ投げる</summary>
    public static IUsbDevice Open(string port, int vendor, int product)
    {
        var found = List(vendor, product).FirstOrDefault(location => location.Port == port)
            ?? throw new IOException($"USB のポート {port} に {vendor:x4}:{product:x4} が見当たりません");
        if (OperatingSystem.IsWindows()) return WinUsbDevice.Open(found);
        if (OperatingSystem.IsMacOS()) return IoKitDevice.Open(found, vendor, product);
        throw new PlatformNotSupportedException();
    }
}
