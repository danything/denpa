using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 に要るメーカーのデータ。**ソースにもイメージにも入れず、使う人の機械で PIXELA の公式パッケージから取り出す。**
///
/// <para>
/// 要るのは3つ (仕様書 12.1): ASSP に毎回書き込む idle イメージ、受信の前に書き込む TRC イメージ、公式の Windows ドライバー
/// <c>pxmb86m0x_usb.sys</c> から位置で切り出す定数 (認証の鍵の片割れ・表、チューナーの初期化表。5.2)。
/// どれも StationTV X の更新パッケージ (PIX-DT295 StationTV X 1.20.3000.2) の zip に入っている (12.2・12.3)。
/// 取り方は <see cref="Px4Firmware"/> と同じ: 取ってくる → zip の SHA-256 → 3つのエントリーを取り出して SHA-256 →
/// ドライバーから位置で切り出して範囲ごとに SHA-256。取れたものは設定の置き場 (tuners.json の隣) に置いて次からはそれを使う。
/// </para>
///
/// <para>
/// 置き場に公式パッケージの zip (<see cref="Dt295FirmwareStore.PackageFile"/>) が置いてあれば、取ってこずにそれを使う。
/// **TRC のフィールド表 (12.5) と TS の IV (12.7) は zip から取れない**ので Dt295Receive.cs で別に揃える。
/// </para>
/// </summary>
public static class Dt295Firmware
{
    private const string Dir = "StationTV X_UpdateTool_1.20.3000.2/Driver/selene/usb/x64/";

    /// <summary>
    /// 取ってくる先と確かめ方 (12.2〜12.4・5.2)。公式のサイトが落ちていれば Internet Archive の写しから取る。
    /// 写しの zip のハッシュは仕様書には無い (12.2) が、2026-11-01 に両方を取って同じ SHA-256 だと確かめた
    /// </summary>
    internal static readonly Dt295FirmwareSource Pixela = new(
        Urls:
        [
            "https://www.pixela.co.jp/products/tv_capture/pix_dt460/data/stationtvx_updater12030002.zip",
            "https://web.archive.org/web/20250803175659id_/https://www.pixela.co.jp/products/tv_capture/pix_dt460/data/stationtvx_updater12030002.zip",
        ],
        ZipSha256: "5c7be4596633179c229a70bf9c5272f884e72ea2621b42064df97c7068b1760c",
        ZipLimit: 256L << 20,
        Driver: new(Dir + "pxmb86m0x_usb.sys", 535_936, "46889d2f8b046485a0cc25451c1691ca87b13601d0566c807ee6e1c9084fc878"),
        Idle: new(Dir + "mb86m01_assp_osec_idle.bin", 333_056, "3c4721204a987a5e8a818be4ac14ee2709a4786413a7ef77ddb33573370dd9d3"),
        Trc: new(Dir + "mb86m01_assp_osec_trc_m_h.bin", 1_497_200, "a3520f60e80f08008621dcf44679474906e43a4de36770d769cd7642b19ddd0b"),
        // 5.2 の表の順。ファイル位置 = VA − 0x10000 (12.4)
        Ranges:
        [
            new("T_DEMOD", 0x741D0, 176, "434a5dfc7f586ea2c13a6b93f2b4950846a849c8b382d1f81e533a35897c3e0b"),
            new("S_DEMOD", 0x745A0, 144, "8258fb580f638e9cf7d0dc1b91b87940c3fb1234ec892921edc4f9f20142fa9e"),
            new("T_RF_A", 0x74630, 208, "3fad5c8e96113d473dc5406335fa978ccf493375dcbc5c23129f38c6754e68d2"),
            new("T_RF_B", 0x74700, 224, "c502f8bfa5246cdb1ea52077f5bf7e0ee4cc35accebf9931ba0c668895ac65a6"),
            new("A_PREFIX", 0x75148, 30, "f3ff8e7a0bac3f4efd723c12ae58afd3fe542780f25870dac63b4ed337e1992e"),
            new("S_SUFFIX", 0x75168, 12, "ee3c2017007839cfb2fae060600669dcddad796fe4349116b52c54ee5fee5295"),
            new("R_SUFFIX", 0x75178, 28, "e15cd9cff30a6fc16e9ec29079e53e2d004c1bd0f41ed1a7955694809d085cc2"),
            new("K1a", 0x75198, 16, "c03508edf636012964349490705091cb50d610eca6ec1e688dd7779f0765ed6d"),
            new("K2a", 0x751A8, 16, "83ed52ad70d9c6fbe0d1229e07a3446525eaf67d6f0fb65e99395a0c4f545517"),
            new("K3a", 0x751B8, 16, "2d202cafa7c8c4bb9f68e1990d5d6fc512d3a60501c41682b9f93e755ff0cc64"),
            new("K4a", 0x751C8, 16, "278ddff781d791a4f8bde6015d8b9062f3ac4dc28001c6d619ff32227bf3b494"),
            new("K1b", 0x751D8, 16, "67c13008acc8b565269d26c0f050a0adad491f6a54b2a0d6004e588d279f029a"),
            new("K2b", 0x751E8, 16, "15f3e85ee00af72ae8364a9cd0f606c4f475bef9d6288ba653cc0a269356698e"),
            new("K3b", 0x751F8, 16, "df8fe4c4607c44142f18666845b5c99144bfc683b13809bb4ba3ca721c77b98b"),
            new("K4b", 0x75208, 16, "edc595fbd11e1eb0981491926fad66e21415985de365f82f50df88521861023c"),
            new("SESSION_IV", 0x75218, 16, "374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb"),
            new("ROWS", 0x75230, 512, "53887f7e32664a35fd4c1de5a69156776b27da5240a6df389b2aa769fb75b4d5"),
        ]);

