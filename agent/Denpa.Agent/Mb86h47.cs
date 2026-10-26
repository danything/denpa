using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics;

namespace Denpa.Agent;

/*
 * 富士通 MB86H47A (CECH-ZD1 J の USB ブリッジ)。**機材の事実を書き出した仕様書だけから書いた** (参考の実装のソースは見ていない)。
 * 節の番号 (「4.2」など) はその仕様書のもの。仕様書が「こちらで決めてよい」とした所 (コア 1 への指示の形など) は
 * Mb86h47Programs.cs に書いた形で決めた。
 *
 * ホストはベンダー要求 0xBC (メモリ要求) でブリッジのレジスタを叩く。メモリ要求は全部この錠で1つずつ通す
 * (I2C もカードの UART もメモリ要求なので、チューナーとカードが別のスレッドから呼んでも混ざらない)。
 * TS の EP 0x81 の読みはこの外 (IUsbInStream) で並べる。
 */

/// <summary>I2C の流し方 (<c>DENPA_ZD1J_I2C</c>)</summary>
public enum Zd1jI2cMode
{
    /// <summary>ホストが I2C マスターを1バイトずつ叩く (仕様書 5.3)</summary>
    Host,

    /// <summary>コア 1 に任せる。指示は bulk の塊で送り、答えなければメモリ要求のリングに戻る (仕様書 5.4・5.5)</summary>
    Core1,

    /// <summary>コア 1 に任せ、指示はメモリ要求のリングと箱だけで渡す</summary>
    Core1Ring,
}

/// <summary>I2C の相手と話す口。DiB8096 はこれと待ちだけを受け取る</summary>
public interface II2c
{
    void Write(byte address, ReadOnlySpan<byte> data);

    /// <summary>書いてから繰り返しスタートで読む (<paramref name="write"/> が空なら読むだけ)</summary>
    void WriteRead(byte address, ReadOnlySpan<byte> write, Span<byte> read);

    /// <summary>2 バイトの番号のレジスタを読んで <c>&amp; keep | set</c> して書く</summary>
    void Modify16(byte address, ushort register, ushort keep, ushort set);

    /// <summary>溜めた書き込みを機材に届ける (戻ったときには届いている)</summary>
    void Flush();
}

/// <summary>MB86H47A。<b>メモリ要求・番地を広げる・クロック・I2C・TS・カードの UART</b></summary>
public sealed class Mb86h47 : II2c
{
    private const byte RequestIn = 0xC0;
    private const byte RequestOut = 0x40;
    private const byte MemoryRequest = 0xBC;
    private const int TimeoutMs = 1000;

    /// <summary>1回のメモリ要求の上限 (4.2 で広げたあと)</summary>
    private const int MaxWords = 16;

    private const uint Core0 = 0x1600000;
    private const uint Core1 = 0x1700000;
    private const uint CoreHalt = 0xFFFFFFFF;
    private const uint CoreRun = 0xFFFCFFFF;
    private const uint CoreEntry = 0xFFFFC;

    // I2C マスター (4.5)
    private const uint I2cStatus = 0xFD8FE0;
    private const uint I2cControl = 0xFD8FE4;
    private const uint I2cData = 0xFD8FF0;

    /// <summary>ホストから直に叩くとき、1バイトや使用中を待つ読みの上限</summary>
    private const int HostSpin = 100;

    // bulk の命令の経路 (5.5)
    private const byte CommandOut = 0x02;
    private const byte CommandIn = 0x83;
    private const int CommandWords = Mb86h47Programs.BulkChunk / 4 - 3;

    // カードの UART (13.1)
    private const uint CardEnable = 0xFEA000;
    private const uint CardLines = 0xFEA004;
    private const uint CardBaud = 0xFEA008;
    private const uint CardSend = 0xFEA00C;
    private const uint CardControl = 0xFEA010;
    private const uint CardCount = 0xFEA014;
    private const uint CardMask = 0xFEA018;
    private const uint CardStatus = 0xFEA01C;
    private const uint CardCwt = 0xFEA020;
    private const uint CardBwt = 0xFEA024;
    private const uint CardTx = 0xFEA028;
    private const uint CardRx = 0xFEA02C;
    private const uint CardPower = 0xFEA034;
    private const uint CardTxLrc = 0xFEA038;
    private const uint CardRxLrc = 0xFEA03C;

    /// <summary>主 CPU の処理の書き換える5語と、電源投入時の値 (4.2)</summary>
    private static readonly uint[] PatchAt = [0xE9AC0, 0xE9AC4, 0xE9E0C, 0xE9E10, 0xE9D94];

    private static readonly uint[] PowerOn = [0x9B800000, 0xAA04E40F, 0x9B800000, 0xAA04E40D, 0xB4279F8D];

    /// <summary>データ段の溜め方の語の上位 16 ビットを NOP にしたもの</summary>
    private const uint Stage = 0x9FA09F8D;

    private const uint JumpSecond = 0x970C9FA0;

    private static readonly Lazy<Mb86h47Programs.Routine[]> Routines = new(() => [Mb86h47Programs.Addressing(0), Mb86h47Programs.Addressing(1)]);
    private static readonly Lazy<uint[]> Core0Program = new(() => Mb86h47Programs.Core0().Words);
    private static readonly Lazy<uint[]> Core1Program = new(() => Mb86h47Programs.Core1().Words);

    private readonly IUsbDevice _usb;
    private readonly Action<string>? _trace;
    private readonly Lock _gate = new();
    private readonly byte[] _buffer = new byte[MaxWords * 4];
    private bool _widened;

    // コア 1 の溜めと箱
    private readonly List<(bool Tuner, int Register, ushort Value)> _ring = [];
    private uint _ringPlaced;
    private uint _ringDone;
    private uint _ringError;
    private byte _boxSequence;

