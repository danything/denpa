using System.Diagnostics;
using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// 常駐方式 (mAgicVISION のファームウェア) で PIX-DT295 を確かめる入口。**サーバを立てず、機材を 1 回だけ動かして統計を出す。**
///
/// <code>
/// denpa-agent --dt295-resident-probe --channel T27 --seconds 5
/// denpa-agent --dt295-resident-probe --channel BS15 --port 1-2 --replug --output /tmp/bs15.ts
/// </code>
///
/// <para>
/// 常駐イメージが残っていれば引き継ぎ、無ければ冷えた機材に入れる。どちらでもない (元のファームウェアで動いた) 機材は、
/// <c>--replug</c> でポートの電源を入れ直してから入れる (Linux だけ)。終わるときは常駐イメージを機材に残したまま手放す。
/// 段ごとの記録 (時間つき) は標準エラーに、統計は標準出力に出す。<c>--output</c> を付けたときだけ TS をファイルに書く。
/// 終了コードは、うまくいけば 0、どこかで止まれば 1
/// </para>
/// </summary>
public static class Dt295ResidentProbe
{
    public const string Usage =
        "denpa-agent --dt295-resident-probe [--port <USB のポート>] --channel <T13-T62 | BS1-BS23[:TSID] | CS2-CS24> [--seconds N] [--output <TS のファイル>] [--replug] [--trace]";

    private sealed record Options(string? Port, string Channel, ChannelTable.Tuning Tuning, TimeSpan Seconds, string? Output, bool Replug, bool Trace);

    private static Options? Parse(string[] args)
    {
        string? Value(string name)
        {
            var at = Array.IndexOf(args, name);
            return at >= 0 ? args.ElementAtOrDefault(at + 1) : null;
        }
        if (Value("--channel") is not { } channel || ChannelTable.Parse(channel) is not { } tuning) return null;
        var seconds = 5;
        if (args.Contains("--seconds") && !int.TryParse(Value("--seconds"), NumberStyles.None, CultureInfo.InvariantCulture, out seconds)) return null;
        if (seconds <= 0) return null;
        return new Options(Value("--port"), channel, tuning, TimeSpan.FromSeconds(seconds), Value("--output"), args.Contains("--replug"), args.Contains("--trace"));
    }

    /// <summary>denpa のチャンネルから、常駐イメージへの選局の中身を作る</summary>
    public static Dt295ResidentRequest Request(ChannelTable.Tuning tuning, uint streamId) =>
        tuning.Satellite
            ? new Dt295ResidentRequest(Dt295ResidentProtocol.SourceSatellite, tuning.Frequency, streamId == ChannelTable.NoStreamId ? null : (int)streamId, 0)
            // 地上波は 3 つの階層を全部受ける
            : new Dt295ResidentRequest(Dt295ResidentProtocol.SourceTerrestrial, tuning.Frequency, null, 7);

    public static int Run(string[] args)
    {
        if (Parse(args) is not { } options)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var clock = Stopwatch.StartNew();
        var last = 0L;
        void Step(string message)
        {
            var now = clock.ElapsedMilliseconds;
            Console.Error.WriteLine($"[{now,6} ms +{now - last,5}] {message}");
            last = now;
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

        Dt295ResidentImage image;
        try
        {
            image = Dt295ResidentImage.Bundled;
        }
        catch (InvalidDataException error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        Step($"同梱のファームウェアを読みました (ビルド {Convert.ToHexString(image.Build)})");

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
            Step($"USB のポート {port} の電源を入れ直しました");
        }

        IUsbDevice usb;
        try
        {
            usb = Dt295.OpenUsb(port);
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException or PlatformNotSupportedException)
        {
            Console.Error.WriteLine($"{Dt295.Model} {port} を開けません: {error.Message}");
            return 1;
        }

        var stats = new Dt295TsStats();
        var failed = false;
        using (usb)
        {
            var link = new Dt295ResidentLink(usb, options.Trace ? line => Console.Error.WriteLine($"    {line}") : null);
            var session = new Dt295ResidentSession(link);
            var started = false;
            try
            {
                var outcome = Dt295ResidentLoader.Start(link, session, image, Step);
                started = true;
                var overview = session.QueryOverview();
                Step($"常駐イメージを{(outcome == Dt295ResidentLoader.Outcome.Adopted ? "引き継ぎ" : "入れ")}、初期化しました "
                    + $"(受信部 {overview.RfMask}、TS {overview.StreamMask}、制御転送 {link.Controls} 回)");
                Receive(options, session, usb, stats, Step);
            }
            catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or InvalidDataException)
            {
                Step($"止めました: {error.Message}");
                failed = true;
            }
            finally
            {
                if (started)
                {
                    try
                    {
                        Dt295ResidentLoader.Close(session);
                        Step("常駐イメージを残したまま手放しました");
                    }
                    catch (Exception error) when (error is IOException or TimeoutException)
                    {
                        Step($"手放せませんでした: {error.Message}");
                        failed = true;
                    }
                }
            }
        }

        if (stats.Bytes > 0) stats.Print(Console.Out);
        return failed ? 1 : 0;
    }

