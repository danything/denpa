using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * 機材の中の I2C の順次実行 (Dt295NativePrograms の操作 2) と、ホストが 1 つずつ行う場合 (Dt295NativeI2c.Run) が、
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
        // 止まったあとの転送は行わない
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
}