    /// <summary>取れなかったあと、次に試すまで待つ時間 (<see cref="Px4Firmware.Backoff"/> と同じ考え)</summary>
    internal static readonly TimeSpan Backoff = TimeSpan.FromMinutes(10);

    /// <summary>置き場 (tuners.json の隣)</summary>
    public static string Folder => Path.GetDirectoryName(Path.GetFullPath(Config.FromEnvironment().TunersFile))!;

    private static readonly Lazy<Dt295FirmwareStore> Default = new(() =>
        new Dt295FirmwareStore(Folder, Pixela, Download, TimeProvider.System));

    /// <summary>3つを揃えて返す。無ければ取ってくる。取れなければ理由を添えて投げる</summary>
    public static Dt295Vendor Ensure() => Default.Value.Ensure();

    /// <summary>
    /// URL の中身をファイルへ。パッケージは 160 MB ほどあるのでメモリには溜めない。
    /// 上限を越えたら止める (違うものが返ってきたときに置き場を使い切らない)
    /// </summary>
    private static void Download(string url, string path)
    {
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        using var cancel = new CancellationTokenSource(TimeSpan.FromMinutes(30));
        using var response = http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel.Token).GetAwaiter().GetResult();
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > Pixela.ZipLimit) throw new InvalidDataException($"大きすぎます ({response.Content.Headers.ContentLength} バイト)");
        using var input = response.Content.ReadAsStream(cancel.Token);
        using var output = File.Create(path);
        var buffer = new byte[1 << 16];
        long total = 0;
        int got;
        while ((got = input.ReadAsync(buffer, cancel.Token).AsTask().GetAwaiter().GetResult()) > 0)
        {
            total += got;
            if (total > Pixela.ZipLimit) throw new InvalidDataException($"大きすぎます ({total} バイトを越えました)");
            output.Write(buffer, 0, got);
        }
    }
}

/// <summary>zip の中のファイル 1 つ。長さと SHA-256 で確かめる</summary>
internal sealed record Dt295Entry(string Path, int Length, string Sha256);

/// <summary>ドライバーから切り出す範囲 1 つ (5.2)</summary>
internal sealed record Dt295Range(string Name, int Offset, int Length, string Sha256);

/// <summary>取り出したもの。<see cref="Material"/> は 5.2 の範囲を表の順につないだもの</summary>
public sealed record Dt295Vendor(byte[] Idle, byte[] Trc, byte[] Material);

