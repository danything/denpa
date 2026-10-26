using System.Globalization;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// Linux の usbfs (<c>/dev/bus/usb/BBB/DDD</c>) を ioctl で直に扱う <see cref="IUsbDevice"/>。**libusb を使わない。**
///
/// <para>
/// ioctl の番号と構造体の形はカーネルの uapi (<c>linux/usbdevice_fs.h</c>) のもの。x64 と arm64 で同じ (どちらも LP64 で
/// asm-generic の <c>_IOC</c> の並び)。構造体の大きさは番号に埋まるので <c>sizeof</c> から組み立てる (<see cref="UsbFsPipe"/> と同じ)。
/// interrupt の IN も <c>USBDEVFS_BULK</c> で読む (カーネルの <c>usb_bulk_msg</c> は interrupt の端点なら interrupt の URB にする)。
/// 出しっぱなしの読みは <c>USBDEVFS_SUBMITURB</c> で URB を出し、<c>poll</c> で待って <c>USBDEVFS_REAPURBNDELAY</c> で回収する。
/// </para>
/// </summary>
public sealed unsafe class UsbFsDevice : IUsbDevice
{
    /// <summary>struct usbdevfs_ctrltransfer (64bit では 24 バイト)</summary>
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

    /// <summary>struct usbdevfs_setinterface</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct SetInterfaceRequest
    {
        public uint Interface;
        public uint AltSetting;
    }

