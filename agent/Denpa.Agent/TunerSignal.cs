using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// チューナーが受信している状態と C/N と強度。<c>GET /denpa/tuners</c> が <c>signal</c> に入れて返す (<see cref="ITuneDevice.Signal"/>)。
///
/// <para>
/// **dB に直せる根拠があるものだけ dB にする。** dB で返すドライバやデーモン (DVB の <c>DTV_STAT_CNR</c>・px4d の <c>cnr_mdb</c>) と、
/// dB の式がある仕様書 (DiB8000) の値と、同じ系統の復調で使われてきた換算式がある PIX-DT295 (TC90522 系。<see cref="Tc90522Db"/>) は <see cref="Unit"/> が <c>dB</c>。
/// DVB のドライバが相対値 (0〜65535) で返すものは、来た値のまま <c>raw</c> にする。
/// raw は同じ機材でチャンネルや配線を比べる目安。大きいほど良いかどうかも、機材ごとに違ってよい (docs/tuners.md「信号レベル」)
/// </para>
/// </summary>
/// <param name="Locked">復調がロックしているか</param>
/// <param name="Cn">C/N。測れなければ null</param>
/// <param name="Unit"><c>dB</c> か <c>raw</c> (<see cref="Db"/>・<see cref="Raw"/>)</param>
/// <param name="AtTune">選局したときに測った値。px4d は選局の答えでしか C/N を返さないので、受信中は変わらない</param>
/// <param name="StrengthDbm">
/// 電波の強度 (dBm)。dBm で返す機材 (DVB のドライバが <c>FE_SCALE_DECIBEL</c> で返すもの・DiB8000 の表) だけで、ほかは null。
/// 機材ごとに校正されておらず、機種どうしでは比べられない。JSON の <c>strengthDbm</c> は後から足したもので、古いサーバは読まずに捨てる
/// </param>
public sealed record TunerSignal(bool Locked, double? Cn, string Unit, bool AtTune = false, double? StrengthDbm = null)
{
    public const string Db = "dB";
    public const string Raw = "raw";

    /// <summary>使用中のチューナーを読む間隔。受信を乱さないよう控えめにする (I2C を数回読むだけでも、選局と同じ USB を通る機材がある)</summary>
    public static readonly TimeSpan Every = TimeSpan.FromSeconds(5);

    public JsonObject ToJson() => new()
    {
        ["locked"] = Locked,
        ["cn"] = Cn is { } cn ? JsonValue.Create(Math.Round(cn, Unit == Db ? 1 : 0)) : null,
        ["unit"] = Unit,
        ["atTune"] = AtTune,
        ["strengthDbm"] = StrengthDbm is { } strength ? JsonValue.Create(Math.Round(strength, 1)) : null,
    };

    /// <summary>CECH-ZD1 J (DiB8000)。C/N は仕様書 8 の式で dB にしたもの、強度は仕様書 8.2 の表から求めた dBm (<see cref="Dib8096.Signal"/>)</summary>
    public static TunerSignal From(DibSignal signal) => new(signal.Locked, signal.CnDb, Db, StrengthDbm: signal.StrengthDbm);

    /// <summary>
    /// ロックしていないとき (レジスタに C/N が無い) と、値が式に入らないとき (地上波の 0・衛星の 3000 未満) は null
    /// </summary>
    public static TunerSignal From(Dt295Signal signal) =>
        new(signal.Locked, signal.Locked ? Tc90522Db(signal.Satellite, signal.CnRaw) : null, Db);

    /// <summary>
    /// **TC90522 系の復調の C/N のレジスタの値を dB にする。** PT1・PT2・PT3 (同じ系統の復調) の C/N の表示で使われてきた近似式
    /// (recpt1 の <c>recpt1core.c</c> などと同じ。docs/licenses.md)。値が大きいほど雑音が多い。
    ///
    /// <list type="bullet">
    /// <item>地上波 (24 ビット): P = 10·log10(5505024 / 値)、C/N = 0.000024P⁴ − 0.0016P³ + 0.0398P² + 0.5491P + 3.0965</item>
    /// <item>衛星 (16 ビット): P = √(値 − 3000) / 64、C/N = −1.6346P⁵ + 14.341P⁴ − 50.259P³ + 88.977P² − 89.565P + 58.857。
    /// 3000 未満は式の外 (ロックしていないと 0 が読める) なので null</item>
    /// </list>
    ///
    /// PIX-DT295 の復調が TC90522 系なのは推定で、レジスタもその系統の位置 (地上波 0x8B・衛星 0xBC)。
    /// 実機で読んだ値と dB は docs/tuners.md「信号レベル」にある (1 台の機材で読んだ値で、ほかの機材の dB と同じ物差しかは確かめていない)
    /// </summary>
    public static double? Tc90522Db(bool satellite, uint raw)
    {
        if (satellite)
        {
            if (raw < 3000) return null;
            var p = Math.Sqrt(raw - 3000.0) / 64;
            return ((((-1.6346 * p + 14.341) * p - 50.259) * p + 88.977) * p - 89.565) * p + 58.857;
        }
        if (raw == 0) return null;
        var q = 10 * Math.Log10(5505024.0 / raw);
        return (((0.000024 * q - 0.0016) * q + 0.0398) * q + 0.5491) * q + 3.0965;
    }
}
