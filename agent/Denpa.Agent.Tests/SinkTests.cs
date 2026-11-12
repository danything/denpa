namespace Denpa.Agent.Tests;

/*
 * **読み出しが追いつかずに切った利用者も、読む側が去れば選局から抜ける。**
 *
 * 切ったあと (`Sink.Push` の `MaxLag`) に抜けたことが選局に伝わらず、選局の利用者に残っていた。
 * そのチューナーは誰も読んでいないのに同じ優先度で塞がり続け、実機では番組表の取得が
 * 「BS のチューナーに空きがありません」と断られ続け、衛星の局ロゴは残りの 1 台を
 * 30 分ごとに番組表の取得に取り上げられて読み切れなかった。
 */
public class SinkTests
{
    [Test]
    public async Task 追いつかずに切ったあとでも_去れば抜ける()
    {
        var left = 0;
        var sink = new Sink("logo BS/BS15:16625", 1, _ => left++);
        // 読まないまま溜める。上限を超えたところで切られる
        var chunk = new byte[1024 * 1024];
        for (var i = 0; i * chunk.Length <= TunerPool.MaxLag; i++) sink.Push(chunk);
        await Assert.That(sink.FailedWith).IsEqualTo("読み出しが追いつかないため切断しました");

        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
        // 2 回去っても 1 回だけ
        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
    }

    /// <summary>取り上げられた利用者には、取り上げた相手の名乗りを返す。記録から相手を追えるように (#1939)</summary>
    [Test]
    public async Task 取り上げられたら相手の名乗りを理由に入れる()
    {
        var sink = new Sink("logo BS/BS15:16625", 4, _ => { });
        sink.Fail(TunerPool.PreemptedBy("epg BS03:16432"));
        await Assert.That(sink.FailedWith).IsEqualTo("優先度の高い要求 (epg BS03:16432) にチューナーを譲りました");
    }

    /// <summary>取り上げられたのか、選局できなかったのかを見分ける。送る前に取り上げられたら 409 で返す (Program.cs)</summary>
    [Test]
    public async Task 取り上げられた理由を見分ける()
    {
        await Assert.That(TunerPool.IsPreempted(TunerPool.PreemptedBy("rec 12"))).IsTrue();
        await Assert.That(TunerPool.IsPreempted("同期しません")).IsFalse();
    }

    /// <summary>
    /// **選局を共有する利用者どうしでは、先頭で待つ局をいちばん厳しい条件に合わせる** (<c>Lease.Services</c>)。
    /// 局を決めない鍵の要る利用者 (録画) がいれば全部 (null)、ライブだけなら観る局を全部。鍵の要らない利用者は数えない
    /// </summary>
    [Test]
    public async Task 共有する利用者のいちばん厳しい条件で局を待つ()
    {
        var lease = new Lease(0, "tuner0", "GR", "T27");
        lease.Sinks.Add(new Sink("live GR/T27", 5, _ => { }) { Service = 1024 });
        lease.Sinks.Add(new Sink("epg T27", 3, _ => { }));
        await Assert.That(string.Join(",", lease.Services()!.Order())).IsEqualTo("1024");

        lease.Sinks.Add(new Sink("live GR/T27", 5, _ => { }) { Service = 1025 });
        await Assert.That(string.Join(",", lease.Services()!.Order())).IsEqualTo("1024,1025");

        lease.Sinks.Add(new Sink("rec 12", 10, _ => { }));
        await Assert.That(lease.Services()).IsNull();
    }

    [Test]
    public async Task ふつうに去っても_1_回だけ抜ける()
    {
        var left = 0;
        var sink = new Sink("epg BS15:16625", 3, _ => left++);
        sink.Leave();
        sink.Leave();
        await Assert.That(left).IsEqualTo(1);
    }
}
