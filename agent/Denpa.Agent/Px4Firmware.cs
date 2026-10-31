using System.IO.Compression;
using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// IT930x のファームウェア (px4-userland の機材に挿すたびに流し込む)。**イメージには入れず、使う人の機械で取ってくる。**
///
/// <para>
/// 本体には入っておらず、挿すたびにホストから RAM へ流し込むもの。px4-userland は受理するバージョンを SHA-256 で
/// 1つに固定していて (SPEC 4.5)、違うものを渡すと <c>FIRMWARE_REJECTED</c> で起動しない。
/// **再配布の許諾は誰も持っていない**ので、公開しているイメージには入れない。px4d を初めて起こすときに
/// PLEX 公式の Windows ドライバ (PX-W3U4 BDA Ver.1.0 64bit) を取ってきて <c>PXW3U4.sys</c> から切り出し、
/// 設定の置き場 (tuners.json の隣) に置いて次からはそれを使う (docs/tuner-px4.md「ファームウェア」)。
/// </para>
///
/// <para>
/// **もう置いてあればそれを使う。** Mac と Windows は install.sh / install.ps1 が入れるときに同じものを切り出して
/// px4-userland の横に置き、<c>PX4_FIRMWARE</c> で指している。
/// </para>
/// </summary>
public static class Px4Firmware
{
    public const string FileName = "it930x-firmware.bin";

    /// <summary>
    /// 取ってくる先と確かめ方。**install.sh / install.ps1 も同じ値を持っている** (変えるときは3つとも)。
    /// PLEX のサイトが落ちていることがある (2026-10-30 はサーバーの「無効な URL」のページと別の証明書を返した) ので、
    /// 取れなければ Internet Archive の写し (同じハッシュ) から取る
    /// </summary>
    internal static readonly Px4FirmwareSource Plex = new(
        Urls:
        [
            "https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip",
            "https://web.archive.org/web/20260927060746id_/http://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip",
        ],
        ZipSha256: "bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200",
        Entry: "pxw3u4_BDA_ver1x64/PXW3U4.sys",
        SysSha256: "8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722",
        Offset: 0x287d0,
        Length: 2169,
        FirmwareSha256: "5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484");

    /// <summary>
    /// 取れなかったあと、次に試すまで待つ時間。**選局のたびには取りに行かない** (番組表の取得や録画の予約は
    /// 数分おきに選局する。PLEX のサイトや Internet Archive が落ちるのは何時間という単位)
    /// </summary>
    internal static readonly TimeSpan Backoff = TimeSpan.FromMinutes(10);

    private static readonly Lazy<Px4FirmwareStore> Default = new(() => new Px4FirmwareStore(
        Existing(), Config.FromEnvironment().Px4FirmwareFile, Plex, Download, TimeProvider.System));

    /// <summary>
    /// 先に見る置き場。<c>PX4_FIRMWARE</c> (install.sh / install.ps1 が書く) と、px4-userland の横
    /// (前のバージョンのイメージはここに入れていた)
    /// </summary>
    private static IReadOnlyList<string> Existing() =>
        [
            .. Environment.GetEnvironmentVariable("PX4_FIRMWARE") is { Length: > 0 } configured ? new[] { configured } : [],
            Path.Combine(Px4Userland.Dir, "firmware", FileName),
        ];

    /// <summary>ファームウェアのパス。無ければ取ってくる。取れなければ理由を添えて投げる (<see cref="Px4FirmwareStore.Ensure"/>)</summary>
    public static string Ensure() => Default.Value.Ensure();

    /// <summary>取れなかった理由 (取れているか、まだ試していなければ null)。チューナー画面の <c>error</c> に出す</summary>
    public static string? Problem => Default.IsValueCreated ? Default.Value.Problem : null;

    private static byte[] Download(string url)
    {
        using var http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(60),
            // 本物は数 MB。違うものが返ってきたときにメモリを使い切らない
            MaxResponseContentBufferSize = 64 << 20,
        };
        return http.GetByteArrayAsync(url).GetAwaiter().GetResult();
    }
}

