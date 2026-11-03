using System.Buffers.Binary;
using System.Diagnostics;

namespace Denpa.Agent;

/*
 * PIX-DT295 の ASSP (MB86M01 系) との基本の操作 (仕様書 3 章)。レジスターの読み書き・イベント・状態・コマンド・I2C・
 * セキュアコマンド・イメージの書き込み。節の番号は DT295 の仕様書のもの (Dt295.cs の頭)。
 *
 * **機材への書き込みは全部 Send を通す** (control OUT も bulk OUT も)。--trace のときはそこで 1 行ずつ記録に出し、
 * 書いた回数もそこで数える。
 */

/// <summary>時刻と眠り。テストは眠らない偽物を渡す</summary>
public interface IDt295Time
{
    /// <summary>いまの時刻 (ms)。差だけを使う</summary>
    long NowMs { get; }

    void Sleep(int ms);
}

/// <summary>本物の時計</summary>
public sealed class Dt295SystemTime : IDt295Time
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    public long NowMs => _clock.ElapsedMilliseconds;
    public void Sleep(int ms) => Thread.Sleep(ms);
}

/// <summary>ASSP とのやり取りが仕様どおりに進まなかった (機器の状態は不明として扱う。13 章の再送しない方針)</summary>
public sealed class Dt295Exception(string message) : IOException(message);

/// <summary>チューナーの操作 (Dt295Frontend.cs) が使う分だけ。テストは偽物を渡す</summary>
public interface IDt295Board
{
    IDt295Time Time { get; }

    /// <summary>I2C 転送 1 回 (3.10)</summary>
    void I2c(byte address, ReadOnlySpan<byte> write, Span<byte> read);

    /// <summary>部分書き換え (3.2)</summary>
    void Modify16(uint address, int shift, int width, int value);

    /// <summary>今の状態 (3.7)</summary>
    ushort State();
}

/// <summary>コマンドの系統 (3.8)</summary>
public enum Dt295Channel
{
    /// <summary>主コマンド (bRequest 0xB8)</summary>
    Main,

    /// <summary>副コマンド (bRequest 0xB9。I2C・カード)</summary>
    Sub,
}

/// <summary>ASSP の制御 (3 章)。1 つのスレッドから使う</summary>
public sealed class Dt295Bridge : IDt295Board
{
    private const byte RequestIn = 0xC0;
    private const byte RequestOut = 0x40;
    private const byte MemoryRequest = 0xBC;
    private const byte MainRequest = 0xB8;
    private const byte SubRequest = 0xB9;

    /// <summary>control 転送の時間切れ (3.1・15 章)</summary>
    public const int ControlTimeoutMs = 1000;

    /// <summary>1 回のレジスター読み書きの上限 (3.1)</summary>
    public const int MaxChunk = 64;

    /// <summary>コマンドの完了待ち (3.8)</summary>
    public const int CommandTimeoutMs = 5000;

    /// <summary>I2C の結果待ち (3.10)</summary>
    public const int I2cTimeoutMs = 1000;

    /// <summary>割り込み 1 回の読みの上限 (3.5)</summary>
    private const int InterruptSliceMs = 50;

    /// <summary>状態待ちの間隔 (3.7)</summary>
    public const int PollMs = 10;

    public const byte ImageEndpoint = 0x02;
    public const byte InterruptEndpoint = 0x83;
    public const int ImageChunk = 65536;
    public const int ImageTimeoutMs = 300;

    // レジスター (3.3)
    public const uint StateRegister = 0x82008;

    /// <summary>ファームウェアのエラー (3.6)</summary>
    public const ushort ErrorState = 0xFFFF;

    public const string ErrorMessage = "ファームウェアがエラーの状態です (0x82008 = 0xFFFF)";
    public const uint EventRegister = 0x90074;
    public const uint MainCode = 0x80014;
    public const uint SubCode = 0x80016;
    public const uint I2cBuffer = 0x800C0;
    public const uint I2cResult = 0x823BE;
    public const uint Mailbox = 0x83000;
    public const int MailboxSize = 512;

    // イベントのビット (3.4)
    public const ushort EventSubDone = 0x0002;
    public const ushort EventState = 0x0004;
    public const ushort EventMainDone = 0x0008;
    public const ushort EventI2c = 0x0100;
    public const ushort EventCard = 0x0200;
    public const ushort EventCardError = 0x0400;

