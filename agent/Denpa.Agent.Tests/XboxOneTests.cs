using System.Collections.Concurrent;

namespace Denpa.Agent.Tests;

/*
 * Xbox One Digital TV Tuner (XboxOne.cs・Dib0700.cs・Mn88472.cs・Tda18250.cs)。本物の機材は無い。
 * 仕様書の計算 (PLL の分周・C/N・ロック・IF・AGC) と、偽の USB (下の FakeXbox) の上で、初期化・選局・TS の取り出しの制御転送の並びを確かめる。
 */
[Timeout(60_000)]
public class XboxOneTests
{
    /// <summary>
    /// 偽の機材。ブリッジの制御転送を仕様書の形で受け、I2C のレジスタを覚える (復調のバンク 0・1・2 とチューナー)。
    /// バンク 0 の 0xF6 はアドレスが進まないレジスタとして、書かれたバイトを <see cref="DemodFirmware"/> に溜める
    /// </summary>
    private sealed class FakeXbox : IUsbDevice
    {
        private readonly Dictionary<byte, byte[]> _registers = [];
        private readonly Dictionary<byte, byte> _pointer = [];

        public string Name => "usb 1-2";

        /// <summary>起きたことの順。制御転送の OUT はデータの 16 進 (<c>out 0C08C0</c>)、IN は <c>in 15</c>・<c>in 12</c></summary>
        public List<string> Log { get; } = [];

        /// <summary>I2C の書き込み (7 ビットアドレスと、レジスタから始まるバイト列)</summary>
        public List<(byte Address, byte[] Data)> Writes { get; } = [];

        public List<byte[]> Bulk { get; } = [];
        public List<byte> DemodFirmware { get; } = [];
        public List<UsbPipe> Endpoints { get; set; } = [new(0x01, 2, 512), new(0x81, 2, 64), new(0x82, 2, 512)];

        /// <summary>ブリッジのファームウェアが動いていない。動かす要求を bulk で受けると false になる</summary>
        public bool Cold { get; set; } = true;

        public uint Ram { get; set; } = 0x00010201;
        public bool Disposed { get; private set; }

        /// <summary>この OUT のデータ (16 進) を失敗させる</summary>
        public Func<string, bool>? FailOut { get; set; }

        /// <summary>偽の TS (null パケット) を流す</summary>
        public BlockingCollection<byte[]> Ts { get; } = [];

        public FakeXbox()
        {
            Set(Mn88472.Bank2, 0xFF, 0x02);
            Set(Mn88472.Bank0, 0xF5, 0x01); // 復調のファームウェアが動いていない
            Set(Mn88472.Bank1, 0x84, 0x08); // ロック
            Set(Mn88472.Bank1, 0xA1, 0x10, 0x00, 0x02, 0x00); // S = 0x1000、N = 0x0200
            Set(Tda18250.Address, 0x00, 0xC7, 0x4A, 0x21);
            Set(Tda18250.Address, 0x08, 0xFF); // 割り込みは全部立っている
            Set(Tda18250.Address, 0x34, 0x1D); // e = 1、s = 13
        }

        public byte[] Bank(byte address) => _registers.TryGetValue(address, out var bank) ? bank : _registers[address] = new byte[256];

        public void Set(byte address, byte register, params byte[] values) => values.CopyTo(Bank(address), register);

        public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
        {
            Log.Add($"in {request:X2}");
            if (request == 0x15)
            {
                if (Cold) throw new IOException("stall");
                data.Clear();
                System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(data[8..], Ram);
                return 16;
            }
            var address = (byte)((value & 0xFF) >> 1);
            var length = (value >> 8) & 0x3F;
            Bank(address).AsSpan(_pointer.GetValueOrDefault(address), length).CopyTo(data);
            return length;
        }

        public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
        {
            Log.Add($"out {Convert.ToHexString(data)}");
            if (FailOut?.Invoke(Convert.ToHexString(data)) == true) throw new IOException("stall");
            if (request != 0x13) return;
            var address = (byte)(data[1] >> 1);
            var payload = data[4..].ToArray();
            if ((data[2] & 0x40) == 0)
            {
                _pointer[address] = payload[0];
                return;
            }
            Writes.Add((address, payload));
            if (address == Mn88472.Bank0 && payload[0] == 0xF6)
            {
                DemodFirmware.AddRange(payload[1..]);
                return;
            }
            payload.AsSpan(1).CopyTo(Bank(address).AsSpan(payload[0]));
        }