    // bulk の塊
    private readonly List<uint> _commands = [];
    private uint _chunkSequence;
    private int _chunkSlot;

    // 流し始めの準備 (9.2)。待ちの間に1つずつ回す
    private readonly Queue<Action> _prepare = new();
    private bool _prepared;

    public Zd1jI2cMode Mode { get; }

    /// <summary>コア 1 への指示を bulk の塊で送っている (5.5)</summary>
    public bool CommandChannel { get; private set; }

    /// <summary>メモリ要求の数 (速さを測るため)</summary>
    public long Requests { get; private set; }

    /// <summary>I2C のやり取りの数 (書き込み・読み・読みかえ書きを1つずつ)</summary>
    public long I2cTransfers { get; private set; }

    public Mb86h47(IUsbDevice usb, Zd1jI2cMode mode, Action<string>? trace = null)
    {
        _usb = usb;
        Mode = mode;
        _trace = trace;
    }

    // ---------------------------------------------------------------------
    // メモリ要求 (3)
    // ---------------------------------------------------------------------

    /// <summary>番地 → (wValue, wIndex)。wValue の上位バイト = ビット 16〜23、下位バイト = ビット 24〜31</summary>
    public static (ushort Value, ushort Index) Setup(uint address) =>
        ((ushort)((((address >> 16) & 0xFF) << 8) | (address >> 24)), (ushort)address);

    private void Check(uint address)
    {
        if (address >= 0x1000000 && !_widened) throw new InvalidOperationException($"番地 0x{address:X} は 4.2 で広げる前には届きません");
    }

    private uint Read32(uint address)
    {
        Span<uint> one = stackalloc uint[1];
        Read(address, one);
        return one[0];
    }

    private void Read(uint address, Span<uint> words)
    {
        Check(address);
        for (var at = 0; at < words.Length; at += MaxWords)
        {
            var count = Math.Min(MaxWords, words.Length - at);
            var (value, index) = Setup(address + (uint)(at * 4));
            var data = _buffer.AsSpan(0, count * 4);
            Requests++;
            var got = _usb.ControlIn(RequestIn, MemoryRequest, value, index, data, TimeoutMs);
            if (got != data.Length) throw new IOException($"ブリッジのメモリを読めません (0x{address:X}: {got}/{data.Length} バイト)");
            for (var i = 0; i < count; i++) words[at + i] = BinaryPrimitives.ReadUInt32BigEndian(data[(i * 4)..]);
        }
    }

    private void Write32(uint address, uint value) => Write(address, [value]);

    /// <summary>書く。4.2 で広げる前は1語ずつ (複数語だと最初の語しか正しく入らない。3.1)</summary>
    private void Write(uint address, ReadOnlySpan<uint> words)
    {
        Check(address);
        var step = _widened ? MaxWords : 1;
        for (var at = 0; at < words.Length; at += step)
        {
            var count = Math.Min(step, words.Length - at);
            var (value, index) = Setup(address + (uint)(at * 4));
            var data = _buffer.AsSpan(0, count * 4);
            for (var i = 0; i < count; i++) BinaryPrimitives.WriteUInt32BigEndian(data[(i * 4)..], words[at + i]);
            Requests++;
            _usb.ControlOut(RequestOut, MemoryRequest, value, index, data, TimeoutMs);
        }
    }

    /// <summary><c>M[a] = (M[a] &amp; ~clear) | set</c></summary>
    private void Modify(uint address, uint clear, uint set) => Write32(address, (Read32(address) & ~clear) | set);

    /// <summary><c>M16[a] ← v</c> (16 ビットのレジスタは語の上位半分。下半分は読んだまま)</summary>
    private void Write16(uint address, ushort value) => Write32(address, ((uint)value << 16) | (Read32(address) & 0xFFFF));

    // ---------------------------------------------------------------------
    // 起動 (4)
    // ---------------------------------------------------------------------

    /// <summary>4.1〜4.5 と、コア 1 の形ならコア 1 を走らせる。どこかで失敗したら投げる (開くのを止める)</summary>
    public void Start()
    {
        lock (_gate)
        {
            // 4.1 電源投入のままか
            var used = Read32(0x82008) >> 16;
            if (used != 0)
            {
                throw new IOException($"{Zd1j.Model} はほかのドライバが一度動かしています。{Zd1j.Model} を抜いて挿し直してください (0x82008 = 0x{used:X4})");
            }
            Widen();
            Clocks();
            MaskInterrupts();
            StartI2c();
            if (Mode == Zd1jI2cMode.Host) return;
            StartCore1();
            if (Mode == Zd1jI2cMode.Core1) CommandChannel = TryCommandChannel();
        }
    }

    /// <summary>跳ぶ2語: <c>LDI:20 #target, R12</c> と <c>JMP @R12</c> + <c>NOP</c></summary>
    public static (uint First, uint Second) Jump(uint target)
    {
        if (target >= 0x100000) throw new ArgumentOutOfRangeException(nameof(target));
        return ((0x9B0Cu | (((target >> 16) & 0xF) << 4)) << 16 | (target & 0xFFFF), JumpSecond);
    }

    /// <summary>跳ぶ2語の飛び先。跳ぶ語の形でなければ null</summary>
    private static uint? JumpTarget(uint first, uint second) =>
        (first & 0xFF0F0000) == 0x9B0C0000 && second == JumpSecond ? ((first >> 4) & 0xF0000) | (first & 0xFFFF) : null;