    private readonly IUsbDevice _usb;
    private readonly IDt295Time _time;
    private readonly Action<string>? _trace;
    private readonly byte[] _chunk = new byte[MaxChunk];

    /// <summary>機材へ書いた回数 (control OUT と bulk OUT)</summary>
    public long Writes { get; private set; }

    /// <summary>レジスターを読んだ回数 (control IN)</summary>
    public long Reads { get; private set; }

    /// <param name="trace">あれば、機材への書き込みを 1 つずつ渡す</param>
    public Dt295Bridge(IUsbDevice usb, IDt295Time time, Action<string>? trace = null)
    {
        _usb = usb;
        _time = time;
        _trace = trace;
    }

    public IDt295Time Time => _time;

    public IUsbDevice Usb => _usb;

    // ---------------------------------------------------------------------
    // 書き込みの通り道 (全部ここ)
    // ---------------------------------------------------------------------

    private void SendControl(byte request, ushort value, ushort index, ReadOnlySpan<byte> data, string what)
    {
        Writes++;
        _trace?.Invoke($"OUT 0x{request:X2} wValue=0x{value:X4} wIndex=0x{index:X4} [{data.Length}] {what}");
        _usb.ControlOut(RequestOut, request, value, index, data, ControlTimeoutMs);
    }

    private void SendBulk(ReadOnlySpan<byte> data, string what)
    {
        Writes++;
        _trace?.Invoke($"BULK EP 0x{ImageEndpoint:X2} [{data.Length}] {what}");
        _usb.BulkWrite(ImageEndpoint, data, ImageTimeoutMs);
    }

    // ---------------------------------------------------------------------
    // レジスター (3.1・3.2)
    // ---------------------------------------------------------------------

    /// <summary>
    /// アドレス → (wValue, wIndex) (3.1)。wValue の上位バイトがビット 16〜23、下位バイトは 0。
    /// 24 ビットの範囲では MB86H47 のメモリ要求 (<see cref="Mb86h47.Setup"/>) と同じ形になる (あちらは下位バイトにビット 24〜31 を置く)
    /// </summary>
    public static (ushort Value, ushort Index) Setup(uint address)
    {
        if (address > 0xFFFFFF) throw new ArgumentOutOfRangeException(nameof(address), $"アドレスは 24 ビットまでです (0x{address:X})");
        return Mb86h47.Setup(address);
    }

    private static void CheckRange(uint address, int length)
    {
        if (length > 65536 || address + (ulong)length > 0x1000000) throw new ArgumentOutOfRangeException(nameof(length), $"0x{address:X} から {length} バイトは範囲の外です (3.1)");
    }

    /// <summary>読む。64 バイトずつに分け、アドレスを 64 ずつ進める (3.1)</summary>
    public void Read(uint address, Span<byte> data)
    {
        CheckRange(address, data.Length);
        for (var at = 0; at < data.Length; at += MaxChunk)
        {
            var piece = data.Slice(at, Math.Min(MaxChunk, data.Length - at));
            var (value, index) = Setup(address + (uint)at);
            Reads++;
            var got = _usb.ControlIn(RequestIn, MemoryRequest, value, index, piece, ControlTimeoutMs);
            if (got != piece.Length) throw new Dt295Exception($"レジスターを読めません (0x{address + at:X}: {got}/{piece.Length} バイト)");
        }
    }

    /// <summary>書く。64 バイトずつ (3.1)</summary>
    public void Write(uint address, ReadOnlySpan<byte> data)
    {
        CheckRange(address, data.Length);
        for (var at = 0; at < data.Length; at += MaxChunk)
        {
            var piece = data.Slice(at, Math.Min(MaxChunk, data.Length - at));
            var (value, index) = Setup(address + (uint)at);
            SendControl(MemoryRequest, value, index, piece, $"0x{address + at:X5} ← {Convert.ToHexString(piece)}");
        }
    }

    /// <summary>16 ビット BE のレジスターを読む (3.2)</summary>
    public ushort Read16(uint address)
    {
        Span<byte> two = stackalloc byte[2];
        Read(address, two);
        return BinaryPrimitives.ReadUInt16BigEndian(two);
    }

    public void Write16(uint address, ushort value)
    {
        Span<byte> two = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(two, value);
        Write(address, two);
    }