        public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
        {
            Bulk.Add(data.ToArray());
            if (data.SequenceEqual(Dib0700.RunRequest)) Cold = false;
        }

        public int Read(byte endpoint, Span<byte> buffer, int timeoutMs) => 0;

        public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
        {
            Log.Add($"stream {endpoint:X2} {transferSize}x{depth}");
            return new Stream(this);
        }

        public IReadOnlyList<UsbPipe> Pipes() => Endpoints;

        public void ClearHalt(byte endpoint) => Log.Add($"clear {endpoint:X2}");

        public void Dispose() => Disposed = true;

        private sealed class Stream(FakeXbox owner) : IUsbInStream
        {
            public int Read(Span<byte> buffer, int timeoutMs)
            {
                if (!owner.Ts.TryTake(out var chunk, timeoutMs)) return 0;
                chunk.CopyTo(buffer);
                return chunk.Length;
            }

            public void Dispose() => owner.Log.Add("stream stop");
        }
    }

    private static readonly byte[] DemodCode = [.. Enumerable.Range(0, Mn88472.FirmwareSize).Select(i => (byte)i)];

    private static XboxOneDevice Started(FakeXbox usb, List<string>? log = null)
    {
        var device = new XboxOneDevice(usb, "Xbox 1-2", _ => { }, (log ?? []).Add);
        device.Start(XboxOne.BridgeFirmware, () => DemodCode);
        return device;
    }

    // ---- 計算 ----

    [Test]
    [Arguments((byte)0x1D, 500_000u, 2, 0, 5)]  // p = 1 (e = 1)、s = 13: 6,551,350
    [Arguments((byte)0x1D, 512_000u, 2, 0, 6)]  // 13 × 515,950 = 6,707,350
    [Arguments((byte)0x27, 500_000u, 3, 1, 2)]  // p = 2 (e = 2)、s = 7: 7,055,300
    [Arguments((byte)0x0D, 500_000u, 2, 0, 5)]  // e = 0 は p = 1
    [Arguments((byte)0x6D, 500_000u, 2, 0, 5)]  // e = 6 は p = 1
    [Arguments((byte)0x5D, 200_000u, 3, 1, 2)]  // e = 5 は p = 16: 16 × 13 × 203,950
    public async Task PLL_の分周は_fvco_の表のとおり(byte status, uint khz, int r, int n, int c)
    {
        await Assert.That(Tda18250.Divider(status, khz)).IsEqualTo((r, n, c));
    }

    [Test]
    public async Task C_N_は_10_log10_8S_N_で_S_か_N_が_0_なら_0_dB()
    {
        await Assert.That(Mn88472.CnDb(1000, 1000)).IsEqualTo(10 * Math.Log10(8));
        await Assert.That(Math.Round(Mn88472.CnDb(0x1000, 0x0200), 6)).IsEqualTo(Math.Round(10 * Math.Log10(64), 6));
        await Assert.That(Mn88472.CnDb(0, 100)).IsEqualTo(0);
        await Assert.That(Mn88472.CnDb(100, 0)).IsEqualTo(0);
    }

    [Test]
    public async Task ロックは_0x84_の下位_4_ビットが_8_以上()
    {
        await Assert.That(Mn88472.IsLocked(0x07)).IsFalse();
        await Assert.That(Mn88472.IsLocked(0xF7)).IsFalse();
        await Assert.That(Mn88472.IsLocked(0x08)).IsTrue();
        await Assert.That(Mn88472.IsLocked(0x0F)).IsTrue();
    }

    [Test]
    public async Task IF_の値は仕様書の例のとおり()
    {
        await Assert.That(Mn88472.IfValue(3_950_000)).IsEqualTo(0x3153ABu);
        await Assert.That(Tda18250.IfRegister(Tda18250.IfKhz)).IsEqualTo((byte)0x4F);
        var rows = Mn88472.Rows(0x3153AB).ToList();
        await Assert.That(rows.Skip(5).Take(3).Select(row => row.Value)).IsEquivalentTo([(byte)0x31, (byte)0x53, (byte)0xAB]);
        await Assert.That(rows[^1]).IsEqualTo((Mn88472.Bank2, (byte)0xF8, (byte)0x9F));
    }

