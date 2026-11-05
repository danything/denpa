using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 使わないカードリーダー。**画面のカードリーダーの表のスイッチから書く** (<c>PUT /denpa/card/readers</c>)。
///
/// <para>
/// リーダーは名前で指す (<see cref="CardLinkCandidate.Name"/>)。画面の表の行も名前で並ぶ。
/// USB のリーダーの名前にはポートが入る (<c>Gemplus USB SmartCard Reader (usb 3-11)</c>) ので、
/// 挿すポートを変えると別のリーダーになる (チューナーのデバイスと同じ扱い)。
/// </para>
///
/// <para>
/// 使わないリーダーは開かない。カードの候補 (<see cref="CardLinks.Find"/>) に入らず、
/// 画面がカードの状態を確かめるときも開かない。PIX-DT295・CECH-ZD1 J の差し込み口なら、
/// チューナーも使っていなければ USB を閉じる (ほかのソフトや <c>--dt295-probe</c> から使える)。
/// </para>
/// </summary>
public static class CardChoice
{
    private static readonly Lock Gate = new();
    private static HashSet<string> _disabled = [];
    private static string? _file;

    /// <summary>使わないリーダーの名前</summary>
    public static IReadOnlySet<string> Disabled
    {
        get
        {
            lock (Gate) return _disabled;
        }
    }

    /// <summary>
    /// 置き場を決めて読む。**起動したときに 1 回** (カードを開く前に)。
    /// 読めなければ全部使うものとして続ける (使わない設定が消えても、開けるリーダーが増えるだけ)
    /// </summary>
    public static void Load(string file)
    {
        HashSet<string> disabled = [];
        try
        {
            if (File.Exists(file) && JsonNode.Parse(File.ReadAllText(file)) is JsonObject { } body
                && body["disabled"] is JsonArray list)
            {
                disabled = [.. list.Select(node => node?.GetValue<string>()).OfType<string>()];
            }
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException
            or FormatException)
        {
            Log.Write($"{file} を読めませんでした。どのカードリーダーも使うものとして続けます: {error.Message}");
        }
        lock (Gate)
        {
            _file = file;
            _disabled = disabled;
        }
    }

    /// <summary>
    /// 使わないリーダーを入れ替えて書く。空なら消す (どれも使う)。
    /// **<paramref name="present"/> に無い (挿さっていない) リーダーの「使わない」は残す。** 画面は挿さっているリーダーしか並べない。
    /// 読んで書き戻すまでを 1 つのロックの中でするので、同時に 2 つ来ても片方の変更が消えない
    /// </summary>
    public static void Save(IEnumerable<string> names, IReadOnlySet<string> present)
    {
        HashSet<string> next;
        lock (Gate)
        {
            next = [.. names.Where(name => name.Length > 0), .. _disabled.Where(name => !present.Contains(name))];
            if (_file is { } file)
            {
                if (next.Count == 0)
                {
                    if (File.Exists(file)) File.Delete(file);
                }
                else
                {
                    Config.WriteAtomic(file, new JsonObject { ["disabled"] = Json.Strings(next.Order(StringComparer.Ordinal)) });
                }
            }
            _disabled = next;
        }
        Log.Write(next.Count == 0 ? "カードリーダーをすべて使います" : $"使わないカードリーダー: {string.Join("、", next.Order(StringComparer.Ordinal))}");
    }

    /// <summary>テスト用。置き場を持たずに入れ替える</summary>
    internal static void Set(IEnumerable<string> names)
    {
        lock (Gate)
        {
            _file = null;
            _disabled = [.. names];
        }
    }
}
