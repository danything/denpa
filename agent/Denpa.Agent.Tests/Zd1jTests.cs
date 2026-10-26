using System.Buffers;
using System.Buffers.Binary;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * CECH-ZD1 J のブリッジ (Mb86h47.cs) と、ボード・チューナー・カード (Zd1j.cs)。
 * 偽の USB (Zd1jFakes.cs) の上で、メモリ要求の順番と値を仕様書と照らす。
 */
public class Zd1jTests
{
    private static Mb86h47 Started(FakeBridgeUsb usb, Zd1jI2cMode mode = Zd1jI2cMode.Host)
    {
        var bridge = new Mb86h47(usb, mode);
        bridge.Start();
        return bridge;
    }

    [Test]
    public async Task メモリ要求の_wValue_と_wIndex()
    {
        // wValue の上位バイト = 番地のビット 16〜23、下位バイト = ビット 24〜31
        await Assert.That(Mb86h47.Setup(0x1700000 + 0xA3F00)).IsEqualTo(((ushort)0x7A01, (ushort)0x3F00));
        await Assert.That(Mb86h47.Setup(0x82008)).IsEqualTo(((ushort)0x0800, (ushort)0x2008));
    }

    [Test]
    public async Task 跳ぶ語は仕様書_4_2_の形()
    {
        // LDI:20 #0xE1000, R12 = 0x9B0C | (0xE << 4) の上位、0x1000 の下位。JMP @R12 と NOP
        await Assert.That(Mb86h47.Jump(0xE1000)).IsEqualTo((0x9BEC1000u, 0x970C9FA0u));
        var words = Mb86h47.HandlerWords(1);
        await Assert.That(words[2].Widened).IsEqualTo(0x9BEC1876u);
        // データ段の溜め方: 上位 16 ビットを NOP に
        await Assert.That(words[4].Widened).IsEqualTo(0x9FA09F8Du);
    }

    [Test]
    public async Task 電源投入のままでなければ開かない()
    {
        var usb = new FakeBridgeUsb();
        usb.Memory[0x82008] = 0x00010000;
        var error = Assert.Throws<IOException>(() => Started(usb));
        await Assert.That(error.Message).Contains("抜いて挿し直してください");
    }

    [Test]
    public async Task 番地を広げる語はルーチンを置いてから書く()
    {
        var usb = new FakeBridgeUsb();
        Started(usb);
        var routine = usb.Log.IndexOf($"W 000E1000={Mb86h47Code.Addressing0[0]:X8}");
        var readBack = usb.Log.IndexOf($"R 000E1{(Mb86h47Code.Addressing0.Length - 1) * 4:X3}");
        string[] jumps = ["W 000E9AC0=9BEC1000", "W 000E9AC4=970C9FA0", "W 000E9E0C=9BEC1076", "W 000E9E10=970C9FA0", "W 000E9D94=9FA09F8D"];
        var at = jumps.Select(line => usb.Log.IndexOf(line)).ToArray();
        await Assert.That(routine).IsGreaterThan(0);
        await Assert.That(readBack).IsGreaterThan(routine);
        await Assert.That(at[0]).IsGreaterThan(readBack);
        for (var i = 1; i < at.Length; i++) await Assert.That(at[i]).IsGreaterThan(at[i - 1]);
        // 書き換える前は1語ずつ (ルーチンを置くところに 64 バイトの書き込みが無い)
        await Assert.That(usb.Log.Count(line => line.StartsWith("W 000E1", StringComparison.Ordinal))).IsEqualTo(Mb86h47Code.Addressing0.Length);
    }

    [Test]
    public async Task 自分が広げたブリッジはもう一度開いても書き換えない()
    {
        var usb = new FakeBridgeUsb();
        Started(usb);
        usb.Log.Clear();
        Started(usb);
        await Assert.That(usb.Log.Any(line => line.StartsWith("W 000E1", StringComparison.Ordinal) || line.StartsWith("W 000E9", StringComparison.Ordinal))).IsFalse();
    }

    [Test]
    public async Task 知らない中身の処理なら開かない()
    {
        var usb = new FakeBridgeUsb();
        usb.Memory[0xE9AC0] = 0x12345678;
        var error = Assert.Throws<IOException>(() => Started(usb));
        await Assert.That(error.Message).Contains("知らない中身");
    }

