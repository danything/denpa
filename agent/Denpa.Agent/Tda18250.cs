namespace Denpa.Agent;

/*
 * NXP TDA18250BHN (チューナー。水晶 27 MHz、ループスルー出力をオン)。Xbox One Digital TV Tuner (XboxOne.cs) で ISDB-C を受けるところだけ。
 *
 * クリーンルームで、仕様書 (GPL のドライバから事実だけを抜き出した Xbox One Digital TV Tuner の仕様書) だけから書いた。Linux のドライバのコードは読んでいない。
 * レジスタの意味を説明する公開資料は無く、値は仕様書に載っている値をそのまま書く。6 MHz の帯域の値は、仕様書が「手直しのあと、Annex C で選局したときの値」として
 * 載せているもの (帯域の計算と選ぶ処理は持たない)。
 */

/// <summary>TDA18250 (仕様書「見つける」「初期化」「選局」「スリープ」のチューナーの所)</summary>
internal sealed class Tda18250(Dib0700 bridge, Action<int> sleep)
{
    public const byte Address = 0x60;

    /// <summary>6 MHz 用のときの IF (kHz)。機材の設定の 4,950 kHz ではなく、手直しの 3,950 kHz に固定する</summary>
    public const uint IfKhz = 3_950;

    /// <summary>割り込みのレジスタを読む間隔と回数 (10 ms おきに最大 500 ms)</summary>
    private const int PollMs = 10;
    private const int Polls = 50;

    /// <summary>初期化で書く 34 組 (意味は仕様書に無い)</summary>
    internal static readonly (byte Register, byte Value)[] InitRows =
    [
        (0x0C, 0xC7), (0x0D, 0x5D), (0x0E, 0x40), (0x0F, 0x0E), (0x10, 0x47), (0x11, 0x4E), (0x12, 0x26), (0x13, 0x60),
        (0x18, 0x37), (0x19, 0x09), (0x1A, 0x00), (0x1E, 0x29), (0x1F, 0x06), (0x20, 0xC6), (0x21, 0x00), (0x2C, 0x75),
        (0x2D, 0x06), (0x2E, 0x07), (0x30, 0x0E), (0x31, 0x00), (0x39, 0x00), (0x3B, 0x55), (0x3C, 0xA7), (0x3F, 0x85),
        (0x40, 0x87), (0x41, 0xC0), (0x43, 0x40), (0x44, 0xC0), (0x46, 0x0C), (0x47, 0x64), (0x4B, 0x30), (0x59, 0x05),
        (0x5B, 0x07), (0x5C, 0x00),
    ];

    /// <summary>水晶 27 MHz の値 (0x4D〜0x51 に続けて書く)</summary>
    internal static readonly byte[] CrystalRow = [0x69, 0x78, 0x8D, 0x80, 0x1B];

    /// <summary>選局の最初に「ビットを書く」16 個 (レジスタ, マスク, 値)。仕様書の表の左の列を上から、続けて右の列を上から</summary>
    internal static readonly (byte Register, byte Mask, byte Value)[] BandRows =
    [
        (0x22, 0x77, 0x51), (0x23, 0xFF, 0x03), (0x24, 0xFF, 0x83), (0x21, 0x87, 0x82),
        (0x0D, 0xF0, 0x50), (0x0C, 0x78, 0x00), (0x0F, 0x07, 0x06), (0x14, 0xE0, 0x60),
        (0x0E, 0x60, 0x40), (0x12, 0x0F, 0x0E), (0x58, 0x60, 0x60), (0x59, 0x0F, 0x05),
        (0x1A, 0x33, 0x33), (0x19, 0x30, 0x10), (0x1E, 0x80, 0x00), (0x30, 0x06, 0x04),
    ];

    /// <summary>キャリブレーションを済ませたか (済んでいれば、2 回目からの初期化で飛ばす)</summary>
    private bool _calibrated;

    /// <summary>最後に書いた IF (kHz)。前と同じなら書かない。スリープで忘れる</summary>
    private uint? _if;

    private void Write(byte register, byte value) => bridge.I2cWrite(Address, [register, value]);

    private byte Read(byte register) => bridge.I2cRead(Address, register);

    /// <summary>ビットを書く: 読んでから、マスクの所だけ値を差し替えて書く (値が変わらなくても書く)</summary>
    private void Update(byte register, byte mask, byte value)
    {
        var old = Read(register);
        Write(register, (byte)((old & ~mask) | (value & mask)));
    }

    /// <summary>0x08 の <paramref name="mask"/> のビットが全部立つまで待つ。立たなければ例外を送出する</summary>
    private void WaitIrq(byte mask, string what)
    {
        for (var i = 0; i < Polls; i++)
        {
            if ((Read(0x08) & mask) == mask) return;
            sleep(PollMs);
        }
        throw new IOException($"チューナーの{what}が {Polls * PollMs} ms で終わりませんでした");
    }

    /// <summary>TDA18250 か確かめ (0x00〜0x02)、スタンバイにする</summary>
    public void Identify()
    {
        Span<byte> id = stackalloc byte[3];
        bridge.I2cRead(Address, 0x00, id);
        if (id[0] is not (0xC7 or 0x47) || id[1] != 0x4A || id[2] is not (0x20 or 0x21))
        {
            throw new IOException($"チューナーが TDA18250 ではありません (0x00〜0x02 が {Convert.ToHexString(id)})");
        }
        Standby();
    }

    /// <summary>スタンバイ (ループスルーがオンのとき)</summary>
    private void Standby()
    {
        Update(0x25, 0xC0, 0x80);
        Update(0x06, 0x07, 0x02);
        Update(0x10, 0x80, 0x00);
    }

