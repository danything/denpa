using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Sockets;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * px4d の制御ソケットで受信機を取ったまま選局し直すところ (Px4Tuner。Px4.cs)。
 *
 * px4d は無い。control.sock と stream.sock を開いて px4d のふりをする (Px4CardTests と同じ流儀)。
 * ふりは SPEC 6.3 の決まりだけ守る: 取った lease で TUNE → START_STREAM → stream.sock に
 * ATTACH_STREAM (lease と nonce) で TS_DATA が流れ、STOP_STREAM で STREAM_END。
 * TS の中身は周波数の印 (パケットの2バイト目) にして、どの選局の TS かを見分ける。
 */
/*
 * **固まったら失敗にする。** ソケットとスレッドを相手にするので、固まり方を1つ見落とすと
 * CI の Unit tests ごと打ち切られ、どのテストかも分からない (Mac で 8 分止まった)。
 * Timeout が効くのはテストが Task を返してから — 各テストは頭で `await Task.Yield()` して、
 * 同期の処理 (Tune・Dispose) を Task の中に入れる。待つところには打ち切りの合図 (cancel) を渡す
 */
[Timeout(60_000)]
public class Px4TunerTests
{
    private const string Id = "00001205000960";

    private static readonly byte[] Nonce = [.. Enumerable.Range(1, 16).Select(i => (byte)i)];

    /// <summary>周波数から TS の印を作る</summary>
    internal static byte Mark(ulong khz) => (byte)(khz % 251);

    internal sealed class FakePx4d : IDisposable
    {
        private readonly Socket _control;
        private readonly Socket _stream;
        private readonly Lock _gate = new();
        private readonly List<Socket> _open = [];
        private ulong _nextLease = 0x1000;
        private ulong _lease;
        private bool _tuned;
        private bool _armed;
        private bool _active;
        private ulong _khz;
        private int _attachments;
        private int _attachTries;
        private Socket? _controlClient;
        private volatile bool _closed;
        private readonly Task[] _serving;

        public DirectoryInfo Runtime { get; } = Directory.CreateTempSubdirectory("px4");

        /// <summary>制御ソケットに来た型 (来た順)</summary>
        public List<ushort> Received { get; } = [];

        /// <summary>TUNE で指定された LNB の電圧 (来た順)</summary>
        public List<byte> Lnbs { get; } = [];

        /// <summary>stream.sock を相手が閉じた回数</summary>
        public int StreamsClosed;

        /// <summary>TUNE に番号で断る (0 なら通す)。引数は kHz</summary>
        public Func<ulong, uint> TuneError { get; init; } = _ => 0;

        /// <summary>ACQUIRE に番号で断る (0 なら通す)</summary>
        public uint AcquireError { get; init; }

        /// <summary>この番目 (1 から) の ATTACH_STREAM を NOT_FOUND で断る</summary>
        public int RejectAttach { get; init; }

        /// <summary>最初のストリームだけ、これだけ流したら STREAM_END (この番号) で止める</summary>
        public (int Frames, uint Code)? EndFirstStream { get; init; }

        /// <summary>
        /// TS を流す速さ (バイト/秒)。null なら1枚ごとに 2ms 寝る (今までどおり)、0 なら寝ずに流せるだけ流す
        /// </summary>
        public double? Rate { get; init; }

        /// <summary>これだけ流したら、繋いだまま黙る (読む側が待っているところを作る)</summary>
        public int? FramesThenSilence { get; init; }

        /// <summary>STATS に答える (HELLO で STREAM_STATS を認める)。呼ばれた回数を引数に、queue_drops を返す。null なら STATS を持たない</summary>
        public Func<int, ulong>? Stats { get; init; }

        private int _statsCalls;

        /// <summary>どちらのふりをするか (asicend は枠の頭とソケットの置き場だけ違う。AsicenTests)</summary>
        public Px4Wire Wire { get; }

        public FakePx4d(Px4Wire? wire = null, string id = Id)
        {
            Wire = wire ?? Px4Wire.Px4;
            var dir = Path.Combine(Runtime.FullName, Wire.Product, id);
            Directory.CreateDirectory(dir);
            _control = Listen(Path.Combine(dir, "control.sock"));
            _stream = Listen(Path.Combine(dir, "stream.sock"));
            _serving = [Serve(_control, ServeControl), Serve(_stream, ServeStream)];
        }