    [Test]
    public async Task クロックと割り込みと_I2C_マスター()
    {
        var usb = new FakeBridgeUsb();
        Started(usb);
        var log = usb.Log;
        int Index(string line) => log.IndexOf(line);
        // 4.3: 16 ビットのレジスタは語の上位半分
        await Assert.That(Index("W 00F1010C=82010000")).IsGreaterThan(0);
        // 4.3 の 4: 0x1000000 以上の番地 (広げたあと)
        await Assert.That(Index("W 01700404=00040000")).IsGreaterThan(Index("W 000E9D94=9FA09F8D"));
        // 4.4: 割り込みのレベルを 31 に
        await Assert.That(Index("W 00000440=1F1F1F1F")).IsGreaterThan(0);
        // 4.5: 分周 0x08、クロック 0x3C、マスター有効
        await Assert.That(Index("W 00FD8FF4=00000008")).IsLessThan(Index("W 00FD8FE8=0000003C"));
        await Assert.That(Index("W 00FD8FE4=00000040")).IsGreaterThan(Index("W 00FD8FE8=0000003C"));
    }

    [Test]
    public async Task ホストから直に叩く_I2C_は仕様書_5_2_の手順()
    {
        var usb = new FakeBridgeUsb();
        var bridge = Started(usb);
        usb.Log.Clear();
        bridge.Write(Dib8096.DemodAddress, [0x05, 0x07, 0x00, 0x03]);
        await Assert.That(usb.Dib.Demod[1287]).IsEqualTo((ushort)3);
        var expected = new List<string> { "R 00FD8FE0" };
        foreach (var value in new byte[] { 0x12, 0x05, 0x07, 0x00, 0x03 })
        {
            expected.AddRange([$"W 00FD8FF0={value:X8}", "W 00FD8FE4=00000050", "R 00FD8FE4", "R 00FD8FE0"]);
        }
        expected.AddRange(["W 00FD8FE4=00000040", "R 00FD8FE0"]);
        await Assert.That(string.Join(" ", usb.Log)).IsEqualTo(string.Join(" ", expected));

        // 読み: 番号を書き、繰り返しスタート (0x70) で 2 バイト。最後のバイトだけ ACK を返さない (0x50)
        usb.Log.Clear();
        Span<byte> value16 = stackalloc byte[2];
        bridge.WriteRead(Dib8096.DemodAddress, [0x03, 0x80], value16);
        await Assert.That(BinaryPrimitives.ReadUInt16BigEndian(value16)).IsEqualTo((ushort)0x01B3);
        await Assert.That(usb.Log).Contains("W 00FD8FF0=00000013");
        var restart = usb.Log.IndexOf("W 00FD8FF0=00000013");
        await Assert.That(usb.Log[restart + 1]).IsEqualTo("W 00FD8FE4=00000070");
        await Assert.That(string.Join(" ", usb.Log.Skip(restart + 4))).IsEqualTo(
            "W 00FD8FE4=00000058 R 00FD8FE4 R 00FD8FF0 W 00FD8FE4=00000050 R 00FD8FE4 R 00FD8FF0 W 00FD8FE4=00000040 R 00FD8FE0");
    }

    [Test]
    public async Task ACK_が無ければバスを止めてから投げる()
    {
        var usb = new FakeBridgeUsb();
        var bridge = Started(usb);
        usb.Log.Clear();
        var error = Assert.Throws<IOException>(() => bridge.Write(0x50, [0x00, 0x00, 0x00]));
        await Assert.That(error.Message).Contains("ACK");
        await Assert.That(usb.Log[^1]).IsEqualTo("W 00FD8FE4=00000040");
    }

    [Test]
    public async Task コア_1_の形では書き込みを溜めて_bulk_の塊で送る()
    {
        var usb = new FakeBridgeUsb();
        // コア 1 の答え: 通し番号、誤り 0・値 0 個
        usb.Answer = packet => (BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(4)) & 0x80000000) != 0 ? packet[..4].Concat(new byte[4]).ToArray() : null;
        var bridge = Started(usb, Zd1jI2cMode.Core1);
        await Assert.That(bridge.CommandChannel).IsTrue();
        // コア 1 を置いて走らせ、生きている印を2回読んだ
        await Assert.That(usb.Log).Contains("W 01700000=FFFCFFFF");
        await Assert.That(usb.Log.Count(line => line == "R 017A3F7C")).IsEqualTo(2);

