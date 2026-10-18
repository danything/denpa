using System.Diagnostics;
using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * px4d から TS を受けて読む側に渡すところ (Px4Stream) の重さを測る。
 *
 * 偽の px4d (Px4TunerTests.FakePx4d) を 8 台立て、それぞれ 5MB/秒 (合計 40MB/秒。地上波 1 本が 2.3MB/秒ほど
 * なので、8 本ぶんを超える) で流し、読む側が読み続ける間の CPU 時間と確保量を出す。
 * 偽の px4d も同じプロセスにいるので、数字はその分も含む (比べるときは同じテストを書き換えの前後で流す)。
 * 合否は「流したぶんが読む側に届いたか」だけで、数字は記録に出す (CI の Unit tests の出力で見る)
 */
// 測るだけなので Windows の CI では流さない (並べずに1本で流れて、そのぶん全体が延びる)。数字は Linux と Mac で出る
[ExcludeOn(OS.Windows)]
[NotInParallel]
[Timeout(120_000)]
public class Px4StreamBenchTests
{
    private const int Streams = 8;
    private const double Rate = 5 * 1024 * 1024;
    private static readonly TimeSpan Warmup = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan Span = TimeSpan.FromSeconds(5);

    [Test]
    public async Task 合計40MB毎秒を流したときのCPUと確保量(CancellationToken cancel)
    {
        await Task.Yield();
        var fakes = new List<Px4TunerTests.FakePx4d>();
        var tuners = new List<Px4Tuner>();
        var counts = new long[Streams];
        var running = true;
        var readers = new List<Thread>();
        try
        {
            for (var i = 0; i < Streams; i++)
            {
                var px4d = new Px4TunerTests.FakePx4d { Rate = Rate };
                fakes.Add(px4d);
                var tuner = new Px4Tuner("00001205000960", 2, null, px4d.Runtime.FullName, () => null);
                tuners.Add(tuner);
                tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
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
                $"[bench] Px4Stream {Streams} 本 × {Rate / 1024 / 1024:F0}MB/秒 を {elapsed.TotalSeconds:F1} 秒: "
                + $"届いた {mbps:F1}MB/秒、CPU {usedCpu.TotalMilliseconds / elapsed.TotalSeconds / 10:F1}% (1 コアに対して)、"
                + $"確保 {usedBytes / elapsed.TotalSeconds / 1024:F0}KB/秒、gen0 GC {collections} 回 ({System.Runtime.InteropServices.RuntimeInformation.OSDescription})";
            Console.WriteLine(line);
            // CI では実行の概要 (Summary) にも出す。通ったテストの出力はログに出ないので
            if (Environment.GetEnvironmentVariable("GITHUB_STEP_SUMMARY") is { Length: > 0 } summary)
            {
                await File.AppendAllTextAsync(summary, line + "\n", cancel);
            }

            // 流したぶん (の 7 割) が届いていること。偽物の速さの揺れ (寝る間隔の粗い Windows) を見込む
            await Assert.That(mbps).IsGreaterThan(Streams * Rate / 1024 / 1024 * 0.7);
        }
        finally
        {
            Volatile.Write(ref running, false);
            foreach (var tuner in tuners) tuner.Dispose();
            foreach (var reader in readers) reader.Join(TimeSpan.FromSeconds(5));
            foreach (var px4d in fakes) px4d.Dispose();
        }
    }
}
