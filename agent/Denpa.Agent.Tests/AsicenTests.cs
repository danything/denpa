using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * asicen-userland の機材 (Asicen.cs)。
 *
 * 機材は無い。sysfs を真似た木から USB 機能を拾うところ、筐体へのまとめ方、device の文字列、
 * IPC の違い (枠の頭とソケットの置き場) を、偽の px4d (Px4TunerTests.FakePx4d を asicend のふりにしたもの) で確かめる。
 * 本物の asicend の模擬 (`--mock`) が手元にあれば (ASICEN_USERLAND_DIR)、それとも話す。
 */
public class AsicenTests
{
    /// <summary>sysfs の USB デバイスを1つ真似る</summary>
    private static void Usb(DirectoryInfo root, string port, string vid, string pid, int bus, int address)
    {
        var dir = Directory.CreateDirectory(Path.Combine(root.FullName, port)).FullName;
        File.WriteAllText(Path.Combine(dir, "idVendor"), vid + "\n");
        File.WriteAllText(Path.Combine(dir, "idProduct"), pid + "\n");
        File.WriteAllText(Path.Combine(dir, "busnum"), $"{bus}\n");
        File.WriteAllText(Path.Combine(dir, "devnum"), $"{address}\n");
    }

    [Test]
    public async Task sysfs_から_ASICEN_の_USB_機能だけを拾う()
    {
        var root = Directory.CreateTempSubdirectory("sysfs");
        try
        {
            Usb(root, "1-2.1", "0b06", "0005", 1, 29);
            Usb(root, "1-2.2", "1738", "5211", 1, 30);
            Usb(root, "1-3", "3275", "0080", 1, 4);       // PX-S1UD (siano)
            Usb(root, "usb1", "1d6b", "0002", 1, 1);      // ルートハブ
            if (!OperatingSystem.IsWindows()) Directory.CreateDirectory(Path.Combine(root.FullName, "1-2.1:1.0"));  // インターフェース (Windows の名前には : が使えない)

            var found = AsicenUserland.Scan(root.FullName);

            await Assert.That(found.Count).IsEqualTo(2);
            await Assert.That(found[0]).IsEqualTo(new AsicenUserland.Function("0b06:0005", 1, 29, "1-2.1", false));
            await Assert.That(found[0].Parent).IsEqualTo("1-2");
            await Assert.That(found[0].Slot).IsEqualTo(1);
            await Assert.That(found[0].Location).IsEqualTo("1:29");
            await Assert.That(found[1].Loader).IsTrue();
            await Assert.That(AsicenUserland.Scan(Path.Combine(root.FullName, "none"))).IsEmpty();
        }
        finally
        {
            root.Delete(true);
        }
    }

    [Test]
    public async Task 同じ内蔵ハブの_1_と_2_を1つの筐体にまとめる_受信機は_0S_1T_2S_3T()
    {
        var warnings = new List<string>();
        var enclosures = AsicenUserland.Group(
            [
                new("0b06:0005", 1, 29, "1-2.1", false),
                // .2 はファームウェア待ちのままでも asicend が受け付ける
                new("1738:5211", 1, 30, "1-2.2", true),
            ],
            warnings.Add);

        await Assert.That(warnings).IsEmpty();
        await Assert.That(enclosures.Count).IsEqualTo(1);
        var enclosure = enclosures[0];
        await Assert.That(enclosure.Id).IsEqualTo("1-2");
        await Assert.That(enclosure.Primary.Port).IsEqualTo("1-2.1");
        await Assert.That(enclosure.Sibling.Port).IsEqualTo("1-2.2");
        await Assert.That(enclosure.Receivers.Select(r => string.Join("/", r.Types)).ToArray())
            .IsEquivalentTo(new[] { "BS/CS", "GR", "BS/CS", "GR" });
        // LNB は出せない (上流が断る)
        await Assert.That(enclosure.Receivers.All(r => r.Lnb15v == false)).IsTrue();

        var specs = AsicenUserland.Specs(enclosures);
        await Assert.That(specs.Select(s => s.Device!).ToArray())
            .IsEquivalentTo(new[] { "asicen:1-2:0", "asicen:1-2:1", "asicen:1-2:2", "asicen:1-2:3" });
        await Assert.That(specs[1].Name).IsEqualTo("PX-W3U3 1-2 #1");
        await Assert.That(AsicenUserland.IdsIn(specs).ToArray()).IsEquivalentTo(new[] { "1-2" });
    }

