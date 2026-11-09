using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// IT930x に流し込むファームウェアと、その区切り。
///
/// <para>
/// バイト列は px4d に渡すものと同じ、同梱の <c>it930x-firmware.bin</c> (<see cref="Px4Firmware.Bundled"/>)。中身は ITE の SDK の
/// <c>api/brfirmware.h</c> の <c>brFirmware_codes[]</c> そのもので、区切りの表は入っていない (firmware/README.md)。
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

    private static readonly Lazy<byte[]> Bundled = new(() => Check(Px4Firmware.Bundled()));

    /// <summary>同梱のファームウェア。SHA-256 と区切りを確かめたもの。合わなければ <see cref="InvalidDataException"/></summary>
    public static byte[] Code => Bundled.Value;

    /// <summary>
    /// SHA-256 が px4d に渡すものと同じで、区切りの合計が長さと合うかを確かめる。
    /// 違うバイト列は区切りの表と合わないので使わない
    /// </summary>
    internal static byte[] Check(byte[] code, string sha256 = Px4Firmware.Sha256)
    {
        if (Convert.ToHexStringLower(SHA256.HashData(code)) != sha256)
        {
            throw new InvalidDataException($"IT930x のファームウェアの SHA-256 が違います ({Px4Firmware.FileName})");
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
