using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Denpa.Agent;

/// <summary>
/// **どの名前で呼ばれたら答えるか** (docs/agent.md「エージェントは認証を持たない」)。
///
/// <para>
/// エージェントは認証を持たないので、アドレスで届く範囲を絞っても DNS リバインディングで抜けられる。
/// 悪いサイトが自分の名前をエージェントの IP (127.0.0.1 など) に向け直すと、そのサイトを開いたブラウザは
/// エージェントを「そのサイトと同じオリジン」として読める (カード ID・ログ・復号済みの TS)。
/// そこで <c>Host</c> を見て、攻める側が自分の名前として用意できないものだけを通す。
/// 決まりは denpa の <c>knownHost</c> (src/lib/server/auth.ts) と同じで、Kubernetes の名前を足してある。
/// </para>
///
/// <list type="bullet">
/// <item>IP の直書き (IPv4・IPv6)、<c>localhost</c>、ドットの無い名前 (compose の <c>tuner-agent</c>・Service の短い名前)</item>
/// <item>家の中だけの名前 (<see cref="LocalSuffixes"/>)。<c>host.docker.internal</c>・<c>xxx.ns.svc.cluster.local</c> もここ</item>
/// <item><c>AGENT_ALLOWED_HOSTS</c> に書いた名前。頭にドットでその名前とその下の名前全部</item>
/// </list>
/// </summary>
public sealed partial class AgentHosts(IReadOnlyList<string> allowed)
{
    /// <summary>
    /// 名前の後ろがこれなら、外の DNS では引けない。<c>.localhost</c> はブラウザが自分に向ける。
    /// <c>.svc</c> は Kubernetes の <c>xxx.ns.svc</c> (<c>.svc.cluster.local</c> は <c>.local</c> に当たる)
    /// </summary>
    public static readonly string[] LocalSuffixes = [".localhost", ".local", ".lan", ".home.arpa", ".internal", ".svc"];

    /// <summary>設定にある名前 (小文字、最後のドット無し)</summary>
    public IReadOnlyList<string> Allowed { get; } = allowed;

    /// <summary>知らせた名前。同じ名前で何度来ても1度だけ出す (ログを埋めないよう、覚えるのは上限まで)</summary>
    private readonly HashSet<string> reported = [];
    private const int MaxReported = 64;

    public static AgentHosts FromEnvironment() => Parse(Environment.GetEnvironmentVariable("AGENT_ALLOWED_HOSTS"));

    /// <summary><c>AGENT_ALLOWED_HOSTS</c> (カンマ区切り) を読む。denpa の <c>ALLOWED_HOSTS</c> と同じ書き方</summary>
    public static AgentHosts Parse(string? list) => new(
        (list ?? "").Split(',')
            .Select(raw => raw.Trim().ToLowerInvariant().TrimEnd('.'))
            .Where(raw => raw.Length > 0)
            .ToList());

    /// <summary>
    /// 答えてよい名前か。<paramref name="host"/> は <c>Host</c> の値 (ポート付きでよい)。
    /// **無い・読めない形なら通さない** (ブラウザは必ず付けるので、無いのは HTTP/1.0 の手書きくらい)
    /// </summary>
    public bool Allows(string? host)
    {
        var name = BareName(host);
        if (name is null) return false;
        // [] で囲むのは IPv6 だけ
        if ((host ?? "").TrimStart().StartsWith('['))
        {
            return IPAddress.TryParse(name, out var v6) && v6.AddressFamily == AddressFamily.InterNetworkV6;
        }
        if (!NameShape().IsMatch(name)) return false;
        if (IPAddress.TryParse(name, out _)) return true;
        if (name == "localhost" || !name.Contains('.')) return true;
        if (LocalSuffixes.Any(name.EndsWith)) return true;
        return Allowed.Any(entry => entry.StartsWith('.')
            ? name == entry[1..] || name.EndsWith(entry)
            : name == entry);
    }

    /// <summary>
    /// 断った名前を初めて見たときだけ true (ログに出すかどうか)。並んで来てもよいように鍵を掛ける
    /// </summary>
    public bool FirstRefusal(string host)
    {
        lock (reported)
        {
            if (reported.Count >= MaxReported) return false;
            return reported.Add(host);
        }
    }

    /// <summary>ポートと <c>[]</c> を外し、小文字にして、最後のドットを落とす。空なら null</summary>
    private static string? BareName(string? host)
    {
        var name = (host ?? "").Trim().ToLowerInvariant();
        if (name.StartsWith('['))
        {
            var end = name.IndexOf(']');
            return end > 1 ? name[1..end] : null;
        }
        var colon = name.IndexOf(':');
        if (colon >= 0) name = name[..colon];
        if (name.EndsWith('.')) name = name[..^1];
        return name.Length == 0 ? null : name;
    }

    [GeneratedRegex("^[a-z0-9_.-]+$")]
    private static partial Regex NameShape();
}
