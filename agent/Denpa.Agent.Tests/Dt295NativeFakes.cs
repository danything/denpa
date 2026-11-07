using System.Buffers.Binary;
using System.Collections.Concurrent;

namespace Denpa.Agent.Tests;

/*
 * 自前方式 (dt295:) の PIX-DT295 の偽物。機材の振る舞いは仕様書 (dt295-resident/spec.md) から決めた。
 *
 * - メモリをバイトの辞書で持ち、ベンダー要求 0xBC (仕様書 3.1) を受ける。0x80000〜0x9FFFF の窓 (書く側 0xEA3D8・読む側 0xE9EBC の基底)、
 *   wValue 下位 = 1 のマスク付きの書き込み、hook (0xEA6FC) が自前のものに書き換わっていれば、その body を Fr30Machine で動かす
 * - レジスタの振る舞い: I2C コントローラ (仕様書 6.4)、TS の FIFO と確定 (仕様書 8.3.2)、取り込みの開始・停止 (仕様書 8.1.4)、
 *   書くと 0 に戻るレジスタ (0xFDBD10・0xFDBD38)
 * - I2C の先は 2 つの復調 (0x10・0x11) と、レジスタ 0xFE を通した中継の先のチューナー (仕様書 7.0)
 * - bulk IN の EP 0x81 は、FIFO に書いて確定した 512 バイトのパケットを順に返す
 */

/// <summary>復調 1 つとその先のチューナーのレジスタ</summary>
internal sealed class NativeDemod
{
    public readonly Dictionary<int, byte> Regs = [];
    public readonly Dictionary<int, byte> Tuner = [];
    private int _pointer;
    private bool _relayRead;
    private int _tunerPointer;

    public void Write(IReadOnlyList<byte> bytes)
    {
        if (bytes.Count == 0) return;
        if (bytes[0] == 0xFE)
        {
            if (bytes[1] == 0xC1)
            {
                _relayRead = true;
            }
            else if (bytes.Count >= 4 && bytes[2] == 0xFB)
            {
                _tunerPointer = bytes[3];
                _relayRead = false;
            }
            else
            {
                for (var i = 3; i < bytes.Count; i++) Tuner[bytes[2] + i - 3] = bytes[i];
                _relayRead = false;
            }
            return;
        }
        _relayRead = false;
        _pointer = bytes[0];
        for (var i = 1; i < bytes.Count; i++) Regs[bytes[0] + i - 1] = bytes[i];
    }

    /// <summary>レジスタの読み値を、書いた値から作る (あれば)</summary>
    public Func<NativeDemod, int, byte?>? Derive;

    public byte Read()
    {
        if (_relayRead) return Tuner.GetValueOrDefault(_tunerPointer++);
        var register = _pointer++;
        return Derive?.Invoke(this, register) ?? Regs.GetValueOrDefault(register);
    }
}

internal sealed class Dt295Fake : IUsbDevice
{
    public const uint RingBase = 0x8138EC00;

    public readonly Dictionary<uint, byte> Bytes = [];
    public readonly NativeDemod Terrestrial = new();
    public readonly NativeDemod Satellite = new();

    /// <summary>I2C の転送を 1 行ずつ (<c>10 W 01 00</c>、<c>10 R 2</c>)</summary>
    public readonly List<string> I2cLog = [];

    /// <summary>レジスタへの書き込み (アドレスと値)。制御転送で書いたものと、プログラムが書いたものの両方</summary>
    public readonly List<(uint Address, uint Value)> Stores = [];

    /// <summary>制御転送の数</summary>
    public long Controls;

    /// <summary>確定したパケット (512 バイト)</summary>
    public readonly List<byte[]> Packets = [];

    private readonly BlockingCollection<byte[]> _bulk = [];
    private readonly List<byte> _fifo = [];
    private uint _protect = 0xF;
    private bool _clockOn;

    // I2C コントローラ
    private uint _data;
    private uint _control;
    private bool _busy, _done, _read, _nack;
    private int _target;
    private int _readCount;
    private readonly List<byte> _written = [];

