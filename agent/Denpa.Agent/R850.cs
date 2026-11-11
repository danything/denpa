namespace Denpa.Agent;

/*
 * RafaelMicro R850 (地上波チューナー) と、R850・RT710 で同じ PLL の計算。
 *
 * クリーンルームで、仕様書 (denpa-spec の tc90522/spec.md。TC90522・R850・RT710 の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は tc90522/spec.md の節の番号 (ブリッジの側の it930x/spec.md は「IT930x の仕様書 x.y」と書く) で、表の値は仕様書の付録 A のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」、仕様書の文から読み取って決めた所は「推定」と書いてある。**実機では確かめていない。**
 */

/// <summary>
/// チューナーへの通信 (復調器の中継を通す。仕様書 2.2)。R850 と RT710 は読むレジスタを選べず、いつも <c>00</c> から読む (仕様書 6.1・7.1)
/// </summary>
internal interface ITunerPort
{
    /// <summary>「レジスタの番号 + データ」を 1 回で書く</summary>
    void Write(ReadOnlySpan<byte> data);

    /// <summary><c>00</c> から <paramref name="length"/> バイトを読み、1 バイトごとにビットの並びを直して返す (仕様書 6.1)</summary>
    byte[] Read(int length);
}

/// <summary>R850 の 1 回の選局で書く値 (仕様書 6.5)</summary>
/// <param name="Registers"><c>08</c>〜<c>2F</c> に書く 40 バイト (仕様書 6.5 (5) の手順 1)</param>
/// <param name="Final">待ったあと <c>2F</c> に書く値 (手順 3)</param>
/// <param name="WaitMs">40 バイトを書いたあとの待ち (手順 2)</param>
/// <param name="Divider">VCO の分周 M (仕様書 6.5 (4) の手順 6)</param>
/// <param name="N">PLL の整数の部分 (丸めたあと)</param>
/// <param name="Fraction">PLL の小数の部分 S (16 ビット)</param>
internal sealed record R850Plan(byte[] Registers, byte Final, int WaitMs, int Divider, int N, int Fraction);

/// <summary>R850 と RT710 で同じ PLL の計算 (仕様書 6.5 (4) の手順 12〜15、7.3 (2))</summary>
internal static class RafaelPll
{
    /// <summary>
    /// VCO の周波数と水晶 (分周したあと) から、整数の部分 N と小数の部分 S (16 ビット) を求める。割り算はどれも整数の割り算 (仕様書 6.5 (4))
    /// </summary>
    public static (int N, int Fraction, bool Integer) Divide(long vco, int xtal)
    {
        var n = (int)(vco / 2 / xtal);
        var f = (int)(vco - 2L * xtal * n);
        // F を丸める (手順 13)。上から順に当てはめ、最初に当てはまったものだけ
        if (f < xtal / 64) f = 0;
        else if (f > xtal * 127 / 64)
        {
            f = 0;
            n++;
        }
        else if (f > xtal * 127 / 128 && f < xtal) f = xtal * 127 / 128;
        else if (f > xtal && f < xtal * 129 / 128) f = xtal * 129 / 128;
        var integer = f == 0;
        /*
         * 小数の部分 (手順 15)。n = 2 から 2 倍ずつ進め、F が 1 以下になるか、n = 0x8000 の回を終えたらやめる。
         * 仕様書の「そのとき n が 0x8000 なら終える」は、引いたかどうかによらず n = 0x8000 の回で終えると読んだ
         * (引いたときだけ終えると読むと、引かなかったときに終わらない。推定)。付録 C の S はこの読み方で合う
         */
        var fraction = 0;
        for (var step = 2; f > 1; step *= 2)
        {
            var t = 2 * xtal / step;
            if (t < f)
            {
                f -= t;
                fraction += 0x10000 / step;
            }
            if (step == 0x8000) break;
        }
        return (n, fraction, integer);
    }
}

/// <summary>
/// R850 (地上波チューナー) 1 つ。初期化 (仕様書 6.3)、周波数の設定 (6.5)、PLL のロック (6.6)。
/// 方式は ISDB-T・6 MHz・IF 4063 kHz だけ (仕様書 6.2)。イメージ除去とフィルタの校正はせず、決まった値を使う (仕様書 6.2)。
/// 待機にはしない (仕様書 6.7)。**ロックは持たない** (呼ぶ側がバスのロックを持つ)
/// </summary>
internal sealed class R850(ITunerPort port, bool loopthrough, Action<int> sleep)
{
    /// <summary>I2C のアドレス (7 ビット。仕様書 6.1)</summary>
    public const byte Address = 0x7C;

