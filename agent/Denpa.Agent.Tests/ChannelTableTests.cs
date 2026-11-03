using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 選局表。
 *
 * ここは**数字が 1 つ違っても ioctl は通り、ただ同期しないだけ**という出方を
 * するので、値そのものを押さえておく。当てているのは recisdb が持っている表と
 * 同じ数字で、いま実機で選局できているものと揃っているかどうかがすべて
 * (実際に受信できるかは `--tune` で実機に当てる。Probe.cs)。
 */

public class ChannelTableTests
{
    [Test]
    public async Task 地上波は_Hz_で数える()
    {
        // UHF 13ch = 473.142857 MHz。1/7 MHz のずれは放送のとおりで、丸めない
        await Assert.That(ChannelTable.Parse("T13")!.Frequency).IsEqualTo(473_142_857u);
        await Assert.That(ChannelTable.Parse("T27")!.Frequency).IsEqualTo(557_142_857u);
        await Assert.That(ChannelTable.Parse("T62")!.Frequency).IsEqualTo(767_142_857u);
    }

    [Test]
    public async Task CATV_は地上波と同じ選局で周波数だけが違う()
    {
        // ミッドバンド C13-C22 (C13 = 111.142857 MHz) とスーパーハイバンド C23-C63 (C23 = 225.142857 MHz)
        var c13 = ChannelTable.Parse("C13")!;
        await Assert.That(c13.Type).IsEqualTo("GR");
        await Assert.That(c13.Delivery).IsEqualTo(ChannelTable.SysIsdbt);
        await Assert.That(c13.Frequency).IsEqualTo(111_142_857u);
        await Assert.That(ChannelTable.Parse("C22")!.Frequency).IsEqualTo(165_142_857u);
        await Assert.That(ChannelTable.Parse("C23")!.Frequency).IsEqualTo(225_142_857u);
        await Assert.That(ChannelTable.Parse("C25")!.Frequency).IsEqualTo(237_142_857u);
        await Assert.That(ChannelTable.Parse("C63")!.Frequency).IsEqualTo(465_142_857u);
        // 範囲の外と CS は CATV として読まない
        await Assert.That(ChannelTable.Parse("C12")).IsNull();
        await Assert.That(ChannelTable.Parse("C64")).IsNull();
        await Assert.That(ChannelTable.Parse("CS02")!.Type).IsEqualTo("CS");
    }

    [Test]
    public async Task 衛星は_kHz_で数える()
    {
        /*
         * DVB API の決まりで、**地上波は Hz、衛星は kHz**。取り違えても
         * ioctl は通るので、ここを間違えると「同期しない」としか見えない
         */
        var bs = ChannelTable.Parse("BS01:16400")!;
        await Assert.That(bs.Delivery).IsEqualTo(ChannelTable.SysIsdbs);
        await Assert.That(bs.Frequency).IsEqualTo(1_049_480u);

        // 中継は 38.36 MHz 刻み。BS03 は BS01 の 1 つ隣
        await Assert.That(ChannelTable.Parse("BS03:16432")!.Frequency).IsEqualTo(1_087_840u);
        await Assert.That(ChannelTable.Parse("BS23:18288")!.Frequency).IsEqualTo(1_471_440u);

        // CS は 40 MHz 刻みで、BS とは別の並び
        await Assert.That(ChannelTable.Parse("CS02:24608")!.Frequency).IsEqualTo(1_613_000u);
        await Assert.That(ChannelTable.Parse("CS24:29056")!.Frequency).IsEqualTo(2_053_000u);
    }

    [Test]
    public async Task 衛星は名前の_TSID_で_TS_を選ぶ()
    {
        // BS-15 の 2 本は**同じ周波数**。見分けるのは名前の TSID で、そのまま復調器に渡す
        var nhk = ChannelTable.Parse("BS15:16625")!;
        var bs10 = ChannelTable.Parse("BS15:18675")!;
        await Assert.That(bs10.Frequency).IsEqualTo(nhk.Frequency);
        await Assert.That(nhk.StreamId).IsEqualTo(16625u);
        await Assert.That(bs10.StreamId).IsEqualTo(18675u);
    }

    [Test]
    public async Task TSID_の無い衛星の名前は中継器の先頭の_TS()
    {
        // NIT を読む入口。どの TS にもネットワーク全体の NIT が流れているので、選り分けなくてよい
        var entry = ChannelTable.Parse("BS15")!;
        await Assert.That(entry.Frequency).IsEqualTo(ChannelTable.Parse("BS15:16625")!.Frequency);
        await Assert.That(entry.StreamId).IsEqualTo(ChannelTable.NoStreamId);
    }

    [Test]
    public async Task CS_と地上波は選り分けない()
    {
        // CS は 1 つの中継器に 1 本しか入っていない。名前の TSID は TS を見分けるためだけ
        await Assert.That(ChannelTable.Parse("CS04:28736")!.StreamId).IsEqualTo(ChannelTable.NoStreamId);
        await Assert.That(ChannelTable.Parse("CS04")!.StreamId).IsEqualTo(ChannelTable.NoStreamId);
        await Assert.That(ChannelTable.Parse("T27")!.StreamId).IsEqualTo(ChannelTable.NoStreamId);
    }

    [Test]
    public async Task ゼロ詰めは同じものとして読む()
    {
        await Assert.That(ChannelTable.Parse("BS01:16400")).IsEqualTo(ChannelTable.Parse("BS1:16400"));
    }

    [Test]
    [Arguments("T12")]      // UHF は 13 から
    [Arguments("T63")]      // 62 まで
    [Arguments("BS02:16400")]   // BS は奇数だけ
    [Arguments("BS25:16400")]
    [Arguments("BS15_0")]   // 相対の番号は読まない (予告なしに詰められる。TSID で指す)
    [Arguments("BS15:")]
    [Arguments("BS15:0")]   // TSID は 1〜65535
    [Arguments("BS15:65536")]
    [Arguments("BS15:1x")]
    [Arguments("CS01:24608")]   // CS は偶数だけ
    [Arguments("CS26")]
    [Arguments("")]
    [Arguments("T")]
    [Arguments("SKY1")]
    public async Task 受け取らない名前(string name)
    {
        await Assert.That(ChannelTable.Parse(name)).IsNull();
    }

    [Test]
    [Arguments("BS07")]
    [Arguments("BS17:18000")]
    public async Task ISDB_S3_の中継は受け取らない(string name)
    {
        // BS-7 と BS-17 は 4K/8K。この復調器では受からない (実機に渡すと「同期しない」まで 5 秒かかる)
        await Assert.That(ChannelTable.Parse(name)).IsNull();
    }
}
