// Copyright 2026 Till0196
// SPDX-License-Identifier: Apache-2.0
//
// coax (https://github.com/Till0196/coax) 2d9f2c2 の internal/coaxd/usb/bridge/mb86h47
// (mb86h47.go・addressing.go・i2c.go・command.go・stream.go・card.go) を C# に移したもの。
// 元は Apache-2.0 OR GPL-2.0-or-later で、ここでは Apache-2.0 を選んでいる (agent/NOTICE)。
// ホストが直に I2C を叩く形 (HostTransfer) は denpa で足した。

using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// I2C の相手に話す口。DiB8000・DiB0090 (Dib8096.cs) はこれと「待つ」だけを受け取る。
/// **書き込みは溜められることがある** (コア 1 の形)。読む・<see cref="Flush"/> の前に溜めたものが先に出る
/// </summary>
public interface II2c
{
    /// <summary>書く (8 ビット表記のアドレス)</summary>
    void Write(byte address, ReadOnlySpan<byte> data);

    /// <summary>書いて、繰り返しスタートで読む</summary>
    void WriteRead(byte address, ReadOnlySpan<byte> write, Span<byte> read);

    /// <summary>2 バイトの番号の 16 ビットのレジスタを読みかえ書き: <c>(値 &amp; keep) | set</c></summary>
    void Modify16(byte address, ushort register, ushort keep, ushort set);

    /// <summary>溜めた書き込みを機材まで届ける</summary>
    void Flush();
}

/// <summary>I2C の流し方 (環境変数 <c>DENPA_ZD1J_I2C</c>)。速さを比べるために切り替えられる</summary>
public enum Zd1jI2cMode
{
    /// <summary>ホストがメモリ要求で I2C マスターを1バイトずつ叩く</summary>
    Host,

    /// <summary>コア 1 にやらせる。bulk の命令の経路が答えればそれ、答えなければメモリ要求のリング (既定)</summary>
    Core1,

    /// <summary>コア 1 にやらせるが、bulk の命令の経路は使わない (メモリ要求のリングだけ)</summary>
    Core1Ring,
}

/// <summary>
/// 富士通 MB86H47A (CECH-ZD1 J の USB ブリッジ)。**全部のメモリ要求をここで1つずつ通す** (I2C もカードの UART も
/// メモリ要求なので)。TS の EP 0x81 の読みは別の経路で、ここを通らない。
///
/// <para>
/// 失敗は <see cref="IOException"/>。抜かれたら <see cref="UsbGoneException"/>。
/// </para>
/// </summary>
public sealed class Mb86h47 : II2c
{
    private const byte RequestMemory = 0xBC;
    private const byte VendorOut = 0x40;
    private const byte VendorIn = 0xC0;
    private const int ControlTimeoutMs = 1000;

    private const uint GpioDirection = 0x90014;
    private const uint GpioValue = 0x90018;

    /// <summary>電源投入のままなら 0 (spec 4.1)</summary>
    private const uint AddressState = 0x82008;

    private const int ReadLimit = 64;
    private const int WriteLimit = 64;

    private readonly IUsbDevice _usb;
    private readonly Lock _gate = new();
    private readonly Action<string>? _trace;

    /// <summary>メモリ要求の回数 (制御転送と、bulk の命令の塊)</summary>
    public long Requests => Interlocked.Read(ref _requests);
    private long _requests;

    /// <summary>I2C のやり取りの回数 (書く・読む・読みかえ書き 1回ずつ)</summary>
    public long I2cTransfers => Interlocked.Read(ref _i2cTransfers);
    private long _i2cTransfers;

    public Zd1jI2cMode Mode { get; }

    /// <summary>bulk の命令の経路が使えている (<see cref="Zd1jI2cMode.Core1"/> でコア 1 が答えた)</summary>
    public bool CommandChannel => _command;

    public Mb86h47(IUsbDevice usb, Zd1jI2cMode mode, Action<string>? trace = null)
    {
        _usb = usb;
        Mode = mode;
        _trace = trace;
    }

    // ---------------------------------------------------------------------
    // メモリ要求 (spec 3)
    // ---------------------------------------------------------------------

    /// <summary>wValue の上位バイト = 番地のビット 16〜23、下位バイト = ビット 24〜31。wIndex = 下位 16 ビット</summary>
    internal static (ushort Value, ushort Index) Setup(uint address) =>
        ((ushort)(((address >> 8) & 0xFF00) | (address >> 24)), (ushort)address);

    private uint Read32(uint address)
    {
        Span<byte> buffer = stackalloc byte[4];
        ReadBlock(address, buffer);
        return BinaryPrimitives.ReadUInt32BigEndian(buffer);
    }

    private void Write32(uint address, uint value)
    {
        Span<byte> buffer = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(buffer, value);
        WriteBlock(address, buffer);
    }

    private void ReadBlock(uint address, Span<byte> buffer)
    {
        var (value, index) = Setup(address);
        Interlocked.Increment(ref _requests);
        var got = _usb.ControlIn(VendorIn, RequestMemory, value, index, buffer, ControlTimeoutMs);
        if (got != buffer.Length) throw new IOException($"MB86H47A の 0x{address:X8} を読めません ({got}/{buffer.Length} バイト)");
    }

    private void WriteBlock(uint address, ReadOnlySpan<byte> data)
    {
        var (value, index) = Setup(address);
        Interlocked.Increment(ref _requests);
        _usb.ControlOut(VendorOut, RequestMemory, value, index, data, ControlTimeoutMs);
    }

    /// <summary>16 ビットのレジスタは語の上位半分。下位はそのまま残す</summary>
    private void Write16(uint address, ushort value) => Write32(address, ((uint)value << 16) | (Read32(address) & 0xFFFF));

    private ushort Read16(uint address) => (ushort)(Read32(address) >> 16);

    private void Set32(uint address, uint bits) => Write32(address, Read32(address) | bits);

    private void Clear32(uint address, uint bits) => Write32(address, Read32(address) & ~bits);

    // ---------------------------------------------------------------------
    // 起動 (spec 4)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 番地を広げ、クロックと I2C マスターを入れ、(コア 1 の形なら) コア 1 を走らせる。
    /// **電源投入のままでなければ断る** (別のドライバが動かしたブリッジは扱えない)
    /// </summary>
    public void Start()
    {
        lock (_gate)
        {
            if (Read16(AddressState) != 0)
            {
                throw new IOException("CECH-ZD1 J のブリッジが電源投入のままではありません (別のドライバが一度動かしています)。CECH-ZD1 J を抜いて挿し直してください");
            }
            Widen();
            Clocks();
            TrapInterrupts();
            I2cInit();
            if (Mode != Zd1jI2cMode.Host)
            {
                Core1Start();
                if (Mode == Zd1jI2cMode.Core1) CommandSetup();
            }
        }
    }

    /// <summary>メモリ要求の処理のうち書き換える語 (spec 4.2)</summary>
    internal readonly record struct HandlerWord(uint Address, uint Original, uint Widened);

