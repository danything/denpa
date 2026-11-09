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
    public async Task 衛星の名前の後ろに番組番号を付けられる()
    {
        // 衛星の名前に付けた番組番号を読む。TSID と同じ中継器の同じ周波数
        var plain = ChannelTable.Parse("BS01:16400")!;
        var service = ChannelTable.Parse("BS01:16400/152")!;
        await Assert.That(plain.ServiceId).IsNull();
        await Assert.That(service.ServiceId).IsEqualTo(152);
        await Assert.That(service.StreamId).IsEqualTo(16400u);
        await Assert.That(service.Frequency).IsEqualTo(plain.Frequency);
        // TSID が無くても付けられる (先頭の TS の番組)
        await Assert.That(ChannelTable.Parse("BS15/101")!.ServiceId).IsEqualTo(101);
        await Assert.That(ChannelTable.Parse("BS15/101")!.StreamId).IsEqualTo(ChannelTable.NoStreamId);
        await Assert.That(ChannelTable.Parse("CS04:28736/161")!.ServiceId).IsEqualTo(161);
    }

    [Test]
    [Arguments("BS15:16625/")]
    [Arguments("BS15:16625/0")]       // 番組番号は 1〜65535
    [Arguments("BS15:16625/65536")]
    [Arguments("BS15:16625/1x")]
    [Arguments("BS15:16625/1/2")]
    [Arguments("T27/152")]            // 地上波は番組を指さない
    [Arguments("C13/152")]
    public async Task 番組番号の読めない名前は受け取らない(string name)
    {
        await Assert.That(ChannelTable.Parse(name)).IsNull();
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
    [Arguments("H00")]      // J.83B は H01 から
    [Arguments("H106")]     // H105 まで
    [Arguments("H")]
    [Arguments("H40:1")]
    public async Task 受け取らない名前(string name)
    {
        await Assert.That(ChannelTable.Parse(name)).IsNull();
    }

    [Test]
    public async Task J83B_は_H01_から_H105_の名前で_SKY_の選局になる()
    {
        // 93.25 MHz から 6.5 MHz おきの中心周波数 (仕様書 7.1)。地上波と同じく Hz で、1/7 MHz はずらさない
        var h01 = ChannelTable.Parse("H01")!;
        await Assert.That(h01.Type).IsEqualTo("SKY");
        await Assert.That(h01.Delivery).IsEqualTo(ChannelTable.SysDvbcAnnexB);
        await Assert.That(h01.Cable).IsTrue();
        await Assert.That(h01.Satellite).IsFalse();
        await Assert.That(h01.StreamId).IsEqualTo(ChannelTable.NoStreamId);
        await Assert.That(h01.Frequency).IsEqualTo(93_250_000u);
        await Assert.That(ChannelTable.Parse("H40")!.Frequency).IsEqualTo(346_750_000u);
        await Assert.That(ChannelTable.Parse("H105")!.Frequency).IsEqualTo(769_250_000u);
        // 0 詰めは無くてもよい
        await Assert.That(ChannelTable.Parse("H1")).IsEqualTo(h01);
        // ずらした周波数を持たないもの
        await Assert.That(h01.ShiftedFrequency).IsNull();
        foreach (var name in new[] { "H10", "H13", "H25", "H29", "H43", "H45" })
            await Assert.That(ChannelTable.Parse(name)!.ShiftedFrequency).IsNull();
    }

    [Test]
    [Arguments("H11", 158_250_000u, 159_250_000u)]  // +1 MHz
    [Arguments("H12", 164_750_000u, 165_750_000u)]
    [Arguments("H26", 255_750_000u, 259_750_000u)]  // +4 MHz
    [Arguments("H27", 262_250_000u, 266_250_000u)]
    [Arguments("H28", 268_750_000u, 272_750_000u)]
    [Arguments("H44", 372_750_000u, 374_950_000u)]  // +2.2 MHz
    public async Task 地域によってずらして送られるチャンネルはずらした周波数も持つ(string name, uint frequency, uint shifted)
    {
        // 仕様書 7.1。どちらで送られているかは選局してみるまで分からない
        var tuning = ChannelTable.Parse(name)!;
        await Assert.That(tuning.Frequency).IsEqualTo(frequency);
        await Assert.That(tuning.ShiftedFrequency).IsEqualTo(shifted);
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