    /// <summary>電源を入れて初期化する。キャリブレーションは最初の 1 回だけ</summary>
    public void Init()
    {
        Update(0x06, 0x07, 0x00);
        Update(0x25, 0xC0, 0xC0);
        sleep(20);
        if (!_calibrated)
        {
            foreach (var (register, value) in InitRows) Write(register, value);
            bridge.I2cWrite(Address, [0x4D, .. CrystalRow]);
            Update(0x10, 0x80, 0x00); // ループスルー出力をオン
            Write(0x0A, 0x82);
            Write(0x2A, 0x70);
            Write(0x2B, 0x01);
            WaitIrq(0x82, "ハードウェアの初期化");
            Write(0x2A, 0x02);
            Write(0x2B, 0x01);
            WaitIrq(0x81, "キャリブレーション");
            _calibrated = true;
        }
        Update(0x0C, 0x80, 0x00); // 元のドライバは LNA の電源を入れると書いている
    }

    /// <summary>
    /// AGC に書く (レジスタ, マスク, 値)。**仕様書が勧める「8 MHz 用」の側の値。** 帯域が 6,000,000 Hz ちょうどにならないので元のドライバが選ぶ側で、
    /// 実機で受けられたと報告されている値。もう一方の 6 MHz 用の値は試した記録が無いので持たない
    /// </summary>
    internal static (byte Register, byte Mask, byte Value)[] AgcRows(uint hertz) =>
    [
        (0x1F, 0x87, 0x06),
        (0x5A, 0xFF, 0x00),
        (0x0C, 0x07, (byte)(hertz < 100_000_000 ? 2 : 3)),
        (0x58, 0x1F, (byte)(hertz < 320_000_000 ? 26 : 28)),
        (0x13, 0x1F, (byte)(hertz < 320_000_000 ? 16 : 18)),
        (0x14, 0x1F, (byte)(hertz < 320_000_000 ? 18 : 20)),
        (0x16, 0xF8, 90),
        (0x12, 0x60, (byte)(hertz > 800_000_000 ? 0x40 : 0x20)),
        (0x17, 0xFF, 0x7C),
        (0x20, 0x06, (byte)(hertz is > 320_000_000 and < 600_000_000 ? 0x02 : 0x04)),
        (0x16, 0x03, (byte)(hertz < 600_000_000 ? 0 : 3)),
        (0x0F, 0x3F, 0x0C),
    ];

    /// <summary>IF (kHz) を 0x26 に書く値 (50 kHz 単位に四捨五入)</summary>
    internal static byte IfRegister(uint khz) => (byte)((khz + 25) / 50);

    /// <summary>
    /// PLL の分周 (r, n) と電流の値 c。<paramref name="status"/> は 0x34 の読み値 (ビット 4〜6 が e、0〜3 が s)。
    /// e が 1〜5 なら p = 2^(e−1)、0 か 6 以上なら p = 1。fvco = p × s × (周波数 kHz + IF kHz)。表は水晶 27 MHz のもの
    /// </summary>
    internal static (int R, int N, int C) Divider(byte status, uint khz)
    {
        var e = (status >> 4) & 0x07;
        var s = status & 0x0F;
        var p = e is >= 1 and <= 5 ? 1 << (e - 1) : 1;
        var fvco = (ulong)p * (ulong)s * (khz + IfKhz);
        return fvco < 6_643_000 ? (2, 0, 5) : fvco < 6_811_000 ? (2, 0, 6) : (3, 1, 2);
    }

    /// <summary>選局する (仕様書「選局」のチューナーの 1.〜12.)。<paramref name="hertz"/> は選局表の中心周波数</summary>
    public void Tune(uint hertz)
    {
        if (hertz is < 42_000_000 or > 870_000_000) throw new IOException($"{hertz / 1e6:0.###} MHz はチューナーが受けられる 42〜870 MHz の外です");
        var khz = ChannelTable.Khz(hertz);
        foreach (var (register, mask, value) in BandRows) Update(register, mask, value);
        if (_if != IfKhz)
        {
            Write(0x26, IfRegister(IfKhz));
            _if = IfKhz;
        }
        foreach (var (register, mask, value) in AgcRows(hertz))
        {
            if (mask == 0xFF) Write(register, value);
            else Update(register, mask, value);
        }
        Update(0x1A, 0x03, 0x01);
        Update(0x14, 0x40, 0x00);
        bridge.I2cWrite(Address, [0x27, (byte)(khz >> 16), (byte)(khz >> 8), (byte)khz]);
        Write(0x0A, 0x88);
        Write(0x2A, 0x01);
        Write(0x2B, 0x01);
        WaitIrq(0x88, "選局");
        var (r, n, c) = Divider(Read(0x34), khz);
        Update(0x4F, 0xE0, (byte)((r << 6) | (n << 5)));
        Write(0x0A, 0x88);
        Update(0x46, 0x07, 0x00);
        Update(0x39, 0x03, 0x00);
        Write(0x2A, 0x01);
        Write(0x2B, 0x01);
        WaitIrq(0x88, "選局");
        sleep(20);
        Update(0x2B, 0x04, 0x04); // 元のドライバは PLL のロックと書いている
        sleep(20);
        Update(0x1A, 0x03, 0x03);
        Update(0x14, 0x40, 0x40);
        Update(0x46, 0x07, (byte)c);
    }

    /// <summary>
    /// スリープ: 0x0C のビット 7 を 0 にし、覚えている IF を忘れて、スタンバイにする。
    /// 0x0C のビット 7 は初期化の最後 (LNA の電源を入れる所) と同じく 0 を書く。仕様書のとおりで、スリープで 0 にする意味は仕様書に無い
    /// </summary>
    public void Sleep()
    {
        Update(0x0C, 0x80, 0x00);
        _if = null;
        Standby();
    }
}