    private const uint HandlerReadCheck = 0xE9AC0;
    private const uint HandlerWriteCheck = 0xE9E0C;
    private const uint HandlerWriteShift = 0xE9D94;
    private const uint NopCode = 0x9FA0;
    private const int AddressingBankSize = 0x800;
    private static readonly uint[] AddressingBanks = [0xE1000, 0xE1800];
    private static readonly uint[][] AddressingCode = [Mb86h47Code.Addressing0, Mb86h47Code.Addressing1];

    /// <summary><c>LDI:20 #飛び先, R12</c> と <c>JMP @R12; NOP</c> (spec 4.2)</summary>
    internal static (uint First, uint Second) Jump(uint target) =>
        (((0x9B0Cu | (((target >> 16) & 0xF) << 4)) << 16) | (target & 0xFFFF), 0x970C0000 | NopCode);

    /// <summary>その置き場のルーチンに跳ぶ5語。書き換える順 (ルーチンを置いてから、読む側・書く側・データ段)</summary>
    internal static HandlerWord[] HandlerWords(int bank)
    {
        var read = Jump(AddressingBanks[bank]);
        var write = Jump(AddressingBanks[bank] + Mb86h47Code.AddressingWriteEntry);
        return
        [
            new(HandlerReadCheck, 0x9B800000, read.First),
            new(HandlerReadCheck + 4, 0xAA04E40F, read.Second),
            new(HandlerWriteCheck, 0x9B800000, write.First),
            new(HandlerWriteCheck + 4, 0xAA04E40D, write.Second),
            new(HandlerWriteShift, 0xB4279F8D, (NopCode << 16) | 0x9F8D),
        ];
    }

    /// <summary>跳ぶ語なら飛び先</summary>
    private static uint? JumpTarget(uint word) =>
        ((word >> 16) & 0xFF0F) == 0x9B0C ? (((word >> 20) & 0xF) << 16) | (word & 0xFFFF) : null;

    private static int BankOf(uint address)
    {
        for (var bank = 0; bank < AddressingBanks.Length; bank++)
        {
            if (address >= AddressingBanks[bank] && address < AddressingBanks[bank] + AddressingBankSize) return bank;
        }
        return -1;
    }

    /// <summary>
    /// 番地を 32 ビットに広げる (spec 4.2)。前の起動の残りが自分のものならそのまま、別の中身なら
    /// **使われていないほうの置き場**に置いてから跳ぶ語を1語ずつ切り替える (どの瞬間も完全なルーチンに跳ぶ)
    /// </summary>
    private void Widen()
    {
        var fresh = HandlerWords(0);
        var held = new uint[fresh.Length];
        int bank = -1, jumps = 0, widened = 0;
        for (var i = 0; i < fresh.Length; i++)
        {
            held[i] = Read32(fresh[i].Address);
            var target = JumpTarget(held[i]);
            if (held[i] == fresh[i].Original) continue;
            if (held[i] == fresh[i].Widened && target is null)
            {
                widened++;
            }
            else if (target is { } at && BankOf(at) >= 0 && (bank < 0 || bank == BankOf(at)))
            {
                bank = BankOf(at);
                jumps++;
            }
            else
            {
                throw new IOException($"MB86H47A のメモリ要求の処理 (0x{fresh[i].Address:X}) が知らない中身です。CECH-ZD1 J を抜いて挿し直してください");
            }
        }

        if (jumps + widened < fresh.Length)
        {
            // 書き換えていない (か途中まで)。跳ぶ先はまだ無いので、置き場 0 に置いてよい
            LoadAddressing(0);
            foreach (var word in HandlerWords(0)) Write32(word.Address, word.Widened);
            return;
        }

        var mine = HandlerWords(bank);
        var same = true;
        for (var i = 0; i < mine.Length; i++) same &= held[i] == mine[i].Widened;
        if (same)
        {
            var code = AddressingCode[bank];
            var loaded = new byte[code.Length * 4];
            for (var offset = 0; offset < loaded.Length; offset += ReadLimit)
            {
                ReadBlock(AddressingBanks[bank] + (uint)offset, loaded.AsSpan(offset, Math.Min(ReadLimit, loaded.Length - offset)));
            }
            for (var i = 0; i < code.Length; i++) same &= BinaryPrimitives.ReadUInt32BigEndian(loaded.AsSpan(i * 4)) == code[i];
            if (same) return;
        }

        bank = 1 - bank;
        LoadAddressing(bank);
        var words = HandlerWords(bank);
        for (var i = 0; i < words.Length; i++)
        {
            if (held[i] != words[i].Widened) Write32(words[i].Address, words[i].Widened);
        }
    }

    /// <summary>ルーチンを1語ずつ置いて読み返す (書き換える前なので1語ずつしか書けない)</summary>
    private void LoadAddressing(int bank)
    {
        var code = AddressingCode[bank];
        var at = AddressingBanks[bank];
        for (var i = 0; i < code.Length; i++) Write32(at + (uint)i * 4, code[i]);
        for (var i = 0; i < code.Length; i++)
        {
            var got = Read32(at + (uint)i * 4);
            if (got != code[i]) throw new IOException($"MB86H47A の SRAM 0x{at + i * 4:X} が {got:X8} (置いたのは {code[i]:X8})");
        }
    }

    /// <summary>エンジンのブロックの待機のレジスタ (spec 4.3 の 4)</summary>
    private static readonly uint[] StandbyBlocks =
        [0x14D0000, 0x10D0000, 0x12D0000, 0x13D0000, 0xE70000, 0xC70000, 0xD00000, 0x1600000, 0x1700000];

    /// <summary>クロックと SDRAM (spec 4.3)。意味の多くは分かっていない。そのまま行えば動く</summary>
    private void Clocks()
    {
        Write16(0xF1010C, 0x8201);
        Write16(0xF10114, 0x8008);
        Write16(0xF10118, 0xFFFF);
        foreach (var block in StandbyBlocks) Set32(block + 0x404, 0x00040000);
        Write16(0xF1011C, 0x0006);
        Write16(0xF10128, 0x6000);
        Write16(0xF1012C, 0x4007);
        Write16(0xF12144, 0x0003);
        foreach (var address in new uint[] { 0xF12178, 0xF1217C, 0xF12198, 0xF1219C }) Write16(address, 0x0880);
    }

    private const uint VectorTable = 0xFFC00;
    private const uint TrapStubs = 0xE3000;
    private const uint TrapCommon = 0xE3800;
    private const uint TrapStubStride = 8;

    /// <summary>TrapRecorder が例外を残す所: 印 0x7EA9・ベクター・PC・PS・RP・R15・回数</summary>
    public const uint TrapRecord = 0x41FF0000;

