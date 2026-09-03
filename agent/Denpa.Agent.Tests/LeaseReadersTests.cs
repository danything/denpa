using Denpa.Agent;
using System.Threading.Tasks;

namespace Denpa.Agent.Tests;

/*
 * **溢れの報告に添える名前。**
 *
 * 報告は1分に1回なので、溢れた瞬間の読み手と報告した瞬間の読み手は違う。
 * 実機の24時間で 302回のうち128回が「読み手なし」になっていて、その多くは
 * 直後の報告に同じ局・同じチューナーで `live` が付いていた。
 * 名前を添えるのは「次に見るところを決める」ためなので、当てにならない名前は
 * 無いのと同じになる。
 */
public class LeaseReadersTests
{
    private static Lease Make() => new(0, "GR", "T27");

    [Test]
    public async Task 誰も来ていなければ読み手なし()
    {
        await Assert.That(Make().Readers()).IsEqualTo("読み手なし");
    }

    [Test]
    public async Task 抜けたあとでも名乗る()
    {
        var lease = Make();
        lease.Saw("live GR/T27");
        // 読み手はもう居ない (Sinks は空のまま) が、居たことは残っている
        await Assert.That(lease.Readers()).IsEqualTo("live GR/T27");
    }

    [Test]
    public async Task 読んだら忘れる()
    {
        var lease = Make();
        lease.Saw("epg T27");
        await Assert.That(lease.Readers()).IsEqualTo("epg T27");
        // 次の報告まで誰も来なければ、そこは本当に読み手なし
        await Assert.That(lease.Readers()).IsEqualTo("読み手なし");
    }

    [Test]
    public async Task 相乗りは並べる()
    {
        var lease = Make();
        lease.Saw("logo GR/T27");
        lease.Saw("epg T27");
        // 並びは決まった順にする。回すたびに入れ替わると差分が読めない
        await Assert.That(lease.Readers()).IsEqualTo("epg T27・logo GR/T27");
    }

    [Test]
    public async Task 同じ読み手は一度だけ()
    {
        var lease = Make();
        lease.Saw("live GR/T27");
        lease.Saw("live GR/T27");
        await Assert.That(lease.Readers()).IsEqualTo("live GR/T27");
    }
}