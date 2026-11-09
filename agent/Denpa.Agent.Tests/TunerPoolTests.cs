namespace Denpa.Agent.Tests;

/*
 * 定義を書き換える (Replace)・止める (CloseAll) のと、選局・読み出しが重なったとき。
 *
 * 偽のチューナー (FakeTuner) は、選局と読み出しの最中に閉じられたか、閉じたあとに使われたかを数える。
 * 本物なら閉じた fd を読むところ。選局と 1 回の読み出しに掛かる時間はテストごとに決める。
 *
 * **固まったら失敗にする** (Px4TunerTests と同じ)。Timeout が効くのはテストが Task を返してからなので、
 * 各テストは最初に `await Task.Yield()` する。待つところには打ち切りの合図 (cancel) を渡す
 */
[Timeout(30_000)]
public class TunerPoolTests
{
    internal sealed class FakeTuner : ITuneDevice
    {
        private readonly TimeSpan _tune;
        private readonly Ts _output;
        private int _busy;
        private volatile bool _closed;

        public FakeTuner(string path, TimeSpan tune, TimeSpan read)
        {
            Path = path;
            _tune = tune;
            _output = new Ts(this, read);
        }

        public string Path { get; }
        public int Tunes;
        /// <summary>選局か読み出しの最中に閉じられた回数</summary>
        public int ClosedWhileBusy;
        /// <summary>閉じたあとに選局・読み出しを始めた回数</summary>
        public int UsedAfterClose;
        public bool Closed => _closed;
        public readonly ManualResetEventSlim Tuning = new();

        private void Enter()
        {
            if (_closed) Interlocked.Increment(ref UsedAfterClose);
            Interlocked.Increment(ref _busy);
        }

        private void Exit() => Interlocked.Decrement(ref _busy);

        public void Tune(ChannelTable.Tuning tuning)
        {
            Enter();
            try
            {
                Interlocked.Increment(ref Tunes);
                Tuning.Set();
                Thread.Sleep(_tune);
            }
            finally
            {
                Exit();
            }
        }

        public Stream Output => _output;

        public bool Tuned => true;

        public void Dispose()
        {
            if (Volatile.Read(ref _busy) > 0) Interlocked.Increment(ref ClosedWhileBusy);
            _closed = true;
        }

        /// <summary>1 回の読み出しに <c>read</c> だけ掛けて、ヌルパケットを 1 つ返す</summary>
        private sealed class Ts(FakeTuner owner, TimeSpan read) : Stream
        {
            public override int Read(byte[] buffer, int offset, int count)
            {
                owner.Enter();
                try
                {
                    Thread.Sleep(read);
                    var packet = buffer.AsSpan(offset, 188);
                    packet.Clear();
                    packet[0] = 0x47;
                    packet[1] = 0x1F;
                    packet[2] = 0xFF;
                    packet[3] = 0x10;
                    return 188;
                }
                finally
                {
                    owner.Exit();
                }
            }

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }
    }

    /// <summary>偽のチューナーを開くプール。開いたものはデバイスの名前ごとに残す</summary>
    private sealed class Rig
    {
        private readonly List<FakeTuner> _opened = [];

        public Rig(IReadOnlyList<TunerSpec> specs, TimeSpan tune, TimeSpan read)
        {
            Pool = new TunerPool(specs, () => { }, new TuneOptions(), spec =>
            {
                var tuner = new FakeTuner(spec.Device!, tune, read);
                lock (_opened) _opened.Add(tuner);
                return tuner;
            });
        }

        public TunerPool Pool { get; }

        public IReadOnlyList<FakeTuner> Opened(string path)
        {
            lock (_opened) return [.. _opened.Where(tuner => tuner.Path == path)];
        }
    }

    private static TunerSpec Spec(string name, string device) => new(name, ["GR"], false, device);

    /// <summary>最初の TS が届くまで待つ</summary>
    private static async Task FirstChunk(Sink sink, CancellationToken cancel) => await sink.Reader.ReadAsync(cancel);

    /// <summary>読み出しが終わるまで読み、理由を返す</summary>
    private static async Task<string?> Drain(Sink sink, CancellationToken cancel)
    {
        await foreach (var _ in sink.Reader.ReadAllAsync(cancel)) { }
        return sink.FailedWith;
    }

