namespace Denpa.Agent;

/*
 * Panasonic MN88472 (復調。水晶 20.5 MHz)。Xbox One Digital TV Tuner (XboxOne.cs) で ISDB-C (J.83 Annex C) を受けるところだけ。DVB-T/T2 は書いていない。
 *
 * クリーンルームで、仕様書 (GPL のドライバから事実だけを抜き出した Xbox One Digital TV Tuner の仕様書) だけから書いた。Linux のドライバのコードは読んでいない。
 * レジスタの意味を説明する公開資料は無く、値は仕様書に載っている値をそのまま書く。I2C のゲートは無く、ブリッジから直に読み書きする。
 */

/// <summary>MN88472 (仕様書「見つける」「初期化」「選局」「ロックと信号」「スリープ」の復調の所)</summary>
internal sealed class Mn88472(Dib0700 bridge)
{
    /// <summary>レジスタのバンク 0・1・2 の I2C の 7 ビットアドレス。バンク 2 は 1 回に 1 つのレジスタしか読み書きできない</summary>
    public const byte Bank0 = 0x18;
    public const byte Bank1 = 0x1A;
    public const byte Bank2 = 0x1C;

    /// <summary>ファームウェアのファイル名と大きさ (仕様書「初期化」)</summary>
    public const string FirmwareName = "dvb-demod-mn88472-02.fw";
    public const int FirmwareSize = 2_012;

    /// <summary>
    /// ファームウェアの SHA-256 の先頭と末尾 (仕様書には全体が載っていない)。違うファイルは送らない
    /// </summary>
    public const string FirmwareShaHead = "7be4b830";
    public const string FirmwareShaTail = "2e9c6196";

    /// <summary>ファームウェアを 1 回の I2C 書き込みで送る長さ</summary>
    private const int FirmwareChunk = 21;

    private const double Crystal = 20_500_000;

    private void Write(byte bank, byte register, byte value) => bridge.I2cWrite(bank, [register, value]);

    private byte Read(byte bank, byte register) => bridge.I2cRead(bank, register);

    /// <summary>MN88472 か確かめ (バンク 2 の 0xFF が 0x02)、スリープにする (電源を入れると動いている)</summary>
    public void Identify()
    {
        var id = Read(Bank2, 0xFF);
        if (id != 0x02) throw new IOException($"復調が MN88472 ではありません (バンク 2 の 0xFF が 0x{id:X2}。0x02 のはず)");
        Write(Bank2, 0x05, 0x3E);
    }

    /// <summary>
    /// 電源を入れ、ファームウェアが動いていなければ送り、TS をパラレル・固定クロックで出す設定にする。
    /// <paramref name="firmware"/> はファームウェアが要るときだけ呼ぶ (動いていれば、ファイルが無くても使える)
    /// </summary>
    /// <returns>ファームウェアを送ったか</returns>
    public bool Init(Func<byte[]> firmware)
    {
        foreach (var register in new byte[] { 0x05, 0x0B, 0x0C }) Write(Bank2, register, 0x00);
        var sent = false;
        if ((Read(Bank0, 0xF5) & 0x01) != 0)
        {
            var code = firmware();
            Write(Bank0, 0xF5, 0x03);
            // 0xF6 はアドレスが進まないレジスタとして扱う (仕様書の推定)。[0xF6, 21 バイト] を繰り返し書く
            Span<byte> chunk = stackalloc byte[FirmwareChunk + 1];
            chunk[0] = 0xF6;
            for (var at = 0; at < code.Length; at += FirmwareChunk)
            {
                var length = Math.Min(FirmwareChunk, code.Length - at);
                code.AsSpan(at, length).CopyTo(chunk[1..]);
                bridge.I2cWrite(Bank0, chunk[..(length + 1)]);
            }
            // 元のドライバがパリティの検査と呼んでいるビット
            if ((Read(Bank0, 0xF8) & 0x10) != 0) throw new IOException($"復調のファームウェア ({FirmwareName}) を送りましたが、検査に落ちました");
            Write(Bank0, 0xF5, 0x00);
            sent = true;
        }
        Write(Bank2, 0x08, 0x00); // TS をパラレルで出す
        Write(Bank0, 0xD9, 0xE1); // TS のクロックを固定にする
        return sent;
    }

