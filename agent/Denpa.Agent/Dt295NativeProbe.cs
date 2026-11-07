using System.Diagnostics;
using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 を確かめる入口。**サーバを立てず、機材を 1 回だけ動かして統計を出す。**
///
/// <code>
/// denpa-agent --dt295-probe --channel T25 --seconds 5
/// denpa-agent --dt295-probe --port 1-2 --channel BS15 --replug --output /tmp/bs15.ts
/// </code>
///
/// <para>
/// エージェントの <c>dt295:</c> と同じ経路 (<see cref="Dt295NativeTuner"/>) で選局し、決めた秒数だけ受けて、設定・選局・最初の TS までの時間と
/// 制御転送の数・CPU 時間・TS の統計を出す。<c>--replug</c> は先にポートの電源を入れ直す (Linux)。<c>--output</c> を付けたときだけ TS をファイルに書く。
/// カードは <c>denpa-agent --card dt295:&lt;USB のポート&gt;</c> で確かめる。終了コードは、うまくいけば 0、どこかで止まれば 1
/// </para>
/// </summary>
public static class Dt295NativeProbe
{
    public const string Usage = "denpa-agent --dt295-probe [--port <USB のポート>] --channel <T13-T62 | BS1-BS23[:TSID] | CS2-CS24> [--seconds N] [--replug] [--output <TS のファイル>] [--demod-dump] [--trace]";

    internal sealed record Options(string? Port, string Channel, ChannelTable.Tuning Tuning, TimeSpan Duration, bool Trace, bool Replug = false, string? Output = null, uint IdlePolls = Dt295NativeDevice.IdlePollsDefault, bool DemodDump = false);

    internal static Options? Parse(string[] args)
    {
        string? Value(string name)
        {
            var at = Array.IndexOf(args, name);
            return at >= 0 ? args.ElementAtOrDefault(at + 1) : null;
        }
        if (Value("--channel") is not { } channel || ChannelTable.Parse(channel) is not { } tuning) return null;
        var seconds = 5;
        if (args.Contains("--seconds") && !int.TryParse(Value("--seconds"), NumberStyles.None, CultureInfo.InvariantCulture, out seconds)) return null;
        return seconds <= 0 ? null : new Options(Value("--port"), channel, tuning, TimeSpan.FromSeconds(seconds), args.Contains("--trace"), args.Contains("--replug"), Value("--output"), DemodDump: args.Contains("--demod-dump"));
    }