    [Test]
    public async Task AGC_は周波数の境目で値を替える()
    {
        static byte Value(uint hertz, byte register, byte mask) =>
            Tda18250.AgcRows(hertz).First(row => row.Register == register && row.Mask == mask).Value;
        await Assert.That(Value(99_000_000, 0x0C, 0x07)).IsEqualTo((byte)2);
        await Assert.That(Value(100_000_000, 0x0C, 0x07)).IsEqualTo((byte)3);
        await Assert.That(Value(319_000_000, 0x58, 0x1F)).IsEqualTo((byte)26);
        await Assert.That(Value(320_000_000, 0x58, 0x1F)).IsEqualTo((byte)28);
        await Assert.That(Value(320_000_000, 0x20, 0x06)).IsEqualTo((byte)0x04);
        await Assert.That(Value(321_000_000, 0x20, 0x06)).IsEqualTo((byte)0x02);
        await Assert.That(Value(600_000_000, 0x20, 0x06)).IsEqualTo((byte)0x04);
        await Assert.That(Value(600_000_000, 0x16, 0x03)).IsEqualTo((byte)3);
        await Assert.That(Value(800_000_000, 0x12, 0x60)).IsEqualTo((byte)0x20);
        await Assert.That(Value(801_000_000, 0x12, 0x60)).IsEqualTo((byte)0x40);
    }

    // ---- ファームウェア ----

    [Test]
    public async Task ファームウェアのレコードはアドレスの_2_バイトを入れ替えて送る()
    {
        byte[] file = [0x03, 0x34, 0x12, 0x00, 0xAA, 0xBB, 0xCC, 0x5E, 0x00, 0x00, 0x00, 0x01, 0xFF];
        var records = Dib0700.Records(file);
        await Assert.That(records.Count).IsEqualTo(2);
        await Assert.That(Convert.ToHexString(records[0])).IsEqualTo("031234" + "00AABBCC5E");
        await Assert.That(Convert.ToHexString(records[1])).IsEqualTo("00000001FF");
        await Assert.That(() => Dib0700.Records(file.AsSpan(0, 6))).Throws<InvalidDataException>();
        await Assert.That(() => Dib0700.Records(file.AsSpan(0, 8))).Throws<InvalidDataException>();
    }

    [Test]
    public async Task 同梱のブリッジのファームウェアは拡張アドレスで始まり終わりのレコードで終わる()
    {
        var code = XboxOne.BridgeFirmware();
        await Assert.That(code.Length).IsEqualTo(33_768);
        var records = Dib0700.Records(code);
        await Assert.That(Convert.ToHexString(records[0].AsSpan(0, 6))).IsEqualTo("020000047000");
        await Assert.That(Convert.ToHexString(records[^1])).IsEqualTo("00000001FF");
        await Assert.That(records.Sum(record => record.Length)).IsEqualTo(code.Length);
    }

    [Test]
    public async Task 復調のファームウェアが無ければ置く場所を理由に出す()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"xbox-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var missing = await Assert.That(() => XboxOne.DemodFirmware([dir, "/nowhere"])).Throws<IOException>();
            await Assert.That(missing!.Message).Contains(Mn88472.FirmwareName).And.Contains(dir).And.Contains("/nowhere");
            // Android はエージェントの置き場に利用者が書けないので、アプリが写す元の場所を出す
            var android = await Assert.That(() => XboxOne.DemodFirmware([dir], XboxOne.AndroidPlace)).Throws<IOException>();
            await Assert.That(android!.Message).Contains("Android/data/io.github.danything.denpa/files/firmware/").And.DoesNotContain(dir);
            await File.WriteAllBytesAsync(Path.Combine(dir, Mn88472.FirmwareName), new byte[10]);
            var wrong = await Assert.That(() => XboxOne.DemodFirmware([dir])).Throws<IOException>();
            await Assert.That(wrong!.Message).Contains("10 バイト");
            await Assert.That(Mn88472.CheckFirmware(DemodCode)).Contains("SHA-256");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // ---- 初期化・選局・TS の制御転送の並び ----

