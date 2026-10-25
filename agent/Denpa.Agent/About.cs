using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// エージェント自身のこと (<c>GET /denpa/about</c>)。設定の「その他」の「バージョンと環境」がバージョン・OS・arch と、macOS なら CCID ドライバを出す。
///
/// <para>
/// **バージョンは2か所から知る。** macOS と Windows の実行ファイルはリリースのときに
/// <c>-p:InformationalVersion=&lt;タグ&gt;</c> で組むので、中に持っている。Linux のイメージは main で組んだものに
/// 名前を貼るだけで組み直さない (.github/workflows/release.yml) ので、中身は <c>dev</c> のまま。こちらは
/// denpa と同じく、リリースのときに足す 1 層の <c>DENPA_VERSION</c> で知る (.github/release.Dockerfile)。
/// 中に持っているほうを先に見る。どちらも無ければ <c>dev</c> (main で組んだもの)。
/// </para>
/// </summary>
public static class About
{
    public static string Version { get; } = ResolveVersion(
        typeof(About).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        Environment.GetEnvironmentVariable("DENPA_VERSION"));

    /// <summary>
    /// 中に持っているもの (<paramref name="built"/>) が <c>dev</c> でなければそれ、無ければ環境変数、どちらも無ければ <c>dev</c>。
    /// SDK が足すことのある <c>+コミット</c> は落とす
    /// </summary>
    public static string ResolveVersion(string? built, string? environment)
    {
        var inside = built?.Split('+')[0].Trim();
        if (inside is { Length: > 0 } and not "dev") return inside;
        return environment?.Trim() is { Length: > 0 } outside ? outside : "dev";
    }

    public static string Os =>
        OperatingSystem.IsMacOS() ? "macos" : OperatingSystem.IsWindows() ? "windows" : "linux";

    public static string Arch => RuntimeInformation.ProcessArchitecture switch
    {
        Architecture.X64 => "x64",
        Architecture.Arm64 => "arm64",
        var other => other.ToString().ToLowerInvariant(),
    };

    /// <summary>
    /// <c>{"version","os","arch","runtime","ccidDriver"}</c>。<c>ccidDriver</c> は macOS だけ (ほかは null)。
    /// 呼ぶたびに `defaults` を高々1回起こす (<see cref="PcscLink.CcidDriver"/>)
    /// </summary>
    public static JsonObject ToJson() => new()
    {
        ["version"] = Version,
        ["os"] = Os,
        ["arch"] = Arch,
        ["runtime"] = RuntimeInformation.OSDescription,
        ["ccidDriver"] = PcscLink.CcidDriver(),
    };
}
