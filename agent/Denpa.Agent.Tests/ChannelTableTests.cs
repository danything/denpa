using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 選局表。
 *
 * ここは**数字が1つ違っても ioctl は通り、ただ同期しないだけ**という出方を
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
    public async Task 同じ周波数のTSは相対番号で見分ける()
    {
        // BS01_0 と BS01_3 は**同じ周波数**。開いたままなら選局し直さずに済む
        await Assert.That(ChannelTable.Parse("BS01_3")!.Frequency).IsEqualTo(ChannelTable.Parse("BS01_0")!.Frequency);
        await Assert.That(ChannelTable.Parse("BS01_0")!.RelativeTs).IsEqualTo(0);
        await Assert.That(ChannelTable.Parse("BS01_3")!.RelativeTs).IsEqualTo(3);
    }

    [Test]
    public async Task 衛星のスロットは相対番号そのもの()
    {
        // TSID が分からないときに px4d の TUNE の slot で渡す (Px4.cs)。CS は1本しか入っていない
        await Assert.That(ChannelTable.Parse("BS01_2")!.Slot).IsEqualTo(2);
        await Assert.That(ChannelTable.Parse("BS23_0")!.Slot).IsEqualTo(0);
        await Assert.That(ChannelTable.Parse("BS15")!.Slot).IsEqualTo(0);
        await Assert.That(ChannelTable.Parse("CS02")!.Slot).IsEqualTo(0);
        await Assert.That(ChannelTable.Parse("T18")!.Slot).IsEqualTo(0);
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
    [Arguments("BS19_8")]   // 同じ周波数には 8 本まで
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
        // 1つの中継に1本しか入っていない
        var cs = ChannelTable.Parse("CS02")!;
        await Assert.That(ChannelTable.StreamId("CS02", cs, null)).IsEqualTo(ChannelTable.NoStreamId);
    }

    [Test]
    public async Task スキャン結果が埋め込んだ表に勝つ()
    {
        // BS は再編がある。1度でもスキャンしていれば、そちらが必ず新しい
        var bs = ChannelTable.Parse("BS15_0")!;
        await Assert.That(ChannelTable.StreamId("BS15_0", bs, null)).IsEqualTo(16625u);
        await Assert.That(ChannelTable.StreamId("BS15_0", bs, _ => 9999)).IsEqualTo(9999u);
    }

    [Test]
    public async Task 表にも無ければ選り分けない()
    {
        // 埋め込んだ表に無い同じ周波数の TS。TSID を指定せずに選局して、あとは復調器任せ
        var bs = ChannelTable.Parse("BS15_7")!;
        await Assert.That(ChannelTable.StreamId("BS15_7", bs, _ => null)).IsEqualTo(ChannelTable.NoStreamId);
    }
}

public class DvbDeviceTests
{
    [Test]
    // パスの区切りが / の前提。Windows では割り方が違う
    [ExcludeOn(OS.Windows)]
    public async Task frontend_からアダプタと番号を割り出す()
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

    // 電圧の errno。カーネルの中の ENOTSUPP はそのまま 524 で返る
    private const int Enotsupp = 524;
    private const int Eopnotsupp = 95;
    private const int Ebusy = 16;

    [Test]
    public async Task LNB_の電源は指示した電圧で送る()
    {
        var sent = new List<int>();

        var powered = DvbTuner.PowerLnb("/dev/dvb/adapter9/0", 1, voltage => { sent.Add(voltage); return 0; });

        await Assert.That(powered).IsTrue();
        await Assert.That(sent).IsEquivalentTo([1]);
    }

    [Test]
    [Arguments(Enotsupp)]
    [Arguments(Eopnotsupp)]
    public async Task 電圧を変えられない機材では電源を飛ばして選局に進む(int errno)
    {
        // PX-BCUD (em28xx + tc90522) のように set_voltage を持たない frontend。投げずに false を返し、記録に残す
        var adapter = $"/dev/dvb/adapter{errno}/lnb-test";

        var powered = DvbTuner.PowerLnb(adapter, 1, _ => errno);

        await Assert.That(powered).IsFalse();
        await Assert.That(Log.Recent.Snapshot().Count(line => line.Text == $"[{adapter}] この機材は LNB の電源を出せません。電源を出さずに選局します")).IsEqualTo(1);
    }

    [Test]
    public void ほかの失敗は選局の失敗にする()
    {
        // 断られた理由が「できない」でなければ、黙って続けると電源の来ないまま同期を待つことになる
        Assert.Throws<IOException>(() => DvbTuner.PowerLnb("/dev/dvb/adapter8/0", 1, _ => Ebusy));
    }
}