using System.Diagnostics;

namespace Denpa.Agent.Tests;

/*
 * 常駐から TS を受けて読む側に渡すところ (UserlandStream) の重さを測る。
 *
 * 偽の常駐 (UserlandTunerTests.FakeDaemon) を 8 台立て、それぞれ 5MB/秒 (合計 40MB/秒。地上波 1 本が 2.3MB/秒ほど
 * なので、8 本ぶんを超える) で流し、読む側が読み続ける間の CPU 時間と確保量を出す。
 * 偽の常駐も同じプロセスにいるので、数字はその分も含む (比べるときは同じテストを書き換えの前後で流す)。
 * 合否は「流したぶんが読む側に届いたか」だけで、数字は記録に出す。
 */
// **名指ししたときだけ流す** (Explicit)。並べずに 1 本で流れるので、毎回の単体テストが 5 秒以上延びていた。測るときは
// dotnet test --project agent/Denpa.Agent.Tests/Denpa.Agent.Tests.csproj --output detailed --treenode-filter '/*/*/UserlandStreamBenchTests/*'
[Explicit]
[NotInParallel]
[Timeout(120_000)]
public class UserlandStreamBenchTests
{
    private const int Streams = 8;
    private const double Rate = 5 * 1024 * 1024;
    private static readonly TimeSpan Warmup = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan Span = TimeSpan.FromSeconds(5);

    [Test]
    public async Task 合計_40MB_毎秒を流したときの_CPU_と確保量(CancellationToken cancel)
    {
        await Task.Yield();
        var fakes = new List<UserlandTunerTests.FakeDaemon>();
        var tuners = new List<UserlandTuner>();
        var counts = new long[Streams];
        var running = true;
        var readers = new List<Thread>();
        try
        {
            for (var i = 0; i < Streams; i++)
            {
                var daemon = new UserlandTunerTests.FakeDaemon { Rate = Rate };
                fakes.Add(daemon);
                var tuner = new UserlandTuner("1-2", 2, null, daemon.Runtime.FullName, () => null);
                tuners.Add(tuner);
                tuner.Tune(ChannelTable.Parse("T27")!);
                var output = tuner.Output;
                var index = i;
                var reader = new Thread(() =>
                {
                    var buffer = new byte[188 * 1024];
                    try
                    {
                        while (Volatile.Read(ref running))
                        {
                            var read = output.Read(buffer, 0, buffer.Length);
                            if (read <= 0) break;
                            Interlocked.Add(ref counts[index], read);
                        }
                    }
                    catch (IOException)
                    {
                    }
                }) { IsBackground = true };
                reader.Start();
                readers.Add(reader);
            }

            await Task.Delay(Warmup, cancel);
            var process = Process.GetCurrentProcess();
            process.Refresh();
            var cpu = process.TotalProcessorTime;
            var allocated = GC.GetTotalAllocatedBytes(precise: true);
            var gen0 = GC.CollectionCount(0);
            var before = counts.Select(count => Interlocked.Read(ref count)).Sum();
            var clock = Stopwatch.StartNew();

            await Task.Delay(Span, cancel);

            var elapsed = clock.Elapsed;
            process.Refresh();
            var usedCpu = process.TotalProcessorTime - cpu;
            var usedBytes = GC.GetTotalAllocatedBytes(precise: true) - allocated;
            var collections = GC.CollectionCount(0) - gen0;
            var moved = counts.Select(count => Interlocked.Read(ref count)).Sum() - before;
            var mbps = moved / elapsed.TotalSeconds / 1024 / 1024;

            var line =
                $"[bench] UserlandStream {Streams} 本 × {Rate / 1024 / 1024:F0}MB/秒 を {elapsed.TotalSeconds:F1} 秒: "
                + $"届いた {mbps:F1}MB/秒、CPU {usedCpu.TotalMilliseconds / elapsed.TotalSeconds / 10:F1}% (1 コアに対して)、"
                + $"確保 {usedBytes / elapsed.TotalSeconds / 1024:F0}KB/秒、gen0 GC {collections} 回 ({System.Runtime.InteropServices.RuntimeInformation.OSDescription})";
            Console.WriteLine(line);
            // CI では実行の概要 (Summary) にも出す。通ったテストの出力はログに出ないので
            if (Environment.GetEnvironmentVariable("GITHUB_STEP_SUMMARY") is { Length: > 0 } summary)
            {
                await File.AppendAllTextAsync(summary, line + "\n", cancel);
            }

            // 流したぶん (の 7 割) が届いていること。偽物の速さの揺れを見込む
            await Assert.That(mbps).IsGreaterThan(Streams * Rate / 1024 / 1024 * 0.7);
        }
        finally
        {
            Volatile.Write(ref running, false);
            foreach (var tuner in tuners) tuner.Dispose();
            foreach (var reader in readers) reader.Join(TimeSpan.FromSeconds(5));
            foreach (var daemon in fakes) daemon.Dispose();
        }
    }
}
