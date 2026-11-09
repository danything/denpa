namespace Denpa.Agent;

/*
 * Sony CXD2858ER (チューナー)。PX-MLT5U・PX-MLT5PE・DTV02A-5TS-P の受信機ごとに 1 つ、復調器 CXD2856ER の I2C の中継の先にある。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。いまは地上波 (ISDB-T) の分だけ。
 */

/// <summary>
/// CXD2858ER の書き込みの並び。**読み書きは、復調器の中継を開けている間だけ呼ぶ** (仕様書 4.1)。開け閉めとバスのロックは <see cref="Cxd2856Frontend"/> が持つ。
/// チューナーの状態 (止まっている・地上波側で動作中) はこちらで覚える (仕様書 4.1)
/// </summary>
internal sealed class Cxd2858(CxdLink link)
{
    /// <summary>I2C のアドレス (7 ビット)。5 つのチューナーはどれも同じ (仕様書 1.1・1.2)</summary>
    public const byte Address = 0x60;

    /// <summary>
    /// 発振器の負荷容量 (仕様書 4.2 の手順 7 の <c>xx</c>)。資料で値が分かれていて、仕様書 4.8 が選んだ値 (この基板の PLEX の値)
    /// </summary>
    public const byte LoadCapacitance = 0xB3;

    /// <summary>地上波側の周波数の上限 (kHz。20 ビット。仕様書 4.1)</summary>
    public const uint MaxTerrestrialKhz = 0xFFFFF;

    private const CxdTarget U = CxdTarget.Tuner;

    /// <summary>地上波側で動作中か (止まっていれば false)</summary>
    public bool Terrestrial { get; private set; }

    /// <summary>仕様書 4.2 の手順 1〜8 (手順 9 の読みの前まで)</summary>
    internal static readonly CxdRow[] InitHead =
    [
        CxdRow.W(U, 0x01, 0x00),
        CxdRow.W(U, 0x67, 0x00),
        CxdRow.W(U, 0x43, 0x07),
        CxdRow.B(U, 0x5E, 0x15, 0x00, 0x00),
        CxdRow.W(U, 0x0C, 0x14),
        CxdRow.B(U, 0x99, 0x7A, 0x01),
        CxdRow.B(U, 0x81, 0x10, 0x84, LoadCapacitance, 0x00, 0x00, 0x00, 0xC4, 0x40, 0x10, 0x00, 0x45, 0x75, 0x07, 0x1C, 0x3F, 0x02, 0x10, 0x20, 0x0A, 0x00),
        CxdRow.W(U, 0x9B, 0x00, wait: 10),
    ];

    /// <summary>仕様書 4.2 の手順 13〜17 (VCO の電流を書いたあと)</summary>
    internal static readonly CxdRow[] InitTail =
    [
        CxdRow.W(U, 0x74, 0x02),
        CxdRow.W(U, 0x88, 0x00),
        CxdRow.W(U, 0x87, 0xC0),
        CxdRow.W(U, 0x80, 0x01),
        CxdRow.B(U, 0x41, 0x07, 0x00),
    ];

    /// <summary>
    /// 初期化 (電源を入れたあと、復調器の初期化に続けて 1 回。仕様書 4.2)。
    /// チューナーの CPU の状態が 0 でなければ <see cref="IOException"/> (仕様書 4.2 の手順 9。識別の代わりに応答と状態を確かめる)
    /// </summary>
    public void Init()
    {
        Terrestrial = false;
        link.Run(InitHead);
        var cpu = link.Read(U, 0x1A, 1)[0];
        if (cpu != 0) throw new IOException($"チューナー (CXD2858ER) の初期化に失敗しました (CPU の状態 0x{cpu:X2})");
        link.Run([CxdRow.B(U, 0x17, 0x90, 0x06) with { WaitMs = 1 }]);
        var v = link.Read(U, 0x19, 1)[0];
        link.Write(U, 0x95, (byte)((v >> 4) & 0x0F));
        link.Run(InitTail);
    }

    /// <summary>
    /// 地上波 (ISDB-T 6 MHz) の周波数を設定する (仕様書 4.3)。<paramref name="khz"/> は中心周波数の kHz。手順 8 のあと 50 ms 待つ。
    /// 衛星側の停止 (手順 0) は、衛星を足すまで要らない (いまは地上波側か止まっているかのどちらか)
    /// </summary>
    public void TuneTerrestrial(uint khz)
    {
        if (khz > MaxTerrestrialKhz) throw new ArgumentOutOfRangeException(nameof(khz), $"地上波の周波数は {MaxTerrestrialKhz} kHz までです ({khz})");
        // 書き始めたら動作中とみなす (途中で失敗しても、使い終えたときに止める書き込みを送れるように。仕様書に無い)
        Terrestrial = true;
        link.Run(TerrestrialRows(khz));
    }

