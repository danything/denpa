using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// CCID のインターフェース1つぶんの形。構成ディスクリプタから読む (<see cref="UsbDescriptors.FindCcid"/>)
/// </summary>
/// <param name="Features">CCID クラスディスクリプタの dwFeatures。やり取りの単位 (TPDU / APDU) もここ</param>
/// <param name="MaxMessage">dwMaxCCIDMessageLength。10 バイトの頭も込み</param>
/// <param name="Voltages">bVoltageSupport。bit0 = 5V、bit1 = 3V、bit2 = 1.8V</param>
public sealed record CcidInterface(
    int Number, byte BulkIn, byte BulkOut, int MaxPacketIn,
    uint Features, int MaxMessage, int MaxIfsd, byte Voltages, uint Protocols, int ClockKhz)
{
    public const uint AutoParameters = 0x02;
    public const uint AutoVoltage = 0x08;
    public const uint AutoPps = 0x80;
    public const uint TpduLevel = 0x0001_0000;
    public const uint ShortApduLevel = 0x0002_0000;
    public const uint ExtendedApduLevel = 0x0004_0000;
    private const uint LevelMask = 0x0007_0000;

    /// <summary>T=1 の枠組みをこちらで組む読み取り機か (TPDU 単位)</summary>
    public bool Tpdu => (Features & LevelMask) == TpduLevel;

    /// <summary>APDU をそのまま渡せる読み取り機か (short / extended APDU 単位)</summary>
    public bool Apdu => (Features & (ShortApduLevel | ExtendedApduLevel)) != 0;

    public string Level => (Features & LevelMask) switch
    {
        TpduLevel => "TPDU",
        ShortApduLevel => "short APDU",
        ExtendedApduLevel => "extended APDU",
        0 => "文字単位",
        _ => $"不明 (0x{Features & LevelMask:x})",
    };
}

/// <summary>USB のディスクリプタを読む。**機材に触らない** (バイト列だけ)</summary>
public static class UsbDescriptors
{
    private const byte TypeDevice = 1;
    private const byte TypeConfig = 2;
    private const byte TypeInterface = 4;
    private const byte TypeEndpoint = 5;
    private const byte TypeCcid = 0x21;
    private const byte ClassCcid = 0x0b;

    /// <summary>デバイスディスクリプタの idVendor / idProduct</summary>
    public static (int Vendor, int Product) Ids(ReadOnlySpan<byte> blob)
    {
        if (blob.Length < 18 || blob[1] != TypeDevice) throw new IOException("USB のデバイスディスクリプタが読めません");
        return (BinaryPrimitives.ReadUInt16LittleEndian(blob[8..]), BinaryPrimitives.ReadUInt16LittleEndian(blob[10..]));
    }

