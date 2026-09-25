using System.Diagnostics;
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
    public async Task siano_ts_はノードを_fd_3_で渡して_control_で起こす()
    {
        var start = SianoTuner.StartInfo("/dev/bus/usb/001/004", "/opt/siano-userland", "/fw/isdbt_rio.inp");
        await Assert.That(start.FileName).IsEqualTo("/bin/sh");
        await Assert.That(start.ArgumentList.ToArray()).IsEquivalentTo(
            [
                "-c", "node=$1; shift; exec \"$0\" --fd 3 \"$@\" 3<>\"$node\"",
                "/opt/siano-userland/siano-ts",
                "/dev/bus/usb/001/004",
                "--control",
                "--firmware", "/fw/isdbt_rio.inp",
            ],
            CollectionOrdering.Matching);
    }

    [Test]
    public async Task 選局は標準入力に_Hz_で頼む()
    {
        // 地上波の表は Hz のまま渡す (27ch は 557.142857 MHz)
        await Assert.That(SianoTuner.TuneCommand(ChannelTable.Parse("T27")!)).IsEqualTo("tune 557142857");
    }

    [Test]
    public async Task 衛星は受けない()
    {
        var error = Assert.Throws<IOException>(() => SianoTuner.TuneCommand(ChannelTable.Parse("BS15_0")!));
        await Assert.That(error.Message).Contains("地上波だけ");
    }

    /// <summary>
    /// 偽の siano-ts --control。起きたらまず前の選局の残りに見立てて **pipe より多く** 書き、
    /// それから標準入力を読む (本物も「書く → 標準入力を見る」の1本の輪)。
    /// <c>tune 1</c> は同期しない。それ以外は少し待ってから (本物の同期待ち)
    /// <c>tuned</c> を返し、<c>NEW&lt;Hz&gt;</c> を書き続ける (本物の TS も流れ続ける。
    /// <c>tuned</c> の直後の少しは読み捨てに食われるので、1行だけだと届かない)
    /// </summary>
    private const string FakeSianoTs = """
        dd if=/dev/zero bs=1048576 count=20 2>/dev/null
        while IFS= read -r line; do
          case "$line" in
            "tune 1") echo "ISDB-T tune response received but no demod lock" >&2
                      echo "control: tune failed: Connection timed out" >&2 ;;
            tune\ *) sleep 0.3; echo "tuned ${line#tune }" >&2
                     i=0; while [ $i -lt 2000 ]; do echo "NEW${line#tune }"; i=$((i+1)); done ;;
            quit) exit 0 ;;
          esac
        done
        """;

    private static SianoTuner Fake() => new("siano fake", () => new ProcessStartInfo("/bin/sh")
    {
        ArgumentList = { "-c", FakeSianoTs },
    });

    /// <summary>
    /// 選局のあと最初に届いた <c>NEW…</c> の行。読み捨てが行の途中で止まるので、
    /// 頭の欠けた1行目は飛ばす。**前の選局の残り (0 の詰め物) が混じっていれば落とす**
    /// </summary>
    private static string ReadLine(Stream stream)
    {
        for (var tries = 0; tries < 3; tries++)
        {
            var line = new List<byte>();
            var one = new byte[1];
            while (stream.Read(one, 0, 1) == 1 && one[0] != (byte)'\n') line.Add(one[0]);
            if (line.Contains(0)) throw new InvalidOperationException("前の選局の残りが混じっています");
            var text = System.Text.Encoding.ASCII.GetString(line.ToArray());
            if (text.StartsWith("NEW", StringComparison.Ordinal)) return text;
        }
        throw new InvalidOperationException("NEW の行が届きません");
    }

    [Test]
    public async Task 起こしたまま選局し直し_前の残りは読まない()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = Fake();

        // 起きた直後の 20MB を読んで捨てないと tune を読みに来ない (詰まらずに返ること)
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW557142857");

        // 同じ子のまま選局し直す。読み口も同じもの
        var output = tuner.Output;
        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Output).IsSameReferenceAs(output);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }

    [Test]
    public async Task 同期しなければ理由を添えて投げ_子は生かしておく()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = Fake();
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);

        var error = Assert.Throws<IOException>(
            () => tuner.Tune(ChannelTable.Parse("T27")! with { Frequency = 1 }, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("no demod lock");
        // 次の選局で使い回す
        await Assert.That(tuner.Tuned).IsTrue();
        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }

    [Test]
    public async Task 子が死んでいれば起こし直す()
    {
        if (!OperatingSystem.IsLinux()) return;
        var starts = 0;
        using var tuner = new SianoTuner("siano fake", () =>
        {
            starts++;
            // 1回目の子は1回選局したら終わる (USB が抜けた、に見立てる)
            var script = starts == 1 ? FakeSianoTs.Replace("i=$((i+1)); done ;;", "i=$((i+1)); done; exit 7 ;;") : FakeSianoTs;
            return new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", script } };
        });
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW557142857");
        for (var i = 0; i < 50 && tuner.Tuned; i++) await Task.Delay(100);
        await Assert.That(tuner.Tuned).IsFalse();

        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(starts).IsEqualTo(2);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }
}