    /// <summary>受け付ける RF の範囲 (kHz。仕様書 4.1・6.5)</summary>
    public const uint MinKhz = 40000;

    public const uint MaxKhz = 1002000;

    /// <summary>IF (kHz。仕様書 6.2)。LO は RF より低い側 (仕様書 6.4)</summary>
    public const int IfKhz = 4063;

    /// <summary>レジスタの数 (<c>00</c>〜<c>2F</c>。仕様書 6.1)</summary>
    public const int Registers = 48;

    /// <summary>書くレジスタの先頭 (<c>08</c>〜<c>2F</c> の 40 個を書く。仕様書 6.1)</summary>
    public const int FirstWritable = 0x08;

    /// <summary>初期値 (仕様書 付録 A.1)。<c>00</c>〜<c>07</c> は読むだけのレジスタで、0 にしておく</summary>
    internal static readonly byte[] Initial =
    [
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xCA, 0xC0, 0x72, 0x50, 0x00, 0xE0, 0x00, 0x30,
        0x86, 0xBB, 0xF8, 0xB0, 0xD2, 0x81, 0xCD, 0x46,
        0x37, 0x40, 0x89, 0x8C, 0x55, 0x95, 0x07, 0x23,
        0x21, 0xF1, 0x4C, 0x5F, 0xC4, 0x20, 0xA9, 0x6C,
        0x53, 0xAB, 0x5B, 0x46, 0xB3, 0x93, 0x6E, 0x41,
    ];

    /// <summary>
    /// 周波数ごとの値 (仕様書 付録 A.2。ISDB-T・IF 4063 kHz)。行は RF の区切り (340000 以下、470000〜487999、680000〜691999、692000〜697999、それ以外)、
    /// 列は a1〜a15
    /// </summary>
    private static readonly byte[][] ByRf =
    [
        [5, 0x6B, 1, 5, 5, 0x4A, 5, 12, 2, 15, 4, 0, 1, 0, 2],
        [6, 0x8C, 1, 5, 5, 0x6B, 5, 3, 2, 14, 4, 3, 1, 1, 3],
        [5, 0x5A, 2, 7, 6, 0x6B, 4, 3, 2, 14, 5, 3, 0, 1, 3],
        [5, 0x5B, 2, 7, 6, 0x6B, 4, 10, 3, 12, 5, 3, 0, 1, 2],
        [5, 0x5A, 1, 5, 6, 0x6B, 5, 3, 2, 14, 4, 3, 1, 1, 3],
    ];

    /// <summary>チップの種類 (0 か 1。仕様書 6.3 の手順 1)。初期化するまでは 0</summary>
    public int Kind { get; private set; }

    /// <summary>種類を見分けるときに読んだ <c>00</c> の値 (ビットの並びを直したあと)。<c>--it930x-probe</c> と <c>--tune</c> が出す</summary>
    public byte Id { get; private set; }

    /// <summary>水晶の駆動の強さ (1〜3。仕様書 6.3)。初期化するまでは 3</summary>
    public int XtalDrive { get; private set; } = 3;

    /// <summary>初期化のときに読んで書き戻した <c>08</c>〜<c>2F</c> (仕様書 6.3 の手順 2・3)。<c>--it930x-probe</c> が出す</summary>
    public byte[]? Saved { get; private set; }

    /// <summary>最後の選局で書いた値。<c>--tune</c> が出す (付録 C.1 と比べるため。仕様書 12 の 6)</summary>
    public R850Plan? Written { get; private set; }

    /// <summary>
    /// 初期化 (電源を入れたあと 1 回。仕様書 6.3)。種類を見分け、<c>08</c>〜<c>2F</c> を読んで取っておき、水晶の駆動の強さを調べ、取っておいた値を書き戻す
    /// </summary>
    public void Init()
    {
        /*
         * 種類を見分ける (手順 1)。00 を読み、(値 & 0x98) が 0 でなければ種類 1。4 回読んでも当てはまらなければ種類 0。
         * 4 回目の読み出しが I2C の誤りなら失敗。値はビットの並びを直したあとのものを見る (仕様書 6.1 は読んだ値をいつも直すと書く。
         * 0x98 を当てるのが直す前か後かは、仕様書 6.3 の注記「ビットを入れ替えたあと」から後と読んだ。推定)
         */
        Kind = 0;
        IOException? failed = null;
        for (var i = 0; i < 4; i++)
        {
            try
            {
                Id = port.Read(1)[0];
                failed = null;
                if ((Id & 0x98) == 0) continue;
                Kind = 1;
                break;
            }
            catch (IOException error) when (error is not UsbGoneException)
            {
                failed = error;
            }
        }
        if (failed is not null) throw failed;
        // 08〜2F を読んで取っておく (手順 2)
        Saved = port.Read(Registers)[FirstWritable..];
        XtalDrive = MeasureXtalDrive();
        // 取っておいた 40 バイトを書き戻す (手順 4)。控えは選局のたびに初期値から作り直すので、ここでは持たない (手順 5)
        WriteAll(Saved);
    }

