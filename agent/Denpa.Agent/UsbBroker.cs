using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Denpa.Agent;

/*
 * Android のアプリから USB の機材を受け取る仕組み (USB_BROKER)。Android ではアプリしか USB の機材を開けない (UsbManager の許可が要る) ので、
 * アプリが開いた usbfs の fd を UNIX ドメインソケットの SCM_RIGHTS でエージェントに渡す。エージェントは受け取った fd を持ち、
 * 開くたびに dup して使う (UsbFsDevice.Open・UsbFsPipe.Open の、fd を受け取るほう)。
 *
 * 取り決め (docs/agent.md「Android でアプリから USB を受け取る」。設計は denpa-spec の android/design.md 3 章)
 * - エージェントが USB_BROKER のパスで待ち受け (AF_UNIX・SOCK_STREAM・0600)、アプリが繋ぐ。uid が自分と違う相手は切る
 *   (bind から chmod までの間に umask の権限で繋がれても、uid で切る。置き場はアプリだけが読める dataDir)
 * - 1 行 1 つの JSON (UTF-8)。`type` が attached・detached・synced。1 行は 1 回の write で送り、attached の write に fd を SCM_RIGHTS で 1 つ付ける
 *   (fd がどの行のものかは、fd を受け取った recvmsg の中で始まった最後の行で決める)
 * - 繋がるたびに、前の接続で受け取った機材を捨てる。接続が切れただけでは捨てない (アプリが終了しても受け取った fd は使える)。
 *   synced (許可のある機材を全部送り終えた印) を受けたら探し直してもらう (changed)。
 *   synced のあとの attached・detached も、受けるたびに changed を呼ぶ
 */

/// <summary>
/// Android のアプリから USB の機材を受け取る <see cref="IUsbHost"/> (<c>USB_BROKER</c>)。並べるのは受け取った機材の表で、
/// 並びはポートの名前の順 (sysfs と同じ)。ポートの名前は fd の <c>USBDEVFS_CONNINFO_EX</c> から作る。
/// カーネルのドライバは見ない (<see cref="UsbFound.Driver"/> は null。使われていれば確保するときに断られる)
/// </summary>
/// <param name="socketPath">待ち受けるソケットのパス (<c>USB_BROKER</c>)</param>
[SupportedOSPlatform("linux")]
public sealed unsafe partial class BrokerUsbHost(string socketPath) : IUsbHost
{
    /// <summary>受け取った機材 1 台。<paramref name="Name"/> はアプリの側の名前 (<c>/dev/bus/usb/001/004</c>)</summary>
    private sealed record Held(UsbFound Found, string Name, int Fd);

    /// <summary>1 行の上限。超える行を送る相手は切る</summary>
    private const int MaxLine = 64 * 1024;

    /// <summary>止まる合図と、新しい接続や行が届いたかを確かめる間隔</summary>
    private const int PollMs = 200;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Held> _held = new(StringComparer.Ordinal);
    private Action? _changed;
    /// <summary>いま受けている接続。新しく繋がったら古いほうは切る</summary>
    private int _connection = -1;
    private long _generation;
    private bool _synced;
    private volatile bool _stopped;