    /// <summary>そのバンクに置いたこちらのルーチンの語の並び (書き換える5語に書く値)</summary>
    internal static uint[] Patch(int bank)
    {
        var routine = Routines.Value[bank];
        var (r0, r1) = Jump(routine.Read);
        var (w0, w1) = Jump(routine.Write);
        return [r0, r1, w0, w1, Stage];
    }

    /// <summary>
    /// 4.2 メモリ要求の番地を 32 ビットに広げる。すでに自分のルーチンを指していれば何もしない。別の中身のルーチンを指していれば、
    /// 使われていないほうのバンクに置いてから跳ぶ語を書き換える (途中で要求が来ても、いつもどちらかの完全なルーチンに跳ぶように)
    /// </summary>
    private void Widen()
    {
        var now = new uint[PatchAt.Length];
        for (var i = 0; i < PatchAt.Length; i++) now[i] = Read32(PatchAt[i]);

        uint? Side(int at)
        {
            if (now[at] == PowerOn[at] && now[at + 1] == PowerOn[at + 1]) return null;
            if (JumpTarget(now[at], now[at + 1]) is { } target && Mb86h47Programs.Banks.Any(bank => target >= bank && target < bank + Mb86h47Programs.BankSize))
            {
                return target;
            }
            throw Unknown();
        }
        var read = Side(0);
        var write = Side(2);
        if (now[4] != PowerOn[4] && now[4] != Stage) throw Unknown();

        var used = new List<int>();
        foreach (var target in new[] { read, write })
        {
            if (target is not { } t) continue;
            var bank = t >= Mb86h47Programs.Banks[1] ? 1 : 0;
            if (!used.Contains(bank)) used.Add(bank);
        }

        // すでに自分のルーチンなら、データ段の語だけ確かめて終わり
        if (used.Count == 1)
        {
            var bank = used[0];
            var routine = Routines.Value[bank];
            if (read == routine.Read && write == routine.Write && Holds(Mb86h47Programs.Banks[bank], routine.Words))
            {
                if (now[4] != Stage) Write32(PatchAt[4], Stage);
                _widened = true;
                _trace?.Invoke($"主 CPU の処理はもう広げてあります (バンク {bank})");
                return;
            }
        }
        var free = Enumerable.Range(0, Mb86h47Programs.Banks.Length).FirstOrDefault(bank => !used.Contains(bank), -1);
        if (free < 0) throw Unknown();

        // ルーチンを1語ずつ置いて、1語ずつ読み返す。それから跳ぶ語を1語ずつ
        var place = Routines.Value[free];
        var origin = Mb86h47Programs.Banks[free];
        for (var i = 0; i < place.Words.Length; i++) Write32(origin + (uint)(i * 4), place.Words[i]);
        for (var i = 0; i < place.Words.Length; i++)
        {
            var back = Read32(origin + (uint)(i * 4));
            if (back != place.Words[i]) throw new IOException($"ブリッジの SRAM に書いたルーチンが読み返せません (0x{origin + i * 4:X}: 0x{back:X8})");
        }
        var patch = Patch(free);
        for (var i = 0; i < PatchAt.Length; i++) Write32(PatchAt[i], patch[i]);
        _widened = true;
        _trace?.Invoke($"主 CPU の処理を広げました (バンク {free})");
    }

    private bool Holds(uint address, uint[] words)
    {
        var back = new uint[words.Length];
        Read(address, back);
        return back.AsSpan().SequenceEqual(words);
    }

    private static IOException Unknown() =>
        new($"{Zd1j.Model} のブリッジの処理が知らない中身です (仕様書 4.2 の5語が電源投入時の値でもこちらの書いた値でもありません)。抜いて挿し直してください");

    /// <summary>4.3 クロックと SDRAM</summary>
    private void Clocks()
    {
        Write16(0xF1010C, 0x8201);
        Write16(0xF10114, 0x8008);
        Write16(0xF10118, 0xFFFF);
        foreach (var engine in new uint[] { 0x14D0000, 0x10D0000, 0x12D0000, 0x13D0000, 0xE70000, 0xC70000, 0xD00000, 0x1600000, 0x1700000 })
        {
            Modify(engine + 0x404, 0, 0x00040000);
        }
        Write16(0xF1011C, 0x0006);
        Write16(0xF10128, 0x6000);
        Write16(0xF1012C, 0x4007);
        Write16(0xF12144, 0x0003);
        foreach (var memory in new uint[] { 0xF12178, 0xF1217C, 0xF12198, 0xF1219C }) Write16(memory, 0x0880);
    }

    /// <summary>4.4 割り込みのレベルを全部 31 (塞ぐ) に</summary>
    private void MaskInterrupts()
    {
        Span<uint> levels = stackalloc uint[16];
        Read(0x440, levels);
        for (var i = 0; i < levels.Length; i++)
        {
            var masked = levels[i] | 0x1F1F1F1F;
            if (masked != levels[i]) Write32(0x440 + (uint)(i * 4), masked);
        }
    }

    /// <summary>4.5 I2C マスター</summary>
    private void StartI2c()
    {
        Modify(0xFD8010, 0, 0x10);
        Modify(0xFD8014, 0x10, 0);
        Write32(0xFD80C0, 1);
        Write32(0xFD80C0, 0);
        Write32(0xFD80C4, 0);
        Write16(0x90114, 0x8008);
        Write32(0xFD8FF8, 0x06);
        // 分周 0x08 (0x10 の倍の速さ。0x05 だと DiB8000 の初期化中に読みを落とす)
        Write32(0xFD8FF4, 0x08);
        Write32(0xFD8FE8, 0x3C);
        Write32(I2cControl, 0x40);
    }

