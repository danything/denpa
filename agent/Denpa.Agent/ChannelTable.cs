using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// 選局表。**チャンネル名を周波数に直す。** 値は <a href="https://github.com/kazuki0824/recisdb-rs">recisdb-rs</a> の
/// <c>channels.rs</c> と <c>dvbv5_channels_isdbs.conf</c> から取った (J.83B の <c>H01</c>〜<c>H105</c> と ISDB-C は CXD2856 の仕様書 7.1・8.2 から)。
/// **地上波と J.83B と ISDB-C は Hz、衛星は kHz** (DVB API の決まり。取り違えても ioctl は通り、同期しないだけ)。docs/agent.md「選局表」
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

    /// <summary>`linux/dvb/frontend.h` の <c>SYS_DVBC_ANNEX_B</c> (J.83 Annex B。スカパー！プレミアムサービス光)</summary>
    public const int SysDvbcAnnexB = 3;

    /// <summary>スカパー！プレミアムサービス光 (J.83B) の種別。サーバの <c>ChannelType</c> の <c>SKY</c></summary>
    public const string Sky = "SKY";

    /// <summary>`linux/dvb/frontend.h` の <c>SYS_ISDBC</c> (J.83 Annex C。ケーブルテレビのトランスモジュレーション方式。CXD2856 の仕様書 8)</summary>
    public const int SysIsdbc = 10;

    /// <summary>ケーブルテレビのトランスモジュレーション方式 (ISDB-C) の種別。サーバの <c>ChannelType</c> の <c>CATV</c> (画面では「ケーブル」)</summary>
    public const string Catv = "CATV";

    /// <summary>TS を選り分けない (<c>NO_STREAM_ID_FILTER</c>)</summary>
    public const uint NoStreamId = ~0U;

    /// <summary>
    /// 1 つの物理チャンネルを選局するのに要るもの、全部。
    /// </summary>
    /// <param name="Type">denpa の種別 (GR / BS / CS / CATV / SKY)</param>
    /// <param name="Delivery">DVB の方式 (<see cref="SysIsdbt"/> / <see cref="SysIsdbs"/> / <see cref="SysDvbcAnnexB"/> / <see cref="SysIsdbc"/>)</param>
    /// <param name="Frequency">**地上波と J.83B と ISDB-C は Hz、衛星は kHz**</param>
    /// <param name="StreamId">
    /// 復調器に渡す TSID。BS で名前に TSID があるときだけ入る。無ければ <see cref="NoStreamId"/> (選り分けない) で、
    /// その中継器の先頭の TS が来る (NIT を読む入口の <c>BS15</c> はこれ)
    /// </param>
    /// <param name="ServiceId">
    /// 受ける番組の番組番号 (service_id)。名前に <c>/152</c> のように付いているときだけ入る。無ければ null。
    /// いまはどの機材も番組を選り分けず、TS をまるごと流す
    /// </param>
    /// <param name="ShiftedFrequency">
    /// J.83B と ISDB-C で、ずらして送られることがあるチャンネルの、ずらした周波数 (Hz)。ほかは null。
    /// どちらで送られているかは選局するまで分からないので、受ける側が両方を試す (<see cref="It930xTuner"/>)
    /// </param>
    /// <param name="TsmfIndex">
    /// ISDB-C で受ける TS。TSMF のフレームにある有効な TS を、相対 TS 番号の小さい順に並べたときの何本目か (0〜14。CXD2856 の仕様書 8.7)。
    /// 名前に <c>:2</c> のように付いているときだけ入り、無ければ 0。ほかの方式では使わない
    /// </param>
    public sealed record Tuning(
        string Type, int Delivery, uint Frequency, uint StreamId, int? ServiceId = null, uint? ShiftedFrequency = null, int TsmfIndex = 0)
    {
        public bool Satellite => Delivery == SysIsdbs;

        /// <summary>J.83B (スカパー！プレミアムサービス光)</summary>
        public bool Cable => Delivery == SysDvbcAnnexB;

        /// <summary>ISDB-C (J.83 Annex C。ケーブルテレビのトランスモジュレーション方式)。J.83B (<see cref="Cable"/>) とは別の方式</summary>
        public bool IsdbC => Delivery == SysIsdbc;
    }

    /// <summary>地上波とケーブルの周波数 (Hz) を、復調器やチューナーに渡す kHz に丸める (衛星の周波数ははじめから kHz)</summary>
    public static uint Khz(uint hertz) => (uint)((hertz + 500UL) / 1000);

    /// <summary>
    /// チャンネル名を読む。**読めなければ null。**
    ///
    /// <para>
    /// <c>T13</c>–<c>T62</c> / <c>C13</c>–<c>C63</c> (ケーブルテレビのパススルー。種別は GR) / <c>BS01</c>–<c>BS23</c> / <c>CS02</c>–<c>CS24</c> /
    /// <c>H01</c>–<c>H105</c> (スカパー！プレミアムサービス光。J.83B) /
    /// <c>QC13</c>–<c>QC63</c>・<c>QU13</c>–<c>QU62</c>・<c>QV1</c>–<c>QV12</c> (ISDB-C。種別 <c>CATV</c>。CATV・UHF・VHF の帯域)。
    /// ISDB-C は <c>:k</c> を付けて TSMF の TS を指す (<c>QC30:2</c>。有効な TS の 0〜14 本目)。付けなければ 0 本目。
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
             * 選局は地上波と同じで周波数だけが違う。ミッドバンド C13-C22 (108-170MHz。C22 だけは 2 MHz 上の 164-170MHz) と
             * スーパーハイバンド C23-C63 (222-468MHz)。真ん中から 1/7 MHz ずれるのも地上波と同じ
             */
            if (!Number(name[1..], out var channel) || channel is < 13 or > 63) return null;
            var center = channel switch
            {
                <= 21 => 111000000 + (channel - 13) * 6000000,
                22 => 167000000,
                _ => 225000000 + (channel - 23) * 6000000,
            };
            return new Tuning("GR", SysIsdbt, (uint)(center + 142857), NoStreamId);
        }

        if (name.StartsWith("H", StringComparison.Ordinal))
        {
            /*
             * スカパー！プレミアムサービス光 (J.83B)。93.25 MHz から 6.5 MHz おきに H01〜H105 (769.25 MHz まで) の中心周波数で、
             * CATV と違って 1/7 MHz はずらさない (CXD2856 の仕様書 7.1。Digital Devices のドライバーの表と同じとされる並び)。
             * 地域によってずらして送られるもの (H11〜H12 は +1 MHz、H26〜H28 は +4 MHz、H44 は +2.2 MHz) は、ずらした周波数も持つ
             */
            if (!Number(name[1..], out var channel) || channel is < 1 or > 105) return null;
            var shift = channel switch
            {
                11 or 12 => 1_000_000u,
                >= 26 and <= 28 => 4_000_000u,
                44 => 2_200_000u,
                _ => 0u,
            };
            var center = (uint)(93_250_000 + (channel - 1) * 6_500_000);
            return new Tuning(Sky, SysDvbcAnnexB, center, NoStreamId, ShiftedFrequency: shift == 0 ? null : center + shift);
        }

        if (name.StartsWith("Q", StringComparison.Ordinal))
        {
            /*
             * ISDB-C (ケーブルテレビのトランスモジュレーション方式)。中心周波数で、地上波や CATV のパススルー (C13〜C63) と違って 1/7 MHz は足さない (CXD2856 の仕様書 8.2)。
             * QC は CATV の帯域 (C13〜C63)、QU は UHF 13〜62、QV は VHF 1〜12。C22 と VHF 4〜7 は 6 MHz おきの並びから 2 MHz ずれている。
             * C24〜C27 は、2 MHz ずらした周波数を載せた資料もあるので (どちらで送られているかは未確認)、ずらした周波数も持つ (CXD2856 の仕様書 8.2 の推定の使い方)
             */
            if (name.Length < 3) return null;
            var body = name[2..];
            var index = 0;
            var colon = body.IndexOf(':');
            if (colon >= 0)
            {
                var text = body[(colon + 1)..];
                if (text.Length is 0 or > 2 || !text.All(char.IsAsciiDigit)
                    || !int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out index) || index > TsmfSelector.MaxIndex) return null;
                body = body[..colon];
            }
            if (!Number(body, out var channel)) return null;
            uint? khz = name[1] switch
            {
                'C' => channel switch
                {
                    >= 13 and <= 21 => (uint)(111_000 + 6_000 * (channel - 13)),
                    22 => 167_000u,
                    >= 23 and <= 63 => (uint)(225_000 + 6_000 * (channel - 23)),
                    _ => null,
                },
                'U' => channel is >= 13 and <= 62 ? (uint)(473_000 + 6_000 * (channel - 13)) : null,
                'V' => channel switch
                {
                    >= 1 and <= 3 => (uint)(93_000 + 6_000 * (channel - 1)),
                    >= 4 and <= 7 => (uint)(173_000 + 6_000 * (channel - 4)),
                    >= 8 and <= 12 => (uint)(195_000 + 6_000 * (channel - 8)),
                    _ => null,
                },
                _ => null,
            };
            if (khz is not { } center) return null;
            var shifted = name[1] == 'C' && channel is >= 24 and <= 27;
            return new Tuning(Catv, SysIsdbc, center * 1000, NoStreamId, ShiftedFrequency: shifted ? (center + 2_000) * 1000 : null, TsmfIndex: index);
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
