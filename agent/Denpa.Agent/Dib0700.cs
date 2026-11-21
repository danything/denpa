using System.Buffers.Binary;

namespace Denpa.Agent;

/*
 * DiBcom DiB0700 (USB ブリッジ)。Microsoft Xbox One Digital TV Tuner (XboxOne.cs) の中身で、EP0 のベンダー要求で GPIO・I2C・TS の出力を動かす。
 *
 * クリーンルームで、仕様書 (GPL のドライバから事実だけを抜き出した Xbox One Digital TV Tuner の仕様書) だけから書いた。
 * Linux のドライバ (dvb-usb-dib0700 など) のコードは読んでいない。コメントの「仕様書」は、その仕様書の節の名前。
 */

/// <summary>バージョンの要求 (<c>0x15</c>) の応答。16 バイトを 4 バイトずつビッグエンディアンで読む</summary>
internal readonly record struct Dib0700Version(uint Hardware, uint Rom, uint Ram, uint Kind)
{
    /// <summary>RAM (ファームウェア) のバージョンがこれ以上なら、TS の転送の長さの要求を送れる (仕様書「TS の取り出し」)</summary>
    public const uint TsLengthFrom = 0x00010201;

    public bool TakesTsLength => Ram >= TsLengthFrom;

    public override string ToString() => $"ハードウェア 0x{Hardware:X8}、ROM 0x{Rom:X8}、RAM 0x{Ram:X8}、種類 0x{Kind:X8}";
}

/// <summary>DiB0700 への制御転送 (仕様書「ブリッジ (DiB0700) への転送」)。**同時には 1 つのスレッドからだけ呼ぶ**</summary>
internal sealed class Dib0700(IUsbDevice usb, Action<int> sleep)
{
    /// <summary>ファームウェアを送る bulk OUT</summary>
    public const byte FirmwareOut = 0x01;

    /// <summary>TS が届く bulk IN</summary>
    public const byte TsIn = 0x82;

    /// <summary>制御転送の時間切れ (元のドライバは Linux の既定の 5 秒)</summary>
    private const int ControlTimeoutMs = 5_000;

    /// <summary>ファームウェアの 1 レコードを送る時間切れ</summary>
    private const int FirmwareTimeoutMs = 1_000;

    /// <summary>ファームウェアを動かす要求のあとに待つ時間</summary>
    private const int RunSettleMs = 500;

    /// <summary>1 回の I2C の転送の長さの上限 (長さは下位 6 ビット)</summary>
    private const int I2cMax = 63;

    private const byte Out = 0x40;
    private const byte In = 0xC0;
    private const byte RequestTsLength = 0x00;
    private const byte RequestGpio = 0x0C;
    private const byte RequestTsOutput = 0x0F;
    private const byte RequestI2cRead = 0x12;
    private const byte RequestI2cWrite = 0x13;
    private const byte RequestVersion = 0x15;

    /// <summary>フロントエンド側の I2C を、ブリッジの I2C 回路で使う指定 (I2C 書き込みの 4 バイト目と、読み出しの index)</summary>
    private const byte FrontendI2c = 0x10;

    private const byte Start = 0x80;
    private const byte Stop = 0x40;

    /// <summary>ファームウェアの最後に送る、アドレス 0x70000000 から動かす要求</summary>
    internal static readonly byte[] RunRequest = [0x08, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00];

    /// <summary>書き込みの要求。データの先頭の 1 バイトに bRequest と同じ値を入れる。value と index は 0</summary>
    private void Write(byte request, ReadOnlySpan<byte> rest)
    {
        Span<byte> data = stackalloc byte[rest.Length + 1];
        data[0] = request;
        rest.CopyTo(data[1..]);
        usb.ControlOut(Out, request, 0, 0, data, ControlTimeoutMs);
    }

    /// <summary>
    /// バージョンを問い合わせる。失敗するか 0 バイトならファームウェアが動いていない (コールド) ので null。
    /// 1〜15 バイトの応答は仕様書に無いので、機材の状態が分からないものとして例外を送出する
    /// </summary>
    public Dib0700Version? Version()
    {
        Span<byte> data = stackalloc byte[16];
        int got;
        try
        {
            got = usb.ControlIn(In, RequestVersion, 0, 0, data, ControlTimeoutMs);
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            return null;
        }
        if (got == 0) return null;
        if (got != 16) throw new IOException($"ブリッジのバージョンの応答が {got} バイトでした (16 バイトのはず)");
        return new Dib0700Version(
            BinaryPrimitives.ReadUInt32BigEndian(data), BinaryPrimitives.ReadUInt32BigEndian(data[4..]),
            BinaryPrimitives.ReadUInt32BigEndian(data[8..]), BinaryPrimitives.ReadUInt32BigEndian(data[12..]));
    }