    /// <summary>4.6 DiB8096 の電源とリセット (ブリッジの GPIO 6 = 電源、GPIO 0 = リセット)</summary>
    public void ResetDemodulator(Action<int> sleep)
    {
        uint value;
        lock (_gate)
        {
            value = Read32(0x90018) >> 16;
            var direction = Read32(0x90014) >> 16;
            Write16(0x90018, (ushort)((value & ~0x01u) | 0x40));
            Write16(0x90014, (ushort)(direction | 0x41));
        }
        sleep(50);
        lock (_gate) Write16(0x90018, (ushort)(value | 0x41));
        sleep(10);
    }

    /// <summary>コアにプログラムを置く: 止めて、入口を書き、16 語ずつ (読み返して同じなら書かない)</summary>
    private void LoadCore(uint core, uint[] program)
    {
        Write32(core, CoreHalt);
        Write32(core + CoreEntry, Mb86h47Programs.CoreOrigin);
        var at = core + Mb86h47Programs.CoreOrigin;
        Span<uint> back = stackalloc uint[MaxWords];
        for (var i = 0; i < program.Length; i += MaxWords)
        {
            var block = program.AsSpan(i, Math.Min(MaxWords, program.Length - i));
            Read(at + (uint)(i * 4), back[..block.Length]);
            if (!back[..block.Length].SequenceEqual(block)) Write(at + (uint)(i * 4), block);
        }
    }

    // ---------------------------------------------------------------------
    // コア 1 (5.4・5.5)
    // ---------------------------------------------------------------------

    private static uint Box(int offset) => Core1 + Mb86h47Programs.Core1Box + (uint)offset;

    /// <summary>コア 1 を置いて走らせ、生きている印が進むのを見る</summary>
    private void StartCore1()
    {
        LoadCore(Core1, Core1Program.Value);
        // データ RAM は電源投入時の中身が不定。コア 1 が見る所を消してから走らせる
        Write(Core1 + Mb86h47Programs.Core1Ring, new uint[Mb86h47Programs.RingSlots]);
        Write(Core1 + Mb86h47Programs.Core1RingDone, [0, 0]);
        Write32(Box(Mb86h47Programs.BoxCommand), 0);
        Write32(Box(Mb86h47Programs.BoxReply), 0);
        Write32(Box(Mb86h47Programs.BoxBulkEnable), 0);
        _ringPlaced = 0;
        _ringDone = 0;
        _ringError = 0;
        _boxSequence = 0;
        Write32(Core1, CoreRun);
        var first = Read32(Box(Mb86h47Programs.BoxAlive));
        Thread.Sleep(1);
        var second = Read32(Box(Mb86h47Programs.BoxAlive));
        if (first == second) throw new IOException($"{Zd1j.Model} のブリッジのコア 1 が動いていません");
    }

    /// <summary>5.5 の bulk の経路を用意して、空の塊を1つ送ってみる。答えが来れば使う</summary>
    private bool TryCommandChannel()
    {
        Write32(0xFD8300, 1);
        Write32(0xFD8304, 0x00008004);
        Modify(0xFDBC14, 0, 0x00040000);
        Modify(0xFD80B4, 0, 4);
        Write32(0xFD8510, Mb86h47Programs.BulkChunk);
        // 置き場の塊の頭を消す (電源投入時の SDRAM は不定。頭が 0 の塊は見ない)
        for (var slot = 0; slot < Mb86h47Programs.BulkSlots; slot++) Write32(Mb86h47Programs.BulkBuffer + (uint)(slot * Mb86h47Programs.BulkChunk), 0);
        ArmCommandDma();
        Write32(Box(Mb86h47Programs.BoxBulkEnable), Mb86h47Programs.BulkEnable);
        // 前の会話の答えが残っていれば捨てる
        Span<byte> stale = stackalloc byte[64];
        for (var i = 0; i < 16 && _usb.InterruptRead(CommandIn, stale, 10) > 0; i++)
        {
        }
        try
        {
            _commands.Clear();
            SendChunk(probeTimeoutMs: 200);
            return true;
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            _trace?.Invoke($"コア 1 が bulk の塊に答えないので、メモリ要求のリングで続けます ({error.Message})");
            Write32(Box(Mb86h47Programs.BoxBulkEnable), 0);
            _commands.Clear();
            return false;
        }
    }

    private void ArmCommandDma()
    {
        Write32(0xFD8508, Mb86h47Programs.BulkBuffer);
        Write32(0xFD8504, 1);
        _chunkSlot = 0;
    }

    // ---------------------------------------------------------------------
    // I2C (5)
    // ---------------------------------------------------------------------

    public void Write(byte address, ReadOnlySpan<byte> data)
    {
        lock (_gate)
        {
            I2cTransfers++;
            var started = Stopwatch.GetTimestamp();
            switch (Mode)
            {
                case Zd1jI2cMode.Host:
                    HostTransfer(address, data, []);
                    break;
                case Zd1jI2cMode.Core1 when CommandChannel:
                    QueueTransfer(address, data, 0);
                    break;
                default:
                    if (RingSlot(address, data) is { } slot) QueueRing(slot);
                    else
                    {
                        PushRing();
                        Mailbox(address, data, []);
                    }
                    break;
            }
            Trace("書く", address, started);
        }
    }

    public void WriteRead(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        lock (_gate)
        {
            I2cTransfers++;
            var started = Stopwatch.GetTimestamp();
            switch (Mode)
            {
                case Zd1jI2cMode.Host:
                    HostTransfer(address, write, read);
                    break;
                case Zd1jI2cMode.Core1 when CommandChannel:
                    if (read.Length > 32) throw new ArgumentOutOfRangeException(nameof(read));
                    QueueTransfer(address, write, read.Length);
                    SendChunk().AsSpan(0, read.Length).CopyTo(read);
                    break;
                default:
                    // 溜めはコア 1 が箱より先に済ませるので、流しておけば書き込みが先に届く
                    PushRing();
                    Mailbox(address, write, read);
                    break;
            }
            Trace("読む", address, started);
        }
    }

