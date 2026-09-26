using System.Diagnostics;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * 画面の「カードリーダー」の表 (Card.cs の Local / Remote / Report)。
 *
 * 本物のリーダーは無い。INT と IDI に答える線を置き、**使っているリーダーを
 * 開き直さない**ことと、予備・カードなし・壊れたリーダーがそれぞれの行になることを確かめる。
 */
public class CardStatusTests
{
    private static readonly CardInit Using = new(new byte[32], new byte[8], 5, [32231622637]);

    /// <summary>INT (返り値 0x2100) と IDI (番号 <paramref name="id"/>) に答える線</summary>
    private sealed class FakeLink(string name, long id) : ICardLink
    {
        public string Name { get; } = name;

        public byte[] Reset() => [0x3b];

        public byte[] Transmit(ReadOnlySpan<byte> apdu)
        {
            if (apdu[1] == 0x30)
            {
                var init = new byte[59];
                init[4] = 0x21;
                init[57] = 0x90;
                return init;
            }
            var idi = new byte[19];
            idi[6] = 1;
            for (var at = 0; at < 6; at++) idi[9 + at] = (byte)(id >> (8 * (5 - at)));
            idi[17] = 0x90;
            return idi;
        }

        public void Dispose() { }
    }

    private static CardLinkCandidate Present(string name, long id) => new(name, () => new FakeLink(name, id));

    private static CardLinkCandidate Failing(string name, Exception error) => new(name, () => throw error);

    [Test]
    public async Task 使っているリーダーは開かず予備だけ覗く()
    {
        CardLinkCandidate[] found =
        [
            Present("PX4 内蔵リーダー", 1),
            new("Gemplus (usb 4-11)", () => throw new InvalidOperationException("使っているリーダーを開き直しました")),
            Failing("空のリーダー (usb 1-2)", new CardAbsentException("空のリーダー にカードが挿さっていません")),
            Failing("壊れたリーダー (usb 1-3)", new IOException("別のプロセスがリーダーを掴んでいます")),
        ];

        var survey = Card.Local(() => Using, () => "Gemplus (usb 4-11)", () => found, TimeSpan.FromSeconds(5));
        var report = Card.Report(survey, ["PT3-T1", "PT3-S1"]);

        await Assert.That(report["ok"]!.GetValue<bool>()).IsTrue();
        await Assert.That(report["message"]!.GetValue<string>()).IsEqualTo("");
        await Assert.That(report["source"]!.GetValue<string>()).IsEqualTo("local");

        var rows = report["readers"]!.AsArray();
        // 並びは見つけた順のまま
        await Assert.That(rows.Select(row => row!["name"]!.GetValue<string>()).ToArray())
            .IsEquivalentTo(found.Select(candidate => candidate.Name).ToArray());

        var standby = rows[0]!;
        await Assert.That(standby["card"]!.GetValue<bool>()).IsTrue();
        await Assert.That(standby["active"]!.GetValue<bool>()).IsFalse();
        await Assert.That(standby["ids"]![0]!.GetValue<string>()).IsEqualTo("0000000000000001");
        await Assert.That(standby["tuners"]!.AsArray().Count).IsEqualTo(0);

        var active = rows[1]!;
        await Assert.That(active["active"]!.GetValue<bool>()).IsTrue();
        await Assert.That(active["ids"]![0]!.GetValue<string>()).IsEqualTo("0000032231622637");
        await Assert.That(active["tuners"]!.AsArray().Select(name => name!.GetValue<string>()).ToArray())
            .IsEquivalentTo(new[] { "PT3-T1", "PT3-S1" });
        await Assert.That(active.AsObject().ContainsKey("error")).IsFalse();

        // 挿さっていないだけなら「エラー」にしない
        var empty = rows[2]!;
        await Assert.That(empty["card"]!.GetValue<bool>()).IsFalse();
        await Assert.That(empty.AsObject().ContainsKey("error")).IsFalse();

        var broken = rows[3]!;
        await Assert.That(broken["card"]!.GetValue<bool>()).IsFalse();
        await Assert.That(broken["error"]!.GetValue<string>()).IsEqualTo("別のプロセスがリーダーを掴んでいます");
    }

    [Test]
    public async Task リーダーが無ければそう言う()
    {
        var survey = Card.Local(
            () => throw new IOException("カードリーダーが見つかりません"), () => "", () => [], TimeSpan.FromSeconds(5));
        var report = Card.Report(survey, []);
        await Assert.That(report["ok"]!.GetValue<bool>()).IsFalse();
        await Assert.That(report["message"]!.GetValue<string>()).IsEqualTo("カードリーダーが見つかりません");
        await Assert.That(report["readers"]!.AsArray().Count).IsEqualTo(0);
    }

