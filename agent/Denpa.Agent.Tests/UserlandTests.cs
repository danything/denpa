using System.Buffers.Binary;
using TUnit.Assertions.Enums;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 同梱のユーザー空間ドライバに共通する部分 (Userland.cs)。受信機の行の読み方、TUNE の中身、LNB の指定、注意書き。
 * 制御ソケットのやり取りは偽の常駐で確かめる (UserlandTunerTests・AsicenTests)。
 */
public class UserlandTests
{
    /// <summary>受信機ごとに衛星か地上波かが決まっている筐体の受信機の行 (8 つ)</summary>
    private const string SplitList = """
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-S
        receiver=2 device=1 local=2 system=ISDB-T
        receiver=3 device=1 local=3 system=ISDB-T
        receiver=4 device=2 local=0 system=ISDB-S
        receiver=5 device=2 local=1 system=ISDB-S
        receiver=6 device=2 local=2 system=ISDB-T
        receiver=7 device=2 local=3 system=ISDB-T
        """;

    /// <summary>同じく、どの受信機も地上波と衛星の両方を受けられる筐体</summary>
    private const string BothList = """
        serial=000000000012345 ready=yes usb-present-mask=0x01
        receiver=0 device=1 local=0 system=ISDB-T/S
        receiver=1 device=1 local=1 system=ISDB-T/S
        receiver=2 device=1 local=2 system=ISDB-T/S
        receiver=3 device=1 local=3 system=ISDB-T/S
        receiver=4 device=1 local=4 system=ISDB-T/S
        """;

    private static List<UserlandReceiver> Receivers(string list) => UserlandReceiver.ParseList(list, _ => { });