    public void Modify16(byte address, ushort register, ushort keep, ushort set)
    {
        lock (_gate)
        {
            I2cTransfers++;
            var started = Stopwatch.GetTimestamp();
            if (Mode == Zd1jI2cMode.Core1 && CommandChannel)
            {
                // 読みかえ書きはコア 1 の上で済ませる (答えを待たない)
                if (_commands.Count + 2 > CommandWords) SendChunk();
                _commands.Add(0x02000000u | ((uint)address << 16) | register);
                _commands.Add(((uint)keep << 16) | set);
            }
            else
            {
                Span<byte> number = [(byte)(register >> 8), (byte)register];
                Span<byte> value = stackalloc byte[2];
                if (Mode == Zd1jI2cMode.Host) HostTransfer(address, number, value);
                else
                {
                    PushRing();
                    Mailbox(address, number, value);
                }
                var next = (ushort)((BinaryPrimitives.ReadUInt16BigEndian(value) & keep) | set);
                Span<byte> data = [(byte)(register >> 8), (byte)register, (byte)(next >> 8), (byte)next];
                if (Mode == Zd1jI2cMode.Host) HostTransfer(address, data, []);
                else QueueRing(RingSlot(address, data) ?? throw new ArgumentException($"アドレス 0x{address:X2} は溜めに入りません"));
            }
            Trace("読みかえ書き", address, started);
        }
    }

    public void Flush()
    {
        lock (_gate)
        {
            if (Mode == Zd1jI2cMode.Host) return;
            if (CommandChannel)
            {
                if (_commands.Count > 0) SendChunk();
                return;
            }
            PushRing();
            WaitRing();
        }
    }

    private void Trace(string what, byte address, long started)
    {
        if (_trace is null) return;
        _trace($"I2C {what} 0x{address:X2} {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F2}ms");
    }

    private static IOException I2cError(int code, byte address) => new(code switch
    {
        1 => $"I2C のバスエラーです (0x{address:X2})",
        2 => $"I2C のアドレス 0x{address:X2} に ACK がありません",
        3 => $"I2C のデータに ACK がありません (0x{address:X2})",
        4 => $"I2C が固まりました (0x{address:X2})",
        _ => $"I2C で知らない誤り {code} です (0x{address:X2})",
    });

    // --- ホストから直に (5.2・5.3) ---

    private void HostTransfer(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        try
        {
            if (write.Length > 0)
            {
                HostIdle(address);
                HostSend((byte)(address & 0xFE), 0x50, 2, address);
                foreach (var b in write) HostSend(b, 0x50, 3, address);
                if (read.Length == 0)
                {
                    HostStop(address);
                    return;
                }
                HostSend((byte)(address | 1), 0x70, 2, address);
            }
            else
            {
                if (read.Length == 0) return;
                HostIdle(address);
                HostSend((byte)(address | 1), 0x50, 2, address);
            }
            for (var i = 0; i < read.Length; i++)
            {
                // 最後の1バイトだけ ACK を返さない
                Write32(I2cControl, i == read.Length - 1 ? 0x50u : 0x58u);
                HostWaitByte(address);
                read[i] = (byte)Read32(I2cData);
            }
            HostStop(address);
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            // バスを止めてから失敗を返す
            Write32(I2cControl, 0x40);
            throw;
        }
    }

    private void HostIdle(byte address)
    {
        for (var i = 0; i < HostSpin; i++)
        {
            if ((Read32(I2cStatus) & 0x80) == 0) return;
        }
        throw I2cError(4, address);
    }

    private void HostWaitByte(byte address)
    {
        for (var i = 0; i < HostSpin; i++)
        {
            var control = Read32(I2cControl);
            if ((control & 0x80) != 0) throw I2cError(1, address);
            if ((control & 0x01) != 0) return;
        }
        throw I2cError(4, address);
    }

    private void HostSend(byte value, uint control, int nack, byte address)
    {
        Write32(I2cData, value);
        Write32(I2cControl, control);
        HostWaitByte(address);
        if ((Read32(I2cStatus) & 0x10) != 0) throw I2cError(nack, address);
    }

    private void HostStop(byte address)
    {
        Write32(I2cControl, 0x40);
        HostIdle(address);
    }

    // --- コア 1 の溜めと箱 ---

    /// <summary>溜めに入る書き込みか (DiB8000 の 4 バイト・DiB0090 の 3 バイト)</summary>
    private static (bool Tuner, int Register, ushort Value)? RingSlot(byte address, ReadOnlySpan<byte> data) => address switch
    {
        Dib8096.DemodAddress when data.Length == 4 => (false, (data[0] << 8) | data[1], BinaryPrimitives.ReadUInt16BigEndian(data[2..])),
        Dib8096.TunerAddress when data.Length == 3 => (true, data[0], BinaryPrimitives.ReadUInt16BigEndian(data[1..])),
        _ => null,
    };

    private void QueueRing((bool Tuner, int Register, ushort Value) slot)
    {
        _ring.Add(slot);
        if (_ring.Count >= Mb86h47Programs.RingSlots) PushRing();
    }

