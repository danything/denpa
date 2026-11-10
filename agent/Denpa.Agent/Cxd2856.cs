namespace Denpa.Agent;

/*
 * Sony CXD2856ER (復調器) と、受信機 1 つぶんの復調器とチューナー (Cxd2856Frontend)。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。地上波 (ISDB-T)・衛星 (ISDB-S)・J.83B (スカパー！プレミアムサービス光)・ISDB-C (ケーブルテレビのトランスモジュレーション方式) の分がある。
 */

/// <summary>
/// 1 本の I2C のバス (IT930x のブリッジの <c>GENERIC_WRITE</c>・<c>GENERIC_READ</c>)。アドレスは 7 ビット (仕様書 1.3)
/// </summary>
public interface ICxdBus
{
    /// <summary>1 回の I2C の書き込み。<paramref name="data"/> の先頭がレジスタの番地で、続けて書く値</summary>
    void Write(byte address, ReadOnlySpan<byte> data);

    /// <summary>読む。読む番地は、その前の <see cref="Write"/> で番地の 1 バイトだけを書いて決めておく (仕様書 1.3)</summary>
    void Read(byte address, Span<byte> data);
}

/// <summary>I2C の相手。復調器の T (復調の本体) と X (システム)、復調器の中継の先のチューナー (仕様書 1.1)</summary>
internal enum CxdTarget
{
    T,
    X,
    Tuner,
}

/// <summary>
/// 仕様書の表の 1 行。<see cref="Values"/> が 2 バイト以上なら、先頭のレジスタから続けて書く 1 回の書き込み。
/// <see cref="Mask"/> が <c>FF</c> でなければ、1 バイト読んで <c>(読んだ値 &amp; ~マスク) | (値 &amp; マスク)</c> を書く (仕様書 1.3)。
/// <see cref="WaitMs"/> は書いたあとに待つ時間
/// </summary>
internal readonly record struct CxdRow(CxdTarget Target, byte Register, byte[] Values, byte Mask = 0xFF, int WaitMs = 0)
{
    public static CxdRow W(CxdTarget target, byte register, byte value, byte mask = 0xFF, int wait = 0) => new(target, register, [value], mask, wait);

    public static CxdRow B(CxdTarget target, byte register, params byte[] values) => new(target, register, values);
}

/// <summary>
/// ISDB-S で受ける TS (仕様書 6.3)。<see cref="Tsid"/> があれば TSID で選び (仕様書が勧める形)、無ければ相対 TS 番号 <see cref="Relative"/> (0〜7) で選ぶ
/// </summary>
public readonly record struct CxdStream(ushort? Tsid, byte Relative = 0)
{
    /// <summary>
    /// 選局表の TSID から。TSID が無ければ (<see cref="ChannelTable.NoStreamId"/>) 相対 TS 番号 0 (その中継器の先頭の TS)。
    /// 選局表の TSID はいつも TSID として扱う (小さい値を相対 TS 番号とみなす決め方は使わない。仕様書 6.3 は TSID で選ぶのを勧める)
    /// </summary>
    public static CxdStream From(uint streamId) =>
        streamId == ChannelTable.NoStreamId ? new(null) : new((ushort)streamId);
}

/// <summary>
/// J.83B の状態と信号品質の元の値 (仕様書 7.5・8.4)。<see cref="Search"/> はバンク <c>40</c> の <c>88</c>、<see cref="Ts"/> は <c>10</c>。
/// 自動の探索がロックしていなければ <see cref="Modulation"/> と <see cref="Per"/> は null で、<see cref="CnRaw"/> は 0
/// </summary>
internal readonly record struct CxdJ83bSignal(byte Search, byte Ts, byte? Modulation, int CnRaw, byte[]? Per);

/// <summary>
/// ISDB-C の状態と信号品質の元の値 (仕様書 7A.6・8.4・8.4A)。どれもバンク <c>40</c>。<see cref="Search"/> は <c>88</c>、<see cref="Ts"/> は <c>10</c>。
/// 自動の探索がロックしていなければ <see cref="Modulation"/> と <see cref="Locked"/> は null で、<see cref="CnRaw"/> は 0。
/// <see cref="Locked"/> は固めて読んだ 10 バイト (<c>19</c>、<c>15</c>〜<c>16</c>、<c>1A</c>〜<c>1B</c>、<c>9B</c>〜<c>9F</c> の順)。
/// <see cref="Per"/> は <c>5C</c>〜<c>5F</c>、<see cref="BerLength"/> は <c>60</c>、<see cref="Ber"/> は <c>62</c>〜<c>64</c>、<see cref="Uncorrected"/> は <c>EA</c>〜<c>EC</c>、
/// <see cref="IfAgc"/> は <c>49</c>〜<c>4A</c> の 12 ビット
/// </summary>
internal readonly record struct CxdIsdbcSignal(
    byte Search, byte Ts, byte? Modulation, int CnRaw, byte[]? Per, byte[]? Locked, byte BerLength, byte[]? Ber, byte[]? Uncorrected, int IfAgc);

/// <summary>
/// ISDB-C でほかに読める値 (仕様書 8.4A)。出どころは PLEX の公開ドライバーに入っている Sony の手順だけで、実機で読んだ記録は無い (仕様書 13)。<c>--tune</c> の出力にだけ出す。値が無ければ null
/// </summary>
/// <param name="Inverted">復調器がスペクトルの反転を見つけたか</param>
/// <param name="CarrierOffsetKhz">搬送波のずれ (kHz)</param>
/// <param name="SymbolRateMsps">シンボルレート (Msps)</param>
/// <param name="PreRsBer">RS の前の BER</param>
/// <param name="Uncorrected">RS で直せなかったパケットの数</param>
/// <param name="IfAgc">IF の AGC の出力 (12 ビット)</param>
public sealed record CxdIsdbcDetail(bool? Inverted, double? CarrierOffsetKhz, double? SymbolRateMsps, double? PreRsBer, int? Uncorrected, int IfAgc);

/// <summary>
/// 受信機 1 つぶんの I2C。相手からアドレスを決める (X は T + 2、チューナーは <see cref="Cxd2858.Address"/>。仕様書 1.1)。
/// **ロックは持たない。** 同じバスの受信機と交わらないようにするのは <see cref="Cxd2856Frontend"/> のバスのロック
/// </summary>
internal sealed class CxdLink(ICxdBus bus, byte demodAddress, Action<int> sleep)
{
    public byte Address(CxdTarget target) => target switch
    {
        CxdTarget.T => demodAddress,
        CxdTarget.X => (byte)(demodAddress + 2),
        _ => Cxd2858.Address,
    };

    public void Sleep(int ms)
    {
        if (ms > 0) sleep(ms);
    }

    /// <summary>レジスタ <paramref name="register"/> から続けて書く (1 回の I2C の書き込み)</summary>
    public void Write(CxdTarget target, byte register, params ReadOnlySpan<byte> values)
    {
        Span<byte> data = stackalloc byte[1 + values.Length];
        data[0] = register;
        values.CopyTo(data[1..]);
        bus.Write(Address(target), data);
    }

    /// <summary>読む (番地の 1 バイトを書いてから、続けて読む。仕様書 1.3)</summary>
    public byte[] Read(CxdTarget target, byte register, int length)
    {
        var address = Address(target);
        bus.Write(address, [register]);
        var data = new byte[length];
        bus.Read(address, data);
        return data;
    }

    /// <summary>表の行を順に書く</summary>
    public void Run(ReadOnlySpan<CxdRow> rows)
    {
        foreach (var row in rows)
        {
            if (row.Mask == 0xFF || row.Values.Length != 1)
            {
                Write(row.Target, row.Register, row.Values);
            }
            else
            {
                // 読んでから書くまでの間に、同じ相手へのほかの書き込みを挟まない (仕様書 1.3。呼ぶ側がバスのロックを持っている)
                var current = Read(row.Target, row.Register, 1)[0];
                Write(row.Target, row.Register, (byte)((current & ~row.Mask) | (row.Values[0] & row.Mask)));
            }
            Sleep(row.WaitMs);
        }
    }
}

/// <summary>
/// CXD2856ER の書き込みの並び (仕様書 2・3・5・6・7・7A・8)。状態 (スリープか、どの方式で動作中か) は <see cref="Cxd2856Frontend"/> が覚える (仕様書 2.1)
/// </summary>
internal sealed class Cxd2856(CxdLink link)
{
    private const CxdTarget T = CxdTarget.T;
    private const CxdTarget X = CxdTarget.X;

    /// <summary>識別のレジスタの値 (仕様書 2.2 の手順 14)。0x90 なら CXD2856、0x91 なら CXD2857</summary>
    public static readonly IReadOnlyList<byte> ChipIds = [0x90, 0x91];