    /// <summary>struct usbdevfs_urb (iso の並びは使わないので持たない。64bit では 56 バイト)</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct Urb
    {
        public byte Type;
        public byte Endpoint;
        public int Status;
        public uint Flags;
        public void* Buffer;
        public int BufferLength;
        public int ActualLength;
        public int StartFrame;
        public int NumberOfPackets;
        public int ErrorCount;
        public uint SignalNumber;
        public void* UserContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PollFd
    {
        public int Fd;
        public short Events;
        public short Revents;
    }

    private static uint Ioc(uint direction, uint number, int size) =>
        (direction << 30) | ((uint)size << 16) | ('U' << 8) | number;

    // _IOC_WRITE = 1、_IOC_READ = 2
    internal static readonly uint Control = Ioc(3, 0, sizeof(ControlTransfer));
    internal static readonly uint SetInterface = Ioc(2, 4, sizeof(SetInterfaceRequest));
    internal static readonly uint SubmitUrb = Ioc(2, 10, sizeof(Urb));
    internal static readonly uint DiscardUrb = Ioc(0, 11, 0);
    internal static readonly uint ReapUrbNoDelay = Ioc(1, 13, sizeof(void*));
    internal static readonly uint ClearHalt = Ioc(2, 21, sizeof(uint));

    private const byte UrbTypeBulk = 3;
    private const short PollOut = 0x004;
    private const int CloseOnExec = 0x80000;

    /// <summary>EP の止まりや化けで続けて捨ててよい読みの数。超えたら読みを失敗で終える</summary>
    private const int MaxStalls = 8;

    private const int Eperm = 1;
    private const int Enoent = 2;
    private const int Eintr = 4;
    private const int Eagain = 11;
    private const int Eacces = 13;
    private const int Ebusy = 16;
    private const int Enodev = 19;
    private const int Epipe = 32;
    private const int Etimedout = 110;
    private const int Eshutdown = 108;
    private const int Eproto = 71;

    private readonly Lock _gate = new();
    private int _fd;

    public string Name { get; }

    private UsbFsDevice(string name, int fd)
    {
        Name = name;
        _fd = fd;
    }

    /// <summary>
    /// sysfs のポート (<c>4-12.1</c>) の機材を開き、USB の ID を突き合わせ、インターフェース 0 を確保して代替設定 0 を選ぶ。
    /// 番号 (<c>DDD</c>) は挿し直すたびに振り直されるので、見つけてから開くまでに挿し替わっていないかを ID で確かめる
    /// </summary>
    public static UsbFsDevice Open(string sysfs, string devUsb, string port, int vendor, int product)
    {
        var dir = Path.Combine(sysfs, port);
        if (!int.TryParse(UsbSysfs.Read(dir, "busnum"), NumberStyles.None, CultureInfo.InvariantCulture, out var bus)
            || !int.TryParse(UsbSysfs.Read(dir, "devnum"), NumberStyles.None, CultureInfo.InvariantCulture, out var device))
        {
            throw new IOException($"USB のポート {port} に機材がありません (抜かれたか、コンテナに /sys が見えていません)");
        }
        var path = Path.Combine(devUsb, bus.ToString("D3", CultureInfo.InvariantCulture), device.ToString("D3", CultureInfo.InvariantCulture));
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
        try
        {
            // usbfs の fd を読むと、先頭にデバイスディスクリプタが返る
            var head = stackalloc byte[18];
            var got = Sys.ReadFd(fd, head, 18);
            var (v, p) = UsbDescriptors.Ids(new ReadOnlySpan<byte>(head, (int)Math.Max(got, 0)));
            if (v != vendor || p != product) throw new IOException($"{path} は別の機材になっています ({v:x4}:{p:x4})。挿し直されました");

            var number = 0u;
            if (Sys.Ioctl(fd, UsbFsPipe.ClaimInterface, (nint)(&number)) < 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                throw new IOException(errno == Ebusy
                    ? $"USB のポート {port} の機材はほかのソフトが使っています (動いているエージェント自身か、カーネルのドライバ)"
                    : $"USB のポート {port} のインターフェースを確保できません ({Marshal.GetPInvokeErrorMessage(errno)})");
            }
            var request = new SetInterfaceRequest { Interface = 0, AltSetting = 0 };
            if (Sys.Ioctl(fd, SetInterface, (nint)(&request)) < 0)
            {
                throw new IOException($"USB のポート {port} の代替設定を選べません ({Marshal.GetPInvokeErrorMessage(Marshal.GetLastPInvokeError())})");
            }
            return new UsbFsDevice($"usb {port}", fd);
        }
        catch
        {
            Sys.Close(fd);
            throw;
        }
    }

    private int Fd => _fd >= 0 ? _fd : throw new ObjectDisposedException(Name);

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        CheckLength(data.Length);
        fixed (byte* start = data)
        {
            var transfer = new ControlTransfer
            {
                RequestType = requestType, Request = request, Value = value, Index = index,
                Length = (ushort)data.Length, TimeoutMs = (uint)timeoutMs, Data = start,
            };
            var got = Sys.Ioctl(Fd, Control, (nint)(&transfer));
            if (got < 0) throw Failure("制御転送 (IN)");
            return got;
        }
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        CheckLength(data.Length);
        fixed (byte* start = data)
        {
            var transfer = new ControlTransfer
            {
                RequestType = requestType, Request = request, Value = value, Index = index,
                Length = (ushort)data.Length, TimeoutMs = (uint)timeoutMs, Data = start,
            };
            var sent = Sys.Ioctl(Fd, Control, (nint)(&transfer));
            if (sent < 0) throw Failure("制御転送 (OUT)");
            if (sent != data.Length) throw new IOException($"{Name}: 制御転送で送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    /// <summary>制御転送の長さは wLength (16 ビット) に収まるだけ</summary>
    private static void CheckLength(int length)
    {
        if (length > ushort.MaxValue) throw new ArgumentOutOfRangeException(nameof(length), $"制御転送は {ushort.MaxValue} バイトまでです ({length} バイト)");
    }

    public int BulkRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Transfer(endpoint, buffer, timeoutMs);

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs) => Transfer(endpoint, buffer, timeoutMs);

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        fixed (byte* start = data)
        {
            var transfer = new UsbFsPipe.BulkTransfer { Endpoint = endpoint, Length = (uint)data.Length, TimeoutMs = (uint)timeoutMs, Data = start };
            var sent = Sys.Ioctl(Fd, UsbFsPipe.Bulk, (nint)(&transfer));
            if (sent < 0) throw Failure($"EP 0x{endpoint:X2} に送れません");
            if (sent != data.Length) throw new IOException($"{Name}: EP 0x{endpoint:X2} に送りきれません ({sent}/{data.Length} バイト)");
        }
    }

    /// <summary>IN を1回。時間切れは 0</summary>
    private int Transfer(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        fixed (byte* start = buffer)
        {
            var transfer = new UsbFsPipe.BulkTransfer { Endpoint = endpoint, Length = (uint)buffer.Length, TimeoutMs = (uint)timeoutMs, Data = start };
            var got = Sys.Ioctl(Fd, UsbFsPipe.Bulk, (nint)(&transfer));
            if (got >= 0) return got;
            if (Marshal.GetLastPInvokeError() == Etimedout) return 0;
            throw Failure($"EP 0x{endpoint:X2} から読めません");
        }
    }

    private IOException Failure(string what) => Failure(Name, what, Marshal.GetLastPInvokeError());

    internal static IOException Failure(string name, string what, int errno) => errno switch
    {
        Enodev or Eshutdown => new UsbGoneException($"{name} が抜かれました"),
        Etimedout => new IOException($"{name}: {what} (時間切れ)"),
        _ => new IOException($"{name}: {what} ({Marshal.GetPInvokeErrorMessage(errno)})"),
    };

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth) => new InStream(this, endpoint, transferSize, depth);

    public void Dispose()
    {
        lock (_gate)
        {
            if (_fd < 0) return;
            var number = 0u;
            Sys.Ioctl(_fd, UsbFsPipe.ReleaseInterface, (nint)(&number));
            Sys.Close(_fd);
            _fd = -1;
        }
    }

    /// <summary>
    /// URB を出しっぱなしにする読み。URB と受け口はアンマネージドのメモリに置く (カーネルが書き込むあいだ動かないように)。
    /// 1本の端点の URB は出した順に済むので、先頭の URB から順に詰めて出し直す
    /// </summary>
    private sealed class InStream : IUsbInStream
    {
        private readonly UsbFsDevice _owner;
        private readonly Urb*[] _urbs;
        private readonly bool[] _done;
        private readonly bool[] _pending;
        private int _head;
        private int _offset;
        private int _stalls;
        private bool _closed;

