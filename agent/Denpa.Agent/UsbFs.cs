using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// CCID のインターフェース 1 つぶんの情報。構成ディスクリプタから読む (<see cref="UsbDescriptors.FindCcid"/>)
/// </summary>
/// <param name="Features">CCID クラスディスクリプタの dwFeatures。やり取りの単位 (TPDU / APDU) もここ</param>
/// <param name="MaxMessage">dwMaxCCIDMessageLength。10 バイトのヘッダも込み</param>
/// <param name="Voltages">bVoltageSupport。bit0 = 5V、bit1 = 3V、bit2 = 1.8V</param>
public sealed record CcidInterface(
    int Number, byte BulkIn, byte BulkOut, int MaxPacketIn,
    uint Features, int MaxMessage, int MaxIfsd, byte Voltages, int ClockKhz)
{
    public const uint AutoParameters = 0x02;
    public const uint AutoVoltage = 0x08;
    public const uint AutoPps = 0x80;
    public const uint TpduLevel = 0x0001_0000;
    public const uint ShortApduLevel = 0x0002_0000;
    public const uint ExtendedApduLevel = 0x0004_0000;
    private const uint LevelMask = 0x0007_0000;

    /// <summary>T=1 の枠組みをこちらで組むリーダーか (TPDU 単位)</summary>
    public bool Tpdu => (Features & LevelMask) == TpduLevel;

    /// <summary>APDU をそのまま渡せるリーダーか (short / extended APDU 単位)</summary>
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
    /// usbfs の fd を読んだ中身 (デバイスディスクリプタ + 全部の構成ディスクリプタ) から、最初の構成にあるインターフェース
    /// <paramref name="interfaceNumber"/> (代替設定 0) の端点を並べる。途中で切れているディスクリプタはその手前までを読む
    /// </summary>
    public static List<UsbPipe> Pipes(ReadOnlySpan<byte> blob, int interfaceNumber)
    {
        var pipes = new List<UsbPipe>();
        var at = 0;
        var configs = 0;
        var inTarget = false;
        while (at + 2 <= blob.Length)
        {
            int length = blob[at];
            var type = blob[at + 1];
            if (length < 2 || at + length > blob.Length) break;
            var d = blob.Slice(at, length);
            if (type == TypeConfig && ++configs > 1) break;
            if (type == TypeInterface && length >= 9) inTarget = d[2] == interfaceNumber && d[3] == 0;
            if (type == TypeEndpoint && inTarget && length >= 7)
            {
                pipes.Add(new UsbPipe(d[2], d[3] & 0x03, BinaryPrimitives.ReadUInt16LittleEndian(d[4..]) & 0x7ff));
            }
            at += length;
        }
        return pipes;
    }

    /// <summary>
    /// usbfs の fd を読んだ中身 (デバイスディスクリプタ + 全部の構成ディスクリプタ) から、
    /// 指した構成・インターフェースの CCID の情報を読み取る。
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
        uint features = 0;
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
            features, maxMessage, maxIfsd, voltages, clock);
    }
}

/// <summary>1 本のバルク転送の経路 (OUT に書く、IN から 1 回読む)。テストでは偽物を挿す</summary>
public interface IBulkPipe : IDisposable
{
    void Write(ReadOnlySpan<byte> data);

    /// <summary>1 回のバルク転送で読めただけ返す。0 バイトのこともある (ZLP)</summary>
    int Read(Span<byte> buffer, int timeoutMs);

    /// <summary>USB のポートをリセットして取り直す。できない実装 (テストの偽物) は何もしない</summary>
    void ResetPort() { }
}

/// <summary>CCID のカードリーダーへの経路 (<see cref="IUsbHost.OpenCcid"/> が返す)。開くときに構成ディスクリプタから読んだ CCID の情報を持つ</summary>
public interface ICcidPipe : IBulkPipe
{
    CcidInterface Interface { get; }
}