    /// <summary>初期化 (仕様書 2.2 の手順 1〜13)</summary>
    internal static readonly CxdRow[] InitRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x10, 0x01),
        CxdRow.W(X, 0x18, 0x01),
        CxdRow.W(X, 0x28, 0x13),
        CxdRow.W(X, 0x17, 0x01),
        CxdRow.W(X, 0x1D, 0x00),
        // 水晶 24 MHz (仕様書 1.1)
        CxdRow.W(X, 0x14, 0x01),
        CxdRow.W(X, 0x1C, 0x03, wait: 4),
        CxdRow.W(X, 0x50, 0x00, wait: 1),
        CxdRow.W(X, 0x10, 0x00, wait: 1),
        CxdRow.W(X, 0x00, 0x00),
        // チューナーへの中継を使う (仕様書 1.4)
        CxdRow.W(X, 0x1A, 0x01),
        CxdRow.W(T, 0x00, 0x00),
    ];

    /// <summary>TS の形の設定 (初期化のとき 1 回。仕様書 3.2)。シリアル・D0・立ち上がりでラッチ</summary>
    internal static readonly CxdRow[] TsFormRows =
    [
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xC4, 0x80, mask: 0x88),
        CxdRow.W(T, 0xC5, 0x01, mask: 0x01),
        CxdRow.W(T, 0xC6, 0x03, mask: 0x1F),
        CxdRow.W(T, 0x00, 0x60),
        CxdRow.W(T, 0x52, 0x03, mask: 0x1F),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xC8, 0x03, mask: 0x1F),
        CxdRow.W(T, 0xC9, 0x03, mask: 0x1F),
        CxdRow.W(T, 0x00, 0xA0),
        CxdRow.W(T, 0xB9, 0x01, mask: 0x01),
    ];

    /// <summary>TS クロックの周波数 (仕様書 3.3 の手順 10 の <c>33</c>)。ISDB-T は低い (<c>02</c>)</summary>
    internal const byte TsClockIsdbt = 0x02;

    /// <summary>TS クロックの周波数。ISDB-S は高い (<c>00</c>)</summary>
    internal const byte TsClockIsdbs = 0x00;

    /// <summary>TS クロックの周波数。J.83B は高い (<c>00</c>。仕様書 3.5 の番号 3。38.4 Mbps の設定では J.83B の TS が収まらない)</summary>
    internal const byte TsClockJ83b = 0x00;

    /// <summary>TS クロックの周波数。ISDB-C は高い (<c>00</c>。仕様書 3.5 の番号 3。256QAM の TS は約 38.9 Mbps で、低い設定の 38.4 Mbps に収まらない)</summary>
    internal const byte TsClockIsdbc = 0x00;

    /// <summary>パケットの間の隙間 (仕様書 3.3 の手順 3 の <c>D3</c>)。ISDB-T・ISDB-S・ISDB-C は入れない (<c>01</c>)</summary>
    internal const byte TsNoGap = 0x01;

    /// <summary>パケットの間の隙間。J.83B は入れる (<c>00</c>)</summary>
    internal const byte TsGap = 0x00;

    /// <summary>
    /// TS クロックの設定 (仕様書 3.3 の手順 3〜15)。方式で違うのは、手順 3 のパケットの間の隙間 <paramref name="gap"/> と手順 10 の周波数 <paramref name="frequency"/>。
    /// 周波数は資料で値が分かれていて、仕様書 3.5 が選んだ値 (ISDB-T は低い・半分の速さ、ISDB-S と J.83B は高い・半分の速さ)
    /// </summary>
    internal static CxdRow[] TsClockRows(byte gap, byte frequency) =>
    [
        CxdRow.W(T, 0xD3, gap, mask: 0x01),
        CxdRow.W(T, 0xDE, 0x00, mask: 0x01),
        CxdRow.W(T, 0xDA, 0x00, mask: 0x01),
        CxdRow.W(T, 0xC4, 0x00, mask: 0x03),
        CxdRow.W(T, 0xD1, 0x02, mask: 0x03),
        CxdRow.W(T, 0xD9, 0x10),
        CxdRow.W(T, 0x32, 0x00, mask: 0x01),
        CxdRow.W(T, 0x33, frequency, mask: 0x03),
        CxdRow.W(T, 0x32, 0x01, mask: 0x01),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0x66, 0x01, mask: 0x01),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x66, 0x01, mask: 0x01),
    ];

    /// <summary>ISDB-T の起動 (スリープから。仕様書 5.2 の手順 1〜35)</summary>
    internal static readonly CxdRow[] StartIsdbtRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x17, 0x06),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(T, 0x2C, 0x01),
        CxdRow.W(T, 0x4B, 0x74),
        CxdRow.W(T, 0x49, 0x00),
        CxdRow.W(X, 0x18, 0x00),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0x6A, 0x50),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0xA5, 0x01),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.B(T, 0xCE, 0x00, 0x00),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0x69, 0x04),
        CxdRow.W(T, 0x6B, 0x03),
        CxdRow.W(T, 0x9D, 0x50),
        CxdRow.W(T, 0xD3, 0x06),
        CxdRow.W(T, 0xED, 0x00),
        CxdRow.W(T, 0xE2, 0xCE),
        CxdRow.W(T, 0xF2, 0x13),
        CxdRow.W(T, 0xDE, 0x2E),
        CxdRow.W(T, 0x00, 0x15),
        CxdRow.W(T, 0xDE, 0x02),
        CxdRow.W(T, 0x00, 0x17),
        CxdRow.B(T, 0x38, 0x00, 0x03),
        CxdRow.W(T, 0x00, 0x1E),
        CxdRow.W(T, 0x73, 0x68),
        CxdRow.W(T, 0x00, 0x63),
        CxdRow.W(T, 0x81, 0x00),
        CxdRow.W(T, 0x00, 0x11),
        // 水晶 24 MHz の値
        CxdRow.B(T, 0x33, 0x00, 0x03, 0x3B),
        CxdRow.W(T, 0x00, 0x60),
        CxdRow.B(T, 0xA8, 0xB7, 0x1B),
    ];

    /// <summary>ISDB-T の起動の、帯域の設定のあと (仕様書 5.2 の手順 37〜38)</summary>
    internal static readonly CxdRow[] StartIsdbtTailRows =
    [
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x80, 0x08, mask: 0x1F),
    ];

    /// <summary>帯域の設定 (6 MHz。仕様書 5.3)。起動と、ISDB-T のままの選局し直しで書く</summary>
    internal static readonly CxdRow[] BandRows =
    [
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.B(T, 0x9F, 0x17, 0xA0, 0x80, 0x00, 0x00),
        CxdRow.B(T, 0xA6, 0x31, 0xA8, 0x29, 0x9B, 0x27, 0x9C, 0x28, 0x9E, 0x29, 0xA4, 0x29, 0xA2, 0x29, 0xA8),
        // IF 3.55 MHz (仕様書 5.1)
        CxdRow.B(T, 0xB6, 0x12, 0xEE, 0xEF),
        CxdRow.W(T, 0xD7, 0x04),
        CxdRow.B(T, 0xD9, 0x1F, 0x79),
        CxdRow.W(T, 0x00, 0x12),
        CxdRow.W(T, 0x71, 0x07),
        CxdRow.W(T, 0x00, 0x15),
        CxdRow.W(T, 0xBE, 0x02),
    ];

    /// <summary>ISDB-T のままの選局し直しの最初 (仕様書 5.4 の手順 1。このあと <see cref="BandRows"/>)</summary>
    internal static readonly CxdRow[] RetuneRows =
    [
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xC3, 0x01),
    ];

    /// <summary>選局を終える 3 行 (TS を出し始める。仕様書 2.3)</summary>
    internal static readonly CxdRow[] FinishRows =
    [
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xFE, 0x01),
        CxdRow.W(T, 0xC3, 0x00),
    ];

    /// <summary>ISDB-T からのスリープの最初 (仕様書 5.7 の手順 1〜3。このあと TS のデータ端子を高インピーダンスにする)</summary>
    internal static readonly CxdRow[] SleepIsdbtHeadRows =
    [
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xC3, 0x01),
        CxdRow.W(T, 0x80, 0x1F, mask: 0x1F),
    ];

    /// <summary>
    /// ISDB-T からのスリープの残り (仕様書 5.7 の手順 5〜21)。バンク <c>17</c> の <c>38</c>〜<c>39</c> は資料で値が分かれていて、仕様書 12.3 が選んだ <c>01 02</c>
    /// </summary>
    internal static readonly CxdRow[] SleepIsdbtRows =
    [
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0x69, 0x05),
        CxdRow.W(T, 0x6B, 0x07),
        CxdRow.W(T, 0x9D, 0x14),
        CxdRow.W(T, 0xD3, 0x00),
        CxdRow.W(T, 0xED, 0x01),
        CxdRow.W(T, 0xE2, 0x4E),
        CxdRow.W(T, 0xF2, 0x03),
        CxdRow.W(T, 0xDE, 0x32),
        CxdRow.W(T, 0x00, 0x15),
        CxdRow.W(T, 0xDE, 0x03),
        CxdRow.W(T, 0x00, 0x17),
        CxdRow.B(T, 0x38, 0x01, 0x02),
        CxdRow.W(T, 0x00, 0x1E),
        CxdRow.W(T, 0x73, 0x00),
        CxdRow.W(T, 0x00, 0x63),
        CxdRow.W(T, 0x81, 0x01),
    ];

    /// <summary>スリープの共通の後始末 (仕様書 2.4。ISDB-T と J.83B で使う)</summary>
    internal static readonly CxdRow[] SleepCommonRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x18, 0x01),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x49, 0x33),
        CxdRow.W(T, 0x4B, 0x21),
        CxdRow.W(T, 0xFE, 0x01),
        CxdRow.W(T, 0x2C, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(X, 0x17, 0x01),
    ];

    /// <summary>ISDB-S の起動 (スリープから。仕様書 6.2 の手順 1〜19)。シンボルレート 28.86 Msps (<c>07 37 0A</c>)、IQ は反転しない (仕様書 6.1)</summary>
    internal static readonly CxdRow[] StartIsdbsRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x17, 0x0C),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x2D, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(T, 0x2C, 0x01),
        CxdRow.W(X, 0x28, 0x31),
        CxdRow.W(T, 0x4B, 0x31),
        CxdRow.W(T, 0x6A, 0x00),
        CxdRow.W(X, 0x18, 0x00),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x20, 0x01),
        CxdRow.B(T, 0xCE, 0x00, 0x00),
        CxdRow.W(T, 0x00, 0xAE),
        CxdRow.B(T, 0x20, 0x07, 0x37, 0x0A),
        CxdRow.W(T, 0x00, 0xA0),
        CxdRow.W(T, 0xD7, 0x00),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x80, 0x10, mask: 0x1F),
    ];

    /// <summary>ISDB-S からのスリープの最初 (仕様書 6.5 の手順 1〜3。このあと TS のデータ端子を高インピーダンスにする)。ISDB-T の最初 (5.7) と同じ並び</summary>
    internal static readonly CxdRow[] SleepIsdbsHeadRows = SleepIsdbtHeadRows;

    /// <summary>ISDB-S からのスリープの残り (仕様書 6.5 の手順 5〜17)。ISDB-T と違い、共通の後始末 (2.4) は使わない</summary>
    internal static readonly CxdRow[] SleepIsdbsRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x18, 0x01),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0x6A, 0x11),
        CxdRow.W(T, 0x4B, 0x21),
        CxdRow.W(X, 0x28, 0x13),
        CxdRow.W(T, 0xFE, 0x01),
        CxdRow.W(T, 0x2C, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(T, 0x2D, 0x00),
        CxdRow.W(X, 0x17, 0x01),
        CxdRow.W(T, 0x00, 0xA0),
        CxdRow.W(T, 0xD7, 0x00),
    ];

    /// <summary>
    /// ISDB-S で TS を選ぶ書き込み (仕様書 6.3)。TSID で選ぶなら <c>E9</c>〜<c>EB</c> に TSID の上位・下位と <c>00</c>、
    /// 相対 TS 番号 n (0〜7) で選ぶなら <c>00、n、01</c>
    /// </summary>
    internal static CxdRow[] SelectTsRows(CxdStream stream) =>
    [
        CxdRow.W(T, 0x00, 0xC0),
        stream.Tsid is { } tsid
            ? CxdRow.B(T, 0xE9, (byte)(tsid >> 8), (byte)tsid, 0x00)
            : CxdRow.B(T, 0xE9, 0x00, stream.Relative, 0x01),
    ];

    /// <summary>
    /// J.83B の起動 (スリープから。仕様書 7.2 の手順 1〜26)。このあと帯域の設定 (<see cref="BandJ83bRows"/>) と <see cref="StartIsdbtTailRows"/> (手順 28〜29)。
    /// 手順 26 のフィルタ係数は ISDB-T の帯域の設定 (仕様書 5.3) と同じ値
    /// </summary>
    internal static readonly CxdRow[] StartJ83bRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x17, 0x08),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(T, 0x2C, 0x01),
        CxdRow.W(T, 0x4B, 0x74),
        CxdRow.W(T, 0x49, 0x00),
        CxdRow.W(X, 0x18, 0x00),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0x6A, 0x48),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0xA5, 0x01),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x21, 0x04),
        CxdRow.W(T, 0xB3, 0x05),
        CxdRow.W(T, 0x1E, 0x80),
        CxdRow.W(T, 0x8E, 0x58),
        CxdRow.W(T, 0x00, 0x41),
        CxdRow.W(T, 0xCF, 0x99),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0xA3, 0x14),
        CxdRow.B(T, 0x33, 0x00, 0x03, 0x3B),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.B(T, 0xCE, 0x01, 0x01),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.B(T, 0xA6, 0x31, 0xA8, 0x29, 0x9B, 0x27, 0x9C, 0x28, 0x9E, 0x29, 0xA4, 0x29, 0xA2, 0x29, 0xA8),
    ];

    /// <summary>
    /// J.83B の帯域の設定 (5.6 Msps。仕様書 7.3)。起動と、J.83B のままの選局し直しで書く。IF 3.75 MHz (<c>14 00 00</c>。仕様書 7.1)、
    /// QAM の探す範囲 <c>10</c>、シンボルレートの探す値 <c>07 77 07 77</c>。手順 1 のバンク <c>10</c> を選び直す書き込みも仕様書のとおり入れる
    /// </summary>
    internal static readonly CxdRow[] BandJ83bRows =
    [
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.B(T, 0xB6, 0x14, 0x00, 0x00),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x14, 0x10),
        CxdRow.B(T, 0x26, 0x07, 0x77, 0x07, 0x77),
    ];

    /// <summary>J.83B からのスリープの最初 (仕様書 7.4 の手順 1〜3。このあと TS のデータ端子を高インピーダンスにする)。ISDB-T の最初 (5.7) と同じ並び</summary>
    internal static readonly CxdRow[] SleepJ83bHeadRows = SleepIsdbtHeadRows;

    /// <summary>
    /// J.83B からのスリープの残り (仕様書 7.4 の手順 5〜17)。このあと共通の後始末 (仕様書 2.4)。
    /// 起動で書いたものの一部しか戻さない (バンク <c>11</c> の <c>6A</c>・<c>33</c>〜<c>35</c>、バンク <c>10</c> の <c>A5</c>〜<c>B3</c>・<c>B6</c>〜<c>B8</c> は J.83B の値のまま残る)。
    /// このあと ISDB-S が受けられるかは確かめられていない (仕様書 7.4・13)。ISDB-T の起動はこれらを書き直す
    /// </summary>
    internal static readonly CxdRow[] SleepJ83bRows =
    [
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0xA3, 0x00),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x21, 0x00),
        CxdRow.W(T, 0xC3, 0x00),
        CxdRow.W(T, 0xB3, 0x02),
        CxdRow.W(T, 0x1E, 0x00),
        CxdRow.W(T, 0x8E, 0x0E),
        CxdRow.W(T, 0x00, 0x41),
        CxdRow.W(T, 0xCF, 0x77),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x14, 0x1F),
        CxdRow.B(T, 0x26, 0x09, 0x9A, 0x00, 0xEE),
    ];

    /// <summary>
    /// ISDB-C の起動の最初 (仕様書 7A.3 の手順 1〜2)。TSMF の処理をしない設定 (バンク <c>49</c> の <c>36</c> の bit4:3 を 0。多重した TS をそのまま出す。仕様書 7A.7)。
    /// TS クロックの設定より前に書く。スリープでも戻さない
    /// </summary>
    internal static readonly CxdRow[] StartIsdbcHeadRows =
    [
        CxdRow.W(T, 0x00, 0x49),
        CxdRow.W(T, 0x36, 0x00, mask: 0x18),
    ];

    /// <summary>
    /// ISDB-C の起動 (スリープから。仕様書 7A.3 の手順 4〜30)。このあと <see cref="StartIsdbtTailRows"/> (手順 31〜32)。
    /// IF 3.7 MHz (<c>13 BB BC</c>)、QAM の探す範囲 <c>14</c> (64QAM と 256QAM。変調は復調器が見分ける)、シンボルレートの探す値 <c>07 08 07 08</c> (5.274 Msps。仕様書 7A.1)。
    /// J.83B (仕様書 7.2) と違い、帯域の設定を分けずに起動の中で 1 回だけ書く。スペクトルの反転の設定は書かない (仕様書 7A.1)
    /// </summary>
    internal static readonly CxdRow[] StartIsdbcRows =
    [
        CxdRow.W(X, 0x00, 0x00),
        CxdRow.W(X, 0x17, 0x09),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.W(T, 0xA9, 0x00),
        CxdRow.W(T, 0x2C, 0x01),
        CxdRow.W(T, 0x4B, 0x74),
        CxdRow.W(T, 0x49, 0x00),
        CxdRow.W(X, 0x18, 0x00),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0x6A, 0x48),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.W(T, 0xA5, 0x01),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.B(T, 0x33, 0x00, 0x03, 0x3B),
        CxdRow.W(T, 0x00, 0x48),
        CxdRow.W(T, 0x2C, 0x03),
        CxdRow.W(T, 0x00, 0x00),
        CxdRow.B(T, 0xCE, 0x01, 0x01),
        CxdRow.W(T, 0x00, 0x10),
        CxdRow.B(T, 0xA6, 0x31, 0xA8, 0x29, 0x9B, 0x27, 0x9C, 0x28, 0x9E, 0x29, 0xA4, 0x29, 0xA2, 0x29, 0xA8),
        CxdRow.B(T, 0xB6, 0x13, 0xBB, 0xBC),
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0xA3, 0x14),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x14, 0x14),
        CxdRow.W(T, 0x1E, 0x80),
        CxdRow.B(T, 0x26, 0x07, 0x08, 0x07, 0x08),
    ];

    /// <summary>ISDB-C からのスリープの最初 (仕様書 7A.5 の手順 1〜3。このあと TS のデータ端子を高インピーダンスにする)。ISDB-T の最初 (5.7) と同じ並び</summary>
    internal static readonly CxdRow[] SleepIsdbcHeadRows = SleepIsdbtHeadRows;

    /// <summary>
    /// ISDB-C からのスリープの残り (仕様書 7A.5 の手順 5〜11)。このあと共通の後始末 (仕様書 2.4)。
    /// 起動で書いたものの一部しか戻さない (バンク <c>11</c> の <c>6A</c>・<c>33</c>〜<c>35</c>、バンク <c>10</c> の <c>A5</c>〜<c>B3</c>・<c>B6</c>〜<c>B8</c>、バンク <c>00</c> の <c>CE</c>〜<c>CF</c>、
    /// バンク <c>40</c> の <c>26</c>〜<c>29</c>、バンク <c>49</c> の <c>36</c> は ISDB-C の値のまま残る)。ISDB-T と J.83B の起動は使うものを書き直す
    /// </summary>
    internal static readonly CxdRow[] SleepIsdbcRows =
    [
        CxdRow.W(T, 0x00, 0x11),
        CxdRow.W(T, 0xA3, 0x00),
        CxdRow.W(T, 0x00, 0x48),
        CxdRow.W(T, 0x2C, 0x01),
        CxdRow.W(T, 0x00, 0x40),
        CxdRow.W(T, 0x14, 0x1F),
        CxdRow.W(T, 0x1E, 0x00),
    ];

    /// <summary>初期化の手順 1〜14 (仕様書 2.2)。識別の値を返し、CXD2856・CXD2857 でなければ <see cref="IOException"/></summary>
    public byte Init()
    {
        link.Run(InitRows);
        var id = link.Read(T, 0xFD, 1)[0];
        if (!ChipIds.Contains(id)) throw new IOException($"復調器 (CXD2856ER) の識別が合いません (0x{id:X2})");
        return id;
    }

    /// <summary>TS の形の設定 (仕様書 3.2)</summary>
    public void TsForm() => link.Run(TsFormRows);

    /// <summary>TS クロックの設定 (仕様書 3.3)。手順 2 の読みは仕様書のとおり読むだけで使わない</summary>
    private void TsClock(byte gap, byte frequency)
    {
        link.Write(T, 0x00, 0x00);
        link.Read(T, 0xC4, 1);
        link.Run(TsClockRows(gap, frequency));
    }

    /// <summary>ISDB-T の起動 (スリープから。仕様書 5.2)。TS クロックの設定から、TS のデータ端子を出力にするまで</summary>
    public void StartIsdbt()
    {
        TsClock(TsNoGap, TsClockIsdbt);
        link.Run(StartIsdbtRows);
        link.Run(BandRows);
        link.Run(StartIsdbtTailRows);
        Output(true);
    }

    /// <summary>ISDB-T のままの選局し直し (仕様書 5.4 の手順 1)</summary>
    public void RetuneIsdbt()
    {
        link.Run(RetuneRows);
        link.Run(BandRows);
    }

    /// <summary>選局を終える (仕様書 2.3)</summary>
    public void Finish() => link.Run(FinishRows);

    /// <summary>ロックの状態 (バンク <c>60</c> の <c>10</c>。仕様書 5.6)</summary>
    public byte IsdbtStatus()
    {
        link.Write(T, 0x00, 0x60);
        return link.Read(T, 0x10, 1)[0];
    }

    /// <summary>ISDB-T からのスリープ (仕様書 5.7)</summary>
    public void SleepIsdbt()
    {
        link.Run(SleepIsdbtHeadRows);
        Output(false);
        link.Run(SleepIsdbtRows);
        link.Run(SleepCommonRows);
    }

    /// <summary>
    /// TS のデータ端子を出力にする・高インピーダンスにする (仕様書 5.5)。マスクは <c>C4</c> の読みで決まる (仕様書 3.2 の設定では <c>01</c>)
    /// </summary>
    public void Output(bool on)
    {
        link.Write(T, 0x00, 0x00);
        var c = link.Read(T, 0xC4, 1)[0];
        link.Write(T, 0x00, 0x00);
        byte mask = (c & 0x88) switch
        {
            0x80 => 0x01,
            0x88 => 0x80,
            _ => 0xFF,
        };
        link.Run([CxdRow.W(T, 0x81, (byte)(on ? 0x00 : 0xFF), mask)]);
    }

    /// <summary>
    /// ISDB-T の状態と C/N の元の値を読む (仕様書 8.1)。値を固めて (T の <c>01</c> ← <c>01</c>) から読み、読み終えたら (途中で失敗しても) <c>00</c> に戻す (仕様書 2.3)。
    /// 復調がロックしていなければ C/N の値は 0
    /// </summary>
    public (byte Status, ushort Cn) ReadIsdbtCn()
    {
        link.Write(T, 0x01, 0x01);
        try
        {
            link.Write(T, 0x00, 0x60);
            var status = link.Read(T, 0x10, 1)[0];
            if ((status & 0x02) == 0) return (status, 0);
            var raw = link.Read(T, 0x28, 2);
            return (status, (ushort)((raw[0] << 8) | raw[1]));
        }
        finally
        {
            link.Write(T, 0x01, 0x00);
        }
    }

    /// <summary>ISDB-S で TS を選ぶ (仕様書 6.3)。スリープでも動作中でも、起動や選局し直しより前に書く</summary>
    public void SelectTs(CxdStream stream) => link.Run(SelectTsRows(stream));

    /// <summary>ISDB-S の起動 (スリープから。仕様書 6.2)。TS クロックの設定 (ISDB-S) から、TS のデータ端子を出力にするまで</summary>
    public void StartIsdbs()
    {
        TsClock(TsNoGap, TsClockIsdbs);
        link.Run(StartIsdbsRows);
        Output(true);
    }

    /// <summary>ISDB-S のままの選局し直し (仕様書 6.3 の手順 2。T <c>00</c> ← <c>00</c>、<c>C3</c> ← <c>01</c>)。帯域の設定は無い</summary>
    public void RetuneIsdbs() => link.Run(RetuneRows);

    /// <summary>
    /// ISDB-S のロックの状態 (バンク <c>A0</c> の <c>10</c>〜<c>12</c>。仕様書 6.3)。
    /// <c>10</c> の bit5 が AGC、<c>12</c> の bit6 が TS、<c>12</c> の bit5 が TMCC のロック
    /// </summary>
    public byte[] IsdbsStatus()
    {
        link.Write(T, 0x00, 0xA0);
        return link.Read(T, 0x10, 3);
    }

    /// <summary>ISDB-S の TS のロック (<c>12</c> の bit6。選局の成否はこれで決める。仕様書 6.3)</summary>
    public static bool IsdbsLocked(byte[] status) => (status[2] & 0x40) != 0;

    /// <summary>ISDB-S の TMCC のロック (<c>12</c> の bit5。仕様書 6.3)</summary>
    public static bool IsdbsTmccLocked(byte[] status) => (status[2] & 0x20) != 0;

    /// <summary>ISDB-S からのスリープ (仕様書 6.5)</summary>
    public void SleepIsdbs()
    {
        link.Run(SleepIsdbsHeadRows);
        Output(false);
        link.Run(SleepIsdbsRows);
    }

    /// <summary>
    /// ISDB-S の C/N の元の値 (仕様書 8.2)。バンク <c>A1</c> の <c>10</c>〜<c>12</c> を読み、計算が終わっていなければ (b0 の bit0 が 0) null、
    /// 終わっていれば 13 ビットの値 <c>((b1 &amp; 0x1F) &lt;&lt; 8) | b2</c>。仕様書 8.2 の手順に値を固める書き込みは無いので、固めずに読む
    /// </summary>
    public ushort? ReadIsdbsCn()
    {
        link.Write(T, 0x00, 0xA1);
        var b = link.Read(T, 0x10, 3);
        if ((b[0] & 0x01) == 0) return null;
        return (ushort)(((b[1] & 0x1F) << 8) | b[2]);
    }

    /// <summary>ISDB-S の入力のレベルの元の値 (仕様書 8.6 の衛星。バンク <c>A0</c> の <c>1F</c>〜<c>20</c> から <c>((x0 &amp; 0x1F) &lt;&lt; 8) | x1</c>)</summary>
    public int ReadIsdbsAgc()
    {
        link.Write(T, 0x00, 0xA0);
        var x = link.Read(T, 0x1F, 2);
        return ((x[0] & 0x1F) << 8) | x[1];
    }

    /// <summary>
    /// TMCC の相対 TS 0〜7 の TSID (仕様書 6.4。バンク <c>C0</c> の <c>31</c>〜<c>40</c>、2 バイトずつ上位から)。
    /// 値を固めて (T <c>01</c> ← <c>01</c>) から読み、読み終えたら (途中で失敗しても) 戻す。TMCC がロックしているときだけ呼ぶ
    /// </summary>
    public ushort[] ReadTmccTsids()
    {
        link.Write(T, 0x01, 0x01);
        try
        {
            link.Write(T, 0x00, 0xC0);
            var raw = link.Read(T, 0x31, 16);
            var tsids = new ushort[8];
            for (var i = 0; i < tsids.Length; i++) tsids[i] = (ushort)((raw[2 * i] << 8) | raw[2 * i + 1]);
            return tsids;
        }
        finally
        {
            link.Write(T, 0x01, 0x00);
        }
    }

    /// <summary>J.83B の起動 (スリープから。仕様書 7.2)。TS クロックの設定 (J.83B) から、TS のデータ端子を出力にするまで</summary>
    public void StartJ83b()
    {
        TsClock(TsGap, TsClockJ83b);
        link.Run(StartJ83bRows);
        link.Run(BandJ83bRows);
        link.Run(StartIsdbtTailRows);
        Output(true);
    }

    /// <summary>J.83B のままの選局し直し (仕様書 7.4。T <c>00</c> ← <c>00</c>、<c>C3</c> ← <c>01</c>、帯域の設定)</summary>
    public void RetuneJ83b()
    {
        link.Run(RetuneRows);
        link.Run(BandJ83bRows);
    }

    /// <summary>
    /// J.83B のロックの状態 (仕様書 7.5)。バンク <c>40</c> の <c>88</c> (bit0 が復調のロック、bit1 がロックしないと分かった) と <c>10</c> (bit5 が TS のロック)
    /// </summary>
    public (byte Search, byte Ts) J83bStatus()
    {
        link.Write(T, 0x00, 0x40);
        var search = link.Read(T, 0x88, 1)[0];
        var ts = link.Read(T, 0x10, 1)[0];
        return (search, ts);
    }

    /// <summary>J.83B のロック (<c>88</c> の bit0 と <c>10</c> の bit5 がどちらも 1。仕様書 7.5)</summary>
    public static bool J83bLocked((byte Search, byte Ts) status) => (status.Search & 0x01) != 0 && (status.Ts & 0x20) != 0;

    /// <summary>J.83B からのスリープ (仕様書 7.4)</summary>
    public void SleepJ83b()
    {
        link.Run(SleepJ83bHeadRows);
        Output(false);
        link.Run(SleepJ83bRows);
        link.Run(SleepCommonRows);
    }

    /// <summary>
    /// J.83B の状態と、変調・C/N・PER の元の値を読む (仕様書 8.4)。値を固めて (T の <c>01</c> ← <c>01</c>) から読み、読み終えたら (途中で失敗しても) 戻す (仕様書 2.3)。
    /// 自動の探索がロックしていなければ (<c>88</c> の bit0 が 0) 値を読まない (仕様書 8.4 が PLEX の公開ドライバーの手順として書く形)。
    /// PER も複数のレジスタにまたがる誤り率なので、同じ固めた間に読む (仕様書に無い。8.4 は PER を固めるかを書いていないので、2.3 の一般の決まりから決めた)
    /// </summary>
    public CxdJ83bSignal ReadJ83bSignal()
    {
        link.Write(T, 0x01, 0x01);
        try
        {
            link.Write(T, 0x00, 0x40);
            var search = link.Read(T, 0x88, 1)[0];
            var ts = link.Read(T, 0x10, 1)[0];
            if ((search & 0x01) == 0) return new CxdJ83bSignal(search, ts, null, 0, null);
            var modulation = (byte)(link.Read(T, 0x19, 1)[0] & 0x07);
            var cn = link.Read(T, 0x4C, 2);
            var per = link.Read(T, 0x5C, 4);
            return new CxdJ83bSignal(search, ts, modulation, ((cn[0] & 0x1F) << 8) | cn[1], per);
        }
        finally
        {
            link.Write(T, 0x01, 0x00);
        }
    }

    /// <summary>
    /// ISDB-C の起動 (スリープから。仕様書 7A.3)。TSMF の処理をしない設定 → TS クロックの設定 (ISDB-C。パケットの間の隙間を入れず、周波数は高い。仕様書 3.3) →
    /// 手順 4〜32 → TS のデータ端子を出力にする
    /// </summary>
    public void StartIsdbc()
    {
        link.Run(StartIsdbcHeadRows);
        TsClock(TsNoGap, TsClockIsdbc);
        link.Run(StartIsdbcRows);
        link.Run(StartIsdbtTailRows);
        Output(true);
    }

    /// <summary>
    /// ISDB-C のままの選局し直し (仕様書 7A.4。T <c>00</c> ← <c>00</c>、<c>C3</c> ← <c>01</c> の 2 行だけ)。帯域や IF、TSMF の設定は起動で書いた値のままにする
    /// </summary>
    public void RetuneIsdbc() => link.Run(RetuneRows);

    /// <summary>ISDB-C のロックの状態 (仕様書 7A.6)。読むレジスタも判定も J.83B (仕様書 7.5) と同じ</summary>
    public (byte Search, byte Ts) IsdbcStatus() => J83bStatus();

    /// <summary>ISDB-C からのスリープ (仕様書 7A.5)</summary>
    public void SleepIsdbc()
    {
        link.Run(SleepIsdbcHeadRows);
        Output(false);
        link.Run(SleepIsdbcRows);
        link.Run(SleepCommonRows);
    }

    /// <summary>
    /// ISDB-C の状態と、変調・C/N・PER (仕様書 8.4) と、ほかに読める値 (仕様書 8.4A) の元の値を読む。
    /// 変調・C/N と「ロックが前提」の値 (反転・搬送波のずれ・シンボルレート) は、値を固めて (T の <c>01</c> ← <c>01</c>) 自動の探索のロック (<c>88</c> の bit0) を確かめてから読み、
    /// 読み終えたら (途中で失敗しても) 戻す (仕様書 2.3)。PER・RS の前の BER・直せなかったパケットの数・IF の AGC は固めずに読む (仕様書 8.4・8.4A)。
    /// 8.4A の値と PER は、ISDB-C の実機で読んだ記録が無い (仕様書 13)
    /// </summary>
    public CxdIsdbcSignal ReadIsdbcSignal()
    {
        byte search;
        byte ts;
        byte? modulation = null;
        var cnRaw = 0;
        byte[]? locked = null;
        link.Write(T, 0x01, 0x01);
        try
        {
            link.Write(T, 0x00, 0x40);
            search = link.Read(T, 0x88, 1)[0];
            ts = link.Read(T, 0x10, 1)[0];
            if ((search & 0x01) != 0)
            {
                var mode = link.Read(T, 0x19, 1)[0];
                var cn = link.Read(T, 0x4C, 2);
                var offset = link.Read(T, 0x15, 2);
                var rate = link.Read(T, 0x1A, 2);
                var fraction = link.Read(T, 0x9B, 5);
                modulation = (byte)(mode & 0x07);
                cnRaw = ((cn[0] & 0x1F) << 8) | cn[1];
                locked = [mode, .. offset, .. rate, .. fraction];
            }
        }
        finally
        {
            link.Write(T, 0x01, 0x00);
        }
        // 固めずに読む値。T の 01 はバンクによらないので、バンクは 40 のまま
        var per = link.Read(T, 0x5C, 4);
        var length = link.Read(T, 0x60, 1)[0];
        var ber = link.Read(T, 0x62, 3);
        var uncorrected = link.Read(T, 0xEA, 3);
        var agc = link.Read(T, 0x49, 2);
        return new CxdIsdbcSignal(search, ts, modulation, cnRaw, per, locked, length, ber, uncorrected, ((agc[0] & 0x0F) << 8) | agc[1]);
    }

    /// <summary>
    /// ISDB-C の C/N (dB。仕様書 8.4)。変調は 64QAM (2) か 256QAM (4) だけを使い、r を 126 以上にして <c>-9.5 × ln(r) + 95.941</c>。ほかの変調は誤りとして null
    /// </summary>
    public static double? IsdbcCnDb(byte modulation, int raw) => modulation is 2 or 4 ? J83bCnDb(modulation, raw) : null;

    /// <summary>
    /// ISDB-C でほかに読める値 (仕様書 8.4A) を、元の値から求める。「ロックが前提」の値は、自動の探索がロックしていなければ null。
    /// スペクトルの「反転」はこちらで設定しない (仕様書 7A.1) ので、反転と搬送波のずれの符号は読んだまま
    /// </summary>
    public static CxdIsdbcDetail IsdbcDetail(CxdIsdbcSignal read)
    {
        bool? inverted = null;
        double? offsetKhz = null;
        double? symbolRate = null;
        if (read.Locked is { Length: 10 } x)
        {
            inverted = (x[0] & 0x80) != 0;
            // 14 ビットの 2 の補数
            var offset = ((x[1] & 0x3F) << 8) | x[2];
            if (offset >= 0x2000) offset -= 0x4000;
            offsetKhz = offset * 48000.0 / 16384;
            var t = ((x[3] & 0x0F) << 8) | x[4];
            var i = unchecked((int)(((uint)x[5] << 24) | ((uint)x[6] << 16) | ((uint)x[7] << 8) | x[8]));
            var d = x[9] & 0x03;
            symbolRate = (t + i / Math.Pow(2, 24 + d)) * 48 / 16384;
        }
        double? ber = null;
        if (read.Ber is { Length: 3 } b && (b[0] & 0x80) != 0)
        {
            var errors = ((b[0] & 0x3F) << 16) | (b[1] << 8) | b[2];
            ber = errors / (Math.Pow(2, read.BerLength & 0x1F) * 204 * 8);
        }
        int? uncorrected = read.Uncorrected is { Length: 3 } u && (u[2] & 0x01) != 0 ? (u[0] << 8) | u[1] : null;
        return new CxdIsdbcDetail(inverted, offsetKhz, symbolRate, ber, uncorrected, read.IfAgc);
    }

    /// <summary>J.83B の変調の名前 (バンク <c>40</c> の <c>19</c> の下位 3 ビット。仕様書 8.4)。表に無い値は null</summary>
    public static string? J83bModulationName(byte modulation) => modulation switch
    {
        0 => "16QAM",
        1 => "32QAM",
        2 => "64QAM",
        3 => "128QAM",
        4 => "256QAM",
        _ => null,
    };

    /// <summary>
    /// J.83B の C/N (dB。仕様書 8.4 の手順 6・7)。64QAM・256QAM は r を 126 以上にして <c>-9.5 × ln(r) + 95.941</c>、
    /// 32QAM・128QAM は r を 69 以上にして <c>-8.8 × ln(r) + 86.99</c>。16QAM と表に無い値は式が仕様書に無いので null
    /// </summary>
    public static double? J83bCnDb(byte modulation, int raw) => modulation switch
    {
        2 or 4 => -9.5 * Math.Log(Math.Max(raw, 126)) + 95.941,
        1 or 3 => -8.8 * Math.Log(Math.Max(raw, 69)) + 86.99,
        _ => null,
    };

    /// <summary>
    /// J.83B の PER (仕様書 8.4)。バンク <c>40</c> の <c>5C</c>〜<c>5F</c> の 4 バイト b0〜b3 から、b1 の bit2 が 0 なら値は無い (null)。
    /// 誤りパケットの数 e = <c>((b1 &amp; 0x03) &lt;&lt; 16) | (b2 &lt;&lt; 8) | b3</c>、測った長さの指数 n = <c>b0 &amp; 0x1F</c>、PER = e / 2^n。
    /// e が 2^n を超えたら値が壊れているので null。J.83B で値が正しいかは実機で確かめられていない (仕様書 8.4・13)
    /// </summary>
    public static double? J83bPer(byte[]? raw)
    {
        if (raw is not { Length: 4 } || (raw[1] & 0x04) == 0) return null;
        var errors = ((raw[1] & 0x03) << 16) | (raw[2] << 8) | raw[3];
        var measured = Math.Pow(2, raw[0] & 0x1F);
        return errors > measured ? null : errors / measured;
    }

    /// <summary>
    /// 付録 A の表 (ISDB-S の C/N。「13 ビットの値:dB」の並びを仕様書のまま写したもの)。値が小さいほど C/N が高い
    /// </summary>
    private const string IsdbsCnTableText =
        "05AF:0.0 0597:0.1 057E:0.2 0567:0.3 0550:0.4 0539:0.5 0522:0.6 050C:0.7 " +
        "04F6:0.8 04E1:0.9 04CC:1.0 04B6:1.1 04A1:1.2 048C:1.3 0477:1.4 0463:1.5 " +
        "044F:1.6 043C:1.7 0428:1.8 0416:1.9 0403:2.0 03EF:2.1 03DC:2.2 03C9:2.3 " +
        "03B6:2.4 03A4:2.5 0392:2.6 0381:2.7 036F:2.8 035F:2.9 034E:3.0 033D:3.1 " +
        "032D:3.2 031D:3.3 030D:3.4 02FD:3.5 02EE:3.6 02DF:3.7 02D0:3.8 02C2:3.9 " +
        "02B4:4.0 02A6:4.1 0299:4.2 028C:4.3 027F:4.4 0272:4.5 0265:4.6 0259:4.7 " +
        "024D:4.8 0241:4.9 0236:5.0 022B:5.1 0220:5.2 0215:5.3 020A:5.4 0200:5.5 " +
        "01F6:5.6 01EC:5.7 01E2:5.8 01D8:5.9 01CF:6.0 01C6:6.1 01BC:6.2 01B3:6.3 " +
        "01AA:6.4 01A2:6.5 0199:6.6 0191:6.7 0189:6.8 0181:6.9 0179:7.0 0171:7.1 " +
        "0169:7.2 0161:7.3 015A:7.4 0153:7.5 014B:7.6 0144:7.7 013D:7.8 0137:7.9 " +
        "0130:8.0 012A:8.1 0124:8.2 011E:8.3 0118:8.4 0112:8.5 010C:8.6 0107:8.7 " +
        "0101:8.8 00FC:8.9 00F7:9.0 00F2:9.1 00EC:9.2 00E7:9.3 00E2:9.4 00DD:9.5 " +
        "00D8:9.6 00D4:9.7 00CF:9.8 00CA:9.9 00C6:10.0 00C2:10.1 00BE:10.2 00B9:10.3 " +
        "00B5:10.4 00B1:10.5 00AE:10.6 00AA:10.7 00A6:10.8 00A3:10.9 009F:11.0 009B:11.1 " +
        "0098:11.2 0095:11.3 0091:11.4 008E:11.5 008B:11.6 0088:11.7 0085:11.8 0082:11.9 " +
        "007F:12.0 007C:12.1 007A:12.2 0077:12.3 0074:12.4 0072:12.5 006F:12.6 006D:12.7 " +
        "006B:12.8 0068:12.9 0066:13.0 0064:13.1 0061:13.2 005F:13.3 005D:13.4 005B:13.5 " +
        "0059:13.6 0057:13.7 0055:13.8 0053:13.9 0051:14.0 004F:14.1 004E:14.2 004C:14.3 " +
        "004A:14.4 0049:14.5 0047:14.6 0045:14.7 0044:14.8 0042:14.9 0041:15.0 003F:15.1 " +
        "003E:15.2 003C:15.3 003B:15.4 003A:15.5 0038:15.6 0037:15.7 0036:15.8 0034:15.9 " +
        "0033:16.0 0032:16.1 0031:16.2 0030:16.3 002F:16.4 002E:16.5 002D:16.6 002C:16.7 " +
        "002B:16.8 002A:16.9 0029:17.0 0028:17.1 0027:17.2 0026:17.3 0025:17.4 0024:17.5 " +
        "0023:17.6 0022:17.8 0021:17.9 0020:18.0 001F:18.2 001E:18.3 001D:18.5 001C:18.7 " +
        "001B:18.9 001A:19.0 0019:19.2 0018:19.3 0017:19.5 0016:19.7 0015:19.9 0014:20.0";

    /// <summary>付録 A の表を (値, dB) の並びにしたもの。値の大きいほうから並ぶ</summary>
    internal static readonly IReadOnlyList<(ushort Raw, double Db)> IsdbsCnTable = [.. IsdbsCnTableText.Split(' ').Select(entry =>
    {
        var colon = entry.IndexOf(':');
        return (Convert.ToUInt16(entry[..colon], 16), double.Parse(entry[(colon + 1)..], System.Globalization.CultureInfo.InvariantCulture));
    })];

    /// <summary>
    /// ISDB-S の C/N (dB) を付録 A の表で求める (仕様書 8.2 の手順 5)。r が表の最初 (<c>0x05AF</c>) 以上なら 0.0 dB、最後 (<c>0x0014</c>) 以下なら 20.0 dB。
    /// それ以外は、表の値のうち r 以上で最も小さいものの dB
    /// </summary>
    public static double IsdbsCnDb(ushort raw)
    {
        if (raw >= IsdbsCnTable[0].Raw) return IsdbsCnTable[0].Db;
        if (raw <= IsdbsCnTable[^1].Raw) return IsdbsCnTable[^1].Db;
        // 値の大きいほうから並んでいるので、r 以上の最後の行が「r 以上で最も小さいもの」
        var found = IsdbsCnTable[0];
        foreach (var entry in IsdbsCnTable)
        {
            if (entry.Raw < raw) break;
            found = entry;
        }
        return found.Db;
    }

    /// <summary>
    /// 衛星の入力のレベル (dB。仕様書 8.6 の衛星): 利得 (dB × 100) = <c>v × (-1400) / 403 + 9700</c> (四捨五入)、レベル = -利得 / 100
    /// </summary>
    public static double IsdbsLevelDb(int agc)
    {
        var gain = (int)Math.Round(agc * -1400.0 / 403, MidpointRounding.AwayFromZero) + 9700;
        return -gain / 100.0;
    }
}
/// <summary>
/// 受信機 1 つぶんの復調器 (CXD2856ER) とチューナー (CXD2858ER)。初期化・地上波と衛星と J.83B と ISDB-C の選局とロックの待ち・方式の切り替え・信号品質・スリープ。
///
/// <para>
/// **同じバスの受信機と I2C を交えない。** 5 つのチューナーはどれも同じアドレスで、バス 1 とバス 3 に分かれている (仕様書 1.1)。
/// 中継を開けてから閉じるまで、バスのロック (<c>busLock</c>。同じバスの受信機で 1 つ) を持ち続ける (仕様書 1.4)。
/// 復調器だけへの書き込みも、読んでから書く行がほかの受信機と交わらないよう、同じロックの中で書く。
/// ロックを待つ間 (10 ms ごとの読み) は、読むたびにロックを取り直すので、ほかの受信機の選局が間に入れる。
/// </para>
///
/// <para>
/// **1 つの受信機の操作は 1 つずつ通す** (<c>_op</c> のロック)。ふだん呼ぶのはその受信機の <see cref="It930xTuner"/> だけだが、
/// J.83B か ISDB-C を初めて選局したときは、ほかの受信機のチューナーから整合を保つ設定 (<see cref="KeepMatching"/>) が呼ばれる。
/// ロックの順は「受信機の操作 → バス」で、逆には取らない。
/// </para>
/// </summary>
public sealed class Cxd2856Frontend
{
    /// <summary>ロックを確かめる間隔 (仕様書 5.6・6.3・7.5・11)</summary>
    public const int LockPollMs = 10;