    [Test]
    public async Task 揃わない筐体と_1_がファームウェア待ちの筐体は使わない()
    {
        var warnings = new List<string>();
        var enclosures = AsicenUserland.Group(
            [
                new("0b06:0005", 1, 29, "1-2.1", false),
                new("1738:5211", 2, 4, "2-3.1", true),
                new("0b06:0005", 2, 5, "2-3.2", false),
                new("0b06:0005", 3, 2, "3-1", false),
            ],
            warnings.Add);

        await Assert.That(enclosures).IsEmpty();
        await Assert.That(warnings.Count).IsEqualTo(3);
        await Assert.That(warnings.Any(w => w.Contains("1-2.1") && w.Contains(".1 と .2"))).IsTrue();
        await Assert.That(warnings.Any(w => w.Contains("2-3.1") && w.Contains("ファームウェア待ち"))).IsTrue();
        await Assert.That(warnings.Any(w => w.Contains("3-1 ") && w.Contains(".1 と .2"))).IsTrue();
    }

    [Test]
    [Arguments("asicen:1-2:1", "1-2", 1)]
    [Arguments("asicen:3-1.4:0", "3-1.4", 0)]
    public async Task device_を割る(string device, string id, int receiver)
    {
        await Assert.That(AsicenUserland.Parse(device)).IsEqualTo((id, receiver));
        await Assert.That(AsicenUserland.Device(id, receiver)).IsEqualTo(device);
    }

    [Test]
    [Arguments("asicen:1-2")]
    [Arguments("asicen:1-2:-1")]
    [Arguments("asicen:00001205000960:0")]
    [Arguments("asicen:../x:0")]
    [Arguments("asicen:1-:0")]
    [Arguments("px4:1-2:0")]
    public async Task 形の違う_device_は断る(string device)
    {
        await Assert.That(AsicenUserland.Parse(device)).IsNull();
    }

    [Test]
    public async Task 枠の頭とソケットの置き場が_px4d_と違う()
    {
        var frame = Px4Control.Encode(Px4Control.Hello, 0, 1, [], Px4Wire.Asicen);
        await Assert.That(frame.AsSpan(0, 4).SequenceEqual("ASCN"u8)).IsTrue();
        await Assert.That(Px4Control.Encode(Px4Control.Hello, 0, 1, []).AsSpan(0, 4).SequenceEqual("PX4U"u8)).IsTrue();
        await Assert.That(Px4Control.Endpoint("/run/x", "1-2", "control.sock", Px4Wire.Asicen))
            .IsEqualTo(Path.Combine("/run/x", "asicen-userland", "1-2", "control.sock"));
    }

    private static readonly AsicenUserland.Enclosure Ready = new(
        "1-2", "PX-W3U3", new("0b06:0005", 1, 29, "1-2.1", false), new("1738:5211", 1, 30, "1-2.2", true),
        AsicenUserland.Receivers(4));

    [Test]
    public async Task asicend_には_1_と_2_の番地と挿し口を渡す()
    {
        var firmware = Path.GetTempFileName();
        try
        {
            await Assert.That(AsicenDaemon.Hardware("1-2", firmware, () => [Ready])).IsEquivalentTo(new[]
            {
                "--hardware", "--primary", "1:29", "--primary-port", "1-2.1", "--sibling", "1:30", "--sibling-port", "1-2.2",
            });
            var missing = Assert.Throws<IOException>(() => AsicenDaemon.Hardware("3-4", firmware, () => [Ready]));
            await Assert.That(missing!.Message).Contains("見つかりません");
        }
        finally
        {
            File.Delete(firmware);
        }
    }

    [Test]
    public async Task ファームウェアが配布物に無ければ_流し込み済みの機材でも起こさない()
    {
        var called = false;
        var error = Assert.Throws<IOException>(() => AsicenDaemon.Hardware("1-2", "/nonexistent/asicen-loader.bin", () =>
        {
            called = true;
            return [Ready];
        }));
        await Assert.That(error!.Message).Contains("ファームウェアがありません");
        // 機材を並べにも行かない (ファームウェアを流し込みにも行かない)
        await Assert.That(called).IsFalse();
    }

    [Test]
    public async Task 配布物が無ければ何も挙げない()
    {
        // テストの環境に /opt/asicen-userland は無い (ASICEN_USERLAND_DIR を指したときだけ別)
        if (Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR") is not null) return;
        await Assert.That(AsicenUserland.Installed).IsFalse();
        await Assert.That(AsicenUserland.Detect()).IsEmpty();
    }
}

/// <summary>偽の asicend (px4d のふりを ASCN の頭と asicen-userland の置き場で) と話す</summary>
[ExcludeOn(OS.Windows)]
[Timeout(60_000)]
public class AsicenTunerTests
{
    private static readonly ChannelTable.Tuning T27 = ChannelTable.Parse("T27")!;
    private static readonly ChannelTable.Tuning Bs15 = ChannelTable.Parse("BS15_0")!;