    /// <summary>水晶の駆動の強さを調べる (仕様書 6.3)。書き込みと読み出しの間に待ちは無い</summary>
    private int MeasureXtalDrive()
    {
        var trial = Initial[FirstWritable..];
        trial[0x1B - FirstWritable] = 0x92;
        trial[0x1D - FirstWritable] = 0x05;
        trial[0x1E - FirstWritable] = 0x08;
        trial[0x1F - FirstWritable] = 0x00;
        trial[0x21 - FirstWritable] = 0xF9;
        trial[0x22 - FirstWritable] = 0x84;
        trial[0x2F - FirstWritable] = (byte)(Kind == 0 ? 0x40 : 0x41);
        WriteAll(trial);
        // 22 に 4 つの値を順に書き、PLL がロックして (02 の bit6)、02 の下位 6 ビットが 61 以下になった最初の回を探す。
        // 強さは「その回の番号 + 1」で、3 を超えない。どの回も当てはまらなければ 3
        for (var i = 0; i < XtalTrials.Length; i++)
        {
            port.Write([0x22, XtalTrials[i]]);
            var status = Status();
            if ((status & 0x40) != 0 && (status & 0x3F) <= 61) return Math.Min(i + 1, 3);
        }
        return 3;
    }

    /// <summary>水晶の駆動の強さを調べるときに、<c>22</c> へ順に書く値 (仕様書 6.3)</summary>
    private static readonly byte[] XtalTrials = [0x84, 0x94, 0xA4, 0xB4];

    /// <summary><c>02</c> の値 (<c>00</c> から 3 バイト読んだ 3 つ目。bit6 が PLL のロック。仕様書 6.6)</summary>
    public byte Status() => port.Read(3)[2];

    private void WriteAll(ReadOnlySpan<byte> registers)
    {
        Span<byte> data = stackalloc byte[1 + registers.Length];
        data[0] = FirstWritable;
        registers.CopyTo(data[1..]);
        port.Write(data);
    }

    /// <summary>
    /// 周波数を設定する (仕様書 6.5)。<paramref name="khz"/> は RF の中心周波数。範囲の外は何も書かずに断る。
    /// 控えは選局のたびに初期値から作り直す (仕様書 6.5 の終わりが勧める形。前の選局の <c>2F</c> の bit3〜2 が残らない)
    /// </summary>
    public void SetFrequency(uint khz)
    {
        if (khz is < MinKhz or > MaxKhz) throw new IOException($"地上波の周波数は {MinKhz}〜{MaxKhz} kHz です ({khz} kHz)");
        var plan = Plan(khz, Kind, loopthrough, XtalDrive);
        WriteAll(plan.Registers);
        sleep(plan.WaitMs);
        port.Write([0x2F, plan.Final]);
        Written = plan;
    }

    /// <summary>PLL がロックしているか (仕様書 6.6)。<c>02</c> の bit6</summary>
    public bool PllLocked() => (Status() & 0x40) != 0;

    /// <summary><c>00</c>〜<c>2F</c> を読む (<c>--it930x-probe</c> が、書き戻せたかを確かめる)</summary>
    public byte[] ReadAll() => port.Read(Registers);

    /// <summary>控えのレジスタ <paramref name="register"/> の bit <paramref name="high"/>〜<paramref name="low"/> を <paramref name="bits"/> にする</summary>
    private static void Set(byte[] shadow, int register, int high, int low, int bits)
    {
        var mask = ((1 << (high - low + 1)) - 1) << low;
        shadow[register] = (byte)((shadow[register] & ~mask) | ((bits << low) & mask));
    }

    /// <summary>LO の区切りの表から値を選ぶ (仕様書 付録 A.3)。小さい側から見て、最初に当てはまった区切りの値。どれにも当てはまらなければ <paramref name="rest"/></summary>
    private static int ByLo(int lo, ReadOnlySpan<(int Below, int Value)> steps, int rest)
    {
        foreach (var (below, value) in steps)
        {
            if (lo < below) return value;
        }
        return rest;
    }

