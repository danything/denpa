using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * ブリッジの中で動かす FR30 のプログラム (Mb86h47Programs.cs) を、Fr30Machine で動かして仕様書と照らす。
 * 機材のレジスタの振る舞い (I2C マスター・コア 0 のレジスタ) は仕様書から決めた偽物。
 */
public class Mb86h47ProgramsTests
{
    /// <summary>バイトで持つメモリ (ビッグエンディアン)。プログラムも置く</summary>
    private sealed class Memory
    {
        public readonly Dictionary<uint, byte> Bytes = [];

        public void Put(uint address, uint[] words)
        {
            for (var i = 0; i < words.Length; i++) Write(address + (uint)(i * 4), 4, words[i]);
        }

        public uint Read(uint address, int size)
        {
            uint value = 0;
            for (var i = 0; i < size; i++) value = (value << 8) | Bytes.GetValueOrDefault(address + (uint)i);
            return value;
        }

        public void Write(uint address, int size, uint value)
        {
            for (var i = 0; i < size; i++) Bytes[address + (uint)i] = (byte)(value >> (8 * (size - 1 - i)));
        }

        public ushort Fetch(uint address) => (ushort)Read(address, 2);
    }

    // ---------------------------------------------------------------------
    // 主 CPU のルーチン (4.2)
    // ---------------------------------------------------------------------

    private const uint State = 0xC4600;

    private static (Memory Memory, Fr30Machine Cpu) Routine(int bank, bool write, uint address, byte high)
    {
        var routine = Mb86h47Programs.Addressing(bank);
        var memory = new Memory();
        memory.Put(Mb86h47Programs.Banks[bank], routine.Words);
        memory.Write(State + 0x40, 1, high);
        memory.Write(State + 0x44, 4, 0xDEADBEEF);
        var cpu = new Fr30Machine { Load = memory.Read, Store = memory.Write, Fetch = memory.Fetch };
        for (var i = 0; i < 16; i++) cpu.R[i] = 0x11110000u * (uint)i;
        cpu.R[4] = address;
        cpu.R[write ? 10 : 8] = State;
        cpu.Pc = write ? routine.Write : routine.Read;
        var end = write ? Mb86h47Programs.WriteContinue : Mb86h47Programs.ReadContinue;
        if (!cpu.RunUntil(pc => pc == end, 1000)) throw new InvalidOperationException("ルーチンが元の処理の続きへ飛びません");
        return (memory, cpu);
    }

    [Test]
    public async Task アドレスを広げるルーチンは_wValue_の下位バイトを上に足す()
    {
        var (memory, cpu) = Routine(0, write: false, 0x7A3C00, 0x17);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0x177A3C00u);
        // 読む側は h を戻さない
        await Assert.That(memory.Read(State + 0x40, 1)).IsEqualTo(0x17u);
        // 使ってよいのは R0・R1・R4 だけ
        for (var i = 0; i < 16; i++)
        {
            if (i is 0 or 1 or 4) continue;
            await Assert.That(cpu.R[i]).IsEqualTo(i == 8 ? State : 0x11110000u * (uint)i);
        }

