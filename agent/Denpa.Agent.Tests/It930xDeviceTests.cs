namespace Denpa.Agent.Tests;

/*
 * IT930x の機材 (It930xDevice.cs)、ブリッジの I2C と GPIO (It930xBridge.cs)、設定の device の形と自動検出 (It930x.cs)。
 * 偽のブリッジ (It930xFakes.cs) の I2C を、偽の復調器とチューナー (Cxd2856Fakes.cs) につなぐ。
 * ブリッジのレジスタの番地は ITE の SDK (brRegister.h・brVariable.h) のもの、値と順は仕様書 (denpa-spec の cxd2856/spec.md) の節。
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
            // I2C の速さ (IT930x の仕様書 4.2)
            "W F6A7=07", "W F103=07",
            // 端子の駆動の強さ (IT9300_initialize)
            "W D833=01", "W D830=00", "W D831=01", "W D832=00",
            // 受信機 0〜4 の T の 8 ビットのアドレスとバス (IT930x の仕様書 4.2・5.1)
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
                // 開いたとき (IT930x の仕様書 7.2): GPIOH7 = 1 (電源を切る)、GPIOH2 = 0 (リセット中)、GPIOH11 = 0 (LNB を切る)。出力にする・有効・値の順
                "W D8C4=01", "W D8C5=01", "W D8C3=01",
                "W D8B8=01", "W D8B9=01", "W D8B7=00",
                "W D8D4=01", "W D8D5=01", "W D8D3=00",
                // 電源を入れる: GPIOH7 ← 0、80 ms、GPIOH2 ← 1、20 ms
                "W D8C3=00", "W D8B7=01",
            });
            // BOOT のあと 20 ms (SDK)、GPIO のあと 20 ms (仕様書 11)、電源の 80 ms と 20 ms (IT930x の仕様書 7.2)
            await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 20, 20, 80, 20 });
            // 受信機には、使うまで触らない
            await Assert.That(usb.Log.Any(line => line.StartsWith("I2C", StringComparison.Ordinal))).IsFalse();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("9-1", TimeSpan.Zero);
        }
        // 閉じると電源を切る (IT930x の仕様書 7.2: GPIOH2 ← 0、GPIOH7 ← 1)
        await Assert.That(usb.Log.Where(line => line.StartsWith("W D8", StringComparison.Ordinal)).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" });
    }

    [Test]
    public async Task 閉じ終えるまで同じポートを開き直さない()
    {
        /*
         * 同じ機材 (同じ偽物) を閉じている途中に、別のスレッドが開き直そうとする。時間で待たず、合図で順を決める:
         * 1. 閉じる側が電源を切る書き込みの 1 つ目 (GPIOH2 ← 0) を出したところで、開き直すスレッドを始める
         * 2. 開き直す側が機材の一覧のロックを取る直前に合図 (reached) を出す
         * 3. 閉じる側は、開き直す側がロックで止まる (WaitSleepJoin) か、USB を開いてしまう (opened) まで待ってから閉じ終える
         * 正しく作られていれば開き直す側はロックで止まり、USB を開くのは古いほうの電源断のあとになる
         */
        var (usb, _, _) = Fake();
        var first = Open(usb, "9-6", new FakeClock());
        first.Release();
        using var reached = new ManualResetEventSlim();
        using var opened = new ManualResetEventSlim();
        It930xDevice? second = null;
        Exception? failure = null;
        var openedAfterPowerOff = false;
        var clock = new FakeClock();
        var reopening = new Thread(() =>
        {
            try
            {
                second = It930xDevice.Acquire("9-6", () =>
                {
                    // 閉じる側の GPIOH2 ← 0 のあとに GPIOH7 ← 1 (電源断) まで届いているか
                    lock (usb.Log) openedAfterPowerOff = usb.Log.IndexOf("W D8C3=01", usb.Log.LastIndexOf("W D8B7=00") + 1) >= 0;
                    opened.Set();
                    usb.ResetSequence();
                    return (usb, Pe);
                }, clock.Sleep, () => clock.Now, () => It930xFirmware.Code, reached.Set);
            }
            catch (Exception error)
            {
                failure = error;
            }
        }) { IsBackground = true, Name = "reopen" };
        var started = 0;
        usb.OnNote = line =>
        {
            // 開き直すスレッドの書き込みでもここを通るので、1 回だけ始める
            if (line != "W D8B7=00" || Interlocked.Exchange(ref started, 1) != 0) return;
            reopening.Start();
            if (!reached.Wait(TimeSpan.FromSeconds(10))) throw new InvalidOperationException("開き直すスレッドが Acquire に入らなかった");
            if (!SpinWait.SpinUntil(() => opened.IsSet || (reopening.ThreadState & ThreadState.WaitSleepJoin) != 0, TimeSpan.FromSeconds(10)))
            {
                throw new InvalidOperationException("開き直すスレッドがロックで止まらず、USB も開かなかった");
            }
        };
        try
        {
            It930xDevice.CloseIfIdle("9-6", TimeSpan.Zero);
            await Assert.That(started).IsEqualTo(1);
            await Assert.That(reopening.Join(TimeSpan.FromSeconds(10))).IsTrue();
            await Assert.That(failure).IsNull();
            // 開き直した側が USB を開いたのは、古いほうの電源断 (GPIOH7 ← 1) のあと
            await Assert.That(openedAfterPowerOff).IsTrue();
            List<string> log;
            lock (usb.Log) log = [.. usb.Log];
            await Assert.That(log.Last(line => line.StartsWith("W D8C3=", StringComparison.Ordinal))).IsEqualTo("W D8C3=00");
            await Assert.That(log.Last(line => line.StartsWith("W D8B7=", StringComparison.Ordinal))).IsEqualTo("W D8B7=01");
        }
        finally
        {
            usb.OnNote = null;
            second?.Release();
            It930xDevice.CloseIfIdle("9-6", TimeSpan.Zero);
        }
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
            await Assert.That(((CxdReceiver)device.Frontend(1)).Chip.ChipId).IsEqualTo((byte)0x90);
            // 失敗した受信機は、次にもう一度試す
            bus1[0x64].ChipId = 0x91;
            await Assert.That(((CxdReceiver)device.Frontend(2)).Chip.ChipId).IsEqualTo((byte)0x91);
            await Assert.That(device.Faulted).IsFalse();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("9-2", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task 開くと_EP_0x84_の読みを出し_最初の受信機を開くときに入力を全部開け_閉じるときは入力を閉じてから読みを止める()
    {
        var (usb, _, _) = Fake();
        var device = Open(usb, "9-27", new FakeClock());
        List<string> log;
        lock (usb.Log) log = [.. usb.Log];
        // TS の経路の設定は入力を閉じたところから (ConfigureTs)。電源を入れてから読みを出す (TS 65424 64)
        var configured = log.IndexOf("W DA7C=67");
        var reading = log.IndexOf($"TS {It930xBridge.TsTransferSize} {It930xBridge.TsDepth}");
        await Assert.That(log.IndexOf("W DA4C=00")).IsLessThan(configured);
        await Assert.That(reading).IsGreaterThan(configured);
        await Assert.That(reading).IsGreaterThan(log.LastIndexOf("W D8B7=01"));
        // 機材を開いただけでは入力を開けない (電源を入れただけで初期化していない復調器の入力が溢れたため)
        await Assert.That(log).DoesNotContain("W DA4C=01");
        // 最初の受信機を開いたときに、入力 0〜4 を全部開ける
        device.Frontend(0);
        lock (usb.Log) log = [.. usb.Log];
        var opened = log.IndexOf("W DA4C=01");
        await Assert.That(opened).IsGreaterThan(reading);
        await Assert.That(log.Skip(opened).Take(6)).IsEquivalentTo(new[] { "W DA4C=01", "W DA4D=01", "W DA4E=01", "W DA4F=01", "W DA50=01", "W DA5A=1F" });
        // 2 つ目の受信機では開け直さない
        device.Frontend(1);
        lock (usb.Log) log = [.. usb.Log];
        await Assert.That(log.Count(line => line == "W DA4C=01")).IsEqualTo(1);
        device.Release();
        It930xDevice.CloseIfIdle("9-27", TimeSpan.Zero);
        lock (usb.Log) log = [.. usb.Log];
        // 閉じるときは、入力を全部閉じて EP 0x84 をリセットし (DRV_ResetRxPort)、読みを止めてから電源を切る
        var disabled = log.LastIndexOf("W DA4C=00");
        await Assert.That(log.Skip(disabled).Take(7)).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        await Assert.That(log.IndexOf("TS 閉じる")).IsGreaterThan(disabled);
        await Assert.That(log[^1]).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task EP_0x84_の読みを始められなければ_入力を開けずに開くのを失敗にする()
    {
        var (usb, _, _) = Fake();
        usb.TsOpenFails = true;
        var error = Assert.Throws<IOException>(() => Open(usb, "9-28", new FakeClock()));
        await Assert.That(error.Message).Contains("読みを始められませんでした");
        await Assert.That(usb.Log).DoesNotContain("W DA4C=01");
    }

    [Test]
    public async Task 開くときに溢れが立っていれば_SDK_の順で_TS_の経路をリセットし直してから読みを出す()
    {
        var (usb, _, _) = Fake();
        // 全体の溢れと入力 2 の溢れ (PX-MLT5PE の受信機 2)。偽物では書いても下りない (実機と同じ)
        usb.Registers[It930xBridge.SysBufOverflow] = 1;
        usb.Registers[It930xBridge.TsOverflow1 + 1] = 1;
        var device = Open(usb, "9-40", new FakeClock());
        List<string> log;
        lock (usb.Log) log = [.. usb.Log];
        device.Release();
        It930xDevice.CloseIfIdle("9-40", TimeSpan.Zero);
        var configured = log.IndexOf("W DA7C=67");
        string[] overflow = ["R DA39 1", "R DA57 1", "R DA8B 4"];
        string[] expected =
        [
            // 溢れを読む
            .. overflow,
            // DRV_ResetRxPort の閉じる側: 入力を全部閉じる → 10 ms → 0xDA1D に 1、0
            "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00",
            // init_work_queue の「Clean PSB buffer」: 0xDA05 に 1
            "W DA05=01",
            // IT9300_configOutput (0xDA05 を 0 に戻す)
            "R DA1D 1", "W DA1D=01",
            "R DD11 1", "W DD11=00",
            "R DD13 1", "W DD13=00",
            "R DD11 1", "W DD11=20",
            "W DD88=E43F", "W DD0C=80",
            "R DA05 1", "W DA05=00",
            "R DA06 1", "W DA06=00",
            "R DA1D 1", "W DA1D=00",
            "W D920=00",
            // 下りたかを読み直す
            .. overflow,
        ];
        await Assert.That(log.Skip(configured + 1).Take(expected.Length)).IsEquivalentTo(expected);
        // リセットし直してから電源を入れ、EP 0x84 の読みを出す
        await Assert.That(log.IndexOf($"TS {It930xBridge.TsTransferSize} {It930xBridge.TsDepth}")).IsGreaterThan(configured + expected.Length);
        var lines = Log.Recent.Snapshot().Select(line => line.Text).Where(text => text.Contains("9-40")).ToList();
        await Assert.That(lines.Any(text => text.Contains("開いたときに TS のバッファが溢れていました") && text.Contains("入力ごとの溢れ (0xDA57・0xDA8B〜) 0 0 1 0 0、受信機 2"))).IsTrue();
        await Assert.That(lines.Any(text => text.Contains("リセットしても溢れたままです") && text.Contains("電源を抜いて"))).IsTrue();
    }

    [Test]
    public async Task 開くときに溢れていなければ読むだけでリセットし直さない()
    {
        var (usb, _, _) = Fake();
        var device = Open(usb, "9-41", new FakeClock());
        List<string> log;
        lock (usb.Log) log = [.. usb.Log];
        device.Release();
        It930xDevice.CloseIfIdle("9-41", TimeSpan.Zero);
        var configured = log.IndexOf("W DA7C=67");
        await Assert.That(log.Skip(configured + 1).Take(4)).IsEquivalentTo(new[] { "R DA39 1", "R DA57 1", "R DA8B 4", "W D8C3=00" });
    }

    [Test]
    public async Task 溢れが下りれば記録に出して続ける()
    {
        var (usb, _, _) = Fake();
        usb.Registers[It930xBridge.TsOverflow0] = 1;
        // TS の経路をリセットし直すと下りる偽物
        usb.OnNote = line =>
        {
            if (line == "W DA05=01") usb.Registers[It930xBridge.TsOverflow0] = 0;
        };
        var device = Open(usb, "9-42", new FakeClock());
        device.Release();
        It930xDevice.CloseIfIdle("9-42", TimeSpan.Zero);
        var lines = Log.Recent.Snapshot().Select(line => line.Text).Where(text => text.Contains("9-42")).ToList();
        await Assert.That(lines.Any(text => text.Contains("溢れが下りました"))).IsTrue();
        await Assert.That(lines.Any(text => text.Contains("リセットしても溢れたまま"))).IsFalse();
    }

    /// <summary>
    /// **全体の溢れが立ったままなら、受信機に触らずに選局を断る** (PX-MLT8PE。2026-11-12)。ロックしても TS が届かないので、30 秒待たせずにほかのチューナーへ回させる。
    /// 機材は返して閉じる (次に取るときに開き直して溢れを読み直す)
    /// </summary>
    [Test]
    public async Task 全体の溢れが立ったままなら受信機に触らずに選局を断る()
    {
        var (usb, _, _) = Fake();
        usb.Registers[It930xBridge.SysBufOverflow] = 1;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-50", new FakeClock()), () => It930xDevice.CloseIfIdle("9-50", TimeSpan.Zero));
        try
        {
            var error = Assert.Throws<TunerUnusableException>(() => tuner.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(error.Message).Contains("全体の溢れ (0xDA39) 1");
            await Assert.That(error.Message).Contains("電源を抜いて入れ直してください");
            await Assert.That(tuner.Tuned).IsFalse();
            // 受信機を開かないので、入力も開けない (OpenInputs)
            await Assert.That(usb.Log).DoesNotContain("W DA4C=01");
            // 機材は返して閉じた (電源を切る書き込みが最後)
            await Assert.That(usb.Log[^1]).IsEqualTo("W D8C3=01");
            var lines = Log.Recent.Snapshot().Select(line => line.Text).Where(text => text.Contains("9-50")).ToList();
            await Assert.That(lines.Any(text => text.Contains("この機材の受信機では選局しません"))).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    /// <summary>
    /// **受信機が流しているまま機材を閉じても (エージェントを止めるとき)、入力を閉じて EP 0x84 をリセットしてから読みを止め、そのあと受信機をスリープにして電源を切る。**
    /// 読む側がいないまま、入力に TS を入れない (読みを先に止めると、ブリッジのバッファが溢れて電源を抜くまで戻らない)
    /// </summary>
    [Test]
    public async Task 流しているまま閉じても_入力を閉じてから読みを止め_そのあと受信機をスリープにする()
    {
        var (usb, _, _) = Fake();
        byte[] packet = [It930xBridge.SyncBytes[0], 0x01, 0x00, 0x10, .. new byte[184]];
        usb.TsSource = () => packet;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-51", new FakeClock()), () => It930xDevice.CloseIfIdle("9-51", TimeSpan.Zero));
        tuner.Tune(ChannelTable.Parse("T27")!);
        var buffer = new byte[188];
        var got = 0;
        while (got < buffer.Length) got += tuner.Output.Read(buffer, got, buffer.Length - got);

        // エージェントを止めるとき (Program.cs の ApplicationStopped) と同じく、選局を返さないまま全部閉じる
        It930xDevice.CloseAll(port => port == "9-51");
        List<string> log;
        lock (usb.Log) log = [.. usb.Log];
        var disabled = log.LastIndexOf("W DA4C=00");
        var stopped = log.IndexOf("TS 閉じる");
        await Assert.That(log.Skip(disabled).Take(7)).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        await Assert.That(stopped).IsGreaterThan(disabled);
        // 入力を閉じたあとは、読みを止めるまで入力を開け直さない
        await Assert.That(log.Skip(disabled).Take(stopped - disabled)).DoesNotContain("W DA4C=01");
        // 受信機のスリープ (I2C) と電源を切るのは、読みを止めたあと
        var slept = log.FindIndex(stopped, line => line.StartsWith("I2C W", StringComparison.Ordinal));
        await Assert.That(slept).IsGreaterThan(stopped);
        await Assert.That(log[^1]).IsEqualTo("W D8C3=01");
        // 流していた出口は終わる (読み出し側は残りを読んだら 0 を返す)
        var drained = new byte[4096];
        while (tuner.Output.Read(drained, 0, drained.Length) > 0) { }
    }

    [Test]
    public async Task EP_0x84_の読みが失敗したら_返されるのを待たずに入力を全部閉じる()
    {
        var (usb, _, _) = Fake();
        using var fail = new ManualResetEventSlim();
        usb.TsSource = () => fail.IsSet ? throw new IOException("fake-it930x の EP 0x84 の読みが失敗しました") : null;
        var device = Open(usb, "9-43", new FakeClock());
        try
        {
            device.Frontend(0);
            int opened;
            lock (usb.Log) opened = usb.Log.LastIndexOf("W DA5A=1F");
            fail.Set();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
            while (!device.Faulted && DateTime.UtcNow < deadline) Thread.Sleep(5);
            await Assert.That(device.Faulted).IsTrue();
            // 使っている側はまだ返していないが、読む側のいない入力を開けたままにしない
            List<string> after;
            do
            {
                Thread.Sleep(5);
                lock (usb.Log) after = [.. usb.Log.Skip(opened + 1).Where(TsRouteWrite)];
            }
            while (after.Count < 7 && DateTime.UtcNow < deadline);
            await Assert.That(after).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        }
        finally
        {
            device.Release();
        }
    }

    /// <summary>TS の経路のレジスタ (5 つの入力で共有するもの) への書き込み</summary>
    internal static bool TsRouteWrite(string line)
    {
        if (!line.StartsWith('W') || line.Length < 6 || !uint.TryParse(line.AsSpan(2, 4), System.Globalization.NumberStyles.HexNumber, null, out var address)) return false;
        return address is (>= 0xDA00 and <= 0xDAFF) or (>= 0xDD00 and <= 0xDDFF);
    }

    [Test]
    public async Task 選局しても捨ててもブリッジの_TS_の経路には書かず_その受信機の出口だけを付け外しする()
    {
        var (usb, bus1, _) = Fake();
        var clock = new FakeClock();
        var u = It930x.Find(0x0511, 0x084E)!;
        // PX-MLT5U の受信機 2 は TS 入力 1 (仕様書 1.2)。入力 1 のパケットだけがこの受信機に届く
        byte[] packet = [It930xBridge.SyncBytes[1], 0x01, 0x00, 0x10, .. new byte[184]];
        byte[] other = [It930xBridge.SyncBytes[0], 0x01, 0x00, 0x10, .. new byte[184]];
        usb.TsSource = () => [.. packet, .. other, .. packet, .. other];
        var tuner = new It930xTuner("test", 2, () => Open(usb, "9-3", clock, u), () => It930xDevice.CloseIfIdle("9-3", TimeSpan.Zero));
        tuner.Tune(ChannelTable.Parse("T27")!);
        int opened;
        lock (usb.Log) opened = usb.Log.LastIndexOf("W DA5A=1F");
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(bus1.Log).Contains("64 X 17=06");
        await Assert.That(tuner.Signal()!.Locked).IsTrue();
        var buffer = new byte[188];
        var got = 0;
        while (got < buffer.Length) got += tuner.Output.Read(buffer, got, buffer.Length - got);
        await Assert.That(buffer[0]).IsEqualTo((byte)0x47);
        // 選局の間、ブリッジの TS の経路には書かない (入力は開いたときから全部開いている)
        List<string> during;
        lock (usb.Log) during = [.. usb.Log.Skip(opened + 1).Where(TsRouteWrite)];
        await Assert.That(during).IsEmpty();
        tuner.Dispose();
        // スリープの最後 (仕様書 2.4) と、入力を全部閉じてから読みを止め、電源を切って閉じる
        await Assert.That(bus1.Log).Contains("64 X 17=01");
        await Assert.That(usb.Log.IndexOf("TS 閉じる")).IsGreaterThan(usb.Log.LastIndexOf("W DA1D=00"));
        await Assert.That(usb.Log[^1]).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task ロックしなければ同期しなかった文で失敗にする()
    {
        var (usb, _, bus3) = Fake();
        bus3[0x65].Status = _ => 0x10;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-4", new FakeClock()), () => It930xDevice.CloseIfIdle("9-4", TimeSpan.Zero));
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

    /// <summary>LNB の給電 (GPIOH11 の値。IT930x の仕様書 7.2・8) の書き込みを、開いたときの設定のあとから拾う</summary>
    private static List<string> LnbWrites(FakeIt930x usb)
    {
        lock (usb.Log)
        {
            var setup = usb.Log.IndexOf("W D8D5=01");
            return [.. usb.Log.Skip(setup + 2).Where(line => line.StartsWith("W D8D3=", StringComparison.Ordinal))];
        }
    }

    [Test]
    public async Task 衛星は_TSID_で選局し_15V_なら_LNB_の給電を入れる()
    {
        var (usb, _, bus3) = Fake();
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-7", new FakeClock()), () => It930xDevice.CloseIfIdle("9-7", TimeSpan.Zero), "15v");
        tuner.Tune(ChannelTable.Parse("BS15:16625")!);
        await Assert.That(tuner.Tuned).IsTrue();
        // 給電を入れてから選局する (GPIOH11 ← 1。IT930x の仕様書 8)
        await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01" });
        await Assert.That(bus3.Log).Contains("65 T E9=40F100");
        await Assert.That(bus3.Log).Contains("65 X 17=0C");
        await Assert.That(tuner.Signal()!.Locked).IsTrue();
        await Assert.That(tuner.SatelliteStreams()).IsNotNull();
        tuner.Dispose();
        // 受信機を閉じるときは給電を求めない (仕様書 10.3 の手順 4)。そのあと電源を切る
        await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01", "W D8D3=00" });
        await Assert.That(bus3.Log).Contains("65 X 28=13");
        await Assert.That(usb.Log[^1]).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task LNB_の給電は求める受信機が_0_と_1_の間で変わるときだけ書く()
    {
        var (usb, _, _) = Fake();
        var clock = new FakeClock();
        var tuners = new[] { 0, 1 }.Select(receiver =>
            new It930xTuner($"test {receiver}", receiver, () => Open(usb, "9-8", clock), () => It930xDevice.CloseIfIdle("9-8", TimeSpan.Zero), "15v")).ToList();
        try
        {
            tuners[0].Tune(ChannelTable.Parse("BS15:16625")!);
            tuners[1].Tune(ChannelTable.Parse("BS01:16400")!);
            // 2 つ目の受信機が求めても書かない (給電は 5 つの受信機で 1 つ。IT930x の仕様書 8)
            await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01" });
            await Assert.That(tuners[0].Device!.LnbUsers).IsEqualTo(2);
            // 1 つ目が地上波に替わっても、2 つ目が求めているので切らない
            tuners[0].Tune(ChannelTable.Parse("T27")!);
            await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01" });
            // 最後の 1 つが求めなくなったら切る
            tuners[1].Dispose();
            await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01", "W D8D3=00" });
        }
        finally
        {
            foreach (var tuner in tuners) tuner.Dispose();
        }
    }

    [Test]
    public async Task LNB_を設定していなければ衛星でも給電しない()
    {
        var (usb, _, _) = Fake();
        var tuner = new It930xTuner("test", 2, () => Open(usb, "9-9", new FakeClock()), () => It930xDevice.CloseIfIdle("9-9", TimeSpan.Zero), "");
        try
        {
            tuner.Tune(ChannelTable.Parse("CS4")!);
            await Assert.That(tuner.Tuned).IsTrue();
            await Assert.That(LnbWrites(usb)).IsEmpty();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 衛星を選局できなければ給電の要求を取り下げる()
    {
        var (usb, _, bus3) = Fake();
        bus3[0x65].SatelliteStatus = _ => 0x00;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-11", new FakeClock()), () => It930xDevice.CloseIfIdle("9-11", TimeSpan.Zero), "15v");
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
            await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01", "W D8D3=00" });
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task LNB_の_11V_は機材を開かずに断る()
    {
        var tuner = new It930xTuner("test", 0, () => throw new InvalidOperationException("開かない"), lnb: "11v");
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15")!));
        await Assert.That(error.Message).Contains("15V だけ");
    }

    [Test]
    public async Task 同じ受信機で地上波と衛星を切り替える()
    {
        var (usb, _, bus3) = Fake();
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-10", new FakeClock()), () => It930xDevice.CloseIfIdle("9-10", TimeSpan.Zero), "15v");
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            tuner.Tune(ChannelTable.Parse("BS15:16625")!);
            tuner.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(tuner.Tuned).IsTrue();
            // ISDB-T → ISDB-S → ISDB-T の起動 (仕様書 10.1)。間にそれぞれのスリープ
            var log = bus3.Log;
            var modes = log.Where(line => line.StartsWith("65 X 17=", StringComparison.Ordinal)).ToList();
            await Assert.That(modes).IsEquivalentTo(new[] { "65 X 17=01", "65 X 17=06", "65 X 17=01", "65 X 17=0C", "65 X 17=01", "65 X 17=06" });
            // 地上波に戻ったら給電を切る
            await Assert.That(LnbWrites(usb)).IsEquivalentTo(new[] { "W D8D3=01", "W D8D3=00" });
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task J83B_は_SKY_の名前で選局し_初めてのときに全受信機を整合を保つ設定にする()
    {
        var (usb, bus1, bus3) = Fake();
        var clock = new FakeClock();
        var ground = new It930xTuner("test 1", 1, () => Open(usb, "9-12", clock), () => It930xDevice.CloseIfIdle("9-12", TimeSpan.Zero));
        var cable = new It930xTuner("test 0", 0, () => Open(usb, "9-12", clock), () => It930xDevice.CloseIfIdle("9-12", TimeSpan.Zero), "15v");
        try
        {
            // 受信機 1 は地上波で動作中
            ground.Tune(ChannelTable.Parse("T27")!);
            cable.Tune(ChannelTable.Parse("H40")!);
            await Assert.That(cable.Tuned).IsTrue();
            await Assert.That(cable.CableFrequency).IsEqualTo(346_750_000u);
            await Assert.That(bus3.Log).Contains("65 X 17=08");
            await Assert.That(cable.Signal()!.Locked).IsTrue();
            // J.83B は衛星ではないので、LNB の給電は要求しない
            await Assert.That(LnbWrites(usb)).IsEmpty();

            // まだ使っていない受信機 2・3・4 は、整合を保つ設定で初期化して待機させる (仕様書 4.8。初期化の手順 2 が 02)
            await Assert.That(bus1.Log).Contains("64 U 67=02");
            await Assert.That(bus3.Log).Contains("6C U 67=02");
            await Assert.That(bus3.Log).Contains("64 U 67=02");
            // 選局する受信機 0 と、動作中の受信機 1 は初期化し直さない
            await Assert.That(bus3.Log.Count(line => line == "65 X 10=01")).IsEqualTo(1);
            await Assert.That(bus1.Log.Count(line => line == "6C X 10=01")).IsEqualTo(1);
            // 動作中の受信機 1 は、止めるときに 67 の bit1 を立てる (仕様書 4.7)
            ground.Dispose();
            var stop = bus1.Log.LastIndexOf("6C U 74=02");
            await Assert.That(bus1.Log.Skip(stop).Take(3)).IsEquivalentTo(new[] { "6C U 74=02", "6C U 67?", "6C U 67=02" });

            // 2 回目からは、ほかの受信機に触らない
            var bus1Lines = bus1.Log.Count;
            cable.Tune(ChannelTable.Parse("H41")!);
            await Assert.That(bus1.Log.Count).IsEqualTo(bus1Lines);
            await Assert.That(bus3.Log.Count(line => line.EndsWith(" X 10=01", StringComparison.Ordinal))).IsEqualTo(3);
        }
        finally
        {
            ground.Dispose();
            cable.Dispose();
        }
    }

    [Test]
    public async Task ずらして送られることがあるチャンネルは両方の周波数を試し_次はロックしたほうを先にする()
    {
        var (usb, _, bus3) = Fake();
        var demod = bus3[0x65];
        // H44 は 372750 kHz。ずらした 374950 kHz (+2.2 MHz) でだけロックする (仕様書 7.1)
        demod.CableStatus = _ =>
        {
            var khz = demod.Tuner.GetValueOrDefault((byte)0x70) | (demod.Tuner.GetValueOrDefault((byte)0x71) << 8) | ((demod.Tuner.GetValueOrDefault((byte)0x72) & 0x0F) << 16);
            return khz == 374950 ? (byte)0x01 : (byte)0x00;
        };
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-13", new FakeClock()), () => It930xDevice.CloseIfIdle("9-13", TimeSpan.Zero));
        try
        {
            tuner.Tune(ChannelTable.Parse("H44")!);
            await Assert.That(tuner.CableFrequency).IsEqualTo(374_950_000u);
            await Assert.That(bus3.Log.Count(line => line.StartsWith("65 U 68=", StringComparison.Ordinal))).IsEqualTo(2);
            // 次は、前にロックしたずらした周波数から試す
            bus3.Log.Clear();
            tuner.Tune(ChannelTable.Parse("H44")!);
            await Assert.That(bus3.Log.Count(line => line.StartsWith("65 U 68=", StringComparison.Ordinal))).IsEqualTo(1);
            await Assert.That(tuner.CableFrequency).IsEqualTo(374_950_000u);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task J83B_がどちらの周波数でもロックしなければ同期しなかった文で失敗にする()
    {
        var (usb, _, bus3) = Fake();
        bus3[0x65].CableStatus = _ => 0x00;
        var tuner = new It930xTuner("test", 0, () => Open(usb, "9-14", new FakeClock()), () => It930xDevice.CloseIfIdle("9-14", TimeSpan.Zero));
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("H11")!));
            await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
            await Assert.That(tuner.CableFrequency).IsNull();
            await Assert.That(bus3.Log.Count(line => line.StartsWith("65 U 68=", StringComparison.Ordinal))).IsEqualTo(2);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 設定の_it930x_の受信機は地上波と衛星と_CATV_と_SKY_を受けられる()
    {
        await Assert.That(DeviceProbe.Receivable("it930x:4-12.1:0")).IsEquivalentTo(new[] { "GR", "BS", "CS", "CATV", "SKY" });
        // 形式が違えば it930x: の受信機として扱わない
        await Assert.That(DeviceProbe.Receivable("it930x:4-12.1:9")).IsNull();
    }

    [Test]
    public async Task 周波数は_kHz_に丸めて渡す()
    {
        // T13 は 473,142,857 Hz → 473,143 kHz (仕様書 5.1 の 473143 + (N - 13) × 6000)
        await Assert.That(It930xTuner.Khz(ChannelTable.Parse("T13")!.Frequency)).IsEqualTo(473143u);
        await Assert.That(It930xTuner.Khz(ChannelTable.Parse("T62")!.Frequency)).IsEqualTo(473143u + 49 * 6000);
    }

    // ---------------------------------------------------------------------
    // 設定の device と自動検出
    // ---------------------------------------------------------------------

    [Test]
    public async Task 設定の_device_は_it930x_ポート_受信機()
    {
        await Assert.That(It930x.Parse("it930x:1-2.3:4")).IsEqualTo(("1-2.3", 4));
        await Assert.That(It930x.Device("1-2.3", 4)).IsEqualTo("it930x:1-2.3:4");
        await Assert.That(It930x.Parse("it930x:1-2.3:5")).IsNull();
        await Assert.That(It930x.Parse("it930x:1-2.3")).IsNull();
        await Assert.That(It930x.Parse("it930x:foo:0")).IsNull();
        await Assert.That(It930x.Parse("asicen:1-2:0")).IsNull();
    }

    [Test]
    public async Task 挿さっている機材は受信機_5_つを_it930x_のチューナーとして挙げる()
    {
        var found = It930x.Specs([("1-2", Pe), ("4-12.1", It930x.Find(0x0511, 0x084E)!)]);

        await Assert.That(found.Select(spec => spec.Device)).IsEquivalentTo(
            new[]
            {
                "it930x:1-2:0", "it930x:1-2:1", "it930x:1-2:2", "it930x:1-2:3", "it930x:1-2:4",
                "it930x:4-12.1:0", "it930x:4-12.1:1", "it930x:4-12.1:2", "it930x:4-12.1:3", "it930x:4-12.1:4",
            },
            TUnit.Assertions.Enums.CollectionOrdering.Matching);
        await Assert.That(found[0].Name).IsEqualTo("PLEX PX-MLT5PE 1-2 #0");
        await Assert.That(found[9].Name).IsEqualTo("PLEX PX-MLT5U 4-12.1 #4");
        // 最初に選ぶ種別は地上波・BS・CS (CATV と SKY は受けられるが、最初からは選ばない)。「使う」で並ぶ
        await Assert.That(found.All(spec => spec.Types.SequenceEqual(["GR", "BS", "CS"]) && !spec.Disabled)).IsTrue();
        // 名前は重ならない (チューナーを名前で見分ける)
        await Assert.That(found.Select(spec => spec.Name).Distinct().Count()).IsEqualTo(10);
        await Assert.That(It930x.Specs([])).IsEmpty();
    }

    [Test]
    public async Task sysfs_の_MLT5_系を自動検出の形式で挙げる()
    {
        // sysfs は Linux だけ (It930xTests の sysfs のテストと同じ)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("it930xdetect");
        try
        {
            void Usb(string name, string vendor, string product)
            {
                var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
                File.WriteAllText(Path.Combine(at, "idVendor"), vendor + "\n");
                File.WriteAllText(Path.Combine(at, "idProduct"), product + "\n");
            }
            Usb("3-1", "0511", "024e");
            Usb("3-2", "0511", "0051");
            var found = It930x.Specs(It930x.Found(new SysfsUsbHost(dir.FullName), null));
            await Assert.That(found.Count).IsEqualTo(5);
            await Assert.That(found[4].Device).IsEqualTo("it930x:3-1:4");
            // 受けられる種別も返す (設定の画面が SKY を選ばせる)
            await Assert.That(DeviceProbe.Receivable("it930x:3-1:4")!).IsEquivalentTo(new[] { "GR", "BS", "CS", "CATV", "SKY" });
        }
        finally
        {
            dir.Delete(true);
        }
    }
}