    /// <summary>仕様書 4.3 の手順 1〜10 (周波数を埋めたもの)</summary>
    internal static CxdRow[] TerrestrialRows(uint khz) =>
    [
        CxdRow.W(U, 0x01, 0x00),
        CxdRow.W(U, 0x74, 0x02),
        CxdRow.B(U, 0x87, 0xC4, 0x40),
        CxdRow.B(U, 0x91, 0x10, 0x20),
        CxdRow.B(U, 0x9C, 0x00, 0x00),
        CxdRow.B(U, 0x5E, 0xEE, 0x02, 0x1E, 0x67, 0x02, 0xB4, 0x78, 0x08, 0x30),
        CxdRow.W(U, 0x67, 0x00, mask: 0x02),
        CxdRow.B(U, 0x68, 0x00, 0x88, 0x00, 0x0B, 0x22, 0x00, 0x17, 0x1B,
            (byte)khz, (byte)(khz >> 8), (byte)((khz >> 16) & 0x0F), 0xFF, 0x01, 0x99, 0x00, 0x24, 0x87) with { WaitMs = 50 },
        CxdRow.W(U, 0x88, 0x00),
        CxdRow.W(U, 0x87, 0xC0),
    ];

    /// <summary>地上波側の停止 (仕様書 4.6)。整合を保つ設定 (仕様書 4.7) は使わないので、<c>67</c> は 0</summary>
    internal static readonly CxdRow[] StopTerrestrialRows =
    [
        CxdRow.W(U, 0x74, 0x02),
        CxdRow.W(U, 0x67, 0x00, mask: 0xFE),
        CxdRow.B(U, 0x5E, 0x15, 0x00, 0x00),
        CxdRow.W(U, 0x88, 0x00),
        CxdRow.W(U, 0x87, 0xC0),
    ];

    /// <summary>止める (地上波側で動作中のときだけ書く。仕様書 4.6)</summary>
    public void Stop()
    {
        if (!Terrestrial) return;
        link.Run(StopTerrestrialRows);
        Terrestrial = false;
    }

    /// <summary>
    /// RF のレベルの元になる値を読む (仕様書 8.6 の地上波の表)。IF の AGC の値 a、RF の AGC の値 b、IF の帯域通過フィルタの利得の番号 g
    /// </summary>
    public (byte IfAgc, byte RfAgc, int Gain) ReadAgc()
    {
        link.Write(U, 0x87, 0xC4, 0x41);
        link.Write(U, 0x59, 0x05, 0x01);
        var a = link.Read(U, 0x5B, 1)[0];
        link.Write(U, 0x59, 0x03, 0x01);
        var b = link.Read(U, 0x5B, 1)[0];
        link.Write(U, 0x59, 0x04);
        link.Write(U, 0x88, 0x00);
        link.Write(U, 0x87, 0xC0);
        var g = link.Read(U, 0x69, 1)[0] & 0x0F;
        return (a, b, g);
    }

    /// <summary>IF の帯域通過フィルタの利得の番号ごとの利得 (dB。仕様書 8.6 の G の表)</summary>
    private static readonly int[] GainTable = [0, 0, 0, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 20];

    /// <summary>
    /// 入力のレベル (dBm × 100。仕様書 8.6 の計算)。<paramref name="correction"/> は方式の補正 (dB × 100。ISDB-T は -450)。
    /// 整数の割り算は仕様書の式のまま (式の中の足し算で四捨五入になっている)
    /// </summary>
    public static int InputLevel(byte ifAgc, byte rfAgc, int gain, uint khz, int correction)
    {
        var g = GainTable[gain & 0x0F] * 100;
        var a140 = ifAgc * 140;
        var ifGain = a140 > 9945 ? 870 + g : 870 + g + (769 * (9945 - a140) + 1275) / 2550;
        var m = Math.Max(ifAgc, rfAgc) * 140;
        var max = MaxRfGain(khz);
        var rfGain = m switch
        {
            < 4896 => max,
            < 5457 => max - (70 * (m - 4896) + 127) / 255,
            < 8823 => max - 154,
            < 24786 => max - 154 - (70 * (m - 8823) + 127) / 255,
            < 30090 => max - 4536 - (57 * (m - 24786) + 127) / 255,
            _ => max - 4536 - 1186 - (160 * (m - 30090) + 127) / 255,
        };
        return -ifGain - rfGain + correction;
    }

    /// <summary>RF の利得の最大値 (dB × 100)。選局した周波数 (kHz) で決まる (仕様書 8.6)</summary>
    internal static int MaxRfGain(uint khz) => khz switch
    {
        > 700000 => 4150,
        > 600000 => 4130,
        > 532000 => 4170,
        > 464000 => 4050,
        > 400000 => 4280,
        > 350000 => 4260,
        > 320000 => 4110,
        > 285000 => 4310,
        > 215000 => 4250,
        > 184000 => 4020,
        > 172000 => 3920,
        > 150000 => 4080,
        > 86000 => 4180,
        > 65000 => 4200,
        _ => 4020,
    };
}
