using System.IO.Compression;
using System.Security.Cryptography;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * IT930x のファームウェアを取ってきて切り出すところ (Px4Firmware.cs)。
 *
 * 本物のドライバもファームウェアも使わない (取りにも行かない)。中身がでたらめの .sys を入れた zip を作り、
 * そのハッシュを持つ出どころとして切り出させる。取ってくるのは偽の関数で、時刻も偽物。
 */
public class Px4FirmwareTests
{
    private const string Entry = "driver/FAKE.sys";
    private const int Offset = 0x40;
    private const int Length = 24;

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 31, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static readonly byte[] Sys = [.. Enumerable.Range(0, 0x100).Select(index => (byte)(index * 7 + 3))];

    private static byte[] Zip(string entry, byte[] content)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            using var stream = archive.CreateEntry(entry).Open();
            stream.Write(content);
        }
        return buffer.ToArray();
    }

    private static string Hash(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static readonly byte[] GoodZip = Zip(Entry, Sys);

    private static Px4FirmwareSource Source(byte[]? zip = null, IReadOnlyList<string>? urls = null) => new(
        urls ?? ["https://first.example/driver.zip", "https://second.example/driver.zip"],
        Hash(zip ?? GoodZip),
        Entry,
        Hash(Sys),
        Offset,
        Length,
        Hash(Sys.AsSpan(Offset, Length)));

    [Test]
    public async Task zip_の_sys_から決めた位置を切り出す()
    {
        var firmware = Source().Extract(GoodZip);
        await Assert.That(firmware).IsEquivalentTo(Sys.AsSpan(Offset, Length).ToArray());
    }

    [Test]
    public async Task ハッシュが合わなければ切り出さない()
    {
        // zip が違う
        var zip = Assert.Throws<InvalidDataException>(() => Source().Extract(Zip(Entry, [.. Sys, 0])));
        await Assert.That(zip.Message).Contains("配布 zip: SHA-256 が違います");

        // zip は合っているが中の .sys が違う (ハッシュの値を取り違えた、など)
        var sys = Assert.Throws<InvalidDataException>(() => (Source() with { SysSha256 = Hash([1]) }).Extract(GoodZip));
        await Assert.That(sys.Message).Contains("FAKE.sys: SHA-256 が違います");

        // 切り出す位置が違う
        var firmware = Assert.Throws<InvalidDataException>(() => (Source() with { Offset = Offset + 1 }).Extract(GoodZip));
        await Assert.That(firmware.Message).Contains("切り出したファームウェア: SHA-256 が違います");

        // .sys が無い
        var other = Zip("driver/OTHER.sys", Sys);
        var missing = Assert.Throws<InvalidDataException>(() => Source(other).Extract(other));
        await Assert.That(missing.Message).Contains($"配布 zip に {Entry} がありません");

        // .sys が短い
        var shortSys = Assert.Throws<InvalidDataException>(() => (Source() with { Offset = Sys.Length - 1 }).Extract(GoodZip));
        await Assert.That(shortSys.Message).Contains("短すぎます");
    }

    [Test]
    public async Task 一つ目が取れなければ二つ目から取って置く()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var target = Path.Combine(dir.FullName, "config", Px4Firmware.FileName);
            List<string> asked = [];
            var store = new Px4FirmwareStore([], target, Source(), url =>
            {
                asked.Add(url);
                return url.Contains("first") ? throw new HttpRequestException("証明書が違います") : GoodZip;
            }, new FakeClock());

            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(File.ReadAllBytes(target)).IsEquivalentTo(Sys.AsSpan(Offset, Length).ToArray());
            await Assert.That(asked).IsEquivalentTo(new[] { "https://first.example/driver.zip", "https://second.example/driver.zip" });
            await Assert.That(store.Problem).IsNull();

            // 置いたものを使う (もう取りに行かない)
            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(asked.Count).IsEqualTo(2);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 置いてあるものが勝つ()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var configured = Path.Combine(dir.FullName, "missing.bin");
            var bundled = Path.Combine(dir.FullName, "px4-userland", "firmware", Px4Firmware.FileName);
            Directory.CreateDirectory(Path.GetDirectoryName(bundled)!);
            File.WriteAllBytes(bundled, [1, 2, 3]);
            var target = Path.Combine(dir.FullName, "config", Px4Firmware.FileName);
            var store = new Px4FirmwareStore([configured, bundled], target, Source(),
                _ => throw new InvalidOperationException("取りに行かない"), new FakeClock());

            await Assert.That(store.Ensure()).IsEqualTo(bundled);
            await Assert.That(File.Exists(target)).IsFalse();

            // 先に見る置き場にあれば、そちらが勝つ
            File.WriteAllBytes(configured, [4]);
            await Assert.That(store.Ensure()).IsEqualTo(configured);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 取れなければ理由を残し_しばらく取りに行かない()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var target = Path.Combine(dir.FullName, Px4Firmware.FileName);
            var clock = new FakeClock();
            var online = false;
            var asked = 0;
            var store = new Px4FirmwareStore([], target, Source(), url =>
            {
                asked++;
                if (!online) throw new HttpRequestException("名前を引けません");
                // 一つ目は中身が違う (落ちたサイトが返すページなど)
                return url.Contains("first") ? "<html>"u8.ToArray() : GoodZip;
            }, clock);

            var first = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(first.Message).Contains("first.example: 名前を引けません / second.example: 名前を引けません");
            await Assert.That(first.Message).Contains("インターネット");
            await Assert.That(store.Problem).IsEqualTo(first.Message);
            await Assert.That(asked).IsEqualTo(2);

            // 待つ時間のうちは取りに行かず、同じ理由で断る
            online = true;
            clock.Now += Px4Firmware.Backoff - TimeSpan.FromSeconds(1);
            var again = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(again.Message).IsEqualTo(first.Message);
            await Assert.That(asked).IsEqualTo(2);

            // 過ぎたら試し直す
            clock.Now += TimeSpan.FromSeconds(1);
            await Assert.That(store.Ensure()).IsEqualTo(target);
            await Assert.That(asked).IsEqualTo(4);
            await Assert.That(store.Problem).IsNull();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 手で置かれたら理由を消す()
    {
        var dir = Directory.CreateTempSubdirectory("px4fw");
        try
        {
            var placed = Path.Combine(dir.FullName, "placed.bin");
            var store = new Px4FirmwareStore([placed], Path.Combine(dir.FullName, Px4Firmware.FileName), Source(),
                _ => throw new HttpRequestException("繋がりません"), new FakeClock());

            Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(store.Problem).IsNotNull();

            File.WriteAllBytes(placed, [1]);
            await Assert.That(store.Ensure()).IsEqualTo(placed);
            await Assert.That(store.Problem).IsNull();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 出どころの値は_install_sh_と_install_ps1_と同じ()
    {
        // 3か所に同じ値を持っている (Px4Firmware.Plex)。片方だけ変えると、Mac・Windows とコンテナで受け付けるものが分かれる
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "install.sh"))) root = Path.GetDirectoryName(root) ?? throw new FileNotFoundException("install.sh");
        var sh = File.ReadAllText(Path.Combine(root, "install.sh"));
        var ps1 = File.ReadAllText(Path.Combine(root, "install.ps1"));
        var plex = Px4Firmware.Plex;
        foreach (var text in new[] { sh, ps1 })
        {
            string[] values = [plex.ZipSha256, plex.SysSha256, plex.FirmwareSha256, plex.Entry, .. plex.Urls];
            foreach (var value in values)
            {
                await Assert.That(text).Contains(value);
            }
            await Assert.That(text).Contains($"0x{plex.Offset:x}");
            await Assert.That(text).Contains($"{plex.Length}");
        }
    }
}
