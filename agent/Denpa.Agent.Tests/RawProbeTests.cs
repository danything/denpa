using System.Security.Cryptography;
using System.Text;

namespace Denpa.Agent.Tests;

/*
 * 元の TS の置き場が見えるかの確かめ (POST /denpa/raw/probe。RawProbe.cs)。
 *
 * - denpa が .denpa/ の下に書いたファイルの中身の SHA-256 を返す
 * - 無ければ 404 (denpa は「見えない」と読む)
 * - .denpa/ の外・置き場の外・大きなファイル・リンクは断る (録画の中身の手がかりを返さない)
 */
public class RawProbeTests
{
    private static string NewRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-probe-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(root, RawProbe.Dir));
        return root;
    }

    [Test]
    public async Task 置き場の_denpa_の下のファイルの中身の_SHA256_を返す()
    {
        var root = NewRoot();
        try
        {
            File.WriteAllText(Path.Combine(root, ".denpa", "probe-1"), "0123abcd");

            var (status, body) = RawProbe.Hash(root, ".denpa/probe-1");

            await Assert.That(status).IsEqualTo(200);
            await Assert.That(body["sha256"]!.GetValue<string>())
                .IsEqualTo(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("0123abcd"))));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Test]
    public async Task 無ければ_404()
    {
        var root = NewRoot();
        try
        {
            var (status, body) = RawProbe.Hash(root, ".denpa/probe-2");

            await Assert.That(status).IsEqualTo(404);
            await Assert.That(body["error"]!.GetValue<string>()).Contains("RAW_DIR");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Test]
    [Arguments("in.ts")]
    [Arguments(".denpa")]
    [Arguments(".denpa/../in.ts")]
    [Arguments("../outside")]
    [Arguments("/etc/hostname")]
    [Arguments("")]
    [Arguments(null)]
    public async Task denpa_の下でなければ断る(string? path)
    {
        var root = NewRoot();
        try
        {
            File.WriteAllText(Path.Combine(root, "in.ts"), "録画");

            var (status, body) = RawProbe.Hash(root, path);

            await Assert.That(status).IsEqualTo(400);
            await Assert.That(body.ContainsKey("sha256")).IsFalse();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Test]
    public async Task 大きなファイルは読まない()
    {
        var root = NewRoot();
        try
        {
            File.WriteAllBytes(Path.Combine(root, ".denpa", "big"), new byte[RawProbe.MaxBytes + 1]);

            var (status, _) = RawProbe.Hash(root, ".denpa/big");

            await Assert.That(status).IsEqualTo(400);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Test]
    public async Task リンクは辿らない()
    {
        var root = NewRoot();
        try
        {
            File.WriteAllText(Path.Combine(root, "in.ts"), "録画");
            File.CreateSymbolicLink(Path.Combine(root, ".denpa", "link"), Path.Combine(root, "in.ts"));

            var (status, body) = RawProbe.Hash(root, ".denpa/link");

            await Assert.That(status).IsEqualTo(400);
            await Assert.That(body.ContainsKey("sha256")).IsFalse();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
