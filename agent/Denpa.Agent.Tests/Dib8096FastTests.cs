using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * DiB8096 の仕様書の外の速くする工夫 (Dib8096.Fast。DENPA_ZD1J_FAST)。切ったときは仕様書どおり (Dib8096Tests.cs) のまま。
 */
public class Dib8096FastTests
{
    private const uint Uhf27 = 557_142_857;
    private const uint Uhf13 = 473_142_857;

    private static (Dib8096 Dib, FakeI2c I2c, DibModel Model, FakeTime Time) Make(bool fast)
    {
        var model = new DibModel();
        var i2c = new FakeI2c(model);
        var time = new FakeTime();
        var dib = new Dib8096(i2c, time) { Fast = fast };
        dib.Initialize();
        return (dib, i2c, model, time);
    }

    /// <summary>キャパシタを置いた回数 (T[0x18] ← 0xE9xx)</summary>
    private static int Capacitor(FakeI2c i2c) => i2c.Log.Count(line => line.StartsWith("T18=E9", StringComparison.Ordinal));

    [Test]
    public async Task キャパシタの較正は周波数ごとに覚えて使い回す()
    {
        var (dib, i2c, _, _) = Make(fast: true);
        dib.Tune(Uhf27);
        dib.Tune(Uhf13);
        i2c.Log.Clear();
        await Assert.That(dib.Tune(Uhf27)).IsEqualTo(DibLock.DataLocked);
        // 二分探索 (7 回置いて最後にもう1回) ではなく、覚えた値を1回置いて ADC を1回見るだけ
        await Assert.That(Capacitor(i2c)).IsEqualTo(1);

        // 切っていれば毎回二分探索
        var (slow, slowI2c, _, _) = Make(fast: false);
        slow.Tune(Uhf27);
        slow.Tune(Uhf13);
        slowI2c.Log.Clear();
        slow.Tune(Uhf27);
        await Assert.That(Capacitor(slowI2c)).IsEqualTo(8);
    }

    [Test]
    public async Task 覚えたキャパシタで合わなければ較正し直す()
    {
        var (dib, i2c, model, _) = Make(fast: true);
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
        var (dib, i2c, model, _) = Make(fast: true);
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
        var (dib, i2c, _, time) = Make(fast: true);
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
        var (dib, _, _, time) = Make(fast: true);
        dib.Tune(Uhf27);
        time.Sleeps.Clear();
        dib.Tune(Uhf27);
        await Assert.That(time.Sleeps).Contains(Dib8096.FastPollMs);
        var fast = time.Sleeps.Sum();

        var (slow, _, _, slowTime) = Make(fast: false);
        slow.Tune(Uhf27);
        slowTime.Sleeps.Clear();
        slow.Tune(Uhf27);
        await Assert.That(slowTime.Sleeps).DoesNotContain(Dib8096.FastPollMs);
        await Assert.That(fast).IsLessThan(slowTime.Sleeps.Sum());
    }
}