    /// <summary>部分書き換え後の値 (3.2)。マスクは <c>((1 &lt;&lt; 幅) - 1) &lt;&lt; シフト</c></summary>
    public static ushort Field(ushort old, int shift, int width, int value)
    {
        if (shift is < 0 or > 15 || width < 1 || width > 16 - shift) throw new ArgumentOutOfRangeException(nameof(width), $"シフト {shift}・幅 {width} は 16 ビットに収まりません");
        var limit = (1 << width) - 1;
        if (value < 0 || value > limit) throw new ArgumentOutOfRangeException(nameof(value), $"値 {value} は幅 {width} に収まりません");
        var mask = limit << shift;
        return (ushort)((old & ~mask) | (value << shift));
    }

    /// <summary>部分書き換え: 2 バイト読む → 範囲だけ置き換える → 2 バイト書く (3.2)</summary>
    public void Modify16(uint address, int shift, int width, int value) =>
        Write16(address, Field(Read16(address), shift, width, value));

    // ---------------------------------------------------------------------
    // イベントと状態 (3.4〜3.7)
    // ---------------------------------------------------------------------

    public ushort Events() => Read16(EventRegister);

    /// <summary>そのビットだけを立てた値を書いて消す (3.4)</summary>
    public void Clear(ushort bits) => Write16(EventRegister, bits);

    /// <summary>
    /// イベントのビットが立つまで待つ (3.5)。最大 50 ms の interrupt の読み → 0x90074 を読む、を繰り返す。
    /// interrupt の中身は見ない。立てば true、期限が来れば false
    /// </summary>
    public bool WaitEvent(ushort bits, int timeoutMs)
    {
        var deadline = _time.NowMs + timeoutMs;
        // EP 0x83 の最大パケットは 64 バイト (2.3)。参照実装は 6 バイトを要求するが、
        // 長い答えが来たときに溢れないよう最大パケットで受ける (0 バイトでなければ何バイトでもよい。3.5)
        Span<byte> buffer = stackalloc byte[64];
        while (true)
        {
            if ((Events() & bits) != 0) return true;
            var left = deadline - _time.NowMs;
            if (left <= 0) return false;
            _usb.InterruptRead(InterruptEndpoint, buffer, (int)Math.Min(InterruptSliceMs, left));
        }
    }

    /// <summary>
    /// 今の状態を確定させる (3.7)。0x90074 のビット 2 が立っていれば消して読み直す。0xFFFF ならエラーで投げる。
    /// 64 回で落ち着かなければ投げる
    /// </summary>
    public ushort State()
    {
        for (var i = 0; i < 64; i++)
        {
            var events = Events();
            var state = Read16(StateRegister);
            if ((events & EventState) != 0) Clear(EventState);
            if (state == ErrorState) throw new Dt295Exception(ErrorMessage);
            if ((events & EventState) == 0) return state;
        }
        throw new Dt295Exception("状態が落ち着きません (0x90074 のビット 2 が 64 回続けて立っていました)");
    }

    /// <summary>その状態になるまで 10 ms おきに待つ (3.7)。期限までにならなければ投げる</summary>
    public void WaitState(ushort wanted, int timeoutMs)
    {
        var deadline = _time.NowMs + timeoutMs;
        while (true)
        {
            var state = State();
            if (state == wanted) return;
            if (_time.NowMs >= deadline) throw new Dt295Exception($"状態 0x{wanted:X2} になりません (いまは 0x{state:X4}、{timeoutMs} ms 待ちました)");
            _time.Sleep(PollMs);
        }
    }

    // ---------------------------------------------------------------------
    // コマンド (3.8)
    // ---------------------------------------------------------------------

    /// <summary>コマンドの 4 バイト <c>[cmd, sub, val上位, val下位]</c> (3.8)</summary>
    public static byte[] CommandBytes(byte command, byte sub, ushort value) => [command, sub, (byte)(value >> 8), (byte)value];

