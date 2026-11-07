using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// <c>denpa-agent --stream-bench</c>: 動いているエージェントの <c>/denpa/stream</c> (本番の選局と同じ道。TunerPool を通る) に、
/// 名指しのチューナーで選局を頼み、時間を測る。DVB (PT3 など) と PIX-DT295 を同じ物差しで比べるための道具。
///
/// <para>
/// 測るもの: 要求から応答のヘッダまで (エージェントが選局してロックを確かめるまで。TunerPool の確保と、選局し直しが要るかの判断を含む)、
/// 最初の本体のバイトまで、最初のバイトから最後のバイトまでの平均の Mbps。<c>--agent-pid</c> を付けると、エージェントのプロセスの CPU 時間
/// (Linux の /proc) も出す。測る間の CPU はエージェント全体のもので、ほかの利用者がいれば混ざる
/// </para>
///
/// <para>
/// **本番のチューナーを邪魔しない。** 使うのは、<c>/denpa/tuners</c> で見て、無効でなく、選局も利用者もいない空きのチューナーだけで、
/// 空きでなければ何もせずに止まる。要求の優先度は −1000 で、本番の要求が来たら先に取り上げられる。
/// DVB は一度合わせたチャンネルが残っていると選局し直さないので、<c>--alt</c> のチャンネルを先に 1 秒受けて、離れてから測る
/// </para>
/// </summary>
public static class StreamBench
{
    public const string Usage = "denpa-agent --stream-bench --tuner <名指しの目印かデバイスの一部> --channel <T25 など> [--type GR|BS|CS] [--alt <チャンネル>] [--seconds N] [--runs R] [--agent-pid N]";

    public static async Task<int> Run(string[] args, string tlsDir, string host, int port)
    {
        string? Value(string name)
        {
            var at = Array.IndexOf(args, name);
            return at >= 0 ? args.ElementAtOrDefault(at + 1) : null;
        }
        var tuner = Value("--tuner");
        var channel = Value("--channel");
        if (tuner is null || channel is null)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var type = Value("--type") ?? (channel.StartsWith("BS", StringComparison.OrdinalIgnoreCase) ? "BS" : channel.StartsWith("CS", StringComparison.OrdinalIgnoreCase) ? "CS" : "GR");
        var seconds = int.TryParse(Value("--seconds"), NumberStyles.None, CultureInfo.InvariantCulture, out var s) && s > 0 ? s : 6;
        var runs = int.TryParse(Value("--runs"), NumberStyles.None, CultureInfo.InvariantCulture, out var r) && r > 0 ? r : 1;
        var alt = Value("--alt");
        var pid = int.TryParse(Value("--agent-pid"), NumberStyles.None, CultureInfo.InvariantCulture, out var p) ? p : (int?)null;
        if (!File.Exists(Path.Combine(tlsDir, "agent.crt")) || !File.Exists(Path.Combine(tlsDir, "agent.key")))
        {
            Console.Error.WriteLine($"{tlsDir} に agent.key / agent.crt がありません");
            return 1;
        }

        using var client = AgentTls.OwnClient(tlsDir, Timeout.InfiniteTimeSpan);
        var baseUrl = $"https://{(host.Contains(':') ? $"[{host}]" : host)}:{port}";

        try
        {
            var pin = await Pick(client, baseUrl, tuner, type);
            if (pin is null) return 1;
            Console.WriteLine($"チューナー {pin} で {channel} を {runs} 回 ({seconds} 秒ずつ)");
            var ticks = Linger();
            for (var run = 1; run <= runs; run++)
            {
                if (alt is not null)
                {
                    await Fetch(client, baseUrl, type, alt, pin, 1, null);
                    await Task.Delay(ticks);
                }
                if (await Pick(client, baseUrl, tuner, type) is null) return 1;
                var result = await Fetch(client, baseUrl, type, channel, pin, seconds, pid);
                Console.WriteLine($"{run,3}: {result}");
                await Task.Delay(ticks);
            }
            return 0;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or IOException)
        {
            Console.Error.WriteLine($"エージェントに繋がりません: {error.GetBaseException().Message}");
            return 1;
        }
    }

    /// <summary>誰も読まなくなってから選局を畳むまでの間 (TunerPool.Linger) より少し長く待つ</summary>
    private static TimeSpan Linger() => TunerPool.Linger + TimeSpan.FromSeconds(1.5);