    /// <summary>ISDB-T のロックの時間切れ (仕様書 11 の勧め 1.5 秒。信号が無いと分かればすぐ失敗)</summary>
    public const int IsdbtLockTimeoutMs = 1500;

    /// <summary>ISDB-T でロックを確かめ始めてから、TS を流すまでの最短の時間 (仕様書 5.6。ロックの表示が整う前に立つことがあるため)</summary>
    public const int IsdbtSettleMs = 350;

    /// <summary>
    /// ISDB-S のロックの時間切れ (仕様書 11 の勧め 3 秒)。信号が無いと早く分かる手段は無い (仕様書 6.3)。
    /// 「指定した TSID が無い」ビット (仕様書 6.3) で早く失敗にしてよいかは確かめられていないので、使わずに時間切れまで待つ
    /// </summary>
    public const int IsdbsLockTimeoutMs = 3000;

    /// <summary>
    /// J.83B のロックの時間切れ (仕様書 7.5・11 の 1 秒)。「ロックしないと分かった」ビット (<c>88</c> の bit1) はスキャン専用の設定でだけ働くとされるので使わない (仕様書 7.5)
    /// </summary>
    public const int J83bLockTimeoutMs = 1000;

    /// <summary>ISDB-T の入力のレベルの補正 (dB × 100。仕様書 8.6)</summary>
    private const int IsdbtLevelCorrection = -450;

