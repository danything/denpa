namespace Denpa.Agent.Tests;

/*
 * USB の境目 (UsbHost.cs)。機材ごとのコードは偽の IUsbHost で、SysfsUsbHost は作った sysfs で確かめる。
 * Windows と macOS の実装 (WinUsbHost・IoKitUsbHost) は OS の一覧をそのまま包むだけなので、偽の IUsbHost が
 * その返し方 (ID の順に返す・ドライバもインターフェースも分からない) を真似る。
 */
public class UsbHostTests
{
    /// <summary>偽の IUsbHost。並べるのは渡した順 (OS が返した順の代わり)</summary>
    private sealed class FakeHost(params UsbFound[] devices) : IUsbHost
    {
        /// <summary>false なら Windows・macOS と同じく、1 台だけを読めない</summary>
        public bool Peeks { get; init; } = true;

        /// <summary>false なら Windows・macOS と同じく、自前の CCID で開かない</summary>
        public bool OwnCcid { get; init; } = true;

        public int Lists { get; private set; }

        public List<string> Opened { get; } = [];

        public IReadOnlyList<UsbFound> List(IReadOnlyCollection<UsbId> ids)
        {
            Lists++;
            return [.. devices.Where(device => ids.Contains(new UsbId(device.Vendor, device.Product)))];
        }

        public UsbFound? Peek(string port) => Peeks ? devices.FirstOrDefault(device => device.Port == port) : null;

        public IReadOnlyList<UsbFound>? Readers() =>
            OwnCcid ? [.. devices.Where(device => device.Interfaces.Any(entry => entry.Class == Ccid.InterfaceClass))] : null;

        public IUsbDevice Open(string port, int vendor, int product, bool selectAlternate = true)
        {
            Opened.Add($"{port} {vendor:x4}:{product:x4} {selectAlternate}");
            throw new IOException("偽の機材は開けません");
        }

        public ICcidPipe OpenCcid(string port, int vendor, int product, int config, int interfaceNumber)
        {
            Opened.Add($"{port} {vendor:x4}:{product:x4} {config}.{interfaceNumber}");
            throw new IOException("偽のリーダーは開けません");
        }

        public Action<string, TimeSpan>? PowerCycle => null;

        public IDisposable Watch(Action changed) => new NoWatch();
    }

    private static UsbFound Device(string port, int vendor, int product, string? driver = null, string? serial = null,
        params (int Config, int Number, int Class)[] interfaces) =>
        new(port, vendor, product, serial, null, null, driver, interfaces);

    [Test]
    public async Task 機材の一覧は_OS_が返した順のまま_カーネルのドライバが使っているものを除く()
    {
        // Windows は機種の表の順に OS に聞くので、ポートの名前の順にならない。並べ直さない
        var host = new FakeHost(
            Device("2-1", 0x0511, 0x024E),
            Device("1-3", 0x0511, 0x084E),
            Device("1-4", 0x0511, 0x024E, driver: "px4_usb"),
            Device("1-5", 0x0511, 0x024E, driver: "usbfs"),
            Device("1-6", 0x0511, 0x0051));
        List<string> warnings = [];
        var found = It930x.Found(host, warnings.Add);
        await Assert.That(string.Join(", ", found.Select(item => $"{item.Port}={item.Model.Name}")))
            .IsEqualTo("2-1=PLEX PX-MLT5PE, 1-3=PLEX PX-MLT5U, 1-5=PLEX PX-MLT5PE");
        await Assert.That(string.Join("\n", warnings)).IsEqualTo("PLEX PX-MLT5PE 1-4 はカーネルのドライバ (px4_usb) が使っているので使いません");
    }