/// <summary>
/// Linux の usbfs (<c>/dev/bus/usb/BBB/DDD</c>) を ioctl で直に扱うための共通の部品。<see cref="UsbFsPipe"/> (カードリーダー) と
/// <see cref="UsbFsDevice"/> (チューナー) が使う。**libusb を使わない。**
///
/// <para>
/// ioctl の番号と構造体の形はカーネルの uapi (<c>linux/usbdevice_fs.h</c>) のもの。x64 と arm64 で同じ (どちらも LP64 で、
/// arm64 も asm-generic の <c>_IOC</c> の並びを使う)。構造体の大きさは番号に埋まるので、<c>sizeof</c> から組み立てる。
/// libc は Sys (Tuning.cs) のものを使う。
/// </para>
/// </summary>
internal static unsafe class UsbFs
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

    /// <summary>asm-generic の <c>_IOC</c>。direction は _IOC_WRITE = 1 と _IOC_READ = 2 の和</summary>
    internal static uint Ioc(uint direction, uint number, int size) =>
        (direction << 30) | ((uint)size << 16) | ('U' << 8) | number;

    internal static readonly uint Bulk = Ioc(3, 2, sizeof(BulkTransfer));
    internal static readonly uint ClaimInterface = Ioc(2, 15, sizeof(uint));
    internal static readonly uint ReleaseInterface = Ioc(2, 16, sizeof(uint));
    internal static readonly uint Reset = Ioc(0, 20, 0);

    internal const int Eperm = 1;
    internal const int Enoent = 2;
    internal const int Eintr = 4;
    internal const int Eagain = 11;
    internal const int Eacces = 13;
    internal const int Ebusy = 16;
    internal const int Enodev = 19;
    internal const int Epipe = 32;
    internal const int Eproto = 71;
    internal const int Eshutdown = 108;
    internal const int Etimedout = 110;

    /// <summary>usbfs のノードを読み書きで開く。開けなければ、理由を書いた <see cref="IOException"/> を投げる</summary>
    internal static int Open(string path)
    {
        var fd = Sys.Open(path, Sys.ReadWrite | Sys.CloseOnExec);
        if (fd < 0) throw new IOException(OpenError(path, Marshal.GetLastPInvokeError()));
        return fd;
    }

    /// <summary>
    /// 受け取った fd の複製 (close-on-exec を付ける)。複製はファイルの位置を共有するので、ディスクリプタは pread で読む。
    /// 受け取った fd が閉じられていれば (抜かれた)、<see cref="IOException"/> を投げる
    /// </summary>
    internal static int Dup(int received, string port)
    {
        var fd = Sys.DupCloseOnExec(received);
        if (fd < 0) throw new IOException($"USB のポート {port} の機材を開けません ({Marshal.GetLastPInvokeErrorMessage()})");
        return fd;
    }

    /// <summary>開けなかったときの文言</summary>
    internal static string OpenError(string path, int errno) => errno switch
    {
        Enoent or Enodev => $"{path} がありません (抜かれたか、コンテナに /dev/bus/usb が見えていません)",
        Eacces or Eperm => $"{path} を開く権限がありません (コンテナに USB 機材の読み書きを許してください)",
        _ => $"{path} を開けません ({Marshal.GetPInvokeErrorMessage(errno)})",
    };
}

/// <summary>CCID のカードリーダーへのバルク転送の経路。usbfs を ioctl で直に扱う (<see cref="UsbFs"/>)</summary>
public sealed unsafe class UsbFsPipe : ICcidPipe
{
    private readonly string _path;
    private int _fd;

    public CcidInterface Interface { get; }

    private UsbFsPipe(string path, int fd, CcidInterface info)
    {
        _path = path;
        _fd = fd;
        Interface = info;
    }

    /// <summary>
    /// 開いて、ディスクリプタを確かめ、インターフェースを確保する。
    ///
    /// <para>
    /// **USB の ID も突き合わせる。** 番号 (<c>DDD</c>) は挿し直すたびに振り直されるので、
    /// 見つけてから開くまでに挿し替わると別の機材を開きうる。
    /// </para>
    /// </summary>
    public static UsbFsPipe Open(string path, int vendor, int product, int configValue, int interfaceNumber) =>
        OpenFd(UsbFs.Open(path), path, vendor, product, configValue, interfaceNumber);