    [Test]
    public async Task どこにも挿さっていなければそう言う()
    {
        CardLinkCandidate[] found = [Failing("空 (usb 1-2)", new CardAbsentException("挿さっていません"))];
        var survey = Card.Local(
            () => throw new CardsUnreadableException([new("空 (usb 1-2)", "空 (usb 1-2) にカードが挿さっていません", true)]),
            () => "", () => found, TimeSpan.FromSeconds(5));
        await Assert.That(survey.Ok).IsFalse();
        await Assert.That(survey.Message).IsEqualTo("どのカードリーダーにもカードが挿さっていません");
    }

    [Test]
    public async Task 読めないカードしか無ければ理由は表に出す()
    {
        CardLinkCandidate[] found = [Failing("壊れた (usb 1-3)", new IOException("INT を断られました"))];
        var survey = Card.Local(
            () => throw new CardsUnreadableException([new("壊れた (usb 1-3)", "INT を断られました", false)]),
            () => "", () => found, TimeSpan.FromSeconds(5));
        await Assert.That(survey.Message).IsEqualTo("どのカードリーダーでもカードを読めません");
        await Assert.That(survey.Readers[0].Error).IsEqualTo("INT を断られました");
    }

    /// <summary>
    /// **INT が通らないときはリーダーを開かない。** 覗きが掴んでいる間は繋ぎ直しが掴めず、
    /// 画面を開くたびに締め出してカードが二度と読めなくなった (実機)
    /// </summary>
    [Test]
    public async Task INTが通らないときはリーダーを開かない()
    {
        var opened = 0;
        CardLinkCandidate[] found = [new("Gemplus (usb 4-11)", () =>
        {
            Interlocked.Increment(ref opened);
            throw new IOException("開いてはいけない");
        })];
        var survey = Card.Local(
            () => throw new CardsUnreadableException([new("Gemplus (usb 4-11)", "リーダーが応答しません", false)]),
            () => "", () => found, TimeSpan.FromSeconds(5));
        await Assert.That(opened).IsEqualTo(0);
        await Assert.That(survey.Readers[0].Error).IsEqualTo("リーダーが応答しません");
    }

    [Test]
    public async Task 固まったリーダーは待たずにその行だけ理由を出す()
    {
        using var release = new ManualResetEventSlim();
        CardLinkCandidate[] found =
        [
            new("固まった (usb 2-1)", () =>
            {
                release.Wait();
                throw new IOException("遅れて断りました");
            }),
            Present("予備 (usb 2-2)", 7),
        ];

        var clock = Stopwatch.StartNew();
        var survey = Card.Local(() => Using, () => "使っている", () => found, TimeSpan.FromMilliseconds(300));
        release.Set();

        await Assert.That(clock.Elapsed).IsLessThan(TimeSpan.FromSeconds(2));
        // 使っているものは探し直しに出なくても出す
        await Assert.That(survey.Readers.Select(reader => reader.Name).ToArray())
            .IsEquivalentTo(new[] { "使っている", "固まった (usb 2-1)", "予備 (usb 2-2)" });
        await Assert.That(survey.Readers[1].Error).Contains("応答しません");
        await Assert.That(survey.Readers[2].Card).IsTrue();
    }

    [Test]
    public async Task 配り役から貰っているときはその相手と番号を返す()
    {
        var report = Card.Report(Card.Remote("http://card:25252", () => Using), ["PT3-T1"]);
        await Assert.That(report["source"]!.GetValue<string>()).IsEqualTo("remote");
        await Assert.That(report["remote"]!.GetValue<string>()).IsEqualTo("http://card:25252");
        await Assert.That(report["ok"]!.GetValue<bool>()).IsTrue();
        await Assert.That(report["ids"]![0]!.GetValue<string>()).IsEqualTo("0000032231622637");
        await Assert.That(report["tuners"]![0]!.GetValue<string>()).IsEqualTo("PT3-T1");
        await Assert.That(report["readers"]!.AsArray().Count).IsEqualTo(0);

        var down = Card.Remote("http://card:25252", () => throw new IOException("鍵を配る拠点からカードの情報を受け取れません (503)"));
        await Assert.That(down.Ok).IsFalse();
        await Assert.That(down.Message).Contains("503");
    }
}