    [Test]
    public async Task 機材ごとの探し方はどれも同じ境目を通る()
    {
        var host = new FakeHost(
            Device("1-1", Zd1j.Vendor, Zd1j.Product),
            Device("1-2", 0x06B8, 0x103B),
            Device("1-3", 0x06B8, 0x1038),
            Device("1-4", 0x3275, 0x0080),
            Device("1-5", 0x3275, 0x0080, driver: "smsusb"));
        await Assert.That(string.Join(",", Zd1j.Ports(host))).IsEqualTo("1-1");
        List<string> warnings = [];
        await Assert.That(string.Join(",", Dt295.Ports(host, warnings.Add))).IsEqualTo("1-2");
        await Assert.That(warnings.Single()).Contains("PIXELA PIX-DT420 1-3 を見つけましたが、未確認なので使いません");
        warnings.Clear();
        await Assert.That(string.Join(",", Siano.Found(host, warnings.Add).Select(item => item.Port))).IsEqualTo("1-4");
        await Assert.That(warnings.Single()).IsEqualTo("PLEX PX-S1UD 1-5 はカーネルのドライバ (smsusb) が使っているので使いません");
    }

    [Test]
    public async Task ポートの機種は_1_台だけ読めればそのポートだけを読み_読めなければ並べて探す()
    {
        UsbFound[] devices = [Device("1-2", 0x06B8, 0x103B), Device("1-3", 0x0511, 0x024E, driver: "px4_usb")];
        var linux = new FakeHost(devices);
        await Assert.That(Dt295.Identify(linux, "1-2")?.Name).IsEqualTo("PIXELA PIX-DT295");
        await Assert.That(Dt295.Identify(linux, "1-3")).IsNull();
        await Assert.That(linux.Lists).IsEqualTo(0);

        var windows = new FakeHost(devices) { Peeks = false };
        await Assert.That(Dt295.Identify(windows, "1-2")?.Name).IsEqualTo("PIXELA PIX-DT295");
        await Assert.That(Dt295.Identify(windows, "9-9")).IsNull();
        await Assert.That(windows.Lists).IsEqualTo(2);
        // 見分けるだけなので、カーネルのドライバが使っていても機種は返す
        await Assert.That(UsbHost.Identify(windows, It930x.Family, model => new UsbId(model.Vendor, model.Product), "1-3")?.Name).IsEqualTo("PLEX PX-MLT5PE");
    }

    [Test]
    public async Task CCID_のリーダーはインターフェースの名前の順に並べ_開くときに境目で開く()
    {
        var host = new FakeHost(
            Device("4-11.2", 0x08E6, 0x3437, interfaces: [(1, 0, 0x0B)]),
            Device("4-11", 0x076B, 0x3021, interfaces: [(1, 0, 0x03), (1, 1, 0x0B)]),
            Device("1-2", 0x046D, 0xC077, interfaces: [(1, 0, 0x03)]));
        var found = Ccid.Find(host)!;
        // 4-11.2:1.0 は 4-11:1.1 より前 (sysfs のインターフェースの名前の順。. は : より小さい)
        await Assert.That(found.Select(candidate => candidate.Name).ToArray())
            .IsEquivalentTo(new[] { "CCID 08e6:3437 (usb 4-11.2)", "CCID 076b:3021 (usb 4-11:1.1)" });
        await Assert.That(found[0].Name).IsEqualTo("CCID 08e6:3437 (usb 4-11.2)");
        await Assert.That(host.Opened).IsEmpty();
        Assert.Throws<IOException>(() => found[1].Open());
        await Assert.That(host.Opened.Single()).IsEqualTo("4-11 076b:3021 1.1");

        // Windows・macOS は PC/SC を使う
        await Assert.That(Ccid.Find(new FakeHost(Device("4-11", 0x076B, 0x3021, interfaces: [(1, 0, 0x0B)])) { OwnCcid = false })).IsNull();
    }

    [Test]
    public async Task ASICEN_は機種とファームウェア待ちの_ID_だけを並べる()
    {
        var host = new FakeHost(
            Device("1-2.1", 0x0B06, 0x0005),
            Device("1-2.2", 0x1738, 0x5211, driver: "something"),
            Device("1-3", 0x3275, 0x0080));
        await Assert.That(AsicenUserland.Scan(host).Select(function => $"{function.Port} {function.Usb} {function.Loader}").ToArray())
            .IsEquivalentTo(new[] { "1-2.1 0b06:0005 False", "1-2.2 1738:5211 True" });
    }