    [Test]
    public async Task コールドの機材はファームウェアを送ってから電源を入れて初期化する()
    {
        var usb = new FakeXbox();
        using var device = Started(usb);

        var records = Dib0700.Records(XboxOne.BridgeFirmware());
        await Assert.That(usb.Bulk.Count).IsEqualTo(records.Count + 1);
        await Assert.That(usb.Bulk[0]).IsEquivalentTo(records[0]);
        await Assert.That(usb.Bulk[^1]).IsEquivalentTo(Dib0700.RunRequest);
        // バージョン (失敗) → バージョン → GPIO6 を 0・1、GPIO10 を 1・0・1
        var gpio = usb.Log.Where(line => line.StartsWith("out 0C", StringComparison.Ordinal)).ToList();
        await Assert.That(gpio).IsEquivalentTo(["out 0C0880", "out 0C08C0", "out 0C0FC0", "out 0C0F80", "out 0C0FC0"]);
        await Assert.That(usb.Log.Take(2)).IsEquivalentTo(["in 15", "in 15"]);
        await Assert.That(usb.Log.IndexOf("out 0C0880")).IsGreaterThan(1);

        // 復調のファームウェアは 21 バイトずつ、最後は残り
        await Assert.That(usb.DemodFirmware).IsEquivalentTo(DemodCode);
        var chunks = usb.Writes.Where(write => write.Address == Mn88472.Bank0 && write.Data[0] == 0xF6).ToList();
        await Assert.That(chunks.Count).IsEqualTo(96);
        await Assert.That(chunks[^1].Data.Length).IsEqualTo(1 + 2_012 - 95 * 21);
        // 復調の初期化の終わりとチューナーの水晶の値
        await Assert.That(usb.Bank(Mn88472.Bank2)[0x08]).IsEqualTo((byte)0x00);
        await Assert.That(usb.Bank(Mn88472.Bank0)[0xD9]).IsEqualTo((byte)0xE1);
        await Assert.That(usb.Writes).Contains(write => write.Address == Tda18250.Address && Convert.ToHexString(write.Data) == "4D69788D801B");
        // 復調、チューナーの順
        var demodFirst = usb.Writes.FindIndex(write => write.Address == Mn88472.Bank0 && write.Data[0] == 0xF6);
        var tunerInit = usb.Writes.FindIndex(write => write.Address == Tda18250.Address && write.Data[0] == 0x4D);
        await Assert.That(demodFirst).IsLessThan(tunerInit);
    }

    [Test]
    public async Task ウォームの機材と動いている復調にはファームウェアを送らない()
    {
        var usb = new FakeXbox { Cold = false };
        usb.Set(Mn88472.Bank0, 0xF5, 0x00);
        using var device = Started(usb);
        await Assert.That(usb.Bulk).IsEmpty();
        await Assert.That(usb.DemodFirmware).IsEmpty();
    }

    [Test]
    public async Task 選局はチューナーを合わせてから復調を始め_周波数を_kHz_で書く()
    {
        var usb = new FakeXbox();
        using var device = Started(usb);
        usb.Writes.Clear();
        await Assert.That(device.Tune(557_000_000)).IsTrue();

        var frequency = usb.Writes.FindIndex(write => write.Address == Tda18250.Address && Convert.ToHexString(write.Data) == "27087FC8");
        var ifWrite = usb.Writes.FindIndex(write => write.Address == Tda18250.Address && Convert.ToHexString(write.Data) == "264F");
        var demod = usb.Writes.FindIndex(write => write.Address == Mn88472.Bank2 && Convert.ToHexString(write.Data) == "0066");
        await Assert.That(ifWrite).IsGreaterThanOrEqualTo(0);
        await Assert.That(frequency).IsGreaterThan(ifWrite);
        await Assert.That(demod).IsGreaterThan(frequency);
        await Assert.That(Convert.ToHexString(usb.Writes[^1].Data)).IsEqualTo("F89F");
        // e = 1、s = 13 で 13 × (557,000 + 3,950) = 7,292,350 なので r = 3、n = 1、c = 2
        await Assert.That(usb.Bank(Tda18250.Address)[0x4F] & 0xE0).IsEqualTo(0xE0);
        await Assert.That(usb.Bank(Tda18250.Address)[0x46] & 0x07).IsEqualTo(2);
        await Assert.That(device.Signal().Locked).IsTrue();

        // 2 回目は同じ IF を書かない
        usb.Writes.Clear();
        device.Tune(557_000_000);
        await Assert.That(usb.Writes).DoesNotContain(write => write.Address == Tda18250.Address && write.Data[0] == 0x26);
    }

