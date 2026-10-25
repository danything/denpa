using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// ログ。標準出力 (`kubectl logs` で読む) に出し、**直近の分をメモリにも残す。**
///
/// <para>
/// distroless のイメージにはシェルが無く、標準出力を読めない人もいる。残した分は
/// <c>GET /denpa/logs</c> で返し、設定の「その他」の「ログ」に出す。メモリだけなので再起動で消える。
/// </para>
/// </summary>
public static class Log
{
    public static readonly LogRing Recent = new(2000);

    public static void Write(string message)
    {
        Recent.Add(message);
        Console.WriteLine($"[agent] {message}");
    }
}

/// <summary>直近の行を決まった数だけ持つリングバッファ。いろいろなスレッドから書かれるので、ロックを取って触る</summary>
public sealed class LogRing(int capacity)
{
    private readonly (long At, string Text)[] lines = new (long, string)[capacity];
    private readonly Lock gate = new();
    private int next;
    private int count;

    public void Add(string text)
    {
        // 時刻はロックの中で取る。外で取ると、同時に書かれたときに古い順が崩れる
        lock (gate)
        {
            lines[next] = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), text);
            next = (next + 1) % lines.Length;
            if (count < lines.Length) count++;
        }
    }

    /// <summary>古い順に写して返す</summary>
    public (long At, string Text)[] Snapshot()
    {
        lock (gate)
        {
            var copy = new (long, string)[count];
            var start = (next - count + lines.Length) % lines.Length;
            for (var i = 0; i < count; i++) copy[i] = lines[(start + i) % lines.Length];
            return copy;
        }
    }

    /// <summary><c>GET /denpa/logs</c> の形式: <c>{"lines":[{"at":ミリ秒,"text":"…"}]}</c></summary>
    public JsonObject ToJson() => new()
    {
        ["lines"] = new JsonArray([.. Snapshot().Select(line =>
            (JsonNode)new JsonObject { ["at"] = line.At, ["text"] = line.Text })]),
    };
}

/// <summary>
/// JSON の書き方。**組み立ては <c>JsonNode</c> だけでやる。**
///
/// <para>
/// Native AOT では、型からリフレクションで書き出す方式が使えない。読むもの (設定・denpa から来るもの・
/// <c>px4d --list-json</c>) も木のまま読む (Px4.cs の <c>JsonShape</c>)。
/// </para>
/// </summary>
public static class Json
{
    /*
     * **日本語をそのまま書く。** 既定では非ASCIIを `\u3042` に逃がすので、
     * `channels.json` が人の目で読めなくなる (局名は全部日本語)。
     * ここは HTML に埋めるものではないので、逃がす理由が無い
     */
    private static readonly JavaScriptEncoder Relaxed = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;

    /// <summary>控えのファイル用。手で開いて確かめられる形式にする</summary>
    public static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IndentSize = 4,
        Encoder = Relaxed,
    };

    /// <summary>API から返すもの。読むのは denpa なので詰めて出す</summary>
    public static readonly JsonSerializerOptions Compact = new() { Encoder = Relaxed };

    /// <summary>文字列の並びを JSON の配列に</summary>
    public static JsonArray Strings(IEnumerable<string> values) => [.. values.Select(value => (JsonNode)value)];

    /// <summary>
    /// 本文が JSON だと名乗っているか (<c>application/json</c>。<c>charset</c> などの引数は見ない)。
    /// 本文を読む API はこれ以外を 415 で断る (Program.cs)
    /// </summary>
    public static bool IsJsonContentType(string? contentType) =>
        System.Net.Http.Headers.MediaTypeHeaderValue.TryParse(contentType, out var type)
        && string.Equals(type.MediaType, "application/json", StringComparison.OrdinalIgnoreCase);
}
