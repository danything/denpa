using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// 選局表。**チャンネル名を周波数に直す。** 値は <a href="https://github.com/kazuki0824/recisdb-rs">recisdb-rs</a> の
/// <c>channels.rs</c> から取った。**地上波は Hz、衛星は kHz** (DVB API の決まり。取り違えても ioctl は通り、
/// 同期しないだけ)。docs/agent.md「選局表」
///
/// <para>
/// **衛星は名前だけで選局できる。** 名前に中継器と TSID が入っている (<c>BS15:16625</c>)。中継器の周波数は規格で
/// 決まっていて再編でも変わらないので式で出し、TSID はそのまま復調器に渡す。控え (<c>channels.json</c>) は読まない。
/// どの中継器にどの TSID があるかは denpa が放送の NIT から決める (<c>src/lib/server/satellite.ts</c>)
/// </para>
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
    /// 1 つの物理チャンネルを選局するのに要るもの、全部。
    /// </summary>
    /// <param name="Type">denpa の種別 (GR / BS / CS)</param>
    /// <param name="Delivery">DVB の方式 (<see cref="SysIsdbt"/> / <see cref="SysIsdbs"/>)</param>
    /// <param name="Frequency">**地上波は Hz、衛星は kHz**</param>
    /// <param name="StreamId">
    /// 復調器に渡す TSID。BS で名前に TSID があるときだけ入る。無ければ <see cref="NoStreamId"/> (選り分けない) で、
    /// その中継器の先頭の TS が来る (NIT を読む入口の <c>BS15</c> はこれ)
    /// </param>
    /// <param name="ServiceId">
    /// 受ける番組の番組番号 (service_id)。名前に <c>/152</c> のように付いているときだけ入る。無ければ null。
    /// いまはどの機材も番組を選り分けず、TS をまるごと流す
    /// </param>
    public sealed record Tuning(string Type, int Delivery, uint Frequency, uint StreamId, int? ServiceId = null)
    {
        public bool Satellite => Delivery == SysIsdbs;
    }

    /// <summary>
    /// チャンネル名を読む。**読めなければ null。**
    ///
    /// <para>
    /// <c>T13</c>–<c>T62</c> / <c>C13</c>–<c>C63</c> (CATV) / <c>BS01</c>–<c>BS23</c> / <c>CS02</c>–<c>CS24</c>。
    /// 衛星は <c>:TSID</c> を付けて TS を指す (<c>BS15:16625</c>)。付けなければ中継器の先頭の TS。
    /// 衛星は BS が奇数、CS が偶数で、**BS-7 と BS-17 だけは受け取らない。**
    /// あそこは 4K/8K (ISDB-S3) で、この構成のチューナーでは復調できない。
    /// </para>
    /// </summary>
    public static Tuning? Parse(string name)
    {
        if (name.StartsWith("T", StringComparison.Ordinal))
        {
            if (!Number(name[1..], out var channel) || channel is < 13 or > 62) return null;
            // UHF 13-62ch。1/7 MHz のずれは放送のとおりで、丸めない
            return new Tuning("GR", SysIsdbt, (uint)(473142857 + (channel - 13) * 6000000), NoStreamId);
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
            return new Tuning("GR", SysIsdbt, (uint)(center + 142857), NoStreamId);
        }

        if (name.StartsWith("BS", StringComparison.Ordinal))
        {
            if (!Satellite(name[2..], out var channel, out var tsid, out var service)) return null;
            if (channel is < 1 or > 23 || channel % 2 == 0) return null;
            if (channel is 7 or 17) return null;  // ISDB-S3 (4K/8K)。この復調では受からない

            var index = channel / 2;  // BS01 -> 0 … BS23 -> 11
            return new Tuning("BS", SysIsdbs, (uint)(1049480 + 38360 * index), tsid, service);
        }

        if (name.StartsWith("CS", StringComparison.Ordinal))
        {
            if (!Satellite(name[2..], out var channel, out _, out var service)) return null;
            if (channel is < 2 or > 24 || channel % 2 != 0) return null;

            // CS は 1 つの中継器に 1 本しか入っていない。TSID は名前で TS を見分けるためだけにあり、選り分けない
            return new Tuning("CS", SysIsdbs, (uint)(1613000 + 40000 * (channel / 2 - 1)), NoStreamId, service);
        }

        return null;
    }

    /// <summary>
    /// 衛星の名前の、種別の後ろ (<c>15:16625</c> か <c>15</c>。番組番号を付けるなら <c>15:16625/152</c>)。
    /// TSID は 1〜65535。付いていなければ <see cref="NoStreamId"/>。番組番号は 1〜65535 で、付いていなければ null
    /// </summary>
    private static bool Satellite(string body, out int channel, out uint tsid, out int? service)
    {
        tsid = NoStreamId;
        service = null;
        channel = 0;
        var slash = body.IndexOf('/');
        if (slash >= 0)
        {
            var text = body[(slash + 1)..];
            if (text.Length is 0 or > 5 || !text.All(char.IsAsciiDigit)
                || !int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number is < 1 or > 65535) return false;
            service = number;
            body = body[..slash];
        }
        var colon = body.IndexOf(':');
        if (colon < 0) return Number(body, out channel);
        if (!Number(body[..colon], out channel)) return false;
        var id = body[(colon + 1)..];
        if (id.Length is 0 or > 5 || !id.All(char.IsAsciiDigit)
            || !int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            || value is < 1 or > 65535) return false;
        tsid = (uint)value;
        return true;
    }

    private static bool Number(string text, out int value)
    {
        // 0 詰めは許す (`BS01` と `BS1` は同じもの)。それ以外は受け取らない
        value = 0;
        return text.Length is > 0 and <= 3
            && text.All(char.IsAsciiDigit)
            && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }
}
