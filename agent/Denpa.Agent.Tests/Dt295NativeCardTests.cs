using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 の内蔵カードリーダー (Dt295NativeCard) を、偽の機材 (Dt295Fake の UART のモデル) で確かめる。
 * 電源投入・切断の表と端子の扱いは仕様書 (dt295-resident/spec.md) §10。UART のモデルは偽物が作ったもので、実機の読み値ではない。
 */
public class Dt295NativeCardTests
{
    /// <summary>B-CAS の ATR (T=1、IFSC 0x7C)</summary>
    private static readonly byte[] BcasAtr = Convert.FromHexString("3BF01200FF91 81B17C451F0399".Replace(" ", ""));

    private static byte[] Respond(byte[] block) =>
        // S(IFS 要求) には S(IFS 応答) で同じ値を返し、I ブロックには 90 00 を返す
        (block[1] & 0xC0) == 0xC0 ? T1Protocol.Block((byte)(block[1] | 0x20), block[3..^1]) : T1Protocol.Block(0x00, [0x90, 0x00]);

    private static (Dt295Fake Fake, Dt295NativeLink Link) Rig()
    {
        var fake = new Dt295Fake { CardAtr = BcasAtr, CardResponder = Respond };
        return (fake, new Dt295NativeLink(fake));
    }

    [Test]
    public async Task 電源投入の表の順に書き_ATR_を読み_T1_で送受信できる()
    {
        var (fake, link) = Rig();
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        var atr = card.Reset();

        await Assert.That(atr).IsEquivalentTo(BcasAtr);
        var uart = fake.Stores.Where(s => s.Address is >= 0xFEA000 and <= 0xFEA03F).Take(17).ToArray();
        // 仕様書 §10 の投入の表: 段ごとのアドレス。0xFEA004 の値は極性 (0xF00223 = 0) から bit3、段 7 は | 2、段 16 は | 6
        await Assert.That(uart.Select(s => s.Address)).IsEquivalentTo(new uint[]
        {
            0xFEA01C, 0xFEA004, 0xFEA014, 0xFEA000, 0xFEA000, 0xFEA004, 0xFEA008, 0xFEA004, 0xFEA000, 0xFEA000,
            0xFEA03C, 0xFEA020, 0xFEA024, 0xFEA018, 0xFEA014, 0xFEA034, 0xFEA004,
        }, CollectionOrdering.Matching);
        await Assert.That(uart[5].Value).IsEqualTo(0x8u);
        await Assert.That(uart[7].Value).IsEqualTo(0xAu);
        await Assert.That(uart[16].Value).IsEqualTo(0xEu);
        await Assert.That(uart[14].Value).IsEqualTo(0x0Du);

        await Assert.That(card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });
    }

    [Test]
    public async Task 端子の極性が_1_なら_bit3_を立てない()
    {
        var (fake, link) = Rig();
        fake.Put(0xF00220, 4, 0x00000001);
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        card.Reset();

        var lines = fake.Stores.Where(s => s.Address == 0xFEA004).Select(s => s.Value).ToArray();
        await Assert.That(lines[1]).IsEqualTo(0x0u);
        await Assert.That(lines[3]).IsEqualTo(0x6u);
    }

    [Test]
    public async Task 端子の組み合わせが_1_1_0_なら電源を入れない()
    {
        var (fake, link) = Rig();
        fake.Put(0xF00220, 4, 0x00000001);
        fake.Put(0xF00224, 4, 0x01000000);
        fake.Put(0xF0022C, 4, 0x00000000);
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        await Assert.That(() => card.Reset()).Throws<Dt295NativeException>();
        await Assert.That(fake.Stores.Any(s => s.Address >= 0xFEA000)).IsFalse();
    }

    [Test]
    public async Task 挿入は_bit10_と_F00224_の_XOR_が_1_のとき()
    {
        var (fake, link) = Rig();
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        await Assert.That(card.Present()).IsTrue();
        fake.CardInserted = false;
        await Assert.That(card.Present()).IsFalse();
        fake.Put(0xF00224, 4, 0x01000000);
        await Assert.That(card.Present()).IsTrue();
    }

    [Test]
    public async Task カードの_UART_は許可するまで書けず_端子のレジスタは書けない()
    {
        var (fake, link) = Rig();

        await Assert.That(() => link.Write32(0xFEA004, 4)).Throws<Dt295NativeException>();
        link.AllowCardUart = true;
        link.Write32(0xFEA004, 4);
        await Assert.That(() => link.Write32(0xF00222, 0)).Throws<Dt295NativeException>();
        await Assert.That(fake.Stores.Select(s => s.Address)).DoesNotContain(0xF00222u);
    }

    [Test]
    public async Task 片付けで切断の表を書く()
    {
        var (fake, link) = Rig();
        var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });
        card.Reset();
        var before = fake.Stores.Count;

        card.Dispose();

        await Assert.That(fake.Stores.Skip(before).Select(s => (s.Address, s.Value))).IsEquivalentTo(new (uint, uint)[]
        {
            (0xFEA004, 2), (0xFEA014, 0), (0xFEA000, 3), (0xFEA004, 0), (0xFEA004, 8),
        }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 電源が入って話し方が決まっていれば_Reset_は入れ直さずに同じ_ATR_を返し_カードが抜かれたら入れ直す()
    {
        var (fake, link) = Rig();
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        var first = card.Reset();
        var writes = fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F);
        var second = card.Reset();

        await Assert.That(second).IsEquivalentTo(first);
        // 2 回目は UART に書かない (電源の入れ直しも、話し方の取り決めもしない)
        await Assert.That(fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F)).IsEqualTo(writes);
        await Assert.That(card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });

        // 抜かれたら、次の Reset は電源から入れ直そうとして、カードが無い (挿入の印が無い) のを ATR が来ないことで知る
        fake.CardInserted = false;
        Assert.Throws<CardAbsentException>(() => card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00]));
        fake.CardInserted = true;
        await Assert.That(card.Reset()).IsEquivalentTo(first);
        await Assert.That(fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F)).IsGreaterThan(writes);
    }

    [Test]
    public async Task 機材を開いて選局すると_カードの準備が並んで進み_選局と同じ機材の制御転送を使っても両方済む()
    {
        var fake = new Dt295Fake { CardAtr = BcasAtr, CardResponder = Respond };
        var ring = new List<byte>();
        for (var i = 0; i < 40; i++)
        {
            var record = new byte[192];
            record[0] = 0x47;
            record[1] = 0x01;
            record[3] = (byte)(0x10 | (i & 0xF));
            ring.AddRange(record);
        }
        fake.PutRing(0, ring.ToArray());
        fake.WpOnStart = (uint)ring.Count;
        var port = $"test-{Guid.NewGuid():N}";
        var tuner = new Dt295NativeTuner("test", () => Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000), () => Dt295NativeDevice.CloseIfIdle(port));
        var tuning = ChannelTable.Parse("T25")!;

        tuner.Tune(tuning, tuning.StreamId);
        var device = tuner.Device!;
        await (device.CardWarmTask ?? throw new InvalidOperationException("カードの準備が始まっていません"));

        // カードは準備済みで、開いてからの時間が残る。ID の読み出しの Reset は電源を入れ直さない
        await Assert.That(device.CardReadyMs).IsGreaterThanOrEqualTo(0);
        var before = fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F);
        using var handle = new Dt295NativeCardHandle("DT295", device);
        await Assert.That(handle.Reset()).IsEquivalentTo(BcasAtr);
        await Assert.That(fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F)).IsEqualTo(before);
        tuner.Dispose();
    }
}