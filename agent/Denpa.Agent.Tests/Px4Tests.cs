using TUnit.Assertions.Enums;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * px4-userland の機材 (PX-Q3U4 / PX-MLT5PE / DTV02A-5TS-P …) を掴むところ。
 *
 * 本物の筐体は無い。ここで確かめるのは**機材に触らない部分**だけ —
 * px4d --list / px4ctl list の読み方、device 文字列の形、px4-ts に渡す引数、reader.conf。
 * 実機で当てるのは `denpa-agent --tune px4:<筐体の番号>:2 T27` (Probe.cs)。
 */
public class Px4Tests
{
    /// <summary>px4-userland 0.1.4 の <c>px4ctl list</c> を Q3U4 に当てたときの形</summary>
    private const string Q3u4List = """
        serial=00001205000960 ready=yes usb-present-mask=0x03
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-S
        receiver=2 device=1 local=2 system=ISDB-T
        receiver=3 device=1 local=3 system=ISDB-T
        receiver=4 device=2 local=0 system=ISDB-S
        receiver=5 device=2 local=1 system=ISDB-S
        receiver=6 device=2 local=2 system=ISDB-T
        receiver=7 device=2 local=3 system=ISDB-T
        """;

    /// <summary>同じく MLT5 系。どの受信機も地上波と衛星の両方</summary>
    private const string Mlt5List = """
        serial=000000000012345 ready=yes usb-present-mask=0x01
        receiver=0 device=1 local=0 system=ISDB-T/S
        receiver=1 device=1 local=1 system=ISDB-T/S
        receiver=2 device=1 local=2 system=ISDB-T/S
        receiver=3 device=1 local=3 system=ISDB-T/S
        receiver=4 device=1 local=4 system=ISDB-T/S
        """;

    private static List<Px4Receiver> Receivers(string list) => Px4Receiver.ParseList(list, _ => { });

    /// <summary>px4-userland 0.1.6 の <c>px4d --list</c> の形 (SPEC 4.6)</summary>
    private const string List = """
        serial=000000000012345 model=PX-MLT5PE usb=0511:024e status=ready receivers=5
        receiver=0 device=1 local=0 system=ISDB-T/S
        receiver=1 device=1 local=1 system=ISDB-T/S
        receiver=2 device=1 local=2 system=ISDB-T/S
        receiver=3 device=1 local=3 system=ISDB-T/S
        receiver=4 device=1 local=4 system=ISDB-T/S
        serial=00001205000123 model=PX-Q3U4 usb=0511:084a status=incomplete receivers=8
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-S
        receiver=2 device=1 local=2 system=ISDB-T
        receiver=3 device=1 local=3 system=ISDB-T
        receiver=4 device=2 local=0 system=ISDB-S
        receiver=5 device=2 local=1 system=ISDB-S
        receiver=6 device=2 local=2 system=ISDB-T
        receiver=7 device=2 local=3 system=ISDB-T
        serial=00001205000960 model=PX-Q3U4 usb=0511:084a status=ready receivers=8
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-S
        receiver=2 device=1 local=2 system=ISDB-T
        receiver=3 device=1 local=3 system=ISDB-T
        receiver=4 device=2 local=0 system=ISDB-S
        receiver=5 device=2 local=1 system=ISDB-S
        receiver=6 device=2 local=2 system=ISDB-T
        receiver=7 device=2 local=3 system=ISDB-T
        rejected serial= model=PX-W3U4 usb=0511:083f status=open_failed
        """;

    [Test]
    public async Task px4d_list_の_ready_な筐体だけ使う()
    {
        var warned = new List<string>();
        var found = Px4Userland.ParseList(List, warned.Add);

        await Assert.That(found.Select(e => (e.Id, e.Model))).IsEquivalentTo(
            [("000000000012345", "PX-MLT5PE"), ("00001205000960", "PX-Q3U4")], CollectionOrdering.Matching);
        await Assert.That(found[0].Receivers.Count).IsEqualTo(5);
        await Assert.That(found[1].Receivers.Count).IsEqualTo(8);
        await Assert.That(found[1].Receivers[2].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);

        // 使えない筐体と rejected は理由を残す。権限が無いときは黙って「無い」にしない
        await Assert.That(warned.Count).IsEqualTo(2);
        await Assert.That(warned[0]).Contains("status=incomplete");
        await Assert.That(warned[1]).Contains("open_failed");
        await Assert.That(warned[1]).Contains("権限");
    }