    [Test]
    public async Task USB_の_ID_を読む()
    {
        await Assert.That(UsbId.Parse("1738:5211")).IsEqualTo(new UsbId(0x1738, 0x5211));
        await Assert.That(UsbId.Parse("0b06:000A")).IsEqualTo(new UsbId(0x0B06, 0x000A));
    }

    [Test]
    public async Task sysfs_から_ID_で絞ってポートの名前の順に並べ_属性とインターフェースを読む()
    {
        // sysfs のインターフェースの名前の「:」は Windows のファイル名に使えない
        if (OperatingSystem.IsWindows()) return;
        var root = Directory.CreateTempSubdirectory("usbhost").FullName;
        void Write(string dir, string name, string value)
        {
            Directory.CreateDirectory(Path.Combine(root, dir));
            File.WriteAllText(Path.Combine(root, dir, name), value + "\n");
        }
        try
        {
            foreach (var (port, product) in new[] { ("2-1", "024e"), ("1-10", "024e"), ("1-2", "084e"), ("1-3", "0051") })
            {
                Write(port, "idVendor", "0511");
                Write(port, "idProduct", product);
            }
            Write("1-2", "serial", "000012050009601");
            Write("1-2", "manufacturer", "PLEX");
            Write("1-2", "product", "");
            Write("1-2:1.0", "bInterfaceNumber", "00");
            Write("1-2:1.0", "bInterfaceClass", "ff");
            Write("1-2:1.1", "bInterfaceNumber", "01");
            Write("1-2:1.1", "bInterfaceClass", "0b");
            Directory.CreateDirectory(Path.Combine(root, "1-10:1.0", "driver"));
            Write("usb1", "idVendor", "1d6b");
            Write("usb1", "idProduct", "0002");

            var host = new SysfsUsbHost(root, Path.Combine(root, "dev"));
            var found = host.List([new UsbId(0x0511, 0x024E), new UsbId(0x0511, 0x084E)]);
            await Assert.That(string.Join(",", found.Select(item => item.Port))).IsEqualTo("1-10,1-2,2-1");
            var mlt5u = found.Single(item => item.Port == "1-2");
            await Assert.That(mlt5u.Serial).IsEqualTo("000012050009601");
            await Assert.That(mlt5u.Manufacturer).IsEqualTo("PLEX");
            // 空の文字列は読めないのと同じ
            await Assert.That(mlt5u.ProductName).IsNull();
            await Assert.That(mlt5u.Driver).IsNull();
            await Assert.That(string.Join(",", mlt5u.Interfaces.Select(entry => $"{entry.Config}.{entry.Number}:{entry.Class:x2}"))).IsEqualTo("1.0:ff,1.1:0b");
            await Assert.That(found.Single(item => item.Port == "1-10").Driver).IsEqualTo("driver");

            await Assert.That(host.Peek("1-3")?.Product).IsEqualTo(0x0051);
            await Assert.That(host.Peek("9-9")).IsNull();
            await Assert.That(host.Peek("usb1")).IsNull();
            // 番号 (busnum・devnum) の無いものはリーダーに並べない
            await Assert.That(host.Readers()).IsEmpty();
            Write("1-2", "busnum", "1");
            Write("1-2", "devnum", "5");
            await Assert.That(host.Readers().Single().Port).IsEqualTo("1-2");
            await Assert.That(Assert.Throws<IOException>(() => host.OpenCcid("1-2", 0x0511, 0x084E, 1, 1)).Message).Contains("001/005");
            await Assert.That(Assert.Throws<IOException>(() => host.OpenCcid("1-3", 0x0511, 0x0051, 1, 0)).Message).Contains("1-3 に機材がありません");
            await Assert.That(host.PowerCycle).IsNotNull();
            // usbfs の置き場が無ければ、抜き差しは受け取らない (止めても例外にならない)
            host.Watch(() => { }).Dispose();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Test]
    public async Task sysfs_が無ければ何も並べない()
    {
        var host = new SysfsUsbHost(Path.Combine(Path.GetTempPath(), $"denpa-none-{Guid.NewGuid():N}"));
        await Assert.That(host.List([new UsbId(0x0511, 0x024E)])).IsEmpty();
        await Assert.That(host.Readers()).IsEmpty();
        await Assert.That(host.Peek("1-2")).IsNull();
    }
}
