using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Denpa.Agent;

/// <summary>
/// macOS の IOKit の <see cref="IUsbDevice"/>。カーネルの拡張も DriverKit も使わず、ユーザーの側の IOUSBLib を P/Invoke で呼ぶ
/// (Apple の公開しているヘッダー IOUSBLib.h・USB.h の形どおり)。
///
/// <para>
/// 並べるのは <c>IOServiceMatching("IOUSBHostDevice")</c> に <c>idVendor</c>・<c>idProduct</c> を足したもの。ポートの名前は
/// <c>locationID</c> から Linux の sysfs と同じ形にする (上の 8 ビット = バスの番号、続く 4 ビットずつ = ハブのポートを根から。
/// <c>0x14320000</c> → <c>20-3.2</c>)。**挿すポートを変えると別の名前になる。**
/// </para>
///
/// <para>
/// IOUSBLib のインターフェースは関数の表 (COM に似た形) なので、表の何番目かで関数ポインタを取って呼ぶ
/// (<c>delegate* unmanaged</c>。リフレクションも <c>Marshal.GetDelegateForFunctionPointer</c> も使わないので Native AOT で通る)。
/// 表の頭の4つは IUnknown (予約・QueryInterface・AddRef・Release)。番号は IOUSBDeviceInterface182・IOUSBInterfaceInterface182 のもの。
/// </para>
/// </summary>
[SupportedOSPlatform("macos")]
public sealed unsafe partial class IoKitDevice : IUsbDevice
{
    private const string IoKit = "/System/Library/Frameworks/IOKit.framework/IOKit";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    private const uint Utf8 = 0x08000100;
    private const int SInt32 = 3;

    private const int Success = 0;
    private const int NoDevice = unchecked((int)0xE00002C0);
    private const int ExclusiveAccess = unchecked((int)0xE00002C5);
    private const int Aborted = unchecked((int)0xE00002EB);
    private const int NotResponding = unchecked((int)0xE00002ED);
    private const int TransactionTimeout = unchecked((int)0xE0004051);

    // IUnknown
    private const int Release = 3;

    // IOUSBDeviceInterface182
    private const int DeviceOpen = 8;
    private const int DeviceClose = 9;
    private const int GetConfiguration = 22;
    private const int SetConfiguration = 23;
    private const int CreateInterfaceIterator = 28;
    private const int DeviceRequestTO = 30;

    // IOUSBInterfaceInterface182
    private const int CreateInterfaceAsyncEventSource = 4;
    private const int InterfaceOpen = 8;
    private const int InterfaceClose = 9;
    private const int GetNumEndpoints = 19;
    private const int SetAlternateInterface = 22;
    private const int GetPipeProperties = 26;
    private const int AbortPipe = 28;
    private const int ClearPipeStall = 30;
    private const int ReadPipeAsync = 33;
    private const int ReadPipeTO = 39;
    private const int WritePipeTO = 40;

    /// <summary>CFUUIDBytes (QueryInterface に値で渡す)</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct UuidBytes
    {
        public ulong High;
        public ulong Low;
    }

    /// <summary>IOUSBDevRequestTO (64bit では 32 バイト)。wValue などは機材の側に送るときに IOKit が並べ替える</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceRequest
    {
        public byte RequestType;
        public byte Request;
        public ushort Value;
        public ushort Index;
        public ushort Length;
        public void* Data;
        public uint Done;
        public uint NoDataTimeout;
        public uint CompletionTimeout;
    }

    /// <summary>IOUSBFindInterfaceRequest (どれも 0xFFFF = 問わない)</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct FindInterface
    {
        public ushort Class;
        public ushort SubClass;
        public ushort Protocol;
        public ushort AlternateSetting;
    }