        public int Count(ushort type)
        {
            lock (Received) return Received.Count(t => t == type);
        }

        private static Socket Listen(string path)
        {
            var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.Bind(new UnixDomainSocketEndPoint(path));
            socket.Listen();
            return socket;
        }

        /// <summary>
        /// 繋いできたものを1本ずつ専用のスレッドで (Px4CardTests と同じ理由でスレッドプールを使わない)。
        ///
        /// <para>
        /// **Accept で待たない。** Poll で 100ms ずつ待ち、来ているときだけ Accept する。
        /// macOS は待ち受けを閉じても Accept が起きず、.NET の Socket.Dispose は Accept が
        /// 戻るのを待つので、片付け (Dispose) ごと止まる。1本繋いで起こす手 (Px4CardTests) は
        /// 1本しか受けない偽物なら効くが、ここは受け続けるので、起こしてもすぐ次の Accept に
        /// 戻って同じことになる (Mac の CI で Unit tests が 8 分で打ち切られた)
        /// </para>
        /// </summary>
        private Task Serve(Socket listener, Action<Socket> serve) => Task.Factory.StartNew(() =>
        {
            while (!_closed)
            {
                Socket client;
                try
                {
                    if (!listener.Poll(TimeSpan.FromMilliseconds(100), SelectMode.SelectRead)) continue;
                    client = listener.Accept();
                }
                catch (Exception)
                {
                    return;
                }
                lock (_open) _open.Add(client);
                Task.Factory.StartNew(() =>
                {
                    try
                    {
                        serve(client);
                    }
                    catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
                    {
                    }
                    finally
                    {
                        client.Dispose();
                    }
                }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

        private static byte[] Error(uint code)
        {
            var payload = new byte[6];
            BinaryPrimitives.WriteUInt32LittleEndian(payload, code);
            return payload;
        }

        private void ServeControl(Socket client)
        {
            lock (_gate) _controlClient = client;
            try
            {
                while (true)
                {
                    var (type, _, id, payload) = Px4Control.ReadFrame(client, Px4Control.MaxPayload, Wire);
                    lock (Received) Received.Add(type);
                    var (flags, answer) = Answer(type, payload);
                    Px4Control.SendAll(client, Px4Control.Encode(type, flags, id, answer, Wire));
                }
            }
            finally
            {
                // 本物は接続が閉じると取ったものを返し、ストリームも畳む
                lock (_gate)
                {
                    if (_controlClient == client)
                    {
                        _lease = 0;
                        _tuned = _armed = _active = false;
                    }
                }
            }
        }

        private (ushort, byte[]) Answer(ushort type, byte[] payload)
        {
            const ushort ok = Px4Control.ResponseFlag;
            const ushort failed = Px4Control.ResponseFlag | Px4Control.ErrorFlag;
            lock (_gate)
            {
                var lease = payload.Length >= 8 ? BinaryPrimitives.ReadUInt64LittleEndian(payload) : 0;
                switch (type)
                {
                    case Px4Control.Hello:
                    {
                        var hello = new byte[8];
                        BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
                        if (Stats is not null) BinaryPrimitives.WriteUInt32LittleEndian(hello.AsSpan(4), Px4Control.StreamStatsCapability);
                        return (ok, hello);
                    }
                    case Px4Control.Acquire:
                    {
                        if (AcquireError != 0) return (failed, Error(AcquireError));
                        _lease = ++_nextLease;
                        var answer = new byte[24];
                        BinaryPrimitives.WriteUInt64LittleEndian(answer, _lease);
                        Nonce.CopyTo(answer, 8);
                        return (ok, answer);
                    }
                    case Px4Control.Tune:
                    {
                        if (lease != _lease || _lease == 0) return (failed, Error(3));
                        if (_armed || _active) return (failed, Error(4));
                        var khz = BinaryPrimitives.ReadUInt64LittleEndian(payload.AsSpan(9));
                        Lnbs.Add(payload[25]);
                        _tuned = false;
                        if (TuneError(khz) is var code and not 0) return (failed, Error(code));
                        _khz = khz;
                        _tuned = true;
                        var answer = new byte[5];
                        answer[0] = 1;
                        BinaryPrimitives.WriteInt32LittleEndian(answer.AsSpan(1), int.MinValue);
                        return (ok, answer);
                    }
                    case Px4Control.StartStream:
                        if (lease != _lease || _lease == 0) return (failed, Error(3));
                        if (!_tuned) return (failed, Error(5));
                        if (_armed || _active) return (failed, Error(4));
                        _armed = true;
                        return (ok, []);
                    case Px4Control.StopStream:
                        if (lease != _lease || _lease == 0) return (failed, Error(3));
                        if (!_active) return (failed, Error(5));
                        _active = false;
                        return (ok, new byte[64]);
                    case Px4Control.Stats when Stats is not null:
                    {
                        if (lease != _lease || _lease == 0) return (failed, Error(3));
                        var counters = new byte[64];
                        BinaryPrimitives.WriteUInt64LittleEndian(counters.AsSpan(40), Stats(++_statsCalls));
                        return (ok, counters);
                    }
                    case Px4Control.Release:
                        if (lease != _lease || _lease == 0) return (failed, Error(3));
                        _lease = 0;
                        _tuned = _armed = _active = false;
                        return (ok, []);
                    default:
                        return (failed, Error(1));
                }
            }
        }

        private void ServeStream(Socket client)
        {
            var (type, _, id, payload) = Px4Control.ReadFrame(client, Px4Control.MaxPayload, Wire);
            int attachment;
            ulong khz;
            lock (_gate)
            {
                var good = ++_attachTries != RejectAttach && type == Px4Control.AttachStream && payload.Length == 24 && _armed
                    && BinaryPrimitives.ReadUInt64LittleEndian(payload) == _lease && payload.AsSpan(8).SequenceEqual(Nonce);
                if (!good)
                {
                    Px4Control.SendAll(client, Px4Control.Encode(Px4Control.AttachStream, 3, id, Error(3), Wire));
                    return;
                }
                _armed = false;
                _active = true;
                attachment = ++_attachments;
                khz = _khz;
            }
            Px4Control.SendAll(client, Px4Control.Encode(Px4Control.AttachStream, Px4Control.ResponseFlag, id, [], Wire));

            try
            {
                const int packets = 64;
                var frame = new byte[20 + 188 * packets];
                BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(16), 188 * packets);
                for (var i = 0; i < packets; i++)
                {
                    frame[20 + i * 188] = 0x47;
                    frame[20 + i * 188 + 1] = Mark(khz);
                }
                // 枠は1度だけ作り、番号だけ書き換えて送る (速さを測るテストで、偽物の確保を数に入れない)
                var encoded = Px4Control.Encode(Px4Control.TsData, 0, 0, frame, Wire);
                var paced = Stopwatch.StartNew();
                long sent = 0;
                for (ulong sequence = 0; ; sequence++)
                {
                    if (FramesThenSilence is { } quiet && (int)sequence >= quiet)
                    {
                        bool still;
                        lock (_gate) still = _active && _attachments == attachment;
                        if (still)
                        {
                            Thread.Sleep(10);
                            sequence--;
                            continue;
                        }
                    }
                    bool active;
                    lock (_gate) active = _active && _attachments == attachment;
                    var ending = attachment == 1 && EndFirstStream is { } end && (int)sequence == end.Frames;
                    if (!active || ending)
                    {
                        var body = new byte[68];
                        if (ending) BinaryPrimitives.WriteUInt32LittleEndian(body.AsSpan(64), EndFirstStream!.Value.Code);
                        lock (_gate) if (ending) _active = false;
                        Px4Control.SendAll(client, Px4Control.Encode(Px4Control.StreamEnd, 0, 0, body, Wire));
                        // 本物と同じく、閉じるのは相手
                        while (client.Receive(new byte[16]) > 0) { }
                        return;
                    }
                    BinaryPrimitives.WriteUInt64LittleEndian(encoded.AsSpan(Px4Control.HeaderSize), sequence);
                    Px4Control.SendAll(client, encoded);
                    sent += frame.Length - 20;
                    if (Rate is null)
                    {
                        Thread.Sleep(2);
                    }
                    else if (Rate > 0)
                    {
                        while (sent > Rate * paced.Elapsed.TotalSeconds) Thread.Sleep(1);
                    }
                }
            }
            finally
            {
                // 本物は閉じた stream.sock のストリームを取り消す (lease は取ったまま)
                lock (_gate)
                {
                    if (_attachments == attachment) _active = false;
                }
                Interlocked.Increment(ref StreamsClosed);
            }
        }

        /// <summary>px4d が落ちたふり。繋がっている制御ソケットを切る</summary>
        public void DropControl()
        {
            lock (_gate)
            {
                _controlClient?.Shutdown(SocketShutdown.Both);
                // Windows は閉じる向きを言っただけでは、受けかけの Receive (受け手のスレッド) が起きない。閉じて起こす
                if (OperatingSystem.IsWindows()) _controlClient?.Dispose();
            }
        }

        public void Dispose()
        {
            // 受け手が Accept の外に出てから待ち受けを閉じる (Serve)。抜けないまま閉じると
            // macOS で Dispose ごと止まりうるので、閉じずに失敗にする (待ち受けは漏れるが固まらない)
            _closed = true;
            if (!Task.WaitAll(_serving, TimeSpan.FromSeconds(5)))
            {
                throw new TimeoutException("偽の px4d の受け手が 5 秒で抜けません");
            }
            _control.Dispose();
            _stream.Dispose();
            /*
             * 繋がったものは、閉じる向きを言ってから閉じる。受けかけ・送りかけのスレッドはこれで起きる
             * (Dispose だけだと、読みかけの Receive が戻るのを待つことがある)
             */
            lock (_open)
            {
                foreach (var socket in _open)
                {
                    try
                    {
                        socket.Shutdown(SocketShutdown.Both);
                    }
                    catch (Exception error) when (error is SocketException or ObjectDisposedException)
                    {
                    }
                    socket.Dispose();
                }
            }
            Runtime.Delete(true);
        }
    }

    private static Px4Tuner Open(FakePx4d px4d, TimeSpan? stallLimit = null) =>
        new(Id, 2, null, px4d.Runtime.FullName, () => null) { StallLimit = stallLimit ?? Px4Stream.DefaultStallLimit };

    /// <summary>TS を1パケットぶん読んで、その印を返す</summary>
    internal static byte ReadMark(Stream output)
    {
        var buffer = new byte[188];
        var read = Task.Run(() =>
        {
            var got = 0;
            while (got < buffer.Length)
            {
                var n = output.Read(buffer, got, buffer.Length - got);
                if (n <= 0) throw new IOException("尽きました");
                got += n;
            }
        });
        if (!read.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("TS が来ません");
        return buffer[1];
    }

    private static readonly ChannelTable.Tuning T27 = ChannelTable.Parse("T27")!;
    private static readonly ChannelTable.Tuning T28 = ChannelTable.Parse("T28")!;

    [Test]
    public async Task 取ったまま2回選局できて_2回目は取り直さない(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        var tuner = Open(px4d);

        tuner.Tune(T27, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T27.Frequency / 1000));
        await Assert.That(tuner.Tuned).IsTrue();

        tuner.Tune(T28, ChannelTable.NoStreamId);
        // 前の局の TS は混ざらない (選局ごとに新しい溜め)
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));

        tuner.Dispose();
        await Assert.That(px4d.Received.ToArray()).IsEquivalentTo(
            new ushort[]
            {
                Px4Control.Hello, Px4Control.Acquire, Px4Control.Tune, Px4Control.StartStream,
                Px4Control.StopStream, Px4Control.Tune, Px4Control.StartStream,
                Px4Control.StopStream, Px4Control.Release,
            },
            TUnit.Assertions.Enums.CollectionOrdering.Matching);
    }

