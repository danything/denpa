using System.Diagnostics;
using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>自前方式の PIX-DT295 が、機材に断られた・想定と違う値を返した・時間切れになった</summary>
public class Dt295NativeException(string message) : IOException(message);

/// <summary>機材が起動直後の状態ではない。ポートの電源を入れ直すと戻る (Linux)。ほかの OS では挿し直しを求める</summary>
public sealed class Dt295NativeWarmException(string message) : Dt295NativeException(message);

/// <summary>
/// 自前方式 (dt295:) の PIX-DT295 との制御転送。節の番号は仕様書 (dt295-resident/spec.md) のもの。
/// ベンダー要求 0xBC で 24 ビットのアドレスを読み書きする (仕様書 3.1)。
///
/// <list type="bullet">
/// <item>アドレス: wValue の上位バイトがビット 16〜23、wIndex が下位 16 ビット。wValue の下位バイトは 0 (1 ならマスク付きの書き込み)</item>
/// <item>読む: 制御 IN で wLength バイト。書く: 制御 OUT で wLength バイト (32 ビット単位)</item>
/// <item>マスク付きの書き込み: wValue 下位 = 1 の制御 OUT。データ [0..3] = 値、[4..7] = マスクで、*アドレス = (*アドレス &amp; ~マスク) | (値 &amp; マスク)</item>
/// <item>0x1000000 以上: 0x80000〜0x9FFFF を窓にして、boot0 のコードの中の LDI:32 の即値 (書く側 0xEA3D8、読む側 0xE9EBC。既定 0x00F00000) を
///   書き換えて 128 KiB ずつ見る。使い終わったら既定に戻す</item>
/// </list>
///
/// 16 ビットのレジスタ (仕様書が「16 ビット」と書いたもの) は 4 の倍数のアドレスの 32 ビットのうち上半分か下半分にあるものとして、
/// 読むときは 32 ビットで読んで切り出し、書くときはマスク付きの書き込みを使う。**仕様書に無い。** 32 ビット単位でしか書けない
/// 制御転送で、隣の 16 ビットを壊さずに 16 ビットだけ書くために決めた (隣は読んだ値のまま書き戻される)。
/// 窓を通す読み書き (0x1000000 以上) は 1 つのスレッドから使う。0x1000000 未満の読み書きと <see cref="Pump"/>・<see cref="RunI2c"/> は、
/// ほかのスレッドが同時に使ってよい (制御転送と、機材のプログラムへの要求と応答の組は、<c>_gate</c> で 1 つずつ通す)
/// </summary>
public sealed class Dt295NativeLink
{
    private const byte RequestIn = 0xC0;
    private const byte RequestOut = 0x40;

    /// <summary>仕様書 3.1</summary>
    public const byte Request = 0xBC;

    public const int ControlTimeoutMs = 1000;

    /// <summary>24 ビットで直に届く範囲の終わり</summary>
    public const uint DirectEnd = 0x1000000;

    /// <summary>窓 (仕様書 3.1): 0x80000〜0x9FFFF。128 KiB ずつ</summary>
    public const uint AliasBase = 0x80000, BankBytes = 0x20000;

    /// <summary>窓の基底を持つ即値の場所 (仕様書 3.1)</summary>
    public const uint WriteWindow = 0xEA3D8, ReadWindow = 0xE9EBC;

    private const uint NativeWindow = 0x00F00000;

    /// <summary>boot0 の状態 (2 バイト)。起動直後は 0 (仕様書 3.1)</summary>
    public const uint StateRegister = 0x82008;

    private readonly IUsbDevice _usb;
    private readonly Action<string>? _trace;
    private uint _readBank = NativeWindow;
    private uint _writeBank = NativeWindow;

    public Dt295NativeLink(IUsbDevice usb, Action<string>? trace = null)
    {
        _usb = usb;
        _trace = trace;
    }

    /// <summary>出した制御転送の数</summary>
    public long Controls { get; private set; }

    public static (ushort Value, ushort Index) Setup(uint address) => ((ushort)((address >> 8) & 0xFF00), (ushort)address);

    // --- 24 ビットの範囲 ---

