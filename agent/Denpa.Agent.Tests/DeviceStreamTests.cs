using System.Diagnostics;
using System.IO.Pipelines;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Denpa.Agent;
using Microsoft.Win32.SafeHandles;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * デバイスの読み出し側。
 *
 * ここは**電波が来ていないときの振る舞い**が問題になる。デバイスは選局を
 * 跨いで開いたままなので、読む側から抜けられないと、チューナーを取り上げられた読む側が
 * 残ったまま次の選局が始まる。実機では、そのせいで**同じ復号の実体を2本の
 * ストリームから呼び**、プロセスごと落ちた (`double free or corruption`)。
 *
 * 本物のチューナーは要らない。何も来ないパイプで「来ないときにどうするか」は
 * そのまま試せる。
 */
// libc の pipe で作る読み出し側 (poll で待つ方式)。Windows の方式は下の DeviceStreamPipeTests
[ExcludeOn(OS.Windows)]
public partial class DeviceStreamTests
{
    [LibraryImport("libc", EntryPoint = "pipe", SetLastError = true)]
    private static partial int Pipe(Span<int> fds);

    /// <summary>何も書き込まれないパイプ。**永久に来ない読み出し側**の代わり</summary>
    private static (DeviceStream Stream, SafeFileHandle Write) Silent()
    {
        Span<int> fds = stackalloc int[2];
        // Assert は await が要るので、stackalloc を跨げないここでは素直に投げる
        if (Pipe(fds) != 0) throw new InvalidOperationException("pipe() に失敗");
        return (new DeviceStream(new SafeFileHandle(fds[0], ownsHandle: true)),
            new SafeFileHandle(fds[1], ownsHandle: true));
    }

    [Test]
    public async Task 降りると言えば_何も来なくても戻る()
    {
        var (stream, write) = Silent();
        using (stream)
        using (write)
        {
            var buffer = new byte[188];
            var clock = Stopwatch.StartNew();
            // 0.2秒ごとに起きて印を見る。1周ぶんで戻れば十分
            var read = stream.Read(buffer, 0, buffer.Length, () => true);
            clock.Stop();

            await Assert.That(read).IsEqualTo(0);
            await Assert.That(clock.ElapsedMilliseconds < 1000).IsTrue().Because($"{clock.ElapsedMilliseconds}ms 掛かった");
        }
    }

