using System.Buffers.Binary;

namespace Denpa.Agent.Tests;

/*
 * 受信の状態と C/N と強度 (GET /denpa/tuners の signal。TunerSignal.cs)。
 * dB に直せるもの (DVB の DTV_STAT_CNR・DiB8000 の式・PIX-DT295 の TC90522 系の式) を dB にする。
 * 強度は dBm で返すもの (DVB の FE_SCALE_DECIBEL・DiB8000 の表) だけ出す
 */
public class TunerSignalTests
{
    /// <summary>DTV_STAT_CNR の結果 (struct dtv_property。76 バイト) を、先頭の 1 つだけ入れて組む</summary>
    private static byte[] Cnr(byte length, byte scale, long value)
    {
        var property = new byte[DvbTuner.PropertySize];
        property[DvbTuner.PropertyDataAt] = length;
        property[DvbTuner.PropertyDataAt + 1] = scale;
        BinaryPrimitives.WriteInt64LittleEndian(property.AsSpan(DvbTuner.PropertyDataAt + 2), value);
        return property;
    }

    [Test]
    public async Task DVB_の_dB_は_0_001dB_刻みを直す()
    {
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 1, 31_250))).IsEqualTo(new TunerSignal(true, 31.25, TunerSignal.Db));
    }

    [Test]
    public async Task DVB_の相対値は_ドライバの値のまま_raw()
    {
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 2, 40_000))).IsEqualTo(new TunerSignal(true, 40_000, TunerSignal.Raw));
    }

    [Test]
    public async Task DVB_で測れなければ_CN_は_null()
    {
        // ドライバが値を入れない (len 0) と、FE_SCALE_NOT_AVAILABLE
        await Assert.That(DvbTuner.Cnr(false, Cnr(0, 1, 31_250))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db));
        await Assert.That(DvbTuner.Cnr(true, Cnr(1, 0, 0))).IsEqualTo(new TunerSignal(true, null, TunerSignal.Db));
    }

    /// <summary>DTV_STAT_CNR と DTV_STAT_SIGNAL_STRENGTH の結果を、この順に並べる (DvbTuner.Stats が読む形)</summary>
    private static byte[] Stats(byte[] cnr, byte[] strength) => [.. cnr, .. strength];

    [Test]
    public async Task DVB_の強度は_dBm_で返すものだけ_0_001dBm_刻みを直す()
    {
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 1, 25_300), Cnr(1, 1, -35_250))))
            .IsEqualTo(new TunerSignal(true, 25.3, TunerSignal.Db, StrengthDbm: -35.25));
        // C/N が相対値でも、強度が dBm なら出す
        await Assert.That(DvbTuner.Stats(true, Stats(Cnr(1, 2, 40_000), Cnr(1, 1, -35_250))))
            .IsEqualTo(new TunerSignal(true, 40_000, TunerSignal.Raw, StrengthDbm: -35.25));
    }

    [Test]
    public async Task DVB_の強度が相対値か測れなければ_強度を出さない()
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
    public async Task DVB_の_CN_が測れなくても_dBm_の強度は出す()
    {
        await Assert.That(DvbTuner.Stats(false, Stats(Cnr(0, 0, 0), Cnr(1, 1, -80_000))))
            .IsEqualTo(new TunerSignal(false, null, TunerSignal.Db, StrengthDbm: -80));
    }

    [Test]
    public async Task DT295_は_TC90522_系の式で_dB_にする()
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
    public async Task DT295_の値は大きいほど低い_dB_になり_式の外とロックしていないときは_null()
    {
        await Assert.That(TunerSignal.Tc90522Db(false, 4000)!.Value).IsLessThan(TunerSignal.Tc90522Db(false, 2000)!.Value);
        await Assert.That(TunerSignal.Tc90522Db(true, 15000)!.Value).IsLessThan(TunerSignal.Tc90522Db(true, 10000)!.Value);
        // 衛星の 3000 未満は式の外 (ロックしていないと 0 が読める)。良い値に見せない
        await Assert.That(TunerSignal.Tc90522Db(true, 2500)).IsNull();
        await Assert.That(TunerSignal.Tc90522Db(true, 0)).IsNull();
        // 地上波の 0 は割れない
        await Assert.That(TunerSignal.Tc90522Db(false, 0)).IsNull();
        // ロックしていなければ、値があっても出さない
        await Assert.That(TunerSignal.From(new Dt295Signal(true, false, 9930, 2))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db));
    }

    [Test]
    public async Task CECH_ZD1_J_は_dB_の_CN_と_dBm_の強度を出す()
    {
        await Assert.That(TunerSignal.From(new DibSignal(true, -60, 22.5, 0x1080))).IsEqualTo(new TunerSignal(true, 22.5, TunerSignal.Db, StrengthDbm: -60));
        await Assert.That(TunerSignal.From(new DibSignal(false, -90, null, 0))).IsEqualTo(new TunerSignal(false, null, TunerSignal.Db, StrengthDbm: -90));
    }

    [Test]
    public async Task JSON_は_dB_を小数_1_桁_raw_を整数にする()
    {
        var db = new TunerSignal(true, 25.345, TunerSignal.Db, AtTune: true).ToJson();
        await Assert.That(db.ToJsonString()).IsEqualTo("""{"locked":true,"cn":25.3,"unit":"dB","atTune":true,"strengthDbm":null}""");
        var raw = new TunerSignal(false, null, TunerSignal.Raw).ToJson();
        await Assert.That(raw.ToJsonString()).IsEqualTo("""{"locked":false,"cn":null,"unit":"raw","atTune":false,"strengthDbm":null}""");
    }

    [Test]
    public async Task JSON_は強度を小数_1_桁の_dBm_にする()
    {
        var signal = new TunerSignal(true, 25.3, TunerSignal.Db, StrengthDbm: -35.27).ToJson();
        await Assert.That(signal.ToJsonString()).IsEqualTo("""{"locked":true,"cn":25.3,"unit":"dB","atTune":false,"strengthDbm":-35.3}""");
    }
}
