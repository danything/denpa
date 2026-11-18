using System.Text.Json.Nodes;

namespace Denpa.Agent.Tests;

/// <summary>通知 (<c>/denpa/events</c>) の中身と、取っておいた通知を新しい購読者に送り直すこと (Events.cs)</summary>
public class EventsTests
{
    private static List<string> Drain(System.Threading.Channels.Channel<string> queue)
    {
        var blocks = new List<string>();
        while (queue.Reader.TryRead(out var block)) blocks.Add(block);
        return blocks;
    }

    [Test]
    public async Task 名前だけの通知は_data_が空のオブジェクト()
    {
        var events = new Events();
        var queue = events.Subscribe();
        events.Emit("tuners");
        await Assert.That(Drain(queue)).IsEquivalentTo(new[] { "event: tuners\ndata: {}\n\n" });
    }

    [Test]
    public async Task 取っておく通知は_あとから購読した側にも送り_名前だけの通知は送らない()
    {
        var events = new Events();
        events.Emit("tuners");
        events.Emit("fault", new JsonObject { ["text"] = "1 行目\n2 行目" }, retain: true);
        var late = events.Subscribe();
        var blocks = Drain(late);
        await Assert.That(blocks.Count).IsEqualTo(1);
        // 文の中の改行はエスケープされ、data は 1 行に収まる
        await Assert.That(blocks[0]).IsEqualTo("event: fault\ndata: {\"text\":\"1 行目\\n2 行目\"}\n\n");
    }

    [Test]
    public async Task 取っておく通知は_新しいほうから決まった数だけ()
    {
        var events = new Events();
        for (var i = 0; i < Events.Retained + 5; i++) events.Emit("fault", new JsonObject { ["n"] = i }, retain: true);
        var blocks = Drain(events.Subscribe());
        await Assert.That(blocks.Count).IsEqualTo(Events.Retained);
        await Assert.That(blocks[0]).Contains($"{{\"n\":5}}");
        await Assert.That(blocks[^1]).Contains($"{{\"n\":{Events.Retained + 4}}}");
    }

    [Test]
    public async Task 異常の行には_その行の時刻と_その前の決まった時間の記録を添える()
    {
        const long At = 1_000_000_000;
        (long, string)[] recent =
        [
            (At - Events.FaultContextMs - 1, "古すぎる行"),
            (At - 1000, "選局 1"),
            (At - 10, "選局 2"),
            (At, "溢れました"),
            (At + 5, "あとの行"),
        ];
        var data = Events.FaultData("溢れました", recent, At + 100);
        await Assert.That(data["at"]!.GetValue<long>()).IsEqualTo(At);
        await Assert.That(data["text"]!.GetValue<string>()).IsEqualTo("溢れました");
        var context = data["context"]!.AsArray().Select(line => line!["text"]!.GetValue<string>()).ToArray();
        await Assert.That(context).IsEquivalentTo(new[] { "選局 1", "選局 2" });
    }

    [Test]
    public async Task 記録から押し出された異常の行は_今の時刻にして_全部を前の記録として添える()
    {
        (long, string)[] recent = [(990, "選局 1")];
        var data = Events.FaultData("溢れました", recent, 1000);
        await Assert.That(data["at"]!.GetValue<long>()).IsEqualTo(1000);
        await Assert.That(data["context"]!.AsArray().Count).IsEqualTo(1);
    }

    [Test]
    public async Task 添える記録は_新しいほうから決まった行数まで()
    {
        const long At = 1_000_000;
        var recent = Enumerable.Range(0, Events.FaultContextLines + 10).Select(i => (At - 1000 + i, $"行 {i}")).Append((At, "溢れました")).ToArray();
        var context = Events.FaultData("溢れました", recent, At)["context"]!.AsArray();
        await Assert.That(context.Count).IsEqualTo(Events.FaultContextLines);
        await Assert.That(context[0]!["text"]!.GetValue<string>()).IsEqualTo("行 10");
    }
}
