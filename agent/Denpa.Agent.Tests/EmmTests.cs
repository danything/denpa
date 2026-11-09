namespace Denpa.Agent.Tests;

/// <summary>止めた時計。テストが進める。タイマーは <see cref="Advance"/> で時刻が来たものだけ呼ぶ</summary>
internal sealed class StepClock : TimeProvider
{
    private readonly List<StepTimer> _timers = [];

    public DateTimeOffset Now { get; set; } = new(2026, 11, 8, 0, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => Now;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new StepTimer(callback, state, Now + dueTime);
        _timers.Add(timer);
        return timer;
    }

    /// <summary>時計を進め、時刻が来たタイマーを 1 回ずつ呼ぶ</summary>
    public void Advance(TimeSpan by)
    {
        Now += by;
        foreach (var timer in _timers.Where(timer => !timer.Disposed && timer.At <= Now).ToList())
        {
            timer.Disposed = true;
            timer.Callback(timer.State);
        }
    }

    private sealed class StepTimer(TimerCallback callback, object? state, DateTimeOffset at) : ITimer
    {
        public TimerCallback Callback { get; } = callback;
        public object? State { get; } = state;
        public DateTimeOffset At { get; } = at;
        public bool Disposed { get; set; }

        public bool Change(TimeSpan dueTime, TimeSpan period) => throw new NotSupportedException();

        public void Dispose() => Disposed = true;

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}

/*
 * 契約の更新 (EMM) の渡し先 (Emm.cs)。
 *
 * 作業スレッドは起動せず、Step を呼んで 1 回ずつ進める。カードは返り値を決めて返す偽物 (Card)。
 * セクションの組み立てと CAT は B25Tests で確かめる。
 */
public class EmmTests
{
    private const long Mine = 0x0000_1111_2222, Group = 0x2000_3333_4444;

    /// <summary>EMM のペイロード 1 つ。カード ID 6・関連情報バイト長 1・プロトコル番号・事業体識別・更新番号 2・有効期限 2・可変部・MAC 4</summary>
    internal static byte[] Payload(long cardId, int seed, int variable = 8)
    {
        var associated = 1 + 1 + 2 + 2 + variable + 4;
        var payload = new List<byte>();
        for (var shift = 40; shift >= 0; shift -= 8) payload.Add((byte)(cardId >> shift));
        payload.Add((byte)associated);
        payload.AddRange([0x41, 0x01, (byte)(seed >> 8), (byte)seed, 0xE0, 0x00]);
        payload.AddRange(Enumerable.Range(0, variable + 4).Select(i => (byte)(seed + i)));
        return [.. payload];
    }

    /// <summary>ペイロードを並べた EMM セクション。CRC は渡し先では確かめないので 0 を置く</summary>
    private static byte[] Section(params byte[][] payloads) =>
        [0x84, 0, 0, 0, 0, 0, 0, 0, .. payloads.SelectMany(p => p), 0, 0, 0, 0];

    private sealed class Card : IKeySource
    {
        public long[] Ids { get; set; } = [Mine, Group];
        public Func<byte[], int> Code { get; set; } = _ => 0x2100;
        public Exception? InitFails { get; set; }
        public int Inits { get; private set; }
        public List<byte[]> Sent { get; } = [];

        public CardInit Init()
        {
            Inits++;
            if (InitFails is { } error) throw error;
            return new(new byte[32], new byte[8], 5, Ids);
        }

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => throw new NotSupportedException();

        public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) => throw new NotSupportedException();

        public int Emm(ReadOnlySpan<byte> payload)
        {
            var copy = payload.ToArray();
            Sent.Add(copy);
            return Code(copy);
        }
    }

    /// <summary>番号を取り終えた渡し先</summary>
    private static (Emm Emm, StepClock Clock) Ready(Card card, Action? accepted = null)
    {
        var clock = new StepClock();
        var emm = new Emm(() => card, clock, accepted);
        emm.Section(Section());
        emm.Step();
        return (emm, clock);
    }

    /// <summary>1 秒進めて 1 回</summary>
    private static void Tick(Emm emm, StepClock clock, int times = 1)
    {
        for (var i = 0; i < times; i++)
        {
            clock.Now += TimeSpan.FromSeconds(1);
            emm.Step();
        }
    }

