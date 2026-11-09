namespace Denpa.Agent;

/*
 * Sony CXD2856ER (復調器) と、受信機 1 つぶんの復調器とチューナー (Cxd2856Frontend)。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。いまは地上波 (ISDB-T) の分だけで、衛星 (ISDB-S) と J.83B はまだ無い。
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
/// CXD2856ER の書き込みの並び (仕様書 2・3・5)。状態 (スリープか ISDB-T で動作中か) は <see cref="Cxd2856Frontend"/> が覚える (仕様書 2.1)
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

    /// <summary>
    /// TS クロックの設定の ISDB-T の値 (仕様書 3.3 の手順 3〜15)。資料で値が分かれていて、仕様書 3.5 が選んだ値 (低い・半分の速さ)
    /// </summary>
    internal static readonly CxdRow[] TsClockIsdbtRows =
    [
        CxdRow.W(T, 0xD3, 0x01, mask: 0x01),
        CxdRow.W(T, 0xDE, 0x00, mask: 0x01),
        CxdRow.W(T, 0xDA, 0x00, mask: 0x01),
        CxdRow.W(T, 0xC4, 0x00, mask: 0x03),
        CxdRow.W(T, 0xD1, 0x02, mask: 0x03),
        CxdRow.W(T, 0xD9, 0x10),
        CxdRow.W(T, 0x32, 0x00, mask: 0x01),
        CxdRow.W(T, 0x33, 0x02, mask: 0x03),
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

    /// <summary>TS クロックの設定の ISDB-T の値 (仕様書 3.3)。手順 2 の読みは仕様書のとおり読むだけで使わない</summary>
    public void TsClockIsdbt()
    {
        link.Write(T, 0x00, 0x00);
        link.Read(T, 0xC4, 1);
        link.Run(TsClockIsdbtRows);
    }

    /// <summary>ISDB-T の起動 (スリープから。仕様書 5.2)。TS クロックの設定から、TS のデータ端子を出力にするまで</summary>
    public void StartIsdbt()
    {
        TsClockIsdbt();
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
}

/// <summary>
/// 受信機 1 つぶんの復調器 (CXD2856ER) とチューナー (CXD2858ER)。初期化・地上波の選局とロックの待ち・信号品質・スリープ。
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
    /// <summary>ロックを確かめる間隔 (仕様書 5.6・11)</summary>
    public const int LockPollMs = 10;

    /// <summary>ISDB-T のロックの時間切れ (仕様書 11 の勧め 1.5 秒。信号が無いと分かればすぐ失敗)</summary>
    public const int IsdbtLockTimeoutMs = 1500;

    /// <summary>ISDB-T でロックを確かめ始めてから、TS を流すまでの最短の時間 (仕様書 5.6。ロックの表示が整う前に立つことがあるため)</summary>
    public const int IsdbtSettleMs = 350;

    /// <summary>ISDB-T の入力のレベルの補正 (dB × 100。仕様書 8.6)</summary>
    private const int IsdbtLevelCorrection = -450;

    private enum State
    {
        /// <summary>まだ初期化していないか、途中で失敗して状態が分からない</summary>
        Unknown,
        Sleep,
        Isdbt,
    }

    private readonly Lock _busLock;
    private readonly CxdLink _link;
    private readonly Cxd2856 _demod;
    private readonly Cxd2858 _tuner;
    private readonly Func<long> _nowMs;
    private readonly Action<int> _sleep;
    private State _state = State.Unknown;
    private uint _khz;

    /// <summary>初期化のあと、起動か選局し直しを書き始めた (途中で失敗して状態が分からなくなっても、使い終えたときにスリープの書き込みを送る)</summary>
    private bool _started;

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
        _started = false;
    }

    /// <summary>
    /// 地上波 (ISDB-T 6 MHz) を選局し、ロックを待つ (仕様書 5.4)。<paramref name="khz"/> は中心周波数の kHz (仕様書 5.1)。
    /// ロックしなければ false (例外にしない。スキャンで続くため)。I2C の失敗は <see cref="IOException"/>
    /// </summary>
    public bool TuneIsdbt(uint khz)
    {
        // 何も書かずに断る (チューナーに渡せるのは 20 ビットまで。仕様書 4.1)
        if (khz > Cxd2858.MaxTerrestrialKhz) throw new IOException($"地上波の周波数は {Cxd2858.MaxTerrestrialKhz} kHz までです ({khz} kHz)");
        if (_state == State.Unknown) Init();
        try
        {
            lock (_busLock)
            {
                _started = true;
                if (_state == State.Isdbt) _demod.RetuneIsdbt();
                else _demod.StartIsdbt();
                _state = State.Isdbt;
                Relay(() => _tuner.TuneTerrestrial(khz));
                _khz = khz;
                _demod.Finish();
            }
        }
        catch (IOException)
        {
            // 途中で失敗したら、どこまで書いたかが分からない。次はスリープの状態から作り直すため、初期化からやり直す (仕様書に無い)
            _state = State.Unknown;
            throw;
        }
        return WaitLock();
    }

    /// <summary>
    /// ロックを待つ (仕様書 5.6)。10 ms ごとに読み、TS のロック (bit0) でロック、信号が無いと分かれば (bit4) すぐ失敗、1.5 秒で時間切れ。
    /// 確かめ始めてから 350 ms より早くロックしたら、350 ms になるまで待ってから返す
    /// </summary>
    private bool WaitLock()
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
    /// 受信の状態と C/N と強度。ISDB-T で動作中のときだけ読む (仕様書 8)。動作中でなければ null。
    /// C/N は <c>10 × log10(r / 8)</c> dB (仕様書 8.1。復調がロックしていないか r が 0 なら null)、強度はチューナーの AGC から求めた dBm (仕様書 8.6)
    /// </summary>
    public TunerSignal? Signal()
    {
        if (_state != State.Isdbt) return null;
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

    /// <summary>
    /// 使い終えたときに、チューナーを止めて復調器をスリープにする (仕様書 10.3 の手順 1〜3。順は「チューナーを止める → 復調器をスリープ」。仕様書 2.4)。
    /// 動作中でなければ何もしない。選局の途中で失敗して状態が分からないときも、起動を書き始めていればスリープの書き込みを送る。
    /// そのときは、次の選局を初期化からやり直す (仕様書に無い)
    /// </summary>
    public void Sleep()
    {
        if (_state != State.Isdbt && !(_state == State.Unknown && _started)) return;
        try
        {
            lock (_busLock)
            {
                Relay(_tuner.Stop);
                _demod.SleepIsdbt();
            }
            _started = false;
            if (_state == State.Isdbt) _state = State.Sleep;
        }
        catch (IOException)
        {
            _state = State.Unknown;
            throw;
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