    private static Task<T> Background<T>(Func<T> work) =>
        Task.Factory.StartNew(work, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    [Test]
    public async Task 読み出し中に定義を書き換えると_読み出しが止まってから閉じる(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(100));
        try
        {
            var sink = rig.Pool.Open("GR", "T27", 3, "epg T27");
            await FirstChunk(sink, cancel);

            rig.Pool.Replace([Spec("A", "fake:b")]);

            var a = rig.Opened("fake:a").Single();
            await Assert.That(a.Closed).IsTrue();
            await Assert.That(a.ClosedWhileBusy).IsEqualTo(0);
            await Assert.That(a.UsedAfterClose).IsEqualTo(0);
            await Assert.That(await Drain(sink, cancel)).IsEqualTo("チューナーの設定が変わりました");
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    [Test]
    public async Task 選局中に定義を書き換えると_選局が終わってから閉じ_その間も取り合いのロックを塞がない(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(10));
        try
        {
            var opening = Background(() => rig.Pool.Open("GR", "T27", 3, "epg T27"));
            // 偽のチューナーは選局の中で開かれるので、現れるまで待つ
            FakeTuner? a = null;
            while (a is null)
            {
                cancel.ThrowIfCancellationRequested();
                a = rig.Opened("fake:a").SingleOrDefault();
                await Task.Delay(10, cancel);
            }
            await Assert.That(a.Tuning.Wait(TimeSpan.FromSeconds(5), cancel)).IsTrue();

            var replacing = Background(() =>
            {
                rig.Pool.Replace([Spec("A", "fake:b")]);
                return true;
            });
            await Task.Delay(100, cancel);
            // 閉じるのを待っている間も、チューナーの一覧はすぐ返る
            var clock = System.Diagnostics.Stopwatch.StartNew();
            rig.Pool.Status();
            await Assert.That(replacing.IsCompleted).IsFalse().Because("選局が終わるまで閉じずに待つ");
            await Assert.That(clock.ElapsedMilliseconds < 300).IsTrue().Because($"{clock.ElapsedMilliseconds}ms 掛かった");

            await replacing.WaitAsync(TimeSpan.FromSeconds(10), cancel);
            var sink = await opening.WaitAsync(TimeSpan.FromSeconds(10), cancel);

            await Assert.That(a.Closed).IsTrue();
            await Assert.That(a.ClosedWhileBusy).IsEqualTo(0);
            await Assert.That(a.UsedAfterClose).IsEqualTo(0);
            await Assert.That(await Drain(sink, cancel)).IsEqualTo("チューナーの設定が変わりました");
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    /*
     * 取り上げた側は、前の読み出しが止まるのをロックの外で待つ (Lease.Await)。その間に定義が並べ替わると、
     * 取り上げた側はロックの中で写した古い定義のデバイスを開き、新しい定義の 0 番に残していた
     */
    [Test]
    public async Task 取り上げを待つ間に定義が並べ替わっても_古い定義のデバイスを開かない(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(300));
        try
        {
            var low = rig.Pool.Open("GR", "T27", 3, "epg T27");
            await FirstChunk(low, cancel);

            var high = Background(() => rig.Pool.Open("GR", "T28", 10, "rec 1"));
            // 取り上げられたら、取り上げた側は前の読み出し (1 回 300ms) が止まるのを待っている
            await Assert.That(await Drain(low, cancel)).IsEqualTo(TunerPool.PreemptedBy("rec 1"));
            rig.Pool.Replace([Spec("B", "fake:b"), Spec("A", "fake:a")]);

            var stale = await high.WaitAsync(TimeSpan.FromSeconds(10), cancel);
            await Assert.That(await Drain(stale, cancel)).IsEqualTo("チューナーの設定が変わりました");

            // 0 番を名指しすると、新しい定義のデバイス (fake:b) で選局する
            var again = rig.Pool.Open("GR", "T27", 3, "epg T27", pin: "fake:b");
            await FirstChunk(again, cancel);
            await Assert.That(rig.Opened("fake:a").Count).IsEqualTo(1);
            await Assert.That(rig.Opened("fake:b").Single().Tunes).IsEqualTo(1);

            var a = rig.Opened("fake:a").Single();
            await Assert.That(a.ClosedWhileBusy).IsEqualTo(0);
            await Assert.That(a.UsedAfterClose).IsEqualTo(0);
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    [Test]
    public async Task 止めるときは_読み出しと選局が終わってから閉じる(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a"), Spec("B", "fake:b")], TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(100));
        var reading = rig.Pool.Open("GR", "T27", 3, "epg T27");
        await FirstChunk(reading, cancel);
        var opening = Background(() => rig.Pool.Open("GR", "T28", 3, "epg T28"));
        FakeTuner? b = null;
        while (b is null)
        {
            cancel.ThrowIfCancellationRequested();
            b = rig.Opened("fake:b").SingleOrDefault();
            await Task.Delay(10, cancel);
        }
        await Assert.That(b.Tuning.Wait(TimeSpan.FromSeconds(5), cancel)).IsTrue();

        rig.Pool.CloseAll();
        await opening.WaitAsync(TimeSpan.FromSeconds(10), cancel);

        foreach (var tuner in rig.Opened("fake:a").Concat(rig.Opened("fake:b")))
        {
            await Assert.That(tuner.Closed).IsTrue();
            await Assert.That(tuner.ClosedWhileBusy).IsEqualTo(0).Because(tuner.Path);
            await Assert.That(tuner.UsedAfterClose).IsEqualTo(0).Because(tuner.Path);
        }
    }

    [Test]
    public async Task J83B_は_IT930x_の機材のほかでは選局せずに断る()
    {
        await Task.Yield();
        // 種別に SKY を入れても、IT930x の機材でなければ ISDB の選局として渡さない
        var rig = new Rig([new TunerSpec("A", ["SKY"], false, "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(10));
        try
        {
            var error = Assert.Throws<IOException>(() => rig.Pool.Open(ChannelTable.Sky, "H40", 3, "scan H40"));
            await Assert.That(error.Message).Contains("it930x: の受信機だけ");
            await Assert.That(rig.Opened("fake:a").Single().Tunes).IsEqualTo(0);
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }
}