    /// <summary>
    /// アプリから受け取った usbfs の fd (<see cref="BrokerUsbHost"/>) で開く。受け取った fd は <c>dup</c> し、閉じるのは複製のほう。
    /// 確かめることはパスから開くときと同じ
    /// </summary>
    public static UsbFsPipe Open(int received, string port, int vendor, int product, int configValue, int interfaceNumber) =>
        OpenFd(UsbFs.Dup(received, port), $"USB のポート {port}", vendor, product, configValue, interfaceNumber);

    /// <summary>開いた fd でディスクリプタを確かめ、インターフェースを確保する。失敗したら fd を閉じて投げる</summary>
    /// <param name="path">文言に出す、開いたもの (パスかポート)</param>
    private static UsbFsPipe OpenFd(int fd, string path, int vendor, int product, int configValue, int interfaceNumber)
    {
        try
        {
            // usbfs の fd を読むと、デバイスディスクリプタと全部の構成ディスクリプタが続けて返る。
            // dup した fd は位置を共有するので、位置を使わない pread で 0 から読む
            var blob = new byte[16 * 1024];
            var total = 0;
            fixed (byte* start = blob)
            {
                nint got;
                while (total < blob.Length && (got = Sys.PRead(fd, start + total, (nuint)(blob.Length - total), total)) > 0)
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
            if (Sys.Ioctl(fd, UsbFs.ClaimInterface, (nint)(&number)) < 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                throw new IOException(errno == UsbFs.Ebusy
                    ? "別のプロセスがカードリーダーを使用中です (動いているエージェント自身か、ホストの pcscd など)"
                    : $"カードリーダーのインターフェースを確保できません ({Marshal.GetPInvokeErrorMessage(errno)})");
            }
            return new UsbFsPipe(path, fd, info);
        }
        catch
        {
            Sys.Close(fd);
            throw;
        }
    }

    public void Write(ReadOnlySpan<byte> data)
    {
        fixed (byte* start = data)
        {
            var transfer = new UsbFs.BulkTransfer { Endpoint = Interface.BulkOut, Length = (uint)data.Length, TimeoutMs = 5000, Data = start };
            var sent = Sys.Ioctl(Fd, UsbFs.Bulk, (nint)(&transfer));
            if (sent < 0) throw Failure("リーダーに送れません");
            if (sent != data.Length) throw new IOException($"リーダーに送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    public int Read(Span<byte> buffer, int timeoutMs)
    {
        fixed (byte* start = buffer)
        {
            var transfer = new UsbFs.BulkTransfer { Endpoint = Interface.BulkIn, Length = (uint)buffer.Length, TimeoutMs = (uint)timeoutMs, Data = start };
            var got = Sys.Ioctl(Fd, UsbFs.Bulk, (nint)(&transfer));
            if (got < 0) throw Failure("リーダーから読めません");
            return got;
        }
    }

    /// <summary>
    /// **USB のポートをリセットする** (<c>USBDEVFS_RESET</c>)。リーダーが途中のやり取りを
    /// 残したまま止まったとき (前のエージェントがやり取りの最中に止められた、など)、
    /// USB からは繋がって見えるのに何を送っても応答しなくなる。人が unbind / bind していたのを
    /// ここでやる。リセットで確保が外れるので取り直す
    /// </summary>
    public void ResetPort()
    {
        if (Sys.Ioctl(Fd, UsbFs.Reset, 0) < 0) throw Failure("リーダーをリセットできません");
        var number = (uint)Interface.Number;
        if (Sys.Ioctl(Fd, UsbFs.ClaimInterface, (nint)(&number)) < 0) throw Failure("リセットしたリーダーを確保し直せません");
    }

    private int Fd => _fd >= 0 ? _fd : throw new ObjectDisposedException(_path);

    private IOException Failure(string what)
    {
        var errno = Marshal.GetLastPInvokeError();
        return new IOException(errno switch
        {
            UsbFs.Enodev => "リーダーが抜かれました",
            UsbFs.Etimedout => "リーダーが応答しません",
            _ => $"{what} ({Marshal.GetPInvokeErrorMessage(errno)})",
        });
    }

    public void Dispose()
    {
        if (_fd < 0) return;
        var number = (uint)Interface.Number;
        Sys.Ioctl(_fd, UsbFs.ReleaseInterface, (nint)(&number));
        Sys.Close(_fd);
        _fd = -1;
    }
}
