namespace Denpa.Agent.Tests;

/*
 * 届いた相手に録画を潰させない守り。
 *
 * - 後から復号する (/denpa/decode) ときは、もうあるファイルを上書きしない。
 *   復号できなかったら自分で作った書きかけを消す (掛け直しが「もうあります」で断られないように)
 */
public class ApiGuardTests
{
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

    [Test]
    public async Task 復号できなければ書きかけを残さない()
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-decode-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            // 掛かったままの映像のパケットだけ。PMT も ECM も無いので鍵を受け取れない
            var packets = new byte[188 * 10];
            for (var at = 0; at < packets.Length; at += 188)
            {
                packets[at] = 0x47;
                packets[at + 1] = 0x01;
                packets[at + 2] = 0x11;
                packets[at + 3] = (byte)(0x90 | (at / 188 & 0x0F));
            }
            File.WriteAllBytes(Path.Combine(root, "in.ts"), packets);

            var result = Scramble.Decode(root, "in.ts", "out.ts");

            await Assert.That(result["ok"]!.GetValue<bool>()).IsFalse();
            await Assert.That(result["error"]!.GetValue<string>()).Contains("スクランブルのまま");
            await Assert.That(File.Exists(Path.Combine(root, "out.ts"))).IsFalse();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