    [LibraryImport(IoKit, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint IOServiceMatching(string name);

    [LibraryImport(IoKit)]
    private static partial int IOServiceGetMatchingServices(uint mainPort, nint matching, uint* iterator);

    [LibraryImport(IoKit)]
    private static partial uint IOIteratorNext(uint iterator);

    [LibraryImport(IoKit)]
    private static partial int IOObjectRelease(uint item);

    [LibraryImport(IoKit)]
    private static partial nint IORegistryEntryCreateCFProperty(uint entry, nint key, nint allocator, uint options);

    [LibraryImport(IoKit)]
    private static partial int IOCreatePlugInInterfaceForService(uint service, nint pluginType, nint interfaceType, void*** plugin, int* score);

    [LibraryImport(CoreFoundation)]
    private static partial nint CFUUIDGetConstantUUIDWithBytes(nint allocator,
        byte b0, byte b1, byte b2, byte b3, byte b4, byte b5, byte b6, byte b7,
        byte b8, byte b9, byte b10, byte b11, byte b12, byte b13, byte b14, byte b15);

    [LibraryImport(CoreFoundation)]
    private static partial UuidBytes CFUUIDGetUUIDBytes(nint uuid);

    [LibraryImport(CoreFoundation, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint CFStringCreateWithCString(nint allocator, string text, uint encoding);

    [LibraryImport(CoreFoundation)]
    private static partial nint CFNumberCreate(nint allocator, int type, void* value);

    [LibraryImport(CoreFoundation)]
    private static partial byte CFNumberGetValue(nint number, int type, void* value);

    [LibraryImport(CoreFoundation)]
    private static partial void CFDictionarySetValue(nint dictionary, nint key, nint value);

    [LibraryImport(CoreFoundation)]
    private static partial void CFRelease(nint item);

    [LibraryImport(CoreFoundation)]
    private static partial nint CFRunLoopGetCurrent();

    [LibraryImport(CoreFoundation)]
    private static partial void CFRunLoopAddSource(nint loop, nint source, nint mode);

    [LibraryImport(CoreFoundation)]
    private static partial void CFRunLoopRemoveSource(nint loop, nint source, nint mode);

    [LibraryImport(CoreFoundation)]
    private static partial int CFRunLoopRunInMode(nint mode, double seconds, byte returnAfterSourceHandled);

    private static nint Uuid(params byte[] b) =>
        CFUUIDGetConstantUUIDWithBytes(0, b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);

    // IOUSBLib.h・IOCFPlugIn.h の UUID
    private static nint DeviceUserClientType => Uuid(0x9d, 0xc7, 0xb7, 0x80, 0x9e, 0xc0, 0x11, 0xD4, 0xa5, 0x4f, 0x00, 0x0a, 0x27, 0x05, 0x28, 0x61);
    private static nint InterfaceUserClientType => Uuid(0x2d, 0x97, 0x86, 0xc6, 0x9e, 0xf3, 0x11, 0xD4, 0xad, 0x51, 0x00, 0x0a, 0x27, 0x05, 0x28, 0x61);
    private static nint PlugInInterface => Uuid(0xC2, 0x44, 0xE8, 0x58, 0x10, 0x9C, 0x11, 0xD4, 0x91, 0xD4, 0x00, 0x50, 0xE4, 0xC6, 0x42, 0x6F);
    private static nint DeviceInterface182 => Uuid(0x15, 0x2f, 0xc4, 0x96, 0x48, 0x91, 0x11, 0xD5, 0x9d, 0x52, 0x00, 0x0a, 0x27, 0x80, 0x1e, 0x86);
    private static nint InterfaceInterface182 => Uuid(0x49, 0x23, 0xac, 0x4c, 0x48, 0x96, 0x11, 0xD5, 0x92, 0x08, 0x00, 0x0a, 0x27, 0x80, 0x1e, 0x86);

    private static nint CfString(string text) => CFStringCreateWithCString(0, text, Utf8);

    private static void* Slot(void* self, int index) => (*(void***)self)[index];

    private readonly Lock _gate = new();
    private readonly Dictionary<byte, byte> _pipes = [];
    private void* _device;
    private void* _interface;

    public string Name { get; }

    private IoKitDevice(string name, void* device, void* @interface)
    {
        Name = name;
        _device = device;
        _interface = @interface;
    }

    /// <summary>刺さっている機材 (開かない)</summary>
    public static IReadOnlyList<UsbLocation> List(int vendor, int product)
    {
        var found = new List<UsbLocation>();
        foreach (var (service, location) in Services(vendor, product))
        {
            IOObjectRelease(service);
            if (UsbDevices.MacPort(location) is { } port) found.Add(new UsbLocation(port, location.ToString("x8", System.Globalization.CultureInfo.InvariantCulture)));
        }
        return found;
    }

    /// <summary>当てはまる機材の IOService と locationID。IOService は呼ぶ側が IOObjectRelease する</summary>
    private static List<(uint Service, uint Location)> Services(int vendor, int product)
    {
        var found = new List<(uint, uint)>();
        var matching = IOServiceMatching("IOUSBHostDevice");
        if (matching == 0) return found;
        SetNumber(matching, "idVendor", vendor);
        SetNumber(matching, "idProduct", product);
        uint iterator = 0;
        // IOServiceGetMatchingServices は matching を手放す (こちらで CFRelease しない)
        if (IOServiceGetMatchingServices(0, matching, &iterator) != Success) return found;
        try
        {
            for (uint service; (service = IOIteratorNext(iterator)) != 0;)
            {
                var key = CfString("locationID");
                var number = IORegistryEntryCreateCFProperty(service, key, 0, 0);
                CFRelease(key);
                var location = 0;
                if (number != 0)
                {
                    CFNumberGetValue(number, SInt32, &location);
                    CFRelease(number);
                }
                found.Add((service, (uint)location));
            }
        }
        finally
        {
            IOObjectRelease(iterator);
        }
        return found;
    }

    private static void SetNumber(nint dictionary, string name, int value)
    {
        var key = CfString(name);
        var number = CFNumberCreate(0, SInt32, &value);
        CFDictionarySetValue(dictionary, key, number);
        CFRelease(number);
        CFRelease(key);
    }

    /// <summary>プラグインを作って、欲しいインターフェースを取る。取れなければ null</summary>
    private static void* Query(uint service, nint pluginType, nint interfaceId)
    {
        void** plugin = null;
        var score = 0;
        if (IOCreatePlugInInterfaceForService(service, pluginType, PlugInInterface, (void***)&plugin, &score) != Success || plugin is null) return null;
        void* result = null;
        var query = (delegate* unmanaged[Cdecl]<void*, UuidBytes, void**, int>)Slot(plugin, 1);
        var hr = query(plugin, CFUUIDGetUUIDBytes(interfaceId), &result);
        ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(plugin, Release))(plugin);
        return hr == 0 ? result : null;
    }

    /// <summary>開いて、最初のインターフェースを開き、代替設定 0 を選ぶ</summary>
    public static IoKitDevice Open(UsbLocation location, int vendor, int product)
    {
        var name = $"usb {location.Port}";
        var services = Services(vendor, product);
        void* device = null;
        try
        {
            foreach (var (service, id) in services)
            {
                if (device is null && id.ToString("x8", System.Globalization.CultureInfo.InvariantCulture) == location.Path)
                {
                    device = Query(service, DeviceUserClientType, DeviceInterface182);
                }
            }
        }
        finally
        {
            foreach (var (service, _) in services) IOObjectRelease(service);
        }
        if (device is null) throw new IOException($"{name} を開けません (見当たらないか、IOKit が開かせません)");

        var open = ((delegate* unmanaged[Cdecl]<void*, int>)Slot(device, DeviceOpen))(device);
        if (open != Success)
        {
            ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(device, Release))(device);
            throw new IOException(open == ExclusiveAccess
                ? $"{name} はほかのソフト (かドライバ) が使っています"
                : $"{name} を開けません (IOReturn 0x{open:X8})");
        }
        IoKitDevice? result = null;
        try
        {
            byte configuration = 0;
            ((delegate* unmanaged[Cdecl]<void*, byte*, int>)Slot(device, GetConfiguration))(device, &configuration);
            if (configuration == 0) Check(name, "構成を選べません", ((delegate* unmanaged[Cdecl]<void*, byte, int>)Slot(device, SetConfiguration))(device, 1));

            var find = new FindInterface { Class = 0xFFFF, SubClass = 0xFFFF, Protocol = 0xFFFF, AlternateSetting = 0xFFFF };
            uint iterator = 0;
            Check(name, "インターフェースを探せません", ((delegate* unmanaged[Cdecl]<void*, FindInterface*, uint*, int>)Slot(device, CreateInterfaceIterator))(device, &find, &iterator));
            void* @interface = null;
            var first = IOIteratorNext(iterator);
            IOObjectRelease(iterator);
            if (first != 0)
            {
                @interface = Query(first, InterfaceUserClientType, InterfaceInterface182);
                IOObjectRelease(first);
            }
            if (@interface is null) throw new IOException($"{name} のインターフェースを開けません");
            result = new IoKitDevice(name, device, @interface);
            var opened = ((delegate* unmanaged[Cdecl]<void*, int>)Slot(@interface, InterfaceOpen))(@interface);
            if (opened != Success)
            {
                ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(@interface, Release))(@interface);
                result._interface = null;
                throw new IOException(opened == ExclusiveAccess
                    ? $"{name} はほかのソフト (かドライバ) が使っています"
                    : $"{name} のインターフェースを開けません (IOReturn 0x{opened:X8})");
            }
            Check(name, "代替設定を選べません", ((delegate* unmanaged[Cdecl]<void*, byte, int>)Slot(@interface, SetAlternateInterface))(@interface, 0));
            result.MapPipes();
            return result;
        }
        catch
        {
            if (result is not null) result.Dispose();
            else
            {
                ((delegate* unmanaged[Cdecl]<void*, int>)Slot(device, DeviceClose))(device);
                ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(device, Release))(device);
            }
            throw;
        }
    }

