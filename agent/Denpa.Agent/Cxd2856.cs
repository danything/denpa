namespace Denpa.Agent;

/*
 * Sony CXD2856ER (復調器) と、受信機 1 つぶんの復調器とチューナー (Cxd2856Frontend)。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。いまは地上波 (ISDB-T) と衛星 (ISDB-S) の分で、J.83B はまだ無い。
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
/// CXD2856ER の書き込みの並び (仕様書 2・3・5・6・8)。状態 (スリープか、どの方式で動作中か) は <see cref="Cxd2856Frontend"/> が覚える (仕様書 2.1)
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

    /// <summary>
    /// TS クロックの設定 (仕様書 3.3 の手順 3〜15)。方式で違うのは手順 10 の周波数 <paramref name="frequency"/> だけ (手順 3 の <c>D3</c> は ISDB-T・ISDB-S とも <c>01</c>)。
    /// 資料で値が分かれていて、仕様書 3.5 が選んだ値 (ISDB-T は低い・半分の速さ、ISDB-S は高い・半分の速さ)
    /// </summary>
    internal static CxdRow[] TsClockRows(byte frequency) =>
    [
        CxdRow.W(T, 0xD3, 0x01, mask: 0x01),
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
    private void TsClock(byte frequency)
    {
        link.Write(T, 0x00, 0x00);
        link.Read(T, 0xC4, 1);
        link.Run(TsClockRows(frequency));
    }

    /// <summary>ISDB-T の起動 (スリープから。仕様書 5.2)。TS クロックの設定から、TS のデータ端子を出力にするまで</summary>
    public void StartIsdbt()
    {
        TsClock(TsClockIsdbt);
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
        TsClock(TsClockIsdbs);
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
/// 受信機 1 つぶんの復調器 (CXD2856ER) とチューナー (CXD2858ER)。初期化・地上波と衛星の選局とロックの待ち・方式の切り替え・信号品質・スリープ。
///
/// <para>
/// **同じバスの受信機と I2C を交えない。** 5 つのチューナーはどれも同じアドレスで、バス 1 とバス 3 に分かれている (仕様書 1.1)。
/// 中継を開けてから閉じるまで、バスのロック (<c>busLock</c>。同じバスの受信機で 1 つ) を持ち続ける (仕様書 1.4)。
/// 復調器だけへの書き込みも、読んでから書く行がほかの受信機と交わらないよう、同じロックの中で書く。
/// ロックを待つ間 (10 ms ごとの読み) は、読むたびにロックを取り直すので、ほかの受信機の選局が間に入れる。
/// </para>
///
/// <para>
/// 1 つの受信機の操作は 1 つずつ呼ぶ (呼ぶ側の <see cref="It930xTuner"/> のロック)。
/// </para>
/// </summary>
public sealed class Cxd2856Frontend
{
    /// <summary>ロックを確かめる間隔 (仕様書 5.6・6.3・11)</summary>
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

    /// <summary>ISDB-T の入力のレベルの補正 (dB × 100。仕様書 8.6)</summary>
    private const int IsdbtLevelCorrection = -450;

    private enum State
    {
        /// <summary>まだ初期化していないか、途中で失敗して状態が分からない (分からないときに初期化からやり直す扱いは仕様書に無い)</summary>
        Unknown,
        Sleep,
        Isdbt,
        Isdbs,
    }

    private readonly Lock _busLock;
    private readonly CxdLink _link;
    private readonly Cxd2856 _demod;
    private readonly Cxd2858 _tuner;
    private readonly Func<long> _nowMs;
    private readonly Action<int> _sleep;
    private State _state = State.Unknown;
    private uint _khz;

    /// <summary>
    /// 初期化のあと、起動か選局し直しを書き始めた方式 (<see cref="State.Isdbt"/> か <see cref="State.Isdbs"/>。書き始めていなければ <see cref="State.Sleep"/>)。
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
    /// 初期化 (電源を入れたあと 1 回。仕様書 2.2)。復調器の初期化 → チューナーの初期化 (中継の中で) → TS の形の設定。
    /// 識別が合わない・チューナーの CPU の状態が 0 でないときは <see cref="IOException"/> (その受信機だけを使えなくする。仕様書 2.2)
    /// </summary>
    public void Init()
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

    /// <summary>
    /// 地上波 (ISDB-T 6 MHz) を選局し、ロックを待つ (仕様書 5.4)。<paramref name="khz"/> は中心周波数の kHz (仕様書 5.1)。
    /// 衛星で動作中なら、ISDB-S のスリープから起動し直す (仕様書 10.1)。チューナーは衛星側を止めてから地上波の周波数を書く (仕様書 10.2)。
    /// ロックしなければ false (例外にしない。スキャンで続くため)。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneIsdbt(uint khz)
    {
        // 何も書かずに断る (チューナーに渡せるのは 20 ビットまで。仕様書 4.1)
        if (khz > Cxd2858.MaxTerrestrialKhz) throw new IOException($"地上波の周波数は {Cxd2858.MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        Tune(State.Isdbt, () => { }, () => _tuner.TuneTerrestrial(khz));
        _khz = khz;
        return WaitIsdbt();
    }

    /// <summary>
    /// 衛星 (ISDB-S) を選局し、ロックを待つ (仕様書 6.3)。<paramref name="khz"/> は衛星の IF (LNB の出力) の kHz (仕様書 6.1)、
    /// <paramref name="stream"/> は受ける TS (TSID か相対 TS 番号)。TS を選ぶ書き込みは、起動や選局し直しより前に書く (仕様書 6.3)。
    /// 地上波で動作中なら、ISDB-T のスリープから起動し直す (仕様書 10.1)。チューナーは地上波側を止めてから衛星の周波数を書く (仕様書 10.2)。
    /// ロックしなければ false。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneIsdbs(uint khz, CxdStream stream)
    {
        // 何も書かずに断る
        if (khz > Cxd2858.MaxSatelliteKhz) throw new IOException($"衛星の周波数は {Cxd2858.MaxSatelliteKhz} kHz までです ({khz} kHz)");
        // 相対 TS 番号は 0〜7 だけ (仕様書 6.3)
        if (stream.Tsid is null && stream.Relative > 7) throw new IOException($"相対 TS 番号は 0〜7 です ({stream.Relative})");
        Tune(State.Isdbs, () => _demod.SelectTs(stream), () => _tuner.TuneSatellite(khz));
        _khz = khz;
        return WaitIsdbs();
    }

    /// <summary>
    /// 選局の書き込み (仕様書 5.4・6.3 の手順のうち、ロックを待つ前まで)。<paramref name="select"/> (ISDB-S の TS を選ぶ書き込み) →
    /// 選局し直しか方式の起動 (ほかの方式で動作中なら、その方式のスリープを先に。仕様書 10.1) → 中継の中で <paramref name="tune"/> (チューナーの周波数) → 選局を終える 3 行 (仕様書 2.3)
    /// </summary>
    private void Tune(State target, Action select, Action tune)
    {
        if (_state == State.Unknown) Init();
        try
        {
            lock (_busLock)
            {
                select();
                if (_state == target)
                {
                    _started = target;
                    if (target == State.Isdbt) _demod.RetuneIsdbt();
                    else _demod.RetuneIsdbs();
                }
                else
                {
                    if (_state != State.Sleep)
                    {
                        SleepDemod(_state);
                        _state = State.Sleep;
                    }
                    _started = target;
                    if (target == State.Isdbt) _demod.StartIsdbt();
                    else _demod.StartIsdbs();
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
    /// 受信の状態と C/N と強度。動作中のときだけ読む (仕様書 8)。動作中でなければ null。
    /// ISDB-T は C/N を <c>10 × log10(r / 8)</c> dB (仕様書 8.1。復調がロックしていないか r が 0 なら null)、強度をチューナーの AGC から求めた dBm (仕様書 8.6)。
    /// ISDB-S は C/N を付録 A の表で (仕様書 8.2。計算が終わっていなければ null)、強度を復調器の AGC から求めた値 (仕様書 8.6 の衛星)。
    /// 衛星の強度は仕様書では dB と書かれていて、dBm として比べられるかは実機で確かめていない
    /// </summary>
    public TunerSignal? Signal()
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
                return new TunerSignal(Cxd2856.IsdbsLocked(status), cn, TunerSignal.Db, StrengthDbm: Cxd2856.IsdbsLevelDb(agc));
            }
            default:
                return null;
        }
    }

    /// <summary>
    /// 衛星で動作中のとき、TMCC から読んだ相対 TS 0〜7 の TSID (仕様書 6.4)。TMCC がロックしていない・衛星で動作中でなければ null。
    /// 使っていない相対 TS の値がどうなるかは仕様書に無いので、読んだ 8 つをそのまま返す
    /// </summary>
    public ushort[]? SatelliteStreams()
    {
        if (_state != State.Isdbs) return null;
        lock (_busLock)
        {
            if (!Cxd2856.IsdbsTmccLocked(_demod.IsdbsStatus())) return null;
            return _demod.ReadTmccTsids();
        }
    }

    /// <summary>
    /// 使い終えたときに、チューナーを止めて (仕様書 4.6) から復調器をスリープにする (方式ごと。仕様書 5.7・6.5)。この順は仕様書 2.4 のもので、
    /// 仕様書 10.3 も順による違いは知られていないとしている。TS は、その前に呼ぶ側 (<see cref="It930xTuner"/>) がブリッジの入力を閉じて止めている。
    /// 動作中でなければ何もしない。選局の途中で失敗して状態が分からないときも、起動を書き始めていればその方式のスリープの書き込みを送る。
    /// そのときは、次の選局を初期化からやり直す (仕様書に無い)
    /// </summary>
    public void Sleep()
    {
        // 状態が分からなくても起動を書き始めていれば、動いたまま残さないようスリープを送る (仕様書に無い)
        var mode = _state is State.Isdbt or State.Isdbs ? _state : _state == State.Unknown ? _started : State.Sleep;
        if (mode is not (State.Isdbt or State.Isdbs)) return;
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
            throw;
        }
    }

    /// <summary>その方式からの復調器のスリープ (仕様書 5.7・6.5)。バスのロックの中で呼ぶ</summary>
    private void SleepDemod(State mode)
    {
        if (mode == State.Isdbs) _demod.SleepIsdbs();
        else _demod.SleepIsdbt();
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