    /// <summary>IF (Hz) を復調に書く値 (24 ビット): round(IF × 2^24 ÷ 20.5 MHz)</summary>
    internal static uint IfValue(uint hertz) => (uint)Math.Round(hertz * 16_777_216.0 / Crystal, MidpointRounding.AwayFromZero);

    /// <summary>
    /// ISDB-C の受信を始める (チューナーを合わせたあと)。Annex C でも Annex A (DVB-C) と同じ値で、シンボルレート・変調・ロールオフは書かない
    /// (復調が自分で見つけると仕様書は推定している)
    /// </summary>
    public void Tune(uint ifHz)
    {
        var value = IfValue(ifHz);
        foreach (var (bank, register, data) in Rows(value)) Write(bank, register, data);
    }

    /// <summary>選局で書く (バンク, レジスタ, 値) の順 (仕様書の表のとおり)</summary>
    internal static IEnumerable<(byte Bank, byte Register, byte Value)> Rows(uint ifValue) =>
    [
        (Bank2, 0x00, 0x66),
        (Bank2, 0x01, 0x00),
        (Bank2, 0x02, 0x01),
        (Bank2, 0x03, 0x04), // 受信方式 DVB-C
        (Bank2, 0x04, 0x00), // 帯域 (DVB-C は 0)
        (Bank2, 0x10, (byte)(ifValue >> 16)),
        (Bank2, 0x11, (byte)(ifValue >> 8)),
        (Bank2, 0x12, (byte)ifValue),
        (Bank0, 0xB4, 0x00),
        (Bank0, 0xCD, 0x17),
        (Bank0, 0xD4, 0x09),
        (Bank0, 0xD6, 0x48),
        (Bank2, 0xF8, 0x9F), // 状態機械をリセットして捕捉を始める
    ];

    /// <summary>ロックしているか: バンク 1 の 0x84 の下位 4 ビットが 8 以上。8 未満の値の意味は仕様書に無い</summary>
    public bool Locked() => IsLocked(Read(Bank1, 0x84));

    internal static bool IsLocked(byte status) => (status & 0x0F) >= 8;

    /// <summary>C/N (dB)。バンク 1 の 0xA1〜0xA4 を続けて読む。ロックしていなければ null</summary>
    public double? Cn()
    {
        if (!Locked()) return null;
        Span<byte> data = stackalloc byte[4];
        bridge.I2cRead(Bank1, 0xA1, data);
        return CnDb((ushort)((data[0] << 8) | data[1]), (ushort)((data[2] << 8) | data[3]));
    }

    /// <summary>C/N [dB] = 10 × log10(8 × S ÷ N)。S か N が 0 なら 0 dB</summary>
    internal static double CnDb(ushort signal, ushort noise) =>
        signal == 0 || noise == 0 ? 0 : 10 * Math.Log10(8.0 * signal / noise);

    /// <summary>スリープにする (チューナーを止めたあと)</summary>
    public void Sleep()
    {
        Write(Bank2, 0x0C, 0x30);
        Write(Bank2, 0x0B, 0x30);
        Write(Bank2, 0x05, 0x3E);
    }

    /// <summary>
    /// ファイルが仕様書のファームウェアか (大きさと、SHA-256 の先頭と末尾)。違えば理由、合えば null
    /// </summary>
    internal static string? CheckFirmware(ReadOnlySpan<byte> code)
    {
        if (code.Length != FirmwareSize) return $"大きさが {code.Length} バイトです ({FirmwareSize} バイトのはず)";
        var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(code));
        return sha.StartsWith(FirmwareShaHead, StringComparison.Ordinal) && sha.EndsWith(FirmwareShaTail, StringComparison.Ordinal)
            ? null
            : $"SHA-256 が {sha} です ({FirmwareShaHead}…{FirmwareShaTail} のはず)";
    }
}
