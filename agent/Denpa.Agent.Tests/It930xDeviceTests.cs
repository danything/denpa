namespace Denpa.Agent.Tests;

/*
 * IT930x の機材 (It930xDevice.cs)、ブリッジの I2C と GPIO (It930xBridge.cs)、設定の device の形と px4d との持ち主の決まり (It930x.cs・Px4.cs)。
 * 偽のブリッジ (It930xFakes.cs) の I2C を、偽の復調器とチューナー (Cxd2856Fakes.cs) につなぐ。
 * ブリッジのレジスタの番地は ITE の SDK (brRegister.h・brVariable.h) のもの、値と順は仕様書 (denpa-spec の mlt5/spec.md) の節。
 */
public class It930xDeviceTests
{
    private static readonly It930xModel Pe = It930x.Find(0x0511, 0x024E)!;

    /// <summary>PX-MLT5PE の割り当て (仕様書 1.2) のとおりに偽の復調器を並べた偽のブリッジ</summary>
    private static (FakeIt930x Usb, FakeCxdBus Bus1, FakeCxdBus Bus3) Fake()
    {
        var usb = new FakeIt930x();
        var bus1 = new FakeCxdBus(0x6C, 0x64);
        var bus3 = new FakeCxdBus(0x65, 0x6C, 0x64);
        usb.I2c[1] = bus1;
        usb.I2c[3] = bus3;
        return (usb, bus1, bus3);
    }