        public InStream(UsbFsDevice owner, byte endpoint, int transferSize, int depth)
        {
            _owner = owner;
            _urbs = new Urb*[depth];
            _done = new bool[depth];
            _pending = new bool[depth];
            try
            {
                for (var i = 0; i < depth; i++)
                {
                    var urb = (Urb*)NativeMemory.AllocZeroed((nuint)sizeof(Urb));
                    urb->Type = UrbTypeBulk;
                    urb->Endpoint = endpoint;
                    urb->Buffer = NativeMemory.Alloc((nuint)transferSize);
                    urb->BufferLength = transferSize;
                    urb->UserContext = (void*)(nint)i;
                    _urbs[i] = urb;
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
            var urb = _urbs[i];
            urb->Status = 0;
            urb->ActualLength = 0;
            if (Sys.Ioctl(_owner.Fd, SubmitUrb, (nint)urb) < 0) throw _owner.Failure("TS の読みを出せません");
            _pending[i] = true;
            _done[i] = false;
        }

        /// <summary>済んだ URB を全部回収する。1つでも回収したら true</summary>
        private bool Reap()
        {
            var any = false;
            for (; ; )
            {
                Urb* urb = null;
                if (Sys.Ioctl(_owner.Fd, ReapUrbNoDelay, (nint)(&urb)) < 0)
                {
                    var errno = Marshal.GetLastPInvokeError();
                    if (errno is Eagain or Eintr) return any;
                    throw Failure(_owner.Name, "TS の読みを回収できません", errno);
                }
                var i = (int)(nint)urb->UserContext;
                _pending[i] = false;
                _done[i] = true;
                any = true;
            }
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            ObjectDisposedException.ThrowIf(_closed, this);
            var deadline = Environment.TickCount64 + timeoutMs;
            for (; ; )
            {
                Reap();
                var copied = 0;
                while (copied < buffer.Length && _done[_head])
                {
                    var urb = _urbs[_head];
                    if (urb->Status != 0) Fail(urb);
                    else _stalls = 0;
                    var left = urb->ActualLength - _offset;
                    var take = Math.Min(left, buffer.Length - copied);
                    new ReadOnlySpan<byte>((byte*)urb->Buffer + _offset, take).CopyTo(buffer[copied..]);
                    copied += take;
                    _offset += take;
                    if (_offset < urb->ActualLength) break;
                    _offset = 0;
                    Submit(_head);
                    _head = (_head + 1) % _urbs.Length;
                }
                if (copied > 0) return copied;
                var wait = deadline - Environment.TickCount64;
                if (wait <= 0) return 0;
                var poll = new PollFd { Fd = _owner.Fd, Events = PollOut };
                if (Sys.Poll((byte*)&poll, 1, (int)Math.Min(wait, int.MaxValue)) < 0 && Marshal.GetLastPInvokeError() != Eintr)
                {
                    throw _owner.Failure("TS の読みを待てません");
                }
            }
        }

        /// <summary>
        /// 済んだ URB の失敗。端点の止まり (EPIPE) は止まりを解いて (USBDEVFS_CLEAR_HALT)、化け (EPROTO) はそのまま、その URB の中身だけ捨てて
        /// 出し直す。続けて <see cref="MaxStalls"/> 回を超えたら読みを失敗で終える
        /// </summary>
        private void Fail(Urb* urb)
        {
            var errno = -urb->Status;
            if (errno is not (Epipe or Eproto)) throw Failure(_owner.Name, "TS の読みが失敗しました", errno);
            if (++_stalls > MaxStalls) throw Failure(_owner.Name, $"TS の読みが続けて {_stalls} 回失敗しました", errno);
            if (errno == Epipe)
            {
                var endpoint = (uint)urb->Endpoint;
                if (Sys.Ioctl(_owner.Fd, ClearHalt, (nint)(&endpoint)) < 0) throw _owner.Failure($"EP 0x{endpoint:X2} の止まりを解けません");
            }
            urb->ActualLength = 0;
        }

        /// <summary>出していた URB を取り消して、全部回収してから受け口を返す</summary>
        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            var fd = _owner._fd;
            if (fd >= 0)
            {
                for (var i = 0; i < _urbs.Length; i++)
                {
                    if (_urbs[i] is not null && _pending[i]) Sys.Ioctl(fd, DiscardUrb, (nint)_urbs[i]);
                }
                var deadline = Environment.TickCount64 + 1000;
                while (_pending.Any(pending => pending) && Environment.TickCount64 < deadline)
                {
                    try
                    {
                        if (!Reap()) Thread.Sleep(1);
                    }
                    catch (IOException)
                    {
                        break;
                    }
                }
                // 回収できなかった URB の受け口は、カーネルがまだ持っているかもしれないので返さない
                if (_pending.Count(pending => pending) is var left and > 0)
                {
                    Log.Write($"[{_owner.Name}] TS の読みを {left} 本回収できなかったので、受け口を返さずに残します");
                    return;
                }
            }
            foreach (var urb in _urbs)
            {
                if (urb is null) continue;
                NativeMemory.Free(urb->Buffer);
                NativeMemory.Free(urb);
            }
        }
    }
}
