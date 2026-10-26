using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * DiB8096 の仕様書の外の、選局を縮める工夫 (キャパシタの較正の使い回し・温度の較正を飛ばす・探索の一部の段を詰める)。
 */
public class Dib8096FastTests
{
    private const uint Uhf27 = 557_142_857;
    private const uint Uhf13 = 473_142_857;

    private static (Dib8096 Dib, FakeI2c I2c, DibModel Model, FakeTime Time) Make()
    {
        var model = new DibModel();
        var i2c = new FakeI2c(model);
        var time = new FakeTime();
        var dib = new Dib8096(i2c, time);
        dib.Initialize();
        return (dib, i2c, model, time);
    }

    /// <summary>キャパシタを置いた回数 (T[0x18] ← 0xE9xx)</summary>
    private static int Capacitor(FakeI2c i2c) => i2c.Log.Count(line => line.StartsWith("T18=E9", StringComparison.Ordinal));

    [Test]
    public async Task キャパシタの較正は周波数ごとに覚えて使い回す()
    {
        var (dib, i2c, _, _) = Make();
        dib.Tune(Uhf27);
        dib.Tune(Uhf13);
        i2c.Log.Clear();
        await Assert.That(dib.Tune(Uhf27)).IsEqualTo(DibLock.DataLocked);
        // 二分探索 (7 回置いて最後にもう1回) ではなく、覚えた値を1回置いて ADC を1回見るだけ
        await Assert.That(Capacitor(i2c)).IsEqualTo(1);

        // 初めての周波数は二分探索 (7 回置いて最後にもう1回)
        i2c.Log.Clear();
        dib.Tune(ChannelTable.Parse("T40")!.Frequency);
        await Assert.That(Capacitor(i2c)).IsEqualTo(8);
    }

    [Test]
    public async Task 覚えたキャパシタで合わなければ較正し直す()
    {
        var (dib, i2c, model, _) = Make();
        dib.Tune(Uhf27);
        dib.Tune(Uhf13);
        // ADC がずれた (温度が変わったなど)
        model.Tuner[0x1D] = 2000;
        i2c.Log.Clear();
        dib.Tune(Uhf27);
        await Assert.That(Capacitor(i2c)).IsEqualTo(1 + 8);
    }

    [Test]
    public async Task ロックしなければ覚えたキャパシタを捨てる()
    {
        var (dib, i2c, model, _) = Make();
        dib.Tune(Uhf27);
        model.Signal = false;
        await Assert.That(dib.Tune(Uhf27)).IsEqualTo(DibLock.Failed);
        model.Signal = true;
        dib.Tune(Uhf13);
        i2c.Log.Clear();
        dib.Tune(Uhf27);
        await Assert.That(Capacitor(i2c)).IsEqualTo(8);
    }

    [Test]
    public async Task 温度の較正は_60_秒以内なら飛ばす()
    {
        var (dib, i2c, _, time) = Make();
        dib.Tune(Uhf27);
        i2c.Log.Clear();
        dib.Tune(Uhf13);
        // 温度の較正は T[0x13] を書き換える (7.3.3)
        await Assert.That(i2c.Log.Any(line => line.StartsWith("T13=", StringComparison.Ordinal))).IsFalse();
        time.Sleep(61_000);
        i2c.Log.Clear();
        dib.Tune(Uhf27);
        await Assert.That(i2c.Log.Any(line => line.StartsWith("T13=", StringComparison.Ordinal))).IsTrue();
    }

    [Test]
    public async Task 探索はシンボルの時間切れに関わらない段だけ詰める()
    {
        var (dib, _, _, time) = Make();
        dib.Tune(Uhf27);
        time.Sleeps.Clear();
        dib.Tune(Uhf27);
        await Assert.That(time.Sleeps).Contains(Dib8096.FastPollMs);
        // 段 5・7 の時間切れに関わる間は 10ms のまま (偽物ではロックがすぐ立つので、段 4 の前の 10ms が残る)
        await Assert.That(time.Sleeps).Contains(10);
    }
}
