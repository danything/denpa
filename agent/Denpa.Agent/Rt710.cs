namespace Denpa.Agent;

/*
 * RafaelMicro RT710・RT720 (衛星チューナー)。
 *
 * クリーンルームで、仕様書 (denpa-spec の px4/spec.md) だけから書いた。参考にした実装のソースは見ていない。
 * コメントの「仕様書 x.y」は px4/spec.md の節の番号で、表の値は仕様書の 8 と付録 B のまま持つ。**実機では確かめていない。**
 */

/// <summary>
/// RT710 か RT720 (衛星チューナー) 1 つ。種類の見分け (仕様書 8.2)、周波数の設定 (8.3)、PLL のロック (8.4)、待機 (8.5)。
/// シンボルレート 28860 ksps・ロールオフ 0.35 だけ (仕様書 6.1)。選局のたびに 16 個のレジスタを全部書くので、待機からの復帰の手順は無い。
/// **ロックは持たない** (呼ぶ側がバスのロックを持つ)
/// </summary>
internal sealed class Rt710(ITunerPort port, Action<int> sleep)
{
    /// <summary>I2C のアドレス (7 ビット。仕様書 8.1)</summary>
    public const byte Address = 0x7A;

    /// <summary>レジスタの数 (<c>00</c>〜<c>0F</c>。仕様書 8.1)</summary>
    public const int Registers = 16;

    /// <summary>
    /// 選局の最初に <c>00</c>〜<c>0F</c> へ書く値 (仕様書 8.3 (1)。付録 B.1 の初期値に、基板の設定を入れたもの)。
    /// 基板の設定はループスルー無し・クロックの出力無し・差動出力・AGC は正の向き・VGA の減衰無し・細かい利得は 3 dB (付録 B.2)
    /// </summary>
    internal static readonly byte[] StartRt710 = [0x40, 0x1D, 0x20, 0x10, 0x41, 0x50, 0xED, 0x25, 0x07, 0x58, 0x39, 0x64, 0x38, 0xF7, 0x90, 0x35];

    internal static readonly byte[] StartRt720 = [0x00, 0x1C, 0x00, 0x10, 0x41, 0x48, 0xDA, 0x4B, 0x07, 0x58, 0x38, 0x40, 0x37, 0xF7, 0x4C, 0x59];

    /// <summary>待機のときに <c>00</c>〜<c>0F</c> へ書く値 (仕様書 8.5)</summary>
    internal static readonly byte[] StandbyRt710 = [0xFF, 0x5C, 0x88, 0x30, 0x41, 0xC8, 0xED, 0x25, 0x47, 0xFC, 0x48, 0xA2, 0x08, 0x0F, 0xF3, 0x59];

    internal static readonly byte[] StandbyRt720 = [0xFF, 0x5E, 0x88, 0x30, 0x41, 0xC8, 0xED, 0x25, 0x47, 0xFC, 0x48, 0xA2, 0x08, 0x0F, 0xF3, 0x59];

    /// <summary>帯域の値 (仕様書 8.3 (4)。シンボルレート 28860 とロールオフ 0.35 から計算した結果で、RT710・RT720 のどちらも同じ)</summary>
    internal const byte Bandwidth = 0x45;

    /// <summary>利得の表 (仕様書 付録 B.4。RT710 の 19 個)</summary>
    private static readonly int[] Gains = [0, 26, 42, 74, 103, 129, 158, 181, 188, 200, 220, 248, 280, 312, 341, 352, 366, 389, 409];

    /// <summary>
    /// <c>01</c> から作った 5 ビットの値 (0〜31) から、利得の表の番号 (仕様書 9.4 の手順 2)。
    /// 2 以下は 0、3〜9 は 1〜7、10〜12 は 7、13〜22 は 8〜17、それより大きければ 18
    /// </summary>
    private static readonly byte[] GainIndex =
    [
        0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 8, 9, 10,
        11, 12, 13, 14, 15, 16, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18,
    ];

    /// <summary>RT720 か (仕様書 8.2)。初期化するまでは false (RT710)</summary>
    public bool Rt720 { get; private set; }

    /// <summary>種類を見分けるときに読んだ <c>03</c> の値 (ビットの並びを直したあと)。<c>--it930x-probe</c> と <c>--tune</c> が出す</summary>
    public byte Id { get; private set; }

    public string Name => Rt720 ? "RT720" : "RT710";

    /// <summary>初期化 (電源を入れたあと 1 回。仕様書 8.2)。<c>03</c> を読み、上位 4 ビットが 7 なら RT710、それ以外は RT720。チップへは何も書かない</summary>
    public void Init()
    {
        Id = port.Read(4)[3];
        Rt720 = (Id & 0xF0) != 0x70;
    }