    /// <summary>
    /// **流している間、px4d の数 (STATS) を聞く** (#1210)。途切れたときに、受信機の側で落ちていたのかを
    /// 記録から見分けるため。STATS を持たない px4d (HELLO で認めない) には聞かない
    /// </summary>
    [Test]
    public async Task 流している間はSTATSを聞き_持たないpx4dには聞かない(CancellationToken cancel)
    {
        await Task.Yield();
        using (var px4d = new FakePx4d { Stats = calls => (ulong)calls })
        {
            var tuner = new Px4Tuner(Id, 2, null, px4d.Runtime.FullName, () => null) { StatsEvery = TimeSpan.FromMilliseconds(50) };
            tuner.Tune(T27, ChannelTable.NoStreamId);
            while (px4d.Count(Px4Control.Stats) < 2) await Task.Delay(20, cancel);
            tuner.Dispose();
            var after = px4d.Count(Px4Control.Stats);
            await Task.Delay(200, cancel);
            // 畳んだら聞かない
            await Assert.That(px4d.Count(Px4Control.Stats)).IsEqualTo(after);
        }
        using (var px4d = new FakePx4d())
        {
            var tuner = new Px4Tuner(Id, 2, null, px4d.Runtime.FullName, () => null) { StatsEvery = TimeSpan.FromMilliseconds(50) };
            tuner.Tune(T27, ChannelTable.NoStreamId);
            await Task.Delay(300, cancel);
            tuner.Dispose();
            await Assert.That(px4d.Count(Px4Control.Stats)).IsEqualTo(0);
        }
    }

