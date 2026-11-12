namespace Denpa.Agent;

/*
 * --tune <受信機+受信機+…> <チャンネル> --steps 2,3,5: IT930x の機材 1 台で、TS を流す受信機を段階を追って増やす。
 * 5 つを同時に流したあとブリッジから TS が届かなくなり、電源を抜くまで戻らなかった記録 (PX-MLT5PE) を、1 回の電源の入れ直しの中で少しずつ確かめるためのもの。
 * 段階ごとと受信機を 1 つ足すごとに、ブリッジの TS の経路の状態 (It930xBridge.ReadTsStatus) と EP 0x84 の読み出しの数えを出し、
 * TS が届かない受信機が出たら、その先の受信機は足さずに止める。
 */

/// <summary><c>--tune … --steps</c> の本体</summary>
internal static class It930xSteps
{
    /// <summary>受信機を 1 つ足したあと、流している受信機に TS が届いているかを見る間</summary>
    private static readonly TimeSpan Quick = TimeSpan.FromSeconds(1);

    /// <summary>
    /// <c>--steps</c> の値 (<c>2,3,5</c>)。段階ごとの受信機の数で、1 から <paramref name="receivers"/> までの増えていく並び。読めなければ null
    /// </summary>
    public static int[]? ParseSteps(string? text, int receivers)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var steps = new List<int>();
        foreach (var part in text.Split(','))
        {
            if (!int.TryParse(part, out var count) || count < 1 || count > receivers) return null;
            if (steps.Count > 0 && count <= steps[^1]) return null;
            steps.Add(count);
        }
        return [.. steps];
    }

    /// <summary>流している受信機 1 つ。出口を読み続けて、読んだバイトを数える (読まないと出口が溢れて捨て始めるため)</summary>
    private sealed class Receiver(string name, string channel, It930xTuner tuner)
    {
        private long _bytes;
        private Thread? _thread;

        public string Name => name;
        public string Channel => channel;
        public It930xTuner Tuner => tuner;
        public long Bytes => Interlocked.Read(ref _bytes);

        private volatile string? _ended;

        /// <summary>出口が尽きるか読めなくなった理由 (流れている間は null。読み出しのスレッドが書き、ほかのスレッドが読む)</summary>
        public string? Ended => _ended;

        public void Start()
        {
            var stream = tuner.Output;
            _thread = new Thread(() =>
            {
                var buffer = new byte[188 * 1024];
                try
                {
                    int got;
                    while ((got = stream.Read(buffer, 0, buffer.Length)) > 0) Interlocked.Add(ref _bytes, got);
                    _ended = "出口が閉じました";
                }
                catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
                {
                    _ended = error.Message;
                }
            })
            { IsBackground = true, Name = $"steps-{name}" };
            _thread.Start();
        }

        public void Stop()
        {
            tuner.Dispose();
            _thread?.Join(TimeSpan.FromSeconds(2));
        }
    }

    public static int Run(string[] devices, string[] channels, string? lnb, int[] steps, TimeSpan seconds, TextWriter output)
    {
        var parsed = devices.Select(It930x.Parse).ToList();
        if (parsed.Any(item => item is null) || parsed.Select(item => item!.Value.Port).Distinct().Count() != 1)
        {
            output.WriteLine($"--steps は、同じ機材の {It930x.Scheme}<USB のポート>:<受信機> を + で並べたときだけ使えます");
            return 2;
        }
        if (parsed.Select(item => item!.Value.Receiver).Distinct().Count() != parsed.Count)
        {
            output.WriteLine("--steps で同じ受信機を 2 回並べています");
            return 2;
        }
        var tunings = channels.Select(ChannelTable.Parse).ToList();
        if (tunings.IndexOf(null) is var missing and >= 0)
        {
            output.WriteLine($"{channels[missing]}: 選局表にありません");
            return 2;
        }
        var port = parsed[0]!.Value.Port;
        output.WriteLine($"受信機を段階を追って足します: {string.Join(" ", devices)}  段階 {string.Join(",", steps)}  各段階 {seconds.TotalSeconds:F0} 秒"
            + $"  チャンネルは並べた順に先頭から割り当てる (足りなければ先頭から繰り返す){(lnb is null ? "" : $"  (LNB {lnb})")}");

        var receivers = new List<Receiver>();
        It930xDevice? device = null;
        var failed = false;
        try
        {
            device = It930xDevice.Acquire(port);
            output.WriteLine($"--- 開いた直後 (どの受信機もまだ開いておらず、入力も開けていない。開くのに {device.OpenMs} ms)");
            Probe.ShowBridge(device, output);
            var added = 0;
            for (var step = 0; step < steps.Length && !failed; step++)
            {
                output.WriteLine($"=== 段階 {step + 1}: 受信機を {steps[step]} つにします");
                for (; added < steps[step]; added++)
                {
                    var name = devices[added];
                    var channel = channels[added % channels.Length];
                    var tuner = (It930xTuner)TunerPool.OpenDevice(name, lnb);
                    var started = DateTime.UtcNow;
                    // 流している受信機の並び (receivers) に入るまでは、どの失敗でもここで捨てる (入ったあとは finally の Stop が捨てる)
                    var handed = false;
                    try
                    {
                        tuner.Tune(tunings[added % tunings.Count]!);
                        var receiver = new Receiver(name, channel, tuner);
                        receiver.Start();
                        receivers.Add(receiver);
                        handed = true;
                    }
                    catch (IOException error)
                    {
                        output.WriteLine($"{name} {channel}: 選局できませんでした ({error.Message})");
                        Probe.ShowBridge(device, output);
                        failed = true;
                        break;
                    }
                    finally
                    {
                        if (!handed) tuner.Dispose();
                    }
                    output.WriteLine($"{name} {channel}: 選局しました ({(DateTime.UtcNow - started).TotalMilliseconds:F0} ms、ロックまで {tuner.LockMs} ms)");
                    // 足した直後に、流している受信機のどれかの TS が止まったかを見る (どの受信機を足したときに止まったかを分ける)
                    if (Window(receivers, Quick, output, "    足したあと 1 秒") is { } stopped)
                    {
                        output.WriteLine($"    {stopped} に TS が届きません。この先の受信機は足しません");
                        Probe.ShowBridge(device, output);
                        failed = true;
                        break;
                    }
                }
                if (failed) break;
                output.WriteLine($"--- 段階 {step + 1}: {receivers.Count} つの受信機を選局したあと");
                Probe.ShowBridge(device, output);
                var quiet = Window(receivers, seconds, output, $"    {seconds.TotalSeconds:F0} 秒");
                output.WriteLine($"--- 段階 {step + 1}: 受けたあと");
                Probe.ShowBridge(device, output);
                if (quiet is { } none)
                {
                    output.WriteLine($"{none} に TS が届きません。この先の段階には進みません");
                    failed = true;
                }
            }
            output.WriteLine(failed ? "=== 途中で止めました" : "=== どの段階も、どの受信機にも TS が届きました");
            return failed ? 1 : 0;
        }
        catch (IOException error)
        {
            output.WriteLine($"{port}: {error.Message}");
            return 1;
        }
        finally
        {
            // 受信機を止めてから機材を返す。閉じるのは呼ぶ側 (It930xDevice.CloseAll。入力を全部閉じて EP 0x84 をリセットしてから電源を切る)
            foreach (var receiver in receivers) receiver.Stop();
            device?.Release();
        }
    }

    /// <summary>
    /// <paramref name="length"/> の間に受信機ごとに届いたバイトと Mbps と出口で捨てたパケットを出す。1 バイトも届かなかった受信機があれば、その名前を返す (最初の 1 つ)
    /// </summary>
    private static string? Window(List<Receiver> receivers, TimeSpan length, TextWriter output, string label)
    {
        var before = receivers.Select(receiver => receiver.Bytes).ToList();
        Thread.Sleep(length);
        string? stopped = null;
        for (var i = 0; i < receivers.Count; i++)
        {
            var receiver = receivers[i];
            var bytes = receiver.Bytes - before[i];
            var mbps = bytes * 8 / length.TotalSeconds / 1e6;
            output.WriteLine($"{label}  {receiver.Name} {receiver.Channel}  {bytes / 1024} KiB  {mbps:F2} Mbps"
                + $"{(receiver.Tuner.Dropped is > 0 and var dropped ? $"  出口で捨てた {dropped} パケット" : "")}{(receiver.Ended is { } why ? $"  ({why})" : "")}");
            if (bytes == 0) stopped ??= receiver.Name;
        }
        return stopped;
    }
}
