using System.Buffers;

namespace Denpa.Agent;

/// <summary>
/// 実機で選局を確かめる小道具。**サーバを立てずに 1 本だけ試す。**
///
/// <para>
/// デバイスを確保したままの選局は、値が 1 つ違っても「ioctl は通るが同期しない」という
/// 出方をする。単体テストでは踏めないので、実機で当てるための入口を用意した
/// (チューナー自動検出のときと同じやり方)。受けた TS は、量・同期バイトの割合・連続性の飛び (ContinuityCount.cs)・
/// 掛かっているパケットの割合を出す。
/// </para>
///
/// <code>
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27
/// denpa-agent --tune /dev/dvb/adapter0/frontend0 BS15:16625 --lnb 15v
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27,T21   # 確保したまま切り替える
/// denpa-agent --tune px4:00001205000960:2 T27               # px4-userland の機材。Q3U4 なら受信機 2 は地上波
/// denpa-agent --tune siano:1-2 T27                          # siano-userland の機材 (smsusb を blacklist した PX-S1UD)
/// denpa-agent --tune asicen:1-2:1 T27                       # asicen-userland の機材 (PX-W3U3。試験的。受信機 1 は地上波)
/// denpa-agent --tune zd1j:4-12.1 27 [--decode] [--seconds N] [--repeat N]   # Sony CECH-ZD1 J。開く・ロック・最初の TS (と復号できたパケット)・2 回目の選局の時間と C/N を出す
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27 --decode [--card-url http://…]
/// denpa-agent --decode-file in.ts out.ts                    # チューナーを使わずに B25 だけ (/denpa/decode と同じ)
/// denpa-agent --card                                        # カードリーダーを並べ、カードに INT を通す (エージェントを止めて)
/// denpa-agent --card zd1j:4-12.1                            # CECH-ZD1 J の内蔵の差し込み口だけ (ほかのリーダーに触らない)
/// denpa-agent --card dt295:4-12.1                           # PIX-DT295 の差し込み口だけ (ほかのリーダーに触らない)
/// </code>
///
/// <para>
/// 見るのは 3 つ。**同期したか・TS の形式になっているか・切り替えに何秒かかるか。**
/// 最後は取り直すのと比べてどれだけ短いかで、ここでしか測れない。
/// </para>
/// </summary>
public static class Probe
{
    // 使い方の 1 行 (引数が合わないときにここと Program.cs が出す)
    public const string TuneUsage = "denpa-agent --tune <device> <channel[,channel...]> [--lnb 15v] [--decode] [--card-url <url>] [--seconds N] [--repeat N]";
    public const string DecodeUsage = "denpa-agent --decode-file <in.ts> <out.ts>";
    public const string CardUsage = $"denpa-agent --card [{Zd1j.Scheme}<USB のポート> | {Dt295.Scheme}<USB のポート>]";

    /// <summary>1 チャンネルあたり読む時間</summary>
    private static readonly TimeSpan Read = TimeSpan.FromSeconds(3);

    /// <summary>
    /// 鍵を貰いに行く接続の TTL (<c>CARD_TTL</c>。常駐のときと同じ)。設定が読めなければ、
    /// 常駐のときと同じく理由を出して止まる (null)
    /// </summary>
    private static int? CardHops()
    {
        try
        {
            return CardLanPolicy.FromEnvironment().Hops;
        }
        catch (ArgumentException error)
        {
            Console.Error.WriteLine(error.Message);
            return null;
        }
    }

    /// <summary>
    /// ファイルを 1 つ復号する。**チューナーを使わずに B25 だけ確かめる。**
    ///
    /// <para>
    /// 掛かったまま録れてしまったものを救うのにも使える (denpa からは
    /// <c>/denpa/decode</c> が同じことをする)。
    /// </para>
    /// </summary>
    public static int Decode(string[] args)
    {
        var source = args.ElementAtOrDefault(1);
        var destination = args.ElementAtOrDefault(2);
        if (source is null || destination is null)
        {
            Console.Error.WriteLine($"usage: {DecodeUsage}");
            return 2;
        }

        if (CardHops() is not { } hops) return 2;
        Keys.Configure(Environment.GetEnvironmentVariable("CARD_URL"), hops);
        var b25 = new Descrambler(Keys.Source);
        using var input = File.OpenRead(source);
        using var output = File.Create(destination);
        long scrambled = 0;
        long packets = 0;
        var written = b25.DecodeAll(input, output, chunk =>
        {
            for (var at = 0; at + 188 <= chunk.Length; at += 188)
            {
                packets++;
                if (Scrambled(chunk[at..])) scrambled++;
            }
        });

        var before = packets == 0 ? 0 : 100.0 * scrambled / packets;
        Console.WriteLine($"{input.Length} -> {written} バイト  元は {before:F1}% が掛かっていました");
        Console.WriteLine($"復号した {b25.Decoded} / 掛かったまま {b25.Undecodable} パケット{(b25.LastError is { } why ? $" ({why})" : "")}");
        return 0;
    }

    /// <summary>
    /// カードリーダーを並べて、カードを開いてみる。**pcscd を通さなくなったので、
    /// 実機でリーダーと話せているかはここで確かめる。**
    /// </summary>
    public static int Card(string[] args)
    {
        if (args.ElementAtOrDefault(1) is { } device)
        {
            if (Dt295.Parse(device) is { } dt295) return OneCard(Dt295.Card(dt295), Dt295ResidentBoard.CloseAll);
            if (Zd1j.Parse(device) is not { } port)
            {
                Console.Error.WriteLine($"usage: {CardUsage}");
                return 2;
            }
            return OneCard(Zd1j.Card(port), Zd1jBoard.CloseAll);
        }
        Console.WriteLine(OperatingSystem.IsLinux() ? Ccid.Describe() : PcscLink.Describe());
        foreach (var found in Px4Card.Find().Concat(AsicenUserland.Cards())) Console.WriteLine($"内蔵 {found.Name}");
        Zd1j.DescribeCards(Zd1j.Cards(), Console.Out);
        Dt295.DescribeCards(Dt295.Cards(), Console.Out);
        try
        {
            using var card = CardLinks.Open();
            var init = card.Init();
            Console.WriteLine($"{card.Name}: カード {string.Join(" / ", init.Ids.Select(id => id.ToString("D16")))}"
                + $"  CA_system_id 0x{init.CaSystemId:X4}");
            return 0;
        }
        catch (IOException error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally
        {
            Zd1jBoard.CloseAll();
            Dt295ResidentBoard.CloseAll();
        }
    }

    public static int Run(string[] args)
    {
        var device = args.ElementAtOrDefault(1);
        var channels = args.ElementAtOrDefault(2)?.Split(',') ?? [];
        if (device is null || channels.Length == 0)
        {
            Console.Error.WriteLine($"usage: {TuneUsage}");
            return 2;
        }

        var lnbAt = Array.IndexOf(args, "--lnb");
        var lnb = lnbAt >= 0 ? args.ElementAtOrDefault(lnbAt + 1) : null;
        var decode = args.Contains("--decode");
        // 手元にカードが無い拠点。鍵だけ貰いに行く (CardShare.cs)
        var cardAt = Array.IndexOf(args, "--card-url");
        // 貰いに行く接続の TTL は常駐のときと同じ CARD_TTL (既定 1。CardLan.cs)
        if (CardHops() is not { } hops) return 2;
        Keys.Configure(cardAt >= 0 ? args.ElementAtOrDefault(cardAt + 1) : null, hops);

        var secondsAt = Array.IndexOf(args, "--seconds");
        var seconds = secondsAt >= 0 && int.TryParse(args.ElementAtOrDefault(secondsAt + 1), out var given) && given > 0
            ? TimeSpan.FromSeconds(given)
            : Read;
        if (Zd1j.Parse(device) is { } zd1j)
        {
            // 覚えたロックの値は常駐のときと同じファイルを読み書きする (再起動をまたいで確かめられるように)
            Zd1jBoard.Locks = new Zd1jLocks(Config.FromEnvironment().Zd1jLocksFile);
            // 鍵はそのボードの内蔵の差し込み口だけから (試験でほかのリーダーに触らない)。--card-url があればそちら
            IKeySource keys = cardAt >= 0 ? Keys.Source : new LocalCard(() => [Zd1j.Card(zd1j)]);
            var repeatAt = Array.IndexOf(args, "--repeat");
            var repeat = repeatAt >= 0 && int.TryParse(args.ElementAtOrDefault(repeatAt + 1), out var times) && times > 0 ? times : 1;
            return RunZd1j(zd1j, channels, decode ? keys : null, seconds, repeat);
        }

        // PIX-DT295 は、鍵もその機材の差し込み口だけから (試験でほかのリーダーに触らない)。--card-url があればそちら
        IKeySource source = Dt295.Parse(device) is { } dt295 && cardAt < 0 ? new LocalCard(() => [Dt295.Card(dt295)]) : Keys.Source;
        using var closing = Dt295.Is(device) ? new Closing(Dt295ResidentBoard.CloseAll) : null;
        using var tuner = TunerPool.OpenDevice(device, lnb);

        Console.WriteLine($"{device} を開きました{(lnb is null ? "" : $" (LNB {lnb})")}");

        foreach (var name in channels)
        {
            var tuning = ChannelTable.Parse(name);
            if (tuning is null)
            {
                Console.Error.WriteLine($"{name}: 選局表にありません");
                return 1;
            }

            var streamId = tuning.StreamId;
            var unit = tuning.Satellite ? "kHz" : "Hz";
            var filter = streamId == ChannelTable.NoStreamId ? "" : $" TSID={streamId}";
            Console.WriteLine($"--- {name}  {tuning.Frequency} {unit}{filter}");

            var started = DateTime.UtcNow;
            try
            {
                tuner.Tune(tuning, streamId);
            }
            catch (IOException error)
            {
                Console.Error.WriteLine($"{name}: {error.Message}");
                continue;
            }
            Console.WriteLine($"    同期 {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");

            Measure(tuner.Output, name, decode ? new Descrambler(source) : null, seconds);
        }

        return 0;
    }

    /// <summary>
    /// CECH-ZD1 J の速さを測る。**冷えた状態から開く・選局からロック・ロックから最初の TS・2 回目の選局 (温かい状態)**
    /// の時間と、I2C の回数、C/N と電波の強さを出す。チャンネルは <c>T27</c> でも <c>27</c> (地上波) でもよい。
    /// 選局のたびに、ロックまでの内訳 (段ごとの時間と待ち) も出す (常駐のときは出さない)。<c>--repeat N</c> はチャンネルの並びを N 回回し、
    /// 最後にロックの成否と時間の最小・中央・最大を出す (選局を縮める工夫で確かさが落ちていないかを見るため)
    /// </summary>
    private static int RunZd1j(string port, string[] channels, IKeySource? keys, TimeSpan seconds, int repeat)
    {
        var once = channels.Select(name => name.All(char.IsAsciiDigit) ? $"T{name}" : name).ToList();
        var names = Enumerable.Repeat(once, repeat).SelectMany(list => list).ToList();
        var locks = new List<long>();
        var decodedAfter = new List<double>();
        var tries = 0;
        // 最後にもう一度、最初のチャンネルを選び直す (温かい状態の選局)
        names.Add(names[0]);
        Zd1jBoard.Trace = message => Console.WriteLine($"    {message}");
        var failed = false;
        var tuner = new Zd1jTuner(port);
        try
        {
            for (var index = 0; index < names.Count; index++)
            {
                var name = names[index];
                if (ChannelTable.Parse(name) is not { } tuning)
                {
                    Console.Error.WriteLine($"{name}: 選局表にありません");
                    return 1;
                }
                var warm = index == names.Count - 1;
                Console.WriteLine($"--- {name}  {tuning.Frequency} Hz{(warm ? "  (2 回目の選局。温かい状態)" : "")}");
                tries++;
                var i2c = tuner.Board?.Bridge.I2cTransfers ?? 0;
                var requests = tuner.Board?.Bridge.Requests ?? 0;
                try
                {
                    tuner.Tune(tuning, ChannelTable.NoStreamId);
                }
                catch (IOException error)
                {
                    Console.Error.WriteLine($"{name}: {error.Message}");
                    failed = true;
                    continue;
                }
                var board = tuner.Board!;
                var timings = tuner.Timings;
                if (index == 0)
                {
                    Console.WriteLine($"    開く (冷えた状態から) {timings.OpenMs} ms  (ブリッジの起動 {board.OpenMs} ms / DiB8096 の初期化 {board.DemodMs} ms)");
                    i2c = 0;
                    requests = 0;
                }
                Console.WriteLine($"    選局からロック {timings.LockMs} ms");
                locks.Add(timings.LockMs);
                if (Measure(tuner.Output, name, keys is null ? null : new Descrambler(keys), seconds, tuner.LockedAt) is { } decodedMs) decodedAfter.Add(decodedMs);
                Console.WriteLine($"    ロックから最初の TS {tuner.Timings.FirstTsMs} ms");
                Console.WriteLine($"    I2C のやり取り {board.Bridge.I2cTransfers - i2c} 回 / メモリ要求 {board.Bridge.Requests - requests} 回 ({(index == 0 ? "開くところからこの選局まで" : "この選局で")})");
                if (tuner.Signal() is { } signal)
                {
                    Console.WriteLine($"    C/N {(signal.CnDb is { } cn ? $"{cn:F1} dB" : "-")}  電波の強さ {signal.StrengthDbm:F1} dBm (目安)  D[568] 0x{signal.Status:X4}");
                }
            }
            if (repeat > 1)
            {
                Console.WriteLine($"=== {tries} 回のうちロック {locks.Count} 回");
                if (locks.Count > 0) Console.WriteLine($"    選局からロック {Spread(locks.Select(ms => (double)ms))}");
                if (decodedAfter.Count > 0) Console.WriteLine($"    ロックから最初の復号できたパケット {Spread(decodedAfter)}");
            }
            return failed ? 1 : 0;
        }
        finally
        {
            tuner.Dispose();
            Zd1jBoard.CloseAll();
        }
    }

    /// <summary>
    /// <c>--card zd1j:&lt;ポート&gt;</c> (<c>dt295:</c> も): **その機材の差し込み口だけ**を開いて、ATR とかかった時間、カードの番号を出す。
    /// ほかのリーダー (本番が使っている USB のリーダーなど) には触らない
    /// </summary>
    private static int OneCard(CardLinkCandidate found, Action close)
    {
        var started = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var link = found.Open();
            var atr = link.Reset();
            Console.WriteLine($"{found.Name}: ATR {Convert.ToHexString(atr)} ({started.ElapsedMilliseconds} ms。開いてカードの電源を入れるまで)");
            var init = BCas.Read(link);
            Console.WriteLine($"{found.Name}: カード {string.Join(" / ", init.Ids.Select(id => id.ToString("D16")))}  CA_system_id 0x{init.CaSystemId:X4} ({started.ElapsedMilliseconds} ms)");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{found.Name}: {Zd1j.Reason(error)} ({started.ElapsedMilliseconds} ms)");
            return 1;
        }
        finally
        {
            close();
        }
    }

    /// <summary>最小・中央・最大 (ms)</summary>
    private static string Spread(IEnumerable<double> values)
    {
        var sorted = values.Order().ToList();
        var middle = sorted.Count % 2 == 1 ? sorted[sorted.Count / 2] : (sorted[sorted.Count / 2 - 1] + sorted[sorted.Count / 2]) / 2;
        return $"最小 {sorted[0]:F0} / 中央 {middle:F0} / 最大 {sorted[^1]:F0} ms";
    }

    /// <summary>
    /// 読めたバイト数と、それが TS の形式になっているか。復号させたなら復号できたか。<paramref name="lockedAt"/> (Stopwatch の時刻) を渡せば、
    /// そこから最初の復号できたパケット (掛かっていた PID の、掛かっていないペイロード) までの ms を出して返す (最初の ECM を待つ時間)
    /// </summary>
    private static double? Measure(Stream stream, string name, Descrambler? b25, TimeSpan duration, long lockedAt = 0)
    {
        var scrambledPids = new HashSet<int>();
        long decodedAt = 0;
        var buffer = new byte[188 * 1024];
        var decoded = new ArrayBufferWriter<byte>();
        var started = DateTime.UtcNow;
        var deadline = started + duration;
        var first = TimeSpan.Zero;
        long total = 0;
        long sync = 0;
        long packets = 0;
        long scrambledIn = 0;
        long outPackets = 0;
        long scrambledOut = 0;
        var continuity = new ContinuityCount();

        while (DateTime.UtcNow < deadline)
        {
            var read = stream.Read(buffer);
            if (read <= 0) break;
            if (total == 0) first = DateTime.UtcNow - started;
            total += read;
            // 188 バイトごとに 0x47 が来ているか。来ていなければ TS ではない
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (buffer[at] == 0x47) sync++;
                continuity.Push(buffer.AsSpan(at, 188), DateTime.UtcNow - started);
                if (!Scrambled(buffer.AsSpan(at))) continue;
                scrambledIn++;
                scrambledPids.Add(Pid(buffer.AsSpan(at)));
            }

            if (b25 is null) continue;

            decoded.ResetWrittenCount();
            b25.Decode(buffer.AsSpan(0, read), decoded);
            for (var at = 0; at + 188 <= decoded.WrittenCount; at += 188)
            {
                outPackets++;
                var packet = decoded.WrittenSpan[at..];
                if (Scrambled(packet)) scrambledOut++;
                else if (decodedAt == 0 && (packet[3] & 0x10) != 0 && scrambledPids.Contains(Pid(packet))) decodedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            }
        }

        var mbps = total * 8.0 / duration.TotalSeconds / 1_000_000;
        var ratio = packets == 0 ? 0 : 100.0 * sync / packets;
        Console.WriteLine(
            $"    最初の 1 バイト {first.TotalMilliseconds:F0} ms  "
            + $"{total / 1024} KiB  {mbps:F2} Mbps  同期バイト {ratio:F1}%");
        if (total == 0) Console.Error.WriteLine($"    {name}: 1 バイトも来ていません");
        Console.WriteLine($"    連続性の飛び {continuity.Jumps} 回 ({continuity.Places.Count} か所。最初の 1 秒は数えない){(continuity.Places.Count == 0 ? "" : "  " + string.Join(" ", continuity.Places.Take(20).Select(place => $"{place.At.TotalSeconds:F1}s({place.Pids} PID)")))}");

        var before = packets == 0 ? 0 : 100.0 * scrambledIn / packets;
        if (b25 is null)
        {
            Console.WriteLine($"    掛かっているパケット {before:F1}%");
            return null;
        }

        var after = outPackets == 0 ? 0 : 100.0 * scrambledOut / outPackets;
        Console.WriteLine($"    掛かっているパケット {before:F1}% -> 復号したあと {after:F1}% ({outPackets} 個)"
            + (b25.LastError is { } why ? $"  {why}" : ""));
        if (lockedAt == 0) return null;
        if (decodedAt == 0)
        {
            Console.WriteLine("    ロックから最初の復号できたパケット - (まだ)");
            return null;
        }
        var ms = System.Diagnostics.Stopwatch.GetElapsedTime(lockedAt, decodedAt).TotalMilliseconds;
        Console.WriteLine($"    ロックから最初の復号できたパケット {ms:F0} ms");
        return ms;
    }

    /// <summary>
    /// スクランブルが掛かっているか。**4 バイト目の上 2 ビット** (transport_scrambling_control)。
    /// 復号できていれば 0 になる
    /// </summary>
    private static bool Scrambled(ReadOnlySpan<byte> packet) => (packet[3] & 0xC0) != 0;

    private static int Pid(ReadOnlySpan<byte> packet) => ((packet[1] & 0x1F) << 8) | packet[2];

    /// <summary>抜けるときに 1 回呼ぶ (using で後始末を並べるため)</summary>
    private sealed class Closing(Action action) : IDisposable
    {
        public void Dispose() => action();
    }
}