    public IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids)
    {
        lock (_gate) return [.. Sorted().Where(found => ids.Contains(new UsbId(found.Vendor, found.Product)))];
    }

    public UsbFound? Peek(string port)
    {
        lock (_gate) return _held.TryGetValue(port, out var held) ? held.Found : null;
    }

    public IReadOnlyList<UsbFound> Readers()
    {
        lock (_gate) return [.. Sorted().Where(found => found.Interfaces.Any(entry => entry.Class == Ccid.InterfaceClass))];
    }

    // 開くあいだは表のロックを取る (detached で閉じる fd を複製しないように)
    public IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true)
    {
        lock (_gate) return UsbFsDevice.Open(Received(port), port, vendor, product, selectAlternate);
    }

    public ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber)
    {
        lock (_gate) return UsbFsPipe.Open(Received(port), port, vendor, product, config, interfaceNumber);
    }

    /// <summary>
    /// そのポートの機材の fd を、子プロセスに継がせる形 (close-on-exec の無い複製) で返す。asicend の <c>--fd</c> に渡す (Asicen.cs)。
    /// 並びは <paramref name="ports"/> の順。受け取っていないポートがあれば <see cref="IOException"/>
    /// </summary>
    public InheritedFds Lend(IReadOnlyList<string> ports)
    {
        lock (_gate) return InheritedFds.Duplicate([.. ports.Select(port => (Received(port), port))]);
    }

    public Action<string, TimeSpan>? PowerCycle => null;

    /// <summary>
    /// ソケットで待ち受け始める。前に起動したときのソケットが残っていれば消して作り直す。待ち受けられなければ記録に出し、受け取らずに続ける。
    /// 1 つの <see cref="BrokerUsbHost"/> で 1 回だけ呼べる
    /// </summary>
    public IDisposable Watch(Action changed)
    {
        lock (_gate)
        {
            if (_changed is not null) throw new InvalidOperationException("USB_BROKER はもう待ち受けています");
            _changed = changed;
        }
        int listen;
        try
        {
            listen = Listen(socketPath);
        }
        catch (IOException error)
        {
            Log.Write($"USB_BROKER ({socketPath}) で待ち受けられないので、アプリから USB の機材を受け取りません ({error.Message})");
            return new NoWatch();
        }
        new Thread(() => Accept(listen)) { IsBackground = true, Name = "usb-broker" }.Start();
        return new Stop(this);
    }

    private sealed class Stop(BrokerUsbHost host) : IDisposable
    {
        public void Dispose() => host.Close();
    }

    /// <summary>待ち受けをやめ (ソケットのファイルは待ち受けの側が消す)、受け取った fd を閉じる</summary>
    private void Close()
    {
        _stopped = true;
        lock (_gate)
        {
            if (_connection >= 0) Native.Shutdown(_connection, ShutReadWrite);
            // 受けている途中の行が、閉じたあとの表に fd を足さないように
            _generation++;
            Drop();
        }
    }

    private IEnumerable<UsbFound> Sorted() => _held.Values.Select(held => held.Found).OrderBy(found => found.Port, StringComparer.Ordinal);

    private int Received(string port) =>
        _held.TryGetValue(port, out var held) ? held.Fd : throw new IOException($"USB のポート {port} に機材がありません (抜かれたか、アプリから受け取っていません)");

    /// <summary>受け取った機材を全部捨てる。_gate の中で呼ぶ</summary>
    private void Drop()
    {
        foreach (var held in _held.Values) Sys.Close(held.Fd);
        _held.Clear();
    }

    private void Accept(int listen)
    {
        try
        {
            while (!_stopped)
            {
                if (!Readable(listen)) continue;
                var fd = Native.Accept4(listen, null, null, SockCloseOnExec);
                if (fd < 0)
                {
                    var errno = Marshal.GetLastPInvokeError();
                    if (errno is UsbFs.Eintr or UsbFs.Eagain or ConnectionAborted) continue;
                    Log.Write($"USB_BROKER の接続を受けられなくなりました ({Marshal.GetPInvokeErrorMessage(errno)})");
                    return;
                }
                if (!SameUser(fd))
                {
                    Log.Write("USB_BROKER に別のユーザーが繋いできたので切りました");
                    Sys.Close(fd);
                    continue;
                }
                long generation;
                lock (_gate)
                {
                    // 止めたあとに受けた接続は使わない
                    if (_stopped)
                    {
                        Sys.Close(fd);
                        return;
                    }
                    // 繋ぎ直したアプリは許可のある機材を全部送り直すので、前の接続で受け取ったものは捨てる
                    if (_connection >= 0) Native.Shutdown(_connection, ShutReadWrite);
                    _connection = fd;
                    generation = ++_generation;
                    _synced = false;
                    Drop();
                }
                new Thread(() => Serve(fd, generation)) { IsBackground = true, Name = "usb-broker-connection" }.Start();
            }
        }
        finally
        {
            Sys.Close(listen);
            Native.Unlink(socketPath);
        }
    }

    /// <summary>1 つの接続の行を読む。切れたか、新しい接続に替わったら終わる</summary>
    private void Serve(int fd, long generation)
    {
        // 行の番号ごとの、その行の write に付いてきた fd
        var owned = new Dictionary<long, List<int>>();
        var received = new List<int>();
        // 組み立てている行の番号
        var index = 0L;
        var line = new List<byte>();
        var data = new byte[4096];
        var control = stackalloc byte[ControlSize];
        try
        {
            while (!_stopped && Current(generation))
            {
                if (!Readable(fd)) continue;
                received.Clear();
                var got = Receive(fd, data, control, received, out var truncated);
                if (got == 0) return;
                if (got < 0)
                {
                    if (Marshal.GetLastPInvokeError() is UsbFs.Eintr or UsbFs.Eagain) continue;
                    return;
                }
                if (truncated) Log.Write("USB_BROKER から一度に受け取れる数を超える fd が届いたので、超えたぶんを捨てました");
                var chunk = data.AsSpan(0, (int)got);
                if (received.Count > 0)
                {
                    // カーネルは fd の付いた write を読んだところで recvmsg を返す (fd の違う write を 1 回の recvmsg に混ぜない) ので、
                    // fd はこの recvmsg の中で始まった最後の行のもの。行の終わりの改行の後ろは、次の recvmsg で始まる行
                    var owner = index + chunk[..^1].Count((byte)'\n');
                    if (!owned.TryGetValue(owner, out var list)) owned[owner] = list = [];
                    list.AddRange(received);
                }
                foreach (var b in chunk)
                {
                    if (b != (byte)'\n')
                    {
                        line.Add(b);
                        if (line.Count <= MaxLine) continue;
                        Log.Write($"USB_BROKER から {MaxLine} バイトを超える行が届いたので切りました");
                        return;
                    }
                    owned.Remove(index, out var fds);
                    try
                    {
                        Handle(Encoding.UTF8.GetString([.. line]), fds ?? [], generation);
                    }
                    catch (Exception error)
                    {
                        // 受けるスレッドで例外を外に出すとエージェントのプロセスが終了するので、その行だけを捨てる (changed の中の失敗も同じ)
                        Log.Write($"USB_BROKER の行を受けられませんでした ({error.Message})");
                    }
                    index++;
                    line.Clear();
                }
            }
        }
        finally
        {
            // 行が終わらないうちに切れた
            foreach (var left in owned.Values.SelectMany(list => list)) Sys.Close(left);
            lock (_gate)
            {
                if (_connection == fd) _connection = -1;
            }
            Sys.Close(fd);
        }
    }

    private bool Current(long generation)
    {
        lock (_gate) return generation == _generation;
    }

    /// <summary>1 行を受ける。attached は受け取った fd を 1 つ使う。読めない行は記録に出して捨てる</summary>
    private void Handle(string text, List<int> fds, long generation)
    {
        JsonObject? message;
        try
        {
            message = JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            message = null;
        }
        var type = Text(message, "type");
        // attached は 1 つ目の fd を使い、ほかの行と余った fd は閉じる
        var fd = type == "attached" && fds.Count > 0 ? fds[0] : -1;
        foreach (var extra in fds.Where(item => item != fd)) Sys.Close(extra);
        Action? notify = null;
        switch (type)
        {
            case "attached":
            {
                if (fd < 0)
                {
                    Log.Write("USB_BROKER から fd の付いていない attached が届いたので捨てました");
                    return;
                }
                var name = Text(message, "name");
                var vendor = Id(message, "vendor");
                var product = Id(message, "product");
                if (name is null || vendor is null || product is null || PortOf(fd, name) is not { } port)
                {
                    Log.Write($"USB_BROKER から読めない attached が届いたので捨てました ({name ?? "名前なし"})");
                    Sys.Close(fd);
                    return;
                }
                var found = new UsbFound(port, vendor.Value, product.Value, Text(message, "serial"), Text(message, "manufacturer"),
                    Text(message, "productName"), null, Interfaces(message!["interfaces"]));
                lock (_gate)
                {
                    if (generation != _generation)
                    {
                        Sys.Close(fd);
                        return;
                    }
                    // 同じ機材を送り直されたら、前に受け取った fd を閉じて入れ替える
                    foreach (var same in _held.Values.Where(held => held.Name == name || held.Found.Port == port).ToList())
                    {
                        Sys.Close(same.Fd);
                        _held.Remove(same.Found.Port);
                    }
                    _held[port] = new Held(found, name, fd);
                    if (_synced) notify = _changed;
                }
                Log.Write($"アプリから USB の機材を受け取りました: {port} ({vendor:x4}:{product:x4})");
                break;
            }
            case "detached":
            {
                var name = Text(message, "name");
                Held? gone;
                lock (_gate)
                {
                    if (generation != _generation) return;
                    gone = _held.Values.FirstOrDefault(held => held.Name == name);
                    if (gone is null) return;
                    Sys.Close(gone.Fd);
                    _held.Remove(gone.Found.Port);
                    if (_synced) notify = _changed;
                }
                Log.Write($"抜かれた USB の機材を外しました: {gone.Found.Port} ({name})");
                break;
            }
            case "synced":
            {
                int count;
                lock (_gate)
                {
                    if (generation != _generation) return;
                    _synced = true;
                    count = _held.Count;
                    notify = _changed;
                }
                Log.Write($"アプリから USB の機材を {count} 台受け取りました");
                break;
            }
            case var other:
                Log.Write($"USB_BROKER から読めない行が届いたので捨てました ({other ?? "type なし"})");
                return;
        }
        notify?.Invoke();
    }

    private static string? Text(JsonObject? message, string key) =>
        message?[key] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length > 0 ? text : null;

    /// <summary>USB の ID (0〜0xffff の数)。無い・範囲の外なら null</summary>
    private static int? Id(JsonObject? message, string key) =>
        message?[key] is JsonValue value && value.TryGetValue<int>(out var id) && id is >= 0 and <= 0xffff ? id : null;

    /// <summary><c>[{"config":1,"number":0,"class":11}]</c>。読めない項は飛ばす</summary>
    private static List<(int Config, int Number, int Class)> Interfaces(JsonNode? node)
    {
        var found = new List<(int, int, int)>();
        if (node is not JsonArray list) return found;
        foreach (var item in list)
        {
            if (item is not JsonObject entry) continue;
            if (Byte(entry, "config") is { } config && Byte(entry, "number") is { } number && Byte(entry, "class") is { } kind) found.Add((config, number, kind));
        }
        return found;
    }

    private static int? Byte(JsonObject entry, string key) =>
        entry[key] is JsonValue value && value.TryGetValue<int>(out var number) && number is >= 0 and <= 0xff ? number : null;

    /// <summary>
    /// fd の機材のポートの名前。<c>USBDEVFS_CONNINFO_EX</c> (Linux 5.3 から) で <c>1-2.3</c> を作る。使えないカーネルでは
    /// アプリの側の名前 (<c>/dev/bus/usb/001/004</c>) から <c>001-004</c> を作る (挿し直すと変わる)。どちらも作れなければ null
    /// </summary>
    internal static string? PortOf(int fd, string name)
    {
        var info = new ConnectionInfo { Size = (uint)sizeof(ConnectionInfo) };
        if (Sys.Ioctl(fd, ConnectionInfoRequest, (nint)(&info)) == 0
            && PortName(info.Bus, new ReadOnlySpan<byte>(info.Ports, Math.Min((int)info.PortCount, ConnectionInfo.MaxPorts))) is { } port)
        {
            return port;
        }
        return FallbackPort(name);
    }

    /// <summary>バスの番号とハブのポートの並びから、sysfs と同じ名前 (<c>1-2.3</c>)。ルートハブ (並びが空) は null</summary>
    internal static string? PortName(uint bus, ReadOnlySpan<byte> ports) =>
        bus == 0 || ports.Length == 0 ? null : $"{bus}-{string.Join('.', ports.ToArray())}";

    /// <summary><c>/dev/bus/usb/001/004</c> から <c>001-004</c>。形式が違えば null</summary>
    internal static string? FallbackPort(string name) =>
        DeviceName().Match(name) is { Success: true } match ? $"{match.Groups[1].Value}-{match.Groups[2].Value}" : null;

    [GeneratedRegex(@"^/dev/bus/usb/(\d{3})/(\d{3})$")]
    private static partial Regex DeviceName();

    /// <summary>ソケットを作って待ち受ける。持ち主だけが読み書きできるようにする (0600)</summary>
    private static int Listen(string path)
    {
        var bytes = Encoding.UTF8.GetBytes(path);
        if (bytes.Length is 0 or > SocketAddress.MaxPath) throw new IOException($"パスは 1〜{SocketAddress.MaxPath} バイトです ({bytes.Length} バイト)");
        var fd = Native.Socket(AfUnix, SockStream | SockCloseOnExec, 0);
        if (fd < 0) throw new IOException($"ソケットを作れません ({Marshal.GetLastPInvokeErrorMessage()})");
        try
        {
            // 前に起動したときのソケットが残っていると bind が EADDRINUSE になる
            Native.Unlink(path);
            var address = new SocketAddress { Family = AfUnix };
            bytes.CopyTo(new Span<byte>(address.Path, SocketAddress.MaxPath));
            if (Native.Bind(fd, &address, (uint)(sizeof(ushort) + bytes.Length + 1)) < 0) throw new IOException($"bind できません ({Marshal.GetLastPInvokeErrorMessage()})");
            if (Native.Chmod(path, OwnerReadWrite) < 0) throw new IOException($"0600 にできません ({Marshal.GetLastPInvokeErrorMessage()})");
            if (Native.Listen(fd, 4) < 0) throw new IOException($"listen できません ({Marshal.GetLastPInvokeErrorMessage()})");
            return fd;
        }
        catch
        {
            Sys.Close(fd);
            throw;
        }
    }

    /// <summary>繋いできた相手 (<c>SO_PEERCRED</c>) の uid が自分と同じか</summary>
    private static bool SameUser(int fd)
    {
        var credentials = default(Credentials);
        var length = (uint)sizeof(Credentials);
        return Native.GetSockOpt(fd, SolSocket, SoPeerCred, &credentials, &length) == 0 && credentials.Uid == Native.GetUid();
    }

    /// <summary>読めるか、切れたか。<see cref="PollMs"/> 待って何も無ければ false</summary>
    private static bool Readable(int fd)
    {
        var poll = new PollFd { Fd = fd, Events = PollIn };
        return Sys.Poll((byte*)&poll, 1, PollMs) > 0 && poll.Revents != 0;
    }

    /// <summary>読んで、付いてきた fd を <paramref name="fds"/> に足す (close-on-exec を付けて受ける)。読んだバイト数 (0 は切れた、負は失敗)</summary>
    private static nint Receive(int fd, byte[] data, byte* control, List<int> fds, out bool truncated)
    {
        fixed (byte* buffer = data)
        {
            var vector = new IoVector { Base = buffer, Length = (nuint)data.Length };
            var message = new MessageHeader { Vector = &vector, VectorLength = 1, Control = control, ControlLength = ControlSize };
            var got = Native.RecvMsg(fd, &message, MsgCmsgCloseOnExec);
            truncated = got >= 0 && (message.Flags & MsgControlTruncated) != 0;
            if (got < 0) return got;
            for (nuint at = 0; at + (nuint)sizeof(ControlHeader) <= message.ControlLength;)
            {
                var header = (ControlHeader*)(control + at);
                if (header->Length < (nuint)sizeof(ControlHeader) || at + header->Length > message.ControlLength) break;
                if (header->Level == SolSocket && header->Type == ScmRights)
                {
                    var count = (int)(header->Length - (nuint)sizeof(ControlHeader)) / sizeof(int);
                    var first = (int*)(header + 1);
                    for (var i = 0; i < count; i++) fds.Add(first[i]);
                }
                at += (header->Length + 7) & ~(nuint)7;
            }
            return got;
        }
    }

    private const int AfUnix = 1;
    private const int SockStream = 1;
    private const int SockCloseOnExec = 0x80000;
    private const int SolSocket = 1;
    private const int SoPeerCred = 17;
    private const int ScmRights = 1;
    private const int MsgControlTruncated = 0x8;
    private const int MsgCmsgCloseOnExec = 0x40000000;
    private const int ShutReadWrite = 2;
    private const int ConnectionAborted = 103;
    private const short PollIn = 0x001;
    private const int OwnerReadWrite = 0x180;

    /// <summary>1 回の recvmsg で受けられる fd の数 (CMSG_SPACE(4 × 8))</summary>
    private const int ControlSize = 16 + 8 * sizeof(int);

    /// <summary>USBDEVFS_CONNINFO_EX(len)。_IOC(_IOC_READ, 'U', 32, len)</summary>
    private static readonly uint ConnectionInfoRequest = UsbFs.Ioc(2, 32, sizeof(ConnectionInfo));

    /// <summary>struct usbdevfs_conninfo_ex (24 バイト)</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct ConnectionInfo
    {
        public const int MaxPorts = 7;
        public uint Size;
        public uint Bus;
        public uint Device;
        public uint Speed;
        public byte PortCount;
        public fixed byte Ports[MaxPorts];
    }

    /// <summary>struct sockaddr_un</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct SocketAddress
    {
        /// <summary>終わりの 0 を除いたパスの長さの上限</summary>
        public const int MaxPath = 107;
        public ushort Family;
        public fixed byte Path[MaxPath + 1];
    }

    /// <summary>struct ucred</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct Credentials
    {
        public int Pid;
        public uint Uid;
        public uint Gid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoVector
    {
        public byte* Base;
        public nuint Length;
    }

    /// <summary>struct msghdr (64bit。glibc も bionic も同じ並び)</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct MessageHeader
    {
        public void* Name;
        public uint NameLength;
        public void* Vector;
        public nuint VectorLength;
        public byte* Control;
        public nuint ControlLength;
        public int Flags;
    }

    /// <summary>struct cmsghdr (64bit では 16 バイト。中身はこの後ろに続く)</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ControlHeader
    {
        public nuint Length;
        public int Level;
        public int Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PollFd
    {
        public int Fd;
        public short Events;
        public short Revents;
    }

    private static partial class Native
    {
        [LibraryImport("libc", EntryPoint = "socket", SetLastError = true)]
        public static partial int Socket(int domain, int type, int protocol);

        [LibraryImport("libc", EntryPoint = "bind", SetLastError = true)]
        public static partial int Bind(int fd, SocketAddress* address, uint length);

        [LibraryImport("libc", EntryPoint = "listen", SetLastError = true)]
        public static partial int Listen(int fd, int backlog);

        [LibraryImport("libc", EntryPoint = "accept4", SetLastError = true)]
        public static partial int Accept4(int fd, void* address, uint* length, int flags);

        [LibraryImport("libc", EntryPoint = "recvmsg", SetLastError = true)]
        public static partial nint RecvMsg(int fd, MessageHeader* message, int flags);

        [LibraryImport("libc", EntryPoint = "getsockopt", SetLastError = true)]
        public static partial int GetSockOpt(int fd, int level, int name, void* value, uint* length);

        [LibraryImport("libc", EntryPoint = "shutdown", SetLastError = true)]
        public static partial int Shutdown(int fd, int how);

        [LibraryImport("libc", EntryPoint = "getuid")]
        public static partial uint GetUid();

        [LibraryImport("libc", EntryPoint = "chmod", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
        public static partial int Chmod(string path, uint mode);

        [LibraryImport("libc", EntryPoint = "unlink", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
        public static partial int Unlink(string path);
    }
}