    private static Px4Tuner Open(Px4TunerTests.FakePx4d asicend, int receiver, string? lnb) => new(
        "1-2", receiver, lnb, asicend.Runtime.FullName, () => AsicenUserland.Receivers(4),
        Px4Wire.Asicen, AsicenUserland.Device("1-2", receiver), $"asicen-1-2 #{receiver}");

    [Test]
    public async Task 借りて選局できる(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new Px4TunerTests.FakePx4d(Px4Wire.Asicen, "1-2");
        using var tuner = Open(asicend, 1, null);

        tuner.Tune(T27, ChannelTable.NoStreamId);
        await Assert.That(Px4TunerTests.ReadMark(tuner.Output)).IsEqualTo(Px4TunerTests.Mark(T27.Frequency / 1000));
        await Assert.That(asicend.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    [Test]
    public async Task 地上波の受信機に衛星は頼まない(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new Px4TunerTests.FakePx4d(Px4Wire.Asicen, "1-2");
        using var tuner = Open(asicend, 1, null);

        var error = Assert.Throws<IOException>(() => tuner.Tune(Bs15, ChannelTable.NoStreamId));
        await Assert.That(error!.Message).Contains("GR 用");
        await Assert.That(asicend.Count(Px4Control.Hello)).IsEqualTo(0);
    }

    [Test]
    public async Task LNB_15V_と書いてあっても_0V_で選局して画面に理由を出す(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new Px4TunerTests.FakePx4d(Px4Wire.Asicen, "1-2");
        var tuner = Open(asicend, 0, "15v");

        tuner.Tune(Bs15, ChannelTable.NoStreamId);
        await Assert.That(asicend.Lnbs.ToArray()).IsEquivalentTo(new byte[] { 0 });
        await Assert.That(Px4Userland.Notice("asicen:1-2:0")).Contains("15V");
        tuner.Dispose();
        await Assert.That(Px4Userland.Notice("asicen:1-2:0")).IsNull();
    }
}

/// <summary>
/// 本物の asicend の模擬 (<c>asicend --mock</c>) と話す。**ASICEN_USERLAND_DIR に組んだものがあるときだけ**
/// (CI の asicen-userland の組み立て、または手元のコンテナ)。模擬の TS は空パケットで、カードは UNSUPPORTED を返す
/// </summary>
[ExcludeOn(OS.Windows)]
[Timeout(120_000)]
public class AsicenMockTests
{
    /// <summary>組んだ asicen-userland の場所。**指してあるのに asicend が無ければ失敗にする** (CI で黙って飛ばさない)</summary>
    private static string? Built => Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR");

    [Test]
    public async Task 模擬の_asicend_を起こして_受信機を聞き_選局し直し_カードは断られる(CancellationToken cancel)
    {
        await Task.Yield();
        if (Built is not { } dir)
        {
            Skip.Test("ASICEN_USERLAND_DIR が指されていません");
            return;
        }
        // Unix ソケットのパスは短く (108 バイトまで)
        var runtime = Directory.CreateTempSubdirectory("asicen");
        var daemon = new AsicenDaemon("1-2", dir, runtime.FullName, () => ["--mock"]);
        try
        {
            daemon.Ensure();
            await Assert.That(daemon.Receivers!.Select(r => string.Join("/", r.Types)).ToArray())
                .IsEquivalentTo(new[] { "BS/CS", "GR", "BS/CS", "GR" });

            using (var tuner = new Px4Tuner(
                "1-2", 1, null, runtime.FullName, () => daemon.Receivers, Px4Wire.Asicen, "asicen:1-2:1", "asicen-1-2 #1"))
            {
                foreach (var channel in new[] { "T27", "T21" })
                {
                    tuner.Tune(ChannelTable.Parse(channel)!, ChannelTable.NoStreamId);
                    var packet = new byte[188];
                    var read = Task.Run(() => tuner.Output.ReadExactly(packet), cancel);
                    await read.WaitAsync(TimeSpan.FromSeconds(10), cancel);
                    await Assert.That(packet[0]).IsEqualTo((byte)0x47);
                    await Assert.That(tuner.Tuned).IsTrue();
                }
            }

            var cards = AsicenUserland.Cards(runtime.FullName);
            await Assert.That(cards.Count).IsEqualTo(1);
            await Assert.That(cards[0].Name).IsEqualTo("asicen-userland 1-2 Internal Card Reader");
            // 模擬にはカードが無い。UNSUPPORTED で断られ、ほかのリーダーを探しに行ける (IOException)
            await Assert.That(() =>
            {
                using var link = cards[0].Open();
                link.Reset();
            }).Throws<IOException>();
        }
        finally
        {
            daemon.Stop();
            runtime.Delete(true);
        }
    }
}
