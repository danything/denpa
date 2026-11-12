using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * Android のアプリから USB を受け取る仕組み (UsbBroker.cs)。偽のアプリがソケットに繋ぎ、memfd に書いたディスクリプタの fd を
 * SCM_RIGHTS で送る。memfd は usbfs ではないので、ポートの名前は名前から作る側 (CONNINFO_EX が使えないカーネルと同じ) になり、
 * インターフェースの確保 (USBDEVFS_CLAIMINTERFACE) は断られる。確かめるのは、その手前まで (受け取る・並べる・dup して先頭から読む)
 */
[RunOn(OS.Linux)]
[SupportedOSPlatform("linux")]
public sealed partial class UsbBrokerTests
{
    /// <summary>エージェントの側。待ち受けて、changed を数える</summary>
    private sealed class Agent : IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("denpa-broker-").FullName;
        private readonly IDisposable _watch;
        private readonly SemaphoreSlim _changed = new(0);

        public string Path { get; }
        public BrokerUsbHost Host { get; }

        public Agent()
        {
            Path = System.IO.Path.Combine(_dir, "u");
            Host = new BrokerUsbHost(Path);
            _watch = Host.Watch(() => _changed.Release());
        }

        public async Task Changed()
        {
            if (!await _changed.WaitAsync(TimeSpan.FromSeconds(10))) throw new TimeoutException("changed が呼ばれません");
        }

        /// <summary>まだ受けていない changed の数</summary>
        public int Pending => _changed.CurrentCount;

