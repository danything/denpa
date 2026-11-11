using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// IT930x に流し込むファームウェアと、その区切り。
///
/// <para>
/// 実行ファイルに埋め込んだ <c>it930x-firmware.bin</c> (firmware/。Denpa.Agent.csproj の LogicalName)。本体には入っておらず、機材を開くたびにホストから RAM へ流し込む。
/// 中身は ITE の SDK の <c>api/brfirmware.h</c> の <c>brFirmware_codes[]</c> そのもので、区切りの表は入っていない (firmware/README.md)。
/// 区切りの表 (<see cref="Segments"/>) は同じファイルの <c>brFirmware_segments[]</c> を写したもの。どれも種類 1 (<c>SCATTER_WRITE</c> で送る) で、
/// <c>brFirmware_partitions[]</c> は 46 なので、全部を 1 回で送る (<c>_IT9300_loadFirmware</c>)。
/// 表は ITE の SDK のデータで、ITE Tech. から使ってよいと確認を得ている (docs/licenses.md)
/// </para>
/// </summary>
public static class It930xFirmware
{
    /// <summary>区切りごとのバイト数 (<c>brFirmware_segments[]</c>。48 バイトが 44 個、47 バイトと 10 バイトが 1 個ずつ。足すと 2,169)</summary>
    public static readonly IReadOnlyList<int> Segments =
    [
        48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
        48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
        48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
        48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
        48, 48, 48, 48, 47, 10,
    ];

    public const string FileName = "it930x-firmware.bin";

    /// <summary>受け付けるファームウェアの SHA-256 (ITE の Linux ドライバの V1_3_0_0)</summary>
    internal const string Sha256 = "5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484";

    /// <summary>埋め込んだリソースの名前 (Denpa.Agent.csproj の LogicalName)</summary>
    internal const string ResourceName = FileName;

    private static readonly Lazy<byte[]> Bundled = new(() => Check(Embedded()));

    /// <summary>実行ファイルに埋め込んだファームウェア (確かめる前のもの)</summary>
    internal static byte[] Embedded()
    {
        using var stream = typeof(It930xFirmware).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new IOException($"同梱の {FileName} が実行ファイルに入っていません");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>同梱のファームウェア。SHA-256 と区切りを確かめたもの。合わなければ <see cref="InvalidDataException"/></summary>
    public static byte[] Code => Bundled.Value;

    /// <summary>
    /// SHA-256 が <see cref="Sha256"/> と同じで、区切りの合計が長さと合うかを確かめる。
    /// 違うバイト列は区切りの表と合わないので使わない
    /// </summary>
    internal static byte[] Check(byte[] code, string sha256 = Sha256)
    {
        if (Convert.ToHexStringLower(SHA256.HashData(code)) != sha256)
        {
            throw new InvalidDataException($"IT930x のファームウェアの SHA-256 が違います ({FileName})");
        }
        var total = Segments.Sum();
        if (total != code.Length)
        {
            throw new InvalidDataException($"IT930x のファームウェアの区切りが合いません (区切りの合計 {total} バイト、ファームウェア {code.Length} バイト)");
        }
        return code;
    }

    /// <summary>区切りごとに分ける (<see cref="Segments"/> の順)。長さは呼ぶ前に <see cref="Check"/> で確かめておく</summary>
    public static IEnumerable<ReadOnlyMemory<byte>> Split(byte[] code)
    {
        var at = 0;
        foreach (var length in Segments)
        {
            yield return code.AsMemory(at, length);
            at += length;
        }
    }
}