    /// <summary>IOUSBLib は端点を pipeRef (1 から) で指すので、端点の番地との対応を作る</summary>
    private void MapPipes()
    {
        byte count = 0;
        Check(Name, "端点を数えられません", ((delegate* unmanaged[Cdecl]<void*, byte*, int>)Slot(_interface, GetNumEndpoints))(_interface, &count));
        for (byte pipe = 1; pipe <= count; pipe++)
        {
            byte direction = 0, number = 0, type = 0, interval = 0;
            ushort size = 0;
            var properties = (delegate* unmanaged[Cdecl]<void*, byte, byte*, byte*, byte*, ushort*, byte*, int>)Slot(_interface, GetPipeProperties);
            if (properties(_interface, pipe, &direction, &number, &type, &size, &interval) != Success) continue;
            // USB.h の kUSBIn = 1
            _pipes[(byte)(number | (direction == 1 ? 0x80 : 0))] = pipe;
        }
    }

    private byte Pipe(byte endpoint) =>
        _pipes.TryGetValue(endpoint, out var pipe) ? pipe : throw new IOException($"{Name} に EP 0x{endpoint:X2} がありません");

    private void* Interface => _interface is not null ? _interface : throw new ObjectDisposedException(Name);

    private static void Check(string name, string what, int result)
    {
        if (result != Success) throw Failure(name, what, result);
    }