    /// <summary>
    /// ISDB-C のロックの時間切れ (仕様書 7A.6・11 の 1 秒)。「信号が無いと分かった」ビット (<c>88</c> の bit1) はスキャン専用の設定でだけ働き、その設定は使わない (仕様書 7A.6)
    /// </summary>
    public const int IsdbcLockTimeoutMs = 1000;

    /// <summary>J.83B と ISDB-C の入力のレベルの補正 (dB × 100。仕様書 8.6)</summary>
    private const int J83bLevelCorrection = -150;

    private enum State
    {
        /// <summary>まだ初期化していないか、途中で失敗して状態が分からない (分からないときに初期化からやり直す扱いは仕様書に無い)</summary>
        Unknown,
        Sleep,
        Isdbt,
        Isdbs,
        J83b,
        Isdbc,
    }

    /// <summary>動作中の方式か (スリープでも、状態が分からないのでもない)</summary>
    private static bool Running(State state) => state is State.Isdbt or State.Isdbs or State.J83b or State.Isdbc;

    private readonly Lock _busLock;
    private readonly Lock _op = new();
    private readonly CxdLink _link;
    private readonly Cxd2856 _demod;
    private readonly Cxd2858 _tuner;
    private readonly Func<long> _nowMs;
    private readonly Action<int> _sleep;
    private State _state = State.Unknown;
    private uint _khz;

