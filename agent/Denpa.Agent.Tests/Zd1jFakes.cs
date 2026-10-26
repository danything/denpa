using System.Buffers.Binary;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * CECH-ZD1 J の偽物。機材の振る舞いは仕様書から決めた (参考の実装の出力は使っていない)。
 *
 * - DibModel … DiB8000 (0x12) と DiB0090 (0xC0) のレジスタ。書いたものを覚え、確かめの値 (D[896] = 0x01B3、
 *   D[897] = 0x8002、T[0x1A] = 0x0223) と、探索の割り込み (D[1284])・ロックのビット (D[568]) を返す
 * - FakeI2c … DibModel の前に置く II2c。やり取りを1行ずつ控える (D1287=0003、D896? など)
 * - FakeBridgeUsb … MB86H47A のメモリを辞書で持ち、メモリ要求を控える。I2C マスター (0xFD8FE0〜) は
 *   仕様書 5.2 の手順で DibModel に繋がる。TS の EP 0x81 は与えた 192 バイトの単位を返す
 */

/// <summary>DiB8000 と DiB0090 のレジスタ</summary>
internal sealed class DibModel
{
    public readonly Dictionary<int, ushort> Demod = [];
    public readonly Dictionary<int, ushort> Tuner = [];

    /// <summary>確かめの値 (D[896]・D[897]・T[0x1A])。既定は製品 2・パッケージ 1・P1G より前の DiB0090</summary>
    public ushort Id { get; set; } = 0x01B3;
    public ushort Version { get; set; } = 0x8002;
    public ushort TunerId { get; set; } = 0x0223;

    /// <summary>D[568] の TMCC の同期 (ビット 1〜4) を立てるか。実機ではロックしたあとも揃わないことがあった</summary>
    public bool Tmcc { get; set; } = true;

    /// <summary>ロックさせるか (D[568] と探索の割り込み)</summary>
    public bool Signal { get; set; } = true;

    public ushort Read(byte address, int register)
    {
        if (address == Dib8096.DemodAddress)
        {
            return register switch
            {
                896 => Id,
                897 => Version,
                // 探索の割り込み: FFT を探しているあいだ (D[355] = 2) は「FFT の終わり」、ガードを探しているあいだは
                // 電波があれば「成功」(ビット 1)、無ければ「失敗」(ビット 0)
                1284 => Demod.GetValueOrDefault(355) == 2 || !Signal ? (ushort)1 : (ushort)2,
                // 信号・搬送波・TMCC・ロック・階層 A の MPEG のロック
                568 => !Signal ? (ushort)0 : Tmcc ? (ushort)0x3FFE : (ushort)0x3FE0,
                570 => 0x0032,  // 8K・1/8
                493 => 13,
                _ => Demod.GetValueOrDefault(register),
            };
        }
        return register switch
        {
            0x1A => TunerId,
            _ => Tuner.GetValueOrDefault(register),
        };
    }

    public void Write(byte address, int register, ushort value)
    {
        if (address == Dib8096.DemodAddress) Demod[register] = value;
        else Tuner[register] = value;
    }
}

/// <summary>DibModel の前の II2c。やり取りを控える</summary>
internal sealed class FakeI2c(DibModel model) : II2c
{
    public List<string> Log { get; } = [];

    public void Write(byte address, ReadOnlySpan<byte> data)
    {
        if (address == Dib8096.DemodAddress)
        {
            var register = BinaryPrimitives.ReadUInt16BigEndian(data);
            var value = BinaryPrimitives.ReadUInt16BigEndian(data[2..]);
            model.Write(address, register, value);
            Log.Add($"D{register}={value:X4}");
        }
        else
        {
            var value = BinaryPrimitives.ReadUInt16BigEndian(data[1..]);
            model.Write(address, data[0], value);
            Log.Add($"T{data[0]:X2}={value:X4}");
        }
    }

    public void WriteRead(byte address, ReadOnlySpan<byte> write, Span<byte> read)
    {
        var register = address == Dib8096.DemodAddress ? BinaryPrimitives.ReadUInt16BigEndian(write) : write[0];
        BinaryPrimitives.WriteUInt16BigEndian(read, model.Read(address, register));
        Log.Add(address == Dib8096.DemodAddress ? $"D{register}?" : $"T{register:X2}?");
    }

    public void Modify16(byte address, ushort register, ushort keep, ushort set)
    {
        var value = (ushort)((model.Read(address, register) & keep) | set);
        model.Write(address, register, value);
        Log.Add($"D{register}&{keep:X4}|{set:X4}");
    }

    public void Flush()
    {
    }
}

/// <summary>眠らない時計。眠った分だけ進む</summary>
internal sealed class FakeTime : IDibTime
{
    public double NowMs { get; private set; }

    public List<int> Sleeps { get; } = [];

    public void Sleep(int ms)
    {
        Sleeps.Add(ms);
        NowMs += ms;
    }
}

