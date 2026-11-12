using System.Buffers;

namespace Denpa.Agent;

/// <summary>
/// 実機で選局を確かめる小道具。**サーバを立てずに 1 本だけ試す。**
///
/// <para>
/// デバイスを確保したままの選局は、値が 1 つ違っても「ioctl は通るが同期しない」という
/// 出方をする。単体テストでは再現できないので、実機で確かめるためのコマンドを用意した
/// (チューナー自動検出のときと同じやり方)。受けた TS は、量・同期バイトの割合・連続性の飛び (ContinuityCount.cs)・
/// スクランブルされたパケットの割合と、カード無しで分かること (CA_system_id・番組表が来ているか。TsObservation.cs) を出す。
/// </para>
///
/// <code>
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27
/// denpa-agent --tune /dev/dvb/adapter0/frontend0 BS15:16625 --lnb 15v
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27,T21   # 確保したまま切り替える
/// denpa-agent --tune siano:1-2 T27                          # Siano の機材 (smsusb を blacklist した PX-S1UD)。エージェントが USB を直に持つ
/// denpa-agent --tune asicen:1-2:1 T27                       # asicen-userland の機材 (PX-W3U3。試験的。受信機 1 は地上波)
/// denpa-agent --tune zd1j:4-12.1 27 [--decode] [--seconds N] [--repeat N]   # Sony CECH-ZD1 J。開く・ロック・最初の TS (と復号できたパケット)・2 回目の選局の時間と C/N を出す
/// denpa-agent --tune it930x:4-12.1:0 T27                    # IT930x の機材 (PX-MLT5・PX-Q3・PX-W3 系など) の受信機 0。ロックまでの時間と C/N と強度も出す (衛星は BS15:16625 --lnb 15v、J.83B は H40 のように)。TC90522 の機種は TMCC とチューナーに書いた値も出す
/// denpa-agent --tune it930x:4-12.1:0+it930x:4-12.1:1 QC14,T27   # 「+」で並べた受信機を同時に選局する (そろって始め、受信機ごとにまとめて出す)
/// denpa-agent --tune it930x:4-12.1:0+…+it930x:4-12.1:4 T27,T22 --steps 2,3,5   # 流す受信機を 2 → 3 → 5 と足し、ブリッジの状態を出す。TS が止まったらその先は足さない
/// denpa-agent --tune it930x:3-1:1 QC26 --seconds 10 --ecm-test   # ケーブルの 4K (分割 TLV)。組み立てた TLV の数と TlvObservation を出し、ECM を 1 つカードに渡す
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27 --decode [--card-url http://…]
/// denpa-agent --decode-file in.ts out.ts                    # チューナーを使わずに B25 だけ (/denpa/decode と同じ)。CA_system_id と番組表が来ているかも出す
/// denpa-agent --card                                      # カードリーダーを並べ、カードに INT を通す (エージェントを止めて)
/// denpa-agent --card zd1j:4-12.1                            # CECH-ZD1 J の内蔵の差し込み口だけ (ほかのリーダーに触らない)
/// denpa-agent --card dt295:4-12.1                           # PIX-DT295 の差し込み口だけ (ほかのリーダーに触らない)
/// denpa-agent --card it930x:4-12.1                          # IT930x の機材の内蔵カードリーダーだけ (ほかのリーダーに触らない)
/// </code>
///
/// <para>
/// 確かめるのは 3 つ。**同期したか・TS の形式になっているか・切り替えに何秒かかるか。**
/// 最後は取り直すのと比べてどれだけ短いかで、ここでしか測れない。
/// </para>
/// </summary>
public static class Probe
{
    // 使い方の 1 行 (引数が合わないときにここと Program.cs が出す)
    public const string TuneUsage = "denpa-agent --tune <device[+device...]> <channel[,channel...]> [--lnb 15v] [--decode] [--ecm-test (TLV のとき)] [--card-url <url>] [--seconds N] [--repeat N (zd1j: のとき)] [--steps 2,3,5 (it930x: のとき)]";
    public const string DecodeUsage = "denpa-agent --decode-file <in.ts> [<out.ts>]";
    public const string CardUsage = $"denpa-agent --card [{Zd1j.Scheme}<USB のポート> | {Dt295.Scheme}<USB のポート> | {It930x.Scheme}<USB のポート>]";

    /// <summary>1 チャンネルあたり読む時間</summary>
    private static readonly TimeSpan Read = TimeSpan.FromSeconds(3);

    /// <summary>
    /// 鍵を受け取る接続の TTL (<c>CARD_TTL</c>。常駐のときと同じ)。設定が読めなければ、
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
    /// スクランブルされたまま録れてしまったものを復号するのにも使える (denpa からは
    /// <c>/denpa/decode</c> が同じことをする)。
    /// </para>
    ///
    /// <para>
    /// **書き出す先を省くと復号せず、カード無しで分かること (<see cref="TsObservation"/>) だけを出す。** カードを開かず、ECM もどこにも渡さない
    /// (スカパー！プレミアムの TS を、B-CAS のカードを挿した機械で調べるときのため)
    /// </para>
    /// </summary>
    public static int Decode(string[] args)
    {
        var source = args.ElementAtOrDefault(1);
        var destination = args.ElementAtOrDefault(2);
        if (source is null)
        {
            Console.Error.WriteLine($"usage: {DecodeUsage}");
            return 2;
        }
        if (destination is null)
        {
            using var file = File.OpenRead(source);
            Observe(file, Console.Out);
            return 0;
        }

        if (CardHops() is not { } hops) return 2;
        Keys.Configure(Environment.GetEnvironmentVariable("CARD_URL"), hops);
        var b25 = new Descrambler(Keys.Source);
        using var input = File.OpenRead(source);
        using var output = File.Create(destination);
        long scrambled = 0;
        long packets = 0;
        // カード無しで分かること (CA_system_id・番組表が来ているか)。復号する前の TS で数える
        var observation = new TsObservation();
        var written = b25.DecodeAll(input, output, chunk =>
        {
            for (var at = 0; at + 188 <= chunk.Length; at += 188)
            {
                packets++;
                if (Scrambled(chunk[at..])) scrambled++;
                observation.Push(chunk.Slice(at, 188));
            }
        });

        var before = packets == 0 ? 0 : 100.0 * scrambled / packets;
        Console.WriteLine($"{input.Length} -> {written} バイト  元は {before:F1}% がスクランブルされていました");
        Console.WriteLine($"復号した {b25.Decoded} / スクランブルされたまま {b25.Undecodable} パケット{(b25.LastError is { } why ? $" ({why})" : "")}");
        foreach (var line in observation.Describe()) Console.WriteLine(line);
        return 0;
    }

    /// <summary>
    /// 復号せずに、スクランブルされたパケットの割合とカード無しで分かること (<see cref="TsObservation"/>) を書く
    /// (<c>--decode-file &lt;in.ts&gt;</c>)。188 バイトの並びが崩れていたら、0x47 が 188 バイトおきに 2 つ続くところで合わせ直す
    /// </summary>
    internal static void Observe(Stream input, TextWriter output)
    {
        var observation = new TsObservation();
        var buffer = new byte[188 * 1024];
        var filled = 0;
        long packets = 0;
        long scrambled = 0;
        int read;
        while ((read = input.Read(buffer, filled, buffer.Length - filled)) > 0)
        {
            filled += read;
            var at = 0;
            while (filled - at >= 188 * 2)
            {
                if (buffer[at] != 0x47 || buffer[at + 188] != 0x47)
                {
                    at++;
                    continue;
                }
                var packet = buffer.AsSpan(at, 188);
                packets++;
                if (Scrambled(packet)) scrambled++;
                observation.Push(packet);
                at += 188;
            }
            buffer.AsSpan(at, filled - at).CopyTo(buffer);
            filled -= at;
        }
        // 最後の 1 パケットは次の同期バイトで確かめられないので、先頭が 0x47 なら読む
        if (filled >= 188 && buffer[0] == 0x47)
        {
            packets++;
            if (Scrambled(buffer)) scrambled++;
            observation.Push(buffer.AsSpan(0, 188));
        }
        var ratio = packets == 0 ? 0 : 100.0 * scrambled / packets;
        output.WriteLine($"{packets} パケット  {ratio:F1}% がスクランブルされています (復号していません)");
        foreach (var line in observation.Describe()) output.WriteLine(line);
    }

    /// <summary>
    /// カードリーダーを並べて、カードを開いてみる。**pcscd を通さなくなったので、
    /// 実機でリーダーと通信できているかはここで確かめる。**
    /// </summary>
    public static int Card(string[] args)
    {
        if (args.ElementAtOrDefault(1) is { } device)
        {
            if (Dt295.Parse(device) is { } dt295) return OneCard(Dt295.Card(dt295), Dt295NativeDevice.CloseAll);
            if (It930x.CardPort(device) is { } it930x)
            {
                if (It930xCardAt(it930x) is not { } card) return 1;
                return OneCard(card, It930xDevice.CloseAll);
            }
            if (Zd1j.Parse(device) is not { } port)
            {
                Console.Error.WriteLine($"usage: {CardUsage}");
                return 2;
            }
            return OneCard(Zd1j.Card(port), Zd1jBoard.CloseAll);
        }
        Console.WriteLine(Ccid.Describe() ?? PcscLink.Describe());
        foreach (var found in It930x.Cards()) Console.WriteLine($"内蔵 {found.Name}");
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
            Dt295NativeDevice.CloseAll();
        }
    }

    /// <summary>そのポートの IT930x の機材の内蔵カードリーダー。機材が見当たらなければ標準エラー出力に出して null</summary>
    private static CardLinkCandidate? It930xCardAt(string port)
    {
        if (It930x.Identify(port) is { } model) return It930x.Card(port, model);
        Console.Error.WriteLine($"USB のポート {port} に {It930x.Model} が見当たりません");
        return null;
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
        // 選んだ TS が TLV (4K) のとき、MPT が指す ECM を 1 つカードに渡して、鍵を返すかを出す (EcmTestLines)
        var ecmTest = args.Contains("--ecm-test");
        // 手元にカードが無い拠点。鍵だけ受け取る (CardShare.cs)。--card-url が無ければ、--decode-file と同じく CARD_URL を読む
        var cardAt = Array.IndexOf(args, "--card-url");
        // 鍵を受け取る接続の TTL は常駐のときと同じ CARD_TTL (既定 1。CardLan.cs)
        if (CardHops() is not { } hops) return 2;
        Keys.Configure(cardAt >= 0 ? args.ElementAtOrDefault(cardAt + 1) : Environment.GetEnvironmentVariable("CARD_URL"), hops);

        var secondsAt = Array.IndexOf(args, "--seconds");
        var seconds = secondsAt >= 0 && int.TryParse(args.ElementAtOrDefault(secondsAt + 1), out var given) && given > 0
            ? TimeSpan.FromSeconds(given)
            : Read;
        if (Zd1j.Parse(device) is { } zd1j)
        {
            // 保存したロックの値は常駐のときと同じファイルを読み書きする (再起動をまたいで確かめられるように)
            Zd1jBoard.Locks = new Zd1jLocks(Config.FromEnvironment().Zd1jLocksFile);
            // 鍵はそのボードの内蔵の差し込み口だけから (試験でほかのリーダーに触らない)。--card-url があればそちら
            IKeySource keys = cardAt >= 0 ? Keys.Source : new LocalCard(() => [Zd1j.Card(zd1j)]);
            var repeatAt = Array.IndexOf(args, "--repeat");
            var repeat = repeatAt >= 0 && int.TryParse(args.ElementAtOrDefault(repeatAt + 1), out var times) && times > 0 ? times : 1;
            return RunZd1j(zd1j, channels, decode ? keys : null, seconds, repeat);
        }

        // CXD2856ER の地上波のプリセットに使う TMCC も、常駐のときと同じファイルを読み書きする
        Cxd2856Frontend.Presets = new TmccPresets(Config.FromEnvironment().TmccPresetsFile);
        // 「+」で並べると、同じプロセスで複数の受信機を同時に選局する (常駐のときの並べたスキャンと同じ形を、サーバ無しで試す)
        var devices = device.Split('+', StringSplitOptions.RemoveEmptyEntries);
        // --steps 2,3,5: IT930x の機材で、TS を流す受信機を段階を追って増やす (It930xSteps)
        var stepsAt = Array.IndexOf(args, "--steps");
        if (stepsAt >= 0)
        {
            if (It930xSteps.ParseSteps(args.ElementAtOrDefault(stepsAt + 1), devices.Length) is not { } steps)
            {
                Console.Error.WriteLine($"--steps は、受信機の数を 1〜{devices.Length} の増えていく並びで書きます (2,3,5 など)");
                return 2;
            }
            using var closingSteps = new Closing(It930xDevice.CloseAll);
            return It930xSteps.Run(devices, channels, lnb, steps, seconds, Console.Out);
        }
        var options = new TuneProbe(decode, ecmTest);
        if (devices.Length > 1) return RunTogether(devices, channels, lnb, options, cardAt >= 0, seconds);

        var source = KeysFor(device, options.UsesCard, cardAt >= 0);
        using var closing = Closer(device);
        using var tuner = TunerPool.OpenDevice(device, lnb);

        Console.WriteLine($"{device} を開きました{(lnb is null ? "" : $" (LNB {lnb})")}");
        return TuneChannels(tuner, channels, options, source, seconds, Console.Out, Console.Error, null).Error ? 1 : 0;
    }

    /// <summary>その機材の鍵の出どころ。PIX-DT295 と IT930x の機材は、その機材のカードリーダーだけ (試験でほかのリーダーに触らない)。--card-url があればそちら</summary>
    private static IKeySource KeysFor(string device, bool decode, bool cardUrl) =>
        cardUrl ? Keys.Source
        : Dt295.Parse(device) is { } dt295 ? new LocalCard(() => [Dt295.Card(dt295)])
        : decode && It930x.Parse(device) is { } it930xReceiver && It930xCardAt(It930x.CardHost(it930xReceiver.Port)) is { } it930xCard ? new LocalCard(() => [it930xCard])
        : Keys.Source;

    /// <summary>終わりに機材を閉じる (PIX-DT295 と IT930x の機材。ほかは null)</summary>
    private static Closing? Closer(string device) =>
        Dt295.Is(device) ? new Closing(Dt295NativeDevice.CloseAll)
        : It930x.Is(device) ? new Closing(It930xDevice.CloseAll)
        : null;

    /// <summary><c>--tune</c> でカードを使う指定</summary>
    /// <param name="Decode">TS を B25 で復号する (<c>--decode</c>)</param>
    /// <param name="EcmTest">TLV の ECM を 1 つカードに渡す (<c>--ecm-test</c>)</param>
    private sealed record TuneProbe(bool Decode, bool EcmTest)
    {
        /// <summary>カードを開くか</summary>
        public bool UsesCard => Decode || EcmTest;
    }

    /// <summary>1 つのチャンネルの結果 (<see cref="RunTogether"/> の終わりのまとめに使う)</summary>
    private sealed record ChannelResult(string Channel, bool Locked, string? Rate, long Bytes, string? Failure);

    /// <summary>チャンネルの並びを選局した結果。<see cref="Error"/> は選局表に無いなどで途中でやめたとき</summary>
    private sealed record TuneResults(List<ChannelResult> Channels, bool Error);

    /// <summary>
    /// <c>--tune it930x:3-1:0+it930x:3-1:1 …</c>: 並べた受信機ごとにスレッドを立て、そろって始めてから、それぞれがチャンネルの並びを順に選局する。
    /// 出力は受信機ごとにまとめて、終わってから受信機の順に出す (行が混ざらないように)。行は 1 つで選局するときと同じで、チャンネルごとに、そろって始めてからの時間を添える。
    /// 最後に、受信機とチャンネルごとのロックと Mbps を並べる
    /// </summary>
    private static int RunTogether(string[] devices, string[] channels, string? lnb, TuneProbe options, bool cardUrl, TimeSpan seconds)
    {
        if (devices.FirstOrDefault(Zd1j.Is) is { } zd1j)
        {
            Console.Error.WriteLine($"{zd1j}: CECH-ZD1 J は 1 つずつ試します (+ で並べられません)");
            return 2;
        }
        // 閉じるのはどの受信機も終わってから 1 回 (同じ機材をほかの受信機が使っている間に閉じない)
        using var closing = devices.Any(It930x.Is) ? new Closing(It930xDevice.CloseAll) : null;
        using var closingDt295 = devices.Any(Dt295.Is) ? new Closing(Dt295NativeDevice.CloseAll) : null;
        Console.WriteLine($"{devices.Length} つの受信機で同時に選局します: {string.Join(" ", devices)}  チャンネル {string.Join(",", channels)}{(lnb is null ? "" : $"  (LNB {lnb})")}");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        using var start = new Barrier(devices.Length, _ => clock.Restart());
        var outputs = devices.Select(_ => new StringWriter()).ToArray();
        var results = new TuneResults?[devices.Length];
        var threads = devices.Select((name, index) => new Thread(() =>
        {
            var output = outputs[index];
            var waiting = true;
            try
            {
                using var tuner = TunerPool.OpenDevice(name, lnb);
                // 機材を開くのは最初の選局 (そろって始めたあと)。開く・初期化するところも同時に始める
                start.SignalAndWait();
                waiting = false;
                results[index] = TuneChannels(tuner, channels, options, KeysFor(name, options.UsesCard, cardUrl), seconds, output, output, clock);
            }
            catch (Exception error) when (error is IOException or ArgumentException or InvalidOperationException)
            {
                output.WriteLine($"{name}: {error.Message}");
                if (waiting) start.RemoveParticipant();
            }
        })
        { IsBackground = true, Name = $"tune-{index}" }).ToList();
        threads.ForEach(thread => thread.Start());
        threads.ForEach(thread => thread.Join());

        for (var index = 0; index < devices.Length; index++)
        {
            Console.WriteLine($"=== {devices[index]}");
            Console.Write(outputs[index].ToString());
        }
        Console.WriteLine("=== まとめ (受信機・チャンネル・ロック・Mbps)");
        for (var index = 0; index < devices.Length; index++)
        {
            foreach (var row in results[index]?.Channels ?? [])
            {
                Console.WriteLine($"{devices[index]}  {row.Channel}  {(row.Locked ? "ロック" : "失敗")}  {row.Rate ?? "-"} Mbps  {row.Bytes / 1024} KiB{(row.Failure is { } why ? $"  {why}" : "")}");
            }
        }
        return results.Any(result => result is null or { Error: true }) ? 1 : 0;
    }

    /// <summary>
    /// 開いたチューナーでチャンネルを順に選局し、受けた TS を数えて <paramref name="output"/> に書く (<c>--tune</c> の本体)。
    /// <paramref name="together"/> があれば、チャンネルごとに、そろって始めてからの時間 (ms) も添える (<see cref="RunTogether"/>)
    /// </summary>
    private static TuneResults TuneChannels(
        ITuneDevice tuner, string[] channels, TuneProbe options, IKeySource source, TimeSpan seconds, TextWriter output, TextWriter error, System.Diagnostics.Stopwatch? together)
    {
        var decode = options.Decode;
        var results = new List<ChannelResult>();
        var powerProbeShown = false;
        foreach (var name in channels)
        {
            var tuning = ChannelTable.Parse(name);
            if (tuning is null)
            {
                error.WriteLine($"{name}: 選局表にありません");
                return new TuneResults(results, true);
            }

            if (!tuner.Accepts(tuning))
            {
                error.WriteLine(TunerPool.Unaccepted(name, tuning));
                return new TuneResults(results, true);
            }

            var streamId = tuning.StreamId;
            var unit = tuning.Satellite ? "kHz" : "Hz";
            var filter = streamId != ChannelTable.NoStreamId ? $" TSID={streamId}"
                : tuning.IsdbC ? $" ISDB-C  TSMF の有効な TS の {tuning.TsmfIndex} 本目 (0 から数える)" : "";
            var shifted = tuning.ShiftedFrequency is { } other ? $" (ずらした周波数 {other} Hz も試す)" : "";
            var at = together is null ? "" : $"  (そろって始めてから {together.ElapsedMilliseconds} ms)";
            output.WriteLine($"--- {name}  {tuning.Frequency} {unit}{filter}{shifted}{at}");
            // スカパー！プレミアムのカードはまだ扱わないので、--decode でも B-CAS のカードに渡さない (TunerPool の Lease と同じ)
            var descramble = decode && !tuning.Cable;
            if (decode && tuning.Cable) output.WriteLine("    J.83B はスクランブルされたまま受けます (スカパー！プレミアムのカードはまだ扱いません)");

            var started = DateTime.UtcNow;
            try
            {
                tuner.Tune(tuning);
            }
            catch (IOException failure)
            {
                error.WriteLine($"{name}: {failure.Message}");
                results.Add(new ChannelResult(name, false, null, 0, failure.Message));
                ShowPowerProbe(tuner, output, ref powerProbeShown);
                // TC90522 の機種は、失敗したあとも、チューナーに書いた値と PLL の状態、ロックの判定で読む復調器のレジスタを出す (どこで止まったかを切り分けるため)。
                // CXD2856ER の地上波は、プリセットを使ったかとロックのビットが立った時刻を出す
                if (tuner is It930xTuner diagnosed && diagnosed.Diagnose() is { Count: > 0 } lines)
                {
                    output.WriteLine($"    選局に失敗するまで {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");
                    foreach (var line in lines) output.WriteLine($"    {line}");
                }
                // ISDB-C は、どこで失敗したか (ロック・TSMF の判定) と、ロックしていれば変調と C/N も出す
                if (tuning.IsdbC && tuner is It930xTuner failed)
                {
                    output.WriteLine($"    選局に失敗するまで {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");
                    if (failed.CableFrequency is { } tried) output.WriteLine($"    ロックした周波数 {tried} Hz");
                    foreach (var line in TsmfLines(failed.IsdbcLocked, failed.Tsmf)) output.WriteLine($"    {line}");
                    if (failed.IsdbcFailedSignal is { } last)
                    {
                        output.WriteLine($"    {(last.Locked ? "ロック中" : "ロックしていない")}  C/N {(last.Cn is { } lastCn ? $"{lastCn:F1} dB" : "-")}  強度 {(last.StrengthDbm is { } lastDbm ? $"{lastDbm:F1} dBm (目安)" : "-")}");
                        foreach (var line in IsdbcSignalLines(failed.CableModulation, failed.CablePer, failed.IsdbcDetail)) output.WriteLine($"    {line}");
                    }
                    // ロックしたのに TS が 1 パケットも届かなかった (CXD2856 の仕様書 3.5、IT930x の仕様書 6.3)。TS を止めるレジスタを読み、ブリッジのバッファを捨てて選局し直す
                    if (failed.IsdbcLocked && failed.Tsmf is { Received: 0 }) RetryAfterFlush(failed, tuning, name, output);
                }
                // DVB の機材の ISDB-C は、渡した方式と、ロックしていれば TSMF の判定を出す (ロックしなければ Tsmf は null)
                if (tuning.IsdbC && tuner is DvbTuner dvbFailed)
                {
                    output.WriteLine($"    {dvbFailed.CableSystemName}  64QAM  {DvbTuner.CableSymbolRate / 1000} kbaud");
                    foreach (var line in TsmfLines(dvbFailed.Tsmf is not null, dvbFailed.Tsmf)) output.WriteLine($"    {line}");
                }
                continue;
            }
            output.WriteLine($"    同期 {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");
            ShowPowerProbe(tuner, output, ref powerProbeShown);

            if (tuner is It930xTuner it930x)
            {
                output.WriteLine($"    ロックまで {it930x.LockMs} ms (ロックを確かめ始めてから){(it930x.Device is { } opened ? $"  機材を開くのに {opened.OpenMs} ms" : "")}");
                // 衛星は TMCC にある TSID も出す (相対 TS 0〜7 の順。TSID で選んだ TS がこの中継器にあるかを確かめるため)
                if (tuning.Satellite && it930x.SatelliteStreams() is { } streams)
                {
                    output.WriteLine($"    TMCC の TSID  {string.Join(" ", streams.Select((tsid, relative) => $"{relative}:{tsid}"))}");
                }
                if (it930x.CableFrequency is { } locked) output.WriteLine($"    受けた周波数 {locked} Hz");
                // ISDB-C は TSMF の判定と、ヘッダーにある TS の一覧も出す (CXD2856 の仕様書 8.7)
                if (tuning.IsdbC)
                {
                    foreach (var line in TsmfLines(it930x.IsdbcLocked, it930x.Tsmf)) output.WriteLine($"    {line}");
                }
            }
            // DVB の機材の ISDB-C は、渡した方式と受けた周波数、TSMF の判定を出す
            if (tuning.IsdbC && tuner is DvbTuner dvb)
            {
                output.WriteLine($"    {dvb.CableSystemName}  64QAM  {DvbTuner.CableSymbolRate / 1000} kbaud  受けた周波数 {dvb.CableFrequency} Hz");
                foreach (var line in TsmfLines(true, dvb.Tsmf)) output.WriteLine($"    {line}");
            }
            // 選んだ TS が分割 TLV なら、組み立てた TLV を数える。B-CAS のカードに MMT の ECM を渡さないので --decode でも復号しない (TunerPool の Lease と同じ)
            var tlv = tuner.Format == StreamFormat.Tlv;
            if (tlv && descramble) output.WriteLine("    4K の TLV はスクランブルされたまま受けます (ACAS には対応していません)");
            if (!tlv && options.EcmTest) output.WriteLine("    --ecm-test は、選んだ TS が TLV のときだけ試します");
            var measured = tlv
                ? CountTlv(tuner.Output, name, options.EcmTest ? source : null, seconds, output, error)
                : Count(tuner.Output, name, descramble ? new Descrambler(source) : null, seconds, 0, output, error);
            results.Add(new ChannelResult(name, true, measured.Rate, measured.Bytes, measured.Bytes == 0 ? "TS が届かない" : null));
            // ロックしたのに TS が 1 バイトも届かなかった (CXD2856 の仕様書 3.5、IT930x の仕様書 6.3)。TS を止めるレジスタを読み、ブリッジのバッファを捨ててからもう一度受ける
            if (measured.Bytes == 0 && tuner is It930xTuner stalled)
            {
                ShowTsOutput(stalled, output);
                output.WriteLine("    ブリッジの入力を全部閉じて EP 0x84 をリセットし (0xDA1D)、入力を開け直してから、もう一度受けます");
                try
                {
                    stalled.FlushTs();
                    var again = Count(tuner.Output, name, null, seconds, 0, output, error);
                    output.WriteLine(again.Bytes > 0 ? "    バッファを捨てたあと TS が届きました" : "    バッファを捨てても TS は届きません");
                    ShowBridge(stalled.Device, output);
                }
                catch (IOException failure)
                {
                    output.WriteLine($"    バッファを捨てられませんでした ({failure.Message})");
                }
            }
            // IT930x の機材は C/N と強度も出す (受け終えたあとの値)
            if (tuner is It930xTuner receiver && tuner.Signal() is { } signal)
            {
                // 衛星の強度は仕様書の式の dB で、dBm として扱えるかは未確認 (画面には出さない)
                var strength = signal.StrengthDbm is { } dbm ? $"{dbm:F1} dBm (目安)"
                    : receiver.SatelliteLevelDb is { } db ? $"{db:F1} dB (仕様書の式。dBm かは未確認)" : "-";
                output.WriteLine($"    {(signal.Locked ? "ロック中" : "ロックしていない")}  C/N {(signal.Cn is { } cn ? $"{cn:F1} dB" : "-")}  強度 {strength}");
                // J.83B は変調と PER も出す (PER は J.83B で値が正しいかを確かめていない)
                if (tuning.Cable)
                {
                    output.WriteLine($"    変調 {receiver.CableModulation ?? "-"}  PER {(receiver.CablePer is { } per ? $"{per:G3} (未確認の値)" : "-")}");
                }
                // ISDB-C は変調と PER と、ほかに読める値 (CXD2856 の仕様書 9.5。値が正しいかは、ほかの受信機と比べていない)
                if (tuning.IsdbC)
                {
                    foreach (var line in IsdbcSignalLines(receiver.CableModulation, receiver.CablePer, receiver.IsdbcDetail)) output.WriteLine($"    {line}");
                }
            }
            // DVB の機材の ISDB-C も、受け終えたあとの C/N と強度を出す (dB や dBm に直すのはドライバ)
            if (tuning.IsdbC && tuner is DvbTuner && tuner.Signal() is { } dvbSignal)
            {
                output.WriteLine($"    {(dvbSignal.Locked ? "ロック中" : "ロックしていない")}  C/N {(dvbSignal.Cn is { } dvbCn ? $"{dvbCn:F1} {dvbSignal.Unit}" : "-")}  強度 {(dvbSignal.StrengthDbm is { } dvbDbm ? $"{dvbDbm:F1} dBm" : "-")}");
            }
            // ISDB-C は、受け終えたあとの TSMF の数と、出力した TS の PAT の TSID も出す
            if (tuning.IsdbC && tuner.Tsmf is { } tsmf)
            {
                foreach (var line in TsmfAfterLines(tsmf)) output.WriteLine($"    {line}");
                if (tlv && ((tuner as It930xTuner)?.Tlv ?? (tuner as DvbTuner)?.Tlv) is { } split)
                {
                    foreach (var line in SplitTlvLines(split)) output.WriteLine($"    {line}");
                }
            }
            // TC90522 の機種は、TMCC・誤り率・チューナーに書いた値も出す (実機の値を仕様書と照らすため。TC90522 の仕様書 12)。
            // CXD2856ER の地上波は、プリセットを使ったか、ロックのビットが立った時刻、TMCC、モードとガードインターバルを出す (CXD2856 の仕様書 5.8)
            if (tuner is It930xTuner noted)
            {
                foreach (var note in noted.Notes()) output.WriteLine($"    {note}");
            }
        }

        return new TuneResults(results, false);
    }

    /// <summary>
    /// 初期化の前に読んだチューナーの <c>62</c> を、受信機ごとに 1 回出す (CXD2856 の仕様書 10.3。前に ISDB-C か J.83B を選局していて <c>10</c> なら、電源が切れていなかったと推定する)
    /// </summary>
    private static void ShowPowerProbe(ITuneDevice tuner, TextWriter output, ref bool shown)
    {
        if (shown || tuner is not It930xTuner { PowerProbe: { } value }) return;
        shown = true;
        output.WriteLine($"    初期化の前のチューナーの 62: {value:X2} (前に ISDB-C か J.83B を選局していて 10 なら、電源が切れていなかった。推定)");
    }

    /// <summary>TS を止める復調器のレジスタ 4 つと、ロックの状態と、ブリッジの TS の経路の状態を出す (CXD2856 の仕様書 3.5、IT930x の仕様書 6.3)</summary>
    private static void ShowTsOutput(It930xTuner tuner, TextWriter output)
    {
        try
        {
            if (tuner.ReadTsOutput() is { } registers) output.WriteLine($"    {registers.Describe()}");
        }
        catch (IOException failure)
        {
            output.WriteLine($"    復調器の TS の出力のレジスタを読めませんでした ({failure.Message})");
        }
        ShowBridge(tuner.Device, output);
    }

    /// <summary>ブリッジの TS の経路の状態 (<see cref="It930xBridge.ReadTsStatus"/>) と、EP 0x84 の読み出しを数えた値 (<see cref="It930xDevice.DescribeTsCounters"/>) を出す</summary>
    internal static void ShowBridge(It930xDevice? device, TextWriter output, string indent = "    ")
    {
        if (device is null) return;
        try
        {
            output.WriteLine($"{indent}{device.Bridge.ReadTsStatus().Describe()}");
        }
        catch (IOException failure)
        {
            output.WriteLine($"{indent}ブリッジの TS の経路の状態を読めませんでした ({failure.Message})");
        }
        output.WriteLine($"{indent}{device.DescribeTsCounters()}");
    }

    /// <summary>
    /// ISDB-C でロックしたのに TS が 1 パケットも届かず、TSMF の判定で失敗したとき (CXD2856 の仕様書 3.5、IT930x の仕様書 6.3)。TS を止めるレジスタを読み、
    /// ブリッジのバッファを捨ててから同じチャンネルを選局し直して、TS が届くようになったかを出す
    /// </summary>
    private static void RetryAfterFlush(It930xTuner tuner, ChannelTable.Tuning tuning, string name, TextWriter output)
    {
        ShowTsOutput(tuner, output);
        output.WriteLine("    ロックしたのに TS が届きませんでした。ブリッジの入力を全部閉じて EP 0x84 をリセットし (0xDA1D)、入力を開け直してから選局し直します");
        try
        {
            tuner.FlushTs();
            tuner.Tune(tuning);
            output.WriteLine($"    バッファを捨てたあと TS が届きました ({tuner.Tsmf?.Received ?? 0} パケット)");
        }
        catch (IOException failure)
        {
            output.WriteLine($"    バッファを捨てて選局し直しても失敗しました: {name}: {failure.Message}{(tuner.Tsmf is { } tsmf ? $" ({tsmf.Received} パケット)" : "")}");
        }
    }

    /// <summary>
    /// <c>--tune</c> が ISDB-C で出す、ロックと TSMF の判定 (CXD2856 の仕様書 8.6・8.7)。ヘッダーを受けていれば、相対 TS 番号ごとの TSID・original_network_id・有効かどうか・
    /// スロットの数と、選んだ TS、ヘッダーの 188 バイトも出す。TSID と original_network_id の並びは仕様書の推定なので、そう書いて出す
    /// </summary>
    internal static IEnumerable<string> TsmfLines(bool locked, TsmfSelector? tsmf)
    {
        if (!locked || tsmf is null)
        {
            yield return $"ISDB-C: ロックしませんでした ({Cxd2856Frontend.IsdbcLockTimeoutMs} ms の間に、復調と TS のロックがそろわなかった)";
            yield break;
        }
        yield return "ISDB-C: ロックしました";
        var decision = tsmf.Decision;
        if (tsmf.FirstHeader is not { } header)
        {
            yield return decision switch
            {
                TsmfDecision.Passthrough => $"TSMF: ヘッダーなし ({TsmfSelector.NoHeaderPackets} パケットの間に来なかった)。TS が 1 つの搬送波として、そのまま出力します",
                TsmfDecision.Missing => $"TSMF: ヘッダーなし ({TsmfSelector.NoHeaderPackets} パケットの間に来なかった)。TS は 0 本目だけで、指定した {tsmf.Index} 本目はありません",
                _ => $"TSMF: 判定できませんでした (ロックしたが、{tsmf.Received} パケットしか届かなかった。最初の {TsmfSelector.DiscardPackets} パケットは判定に使わずに捨て、"
                    + $"そのあとヘッダーか、ヘッダーの無い {TsmfSelector.NoHeaderPackets} パケットが要る)",
            };
            yield break;
        }
        var valid = header.ValidStreams;
        yield return $"TSMF: ヘッダーあり (バージョン {header.Version}、フレームの種類 {header.FrameType})。有効な TS は {valid.Count} 本";
        for (var relative = 1; relative <= TsmfHeader.Streams; relative++)
        {
            var (tsid, onid) = header.Ids[relative - 1];
            var slots = header.SlotsOf(relative);
            // 無効で、スロットも ID も無い相対 TS 番号は出さない
            if (!header.IsValid(relative) && slots == 0 && tsid == 0 && onid == 0) continue;
            var index = header.IsValid(relative) ? valid.ToList().IndexOf(relative) : -1;
            var order = index < 0 ? "" : $"  {index} 本目{(decision == TsmfDecision.Selected && relative == tsmf.Relative ? " (選んだ TS)" : "")}";
            yield return $"  相対 TS 番号 {relative}: {(header.IsValid(relative) ? "有効" : "無効")}  TSID 0x{tsid:X4} ({tsid})  ONID 0x{onid:X4}  "
                + $"{(header.IsTs(relative) ? "MPEG-2 TS" : "分割 TLV")}  スロット {slots}{order}";
        }
        yield return "  (TSID と ONID の並びは仕様書の推定。下の PAT の TSID と比べる)";
        if (decision == TsmfDecision.Selected && tsmf.Format == StreamFormat.Tlv) yield return "TSMF: 選んだ TS は分割 TLV です。TLV に組み立てて出力します";
        if (decision == TsmfDecision.Missing)
        {
            yield return valid.Count == 0
                ? $"指定した {tsmf.Index} 本目はありません (有効な TS が 1 本も無い)"
                : $"指定した {tsmf.Index} 本目はありません (:0〜:{valid.Count - 1} を指定する)";
        }
        yield return $"  受信の状態と緊急のフラグ (バイト 69〜72。並びは推定) {Convert.ToHexString(header.Status)}";
        yield return $"  ヘッダーのパケット {Convert.ToHexString(header.Raw)}";
    }

    /// <summary>
    /// <c>--tune</c> が ISDB-C で受け終えたあとに出す、TSMF の数と、出力した TS の PAT の TSID (ヘッダーの TSID の並びの推定を確かめるため。CXD2856 の仕様書 8.7)。
    /// 選んだ TS のパケットが欠けたときに、選ぶ前 (搬送波から受けたまま) で欠けていたのか、選ぶ処理で欠けたのかを分けられるように、
    /// 選んだ TS のスロットに来た数と出力した数、選ぶ前とあとの連続性の飛びも出す
    /// </summary>
    internal static IEnumerable<string> TsmfAfterLines(TsmfSelector tsmf)
    {
        yield return $"TSMF: 受けたパケット {tsmf.Received}  ヘッダー {tsmf.Headers}  CRC が合わないヘッダー {tsmf.BadHeaders}  "
            + $"ヘッダーの位置に来たほかのパケット {tsmf.MissedHeaders}  そろわずに捨てたフレーム {tsmf.BrokenFrames}";
        yield return $"TSMF: 前のヘッダーの割り当てで受けたフレーム {tsmf.HeldFrames}  スロットの割り当てが変わったヘッダー {tsmf.MappingChanges}";
        var perFrame = tsmf.SlotsPerFrame is { } slots
            ? $"1 フレームの選んだ TS のスロット {(slots.Fewest == slots.Most ? $"{slots.Most}" : $"{slots.Fewest}〜{slots.Most}")} / {TsmfHeader.SlotCount}  "
            : "";
        yield return $"TSMF: {perFrame}選んだ TS のスロットに来たパケット {tsmf.Expected}  出力したパケット {tsmf.Emitted}";
        var (beforeJumps, beforeErrors) = tsmf.ContinuityBefore;
        var (afterJumps, afterErrors) = tsmf.ContinuityAfter;
        yield return $"TSMF: 連続性の飛び (最初の 1 秒も数える) 選ぶ前 {beforeJumps} 回  選んだあと {afterJumps} 回  "
            + $"transport_error_indicator が 1 のパケット 選ぶ前 {beforeErrors}  選んだあと {afterErrors}";
        if (tsmf.Decision == TsmfDecision.Selected && tsmf.LastHeader is { } last && !last.IsValid(tsmf.Relative))
        {
            yield return $"TSMF: 選んだ相対 TS 番号 {tsmf.Relative} が、最後のヘッダーでは無効になっています (出力を止めている)";
        }
        if (tsmf.FormatChanged) yield return $"TSMF: 選んだ TS の種類がヘッダーで変わったため、出力を止めました ({It930xTsOutput.FormatChangedReason})";
        // 分割 TLV には PAT が無い (TLV の数は SplitTlvLines が出す)
        if (tsmf.Format == StreamFormat.Tlv) yield break;
        var listed = tsmf.Decision == TsmfDecision.Selected && tsmf.FirstHeader is { } first ? first.Ids[tsmf.Relative - 1].Tsid : (ushort?)null;
        yield return tsmf.PatTsid is { } pat
            ? $"出力した TS の PAT の TSID 0x{pat:X4} ({pat}){(listed is { } tsid ? tsid == pat ? "  ヘッダーの TSID と同じ" : $"  ヘッダーの TSID 0x{tsid:X4} と違う" : "")}"
            : "出力した TS の PAT は来ませんでした";
    }

    /// <summary><c>--tune</c> が、選んだ TS が分割 TLV のときに受け終えたあとに出す、TLV パケットに組み立てた数 (<see cref="SplitTlv"/>)</summary>
    internal static IEnumerable<string> SplitTlvLines(SplitTlv tlv)
    {
        yield return $"分割 TLV: 受けた単位 {tlv.Units}  開始の単位 {tlv.Starts}  組み立てた TLV パケット {tlv.Packets}  "
            + $"捨てたバイト {tlv.DroppedBytes}  合わせ直した回数 (中身の食い違い) {tlv.Resyncs}  (フレームの欠け) {tlv.Breaks}";
        var types = string.Join("  ", tlv.ByType.Select(pair => $"{SplitTlv.Types.GetValueOrDefault(pair.Type, "?")} (0x{pair.Type:X2}) {pair.Count}"));
        yield return $"分割 TLV: TLV パケットの種類 {(types.Length == 0 ? "-" : types)}";
        if (tlv.OtherHeaders > 0) yield return $"分割 TLV: ヘッダーが 47 00 2D・47 40 2D でない単位 {tlv.OtherHeaders} (読み方は変えていない)";
    }

    /// <summary>
    /// <c>--ecm-test</c>: TLV で受けた ECM のセクション (<see cref="TlvObservation.Ecm"/>) を、B-CAS の ECM と同じ切り方 (先頭 8 バイトと末尾の CRC を除いた中身。
    /// <see cref="Descrambler"/> と同じ) でカードに渡し、鍵を返したかを出す。MMT の復号はしない (4K の放送を B-CAS のカードで復号できるかを確かめるだけ)
    /// </summary>
    internal static IEnumerable<string> EcmTestLines(TlvObservation observation, IKeySource source)
    {
        if (observation.Ecm is not { } ecm)
        {
            yield return observation.AccessControl.Count == 0
                ? "ECM の試験: MPT のアクセス制御記述子が来なかったため、ECM の packet_id が分かりません"
                : $"ECM の試験: 受けた間に ECM ({string.Join(" ", observation.AccessControl.Select(ca => $"0x{ca.Pid:X4}"))}) が来ませんでした";
            yield break;
        }
        var section = ecm.Section;
        yield return $"ECM の試験: packet_id 0x{ecm.Pid:X4} の ECM (table_id 0x{section[0]:X2}、{section.Length} バイト。カードに渡すのは {section.Length - 12} バイト) をカードに渡します";
        string result;
        try
        {
            var init = source.Init();
            var answer = source.Ecm(section.AsSpan(8, section.Length - 12));
            // 0x0200・0x0400・0x0800 が「視聴できる」(Descrambler と同じ)
            var entitled = answer.Code is 0x0200 or 0x0400 or 0x0800;
            result = $"カードの CA_system_id 0x{init.CaSystemId:X4}。"
                + (entitled
                    ? $"カードが鍵を返しました (0x{answer.Code:X4})。その鍵で MMT を復号できるかは、この試験では確かめていません"
                    : $"カードが鍵を返しません (0x{answer.Code:X4})");
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or CardRefusedException)
        {
            result = $"カードとやり取りできませんでした ({error.Message})";
        }
        yield return $"ECM の試験: {result}";
    }

    /// <summary>
    /// <c>--tune</c> が ISDB-C で出す、変調と PER (CXD2856 の仕様書 9.4) と、ほかに読める値 (CXD2856 の仕様書 9.5)。PER と 9.5 の値は、正しいかをほかの受信機と比べていないので、未確認と書いて出す
    /// </summary>
    internal static IEnumerable<string> IsdbcSignalLines(string? modulation, double? per, CxdIsdbcDetail? detail)
    {
        yield return $"変調 {modulation ?? "-"}  PER {(per is { } value ? $"{value:G3} (未確認の値)" : "-")}";
        if (detail is null) yield break;
        yield return "ほかの値 (未確認の読み方)  "
            + $"反転 {(detail.Inverted is { } inverted ? inverted ? "あり" : "なし" : "-")}  "
            + $"搬送波のずれ {(detail.CarrierOffsetKhz is { } offset ? $"{offset:F1} kHz" : "-")}  "
            + $"シンボルレート {(detail.SymbolRateMsps is { } rate ? $"{rate:F4} Msps" : "-")}  "
            + $"RS の前の BER {(detail.PreRsBer is { } ber ? $"{ber:G3}" : "-")}  "
            + $"直せなかったパケット {(detail.Uncorrected is { } count ? $"{count}" : "-")}  "
            + $"IF の AGC {detail.IfAgc}";
    }

    /// <summary>
    /// CECH-ZD1 J の速さを測る。**冷えた状態から開く・選局からロック・ロックから最初の TS・2 回目の選局 (温かい状態)**
    /// の時間と、I2C の回数、C/N と電波の強度を出す。チャンネルは <c>T27</c> でも <c>27</c> (地上波) でもよい。
    /// 選局のたびに、ロックまでの内訳 (段ごとの時間と待ち) も出す (常駐のときは出さない)。<c>--repeat N</c> はチャンネルの並びを N 回回し、
    /// 最後にロックの成否と時間の最小・中央・最大を出す (選局を縮める工夫で確かさが落ちていないかを確かめるため)
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
                    tuner.Tune(tuning);
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
                    Console.WriteLine($"    C/N {(signal.CnDb is { } cn ? $"{cn:F1} dB" : "-")}  電波の強度 {signal.StrengthDbm:F1} dBm (目安)  D[568] 0x{signal.Status:X4}");
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
    /// <c>--card zd1j:&lt;ポート&gt;</c> (<c>dt295:</c>・<c>it930x:</c> も): **その機材の差し込み口だけ**を開いて、ATR とかかった時間、カードの番号を出す。
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
            Console.Error.WriteLine($"{found.Name}: {UsbDevices.Reason(error)} ({started.ElapsedMilliseconds} ms)");
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
    /// 平均の Mbps。**最初の読み出しから最後の読み出しまでで割る** (最初の読み出しのぶんは除く。<c>--dt295-probe</c> と同じ)。
    /// 決めた秒数で割ると、最初の TS が遅れたぶん少なく出る。読み出しが 1 回だけなら測れないので null
    /// </summary>
    internal static double? Rate(long total, long firstChunk, TimeSpan receiving) =>
        receiving > TimeSpan.Zero ? (total - firstChunk) * 8.0 / receiving.TotalSeconds / 1_000_000 : null;

    /// <summary>
    /// 読めたバイト数と、それが TS の形式になっているか。復号させたなら復号できたか。<paramref name="lockedAt"/> (Stopwatch の時刻) を渡せば、
    /// そこから最初の復号できたパケット (スクランブルされていた PID の、スクランブルされていないペイロード) までの ms を出して返す (最初の ECM を待つ時間)
    /// </summary>
    internal static double? Measure(Stream stream, string name, Descrambler? b25, TimeSpan duration, long lockedAt = 0) =>
        Count(stream, name, b25, duration, lockedAt, Console.Out, Console.Error).DecodedMs;

    /// <summary><see cref="Count"/> の結果。Rate は書き出した Mbps の文字 (測れなければ null)</summary>
    private readonly record struct Counted(double? DecodedMs, long Bytes, string? Rate);

    /// <summary><see cref="Measure"/> の本体。書き出す先を選べる (<c>--tune</c> で受信機を並べたときは、受信機ごとの出力に書く)</summary>
    private static Counted Count(Stream stream, string name, Descrambler? b25, TimeSpan duration, long lockedAt, TextWriter output, TextWriter error)
    {
        var scrambledPids = new HashSet<int>();
        long decodedAt = 0;
        var buffer = new byte[188 * 1024];
        var decoded = new ArrayBufferWriter<byte>();
        var started = DateTime.UtcNow;
        var deadline = started + duration;
        var first = TimeSpan.Zero;
        var last = TimeSpan.Zero;
        long firstChunk = 0;
        long total = 0;
        long sync = 0;
        long packets = 0;
        long scrambledIn = 0;
        long outPackets = 0;
        long scrambledOut = 0;
        var continuity = new ContinuityCount();
        // ContinuityCount が数えない最初の 1 秒の、連続性の飛びと transport_error_indicator が 1 のパケット (選局を速くしたぶん誤りが増えていないかを見るため)
        var firstSecond = new ContinuityTracker();
        // カード無しで分かること (CA_system_id・番組表が来ているか)。復号する前の TS で数える
        var observation = new TsObservation();

        while (DateTime.UtcNow < deadline)
        {
            // DeviceStream は TS が来ない間は戻らないので、決めた時間で読み出しを抜ける合図を渡す
            var read = stream is DeviceStream device ? device.Read(buffer, 0, buffer.Length, () => DateTime.UtcNow >= deadline) : stream.Read(buffer);
            if (read <= 0) break;
            last = DateTime.UtcNow - started;
            if (total == 0)
            {
                first = last;
                firstChunk = read;
            }
            total += read;
            // 188 バイトごとに 0x47 が来ているか。来ていなければ TS ではない
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (buffer[at] == 0x47) sync++;
                continuity.Push(buffer.AsSpan(at, 188), DateTime.UtcNow - started);
                if (DateTime.UtcNow - started < TimeSpan.FromSeconds(1)) firstSecond.Push(buffer.AsSpan(at, 188));
                observation.Push(buffer.AsSpan(at, 188));
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

        var rated = Rate(total, firstChunk, last - first) is { } rate ? $"{rate:F2}" : null;
        var ratio = packets == 0 ? 0 : 100.0 * sync / packets;
        output.WriteLine(
            $"    最初の 1 バイト {first.TotalMilliseconds:F0} ms  "
            + $"{total / 1024} KiB  {rated ?? "-"} Mbps  同期バイト {ratio:F1}%");
        if (total == 0) error.WriteLine($"    {name}: 1 バイトも来ていません");
        output.WriteLine($"    最初の 1 秒  連続性の飛び {firstSecond.Jumps} 回  transport_error_indicator が 1 のパケット {firstSecond.Errors} 個");
        output.WriteLine($"    連続性の飛び {continuity.Jumps} 回 ({continuity.Places.Count} か所。最初の 1 秒は数えない){(continuity.Places.Count == 0 ? "" : "  " + string.Join(" ", continuity.Places.Take(20).Select(ContinuityCount.Describe)))}");

        foreach (var line in observation.Describe()) output.WriteLine($"    {line}");

        var before = packets == 0 ? 0 : 100.0 * scrambledIn / packets;
        if (b25 is null)
        {
            output.WriteLine($"    スクランブルされたパケット {before:F1}%");
            return new Counted(null, total, rated);
        }

        var after = outPackets == 0 ? 0 : 100.0 * scrambledOut / outPackets;
        output.WriteLine($"    スクランブルされたパケット {before:F1}% -> 復号したあと {after:F1}% ({outPackets} 個)"
            + (b25.LastError is { } why ? $"  {why}" : ""));
        if (lockedAt == 0) return new Counted(null, total, rated);
        if (decodedAt == 0)
        {
            output.WriteLine("    ロックから最初の復号できたパケット - (まだ)");
            return new Counted(null, total, rated);
        }
        var ms = System.Diagnostics.Stopwatch.GetElapsedTime(lockedAt, decodedAt).TotalMilliseconds;
        output.WriteLine($"    ロックから最初の復号できたパケット {ms:F0} ms");
        return new Counted(ms, total, rated);
    }

    /// <summary>
    /// TLV (4K。<see cref="StreamFormat.Tlv"/>) を受けて、量とカード無しで分かること (<see cref="TlvObservation"/>) を書く。
    /// <paramref name="ecm"/> があれば、受け終えたあとに ECM を 1 つカードに渡す (<c>--ecm-test</c>。<see cref="EcmTestLines"/>)
    /// </summary>
    private static Counted CountTlv(Stream stream, string name, IKeySource? ecm, TimeSpan duration, TextWriter output, TextWriter error)
    {
        var buffer = new byte[188 * 1024];
        var started = DateTime.UtcNow;
        var deadline = started + duration;
        var first = TimeSpan.Zero;
        var last = TimeSpan.Zero;
        long firstChunk = 0;
        long total = 0;
        var observation = new TlvObservation();
        while (DateTime.UtcNow < deadline)
        {
            var read = stream is DeviceStream device ? device.Read(buffer, 0, buffer.Length, () => DateTime.UtcNow >= deadline) : stream.Read(buffer);
            if (read <= 0) break;
            last = DateTime.UtcNow - started;
            if (total == 0)
            {
                first = last;
                firstChunk = read;
            }
            total += read;
            observation.Feed(buffer.AsSpan(0, read));
        }
        var rated = Rate(total, firstChunk, last - first) is { } rate ? $"{rate:F2}" : null;
        output.WriteLine($"    最初の 1 バイト {first.TotalMilliseconds:F0} ms  {total / 1024} KiB  {rated ?? "-"} Mbps  (TLV)");
        if (total == 0) error.WriteLine($"    {name}: 1 バイトも来ていません");
        foreach (var line in observation.Describe()) output.WriteLine($"    {line}");
        if (ecm is not null)
        {
            foreach (var line in EcmTestLines(observation, ecm)) output.WriteLine($"    {line}");
        }
        return new Counted(null, total, rated);
    }

    /// <summary>
    /// スクランブルされているか。**4 バイト目の上 2 ビット** (transport_scrambling_control)。
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