    /// <summary>
    /// 初期化のあと、起動か選局し直しを書き始めた方式 (<see cref="State.Isdbt"/>・<see cref="State.Isdbs"/>・<see cref="State.J83b"/>・<see cref="State.Isdbc"/>。書き始めていなければ <see cref="State.Sleep"/>)。
    /// 途中で失敗して状態が分からなくなっても、使い終えたときにこの方式のスリープの書き込みを送る
    /// </summary>
    private State _started = State.Sleep;

    /// <param name="bus">この受信機のバス</param>
    /// <param name="busLock">同じバスの受信機で 1 つのロック</param>
    /// <param name="demodAddress">復調器の T のアドレス (7 ビット。仕様書 1.2)</param>
    /// <param name="sleep">待つ (ms)。テストは時計を進めるだけにする</param>
    /// <param name="nowMs">いまの時刻 (ms)。ロックの待ちを測る</param>
    public Cxd2856Frontend(ICxdBus bus, Lock busLock, byte demodAddress, Action<int> sleep, Func<long> nowMs)
    {
        _busLock = busLock;
        _sleep = sleep;
        _nowMs = nowMs;
        _link = new CxdLink(bus, demodAddress, sleep);
        _demod = new Cxd2856(_link);
        _tuner = new Cxd2858(_link);
    }