    /*
     * **止めたあとは、読みかけが戻るまでだけ待つ** (`WaitReaders`)。局替えのたびに
     * 固定で 300ms 寝ていたのを、読む側がいなければ待たないようにした
     */
    [Test]
    public async Task 読んでいる処理がなければ待たず_あれば戻るまで待つ()
    {
        var (stream, write) = Silent();
        using (stream)
        using (write)
        {
            stream.Stop();
            var idle = Stopwatch.StartNew();
            stream.WaitReaders(TimeSpan.FromSeconds(2));
            await Assert.That(idle.ElapsedMilliseconds < 50).IsTrue().Because($"{idle.ElapsedMilliseconds}ms 待った");
        }

        (stream, write) = Silent();
        using (stream)
        using (write)
        {
            var buffer = new byte[188];
            var reading = Task.Factory.StartNew(
                () => stream.Read(buffer, 0, buffer.Length, () => false),
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            /*
             * **読む側が中に入ったのを見てから止める。** 決め打ちで 100ms 寝ていた頃は、混んだ Mac の
             * ランナーでまだ入っていないうちに止めてしまい、待つ相手のいない WaitReaders が
             * すぐ戻って落ちた (CI)
             */
            var entering = Stopwatch.StartNew();
            while (stream.Readers == 0 && entering.Elapsed < TimeSpan.FromSeconds(2)) await Task.Delay(5);
            await Assert.That(stream.Readers).IsEqualTo(1);
            stream.Stop();
            stream.WaitReaders(TimeSpan.FromSeconds(2));
            // poll は 0.2 秒ごとに起きるので、待ち終えた時点で読む側は戻っている。
            // タスクが「終わった」になるのはその少し後なので、見るのは中にいる数
            await Assert.That(stream.Readers).IsEqualTo(0);
            await Assert.That(await reading.WaitAsync(TimeSpan.FromSeconds(1))).IsEqualTo(0);
        }
    }

    /*
     * **降りると言うまでは戻らない。**
     *
     * 何も来ないからといって勝手に終わると、電波が一瞬途切れただけで録画が
     * 落ちることになる。実際に来ていないだけなら待ち続けるのが正しい
     */
    [Test]
    public async Task 降りると言わなければ_来るまで待つ()
    {
        var (stream, write) = Silent();
        using (stream)
        using (write)
        {
            var buffer = new byte[188];
            /*
             * **専用のスレッドで読む。** 共用のスレッドプールから借りると、他のテストがプールを塞いでいる間は
             * 読み始めることすらできず、書いてから 2 秒待っても返らない (CI で1度落ちた。
             * 手元では2コアに絞っても出ない揺れ)。Px4CardTests の偽の px4d と同じ理由
             */
            var reading = Task.Factory.StartNew(
                () => stream.Read(buffer, 0, buffer.Length, () => false),
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

            var waited = await Task.WhenAny(reading, Task.Delay(TimeSpan.FromMilliseconds(600), TestContext.Current!.Execution.CancellationToken));
            await Assert.That(waited).IsNotSameReferenceAs(reading);

            // 書けば返ってくる
            var payload = new byte[] { 0x47, 0x01, 0x02 };
            await Assert.That(Write(write, payload)).IsEqualTo(payload.Length);
            await Assert.That(await reading.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current!.Execution.CancellationToken)).IsEqualTo(payload.Length);
        }
    }

    private static unsafe int Write(SafeFileHandle handle, byte[] data)
    {
        fixed (byte* source = data)
        {
            return (int)WriteFd((int)handle.DangerousGetHandle(), source, (nuint)data.Length);
        }
    }

    [LibraryImport("libc", EntryPoint = "write", SetLastError = true)]
    private static unsafe partial nint WriteFd(int fd, byte* buffer, nuint count);
}
/*
 * Windows の読み出し側 (.NET の Stream を裏のスレッドに読ませる方式)。どの OS でも同じに動くので、
 * Linux の CI でもここで見る。何も来ない pipe は .NET の匿名 pipe で作る
 */
public class DeviceStreamPipeTests
{
    /// <summary>読み出し側と書き込み側。読み出し側が Windows で子の標準出力にあたる</summary>
    private static (DeviceStream Stream, Stream Write) Silent(Func<string?>? ended = null)
    {
        var read = new AnonymousPipeServerStream(PipeDirection.In);
        var write = new AnonymousPipeClientStream(PipeDirection.Out, read.ClientSafePipeHandle);
        return (new DeviceStream(read, ended), write);
    }

    [Test]
    public async Task 降りると言えば_何も来なくても戻り_あとから来たものは次に読む処理に渡る()
    {
        var (stream, write) = Silent();
        using var _ = write;
        var buffer = new byte[188];

        var clock = Stopwatch.StartNew();
        await Assert.That(stream.Read(buffer, 0, buffer.Length, () => clock.ElapsedMilliseconds > 300)).IsEqualTo(0);
        await Assert.That(clock.ElapsedMilliseconds < 1000).IsTrue().Because($"{clock.ElapsedMilliseconds}ms 掛かった");

        // 抜けた側の読みかけに届いたものも、次に読む側が受け取る (捨てない)
        write.Write([0x47, 0x01, 0x02]);
        write.Flush();
        await Assert.That(stream.Read(buffer, 0, 2, () => false)).IsEqualTo(2);
        await Assert.That(stream.Read(buffer, 2, 10, () => false)).IsEqualTo(1);
        await Assert.That(buffer[..3]).IsEquivalentTo([(byte)0x47, (byte)0x01, (byte)0x02]);
    }

    [Test]
    public async Task 尽きたら理由を添えて投げる()
    {
        var (stream, write) = Silent(() => "siano-ts が終了しました");
        using var _ = stream;
        // 書き手 (子) がいなくなった
        write.Dispose();
        var error = Assert.Throws<IOException>(() => stream.Read(new byte[188], 0, 188, () => false));
        await Assert.That(error.Message).Contains("終了しました");
    }
}
/*
 * px4d から受けた TS (PipeReader) の読み出し側。待っている読みが済むと PipeReader が合図を呼ぶが、
 * **合図は済んだ印より少し遅れて届く** (書く側は印を立ててから、ロックの外で合図を呼ぶ)。
 * 読む側は印を見て先に読み進めるので、前の読みの合図が次の読みを待っている最中に届くことがある
 */
public class DeviceStreamPipedTests
{
    /// <summary>合図を言われるまで溜めておく。止めると、来た合図はその場で呼ぶ</summary>
    private sealed class HeldScheduler : PipeScheduler
    {
        private readonly Lock _gate = new();
        private readonly List<(Action<object?> Action, object? State)> _held = [];
        private bool _holding = true;