/// <summary>ファームウェアの出どころ。配布 zip・<c>.sys</c>・切り出したものの3つをハッシュで確かめる</summary>
internal sealed record Px4FirmwareSource(
    IReadOnlyList<string> Urls,
    string ZipSha256,
    string Entry,
    string SysSha256,
    int Offset,
    int Length,
    string FirmwareSha256)
{
    /// <summary>配布 zip からファームウェアを切り出す。どこかが合わなければ <see cref="InvalidDataException"/></summary>
    public byte[] Extract(byte[] zip)
    {
        Check(zip, ZipSha256, "配布 zip");
        using var archive = new ZipArchive(new MemoryStream(zip, writable: false), ZipArchiveMode.Read);
        var entry = archive.GetEntry(Entry) ?? throw new InvalidDataException($"配布 zip に {Entry} がありません");
        using var sys = new MemoryStream();
        using (var stream = entry.Open()) stream.CopyTo(sys);
        Check(sys.GetBuffer().AsSpan(0, (int)sys.Length), SysSha256, Path.GetFileName(Entry));
        if (sys.Length < Offset + Length) throw new InvalidDataException($"{Path.GetFileName(Entry)} が短すぎます ({sys.Length} バイト)");
        var firmware = sys.GetBuffer().AsSpan(Offset, Length).ToArray();
        Check(firmware, FirmwareSha256, "切り出したファームウェア");
        return firmware;
    }

    private static void Check(ReadOnlySpan<byte> data, string expected, string what)
    {
        var actual = Convert.ToHexStringLower(SHA256.HashData(data));
        if (actual != expected) throw new InvalidDataException($"{what}: SHA-256 が違います ({actual})");
    }
}

/// <summary>
/// ファームウェアの置き場1つ。**置いてあるものが勝ち**、無ければ取ってきて <c>target</c> に置く。
/// 取れなければ <see cref="Px4Firmware.Backoff"/> のあいだ取りに行かず、同じ理由で断る
/// </summary>
/// <param name="existing">先に見る置き場。どれかにあればそれを使い、取りに行かない</param>
/// <param name="target">取ってきたものを置く場所</param>
/// <param name="download">URL の中身を返す。テストは偽の zip を返す</param>
internal sealed class Px4FirmwareStore(
    IReadOnlyList<string> existing, string target, Px4FirmwareSource source, Func<string, byte[]> download, TimeProvider clock)
{
    private readonly Lock _gate = new();
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;

    public string? Problem { get; private set; }

    /// <summary>
    /// ファームウェアのパス。無ければ取ってくる (筐体が2台でも取りに行くのは1度。もう1台は待つ)。
    /// 取れなければ、または待つ時間のうちなら、理由を添えて <see cref="IOException"/>
    /// </summary>
    public string Ensure()
    {
        foreach (var path in existing)
        {
            if (!File.Exists(path)) continue;
            // 取れなかったあとで手で置かれた
            Problem = null;
            return path;
        }
        lock (_gate)
        {
            if (File.Exists(target)) return target;
            if (Problem is { } problem && clock.GetUtcNow() < _retryAt) throw new IOException(problem);
            try
            {
                Log.Write($"IT930x のファームウェアを PLEX のドライバから切り出します (置き場: {target})");
                var firmware = Fetch();
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(target))!);
                // 書きかけを読ませない (px4d に途中までのものを渡すと FIRMWARE_REJECTED になる)
                var working = $"{target}.writing";
                File.WriteAllBytes(working, firmware);
                File.Move(working, target, overwrite: true);
                Problem = null;
                Log.Write("IT930x のファームウェアを切り出しました");
                return target;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                _retryAt = clock.GetUtcNow() + Px4Firmware.Backoff;
                Problem = $"IT930x のファームウェアを用意できません ({error.Message})。"
                    + $"初めて使うときはインターネットに繋がっている必要があります。{Px4Firmware.Backoff.TotalMinutes:F0} 分おきに試し直します";
                throw new IOException(Problem, error);
            }
        }
    }

    /// <summary>URL を順に試す。どれも駄目なら、それぞれの理由を並べて投げる</summary>
    private byte[] Fetch()
    {
        List<string> reasons = [];
        foreach (var url in source.Urls)
        {
            try
            {
                return source.Extract(download(url));
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidDataException or IOException)
            {
                // TaskCanceledException は HttpClient の時間切れ
                var why = error is TaskCanceledException ? "時間切れ" : error.Message;
                reasons.Add($"{new Uri(url).Host}: {why}");
            }
        }
        throw new IOException(string.Join(" / ", reasons));
    }
}