    /// <summary>識別のレジスタの値 (初期化のあと。0x90 なら CXD2856、0x91 なら CXD2857)</summary>
    public byte ChipId { get; private set; }

    /// <summary>最後の選局で、ロックを確かめ始めてからロックするまで (ms)。ロックしなければ -1</summary>
    public long LockMs { get; private set; } = -1;

    /// <summary>
    /// 衛星で最後に <see cref="Signal"/> を読んだときの強度 (仕様書 8.6 の衛星の式。dB)。dBm として扱えるかは未確認なので、
    /// 画面に出す強度 (<see cref="TunerSignal.StrengthDbm"/>) には入れず、<c>--tune</c> の出力にだけ出す。読んでいなければ null
    /// </summary>
    public double? SatelliteLevelDb { get; private set; }

    /// <summary>J.83B と ISDB-C で最後に <see cref="Signal"/> を読んだときの変調 (<c>256QAM</c> など。仕様書 8.4)。<c>--tune</c> の出力にだけ出す。読めていなければ null</summary>
    public string? CableModulation { get; private set; }

    /// <summary>
    /// J.83B と ISDB-C で最後に <see cref="Signal"/> を読んだときの PER (仕様書 8.4)。どちらも値が正しいかは実機で確かめられていないので、<c>--tune</c> の出力にだけ出す。読めていなければ null
    /// </summary>
    public double? CablePer { get; private set; }

    /// <summary>ISDB-C で最後に <see cref="Signal"/> を読んだときの、ほかに読める値 (仕様書 8.4A)。<c>--tune</c> の出力にだけ出す。読んでいなければ null</summary>
    public CxdIsdbcDetail? IsdbcDetail { get; private set; }

    /// <summary>待機中の地上波の RF 入力の整合を保つ設定になっているか (仕様書 4.7。<see cref="KeepMatching"/>)。テストのため。受信機の操作のロックを取るので、選局の間は待つ</summary>
    internal bool KeepsMatching
    {
        get
        {
            lock (_op) return _tuner.KeepMatching;
        }
    }

    /// <summary>
    /// 初期化 (電源を入れたあと 1 回。仕様書 2.2)。復調器の初期化 → チューナーの初期化 (中継の中で) → TS の形の設定。
    /// 識別が合わない・チューナーの CPU の状態が 0 でないときは <see cref="IOException"/> (その受信機だけを使えなくする。仕様書 2.2)
    /// </summary>
    public void Init()
    {
        lock (_op)
        {
            _state = State.Unknown;
            lock (_busLock)
            {
                ChipId = _demod.Init();
                Relay(_tuner.Init);
                _demod.TsForm();
            }
            _state = State.Sleep;
            _started = State.Sleep;
        }
    }