    /// <summary>溜めた書き込みを輪に書く (答えは待たない。空きが無ければコア 1 が済ませるのを待つ)</summary>
    private void PushRing()
    {
        var at = 0;
        while (at < _ring.Count)
        {
            var free = Mb86h47Programs.RingSlots - (int)(_ringPlaced - _ringDone);
            if (free == 0)
            {
                ReadRing(waitFor: _ringPlaced - Mb86h47Programs.RingSlots + 1);
                continue;
            }
            var slot = (int)(_ringPlaced % Mb86h47Programs.RingSlots);
            var count = Math.Min(Math.Min(free, _ring.Count - at), Mb86h47Programs.RingSlots - slot);
            var words = new uint[count];
            for (var i = 0; i < count; i++)
            {
                var (tuner, register, value) = _ring[at + i];
                words[i] = Mb86h47Programs.Slot(_ringPlaced + i, tuner, register, value);
            }
            Write(Core1 + Mb86h47Programs.Core1Ring + (uint)(slot * 4), words);
            _ringPlaced += (uint)count;
            at += count;
        }
        _ring.Clear();
    }

    /// <summary>コア 1 が溜めを全部済ませるまで待つ</summary>
    private void WaitRing() => ReadRing(waitFor: _ringPlaced);

    private void ReadRing(uint waitFor)
    {
        var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency;
        Span<uint> state = stackalloc uint[2];
        while (true)
        {
            Read(Core1 + Mb86h47Programs.Core1RingDone, state);
            _ringDone = state[0];
            if (state[1] != _ringError)
            {
                _ringError = state[1];
                throw I2cError((int)(state[1] & 0xFF), 0x12);
            }
            if ((int)(_ringDone - waitFor) >= 0) return;
            if (Stopwatch.GetTimestamp() > deadline) throw new IOException($"{Zd1j.Model} のブリッジのコア 1 が溜めた I2C を済ませません");
        }
    }

    /// <summary>箱で1回のやり取り (書き 32・読み 32 バイトまで)</summary>
    private void Mailbox(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        if (write.Length > 32 || read.Length > 32) throw new ArgumentOutOfRangeException(nameof(write), "コア 1 の箱は書き 32・読み 32 バイトまで");
        _boxSequence = (byte)(_boxSequence == 0xFF ? 1 : _boxSequence + 1);
        if (write.Length > 0) Write(Box(0), Pack(write));
        Write32(Box(Mb86h47Programs.BoxCommand), ((uint)_boxSequence << 24) | ((uint)address << 16) | ((uint)write.Length << 8) | (uint)read.Length);
        var reply = new uint[1 + (read.Length + 3) / 4];
        var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency;
        while (true)
        {
            Read(Box(Mb86h47Programs.BoxReply), reply);
            if (reply[0] >> 24 == _boxSequence) break;
            if (Stopwatch.GetTimestamp() > deadline) throw new IOException($"{Zd1j.Model} のブリッジのコア 1 が答えません");
        }
        if ((reply[0] & 0xFF) != 0) throw I2cError((int)(reply[0] & 0xFF), address);
        for (var i = 0; i < read.Length; i++) read[i] = (byte)(reply[1 + i / 4] >> (24 - 8 * (i % 4)));
    }

    /// <summary>バイトをビッグエンディアンの語に詰める</summary>
    private static uint[] Pack(ReadOnlySpan<byte> bytes)
    {
        var words = new uint[(bytes.Length + 3) / 4];
        for (var i = 0; i < bytes.Length; i++) words[i / 4] |= (uint)bytes[i] << (24 - 8 * (i % 4));
        return words;
    }

    // --- bulk の塊 (5.5) ---

    private void QueueTransfer(byte address, ReadOnlySpan<byte> write, int read)
    {
        if (write.Length > 255) throw new ArgumentOutOfRangeException(nameof(write));
        var words = Pack(write);
        if (_commands.Count + 1 + words.Length > CommandWords) SendChunk();
        _commands.Add(0x01000000u | ((uint)address << 16) | ((uint)write.Length << 8) | (uint)read);
        _commands.AddRange(words);
    }

    /// <summary>溜めた命令を1つの塊で送り、答えを待つ。読んだバイトを返す</summary>
    private byte[] SendChunk(int probeTimeoutMs = TimeoutMs)
    {
        _chunkSequence = _chunkSequence == uint.MaxValue ? 1 : _chunkSequence + 1;
        var sequence = _chunkSequence;
        var chunk = new byte[Mb86h47Programs.BulkChunk];
        BinaryPrimitives.WriteUInt32BigEndian(chunk, sequence);
        var count = 0;
        var at = 8;
        for (var i = 0; i < _commands.Count; i++)
        {
            BinaryPrimitives.WriteUInt32BigEndian(chunk.AsSpan(at), _commands[i]);
            at += 4;
        }
        // 命令の数 (書くバイトの語は数えない)
        for (var i = 0; i < _commands.Count;)
        {
            var command = _commands[i];
            count++;
            i += command >> 24 == 0x02 ? 2 : 1 + (int)((((command >> 8) & 0xFF) + 3) / 4);
        }
        BinaryPrimitives.WriteUInt32BigEndian(chunk.AsSpan(4), (uint)count);
        BinaryPrimitives.WriteUInt32BigEndian(chunk.AsSpan(Mb86h47Programs.BulkChunk - 4), sequence);
        _commands.Clear();

        _usb.BulkWrite(CommandOut, chunk, TimeoutMs);
        var reply = new byte[64];
        var deadline = Stopwatch.GetTimestamp() + probeTimeoutMs * Stopwatch.Frequency / 1000;
        while (true)
        {
            var left = (int)((deadline - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency);
            if (left <= 0) throw new IOException($"{Zd1j.Model} のブリッジのコア 1 が bulk の塊に答えません");
            var got = _usb.InterruptRead(CommandIn, reply, left);
            if (got < 8) continue;
            // 答えの語の並びは、印 (0xA5) が頭か終わりかで見分ける (FIFO のバイトの並びは仕様書に無い)
            if (reply[0] != Mb86h47Programs.BulkReplyMark && reply[3] == Mb86h47Programs.BulkReplyMark)
            {
                for (var i = 0; i + 4 <= got; i += 4) reply.AsSpan(i, 4).Reverse();
            }
            if (reply[0] != Mb86h47Programs.BulkReplyMark) continue;
            var head = BinaryPrimitives.ReadUInt32BigEndian(reply);
            if (((head >> 8) & 0xFFFF) != (sequence & 0xFFFF)) continue;    // 古い答え
            var info = BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(4));
            var error = (int)(head & 0xFF);
            _chunkSlot++;
            if (_chunkSlot == Mb86h47Programs.BulkSlots) ArmCommandDma();
            if (error != 0)
            {
                throw error == 6
                    ? new IOException($"{Zd1j.Model} のブリッジのコア 1 が知らない命令を受けました (命令 {info >> 16})")
                    : I2cError(error, 0);
            }
            var length = (int)Math.Min(info & 0xFFFF, (uint)Mb86h47Programs.BulkReplyData);
            return reply.AsSpan(8, Math.Min(length, got - 8)).ToArray();
        }
    }

