using TUnit.Assertions.Enums;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * siano-userland の機材 (PX-S1UD など) を掴むところ。
 *
 * 本物の機材は無い。ここで確かめるのは**機材に触らない部分**だけ —
 * sysfs の読み方 (とくに「カーネルが掴んでいるものは渡さない」)、device 文字列の形、
 * siano-ts の起こし方。実機で当てるのは `denpa-agent --tune siano:<ポート> T27` (Probe.cs)。
 */
public class SianoTests
{
    /// <summary>
    /// 偽の sysfs。<c>/sys/bus/usb/devices/&lt;port&gt;/{idVendor,idProduct,busnum,devnum}</c> と、
    /// ドライバが掴んでいればインターフェース <c>&lt;port&gt;:1.0/driver</c> をドライバの場所へのリンクで
    /// </summary>
    private static string FakeSysfs(params (string Port, string Vendor, string Product, int Bus, int Address, string? Driver)[] devices)
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-sysfs-{Guid.NewGuid():N}");
        var drivers = Path.Combine(root, "_drivers");
        foreach (var (port, vendor, product, bus, address, driver) in devices)
        {
            var dir = Path.Combine(root, port);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "idVendor"), vendor + "\n");
            File.WriteAllText(Path.Combine(dir, "idProduct"), product + "\n");
            File.WriteAllText(Path.Combine(dir, "busnum"), bus + "\n");
            File.WriteAllText(Path.Combine(dir, "devnum"), address + "\n");
            var iface = Path.Combine(root, $"{port}:1.0");
            Directory.CreateDirectory(iface);
            if (driver is null) continue;
            Directory.CreateDirectory(Path.Combine(drivers, driver));
            Directory.CreateSymbolicLink(Path.Combine(iface, "driver"), Path.Combine(drivers, driver));
        }
        return root;
    }

    [Test]
    public async Task ドライバに繋がっていない機材だけ挙げる()
    {
        var sysfs = FakeSysfs(
            ("1-2", "3275", "0080", 1, 4, null),
            // smsusb が掴んでいる S1UD は /dev/dvb で見つかる。こちらでは挙げない
            ("1-3", "3275", "0080", 1, 5, "smsusb"),
            ("2-1.4", "187f", "0600", 2, 9, null),
            // 関係ない機材
            ("1-4", "0511", "084a", 1, 6, null));
        try
        {
            await Assert.That(SianoUserland.Detect(sysfs)).IsEquivalentTo(
                [
                    new TunerSpec("PX-S1UD 1-2", ["GR"], false, "siano:1-2"),
                    new TunerSpec("Siano RIO 2-1.4", ["GR"], false, "siano:2-1.4"),
                ],
                CollectionOrdering.Matching);
            var sticks = SianoUserland.Sticks(sysfs);
            await Assert.That(sticks.Single(s => s.Port == "1-3").Driver).IsEqualTo("smsusb");
            await Assert.That(sticks.Single(s => s.Port == "2-1.4").Node).IsEqualTo("/dev/bus/usb/002/009");
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task カーネルが掴んでいれば選局の前に断る()
    {
        var sysfs = FakeSysfs(("1-3", "3275", "0080", 1, 5, "smsusb"), ("1-2", "3275", "0080", 1, 4, null));
        try
        {
            var error = Assert.Throws<IOException>(() => SianoUserland.Claimable("1-3", sysfs));
            await Assert.That(error.Message).Contains("smsusb");
            Assert.Throws<IOException>(() => SianoUserland.Claimable("1-9", sysfs));
            await Assert.That(SianoUserland.Claimable("1-2", sysfs).Node).IsEqualTo("/dev/bus/usb/001/004");
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task sysfs_が無ければ空()
    {
        await Assert.That(SianoUserland.Detect("/nonexistent/sysfs")).IsEmpty();
    }

    [Test]
    public async Task device_の形()
    {
        await Assert.That(SianoUserland.Parse("siano:1-2")).IsEqualTo("1-2");
        await Assert.That(SianoUserland.Parse("siano:3-1.4.2")).IsEqualTo("3-1.4.2");
        // インターフェースやルートハブ、シェルに渡りそうなものは受け取らない
        await Assert.That(SianoUserland.Parse("siano:1-2:1.0")).IsNull();
        await Assert.That(SianoUserland.Parse("siano:usb1")).IsNull();
        await Assert.That(SianoUserland.Parse("siano:1-2;reboot")).IsNull();
        await Assert.That(SianoUserland.Parse("px4:00001205000960:2")).IsNull();
        await Assert.That(TunerPool.OpenDevice("siano:1-2", null)).IsTypeOf<SianoTuner>();
    }

    [Test]
    public async Task siano_ts_はノードを_fd_3_で渡して起こす()
    {
        var tuning = ChannelTable.Parse("T27")!;
        var start = SianoTuner.StartInfo("/dev/bus/usb/001/004", tuning, "/opt/siano-userland", "/fw/isdbt_rio.inp");
        await Assert.That(start.FileName).IsEqualTo("/bin/sh");
        await Assert.That(start.ArgumentList.ToArray()).IsEquivalentTo(
            [
                "-c", "node=$1; shift; exec \"$0\" --fd 3 \"$@\" 3<>\"$node\"",
                "/opt/siano-userland/siano-ts",
                "/dev/bus/usb/001/004",
                "--freq", tuning.Frequency.ToString(),
                "--firmware", "/fw/isdbt_rio.inp",
            ],
            CollectionOrdering.Matching);
        // 地上波の表は Hz のまま渡す (27ch は 557.142857 MHz)
        await Assert.That(tuning.Frequency).IsEqualTo(557142857u);
    }

    [Test]
    public async Task 衛星は受けない()
    {
        var bs = ChannelTable.Parse("BS15_0")!;
        var error = Assert.Throws<IOException>(() => SianoTuner.StartInfo("/dev/bus/usb/001/004", bs, "/d", "/f"));
        await Assert.That(error.Message).Contains("地上波だけ");
    }
}
