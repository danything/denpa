namespace Denpa.Agent.Tests;

public sealed class TunerAdditionsTests
{
    private static TunerSpec Spec(string name, string device) => new(name, ["GR"], false, device);

    [Test]
    public async Task 挿された機材だけを足し_定義にあるものと前から挿さっていたものは足さない()
    {
        var written = new[] { Spec("gr0", "dt295:1-1") };
        var found = new[] { Spec("PIXELA PIX-DT295 1-1", "dt295:1-1"), Spec("old", "zd1j:2-1"), Spec("new", "zd1j:2-2") };
        var added = Config.Additions(written, found, new HashSet<string?> { "dt295:1-1", "zd1j:2-1" });
        await Assert.That(added.Select(tuner => tuner.Device)).IsEquivalentTo(new[] { "zd1j:2-2" });
    }

    [Test]
    public async Task 定義から消して挿したままの機材は_挿し直すまで戻さない()
    {
        var found = new[] { Spec("PIXELA PIX-DT295 1-1", "dt295:1-1") };
        // 消したあとの探し直し: 前から挿さっているので足さない
        await Assert.That(Config.Additions([], found, new HashSet<string?> { "dt295:1-1" })).IsEmpty();
        // 抜いて挿し直した: 抜いた時点の探し直しで控えから消えているので足す
        await Assert.That(Config.Additions([], found, new HashSet<string?>()).Count).IsEqualTo(1);
    }

    [Test]
    public async Task 名前が重なれば番号を付ける()
    {
        var written = new[] { Spec("PIXELA PIX-DT295 1-1", "dt295:9-9") };
        var found = new[] { Spec("PIXELA PIX-DT295 1-1", "dt295:1-1") };
        var added = Config.Additions(written, found, new HashSet<string?>());
        await Assert.That(added[0].Name).IsEqualTo("PIXELA PIX-DT295 1-1 (2)");
    }

    /*
     * **受けられる種別は、見つけた機材の種別。** 定義の種別を書き換えても変わらない。
     * 見つけていない機材 (抜いた・手で書いたデバイス) は分からないので null (#2386)
     */
    [Test]
    [NotInParallel(nameof(DeviceProbe))]
    public async Task 受けられる種別は見つけた機材のもので_見つけていない機材は_null()
    {
        DeviceProbe.Remember([
            new TunerSpec("PX-W3U3 2-3 #0", ["BS", "CS"], false, "asicen:2-3:0"),
            new TunerSpec("PX-W3U3 2-3 #2", ["GR"], false, "asicen:2-3:2"),
        ]);
        await Assert.That(DeviceProbe.Receivable("asicen:2-3:0")).IsEquivalentTo(new[] { "BS", "CS" });
        await Assert.That(DeviceProbe.Receivable("asicen:2-3:2")).IsEquivalentTo(new[] { "GR" });
        await Assert.That(DeviceProbe.Receivable("asicen:2-3:9")).IsNull();
        await Assert.That(DeviceProbe.Receivable(null)).IsNull();
    }
}
