using System.Buffers.Binary;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * CECH-ZD1 J の偽物。機材の振る舞いは仕様書から決めた (参考の実装の出力は使っていない)。
 *
 * - DibModel … DiB8000 (0x12) と DiB0090 (0xC0) のレジスタ。書いたものを覚え、確かめの値 (D[896] = 0x01B3、
 *   D[897] = 0x8002、T[0x1A] = 0x0223) と、探索の割り込み (D[1284])・ロックのビット (D[568]) を返す
 * - FakeI2c … DibModel の前に置く II2c。やり取りを1行ずつ控える (D1287=0003、D896? など)
 * - FakeBridgeUsb … MB86H47A のメモリを辞書で持ち、メモリ要求を控える。bulk の塊は、コア 1 のプログラムの代わりに
 *   Mb86h47Programs.cs に書いた形どおりに読んで DibModel に届ける (コア 1 の I2C の手順そのものは Mb86h47ProgramsTests.cs が
 *   FR30 の真似で確かめる)。TS の EP 0x81 は与えた 192 バイトの単位を返す
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

/// <summary>
/// MB86H47A の偽物 (メモリ・コア 1・TS の端点)。コア 1 のプログラムの代わりに、bulk の塊を
/// Mb86h47Programs.cs に書いた形どおりに読んで DibModel に届け、EP 0x83 で答える
/// </summary>
internal sealed class FakeBridgeUsb : IUsbDevice
{
    private const uint Box = 0x1700000 + Mb86h47Programs.Core1Box;

    public readonly Dictionary<uint, uint> Memory = [];
    public List<string> Log { get; } = [];
    public DibModel Dib { get; } = new();
    public Queue<byte[]> Ts { get; } = new();
    public bool Disposed { get; private set; }

    /// <summary>コア 1 が動いているふりをする (生きている印が進む)</summary>
    public bool Core1 { get; set; } = true;

    /// <summary>コア 1 が bulk の塊に答えるふりをする</summary>
    public bool Core1Bulk { get; set; } = true;

    public List<byte[]> Packets { get; } = [];

    public string Name => "usb 1-2";

    private uint _alive;
    private int _answered;

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
        for (var at = 0; at < data.Length; at += 4)
        {
            var word = address + (uint)at == Box + Mb86h47Programs.BoxAlive && Core1 ? ++_alive : Memory.GetValueOrDefault(address + (uint)at);
            BinaryPrimitives.WriteUInt32BigEndian(data[at..], word);
        }
        return data.Length;
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        var address = Address(value, index);
        for (var at = 0; at < data.Length; at += 4)
        {
            var word = BinaryPrimitives.ReadUInt32BigEndian(data[at..]);
            Log.Add($"W {address + (uint)at:X8}={word:X8}");
            Memory[address + (uint)at] = word;
        }
    }

    private void Apply(byte address, byte[] data)
    {
        if (address == Dib8096.DemodAddress && data.Length == 4) Dib.Write(address, (data[0] << 8) | data[1], (ushort)((data[2] << 8) | data[3]));
        else if (address == Dib8096.TunerAddress && data.Length == 3) Dib.Write(address, data[0], (ushort)((data[1] << 8) | data[2]));
    }

    private ushort Fetch(byte address, byte[] number) =>
        Dib.Read(address, address == Dib8096.DemodAddress ? (number[0] << 8) | number[1] : number[0]);

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Log.Add($"B {endpoint:X2} {data.Length}");
        Packets.Add(data.ToArray());
    }

    /// <summary>EP 0x83: 答えていない塊があれば、命令を DibModel に届けて答えを作る</summary>
    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        if (!Core1Bulk || _answered >= Packets.Count) return 0;
        var chunk = Packets[_answered++];
        var sequence = BinaryPrimitives.ReadUInt32BigEndian(chunk);
        var count = BinaryPrimitives.ReadUInt32BigEndian(chunk.AsSpan(4));
        var at = 8;
        var output = new List<byte>();
        uint done = 0, error = 0;
        for (; done < count; done++)
        {
            var command = BinaryPrimitives.ReadUInt32BigEndian(chunk.AsSpan(at));
            var address = (byte)(command >> 16);
            if (address is not (Dib8096.DemodAddress or Dib8096.TunerAddress))
            {
                error = 2;
                break;
            }
            if (command >> 24 == 1)
            {
                var write = (int)((command >> 8) & 0xFF);
                var read = (int)(command & 0xFF);
                var bytes = chunk.AsSpan(at + 4, write).ToArray();
                if (read == 0) Apply(address, bytes);
                else
                {
                    var value = Fetch(address, bytes);
                    output.AddRange(new[] { (byte)(value >> 8), (byte)value }.Take(read));
                }
                at += 4 + (write + 3) / 4 * 4;
            }
            else
            {
                var register = (int)(command & 0xFFFF);
                var keepSet = BinaryPrimitives.ReadUInt32BigEndian(chunk.AsSpan(at + 4));
                Dib.Write(address, register, (ushort)((Dib.Read(address, register) & (keepSet >> 16)) | (keepSet & 0xFFFF)));
                at += 8;
            }
        }
        var reply = new byte[8 + (output.Count + 3) / 4 * 4];
        BinaryPrimitives.WriteUInt32BigEndian(reply, 0xA5000000u | ((sequence & 0xFFFF) << 8) | error);
        BinaryPrimitives.WriteUInt32BigEndian(reply.AsSpan(4), (done << 16) | (uint)output.Count);
        output.CopyTo(reply, 8);
        reply.CopyTo(buffer);
        return reply.Length;
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