    /// <summary>
    /// 読みを出してから選局し (選局の途中から TS が出る)、決めた秒数だけ受ける。受けている間は SERVICE を送り続ける (usbboot.c の capture_firmware)
    /// </summary>
    private static void Receive(Options options, Dt295ResidentSession session, IUsbDevice usb, Dt295TsStats stats, Action<string> step)
    {
        var request = Request(options.Tuning, options.Tuning.StreamId);
        var described = session.QuerySource(request.Source);
        step($"受信部 {request.Source}: 周波数 {described.FrequencyMin}〜{described.FrequencyMax}、記録 {described.RecordSize} バイト、"
            + $"形式 {(described.StreamFormat == Dt295ResidentProtocol.FormatMux ? "MUX" : "そのまま")}、印 0x{described.Flags:X}");
        if ((described.Flags & Dt295ResidentProtocol.SourceStream) == 0) throw new InvalidOperationException($"受信部 {request.Source} は TS を出せません");
        if (described.WindowRecords != 0) throw new InvalidOperationException("受信部が窓での受け渡しを求めていて、USB では使えません");

        var ts = new Dt295ResidentTs(described.StreamFormat, request.Source, (int)described.RecordSize);
        using var output = options.Output is { } path ? File.Create(path) : null;
        var reading = Stopwatch.StartNew();
        long firstMs = -1;
        string? problem = null;
        var stop = false;
        void Sink(ReadOnlySpan<byte> packet)
        {
            stats.Push(packet);
            output?.Write(packet);
        }

        using var input = usb.OpenInStream(0x81, 8192, 64);
        var reader = new Thread(() =>
        {
            var buffer = new byte[8192 * 64];
            while (!Volatile.Read(ref stop))
            {
                int got;
                try
                {
                    got = input.Read(buffer, 100);
                }
                catch (IOException error)
                {
                    problem = error.Message;
                    return;
                }
                if (got == 0) continue;
                if (firstMs < 0) firstMs = reading.ElapsedMilliseconds;
                if (!ts.Push(buffer.AsSpan(0, got), Sink))
                {
                    problem = ts.Broken;
                    return;
                }
            }
        }) { IsBackground = true, Name = "dt295-resident-probe" };
        reader.Start();

        var tuneClock = Stopwatch.StartNew();
        session.Tune(request, streaming: true);
        step($"{options.Channel} を選びました (選局 {tuneClock.ElapsedMilliseconds} ms、世代 {session.Generation}、最初の TS {(firstMs < 0 ? "まだ" : $"{firstMs} ms")})");

        var services = 0L;
        while (reading.Elapsed < options.Seconds && problem is null)
        {
            session.Service();
            services++;
            Thread.Sleep(1);
        }
        var locked = session.Locked(request.Source);
        session.Stop(request.Source);
        session.WaitStopped();
        Volatile.Write(ref stop, true);
        reader.Join(TimeSpan.FromSeconds(2));
        step($"受信を止めました (SERVICE {services} 回、受かっている {(locked ? "はい" : "いいえ")}、同期の探し直し {ts.Desyncs} 回・捨てた {ts.Discarded} バイト"
            + $"{(problem is null ? "" : $"、{problem}")})");
        if (problem is not null) throw new IOException(problem);
    }
}
