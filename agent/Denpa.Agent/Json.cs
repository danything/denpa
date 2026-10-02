using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>ログ。出す先は標準出力だけ (`kubectl logs` で読む)</summary>
public static class Log
{
    public static void Write(string message) => Console.WriteLine($"[agent] {message}");
}

/// <summary>
/// JSON の書き方。**組み立ては <c>JsonNode</c> だけでやる。**
///
/// <para>
/// Native AOT では、型から反射で書き出す道が使えない。読むもの (設定・denpa から来るもの・
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

    /// <summary>控えのファイル用。手で開いて確かめられる形にする</summary>
    public static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IndentSize = 4,
        Encoder = Relaxed,
    };

    /// <summary>口から返すもの。読むのは denpa なので詰めて出す</summary>
    public static readonly JsonSerializerOptions Compact = new() { Encoder = Relaxed };

    /// <summary>文字列の並びを JSON の配列に</summary>
    public static JsonArray Strings(IEnumerable<string> values) => [.. values.Select(value => (JsonNode)value)];
}
