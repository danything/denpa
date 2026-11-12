// denpa の様子と、それを通知領域に出す文言。Win32 に触らないので、テスト (tray/Denpa.Tray.Tests) は Linux でも流れる。
// Mac のメニューバーのアプリ (tray/mac/Sources/DenpaTrayCore/Health.swift) も、メニューと確認の文言はそろえる (更新の知らせ方と、登録用の URL を出す窓は Mac だけ違う)。

using System.Text;
using System.Text.Json;

namespace Denpa.Tray;

/// <summary>
/// denpa の <c>GET /api/health</c> の答えのうち、通知領域に出すもの。
/// 新しいバージョンがあるかは denpa が GitHub の releases/latest と見比べた結果 (src/lib/server/update.ts) をそのまま使い、ここでは比べない
/// </summary>
public sealed record Health(string Version, string? Latest, int Recording, int Encoding)
{
    /// <summary>
    /// 読む。<c>ok</c> が true でなければ null (動いていないのと同じに扱う)。
    /// 足りない項目は無いものとして読む (古い denpa には <c>encoding</c> が無い)
    /// </summary>
    public static Health? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True) return null;
            var version = Text(root, "version") ?? "?";
            var latest = root.TryGetProperty("update", out var update) && update.ValueKind == JsonValueKind.Object ? Text(update, "version") : null;
            return new Health(version, latest, Count(root, "recording"), Count(root, "encoding"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static string? Text(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static int Count(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;
}

public static class Words
{
    /// <summary>メニューの先頭に出す 1 行 (選べない)。答えが無ければ、応答しないと出す</summary>
    public static string Summary(Health? health)
    {
        if (health is null) return "denpa が応答しません";
        var line = new StringBuilder($"denpa {health.Version}");
        if (health.Recording > 0) line.Append($"・録画中 {health.Recording} 本");
        if (health.Encoding > 0) line.Append($"・エンコード中 {health.Encoding} 本");
        return line.ToString();
    }

    /// <summary>アイコンに重ねたときの説明 (Shell_NotifyIcon の szTip は 127 文字まで)</summary>
    public static string Tip(Health? health) =>
        health?.Latest is { } latest ? $"{Summary(health)}\n新しいバージョン {latest} があります" : Summary(health);

    /// <summary>メニューの更新の項目</summary>
    public static string UpdateItem(string latest) => $"{latest} に更新…";

    /// <summary>新しいバージョンが出たときの通知 (タイトルと本文)</summary>
    public static (string Title, string Text) UpdateNotice(string latest) =>
        ($"新しいバージョン {latest} があります", $"メニューの「{UpdateItem(latest)}」から更新できます");

    /// <summary>
    /// 更新を始める前に確かめる文。録画もエンコードもしていなければ null (確かめずに始める)。
    /// **録画は止めない。** install.ps1 が録画の終わりを待ってから入れ替える (Stop-Denpa)。
    /// エンコードは待たずに止まり、起き直したあとで最初からやり直しになる (encoder.ts の requeueOrphanedJobs) ので、そう言って選んでもらう
    /// </summary>
    public static string? AskBeforeUpdate(Health health)
    {
        if (health.Recording == 0 && health.Encoding == 0) return null;
        var text = new StringBuilder();
        if (health.Recording > 0) text.Append($"録画中です ({health.Recording} 本)。録画が終わるまで待ってから入れ替えます。\n");
        if (health.Encoding > 0) text.Append($"エンコード中です ({health.Encoding} 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n");
        text.Append("\n更新しますか");
        return text.ToString();
    }
}

public static class Installer
{
    /// <summary>
    /// 更新に流す PowerShell。**入れたときと同じ install.ps1 の 1 行** (docs/install-windows.md)。ブラウザは開かない。
    /// 窓は開いたままにして、録画を待っている間の表示と結果を見せる。失敗したら Enter を押すまで閉じない
    /// </summary>
    public const string Script =
        "$ErrorActionPreference = 'Stop'\n" +
        "try {\n" +
        "    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -NoOpen\n" +
        "} catch {\n" +
        "    Write-Host $_ -ForegroundColor Red\n" +
        "    Read-Host '更新できませんでした。Enter で閉じます'\n" +
        "}\n";

    /// <summary>
    /// powershell.exe に渡す引数。中身は -EncodedCommand (UTF-16LE の base64) で渡す
    /// (引用符と日本語を、コマンドラインの書き方に左右されずに渡すため)
    /// </summary>
    public static string Arguments(string script) =>
        "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
}

/// <summary>
/// エージェントだけ入れたとき (install.ps1 -AgentOnly) の文言。denpa はこの PC にいないので、エージェントが応答するかと、
/// 別の機械の denpa に登録するための URL を出す (docs/agent.md「denpa と組む」)
/// </summary>
public static class AgentWords
{
    /// <summary>メニューの先頭に出す 1 行 (選べない)。組んだ denpa があるかは出さない (このアプリは組んだ相手の一覧を読めない)</summary>
    public static string Summary(bool answering) => answering ? "エージェントが応答しています" : "エージェントが応答しません";

    /// <summary>メニューの、登録用の URL を出す項目</summary>
    public const string PairItem = "登録用の URL を表示…";
}

public static class Pairing
{
    /// <summary>エージェントのポート (install.ps1 の $Port と同じ)。応答を見るときに TLS で繋ぐ</summary>
    public const int Port = 25252;

    /// <summary>
    /// 登録用の URL と QR を出す PowerShell。管理者の窓で <c>denpa-agent --pair</c> を流す (合言葉の入ったファイルを読むため)。
    /// <paramref name="tunersFile"/> はエージェントの <c>TUNERS_FILE</c> (install.ps1 が渡す。合言葉はその隣の tls\pair-token)。
    /// <c>--pair</c> は標準出力が端末のときだけ QR を描くので、出力を横取りしない <c>Start-Process -NoNewWindow</c> で起こす。
    /// 読み終えるまで窓は閉じない
    /// </summary>
    public static string Script(string agent, string? tunersFile)
    {
        static string Quote(string text) => "'" + text.Replace("'", "''") + "'";
        var script = new StringBuilder("$ErrorActionPreference = 'Stop'\n");
        if (tunersFile is { Length: > 0 }) script.Append($"$env:TUNERS_FILE = {Quote(tunersFile)}\n");
        script.Append(
            "try {\n" +
            $"    Start-Process -FilePath {Quote(agent)} -ArgumentList '--pair' -NoNewWindow -Wait\n" +
            "    Write-Host ''\n" +
            "    Write-Host 'denpa の設定の「受信」にある「エージェントを追加」に、この URL を貼るか QR を読ませてください。#pair= の後ろは合言葉なので、人に見せないでください'\n" +
            "} catch {\n" +
            "    Write-Host $_ -ForegroundColor Red\n" +
            "}\n" +
            "Read-Host 'Enter で閉じます'\n");
        return script.ToString();
    }
}
