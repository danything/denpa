using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * 定義を書き換える (Replace)・止める (CloseAll) のと、選局・読み出しが重なったとき。
 *
 * 偽のチューナー (FakeTuner) は、選局と読み出しの最中に閉じられたか、閉じたあとに使われたかを数える。
 * 本物なら閉じた fd を読むところ。選局と 1 回の読み出しに掛かる時間はテストごとに決める。
 *
 * **固まったら失敗にする。**Timeout が効くのはテストが Task を返してからなので、
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

        public FakeTuner(string path, TimeSpan tune, TimeSpan read, StreamFormat format = StreamFormat.Ts, byte[]? content = null)
        {
            Path = path;
            _tune = tune;
            Format = format;
            _output = new Ts(this, read);
            Content = content;
        }

        public string Path { get; }

        /// <summary>TLV なら、読み出しは TLV のヌルパケットを返す (<see cref="NullTlv"/>)</summary>
        public StreamFormat Format { get; }

        /// <summary>TLV のヌルパケット (長さ 96)。188 バイトの並びにならない長さにして、デスクランブラに通していないことを確かめる</summary>
        public static readonly byte[] NullTlv = [0x7F, 0xFF, 0x00, 0x60, .. new byte[0x60]];
        public int Tunes;
        /// <summary>選局か読み出しの最中に閉じられた回数</summary>
        public int ClosedWhileBusy;
        /// <summary>閉じたあとに選局・読み出しを始めた回数</summary>
        public int UsedAfterClose;
        public bool Closed => _closed;
        /// <summary>TS の読み出しが返すパケットの並び。くり返し 1 パケットずつ返す。null ならヌルパケット</summary>
        public byte[]? Content { get; }
        private int _at;
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
                    if (owner.Format == StreamFormat.Tlv)
                    {
                        NullTlv.CopyTo(buffer.AsSpan(offset));
                        return NullTlv.Length;
                    }
                    var packet = buffer.AsSpan(offset, 188);
                    if (owner.Content is { } content)
                    {
                        content.AsSpan(owner._at, 188).CopyTo(packet);
                        owner._at = (owner._at + 188) % content.Length;
                        return 188;
                    }
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

        public Rig(IReadOnlyList<TunerSpec> specs, TimeSpan tune, TimeSpan read, StreamFormat format = StreamFormat.Ts, byte[]? content = null)
        {
            Pool = new TunerPool(specs, () => { }, new TuneOptions(), spec =>
            {
                var tuner = new FakeTuner(spec.Device!, tune, read, format, content);
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
    public async Task TLV_はデスクランブラに通さずにそのまま配り_共有に入った利用者にも同じ形式を返す(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(10), StreamFormat.Tlv);
        try
        {
            var first = rig.Pool.Open("GR", "T27", 3, "rec 1");
            var chunk = await first.Reader.ReadAsync(cancel);
            // デスクランブラは 188 バイトのパケットに区切るので、96 バイトのまま届けば通していない
            await Assert.That(chunk.AsSpan(0, FakeTuner.NullTlv.Length).SequenceEqual(FakeTuner.NullTlv)).IsTrue();
            await Assert.That(chunk.Length % FakeTuner.NullTlv.Length).IsEqualTo(0);
            await Assert.That(first.Format).IsEqualTo(StreamFormat.Tlv);
            await Assert.That(first.ContentType).IsEqualTo("application/x-arib-tlv");

            // 同じチャンネルは選局し直さずに共有する。形式は選局したときのまま
            var second = rig.Pool.Open("GR", "T27", 3, "live 1");
            await FirstChunk(second, cancel);
            await Assert.That(second.ContentType).IsEqualTo("application/x-arib-tlv");
            await Assert.That(rig.Opened("fake:a").Single().Tunes).IsEqualTo(1);
            first.Leave();
            second.Leave();
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    [Test]
    public async Task TS_の_Content_Type_は今までの_video_MP2T(CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(10));
        try
        {
            var sink = rig.Pool.Open("GR", "T27", 3, "epg T27");
            await FirstChunk(sink, cancel);
            await Assert.That(sink.Format).IsEqualTo(StreamFormat.Ts);
            await Assert.That(sink.ContentType).IsEqualTo("video/MP2T");
            sink.Leave();
        }
        finally
        {
            rig.Pool.CloseAll();
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

    [Test]
    public async Task ISDB_C_は_IT930x_の機材のほかでは選局せずに断る()
    {
        await Task.Yield();
        // 種別に CATV を入れても、IT930x の機材でなければ ISDB-T の選局として渡さない
        var rig = new Rig([new TunerSpec("A", [ChannelTable.Catv], false, "fake:a")], TimeSpan.Zero, TimeSpan.FromMilliseconds(10));
        try
        {
            var error = Assert.Throws<IOException>(() => rig.Pool.Open(ChannelTable.Catv, "QC30:1", 3, "scan QC30:1"));
            await Assert.That(error.Message).Contains("QC30:1 (ISDB-C) を選局できるのは it930x: の受信機だけ");
            await Assert.That(rig.Opened("fake:a").Single().Tunes).IsEqualTo(0);
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    /*
     * 覚えた PAT・PMT (PsiMemory)。偽のチューナーは、スクランブルされていない 2 局の TS (映像が先、PAT・PMT があと) をくり返し返す。
     * 覚えたものを使えば、ライブの最初の塊は差し込んだ PAT から始まる。使わなければ本物の PMT まで溜めるので、映像から始まる
     */
    private const int Service = 0x0400, OtherService = 0x0401, OtherPmt = 0x0102, OtherVideo = 0x0121;

    /// <summary>2 局の TS の 1 周。<paramref name="other"/> が false なら 2 局目の PMT を入れない</summary>
    private static byte[] TwoServices(bool other = true)
    {
        var ts = new B25Tests.Ts().Videos(5, null)
            .Pat((Service, B25Tests.PmtPid), (OtherService, OtherPmt))
            .Pmt(B25Tests.PmtPid, Service, [], (B25Tests.VideoPid, []));
        if (other) ts.Pmt(OtherPmt, OtherService, [], (OtherVideo, []));
        return [.. ts.Videos(5, null).Wire];
    }

    private static int[] Pids(byte[] ts) => [.. ts.Chunk(188).Select(packet => ((packet[1] & 0x1F) << 8) | packet[2])];

    /// <summary><paramref name="bytes"/> バイト読むまで待つ</summary>
    private static async Task ReadBytes(Sink sink, int bytes, CancellationToken cancel)
    {
        var read = 0;
        while (read < bytes) read += (await sink.Reader.ReadAsync(cancel)).Length;
    }

    /// <summary>**番組表の選局で覚えた PAT・PMT を、同じチャンネルのライブの選局がほかのチューナーで使う**</summary>
    [Test]
    public async Task 番組表の選局で覚えた_PMT_を同じチャンネルのライブがほかのチューナーで使う(CancellationToken cancel)
    {
        await Task.Yield();
        var content = TwoServices();
        var rig = new Rig([Spec("A", "fake:a"), Spec("B", "fake:b")], TimeSpan.Zero, TimeSpan.FromMilliseconds(1), content: content);
        try
        {
            var epg = rig.Pool.Open("GR", "T27", 1, "epg T27", pin: "fake:a");
            await ReadBytes(epg, content.Length, cancel);

            var live = rig.Pool.Open("GR", "T27", 5, "live 1", pin: "fake:b", service: Service);
            var first = await live.Reader.ReadAsync(cancel);

            // 最初の 1 パケットは並びを合わせるのに次を待つので、差し込みのあとに映像が 2 つ並ぶ
            await Assert.That(Pids(first)).IsEquivalentTo(new[] { 0, B25Tests.PmtPid, B25Tests.VideoPid, B25Tests.VideoPid }, CollectionOrdering.Matching);
            epg.Leave();
            live.Leave();
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    /// <summary>
    /// **2 局のライブが 1 つの選局を共有しているときは、両方の局の PMT を覚えていなければ使わない。** 片方だけなら本物の PAT・PMT を待つ
    /// </summary>
    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task 共有している_2_局のライブは両方の局を覚えているときだけ使う(bool both, CancellationToken cancel)
    {
        await Task.Yield();
        var rig = new Rig([Spec("A", "fake:a")], TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(1), content: TwoServices());
        try
        {
            // 番組表の選局で読んだことにする (both が false なら 2 局目の PMT は流れてこなかった)
            var remembered = TwoServices(other: both);
            new Descrambler(new NoCard(), keysWanted: () => false, memory: rig.Pool.Psi.For("GR", "T27"))
                .DecodeAll(new MemoryStream(remembered), Stream.Null);

            // 1 局目のライブが選局している間に、2 局目のライブが共有に入る
            var opening = Background(() => rig.Pool.Open("GR", "T27", 5, "live 1", service: Service));
            while (rig.Opened("fake:a").Count == 0) await Task.Delay(10, cancel);
            await Assert.That(rig.Opened("fake:a").Single().Tuning.Wait(TimeSpan.FromSeconds(10), cancel)).IsTrue();
            var second = rig.Pool.Open("GR", "T27", 5, "live 2", service: OtherService);
            var first = await opening;
            var chunk = await first.Reader.ReadAsync(cancel);

            var pids = Pids(chunk);
            if (both) await Assert.That(pids[..3]).IsEquivalentTo(new[] { 0, B25Tests.PmtPid, OtherPmt }, CollectionOrdering.Matching);
            else await Assert.That(pids[0]).IsEqualTo(B25Tests.VideoPid);
            first.Leave();
            second.Leave();
        }
        finally
        {
            rig.Pool.CloseAll();
        }
    }

    /// <summary>鍵の要らない選局だけで使うカード。問い合わせられたら失敗にする</summary>
    private sealed class NoCard : IKeySource
    {
        public CardInit Init() => throw new InvalidOperationException("カードに問い合わせました");
        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => throw new InvalidOperationException("カードに問い合わせました");
        public int Emm(ReadOnlySpan<byte> payload) => throw new InvalidOperationException("カードに問い合わせました");
        public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) => throw new InvalidOperationException("カードに問い合わせました");
    }
}
