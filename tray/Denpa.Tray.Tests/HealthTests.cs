using System.Text;

namespace Denpa.Tray.Tests;

/*
 * 通知領域のアプリが denpa の `/api/health` をどう読み、更新の前に何を確かめるか。
 * Win32 の側 (Program.cs) は CI で起こして落ちないことだけを見る (test.yml の agent-windows-install)
 */
public class HealthTests
{
    [Test]
    public async Task 新しいバージョンと録画とエンコードの本数を読む()
    {
        var health = Health.Parse("""
            {"ok":true,"version":"v2.30.0","update":{"version":"v2.31.0","url":"https://github.com/danything/denpa/releases/tag/v2.31.0"},
             "services":12,"recording":1,"encoding":2}
            """);
        await Assert.That(health).IsEqualTo(new Health("v2.30.0", "v2.31.0", 1, 2));
    }

    [Test]
    public async Task 新しいバージョンが無ければ_null()
    {
        var health = Health.Parse("""{"ok":true,"version":"v2.30.0","update":null,"services":0,"recording":0,"encoding":0}""");
        await Assert.That(health).IsEqualTo(new Health("v2.30.0", null, 0, 0));
    }

    [Test]
    public async Task 古い_denpa_の_encoding_の無い答えも読む()
    {
        var health = Health.Parse("""{"ok":true,"version":"v2.29.0","update":null,"services":0,"recording":3}""");
        await Assert.That(health).IsEqualTo(new Health("v2.29.0", null, 3, 0));
    }

    [Test]
    public async Task ok_でない答えと読めない答えは動いていないことにする()
    {
        await Assert.That(Health.Parse("""{"ok":false,"version":"v2.30.0"}""")).IsNull();
        await Assert.That(Health.Parse("""{"version":"v2.30.0"}""")).IsNull();
        await Assert.That(Health.Parse("[]")).IsNull();
        await Assert.That(Health.Parse("<html>")).IsNull();
        await Assert.That(Health.Parse("")).IsNull();
    }

    [Test]
    public async Task 様子の_1_行()
    {
        await Assert.That(Words.Summary(null)).IsEqualTo("denpa が応答しません");
        await Assert.That(Words.Summary(new Health("v2.30.0", null, 0, 0))).IsEqualTo("denpa v2.30.0");
        await Assert.That(Words.Summary(new Health("v2.30.0", null, 1, 2))).IsEqualTo("denpa v2.30.0・録画中 1 本・エンコード中 2 本");
        await Assert.That(Words.Summary(new Health("dev", null, 0, 1))).IsEqualTo("denpa dev・エンコード中 1 本");
    }

    [Test]
    public async Task 説明には新しいバージョンも添える()
    {
        await Assert.That(Words.Tip(new Health("v2.30.0", "v2.31.0", 0, 0))).IsEqualTo("denpa v2.30.0\n新しいバージョン v2.31.0 があります");
        await Assert.That(Words.Tip(null)).IsEqualTo("denpa が応答しません");
        // Shell_NotifyIcon の szTip に収まる (127 文字まで)
        await Assert.That(Words.Tip(new Health("v12.345.678", "v12.345.679", 999, 999)).Length).IsLessThan(128);
    }

    [Test]
    public async Task 録画もエンコードもしていなければ確かめずに更新する()
    {
        await Assert.That(Words.AskBeforeUpdate(new Health("v2.30.0", "v2.31.0", 0, 0))).IsNull();
    }

    [Test]
    public async Task 録画中は録画の終わりを待つと言って確かめる()
    {
        var question = Words.AskBeforeUpdate(new Health("v2.30.0", "v2.31.0", 1, 0));
        await Assert.That(question).IsEqualTo("録画中です (1 本)。録画が終わるまで待ってから入れ替えます。\n\n更新しますか");
    }

    [Test]
    public async Task エンコード中はやり直しになると言って確かめる()
    {
        await Assert.That(Words.AskBeforeUpdate(new Health("v2.30.0", "v2.31.0", 0, 1))).IsEqualTo(
            "エンコード中です (1 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n\n更新しますか");
        var question = Words.AskBeforeUpdate(new Health("v2.30.0", "v2.31.0", 1, 2));
        await Assert.That(question).IsEqualTo(
            "録画中です (1 本)。録画が終わるまで待ってから入れ替えます。\n" +
            "エンコード中です (2 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n\n更新しますか");
    }

    [Test]
    public async Task 更新は入れたときと同じ_install_ps1_をブラウザを開かずに流す()
    {
        await Assert.That(Installer.Script).Contains(
            "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1))) -NoOpen");
    }

    [Test]
    public async Task PowerShell_には_UTF_16LE_の_base64_で渡す()
    {
        var args = Installer.Arguments("Write-Host '更新'");
        await Assert.That(args).StartsWith("-NoProfile -ExecutionPolicy Bypass -EncodedCommand ");
        var encoded = args.Split(' ')[^1];
        await Assert.That(Encoding.Unicode.GetString(Convert.FromBase64String(encoded))).IsEqualTo("Write-Host '更新'");
    }
    [Test]
    public async Task エージェントだけのときは応答するかを出す()
    {
        await Assert.That(AgentWords.Summary(true)).IsEqualTo("エージェントが応答しています");
        await Assert.That(AgentWords.Summary(false)).IsEqualTo("エージェントが応答しません");
    }

    [Test]
    public async Task 登録用の_URL_は_TUNERS_FILE_を渡して_denpa_agent_の_pair_を端末のまま流す()
    {
        var script = Pairing.Script(@"C:\Program Files\denpa\bin\denpa-agent.exe", @"C:\Users\o'neil\denpa\config\tuners.json");
        // 引用符は '' に重ねる
        await Assert.That(script).Contains(@"$env:TUNERS_FILE = 'C:\Users\o''neil\denpa\config\tuners.json'");
        // 出力を横取りすると --pair が QR を描かない
        await Assert.That(script).Contains(@"Start-Process -FilePath 'C:\Program Files\denpa\bin\denpa-agent.exe' -ArgumentList '--pair' -NoNewWindow -Wait");
        await Assert.That(script).Contains("Read-Host");
        // TUNERS_FILE を渡されていなければ書かない (エージェントの既定の置き場)
        await Assert.That(Pairing.Script("denpa-agent.exe", "")).DoesNotContain("TUNERS_FILE");
    }
}