    /// <summary>
    /// 制御転送 1 回ごとと、機材のプログラムへの要求と応答の組 (<see cref="Pump"/>・<see cref="RunI2c"/>) を、1 つのスレッドずつ通す。
    /// 書き込みのデータも、機材のプログラムの要求と応答も、同じ 64 バイトの場所 (0xC4620。仕様書 3.1) を通るので、要求と応答の読みの間に
    /// 別のスレッドが書き込むと、応答が壊れる (受信中にカードや信号の読みが入るとき)。
    /// <see cref="Pump"/> は、要求したパケットを送り終える (またはリングが空のまま待つ回数の限度に達する) まで、このロックを持つ。
    /// 30 Mbps では 512 パケットで約 70 ms で、低いビットレートでは待つ回数の限度で先に戻る。その間、カードや C/N の読みは待たされる
    /// </summary>
    private readonly Lock _gate = new();

    /// <summary>
    /// ロックを待っている呼び出しの数。**<see cref="Pump"/> は、待っている呼び出しがいる間は次の要求を出さずに譲る。**
    /// .NET のロックは公平ではなく、TS の要求を続けて出すスレッドが、放してすぐ取り直して、カードや I2C の読み書きを長く待たせた
    /// (衛星は選局が短く、カードの準備と TS の送り出しが重なる)
    /// </summary>
    private int _waiters;

    private Lock.Scope Enter()
    {
        Interlocked.Increment(ref _waiters);
        try
        {
            return _gate.EnterScope();
        }
        finally
        {
            Interlocked.Decrement(ref _waiters);
        }
    }

    private void DirectRead(uint address, Span<byte> data)
    {
        using (Enter())
        {
            var (value, index) = Setup(address);
            Controls++;
            int got;
            try
            {
                got = _usb.ControlIn(RequestIn, Request, value, index, data, ControlTimeoutMs);
            }
            catch (IOException)
            {
                Dead = true;
                throw;
            }
            if (got != data.Length) throw new Dt295NativeException($"0x{address:X} を読めません ({got}/{data.Length} バイト)");
        }
    }

    private void DirectWrite(uint address, ReadOnlySpan<byte> data, ushort valueLow = 0)
    {
        using (Enter())
        {
            var (value, index) = Setup(address);
            Controls++;
            try
            {
                _usb.ControlOut(RequestOut, Request, (ushort)(value | valueLow), index, data, ControlTimeoutMs);
            }
            catch (IOException)
            {
                Dead = true;
                throw;
            }
        }
    }

    /// <summary>制御転送が失敗した (時間切れなど)。USB の制御が止まったとみなし、後始末の書き込みを省くのに使う</summary>
    public bool Dead { get; private set; }

    /// <summary>範囲を読む。64 バイトずつ。0x1000000 以上は窓を通し、バンクの境目をまたぐ所で区切る</summary>
    public byte[] ReadBytes(uint address, int length)
    {
        if (length <= 0 || (ulong)address + (ulong)length > uint.MaxValue) throw new ArgumentOutOfRangeException(nameof(address));
        var data = new byte[length];
        for (var at = 0; at < length;)
        {
            var current = address + (uint)at;
            var size = Chunk(current, length - at);
            DirectRead(current < DirectEnd ? current : Alias(current, ReadWindow, ref _readBank), data.AsSpan(at, size));
            at += size;
        }
        return data;
    }