    /// <summary>取り込みの書き込み位置 (0x1902028)。取り込みを始めると <see cref="WpOnStart"/> になる</summary>
    public uint Wp;

    public uint WpOnStart;
    public bool CaptureStarted;

    /// <summary>TS の FIFO が空いているか (0xFDBD0C の bit2)</summary>
    public bool FifoReady = true;

    /// <summary>body を動かした CPU (最後の 1 回)</summary>
    public Fr30Machine? Cpu;

    /// <summary>body を動かす前にレジスタを仕込む</summary>
    public Action<Fr30Machine>? CpuSetup;


    public Dt295Fake()
    {
        Put(0xEA3D8, 4, 0x00F00000);
        Put(0xE9EBC, 4, 0x00F00000);
        for (var i = 0; i < 8; i++) Bytes[Dt295NativePrograms.Hook + (uint)i] = Dt295NativePrograms.OriginalHook[i];
        Put(0x1600000, 4, 0x000200FF);
        Put(0x1600004, 4, 0x01000000);
        Put(0xF001F0, 4, 0);                  // 実機は設定の前に 0
        Put(0x1700000, 4, 0x000200FF);      // 補助 CPU を起動する前提 (仕様書 6 章)
        Put(0x1700004, 4, 0x0D8F7FF3);
        Put(0xF1010C, 4, 0x00010000);       // 16 ビットの 0x0001 は上半分
        Put(0xFDBD14, 4, 0x00141004);       // 実機の読み値
        Put(0xFDBD1C, 4, 0x0015000C);
        Put(0xFD8300, 4, 1);
        Put(0xFD8320, 4, 1);
        Put(0xF10118, 4, 0x90000000);
        Put(0xF1011C, 4, 0x479F0000);
        Put(0xF10004, 4, 0x8A010000);       // 実機の読み値。16 ビットの 0x8A01 は、4 の倍数のアドレスでは上半分
        Put(0xF10014, 4, 0x00800000);
        Put(0xFDBC14, 4, 0x84);
        Put(0xFD814C, 4, 0xF);
        // 受信できる状態: T 復調は 0x96 に階層 A・B・C、0x81 の bit4。S 復調は 0xC3 が 0、0xC5 の bit1、TSID の表
        Terrestrial.Regs[0x96] = 0xE0;
        Terrestrial.Regs[0x81] = 0x10;
        Satellite.Regs[0xC5] = 0x02;
        // いま出している TSID (0xE6〜0xE7) は、0x8F〜0x90 に書いた値。0 なら表の最初 (仕様書 7.3.4)
        Satellite.Derive = (demod, register) =>
        {
            if (register is not (0xE6 or 0xE7)) return null;
            var tsid = (demod.Regs.GetValueOrDefault(0x8F) << 8) | demod.Regs.GetValueOrDefault(0x90);
            if (tsid == 0) tsid = 0x4010;
            return (byte)(register == 0xE6 ? tsid >> 8 : tsid);
        };
        foreach (var (entry, i) in new ushort[] { 0x4010, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF }.Select((entry, i) => (entry, i)))
        {
            Satellite.Regs[0xCE + 2 * i] = (byte)(entry >> 8);
            Satellite.Regs[0xCE + 2 * i + 1] = (byte)entry;
        }
    }

    public string Name => "fake DT295";

    // --- メモリ ---

    public void Put(uint address, int size, uint value)
    {
        for (var i = 0; i < size; i++) Bytes[address + (uint)i] = (byte)(value >> (8 * (size - 1 - i)));
    }

    public uint Get(uint address, int size)
    {
        uint value = 0;
        for (var i = 0; i < size; i++) value = (value << 8) | Bytes.GetValueOrDefault(address + (uint)i);
        return value;
    }

    public void PutRing(uint offset, ReadOnlySpan<byte> data)
    {
        for (var i = 0; i < data.Length; i++) Bytes[RingBase + offset + (uint)i] = data[i];
    }

