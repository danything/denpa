using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * **読み出しが追いつかずに切った利用者も、読む側が去れば選局から抜ける。**
 *
 * 切ったあと (`Sink.Push` の `MaxLag`) に抜ける知らせが届かず、選局の利用者に残っていた。
 * そのチューナーは誰も読んでいないのに同じ優先度で塞がり続け、実機では番組表集めが
 * 「BS のチューナーに空きがありません」と断られ続け、衛星の局ロゴは残りの1台を
 * 30分ごとに番組表集めに取り上げられて読み切れなかった。
 */
public class SinkTests
{
    [Test]
    public async Task 追いつかずに切ったあとでも_去れば抜ける()
    {
        var left = 0;
        var sink = new Sink("logo BS/BS15_0", 1, _ => left++);
        // 読まないまま溜める。上限を超えたところで切られる
        var chunk = new byte[1024 * 1024];
        for (var i = 0; i * chunk.Length <= TunerPool.MaxLag; i++) sink.Push(chunk);
        await Assert.That(sink.FailedWith).IsEqualTo("読み出しが追いつかないため切断しました");

        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
        // 2回去っても1回だけ
        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
    }

    [Test]
    public async Task ふつうに去っても1回だけ抜ける()
    {
        var left = 0;
        var sink = new Sink("epg BS15_0", 3, _ => left++);
        sink.Leave();
        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
    }
}
