using System.Buffers.Binary;

namespace Denpa.Agent.Tests;

/*
 * 受信の状態と C/N と強度 (GET /denpa/tuners の signal。TunerSignal.cs)。
 * dB に直せるもの (DVB の DTV_STAT_CNR・DiB8000 の式) だけ dB にし、PIX-DT295 はレジスタの値のまま出す。
 * 強度は dBm で返すもの (DVB の FE_SCALE_DECIBEL・DiB8000 の表) だけ出す
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

    /// <summary>DTV_STAT_CNR と DTV_STAT_SIGNAL_STRENGTH の答えを、この順に並べる (DvbTuner.Stats が読む形)</summary>
    private static byte[] Stats(byte[] cnr, byte[] strength) => [.. cnr, .. strength];

    [Test]
    public async Task DVBの強度は_dBmで返すものだけ_0_001dBm刻みを直す()
    {
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 1, 25_300), Cnr(1, 1, -35_250))))
            .IsEqualTo(new TunerSignal(true, 25.3, TunerSignal.Db, StrengthDbm: -35.25));
        // C/N が相対値でも、強度が dBm なら出す
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 2, 40_000), Cnr(1, 1, -35_250))))
            .IsEqualTo(new TunerSignal(true, 40_000, TunerSignal.Raw, StrengthDbm: -35.25));
    }

    [Test]
    public async Task DVBの強度が相対値か測れなければ_強度を出さない()
    {
        // 相対値 (FE_SCALE_RELATIVE) は dBm に直せない。len 0 と FE_SCALE_NOT_AVAILABLE は測れない
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 1, 25_300), Cnr(1, 2, 40_000))))
            .IsEqualTo(new TunerSignal(true, 25.3, TunerSignal.Db));
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 2, 40_000), Cnr(0, 1, -35_000))))
            .IsEqualTo(new TunerSignal(true, 40_000, TunerSignal.Raw));
        await Assert.That(DvbTuner.Stats(false, Stats(Cnr(0, 0, 0), Cnr(1, 0, 0))))
            .IsEqualTo(new TunerSignal(false, null, TunerSignal.Db));
    }

    [Test]
    public async Task DVBのCNが測れなくても_dBmの強度は出す()
    {
        await Assert.That(DvbTuner.Stats(false, Stats(Cnr(0, 0, 0), Cnr(1, 1, -80_000))))
            .IsEqualTo(new TunerSignal(false, null, TunerSignal.Db, StrengthDbm: -80));
    }

    [Test]
    public async Task DT295はレジスタの値のまま()
    {
        await Assert.That(TunerSignal.From(new Dt295Signal(false, true, 2748, 3))).IsEqualTo(new TunerSignal(true, 2748, TunerSignal.Raw));
    }

    [Test]
    public async Task CECH_ZD1_JはdBのCNとdBmの強度を出す()
    {
        await Assert.That(TunerSignal.From(new DibSignal(true, -60, 22.5, 0x1080))).IsEqualTo(new TunerSignal(true, 22.5, TunerSignal.Db, StrengthDbm: -60));
        await Assert.That(TunerSignal.From(new DibSignal(false, -90, null, 0))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db, StrengthDbm: -90));
    }

    [Test]
    public async Task JSONはdBを小数1桁_生の値を整数にする()
    {
        var db = new TunerSignal(true, 25.345, TunerSignal.Db, AtTune: true).ToJson();
        await Assert.That(db.ToJsonString()).IsEqualTo("""{"locked":true,"cn":25.3,"unit":"dB","atTune":true,"strengthDbm":null}""");
        var raw = new TunerSignal(false, null, TunerSignal.Raw).ToJson();
        await Assert.That(raw.ToJsonString()).IsEqualTo("""{"locked":false,"cn":null,"unit":"raw","atTune":false,"strengthDbm":null}""");
    }

    [Test]
    public async Task JSONは強度を小数1桁のdBmにする()
    {
        var signal = new TunerSignal(true, 25.3, TunerSignal.Db, StrengthDbm: -35.27).ToJson();
        await Assert.That(signal.ToJsonString()).IsEqualTo("""{"locked":true,"cn":25.3,"unit":"dB","atTune":false,"strengthDbm":-35.3}""");
    }
}