        (memory, _) = Routine(1, write: true, 0x100000, 0x82);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0x82100000u);
        // 書く側は h を 0 に戻す
        await Assert.That(memory.Read(State + 0x40, 1)).IsEqualTo(0u);
    }

    [Test]
    public async Task アドレスを広げるルーチンは_0x80000_からの付け替えを残す()
    {
        var (memory, _) = Routine(0, write: false, 0x82008, 0);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0xF02008u);
        (memory, _) = Routine(0, write: true, 0x9FFFC, 0);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0xF1FFFCu);
        // 範囲の外は何もしない
        (memory, _) = Routine(1, write: false, 0x7FFFC, 0);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0xDEADBEEFu);
        (memory, _) = Routine(1, write: true, 0xA0000, 0);
        await Assert.That(memory.Read(State + 0x44, 4)).IsEqualTo(0xDEADBEEFu);
    }

    // ---------------------------------------------------------------------
    // コア 1 (5.2・5.4・5.5)
    // ---------------------------------------------------------------------

    /// <summary>I2C マスターの偽物 (仕様書 4.5・5.2 のレジスタ)。DibModel に繋がる</summary>
    private sealed class I2cMaster(DibModel dib)
    {
        private byte? _target;
        private bool _reading;
        private bool _nack;
        private uint _data;
        private readonly List<byte> _written = [];
        private readonly Queue<byte> _answer = new();
        public readonly List<string> Log = [];

        public bool Handles(uint address) => address is >= 0xFD8FE0 and < 0xFD9000;

        public uint Read(uint address) => address switch
        {
            0xFD8FE0 => _nack ? 0x10u : 0,
            0xFD8FE4 => 0x41,
            0xFD8FF0 => _data,
            _ => 0,
        };

        public void Write(uint address, uint value)
        {
            if (address == 0xFD8FF0) _data = value & 0xFF;
            if (address != 0xFD8FE4) return;
            var data = (byte)_data;
            switch (value)
            {
                case 0x40:
                    Deliver();
                    Log.Add("P");
                    _target = null;
                    _reading = false;
                    break;
                case 0x70:
                    Log.Add("Sr");
                    Start(data);
                    break;
                case 0x50 when _target is null:
                    Log.Add("S");
                    Start(data);
                    break;
                case 0x50 or 0x58 when _reading:
                    Log.Add(value == 0x58 ? "rA" : "rN");
                    _data = _answer.Count > 0 ? _answer.Dequeue() : 0u;
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
            if (!_reading || _nack) return;
            var register = _target == Dib8096.DemodAddress ? (_written[0] << 8) | _written[1] : _written[0];
            var value = dib.Read(_target.Value, register);
            _answer.Clear();
            _answer.Enqueue((byte)(value >> 8));
            _answer.Enqueue((byte)value);
            _written.Clear();
        }

        private void Deliver()
        {
            if (_target is not { } target || _reading || _written.Count == 0) return;
            if (target == Dib8096.DemodAddress && _written.Count == 4) dib.Write(target, (_written[0] << 8) | _written[1], (ushort)((_written[2] << 8) | _written[3]));
            else if (target == Dib8096.TunerAddress && _written.Count == 3) dib.Write(target, _written[0], (ushort)((_written[1] << 8) | _written[2]));
            _written.Clear();
        }
    }

    private sealed class Core1Rig
    {
        public readonly Memory Ram = new();
        public readonly DibModel Dib = new();
        public readonly I2cMaster I2c;
        public readonly List<uint> Fifo = [];
        public readonly List<uint[]> Sent = [];
        public readonly Fr30Machine Cpu;

        public Core1Rig()
        {
            I2c = new I2cMaster(Dib);
            var (words, _) = Mb86h47Programs.Core1();
            Ram.Put(Mb86h47Programs.CoreOrigin, words);
            Cpu = new Fr30Machine
            {
                Fetch = Ram.Fetch,
                Load = (address, size) => I2c.Handles(address) ? I2c.Read(address) : Ram.Read(address, size),
                Store = (address, size, value) =>
                {
                    if (I2c.Handles(address)) I2c.Write(address, value);
                    else if (address == 0xFDBD8C) Fifo.Add(value);
                    else if (address == 0xFDBD1C)
                    {
                        Sent.Add([.. Fifo]);
                        Fifo.Clear();
                    }
                    else Ram.Write(address, size, value);
                },
                Pc = Mb86h47Programs.CoreOrigin,
            };
            Run(2000);
        }

        public void Run(long steps)
        {
            for (var i = 0; i < steps; i++) Cpu.Step();
        }

        private int _slot;
        private uint _sequence;

        /// <summary>bulk の塊を1つ置いて (ホストの SendChunk と同じ形)、答えを待つ。答えの語を返す</summary>
        public uint[] Chunk(int count, params uint[] commands)
        {
            Ram.Write(Mb86h47Programs.Core1Box + Mb86h47Programs.BoxBulkEnable, 4, Mb86h47Programs.BulkEnable);
            var words = new uint[128];
            words[0] = ++_sequence;
            words[1] = (uint)count;
            commands.CopyTo(words, 2);
            words[127] = _sequence;
            Ram.Put(Mb86h47Programs.BulkBuffer + (uint)(_slot * 512), words);
            _slot = (_slot + 1) % Mb86h47Programs.BulkSlots;
            var before = Sent.Count;
            for (var i = 0; i < 400 && Sent.Count == before; i++) Run(100);
            return Sent.Count > before ? Sent[^1] : throw new InvalidOperationException("コア 1 が答えません");
        }
    }

    [Test]
    public async Task コア_1_は生きている印を進め続ける()
    {
        var rig = new Core1Rig();
        var first = rig.Ram.Read(Mb86h47Programs.Core1Box + Mb86h47Programs.BoxAlive, 4);
        rig.Run(1000);
        await Assert.That(rig.Ram.Read(Mb86h47Programs.Core1Box + Mb86h47Programs.BoxAlive, 4)).IsGreaterThan(first);
    }

    [Test]
    public async Task コア_1_の_I2C_は仕様書_5_2_の手順()
    {
        var rig = new Core1Rig();
        var reply = rig.Chunk(1, 0x01120400, 0x05070003);
        await Assert.That(reply[0] & 0xFF).IsEqualTo(0u);
        await Assert.That(rig.Dib.Demod[1287]).IsEqualTo((ushort)3);
        // 5.2: スタート、(書く)、ストップ
        await Assert.That(string.Join(" ", rig.I2c.Log)).IsEqualTo("S P");

        rig.I2c.Log.Clear();
        reply = rig.Chunk(1, 0x01120202, 0x03800000);
        await Assert.That(reply[2] >> 16).IsEqualTo(0x01B3u);
        // 繰り返しスタートで 2 バイト。最後の1バイトだけ ACK を返さない
        await Assert.That(string.Join(" ", rig.I2c.Log)).IsEqualTo("S Sr rA rN P");

        // DiB0090 は番号 1 バイト
        reply = rig.Chunk(1, 0x01C00102, 0x1A000000);
        await Assert.That(reply[2] >> 16).IsEqualTo(0x0223u);
    }

    [Test]
    public async Task コア_1_は_ACK_が無ければ誤り_2_を返してバスを止める()
    {
        var rig = new Core1Rig();
        var reply = rig.Chunk(1, 0x01500100, 0);
        await Assert.That(reply[0] & 0xFF).IsEqualTo(2u);
        await Assert.That(rig.I2c.Log[^1]).IsEqualTo("P");
    }

    [Test]
    public async Task コア_1_は_bulk_の塊の命令を済ませて_EP_0x83_に答える()
    {
        var rig = new Core1Rig();
        rig.Dib.Demod[285] = 0x0021;
        var chunk = new uint[128];
        chunk[0] = 0x00000007;
        chunk[1] = 3;
        chunk[2] = 0x01120400;        // D[1287] ← 3
        chunk[3] = 0x05070003;
        chunk[4] = 0x0212011D;        // D[285] ⇐ (0xFF9F, 0x0060)
        chunk[5] = 0xFF9F0060;
        chunk[6] = 0x01120202;        // D[896] を読む
        chunk[7] = 0x03800000;
        chunk[127] = 0x00000007;
        var slot = Mb86h47Programs.BulkBuffer;
        // 有効の印が無いうちは見ない
        rig.Ram.Put(slot, chunk);
        rig.Run(5000);
        await Assert.That(rig.Sent.Count).IsEqualTo(0);
        rig.Ram.Write(Mb86h47Programs.Core1Box + Mb86h47Programs.BoxBulkEnable, 4, Mb86h47Programs.BulkEnable);
        rig.Run(40000);
        await Assert.That(rig.Sent.Count).IsEqualTo(1);
        var reply = rig.Sent[0];
        await Assert.That(reply[0]).IsEqualTo(0xA5000700u);
        await Assert.That(reply[1]).IsEqualTo((3u << 16) | 2);
        await Assert.That(reply[2] >> 16).IsEqualTo(0x01B3u);
        await Assert.That(rig.Dib.Demod[1287]).IsEqualTo((ushort)3);
        await Assert.That(rig.Dib.Demod[285]).IsEqualTo((ushort)0x0061);
        // 済ませた塊の頭と終わりを消した
        await Assert.That(rig.Ram.Read(slot, 4)).IsEqualTo(0u);
        await Assert.That(rig.Ram.Read(slot + 508, 4)).IsEqualTo(0u);

        // 次の塊は 2 番目の置き場。終わりの通し番号が届くまでは見ない
        var next = slot + 512;
        rig.Ram.Write(next, 4, 8);
        rig.Ram.Write(next + 4, 4, 1);
        rig.Ram.Write(next + 8, 4, 0x01500100);
        rig.Run(5000);
        await Assert.That(rig.Sent.Count).IsEqualTo(1);
        rig.Ram.Write(next + 508, 4, 8);
        rig.Run(20000);
        await Assert.That(rig.Sent.Count).IsEqualTo(2);
        // 0x50 は ACK しない: 誤り 2、済ませた命令 0
        await Assert.That(rig.Sent[1][0]).IsEqualTo(0xA5000802u);
        await Assert.That(rig.Sent[1][1]).IsEqualTo(0u);
    }

    // ---------------------------------------------------------------------
    // コア 0 (11.2)
    // ---------------------------------------------------------------------

    private sealed class Core0Rig
    {
        public readonly Memory Ram = new();
        public readonly List<string> Stores = [];
        public readonly Fr30Machine Cpu;
        public uint Event;
        public uint WriterAt = 0x1230;
        public uint ReaderAt = 0x40;
        public ushort FifoHigh = 0x100;
        public ushort FifoLow = 0x100;

        public Core0Rig()
        {
            var (words, _) = Mb86h47Programs.Core0();
            Ram.Put(Mb86h47Programs.CoreOrigin, words);
            Cpu = new Fr30Machine
            {
                Fetch = Ram.Fetch,
                Load = (address, size) => address switch
                {
                    0x0020 => Event,
                    0x1068 => 0,
                    0x1048 => ReaderAt,
                    0x2000 => 0,
                    0xD02038 => WriterAt,
                    0x10068 => FifoHigh,
                    0x10058 => FifoLow,
                    _ when address >= Mb86h47Programs.CoreOrigin => Ram.Read(address, size),
                    _ => 0,
                },
                Store = (address, size, value) =>
                {
                    if (address is >= Mb86h47Programs.CoreOrigin and < 0xA4000) Ram.Write(address, size, value);
                    else Stores.Add(size == 2 ? $"{address:X}:{value:X}h" : $"{address:X}={value:X}");
                },
                Pc = Mb86h47Programs.CoreOrigin,
            };
        }

        public void Run(long steps)
        {
            for (var i = 0; i < steps; i++) Cpu.Step();
        }
    }

    [Test]
    public async Task コア_0_は仕様書_11_2_の順にレジスタを書いてから回る()
    {
        var rig = new Core0Rig();
        rig.Run(400);
        var expected = string.Join(" ",
            "0=77", "0=0", "4=FFFFFFFF", "30=4041FF", "50=4041FF", "90=FFFFFFFF", "B8=FFFFFFFF", "C8=FFFFFFFF", "10=FFFFFFFF", "20=FFFFFFFF", "40=0",
            "1060=300", "1064=300", "1068=300", "106C=300", "10B0=300", "10B4=300",
            "1018=AE4000", "1028=600000", "1048=1230", "1038=1230", "1000=FFF00000",
            "10010:0h", "10030:0h", "10034:800h", "10038:1000h", "1003C:1840h", "10040:1840h",
            "10080:B8h", "10084:B8h", "10088:C0h", "1008C:B8h", "100B0:1880h", "100B4:1900h",
            "2020=0", "2024=0", "202C=3000400", "2030=5010101", "3008=0", "5000=411080C0", "5008=10000000", "5004=1000000", "200C=1000000",
            "1078=460", "1068=1000000");
        await Assert.That(string.Join(" ", rig.Stores.Take(45))).IsEqualTo(expected);
        // 回る間は DMA 2 の読んでよい所を書き手の位置まで進める。満たし中なので満たさない
        await Assert.That(rig.Stores.Skip(45).Take(3)).IsEquivalentTo(new[] { "1038=1230", "1038=1230", "1038=1230" });
    }

    [Test]
    public async Task コア_0_は単位を送り_10_単位ごとに読んだ位置を返す()
    {
        var rig = new Core0Rig();
        rig.Run(400);
        rig.Stores.Clear();
        // FIFO を満たし終わった印 (ビット 29) と送れる単位 (ビット 5)
        rig.Event = 0x20000020;
        rig.Run(200);
        await Assert.That(rig.Stores).Contains("20=20000000");
        await Assert.That(rig.Stores).Contains("2000=D000041");
        var send = rig.Stores.IndexOf("20=8");
        await Assert.That(string.Join(" ", rig.Stores.Skip(send).Take(4))).IsEqualTo("20=8 200C=1000000 2004=BF 2000=D000041");
        rig.Event = 0x20;
        rig.Run(2000);
        // 10 単位ごとに、DMA 2 の読んだ位置の 8 バイト手前を書き手に返す
        await Assert.That(rig.Stores).Contains("D0202C=38");
        // 8 未満ならリングの終わりへ回す
        rig.ReaderAt = 4;
        rig.Stores.Clear();
        rig.Run(2000);
        await Assert.That(rig.Stores).Contains($"D0202C={4 + 0x600000 - 8:X}");
    }

    [Test]
    public async Task コア_0_は空きが_0x470_を超えたら満たす()
    {
        static Core0Rig Drained()
        {
            var rig = new Core0Rig { FifoHigh = 0x180, FifoLow = 0x80 };   // 空き 0x100 (満たさない)
            rig.Run(400);
            rig.Event = 0x20000000;       // 満たし終わり (送れる単位は無い)
            rig.Run(40);
            rig.Event = 0;
            rig.Stores.Clear();
            return rig;
        }
        var rig = Drained();
        rig.Run(100);
        await Assert.That(rig.Stores).DoesNotContain("1078=460");
        rig.FifoHigh = 0x500;             // 空き 0x480
        rig.Run(60);
        await Assert.That(rig.Stores).Contains("1078=460");
        // 空きが負ならリングの大きさ (0x840) を足す: 0x500 - 0x80 は 0x480 だが、逆だと 0x80 - 0x500 + 0x840 = 0x3C0 で満たさない
        var again = Drained();
        again.FifoHigh = 0x80;
        again.FifoLow = 0x500;
        again.Run(200);
        await Assert.That(again.Stores).DoesNotContain("1078=460");
        // 0 ならリングの大きさとみて満たす
        var empty = Drained();
        empty.FifoHigh = 0x80;
        empty.Run(100);
        await Assert.That(empty.Stores).Contains("1078=460");
    }
}