    private static It930xDevice Open(FakeIt930x usb, string port, FakeClock clock, It930xModel? model = null) =>
        It930xDevice.Acquire(port, () => (usb, model ?? Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code);

    [Test]
    public async Task 機種ごとの受信機の割り当ては仕様書_1_2_の表()
    {
        var u = It930x.Find(0x0511, 0x084E)!;
        var dtv = It930x.Find(0x0511, 0x924E)!;
        await Assert.That(Pe.Receivers.Select(r => (r.I2cBus, r.DemodAddress, r.TsInput))).IsEquivalentTo(new (byte, byte, int)[]
        {
            (3, 0x65, 0), (1, 0x6C, 1), (1, 0x64, 2), (3, 0x6C, 3), (3, 0x64, 4),
        });
        await Assert.That(u.Receivers.Select(r => r.TsInput)).IsEquivalentTo(new[] { 4, 3, 1, 2, 0 });
        await Assert.That(u.Receivers.Select(r => (r.I2cBus, r.DemodAddress))).IsEquivalentTo(Pe.Receivers.Select(r => (r.I2cBus, r.DemodAddress)));
        await Assert.That(dtv.Receivers).IsEquivalentTo(Pe.Receivers);
    }

    [Test]
    public async Task I2C_は_GENERIC_WRITE_と_GENERIC_READ_で_8_ビットのアドレスを渡す()
    {
        var (usb, _, bus3) = Fake();
        var bridge = new It930xBridge(usb, _ => { });
        bridge.I2cWrite(3, 0x65, [0x00, 0x00]);
        bridge.I2cWrite(3, 0x65, [0xFD]);
        var read = bridge.I2cRead(3, 0x65, 1);
        await Assert.That(read).IsEquivalentTo(new byte[] { 0x90 });
        // 偽のブリッジは 8 ビットのアドレス (0xCA) を受けて 7 ビット (0x65) に戻して控える
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "I2C W 3 65 0000", "I2C W 3 65 FD", "I2C R 3 65 1" });
        await Assert.That(bus3.Log).IsEquivalentTo(new[] { "65 T 00=00", "65 T FD?" });
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.I2cWrite(3, 0x65, new byte[It930xBridge.MaxI2cWrite + 1]));
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.I2cRead(3, 0x65, It930xBridge.MaxI2cRead + 1));
    }

    [Test]
    public async Task 次の段の_I2C_の欄は受信機の番号で並ぶ()
    {
        var usb = new FakeIt930x();
        var bridge = new It930xBridge(usb, _ => { });
        usb.Registers[It930xBridge.EepromValid] = 1;
        var valid = bridge.ConfigureReceivers(Pe.Receivers);
        await Assert.That(valid).IsEqualTo((byte)1);
        await Assert.That(usb.Log).IsEquivalentTo(new[]
        {
            // I2C の速さ (仕様書 1.3)
            "W F6A7=07", "W F103=07",
            // 端子の駆動の強さ (IT9300_initialize)
            "W D833=01", "W D830=00", "W D831=01", "W D832=00",
            // 受信機 0〜4 の T の 8 ビットのアドレスとバス (仕様書 1.3)
            "W 4975=CA", "W 4971=03", "W 4974=D8", "W 4970=01", "W 4973=C8", "W 496F=01", "W 4972=D8", "W 496E=03", "W 4964=C8", "W 4963=03",
            "R 4979 1",
        });
    }

    [Test]
    public async Task 開くとファームウェアのあとに_GPIO_を設定して電源を入れる()
    {
        var (usb, _, _) = Fake();
        var clock = new FakeClock();
        var device = Open(usb, "9-1", clock);
        try
        {
            var log = usb.Log.Where(line => line.StartsWith("W D8", StringComparison.Ordinal)).ToList();
            await Assert.That(log).IsEquivalentTo(new[]
            {
                "W D833=01", "W D830=00", "W D831=01", "W D832=00",
                // 開いたとき (仕様書 1.5): GPIOH7 = 1 (電源を切る)、GPIOH2 = 0 (リセット中)、GPIOH11 = 0 (LNB を切る)。出力にする・有効・値の順
                "W D8C4=01", "W D8C5=01", "W D8C3=01",
                "W D8B8=01", "W D8B9=01", "W D8B7=00",
                "W D8D4=01", "W D8D5=01", "W D8D3=00",
                // 電源を入れる: GPIOH7 ← 0、80 ms、GPIOH2 ← 1、20 ms
                "W D8C3=00", "W D8B7=01",
            });
            // BOOT のあと 20 ms (SDK)、GPIO のあと 20 ms (仕様書 11)、電源の 80 ms と 20 ms (仕様書 1.5)
            await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 20, 20, 80, 20 });
            // 受信機には、使うまで触らない
            await Assert.That(usb.Log.Any(line => line.StartsWith("I2C", StringComparison.Ordinal))).IsFalse();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("9-1");
        }
        // 閉じると電源を切る (仕様書 1.5: GPIOH2 ← 0、GPIOH7 ← 1)
        await Assert.That(usb.Log.Where(line => line.StartsWith("W D8", StringComparison.Ordinal)).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" });
    }

    [Test]
    public async Task 受信機の一部が初期化できなくてもほかの受信機は使える()
    {
        var (usb, bus1, _) = Fake();
        bus1[0x64].ChipId = 0x00;
        var device = Open(usb, "9-2", new FakeClock());
        try
        {
            var error = Assert.Throws<IOException>(() => device.Frontend(2));
            await Assert.That(error.Message).Contains("受信機 2 を初期化できません");
            await Assert.That(device.Frontend(1).ChipId).IsEqualTo((byte)0x90);
            // 失敗した受信機は、次にもう一度試す
            bus1[0x64].ChipId = 0x91;
            await Assert.That(device.Frontend(2).ChipId).IsEqualTo((byte)0x91);
            await Assert.That(device.Faulted).IsFalse();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("9-2");
        }
    }

    [Test]
    public async Task 選局するとその受信機の_TS_入力を開け_捨てるとスリープにして閉じる()
    {
        var (usb, bus1, _) = Fake();
        var clock = new FakeClock();
        var u = It930x.Find(0x0511, 0x084E)!;
        // PX-MLT5U の受信機 2 は TS 入力 1 (仕様書 1.2)
        var tuner = new It930xTuner("test", 2, () => Open(usb, "9-3", clock, u), () => It930xDevice.CloseIfIdle("9-3"));
        tuner.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(tuner.Output).IsNotNull();
        await Assert.That(usb.Log).Contains($"W {It930xBridge.TsEnable + 1:X4}=01");
        await Assert.That(bus1.Log).Contains("64 X 17=06");
        await Assert.That(tuner.Signal()!.Locked).IsTrue();
        tuner.Dispose();
        await Assert.That(usb.Log).Contains($"W {It930xBridge.TsEnable + 1:X4}=00");
        // スリープの最後 (仕様書 2.4) と、電源を切ってから閉じる
        await Assert.That(bus1.Log).Contains("64 X 17=01");
        await Assert.That(usb.Log).Contains("TS 閉じる");
        await Assert.That(usb.Log[^1]).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task ロックしなければ同期しなかった文で失敗にする()
    {
        var (usb, _, bus3) = Fake();
        bus3[0x65].Status = _ => 0x10;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-4", new FakeClock()), () => It930xDevice.CloseIfIdle("9-4"));
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
            await Assert.That(tuner.Tuned).IsFalse();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 衛星はまだ断る()
    {
        var tuner = new It930xTuner("test", 0, () => throw new InvalidOperationException("開かない"));
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15")!));
        await Assert.That(error.Message).Contains("地上波だけ");
    }

    [Test]
    public async Task 周波数は_kHz_に丸めて渡す()
    {
        // T13 は 473,142,857 Hz → 473,143 kHz (仕様書 5.1 の 473143 + (N - 13) × 6000)
        await Assert.That(It930xTuner.Khz(ChannelTable.Parse("T13")!.Frequency)).IsEqualTo(473143u);
        await Assert.That(It930xTuner.Khz(ChannelTable.Parse("T62")!.Frequency)).IsEqualTo(473143u + 49 * 6000);
    }

    // ---------------------------------------------------------------------
    // 設定の device と持ち主の決まり
    // ---------------------------------------------------------------------

    [Test]
    public async Task 設定の_device_は_it930x_ポート_受信機()
    {
        await Assert.That(It930x.Parse("it930x:1-2.3:4")).IsEqualTo(("1-2.3", 4));
        await Assert.That(It930x.Device("1-2.3", 4)).IsEqualTo("it930x:1-2.3:4");
        await Assert.That(It930x.Parse("it930x:1-2.3:5")).IsNull();
        await Assert.That(It930x.Parse("it930x:1-2.3")).IsNull();
        await Assert.That(It930x.Parse("it930x:foo:0")).IsNull();
        await Assert.That(It930x.Parse("px4:0001:0")).IsNull();
    }

    [Test]
    public async Task 使う受信機が_1_つでもあればそのポートはエージェントが持つ()
    {
        var claimed = It930x.Claimed(
        [
            new TunerSpec("a", ["GR"], false, "it930x:1-2:0"),
            new TunerSpec("b", ["GR"], true, "it930x:1-3:0"),
            new TunerSpec("c", ["GR"], true, "it930x:1-4:0"),
            new TunerSpec("d", ["GR"], false, "it930x:1-4:1"),
            new TunerSpec("e", ["GR"], false, "px4:0001:0"),
        ]);
        await Assert.That(claimed.Order()).IsEquivalentTo(new[] { "1-2", "1-4" });
    }

    [Test]
    public async Task エージェントが持つポートの筐体は_px4d_の筐体として挙げない()
    {
        var notes = new List<string>();
        var enclosures = new List<Px4Userland.Enclosure>
        {
            new("0001", "PX-MLT5PE", []) { Places = ["1-2"] },
            new("0002", "PX-Q3U4", []) { Places = ["1-5"] },
        };
        var kept = Px4Userland.Yield(enclosures, new HashSet<string> { "1-2" }, notes.Add);
        await Assert.That(kept.Select(enclosure => enclosure.Id)).IsEquivalentTo(new[] { "0002" });
        await Assert.That(notes.Single()).Contains("エージェントが持つ");
        // 動いている px4d の筐体なら、起動する顔ぶれから外す (Prepare が止める)
        await Assert.That(Px4Daemon.Yielding(["0001", "0002", "0003"], enclosures, new HashSet<string> { "1-2" })).IsEquivalentTo(new[] { "0002", "0003" });
    }
}