    /// <summary>body を置く (hook を書き換えずにプログラムのテストをするとき)</summary>
    public void PlaceBody(bool hook)
    {
        var image = Dt295NativePrograms.Build();
        for (var i = 0; i < image.Words.Length; i++) Put(Dt295NativePrograms.BodyOrigin + (uint)(i * 4), 4, image.Words[i]);
        if (hook) for (var i = 0; i < 8; i++) Bytes[Dt295NativePrograms.Hook + (uint)i] = image.HookBytes[i];
    }

    // --- レジスタ ---

    /// <summary>true なら I2C のブロック (0xFD8FE0〜) は 0 しか読めず、書いても効かない (主 CPU から I2C が動かない機材)</summary>
    public bool I2cDead;

    /// <summary>true なら制御転送がすべて時間切れになる (実機の USB が止まった様子)</summary>
    public bool Wedged;

    /// <summary>0xF10080〜0xF100FF を読んだ回数。実機では読むと常駐イメージが壊れる語なので、自前方式は読まない</summary>
    public int ReadsF10080;

    /// <summary>カードの UART のモデル。ATR・受信 FIFO・挿入・送ったブロックへの応答 (仕様書 §10)</summary>
    public byte[]? CardAtr;

    public readonly Queue<byte> CardRx = [];
    public bool CardInserted = true;
    public Func<byte[], byte[]>? CardResponder;
    private readonly List<byte> _cardTx = [];
    private bool _cardPower;

    public uint Load(uint address, int size)
    {
        if (address is >= 0xF10080 and <= 0xF100FF) ReadsF10080++;
        if (I2cDead && address is >= 0xFD8FE0 and < 0xFD9000) return 0;
        switch (address)
        {
            case 0xFD8FE0:
                return (_busy ? 0x80u : 0) | (_nack && _busy ? 0x10u : 0);
            case 0xFD8FE4:
                return _control | (_done ? 1u : 0);
            case 0xFD8FF0:
                return _data;
            case 0xFDBD0C:
                return FifoReady ? 4u : 0;
            case 0x1902028:
                return Wp;
            // カードの UART (仕様書 §10): 受信済みの数は上半分、受信 FIFO、割り込みの状態の bit10 (実機の観測: F00224 = 0 で挿さっていれば 1)
            case 0xFEA014:
                return (uint)CardRx.Count << 16;
            case 0xFEA02C:
                return CardRx.Count > 0 ? CardRx.Dequeue() : 0u;
            case 0xFEA01C:
                return CardInserted ? 0x400u : 0u;
            // 0x1600000 のブロックは、0xF10118 に 0xFFFF を書く (仕様書 6 章の手順 2) まで止まっていて、0 しか読めない
            case >= 0x1600000 and < 0x1700000 when !_clockOn:
                return 0;
            default:
                return Get(address, size);
        }
    }