    public static int Run(string[] args)
    {
        if (Parse(args) is not { } options)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var ports = Dt295.Ports(message => Console.Error.WriteLine(message));
        var port = options.Port ?? (ports.Count == 1 ? ports[0] : null);
        if (port is null)
        {
            Console.Error.WriteLine(ports.Count == 0
                ? $"{Dt295.Model} が見当たりません"
                : $"{Dt295.Model} が {ports.Count} 台あります。--port で指してください ({string.Join(", ", ports)})");
            return 1;
        }
        if (options.Replug)
        {
            try
            {
                UsbSysfs.PowerCycle(UsbSysfs.Devices, port, TimeSpan.FromSeconds(10));
                Thread.Sleep(500);
            }
            catch (IOException error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
            Console.Error.WriteLine($"USB のポート {port} の電源を入れ直しました");
        }
        try
        {
            return Execute(() => Dt295NativeDevice.Acquire(port), () => Dt295NativeDevice.CloseIfIdle(port), options, Console.Out, Console.Error);
        }
        finally
        {
            Dt295NativeDevice.CloseAll();
        }
    }

    /// <summary>機材を取って選局し、<see cref="Options.Duration"/> だけ受けて統計を出す。テストは偽の機材を取る関数と閉じる関数を渡す</summary>
    internal static int Execute(Func<Dt295NativeDevice> acquire, Action? closeIdle, Options options, TextWriter output, TextWriter log)
    {
        var total = Stopwatch.StartNew();
        var process = Process.GetCurrentProcess();
        TimeSpan Cpu()
        {
            process.Refresh();
            return process.TotalProcessorTime;
        }
        var cpuStart = Cpu();
        void Step(string message) => log.WriteLine($"[{total.ElapsedMilliseconds,6} ms] {message}");

        var stats = new Dt295TsStats();
        var continuity = new ContinuityCount();
        var framer = new NativeTsFramer();
        using var file = options.Output is { } path ? File.Create(path) : null;
        var failed = false;
        var problem = (string?)null;
        long firstTsMs = -1;
        var streaming = TimeSpan.Zero;
        Dt295NativeDevice? device = null;
        Thread? reader = null;
        var stopReading = false;
        long seenBytes = 0;
        using var tuner = new Dt295NativeTuner($"{Dt295.Model} {options.Port}", () => device = acquire(), closeIdle);
        try
        {
            var tuneClock = Stopwatch.StartNew();
            tuner.Tune(options.Tuning, options.Tuning.StreamId);
            device = tuner.Device;
            Step($"{options.Channel} を選局しました (選局から最初の TS まで {tuneClock.ElapsedMilliseconds} ms)");
            if (device is not null)
            {
                output.WriteLine($"設定: {device.SetUp.Time.TotalMilliseconds:F0} ms、制御転送 {device.SetUp.Controls} 回");
            }
            output.WriteLine("受信の確認: 受かった");
            output.WriteLine($"選局から最初の TS: {tuneClock.ElapsedMilliseconds} ms");
            firstTsMs = tuneClock.ElapsedMilliseconds;
            var reading = Stopwatch.StartNew();
            // 読む側は Output を 1 回だけ取る (止めたあとに tuner.Output を取り直すと、選局していないとして例外になる)
            var tsStream = tuner.Output;
            reader = new Thread(() =>
            {
                var buffer = new byte[188 * 1024];
                try
                {
                    while (true)
                    {
                        var got = tsStream.Read(buffer, 0, buffer.Length);
                        if (got == 0)
                        {
                            if (!Volatile.Read(ref stopReading)) problem = "TS の読みが終わりました";
                            return;
                        }
                        file?.Write(buffer, 0, got);
                        framer.Push(buffer.AsSpan(0, got), packet =>
                        {
                            stats.Push(packet);
                            Interlocked.Add(ref seenBytes, packet.Length);
                            continuity.Push(packet, reading.Elapsed);
                        });
                    }
                }
                catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
                {
                    if (!Volatile.Read(ref stopReading)) problem = error.Message;
                }
            }) { IsBackground = true, Name = "dt295-probe-ts" };
            reader.Start();
            var lastSignal = TimeSpan.Zero;
            void ShowSignal()
            {
                // C/N の生の値 (dB には直していない。仕様書に換算式もレジスタも無く、レジスタは TC90522 系の推定)
                if (tuner.Signal() is { } signal)
                {
                    output.WriteLine($"信号 ({reading.Elapsed.TotalSeconds:F1} 秒): {(signal.Locked ? "受信中" : "受信していない")}、"
                        + $"C/N の生の値 0x{signal.CnRaw.ToString($"X{signal.CnBytes * 2}")} ({signal.CnRaw}。{(signal.Satellite ? "衛星 0xBC" : "地上波 0x8B")} から {signal.CnBytes} バイト。dB には直していません)");
                }
                lastSignal = reading.Elapsed;
            }
            // 決めた秒数のあいだ受ける。1 バイトも読めていなければ、読み手が動くまで 5 秒まで待つ (遅い環境で読み手より先に時間が来ない)
            while ((reading.Elapsed < options.Duration || (Interlocked.Read(ref seenBytes) == 0 && reading.Elapsed < TimeSpan.FromSeconds(5))) && problem is null)
            {
                Thread.Sleep(10);
                if (reading.Elapsed - lastSignal >= TimeSpan.FromSeconds(1)) ShowSignal();
            }
            streaming = reading.Elapsed;
            ShowSignal();
            if (options.DemodDump && tuner.DumpDemod() is { } dump)
            {
                output.WriteLine("復調のレジスタ 0x00〜0xFF (受信中。C/N のレジスタを探すときは、アンテナの信号を変えて 2 回取って比べる):");
                for (var at = 0; at < dump.Length; at += 16) output.WriteLine($"  {at:X2}: {Convert.ToHexString(dump.AsSpan(at, 16))}");
            }
            Volatile.Write(ref stopReading, true);
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or ArgumentException
            or UnauthorizedAccessException or InvalidDataException)
        {
            Step($"止めました: {error.Message}");
            failed = true;
        }
        Volatile.Write(ref stopReading, true);
        var controls = device?.Link.Controls ?? 0;
        tuner.Dispose();
        reader?.Join(TimeSpan.FromSeconds(2));
        output.WriteLine($"制御転送: 合計 {controls} 回、ホストの CPU 時間 {(Cpu() - cpuStart).TotalMilliseconds:F0} ms、経過 {total.ElapsedMilliseconds} ms");
        if (streaming > TimeSpan.Zero && stats.Bytes > 0) output.WriteLine($"受信の平均: {stats.Bytes * 8 / streaming.TotalSeconds / 1e6:F2} Mbps ({streaming.TotalSeconds:F1} 秒)");
        if (stats.Bytes > 0)
        {
            stats.Print(output);
            output.WriteLine($"continuity_counter の飛び: {continuity.Jumps} 回 ({continuity.Places.Count} か所)");
            output.WriteLine($"同期を探し直して捨てたバイト: {framer.Discarded}");
        }
        else
        {
            output.WriteLine($"最初の TS: {(firstTsMs < 0 ? "来なかった" : "届いたが読めなかった")}");
        }
        if (firstTsMs >= 0 && stats.Bytes > 0) output.WriteLine($"最初の TS: 選局から {firstTsMs} ms");
        if (problem is not null) output.WriteLine($"TS の読みで止まった: {problem}");
        return failed || stats.Bytes == 0 || problem is not null ? 1 : 0;
    }
}

/// <summary>
/// TS の統計。188 バイトのパケットを 1 つずつ渡す。同期バイトの割合・transport_scrambling_control ごとの数・
/// transport_error_indicator が 1 の数・PID の種類を数える。中身は持たない
/// </summary>
public sealed class Dt295TsStats
{
    public long Bytes { get; private set; }
    public long Packets { get; private set; }
    public long Synced { get; private set; }
    public long Errors { get; private set; }
    public long[] Scrambling { get; } = new long[4];
    public SortedDictionary<int, long> Pids { get; } = [];

    public void Push(ReadOnlySpan<byte> packet)
    {
        Bytes += packet.Length;
        Packets++;
        if (packet[0] != 0x47) return;
        Synced++;
        // 誤りのあるパケットは PID も崩れているので、PID の種類には数えない
        if ((packet[1] & 0x80) != 0)
        {
            Errors++;
            return;
        }
        Scrambling[packet[3] >> 6]++;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        Pids[pid] = Pids.GetValueOrDefault(pid) + 1;
    }

    public void Print(TextWriter output)
    {
        output.WriteLine($"bytes: {Bytes}");
        output.WriteLine($"packets: {Packets}  sync 0x47: {Synced} ({(Packets == 0 ? 0 : 100.0 * Synced / Packets):F2}%)  transport_error_indicator: {Errors}");
        output.WriteLine($"transport_scrambling_control: 00={Scrambling[0]} 01={Scrambling[1]} 10={Scrambling[2]} 11={Scrambling[3]}");
        output.WriteLine($"PID: {Pids.Count} 種類  PAT: {(Pids.ContainsKey(0) ? "来た" : "来ない")}");
    }
}