    /// <summary>
    /// 主 CPU の割り込みを塞ぐ (spec 4.4)。例外と使っていないベクターは記録のルーチンに向ける
    /// (参考の実装の形。USB は生きたままなので、止まったときに <see cref="TrapRecord"/> を後から読める)
    /// </summary>
    private void TrapInterrupts()
    {
        for (uint offset = 0; offset < 0x40; offset += 4)
        {
            var word = Read32(0x440 + offset);
            if ((word | 0x1F1F1F1F) != word) Write32(0x440 + offset, word | 0x1F1F1F1F);
        }
        WriteWords(TrapCommon, Mb86h47Code.TrapRecorder);
        WriteWords(TrapStubs, Mb86h47Code.TrapStubs);
        for (uint vector = 1; vector < 256; vector++)
        {
            if (vector is >= 16 and < 20) continue;
            Write32(VectorTable + 0x3FC - 4 * vector, TrapStubs + vector * TrapStubStride);
        }
    }

    /// <summary>語の並びを 64 バイトずつ書く (番地を広げたあと)</summary>
    private void WriteWords(uint address, uint[] words)
    {
        var data = new byte[words.Length * 4];
        for (var i = 0; i < words.Length; i++) BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(i * 4), words[i]);
        for (var offset = 0; offset < data.Length; offset += WriteLimit)
        {
            WriteBlock(address + (uint)offset, data.AsSpan(offset, Math.Min(WriteLimit, data.Length - offset)));
        }
    }

    // I2C マスター (spec 4.5)
    private const uint I2cStatus = 0xFD8FE0;   // bit7 使用中、bit4 ACK 無し
    private const uint I2cControl = 0xFD8FE4;  // bit0 1バイト終わり、bit7 バスエラー
    private const uint I2cClock = 0xFD8FE8;
    private const uint I2cData = 0xFD8FF0;
    private const uint I2cDivider = 0xFD8FF4;
    private const uint I2cUnknown = 0xFD8FF8;

    private void I2cInit()
    {
        Set32(0xFD8010, 0x10);
        Clear32(0xFD8014, 0x10);
        Write32(0xFD80C0, 1);
        Write32(0xFD80C0, 0);
        Write32(0xFD80C4, 0);
        Write16(0x90114, 0x8008);
        Write32(I2cUnknown, 0x06);
        // 0x10 で約 100kHz、0x08 でその倍。0x05 にすると DiB8000 の初期化中に読みを落とす
        Write32(I2cDivider, 0x08);
        Write32(I2cClock, 0x3C);
        Write32(I2cControl, 0x40);
    }

    /// <summary>DiB8096 の電源 (GPIO 6) を入れ、リセット (GPIO 0) を外す (spec 4.6)</summary>
    public void ResetDemodulator(Action<int> sleep)
    {
        lock (_gate)
        {
            Drain();
            var value = Read16(GpioValue);
            var direction = Read16(GpioDirection);
            Write16(GpioValue, (ushort)((value & ~1) | 0x40));
            Write16(GpioDirection, (ushort)(direction | 0x41));
            sleep(50);
            Write16(GpioValue, (ushort)(value | 0x41));
            sleep(10);
        }
    }

    /// <summary>
    /// コアを止めて、入口を書き、プログラムを 16 語ずつ置く (spec 11.1)。**読み返して同じなら書かない**
    /// (前の起動や流し始めが置いたものがそのまま残っていることが多い)
    /// </summary>
    private void Load(uint core, uint origin, uint[] program)
    {
        Write32(core, 0xFFFFFFFF);
        Write32(core + 0xFFFFC, origin);
        var loaded = new byte[64];
        for (var first = 0; first < program.Length; first += 16)
        {
            var count = Math.Min(16, program.Length - first);
            var address = core + origin + (uint)first * 4;
            ReadBlock(address, loaded.AsSpan(0, count * 4));
            for (var i = 0; i < count; i++)
            {
                if (BinaryPrimitives.ReadUInt32BigEndian(loaded.AsSpan(i * 4)) == program[first + i]) continue;
                WriteWords(address, program[first..(first + count)]);
                break;
            }
        }
    }

    // ---------------------------------------------------------------------
    // コア 1 の I2C (spec 5.4。箱とリング)
    //
    // リングは 1 語のスロット 16 個: レジスタの書き込み (1 か 2 バイトの番号のあとに 2 バイト) か読み (2 バイト)。
    //   bit 31 周回 (スロットの番号 / 16 の偶奇)、bit 30 読む、bit 29 1 バイトの番号、
    //   bit 28 読みかえ書き (次のスロットの bit 15-0 がマスク)、bit 27 (28 と一緒に) マスクのスロット、
    //   bit 26-16 レジスタの番号、bit 15-0 書く値
    // 2 バイトの番号は ringAddresses の 1 バイト目のアドレスへ、1 バイトの番号は 2 バイト目へ。
    // 読みは1回のメモリ要求でも済む (wValue の下位バイト 0xFE。番地を広げるルーチンがリングに入れて答えを返す)
    // ---------------------------------------------------------------------

    private const uint Core1Base = 0x1700000;
    private const uint CoreOrigin = 0xA0000;
    private const uint Mailbox = 0xA3F00;
    private const uint MailboxWrite = 0x04;
    private const uint MailboxAlive = 0x7C;
    private const uint MailboxAnswer = 0x80;
    private const int MaxTransfer = 32;

    private const uint RingScratch = 0xA3D00;
    private const uint RingAddresses = 0xA3D40;
    private const uint Ring = 0xA3E00;
    private const uint RingSlots = 16;
    private const uint RingAnswer = 0xA3E40;
    private const uint RingFailure = 0xA3E44;
    private const uint RingLap = 1u << 31;
    private const uint RingRead = 1 << 30;
    private const uint RingShort = 1 << 29;
    private const uint RingModify = 1 << 28;
    private const uint RingMask = 1 << 27;
    private const uint RingRegister = 0x7FF;
    private const uint RingExecute = 0xFE;

    private static readonly TimeSpan I2cTimeout = TimeSpan.FromMilliseconds(500);

    private byte _sequence;
    private uint _ringNext;
    private uint _ringDone;
    private readonly byte[] _ringAddresses = new byte[2];
    private readonly byte[] _ringSent = new byte[256];
    private readonly List<uint> _ringHeld = [];

    private void Core1Start()
    {
        Load(Core1Base, CoreOrigin, Mb86h47Code.Core1);
        // データ RAM は電源投入時の中身が不定。使う前に消す
        foreach (var address in new[] { Mailbox, Mailbox + MailboxAnswer, Mailbox + MailboxAlive, RingScratch, RingAddresses, RingFailure })
        {
            Write32(Core1Base + address, 0);
        }
        WriteBlock(Core1Base + Ring, new byte[RingSlots * 4]);
        // bulk の命令は毎回新しい通し番号から (前の起動の塊と取り違えない)
        _commandSequence = (uint)(Stopwatch.GetTimestamp() & 0x7FFFFFFF) | 1;
        _commandSlot = 0;
        _command = false;
        Write32(Core1Base + CommandVars + CommandSlotVar, CommandBase);
        Write32(Core1Base + CommandVars + CommandErrorVar, 0);
        Write32(Core1Base + CommandVars + CommandExpectVar, _commandSequence);
        // リングはスロット 16 (周回 1) から。答えは1つ前のスロットを指しておく
        Write32(Core1Base + RingAnswer, (RingSlots - 1) << 24);
        Write32(Core1Base, 0xFFFCFFFF);
        _sequence = 0;
        _ringNext = RingSlots;
        _ringDone = RingSlots - 1;
        Array.Clear(_ringAddresses);
        _ringHeld.Clear();
        var before = Read32(Core1Base + Mailbox + MailboxAlive);
        Thread.Sleep(1);
        var after = Read32(Core1Base + Mailbox + MailboxAlive);
        if (before == after) throw new IOException("MB86H47A のコア 1 が動きません");
    }

    private static IOException I2cError(byte address, int code) => new(code switch
    {
        1 => $"I2C のバスエラー (0x{address:X2})",
        2 => $"I2C のアドレス 0x{address:X2} に ACK がありません",
        3 => $"I2C のデータに 0x{address:X2} が ACK しません",
        4 => $"I2C が固まりました (0x{address:X2})",
        _ => $"I2C のやり取りに失敗しました (0x{address:X2}、{code})",
    });

    /// <summary>リングの答えと誤りを読み、コア 1 がどこまで進んだかを知る</summary>
    private uint RingPoll()
    {
        Span<byte> status = stackalloc byte[8];
        ReadBlock(Core1Base + RingAnswer, status);
        var answer = BinaryPrimitives.ReadUInt32BigEndian(status);
        var last = _ringNext - 1;
        _ringDone = last - (byte)((byte)last - (byte)(answer >> 24));
        var failure = BinaryPrimitives.ReadUInt32BigEndian(status[4..]);
        if (failure != 0)
        {
            Write32(Core1Base + RingFailure, 0);
            throw I2cError(_ringSent[(byte)(failure >> 24)], (byte)(failure >> 16));
        }
        return answer;
    }

    /// <summary>番号 <paramref name="done"/> のやり取りが済むまで待つ</summary>
    private uint RingWait(uint done)
    {
        if ((int)(_ringDone - done) >= 0) return 0;
        var deadline = Stopwatch.GetTimestamp() + (long)(I2cTimeout.TotalSeconds * Stopwatch.Frequency);
        for (; ; )
        {
            var answer = RingPoll();
            if ((int)(_ringDone - done) >= 0) return answer;
            if (Stopwatch.GetTimestamp() > deadline) throw new IOException("MB86H47A のコア 1 が I2C に答えません");
        }
    }

    /// <summary>リングにやり取りを1つ溜める。16 個溜まったら送る</summary>
    private void RingPush(byte address, bool isShort, uint access)
    {
        if (isShort) access |= RingShort;
        RingAddress(address, isShort);
        if (_command)
        {
            CommandPush(access);
            return;
        }
        var next = _ringNext;
        if (next / RingSlots % 2 == 1) access |= RingLap;
        _ringHeld.Add(access);
        _ringSent[(byte)next] = address;
        _ringNext++;
        if (_ringHeld.Count == RingSlots) RingFlush();
    }

    /// <summary>その種類のやり取りの相手を <paramref name="address"/> にする (前の相手のぶんが済んでから)</summary>
    private void RingAddress(byte address, bool isShort)
    {
        var kind = isShort ? 1 : 0;
        if (_ringAddresses[kind] == address) return;
        Drain();
        _ringAddresses[kind] = address;
        Write32(Core1Base + RingAddresses, ((uint)_ringAddresses[0] << 24) | ((uint)_ringAddresses[1] << 16));
    }

    /// <summary>溜めたスロットを送る (置き換えるスロットをコア 1 が済ませてから)。リングの終わりまでと頭からの2回</summary>
    private void RingFlush()
    {
        if (_command)
        {
            CommandSend(false);
            return;
        }
        if (_ringHeld.Count == 0) return;
        var last = _ringNext - 1;
        if (last - _ringDone > RingSlots) RingWait(last - RingSlots);
        var first = _ringNext - (uint)_ringHeld.Count;
        var at = 0;
        while (at < _ringHeld.Count)
        {
            var slot = first % RingSlots;
            var count = Math.Min(_ringHeld.Count - at, (int)(RingSlots - slot));
            var data = new byte[count * 4];
            for (var i = 0; i < count; i++) BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(i * 4), _ringHeld[at + i]);
            WriteBlock(Core1Base + Ring + slot * 4, data);
            at += count;
            first += (uint)count;
        }
        _ringHeld.Clear();
    }

    /// <summary>溜めたものを送って、コア 1 が済ませるまで待つ。ホストの形では何もしない</summary>
    private void Drain()
    {
        if (Mode == Zd1jI2cMode.Host) return;
        if (_command)
        {
            CommandSend(true);
            return;
        }
        RingFlush();
        RingWait(_ringNext - 1);
    }

    /// <summary>リングで1つ読む: 溜めたものを先に送り、読みそのものは答えを返す1回のメモリ要求で</summary>
    private ushort RingReadRegister(byte address, bool isShort, uint number)
    {
        RingAddress(address, isShort);
        if (_command)
        {
            var access = RingRead | (number << 16) | (isShort ? RingShort : 0);
            CommandPush(access);
            var values = CommandSend(true);
            if (values.Count == 0) throw new IOException("MB86H47A のコア 1 が bulk の命令に答えません");
            return (ushort)values[^1];
        }
        RingFlush();
        var next = _ringNext;
        if (next - _ringDone > RingSlots) RingWait(next - RingSlots);
        var slot = (next % RingSlots) | ((next / RingSlots % 2) << 4) | (isShort ? 1u << 5 : 0);
        _ringSent[(byte)next] = address;
        _ringNext++;
        Span<byte> status = stackalloc byte[8];
        ReadBlock((RingExecute << 24) | (slot << 16) | number, status);
        var answer = BinaryPrimitives.ReadUInt32BigEndian(status);
        if ((byte)(answer >> 24) == (byte)next)
        {
            _ringDone = next;
            var failure = BinaryPrimitives.ReadUInt32BigEndian(status[4..]);
            if (failure != 0)
            {
                Write32(Core1Base + RingFailure, 0);
                throw I2cError(_ringSent[(byte)(failure >> 24)], (byte)(failure >> 16));
            }
        }
        else
        {
            // 処理のほうが待ちきれなかった。リングには入っているので答えを待つ
            answer = RingWait(next);
        }
        if (((answer >> 16) & 0xFF) != 0) throw I2cError(address, (int)((answer >> 16) & 0xFF));
        return (ushort)answer;
    }

    /// <summary>箱で1回のやり取り (リングに入らない形)。リングの残りが先</summary>
    private byte[] MailboxTransfer(byte address, ReadOnlySpan<byte> write, int readLength)
    {
        if (write.Length > MaxTransfer || readLength > MaxTransfer)
        {
            throw new IOException($"I2C の1回のやり取りは {MaxTransfer} バイトまでです");
        }
        if (_command)
        {
            // 箱はメモリ要求で叩くので、bulk の経路の残りを済ませてから
            CommandSend(true);
        }
        else
        {
            Drain();
        }
        _sequence++;
        if (_sequence == 0) _sequence = 1;
        for (var offset = 0; offset < write.Length; offset += 4)
        {
            Write32(Core1Base + Mailbox + MailboxWrite + (uint)offset, Pack(write, offset));
        }
        Write32(Core1Base + Mailbox, ((uint)_sequence << 24) | ((uint)address << 16) | ((uint)write.Length << 8) | (uint)readLength);
        var answer = new byte[4 + ((readLength + 3) & ~3)];
        var deadline = Stopwatch.GetTimestamp() + (long)(I2cTimeout.TotalSeconds * Stopwatch.Frequency);
        for (; ; )
        {
            ReadBlock(Core1Base + Mailbox + MailboxAnswer, answer);
            if (answer[0] == _sequence) break;
            if (Stopwatch.GetTimestamp() > deadline) throw new IOException($"MB86H47A のコア 1 が I2C (0x{address:X2}) に答えません");
        }
        if (answer[3] != 0) throw I2cError(address, answer[3]);
        return answer[4..(4 + readLength)];
    }

    // ---------------------------------------------------------------------
    // bulk の命令の経路 (spec 5.5)
    //
    // 1 つの塊は EP 0x02 に 512 バイト。DMA が 0x82100000 からのスロットに順に書く。
    //   語 0 通し番号、語 1 bit 31 答えが要る / bit 7-0 語の数、語 2- やり取り (リングのスロットの形。
    //   読みかえ書きはマスクを次の語に)、最後の語 通し番号をもう一度
    // メモリのやり取りは bit 27 だけ: bit 30 読む、bit 29 FIFO (bit 7-0 のバイト数を1つのレジスタへ / から)、
    // 次の語が番地。書くならそのあとに値か、4 バイトずつのバイト。
    // コア 1 は答えを EP 0x83 (interrupt) に: 通し番号、前の答えからの最初の誤り (bit 23-16) と読んだ値の数 (bit 7-0)、値
    // ---------------------------------------------------------------------

    private const uint CommandBase = 0x82100000;
    private const uint CommandSlots = 16;
    private const int CommandSize = 512;
    private const int CommandWords = CommandSize / 4 - 3;
    private const uint CommandAnswer = 1u << 31;
    private const int CommandReads = 14;
    private const uint MemoryAccess = RingMask;
    private const uint MemoryRead = RingRead;
    private const uint MemoryFifo = 1 << 29;
    private const byte EndpointCommand = 0x02;
    private const byte EndpointAnswer = 0x83;
    private const uint CommandVars = 0xA3C00;
    private const uint CommandExpectVar = 0x00;
    private const uint CommandSlotVar = 0x04;
    private const uint CommandErrorVar = 0x14;
    private const int CommandTimeoutMs = 500;

    private bool _command;
    private uint _commandSequence;
    private uint _commandSlot;
    private readonly List<uint> _commandHeld = [];

    /// <summary>EP 0x02 の DMA をスロットに向け、コア 1 が塊に答えるかを確かめる。答えなければリングのまま</summary>
    private void CommandSetup()
    {
        _command = false;
        try
        {
            Write32(0xFD8300, 1);
            Write32(0xFD8304, 0x00008004);
            Write32(0xFDBC14, Read32(0xFDBC14) | 0x00040000);
            Write32(0xFD80B4, Read32(0xFD80B4) | 4);
            Write32(0xFD8510, CommandSize);
            Write32(0xFD8508, CommandBase);
            Write32(0xFD8504, 1);
            // 前の起動が答えの端点に残したものを捨てる
            var stale = new byte[64];
            for (var i = 0; i < 8 && _usb.InterruptRead(EndpointAnswer, stale, 5) > 0; i++)
            {
            }
            _commandHeld.Clear();
            _command = true;
            CommandSend(true);
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            _command = false;
            _trace?.Invoke($"bulk の命令の経路が使えないので、メモリ要求のリングで I2C を流します ({error.Message})");
        }
    }

    private void CommandPush(params ReadOnlySpan<uint> words)
    {
        if (_commandHeld.Count + words.Length > CommandWords) CommandSend(false);
        foreach (var word in words) _commandHeld.Add(word);
    }

    /// <summary>溜めたやり取りを1つの塊で送る。答えが要るか、最後のスロットなら答えを待って読んだ値を返す</summary>
    private List<uint> CommandSend(bool answer)
    {
        if (_commandHeld.Count == 0 && !answer) return [];
        if (_commandSlot == CommandSlots - 1) answer = true;
        var sequence = _commandSequence;
        var packet = new byte[CommandSize];
        BinaryPrimitives.WriteUInt32BigEndian(packet, sequence);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4), (uint)_commandHeld.Count | (answer ? CommandAnswer : 0));
        for (var i = 0; i < _commandHeld.Count; i++) BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8 + i * 4), _commandHeld[i]);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(CommandSize - 4), sequence);
        _commandHeld.Clear();
        try
        {
            Interlocked.Increment(ref _requests);
            _usb.BulkWrite(EndpointCommand, packet, CommandTimeoutMs);
        }
        catch (IOException)
        {
            _command = false;
            throw;
        }
        _commandSequence++;
        _commandSlot++;
        if (!answer) return [];

        var message = new byte[64];
        int got;
        var deadline = Environment.TickCount64 + CommandTimeoutMs;
        for (; ; )
        {
            got = _usb.InterruptRead(EndpointAnswer, message, CommandTimeoutMs);
            if (got >= 8 && BinaryPrimitives.ReadUInt32BigEndian(message) == sequence) break;
            if (Environment.TickCount64 > deadline)
            {
                _command = false;
                throw new IOException("MB86H47A のコア 1 が bulk の命令に答えません");
            }
        }
        if (_commandSlot == CommandSlots)
        {
            // コア 1 が全部のスロットを済ませた。DMA を頭に戻す
            _commandSlot = 0;
            Write32(0xFD8508, CommandBase);
            Write32(0xFD8504, 1);
        }
        var status = BinaryPrimitives.ReadUInt32BigEndian(message.AsSpan(4));
        var count = (int)(status & 0xFF);
        if (8 + count * 4 > got) throw new IOException("MB86H47A のコア 1 の答えが崩れています");
        var values = new List<uint>(count);
        for (var i = 0; i < count; i++) values.Add(BinaryPrimitives.ReadUInt32BigEndian(message.AsSpan(8 + i * 4)));
        var failure = (byte)(status >> 16);
        if (failure != 0) throw I2cError(_ringAddresses[0], failure);
        return values;
    }

    /// <summary><paramref name="data"/> の <paramref name="offset"/> から 4 バイトをビッグエンディアンの語に (足りなければ 0 で埋める)</summary>
    private static uint Pack(ReadOnlySpan<byte> data, int offset)
    {
        uint word = 0;
        for (var i = 0; i < 4; i++) word = (word << 8) | (offset + i < data.Length ? data[offset + i] : 0u);
        return word;
    }

    /// <summary>チップのレジスタを書く。bulk の経路があれば次の塊に溜める</summary>
    private void RegisterWrite(uint address, uint value)
    {
        if (!_command)
        {
            RingFlushIfAny();
            Write32(address, value);
            return;
        }
        CommandPush(MemoryAccess, address, value);
    }

    /// <summary>チップのレジスタを読む (溜めたものが先)</summary>
    private uint RegisterRead(uint address)
    {
        if (!_command)
        {
            RingFlushIfAny();
            return Read32(address);
        }
        CommandPush(MemoryAccess | MemoryRead, address);
        var values = CommandSend(true);
        return values.Count > 0 ? values[^1] : throw new IOException("MB86H47A のコア 1 が bulk の命令に答えません");
    }

    /// <summary>FIFO のレジスタにバイトを順に書く</summary>
    private void FifoWrite(uint address, ReadOnlySpan<byte> data)
    {
        if (!_command)
        {
            RingFlushIfAny();
            foreach (var value in data) Write32(address, value);
            return;
        }
        while (data.Length > 0)
        {
            var chunk = data[..Math.Min(data.Length, 0xFF)];
            data = data[chunk.Length..];
            var words = new List<uint> { MemoryAccess | MemoryFifo | (uint)chunk.Length, address };
            for (var offset = 0; offset < chunk.Length; offset += 4)
            {
                words.Add(Pack(chunk, offset));
            }
            CommandPush([.. words]);
        }
    }

    /// <summary>FIFO のレジスタから <paramref name="length"/> バイトを順に読む (溜めたものが先)</summary>
    private byte[] FifoRead(uint address, int length)
    {
        var data = new List<byte>(length);
        if (!_command)
        {
            RingFlushIfAny();
            while (data.Count < length) data.Add((byte)Read32(address));
            return [.. data];
        }
        while (data.Count < length)
        {
            var chunk = Math.Min(length - data.Count, CommandReads * 4);
            CommandPush(MemoryAccess | MemoryRead | MemoryFifo | (uint)chunk, address);
            foreach (var value in CommandSend(true))
            {
                for (var shift = 24; shift >= 0 && data.Count < length; shift -= 8) data.Add((byte)(value >> shift));
            }
        }
        return [.. data];
    }

    /// <summary>リングに溜めた I2C の書き込みを先に出す (メモリ要求の順番を崩さない)</summary>
    private void RingFlushIfAny()
    {
        if (Mode != Zd1jI2cMode.Host) RingFlush();
    }

    // ---------------------------------------------------------------------
    // ホストが直に I2C を叩く (spec 5.2 / 5.3)
    // ---------------------------------------------------------------------

    /// <summary>バイトを1つ待つ上限。ホストから見ると数ミリ秒で済む</summary>
    private static readonly TimeSpan HostByteTimeout = TimeSpan.FromMilliseconds(100);

    private void HostWaitByte(byte address)
    {
        var deadline = Stopwatch.GetTimestamp() + (long)(HostByteTimeout.TotalSeconds * Stopwatch.Frequency);
        for (; ; )
        {
            var control = Read32(I2cControl);
            if ((control & 0x80) != 0) throw I2cError(address, 1);
            if ((control & 0x01) != 0) return;
            if (Stopwatch.GetTimestamp() > deadline) throw I2cError(address, 4);
        }
    }

    private void HostIdle()
    {
        var deadline = Stopwatch.GetTimestamp() + (long)(HostByteTimeout.TotalSeconds * Stopwatch.Frequency);
        while ((Read32(I2cStatus) & 0x80) != 0 && Stopwatch.GetTimestamp() < deadline)
        {
        }
    }

    private void HostSend(byte address, byte value, uint control, int noAck)
    {
        Write32(I2cData, value);
        Write32(I2cControl, control);
        HostWaitByte(address);
        if ((Read32(I2cStatus) & 0x10) != 0) throw I2cError(address, noAck);
    }

    /// <summary>1回のやり取り (spec 5.2)。失敗したらバスを止めてから投げる</summary>
    private void HostTransfer(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        try
        {
            if (write.Length > 0)
            {
                HostIdle();
                HostSend(address, (byte)(address & 0xFE), 0x50, 2);
                foreach (var value in write) HostSend(address, value, 0x50, 3);
                if (read.Length == 0)
                {
                    Write32(I2cControl, 0x40);
                    HostIdle();
                    return;
                }
                HostSend(address, (byte)(address | 1), 0x70, 2);
            }
            else
            {
                if (read.Length == 0) return;
                HostIdle();
                HostSend(address, (byte)(address | 1), 0x50, 2);
            }
            for (var i = 0; i < read.Length; i++)
            {
                Write32(I2cControl, i == read.Length - 1 ? 0x50u : 0x58u);
                HostWaitByte(address);
                read[i] = (byte)Read32(I2cData);
            }
            Write32(I2cControl, 0x40);
            HostIdle();
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            try
            {
                Write32(I2cControl, 0x40);
            }
            catch (IOException)
            {
                // 止めにも失敗した。元の理由を返す
            }
            throw;
        }
    }

    // ---------------------------------------------------------------------
    // II2c
    // ---------------------------------------------------------------------

    /// <summary>2 バイト (か 1 バイト) の番号を読む。リングに載らない番号なら null</summary>
    private static uint? RingNumber(ReadOnlySpan<byte> data, bool isShort)
    {
        if (isShort) return data[0];
        var number = (uint)BinaryPrimitives.ReadUInt16BigEndian(data);
        return number <= RingRegister ? number : null;
    }

    /// <summary>
    /// 書く。**コア 1 の形では、レジスタの書き込み (3 か 4 バイト) は溜めて答えを待たない** —
    /// 次の読み・<see cref="Flush"/>・流し始めか流し終わりで出る。その失敗はあとの呼び出しが投げる
    /// </summary>
    public void Write(byte address, ReadOnlySpan<byte> data)
    {
        Interlocked.Increment(ref _i2cTransfers);
        lock (_gate)
        {
            if (Mode == Zd1jI2cMode.Host)
            {
                var started = _trace is null ? 0 : Stopwatch.GetTimestamp();
                HostTransfer(address, data, []);
                if (_trace is not null) _trace($"I2C 0x{address:X2} 書く {Convert.ToHexString(data)} {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F2}ms");
                return;
            }
            if (data.Length is 3 or 4 && RingNumber(data, data.Length == 3) is { } number)
            {
                RingPush(address, data.Length == 3, (number << 16) | BinaryPrimitives.ReadUInt16BigEndian(data[^2..]));
                return;
            }
            MailboxTransfer(address, data, 0);
        }
    }

    public void WriteRead(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        Interlocked.Increment(ref _i2cTransfers);
        lock (_gate)
        {
            var started = _trace is null ? 0 : Stopwatch.GetTimestamp();
            if (Mode == Zd1jI2cMode.Host)
            {
                HostTransfer(address, write, read);
            }
            else if (write.Length is 1 or 2 && read.Length == 2 && RingNumber(write, write.Length == 1) is { } number)
            {
                BinaryPrimitives.WriteUInt16BigEndian(read, RingReadRegister(address, write.Length == 1, number));
            }
            else
            {
                MailboxTransfer(address, write, read.Length).CopyTo(read);
            }
            if (_trace is not null)
            {
                _trace($"I2C 0x{address:X2} 読む {Convert.ToHexString(write)} → {Convert.ToHexString(read)} {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F2}ms");
            }
        }
    }

    /// <summary>読みかえ書き。コア 1 の形ではコア 1 の上で済ませ、書き込みと同じく溜める</summary>
    public void Modify16(byte address, ushort register, ushort keep, ushort set)
    {
        if (Mode == Zd1jI2cMode.Host || register > RingRegister)
        {
            Span<byte> number = [(byte)(register >> 8), (byte)register];
            Span<byte> value = stackalloc byte[2];
            WriteRead(address, number, value);
            var next = (ushort)((BinaryPrimitives.ReadUInt16BigEndian(value) & keep) | set);
            Write(address, [(byte)(register >> 8), (byte)register, (byte)(next >> 8), (byte)next]);
            return;
        }
        Interlocked.Increment(ref _i2cTransfers);
        lock (_gate)
        {
            RingAddress(address, false);
            if (_command)
            {
                CommandPush(RingModify | ((uint)register << 16) | set, RingModify | RingMask | keep);
                return;
            }
            // 2 つのスロットは一緒に出す (コア 1 はマスクを待つ)
            if (_ringHeld.Count > RingSlots - 2) RingFlush();
            RingPush(address, false, RingModify | ((uint)register << 16) | set);
            RingPush(address, false, RingModify | RingMask | keep);
        }
    }

    public void Flush()
    {
        if (Mode == Zd1jI2cMode.Host) return;
        lock (_gate)
        {
            var started = _trace is null ? 0 : Stopwatch.GetTimestamp();
            RingFlush();
            if (_trace is not null) _trace($"I2C 溜めた書き込みを送りました {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F2}ms");
        }
    }

    // ---------------------------------------------------------------------
    // TS (spec 9)
    // ---------------------------------------------------------------------

    private const uint RingBase = 0x00AE4000;
    private const uint RingSize = 0x00600000;
    private const uint Core0Base = 0x1600000;

    private List<Action>? _steps;
    private bool _core0Loaded;

    /// <summary>流し始めの準備 (spec 9.2) を1歩ずつ。選局の待ちの間に回せる (<see cref="Idle"/>)</summary>
    private List<Action> StreamSteps()
    {
        var steps = new List<Action>();
        void Put(uint address, uint value) => steps.Add(() => Write32(address, value));

        Put(0xD000C4, 0);
        Put(0xD00000, 0xFFFFFFFF);
        Put(0xD00004, 0x001F33FF);
        Put(0xD00000, 0x30030FFF);
        Put(0xD00000, 0x00030000);
        Put(0xD00004, 0x00003305);
        foreach (var address in new uint[] { 0xD01040, 0xD01064, 0xD010A0, 0xD010A4, 0xD010A8 }) Put(address, 0);
        Put(0xD01020, 0x02000000);
        Put(0xD01004, 0);
        Put(0xD01044, 0x00BC0000);
        Put(0xD01048, 0x47000000);
        Put(0xD0104C, 0x00FFFFFF);
        Put(0xD01050, 0);
        Put(0xD01060, 0);
        Put(0xD01000, 0x06070000);
        Put(0xD01080, 0x01000000);
        Put(0xD01088, 0);
        Put(0xD0108C, 0xFF);
        Put(0xD01084, 0);
        Put(0xD01090, 0x01000000);
        foreach (var address in new uint[] { 0xD02028, 0xD0202C, 0xD02030, 0xD02038 }) Put(address, 0);
        Put(0xD02000, 0x03020300);
        Put(0xD02020, RingBase);
        Put(0xD02024, RingSize);
        Put(0xD00004, 0x00043305);

        // コア 0。一度置いたら次からは止めるだけ
        steps.Add(() =>
        {
            if (!_core0Loaded)
            {
                Load(Core0Base, CoreOrigin, Mb86h47Code.Core0);
                _core0Loaded = true;
            }
            else
            {
                Write32(Core0Base, 0xFFFFFFFF);
            }
        });
        Put(Core0Base, 0xFFFCFFFF);

        steps.Add(() => Set32(0xFD8010, 0x000F0000));
        Put(0xFD8200, 1);
        Put(0xFD8220, 1);
        steps.Add(() => Clear32(0xFD8014, 0x000F0000));
        Put(0xFD8240, 0);
        Put(0xFD82A0, 0);
        Put(0xFD8200, 0);
        Put(0xFD8204, 0xB09F0000);
        Put(0xFD8200, 2);
        Put(0xFD8220, 0);
        Put(0xFD8224, 0xB09F2000);
        Put(0xFD8220, 2);
        // DMA 8 (EP 0x02 の受け) は bulk の命令の経路のもの。止めたままにしておく
        Put(0xFD8300, 1);
        Put(0xFD8304, 0x00008004);
        // USB コアのレジスタは語ごとに書く。0xFDBC0C には書かない (spec 9.2)
        steps.Add(() =>
        {
            Write32(0xFDBD08, 0x00FF6001);
            for (var i = 0; i < 100 && (Read32(0xFDBD08) & 1) != 0; i++)
            {
            }
            Write32(0xFDBD08, 0x00FF6000);
        });
        Put(0xFDBC14, 0x00060030);
        return steps;
    }

    /// <summary>流し始めの準備を溜める。選局の待ちの間に <see cref="Idle"/> が回し、<see cref="StartStream"/> が仕上げる</summary>
    public void PrepareStream()
    {
        lock (_gate) _steps = StreamSteps();
    }

    /// <summary>溜めた準備を <paramref name="until"/> (Stopwatch の時刻) の少し前まで回す</summary>
    public void Idle(long until)
    {
        var margin = Stopwatch.Frequency / 200;  // 5ms
        lock (_gate)
        {
            while (_steps is { Count: > 0 } steps && until - Stopwatch.GetTimestamp() > margin)
            {
                var step = steps[0];
                steps.RemoveAt(0);
                step();
            }
        }
    }

    /// <summary>
    /// 準備を仕上げて (溜めていなければ全部)、受け口と書き手を入れる (spec 9.3)。
    /// **復調器がパラレルで出力していることが先**
    /// </summary>
    public void StartStream()
    {
        lock (_gate)
        {
            RingFlushIfAny();
            foreach (var step in _steps ?? StreamSteps()) step();
            _steps = null;
            Write32(0xD01020, 0);
            Write32(0xD01040, 0x03000000);
            Write32(0xD010A4, 0x13170400);
            Write32(0xD00484, 0x01000000);
            Write32(0xD00488, 0x206C0000);
            Write32(0xD02010, 0x02000000);
        }
    }

    /// <summary>コア 0 と受け口・書き手を止める (spec 9.5 の 1〜3)</summary>
    public void StopStream()
    {
        lock (_gate)
        {
            _steps = null;
            RingFlushIfAny();
            Write32(Core0Base, 0xFFFFFFFF);
            Write32(0xD01040, 0);
            Write32(0xD01020, 0x02000000);
            Write32(0xD02010, 0x04000000);
        }
    }

    // ---------------------------------------------------------------------
    // カードの UART (spec 13)
    // ---------------------------------------------------------------------

    private const uint CardEnable = 0xFEA000;
    private const uint CardLines = 0xFEA004;
    private const uint CardBaud = 0xFEA008;
    private const uint CardSend = 0xFEA00C;
    private const uint CardControl = 0xFEA010;
    private const uint CardFifo = 0xFEA014;
    private const uint CardIrqMask = 0xFEA018;
    private const uint CardIrq = 0xFEA01C;
    private const uint CardCwt = 0xFEA020;
    private const uint CardBwt = 0xFEA024;
    private const uint CardTx = 0xFEA028;
    private const uint CardRx = 0xFEA02C;
    private const uint CardPower = 0xFEA034;
    private const uint CardSentLrc = 0xFEA038;
    private const uint CardReceivedLrc = 0xFEA03C;
    private const uint CardNoCard = 1 << 10;

    /// <summary>UART のレジスタを触る1まとまり。最後に溜めたものを出す</summary>
    private T Card<T>(Func<T> body)
    {
        lock (_gate)
        {
            var result = body();
            if (_command) CommandSend(false);
            return result;
        }
    }

    private void CardSet(uint address, uint bits) => RegisterWrite(address, RegisterRead(address) | bits);

    private void CardClear(uint address, uint bits) => RegisterWrite(address, RegisterRead(address) & ~bits);

    /// <summary>溜めたものが届いてから待つ</summary>
    private void CardPause(int ms)
    {
        if (_command) CommandSend(false);
        Thread.Sleep(ms);
    }

    /// <summary>カードが挿さっているか (spec 13.3。割り込みの状態のビット 10 が 0)</summary>
    public bool CardPresent() => Card(() => (RegisterRead(CardIrq) & CardNoCard) == 0);

    /// <summary>電源を入れ直して、9600 ボーで ATR を受ける用意 (spec 13.5)</summary>
    public void CardReset() => Card(() =>
    {
        CardPowerDown();
        CardPause(10);
        RegisterWrite(CardIrq, 0x3FF);
        RegisterWrite(CardPower, 1);
        CardClear(CardLines, 4);
        RegisterWrite(CardFifo, 0);
        RegisterWrite(CardEnable, 0);
        RegisterWrite(CardEnable, 7);
        CardSet(CardLines, 8);
        RegisterWrite(CardBaud, 0xBA7F);
        CardPause(2);
        CardSet(CardLines, 2);
        RegisterWrite(CardReceivedLrc, 0x3B);
        RegisterWrite(CardCwt, 9600);
        RegisterWrite(CardBwt, 0);
        RegisterWrite(CardIrqMask, 0x1FF);
        CardPause(1);
        CardSet(CardLines, 4);
        return true;
    });

    /// <summary>電源を切る (spec 13.4)</summary>
    private void CardPowerDown()
    {
        CardClear(CardLines, 4);
        RegisterWrite(CardFifo, 0);
        CardClear(CardEnable, 4);
        CardClear(CardLines, 0xA);
        RegisterWrite(CardIrqMask, 1);
        RegisterWrite(CardPower, 0);
    }

    /// <summary>速さを変える (spec 13.2 の 4 つのレジスタ)</summary>
    public void CardSpeed(uint baud, uint control, uint cwt, uint bwt) => Card(() =>
    {
        RegisterWrite(CardBaud, baud);
        RegisterWrite(CardControl, control);
        RegisterWrite(CardCwt, cwt);
        RegisterWrite(CardBwt, bwt);
        return true;
    });

    /// <summary>受けて読まれていないぶんを、<paramref name="most"/> バイトまで読む。無ければ空</summary>
    public byte[] CardRead(int most) => Card(() =>
    {
        var waiting = (int)(RegisterRead(CardFifo) >> 16);
        return waiting == 0 ? [] : FifoRead(CardRx, Math.Min(waiting, most));
    });

    /// <summary>T=1 のブロックを LRC まで丸ごと送る (spec 13.6)</summary>
    public void CardWrite(ReadOnlySpan<byte> block)
    {
        var data = block.ToArray();
        Card(() =>
        {
            RegisterWrite(CardReceivedLrc, 0);
            RegisterWrite(CardSentLrc, 0);
            FifoWrite(CardTx, data);
            RegisterWrite(CardIrq, 0x3FF);
            RegisterWrite(CardControl, data.Length >= 0x100 ? 0x280u : 0x200u);
            RegisterWrite(CardSend, 1);
            return true;
        });
    }
}

