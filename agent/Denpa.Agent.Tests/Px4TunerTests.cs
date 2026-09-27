using System.Buffers.Binary;
using System.Net.Sockets;
using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * px4d の制御ソケットで受信機を借りたまま選局し直すところ (Px4Tuner。Px4.cs)。
 *
 * px4d は無い。control.sock と stream.sock を開いて px4d のふりをする (Px4CardTests と同じ流儀)。
 * ふりは SPEC 6.3 の決まりだけ守る: 借りた lease で TUNE → START_STREAM → stream.sock に
 * ATTACH_STREAM (lease と nonce) で TS_DATA が流れ、STOP_STREAM で STREAM_END。
 * TS の中身は周波数の印 (パケットの2バイト目) にして、どの選局の TS かを見分ける。
 */
[ExcludeOn(OS.Windows)]
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
    private static byte Mark(ulong khz) => (byte)(khz % 251);

    private sealed class FakePx4d : IDisposable
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

        /// <summary>stream.sock を相手が閉じた回数</summary>
        public int StreamsClosed;

        /// <summary>TUNE に番号で断る (0 なら通す)。引数は kHz</summary>
        public Func<ulong, uint> TuneError { get; init; } = _ => 0;

        /// <summary>ACQUIRE に番号で断る (0 なら通す)</summary>
        public uint AcquireError { get; init; }

        /// <summary>この番目 (1 から) の ATTACH_STREAM を NOT_FOUND で断る</summary>
        public int RejectAttach { get; init; }

        /// <summary>最初の流れだけ、これだけ流したら STREAM_END (この番号) で止める</summary>
        public (int Frames, uint Code)? EndFirstStream { get; init; }

        public FakePx4d()
        {
            var dir = Path.Combine(Runtime.FullName, "px4-userland", Id);
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
        /// 繋いできたものを1本ずつ専用のスレッドで (Px4CardTests と同じ理由で池を使わない)。
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
                    var (type, _, id, payload) = Px4Control.ReadFrame(client, Px4Control.MaxPayload);
                    lock (Received) Received.Add(type);
                    var (flags, answer) = Answer(type, payload);
                    Px4Control.SendAll(client, Px4Control.Encode(type, flags, id, answer));
                }
            }
            finally
            {
                // 本物は接続が閉じると借りたものを返し、流れも畳む
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
            var (type, _, id, payload) = Px4Control.ReadFrame(client, Px4Control.MaxPayload);
            int attachment;
            ulong khz;
            lock (_gate)
            {
                var good = ++_attachTries != RejectAttach && type == Px4Control.AttachStream && payload.Length == 24 && _armed
                    && BinaryPrimitives.ReadUInt64LittleEndian(payload) == _lease && payload.AsSpan(8).SequenceEqual(Nonce);
                if (!good)
                {
                    Px4Control.SendAll(client, Px4Control.Encode(Px4Control.AttachStream, 3, id, Error(3)));
                    return;
                }
                _armed = false;
                _active = true;
                attachment = ++_attachments;
                khz = _khz;
            }
            Px4Control.SendAll(client, Px4Control.Encode(Px4Control.AttachStream, Px4Control.ResponseFlag, id, []));

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
                for (ulong sequence = 0; ; sequence++)
                {
                    bool active;
                    lock (_gate) active = _active && _attachments == attachment;
                    var ending = attachment == 1 && EndFirstStream is { } end && (int)sequence == end.Frames;
                    if (!active || ending)
                    {
                        var body = new byte[68];
                        if (ending) BinaryPrimitives.WriteUInt32LittleEndian(body.AsSpan(64), EndFirstStream!.Value.Code);
                        lock (_gate) if (ending) _active = false;
                        Px4Control.SendAll(client, Px4Control.Encode(Px4Control.StreamEnd, 0, 0, body));
                        // 本物と同じく、閉じるのは相手
                        while (client.Receive(new byte[16]) > 0) { }
                        return;
                    }
                    BinaryPrimitives.WriteUInt64LittleEndian(frame, sequence);
                    Px4Control.SendAll(client, Px4Control.Encode(Px4Control.TsData, 0, 0, frame));
                    Thread.Sleep(2);
                }
            }
            finally
            {
                // 本物は閉じた stream.sock の流れを取り消す (lease は借りたまま)
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
            lock (_gate) _controlClient?.Shutdown(SocketShutdown.Both);
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
    private static byte ReadMark(Stream output)
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
    public async Task 借りたまま2回選局できて_2回目は借り直さない(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        var tuner = Open(px4d);

        tuner.Tune(T27, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T27.Frequency / 1000));
        await Assert.That(tuner.Tuned).IsTrue();

        tuner.Tune(T28, ChannelTable.NoStreamId);
        // 前の局の TS は混ざらない (選局ごとに新しい pipe)
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

    [Test]
    public async Task 同期しなければ理由を言い_受信機は借りたまま(CancellationToken cancel)
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
    public async Task px4dとの接続が切れたら次の選局で借り直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);
        ReadMark(tuner.Output);

        px4d.DropControl();
        // 本物は借りたものを返して流れも畳む。TS が尽きれば Tuned が落ちる
        await WaitUntil(() => !tuner.Tuned, cancel);

        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Hello)).IsEqualTo(2);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(2);
    }

    [Test]
    public async Task px4dが流れを止めたら理由を添えて尽き_次は借りたまま選局し直す(CancellationToken cancel)
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
    public async Task ATTACHを断られたら黙って借り直さず_次の選局で借り直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { RejectAttach = 2 };
        using var tuner = Open(px4d);
        tuner.Tune(T27, ChannelTable.NoStreamId);

        // 2回目の ATTACH_STREAM を断られる。接続が切れたわけではないので、その場では借り直さない (1度で投げる)
        var error = Assert.Throws<IOException>(() => tuner.Tune(T28, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("TS を受け取れません");
        await Assert.That(px4d.Count(Px4Control.StartStream)).IsEqualTo(2);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
        await Assert.That(tuner.Tuned).IsFalse();

        // px4d の lease は armed のまま残る (本物は TUNE が BUSY になる) ので、返して借り直す
        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Release)).IsEqualTo(1);
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(2);
    }

    [Test]
    public async Task 読み手が居なければ流れを畳み_受信機は借りたまま(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d();
        using var tuner = Open(px4d, TimeSpan.FromMilliseconds(300));
        tuner.Tune(T27, ChannelTable.NoStreamId);

        // 誰も読まない。pipe が埋まって空かなければ stream.sock を閉じる
        await WaitUntil(() => !tuner.Tuned, cancel, TimeSpan.FromSeconds(20));
        await WaitUntil(() => Volatile.Read(ref px4d.StreamsClosed) == 1, cancel);

        tuner.Tune(T28, ChannelTable.NoStreamId);
        await Assert.That(ReadMark(tuner.Output)).IsEqualTo(Mark(T28.Frequency / 1000));
        await Assert.That(px4d.Count(Px4Control.Acquire)).IsEqualTo(1);
    }

    [Test]
    public async Task 借りられなければ理由を言う(CancellationToken cancel)
    {
        await Task.Yield();
        using var px4d = new FakePx4d { AcquireError = 4 };
        using var tuner = Open(px4d);

        var error = Assert.Throws<IOException>(() => tuner.Tune(T27, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("受信機 2 を借りられません");
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

    /// <summary>選局し直すたびに pipe と stream.sock を作る。閉じ忘れれば fd が1本ずつ増える</summary>
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
        // 漏れていれば選局1回につき pipe と stream.sock で 30 本以上増える。並んで走る他のテストと
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
}