    /// <summary>
    /// <c>/denpa/tuners</c> から名指しのチューナーを探す。空きでなければ理由を出して null (測らない)。
    /// 目印 (pin) の完全一致か、デバイスやチューナー名に含まれる文字列で探し、1 台に決まらなければ断る
    /// </summary>
    private static async Task<string?> Pick(HttpClient client, string baseUrl, string wanted, string type)
    {
        using var response = await client.GetAsync($"{baseUrl}/denpa/tuners");
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            Console.Error.WriteLine($"/denpa/tuners: {(int)response.StatusCode} {body}");
            return null;
        }
        var list = (JsonNode.Parse(body) as JsonObject)?["tuners"] as JsonArray ?? [];
        var matches = list.OfType<JsonObject>().Where(item =>
            string.Equals(item["pin"]?.GetValue<string>(), wanted, StringComparison.Ordinal)
            || (item["device"]?.GetValue<string>() ?? "").Contains(wanted, StringComparison.Ordinal)
            || (item["name"]?.GetValue<string>() ?? "").Contains(wanted, StringComparison.Ordinal)).ToList();
        if (matches.Count != 1)
        {
            Console.Error.WriteLine(matches.Count == 0
                ? $"「{wanted}」に当たるチューナーがありません"
                : $"「{wanted}」に当たるチューナーが {matches.Count} 台あります。--tuner をもっと絞ってください ({string.Join(", ", matches.Select(item => item["pin"]?.GetValue<string>()))})");
            return null;
        }
        var tuner = matches[0];
        var name = tuner["name"]?.GetValue<string>() ?? "?";
        if (tuner["disabled"]?.GetValue<bool>() == true)
        {
            Console.Error.WriteLine($"{name} は無効です。測りません");
            return null;
        }
        var types = (tuner["types"] as JsonArray)?.Select(node => node?.GetValue<string>()).ToList() ?? [];
        if (!types.Contains(type))
        {
            Console.Error.WriteLine($"{name} は {type} を受けません ({string.Join(", ", types)})");
            return null;
        }
        // 選局も利用者もいない空きのときだけ測る
        var busy = tuner["channel"] is JsonObject || (tuner["users"] as JsonArray)?.Count > 0;
        if (busy)
        {
            Console.Error.WriteLine($"{name} は使われています (利用者 {(tuner["users"] as JsonArray)?.Count ?? 0}、{(tuner["channel"] as JsonObject)?["channel"]})。測りません");
            return null;
        }
        return tuner["pin"]?.GetValue<string>();
    }

    private static async Task<string> Fetch(HttpClient client, string baseUrl, string type, string channel, string pin, int seconds, int? pid)
    {
        var url = $"{baseUrl}/denpa/stream?type={Uri.EscapeDataString(type)}&channel={Uri.EscapeDataString(channel)}&use={Uri.EscapeDataString("bench")}&priority=-1000&tuner={Uri.EscapeDataString(pin)}";
        var cpu0 = pid is { } id ? CpuTicks(id) : null;
        var clock = Stopwatch.StartNew();
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        var headers = clock.Elapsed.TotalMilliseconds;
        if (!response.IsSuccessStatusCode)
        {
            return $"失敗 {(int)response.StatusCode} ({(await response.Content.ReadAsStringAsync()).Trim()}) {headers:F0} ms";
        }
        await using var stream = await response.Content.ReadAsStreamAsync();
        var buffer = new byte[188 * 1024];
        double first = -1, last = 0;
        long bytes = 0, firstChunk = 0;
        using var cancel = new CancellationTokenSource();
        try
        {
            while (true)
            {
                var got = await stream.ReadAsync(buffer, cancel.Token);
                if (got == 0) break;
                var now = clock.Elapsed.TotalMilliseconds;
                if (first < 0)
                {
                    first = now;
                    firstChunk = got;
                    cancel.CancelAfter(TimeSpan.FromSeconds(seconds));
                }
                last = now;
                bytes += got;
            }
        }
        catch (OperationCanceledException)
        {
        }
        var cpu1 = pid is { } id2 ? CpuTicks(id2) : null;
        var mbps = last > first && first >= 0 ? (bytes - firstChunk) * 8 / ((last - first) / 1000.0) / 1e6 : 0;
        var cpu = cpu0 is { } a && cpu1 is { } b ? $"、エージェントの CPU {(b - a) * 1000.0 / ClockTicks():F0} ms" : "";
        return first < 0
            ? $"本体が来ませんでした (ヘッダまで {headers:F0} ms)"
            : $"ヘッダまで {headers:F0} ms (選局とロック)、最初のバイトまで {first:F0} ms、平均 {mbps:F2} Mbps ({(last - first) / 1000.0:F1} 秒、{bytes} バイト){cpu}";
    }

    /// <summary>/proc/&lt;pid&gt;/stat の utime + stime (時計の刻み)。Linux 以外や読めなければ null</summary>
    private static long? CpuTicks(int pid)
    {
        try
        {
            var text = File.ReadAllText($"/proc/{pid}/stat");
            // 2 つ目の欄 (コマンド名) は括弧で囲まれ、空白を含みうる。最後の ')' のあとから数える
            var fields = text[(text.LastIndexOf(')') + 2)..].Split(' ');
            return long.Parse(fields[11], CultureInfo.InvariantCulture) + long.Parse(fields[12], CultureInfo.InvariantCulture);
        }
        catch (Exception error) when (error is IOException or FormatException or IndexOutOfRangeException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>1 秒あたりの時計の刻み。Linux の USER_HZ は 100</summary>
    private static double ClockTicks() => 100.0;
}
