using System.Buffers.Binary;

namespace Denpa.Agent.Tests;

/*
 * 受信の状態と C/N (GET /denpa/tuners の signal。TunerSignal.cs)。
 * dB に直せるもの (DVB の DTV_STAT_CNR・DiB8000 の式) だけ dB にし、PIX-DT295 はレジスタの値のまま出す
 */
public class TunerSignalTests
{
    /// <summary>DTV_STAT_CNR の答え (struct dtv_property。76 バイト) を、先頭の 1 つだけ入れて組む</summary>
    private static byte[] Cnr(byte length, byte scale, long value)
    {
        var property = new byte[DvbTuner.PropertySize];
        property[DvbTuner.PropertyDataAt] = length;
        property[DvbTuner.PropertyDataAt + 1] = scale;
        BinaryPrimitives.WriteInt64LittleEndian(property.AsSpan(DvbTuner.PropertyDataAt + 2), value);
        return property;
    }

    [Test]
    public async Task DVBのdBは_0_001dB刻みを直す()
    {
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 1, 31_250))).IsEqualTo(new TunerSignal(true, 31.25, TunerSignal.Db));
    }

    [Test]
    public async Task DVBの相対値は_生の値のまま()
    {
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 2, 40_000))).IsEqualTo(new TunerSignal(true, 40_000, TunerSignal.Raw));
    }

    [Test]
    public async Task DVBで測れなければ_CNはnull()
    {
        // ドライバが値を入れない (len 0) と、FE_SCALE_NOT_AVAILABLE
        await Assert.That(DvbTuner.Cnr(false, Cnr(0, 1, 31_250))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db));
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 0, 0))).IsEqualTo(new TunerSignal(true, null, TunerSignal.Db));
    }

    [Test]
    public async Task DT295はTC90522系の式でdBにする()
    {
        // 本番の PIX-DT295 で読んだ値。地上波は約 35 dB、BS は約 17 dB、CS は約 13 dB
        var terrestrial = TunerSignal.From(new Dt295Signal(false, true, 2935, 3));
        await Assert.That(terrestrial.Unit).IsEqualTo(TunerSignal.Db);
        await Assert.That(terrestrial.Locked).IsTrue();
        await Assert.That(terrestrial.Cn!.Value).IsBetween(34.5, 35.5);
        await Assert.That(TunerSignal.From(new Dt295Signal(true, true, 9930, 2)).Cn!.Value).IsBetween(16.7, 17.7);
        await Assert.That(TunerSignal.From(new Dt295Signal(true, true, 14800, 2)).Cn!.Value).IsBetween(12.9, 13.9);
    }

    [Test]
    public async Task DT295の値は大きいほど低いdBになり_式の外は上限かnull()
    {
        await Assert.That(TunerSignal.Tc90522Db(false, 4000)!.Value).IsLessThan(TunerSignal.Tc90522Db(false, 2000)!.Value);
        await Assert.That(TunerSignal.Tc90522Db(true, 15000)!.Value).IsLessThan(TunerSignal.Tc90522Db(true, 10000)!.Value);
        // 衛星の 3000 以下は式の外。上限 (P = 0) にする
        await Assert.That(TunerSignal.Tc90522Db(true, 2500)).IsEqualTo(58.857);
        // 地上波の 0 は割れない
        await Assert.That(TunerSignal.Tc90522Db(false, 0)).IsNull();
    }

    [Test]
    public async Task CECH_ZD1_JはdBのCNを出す()
    {
        await Assert.That(TunerSignal.From(new DibSignal(true, -60, 22.5, 0x1080))).IsEqualTo(new TunerSignal(true, 22.5, TunerSignal.Db));
        await Assert.That(TunerSignal.From(new DibSignal(false, -90, null, 0))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db));
    }

    [Test]
    public async Task JSONはdBを小数1桁_生の値を整数にする()
    {
        var db = new TunerSignal(true, 25.345, TunerSignal.Db, AtTune: true).ToJson();
        await Assert.That(db.ToJsonString()).IsEqualTo("""{"locked":true,"cn":25.3,"unit":"dB","atTune":true}""");
        var raw = new TunerSignal(false, null, TunerSignal.Raw).ToJson();
        await Assert.That(raw.ToJsonString()).IsEqualTo("""{"locked":false,"cn":null,"unit":"raw","atTune":false}""");
    }
}
