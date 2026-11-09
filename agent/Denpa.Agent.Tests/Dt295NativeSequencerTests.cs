using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * 機材の中の I2C の順次実行 (Dt295NativePrograms の操作 2) と、ホストが 1 つずつ実行する場合 (Dt295NativeI2c.Run) が、
 * 同じ手順で同じ結果になることを、偽の機材 (Dt295Fake。I2C のコントローラのモデルつき) で確かめる。機材のプログラムは FR30 のエミュレータで動かす。
 */
public class Dt295NativeSequencerTests
{
    private static (Dt295Fake Fake, Dt295NativeLink Link, Dt295NativeI2c I2c) Rig(bool sequencer)
    {
        var fake = new Dt295Fake();
        fake.PlaceBody(hook: true);
        var link = new Dt295NativeLink(fake);
        foreach (var register in Dt295NativeI2c.ClockRegisters) link.AllowedCoreWrites.Add(register);
        var i2c = new Dt295NativeI2c(link) { UseSequencer = sequencer };
        i2c.Prepare();
        return (fake, link, i2c);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 書きと読みの並びは機材の中でもホストでも同じ結果と同じ_I2C_の転送になる(bool sequencer)
    {
        var (fake, _, i2c) = Rig(sequencer);
        var batch = new Dt295I2cBatch();
        batch.Write(0x10, 0x01, 0x23);
        batch.Write(0x11, 0x05, 0x66, 0x77);
        batch.Write(0x10, 0x01);
        batch.Read(0x10, 1);
        batch.Write(0x11, 0x05);
        batch.Read(0x11, 2);

        var read = i2c.Run(batch);

        await Assert.That(read).IsEquivalentTo(new byte[] { 0x23, 0x66, 0x77 }, CollectionOrdering.Matching);
        await Assert.That(fake.I2cLog).IsEquivalentTo(new[] { "10 W 0123", "11 W 056677", "10 W 01", "10 R 1", "11 W 05", "11 R 2" }, CollectionOrdering.Matching);
        await Assert.That(i2c.Transfers).IsEqualTo(6L);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 読み_変更_書きは直前の読みの先頭バイトから書く値を作る(bool sequencer)
    {
        var (fake, _, i2c) = Rig(sequencer);
        fake.Terrestrial.Regs[0x20] = 0x23;
        var batch = new Dt295I2cBatch();
        batch.Write(0x10, 0x20);
        batch.Read(0x10, 1);
        batch.WriteModified(0x10, [0x20], 0x0F, 0x40);
        // 読みが 2 バイトなら先頭のバイトを使う (衛星の選局の t=16)
        batch.Write(0x11, 0x00);
        batch.Read(0x11, 2);
        batch.WriteModified(0x11, [0xFE, 0xC0, 0x50], 0x01, 0xF0);

        i2c.Run(batch);

        await Assert.That(fake.Terrestrial.Regs[0x20]).IsEqualTo((byte)0x43);
        await Assert.That(fake.I2cLog.Last()).StartsWith("11 W FEC050");
    }

    [Test]
    public async Task 長い並びは要求に入りきらないので_SDRAM_に置いて渡し_結果も同じ()
    {
        var (fake, _, i2c) = Rig(true);
        var batch = new Dt295I2cBatch();
        for (var reg = 0; reg < 30; reg++) batch.Write(0x10, (byte)(0x40 + reg), (byte)(0xA0 + reg));
        for (var reg = 0; reg < 30; reg++)
        {
            batch.Write(0x10, (byte)(0x40 + reg));
            batch.Read(0x10, 1);
        }

        var read = i2c.Run(batch);

        await Assert.That(read.Length).IsEqualTo(30);
        await Assert.That(read[0]).IsEqualTo((byte)0xA0);
        await Assert.That(read[29]).IsEqualTo((byte)0xBD);
        // 操作列は SDRAM の置き場にある
        await Assert.That(fake.Get(Dt295NativePrograms.BatchPhysical, 4)).IsNotEqualTo(0u);
    }

    [Test]
    public async Task ACK_が来ない転送で止まり_止まった番号を返し_続けて使える()
    {
        var (fake, link, i2c) = Rig(true);
        var good = new Dt295I2cBatch();
        good.Write(0x10, 0x01, 0x23);
        good.Write(0x11, 0x02, 0x34);
        var bad = Dt295I2cBatch.Encode([new Dt295I2cBatch.Op(0x30, [0x00], 0, false, 0, 0)]);

        // 0x30 には機器が無い。ホストの作る並びは 0x10・0x11 だけなので、符号化した操作列を直に渡す
        var reply = link.RunI2c([.. Dt295I2cBatch.Encode(good.Ops), .. bad, .. Dt295I2cBatch.Encode(good.Ops)], 5, 0);

        await Assert.That(reply.Code).IsEqualTo(Dt295NativePrograms.I2cNack);
        await Assert.That(reply.Index).IsEqualTo(2u);
        // 止まったあとの転送は実行しない
        await Assert.That(fake.I2cLog).IsEquivalentTo(new[] { "10 W 0123", "11 W 0234" }, CollectionOrdering.Matching);
        // バスは空いていて、次の並びが通る
        var next = new Dt295I2cBatch();
        next.Write(0x10, 0x01);
        next.Read(0x10, 1);
        await Assert.That(i2c.Run(next)[0]).IsEqualTo((byte)0x23);
    }

    [Test]
    public async Task ホストが作る並びは復調の_0x10_0x11_以外のアドレスを断る()
    {
        var batch = new Dt295I2cBatch();
        Assert.Throws<ArgumentOutOfRangeException>(() => batch.Write(0x30, 0x00));
        Assert.Throws<ArgumentOutOfRangeException>(() => batch.Read(0x12, 1));
        await Assert.That(batch.IsEmpty).IsTrue();
    }

    [Test]
    public async Task 分けるときは読みの結果を使う書きを読みと同じ塊に入れる()
    {
        var batch = new Dt295I2cBatch();
        batch.Write(0x10, 0x20);
        batch.Read(0x10, 1);
        batch.WriteModified(0x10, [0x20], 0x0F, 0x40);
        var chunks = batch.Split(opLimit: 8, resultLimit: 100).ToList();
        // 上限が小さくても、読みと書きは別の塊にならない
        await Assert.That(chunks.Any(chunk => chunk.Any(op => op.Modified) && !chunk.Any(op => op.Read > 0))).IsFalse();
    }

    [Test]
    public async Task 使えるかの確認は_body_があれば真で_無ければ偽()
    {
        var withBody = Rig(true);
        await Assert.That(withBody.Link.ProbeI2cSequencer()).IsTrue();

        var bare = new Dt295Fake();
        await Assert.That(new Dt295NativeLink(bare).ProbeI2cSequencer()).IsFalse();
    }

    [Test]
    public async Task TS_の要求と_I2C_の順次実行を別のスレッドから交互に出しても_応答が混ざらない()
    {
        // 機材のプログラムの要求と応答は同じ 64 バイトの場所を通る。要求と応答の読みの間に別の要求が入ると、応答が壊れる
        var (fake, link, i2c) = Rig(true);
        fake.Terrestrial.Regs[0x20] = 0x5A;
        var ring = new List<byte>();
        for (var i = 0; i < 40; i++)
        {
            var record = new byte[192];
            record[0] = 0x47;
            ring.AddRange(record);
        }
        fake.PutRing(0, ring.ToArray());
        fake.WpOnStart = (uint)ring.Count;
        fake.Put(0x190202C, 4, 0);

        var failures = new List<string>();
        var stop = false;
        var pump = Task.Run(() =>
        {
            try
            {
                while (!Volatile.Read(ref stop))
                {
                    var reply = link.Pump(2, 50, 1000);
                    if (reply.Sent > 2) lock (failures) failures.Add($"送ったパケット {reply.Sent}");
                }
            }
            catch (Exception error)
            {
                lock (failures) failures.Add($"要求: {error.Message}");
            }
        });
        for (var i = 0; i < 100; i++)
        {
            var batch = new Dt295I2cBatch();
            batch.Write(0x10, 0x20);
            batch.Read(0x10, 1);
            try
            {
                var read = i2c.Run(batch);
                if (read.Length != 1 || read[0] != 0x5A) lock (failures) failures.Add($"読み {Convert.ToHexString(read)}");
            }
            catch (Exception error)
            {
                lock (failures) failures.Add($"I2C: {error.Message}");
            }
        }
        Volatile.Write(ref stop, true);
        await pump;

        await Assert.That(failures).IsEmpty();
    }

    [Test]
    public async Task 受信中に_C_N_の読みを繰り返しても_TS_は止まらず_読みも壊れない()
    {
        var fake = new Dt295Fake();
        var ring = new List<byte>();
        for (var i = 0; i < 400; i++)
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

        for (var i = 0; i < 30; i++)
        {
            var signal = tuner.Signal();
            await Assert.That(signal).IsNotNull();
            await Assert.That(signal!.Locked).IsTrue();
        }

        tuner.Dispose();
    }

    [Test]
    public async Task 要求と応答の読みの間に別のスレッドの要求が入ろうとしても_応答は壊れない()
    {
        var (fake, link, i2c) = Rig(true);
        fake.Terrestrial.Regs[0x20] = 0x5A;
        var ring = new List<byte>();
        for (var i = 0; i < 40; i++)
        {
            var record = new byte[192];
            record[0] = 0x47;
            ring.AddRange(record);
        }
        fake.PutRing(0, ring.ToArray());
        fake.WpOnStart = (uint)ring.Count;
        fake.Put(0x190202C, 4, 0);
        // TS の要求を処理した直後 (応答を読む前) に、別のスレッドが 3 転送の I2C の順次実行を出そうとする。
        // 要求と応答の組を 1 つずつ通していれば、そのスレッドは組が終わるまで待たされる (待つのは 300 ms まで)
        Task<byte[]>? other = null;
        fake.AfterRequest = () =>
        {
            var batch = new Dt295I2cBatch();
            batch.Write(0x10, 0x20);
            batch.Read(0x10, 1);
            batch.Write(0x10, 0x20);
            other = Task.Run(() => i2c.Run(batch));
            other.Wait(TimeSpan.FromMilliseconds(300));
        };

        var reply = link.Pump(2, 50, 1000);

        // 送ったパケット数は要求の 2 個以下 (I2C の応答の「止まった番号」3 が混ざっていない)
        await Assert.That(reply.Sent).IsLessThanOrEqualTo(2u);
        var done = other ?? throw new InvalidOperationException("別のスレッドの要求が出ていません");
        await Assert.That((await done).Single()).IsEqualTo((byte)0x5A);
    }

    [Test]
    public async Task 要求を続けて出すスレッドがいても_ほかの読み書きは待たされ続けない()
    {
        // TS の要求を休みなく出す側が、放してすぐ取り直してほかの呼び出しを待たせ続けない (カードの準備が TS の送り出しに押される問題)
        var (fake, link, _) = Rig(true);
        var ring = new List<byte>();
        for (var i = 0; i < 40; i++)
        {
            var record = new byte[192];
            record[0] = 0x47;
            ring.AddRange(record);
        }
        fake.PutRing(0, ring.ToArray());
        fake.WpOnStart = (uint)ring.Count;
        fake.Put(0x190202C, 4, 0);
        var stop = false;
        var pump = Task.Run(() =>
        {
            while (!Volatile.Read(ref stop)) link.Pump(1, 20, 1000);
        });

        var clock = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 200; i++) link.Read32(0xFD8010);
        var elapsed = clock.Elapsed;
        Volatile.Write(ref stop, true);
        await pump;

        await Assert.That(elapsed).IsLessThan(TimeSpan.FromSeconds(5));
    }
}