    /// <summary>
    /// コマンドを 1 つ送って完了を待つ (3.8)。**失敗しても送り直さない。** 完了コードの上位バイトが cmd と同じで、
    /// 下位バイトが 0x80 でも 0x81 でもなければ成功。<paramref name="beforeClear"/> は完了ビットを消す前に呼ぶ
    /// (セキュアコマンドの応答をここで読む。手順 5)
    /// </summary>
    public ushort Command(Dt295Channel channel, byte command, byte sub, ushort value, Action? beforeClear = null)
    {
        var (request, done, codeAt) = channel == Dt295Channel.Main
            ? (MainRequest, EventMainDone, MainCode)
            : (SubRequest, EventSubDone, SubCode);
        var what = $"cmd {command} sub 0x{sub:X2} val 0x{value:X4}";
        // 1. 完了ビットがすでに立っていたら送らない
        if ((Events() & done) != 0) throw new Dt295Exception($"{what}: 前のコマンドの完了ビット (0x{done:X4}) が残っています");
        // 2. 送る
        SendControl(request, 0, 0, CommandBytes(command, sub, value), what);
        // 3. 完了を待つ
        if (!WaitEvent(done, CommandTimeoutMs)) throw new Dt295Exception($"{what}: {CommandTimeoutMs} ms 待っても完了しません");
        // 4. 完了コード
        var code = Read16(codeAt);
        // 5. セキュアコマンドの応答
        beforeClear?.Invoke();
        // 6. 完了ビットを消す
        Clear(done);
        // 7. 判定
        if (!Succeeded(command, code)) throw new Dt295Exception($"{what}: 完了コード 0x{code:X4}");
        return code;
    }

    /// <summary>完了コードの判定 (3.8 の手順 7)</summary>
    public static bool Succeeded(byte command, ushort code) => code >> 8 == command && (code & 0xFF) is not (0x80 or 0x81);

    // ---------------------------------------------------------------------
    // I2C (3.10)
    // ---------------------------------------------------------------------

    /// <summary>
    /// I2C 転送 1 回 (3.10)。<paramref name="write"/> を送り、<paramref name="read"/> の長さだけ受ける (どちらも 0〜64 バイト、
    /// 少なくともどちらかは 1 以上)。<paramref name="address"/> は 0x20 (地上波復調器) か 0x22 (衛星復調器)
    /// </summary>
    public void I2c(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        if (write.Length > 64 || read.Length > 64 || (write.IsEmpty && read.IsEmpty)) throw new ArgumentException("I2C は送り・受けとも 0〜64 バイトで、どちらかは 1 バイト以上です");
        if ((Events() & EventI2c) != 0) throw new Dt295Exception("前の I2C の結果 (0x90074 のビット 8) が残っています");
        if (!write.IsEmpty)
        {
            Span<byte> padded = stackalloc byte[64];
            padded.Clear();
            write.CopyTo(padded);
            Write(I2cBuffer, padded);
            Command(Dt295Channel.Sub, 9, read.IsEmpty ? (byte)0 : (byte)2, I2cValue(address, write.Length));
        }
        if (!read.IsEmpty)
        {
            Command(Dt295Channel.Sub, 9, write.IsEmpty ? (byte)1 : (byte)3, I2cValue(address, read.Length));
        }
        if (!WaitEvent(EventI2c, I2cTimeoutMs)) throw new Dt295Exception($"I2C 0x{address:X2}: {I2cTimeoutMs} ms 待っても結果が来ません");
        Span<byte> result = stackalloc byte[66];
        Read(I2cResult, result);
        Clear(EventI2c);
        if (result[0] != 0 || result[1] != 0) throw new Dt295Exception($"I2C 0x{address:X2}: 失敗しました ({result[0]:X2} {result[1]:X2})");
        result.Slice(2, read.Length).CopyTo(read);
    }

    /// <summary>I2C のコマンドの val: <c>(I2C アドレス &lt;&lt; 8) | 長さ</c> (3.10)</summary>
    public static ushort I2cValue(byte address, int length) => (ushort)((address << 8) | length);

    // ---------------------------------------------------------------------
    // セキュアコマンド (3.11)
    // ---------------------------------------------------------------------

