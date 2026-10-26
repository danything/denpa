// Copyright 2026 Till0196
// SPDX-License-Identifier: Apache-2.0
//
// 読みを何本も出しておく形 (UsbFsInStream) は coax (https://github.com/Till0196/coax) 2d9f2c2 の
// pkg/usbio/usbfs (bulkring_linux.go) を C# に移したもの。元は Apache-2.0 OR GPL-2.0-or-later で、
// ここでは Apache-2.0 を選んでいる (agent/NOTICE)。

using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// 機材1台の USB。**制御 (CECH-ZD1 J のブリッジなど) はこれだけを使い、OS を知らない。**
/// テストでは偽物を挿す。失敗は <see cref="IOException"/>、抜かれたら <see cref="UsbGoneException"/>
/// </summary>
public interface IUsbDevice : IDisposable
{
    /// <summary>記録に出す名前 (<c>usb 4-12.1</c> など)</summary>
    string Name { get; }

    /// <summary>EP0 の IN。読めたバイト数</summary>
    int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs);

    /// <summary>EP0 の OUT</summary>
    void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>bulk の OUT。送りきれなければ投げる</summary>
    void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>interrupt の IN を1回。**時間切れは 0**</summary>
    int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs);

    /// <summary>
    /// bulk の IN の読みを <paramref name="depth"/> 本出しっぱなしにする。読みが出ていない間に機材が送ったものは
    /// 抜けるので、TS はこれで読む
    /// </summary>
    IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth);
}

/// <summary>出しっぱなしの読み。止める (Dispose) と出していた読みを取り消す</summary>
public interface IUsbInStream : IDisposable
{
    /// <summary>済んだ転送から順に詰めて返す。**時間切れは 0**。<paramref name="buffer"/> は1回の転送より大きく</summary>
    int Read(Span<byte> buffer, int timeoutMs);
}

/// <summary>機材が抜かれた (ENODEV)</summary>
public sealed class UsbGoneException(string message) : IOException(message);

/// <summary>機材が時間内に答えなかった (ETIMEDOUT)</summary>
public sealed class UsbTimeoutException(string message) : IOException(message);