    /// <summary>範囲を書く。アドレスも長さも 4 の倍数で、64 バイトずつ。0x1000000 以上は窓を通す</summary>
    public void WriteBytes(uint address, ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty || (ulong)address + (ulong)data.Length > uint.MaxValue || (address & 3) != 0 || (data.Length & 3) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(address));
        }
        // 書いてよいかは 32 ビットの書き込みと同じく語ごとに確かめる (書けない語が 1 つでもあれば、何も書かない)
        for (var at = 0u; at < data.Length; at += 4) Guard(address + at);
        _trace?.Invoke($"書く 0x{address:X8} [{data.Length}]");
        for (var at = 0; at < data.Length;)
        {
            var current = address + (uint)at;
            var size = Chunk(current, data.Length - at);
            DirectWrite(current < DirectEnd ? current : Alias(current, WriteWindow, ref _writeBank), data.Slice(at, size));
            at += size;
        }
    }

    /// <summary>1 回の制御転送の大きさ: 64 バイトまで。窓を通す範囲は、バンクの終わりまで</summary>
    private static int Chunk(uint address, int remaining)
    {
        var size = Math.Min(64, remaining);
        if (address >= DirectEnd) size = (int)Math.Min((uint)size, BankBytes - (address & (BankBytes - 1)));
        return size;
    }

    // --- 32 ビット・16 ビット (0x1000000 以上は窓を通す) ---

    /// <summary>32 ビットのレジスタを読む</summary>
    public uint Read32(uint address)
    {
        Span<byte> data = stackalloc byte[4];
        if (address < DirectEnd)
        {
            DirectRead(address, data);
        }
        else
        {
            DirectRead(Alias(address, ReadWindow, ref _readBank), data);
        }
        var result = BinaryPrimitives.ReadUInt32BigEndian(data);
        _trace?.Invoke($"読む 0x{address:X8} = 0x{result:X8}");
        return result;
    }

    /// <summary>
    /// ホストから書いてよい USB コアのレジスタ (0xFD8000〜0xFD80FF と 0xFD8300〜0xFD83FF。仕様書 8.4 が補助 CPU の割り込み・クロックの設定として書く所)。
    /// 空のままなら 1 つも書けない。実機で 0xFD8010 = 0x08080000 を書いたら制御転送がすべて時間切れになったので、
    /// 明示して許したものだけ書く (仕様書に無い)
    /// </summary>
    public HashSet<uint> AllowedCoreWrites { get; } = [];

    /// <summary>
    /// true なら、カードの UART (0xFEA000〜0xFEA03F。仕様書 §10) に書ける。カードの電源投入・切断の表と ATR・T=1 の送受信だけが使う。
    /// 空き (false) のままなら書けない (仕様書に無い。USB コアのレジスタと同じく、使う所だけ明示して許す)
    /// </summary>
    public bool AllowCardUart { get; set; }

    private int _cardBusy;

    /// <summary>
    /// カードが読み書きの途中か。TS を流している間、機材のプログラムへの要求は終わるまで制御転送が返らないので、
    /// カードの UART (受信 FIFO は 32 バイト) の読みが遅れる。カードが使っている間は、要求を小さくして遅れを短くする (<see cref="Dt295NativeStream"/>)
    /// </summary>
    public bool CardBusy => Volatile.Read(ref _cardBusy) > 0;

    /// <summary>カードの読み書きを始める。終わったら <see cref="LeaveCard"/></summary>
    public void EnterCard() => Interlocked.Increment(ref _cardBusy);

    public void LeaveCard() => Interlocked.Decrement(ref _cardBusy);

    private void Guard(uint address)
    {
        // カードの端子の向き・極性 (0xF00222〜0xF0022E。仕様書 §10 の設定確認) は、仕様書の常駐イメージも読んで確かめるだけ。書かない
        if (address is >= 0xF00200 and <= 0xF002FF)
        {
            throw new Dt295NativeException($"0x{address:X} はカードの端子の向きのレジスタで、読むだけです。書きません");
        }
        if (address is >= 0xFEA000 and <= 0xFEA03F && !AllowCardUart)
        {
            throw new Dt295NativeException($"0x{address:X} はカードの UART のレジスタで、許可していないので書きません");
        }
        if (address is (>= 0xFD8000 and <= 0xFD80FF) or (>= 0xFD8300 and <= 0xFD83FF) && !AllowedCoreWrites.Contains(address & ~3u))
        {
            throw new Dt295NativeException($"0x{address:X} は USB コアの割り込み・クロックのレジスタで、許可していないので書きません");
        }
    }

    /// <summary>32 ビットのレジスタに書く</summary>
    public void Write32(uint address, uint value)
    {
        Guard(address);
        if ((address & 3) != 0) throw new ArgumentOutOfRangeException(nameof(address));
        Span<byte> data = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(data, value);
        _trace?.Invoke($"書く 0x{address:X8} = 0x{value:X8}");
        DirectWrite(address < DirectEnd ? address : Alias(address, WriteWindow, ref _writeBank), data);
    }

    /// <summary>16 ビットのレジスタを読む (上のとおり、4 の倍数のアドレスの上半分か下半分)</summary>
    public ushort Read16(uint address)
    {
        var word = Read32(address & ~3u);
        return (ushort)((address & 2) == 0 ? word >> 16 : word);
    }

    /// <summary>16 ビットのレジスタに書く (マスク付きの書き込みで、反対側の 16 ビットは変えない)</summary>
    public void Write16(uint address, ushort value)
    {
        var shift = (address & 2) == 0 ? 16 : 0;
        MaskWrite(address & ~3u, (uint)value << shift, 0xFFFFu << shift);
    }

    /// <summary>マスク付きの書き込み (仕様書 3.1)</summary>
    public void MaskWrite(uint address, uint value, uint mask)
    {
        Guard(address);
        Span<byte> data = stackalloc byte[8];
        BinaryPrimitives.WriteUInt32BigEndian(data, value);
        BinaryPrimitives.WriteUInt32BigEndian(data[4..], mask);
        _trace?.Invoke($"書く 0x{address:X8} = 0x{value:X8} (マスク 0x{mask:X8})");
        DirectWrite(address < DirectEnd ? address : Alias(address, WriteWindow, ref _writeBank), data, valueLow: 1);
    }

    /// <summary>
    /// 0x1000000 以上のアドレスを窓の中のアドレスにする。窓の基底がそのバンクでなければ書き換える。
    /// 同じバンクの続けての読み書きでは書き換えない (制御転送を減らすため。仕様書は 1 回ごとに戻すとは書いていない)
    /// </summary>
    private uint Alias(uint address, uint window, ref uint bank)
    {
        var wanted = address & ~(BankBytes - 1);
        if (bank != wanted)
        {
            SetWindow(window, wanted);
            bank = wanted;
        }
        return AliasBase + (address & (BankBytes - 1));
    }

    private void SetWindow(uint window, uint bank)
    {
        Span<byte> data = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(data, bank);
        _trace?.Invoke($"窓 0x{window:X} = 0x{bank:X8}");
        DirectWrite(window, data);
        Span<byte> back = stackalloc byte[4];
        DirectRead(window, back);
        var check = BinaryPrimitives.ReadUInt32BigEndian(back);
        if (check != bank) throw new Dt295NativeException($"窓のレジスタ 0x{window:X} にバンク 0x{bank:X8} が入りません (0x{check:X8})");
    }

    /// <summary>
    /// 窓の基底を既定に書く。前の実行が途中で止まって窓を動かしたままにしていても、
    /// 0x82008 のような 0x80000〜0x9FFFF の読み書きが正しい所に届くようにするため、始めに呼ぶ
    /// </summary>
    public void ResetWindows()
    {
        SetWindow(ReadWindow, NativeWindow);
        SetWindow(WriteWindow, NativeWindow);
        _readBank = NativeWindow;
        _writeBank = NativeWindow;
    }

    /// <summary>窓を既定 (0x00F00000) に戻す</summary>
    public void RestoreWindows()
    {
        if (_readBank != NativeWindow)
        {
            SetWindow(ReadWindow, NativeWindow);
            _readBank = NativeWindow;
        }
        if (_writeBank != NativeWindow)
        {
            SetWindow(WriteWindow, NativeWindow);
            _writeBank = NativeWindow;
        }
    }

    // --- 自前のプログラムへの要求 ---

    /// <summary>
    /// 自前の body に要求を渡す (Dt295NativePrograms の「要求」)。制御 OUT で 64 バイトを渡し、戻ってから 0xC4620 の応答を読む。
    /// body がパケットを送り終えるまで制御 OUT が終わらないので、時間切れは長くとる
    /// </summary>
    public NativeReply Pump(uint packets, uint idleLimit, int timeoutMs)
    {
        // 待っている呼び出しに先に譲る (最大 20 ms。カードの 1 回の読み書きや I2C の 1 回の要求は、それより短く済む)
        var spin = new SpinWait();
        var until = Stopwatch.GetTimestamp() + Stopwatch.Frequency / 50;
        while (Volatile.Read(ref _waiters) > 0 && Stopwatch.GetTimestamp() < until) spin.SpinOnce();
        using (Enter()) return PumpLocked(packets, idleLimit, timeoutMs);
    }

    private NativeReply PumpLocked(uint packets, uint idleLimit, int timeoutMs)
    {
        var request = new byte[64];
        BinaryPrimitives.WriteUInt32BigEndian(request, Dt295NativePrograms.Magic);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(4), 1);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(8), packets);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(12), idleLimit);
        Controls++;
        _trace?.Invoke($"要求 パケット {packets}、待つ回数 {idleLimit}");
        try
        {
            _usb.ControlOut(RequestOut, Request, Dt295NativePrograms.RequestValue, Dt295NativePrograms.RequestIndex, request, timeoutMs);
        }
        catch (IOException)
        {
            Dead = true;
            throw;
        }
        var reply = new byte[64];
        DirectRead(Dt295NativePrograms.Staging, reply);
        uint Word(int at) => BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(at));
        return new NativeReply(Word(4), Word(8), Word(12), Word(16), Word(20), Word(24), Word(28));
    }

    /// <summary>
    /// 機材の中で I2C の転送を順に行わせる (Dt295NativePrograms の操作 2)。<paramref name="ops"/> は <see cref="Dt295I2cBatch.Encode"/> の形式。
    /// 短ければ (操作列 32 バイト・結果 16 バイトまで) 要求の中に入れて、制御転送は要求と応答の 2 回で済む。
    /// 長ければ操作列を SDRAM (0x380000) に書き、結果もそこから読む。機材のプログラムが触るのは I2C のブロック (0xFD8FE0〜0xFD8FF0) だけ
    /// </summary>
    public I2cReply RunI2c(ReadOnlySpan<byte> ops, int transfers, int readBytes)
    {
        using (Enter()) return RunI2cLocked(ops, transfers, readBytes);
    }

    private I2cReply RunI2cLocked(ReadOnlySpan<byte> ops, int transfers, int readBytes)
    {
        var inline = ops.Length <= Dt295NativePrograms.InlineOpBytes && readBytes <= Dt295NativePrograms.InlineResultBytes;
        if (!inline)
        {
            if (ops.Length > Dt295NativePrograms.BatchLimit || readBytes > Dt295NativePrograms.BatchLimit) throw new ArgumentOutOfRangeException(nameof(ops));
            var padded = new byte[(ops.Length + 3) & ~3];
            ops.CopyTo(padded);
            WriteBytes(Dt295NativePrograms.BatchPhysical, padded);
        }
        var request = new byte[64];
        BinaryPrimitives.WriteUInt32BigEndian(request, Dt295NativePrograms.Magic);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(4), 2);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(8), inline ? Dt295NativePrograms.InlineOps : Dt295NativePrograms.BatchCpu);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(12), inline ? Dt295NativePrograms.InlineResults : Dt295NativePrograms.BatchCpu + Dt295NativePrograms.BatchResultOffset);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(16), (uint)transfers);
        if (inline) ops.CopyTo(request.AsSpan((int)(Dt295NativePrograms.InlineOps - Dt295NativePrograms.Staging)));
        Controls++;
        _trace?.Invoke($"I2C の順次実行 転送 {transfers}、操作列 {ops.Length} バイト");
        try
        {
            _usb.ControlOut(RequestOut, Request, Dt295NativePrograms.RequestValue, Dt295NativePrograms.RequestIndex, request, ControlTimeoutMs);
        }
        catch (IOException)
        {
            Dead = true;
            throw;
        }
        var reply = new byte[64];
        DirectRead(Dt295NativePrograms.Staging, reply);
        var code = BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(4));
        var index = BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(8));
        var count = (int)BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(12));
        if (count < 0 || count > Math.Max(readBytes, 0)) throw new Dt295NativeException($"I2C の順次実行が返した読みの数 {count} が想定 ({readBytes}) を超えています");
        byte[] read = [];
        if (count > 0)
        {
            read = inline
                ? reply.AsSpan((int)(Dt295NativePrograms.InlineResults - Dt295NativePrograms.Staging), count).ToArray()
                : ReadBytes(Dt295NativePrograms.BatchPhysical + Dt295NativePrograms.BatchResultOffset, count);
        }
        return new I2cReply(code, index, read);
    }

    /// <summary>
    /// 機材の中の I2C の順次実行が使えるか。転送 0 個の要求が結果 0 で戻ることと、操作列の置き場 (SDRAM の 0x380000) に書いたものが読めることを確かめる。
    /// 使えなければ false で、ホストが 1 つずつ行う。書くのは置き場だけ (I2C のレジスタには触れない)
    /// </summary>
    public bool ProbeI2cSequencer()
    {
        try
        {
            var empty = RunI2c([], 0, 0);
            if (empty.Code != Dt295NativePrograms.I2cOk || empty.Index != 0) return false;
            byte[] pattern = [0xA5, 0x5A, 0x3C, 0xC3, 0x01, 0x23, 0x45, 0x67];
            WriteBytes(Dt295NativePrograms.BatchPhysical, pattern);
            return ReadBytes(Dt295NativePrograms.BatchPhysical, pattern.Length).AsSpan().SequenceEqual(pattern);
        }
        catch (Dt295NativeException)
        {
            return false;
        }
    }
}

/// <summary>機材の中の I2C の順次実行 (Dt295NativePrograms の操作 2) の応答: 結果・止まった転送の番号・読んだバイト</summary>
public sealed record I2cReply(uint Code, uint Index, byte[] Read);

/// <summary>自前の body の応答 (Dt295NativePrograms の「応答」)</summary>
public sealed record NativeReply(uint Result, uint Sent, uint ReadPosition, uint Alignment, uint PacketPosition, uint WritePosition, uint Aligned);