    public void Store(uint address, int size, uint value)
    {
        Stores.Add((address, value));
        if (I2cDead && address is >= 0xFD8FE0 and < 0xFD9000) return;
        switch (address)
        {
            case 0xFEA034:
                _cardPower = value == 1;
                Put(address, size, value);
                return;
            case 0xFEA004:
                Put(address, size, value);
                // 電源が入って、リセットの線 (bit2) が立つと、カードが ATR を送る
                if (_cardPower && (value & 4) != 0 && CardAtr is { } atr) foreach (var b in atr) CardRx.Enqueue(b);
                return;
            case 0xFEA028:
                _cardTx.Add((byte)value);
                return;
            case 0xFEA00C when value == 1:
                if (CardResponder is { } responder) foreach (var b in responder([.. _cardTx])) CardRx.Enqueue(b);
                _cardTx.Clear();
                return;
            case 0xFD8FF0:
                _data = value;
                return;
            case 0xFD8FE4:
                I2cControl(value);
                return;
            case 0xFD814C:
                _protect = value;
                break;
            case 0xFD8300 or 0xFD8320:
                // パルス: 0 を書いた直後でも 1 が読める (実機)
                Put(address, size, 1);
                return;
            case 0xFDBD1C:
                Put(address, size, value | (Get(address, size) & 0xC));
                return;
            case 0xFDBD14:
                // 実機では 0x1004 のビットが、0 を書いても残った (読み取り専用らしい)
                Put(address, size, value | (Get(address, size) & 0x1004));
                return;
            case 0xF10118:
                _clockOn = (value >> 16) == 0xFFFF;
                break;
            case 0xFDBD84:
                _fifo.AddRange([(byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value]);
                return;
            case 0xFDBD0C when value == 4 && _protect == 8:
                if (_fifo.Count != 512) throw new InvalidOperationException($"確定したパケットが 512 バイトではありません ({_fifo.Count})");
                Packets.Add([.. _fifo]);
                _bulk.Add([.. _fifo]);
                _fifo.Clear();
                return;
            case 0x1902010 when value == 0x02000000:
                CaptureStarted = true;
                Wp = WpOnStart;
                return;
            case 0x1902010 when value == 0x04000000:
                CaptureStarted = false;
                return;
            case 0x1902010:
                return;
            case 0x1902028:
                return;
            case 0xFDBD10 or 0xFDBD38 when value == 1:
                Put(address, 4, 0);          // 書くと 0 に戻る (仕様書 8.4 の 6・7)
                return;
        }
        Put(address, size, value);
    }

    // --- I2C コントローラ (仕様書 6.4) ---

    private NativeDemod? Device(int address) => address switch
    {
        0x10 => Terrestrial,
        0x11 => Satellite,
        _ => null,
    };

    private void I2cControl(uint value)
    {
        var wasDone = _done;
        _control = value & ~1u;
        if ((value & 0x10) != 0 && !_busy)
        {
            var b = (byte)_data;
            _busy = true;
            _target = b >> 1;
            _read = (b & 1) != 0;
            _nack = Device(_target) is null;
            _written.Clear();
            _readCount = 0;
            _done = true;
            return;
        }
        if ((value & 0x10) == 0)
        {
            if (_busy) EndTransfer();
            _busy = false;
            _done = false;
            return;
        }
        if (!wasDone || (value & 1) != 0) return;
        _done = true;
        if ((value & 0x20) != 0)
        {
            // 再スタート: ここまでの書きを渡して、読みに切り替える
            if (_written.Count > 0) Device(_target)?.Write(_written);
            I2cLog.Add($"{_target:X2} W {Convert.ToHexString([.. _written])}");
            _written.Clear();
            _read = ((byte)_data & 1) != 0;
            return;
        }
        if (!_read)
        {
            _written.Add((byte)_data);
            return;
        }
        _data = Device(_target)?.Read() ?? 0;
        _readCount++;
    }

    private void EndTransfer()
    {
        if (_read) I2cLog.Add($"{_target:X2} R {_readCount}");
        else if (_written.Count > 0)
        {
            Device(_target)?.Write(_written);
            I2cLog.Add($"{_target:X2} W {Convert.ToHexString([.. _written])}");
        }
        _written.Clear();
    }

    // --- 制御転送 (仕様書 3.1) ---

    private uint Resolve(uint address, bool write)
    {
        if (address is >= 0x80000 and < 0xA0000) return (address & 0x3FFFF) + Get(write ? 0xEA3D8u : 0xE9EBC, 4);
        return address;
    }

    private readonly object _controlGate = new();

    /// <summary>実機の USB は制御転送を 1 つずつ通す。偽物も、複数のスレッド (TS の要求と I2C の読み) から同時に呼ばれても 1 つずつ通す</summary>
    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        lock (_controlGate) return ControlInCore(requestType, request, value, index, data, timeoutMs);
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        lock (_controlGate) ControlOutCore(requestType, request, value, index, data, timeoutMs);
    }

    private int ControlInCore(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        Controls++;
        if (Wedged) throw new IOException("制御転送 (IN) (時間切れ)");
        if (request != 0xBC || requestType != 0xC0) throw new InvalidOperationException("0xBC 以外の IN");
        var address = Resolve(((uint)(value & 0xFF00) << 8) | index, write: false);
        if (data.Length == 4 && (address & 3) == 0)
        {
            BinaryPrimitives.WriteUInt32BigEndian(data, Load(address, 4));
        }
        else
        {
            for (var i = 0; i < data.Length; i++) data[i] = (byte)Load(address + (uint)i, 1);
        }
        return data.Length;
    }