        public int Held
        {
            get { lock (_gate) return _held.Count; }
        }

        public override void Schedule(Action<object?> action, object? state)
        {
            lock (_gate)
            {
                if (_holding)
                {
                    _held.Add((action, state));
                    return;
                }
            }
            action(state);
        }

        public void Release()
        {
            List<(Action<object?> Action, object? State)> held;
            lock (_gate)
            {
                _holding = false;
                held = [.. _held];
                _held.Clear();
            }
            foreach (var (action, state) in held) action(state);
        }
    }

    [Test]
    public async Task 前の読みの合図が遅れて届いても_次の読みを取り違えない(CancellationToken cancel)
    {
        var scheduler = new HeldScheduler();
        var pipe = new Pipe(new System.IO.Pipelines.PipeOptions(readerScheduler: scheduler, writerScheduler: PipeScheduler.Inline, useSynchronizationContext: false));
        using var stream = new DeviceStream(pipe.Reader);
        var buffer = new byte[188];

        // 1回目: 待っている間に届く。合図は溜めたままなので、読む側は 200ms ごとに起きて印を見て読む
        var first = Task.Run(() => stream.Read(buffer, 0, buffer.Length), cancel);
        while (stream.Readers == 0) await Task.Delay(5, cancel);
        await Task.Delay(50, cancel);
        await pipe.Writer.WriteAsync(new byte[] { 0x47, 0x01 }, cancel);
        await Assert.That(await first.WaitAsync(TimeSpan.FromSeconds(5), cancel)).IsEqualTo(2);
        await Assert.That(scheduler.Held).IsEqualTo(1);

        // 2回目の読みが待ちに入ってから、1回目の合図を届ける
        var second = Task.Run(() => stream.Read(buffer, 0, buffer.Length), cancel);
        while (stream.Readers == 0) await Task.Delay(5, cancel);
        await Task.Delay(100, cancel);
        scheduler.Release();
        await Task.Delay(100, cancel);
        await Assert.That(second.IsCompleted).IsFalse().Because(second.Exception?.InnerException?.Message ?? "読めるものは無いはず");

        await pipe.Writer.WriteAsync(new byte[] { 0x47, 0x02, 0x03 }, cancel);
        await Assert.That(await second.WaitAsync(TimeSpan.FromSeconds(5), cancel)).IsEqualTo(3);
        await Assert.That(buffer[..3]).IsEquivalentTo([(byte)0x47, (byte)0x02, (byte)0x03]);
    }

    /*
     * **止めたら、待っている読む側はすぐ起きる** (次に起きる 200ms を待たない)。200ms ごとに起きて
     * 印を見るだけだと、止めてから戻るまでに最大 200ms 掛かり、混んだ CI では 500ms を超えていた
     * (Px4TunerTests の「待っている読む側は畳めと言われたらすぐ抜ける」が落ちた)
     */
    [Test]
    public async Task 止めたら_待っている読む側はすぐ起きる(CancellationToken cancel)
    {
        var pipe = new Pipe(new System.IO.Pipelines.PipeOptions(readerScheduler: PipeScheduler.Inline, writerScheduler: PipeScheduler.Inline, useSynchronizationContext: false));
        using var stream = new DeviceStream(pipe.Reader);
        long stoppedAt = 0;
        var reading = Task.Factory.StartNew(() =>
        {
            var read = stream.Read(new byte[188], 0, 188);
            return (read, Stopwatch.GetElapsedTime(Volatile.Read(ref stoppedAt)));
        }, cancel, TaskCreationOptions.LongRunning, TaskScheduler.Default);

        while (stream.Readers == 0) await Task.Delay(5, cancel);
        // 待ちに入ってすぐ止める (200ms ごとに起きるだけなら、次に起きるまで 180ms ほど掛かる)
        await Task.Delay(20, cancel);
        Volatile.Write(ref stoppedAt, Stopwatch.GetTimestamp());
        stream.Stop();
        var (read, left) = await reading.WaitAsync(TimeSpan.FromSeconds(5), cancel);

        await Assert.That(read).IsEqualTo(0);
        await Assert.That(left).IsLessThan(TimeSpan.FromMilliseconds(100));
    }
}