    /// <summary>
    /// ファームウェアが動いていなければ送って動かし、動いているバージョンを返す (仕様書「ブリッジのファームウェア」)。
    /// 送ったあとも USB はつながったまま (接続し直しは起きない)
    /// </summary>
    /// <param name="firmware">ファームウェアのファイル。コールドのときだけ呼ぶ</param>
    /// <param name="sent">送ったときに呼ぶ (記録に出す)</param>
    public Dib0700Version Boot(Func<byte[]> firmware, Action<int>? sent = null)
    {
        if (Version() is { } warm) return warm;
        var records = Records(firmware());
        foreach (var record in records) usb.BulkWrite(FirmwareOut, record, FirmwareTimeoutMs);
        usb.BulkWrite(FirmwareOut, RunRequest, FirmwareTimeoutMs);
        sleep(RunSettleMs);
        sent?.Invoke(records.Count);
        return Version() ?? throw new IOException("ファームウェアを送りましたが、ブリッジがバージョンの要求に応答しません。機材を抜いて挿し直してください");
    }

    /// <summary>
    /// ファームウェアのファイルを、送るレコードに分ける。1 レコードは [長さ L, アドレスの下位, アドレスの上位, 種類, データ L バイト, チェックサム] で、
    /// **送るときはアドレスの 2 バイトを入れ替える。** 終わりのレコード (種類 0x01) までを返す。形が崩れていれば例外を送出する
    /// </summary>
    internal static List<byte[]> Records(ReadOnlySpan<byte> file)
    {
        var records = new List<byte[]>();
        var at = 0;
        while (at < file.Length)
        {
            if (file.Length - at < 5) throw new InvalidDataException($"ファームウェアの {at} バイト目のレコードが途中で切れています");
            var size = file[at] + 5;
            if (file.Length - at < size) throw new InvalidDataException($"ファームウェアの {at} バイト目のレコード ({size} バイト) が途中で切れています");
            var record = file.Slice(at, size).ToArray();
            (record[1], record[2]) = (record[2], record[1]);
            records.Add(record);
            at += size;
            if (record[3] == 0x01) return records;
        }
        throw new InvalidDataException("ファームウェアに終わりのレコード (種類 0x01) がありません");
    }

    /// <summary>GPIO を出力にして値を書く。<paramref name="gpio"/> は要求に入れる番号 (仕様書「GPIO の番号」)</summary>
    public void Gpio(byte gpio, bool value) => Write(RequestGpio, [gpio, (byte)(0x80 | (value ? 0x40 : 0))]);

    /// <summary>1 回の bulk 転送に入れる TS パケットの数を指定する</summary>
    public void TsLength(ushort packets) => Write(RequestTsLength, [(byte)(packets >> 8), (byte)packets]);

    /// <summary>TS の出力のオン/オフ (オンはチャンネル 0、マスターモードは使わない)</summary>
    public void TsOutput(bool on) => Write(RequestTsOutput, on ? [0x10, 0x01, 0x00] : [0x00, 0x00, 0x00]);

    /// <summary>I2C の書き込み 1 回 (開始と停止の両方を立てる)。<paramref name="address"/> は 7 ビット</summary>
    public void I2cWrite(byte address, ReadOnlySpan<byte> data) => I2cWrite(address, data, stop: true);

    private void I2cWrite(byte address, ReadOnlySpan<byte> data, bool stop)
    {
        if (data.Length is 0 or > I2cMax) throw new ArgumentOutOfRangeException(nameof(data), $"I2C は 1 回に 1〜{I2cMax} バイトです ({data.Length} バイト)");
        Span<byte> body = stackalloc byte[data.Length + 3];
        body[0] = (byte)(address << 1);
        body[1] = (byte)(Start | (stop ? Stop : 0) | data.Length);
        body[2] = FrontendI2c;
        data.CopyTo(body[3..]);
        Write(RequestI2cWrite, body);
    }

    /// <summary>レジスタを読む: [レジスタ] を開始あり・停止なしで書き、リピーテッドスタートで <paramref name="into"/> の長さだけ読む</summary>
    public void I2cRead(byte address, byte register, Span<byte> into)
    {
        if (into.Length is 0 or > I2cMax) throw new ArgumentOutOfRangeException(nameof(into), $"I2C は 1 回に 1〜{I2cMax} バイトです ({into.Length} バイト)");
        I2cWrite(address, [register], stop: false);
        var value = (ushort)(((Start | Stop | into.Length) << 8) | (address << 1));
        var got = usb.ControlIn(In, RequestI2cRead, value, FrontendI2c, into, ControlTimeoutMs);
        if (got != into.Length) throw new IOException($"I2C 0x{address:X2} のレジスタ 0x{register:X2} を {into.Length} バイト読むはずが {got} バイトでした");
    }

    public byte I2cRead(byte address, byte register)
    {
        Span<byte> one = stackalloc byte[1];
        I2cRead(address, register, one);
        return one[0];
    }

    /// <summary>
    /// フロントエンドの電源を入れ、復調をリセットして放す (仕様書「電源とリセット」)。それぞれのあとに 30 ms 待つ
    /// </summary>
    public void PowerUp()
    {
        const byte power = 0x08; // GPIO6
        const byte demodReset = 0x0F; // GPIO10 (0 でリセット)
        foreach (var (gpio, value) in new (byte, bool)[] { (power, false), (power, true), (demodReset, true), (demodReset, false), (demodReset, true) })
        {
            Gpio(gpio, value);
            sleep(30);
        }
    }
}