    /// <summary>
    /// 待機中の地上波の RF 入力の整合を保つ設定にする (仕様書 4.7)。J.83B か ISDB-C を初めて選局するときに、機材の全受信機に呼ぶ (<see cref="It930xDevice.KeepMatching"/>)。
    /// 一度立てたら、電源を切るまで (この受信機を作り直すまで) 立てたまま。
    /// <paramref name="standby"/> が true で、受信機が閉じている (スリープか、まだ初期化していない・状態が分からない) なら、初期化し直して待機させる (仕様書 4.7)。
    /// 状態が分からないときは、起動を書き始めていた方式のスリープを先に送る。動作中なら設定だけを立て、止めるときに書く (仕様書 4.6)
    /// </summary>
    public void KeepMatching(bool standby)
    {
        lock (_op)
        {
            _tuner.KeepMatching = true;
            if (!standby || Running(_state)) return;
            if (_state == State.Unknown) Sleep();
            Init();
        }
    }

    /// <summary>
    /// 地上波 (ISDB-T 6 MHz) を選局し、ロックを待つ (仕様書 5.4)。<paramref name="khz"/> は中心周波数の kHz (仕様書 5.1)。
    /// ほかの方式で動作中なら、その方式のスリープから起動し直す (仕様書 10.1)。チューナーは衛星側を止めてから地上波の周波数を書く (仕様書 10.2)。
    /// ロックしなければ false (例外にしない。スキャンで続くため)。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneIsdbt(uint khz)
    {
        // 何も書かずに断る (チューナーに渡せるのは 20 ビットまで。仕様書 4.1)
        if (khz > Cxd2858.MaxTerrestrialKhz) throw new IOException($"地上波の周波数は {Cxd2858.MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        lock (_op)
        {
            ClearReadings();
            Tune(State.Isdbt, () => { }, () => _tuner.TuneTerrestrial(khz));
            _khz = khz;
            return WaitIsdbt();
        }
    }

    /// <summary>
    /// 衛星 (ISDB-S) を選局し、ロックを待つ (仕様書 6.3)。<paramref name="khz"/> は衛星の IF (LNB の出力) の kHz (仕様書 6.1)、
    /// <paramref name="stream"/> は受ける TS (TSID か相対 TS 番号)。TS を選ぶ書き込みは、起動や選局し直しより前に書く (仕様書 6.3)。
    /// ほかの方式で動作中なら、その方式のスリープから起動し直す (仕様書 10.1)。チューナーは地上波側を止めてから衛星の周波数を書く (仕様書 10.2)。
    /// ロックしなければ false。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneIsdbs(uint khz, CxdStream stream)
    {
        // 何も書かずに断る
        if (khz > Cxd2858.MaxSatelliteKhz) throw new IOException($"衛星の周波数は {Cxd2858.MaxSatelliteKhz} kHz までです ({khz} kHz)");
        // 相対 TS 番号は 0〜7 だけ (仕様書 6.3)
        if (stream.Tsid is null && stream.Relative > 7) throw new IOException($"相対 TS 番号は 0〜7 です ({stream.Relative})");
        lock (_op)
        {
            ClearReadings();
            Tune(State.Isdbs, () => _demod.SelectTs(stream), () => _tuner.TuneSatellite(khz));
            _khz = khz;
            // ロックしなかったときも、復調器は ISDB-S で動作中のまま残す (仕様書に無い)。次の選局が方式に合わせて選局し直すか起動し直し、
            // 受信機を閉じるときは Sleep がスリープにするので、ここでスリープにしなくても次の手順は変わらない
            return WaitIsdbs();
        }
    }

    /// <summary>
    /// J.83B (スカパー！プレミアムサービス光) を選局し、ロックを待つ (仕様書 7.4)。<paramref name="khz"/> は中心周波数の kHz (仕様書 7.1)。
    /// 変調 (64QAM か 256QAM か) は復調器が見分けるので、選局の手順は変調によらない (仕様書 7.1)。
    /// ほかの方式で動作中なら、その方式のスリープから起動し直す (仕様書 10.1)。チューナーは地上波側のまま周波数を書く (衛星側なら止めてから。仕様書 10.2)。
    /// ロックしなければ false (ISDB-S と同じく、復調器は J.83B で動作中のまま残す)。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneJ83b(uint khz)
    {
        if (khz > Cxd2858.MaxTerrestrialKhz) throw new IOException($"J.83B の周波数は {Cxd2858.MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        lock (_op)
        {
            ClearReadings();
            Tune(State.J83b, () => { }, () => _tuner.TuneCable(khz));
            _khz = khz;
            return WaitJ83b();
        }
    }

    /// <summary>
    /// ISDB-C (ケーブルテレビのトランスモジュレーション方式) を選局し、ロックを待つ (仕様書 7A.4 の手順 2〜5)。<paramref name="khz"/> は中心周波数の kHz (仕様書 7A.2)。
    /// 変調 (64QAM か 256QAM か) は復調器が見分けるので、変調を指定する書き込みは無い (仕様書 7A.1)。
    /// ほかの方式 (J.83B を含む) で動作中なら、その方式のスリープから起動し直す (仕様書 10.1)。チューナーは地上波側のまま周波数を書く (衛星側なら止めてから。仕様書 10.2)。
    /// ロックしなければ false (復調器は ISDB-C で動作中のまま残す)。I2C の失敗は <see cref="IOException"/>。
    /// ロックは搬送波の TS が同期したことを示すだけで、TSMF で選ぶ TS があるかは受け取った TS から決める (<see cref="TsmfSelector"/>。仕様書 7A.7)
    /// </summary>
    public bool TuneIsdbc(uint khz)
    {
        if (khz > Cxd2858.MaxTerrestrialKhz) throw new IOException($"ISDB-C の周波数は {Cxd2858.MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        lock (_op)
        {
            ClearReadings();
            Tune(State.Isdbc, () => { }, () => _tuner.TuneIsdbc(khz));
            _khz = khz;
            return WaitIsdbc();
        }
    }

    /// <summary>前の選局で読んだ、<c>--tune</c> だけに出す値を消す</summary>
    private void ClearReadings()
    {
        SatelliteLevelDb = null;
        CableModulation = null;
        CablePer = null;
        IsdbcDetail = null;
    }

    /// <summary>
    /// 選局の書き込み (仕様書 5.4・6.3・7.4 の手順のうち、ロックを待つ前まで)。<paramref name="select"/> (ISDB-S の TS を選ぶ書き込み) →
    /// 選局し直しか方式の起動 (ほかの方式で動作中なら、その方式のスリープを先に。仕様書 10.1) → 中継の中で <paramref name="tune"/> (チューナーの周波数) → 選局を終える 3 行 (仕様書 2.3)
    /// </summary>
    private void Tune(State target, Action select, Action tune)
    {
        if (_state == State.Unknown)
        {
            /*
             * J.83B か ISDB-C の起動が途中で終わっていたら、その方式のスリープからやり直す (仕様書 7.4・7A.3・10.1。初期化では戻らないレジスタがある)。
             * スリープが失敗したら、ほかの方式の起動を始めずに失敗を返し、次の選局か停止でまたスリープからやり直す (仕様書 7.4・7A.5)
             */
            if (_started is State.J83b or State.Isdbc) Sleep();
            Init();
        }
        try
        {
            lock (_busLock)
            {
                select();
                if (_state == target)
                {
                    _started = target;
                    Retune(target);
                }
                else
                {
                    if (_state != State.Sleep)
                    {
                        SleepDemod(_state);
                        _state = State.Sleep;
                    }
                    _started = target;
                    Start(target);
                }
                _state = target;
                Relay(tune);
                _demod.Finish();
            }
        }
        catch (IOException)
        {
            // 途中で失敗したら、どこまで書いたかが分からない。次はスリープの状態から作り直すため、初期化からやり直す (仕様書に無い)
            _state = State.Unknown;
            throw;
        }
    }

    /// <summary>方式の起動 (スリープから。仕様書 5.2・6.2・7.2・7A.3)。バスのロックの中で呼ぶ</summary>
    private void Start(State mode)
    {
        switch (mode)
        {
            case State.Isdbt:
                _demod.StartIsdbt();
                break;
            case State.Isdbs:
                _demod.StartIsdbs();
                break;
            case State.Isdbc:
                _demod.StartIsdbc();
                break;
            default:
                _demod.StartJ83b();
                break;
        }
    }

    /// <summary>同じ方式のままの選局し直し (仕様書 5.4・6.3・7.4・7A.4)。バスのロックの中で呼ぶ</summary>
    private void Retune(State mode)
    {
        switch (mode)
        {
            case State.Isdbt:
                _demod.RetuneIsdbt();
                break;
            case State.Isdbs:
                _demod.RetuneIsdbs();
                break;
            case State.Isdbc:
                _demod.RetuneIsdbc();
                break;
            default:
                _demod.RetuneJ83b();
                break;
        }
    }

    /// <summary>
    /// ISDB-T のロックを待つ (仕様書 5.6)。10 ms ごとに読み、TS のロック (bit0) でロック、信号が無いと分かれば (bit4) すぐ失敗、1.5 秒で時間切れ。
    /// 確かめ始めてから 350 ms より早くロックしたら、350 ms になるまで待ってから返す
    /// </summary>
    private bool WaitIsdbt()
    {
        LockMs = -1;
        var started = _nowMs();
        while (true)
        {
            byte status;
            lock (_busLock) status = _demod.IsdbtStatus();
            var elapsed = _nowMs() - started;
            if ((status & 0x01) != 0)
            {
                LockMs = elapsed;
                if (elapsed < IsdbtSettleMs) _sleep((int)(IsdbtSettleMs - elapsed));
                return true;
            }
            if ((status & 0x10) != 0) return false;
            if (elapsed >= IsdbtLockTimeoutMs) return false;
            _sleep(LockPollMs);
        }
    }

    /// <summary>
    /// ISDB-S のロックを待つ (仕様書 6.3)。10 ms ごとに読み、TS のロック (バンク <c>A0</c> の <c>12</c> の bit6) でロック、3 秒で時間切れ。
    /// ロックのあとに待ち足すのは ISDB-T だけ (仕様書 5.6) なので、ここでは待たない
    /// </summary>
    private bool WaitIsdbs()
    {
        LockMs = -1;
        var started = _nowMs();
        while (true)
        {
            byte[] status;
            lock (_busLock) status = _demod.IsdbsStatus();
            var elapsed = _nowMs() - started;
            if (Cxd2856.IsdbsLocked(status))
            {
                LockMs = elapsed;
                return true;
            }
            if (elapsed >= IsdbsLockTimeoutMs) return false;
            _sleep(LockPollMs);
        }
    }

    /// <summary>
    /// J.83B のロックを待つ (仕様書 7.5)。10 ms ごとに読み、復調のロック (バンク <c>40</c> の <c>88</c> の bit0) と TS のロック (<c>10</c> の bit5) がどちらも立てばロック、1 秒で時間切れ。
    /// ロックのあとに待ち足すのは ISDB-T だけ (仕様書 5.6) なので、ここでは待たない
    /// </summary>
    private bool WaitJ83b()
    {
        LockMs = -1;
        var started = _nowMs();
        while (true)
        {
            (byte Search, byte Ts) status;
            lock (_busLock) status = _demod.J83bStatus();
            var elapsed = _nowMs() - started;
            if (Cxd2856.J83bLocked(status))
            {
                LockMs = elapsed;
                return true;
            }
            if (elapsed >= J83bLockTimeoutMs) return false;
            _sleep(LockPollMs);
        }
    }

    /// <summary>
    /// ISDB-C のロックを待つ (仕様書 7A.6)。J.83B と同じレジスタを 10 ms ごとに読み、復調のロック (バンク <c>40</c> の <c>88</c> の bit0) と TS のロック (<c>10</c> の bit5) がどちらも立てばロック、1 秒で時間切れ。
    /// ロックのあとの待ちは無い (仕様書 7A.6)
    /// </summary>
    private bool WaitIsdbc()
    {
        LockMs = -1;
        var started = _nowMs();
        while (true)
        {
            (byte Search, byte Ts) status;
            lock (_busLock) status = _demod.IsdbcStatus();
            var elapsed = _nowMs() - started;
            if (Cxd2856.J83bLocked(status))
            {
                LockMs = elapsed;
                return true;
            }
            if (elapsed >= IsdbcLockTimeoutMs) return false;
            _sleep(LockPollMs);
        }
    }

    /// <summary>
    /// 受信の状態と C/N と強度。動作中のときだけ読む (仕様書 8)。動作中でなければ null。
    /// ISDB-T は C/N を <c>10 × log10(r / 8)</c> dB (仕様書 8.1。復調がロックしていないか r が 0 なら null)、強度をチューナーの AGC から求めた dBm (仕様書 8.6)。
    /// ISDB-S は C/N を付録 A の表で (仕様書 8.2。計算が終わっていなければ null)。強度は復調器の AGC から求めた値 (仕様書 8.6 の衛星) を
    /// <see cref="SatelliteLevelDb"/> にだけ入れ、<see cref="TunerSignal.StrengthDbm"/> には入れない (仕様書は dB とだけ書いていて、dBm として扱えるかは未確認。仕様書 13)。
    /// J.83B は C/N を変調ごとの式で (仕様書 8.4。自動の探索がロックしていないか、式の無い変調なら null)、強度を地上波と同じチューナーの AGC から求めた dBm (仕様書 8.6。補正は -1.5 dB)。
    /// 変調と PER は <see cref="CableModulation"/>・<see cref="CablePer"/> にだけ入れる。
    /// ISDB-C は J.83B と同じレジスタと式で (仕様書 8.4。変調が 64QAM・256QAM でなければ C/N は null)、強度の補正も J.83B と同じ -1.5 dB (仕様書 8.6)。
    /// ほかに読める値 (仕様書 8.4A) は <see cref="IsdbcDetail"/> にだけ入れる
    /// </summary>
    public TunerSignal? Signal()
    {
        lock (_op)
        {
            switch (_state)
            {
                case State.Isdbt:
                {
                    byte status;
                    ushort raw;
                    (byte IfAgc, byte RfAgc, int Gain) agc = default;
                    lock (_busLock)
                    {
                        (status, raw) = _demod.ReadIsdbtCn();
                        Relay(() => agc = _tuner.ReadAgc());
                    }
                    double? cn = raw == 0 ? null : 10 * Math.Log10(raw / 8.0);
                    var level = Cxd2858.InputLevel(agc.IfAgc, agc.RfAgc, agc.Gain, _khz, IsdbtLevelCorrection);
                    return new TunerSignal((status & 0x01) != 0, cn, TunerSignal.Db, StrengthDbm: level / 100.0);
                }
                case State.Isdbs:
                {
                    byte[] status;
                    ushort? raw;
                    int agc;
                    lock (_busLock)
                    {
                        status = _demod.IsdbsStatus();
                        raw = _demod.ReadIsdbsCn();
                        agc = _demod.ReadIsdbsAgc();
                    }
                    double? cn = raw is { } r ? Cxd2856.IsdbsCnDb(r) : null;
                    SatelliteLevelDb = Cxd2856.IsdbsLevelDb(agc);
                    return new TunerSignal(Cxd2856.IsdbsLocked(status), cn, TunerSignal.Db);
                }
                case State.J83b:
                {
                    CxdJ83bSignal read;
                    (byte IfAgc, byte RfAgc, int Gain) agc = default;
                    lock (_busLock)
                    {
                        read = _demod.ReadJ83bSignal();
                        Relay(() => agc = _tuner.ReadAgc());
                    }
                    double? cn = read.Modulation is { } modulation ? Cxd2856.J83bCnDb(modulation, read.CnRaw) : null;
                    CableModulation = read.Modulation is { } named ? Cxd2856.J83bModulationName(named) : null;
                    CablePer = Cxd2856.J83bPer(read.Per);
                    var level = Cxd2858.InputLevel(agc.IfAgc, agc.RfAgc, agc.Gain, _khz, J83bLevelCorrection);
                    return new TunerSignal(Cxd2856.J83bLocked((read.Search, read.Ts)), cn, TunerSignal.Db, StrengthDbm: level / 100.0);
                }
                case State.Isdbc:
                {
                    CxdIsdbcSignal read;
                    (byte IfAgc, byte RfAgc, int Gain) agc = default;
                    lock (_busLock)
                    {
                        read = _demod.ReadIsdbcSignal();
                        Relay(() => agc = _tuner.ReadAgc());
                    }
                    double? cn = read.Modulation is { } modulation ? Cxd2856.IsdbcCnDb(modulation, read.CnRaw) : null;
                    CableModulation = read.Modulation is { } named ? Cxd2856.J83bModulationName(named) : null;
                    CablePer = Cxd2856.J83bPer(read.Per);
                    IsdbcDetail = Cxd2856.IsdbcDetail(read);
                    var level = Cxd2858.InputLevel(agc.IfAgc, agc.RfAgc, agc.Gain, _khz, J83bLevelCorrection);
                    return new TunerSignal(Cxd2856.J83bLocked((read.Search, read.Ts)), cn, TunerSignal.Db, StrengthDbm: level / 100.0);
                }
                default:
                    return null;
            }
        }
    }

    /// <summary>
    /// 衛星で動作中のとき、TMCC から読んだ相対 TS 0〜7 の TSID (仕様書 6.4)。TMCC がロックしていない・衛星で動作中でなければ null。
    /// 使っていない相対 TS の値がどうなるかは仕様書に無いので、読んだ 8 つをそのまま返す
    /// </summary>
    public ushort[]? SatelliteStreams()
    {
        lock (_op)
        {
            if (_state != State.Isdbs) return null;
            lock (_busLock)
            {
                if (!Cxd2856.IsdbsTmccLocked(_demod.IsdbsStatus())) return null;
                return _demod.ReadTmccTsids();
            }
        }
    }

    /// <summary>
    /// 使い終えたときに、チューナーを止めて (仕様書 4.6) から復調器をスリープにする (方式ごと。仕様書 5.7・6.5・7.4)。この順は仕様書 2.4 のもので、
    /// 仕様書 10.3 も順による違いは知られていないとしている。TS は、その前に呼ぶ側 (<see cref="It930xTuner"/>) がブリッジの入力を閉じて止めている。
    /// 動作中でなければ何もしない。選局の途中で失敗して状態が分からないときも、起動を書き始めていればその方式のスリープの書き込みを送る。
    /// そのときは、次の選局を初期化からやり直す (仕様書に無い)。J.83B か ISDB-C のスリープが途中で失敗したら、起動を書き始めた方式をそのまま残し、次の選局か停止でスリープからやり直す (仕様書 7.4・7A.5)
    /// </summary>
    public void Sleep()
    {
        lock (_op)
        {
            // 状態が分からなくても起動を書き始めていれば、動いたまま残さないようスリープを送る (仕様書に無い)
            var mode = Running(_state) ? _state : _state == State.Unknown ? _started : State.Sleep;
            if (!Running(mode)) return;
            try
            {
                lock (_busLock)
                {
                    Relay(_tuner.Stop);
                    SleepDemod(mode);
                }
                _started = State.Sleep;
                if (_state != State.Unknown) _state = State.Sleep;
            }
            catch (IOException)
            {
                _state = State.Unknown;
                _started = mode;
                throw;
            }
        }
    }

    /// <summary>その方式からの復調器のスリープ (仕様書 5.7・6.5・7.4)。バスのロックの中で呼ぶ</summary>
    private void SleepDemod(State mode)
    {
        switch (mode)
        {
            case State.Isdbs:
                _demod.SleepIsdbs();
                break;
            case State.J83b:
                _demod.SleepJ83b();
                break;
            case State.Isdbc:
                _demod.SleepIsdbc();
                break;
            default:
                _demod.SleepIsdbt();
                break;
        }
    }

    /// <summary>
    /// チューナーへの中継を開けて <paramref name="action"/> を呼び、閉じる (仕様書 1.4)。中で失敗しても閉じる書き込みは送る。
    /// 中継のレジスタはどのバンクでも同じなので、バンクを選ばずに書く。バスのロックの中で呼ぶ
    /// </summary>
    private void Relay(Action action)
    {
        _link.Write(CxdTarget.X, 0x08, 0x01);
        try
        {
            action();
        }
        catch
        {
            try
            {
                _link.Write(CxdTarget.X, 0x08, 0x00);
            }
            catch (IOException)
            {
                // 元の失敗を返す
            }
            throw;
        }
        _link.Write(CxdTarget.X, 0x08, 0x00);
    }
}
