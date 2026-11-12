using System.Diagnostics;
using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 を確かめるコマンド。**サーバを立てず、機材を 1 回だけ動かして統計を出す。**
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
    public const string Usage = "denpa-agent --dt295-probe [--port <USB のポート>] --channel <T13-T62 | BS1-BS23[:TSID] | CS2-CS24> [--seconds N] [--replug] [--output <TS のファイル>] [--demod-dump] [--switch <チャンネル,…>] [--lock-test N [--reopen] [--alt <チャンネル>]] [--demod-trace] [--trace]";

    internal sealed record Options(string? Port, string Channel, ChannelTable.Tuning Tuning, TimeSpan Duration, bool Trace, bool Replug = false, string? Output = null, bool DemodDump = false, string[]? Switch = null,
        int LockTest = 0, bool Reopen = false, string? Alt = null, bool DemodTrace = false);

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
        return seconds <= 0 ? null : new Options(Value("--port"), channel, tuning, TimeSpan.FromSeconds(seconds), args.Contains("--trace"), args.Contains("--replug"), Value("--output"), DemodDump: args.Contains("--demod-dump"), Switch: Value("--switch")?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            LockTest: int.TryParse(Value("--lock-test"), NumberStyles.None, CultureInfo.InvariantCulture, out var lockTest) ? lockTest : 0,
            Reopen: args.Contains("--reopen"), Alt: Value("--alt"), DemodTrace: args.Contains("--demod-trace"));
    }

    /// <summary>
    /// 地上波を選局してから受信を確認するまでの間、T 復調のレジスタ 0x00〜0xFF を約 10 ms ごとに読んで、途中で値が変わったものを時刻つきで出す。
    /// ロックの前後で動くレジスタから、復調が検出した結果 (モード・ガード・階層など) を返すものを探すため。選局のあとは読むだけで、復調には書かない。
    /// ロックの印 (0x81 の bit4) が立ってからも 15 回読む。選局が終わったところ (選局の呼び出しが戻ったとき) を 0 ms とする
    /// </summary>
    internal static int DemodTrace(Options options, Func<Dt295Timeline, Dt295NativeDevice> acquire, Action closeAll, TextWriter output)
    {
        if (options.Tuning.Satellite)
        {
            output.WriteLine("--demod-trace は地上波だけです");
            return 2;
        }
        var timeline = new Dt295Timeline();
        try
        {
            var device = acquire(timeline);
            var frontend = device.Frontend;
            frontend.TuneTerrestrial(ChannelTable.Khz(options.Tuning.Frequency));
            var samples = new List<(double Ms, byte[] Regs)>();
            var clock = Stopwatch.StartNew();
            double? lockedAt = null;
            var after = 0;
            while (clock.Elapsed < TimeSpan.FromSeconds(2) && after < 15)
            {
                var regs = frontend.DumpDemod(false);
                samples.Add((clock.Elapsed.TotalMilliseconds, regs));
                if ((regs[0x81] & 0x10) != 0)
                {
                    lockedAt ??= clock.Elapsed.TotalMilliseconds;
                    after++;
                }
                Thread.Sleep(10);
            }
            output.WriteLine($"T 復調のレジスタの経過: {options.Channel}、標本 {samples.Count} 回 (1 回 {(samples.Count > 1 ? (samples[^1].Ms - samples[0].Ms) / (samples.Count - 1) : 0):F1} ms 間隔)、"
                + $"ロックの印 (0x81 の bit4) {(lockedAt is { } lockMs ? $"{lockMs:F0} ms" : "立たず")}。選局が終わったところが 0 ms");
            var changed = 0;
            for (var register = 0; register < 256; register++)
            {
                var transitions = new List<string>();
                var previous = -1;
                foreach (var (ms, regs) in samples)
                {
                    if (regs[register] == previous) continue;
                    transitions.Add($"{ms:F0}:{regs[register]:X2}");
                    previous = regs[register];
                }
                if (transitions.Count < 2) continue;
                changed++;
                output.WriteLine($"  0x{register:X2}: {string.Join(" ", transitions.Take(40))}{(transitions.Count > 40 ? $" …(変わった回数 {transitions.Count})" : "")}");
            }
            if (changed == 0) output.WriteLine("  途中で値が変わったレジスタはありません");
            output.WriteLine("ロック後の値 (変わらなかったものも含めて、0x80〜0xBF):");
            var last = samples[^1].Regs;
            for (var at = 0x80; at < 0xC0; at += 16) output.WriteLine($"  {at:X2}: {Convert.ToHexString(last.AsSpan(at, 16))}");
            return lockedAt is null ? 1 : 0;
        }
        finally
        {
            closeAll();
        }
    }

    /// <summary>次の選局に使う、前の選局から離れるための同じ種別のチャンネル (チャンネル番号 + 2)。指定が無いときの既定</summary>
    private static string DefaultAlt(string channel)
    {
        var digits = new string(channel.SkipWhile(c => !char.IsDigit(c)).TakeWhile(char.IsDigit).ToArray());
        var prefix = channel[..(channel.Length - channel.SkipWhile(c => !char.IsDigit(c)).Count())];
        return int.TryParse(digits, out var number) ? $"{prefix}{number + 2}" : channel;
    }

    /// <summary>
    /// 選局を <paramref name="options"/>.LockTest 回くり返して、成功した割合と時間を出す (選局の手順や待ちを変えたときの確認用)。
    /// 毎回、同じ種別の別のチャンネル (--alt) に周波数だけ合わせて前の選局から離してから、測るチャンネルを選局する。--alt が選局表に無い名前 (none) なら離さず、同じチャンネルの選局し直しを測る。
    /// --reopen を付けると毎回機材を閉じて開き直す (INITIALIZE の待ちを試すとき)。成功は、選局が受信を確認して最初の TS が届くこと
    /// </summary>
    internal static int LockTest(Options options, Func<Dt295Timeline, Dt295NativeDevice> acquire, Action closeIdle, Action closeAll, TextWriter output)
    {
        var timeline = new Dt295Timeline();
        Dt295NativeTuner Make() => new($"{Dt295.Model} {options.Port}", () => acquire(timeline), closeIdle);
        var alt = options.Alt ?? DefaultAlt(options.Channel);
        var altTuning = ChannelTable.Parse(alt);
        var results = new List<(bool Ok, double TotalMs, double LockMs, string? Error)>();
        output.WriteLine($"ロックの試験: {options.Channel} を {options.LockTest} 回 (機材を開き直す: {(options.Reopen ? "はい" : "いいえ")}、離れるチャンネル {alt})");
        Dt295NativeTuner? tuner = null;
        try
        {
            for (var i = 1; i <= options.LockTest; i++)
            {
                if (options.Reopen)
                {
                    tuner?.Dispose();
                    tuner = null;
                }
                tuner ??= Make();
                if (!options.Reopen && altTuning is not null && tuner.Device is { } open)
                {
                    try
                    {
                        // 前の選局から離す。ロックは待たない
                        if (altTuning.Satellite) open.Frontend.TuneSatellite(altTuning.Frequency);
                        else open.Frontend.TuneTerrestrial(ChannelTable.Khz(altTuning.Frequency));
                    }
                    catch (Exception error) when (error is IOException or InvalidOperationException)
                    {
                        output.WriteLine($"  離れる選局に失敗: {error.Message}");
                    }
                }
                var before = timeline.Rows.Count;
                var clock = Stopwatch.StartNew();
                try
                {
                    tuner.Tune(options.Tuning);
                    var total = clock.Elapsed.TotalMilliseconds;
                    var lockMs = timeline.Rows.Skip(before).Where(row => row.Name.StartsWith("受信の確認", StringComparison.Ordinal)).Select(row => row.Ms).DefaultIfEmpty(-1).Last();
                    results.Add((true, total, lockMs, null));
                    output.WriteLine($"{i,4}: 成功 {total:F0} ms (受信の確認 {lockMs:F0} ms)");
                }
                catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
                {
                    results.Add((false, clock.Elapsed.TotalMilliseconds, -1, error.Message));
                    output.WriteLine($"{i,4}: 失敗 {clock.Elapsed.TotalMilliseconds:F0} ms ({error.Message})");
                }
            }
        }
        finally
        {
            tuner?.Dispose();
            closeAll();
        }
        static double At(List<double> sorted, double q) => sorted.Count == 0 ? double.NaN : sorted[Math.Clamp((int)Math.Ceiling(q * sorted.Count) - 1, 0, sorted.Count - 1)];
        var ok = results.Where(result => result.Ok).ToList();
        var totals = ok.Select(result => result.TotalMs).Order().ToList();
        var locks = ok.Where(result => result.LockMs >= 0).Select(result => result.LockMs).Order().ToList();
        output.WriteLine($"結果: 成功 {ok.Count}/{results.Count} ({(results.Count == 0 ? 0 : 100.0 * ok.Count / results.Count):F1}%)、"
            + $"最初の TS まで 最小 {At(totals, 0):F0} 中央 {At(totals, 0.5):F0} 90% {At(totals, 0.9):F0} 最大 {At(totals, 1):F0} ms、"
            + $"受信の確認 最小 {At(locks, 0):F0} 中央 {At(locks, 0.5):F0} 90% {At(locks, 0.9):F0} 最大 {At(locks, 1):F0} ms");
        return ok.Count == results.Count && results.Count > 0 ? 0 : 1;
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
            if (UsbHost.Current.PowerCycle is not { } cycle)
            {
                Console.Error.WriteLine("この OS ではポートの電源を入れ直せません。機材を挿し直してください");
                return 1;
            }
            try
            {
                cycle(port, TimeSpan.FromSeconds(10));
                Thread.Sleep(500);
            }
            catch (IOException error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
            Console.Error.WriteLine($"USB のポート {port} の電源を入れ直しました");
        }
        // --trace: 機材への読み書きと設定の読み戻しを 1 行ずつ、標準エラー出力に出す
        Action<string>? trace = options.Trace ? message => Console.Error.WriteLine($"  {message}") : null;
        if (options.DemodTrace) return DemodTrace(options with { Port = port }, timeline => Dt295NativeDevice.Acquire(port, timeline, trace), Dt295NativeDevice.CloseAll, Console.Out);
        if (options.LockTest > 0) return LockTest(options with { Port = port }, timeline => Dt295NativeDevice.Acquire(port, timeline, trace), () => Dt295NativeDevice.CloseIfIdle(port), Dt295NativeDevice.CloseAll, Console.Out);
        try
        {
            var timeline = new Dt295Timeline();
            return Execute(() => Dt295NativeDevice.Acquire(port, timeline, trace), () => Dt295NativeDevice.CloseIfIdle(port), options, Console.Out, Console.Error, timeline,
                () => Dt295.Card(port).Open());
        }
        finally
        {
            Dt295NativeDevice.CloseAll();
        }
    }

    /// <summary>
    /// このプロセスのスレッドごとの CPU 時間 (Linux の /proc/self/task。10 ms 単位)。「名前 ms」を、使った順に並べる。Linux 以外は空
    /// </summary>
    internal static string ThreadCpu()
    {
        try
        {
            var times = new List<(string Name, int Ms)>();
            foreach (var dir in Directory.GetDirectories("/proc/self/task"))
            {
                var stat = File.ReadAllText(Path.Combine(dir, "stat"));
                var open = stat.IndexOf('(');
                var close = stat.LastIndexOf(')');
                var fields = stat[(close + 2)..].Split(' ');
                // close の後ろは状態 (3 番目) から始まる。utime は 14 番目、stime は 15 番目
                var ticks = long.Parse(fields[11], CultureInfo.InvariantCulture) + long.Parse(fields[12], CultureInfo.InvariantCulture);
                times.Add((stat[(open + 1)..close], (int)(ticks * 10)));
            }
            return string.Join("、", times.GroupBy(t => t.Name).Select(g => (Name: g.Key, Ms: g.Sum(t => t.Ms))).Where(t => t.Ms > 0)
                .OrderByDescending(t => t.Ms).Select(t => $"{t.Name} {t.Ms} ms"));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or FormatException or IndexOutOfRangeException or ArgumentOutOfRangeException)
        {
            return "";
        }
    }

    /// <summary>機材を取って選局し、<see cref="Options.Duration"/> だけ受けて統計を出す。テストは偽の機材を取る関数と閉じる関数を渡す</summary>
    internal static int Execute(Func<Dt295NativeDevice> acquire, Action? closeIdle, Options options, TextWriter output, TextWriter log, Dt295Timeline? timeline = null, Func<ICardLink>? openCard = null)
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
        // 平均の Mbps は、最初に読めた時刻から最後に読めた時刻までで割る (最初の読み出しのぶんは除く)。窓の秒数や止めるまでの読み出しには左右されない
        var firstRead = TimeSpan.MinValue;
        var lastRead = TimeSpan.Zero;
        long firstChunk = 0;
        long mainControls = 0;
        var mainCpu = TimeSpan.Zero;
        var threadCpu = "";
        long mainElapsed = 0;
        Dt295NativeDevice? device = null;
        Thread? reader = null;
        var stopReading = false;
        long seenBytes = 0;
        using var tuner = new Dt295NativeTuner($"{Dt295.Model} {options.Port}", () => device = acquire(), closeIdle);
        try
        {
            var tuneClock = Stopwatch.StartNew();
            tuner.Tune(options.Tuning);
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
                            if (!Volatile.Read(ref stopReading)) problem = "TS の読み出しが終わりました";
                            return;
                        }
                        file?.Write(buffer, 0, got);
                        var now = reading.Elapsed;
                        if (firstRead == TimeSpan.MinValue)
                        {
                            firstRead = now;
                            firstChunk = got;
                        }
                        lastRead = now;
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
                // C/N の生の値 (レジスタは TC90522 系の推定。dB は TunerSignal.Tc90522Db の式で併記する)
                if (tuner.Signal() is { } signal)
                {
                    output.WriteLine($"信号 ({reading.Elapsed.TotalSeconds:F1} 秒): {(signal.Locked ? "受信中" : "受信していない")}、"
                        + $"C/N の生の値 0x{signal.CnRaw.ToString($"X{signal.CnBytes * 2}")} ({signal.CnRaw}。{(signal.Satellite ? "衛星 0xBC" : "地上波 0x8B")} から {signal.CnBytes} バイト。TC90522 系の式で {(TunerSignal.Tc90522Db(signal.Satellite, signal.CnRaw) is { } db ? $"{db:F1} dB" : "式の外")})");
                }
                lastSignal = reading.Elapsed;
            }
            // 決めた秒数のあいだ受ける。1 バイトも読めていなければ、読み取りのスレッドが動くまで 5 秒まで待つ (遅い環境で、読み始める前に時間が切れないように)
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
            mainControls = device?.Link.Controls ?? 0;
            mainCpu = Cpu();
            threadCpu = ThreadCpu();
            mainElapsed = total.ElapsedMilliseconds;
            reader.Join(TimeSpan.FromSeconds(2));
            if (device is not null) MeasureCard(device, firstTsMs, openCard, output);
            if (options.Switch is { Length: > 0 } list) MeasureSwitches(tuner, device, options.Channel, options.Tuning, list, output);
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or ArgumentException
            or UnauthorizedAccessException or InvalidDataException)
        {
            Step($"止めました: {error.Message}");
            failed = true;
        }
        Volatile.Write(ref stopReading, true);
        tuner.Dispose();
        reader?.Join(TimeSpan.FromSeconds(2));
        if (mainElapsed == 0)
        {
            mainControls = device?.Link.Controls ?? 0;
            mainCpu = Cpu();
            threadCpu = ThreadCpu();
            mainElapsed = total.ElapsedMilliseconds;
        }
        output.WriteLine($"制御転送: 合計 {mainControls} 回、ホストの CPU 時間 {(mainCpu - cpuStart).TotalMilliseconds:F0} ms、経過 {mainElapsed} ms");
        if (threadCpu.Length > 0) output.WriteLine($"スレッドごとの CPU 時間: {threadCpu}");
        var receiving = firstRead == TimeSpan.MinValue ? TimeSpan.Zero : lastRead - firstRead;
        if (firstRead != TimeSpan.MinValue && receiving > TimeSpan.Zero)
        {
            output.WriteLine($"受信の平均: {(stats.Bytes - firstChunk) * 8 / receiving.TotalSeconds / 1e6:F2} Mbps (最初の読み出しから最後の読み出しまで {receiving.TotalSeconds:F1} 秒。決めた秒数は {streaming.TotalSeconds:F1} 秒)");
        }
        else if (stats.Bytes > 0)
        {
            output.WriteLine("受信の平均: 求められません (読み出しが 1 回だけで、最初の読み出しから最後の読み出しまでの時間がありません)");
        }
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
        if (problem is not null) output.WriteLine($"TS の読み出しで止まった: {problem}");
        if (timeline is not null)
        {
            output.WriteLine();
            output.WriteLine("時間の内訳 (開始は --dt295-probe の機材を開く前から。子の行は親の行に含まれる):");
            timeline.Print(output);
        }
        return failed || stats.Bytes == 0 || problem is not null ? 1 : 0;
    }

    /// <summary>
    /// カードの準備が選局と並んで済んだ時間と、ID を読むまでの時間を出す。時間は機材を開き始めてからで、最初の TS と同じ物差し。
    /// ID は、準備済みのカードに Reset と BCas の読み出しをして得る (TS が届いたときに復号を始める場合にかかる時間)
    /// </summary>
    private static void MeasureCard(Dt295NativeDevice device, long firstTsMs, Func<ICardLink>? openCard, TextWriter output)
    {
        device.CardWarmTask?.Wait(TimeSpan.FromSeconds(5));
        output.WriteLine($"カード: 準備完了まで {(device.CardReadyMs < 0 ? "済んでいない (カードが無いか失敗)" : $"{device.CardReadyMs} ms")} (機材を開き始めてから)、最初の TS まで {firstTsMs} ms (同じく)");
        if (openCard is null) return;
        try
        {
            var clock = Stopwatch.StartNew();
            using var link = openCard();
            link.Reset();
            var reset = clock.ElapsedMilliseconds;
            var init = BCas.Read(link);
            var read = clock.ElapsedMilliseconds;
            var ready = Math.Max(Math.Max(device.CardReadyMs, 0), firstTsMs);
            output.WriteLine($"カードの ID: Reset {reset} ms、ID の読み出しまで {read} ms。TS が届いたときに復号を始めるなら、開き始めてから約 {ready + read} ms で ID が読める "
                + $"(カード {string.Join(" / ", init.Ids.Select(id => id.ToString("D16")))}、CA_system_id 0x{init.CaSystemId:X4})");
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
        {
            output.WriteLine($"カードの ID を読めませんでした: {error.Message}");
        }
    }

    /// <summary>
    /// 同じ機材で続けて選局し直す時間を測る (機材を開いたままの選局し直しで、全部の初期化はしない)。種別が同じ (地上波どうし・衛星どうし) か替わるかも出す。
    /// 時間は選局の呼び出しから最初の TS まで
    /// </summary>
    private static void MeasureSwitches(Dt295NativeTuner tuner, Dt295NativeDevice? device, string firstChannel, ChannelTable.Tuning firstTuning, string[] list, TextWriter output)
    {
        var previous = (Name: firstChannel, firstTuning.Satellite);
        output.WriteLine("選局の切り替え (機材は開いたまま):");
        foreach (var name in list)
        {
            if (ChannelTable.Parse(name) is not { } tuning)
            {
                output.WriteLine($"  {name}: 選局表にありません");
                continue;
            }
            var controls = device?.Link.Controls ?? 0;
            var clock = Stopwatch.StartNew();
            try
            {
                tuner.Tune(tuning);
                output.WriteLine($"  {previous.Name} → {name} ({(previous.Satellite == tuning.Satellite ? "同じ種別" : "種別が替わる")}): {clock.ElapsedMilliseconds} ms、制御転送 {(device?.Link.Controls ?? 0) - controls} 回");
            }
            catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
            {
                output.WriteLine($"  {previous.Name} → {name}: 失敗 ({error.Message}。{clock.ElapsedMilliseconds} ms)");
            }
            previous = (name, tuning.Satellite);
        }
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
    public long FirstError { get; private set; }
    public long LastError { get; private set; }
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
            if (FirstError == 0) FirstError = Packets;
            LastError = Packets;
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
        if (Errors > 0) output.WriteLine($"transport_error_indicator の位置: 最初 {FirstError} 番目、最後 {LastError} 番目 (全 {Packets} パケット)");
        output.WriteLine($"transport_scrambling_control: 00={Scrambling[0]} 01={Scrambling[1]} 10={Scrambling[2]} 11={Scrambling[3]}");
        output.WriteLine($"PID: {Pids.Count} 種類  PAT: {(Pids.ContainsKey(0) ? "来た" : "来ない")}");
    }
}