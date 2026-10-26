using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// Windows の WinUSB (<c>winusb.dll</c>) の <see cref="IUsbDevice"/>。機材にドライバが無いので、利用者が Zadig で WinUSB を当てる
/// (docs/install-windows.md)。Microsoft の公開の資料 (SetupAPI・WinUSB の関数) どおりに P/Invoke だけで呼ぶ。
///
/// <para>
/// 並べるのは SetupAPI の <c>GUID_DEVINTERFACE_USB_DEVICE</c> (Zadig で入れたものも同じ GUID で見える)。ポートの名前は Linux の sysfs と
/// 同じ形 (<c>1-3.2</c>) にする: 頭の数はホストコントローラーを場所の文字列 (<c>PCIROOT(0)#PCI(1400)</c>) で並べた順番 (1 から)、
/// 後ろはハブのポートを根から順に (<c>SPDRP_LOCATION_PATHS</c> の <c>USB(n)</c>)。**挿すポートを変えると別の名前になる。**
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed unsafe partial class WinUsbDevice : IUsbDevice
{
    private static readonly Guid UsbDeviceInterface = new("A5DCBF10-6530-11D2-901F-00C04FB951ED");
    private static readonly Guid UsbHostControllerInterface = new("3ABF6F2D-71C4-462A-8A92-1E6861E6AF27");

    private const uint DigcfPresent = 0x02;
    private const uint DigcfDeviceInterface = 0x10;
    private const uint SpdrpLocationPaths = 0x23;

    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x80;
    private const uint FileFlagOverlapped = 0x40000000;

    private const uint PipeTransferTimeout = 0x03;
    private const uint RawIo = 0x07;

    private const int ErrorFileNotFound = 2;
    private const int ErrorAccessDenied = 5;
    private const int ErrorBadCommand = 22;
    private const int ErrorGenFailure = 31;
    private const int ErrorSemTimeout = 121;
    private const int ErrorNoSuchDevice = 433;
    private const int ErrorOperationAborted = 995;
    private const int ErrorIoPending = 997;
    private const int ErrorDeviceNotConnected = 1167;

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInterfaceData
    {
        public uint Size;
        public Guid ClassGuid;
        public uint Flags;
        public nuint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfoData
    {
        public uint Size;
        public Guid ClassGuid;
        public uint DevInst;
        public nuint Reserved;
    }

    /// <summary>WINUSB_SETUP_PACKET (8 バイト。値で渡す)</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct SetupPacket
    {
        public byte RequestType;
        public byte Request;
        public ushort Value;
        public ushort Index;
        public ushort Length;
    }

    [LibraryImport("setupapi.dll", SetLastError = true)]
    private static partial nint SetupDiGetClassDevsW(Guid* classGuid, char* enumerator, nint parent, uint flags);

    [LibraryImport("setupapi.dll", SetLastError = true)]
    private static partial int SetupDiEnumDeviceInterfaces(nint set, DeviceInfoData* info, Guid* interfaceGuid, uint index, DeviceInterfaceData* data);

    [LibraryImport("setupapi.dll", SetLastError = true)]
    private static partial int SetupDiGetDeviceInterfaceDetailW(nint set, DeviceInterfaceData* data, byte* detail, uint size, uint* required, DeviceInfoData* info);

    [LibraryImport("setupapi.dll", SetLastError = true)]
    private static partial int SetupDiGetDeviceRegistryPropertyW(nint set, DeviceInfoData* info, uint property, uint* type, byte* buffer, uint size, uint* required);

    [LibraryImport("setupapi.dll")]
    private static partial int SetupDiDestroyDeviceInfoList(nint set);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint CreateFileW(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);

    [LibraryImport("kernel32.dll")]
    private static partial int CloseHandle(nint handle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint CreateEventW(nint security, int manualReset, int initialState, char* name);

    [LibraryImport("kernel32.dll")]
    private static partial int ResetEvent(nint handle);

    [LibraryImport("kernel32.dll")]
    private static partial uint WaitForSingleObject(nint handle, uint milliseconds);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_Initialize(nint file, nint* handle);

    [LibraryImport("winusb.dll")]
    private static partial int WinUsb_Free(nint handle);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_SetCurrentAlternateSetting(nint handle, byte setting);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_ControlTransfer(nint handle, SetupPacket setup, byte* buffer, uint length, uint* transferred, nint overlapped);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_ReadPipe(nint handle, byte pipe, byte* buffer, uint length, uint* transferred, nint overlapped);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_WritePipe(nint handle, byte pipe, byte* buffer, uint length, uint* transferred, nint overlapped);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_SetPipePolicy(nint handle, byte pipe, uint policy, uint length, void* value);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_AbortPipe(nint handle, byte pipe);

    [LibraryImport("winusb.dll", SetLastError = true)]
    private static partial int WinUsb_GetOverlappedResult(nint handle, nint overlapped, uint* transferred, int wait);

    private const string Busy = "ほかのソフトが使っているか、WinUSB になっていません (Zadig で WinUSB を当ててください)";

    private readonly Lock _gate = new();
    private readonly Dictionary<byte, uint> _timeouts = [];
    private nint _file;
    private nint _handle;

    public string Name { get; }

    private WinUsbDevice(string name, nint file, nint handle)
    {
        Name = name;
        _file = file;
        _handle = handle;
    }

    /// <summary>刺さっている機材 (WinUSB でないものも並ぶ。開けるかは開いてみるまで分からない)</summary>
    public static IReadOnlyList<UsbLocation> List(int vendor, int product)
    {
        var controllers = Interfaces(UsbHostControllerInterface)
            .Select(found => found.Location)
            .OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var want = $"vid_{vendor:x4}&pid_{product:x4}";
        var found = new List<UsbLocation>();
        foreach (var (path, location) in Interfaces(UsbDeviceInterface))
        {
            if (!path.Contains(want, StringComparison.OrdinalIgnoreCase) || location is null) continue;
            if (UsbDevices.WindowsPort(location, controllers) is { } port) found.Add(new UsbLocation(port, path));
        }
        return found;
    }

    /// <summary>インターフェースのパスと、その機材の最初の場所の文字列</summary>
    private static List<(string Path, string? Location)> Interfaces(Guid guid)
    {
        var found = new List<(string, string?)>();
        var set = SetupDiGetClassDevsW(&guid, null, 0, DigcfPresent | DigcfDeviceInterface);
        if (set == -1) return found;
        try
        {
            for (uint index = 0; ; index++)
            {
                var data = new DeviceInterfaceData { Size = (uint)sizeof(DeviceInterfaceData) };
                if (SetupDiEnumDeviceInterfaces(set, null, &guid, index, &data) == 0) break;
                uint required = 0;
                SetupDiGetDeviceInterfaceDetailW(set, &data, null, 0, &required, null);
                if (required < 8) continue;
                var detail = new byte[required];
                var info = new DeviceInfoData { Size = (uint)sizeof(DeviceInfoData) };
                fixed (byte* buffer = detail)
                {
                    // SP_DEVICE_INTERFACE_DETAIL_DATA_W の cbSize は 64bit では 8 (DWORD + WCHAR を 8 に揃えた大きさ)
                    *(uint*)buffer = IntPtr.Size == 8 ? 8u : 6u;
                    if (SetupDiGetDeviceInterfaceDetailW(set, &data, buffer, required, null, &info) == 0) continue;
                    var path = new string((char*)(buffer + 4));
                    found.Add((path, Location(set, &info)));
                }
            }
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(set);
        }
        return found;
    }

    private static string? Location(nint set, DeviceInfoData* info)
    {
        uint type = 0, required = 0;
        SetupDiGetDeviceRegistryPropertyW(set, info, SpdrpLocationPaths, &type, null, 0, &required);
        if (required < 2) return null;
        var buffer = new byte[required];
        fixed (byte* start = buffer)
        {
            if (SetupDiGetDeviceRegistryPropertyW(set, info, SpdrpLocationPaths, &type, start, required, null) == 0) return null;
        }
        // REG_MULTI_SZ の最初の1つ
        var text = Encoding.Unicode.GetString(buffer);
        var end = text.IndexOf('\0');
        return end > 0 ? text[..end] : null;
    }

    /// <summary>開いて、インターフェース 0 の代替設定 0 を選ぶ</summary>
    public static WinUsbDevice Open(UsbLocation location)
    {
        var name = $"usb {location.Port}";
        var file = CreateFileW(location.Path, GenericRead | GenericWrite, FileShareRead | FileShareWrite, 0, OpenExisting,
            FileAttributeNormal | FileFlagOverlapped, 0);
        if (file == -1)
        {
            var error = Marshal.GetLastPInvokeError();
            throw error switch
            {
                ErrorFileNotFound or ErrorNoSuchDevice or ErrorDeviceNotConnected => new UsbGoneException($"{name} が抜かれました"),
                ErrorAccessDenied => new IOException($"{name}: {Busy}"),
                _ => new IOException($"{name} を開けません ({Marshal.GetPInvokeErrorMessage(error)}。{Busy})"),
            };
        }
        nint handle = 0;
        if (WinUsb_Initialize(file, &handle) == 0)
        {
            CloseHandle(file);
            throw new IOException($"{name}: {Busy}");
        }
        var device = new WinUsbDevice(name, file, handle);
        if (WinUsb_SetCurrentAlternateSetting(handle, 0) == 0)
        {
            var error = device.Failure("代替設定を選べません");
            device.Dispose();
            throw error;
        }
        return device;
    }

    private nint Handle => _handle != 0 ? _handle : throw new ObjectDisposedException(Name);

    private IOException Failure(string what) => Failure(Name, what, Marshal.GetLastPInvokeError());

    private static IOException Failure(string name, string what, int error) => error switch
    {
        ErrorBadCommand or ErrorNoSuchDevice or ErrorDeviceNotConnected => new UsbGoneException($"{name} が抜かれました"),
        ErrorSemTimeout => new IOException($"{name}: {what} (時間切れ)"),
        _ => new IOException($"{name}: {what} ({Marshal.GetPInvokeErrorMessage(error)})"),
    };

    /// <summary>端点の時間切れを決める (変わったときだけ書く)。0 は待ち続ける</summary>
    private void Timeout(byte pipe, int timeoutMs)
    {
        var value = (uint)Math.Max(0, timeoutMs);
        lock (_gate)
        {
            if (_timeouts.TryGetValue(pipe, out var current) && current == value) return;
            if (WinUsb_SetPipePolicy(Handle, pipe, PipeTransferTimeout, sizeof(uint), &value) == 0) throw Failure("時間切れを決められません");
            _timeouts[pipe] = value;
        }
    }

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs) =>
        Control(requestType, request, value, index, data, timeoutMs);

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var sent = Control(requestType, request, value, index, new Span<byte>(start, data.Length), timeoutMs);
            if (sent != data.Length) throw new IOException($"{Name}: 制御転送で送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    private int Control(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        Timeout(0, timeoutMs);
        var setup = new SetupPacket { RequestType = requestType, Request = request, Value = value, Index = index, Length = (ushort)data.Length };
        fixed (byte* start = data)
        {
            uint done = 0;
            if (WinUsb_ControlTransfer(Handle, setup, start, (uint)data.Length, &done, 0) == 0) throw Failure("制御転送");
            return (int)done;
        }
    }

    public int BulkRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Read(endpoint, buffer, timeoutMs);

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Read(endpoint, buffer, timeoutMs);

    private int Read(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        Timeout(endpoint, timeoutMs);
        fixed (byte* start = buffer)
        {
            uint done = 0;
            if (WinUsb_ReadPipe(Handle, endpoint, start, (uint)buffer.Length, &done, 0) != 0) return (int)done;
            if (Marshal.GetLastPInvokeError() == ErrorSemTimeout) return 0;
            throw Failure($"EP 0x{endpoint:X2} から読めません");
        }
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Timeout(endpoint, timeoutMs);
        fixed (byte* start = data)
        {
            uint done = 0;
            if (WinUsb_WritePipe(Handle, endpoint, start, (uint)data.Length, &done, 0) == 0) throw Failure($"EP 0x{endpoint:X2} に送れません");
            if (done != data.Length) throw new IOException($"{Name}: EP 0x{endpoint:X2} に送りきれません ({done}/{data.Length} バイト)");
        }
    }

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        // 出しっぱなしの読みは待ち続ける (時間切れは Read の待ちで見る)。RAW_IO で WinUSB の詰め直しを省く
        Timeout(endpoint, 0);
        byte raw = 1;
        if (WinUsb_SetPipePolicy(Handle, endpoint, RawIo, 1, &raw) == 0) throw Failure("TS の読みの形を決められません");
        return new InStream(this, endpoint, transferSize, depth);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_handle != 0) WinUsb_Free(_handle);
            if (_file != 0) CloseHandle(_file);
            _handle = 0;
            _file = 0;
        }
    }

    /// <summary>OVERLAPPED 付きの読みを何本も出しておき、出した順に待つ。OVERLAPPED と受け口はアンマネージドのメモリに置く</summary>
    private sealed class InStream : IUsbInStream
    {
        private readonly WinUsbDevice _owner;
        private readonly byte _endpoint;
        private readonly int _size;
        private readonly NativeOverlapped*[] _overlapped;
        private readonly byte*[] _buffers;
        private readonly bool[] _pending;
        private int _head;
        private int _offset;
        private int _length = -1;
        private bool _closed;

        public InStream(WinUsbDevice owner, byte endpoint, int transferSize, int depth)
        {
            _owner = owner;
            _endpoint = endpoint;
            _size = transferSize;
            _overlapped = new NativeOverlapped*[depth];
            _buffers = new byte*[depth];
            _pending = new bool[depth];
            try
            {
                for (var i = 0; i < depth; i++)
                {
                    var overlapped = (NativeOverlapped*)NativeMemory.AllocZeroed((nuint)sizeof(NativeOverlapped));
                    overlapped->EventHandle = CreateEventW(0, 1, 0, null);
                    if (overlapped->EventHandle == 0) throw owner.Failure("TS の読みの用意ができません");
                    _overlapped[i] = overlapped;
                    _buffers[i] = (byte*)NativeMemory.Alloc((nuint)transferSize);
                }
                for (var i = 0; i < depth; i++) Submit(i);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        private void Submit(int i)
        {
            var overlapped = _overlapped[i];
            var handle = overlapped->EventHandle;
            *overlapped = default;
            overlapped->EventHandle = handle;
            ResetEvent(handle);
            if (WinUsb_ReadPipe(_owner.Handle, _endpoint, _buffers[i], (uint)_size, null, (nint)overlapped) == 0
                && Marshal.GetLastPInvokeError() != ErrorIoPending)
            {
                throw _owner.Failure("TS の読みを出せません");
            }
            _pending[i] = true;
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            ObjectDisposedException.ThrowIf(_closed, this);
            var deadline = Environment.TickCount64 + timeoutMs;
            var copied = 0;
            while (copied < buffer.Length)
            {
                if (_length < 0)
                {
                    var wait = copied > 0 ? 0 : Math.Max(0, deadline - Environment.TickCount64);
                    if (WaitForSingleObject(_overlapped[_head]->EventHandle, (uint)wait) != 0) break;
                    uint done = 0;
                    _pending[_head] = false;
                    if (WinUsb_GetOverlappedResult(_owner.Handle, (nint)_overlapped[_head], &done, 0) == 0)
                    {
                        var error = Marshal.GetLastPInvokeError();
                        // 端点の止まりなどは、その読みだけ捨てて出し直す
                        if (error != ErrorGenFailure) throw Failure(_owner.Name, "TS の読みが失敗しました", error);
                        done = 0;
                    }
                    _length = (int)done;
                    _offset = 0;
                }
                var take = Math.Min(_length - _offset, buffer.Length - copied);
                new ReadOnlySpan<byte>(_buffers[_head] + _offset, take).CopyTo(buffer[copied..]);
                copied += take;
                _offset += take;
                if (_offset < _length) break;
                _length = -1;
                Submit(_head);
                _head = (_head + 1) % _overlapped.Length;
            }
            return copied;
        }

        /// <summary>読みを取り消し (WinUsb_AbortPipe)、全部済むのを待ってから返す</summary>
        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            var handle = _owner._handle;
            if (handle != 0)
            {
                WinUsb_AbortPipe(handle, _endpoint);
                for (var i = 0; i < _overlapped.Length; i++)
                {
                    if (_overlapped[i] is null || !_pending[i]) continue;
                    uint done = 0;
                    if (WinUsb_GetOverlappedResult(handle, (nint)_overlapped[i], &done, 1) == 0
                        && Marshal.GetLastPInvokeError() is not (ErrorOperationAborted or ErrorGenFailure or ErrorBadCommand or ErrorDeviceNotConnected))
                    {
                        // 済んだか分からない読みの受け口は返さない
                        return;
                    }
                    _pending[i] = false;
                }
            }
            for (var i = 0; i < _overlapped.Length; i++)
            {
                if (_overlapped[i] is not null)
                {
                    if (_overlapped[i]->EventHandle != 0) CloseHandle(_overlapped[i]->EventHandle);
                    NativeMemory.Free(_overlapped[i]);
                }
                if (_buffers[i] is not null) NativeMemory.Free(_buffers[i]);
            }
        }
    }
}