/// <summary>
/// Linux の usbfs (<c>/dev/bus/usb/BBB/DDD</c>) を ioctl で直に。**libusb を使わない。**
///
/// <para>
/// ioctl の番号と構造体は x64 と arm64 で同じ (<see cref="UsbFsPipe"/> と同じく <c>sizeof</c> から組み立てる)。
/// 非同期の転送 (URB) は fd ごとに1つの「済んだもの」の列から取る (REAPURBNDELAY) ので、取るのはここ1か所で、
/// 取った URB に「済んだ」印を付けて、待っている側がそれを見る (TS の読みと bulk の命令の答えが同じ fd を使う)。
/// </para>
/// </summary>
public sealed unsafe class UsbFsDevice : IUsbDevice
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct ControlTransfer
    {
        public byte RequestType;
        public byte Request;
        public ushort Value;
        public ushort Index;
        public ushort Length;
        public uint TimeoutMs;
        public void* Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SetInterfaceRequest
    {
        public uint Interface;
        public uint Alternate;
    }

    /// <summary>struct usbdevfs_urb。64bit で 56 バイト</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct Urb
    {
        public byte Type;
        public byte Endpoint;
        public short Padding;
        public int Status;
        public uint Flags;
        public void* Buffer;
        public int BufferLength;
        public int ActualLength;
        public int StartFrame;
        public int NumberOfPackets;
        public int ErrorCount;
        public uint Signal;
        public void* UserContext;
    }

    private static uint Ioc(uint direction, uint number, int size) =>
        (direction << 30) | ((uint)size << 16) | ('U' << 8) | number;

    internal static readonly uint Control = Ioc(3, 0, sizeof(ControlTransfer));
    internal static readonly uint Bulk = Ioc(3, 2, sizeof(UsbFsPipe.BulkTransfer));
    internal static readonly uint SetInterface = Ioc(2, 4, sizeof(SetInterfaceRequest));
    internal static readonly uint SubmitUrb = Ioc(2, 10, sizeof(Urb));
    internal static readonly uint DiscardUrb = Ioc(0, 11, 0);
    internal static readonly uint ReapUrbNoDelay = Ioc(1, 13, sizeof(void*));
    internal static readonly uint ClaimInterface = Ioc(2, 15, sizeof(uint));
    internal static readonly uint ReleaseInterface = Ioc(2, 16, sizeof(uint));

    internal const byte UrbInterrupt = 1;
    internal const byte UrbBulk = 3;

    private const int CloseOnExec = 0x80000;
    private const short PollOut = 4;
    private const int Eperm = 1;
    private const int Enoent = 2;
    private const int Eintr = 4;
    private const int Eagain = 11;
    private const int Eacces = 13;
    private const int Ebusy = 16;
    private const int Enodev = 19;
    private const int Etimedout = 110;
    private const int Eshutdown = 108;

    private int _fd;
    private readonly Lock _reap = new();
    private readonly Dictionary<nint, AsyncUrb> _pending = [];

    public string Name { get; }

    private UsbFsDevice(string name, int fd)
    {
        Name = name;
        _fd = fd;
    }

    /// <summary>
    /// sysfs のポート (<c>4-12.1</c>) の機材を開き、インターフェース 0 を確保して代替設定 0 を選ぶ。
    /// **USB の ID も突き合わせる** (番号は挿し直すたびに振り直されるので、別の機材を開かないように)
    /// </summary>
    public static UsbFsDevice Open(string sysfs, string devUsb, string port, int vendor, int product)
    {
        var dir = Path.Combine(sysfs, port);
        if (!int.TryParse(UsbSysfs.Read(dir, "busnum"), out var bus) || !int.TryParse(UsbSysfs.Read(dir, "devnum"), out var address))
        {
            throw new IOException($"usb {port} に機材が見当たりません (抜けたか、挿し替えた?)");
        }
        if (UsbSysfs.Read(dir, "idVendor") != vendor.ToString("x4") || UsbSysfs.Read(dir, "idProduct") != product.ToString("x4"))
        {
            throw new IOException($"usb {port} は別の機材になっています");
        }

        var path = $"{devUsb}/{bus:000}/{address:000}";
        var fd = Sys.Open(path, Sys.ReadWrite | CloseOnExec);
        if (fd < 0)
        {
            var errno = Marshal.GetLastPInvokeError();
            throw new IOException(errno switch
            {
                Enoent or Enodev => $"{path} がありません (抜かれたか、コンテナに /dev/bus/usb が見えていません)",
                Eacces or Eperm => $"{path} を開く権限がありません (コンテナに USB 機材の読み書きを許してください)",
                _ => $"{path} を開けません ({Marshal.GetPInvokeErrorMessage(errno)})",
            });
        }

        var device = new UsbFsDevice($"usb {port}", fd);
        try
        {
            var number = 0u;
            if (Sys.Ioctl(fd, ClaimInterface, (nint)(&number)) < 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                throw new IOException(errno == Ebusy
                    ? $"usb {port} は別のプロセスかカーネルのドライバが使っています"
                    : $"usb {port} のインターフェースを確保できません ({Marshal.GetPInvokeErrorMessage(errno)})");
            }
            var request = new SetInterfaceRequest { Interface = 0, Alternate = 0 };
            device.Call(SetInterface, (nint)(&request), "代替設定を選べません");
            return device;
        }
        catch
        {
            device.Dispose();
            throw;
        }
    }

    private int Fd => _fd >= 0 ? _fd : throw new ObjectDisposedException(Name);

    /// <summary>ioctl を1回 (EINTR は繰り返す)。失敗は errno を見て投げる</summary>
    private int Call(uint request, nint argument, string what)
    {
        for (; ; )
        {
            var result = Sys.Ioctl(Fd, request, argument);
            if (result >= 0) return result;
            var errno = Marshal.GetLastPInvokeError();
            if (errno == Eintr) continue;
            throw Failure(errno, what);
        }
    }

    private IOException Failure(int errno, string what) => errno switch
    {
        Enodev or Eshutdown => new UsbGoneException($"{Name} が抜かれました"),
        Etimedout => new UsbTimeoutException($"{what} ({Name} が応答しません)"),
        _ => new IOException($"{what} ({Name}: {Marshal.GetPInvokeErrorMessage(errno)})"),
    };

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var transfer = new ControlTransfer
            {
                RequestType = requestType, Request = request, Value = value, Index = index,
                Length = (ushort)data.Length, TimeoutMs = (uint)timeoutMs, Data = start,
            };
            return Call(Control, (nint)(&transfer), "制御転送 (IN) に失敗しました");
        }
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var transfer = new ControlTransfer
            {
                RequestType = requestType, Request = request, Value = value, Index = index,
                Length = (ushort)data.Length, TimeoutMs = (uint)timeoutMs, Data = start,
            };
            Call(Control, (nint)(&transfer), "制御転送 (OUT) に失敗しました");
        }
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var transfer = new UsbFsPipe.BulkTransfer { Endpoint = endpoint, Length = (uint)data.Length, TimeoutMs = (uint)timeoutMs, Data = start };
            var sent = Call(Bulk, (nint)(&transfer), $"EP 0x{endpoint:x2} に送れません");
            if (sent != data.Length) throw new IOException($"EP 0x{endpoint:x2} に送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    /// <summary>
    /// **interrupt の端点は URB の種類を INTERRUPT にして出す** (bulk の ioctl では送り方が違う)。
    /// 時間切れなら取り消して 0
    /// </summary>
    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        var urb = new AsyncUrb(buffer.Length);
        try
        {
            Submit(urb, UrbInterrupt, endpoint);
            if (!Await(urb, timeoutMs))
            {
                Cancel(urb);
                if (!urb.Done) return 0;
            }
            if (urb.Request->Status != 0) return Status(urb.Request->Status, endpoint);
            var got = urb.Request->ActualLength;
            new ReadOnlySpan<byte>(urb.Buffer, got).CopyTo(buffer);
            return got;
        }
        finally
        {
            urb.Free(this);
        }
    }

    /// <summary>取り消された (ENOENT) なら 0。抜かれたなら投げる</summary>
    private int Status(int status, byte endpoint) => -status switch
    {
        Enoent => 0,
        Enodev or Eshutdown => throw new UsbGoneException($"{Name} が抜かれました"),
        _ => throw new IOException($"EP 0x{endpoint:x2} の転送に失敗しました ({Name}: {Marshal.GetPInvokeErrorMessage(-status)})"),
    };

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth) =>
        new UsbFsInStream(this, endpoint, transferSize, depth);

    /// <summary>1本の非同期の転送。URB と受け口は動かないメモリに置く (カーネルが後から書く)</summary>
    internal sealed class AsyncUrb
    {
        public readonly Urb* Request;
        public readonly byte* Buffer;
        public readonly int Size;
        public volatile bool Done;
        public bool InFlight;

        public AsyncUrb(int size)
        {
            Size = size;
            Request = (Urb*)NativeMemory.AllocZeroed((nuint)sizeof(Urb));
            Buffer = (byte*)NativeMemory.Alloc((nuint)size);
        }

        /// <summary>
        /// 手放す。**カーネルに返してもらっていない URB は放さない** (返ってきたときに書き込まれる)。
        /// 取り消しても返ってこないのは抜かれたときくらいで、そのぶんは捨てておく
        /// </summary>
        public void Free(UsbFsDevice device)
        {
            if (InFlight && !Done) return;
            lock (device._reap) device._pending.Remove((nint)Request);
            NativeMemory.Free(Request);
            NativeMemory.Free(Buffer);
        }
    }

    internal void Submit(AsyncUrb urb, byte type, byte endpoint)
    {
        *urb.Request = new Urb { Type = type, Endpoint = endpoint, Buffer = urb.Buffer, BufferLength = urb.Size };
        urb.Done = false;
        lock (_reap) _pending[(nint)urb.Request] = urb;
        Call(SubmitUrb, (nint)urb.Request, $"EP 0x{endpoint:x2} に読みを出せません");
        urb.InFlight = true;
    }

    /// <summary>取り消して、返ってくるまで少し待つ</summary>
    internal void Cancel(AsyncUrb urb)
    {
        if (!urb.InFlight || urb.Done) return;
        if (_fd >= 0) Sys.Ioctl(_fd, DiscardUrb, (nint)urb.Request);
        Await(urb, 500);
    }

    /// <summary>
    /// <paramref name="urb"/> が済むまで待つ。**取るのは1本のスレッドだけ** (ほかの待ち手は 1ms ずつ印を見る)。
    /// 済んだら true
    /// </summary>
    internal bool Await(AsyncUrb urb, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        var descriptor = stackalloc byte[8];
        while (!urb.Done)
        {
            var left = (int)(deadline - Environment.TickCount64);
            if (left <= 0) return false;
            if (!_reap.TryEnter())
            {
                Thread.Sleep(1);
                continue;
            }
            try
            {
                if (urb.Done) break;
                *(int*)descriptor = Fd;
                *(short*)(descriptor + 4) = PollOut;
                *(short*)(descriptor + 6) = 0;
                Sys.Poll(descriptor, 1, Math.Min(left, 20));
                ReapAll();
            }
            finally
            {
                _reap.Exit();
            }
        }
        return true;
    }

    /// <summary>済んだ URB を全部取って印を付ける。<see cref="_reap"/> を持って呼ぶ</summary>
    private void ReapAll()
    {
        for (; ; )
        {
            void* done = null;
            if (Sys.Ioctl(Fd, ReapUrbNoDelay, (nint)(&done)) < 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                if (errno == Eintr) continue;
                if (errno == Eagain) return;
                throw Failure(errno, "転送の結果を受け取れません");
            }
            if (_pending.Remove((nint)done, out var urb))
            {
                urb.InFlight = false;
                urb.Done = true;
            }
        }
    }

    public void Dispose()
    {
        if (_fd < 0) return;
        var number = 0u;
        Sys.Ioctl(_fd, ReleaseInterface, (nint)(&number));
        Sys.Close(_fd);
        _fd = -1;
    }

    /// <summary>
    /// bulk の IN の読みを出しっぱなしにする輪。**同じ端点の URB は出した順に済む**ので、頭から順に取る。
    /// 取ったものはすぐ出し直してから中身を返す (呼んだ側が他所にいる間も端点の FIFO を空け続ける)
    /// </summary>
    private sealed class UsbFsInStream : IUsbInStream
    {
        private readonly UsbFsDevice _device;
        private readonly byte _endpoint;
        private readonly AsyncUrb[] _ring;
        private int _head;
        private bool _closed;

        public UsbFsInStream(UsbFsDevice device, byte endpoint, int size, int depth)
        {
            _device = device;
            _endpoint = endpoint;
            _ring = [.. Enumerable.Range(0, depth).Select(_ => new AsyncUrb(size))];
            try
            {
                foreach (var urb in _ring) device.Submit(urb, UrbBulk, endpoint);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            ObjectDisposedException.ThrowIf(_closed, this);
            var total = 0;
            while (buffer.Length - total >= _ring[_head].Size)
            {
                var urb = _ring[_head];
                if (!urb.Done && !_device.Await(urb, total == 0 ? timeoutMs : 0)) break;
                var status = urb.Request->Status;
                var carried = urb.Request->ActualLength;
                new ReadOnlySpan<byte>(urb.Buffer, carried).CopyTo(buffer[total..]);
                total += carried;
                _device.Submit(urb, UrbBulk, _endpoint);
                _head = (_head + 1) % _ring.Length;
                if (status != 0) _device.Status(status, _endpoint);
            }
            return total;
        }

        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            foreach (var urb in _ring)
            {
                if (urb.InFlight && !urb.Done && _device._fd >= 0) Sys.Ioctl(_device._fd, DiscardUrb, (nint)urb.Request);
            }
            foreach (var urb in _ring)
            {
                if (urb.InFlight && _device._fd >= 0) _device.Await(urb, 500);
                urb.Free(_device);
            }
        }
    }
}