    [Test]
    public async Task 同期しなければ理由を言い_受信機は取ったまま(CancellationToken cancel)
    {
        await Task.Yield();
        var silent = T28.Frequency / 1000;
        using var px4d = new FakePx4d { TuneError = khz => khz == silent ? 6u : 0u };
        using var tuner = Open(px4d);

        var error = Assert.Throws<IOException>(() => tuner.Tune(T28, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("同期しませんでした");
        await Assert.That(tuner.Tuned).IsFalse();

        tuner.Tune(T27, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T27.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
        await Assert.That(px4d.Count(Px4Control.Release)).IsEqualTo(0);
    }

    [Test]
    public async Task px4dとの接続が切れたら次の選局で取り直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);
        ReadMark(tuner.Output);

        px4d.DropControl();
        // 本物は取ったものを返してストリームも畳む。TS が尽きれば Tuned が落ちる
        await WaitUntil(() => !tuner.Tuned, cancel);

        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Hello)).IsEqualTo(2);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(2);
    }

    [Test]
    public async Task px4dがストリームを止めたら理由を添えて終わり_次は取ったまま選局し直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { EndFirstStream = (5, 15) };
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);

        var output = tuner.Output;
        var error = Assert.Throws<IOException>(() =>
        {
            var buffer = new byte[188 * 64];
            while (output.Read(buffer, 0, buffer.Length) > 0) { }
        });
        await Assert.That(error.Message).Contains("SLOW_CONSUMER");
        await Assert.That(tuner.Tuned).IsFalse();

        // 同じチャンネルでも選局し直す (TunerPool は Tuned を見る)。lease はそのまま
        tuner.Tune(T27, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T27.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    [Test]
    public async Task ATTACHを断られたら黙って取り直さず_次の選局で取り直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { RejectAttach = 2 };
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);

        // 2回目の ATTACH_STREAM を断られる。接続が切れたわけではないので、その場では取り直さない (1度で投げる)
        var error = Assert.Throws<IOException>(() => tuner.Tune(T28, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("TS を受け取れません");
        await Assert.That(px4d.Count(Px4Control.StartStream)).IsEqualTo(2);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
        await Assert.That(tuner.Tuned).IsFalse();

        // px4d の lease は armed のまま残る (本物は TUNE が BUSY になる) ので、返して取り直す
        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Release)).IsEqualTo(1);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(2);
    }

    [Test]
    public async Task 利用者がいなければストリームを閉じ_受信機は取ったまま(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        using var tuner = Open(px4d, TimeSpan.FromMilliseconds(300));
        tuner.Tune(T27, ChannelTable.NoStreamId);

        // 誰も読まない。溜めが埋まって空かなければ stream.sock を閉じる
        await WaitUntil(() => !tuner.Tuned, cancel, TimeSpan.FromSeconds(20));
        await WaitUntil(() => Volatile.Read(ref px4d.StreamsClosed) == 1, cancel);

        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    [Test]
    public async Task 取れなければ理由を言う(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { AcquireError = 4 };
        using var tuner = Open(px4d);

        var error = Assert.Throws<IOException>(() => tuner.Tune(T27, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("受信機 2 を取れません");
        await Assert.That(error.Message).Contains("BUSY");
    }

    [Test]
    public async Task px4dが起きていなければ理由を言う(CancellationToken cancel)
    {
        await Task.Yield();
        using var tuner = new Px4Tuner(Id, 0, null, "/nonexistent", () => null);
        var error = Assert.Throws<IOException>(() => tuner.Tune(T27, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("px4d に繋がりません");
    }

    /// <summary>選局し直すたびに stream.sock を作る。閉じ忘れれば fd が1本ずつ増える</summary>
    [Test]
    [NotInParallel]
    public async Task 何度選局し直してもfdが残らない(CancellationToken cancel)
    {
        await Task.Yield();
        if (!OperatingSystem.IsLinux()) return;
        static int Fds() => Directory.GetFiles("/proc/self/fd").Length;

        using var px4d = new FakePx4d();
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);
        var before = Fds();
        for (var i = 0; i < 30; i++) tuner.Tune(i % 2 == 0 ? T28 : T27, ChannelTable.NoStreamId);
        // 偽の px4d の後始末 (閉じた stream.sock を向こうが閉じる) が追いつくのを少し待つ
        await Task.Delay(300, cancel);
        // 漏れていれば選局1回につき stream.sock で 30 本以上増える。並んで走る他のテストと
        // 偽の px4d の揺れは数本 (CI でちょうど 5 本だったことがある) なので、間を大きく取る
        await Assert.That(Fds() - before).IsLessThan(15);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    private static async Task WaitUntil(Func<bool> condition, CancellationToken cancel, TimeSpan? limit = null)
    {
        var deadline = DateTime.UtcNow + (limit ?? TimeSpan.FromSeconds(10));
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("待ちきれませんでした");
            await Task.Delay(50, cancel);
        }
    }

    [Test]
    public async Task _15V_を出せない受信機には_0V_でリクエストし_画面に理由を出す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        // PX-M1UR のような受信機 (衛星も受けるが 15V は出せない)。設定には 15v と書いてある
        IReadOnlyList<Px4Receiver> receivers = [new(2, true, true, false)];
        var tuner = new Px4Tuner(Id, 2, "15v", px4d.Runtime.FullName, () => receivers);
        var bs = ChannelTable.Parse("BS15_0")!;

        tuner.Tune(bs, ChannelTable.NoStreamId);
        tuner.Tune(bs, ChannelTable.NoStreamId);
        await Assert.That(px4d.Lnbs.ToArray()).IsEquivalentTo(new byte[] { 0, 0 }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
        await Assert.That(Px4Userland.Notice(Px4Userland.Device(Id, 2))).Contains("15V を出せない");

        // 閉じたら消す (設定を変えて開き直したとき、古い注意書きを残さない)
        tuner.Dispose();
        await Assert.That(Px4Userland.Notice(Px4Userland.Device(Id, 2))).IsNull();
    }

    /// <summary>
    /// 読む側がいないとき、溜め (8MB) が埋まってから**決めた時間で**畳む。早すぎもしない
    /// (溜めが埋まるまでは書けているので、畳むのは埋まってから StallLimit 経ったとき)
    /// </summary>
    [Test]
    public async Task 溜めが埋まったら決めた時間で畳む(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { Rate = 0 };
        var limit = TimeSpan.FromSeconds(1);
        using var tuner = Open(px4d, limit);
        var since = Stopwatch.StartNew();
        tuner.Tune(T27, ChannelTable.NoStreamId);

        await WaitUntil(() => !tuner.Tuned, cancel, TimeSpan.FromSeconds(20));
        var took = since.Elapsed;
        // 溜めは 8MB。流せるだけ流すので埋まるのはすぐ。そこから 1 秒 (と定期チェックの 50ms) で畳む
        await Assert.That(took).IsGreaterThanOrEqualTo(limit);
        await Assert.That(took).IsLessThan(limit + TimeSpan.FromSeconds(4));
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    /// <summary>
    /// TS が来なくて待っている読む側も、畳めと言われたら 200ms (起きる間隔) ほどで抜ける
    /// (DeviceStream.Stop の約束。抜けないと、取り上げられたチューナーを読む側が持ったまま次の選局が始まる)
    /// </summary>
    [Test]
    public async Task 待っている読む側は畳めと言われたらすぐ抜ける(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { FramesThenSilence = 1 };
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);
        var output = (DeviceStream)tuner.Output;

        var buffer = new byte[188 * 1024];
        long stoppedAt = 0;
        var reading = Task.Factory.StartNew(() =>
        {
            // 1枚目を読み切ったら、次は来ない TS を待つ
            while (output.Read(buffer, 0, buffer.Length) > 0) { }
            return Stopwatch.GetElapsedTime(Volatile.Read(ref stoppedAt));
        }, cancel, TaskCreationOptions.LongRunning, TaskScheduler.Default);

        await WaitUntil(() => output.Readers == 1, cancel);
        await Task.Delay(300, cancel);
        Volatile.Write(ref stoppedAt, Stopwatch.GetTimestamp());
        output.Stop();
        var left = await reading.WaitAsync(TimeSpan.FromSeconds(5), cancel);
        await Assert.That(left).IsLessThan(TimeSpan.FromMilliseconds(400));
    }

    /// <summary>流している最中に止めても、局替え (TS のストリームを畳んで選局し直す) が待たされない</summary>
    [Test]
    public async Task 流している最中でもすぐ止まる(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { Rate = 0 };
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);
        var output = tuner.Output;

        var running = true;
        var reading = Task.Factory.StartNew(() =>
        {
            var buffer = new byte[188 * 1024];
            try
            {
                while (Volatile.Read(ref running) && output.Read(buffer, 0, buffer.Length) > 0) { }
            }
            catch (IOException)
            {
            }
        }, cancel, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await Task.Delay(500, cancel);

        var since = Stopwatch.StartNew();
        tuner.Tune(T28, ChannelTable.NoStreamId);
        var took = since.Elapsed;
        Volatile.Write(ref running, false);
        await reading.WaitAsync(TimeSpan.FromSeconds(5), cancel);

        // 畳む (pump を降ろす・読む側を待つ) と STOP_STREAM → TUNE → START_STREAM → ATTACH で、ほぼ通信の往復だけ
        await Assert.That(took).IsLessThan(TimeSpan.FromSeconds(1));
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
    }

    /// <summary>
    /// 受信機ごとに接続を持ち、**要求を全部1つのキューで順に片付ける** px4d のふり (#1713)。
    /// 本物の px4d も同じブリッジの受信機の要求は1つずつ処理する (MLT5 系なら受信機 0〜3)。
    /// TUNE は <see cref="TuneTakes"/> かけて「同期しませんでした」(TIMEOUT) で答える
    /// </summary>
    private sealed class QueuedPx4d : IDisposable
    {
        private readonly Socket _control;
        private readonly Lock _queue = new();
        private readonly List<Socket> _open = [];
        private readonly Task _serving;
        private volatile bool _closed;
        private ulong _nextLease = 0x1000;

        public DirectoryInfo Runtime { get; } = Directory.CreateTempSubdirectory("px4");

        public TimeSpan TuneTakes { get; init; }

        public int Acquired;

        public QueuedPx4d()
        {
            var dir = Path.Combine(Runtime.FullName, Px4Wire.Px4.Product, Id);
            Directory.CreateDirectory(dir);
            _control = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            _control.Bind(new UnixDomainSocketEndPoint(Path.Combine(dir, "control.sock")));
            _control.Listen();
            // 待ち方は FakePx4d.Serve と同じ (Accept で待たない)
            _serving = Task.Factory.StartNew(() =>
            {
                while (!_closed)
                {
                    Socket client;
                    try
                    {
                        if (!_control.Poll(TimeSpan.FromMilliseconds(100), SelectMode.SelectRead)) continue;
                        client = _control.Accept();
                    }
                    catch (Exception)
                    {
                        return;
                    }
                    lock (_open) _open.Add(client);
                    Task.Factory.StartNew(() =>
                    {
                        try
                        {
                            while (true)
                            {
                                var (type, _, id, _) = Px4Control.ReadFrame(client, Px4Control.MaxPayload, Px4Wire.Px4);
                                var (flags, answer) = Answer(type);
                                Px4Control.SendAll(client, Px4Control.Encode(type, flags, id, answer, Px4Wire.Px4));
                            }
                        }
                        catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
                        {
                        }
                        finally
                        {
                            client.Dispose();
                        }
                    }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
                }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }

        private (ushort, byte[]) Answer(ushort type)
        {
            const ushort ok = Px4Control.ResponseFlag;
            const ushort failed = Px4Control.ResponseFlag | Px4Control.ErrorFlag;
            lock (_queue)
            {
                switch (type)
                {
                    case Px4Control.Hello:
                    {
                        var hello = new byte[8];
                        BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
                        return (ok, hello);
                    }
                    case Px4Control.Acquire:
                    {
                        Interlocked.Increment(ref Acquired);
                        var answer = new byte[24];
                        BinaryPrimitives.WriteUInt64LittleEndian(answer, ++_nextLease);
                        Nonce.CopyTo(answer, 8);
                        return (ok, answer);
                    }
                    case Px4Control.Tune:
                    {
                        Thread.Sleep(TuneTakes);
                        var error = new byte[6];
                        BinaryPrimitives.WriteUInt32LittleEndian(error, Px4Error.Timeout);
                        return (failed, error);
                    }
                    case Px4Control.Release:
                        return (ok, []);
                    default:
                    {
                        var error = new byte[6];
                        BinaryPrimitives.WriteUInt32LittleEndian(error, Px4Error.InvalidArgument);
                        return (failed, error);
                    }
                }
            }
        }

        public void Dispose()
        {
            _closed = true;
            if (!_serving.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("偽の px4d の受け手が 5 秒で抜けません");
            _control.Dispose();
            lock (_open)
            {
                foreach (var socket in _open)
                {
                    try
                    {
                        socket.Shutdown(SocketShutdown.Both);
                    }
                    catch (Exception error) when (error is SocketException or ObjectDisposedException)
                    {
                    }
                    socket.Dispose();
                }
            }
            Runtime.Delete(true);
        }
    }

    /// <summary>
    /// **同じ筐体の受信機を同時に選局しても、px4d の順番待ちで時間切れにしない** (#1713)。
    ///
    /// <para>
    /// 複数のチューナーでスキャンすると、4つの TUNE が px4d のキューに並ぶ。同期しないチャンネルは
    /// 1つ 5 秒かかるので、後ろのほうは答えが来るまでに待つ上限 (7 秒) を過ぎていた。
    /// 時間切れを「接続が切れた」と取って受信機を返し、取り直しは BUSY で断られ、
    /// そのチャンネルがスキャンの結果から落ちていた
    /// </para>
    /// </summary>
    [Test]
    public async Task 同じ筐体の受信機を同時に選局しても時間切れにならない(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new QueuedPx4d { TuneTakes = TimeSpan.FromSeconds(2.5) };
        var tuners = Enumerable.Range(0, 4)
            .Select(receiver => new Px4Tuner(Id, receiver, null, px4d.Runtime.FullName, () => null))
            .ToList();
        try
        {
            var bs = ChannelTable.Parse("BS15_0")!;
            var tuning = tuners.Select(tuner => Task.Factory.StartNew(() =>
            {
                try
                {
                    tuner.Tune(bs, ChannelTable.NoStreamId);
                    return "";
                }
                catch (IOException error)
                {
                    return error.Message;
                }
            }, cancel, TaskCreationOptions.LongRunning, TaskScheduler.Default)).ToArray();
            var messages = await Task.WhenAll(tuning).WaitAsync(TimeSpan.FromSeconds(40), cancel);

            // どれも「同期しませんでした」で終わる。時間切れ (TimedOut) や取り直し (BUSY) にならない
            await Assert.That(messages).IsEquivalentTo(Enumerable.Repeat(ITuneDevice.SyncFailed, 4).ToArray());
            await Assert.That(px4d.Acquired).IsEqualTo(4);
        }
        finally
        {
            foreach (var tuner in tuners) tuner.Dispose();
        }
    }
}
