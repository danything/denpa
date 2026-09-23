using TUnit.Assertions.Enums;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * PX-Q3U4 を px4-userland で掴むところ。
 *
 * 本物の筐体は無い。ここで確かめるのは**機材に触らない部分**だけ —
 * sysfs の読み方、device 文字列の形、px4-ts に渡す引数。実機で当てるのは
 * `denpa-agent --tune q3u4:<serial>:2 T27` (Probe.cs)。
 */
public class Q3u4Tests
{
    /// <summary>偽の sysfs。<c>/sys/bus/usb/devices/&lt;name&gt;/{idVendor,idProduct,serial}</c> の形</summary>
    private static string FakeSysfs(params (string Name, string Vendor, string Product, string? Serial)[] devices)
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-sysfs-{Guid.NewGuid():N}");
        foreach (var (name, vendor, product, serial) in devices)
        {
            var dir = Path.Combine(root, name);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "idVendor"), vendor + "\n");
            File.WriteAllText(Path.Combine(dir, "idProduct"), product + "\n");
            if (serial is not null) File.WriteAllText(Path.Combine(dir, "serial"), serial + "\n");
        }
        return root;
    }

    [Test]
    public async Task USB_2機能が揃った筐体だけ数える()
    {
        var sysfs = FakeSysfs(
            ("1-3.1", "0511", "084a", "000012050009601"),
            ("1-3.2", "0511", "084a", "000012050009602"),
            // 片方しか見えていない筐体は使えない
            ("2-1", "0511", "084a", "000012050001231"),
            // 別の機材
            ("1-4", "1234", "5678", "000012050009999"),
            // シリアルが無い
            ("usb1", "1d6b", "0002", null));
        try
        {
            await Assert.That(Px4Userland.Serials(sysfs)).IsEquivalentTo(["00001205000960"], CollectionOrdering.Matching);
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task 筐体1台につき8本_衛星4本と地上波4本()
    {
        var sysfs = FakeSysfs(
            ("1-3.1", "0511", "084a", "000012050009601"),
            ("1-3.2", "0511", "084a", "000012050009602"));
        try
        {
            var found = Px4Userland.Detect(sysfs);
            await Assert.That(found.Count).IsEqualTo(8);
            await Assert.That(found[0].Device).IsEqualTo("q3u4:00001205000960:0");
            await Assert.That(found[0].Name).IsEqualTo("Q3U4-0960 #0");
            await Assert.That(found[2].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
            await Assert.That(found[5].Types).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
            await Assert.That(found[7].Device).IsEqualTo("q3u4:00001205000960:7");
            await Assert.That(found.All(spec => !spec.Disabled)).IsTrue();
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task sysfs_が無ければ空()
    {
        await Assert.That(Px4Userland.Detect("/nonexistent/sysfs")).IsEmpty();
    }

    [Test]
    public async Task base_serial_は先頭14桁()
    {
        await Assert.That(Px4Userland.BaseSerial("000012050009601")).IsEqualTo("00001205000960");
        await Assert.That(Px4Userland.BaseSerial("000012050009602")).IsEqualTo("00001205000960");
        await Assert.That(Px4Userland.BaseSerial("00001205000960")).IsEqualTo("00001205000960");
        await Assert.That(Px4Userland.BaseSerial("0000120500096")).IsNull();
        await Assert.That(Px4Userland.BaseSerial("0000120500096ab")).IsNull();
    }

    [Test]
    public async Task device_文字列の読み書き()
    {
        await Assert.That(Px4Userland.Device("00001205000960", 3)).IsEqualTo("q3u4:00001205000960:3");
        await Assert.That(Px4Userland.Parse("q3u4:00001205000960:3")).IsEqualTo(("00001205000960", 3));
        await Assert.That(Px4Userland.Parse("q3u4:00001205000960:8")).IsNull();
        await Assert.That(Px4Userland.Parse("q3u4:0000120500096:0")).IsNull();
        await Assert.That(Px4Userland.Parse("q3u4:000012050009601:0")).IsNull();
        await Assert.That(Px4Userland.Parse("/dev/dvb/adapter0/frontend0")).IsNull();
        await Assert.That(Px4Userland.Is("q3u4:x")).IsTrue();
        await Assert.That(Px4Userland.Is(null)).IsFalse();
    }

    [Test]
    public async Task 設定に出てくる筐体を集める()
    {
        var specs = new List<TunerSpec>
        {
            new("a", ["GR"], false, "q3u4:00001205000960:2"),
            new("b", ["BS", "CS"], false, "q3u4:00001205000960:0"),
            new("c", ["GR"], false, "q3u4:00001205000123:3"),
            // 止めてある本の筐体は起こさない
            new("d", ["GR"], true, "q3u4:00001205009999:2"),
            new("pt3", ["GR"], false, "/dev/dvb/adapter1/frontend0"),
        };
        await Assert.That(Px4Userland.SerialsIn(specs).ToArray())
            .IsEquivalentTo(["00001205000960", "00001205000123"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 地上波は_Hz_を_kHz_に直して渡す()
    {
        var tuning = ChannelTable.Parse("T27")!;
        var args = Q3u4Tuner.Arguments("00001205000960", 2, tuning, ChannelTable.NoStreamId, null);
        // px4-userland の README の例 (T27 = 557142 kHz) と同じ数字になること
        await Assert.That(args).IsEquivalentTo(
            ["--device", "00001205000960", "--receiver", "2", "--system", "isdb-t", "--frequency-khz", "557142",
                "--tune-timeout-ms", "5000", "--output", "-"],
            CollectionOrdering.Matching);
    }

    [Test]
    public async Task 衛星は_TSID_が分かっていれば_stream_id()
    {
        var tuning = ChannelTable.Parse("BS15_1")!;
        var args = Q3u4Tuner.Arguments("00001205000960", 0, tuning, 16626, "15v");
        await Assert.That(args).Contains("--system");
        await Assert.That(args[args.IndexOf("--system") + 1]).IsEqualTo("isdb-s");
        await Assert.That(args[args.IndexOf("--frequency-khz") + 1]).IsEqualTo(tuning.Frequency.ToString());
        await Assert.That(args[args.IndexOf("--stream-id") + 1]).IsEqualTo("16626");
        await Assert.That(args).DoesNotContain("--slot");
        // 15V は設定に書いてある本だけ
        await Assert.That(args[args.IndexOf("--lnb-voltage") + 1]).IsEqualTo("15");
    }

    [Test]
    public async Task 衛星で_TSID_が分からなければ_slot()
    {
        var tuning = ChannelTable.Parse("BS15_2")!;
        var args = Q3u4Tuner.Arguments("00001205000960", 1, tuning, ChannelTable.NoStreamId, null);
        await Assert.That(args[args.IndexOf("--slot") + 1]).IsEqualTo("2");
        await Assert.That(args).DoesNotContain("--stream-id");
        await Assert.That(args).DoesNotContain("--lnb-voltage");

        // CS は1本しか乗っていないので slot 0
        var cs = Q3u4Tuner.Arguments("00001205000960", 1, ChannelTable.Parse("CS04")!, ChannelTable.NoStreamId, "11v");
        await Assert.That(cs[cs.IndexOf("--slot") + 1]).IsEqualTo("0");
        // 11v は px4-userland には無い (0V か 15V)。頼まない
        await Assert.That(cs).DoesNotContain("--lnb-voltage");
    }

    [Test]
    public async Task 受信機の種別と違う方式は選局しない()
    {
        using var tuner = new Q3u4Tuner("00001205000960", 2, null);
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15_0")!, 16625));
        await Assert.That(error.Message).Contains("地上波");
        await Assert.That(tuner.Tuned).IsFalse();
    }

    [Test]
    public async Task reader_conf_は_pcscd_の形()
    {
        var conf = Px4Daemon.ReaderConf("00001205000960", "/run/px4-userland", "/opt/px4-userland/ifd/px4-userland-ifd.so");
        await Assert.That(conf).Contains("FRIENDLYNAME \"PLEX PX-Q3U4 0960 Internal Card Reader\"");
        await Assert.That(conf).Contains("DEVICENAME   px4-userland:runtime=/run/px4-userland:device=00001205000960:access=user");
        await Assert.That(conf).Contains("LIBPATH      /opt/px4-userland/ifd/px4-userland-ifd.so");
        await Assert.That(conf).Contains("CHANNELID    0");
    }
}
