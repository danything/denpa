using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Denpa.Agent;
using Microsoft.Win32.SafeHandles;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * デバイスの読み口。
 *
 * ここは**電波が来ていないときの振る舞い**が問題になる。デバイスは選局を
 * 跨いで開いたままなので、読み手のほうから降りられないと、蹴られた読み手が
 * 居座ったまま次の選局が始まる。実機では、そのせいで**同じ復号器を2本の
 * 流れから叩き**、プロセスごと落ちた (`double free or corruption`)。
 *
 * 本物のチューナーは要らない。何も来ないパイプで「来ないときにどうするか」は
 * そのまま試せる。
 */
// libc の pipe で作る読み口 (poll で待つ道)。Windows の道は下の DeviceStreamPipeTests
[ExcludeOn(OS.Windows)]
public partial class DeviceStreamTests
{
    [LibraryImport("libc", EntryPoint = "pipe", SetLastError = true)]
    private static partial int Pipe(Span<int> fds);

    /// <summary>何も書き込まれないパイプ。**永久に来ない読み口**の代わり</summary>
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
             * **専用のスレッドで読む。** 共用の池から借りると、他のテストが池を塞いでいる間は
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
 * Windows の読み口 (.NET の Stream を裏の1本に読ませる道)。どの OS でも同じに動くので、
 * Linux の CI でもここで見る。何も来ない pipe は .NET の匿名 pipe で作る
 */
public class DeviceStreamPipeTests
{
    /// <summary>読み口と書き口。読み口の側が Windows で子の標準出力にあたる</summary>
    private static (DeviceStream Stream, Stream Write) Silent(Func<string?>? ended = null)
    {
        var read = new AnonymousPipeServerStream(PipeDirection.In);
        var write = new AnonymousPipeClientStream(PipeDirection.Out, read.ClientSafePipeHandle);
        return (new DeviceStream(read, ended), write);
    }

    [Test]
    public async Task 降りると言えば_何も来なくても戻り_あとから来たものは次の読み手に渡る()
    {
        var (stream, write) = Silent();
        using var _ = write;
        var buffer = new byte[188];

        var clock = Stopwatch.StartNew();
        await Assert.That(stream.Read(buffer, 0, buffer.Length, () => clock.ElapsedMilliseconds > 300)).IsEqualTo(0);
        await Assert.That(clock.ElapsedMilliseconds < 1000).IsTrue().Because($"{clock.ElapsedMilliseconds}ms 掛かった");

        // 降りた読み手の読みかけに届いたものも、次の読み手が受け取る (捨てない)
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
        // 書き手 (子) が居なくなった
        write.Dispose();
        var error = Assert.Throws<IOException>(() => stream.Read(new byte[188], 0, 188, () => false));
        await Assert.That(error.Message).Contains("終了しました");
    }
}