    [Test]
    public async Task 個別とグループの番号の両方で自分宛てを選ぶ()
    {
        var card = new Card();
        var (emm, clock) = Ready(card);

        emm.Section(Section(Payload(0x0000_9999_8888, 1), Payload(Mine, 2), Payload(Group, 3)));
        Tick(emm, clock, 5);

        await Assert.That(card.Sent.Select(p => p[10]).ToArray()).IsEquivalentTo(new byte[] { 2, 3 });
    }

    [Test]
    [Arguments(0x2100)]
    [Arguments(0xA102)]
    [Arguments(0xA107)]
    public async Task カードが応答したものは_もう送らない(int code)
    {
        var card = new Card { Code = _ => code };
        var (emm, clock) = Ready(card);

        for (var i = 0; i < 3; i++)
        {
            emm.Section(Section(Payload(Mine, 1)));
            Tick(emm, clock, 2);
        }

        await Assert.That(card.Sent.Count).IsEqualTo(1);
    }

    [Test]
    public async Task ほかの返り値とカードと通信できなかったものは_次に流れてきたら送り直す()
    {
        var calls = 0;
        var card = new Card { Code = _ => ++calls == 1 ? 0xA103 : throw new IOException("カードとやり取りできません") };
        var (emm, clock) = Ready(card);

        for (var i = 0; i < 3; i++)
        {
            emm.Section(Section(Payload(Mine, 1)));
            Tick(emm, clock, 2);
        }

        await Assert.That(card.Sent.Count).IsEqualTo(3);
    }

    [Test]
    public async Task 配る側が古く_EMM_を受け付けなければ_その出どころのあいだはもう送らない()
    {
        var card = new Card { Code = _ => throw new NotSupportedException("配る側のエージェントが古い") };
        var (emm, clock) = Ready(card);

        for (var i = 0; i < 3; i++)
        {
            emm.Section(Section(Payload(Mine, i)));
            Tick(emm, clock, 2);
        }
        await Assert.That(card.Sent.Count).IsEqualTo(1);

        // 鍵の出どころが替われば (配る側を新しくした・手元のカードに替えた) また送る
        var next = new Card();
        var current = card;
        var swapped = new Emm(() => current, clock);
        swapped.Section(Section());
        swapped.Step();
        swapped.Section(Section(Payload(Mine, 9)));
        Tick(swapped, clock, 2);
        await Assert.That(card.Sent.Count).IsEqualTo(2);
        current = next;
        swapped.Section(Section(Payload(Mine, 10)));
        Tick(swapped, clock, 2);
        await Assert.That(next.Sent.Count).IsEqualTo(1);
    }

    [Test]
    public async Task 持つのは_256_件までで_古いものから捨てる()
    {
        var card = new Card();
        var (emm, clock) = Ready(card);

        for (var seed = 0; seed <= 256; seed++)
        {
            emm.Section(Section(Payload(Mine, seed)));
            Tick(emm, clock);
        }
        // 0 番は捨て、256 番は持っている
        emm.Section(Section(Payload(Mine, 256), Payload(Mine, 0)));
        Tick(emm, clock, 3);

        await Assert.That(card.Sent.Count).IsEqualTo(258);
        await Assert.That(card.Sent[^1].SequenceEqual(Payload(Mine, 0))).IsTrue();
    }

    [Test]
    public async Task 順番待ちは_16_件で_溢れたら新しいほうを捨てる()
    {
        var card = new Card();
        var (emm, clock) = Ready(card);

        emm.Section(Section([.. Enumerable.Range(0, 20).Select(seed => Payload(Mine, seed))]));
        Tick(emm, clock, 30);

        await Assert.That(card.Sent.Count).IsEqualTo(16);
        await Assert.That(card.Sent[^1][10]).IsEqualTo((byte)15);
    }

    [Test]
    public async Task カードに送るのは_1_秒に_1_件まで()
    {
        var card = new Card();
        var (emm, clock) = Ready(card);

        emm.Section(Section(Payload(Mine, 1), Payload(Mine, 2), Payload(Mine, 3)));
        for (var i = 0; i < 5; i++) emm.Step();
        await Assert.That(card.Sent.Count).IsEqualTo(1);

        clock.Now += TimeSpan.FromMilliseconds(999);
        emm.Step();
        await Assert.That(card.Sent.Count).IsEqualTo(1);

        clock.Now += TimeSpan.FromMilliseconds(1);
        emm.Step();
        await Assert.That(card.Sent.Count).IsEqualTo(2);
    }

