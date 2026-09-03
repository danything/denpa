using Denpa.Agent;
using System.Threading.Tasks;

namespace Denpa.Agent.Tests;

/*
 * 選局表。
 *
 * ここは**数字が1つ違っても ioctl は通り、ただ同期しないだけ**という出方を
 * するので、値そのものを押さえておく。当てているのは recisdb が持っている表と
 * 同じ数字で、いま実機で選局できているものと揃っているかどうかがすべて
 * (実際に掴めるかは `--tune` で実機に当てる。Probe.cs)。
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
    public async Task 衛星は_kHz_で数える()
    {
        /*
         * DVB API の決まりで、**地上波は Hz、衛星は kHz**。取り違えても
         * ioctl は通るので、ここを間違えると「同期しない」としか見えない
         */
        var bs = ChannelTable.Parse("BS01_0")!;
        await Assert.That(bs.Delivery).IsEqualTo(ChannelTable.SysIsdbs);
        await Assert.That(bs.Frequency).IsEqualTo(1_049_480u);

        // 中継は 38.36 MHz 刻み。BS03 は BS01 の1つ隣
        await Assert.That(ChannelTable.Parse("BS03_0")!.Frequency).IsEqualTo(1_087_840u);
        await Assert.That(ChannelTable.Parse("BS23_0")!.Frequency).IsEqualTo(1_471_440u);

        // CS は 40 MHz 刻みで、BS とは別の並び
        await Assert.That(ChannelTable.Parse("CS02")!.Frequency).IsEqualTo(1_613_000u);
        await Assert.That(ChannelTable.Parse("CS24")!.Frequency).IsEqualTo(2_053_000u);
    }

    [Test]
    public async Task 同じ周波数に相乗りしている本数を覚えておく()
    {
        // BS01_0 と BS01_1 は**同じ周波数**。開いたままなら選局し直さずに済む
        await Assert.That(ChannelTable.Parse("BS01_3")!.Frequency).IsEqualTo(ChannelTable.Parse("BS01_0")!.Frequency);
        await Assert.That(ChannelTable.Parse("BS01_0")!.RelativeTs).IsEqualTo(0);
        await Assert.That(ChannelTable.Parse("BS01_3")!.RelativeTs).IsEqualTo(3);
    }

    [Test]
    public async Task px4_の番号は別の数え方()
    {
        // chardev は周波数ではなく表の番号で言う。地上波は物理チャンネル+50
        await Assert.That(ChannelTable.Parse("T18")!.FreqNo).IsEqualTo(68);
        // 衛星はスロットが相対TS番号そのもの
        await Assert.That((ChannelTable.Parse("BS01_2")!.FreqNo, ChannelTable.Parse("BS01_2")!.Slot)).IsEqualTo((0, 2));
        await Assert.That(ChannelTable.Parse("BS23_0")!.FreqNo).IsEqualTo(11);
        await Assert.That(ChannelTable.Parse("CS02")!.FreqNo).IsEqualTo(12);
        await Assert.That(ChannelTable.Parse("CS24")!.FreqNo).IsEqualTo(23);
    }

    [Test]
    public async Task ゼロ詰めは同じものとして読む()
    {
        await Assert.That(ChannelTable.Parse("BS01_0")!.Frequency).IsEqualTo(ChannelTable.Parse("BS1_0")!.Frequency);
    }

    [Test]
    [Arguments("T12")]      // UHF は 13 から
    [Arguments("T63")]      // 62 まで
    [Arguments("BS02_0")]   // BS は奇数だけ
    [Arguments("BS25_0")]
    [Arguments("BS19_8")]   // 相乗りは 8 本まで
    [Arguments("CS01")]     // CS は偶数だけ
    [Arguments("CS26")]
    [Arguments("")]
    [Arguments("T")]
    [Arguments("SKY1")]
    public async Task 受け取らない名前(string name)
    {
        await Assert.That(ChannelTable.Parse(name)).IsNull();
    }

    [Test]
    [Arguments("BS07_0")]
    [Arguments("BS17_0")]
    public async Task ISDB_S3_の中継は受け取らない(string name)
    {
        // BS-7 と BS-17 は 4K/8K。この復調器では受からないので、総当たりの
        // スキャンでも試させない (実機に投げれば「同期しない」で5秒溶ける)
        await Assert.That(ChannelTable.Parse(name)).IsNull();
    }
}

public class StreamIdTests
{
    [Test]
    public async Task 地上波は選り分けない()
    {
        var gr = ChannelTable.Parse("T27")!;
        await Assert.That(ChannelTable.StreamId("T27", gr, _ => 1234)).IsEqualTo(ChannelTable.NoStreamId);
    }

    [Test]
    public async Task CS_も選り分けない()
    {
        // 1つの中継に1本しか乗っていない
        var cs = ChannelTable.Parse("CS02")!;
        await Assert.That(ChannelTable.StreamId("CS02", cs, null)).IsEqualTo(ChannelTable.NoStreamId);
    }

    [Test]
    public async Task スキャン結果が焼き込んだ表に勝つ()
    {
        // BS は再編がある。1度でもスキャンしていれば、そちらが必ず新しい
        var bs = ChannelTable.Parse("BS15_0")!;
        await Assert.That(ChannelTable.StreamId("BS15_0", bs, null)).IsEqualTo(16625u);
        await Assert.That(ChannelTable.StreamId("BS15_0", bs, _ => 9999)).IsEqualTo(9999u);
    }

    [Test]
    public async Task 表にも無ければ選り分けない()
    {
        // 焼き込んだ表に無い相乗り。TSID を指定せずに掴んで、あとは復調器任せ
        var bs = ChannelTable.Parse("BS15_7")!;
        await Assert.That(ChannelTable.StreamId("BS15_7", bs, _ => null)).IsEqualTo(ChannelTable.NoStreamId);
    }
}

public class DvbDeviceTests
{
    [Test]
    public async Task frontend_から_demux_と_dvr_を組み立てる()
    {
        var (adapter, number) = DvbTuner.Split("/dev/dvb/adapter1/frontend0");

        await Assert.That(adapter).IsEqualTo("/dev/dvb/adapter1");
        await Assert.That(number).IsEqualTo("0");
    }

    [Test]
    public void DVB_でないデバイスは受け取らない()
    {
        Assert.Throws<ArgumentException>(() => DvbTuner.Split("/dev/px4video0"));
    }
}