/// <summary>
/// EP 0x81 の「4 バイトの到着時刻 + 188 バイトの TS」をほどいて 188 バイトにする (spec 9.4)。
/// **読みの区切りは単位の区切りと揃わない**ので、TS の頭の 0x47 と、192 バイト先の 0x47 の2つで揃える
/// </summary>
public sealed class Mb86h47Framer
{
    public const int Unit = 192;
    public const int Packet = 188;
    private const int Stamp = Unit - Packet;

    private byte[] _work = new byte[Unit * 2];
    private int _carry;

    /// <summary>単位の頭に揃っている。流し始めと、頭が 0x47 でなくなったときは揃え直す</summary>
    private bool _aligned;

    /// <summary><paramref name="raw"/> を足し、まとまった TS を <paramref name="output"/> に書く。書いたバイト数</summary>
    public int Feed(ReadOnlySpan<byte> raw, IBufferWriter<byte> output)
    {
        var length = _carry + raw.Length;
        if (_work.Length < length) Array.Resize(ref _work, Math.Max(length, _work.Length * 2));
        raw.CopyTo(_work.AsSpan(_carry));
        var data = _work.AsSpan(0, length);
        var offset = 0;
        var written = 0;
        while (offset + Unit <= data.Length)
        {
            if (!_aligned)
            {
                offset = Resync(data, offset, out _aligned);
                if (!_aligned) break;
                continue;
            }
            if (data[offset + Stamp] != 0x47)
            {
                _aligned = false;
                offset++;
                continue;
            }
            data.Slice(offset + Stamp, Packet).CopyTo(output.GetSpan(Packet));
            output.Advance(Packet);
            written += Packet;
            offset += Unit;
        }
        _carry = data.Length - offset;
        data[offset..].CopyTo(_work);
        return written;
    }

    /// <summary>次に単位が始まる位置。192 バイト先にも 0x47 があるところ (データがそこまであれば)</summary>
    private static int Resync(ReadOnlySpan<byte> data, int from, out bool found)
    {
        found = true;
        for (var offset = from; offset + Unit <= data.Length; offset++)
        {
            if (data[offset + Stamp] != 0x47) continue;
            var next = offset + Unit + Stamp;
            if (next >= data.Length || data[next] == 0x47) return offset;
        }
        found = false;
        return Math.Max(from, data.Length - Unit + 1);
    }
}