/// <summary>MB86H47A の偽物 (メモリ・I2C マスター・TS の端点)</summary>
internal sealed class FakeBridgeUsb : IUsbDevice
{
    public readonly Dictionary<uint, uint> Memory = [];
    public List<string> Log { get; } = [];
    public DibModel Dib { get; } = new();
    public Queue<byte[]> Ts { get; } = new();
    public bool Disposed { get; private set; }

    public string Name => "usb 1-2";

    public FakeBridgeUsb()
    {
        // 主 CPU の処理の、電源投入時の5語 (仕様書 4.2)
        Memory[0xE9AC0] = 0x9B800000;
        Memory[0xE9AC4] = 0xAA04E40F;
        Memory[0xE9E0C] = 0x9B800000;
        Memory[0xE9E10] = 0xAA04E40D;
        Memory[0xE9D94] = 0xB4279F8D;
    }

    private static uint Address(ushort value, ushort index) => ((uint)(value >> 8) << 16) | index | ((uint)(value & 0xFF) << 24);

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        var address = Address(value, index);
        Log.Add($"R {address:X8}");
        for (var at = 0; at < data.Length; at += 4) BinaryPrimitives.WriteUInt32BigEndian(data[at..], Read(address + (uint)at));
        return data.Length;
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        var address = Address(value, index);
        for (var at = 0; at < data.Length; at += 4)
        {
            var word = BinaryPrimitives.ReadUInt32BigEndian(data[at..]);
            Log.Add($"W {address + (uint)at:X8}={word:X8}");
            Write(address + (uint)at, word);
        }
    }

    // I2C マスター (仕様書 4.5・5.2)
    private const uint I2cStatus = 0xFD8FE0;
    private const uint I2cControl = 0xFD8FE4;
    private const uint I2cData = 0xFD8FF0;
    private byte? _target;
    private bool _reading;
    private readonly List<byte> _written = [];
    private readonly Queue<byte> _answer = new();
    private bool _nack;
    private uint _alive;

    private uint Read(uint address) => address switch
    {
        I2cControl => 0x41,
        I2cStatus => _nack ? 0x10u : 0,
        // コア 1 の生きている印 (箱の +0x7C)。読むたびに進む
        0x17A3F7C => ++_alive,
        _ => Memory.GetValueOrDefault(address),
    };

    private void Write(uint address, uint value)
    {
        Memory[address] = value;
        if (address != I2cControl) return;
        var data = (byte)Memory.GetValueOrDefault(I2cData);
        switch (value)
        {
            case 0x40:
                Deliver();
                _target = null;
                _reading = false;
                break;
            case 0x70:
                Deliver();
                Start(data);
                break;
            case 0x50 when _target is null:
                Start(data);
                break;
            case 0x50 or 0x58 when _reading:
                Memory[I2cData] = _answer.Count > 0 ? _answer.Dequeue() : (byte)0;
                break;
            case 0x50:
                _written.Add(data);
                break;
        }
    }

    private void Start(byte address)
    {
        _target = (byte)(address & 0xFE);
        _nack = _target is not (Dib8096.DemodAddress or Dib8096.TunerAddress);
        _reading = (address & 1) != 0;
        if (!_reading) return;
        // 書いた番号のレジスタを読む (繰り返しスタート)
        var register = _target == Dib8096.DemodAddress ? (_written[0] << 8) | _written[1] : _written[0];
        var value = Dib.Read(_target.Value, register);
        _answer.Clear();
        _answer.Enqueue((byte)(value >> 8));
        _answer.Enqueue((byte)value);
        _written.Clear();
    }

    /// <summary>書くだけのやり取りが終わったら、相手のレジスタに書く</summary>
    private void Deliver()
    {
        if (_target is not { } target || _reading || _written.Count == 0) return;
        if (target == Dib8096.DemodAddress && _written.Count == 4)
        {
            Dib.Write(target, (_written[0] << 8) | _written[1], (ushort)((_written[2] << 8) | _written[3]));
            _written.Clear();
        }
        else if (target == Dib8096.TunerAddress && _written.Count == 3)
        {
            Dib.Write(target, _written[0], (ushort)((_written[1] << 8) | _written[2]));
            _written.Clear();
        }
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Log.Add($"B {endpoint:X2} {data.Length}");
        Packets.Add(data.ToArray());
    }

    public List<byte[]> Packets { get; } = [];

    /// <summary>EP 0x83 の答えを作る (送った塊を見て)。無ければ時間切れ</summary>
    public Func<byte[], byte[]?>? Answer { get; set; }

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        if (Answer is null || Packets.Count == 0) return 0;
        var answer = Answer(Packets[^1]);
        if (answer is null) return 0;
        answer.CopyTo(buffer);
        return answer.Length;
    }

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        Log.Add($"S {endpoint:X2} {transferSize}x{depth}");
        return new FakeIn(this);
    }

    private sealed class FakeIn(FakeBridgeUsb owner) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs)
        {
            lock (owner.Ts)
            {
                if (owner.Ts.TryDequeue(out var chunk))
                {
                    chunk.CopyTo(buffer);
                    return chunk.Length;
                }
            }
            Thread.Sleep(5);
            return 0;
        }

        public void Dispose() => owner.Log.Add("S stop");
    }

    public void Dispose() => Disposed = true;
}
