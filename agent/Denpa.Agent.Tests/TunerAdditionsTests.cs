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
}