    private static IOException Failure(string name, string what, int result) => result switch
    {
        NoDevice or NotResponding => new UsbGoneException($"{name} が抜かれました"),
        TransactionTimeout => new IOException($"{name}: {what} (時間切れ)"),
        _ => new IOException($"{name}: {what} (IOReturn 0x{result:X8})"),
    };

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        fixed (byte* start = data) return Control(requestType, request, value, index, start, data.Length, timeoutMs);
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var sent = Control(requestType, request, value, index, start, data.Length, timeoutMs);
            if (sent != data.Length) throw new IOException($"{Name}: 制御転送で送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    private int Control(byte requestType, byte request, ushort value, ushort index, byte* data, int length, int timeoutMs)
    {
        var device = _device is not null ? _device : throw new ObjectDisposedException(Name);
        var call = new DeviceRequest
        {
            RequestType = requestType, Request = request, Value = value, Index = index, Length = (ushort)length,
            Data = data, NoDataTimeout = (uint)timeoutMs, CompletionTimeout = (uint)timeoutMs,
        };
        Check(Name, "制御転送", ((delegate* unmanaged[Cdecl]<void*, DeviceRequest*, int>)Slot(device, DeviceRequestTO))(device, &call));
        return (int)call.Done;
    }

    public int BulkRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Read(endpoint, buffer, timeoutMs);

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Read(endpoint, buffer, timeoutMs);

    private int Read(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        var pipe = Pipe(endpoint);
        fixed (byte* start = buffer)
        {
            var size = (uint)buffer.Length;
            var result = ((delegate* unmanaged[Cdecl]<void*, byte, void*, uint*, uint, uint, int>)Slot(Interface, ReadPipeTO))(
                Interface, pipe, start, &size, (uint)timeoutMs, (uint)timeoutMs);
            if (result == TransactionTimeout)
            {
                // 時間切れのあとは端点を立て直す (IOUSBLib.h の ReadPipeTO の説明)
                ((delegate* unmanaged[Cdecl]<void*, byte, int>)Slot(Interface, ClearPipeStall))(Interface, pipe);
                return 0;
            }
            Check(Name, $"EP 0x{endpoint:X2} から読めません", result);
            return (int)size;
        }
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        var pipe = Pipe(endpoint);
        fixed (byte* start = data)
        {
            var result = ((delegate* unmanaged[Cdecl]<void*, byte, void*, uint, uint, uint, int>)Slot(Interface, WritePipeTO))(
                Interface, pipe, start, (uint)data.Length, (uint)timeoutMs, (uint)timeoutMs);
            Check(Name, $"EP 0x{endpoint:X2} に送れません", result);
        }
    }

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth) => new InStream(this, Pipe(endpoint), transferSize, depth);