    [Test]
    public async Task 何も刺さっていなければ空()
    {
        await Assert.That(Px4Userland.ParseList("", _ => { })).IsEmpty();
    }

    [Test]
    public async Task 受信機の数と種別は筐体の答えのとおり_Q3U4()
    {
        var receivers = Receivers(Q3u4List);
        await Assert.That(receivers.Count).IsEqualTo(8);
        await Assert.That(receivers[0].Types).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(receivers[2].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(receivers[7].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 受信機の数と種別は筐体の答えのとおり_MLT5()
    {
        var receivers = Receivers(Mlt5List);
        await Assert.That(receivers.Count).IsEqualTo(5);
        await Assert.That(receivers.All(r => r.Types.SequenceEqual(["GR", "BS", "CS"]))).IsTrue();
    }

    [Test]
    public async Task 知らない方式の受信機は飛ばして続ける()
    {
        var warned = new List<string>();
        var receivers = Px4Receiver.ParseList(
            """
            receiver=0 device=1 local=0 system=ISDB-T
            receiver=1 device=1 local=1 system=ISDB-S3
            receiver=2 device=1 local=2 system=ISDB-S
            """,
            warned.Add);
        await Assert.That(receivers.Select(r => r.Index)).IsEquivalentTo([0, 2], CollectionOrdering.Matching);
        await Assert.That(warned.Count).IsEqualTo(1);
        await Assert.That(warned[0]).Contains("ISDB-S3");
    }

    [Test]
    public async Task 筐体と受信機から設定の形に組み立てる()
    {
        var found = Px4Userland.Specs(Px4Userland.ParseList(List, _ => { }));
        await Assert.That(found.Count).IsEqualTo(13);
        await Assert.That(found[0].Device).IsEqualTo("px4:000000000012345:0");
        await Assert.That(found[0].Name).IsEqualTo("PX-MLT5PE-2345 #0");
        await Assert.That(found[0].Types).IsEquivalentTo(["GR", "BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(found[5].Device).IsEqualTo("px4:00001205000960:0");
        await Assert.That(found[5].Name).IsEqualTo("PX-Q3U4-0960 #0");
        await Assert.That(found[7].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(found.All(spec => !spec.Disabled)).IsTrue();
    }

    [Test]
    public async Task device_文字列の読み書き()
    {
        await Assert.That(Px4Userland.Device("00001205000960", 3)).IsEqualTo("px4:00001205000960:3");
        await Assert.That(Px4Userland.Parse("px4:00001205000960:3")).IsEqualTo(("00001205000960", 3));
        await Assert.That(Px4Userland.Parse("px4:000000000012345:4")).IsEqualTo(("000000000012345", 4));
        // 桁数と受信機の上限は px4-userland が見る
        await Assert.That(Px4Userland.Parse("px4:00001205000960:8")).IsEqualTo(("00001205000960", 8));
        await Assert.That(Px4Userland.Parse("px4:00001205000960:-1")).IsNull();
        await Assert.That(Px4Userland.Parse("px4:0000abc:0")).IsNull();
        await Assert.That(Px4Userland.Parse("px4:00001205000960")).IsNull();
        await Assert.That(Px4Userland.Parse("q3u4:00001205000960:3")).IsNull();
        await Assert.That(Px4Userland.Parse("/dev/dvb/adapter0/frontend0")).IsNull();
        await Assert.That(Px4Userland.Is("px4:x")).IsTrue();
        await Assert.That(Px4Userland.Is(null)).IsFalse();
    }

    [Test]
    public async Task 設定に出てくる筐体を集める()
    {
        var specs = new List<TunerSpec>
        {
            new("a", ["GR"], false, "px4:00001205000960:2"),
            new("b", ["BS", "CS"], false, "px4:00001205000960:0"),
            new("c", ["GR", "BS", "CS"], false, "px4:000000000012345:3"),
            // 止めてある本の筐体は起こさない
            new("d", ["GR"], true, "px4:00001205009999:2"),
            new("pt3", ["GR"], false, "/dev/dvb/adapter1/frontend0"),
        };
        await Assert.That(Px4Userland.IdsIn(specs).ToArray())
            .IsEquivalentTo(["00001205000960", "000000000012345"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 地上波は_Hz_を_kHz_に直して渡す()
    {
        var tuning = ChannelTable.Parse("T27")!;
        var args = Px4Tuner.Arguments("00001205000960", 2, tuning, ChannelTable.NoStreamId, null);
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
        var args = Px4Tuner.Arguments("00001205000960", 0, tuning, 16626, "15v");
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
        var args = Px4Tuner.Arguments("00001205000960", 1, tuning, ChannelTable.NoStreamId, null);
        await Assert.That(args[args.IndexOf("--slot") + 1]).IsEqualTo("2");
        await Assert.That(args).DoesNotContain("--stream-id");
        await Assert.That(args).DoesNotContain("--lnb-voltage");

        // CS は1本しか乗っていないので slot 0
        var cs = Px4Tuner.Arguments("00001205000960", 1, ChannelTable.Parse("CS04")!, ChannelTable.NoStreamId, "11v");
        await Assert.That(cs[cs.IndexOf("--slot") + 1]).IsEqualTo("0");
        // 11v は px4-userland には無い (0V か 15V)。頼まない
        await Assert.That(cs).DoesNotContain("--lnb-voltage");
    }

    [Test]
    public async Task 受信機の種別と違う方式は選局しない()
    {
        var q3u4 = Receivers(Q3u4List);
        var error = Assert.Throws<IOException>(() => Px4Tuner.Check(q3u4, 2, ChannelTable.Parse("BS15_0")!));
        await Assert.That(error.Message).Contains("GR 用");
        Px4Tuner.Check(q3u4, 0, ChannelTable.Parse("BS15_0")!);

        // MLT5 系はどの受信機も両方受けられる
        var mlt5 = Receivers(Mlt5List);
        Px4Tuner.Check(mlt5, 4, ChannelTable.Parse("BS15_0")!);
        Px4Tuner.Check(mlt5, 4, ChannelTable.Parse("T27")!);
    }

    [Test]
    public async Task 無い受信機は選局しない()
    {
        var error = Assert.Throws<IOException>(() => Px4Tuner.Check(Receivers(Mlt5List), 5, ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).Contains("受信機 5 はありません");
    }

    [Test]
    public async Task 受信機を聞けていなければ_px4_ts_に任せる()
    {
        Px4Tuner.Check(null, 7, ChannelTable.Parse("BS15_0")!);
        await Task.CompletedTask;
    }

    [Test]
    public async Task reader_conf_は_pcscd_の形()
    {
        var conf = Px4Userland.ReaderConf("00001205000960", "/run/px4-userland", "/opt/px4-userland/ifd/px4-userland-ifd.so");
        await Assert.That(conf).Contains("FRIENDLYNAME \"px4-userland 0960 Internal Card Reader\"");
        await Assert.That(conf).Contains("DEVICENAME   px4-userland:runtime=/run/px4-userland:device=00001205000960:access=user");
        await Assert.That(conf).Contains("LIBPATH      /opt/px4-userland/ifd/px4-userland-ifd.so");
        await Assert.That(conf).Contains("CHANNELID    0");
    }

    [Test]
    public async Task reader_conf_を筐体ぶん揃えて_いない筐体のは消す()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"denpa-readerconf-{Guid.NewGuid():N}");
        var ifd = Path.Combine(dir, "ifd.so");
        Directory.CreateDirectory(dir);
        File.WriteAllText(ifd, "");
        try
        {
            // もう居ない筐体の reader.conf は消す
            File.WriteAllText(Path.Combine(dir, "px4-userland-00001205009999.conf"), "old");
            // denpa が書いたものでないファイルには触らない
            File.WriteAllText(Path.Combine(dir, "other.conf"), "keep");

            await Assert.That(Px4Userland.WriteReaderConfs(["00001205000960", "000000000012345"], dir, ifd)).IsTrue();
            var names = Directory.GetFiles(dir, "*.conf").Select(Path.GetFileName).Order().ToArray();
            await Assert.That(names).IsEquivalentTo(
                ["other.conf", "px4-userland-000000000012345.conf", "px4-userland-00001205000960.conf"],
                CollectionOrdering.Matching);

            // 同じ顔ぶれなら書き直さない (pcscd を入れ直さなくてよい)
            await Assert.That(Px4Userland.WriteReaderConfs(["00001205000960", "000000000012345"], dir, ifd)).IsFalse();
            // 減っただけなら入れ直さない (居ない筐体のリーダーは「カードなし」で並ぶだけ)
            await Assert.That(Px4Userland.WriteReaderConfs(["00001205000960"], dir, ifd)).IsFalse();
            // 増えたら入れ直す
            await Assert.That(Px4Userland.WriteReaderConfs(["00001205000960", "000000000067890"], dir, ifd)).IsTrue();
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
