using System.Buffers.Binary;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * px4d の数 (SPEC 6.4 の STATS / final counters) を読んで、増えた誤りを1行にするところ (Px4Counters。Px4Control.cs)。
 * 途切れたときに、受信機の側で落ちていたのか、届き方が揺れただけなのかを記録から見分ける (#1210)
 */
public class Px4CountersTests
{
    /// <summary>packets, bytes, sync, TEI, continuity, queue, USB, empty の順に u64 で並べる</summary>
    private static byte[] Body(params ulong[] values)
    {
        var body = new byte[Px4Counters.Size + 4];
        for (var i = 0; i < values.Length; i++) BinaryPrimitives.WriteUInt64LittleEndian(body.AsSpan(i * 8), values[i]);
        return body;
    }

    [Test]
    public async Task 並びのとおりに読む()
    {
        var counters = Px4Counters.Parse(Body(1000, 188000, 1, 2, 3, 4, 5, 99));
        await Assert.That(counters).IsEqualTo(new Px4Counters(1000, 188000, 1, 2, 3, 4, 5));
    }

    [Test]
    public async Task 短ければ読まない()
    {
        await Assert.That(Px4Counters.Parse(new byte[32])).IsNull();
    }

    [Test]
    public async Task 誤りが増えていなければ何も残さない()
    {
        var before = new Px4Counters(1000, 188000, 0, 0, 2, 0, 0);
        var now = before with { Packets = 5000, Bytes = 940000 };
        await Assert.That(Px4Counters.Describe(before, now)).IsNull();
        await Assert.That(Px4Counters.Describe(null, new Px4Counters(10, 1880, 0, 0, 0, 0, 0))).IsNull();
    }

    [Test]
    public async Task 増えた誤りだけを_増えた数と合計で残す()
    {
        var before = new Px4Counters(1000, 188000, 0, 0, 2, 0, 0);
        var now = before with { ContinuityErrors = 7, QueueDrops = 3 };
        await Assert.That(Px4Counters.Describe(before, now)).IsEqualTo("キュー溢れ +3 (計 3)、連続性エラー +5 (計 7)");
    }

    [Test]
    public async Task 前を知らなければ0から数える()
    {
        await Assert.That(Px4Counters.Describe(null, new Px4Counters(10, 1880, 0, 1, 0, 0, 0))).IsEqualTo("TEI +1 (計 1)");
    }

    [Test]
    public async Task 数え直されたら今の値を増えた分とみなす()
    {
        var before = new Px4Counters(1000, 188000, 9, 0, 0, 0, 0);
        await Assert.That(Px4Counters.Describe(before, before with { SyncErrors = 2 })).IsEqualTo("同期エラー +2 (計 2)");
    }
}
