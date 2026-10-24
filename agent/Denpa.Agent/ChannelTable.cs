using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// 選局表。**チャンネル名を周波数に直す。** 値は <a href="https://github.com/kazuki0824/recisdb-rs">recisdb-rs</a> の
/// <c>channels.rs</c> から取った。**地上波は Hz、衛星は kHz** (DVB API の決まり。取り違えても ioctl は通り、
/// 同期しないだけ)。docs/agent.md「選局表」
/// </summary>
public static class ChannelTable
{
    /// <summary>`linux/dvb/frontend.h` の <c>SYS_ISDBT</c></summary>
    public const int SysIsdbt = 8;

    /// <summary>`linux/dvb/frontend.h` の <c>SYS_ISDBS</c></summary>
    public const int SysIsdbs = 9;

    /// <summary>TS を選り分けない (<c>NO_STREAM_ID_FILTER</c>)</summary>
    public const uint NoStreamId = ~0U;

    /// <summary>
    /// 1つの物理チャンネルを選局するのに要るもの、全部。
    /// </summary>
    /// <param name="Type">denpa の種別 (GR / BS / CS)</param>
    /// <param name="Delivery">DVB の方式 (<see cref="SysIsdbt"/> / <see cref="SysIsdbs"/>)</param>
    /// <param name="Frequency">**地上波は Hz、衛星は kHz**</param>
    /// <param name="RelativeTs">衛星で同じ周波数に入っている何本目か。無ければ -1</param>
    /// <param name="Slot">
    /// 衛星のスロット。TSID が分からないときに px4d の TUNE の <c>slot</c> で渡す
    /// (<see cref="Px4Tuner.TuneRequest"/>)。BS は相対番号そのもの、CS は1つしか入っていないので 0
    /// </param>
    public sealed record Tuning(string Type, int Delivery, uint Frequency, int RelativeTs, int Slot)
    {
        public bool Satellite => Delivery == SysIsdbs;
    }

    /// <summary>
    /// チャンネル名を読む。**読めなければ null** (総当たりのスキャンが投げてくる
    /// 名前もここを通る)。
    ///
    /// <para>
    /// <c>T13</c>–<c>T62</c> / <c>C13</c>–<c>C63</c> (CATV) / <c>BS01_0</c>–<c>BS23_7</c> / <c>CS02</c>–<c>CS24</c>。
    /// 衛星は BS が奇数、CS が偶数で、**BS-7 と BS-17 だけは受け取らない** —
    /// あそこは 4K/8K (ISDB-S3) で、この構成のチューナーでは復調できない。
    /// </para>
    /// </summary>
    public static Tuning? Parse(string name)
    {
        if (name.StartsWith("T", StringComparison.Ordinal))
        {
            if (!Number(name[1..], out var channel) || channel is < 13 or > 62) return null;
            // UHF 13-62ch。1/7 MHz のずれは放送のとおりで、丸めない
            return new Tuning("GR", SysIsdbt, (uint)(473142857 + (channel - 13) * 6000000), -1, 0);
        }

        if (name.StartsWith("C", StringComparison.Ordinal) && !name.StartsWith("CS", StringComparison.Ordinal))
        {
            /*
             * CATV の周波数変換パススルー。地デジの電波をそのまま CATV のチャンネルの周波数に移して送るので、
             * 選局は地上波と同じで周波数だけが違う。ミッドバンド C13-C22 (108-168MHz) と
             * スーパーハイバンド C23-C63 (222-468MHz)。真ん中から 1/7 MHz ずれるのも地上波と同じ
             */
            if (!Number(name[1..], out var channel) || channel is < 13 or > 63) return null;
            var center = channel <= 22 ? 111000000 + (channel - 13) * 6000000 : 225000000 + (channel - 23) * 6000000;
            return new Tuning("GR", SysIsdbt, (uint)(center + 142857), -1, 0);
        }

        if (name.StartsWith("BS", StringComparison.Ordinal))
        {
            var body = name[2..];
            var relative = -1;
            var underscore = body.IndexOf('_');
            if (underscore >= 0)
            {
                if (!Number(body[(underscore + 1)..], out relative) || relative is < 0 or > 7) return null;
                body = body[..underscore];
            }
            if (!Number(body, out var channel)) return null;
            if (channel is < 1 or > 23 || channel % 2 == 0) return null;
            if (channel is 7 or 17) return null;  // ISDB-S3 (4K/8K)。この復調では受からない

            var index = channel / 2;  // BS01 -> 0 … BS23 -> 11
            return new Tuning("BS", SysIsdbs, (uint)(1049480 + 38360 * index), relative, Math.Max(0, relative));
        }

        if (name.StartsWith("CS", StringComparison.Ordinal))
        {
            if (!Number(name[2..], out var channel)) return null;
            if (channel is < 2 or > 24 || channel % 2 != 0) return null;

            return new Tuning("CS", SysIsdbs, (uint)(1613000 + 40000 * (channel / 2 - 1)), -1, 0);
        }

        return null;
    }

    /// <summary>
    /// DVB に渡す <c>DTV_STREAM_ID</c>。衛星の復調器は **TSID で選り分ける**ので、denpa が言ってくる
    /// 相対番号 (<c>BS15_0</c>) を TSID に直す。<paramref name="known"/> (自分の <c>channels.json</c>) が勝ち、
    /// 埋め込んだ表はまだ1度もスキャンしていないときだけ
    /// </summary>
    public static uint StreamId(string name, Tuning tuning, Func<string, int?>? known = null)
    {
        // CS は1つの中継に1つしか入っていない。選り分ける必要が無い
        if (!tuning.Satellite || tuning.RelativeTs < 0) return NoStreamId;

        var scanned = known?.Invoke(name);
        if (scanned is > 0) return (uint)scanned.Value;

        return Fallback.TryGetValue(name, out var id) ? id : NoStreamId;
    }

    /// <summary>スキャン前に使う BS の TSID。recisdb の表 (<c>dvbv5_channels_isdbs.conf</c>) と同じ</summary>
    private static readonly Dictionary<string, uint> Fallback = new(StringComparer.Ordinal)
    {
        ["BS01_0"] = 16400, ["BS01_1"] = 16401, ["BS01_2"] = 16402,
        ["BS03_0"] = 16432, ["BS03_1"] = 17969, ["BS03_2"] = 17970,
        ["BS05_0"] = 17488, ["BS05_1"] = 17489,
        ["BS09_0"] = 16528, ["BS09_1"] = 16530,
        ["BS13_0"] = 16592, ["BS13_1"] = 16593, ["BS13_2"] = 18130,
        ["BS15_0"] = 16625, ["BS15_1"] = 16626, ["BS15_2"] = 18675,
        ["BS19_0"] = 18224, ["BS19_1"] = 18225, ["BS19_2"] = 18226, ["BS19_3"] = 18227,
        ["BS21_0"] = 18256, ["BS21_1"] = 18257, ["BS21_2"] = 18258,
        ["BS23_0"] = 18288, ["BS23_1"] = 18801, ["BS23_2"] = 18803,
    };

    private static bool Number(string text, out int value)
    {
        // 0詰めは許す (`BS01_0` と `BS1_0` は同じもの)。それ以外は受け取らない
        value = 0;
        return text.Length is > 0 and <= 3
            && text.All(char.IsAsciiDigit)
            && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }
}