    /// <summary>要求の 512 バイト (3.11)。暗号化はまだかけない</summary>
    public static byte[] SecureRequest(uint id, ReadOnlySpan<byte> payload)
    {
        if (payload.Length > 496 || payload.Length % 4 != 0) throw new ArgumentException($"ペイロードは 496 バイトまでの 4 の倍数です ({payload.Length} バイト)", nameof(payload));
        var request = new byte[MailboxSize];
        BinaryPrimitives.WriteUInt32BigEndian(request, id);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(4), 0);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(8), (uint)(payload.Length / 4));
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(12), 0xFFFFFFFF);
        payload.CopyTo(request.AsSpan(16));
        return request;
    }

    /// <summary>ID のビット 10 が立っていれば要求を暗号化する (3.11)</summary>
    public static bool EncryptsRequest(uint id) => (id & 0x400) != 0;

    /// <summary>ID のビット 9 が立っていれば応答を復号する (3.11)</summary>
    public static bool DecryptsResponse(uint id) => (id & 0x200) != 0;

    /// <summary>暗号化・復号する範囲: オフセット 12〜507 (496 バイト = 16 バイト×31)</summary>
    private const int CipherAt = 12;
    private const int CipherLength = 496;

    /// <summary>
    /// セキュアコマンドを 1 つ実行して応答ペイロードを返す (3.11)。暗号を使う ID なら <paramref name="key"/> と <paramref name="iv"/>
    /// (セッション鍵と IV) が要る。IV はコマンドごとにセッション IV から始め直す
    /// </summary>
    public byte[] Secure(uint id, ReadOnlySpan<byte> payload, byte[]? key, byte[]? iv)
    {
        var encrypted = EncryptsRequest(id);
        var decrypted = DecryptsResponse(id);
        if ((encrypted || decrypted) && (key is null || iv is null)) throw new InvalidOperationException($"セキュアコマンド 0x{id:X8} は認証のあとでなければ使えません");
        var request = SecureRequest(id, payload);
        if (encrypted) Dt295Crypto.CbcEncrypt(key!, iv!, request.AsSpan(CipherAt, CipherLength));
        Write(Mailbox, request);
        var response = new byte[MailboxSize];
        Command(Dt295Channel.Main, 8, 0, 0, () => Read(Mailbox, response));
        return SecureResponse(id, response, key, iv);
    }

    /// <summary>応答の 512 バイトを解く (3.11)。合わなければ投げる</summary>
    public static byte[] SecureResponse(uint id, byte[] response, byte[]? key, byte[]? iv)
    {
        if (DecryptsResponse(id)) Dt295Crypto.CbcDecryptWithResidual(key!, iv!, response.AsSpan(CipherAt, CipherLength));
        var echoed = BinaryPrimitives.ReadUInt32BigEndian(response);
        if (echoed != id) throw new Dt295Exception($"セキュアコマンド 0x{id:X8}: 応答の ID が違います (0x{echoed:X8})");
        var status = BinaryPrimitives.ReadUInt32BigEndian(response.AsSpan(4));
        if (status != 0) throw new Dt295Exception($"セキュアコマンド 0x{id:X8}: ステータス 0x{status:X8}");
        var words = BinaryPrimitives.ReadUInt32BigEndian(response.AsSpan(8));
        if (words > 124) throw new Dt295Exception($"セキュアコマンド 0x{id:X8}: 応答のワード数が多すぎます ({words})");
        return response.AsSpan(16, (int)words * 4).ToArray();
    }

    // ---------------------------------------------------------------------
    // イメージの書き込み (4.2 の手順 7・5.7・9.2)
    // ---------------------------------------------------------------------

    /// <summary>EP 0x02 へ 65,536 バイトずつ送る (最後は端数)。**失敗しても送り直さない** (機器の状態は不明)</summary>
    public void Upload(ReadOnlySpan<byte> image, string name)
    {
        for (var at = 0; at < image.Length; at += ImageChunk)
        {
            var piece = image.Slice(at, Math.Min(ImageChunk, image.Length - at));
            try
            {
                SendBulk(piece, $"{name} {at}/{image.Length}");
            }
            catch (IOException error)
            {
                throw new Dt295Exception($"{name} を送れません ({at}/{image.Length} バイトのところ。機器の状態は分からないので、抜いて挿し直してください): {error.Message}");
            }
        }
    }

    /// <summary>
    /// 4.2 の手順 10 の 1 回だけの書き込み。ファームウェアが EP0 を再起動するので、時間切れやエラーで返ることがある。
    /// **送り直さず**、結果は呼ぶ側が次の観測で判断する。返ったかどうかを返す
    /// </summary>
    public bool WriteOnce(uint address, ushort value)
    {
        try
        {
            Write16(address, value);
            return true;
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            _trace?.Invoke($"0x{address:X5} の書き込みは返りませんでした ({error.Message})。送り直しません");
            return false;
        }
    }
}