        public void Dispose()
        {
            _watch.Dispose();
            // 待ち受けの側がソケットを消すまで待つ
            for (var i = 0; i < 50 && File.Exists(Path); i++) Thread.Sleep(100);
            Directory.Delete(_dir, recursive: true);
        }
    }

    /// <summary>偽のアプリ。1 行ずつ送り、attached には fd を付ける</summary>
    private sealed unsafe class App : IDisposable
    {
        private readonly int _fd;

        private App(int fd) => _fd = fd;

        public static App Connect(string path)
        {
            var deadline = Environment.TickCount64 + 10_000;
            for (; ; )
            {
                var fd = Native.Socket(1, 1, 0);
                var address = new SocketAddress { Family = 1 };
                var bytes = Encoding.UTF8.GetBytes(path);
                bytes.CopyTo(new Span<byte>(address.Path, 108));
                if (Native.Connect(fd, &address, (uint)(2 + bytes.Length + 1)) == 0) return new App(fd);
                Native.Close(fd);
                if (Environment.TickCount64 > deadline) throw new TimeoutException($"{path} に繋げません");
                Thread.Sleep(50);
            }
        }

        public void Send(string line, int fd = -1)
        {
            var data = Encoding.UTF8.GetBytes(line + "\n");
            var control = stackalloc byte[24];
            fixed (byte* start = data)
            {
                var vector = new IoVector { Base = start, Length = (nuint)data.Length };
                var message = new MessageHeader { Vector = &vector, VectorLength = 1 };
                if (fd >= 0)
                {
                    // struct cmsghdr { len = CMSG_LEN(4) = 20, SOL_SOCKET, SCM_RIGHTS } と fd
                    *(nuint*)control = 20;
                    *(int*)(control + 8) = 1;
                    *(int*)(control + 12) = 1;
                    *(int*)(control + 16) = fd;
                    message.Control = control;
                    message.ControlLength = 24;
                }
                if (Native.SendMsg(_fd, &message, 0) != data.Length) throw new IOException($"送れません ({Marshal.GetLastPInvokeErrorMessage()})");
            }
        }

        public void Dispose() => Native.Close(_fd);
    }

    /// <summary>中身を書いた memfd。書いたあとの位置は末尾 (先頭から読むなら pread が要る)</summary>
    private static unsafe int Memfd(byte[] content, string name = "usb")
    {
        var fd = Native.MemfdCreate(name, 1);
        fixed (byte* start = content)
        {
            if (fd < 0 || Native.Write(fd, start, (nuint)content.Length) != content.Length) throw new IOException("memfd を作れません");
        }
        return fd;
    }

    /// <summary>
    /// <paramref name="fd"/> を付けて attached を送り、送った側の fd は閉じる (アプリが持っていても、
    /// エージェントが受け取ったものは別の fd なので変わらない)
    /// </summary>
    private static void Attach(App app, string name, int vendor, int product, byte[] descriptors, string interfaces = "[]", string serial = "null", string memfd = "usb")
    {
        var fd = Memfd(descriptors, memfd);
        app.Send($$"""{"type":"attached","name":"{{name}}","vendor":{{vendor}},"product":{{product}},"serial":{{serial}},"manufacturer":"Gemalto","productName":"PC Twin Reader","interfaces":{{interfaces}}}""", fd);
        Native.Close(fd);
    }

    /// <summary>デバイスディスクリプタだけ (18 バイト)</summary>
    private static byte[] DeviceDescriptor(int vendor, int product) =>
        [18, 1, 0x00, 0x02, 0, 0, 0, 64, (byte)vendor, (byte)(vendor >> 8), (byte)product, (byte)(product >> 8), 0, 1, 1, 2, 3, 1];

    private const string Reader = """[{"config":1,"number":0,"class":11}]""";

    [Test]
    public async Task 待ち受けるソケットは持ち主だけが読み書きでき_止めると消える()
    {
        string path;
        using (var agent = new Agent())
        {
            path = agent.Path;
            using var app = App.Connect(agent.Path);
            await Assert.That(File.GetUnixFileMode(agent.Path)).IsEqualTo(UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        await Assert.That(File.Exists(path)).IsFalse();
    }

    [Test]
    public async Task synced_を受けたら探し直してもらい_何も受け取っていなければ一覧は空()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        app.Send("""{"type":"synced"}""");
        await agent.Changed();
        await Assert.That(agent.Host.List([new UsbId(0x0511, 0x0045)])).IsEmpty();
        await Assert.That(agent.Host.Readers()).IsEmpty();
        await Assert.That(agent.Host.Peek("1-2")).IsNull();
        await Assert.That(agent.Host.PowerCycle).IsNull();
    }

    [Test]
    public async Task 受け取った機材はポートの名前の順に並び_CCID_のものはリーダーにも並ぶ()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        Attach(app, "/dev/bus/usb/001/007", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045), serial: "\"ABC123\"");
        Attach(app, "/dev/bus/usb/001/003", 0x08e6, 0x3437, CcidTests.TwinDescriptors(), Reader);
        app.Send("""{"type":"synced"}""");
        await agent.Changed();
        // synced の前の attached では探し直さない
        await Assert.That(agent.Pending).IsEqualTo(0);

        var found = agent.Host.List([new UsbId(0x0511, 0x0045), new UsbId(0x08e6, 0x3437)]);
        await Assert.That(string.Join(" ", found.Select(item => item.Port))).IsEqualTo("001-003 001-007");
        await Assert.That(agent.Host.List([new UsbId(0x0511, 0x0045)]).Single().Port).IsEqualTo("001-007");

        var tuner = agent.Host.Peek("001-007")!;
        await Assert.That(tuner.Serial).IsEqualTo("ABC123");
        await Assert.That(tuner.Driver).IsNull();
        await Assert.That(tuner.Interfaces).IsEmpty();

        var readers = agent.Host.Readers();
        await Assert.That(readers.Select(item => item.Port)).IsEquivalentTo(["001-003"]);
        await Assert.That(readers[0].Interfaces.Single()).IsEqualTo((1, 0, 11));
        var candidates = Ccid.Find(agent.Host)!;
        await Assert.That(candidates.Single().Name).IsEqualTo("Gemalto PC Twin Reader (usb 001-003)");
    }

    [Test]
    public async Task 開くときは受け取った_fd_を複製して先頭から読み_ID_を確かめてから確保する()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        Attach(app, "/dev/bus/usb/002/004", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        Attach(app, "/dev/bus/usb/002/005", 0x08e6, 0x3437, CcidTests.TwinDescriptors(), Reader);
        app.Send("""{"type":"synced"}""");
        await agent.Changed();

        // ID が違えば確保の手前で断る。memfd の位置は末尾なので、先頭を読めているのは pread で 0 から読んだから
        var other = Assert.Throws<IOException>(() => agent.Host.Open("002-004", 0x0511, 0x0046));
        await Assert.That(other.Message).Contains("別の機材になっています (0511:0045)");
        // ID が合えば確保に進む。memfd は usbfs ではないので、そこで断られる
        var claim = Assert.Throws<IOException>(() => agent.Host.Open("002-004", 0x0511, 0x0045));
        await Assert.That(claim.Message).Contains("インターフェースを確保できません");
        // 何度開いても、受け取った fd は閉じない
        var again = Assert.Throws<IOException>(() => agent.Host.Open("002-004", 0x0511, 0x0045));
        await Assert.That(again.Message).Contains("インターフェースを確保できません");

        var ccid = Assert.Throws<IOException>(() => agent.Host.OpenCcid("002-005", 0x08e6, 0x3437, 1, 0));
        await Assert.That(ccid.Message).Contains("カードリーダーのインターフェースを確保できません");
        var missing = Assert.Throws<IOException>(() => agent.Host.OpenCcid("002-005", 0x08e6, 0x3437, 2, 0));
        await Assert.That(missing.Message).Contains("CCID のインターフェース 0 が見当たりません");

        var gone = Assert.Throws<IOException>(() => agent.Host.Open("2-1", 0x0511, 0x0045));
        await Assert.That(gone.Message).Contains("USB のポート 2-1 に機材がありません");
    }

    [Test]
    public async Task 子プロセスには受け取った_fd_の複製をポートの順に継がせ_起動し終えたら複製を閉じる()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        Attach(app, "/dev/bus/usb/003/004", 0x0b06, 0x0005, DeviceDescriptor(0x0b06, 0x0005), memfd: "first");
        Attach(app, "/dev/bus/usb/003/005", 0x0b06, 0x0005, DeviceDescriptor(0x0b06, 0x0005), memfd: "second");
        app.Send("""{"type":"synced"}""");
        await agent.Changed();

        // 並べた順と逆に指定しても、指定した順に並ぶ
        int[] numbers = [];
        using var child = Userland.Start("/bin/sh", fds =>
        {
            numbers = [.. fds];
            return ["-c", string.Join("; ", fds.Select(fd => $"readlink /proc/self/fd/{fd}"))];
        }, () => agent.Host.Lend(["003-005", "003-004"]));
        await Assert.That(numbers.All(fd => fd > 2)).IsTrue();
        var output = await child.StandardOutput.ReadToEndAsync();
        await child.WaitForExitAsync();
        await Assert.That(output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            .IsEquivalentTo(new[] { "/memfd:second (deleted)", "/memfd:first (deleted)" });
        // こちらの複製は閉じた (子プロセスの写しは子が持つ)。受け取った fd はそのまま
        // (番号はほかのテストの fd に使い回されることがあるので、指す先で見る)
        await Assert.That(numbers.Select(fd => new FileInfo($"/proc/self/fd/{fd}").LinkTarget)
            .Any(target => target is "/memfd:first (deleted)" or "/memfd:second (deleted)")).IsFalse();
        await Assert.That(agent.Host.Peek("003-004")).IsNotNull();

        var gone = Assert.Throws<IOException>(() => agent.Host.Lend(["003-004", "9-9"]));
        await Assert.That(gone.Message).Contains("USB のポート 9-9 に機材がありません");
    }

    [Test]
    public async Task detached_を受けたら表から消し_探し直してもらう()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        Attach(app, "/dev/bus/usb/001/004", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        app.Send("""{"type":"synced"}""");
        await agent.Changed();
        await Assert.That(agent.Host.Peek("001-004")).IsNotNull();

        app.Send("""{"type":"detached","name":"/dev/bus/usb/001/004"}""");
        await agent.Changed();
        await Assert.That(agent.Host.Peek("001-004")).IsNull();
        await Assert.That(agent.Host.List([new UsbId(0x0511, 0x0045)])).IsEmpty();

        // synced のあとに挿されたものは、受けたときに探し直してもらう
        Attach(app, "/dev/bus/usb/001/009", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        await agent.Changed();
        await Assert.That(agent.Host.Peek("001-009")).IsNotNull();
    }

    [Test]
    public async Task 繋ぎ直したら前の接続で受け取った機材を捨て_synced_まで待つ()
    {
        using var agent = new Agent();
        using (var first = App.Connect(agent.Path))
        {
            Attach(first, "/dev/bus/usb/001/004", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
            first.Send("""{"type":"synced"}""");
            await agent.Changed();
        }
        // 切れただけでは捨てない (アプリが終了しても、受け取った fd は使える)
        await Task.Delay(500);
        await Assert.That(agent.Host.Peek("001-004")).IsNotNull();

        using var second = App.Connect(agent.Path);
        Attach(second, "/dev/bus/usb/001/005", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        second.Send("""{"type":"synced"}""");
        await agent.Changed();
        await Assert.That(agent.Host.List([new UsbId(0x0511, 0x0045)]).Select(item => item.Port)).IsEquivalentTo(["001-005"]);
    }

    [Test]
    public async Task fd_の付いていない_attached_と読めない行は捨てて続ける()
    {
        using var agent = new Agent();
        using var app = App.Connect(agent.Path);
        app.Send("""{"type":"attached","name":"/dev/bus/usb/001/004","vendor":1297,"product":69}""");
        app.Send("これは JSON ではない");
        app.Send("""{"type":"unknown"}""");
        // 名前からポートを作れないもの・ID が範囲の外のものは、付いてきた fd を閉じて捨てる
        Attach(app, "usb-1", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        Attach(app, "/dev/bus/usb/001/006", 0x10000, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        Attach(app, "/dev/bus/usb/001/005", 0x0511, 0x0045, DeviceDescriptor(0x0511, 0x0045));
        app.Send("""{"type":"synced"}""");
        await agent.Changed();
        await Assert.That(agent.Host.List([new UsbId(0x0511, 0x0045)]).Select(item => item.Port)).IsEquivalentTo(["001-005"]);
    }

    [Test]
    public async Task ポートの名前は_CONNINFO_EX_のバスとハブのポートの並びから作り_使えなければアプリの側の名前から作る()
    {
        await Assert.That(BrokerUsbHost.PortName(1, [2])).IsEqualTo("1-2");
        await Assert.That(BrokerUsbHost.PortName(3, [1, 4, 2])).IsEqualTo("3-1.4.2");
        await Assert.That(BrokerUsbHost.PortName(1, [])).IsNull();
        await Assert.That(BrokerUsbHost.PortName(0, [1])).IsNull();
        await Assert.That(BrokerUsbHost.FallbackPort("/dev/bus/usb/001/004")).IsEqualTo("001-004");
        await Assert.That(UsbSysfs.IsPort("001-004")).IsTrue();
        await Assert.That(BrokerUsbHost.FallbackPort("/dev/bus/usb/1/4")).IsNull();
        await Assert.That(BrokerUsbHost.FallbackPort("/dev/bus/usb/001/004/x")).IsNull();
        await Assert.That(Unsafe.SizeOf<BrokerUsbHost.ConnectionInfo>()).IsEqualTo(24);
        await Assert.That(Unsafe.SizeOf<BrokerUsbHost.MessageHeader>()).IsEqualTo(56);
    }

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct SocketAddress
    {
        public ushort Family;
        public fixed byte Path[108];
    }

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct IoVector
    {
        public byte* Base;
        public nuint Length;
    }

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct MessageHeader
    {
        public void* Name;
        public uint NameLength;
        public IoVector* Vector;
        public nuint VectorLength;
        public byte* Control;
        public nuint ControlLength;
        public int Flags;
    }

    private static unsafe partial class Native
    {
        [LibraryImport("libc", EntryPoint = "socket", SetLastError = true)]
        public static partial int Socket(int domain, int type, int protocol);

        [LibraryImport("libc", EntryPoint = "connect", SetLastError = true)]
        public static partial int Connect(int fd, SocketAddress* address, uint length);

        [LibraryImport("libc", EntryPoint = "sendmsg", SetLastError = true)]
        public static partial nint SendMsg(int fd, MessageHeader* message, int flags);

        [LibraryImport("libc", EntryPoint = "memfd_create", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
        public static partial int MemfdCreate(string name, uint flags);

        [LibraryImport("libc", EntryPoint = "write", SetLastError = true)]
        public static partial nint Write(int fd, byte* buffer, nuint count);

        [LibraryImport("libc", EntryPoint = "close")]
        public static partial int Close(int fd);
    }
}