    private void ControlOutCore(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Controls++;
        if (Wedged) throw new IOException("制御転送 (OUT) (時間切れ)");
        if (request != 0xBC || requestType != 0x40) throw new InvalidOperationException("0xBC 以外の OUT");
        var address = ((uint)(value & 0xFF00) << 8) | index;
        var low = (byte)value;
        // boot0 の作業域 W (仕様書 3.1)
        Put(Dt295NativePrograms.Work, 4, address);
        Put(0xC4662, 1, low);
        Put(0xC4664, 2, (uint)data.Length);
        // データ段は W+4 = 0xC4620 に置かれる
        for (var i = 0; i < Math.Min(data.Length, 64); i++) Bytes[0xC4620 + (uint)i] = data[i];
        // 自前の hook のときだけ body を動かす。ほかの hook (常駐方式のもの) は、要求の条件が合わなければ元どおりに通すものとして扱う
        var ours = Dt295NativePrograms.Build().HookBytes;
        var hooked = Enumerable.Range(0, 8).All(i => Bytes.GetValueOrDefault(Dt295NativePrograms.Hook + (uint)i) == ours[i]);
        if (hooked && RunHook()) return;
        var resolved = Resolve(address, write: true);
        if (low == 1)
        {
            var newValue = BinaryPrimitives.ReadUInt32BigEndian(data);
            var mask = BinaryPrimitives.ReadUInt32BigEndian(data[4..]);
            Store(resolved, 4, (Load(resolved, 4) & ~mask) | (newValue & mask));
            return;
        }
        for (var i = 0; i + 4 <= data.Length; i += 4) Store(resolved + (uint)i, 4, BinaryPrimitives.ReadUInt32BigEndian(data[i..]));
    }

    /// <summary>
    /// hook を FR30 で動かす。状態段 (0xEA8C8) に着いたら true。元の分岐先 (0xEA704・0xEA75A) に着いたら false で、元の処理 (普通の書き込み) に進む。
    /// boot0 の hook 直前の状態: R11 = W (0xC461C)、R15 = スタック
    /// </summary>
    private bool RunHook()
    {
        var cpu = new Fr30Machine
        {
            Fetch = address => (ushort)Get(address, 2),
            Load = Load,
            Store = Store,
            Pc = Dt295NativePrograms.Hook,
        };
        for (var i = 0; i < 16; i++) cpu.R[i] = 0x11110000u * (uint)i;
        cpu.R[11] = Dt295NativePrograms.Work;
        cpu.R[15] = 0xC8000;
        cpu.Rp = 0xE9999;
        CpuSetup?.Invoke(cpu);
        Cpu = cpu;
        var stackBefore = cpu.R[15];
        var arrived = 0u;
        var finished = cpu.RunUntil(pc =>
        {
            arrived = pc;
            return pc is Dt295NativePrograms.ContinueMask or Dt295NativePrograms.ContinueWrite or Dt295NativePrograms.StatusStage;
        }, 200_000_000);
        if (!finished) throw new InvalidOperationException("body が戻りません");
        if (cpu.R[15] != stackBefore) throw new InvalidOperationException("body がスタックを戻していません");
        return arrived == Dt295NativePrograms.StatusStage;
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs) => throw new NotSupportedException();

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs) => throw new NotSupportedException();

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        if (endpoint != 0x81) throw new InvalidOperationException("EP 0x81 以外");
        return new Stream(_bulk);
    }

    private sealed class Stream(BlockingCollection<byte[]> bulk) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs)
        {
            var total = 0;
            while (total + 512 <= buffer.Length && bulk.TryTake(out var packet, total == 0 ? timeoutMs : 0))
            {
                packet.CopyTo(buffer[total..]);
                total += packet.Length;
            }
            return total;
        }

        public void Dispose()
        {
        }
    }

    public void Dispose()
    {
    }
}