    /// <summary>
    /// 1 回の選局で書く値を計算する (仕様書 6.5 の (1)〜(5))。チップには触らない。付録 C.1 の計算例と照合できる
    /// </summary>
    /// <param name="rf">RF の中心周波数 (kHz)</param>
    /// <param name="kind">チップの種類 (0 か 1)</param>
    /// <param name="loopthrough">ループスルーが有りか (受信機 2 は有り、受信機 3 は無し。仕様書 1.2)</param>
    /// <param name="xtalDrive">水晶の駆動の強さ (1〜3。仕様書 6.3)</param>
    internal static R850Plan Plan(uint rf, int kind, bool loopthrough, int xtalDrive)
    {
        var s = (byte[])Initial.Clone();

        // (1) 方式 (ISDB-T・6 MHz・IF 4063) の値
        s[0x17] = 0x65;
        Set(s, 0x18, 7, 4, kind == 0 ? 0x8 : 0xA);
        Set(s, 0x18, 3, 2, 1);
        Set(s, 0x12, 6, 6, 0);
        Set(s, 0x2F, 3, 2, kind == 0 ? 0 : 1);
        if (kind == 1) Set(s, 0x2C, 0, 0, 1);
        Set(s, 0x2E, 4, 4, kind == 0 ? 0 : 1);

        // (2) 周波数ごとの値 (付録 A.2)
        var row = ByRf[rf <= 340000 ? 0 : rf is >= 470000 and <= 487999 ? 1 : rf is >= 680000 and <= 691999 ? 2 : rf is >= 692000 and <= 697999 ? 3 : 4];
        Set(s, 0x26, 2, 0, 7 - row[0]);
        s[0x27] = row[1];
        Set(s, 0x2D, 1, 0, 3);
        Set(s, 0x1F, 0, 0, row[2] == 1 ? 1 : 0);
        Set(s, 0x20, 5, 5, row[2] == 1 ? 1 : 0);
        Set(s, 0x2C, 7, 4, row[3]);
        Set(s, 0x26, 6, 4, 7 - row[4]);
        s[0x2A] = row[5];
        Set(s, 0x2D, 7, 4, row[6]);
        Set(s, 0x28, 7, 4, 15 - row[7]);
        Set(s, 0x1A, 7, 6, row[8]);
        Set(s, 0x28, 3, 0, 15 - row[9]);
        Set(s, 0x2B, 3, 0, row[10]);
        Set(s, 0x18, 1, 0, row[11]);
        Set(s, 0x0A, 6, 6, row[12]);
        Set(s, 0x19, 1, 1, row[13]);
        Set(s, 0x2E, 3, 2, row[14]);
        // どの行でも同じ値
        Set(s, 0x0B, 7, 7, 0);
        Set(s, 0x1F, 1, 1, 1);
        Set(s, 0x0D, 5, 5, 1);
        Set(s, 0x0D, 2, 1, 2);
        Set(s, 0x11, 4, 4, 1);
        Set(s, 0x1A, 3, 2, 0);
        s[0x29] = 0x99;
        Set(s, 0x2B, 7, 4, 4);
        Set(s, 0x13, 2, 0, 7);
        Set(s, 0x16, 7, 6, 3);
        Set(s, 0x2E, 7, 7, 0);
        Set(s, 0x25, 7, 6, 0);
        Set(s, 0x25, 2, 2, 0);
        if (kind == 0) Set(s, 0x2C, 3, 0, 3);
        else Set(s, 0x2C, 3, 1, 1);
        Set(s, 0x0A, 4, 4, 1);
        Set(s, 0x19, 6, 6, 1);
        Set(s, 0x15, 4, 4, 1);
        // あわせて行うこと
        Set(s, 0x13, 4, 4, 1);
        Set(s, 0x10, 6, 5, 0);
        Set(s, 0x12, 2, 2, 0);
        Set(s, 0x19, 5, 5, 0);
        if (rf is >= 478000 and <= 481999) Set(s, 0x2F, 3, 2, 0);
        Set(s, 0x08, 7, 6, loopthrough ? 3 : 1);
        Set(s, 0x0A, 1, 1, loopthrough ? 1 : 0);
        Set(s, 0x22, 2, 2, 1);

        // (3) LO で決まる値 (付録 A.3)
        var lo = (int)rf - IfKhz;
        Set(s, 0x0E, 3, 2, lo < 330000 ? 2 : 0);
        Set(s, 0x0E, 7, 4, ByLo(lo, [(73000, 8), (81000, 8), (89000, 8), (121000, 6), (145000, 4), (153000, 3), (177000, 2), (201000, 1)], 0));
        Set(s, 0x0F, 3, 0, ByLo(lo, [(73000, 10), (81000, 4), (89000, 3), (121000, 1)], 0));
        Set(s, 0x10, 4, 3, ByLo(lo, [(480000, 3), (550000, 2), (700000, 1)], 0));
        Set(s, 0x10, 2, 0, ByLo(lo, [(580000, 7), (660000, 1), (780000, 6), (900000, 4)], 0));
        Set(s, 0x12, 1, 0, ByLo(lo, [(133000, 2), (221000, 1), (760000, 0)], 3));
        s[0x14] = (byte)((s[0x14] & 0xD0) | 0x02);
        s[0x15] = (byte)(s[0x15] & 0x10);

        // (4) PLL。先に値を計算し、控えにはレジスタの番号の順に入れる
        // 水晶の駆動の強さ (手順 2)。使うのは LO が 130000 kHz より低い選局だけ
        var drive = lo < 100000 ? xtalDrive >= 2 ? 3 - xtalDrive : 2
            : lo < 130000 ? xtalDrive == 3 ? 0 : 1
            : 0;
        var j = (int)(rf / 1000 / 12);
        // VCO の範囲 (手順 6)
        long minimum = kind == 0 ? 2270000 : 2200000;
        var divider = 2;
        var shift = 0;
        while (((long)lo * divider < minimum || (long)lo * divider >= 2 * minimum) && shift < 6)
        {
            divider *= 2;
            shift++;
        }
        // 水晶の分周 (手順 7)。2 で割るか、4 で割るか、割らないか
        var xtal = lo < 380500 && j % 2 == 0 ? 12000
            : lo >= 380500 && rf is >= 478000 and < 482000 ? 6000
            : 24000;
        var (n, fraction, _) = RafaelPll.Divide((long)lo * divider, xtal);
        // N − 13 を 4 で割った商と余り (手順 14)
        var (quotient, remainder) = Math.DivRem(n - 13, 4);

        Set(s, 0x09, 2, 1, 0);
        s[0x0B] = (byte)((s[0x0B] & 0xC2) | 0x10);
        s[0x0C] = (byte)(s[0x0C] & 0x3C);
        Set(s, 0x11, 7, 7, divider == 8 ? 1 : 0);
        s[0x1B] = (byte)((s[0x1B] & 0x80) | (quotient & 0x7F));
        s[0x1C] = (byte)fraction;
        s[0x1D] = (byte)(fraction >> 8);
        Set(s, 0x1E, 7, 5, 0);
        Set(s, 0x1E, 4, 2, shift);
        Set(s, 0x1E, 1, 0, remainder);
        // 20 は bit5・bit3・bit2 だけを残し、VCO を 8 以上で割るときに bit0 を 1 にする (手順 1・9・14)
        s[0x20] = (byte)((s[0x20] & 0x2C) | (divider >= 8 ? 0x01 : 0x00));
        s[0x21] = (byte)((s[0x21] & 0x07) | 0xF0);
        Set(s, 0x22, 7, 6, 0);
        Set(s, 0x22, 5, 4, drive);
        Set(s, 0x22, 3, 3, 1);
        Set(s, 0x22, 1, 0, xtal == 12000 ? 2 : xtal == 6000 ? 3 : 0);
        s[0x25] = (byte)((s[0x25] & 0xEF) | 0x20);
        Set(s, 0x25, 1, 1, j is 4 or 10 or 22 or 24 or 28 ? 1 : 0);
        Set(s, 0x2D, 3, 2, divider == 8 ? 1 : divider == 16 ? 2 : divider >= 32 ? 3 : 0);
        Set(s, 0x2E, 6, 6, 1);
        Set(s, 0x2E, 1, 0, divider is 2 or 4 ? 1 : 2);
        Set(s, 0x2F, 1, 1, 0);
        if (kind == 0) Set(s, 0x2F, 0, 0, 0);

        // (5) 書く値。40 バイトのあと、水晶の分周に合わせて待ち、2F の bit1 を 1 にして書く
        var registers = s[FirstWritable..];
        Set(s, 0x2F, 1, 1, 1);
        if (kind == 0) Set(s, 0x2F, 0, 0, 0);
        return new R850Plan(registers, s[0x2F], xtal == 24000 ? 10 : xtal == 12000 ? 20 : 40, divider, n, fraction);
    }
}
