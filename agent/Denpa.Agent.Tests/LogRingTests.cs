using TUnit.Assertions.Enums;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * `GET /denpa/logs` が返す直近のログ。返し方は conformance.test.ts が見るので、
 * こちらは**数の上限と順番**と、いろいろなスレッドから同時に書かれても壊れないことを見る。
 */
public class LogRingTests
{
    [Test]
    public async Task 古い順に返す()
    {
        var ring = new LogRing(5);
        ring.Add("a");
        ring.Add("b");
        ring.Add("c");
        await Assert.That(ring.Snapshot().Select(line => line.Text)).IsEquivalentTo(["a", "b", "c"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 上限を超えると古いものから捨てる()
    {
        var ring = new LogRing(2000);
        for (var i = 0; i < 2500; i++) ring.Add($"{i}");
        var lines = ring.Snapshot();
        await Assert.That(lines.Length).IsEqualTo(2000);
        await Assert.That(lines[0].Text).IsEqualTo("500");
        await Assert.That(lines[^1].Text).IsEqualTo("2499");
    }

    [Test]
    public async Task 時刻はミリ秒で古い順に並ぶ()
    {
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var ring = new LogRing(3);
        for (var i = 0; i < 4; i++) ring.Add($"{i}");
        var at = ring.Snapshot().Select(line => line.At).ToArray();
        await Assert.That(at[0]).IsGreaterThanOrEqualTo(before);
        await Assert.That(at.Zip(at.Skip(1)).All(pair => pair.First <= pair.Second)).IsTrue();
    }

    [Test]
    public async Task 同時に書いても壊れない()
    {
        var ring = new LogRing(2000);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(worker => Task.Run(() =>
        {
            for (var i = 0; i < 1000; i++)
            {
                ring.Add($"{worker}:{i}");
                if (i % 100 == 0) _ = ring.Snapshot();
            }
        })));
        var lines = ring.Snapshot();
        await Assert.That(lines.Length).IsEqualTo(2000);
        await Assert.That(lines.All(line => line.Text is not null)).IsTrue();
    }

    [Test]
    public async Task JSONの形()
    {
        var ring = new LogRing(2);
        ring.Add("起動しました");
        var body = ring.ToJson();
        var first = body["lines"]![0]!;
        await Assert.That(first["text"]!.GetValue<string>()).IsEqualTo("起動しました");
        await Assert.That(first["at"]!.GetValue<long>()).IsGreaterThan(0);
    }
}