    /// <summary>
    /// usbfs の fd を読んだ中身 (デバイスディスクリプタ + 全部の構成ディスクリプタ) から、
    /// 指した構成・インターフェースの CCID の形を拾う。
    ///
    /// <para>
    /// **構成は番号で選ぶ** (sysfs のインターフェース名 <c>4-11:1.0</c> の <c>1</c>)。
    /// usbfs は使っていない構成のディスクリプタも並べて返すので、先頭を取ると違うことがある。
    /// 代替設定 (bAlternateSetting) は 0 だけ見る。
    /// </para>
    /// </summary>
    public static CcidInterface? FindCcid(ReadOnlySpan<byte> blob, int configValue, int interfaceNumber)
    {
        var at = 0;
        var inConfig = false;
        var inTarget = false;
        uint features = 0, protocols = 0;
        int maxMessage = 0, maxIfsd = 0, clock = 0, maxPacketIn = 64;
        byte voltages = 0, bulkIn = 0, bulkOut = 0;
        var foundClass = false;

        while (at + 2 <= blob.Length)
        {
            int length = blob[at];
            var type = blob[at + 1];
            if (length < 2 || at + length > blob.Length) break;
            var d = blob.Slice(at, length);
            switch (type)
            {
                case TypeConfig when length >= 9:
                    inConfig = d[5] == configValue;
                    inTarget = false;
                    break;
                case TypeInterface when length >= 9:
                    inTarget = inConfig && d[2] == interfaceNumber && d[3] == 0 && d[5] == ClassCcid;
                    break;
                // 0x21 は HID と同じ番号。CCID のインターフェースの中でだけ読む
                case TypeCcid when inTarget && length >= 0x36:
                    voltages = d[5];
                    protocols = BinaryPrimitives.ReadUInt32LittleEndian(d[6..]);
                    clock = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[10..]);
                    maxIfsd = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[28..]);
                    features = BinaryPrimitives.ReadUInt32LittleEndian(d[40..]);
                    maxMessage = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[44..]);
                    foundClass = true;
                    break;
                case TypeEndpoint when inTarget && length >= 7 && (d[3] & 0x03) == 2:
                    if ((d[2] & 0x80) != 0)
                    {
                        bulkIn = d[2];
                        maxPacketIn = BinaryPrimitives.ReadUInt16LittleEndian(d[4..]) & 0x7ff;
                    }
                    else
                    {
                        bulkOut = d[2];
                    }
                    break;
            }
            at += length;
        }

        if (!foundClass || bulkIn == 0 || bulkOut == 0) return null;
        return new CcidInterface(interfaceNumber, bulkIn, bulkOut, Math.Max(maxPacketIn, 8),
            features, maxMessage, maxIfsd, voltages, protocols, clock);
    }
}

/// <summary>1本のバルク転送の口 (OUT に書く、IN から1回読む)。テストでは偽物を挿す</summary>
public interface IBulkPipe : IDisposable
{
    void Write(ReadOnlySpan<byte> data);

    /// <summary>1回のバルク転送で読めただけ返す。0 バイトのこともある (ZLP)</summary>
    int Read(Span<byte> buffer, int timeoutMs);
}

/// <summary>
/// Linux の usbfs (<c>/dev/bus/usb/BBB/DDD</c>) を ioctl で直に叩く。**libusb を使わない。**
///
/// <para>
/// ioctl の番号と構造体は x64 と arm64 で同じ (どちらも LP64 で、arm64 も asm-generic の
/// <c>_IOC</c> の並びを使う)。構造体の大きさは番号に埋まるので、<c>sizeof</c> から組み立てる。
/// </para>
/// </summary>
public sealed unsafe partial class UsbFsPipe : IBulkPipe
{
    /// <summary>struct usbdevfs_bulktransfer。64bit ではポインタの前に 4 バイトの詰めが入って 24 バイト</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct BulkTransfer
    {
        public uint Endpoint;
        public uint Length;
        public uint TimeoutMs;
        public void* Data;
    }

    private static uint Ioc(uint direction, uint number, int size) =>
        (direction << 30) | ((uint)size << 16) | ('U' << 8) | number;

    internal static readonly uint Bulk = Ioc(3, 2, sizeof(BulkTransfer));
    internal static readonly uint ClaimInterface = Ioc(2, 15, sizeof(uint));
    internal static readonly uint ReleaseInterface = Ioc(2, 16, sizeof(uint));

    private const int ReadWrite = 2;
    private const int CloseOnExec = 0x80000;

    private const int Eperm = 1;
    private const int Enoent = 2;
    private const int Eacces = 13;
    private const int Ebusy = 16;
    private const int Enodev = 19;
    private const int Etimedout = 110;

    [LibraryImport("libc", EntryPoint = "open", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    private static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "ioctl", SetLastError = true)]
    private static partial int Ioctl(int fd, nuint request, void* argument);

    [LibraryImport("libc", EntryPoint = "read", SetLastError = true)]
    private static partial nint ReadFd(int fd, byte* buffer, nuint count);

    [LibraryImport("libc", EntryPoint = "close")]
    private static partial int Close(int fd);

    private readonly string _path;
    private readonly byte _in;
    private readonly byte _out;
    private readonly uint _interface;
    private int _fd;

    public CcidInterface Interface { get; }

