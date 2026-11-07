using System.Diagnostics;
using System.IO.Pipelines;

namespace Denpa.Agent.Tests;

/*
 * 実機で確かめる小道具 (--tune・--dt295-probe) のうち、偽物で確かめられるところ。
 *
 * **固まったら失敗にする** (Px4TunerTests と同じ)。各テストは最初に `await Task.Yield()` する
 */
[Timeout(30_000)]
public class ProbeTests
{
    /*
     * `--tune` は TS が来なくても `--seconds` で戻る。読み出し側 (DeviceStream) は TS が来ない間は戻らないので、
     * 決めた時間で降りる合図を渡している (Probe.Measure)
     */
    [Test]
    public async Task tune_は_TS_が来なくても決めた時間で戻る()
    {
        await Task.Yield();
        // 何も書き込まない Pipe。電波が来ていないチューナーの代わり
        var pipe = new Pipe();
        using var stream = new DeviceStream(pipe.Reader);
        var clock = Stopwatch.StartNew();
        var decodedMs = Probe.Measure(stream, "T27", null, TimeSpan.FromSeconds(1));
        clock.Stop();

        await Assert.That(decodedMs).IsNull();
        // 読み出し側は 200ms ごとに起きて合図を見る
        await Assert.That(clock.ElapsedMilliseconds >= 1000 && clock.ElapsedMilliseconds < 2000).IsTrue()
            .Because($"{clock.ElapsedMilliseconds}ms 掛かった");
    }

    /*
     * `--dt295-probe --trace` は、機材への読み書きを 1 行ずつ渡す (Dt295NativeDevice.Acquire の trace)。
     * 開くときの読み書き (窓の切り替え・レジスタの読み書き) が届けばよい
     */
    [Test]
    public async Task dt295_probe_の_trace_は機材を開くときの読み書きを1行ずつ渡す()
    {
        await Task.Yield();
        var fake = new Dt295Fake();
        var port = $"test-{Guid.NewGuid():N}";
        var lines = new List<string>();
        var device = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000, trace: lines.Add);
        try
        {
            await Assert.That(device.Faulted).IsFalse();
        }
        finally
        {
            device.Release();
            Dt295NativeDevice.CloseIfIdle(port);
        }

        await Assert.That(lines.Any(line => line.StartsWith("窓 0x", StringComparison.Ordinal))).IsTrue();
        await Assert.That(lines.Any(line => line.StartsWith("読む 0x", StringComparison.Ordinal))).IsTrue();
        await Assert.That(lines.Any(line => line.StartsWith("書く 0x", StringComparison.Ordinal))).IsTrue();
        await Assert.That(Dt295NativeProbe.Parse(["--channel", "T27", "--trace"])?.Trace).IsTrue();
        await Assert.That(Dt295NativeProbe.Parse(["--channel", "T27"])?.Trace).IsFalse();
    }
}
