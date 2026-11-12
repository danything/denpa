using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// エージェント自身のこと (<c>GET /denpa/about</c>)。設定の「その他」の「バージョンと環境」がバージョン・OS・arch と、macOS なら CCID ドライバを出す。
///
/// <para>
/// **バージョンは 2 か所から読む。** macOS と Windows の実行ファイルはリリースのときに
/// <c>-p:InformationalVersion=&lt;タグ&gt;</c> で組むので、中に持っている。Linux のイメージは main で組んだものに
/// 名前を貼るだけで組み直さない (.github/workflows/release.yml) ので、中身は <c>dev</c> のまま。こちらは
/// denpa と同じく、リリースのときに足す 1 層の <c>DENPA_VERSION</c> から読む (.github/release.Dockerfile)。
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

    /// <summary><c>macos</c>・<c>windows</c>・<c>android</c> (アプリから USB を受け取っている Linux。bionic も OS は Linux と答える)・<c>linux</c></summary>
    public static string Os =>
        OperatingSystem.IsMacOS() ? "macos" : OperatingSystem.IsWindows() ? "windows" : UsbHost.Brokered ? "android" : "linux";

    public static string Arch => RuntimeInformation.ProcessArchitecture switch
    {
        Architecture.X64 => "x64",
        Architecture.Arm64 => "arm64",
        var other => other.ToString().ToLowerInvariant(),
    };

    /// <summary>
    /// 画面に出す名前の元。denpa は登録したときにこれで名前を付ける (設定の「受信」の「エージェント」)。
    /// <c>AGENT_NAME</c> が空でなければそれ、無ければ機械の名前
    /// </summary>
    public static string Name => ResolveName(Environment.GetEnvironmentVariable("AGENT_NAME"), Environment.MachineName);

    /// <summary><paramref name="environment"/> (<c>AGENT_NAME</c>) が空でなければそれ、無ければ <paramref name="machine"/></summary>
    public static string ResolveName(string? environment, string machine) =>
        environment?.Trim() is { Length: > 0 } given ? given : machine;

    /// <summary>
    /// <c>{"name","version","os","arch","runtime","ccidDriver"}</c>。<c>ccidDriver</c> は macOS だけ (ほかは null)。
    /// 呼ぶたびに `defaults` を高々 1 回起動する (<see cref="PcscLink.CcidDriver"/>)
    /// </summary>
    public static JsonObject ToJson() => new()
    {
        ["name"] = Name,
        ["version"] = Version,
        ["os"] = Os,
        ["arch"] = Arch,
        ["runtime"] = RuntimeInformation.OSDescription,
        ["ccidDriver"] = PcscLink.CcidDriver(),
    };
}