    /// <summary>1 回の選局の書き込み (レジスタと値の並び。待ちは <see cref="Wait"/>)。チップには触らない。付録 C.2 の計算例と照合できる</summary>
    internal static List<(byte Register, byte[] Values)> Plan(uint khz, bool rt720)
    {
        var writes = new List<(byte, byte[])>();
        var r = (byte[])(rt720 ? StartRt720 : StartRt710).Clone();
        void Write(int register) => writes.Add(((byte)register, [r[register]]));
        void Bit(int register, int bit, bool on) => r[register] = (byte)(on ? r[register] | (1 << bit) : r[register] & ~(1 << bit));

        // (1) 16 バイトを書く
        writes.Add((0x00, (byte[])r.Clone()));

        // (2) PLL。水晶は 24000 kHz
        const int xtal = 24000;
        var divider = 2;
        while (((long)khz * divider < 2350000 || (long)khz * divider > 4700000) && divider < 16) divider *= 2;
        var vco = (long)khz * divider;
        var k = divider switch { 2 => 1, 4 => 0, 8 => 2, _ => 3 };
        Bit(0x04, 0, (k & 1) != 0);
        Write(0x04);
        if (rt720)
        {
            Bit(0x08, 4, (k & 2) != 0);
            Write(0x08);
            r[0x04] = (byte)((r[0x04] & 0x3F) | (k <= 1 ? 0x40 : 0x80));
            Bit(0x0C, 4, k <= 1);
            Write(0x04);
            Write(0x0C);
        }
        var (n, fraction, integer) = RafaelPll.Divide(vco, xtal);
        // N − 13 を 4 で割った商と余り (手順 6)
        var (quotient, remainder) = Math.DivRem(n - 13, 4);
        r[0x05] = (byte)((quotient & 0x3F) | (remainder << 6));
        Write(0x05);
        if (integer) Bit(0x04, 1, true);
        Write(0x04);
        r[0x07] = (byte)(fraction >> 8);
        Write(0x07);
        r[0x06] = (byte)fraction;
        Write(0x06);
        writes.Add((Wait, []));

        // (3) 周波数で変える値
        if (!rt720)
        {
            var middle = khz is >= 1600000 and < 1950000;
            Bit(0x02, 6, middle);
            Bit(0x08, 7, middle);
            if (khz >= 1950000) r[0x0A] = 0x38;
            Write(0x0A);
            Write(0x02);
            Write(0x08);
            r[0x0E] = (byte)((r[0x0E] & 0xF3) | (khz >= 2000000 ? 0x08 : 0x00));
            Write(0x0E);
        }
        else
        {
            r[0x0B] = (byte)(r[0x0B] & 0xFC);
            Write(0x0B);
        }

        // (4) 帯域
        writes.Add((0x0F, [Bandwidth]));
        return writes;
    }

    /// <summary><see cref="Plan"/> の並びの中で、10 ms の待ち (仕様書 8.3 (2) の手順 10) を表す印。レジスタの番号には無い値</summary>
    internal const byte Wait = 0xFF;

    /// <summary>周波数を設定する (仕様書 8.3)。<paramref name="khz"/> は LNB で変換したあとの周波数 (IF。仕様書 6.1)</summary>
    public void SetFrequency(uint khz)
    {
        Span<byte> buffer = stackalloc byte[1 + Registers];
        var plan = Plan(khz, Rt720);
        Written = [.. plan.Where(write => write.Register != Wait)];
        foreach (var (register, values) in plan)
        {
            if (register == Wait)
            {
                sleep(10);
                continue;
            }
            var data = buffer[..(1 + values.Length)];
            data[0] = register;
            values.CopyTo(data[1..]);
            port.Write(data);
        }
    }

    /// <summary>PLL がロックしているか (仕様書 8.4)。<c>02</c> の bit7 (R850 は bit6)</summary>
    public bool PllLocked() => (Status() & 0x80) != 0;

    /// <summary><c>02</c> の値 (<c>00</c> から 3 バイト読んだ 3 つ目。bit7 が PLL のロック。仕様書 8.4)</summary>
    public byte Status() => port.Read(3)[2];

    /// <summary>最後の選局で書いた値 (レジスタと値の並び。待ちの印を除く)。<c>--tune</c> が出す</summary>
    public IReadOnlyList<(byte Register, byte[] Values)>? Written { get; private set; }

    /// <summary>待機にする (仕様書 8.5)。<c>00</c>〜<c>0F</c> を 1 回で書く</summary>
    public void Standby()
    {
        Span<byte> data = stackalloc byte[1 + Registers];
        data[0] = 0x00;
        (Rt720 ? StandbyRt720 : StandbyRt710).CopyTo(data[1..]);
        port.Write(data);
    }

    /// <summary>
    /// 入力のレベル (仕様書 9.4)。RT710 だけ (RT720 は利得の番号の決め方が仕様書に無い)。単位は仕様書に無く、0.001 dBm と推定されている。
    /// <c>--tune</c> の出力にだけ出す
    /// </summary>
    public int? Level(uint khz)
    {
        if (Rt720) return null;
        var value = port.Read(2)[1];
        return Level(value, khz);
    }

    /// <summary><c>01</c> の値 (ビットの並びを直したあと) と周波数から、入力のレベル (仕様書 9.4 の手順 1〜3)</summary>
    internal static int Level(byte value, uint khz)
    {
        var g = (value >> 4) | ((value & 1) << 4);
        var n = GainIndex[g];
        var floor = khz < 1200000 ? 190 : khz < 1800000 ? 170 : 140;
        return -100 * (floor + Gains[n]);
    }
}