    [Test]
    public async Task ロックしなければ_false()
    {
        var usb = new FakeXbox();
        using var device = Started(usb);
        usb.Set(Mn88472.Bank1, 0x84, 0x07);
        await Assert.That(device.Tune(557_000_000)).IsFalse();
        await Assert.That(device.Signal()).IsEqualTo((false, (double?)null));
    }

    [Test]
    public async Task TS_は転送の長さと出力を送ってから読み_止めるときは読み出しを取り消してから出力を止める()
    {
        var usb = new FakeXbox();
        using var device = Started(usb);
        usb.Log.Clear();
        device.StartTs();
        device.StopTs();
        await Assert.That(usb.Log).IsEquivalentTo(["out 000015", "out 0F100100", "clear 82", "stream 82 3948x16", "stream stop", "out 0F000000"]);
    }

    [Test]
    public async Task 古いファームウェアは転送の長さを送らず_wMaxPacketSize_の倍数で読む()
    {
        var usb = new FakeXbox { Ram = 0x00010200 };
        using var device = Started(usb);
        usb.Log.Clear();
        device.StartTs();
        await Assert.That(usb.Log).IsEquivalentTo(["out 0F100100", "clear 82", "stream 82 3584x16"]);
    }

    [Test]
    public async Task TS_の端点が記述子に無ければ開かない()
    {
        var usb = new FakeXbox { Endpoints = [new(0x01, 2, 512), new(0x81, 2, 64)] };
        var device = new XboxOneDevice(usb, "Xbox 1-2", _ => { }, _ => { });
        var error = await Assert.That(() => device.Start(XboxOne.BridgeFirmware, () => DemodCode)).Throws<IOException>();
        await Assert.That(error!.Message).Contains("0x82");
    }

    [Test]
    public async Task 閉じるときは_TS_を止められなくてもチューナーと復調をスリープにする()
    {
        var usb = new FakeXbox();
        var device = Started(usb);
        device.StartTs();
        usb.FailOut = hex => hex == "0F000000";
        device.Dispose();
        await Assert.That(usb.Bank(Mn88472.Bank2)[0x0C]).IsEqualTo((byte)0x30);
        await Assert.That(usb.Bank(Tda18250.Address)[0x25] & 0xC0).IsEqualTo(0x80);
        await Assert.That(usb.Disposed).IsTrue();
    }

    // ---- チューナー ----

    private static byte[] NullPackets(int count)
    {
        var data = new byte[188 * count];
        for (var i = 0; i < count; i++)
        {
            data[i * 188] = 0x47;
            data[i * 188 + 1] = 0x1F;
            data[i * 188 + 2] = 0xFF;
            data[i * 188 + 3] = (byte)(0x10 | (i & 0x0F));
        }
        return data;
    }

    [Test]
    public async Task チューナーはケーブルだけを受け_ロックしたら_TS_を流す()
    {
        var usb = new FakeXbox();
        for (var i = 0; i < 200; i++) usb.Ts.Add(NullPackets(21));
        using var tuner = new XboxOneTuner("Xbox 1-2", () => Started(usb));
        await Assert.That(tuner.Accepts(ChannelTable.Parse("T27")!)).IsFalse();

        tuner.Tune(ChannelTable.Parse("QC13")!);
        await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Passthrough);
        await Assert.That(tuner.Tuned).IsTrue();
        var read = new byte[188];
        await Assert.That(tuner.Output.Read(read, 0, read.Length)).IsGreaterThan(0);
        await Assert.That(read[0]).IsEqualTo((byte)0x47);
        await Assert.That(tuner.Signal()!.Cn).IsNotNull();
    }

    [Test]
    public async Task ロックしなければ同期しなかったと返し_機材は閉じない()
    {
        var usb = new FakeXbox();
        usb.Set(Mn88472.Bank1, 0x84, 0x00);
        var opened = 0;
        using var tuner = new XboxOneTuner("Xbox 1-2", () =>
        {
            opened++;
            return Started(usb);
        });
        var error = await Assert.That(() => tuner.Tune(ChannelTable.Parse("QC13")!)).Throws<IOException>();
        await Assert.That(error!.Message).IsEqualTo(ITuneDevice.SyncFailed);
        await Assert.That(usb.Disposed).IsFalse();
        await Assert.That(() => tuner.Tune(ChannelTable.Parse("QC14")!)).Throws<IOException>();
        await Assert.That(opened).IsEqualTo(1);
    }
}
