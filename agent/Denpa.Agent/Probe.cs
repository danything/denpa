using System.Buffers;

namespace Denpa.Agent;

/// <summary>
/// 実機で選局を確かめる小道具。**サーバを立てずに1本だけ試す。**
///
/// <para>
/// 掴んだままの選局は、値が1つ違っても「ioctl は通るが同期しない」という
/// 出方をする。単体テストでは踏めないので、実機で当てるための口を用意した
/// (チューナー自動検出のときと同じやり方)。
/// </para>
///
/// <code>
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27
/// denpa-agent --tune /dev/dvb/adapter0/frontend0 BS15_0 --lnb 15v
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27,T21   # 掴んだまま切り替える
/// denpa-agent --tune px4:00001205000960:2 T27               # px4-userland の機材。Q3U4 なら受信機 2 は地上波
/// denpa-agent --tune siano:1-2 T27                          # siano-userland の機材 (smsusb を blacklist した PX-S1UD)
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27 --decode [--card-url http://…]
/// denpa-agent --card                                        # カードリーダーを並べ、カードに INT を通す
/// </code>
///
/// <para>
/// 見るのは3つ。**同期したか・TS の形をしているか・切り替えに何秒かかるか。**
/// 最後は掴み直すのと比べてどれだけ短いかで、ここでしか測れない。
/// </para>
/// </summary>
public static class Probe
{
    /// <summary>1チャンネルあたり読む時間</summary>
    private static readonly TimeSpan Read = TimeSpan.FromSeconds(3);

    /// <summary>
    /// ファイルを1つ解く。**チューナーを使わずに B25 だけ確かめる。**
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
            Console.Error.WriteLine("usage: denpa-agent --decode-file <in.ts> <out.ts>");
            return 2;
        }

        Keys.Configure(Environment.GetEnvironmentVariable("CARD_URL"));
        var b25 = new Descrambler(Keys.Source);
        var decoded = new ArrayBufferWriter<byte>();

        using var input = File.OpenRead(source);
        using var output = File.Create(destination);
        var buffer = new byte[188 * 1024];
        long read;
        long written = 0;
        long scrambled = 0;
        long packets = 0;

        while ((read = input.Read(buffer)) > 0)
        {
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (Scrambled(buffer.AsSpan(at))) scrambled++;
            }
            decoded.ResetWrittenCount();
            b25.Decode(buffer.AsSpan(0, (int)read), decoded);
            output.Write(decoded.WrittenSpan);
            written += decoded.WrittenCount;
        }

        decoded.ResetWrittenCount();
        b25.Flush(decoded);
        output.Write(decoded.WrittenSpan);
        written += decoded.WrittenCount;

        var before = packets == 0 ? 0 : 100.0 * scrambled / packets;
        Console.WriteLine($"{input.Length} -> {written} バイト  元は {before:F1}% が掛かっていました");
        Console.WriteLine($"解いた {b25.Decoded} / 掛かったまま {b25.Undecodable} パケット{(b25.LastError is { } why ? $" ({why})" : "")}");
        return 0;
    }

    /// <summary>
    /// カードリーダーを並べて、カードを開いてみる。**pcscd を通さなくなったので、
    /// 実機でリーダーと話せているかはここで確かめる。**
    /// </summary>
    public static int Card(string[] args)
    {
        Console.WriteLine(Ccid.Describe(reset: true));
        foreach (var found in Px4Card.Find()) Console.WriteLine($"内蔵 {found.Name}");
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
    }

    public static int Run(string[] args)
    {
        var device = args.ElementAtOrDefault(1);
        var channels = args.ElementAtOrDefault(2)?.Split(',') ?? [];
        if (device is null || channels.Length == 0)
        {
            Console.Error.WriteLine("usage: denpa-agent --tune <device> <channel[,channel...]> [--lnb 15v]");
            return 2;
        }

        var lnbAt = Array.IndexOf(args, "--lnb");
        var lnb = lnbAt >= 0 ? args.ElementAtOrDefault(lnbAt + 1) : null;
        var decode = args.Contains("--decode");
        // 手元にカードが無い拠点。鍵だけ貰いに行く (CardShare.cs)
        var cardAt = Array.IndexOf(args, "--card-url");
        Keys.Configure(cardAt >= 0 ? args.ElementAtOrDefault(cardAt + 1) : null);

        var known = Config.FromEnvironment().StreamIds();

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

            var streamId = ChannelTable.StreamId(name, tuning, known);
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

            Measure(tuner.Output, name, decode ? new Descrambler(Keys.Source) : null);
        }

        return 0;
    }

    /// <summary>読めたバイト数と、それが TS の形をしているか。解かせたなら解けたか</summary>
    private static void Measure(Stream stream, string name, Descrambler? b25)
    {
        var buffer = new byte[188 * 1024];
        var decoded = new ArrayBufferWriter<byte>();
        var started = DateTime.UtcNow;
        var deadline = started + Read;
        var first = TimeSpan.Zero;
        long total = 0;
        long sync = 0;
        long packets = 0;
        long scrambledIn = 0;
        long outPackets = 0;
        long scrambledOut = 0;

        while (DateTime.UtcNow < deadline)
        {
            var read = stream.Read(buffer);
            if (read <= 0) break;
            if (total == 0) first = DateTime.UtcNow - started;
            total += read;
            // 188バイトごとに 0x47 が来ているか。来ていなければ TS ではない
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (buffer[at] == 0x47) sync++;
                if (Scrambled(buffer.AsSpan(at))) scrambledIn++;
            }

            if (b25 is null) continue;

            decoded.ResetWrittenCount();
            b25.Decode(buffer.AsSpan(0, read), decoded);
            for (var at = 0; at + 188 <= decoded.WrittenCount; at += 188)
            {
                outPackets++;
                if (Scrambled(decoded.WrittenSpan[at..])) scrambledOut++;
            }
        }

        var mbps = total * 8.0 / Read.TotalSeconds / 1_000_000;
        var ratio = packets == 0 ? 0 : 100.0 * sync / packets;
        Console.WriteLine(
            $"    最初の1バイト {first.TotalMilliseconds:F0} ms  "
            + $"{total / 1024} KiB  {mbps:F2} Mbps  同期バイト {ratio:F1}%");

        var before = packets == 0 ? 0 : 100.0 * scrambledIn / packets;
        if (b25 is null)
        {
            Console.WriteLine($"    掛かっているパケット {before:F1}%");
            return;
        }

        var after = outPackets == 0 ? 0 : 100.0 * scrambledOut / outPackets;
        Console.WriteLine($"    掛かっているパケット {before:F1}% -> 解いたあと {after:F1}% ({outPackets} 個)"
            + (b25.LastError is { } why ? $"  {why}" : ""));
        if (total == 0) Console.Error.WriteLine($"    {name}: 1バイトも来ていません");
    }

    /// <summary>
    /// スクランブルが掛かっているか。**4バイト目の上2ビット** (transport_scrambling_control)。
    /// 解けていれば 0 になる
    /// </summary>
    private static bool Scrambled(ReadOnlySpan<byte> packet) => (packet[3] & 0xC0) != 0;
}