    public void Dispose()
    {
        lock (_gate)
        {
            if (_interface is not null)
            {
                ((delegate* unmanaged[Cdecl]<void*, int>)Slot(_interface, InterfaceClose))(_interface);
                ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(_interface, Release))(_interface);
                _interface = null;
            }
            if (_device is not null)
            {
                ((delegate* unmanaged[Cdecl]<void*, int>)Slot(_device, DeviceClose))(_device);
                ((delegate* unmanaged[Cdecl]<void*, uint>)Slot(_device, Release))(_device);
                _device = null;
            }
        }
    }

    /// <summary>
    /// <c>ReadPipeAsync</c> を何本も出しておく読み。完了は CFRunLoop を回す専用のスレッドで受け、その場で中身を写して同じ受け口で
    /// 出し直す (1本の端点の読みは出した順に済むので、写した順がそのまま届いた順)
    /// </summary>
    private sealed class InStream : IUsbInStream
    {
        private static readonly nint DefaultMode = DefaultRunLoopMode();

        private readonly IoKitDevice _owner;
        private readonly byte _pipe;
        private readonly int _size;
        private readonly byte*[] _buffers;
        private readonly GCHandle[] _slots;
        private readonly BlockingCollection<byte[]> _chunks = new(new ConcurrentQueue<byte[]>());
        private readonly Thread _loop;
        private readonly ManualResetEventSlim _started = new();
        private volatile bool _closing;
        private int _outstanding;
        private volatile int _error;
        private byte[]? _current;
        private int _offset;

        private sealed record Waiting(InStream Stream, int Index);

        public InStream(IoKitDevice owner, byte pipe, int transferSize, int depth)
        {
            _owner = owner;
            _pipe = pipe;
            _size = transferSize;
            _buffers = new byte*[depth];
            _slots = new GCHandle[depth];
            for (var i = 0; i < depth; i++)
            {
                _buffers[i] = (byte*)NativeMemory.Alloc((nuint)transferSize);
                _slots[i] = GCHandle.Alloc(new Waiting(this, i));
            }
            _loop = new Thread(Loop) { IsBackground = true, Name = $"{owner.Name} IN" };
            _loop.Start();
            _started.Wait(TimeSpan.FromSeconds(2));
            if (_error != Success)
            {
                var error = _error;
                Dispose();
                throw Failure(_owner.Name, "TS の読みを出せません", error);
            }
        }

        private static nint DefaultRunLoopMode()
        {
            var library = NativeLibrary.Load(CoreFoundation);
            return *(nint*)NativeLibrary.GetExport(library, "kCFRunLoopDefaultMode");
        }

        private void Loop()
        {
            var @interface = _owner.Interface;
            nint source = 0;
            var loop = CFRunLoopGetCurrent();
            var created = ((delegate* unmanaged[Cdecl]<void*, nint*, int>)IoKitDevice.Slot(@interface, CreateInterfaceAsyncEventSource))(@interface, &source);
            if (created != Success)
            {
                _error = created;
                _started.Set();
                return;
            }
            CFRunLoopAddSource(loop, source, DefaultMode);
            for (var i = 0; i < _buffers.Length && _error == Success; i++) Submit(i);
            _started.Set();
            var closingSince = 0L;
            while (true)
            {
                CFRunLoopRunInMode(DefaultMode, 0.05, 0);
                if (!_closing) continue;
                if (Volatile.Read(ref _outstanding) == 0) break;
                if (closingSince == 0) closingSince = Environment.TickCount64;
                else if (Environment.TickCount64 - closingSince > 2000) break;
            }
            CFRunLoopRemoveSource(loop, source, DefaultMode);
        }

        private void Submit(int i)
        {
            var @interface = _owner._interface;
            if (@interface is null) return;
            var read = (delegate* unmanaged[Cdecl]<void*, byte, void*, uint, delegate* unmanaged[Cdecl]<void*, int, void*, void>, void*, int>)
                IoKitDevice.Slot(@interface, ReadPipeAsync);
            var result = read(@interface, _pipe, _buffers[i], (uint)_size, &Completed, (void*)GCHandle.ToIntPtr(_slots[i]));
            if (result == Success) Interlocked.Increment(ref _outstanding);
            else _error = result;
        }

        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static void Completed(void* refcon, int result, void* transferred)
        {
            if (GCHandle.FromIntPtr((nint)refcon).Target is not Waiting slot) return;
            var stream = slot.Stream;
            Interlocked.Decrement(ref stream._outstanding);
            if (result == Success)
            {
                var length = (int)(nint)transferred;
                if (length > 0) stream._chunks.Add(new ReadOnlySpan<byte>(stream._buffers[slot.Index], length).ToArray());
            }
            else if (result != Aborted)
            {
                stream._error = result;
            }
            if (!stream._closing && result is Success or Aborted) stream.Submit(slot.Index);
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (_error is not (Success or Aborted)) throw Failure(_owner.Name, "TS の読みが失敗しました", _error);
            var copied = 0;
            while (copied < buffer.Length)
            {
                if (_current is null && !_chunks.TryTake(out _current, copied > 0 ? 0 : timeoutMs)) break;
                var take = Math.Min(_current!.Length - _offset, buffer.Length - copied);
                _current.AsSpan(_offset, take).CopyTo(buffer[copied..]);
                copied += take;
                _offset += take;
                if (_offset < _current.Length) break;
                _current = null;
                _offset = 0;
            }
            return copied;
        }

        public void Dispose()
        {
            if (_closing) return;
            _closing = true;
            var @interface = _owner._interface;
            if (@interface is not null) ((delegate* unmanaged[Cdecl]<void*, byte, int>)IoKitDevice.Slot(@interface, AbortPipe))(@interface, _pipe);
            _loop.Join(TimeSpan.FromSeconds(3));
            // 返ってこなかった読みの受け口は、IOKit がまだ持っているかもしれないので返さない
            if (Volatile.Read(ref _outstanding) != 0) return;
            for (var i = 0; i < _buffers.Length; i++)
            {
                NativeMemory.Free(_buffers[i]);
                _slots[i].Free();
            }
            _chunks.Dispose();
            _started.Dispose();
        }
    }
}