    private UsbFsPipe(string path, int fd, CcidInterface info)
    {
        _path = path;
        _fd = fd;
        Interface = info;
        _in = info.BulkIn;
        _out = info.BulkOut;
        _interface = (uint)info.Number;
    }

    /// <summary>
    /// 開いて、ディスクリプタを確かめ、インターフェースを掴む。
    ///
    /// <para>
    /// **USB の ID も突き合わせる。** 番号 (<c>DDD</c>) は挿し直すたびに振り直されるので、
    /// 見つけてから開くまでに挿し替わると別の機材を開きうる。
    /// </para>
    /// </summary>
    public static UsbFsPipe Open(string path, int vendor, int product, int configValue, int interfaceNumber)
    {
        var fd = Open(path, ReadWrite | CloseOnExec);
        if (fd < 0)
        {
            var errno = Marshal.GetLastPInvokeError();
            throw new IOException(errno switch
            {
                Enoent or Enodev => $"{path} がありません (リーダーが抜かれたか、コンテナに /dev/bus/usb が見えていません)",
                Eacces or Eperm => $"{path} を開く権限がありません (コンテナに USB 機材の読み書きを許してください)",
                _ => $"{path} を開けません ({Marshal.GetPInvokeErrorMessage(errno)})",
            });
        }

        try
        {
            // usbfs の fd を読むと、デバイスディスクリプタと全部の構成ディスクリプタが続けて返る
            var blob = new byte[16 * 1024];
            var total = 0;
            fixed (byte* start = blob)
            {
                nint got;
                while (total < blob.Length && (got = ReadFd(fd, start + total, (nuint)(blob.Length - total))) > 0)
                {
                    total += (int)got;
                }
            }
            var descriptors = blob.AsSpan(0, total);
            var (v, p) = UsbDescriptors.Ids(descriptors);
            if (v != vendor || p != product)
            {
                throw new IOException($"{path} は別の機材になっています ({v:x4}:{p:x4})。リーダーが挿し直されました");
            }
            var info = UsbDescriptors.FindCcid(descriptors, configValue, interfaceNumber)
                ?? throw new IOException($"{path} に CCID のインターフェース {interfaceNumber} が見当たりません");

            var number = (uint)interfaceNumber;
            if (Ioctl(fd, ClaimInterface, &number) < 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                throw new IOException(errno == Ebusy
                    ? "別のプロセス (pcscd など) がリーダーを掴んでいます。pcscd を止めてください"
                    : $"リーダーのインターフェースを掴めません ({Marshal.GetPInvokeErrorMessage(errno)})");
            }
            return new UsbFsPipe(path, fd, info);
        }
        catch
        {
            Close(fd);
            throw;
        }
    }

    public void Write(ReadOnlySpan<byte> data)
    {
        fixed (byte* start = data)
        {
            var transfer = new BulkTransfer { Endpoint = _out, Length = (uint)data.Length, TimeoutMs = 5000, Data = start };
            var sent = Ioctl(Fd, Bulk, &transfer);
            if (sent < 0) throw Failure("リーダーに送れません");
            if (sent != data.Length) throw new IOException($"リーダーに送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    public int Read(Span<byte> buffer, int timeoutMs)
    {
        fixed (byte* start = buffer)
        {
            var transfer = new BulkTransfer { Endpoint = _in, Length = (uint)buffer.Length, TimeoutMs = (uint)timeoutMs, Data = start };
            var got = Ioctl(Fd, Bulk, &transfer);
            if (got < 0) throw Failure("リーダーから読めません");
            return got;
        }
    }

    private int Fd => _fd >= 0 ? _fd : throw new ObjectDisposedException(_path);

    private IOException Failure(string what)
    {
        var errno = Marshal.GetLastPInvokeError();
        return new IOException(errno switch
        {
            Enodev => "リーダーが抜かれました",
            Etimedout => "リーダーが応答しません",
            _ => $"{what} ({Marshal.GetPInvokeErrorMessage(errno)})",
        });
    }

    public void Dispose()
    {
        if (_fd < 0) return;
        var number = _interface;
        Ioctl(_fd, ReleaseInterface, &number);
        Close(_fd);
        _fd = -1;
    }
}
