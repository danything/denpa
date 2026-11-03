using System.IO.Compression;
using System.Security.Cryptography;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 のメーカーのデータを取り出すところ (Dt295Firmware.cs)。
 *
 * 本物のパッケージは使わない (取りにも行かない)。中身がでたらめのドライバー・イメージを入れた zip を作り、
 * そのハッシュを持つ出どころとして取り出させる。範囲の名前と長さだけは公式と同じ並び (素材を読むところも確かめるため)。
 */
public class Dt295FirmwareTests
{
    private const string Dir = "Fake Tool 1.0/Driver/x64/";

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 11, 1, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static string Hash(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static readonly byte[] Material = FakeDt295Material.Bytes();

    /// <summary>素材を決まった位置に置いたドライバーの偽物</summary>
    private static readonly byte[] Driver = MakeDriver();

    private static readonly byte[] Idle = [.. Enumerable.Range(0, 300).Select(i => (byte)(i * 13))];
    private static readonly byte[] Trc = [.. Enumerable.Range(0, 500).Select(i => (byte)(i * 29 + 1))];

    private static byte[] MakeDriver()
    {
        var driver = new byte[0x100 + Material.Length + 64];
        RandomNumberGenerator.Fill(driver);
        Material.CopyTo(driver, 0x100);
        return driver;
    }

    private static IReadOnlyList<Dt295Range> Ranges()
    {
        var at = 0x100;
        var offset = 0;
        List<Dt295Range> ranges = [];
        foreach (var range in Dt295Firmware.Pixela.Ranges)
        {
            ranges.Add(new Dt295Range(range.Name, at, range.Length, Hash(Material.AsSpan(offset, range.Length))));
            at += range.Length;
            offset += range.Length;
        }
        return ranges;
    }

    private static byte[] Zip(params (string Name, byte[] Content)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                using var stream = archive.CreateEntry(name).Open();
                stream.Write(content);
            }
        }
        return buffer.ToArray();
    }

    private static readonly byte[] GoodZip = Zip(
        (Dir + "readme.txt", "x"u8.ToArray()),
        (Dir + "drv.sys", Driver),
        (Dir + "idle.bin", Idle),
        (Dir + "trc.bin", Trc));

    private static Dt295FirmwareSource Source(byte[]? zip = null) => new(
        ["https://first.example/pkg.zip", "https://second.example/pkg.zip"],
        Hash(zip ?? GoodZip),
        1 << 20,
        new Dt295Entry(Dir + "drv.sys", Driver.Length, Hash(Driver)),
        new Dt295Entry(Dir + "idle.bin", Idle.Length, Hash(Idle)),
        new Dt295Entry(Dir + "trc.bin", Trc.Length, Hash(Trc)),
        Ranges());

    [Test]
    public async Task zip_から3つを取り出して素材を切り出す()
    {
        var vendor = Source().Extract(new MemoryStream(GoodZip));
        await Assert.That(vendor.Idle).IsEquivalentTo(Idle);
        await Assert.That(vendor.Trc).IsEquivalentTo(Trc);
        await Assert.That(vendor.Material).IsEquivalentTo(Material);
        await Assert.That(Source().Holds(vendor.Material)).IsTrue();

        // 素材を読む: 鍵は片割れの XOR、表は 8 バイトの行
        var material = new Dt295Material(vendor.Material, Dt295Firmware.Pixela.Ranges);
        await Assert.That(material.TerrestrialDemod.Count).IsEqualTo(22);
        await Assert.That(material.SatelliteDemod.Count).IsEqualTo(18);
        await Assert.That(material.TerrestrialRfA.Count).IsEqualTo(26);
        await Assert.That(material.TerrestrialRfB.Count).IsEqualTo(28);
        await Assert.That(material.TerrestrialDemod[1]).IsEqualTo(((byte)0x41, (byte)3));
        await Assert.That(material.Rows.Length).IsEqualTo(512);
        await Assert.That(material.SatelliteMissing).IsFalse();
    }

    [Test]
    public async Task 区切りが逆スラッシュの_zip_も読む()
    {
        var zip = Zip(
            (Dir.Replace('/', '\\') + "drv.sys", Driver),
            (Dir.Replace('/', '\\') + "idle.bin", Idle),
            (Dir.Replace('/', '\\') + "trc.bin", Trc));
        var vendor = Source(zip).Extract(new MemoryStream(zip));
        await Assert.That(vendor.Idle).IsEquivalentTo(Idle);
    }

    [Test]
    public async Task どこかが合わなければ取り出さない()
    {
        var zip = Assert.Throws<InvalidDataException>(() => Source().Extract(new MemoryStream([.. GoodZip, 0])));
        await Assert.That(zip.Message).Contains("配布 zip: SHA-256 が違います");

        var idle = Assert.Throws<InvalidDataException>(() => (Source() with { Idle = new Dt295Entry(Dir + "idle.bin", Idle.Length, Hash([1])) }).Extract(new MemoryStream(GoodZip)));
        await Assert.That(idle.Message).Contains("idle.bin: SHA-256 が違います");

        var length = Assert.Throws<InvalidDataException>(() => (Source() with { Trc = new Dt295Entry(Dir + "trc.bin", 1, Hash(Trc)) }).Extract(new MemoryStream(GoodZip)));
        await Assert.That(length.Message).Contains("長さが違います");

        var missing = Assert.Throws<InvalidDataException>(() => (Source() with { Driver = new Dt295Entry(Dir + "other.sys", 1, "") }).Extract(new MemoryStream(GoodZip)));
        await Assert.That(missing.Message).Contains("がありません");

        // 切り出す位置が 1 バイトずれた
        var shifted = Source().Ranges.Select(range => range with { Offset = range.Offset + 1 }).ToList();
        var cut = Assert.Throws<InvalidDataException>(() => (Source() with { Ranges = shifted }).Extract(new MemoryStream(GoodZip)));
        await Assert.That(cut.Message).Contains("切り出した T_DEMOD: SHA-256 が違います");

        // ドライバーより外
        var outside = Source().Ranges.Select(range => range with { Offset = Driver.Length }).ToList();
        Assert.Throws<InvalidDataException>(() => (Source() with { Ranges = outside }).Cut(Driver));

        // 表の値が 255 を越える
        var table = new byte[16];
        table[4] = 0x00;
        table[5] = 0x01;
        Assert.Throws<InvalidDataException>(() => Dt295Material.Table(table, "T"));
    }

    [Test]
    public async Task 一つ目が取れなければ二つ目から取って置き_次からは置いたものを使う()
    {
        var dir = Directory.CreateTempSubdirectory("dt295fw");
        try
        {
            List<string> asked = [];
            var store = new Dt295FirmwareStore(dir.FullName, Source(), (url, path) =>
            {
                asked.Add(url);
                File.WriteAllBytes(path, url.Contains("first") ? "<html>"u8.ToArray() : GoodZip);
            }, new FakeClock());

            var vendor = store.Ensure();
            await Assert.That(vendor.Material).IsEquivalentTo(Material);
            await Assert.That(asked.Count).IsEqualTo(2);
            await Assert.That(File.ReadAllBytes(Path.Combine(dir.FullName, Dt295FirmwareStore.IdleFile))).IsEquivalentTo(Idle);
            // 一時ファイルは消した
            await Assert.That(Directory.GetFiles(dir.FullName).Length).IsEqualTo(3);

            await Assert.That(store.Ensure().Trc).IsEquivalentTo(Trc);
            await Assert.That(asked.Count).IsEqualTo(2);

            // 置いたものが壊れていたら取り直す
            File.WriteAllBytes(Path.Combine(dir.FullName, Dt295FirmwareStore.MaterialFile), [1, 2, 3]);
            await Assert.That(store.Ensure().Material).IsEquivalentTo(Material);
            await Assert.That(asked.Count).IsEqualTo(4);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 取れなければ理由を残し_しばらく取得し直さない()
    {
        var dir = Directory.CreateTempSubdirectory("dt295fw");
        try
        {
            var clock = new FakeClock();
            var online = false;
            var asked = 0;
            var store = new Dt295FirmwareStore(dir.FullName, Source(), (url, path) =>
            {
                asked++;
                if (!online) throw new HttpRequestException("名前を引けません");
                File.WriteAllBytes(path, GoodZip);
            }, clock);

            var first = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(first.Message).Contains("first.example: 名前を引けません / second.example: 名前を引けません");
            await Assert.That(store.Problem).IsEqualTo(first.Message);

            online = true;
            clock.Now += Dt295Firmware.Backoff - TimeSpan.FromSeconds(1);
            Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(asked).IsEqualTo(2);

            clock.Now += TimeSpan.FromSeconds(1);
            await Assert.That(store.Ensure().Idle).IsEquivalentTo(Idle);
            await Assert.That(store.Problem).IsNull();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 置き場に公式パッケージがあれば取ってこずにそれを使い_残す()
    {
        var dir = Directory.CreateTempSubdirectory("dt295fw");
        try
        {
            var placed = Path.Combine(dir.FullName, Dt295FirmwareStore.PackageFile);
            File.WriteAllBytes(placed, GoodZip);
            var asked = 0;
            var store = new Dt295FirmwareStore(dir.FullName, Source(), (_, _) => asked++, new FakeClock());
            await Assert.That(store.Ensure().Idle).IsEquivalentTo(Idle);
            await Assert.That(asked).IsEqualTo(0);
            await Assert.That(File.Exists(placed)).IsTrue();

            // 壊れていれば取りにいき、取れなければ置き場所も添えて断る
            File.Delete(Path.Combine(dir.FullName, Dt295FirmwareStore.IdleFile));
            File.WriteAllBytes(placed, [1, 2, 3]);
            var offline = new Dt295FirmwareStore(dir.FullName, Source(), (_, _) => throw new HttpRequestException("名前を引けません"), new FakeClock());
            var error = Assert.Throws<IOException>(() => offline.Ensure());
            await Assert.That(error.Message).Contains(Dt295FirmwareStore.PackageFile);
            await Assert.That(error.Message).Contains(dir.FullName);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task 公式の範囲の表は5_2_の並びと長さ()
    {
        var ranges = Dt295Firmware.Pixela.Ranges;
        await Assert.That(ranges.Count).IsEqualTo(17);
        await Assert.That(ranges[0].Offset).IsEqualTo(0x841D0 - 0x10000);
        await Assert.That(ranges[^1].Offset).IsEqualTo(0x85230 - 0x10000);
        await Assert.That(Dt295Firmware.Pixela.MaterialLength).IsEqualTo(176 + 144 + 208 + 224 + 30 + 12 + 28 + 16 * 8 + 16 + 512);
        await Assert.That(ranges.All(range => range.Sha256.Length == 64)).IsTrue();
    }
}