/// <summary>パッケージの出どころと、中身の確かめ方</summary>
internal sealed record Dt295FirmwareSource(
    IReadOnlyList<string> Urls,
    string ZipSha256,
    long ZipLimit,
    Dt295Entry Driver,
    Dt295Entry Idle,
    Dt295Entry Trc,
    IReadOnlyList<Dt295Range> Ranges)
{
    /// <summary>素材 (範囲をつないだもの) の長さ</summary>
    public int MaterialLength => Ranges.Sum(range => range.Length);

    /// <summary>zip (読める・戻れるストリーム) から取り出す。どこかが合わなければ <see cref="InvalidDataException"/></summary>
    public Dt295Vendor Extract(Stream zip)
    {
        Check(SHA256.HashData(zip), ZipSha256, "配布 zip");
        zip.Position = 0;
        using var archive = new ZipArchive(zip, ZipArchiveMode.Read, leaveOpen: true);
        var driver = Read(archive, Driver);
        var idle = Read(archive, Idle);
        var trc = Read(archive, Trc);
        return new Dt295Vendor(idle, trc, Cut(driver));
    }

    /// <summary>ドライバーから範囲を切り出して、表の順につなぐ (12.4)</summary>
    public byte[] Cut(ReadOnlySpan<byte> driver)
    {
        var material = new byte[MaterialLength];
        var at = 0;
        foreach (var range in Ranges)
        {
            if (range.Offset < 0 || driver.Length < range.Offset + range.Length) throw new InvalidDataException($"ドライバーが短すぎます ({range.Name})");
            var piece = driver.Slice(range.Offset, range.Length);
            Check(SHA256.HashData(piece), range.Sha256, $"切り出した {range.Name}");
            piece.CopyTo(material.AsSpan(at));
            at += range.Length;
        }
        return material;
    }

    /// <summary>置いてあった素材を確かめる (範囲ごとのハッシュ)</summary>
    public bool Holds(ReadOnlySpan<byte> material)
    {
        if (material.Length != MaterialLength) return false;
        var at = 0;
        foreach (var range in Ranges)
        {
            if (Hex(material.Slice(at, range.Length)) != range.Sha256) return false;
            at += range.Length;
        }
        return true;
    }

    /// <summary>置いてあったファイルを確かめる</summary>
    public static bool Holds(Dt295Entry entry, ReadOnlySpan<byte> data) => data.Length == entry.Length && Hex(data) == entry.Sha256;

    private static byte[] Read(ZipArchive archive, Dt295Entry wanted)
    {
        // エントリーの区切りが \ の zip もあるので、/ にそろえて比べる (名前には空白が入る。12.2)
        var entry = archive.Entries.FirstOrDefault(found => found.FullName.Replace('\\', '/') == wanted.Path)
            ?? throw new InvalidDataException($"配布 zip に {wanted.Path} がありません");
        var name = System.IO.Path.GetFileName(wanted.Path);
        if (entry.Length != wanted.Length) throw new InvalidDataException($"{name}: 長さが違います ({entry.Length} バイト)");
        var data = new byte[wanted.Length];
        using (var stream = entry.Open()) stream.ReadExactly(data);
        Check(SHA256.HashData(data), wanted.Sha256, name);
        return data;
    }

    private static string Hex(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static void Check(byte[] hash, string expected, string what)
    {
        var actual = Convert.ToHexStringLower(hash);
        if (actual != expected) throw new InvalidDataException($"{what}: SHA-256 が違います ({actual})");
    }
}

/// <summary>
/// 置き場 1 つ。置いてあってハッシュが合えばそれを使い、無ければ取ってきて置く。取れなければ
/// <see cref="Dt295Firmware.Backoff"/> のあいだ取り直さず、同じ理由で断る (<see cref="Px4FirmwareStore"/> と同じ形)
/// </summary>
/// <param name="download">URL の中身を、渡したパスのファイルに書く。テストは偽の zip を書く</param>
internal sealed class Dt295FirmwareStore(string folder, Dt295FirmwareSource source, Action<string, string> download, TimeProvider clock)
{
    public const string IdleFile = "dt295-idle.bin";
    public const string TrcFile = "dt295-trc.bin";
    public const string MaterialFile = "dt295-driver.bin";

    /// <summary>公式パッケージの zip の名前 (12.2)。置き場にあれば取ってこずにそれを使う</summary>
    public const string PackageFile = "stationtvx_updater12030002.zip";

    private readonly Lock _gate = new();
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;

    public string? Problem { get; private set; }

    public Dt295Vendor Ensure()
    {
        lock (_gate)
        {
            if (Cached() is { } cached)
            {
                Problem = null;
                return cached;
            }
            if (Problem is { } problem && clock.GetUtcNow() < _retryAt) throw new IOException(problem);
            try
            {
                Log.Write($"PIX-DT295 のデータを PIXELA の公式パッケージから取り出します (置き場: {folder})");
                Directory.CreateDirectory(folder);
                var vendor = Fetch();
                Put(IdleFile, vendor.Idle);
                Put(TrcFile, vendor.Trc);
                Put(MaterialFile, vendor.Material);
                Problem = null;
                Log.Write("PIX-DT295 のデータを取り出しました");
                return vendor;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                _retryAt = clock.GetUtcNow() + Dt295Firmware.Backoff;
                Problem = $"PIX-DT295 のデータを用意できません ({error.Message})。"
                    + $"初めて使うときはインターネットに繋がっているか、PIXELA の公式パッケージ ({PackageFile}) を {folder} に置いてください。"
                    + $"{Dt295Firmware.Backoff.TotalMinutes:F0} 分おきに試し直します";
                throw new IOException(Problem, error);
            }
        }
    }

    /// <summary>置いてある 3 つ。どれかが無いか合わなければ null (取り直す)</summary>
    private Dt295Vendor? Cached()
    {
        byte[]? Load(string name)
        {
            var path = Path.Combine(folder, name);
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }
        var idle = Load(IdleFile);
        var trc = Load(TrcFile);
        var material = Load(MaterialFile);
        if (idle is null || trc is null || material is null) return null;
        if (!Dt295FirmwareSource.Holds(source.Idle, idle) || !Dt295FirmwareSource.Holds(source.Trc, trc) || !source.Holds(material)) return null;
        return new Dt295Vendor(idle, trc, material);
    }

    /// <summary>書きかけを読ませない</summary>
    private void Put(string name, byte[] data)
    {
        var target = Path.Combine(folder, name);
        var working = $"{target}.writing";
        File.WriteAllBytes(working, data);
        File.Move(working, target, overwrite: true);
    }

    /// <summary>URL を順に試す。zip は置き場に一時ファイルとして落とし、取り出したら消す</summary>
    private Dt295Vendor Fetch()
    {
        List<string> reasons = [];
        // 使う人が置いた公式パッケージ (取ってこられない機械のため)。消さない
        var placed = Path.Combine(folder, PackageFile);
        if (File.Exists(placed))
        {
            try
            {
                using var zip = File.OpenRead(placed);
                return source.Extract(zip);
            }
            catch (Exception error) when (error is InvalidDataException or IOException)
            {
                reasons.Add($"{PackageFile}: {error.Message}");
            }
        }
        var temporary = Path.Combine(folder, "dt295-package.zip.download");
        foreach (var url in source.Urls)
        {
            try
            {
                download(url, temporary);
                using var zip = File.OpenRead(temporary);
                return source.Extract(zip);
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or OperationCanceledException or InvalidDataException or IOException)
            {
                var why = error is OperationCanceledException ? "時間切れ" : error.Message;
                reasons.Add($"{new Uri(url).Host}: {why}");
            }
            finally
            {
                try
                {
                    File.Delete(temporary);
                }
                catch (IOException)
                {
                    // 消せなくても次の取得で上書きする
                }
            }
        }
        throw new IOException(string.Join(" / ", reasons));
    }
}

/// <summary>
/// ドライバー素材 (5.2) を読む。鍵は片割れ 2 つのバイトごとの XOR、初期化表は「レジスター番号 LE32・値 LE32」の 8 バイトの行
/// </summary>
public sealed class Dt295Material
{
    public IReadOnlyList<(byte Register, byte Value)> TerrestrialDemod { get; }
    public IReadOnlyList<(byte Register, byte Value)> SatelliteDemod { get; }
    public IReadOnlyList<(byte Register, byte Value)> TerrestrialRfA { get; }
    public IReadOnlyList<(byte Register, byte Value)> TerrestrialRfB { get; }
    public byte[] AuthPrefix { get; }
    public byte[] SessionSuffix { get; }
    public byte[] RefreshSuffix { get; }
    public byte[] Key1 { get; }
    public byte[] Key2 { get; }
    public byte[] Key3 { get; }
    public byte[] Key4 { get; }
    public byte[] SessionIv { get; }
    public byte[] Rows { get; }

    /// <summary>S_DEMOD がすべて 0 (素材が欠けている。8.3)</summary>
    public bool SatelliteMissing { get; }

    /// <summary>範囲を表の順につないだもの (<see cref="Dt295Vendor.Material"/>) から。長さは <paramref name="ranges"/> の並びで決まる</summary>
    internal Dt295Material(ReadOnlySpan<byte> material, IReadOnlyList<Dt295Range> ranges)
    {
        var pieces = new Dictionary<string, byte[]>();
        var at = 0;
        foreach (var range in ranges)
        {
            if (material.Length < at + range.Length) throw new InvalidDataException("ドライバー素材が短すぎます");
            pieces[range.Name] = material.Slice(at, range.Length).ToArray();
            at += range.Length;
        }
        byte[] Piece(string name, int length)
        {
            if (!pieces.TryGetValue(name, out var piece) || piece.Length != length) throw new InvalidDataException($"ドライバー素材に {name} ({length} バイト) がありません");
            return piece;
        }
        TerrestrialDemod = Table(Piece("T_DEMOD", 176), "T_DEMOD");
        var satellite = Piece("S_DEMOD", 144);
        SatelliteMissing = satellite.All(value => value == 0);
        SatelliteDemod = Table(satellite, "S_DEMOD");
        TerrestrialRfA = Table(Piece("T_RF_A", 208), "T_RF_A");
        TerrestrialRfB = Table(Piece("T_RF_B", 224), "T_RF_B");
        AuthPrefix = Piece("A_PREFIX", 30);
        SessionSuffix = Piece("S_SUFFIX", 12);
        RefreshSuffix = Piece("R_SUFFIX", 28);
        Key1 = Xor(Piece("K1a", 16), Piece("K1b", 16));
        Key2 = Xor(Piece("K2a", 16), Piece("K2b", 16));
        Key3 = Xor(Piece("K3a", 16), Piece("K3b", 16));
        Key4 = Xor(Piece("K4a", 16), Piece("K4b", 16));
        SessionIv = Piece("SESSION_IV", 16);
        Rows = Piece("ROWS", 512);
    }

    /// <summary>公式パッケージの範囲の並びで読む</summary>
    public static Dt295Material From(Dt295Vendor vendor) => new(vendor.Material, Dt295Firmware.Pixela.Ranges);

    private static byte[] Xor(byte[] a, byte[] b)
    {
        var key = new byte[a.Length];
        for (var i = 0; i < a.Length; i++) key[i] = (byte)(a[i] ^ b[i]);
        return key;
    }

    /// <summary>8 バイトの行の並び。レジスター番号も値も 255 以下でなければ不正 (5.2)</summary>
    internal static (byte Register, byte Value)[] Table(ReadOnlySpan<byte> data, string name)
    {
        if (data.Length % 8 != 0) throw new InvalidDataException($"{name} の長さが 8 の倍数ではありません");
        var rows = new (byte, byte)[data.Length / 8];
        for (var i = 0; i < rows.Length; i++)
        {
            var register = BinaryPrimitives.ReadUInt32LittleEndian(data[(i * 8)..]);
            var value = BinaryPrimitives.ReadUInt32LittleEndian(data[(i * 8 + 4)..]);
            if (register > 0xFF || value > 0xFF) throw new InvalidDataException($"{name} の {i} 行目が範囲の外です");
            rows[i] = ((byte)register, (byte)value);
        }
        return rows;
    }
}
