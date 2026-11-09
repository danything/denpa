namespace Denpa.Agent.Tests;

/*
 * 使わないカードリーダー (CardChoice.cs・CardLinks.Without・Card.WithDisabled・BCas.Release)。
 * 本物のリーダーは無い。候補と偽の接続を並べて、外れる候補・画面に返す行・繋ぎ直しを確かめる
 */
public class CardChoiceTests
{
    /// <summary>INT (返り値 0x2100) と IDI に応答する接続。閉じたかを数える</summary>
    private sealed class FakeLink(string name) : ICardLink
    {
        public string Name { get; } = name;
        public int Closed { get; private set; }

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
            idi[17] = 0x90;
            return idi;
        }

        public void Dispose() => Closed++;
    }

    private static CardLinkCandidate Never(string name, string? device = null) =>
        new(name, () => throw new InvalidOperationException("開かない"), device);

    [Test]
    public async Task 使わないリーダーは候補に入れない()
    {
        IReadOnlyList<CardLinkCandidate> found = [Never("Gemplus (usb 3-11)"), Never("PIXELA PIX-DT295 3-5 Card Reader", "dt295:3-5")];
        await Assert.That(CardLinks.Without(found, new HashSet<string> { "PIXELA PIX-DT295 3-5 Card Reader" }).Select(c => c.Name).ToArray()).IsEquivalentTo(new[] { "Gemplus (usb 3-11)" });
        await Assert.That(CardLinks.Without(found, new HashSet<string>()).Count).IsEqualTo(2);
    }

    [Test]
    public async Task 使わないリーダーは開かずに後ろへ足す()
    {
        var survey = new CardSurvey(true, "", [new ReaderState("Gemplus (usb 3-11)", [1], true, null)], [1], null);
        var off = new HashSet<string> { "PIXELA PIX-DT295 3-5 Card Reader", "抜いたリーダー" };
        var shown = Card.WithDisabled(survey, off, () => [Never("Gemplus (usb 3-11)"), Never("PIXELA PIX-DT295 3-5 Card Reader", "dt295:3-5")]);

        // 挿さっていないもの (抜いたリーダー) は足さない
        await Assert.That(shown.Readers.Select(r => r.Name).ToArray()).IsEquivalentTo(new[] { "Gemplus (usb 3-11)", "PIXELA PIX-DT295 3-5 Card Reader" });
        await Assert.That(shown.Readers[0].Name).IsEqualTo("Gemplus (usb 3-11)");
        await Assert.That(shown.Readers[1].Disabled).IsTrue();
        await Assert.That(shown.Readers[1].Card).IsFalse();
        await Assert.That(shown.Message).IsEqualTo("");
    }

    [Test]
    public async Task 全部オフなら見つからないと返さない()
    {
        var survey = new CardSurvey(false, "カードリーダーが見つかりません", [], [], null);
        var shown = Card.WithDisabled(survey, new HashSet<string> { "Gemplus (usb 3-11)" }, () => [Never("Gemplus (usb 3-11)")]);
        await Assert.That(shown.Message).IsEqualTo("使うカードリーダーがありません。カードリーダーをオンにしてください");
        await Assert.That(shown.Readers.Count).IsEqualTo(1);
    }

    [Test]
    public async Task 挿さっていないリーダーの使わない設定は保存し直しても残す()
    {
        var dir = Directory.CreateTempSubdirectory("denpa-cards-");
        var file = Path.Combine(dir.FullName, "cards.json");
        try
        {
            CardChoice.Load(file);
            CardChoice.Save(["抜いたリーダー"], new HashSet<string>());
            // 画面は挿さっているリーダー (A・B) だけを送る。A を外す
            CardChoice.Save(["A"], new HashSet<string> { "A", "B" });
            await Assert.That(CardChoice.Disabled.Order().ToArray()).IsEquivalentTo(new[] { "A", "抜いたリーダー" });

            // 読み直しても同じ
            CardChoice.Load(file);
            await Assert.That(CardChoice.Disabled.Count).IsEqualTo(2);

            // 挿さっているリーダーは、送られてこなければ使う
            CardChoice.Save([], new HashSet<string> { "A", "B", "抜いたリーダー" });
            await Assert.That(CardChoice.Disabled.Count).IsEqualTo(0);
            await Assert.That(File.Exists(file)).IsFalse();
        }
        finally
        {
            CardChoice.Set([]);
            dir.Delete(true);
        }
    }

    [Test]
    public async Task 使っているリーダーをオフにすると次のリーダーで繋ぎ直す()
    {
        var first = new FakeLink("Gemplus (usb 3-11)");
        var second = new FakeLink("PIXELA PIX-DT295 3-5 Card Reader");
        HashSet<string> disabled = [];
        var card = BCas.Open(() => CardLinks.Without([new(first.Name, () => first), new(second.Name, () => second)], disabled));
        await Assert.That(card.Name).IsEqualTo(first.Name);

        disabled.Add(first.Name);
        card.Release(disabled);
        await Assert.That(first.Closed).IsEqualTo(1);
        await Assert.That(card.Name).IsEqualTo(second.Name);

        // 使っていないリーダーをオフにしても手放さない
        card.Release(new HashSet<string> { first.Name });
        await Assert.That(card.Name).IsEqualTo(second.Name);
        await Assert.That(second.Closed).IsEqualTo(0);
    }
}