    [Test]
    public async Task 受信機の行は_CRLF_でも読む()
    {
        // Windows では siano-ts --list の受信機の行を集め直すとき (AppendLine) に CRLF が付く。行末の \r を値に残さない
        var found = Receivers(SplitList.ReplaceLineEndings("\r\n"));

        await Assert.That(found.Count).IsEqualTo(8);
        await Assert.That(found[2].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 受信機の数と種別は筐体の応答のとおり_分かれている()
    {
        var receivers = Receivers(SplitList);
        await Assert.That(receivers.Count).IsEqualTo(8);
        await Assert.That(receivers[0].Types).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(receivers[2].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(receivers[7].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 受信機の数と種別は筐体の応答のとおり_どれも両方()
    {
        var receivers = Receivers(BothList);
        await Assert.That(receivers.Count).IsEqualTo(5);
        await Assert.That(receivers.All(r => r.Types.SequenceEqual(["GR", "BS", "CS"]))).IsTrue();
    }

    [Test]
    public async Task 対応していない方式の受信機は飛ばして続ける()
    {
        var warned = new List<string>();
        var receivers = UserlandReceiver.ParseList(
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

    /// <summary>同じ鍵が 2 度ある行は最初の値を採る (<see cref="UserlandReceiver.Fields"/>)。投げない</summary>
    [Test]
    public async Task 同じ鍵が_2_度あれば最初の値()
    {
        var receivers = UserlandReceiver.ParseList("receiver=3 device=1 system=ISDB-T system=ISDB-S", _ => { });
        await Assert.That(receivers.Count).IsEqualTo(1);
        await Assert.That(receivers[0].Index).IsEqualTo(3);
        await Assert.That(receivers[0].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
    }


    /// <summary>TUNE の中身を読む (SPEC 6.4)</summary>
    private static (ulong Lease, byte System, ulong Khz, ushort StreamId, ushort Slot, uint Bandwidth, byte Lnb, uint TimeoutMs) Tune(byte[] p) => (
        BinaryPrimitives.ReadUInt64LittleEndian(p),
        p[8],
        BinaryPrimitives.ReadUInt64LittleEndian(p.AsSpan(9)),
        BinaryPrimitives.ReadUInt16LittleEndian(p.AsSpan(17)),
        BinaryPrimitives.ReadUInt16LittleEndian(p.AsSpan(19)),
        BinaryPrimitives.ReadUInt32LittleEndian(p.AsSpan(21)),
        p[25],
        BinaryPrimitives.ReadUInt32LittleEndian(p.AsSpan(26)));

    [Test]
    public async Task 地上波は_Hz_を_kHz_に直してリクエストする()
    {
        var payload = UserlandTuner.TuneRequest(0x0102030405060708, ChannelTable.Parse("T27")!, ChannelTable.NoStreamId, "15v");
        await Assert.That(payload.Length).IsEqualTo(30);
        // T27 は 557142 kHz。
        // 地上波は stream_id / slot を使わず、帯域 6MHz、LNB は指定しない (15v と書いてあっても)
        await Assert.That(Tune(payload)).IsEqualTo(((ulong)0x0102030405060708, (byte)1, 557142UL, (ushort)0xffff, (ushort)0xffff, 6_000_000u, (byte)0, 5000u));
    }

    [Test]
    public async Task 衛星は名前に_TSID_があれば_stream_id()
    {
        var tuning = ChannelTable.Parse("BS15:16626")!;
        var tune = Tune(UserlandTuner.TuneRequest(7, tuning, tuning.StreamId, "15v"));
        await Assert.That(tune.System).IsEqualTo((byte)2);
        await Assert.That(tune.Khz).IsEqualTo((ulong)tuning.Frequency);
        await Assert.That(tune.StreamId).IsEqualTo((ushort)16626);
        await Assert.That(tune.Slot).IsEqualTo((ushort)0xffff);
        await Assert.That(tune.Bandwidth).IsEqualTo(0u);
        // 15V は設定に書いてあるチューナーだけ
        await Assert.That(tune.Lnb).IsEqualTo((byte)15);
    }

    [Test]
    public async Task 衛星で_TSID_が無ければ_slot_0_で先頭の_TS()
    {
        // NIT を読む入口 (BS15)。中継器のどの TS にもネットワーク全体の NIT が流れている
        var tune = Tune(UserlandTuner.TuneRequest(7, ChannelTable.Parse("BS15")!, ChannelTable.NoStreamId, null));
        await Assert.That(tune.Slot).IsEqualTo((ushort)0);
        await Assert.That(tune.StreamId).IsEqualTo((ushort)0xffff);
        await Assert.That(tune.Lnb).IsEqualTo((byte)0);

        // CS は 1 本しか入っていないので slot 0。11v は IPC に無い (0V か 15V)。指定しない
        var cs = Tune(UserlandTuner.TuneRequest(7, ChannelTable.Parse("CS04:28736")!, ChannelTable.NoStreamId, "11v"));
        await Assert.That(cs.Slot).IsEqualTo((ushort)0);
        await Assert.That(cs.Lnb).IsEqualTo((byte)0);
    }

    [Test]
    public async Task 受信機の種別と違う方式は選局しない()
    {
        var split = Receivers(SplitList);
        var error = Assert.Throws<IOException>(() => UserlandTuner.Check(split, 2, ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).Contains("GR 用");
        UserlandTuner.Check(split, 0, ChannelTable.Parse("BS15:16625")!);

        // どの受信機も両方受けられる筐体
        var both = Receivers(BothList);
        UserlandTuner.Check(both, 4, ChannelTable.Parse("BS15:16625")!);
        UserlandTuner.Check(both, 4, ChannelTable.Parse("T27")!);
    }

    [Test]
    public async Task 無い受信機は選局しない()
    {
        var error = Assert.Throws<IOException>(() => UserlandTuner.Check(Receivers(BothList), 5, ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).Contains("受信機 5 はありません");
    }

    [Test]
    public async Task 受信機を問い合わせられていなければ_常駐に任せる()
    {
        UserlandTuner.Check(null, 7, ChannelTable.Parse("BS15:16625")!);
        await Task.CompletedTask;
    }

    [Test]
    public async Task _15V_を出せない受信機では_0V_で選局する()
    {
        var bs = ChannelTable.Parse("BS15:16625")!;
        List<UserlandReceiver> cannot = [new(0, true, true, false)];
        List<UserlandReceiver> can = [new(0, true, true, true)];
        List<UserlandReceiver> unknown = [new(0, true, true)];

        await Assert.That(UserlandTuner.Lnb(cannot, 0, bs, "15v")).IsNull();
        // 出せる・分からない・受信機を問い合わせられていない、は要求どおり
        await Assert.That(UserlandTuner.Lnb(can, 0, bs, "15v")).IsEqualTo("15v");
        await Assert.That(UserlandTuner.Lnb(unknown, 0, bs, "15v")).IsEqualTo("15v");
        await Assert.That(UserlandTuner.Lnb(null, 0, bs, "15v")).IsEqualTo("15v");
        // 地上波・15V を指定しないチューナーは触らない
        await Assert.That(UserlandTuner.Lnb(cannot, 0, ChannelTable.Parse("T27")!, "15v")).IsEqualTo("15v");
        await Assert.That(UserlandTuner.Lnb(cannot, 0, bs, null)).IsNull();
    }

    [Test]
    public async Task 注意書きは出したチューナーだけが消す()
    {
        // 設定を変えて開き直すとき、古いチューナーの後始末 (Dispose) が新しいチューナーの出した注意書きを消さない
        const string device = "asicen:9-9:0";
        object old = new(), fresh = new();
        TunerNotice.Set(device, fresh, "0V で選局しています");
        TunerNotice.Clear(device, old);
        await Assert.That(TunerNotice.Get(device)).IsEqualTo("0V で選局しています");
        TunerNotice.Clear(device, fresh);
        await Assert.That(TunerNotice.Get(device)).IsNull();
    }
}

/*
 * asicend は使う受信機がある間だけ動かす (UserlandDaemon.Prepare)。受信機を全部使わない設定にした筐体は止めて
 * USB を手放し、使う設定に戻したら起動し直す。内蔵カードリーダーを復号に使っている間は止めない。
 * 常駐の代わりに sleep を起動する (止めるのは SIGTERM)
 */
[ExcludeOn(OS.Windows)]
public class UserlandDaemonTests
{
    private sealed class SleepDaemon(string id, string dir) : UserlandDaemon("sleep", id)
    {
        public static SleepDaemon For(string id, string dir) => For(id, () => new SleepDaemon(id, dir));

        public override string CardName => $"sleep {Id} Internal Card Reader";

        public override void Ensure()
        {
            if (Running) return;
            Launch("sleep", ["60"], dir, () => true, () => { });
        }
    }

    [Test]
    public async Task 使う受信機が無くなった筐体は止め_戻したら起動し直す()
    {
        await Task.Yield();
        var dir = Directory.CreateTempSubdirectory("daemon").FullName;
        var tag = Guid.NewGuid().ToString("N");
        var a = SleepDaemon.For($"{tag}a", dir);
        var b = SleepDaemon.For($"{tag}b", dir);
        SleepDaemon Daemon(string id) => SleepDaemon.For(id, dir);
        string[] both = [$"{tag}a", $"{tag}b"];
        try
        {
            UserlandDaemon.Prepare(both, Daemon, _ => false);
            await Assert.That(a.Running && b.Running).IsTrue();

            // b の受信機を全部使わない設定にした
            UserlandDaemon.Prepare([$"{tag}a"], Daemon, _ => false);
            await Assert.That(a.Running).IsTrue();
            await Assert.That(b.Running).IsFalse();

            // 内蔵カードリーダーを復号に使っている間は止めない。カードリーダーも使わない設定にしたら止まる
            UserlandDaemon.Prepare([], Daemon, name => name == a.CardName);
            await Assert.That(a.Running).IsTrue();
            UserlandDaemon.Prepare([], Daemon, _ => false);
            await Assert.That(a.Running).IsFalse();

            // 使う設定に戻した
            UserlandDaemon.Prepare(both, Daemon, _ => false);
            await Assert.That(a.Running && b.Running).IsTrue();
        }
        finally
        {
            a.Stop();
            b.Stop();
            Directory.Delete(dir, recursive: true);
        }
    }
}
