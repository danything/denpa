using System.Security.Cryptography;

namespace Denpa.Agent.Tests;

/*
 * IT930x のファームウェアの置き場 (Px4Firmware.cs)。
 *
 * 置き場の順とハッシュの確認は、中身がでたらめの偽のファームウェアで確かめる。
 * 同梱の本物は、埋め込んだものが決めた SHA-256 と大きさか、だけを見る。
 */
public class Px4FirmwareTests
{
    private static readonly byte[] Fake = [.. Enumerable.Range(0, 24).Select(index => (byte)(index * 7 + 3))];

    private static string Hash(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static Px4FirmwareStore Store(string? configured, string target, Func<byte[]>? bundled = null) =>
        new(configured, bundled ?? (() => Fake), target, Hash(Fake));

    [Test]
    public async Task 同梱のものは決めた_SHA_256()
    {
        var firmware = Px4Firmware.Bundled();
        await Assert.That(firmware.Length).IsEqualTo(2169);
        await Assert.That(Hash(firmware)).IsEqualTo(Px4Firmware.Sha256);
    }

    [Test]
    public async Task 指定が無ければ同梱のものを書き出して使う()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var target = Path.Combine(dir.FullName, "config", Px4Firmware.FileName);
            var asked = 0;
            var store = Store(null, target, () =>
            {
                asked++;
                return Fake;
            });

            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(File.ReadAllBytes(target)).IsEquivalentTo(Fake);
            await Assert.That(store.Problem).IsNull();

            // 同じものが置いてあれば書き直さない
            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(asked).IsEqualTo(1);

            // 置いてあるものが違えば (前のバージョンが置いた壊れたものなど) 書き直す
            File.WriteAllBytes(target, [1, 2, 3]);
            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(File.ReadAllBytes(target)).IsEquivalentTo(Fake);
            await Assert.That(asked).IsEqualTo(2);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task PX4_FIRMWARE_が指定されていればそれを使う()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var configured = Path.Combine(dir.FullName, "placed.bin");
            File.WriteAllBytes(configured, Fake);
            var target = Path.Combine(dir.FullName, "config", Px4Firmware.FileName);
            var store = Store(configured, target, () => throw new InvalidOperationException("同梱のものは使わない"));

            await Assert.That(store.Ensure()).IsEqualTo(configured);
            await Assert.That(File.Exists(target)).IsFalse();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task PX4_FIRMWARE_の中身が違えば使わず理由を残す()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var configured = Path.Combine(dir.FullName, "placed.bin");
            var target = Path.Combine(dir.FullName, Px4Firmware.FileName);
            var store = Store(configured, target);

            // 無い
            var missing = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(missing.Message).Contains($"PX4_FIRMWARE の {configured} がありません");
            await Assert.That(store.Problem).IsEqualTo(missing.Message);

            // 中身が違う。同梱のものに逃げない
            File.WriteAllBytes(configured, [.. Fake, 0]);
            var wrong = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(wrong.Message).Contains($"PX4_FIRMWARE の {configured} の SHA-256 が違います");
            await Assert.That(File.Exists(target)).IsFalse();

            // 直したら理由を消す
            File.WriteAllBytes(configured, Fake);
            await Assert.That(store.Ensure()).IsEqualTo(configured);
            await Assert.That(store.Problem).IsNull();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 同梱のものの中身が違えば書き出さない()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var target = Path.Combine(dir.FullName, Px4Firmware.FileName);
            var store = Store(null, target, () => [.. Fake, 0]);

            var error = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(error.Message).Contains($"同梱の {Px4Firmware.FileName} の SHA-256 が違います");
            await Assert.That(File.Exists(target)).IsFalse();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