    // ---------------------------------------------------------------------
    // TS (9)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 9.2 流し始めの準備を積む。実際に回すのは待ちの間 (<see cref="Idle"/>) と <see cref="StartStream"/>
    /// </summary>
    public void PrepareStream()
    {
        lock (_gate)
        {
            _prepare.Clear();
            foreach (var step in PrepareSteps()) _prepare.Enqueue(step);
            _prepared = true;
        }
    }

    private IEnumerable<Action> PrepareSteps()
    {
        // TS エンジン (この順に)
        (uint, uint)[] engine =
        [
            (0xD000C4, 0), (0xD00000, 0xFFFFFFFF), (0xD00004, 0x001F33FF), (0xD00000, 0x30030FFF), (0xD00000, 0x00030000),
            (0xD00004, 0x00003305), (0xD01040, 0), (0xD01064, 0), (0xD010A0, 0), (0xD010A4, 0), (0xD010A8, 0),
            (0xD01020, 0x02000000), (0xD01004, 0), (0xD01044, 0x00BC0000), (0xD01048, 0x47000000), (0xD0104C, 0x00FFFFFF),
            (0xD01050, 0), (0xD01060, 0), (0xD01000, 0x06070000), (0xD01080, 0x01000000), (0xD01088, 0), (0xD0108C, 0xFF),
            (0xD01084, 0), (0xD01090, 0x01000000), (0xD02028, 0), (0xD0202C, 0), (0xD02030, 0), (0xD02038, 0),
            (0xD02000, 0x03020300), (0xD02020, 0x00AE4000), (0xD02024, 0x00600000), (0xD00004, 0x00043305),
        ];
        foreach (var (address, value) in engine) yield return () => Write32(address, value);

        // コア 0: 置いて (中身が残っていれば書かない) 走らせる
        yield return () => LoadCore(Core0, Core0Program.Value);
        yield return () => Write32(Core0, CoreRun);

        // USB の DMA と端点 (0xFDBC00 からの USB コアのレジスタは語ごと書く。0xFDBC0C には書かない)
        yield return () => Modify(0xFD8010, 0, 0x000F0000);
        yield return () =>
        {
            Write32(0xFD8200, 1);
            Write32(0xFD8220, 1);
        };
        yield return () => Modify(0xFD8014, 0x000F0000, 0);
        yield return () =>
        {
            Write32(0xFD8240, 0);
            Write32(0xFD82A0, 0);
        };
        yield return () =>
        {
            Write32(0xFD8200, 0);
            Write32(0xFD8204, 0xB09F0000);
            Write32(0xFD8200, 2);
        };
        yield return () =>
        {
            Write32(0xFD8220, 0);
            Write32(0xFD8224, 0xB09F2000);
            Write32(0xFD8220, 2);
        };
        // DMA 8 (EP 0x02 の受け) は、bulk の命令の経路を使っているなら触らない (止めると経路が切れる)
        if (!CommandChannel)
        {
            yield return () =>
            {
                Write32(0xFD8300, 1);
                Write32(0xFD8304, 0x00008004);
            };
        }
        yield return () =>
        {
            Write32(0xFDBD08, 0x00FF6001);
            for (var i = 0; i < 100 && (Read32(0xFDBD08) & 1) != 0; i++)
            {
            }
            Write32(0xFDBD08, 0x00FF6000);
        };
        yield return () => Write32(0xFDBC14, 0x00060030);
    }

    /// <summary>
    /// 待ちの間に、積んである流し始めの準備を1つずつ回す。<paramref name="until"/> (Stopwatch の時刻) を過ぎたら戻る。
    /// 1つ回すごとに錠を外すので、カードの読み書きも挟まる
    /// </summary>
    public void Idle(long until)
    {
        while (Stopwatch.GetTimestamp() < until)
        {
            lock (_gate)
            {
                if (!_prepare.TryDequeue(out var step)) return;
                step();
            }
        }
    }

    /// <summary>9.3 流し始め。準備の残りを済ませ、受け口と書き手を動かす。復調器はもう出力していること</summary>
    public void StartStream()
    {
        lock (_gate)
        {
            if (!_prepared) PrepareStream();
            while (_prepare.TryDequeue(out var step)) step();
            Write32(0xD01020, 0);
            Write32(0xD01040, 0x03000000);
            Write32(0xD010A4, 0x13170400);
            Write32(0xD00484, 0x01000000);
            Write32(0xD00488, 0x206C0000);
            Write32(0xD02010, 0x02000000);
            _prepared = false;
        }
    }