    [Test]
    public async Task 番号が取れない間は_EMM_を捨て_10_秒は取り直さない()
    {
        var card = new Card { InitFails = new IOException("カードリーダーが見つかりません") };
        var clock = new StepClock();
        var emm = new Emm(() => card, clock);

        emm.Section(Section(Payload(Mine, 1)));
        emm.Step();
        await Assert.That(card.Inits).IsEqualTo(1);
        await Assert.That(emm.Ids).IsNull();

        // 番号が無い間に流れてきたものは比べずに捨てる。取り直すのは 10 秒たってから
        card.InitFails = null;
        emm.Section(Section(Payload(Mine, 2)));
        clock.Now += TimeSpan.FromSeconds(9);
        emm.Step();
        await Assert.That(card.Inits).IsEqualTo(1);
        clock.Now += TimeSpan.FromSeconds(1);
        emm.Step();
        await Assert.That(card.Inits).IsEqualTo(2);
        await Assert.That(card.Sent.Count).IsEqualTo(0);

        emm.Section(Section(Payload(Mine, 3)));
        Tick(emm, clock);
        await Assert.That(card.Sent.Count).IsEqualTo(1);
    }

    [Test]
    public async Task カードが替わったら送る前に選び直す()
    {
        var card = new Card();
        var (emm, clock) = Ready(card);

        emm.Section(Section(Payload(Mine, 1)));
        card.Ids = [0x0000_7777_6666];
        Tick(emm, clock, 2);
        await Assert.That(card.Sent.Count).IsEqualTo(0);

        // 選び直したあとは、新しい番号で比べる
        emm.Section(Section(Payload(Mine, 2), Payload(0x0000_7777_6666, 3)));
        Tick(emm, clock, 3);
        await Assert.That(card.Sent.Select(p => p[10]).ToArray()).IsEquivalentTo(new byte[] { 3 });
    }

    [Test]
    public async Task 受け入れたときだけ知らせる()
    {
        var accepted = 0;
        var card = new Card { Code = payload => payload[10] == 1 ? 0x2100 : 0xA102 };
        var (emm, clock) = Ready(card, () => accepted++);

        emm.Section(Section(Payload(Mine, 1), Payload(Mine, 2)));
        Tick(emm, clock, 3);

        await Assert.That(card.Sent.Count).IsEqualTo(2);
        await Assert.That(accepted).IsEqualTo(1);
    }

    [Test]
    public async Task 受け入れ以外の返り値が続いても記録には_1_行だけ出す()
    {
        // ほかのテストと混ざらない返り値
        const int code = 0xA1F5;
        static int Lines() => Log.Recent.Snapshot().Count(line => line.Text.Contains($"0x{code:X4}"));
        var card = new Card { Code = _ => code };
        var (emm, clock) = Ready(card);
        var before = Lines();

        for (var i = 0; i < 3; i++)
        {
            emm.Section(Section(Payload(Mine, 1)));
            Tick(emm, clock, 2);
        }

        await Assert.That(card.Sent.Count).IsEqualTo(3);
        await Assert.That(Lines() - before).IsEqualTo(1);
    }

    [Test]
    public async Task 知らせるのは_1_分に_1_回まで_その間にまた受け入れたら間が明けたときに_1_回知らせる()
    {
        var clock = new StepClock();
        var emitted = 0;
        var notice = new CardNotice(() => emitted++, clock);

        notice.Accepted();
        clock.Advance(TimeSpan.FromSeconds(20));
        notice.Accepted();
        clock.Advance(TimeSpan.FromSeconds(20));
        notice.Accepted();
        await Assert.That(emitted).IsEqualTo(1);

        // 1 回目から 1 分で、まとめて 1 回
        clock.Advance(TimeSpan.FromSeconds(20));
        await Assert.That(emitted).IsEqualTo(2);

        // 間が明けてから 1 分たてば、すぐ知らせる
        clock.Advance(TimeSpan.FromSeconds(60));
        notice.Accepted();
        await Assert.That(emitted).IsEqualTo(3);
        clock.Advance(TimeSpan.FromSeconds(120));
        await Assert.That(emitted).IsEqualTo(3);
    }
}
