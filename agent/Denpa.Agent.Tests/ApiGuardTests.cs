using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * 認証を持たない API の守り。
 *
 * - 本文を読む API は application/json と名乗ったものしか受けない (Program.cs が 415 で断る)。
 *   text/plain などはブラウザが下調べ (preflight) なしに送れるので、外のサイトから書き込めてしまう
 * - 後から復号する (/denpa/decode) ときは、もうあるファイルを上書きしない
 */
public class ApiGuardTests
{
    [Test]
    [Arguments("application/json")]
    [Arguments("application/json; charset=utf-8")]
    [Arguments("Application/JSON")]
    public async Task JSONと名乗れば受ける(string contentType)
    {
        await Assert.That(Json.IsJsonContentType(contentType)).IsTrue();
    }

    [Test]
    [Arguments(null)]
    [Arguments("")]
    [Arguments("text/plain")]
    [Arguments("text/plain; charset=utf-8")]
    [Arguments("application/x-www-form-urlencoded")]
    [Arguments("multipart/form-data; boundary=x")]
    [Arguments("application/jsonx")]
    public async Task 下調べなしに送れる形は断る(string? contentType)
    {
        await Assert.That(Json.IsJsonContentType(contentType)).IsFalse();
    }

    [Test]
    public async Task 復号の書き出し先がもうあれば上書きしない()
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-decode-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllBytes(Path.Combine(root, "in.ts"), new byte[188]);
            var kept = Path.Combine(root, "kept.ts");
            File.WriteAllText(kept, "録画");

            var result = Scramble.Decode(root, "in.ts", "kept.ts");

            await Assert.That(result["ok"]!.GetValue<bool>()).IsFalse();
            await Assert.That(result["error"]!.GetValue<string>()).Contains("もうあります");
            await Assert.That(File.ReadAllText(kept)).IsEqualTo("録画");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