    /// <summary>9.5 流し終わりの 1〜3 (コア 0・受け口・書き手を止める)。出力のハイインピーダンスと読みの取り消しは呼ぶ側</summary>
    public void StopStream()
    {
        lock (_gate)
        {
            _prepare.Clear();
            _prepared = false;
            Write32(Core0, CoreHalt);
            Write32(0xD01040, 0);
            Write32(0xD01020, 0x02000000);
            Write32(0xD02010, 0x04000000);
        }
    }

    // ---------------------------------------------------------------------
    // カードの UART (13)
    // ---------------------------------------------------------------------

    /// <summary>13.3 カードが挿さっているか (割り込みの状態のビット 10 が 0)</summary>
    public bool CardPresent()
    {
        lock (_gate) return (Read32(CardStatus) & (1u << 10)) == 0;
    }

    /// <summary>13.4 カードの電源を切る</summary>
    private void CardOff()
    {
        Modify(CardLines, 0x4, 0);
        Write32(CardCount, 0);
        Modify(CardEnable, 0x4, 0);
        Modify(CardLines, 0xA, 0);
        Write32(CardMask, 1);
        Write32(CardPower, 0);
    }

    /// <summary>13.5 リセット。戻ったらカードが ATR を送ってくる (速さは 9600)</summary>
    public void CardReset()
    {
        lock (_gate) CardOff();
        Thread.Sleep(10);
        lock (_gate)
        {
            Write32(CardStatus, 0x3FF);
            Write32(CardPower, 1);
            Modify(CardLines, 0x4, 0);
            Write32(CardCount, 0);
            Write32(CardEnable, 0);
            Write32(CardEnable, 7);
            Modify(CardLines, 0, 0x8);
            Write32(CardBaud, 0xBA7F);
        }
        Thread.Sleep(2);
        lock (_gate)
        {
            Modify(CardLines, 0, 0x2);
            Write32(CardRxLrc, 0x3B);
            Write32(CardCwt, 9600);
            Write32(CardBwt, 0);
            Write32(CardMask, 0x1FF);
        }
        Thread.Sleep(1);
        lock (_gate) Modify(CardLines, 0, 0x4);
    }

    /// <summary>13.2 速さを変える (速さ・制御・CWT・BWT の順に)</summary>
    public void CardSpeed(uint baud, uint control, uint cwt, uint bwt)
    {
        lock (_gate)
        {
            Write32(CardBaud, baud);
            Write32(CardControl, control);
            Write32(CardCwt, cwt);
            Write32(CardBwt, bwt);
        }
    }

    /// <summary>13.6 受けて読まれていないバイトを、<paramref name="max"/> まで読む。無ければ空</summary>
    public byte[] CardRead(int max)
    {
        lock (_gate)
        {
            var waiting = (int)(Read32(CardCount) >> 16);
            var count = Math.Min(waiting, Math.Max(0, max));
            var received = new byte[count];
            for (var i = 0; i < count; i++) received[i] = (byte)Read32(CardRx);
            return received;
        }
    }

    /// <summary>13.6 T=1 のブロックを LRC まで含めて丸ごと送る</summary>
    public void CardWrite(ReadOnlySpan<byte> block)
    {
        lock (_gate)
        {
            Write32(CardRxLrc, 0);
            Write32(CardTxLrc, 0);
            foreach (var b in block) Write32(CardTx, b);
            Write32(CardStatus, 0x3FF);
            Write32(CardControl, block.Length >= 256 ? 0x280u : 0x200u);
            Write32(CardSend, 1);
        }
    }
}

/// <summary>
/// 9.4 EP 0x81 から来る「4 バイトの到着時刻 + 188 バイトの TS」の 192 バイトの単位をほどいて、188 バイトのパケットにする。
/// 読みの区切りは単位と揃わないので、TS の頭 (単位の 5 バイト目) の 0x47 と、192 バイト先の 0x47 の2つで揃える
/// (TS の中の 0x47 は珍しくないので1つでは信じない)。揃えたあと頭が 0x47 でなくなったら揃え直す
/// </summary>
public sealed class Mb86h47Framer
{
    private const int Unit = 192;
    private const int Stamp = 4;
    private const int Packet = 188;

    private byte[] _work = new byte[Unit * 64];
    private int _carry;
    private bool _locked;

    /// <summary>ほどいたパケットを書き、書いたバイト数を返す。半端は次の呼び出しにつなぐ</summary>
    public int Feed(ReadOnlySpan<byte> data, IBufferWriter<byte> output)
    {
        if (_work.Length < _carry + data.Length) Array.Resize(ref _work, Math.Max(_work.Length * 2, _carry + data.Length));
        data.CopyTo(_work.AsSpan(_carry));
        var length = _carry + data.Length;
        var at = 0;
        var written = 0;
        while (true)
        {
            if (!_locked)
            {
                // 頭の候補: そこと 192 バイト先の両方の TS の頭が 0x47。192 バイト先がまだ来ていなければ次を待つ
                var found = -1;
                for (var i = at; i + Unit + Stamp < length; i++)
                {
                    if (_work[i + Stamp] == 0x47 && _work[i + Unit + Stamp] == 0x47)
                    {
                        found = i;
                        break;
                    }
                }
                if (found < 0)
                {
                    at = Math.Max(at, length - Unit - Stamp);
                    break;
                }
                at = found;
                _locked = true;
            }
            if (length - at < Unit) break;
            if (_work[at + Stamp] != 0x47)
            {
                _locked = false;
                at++;
                continue;
            }
            output.Write(_work.AsSpan(at + Stamp, Packet));
            written += Packet;
            at += Unit;
        }
        at = Math.Clamp(at, 0, length);
        _carry = length - at;
        _work.AsSpan(at, _carry).CopyTo(_work);
        return written;
    }
}
