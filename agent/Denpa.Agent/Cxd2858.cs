namespace Denpa.Agent;

/*
 * Sony CXD2858ER (チューナー)。PX-MLT5U・PX-MLT5PE・DTV02A-5TS-P の受信機ごとに 1 つ、復調器 CXD2856ER の I2C の中継の先にある。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。地上波 (ISDB-T)・衛星 (ISDB-S)・J.83B (スカパー！プレミアムサービス光) の分がある。
 */

/// <summary>チューナーの状態 (仕様書 4.1)。J.83B は地上波側を使う</summary>
internal enum Cxd2858Side
{
    Stopped,
    Terrestrial,
    Satellite,
}

/// <summary>
/// CXD2858ER の書き込みの並び。**読み書きは、復調器の中継を開けている間だけ呼ぶ** (仕様書 4.1)。開け閉めとバスのロックは <see cref="Cxd2856Frontend"/> が持つ。
/// チューナーの状態 (止まっている・地上波側で動作中・衛星側で動作中) はこちらで覚える (仕様書 4.1)
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

    /// <summary>
    /// 衛星の周波数の上限 (kHz)。4 kHz 単位にした値 q を 20 ビットで書く (仕様書 4.4 の手順 8。q2 が上位 4 ビット) ので、
    /// <c>(f + 2) / 4</c> が <c>0xFFFFF</c> に収まる f まで (仕様書に上限は無く、書ける桁から決めた)
    /// </summary>
    public const uint MaxSatelliteKhz = 0xFFFFF * 4 + 1;

    private const CxdTarget U = CxdTarget.Tuner;

    /// <summary>いまの状態 (仕様書 4.1)</summary>
    public Cxd2858Side Side { get; private set; }

    /// <summary>
    /// 待機中の地上波の RF 入力の整合を保つ設定 (仕様書 4.7)。地上波・ケーブルの RF 入力を全チューナーに分配している機材で、
    /// あるチューナーが待機と動作を切り替えると、隣の受信機の 256QAM に誤りが出たため。J.83B を初めて選局したときに機材の全受信機で立てる (<see cref="It930xDevice.KeepMatching"/>)。
    /// 立てると、待機にする書き込み (初期化の手順 2・地上波側の停止の手順 2・衛星側の停止のあと) で <c>67</c> の bit1 を立てる。
    /// 選局の書き込み (仕様書 4.3・4.5 の手順 7) は、どちらでも bit1 を 0 にする
    /// </summary>
    public bool KeepMatching { get; set; }

    /// <summary>仕様書 4.2 の手順 1〜8 (手順 9 の読みの前まで)。手順 2 は整合を保つ設定 (仕様書 4.7) なら <c>02</c></summary>
    internal static CxdRow[] InitHead(bool keepMatching) =>
    [
        CxdRow.W(U, 0x01, 0x00),
        CxdRow.W(U, 0x67, (byte)(keepMatching ? 0x02 : 0x00)),
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
        Side = Cxd2858Side.Stopped;
        link.Run(InitHead(KeepMatching));
        var cpu = link.Read(U, 0x1A, 1)[0];
        if (cpu != 0) throw new IOException($"チューナー (CXD2858ER) の初期化に失敗しました (CPU の状態 0x{cpu:X2})");
        link.Run([CxdRow.B(U, 0x17, 0x90, 0x06) with { WaitMs = 1 }]);
        var v = link.Read(U, 0x19, 1)[0];
        link.Write(U, 0x95, (byte)((v >> 4) & 0x0F));
        link.Run(InitTail);
    }

    /// <summary>
    /// 地上波 (ISDB-T 6 MHz) の周波数を設定する (仕様書 4.3)。<paramref name="khz"/> は中心周波数の kHz。手順 8 のあと 50 ms 待つ。
    /// 衛星側で動作中なら、先に衛星側を止める (手順 0。仕様書 10.2)。地上波側のままなら止めずに書く
    /// </summary>
    public void TuneTerrestrial(uint khz)
    {
        if (khz > MaxTerrestrialKhz) throw new IOException($"地上波の周波数は {MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        if (Side == Cxd2858Side.Satellite) StopSatellite();
        // 書き始めたら動作中とみなす (途中で失敗しても、使い終えたときに止める書き込みを送れるように。仕様書に無い)
        Side = Cxd2858Side.Terrestrial;
        link.Run(TerrestrialRows(khz));
    }

    /// <summary>
    /// J.83B の周波数を設定する (仕様書 4.5)。<paramref name="khz"/> は中心周波数の kHz (仕様書 7.1)。並びは地上波 (仕様書 4.3) と同じで、手順 4・6・8 の値だけが違う。
    /// 手順 8 のあと 50 ms 待つ。J.83B も地上波側を使うので、地上波側のままなら止めずに書き、衛星側で動作中なら先に衛星側を止める (仕様書 10.2)
    /// </summary>
    public void TuneCable(uint khz)
    {
        if (khz > MaxTerrestrialKhz) throw new IOException($"J.83B の周波数は {MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        if (Side == Cxd2858Side.Satellite) StopSatellite();
        // 書き始めたら動作中とみなす (地上波と同じ。仕様書に無い)
        Side = Cxd2858Side.Terrestrial;
        link.Run(CableRows(khz));
    }

    /// <summary>
    /// 衛星 (ISDB-S) の周波数を設定する (仕様書 4.4)。<paramref name="khz"/> は衛星の IF (LNB の出力) の kHz (仕様書 6.1)。
    /// 手順 8 のあと 10 ms、手順 10 のあと 50 ms 待つ (仕様書 4.4 の表。50 ms は資料で分かれていて、仕様書 12.3 はどちらでもよいとしている。表のとおり待つ)。
    /// 地上波側で動作中なら、先に地上波側を止める (手順 0。仕様書 10.2)
    /// </summary>
    public void TuneSatellite(uint khz)
    {
        if (khz > MaxSatelliteKhz) throw new IOException($"衛星の周波数は {MaxSatelliteKhz} kHz までです ({khz} kHz)");
        if (Side == Cxd2858Side.Terrestrial) StopTerrestrial();
        // 書き始めたら動作中とみなす (地上波と同じ。仕様書に無い)
        Side = Cxd2858Side.Satellite;
        link.Run(SatelliteRows(khz));
    }

    /// <summary>仕様書 4.4 の手順 1〜10 (周波数を埋めたもの)。q は 4 kHz 単位に丸めた値 (<c>(f + 2) / 4</c>。整数の割り算)</summary>
    internal static CxdRow[] SatelliteRows(uint khz)
    {
        var q = (khz + 2) / 4;
        return
        [
            CxdRow.W(U, 0x15, 0x02),
            CxdRow.W(U, 0x43, 0x06),
            CxdRow.B(U, 0x6A, 0x00, 0x00),
            CxdRow.W(U, 0x75, 0x99),
            CxdRow.W(U, 0x9D, 0x00),
            CxdRow.W(U, 0x61, 0x07),
            CxdRow.W(U, 0x01, 0x01),
            CxdRow.B(U, 0x04, 0xC4, 0x40, 0x02, 0x00, 0xB4, 0x78, 0x08, 0x30, 0xFF, 0x02, 0x1E, 0x16,
                (byte)q, (byte)(q >> 8), (byte)((q >> 16) & 0x0F), 0xFF, 0x00, 0x01) with { WaitMs = 10 },
            CxdRow.W(U, 0x05, 0x00),
            CxdRow.W(U, 0x04, 0xC0, wait: 50),
        ];
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

    /// <summary>
    /// 仕様書 4.5 の手順 1〜10 (周波数を埋めたもの)。4.3 と違うのは、手順 4 (ケーブル用の <c>16 26</c>)、
    /// 手順 6 (基準の分周 <c>10</c> とループフィルタの値 <c>1C 78 08 1C</c>)、手順 8 (IF の帯域通過フィルタの利得 4 など) だけ
    /// </summary>
    internal static CxdRow[] CableRows(uint khz) =>
    [
        CxdRow.W(U, 0x01, 0x00),
        CxdRow.W(U, 0x74, 0x02),
        CxdRow.B(U, 0x87, 0xC4, 0x40),
        CxdRow.B(U, 0x91, 0x16, 0x26),
        CxdRow.B(U, 0x9C, 0x00, 0x00),
        CxdRow.B(U, 0x5E, 0xEE, 0x02, 0x1E, 0x67, 0x10, 0x1C, 0x78, 0x08, 0x1C),
        CxdRow.W(U, 0x67, 0x00, mask: 0x02),
        CxdRow.B(U, 0x68, 0x00, 0x84, 0x00, 0x02, 0x21, 0x00, 0x1B, 0x02,
            (byte)khz, (byte)(khz >> 8), (byte)((khz >> 16) & 0x0F), 0xFF, 0x01, 0xD9, 0x0F, 0x24, 0x87) with { WaitMs = 50 },
        CxdRow.W(U, 0x88, 0x00),
        CxdRow.W(U, 0x87, 0xC0),
    ];

    /// <summary>地上波側の停止 (仕様書 4.6)。手順 2 の <c>67</c> は、整合を保つ設定 (仕様書 4.7) なら <c>02</c>、そうでなければ <c>00</c> (bit0 は残す)</summary>
    internal static CxdRow[] StopTerrestrialRows(bool keepMatching) =>
    [
        CxdRow.W(U, 0x74, 0x02),
        CxdRow.W(U, 0x67, (byte)(keepMatching ? 0x02 : 0x00), mask: 0xFE),
        CxdRow.B(U, 0x5E, 0x15, 0x00, 0x00),
        CxdRow.W(U, 0x88, 0x00),
        CxdRow.W(U, 0x87, 0xC0),
    ];

    /// <summary>衛星側の停止 (仕様書 4.6)。整合を保つ設定 (仕様書 4.7) のときは、このあとに <see cref="KeepMatchingRow"/> を書く</summary>
    internal static readonly CxdRow[] StopSatelliteRows =
    [
        CxdRow.W(U, 0x15, 0x02),
        CxdRow.W(U, 0x43, 0x07),
        CxdRow.B(U, 0x0C, 0x14, 0x00, 0x00),
        CxdRow.W(U, 0x01, 0x00),
        CxdRow.W(U, 0x05, 0x00),
        CxdRow.W(U, 0x04, 0xC0),
    ];

    /// <summary>整合を保つ設定 (仕様書 4.7) のときに、衛星側の停止のあとに書く行 (<c>67</c> を <c>02</c>・マスク <c>02</c>。仕様書 4.6)</summary>
    internal static readonly CxdRow KeepMatchingRow = CxdRow.W(U, 0x67, 0x02, mask: 0x02);

    /// <summary>止める (動作中の側だけを書く。止まっていれば何もしない。仕様書 4.6)</summary>
    public void Stop()
    {
        switch (Side)
        {
            case Cxd2858Side.Terrestrial:
                StopTerrestrial();
                break;
            case Cxd2858Side.Satellite:
                StopSatellite();
                break;
        }
    }

    private void StopTerrestrial()
    {
        link.Run(StopTerrestrialRows(KeepMatching));
        Side = Cxd2858Side.Stopped;
    }

    private void StopSatellite()
    {
        link.Run(StopSatelliteRows);
        if (KeepMatching) link.Run([KeepMatchingRow]);
        Side = Cxd2858Side.Stopped;
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
    /// 入力のレベル (dBm × 100。仕様書 8.6 の計算)。<paramref name="correction"/> は方式の補正 (dB × 100。ISDB-T は -450、J.83B は -150)。
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