        usb.Packets.Clear();
        bridge.Write(Dib8096.DemodAddress, [0x05, 0x07, 0x00, 0x03]);
        bridge.Write(Dib8096.DemodAddress, [0x04, 0x01, 0xC0, 0x00]);
        // 相手のアドレス (2 バイトの番号は 0x12) はメモリ要求で
        await Assert.That(usb.Log).Contains("W 017A3D40=12000000");
        var before = usb.Packets.Count;
        bridge.Flush();
        await Assert.That(usb.Packets.Count).IsEqualTo(before + 1);
        var packet = usb.Packets[^1];
        var sequence = BinaryPrimitives.ReadUInt32BigEndian(packet);
        await Assert.That(packet.Length).IsEqualTo(512);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(4))).IsEqualTo(2u);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(8))).IsEqualTo((1287u << 16) | 3);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(12))).IsEqualTo((1025u << 16) | 0xC000);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(508))).IsEqualTo(sequence);
    }

    [Test]
    public async Task コア_1_が答えなければメモリ要求のリングに戻る()
    {
        var usb = new FakeBridgeUsb();
        var bridge = Started(usb, Zd1jI2cMode.Core1);
        await Assert.That(bridge.CommandChannel).IsFalse();
        // リングに溜めて、16 個に満たなければ Flush で1回の書き込み
        bridge.Write(Dib8096.DemodAddress, [0x05, 0x07, 0x00, 0x03]);
        usb.Log.Clear();
        bridge.Flush();
        // スロット 16 (周回 1) から
        await Assert.That(usb.Log).Contains($"W 017A3E00={(1u << 31) | (1287u << 16) | 3:X8}");
    }

    [Test]
    public async Task カードに送る手順は仕様書_13_6()
    {
        var usb = new FakeBridgeUsb();
        var bridge = Started(usb);
        usb.Log.Clear();
        bridge.CardWrite([0x00, 0xC1, 0x01, 0xFE, 0x3E]);
        await Assert.That(string.Join(" ", usb.Log)).IsEqualTo(
            "W 00FEA03C=00000000 W 00FEA038=00000000 W 00FEA028=00000000 W 00FEA028=000000C1 W 00FEA028=00000001 "
            + "W 00FEA028=000000FE W 00FEA028=0000003E W 00FEA01C=000003FF W 00FEA010=00000200 W 00FEA00C=00000001");
    }

    [Test]
    public async Task カードがあるかは割り込みの状態のビット_10()
    {
        var usb = new FakeBridgeUsb();
        var bridge = Started(usb);
        await Assert.That(bridge.CardPresent()).IsTrue();
        usb.Memory[0xFEA01C] = 1 << 10;
        await Assert.That(bridge.CardPresent()).IsFalse();
    }

    [Test]
    public async Task B_CAS_の速さは_19200()
    {
        var atr = Atr.Parse(Convert.FromHexString("3BF01200FF9181B17C451F0399"));
        var (baud, control, cwt, bwt, rate) = Zd1jCard.Speed(atr);
        await Assert.That(baud).IsEqualTo(0x5D5Du);
        await Assert.That(control).IsEqualTo(0x00010000u);
        await Assert.That(cwt).IsEqualTo(107u);
        await Assert.That(bwt).IsEqualTo(36559u);
        await Assert.That(rate).IsEqualTo(19200);
        await Assert.That(Zd1jCard.AtrLength([.. Convert.FromHexString("3BF01200FF9181B17C451F0399")])).IsEqualTo(13);
        await Assert.That(Zd1jCard.AtrLength([0x3B, 0xF0, 0x12])).IsNull();
    }

    [Test]
    public async Task 単位をほどくときは_0x47_を2つ見て揃える()
    {
        static byte[] Unit(byte marker)
        {
            var unit = new byte[192];
            unit[4] = 0x47;
            unit[5] = marker;
            // 中身にも 0x47 を混ぜる (1つだけでは単位の頭と信じない)
            if (marker == 0) unit[100] = 0x47;
            if (marker == 2) unit[150] = 0x47;
            return unit;
        }
        var stream = new List<byte>();
        // 流し始めは単位の途中から来る
        stream.AddRange(Unit(0)[96..]);
        for (byte i = 1; i <= 5; i++) stream.AddRange(Unit(i));
        var data = stream.ToArray();

        var framer = new Mb86h47Framer();
        var output = new ArrayBufferWriter<byte>();
        // 区切りは単位と揃わない
        framer.Feed(data.AsSpan(0, 300), output);
        framer.Feed(data.AsSpan(300), output);
        var packets = output.WrittenSpan.ToArray();
        await Assert.That(packets.Length).IsEqualTo(5 * 188);
        for (var i = 0; i < 5; i++)
        {
            await Assert.That(packets[i * 188]).IsEqualTo((byte)0x47);
            await Assert.That(packets[i * 188 + 1]).IsEqualTo((byte)(i + 1));
        }
    }

    [Test]
    public async Task device_の書き方()
    {
        await Assert.That(Zd1j.Parse("zd1j:4-12.1")).IsEqualTo("4-12.1");
        await Assert.That(Zd1j.Parse("zd1j:4-12:1.0")).IsNull();
        await Assert.That(Zd1j.Parse("siano:4-12")).IsNull();
        await Assert.That(Zd1j.I2cMode("host")).IsEqualTo(Zd1jI2cMode.Host);
        await Assert.That(Zd1j.I2cMode(null)).IsEqualTo(Zd1jI2cMode.Core1);
        await Assert.That(Zd1j.I2cMode("core1-ring")).IsEqualTo(Zd1jI2cMode.Core1Ring);
    }

    [Test]
    public async Task 探すときはカーネルのドライバが掴んでいるものを並べない()
    {
        // sysfs のインターフェースの名前 (1-4:1.0) は Windows ではファイル名にできない
        if (OperatingSystem.IsWindows()) return;
        var sysfs = Directory.CreateTempSubdirectory("zd1j-sysfs").FullName;
        try
        {
            void Device(string port, string vendor, string product)
            {
                Directory.CreateDirectory(Path.Combine(sysfs, port));
                File.WriteAllText(Path.Combine(sysfs, port, "idVendor"), vendor + "\n");
                File.WriteAllText(Path.Combine(sysfs, port, "idProduct"), product + "\n");
            }
            Device("1-2", "054c", "04b2");
            Device("1-3", "0511", "0045");
            Device("1-4", "054c", "04b2");
            Directory.CreateDirectory(Path.Combine(sysfs, "1-4:1.0", "driver"));
            await Assert.That(string.Join(",", Zd1j.Ports(sysfs))).IsEqualTo("1-2");
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task 選局して_TS_を流し_返したら_LED_を緑に戻して閉じる()
    {
        var linger = Zd1jBoard.Linger;
        Zd1jBoard.Linger = TimeSpan.FromMilliseconds(50);
        try
        {
            var usb = new FakeBridgeUsb();
            var board = new Zd1jBoard("1-2", usb, Zd1jI2cMode.Host, shortWaits: true, trace: false);
            board.Bridge.Start();
            var tuner = new Zd1jTuner("test", () => board);
            tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
            await Assert.That(tuner.Tuned).IsTrue();
            // 流している間は赤 (GPIO 1 = 出力・High)
            await Assert.That(usb.Dib.Demod[1029] & 2).IsEqualTo(0);
            await Assert.That(usb.Dib.Demod[1030] & 2).IsEqualTo(2);
            // 流し始めのあとに読みを出す
            await Assert.That(usb.Log.IndexOf("S 81 64512x16")).IsGreaterThan(usb.Log.IndexOf("W 00D02010=02000000"));

            var units = new byte[192 * 10];
            for (var i = 0; i < 10; i++) units[i * 192 + 4] = 0x47;
            lock (usb.Ts) usb.Ts.Enqueue(units);
            var buffer = new byte[188 * 10];
            var got = 0;
            var output = (DeviceStream)tuner.Output;
            while (got < buffer.Length)
            {
                var read = output.Read(buffer, got, buffer.Length - got, null);
                if (read <= 0) break;
                got += read;
            }
            await Assert.That(got).IsEqualTo(188 * 10);
            await Assert.That(buffer[188]).IsEqualTo((byte)0x47);
            await Assert.That(tuner.Timings.FirstTsMs).IsGreaterThanOrEqualTo(0);

            tuner.Dispose();
            // 流し終わり (仕様書 9.5): コア 0 を止め、受け口と書き手を止め、出力をハイインピーダンスに
            await Assert.That(usb.Log).Contains("S stop");
            await Assert.That(usb.Log).Contains("W 00D02010=04000000");
            await Assert.That(usb.Dib.Demod[1286]).IsEqualTo((ushort)0);
            await Assert.That(usb.Dib.Demod[1029] & 2).IsEqualTo(2);
            for (var i = 0; i < 100 && !usb.Disposed; i++) await Task.Delay(20);
            await Assert.That(usb.Disposed).IsTrue();
            // 閉じる前に眠らせた (DiB0090 のスリープ = GPIO 0 を High)
            await Assert.That(usb.Dib.Demod[1030] & 1).IsEqualTo(1);
        }
        finally
        {
            Zd1jBoard.Linger = linger;
        }
    }

    [Test]
    public async Task ロックしなければ同期しなかったと言ってボードを返す()
    {
        var usb = new FakeBridgeUsb();
        usb.Dib.Signal = false;
        var board = new Zd1jBoard("1-2", usb, Zd1jI2cMode.Host, shortWaits: true, trace: false);
        board.Bridge.Start();
        var tuner = new Zd1jTuner("test", () => board);
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
        await Assert.That(tuner.Tuned).IsFalse();
        await Assert.That(tuner.Board).IsNull();
    }
}
