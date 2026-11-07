using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// チューナーが受信している状態と C/N。<c>GET /denpa/tuners</c> が <c>signal</c> に入れて返す (<see cref="ITuneDevice.Signal"/>)。
///
/// <para>
/// **dB に直せる根拠があるものだけ dB にする。** dB で返すドライバやデーモン (DVB の <c>DTV_STAT_CNR</c>・px4d の <c>cnr_mdb</c>) と、
/// dB の式がある仕様書 (DiB8000) の値は <see cref="Unit"/> が <c>dB</c>。式の根拠が無いもの (PIX-DT295 の復調のレジスタ) と、DVB のドライバが相対値 (0〜65535) で返すものは、来た値のまま <c>raw</c> にする。
/// raw は同じ機材でチャンネルや配線を比べる目安。大きいほど良いかどうかも、機材ごとに違ってよい (docs/tuners.md「信号レベル」)
/// </para>
/// </summary>
/// <param name="Locked">復調がロックしているか</param>
/// <param name="Cn">C/N。測れなければ null</param>
/// <param name="Unit"><c>dB</c> か <c>raw</c> (<see cref="Db"/>・<see cref="Raw"/>)</param>
/// <param name="AtTune">選局したときに測った値。px4d は選局の答えでしか C/N を返さないので、受信中は変わらない</param>
public sealed record TunerSignal(bool Locked, double? Cn, string Unit, bool AtTune = false)
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
    };

    /// <summary>CECH-ZD1 J (DiB8000)。C/N は仕様書 8 の式で dB にしたもの (<see cref="Dib8096.Signal"/>)</summary>
    public static TunerSignal From(DibSignal signal) => new(signal.Locked, signal.CnDb, Db);

    /// <summary>PIX-DT295。**dB の式が無いので、復調のレジスタの値のまま** (<see cref="Dt295NativeFrontend.Signal"/>)</summary>
    public static TunerSignal From(Dt295Signal signal) => new(signal.Locked, signal.CnRaw, Raw);
}
