using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 の内蔵カードリーダー (Dt295NativeCard) を、偽の機材 (Dt295Fake の UART のモデル) で確かめる。
 * 電源投入・切断の表と端子の扱いは仕様書 (dt295-resident/spec.md) の 10 章。UART のモデルは偽物が作ったもので、実機の読み値ではない。
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

    /// <summary>機材のプログラムを置いた偽物。<paramref name="program"/> なら、カードの送受信を機材のプログラムに実行させる</summary>
    private static (Dt295Fake Fake, Dt295NativeLink Link) ProgramRig(bool program)
    {
        var fake = new Dt295Fake { CardAtr = BcasAtr, CardResponder = Respond };
        fake.PlaceBody(hook: true);
        return (fake, new Dt295NativeLink(fake) { CardProgram = program });
    }

    private static bool Uart(uint address) => address is >= 0xFEA000 and <= 0xFEA03F;

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 機材のプログラムでもホストでも_同じ_ATR_と応答になり_UART_に同じ順で書く(bool program)
    {
        var (fake, link) = ProgramRig(program);
        var blocks = new List<byte[]>();
        fake.CardResponder = block =>
        {
            blocks.Add(block);
            return Respond(block);
        };
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        await Assert.That(card.Reset()).IsEquivalentTo(BcasAtr);
        var before = fake.Stores.Count;
        var controls = fake.Controls;
        await Assert.That(card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });

        // CardUart.Send と同じ順: 受けの LRC、送りの LRC、各バイト、状態、制御、開始
        var block = blocks.Last();
        var expected = new List<(uint, uint)> { (CardUart.RxLrc, 0), (CardUart.TxLrc, 0) };
        expected.AddRange(block.Select(b => (CardUart.Tx, (uint)b)));
        expected.AddRange([(CardUart.Status, 0x3FF), (CardUart.Control, 0x200), (CardUart.Start, 1)]);
        await Assert.That(fake.Stores.Skip(before).Where(s => Uart(s.Address)).Select(s => (s.Address, s.Value))).IsEquivalentTo(expected, CollectionOrdering.Matching);
        // 機材のプログラムなら、送りは要求と応答の 2 回、受けも 1 回の読み出しで 2 回の制御転送で済む (ホストは 1 バイトに 1 回)
        var used = fake.Controls - controls;
        if (program) await Assert.That(used).IsLessThan(block.Length + 6L);
        else await Assert.That(used).IsGreaterThan(block.Length + 6L);
    }

    [Test]
    public async Task 長いブロックは_SDRAM_に置いて送らせ_256_バイト以上は制御に_0x280_を書く()
    {
        var (fake, link) = ProgramRig(program: true);
        link.AllowCardUart = true;
        foreach (var length in new[] { 49, 258 })
        {
            var block = Enumerable.Range(0, length).Select(i => (byte)(i * 7 + 3)).ToArray();
            var sent = new List<byte[]>();
            fake.CardResponder = got =>
            {
                sent.Add(got);
                return [];
            };
            var before = fake.Stores.Count;

            link.CardSend(block);

            await Assert.That(sent.Single()).IsEquivalentTo(block, CollectionOrdering.Matching);
            await Assert.That(fake.Get(Dt295NativePrograms.BatchPhysical, 1)).IsEqualTo((uint)block[0]);
            var control = fake.Stores.Skip(before).Single(s => s.Address == CardUart.Control).Value;
            await Assert.That(control).IsEqualTo(length >= 256 ? 0x280u : 0x200u);
        }
    }

    [Test]
    public async Task 受けは受けた数と上限と_48_バイトの小さいほうだけ読み_無ければ空()
    {
        var (fake, link) = ProgramRig(program: true);
        await Assert.That(link.CardReceive(10)).IsEmpty();
        for (var i = 0; i < 60; i++) fake.CardRx.Enqueue((byte)i);

        await Assert.That(link.CardReceive(3)).IsEquivalentTo(new byte[] { 0, 1, 2 }, CollectionOrdering.Matching);
        var many = link.CardReceive(100);
        await Assert.That(many.Length).IsEqualTo(Dt295NativePrograms.InlineCardBytes);
        await Assert.That(many[0]).IsEqualTo((byte)3);
        await Assert.That(fake.CardRx.Count).IsEqualTo(60 - 3 - Dt295NativePrograms.InlineCardBytes);
        await Assert.That(link.CardReceive(0)).IsEmpty();
        await Assert.That(fake.CardRx.Count).IsEqualTo(60 - 3 - Dt295NativePrograms.InlineCardBytes);
    }

    [Test]
    public async Task 機材のプログラムに送らせるのも_カードの_UART_を許可するまで例外にして書かない()
    {
        var (fake, link) = ProgramRig(program: true);

        await Assert.That(() => link.CardSend([0x00, 0x00, 0x00, 0x00])).Throws<Dt295NativeException>();
        await Assert.That(fake.Stores.Any(s => Uart(s.Address))).IsFalse();
    }

    [Test]
    public async Task 使えるかの確認は_body_があれば真で_無ければ偽で_どちらも_UART_に書かず受けも読まない()
    {
        var (withBody, link) = ProgramRig(program: false);
        withBody.CardRx.Enqueue(0x3B);
        await Assert.That(link.ProbeCardProgram()).IsTrue();
        await Assert.That(withBody.Stores.Any(s => Uart(s.Address))).IsFalse();
        await Assert.That(withBody.CardRx.Count).IsEqualTo(1);

        var bare = new Dt295Fake();
        await Assert.That(new Dt295NativeLink(bare).ProbeCardProgram()).IsFalse();
        await Assert.That(bare.Stores.Any(s => Uart(s.Address))).IsFalse();
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 機材を開くと_カードの送受信が機材のプログラムで通るかを確かめ_通らなければホストが_1_バイトずつ読み書きする(bool works)
    {
        var fake = new Dt295Fake { CardAtr = BcasAtr, CardResponder = Respond };
        if (!works)
        {
            // カードの操作 (3・4) の要求だけ、プログラムが動かなかったときと同じく、要求をそのまま 0xC4620 に書いたことにする
            fake.CpuSetup = cpu =>
            {
                var operation = fake.Get(Dt295NativePrograms.Staging + 4, 4);
                if (operation is 3 or 4) cpu.Pc = Dt295NativePrograms.ContinueWrite;
            };
        }
        var port = $"test-{Guid.NewGuid():N}";
        var device = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000);
        try
        {
            await Assert.That(device.Link.CardProgram).IsEqualTo(works);
            using var handle = new Dt295NativeCardHandle("DT295", device);
            await Assert.That(handle.Reset()).IsEquivalentTo(BcasAtr);
            await Assert.That(handle.Transmit([0x90, 0x32, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });
        }
        finally
        {
            Dt295NativeDevice.CloseIfIdle(port);
        }
    }

    [Test]
    public async Task 電源投入の表の順に書き_ATR_を読み_T1_で送受信できる()
    {
        var (fake, link) = Rig();
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        var atr = card.Reset();

        await Assert.That(atr).IsEquivalentTo(BcasAtr);
        var uart = fake.Stores.Where(s => s.Address is >= 0xFEA000 and <= 0xFEA03F).Take(17).ToArray();
        // 仕様書 10 章の投入の表: 段ごとのアドレス。0xFEA004 の値は極性 (0xF00223 = 0) から bit3、段 7 は | 2、段 16 は | 6
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
    public async Task 電源が入って_T1_の取り決めが済んでいれば_Reset_は入れ直さずに同じ_ATR_を返し_カードが抜かれたら入れ直す()
    {
        var (fake, link) = Rig();
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });

        var first = card.Reset();
        var writes = fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F);
        var second = card.Reset();

        await Assert.That(second).IsEquivalentTo(first);
        // 2 回目は UART に書かない (電源の入れ直しも、IFSD の取り決めもしない)
        await Assert.That(fake.Stores.Count(s => s.Address is >= 0xFEA000 and <= 0xFEA03F)).IsEqualTo(writes);
        await Assert.That(card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });

        // 抜かれたら送受信は CardAbsentException になり、挿し直したあとの Reset は電源から入れ直す
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

        tuner.Tune(tuning);
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