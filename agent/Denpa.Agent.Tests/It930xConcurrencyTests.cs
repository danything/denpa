using System.Text.RegularExpressions;

namespace Denpa.Agent.Tests;

/*
 * IT930x の受信機を同時に選局する (It930xDevice.cs・Cxd2856.cs)。常駐のエージェントは、スキャンで 5 つの受信機を並べて選局する。
 * 偽のブリッジ (It930xFakes.cs) が受けた I2C を、バスごとの順で読み直し、1 つの受信機の操作の途中にほかの受信機の I2C が入っていないかを確かめる。
 *
 * **固まったら失敗にする。** 各テストは最初に `await Task.Yield()` し、スレッドは時間を決めて待つ (ロックの順が逆だと止まる)
 */
[Timeout(60_000)]
public partial class It930xConcurrencyTests
{
    private static readonly It930xModel Pe = It930x.Find(0x0511, 0x024E)!;

    /// <summary>スレッドを待つ長さ。これを過ぎたら固まったとみなす</summary>
    private static readonly TimeSpan Stuck = TimeSpan.FromSeconds(30);

    private static (FakeIt930x Usb, FakeCxdBus Bus1, FakeCxdBus Bus3) Fake()
    {
        var usb = new FakeIt930x();
        var bus1 = new FakeCxdBus(0x6C, 0x64);
        var bus3 = new FakeCxdBus(0x65, 0x6C, 0x64);
        usb.I2c[1] = bus1;
        usb.I2c[3] = bus3;
        return (usb, bus1, bus3);
    }

    /// <summary>いくつものスレッドから進める時計。待つたびにほかのスレッドに順を譲り、操作が交わる機会を作る</summary>
    private sealed class SharedClock
    {
        private long _now;

        public long Now => Interlocked.Read(ref _now);

        public void Sleep(int ms)
        {
            Interlocked.Add(ref _now, ms);
            Thread.Yield();
        }
    }

    private static It930xTuner Tuner(FakeIt930x usb, string port, SharedClock clock, int receiver) =>
        new($"test {receiver}", receiver,
            () => It930xDevice.Acquire(port, () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code),
            () => It930xDevice.CloseIfIdle(port, TimeSpan.Zero));

    /// <summary>受信機ごとのスレッドを、そろって始めて走らせる。どれかが投げた例外を返す (固まったら失敗)</summary>
    private static List<Exception> Together(int count, Action<int> body)
    {
        var errors = new List<Exception>();
        using var start = new Barrier(count);
        var threads = Enumerable.Range(0, count).Select(index => new Thread(() =>
        {
            try
            {
                start.SignalAndWait();
                body(index);
            }
            catch (Exception error)
            {
                lock (errors) errors.Add(error);
            }
        })
        { IsBackground = true }).ToList();
        threads.ForEach(thread => thread.Start());
        foreach (var thread in threads)
        {
            if (!thread.Join(Stuck)) throw new TimeoutException("スレッドが終わりません (ロックの順が逆で止まった)");
        }
        return errors;
    }

    [GeneratedRegex("^I2C ([WR]) (\\d) ([0-9A-F]{2}) ?([0-9A-F]*)$")]
    private static partial Regex I2cLine();

    /// <summary>
    /// 偽のブリッジが受けた I2C を、バスごとの順で確かめる。見つけた食い違いを返す (無ければ空)。
    /// <list type="bullet">
    /// <item>中継を開けてから (X <c>08</c> ← <c>01</c>) 閉じるまで、同じバスのほかの復調器 (T・X) に届いていない (チューナーは同じアドレス 0x60 なので、中継の区切りは交えない。仕様書 1.4)</item>
    /// <item>読む番地を書いた (1 バイトの書き込み) 次の同じバスの I2C は、同じ相手からの読み (仕様書 1.3)</item>
    /// </list>
    /// </summary>
    private static List<string> Interleaving(FakeIt930x usb, It930xModel model)
    {
        List<string> lines;
        lock (usb.Log) lines = [.. usb.Log];
        var problems = new List<string>();
        var demods = model.Receivers.ToDictionary(receiver => (receiver.I2cBus, receiver.DemodAddress), receiver => receiver.Index);
        foreach (var bus in model.Receivers.Select(receiver => receiver.I2cBus).Distinct())
        {
            // 中継を開けている受信機 (復調器の T のアドレス)。開けていなければ null
            byte? relay = null;
            (byte Address, int Line)? select = null;
            for (var at = 0; at < lines.Count; at++)
            {
                var match = I2cLine().Match(lines[at]);
                if (!match.Success || byte.Parse(match.Groups[2].Value) != bus) continue;
                var write = match.Groups[1].Value == "W";
                var address = Convert.ToByte(match.Groups[3].Value, 16);
                var data = match.Groups[4].Value;
                // 復調器の T のアドレスに直す (X は T + 2。チューナーは 0x60)
                byte? demod = address == Cxd2858.Address ? null
                    : demods.ContainsKey((bus, address)) ? address
                    : demods.ContainsKey((bus, (byte)(address - 2))) ? (byte)(address - 2)
                    : throw new InvalidOperationException($"知らないアドレス 0x{address:X2}");

                if (select is { } pending)
                {
                    if (write || address != pending.Address) problems.Add($"{at}: 0x{pending.Address:X2} の読む番地を書いた ({pending.Line}) あとに、{lines[at]} が入った");
                    select = null;
                }
                if (relay is { } open && demod is { } other && other != open) problems.Add($"{at}: 0x{open:X2} の中継を開けている間に {lines[at]} が入った");
                if (relay is null && demod is null) problems.Add($"{at}: 中継が開いていないのにチューナーに届いた ({lines[at]})");

                if (write && data.Length == 2) select = (address, at);
                if (write && demod is { } x && address == x + 2 && data.StartsWith("08", StringComparison.Ordinal) && data.Length == 4)
                {
                    if (data == "0801") relay = x;
                    else if (relay == x) relay = null;
                }
            }
        }
        return problems;
    }

    [Test]
    public async Task 偽のブリッジの控えで_中継の区切りに入ったほかの受信機を見つけられる()
    {
        await Task.Yield();
        var usb = new FakeIt930x();
        lock (usb.Log)
        {
            // バス 1 の受信機 1 (0x6C) が中継を開けている間に、受信機 2 (0x64) の T に届いた
            usb.Log.AddRange(["I2C W 1 6E 0801", "I2C W 1 60 0100", "I2C W 1 64 0000", "I2C W 1 6E 0800"]);
            // 読む番地を書いたあと、別の受信機の読みが入った
            usb.Log.AddRange(["I2C W 1 6C FD", "I2C R 1 64 1"]);
        }
        var problems = Interleaving(usb, Pe);
        await Assert.That(problems.Count).IsEqualTo(2);
        await Assert.That(problems[0]).Contains("0x6C の中継を開けている間に I2C W 1 64 0000");
        await Assert.That(problems[1]).Contains("0x6C の読む番地を書いた");
    }

    [Test]
    public async Task 五つの受信機を同時に地上波で選局しても_同じバスの_I2C_は交わらない()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var clock = new SharedClock();
        var tuners = Pe.Receivers.Select(receiver => Tuner(usb, "11-1", clock, receiver.Index)).ToArray();
        try
        {
            // 常駐のスキャンと同じく、どの受信機もそろって選局し、続けてチャンネルを替える
            var errors = Together(tuners.Length, index =>
            {
                tuners[index].Tune(ChannelTable.Parse("T27")!);
                tuners[index].Tune(ChannelTable.Parse("T22")!);
            });
            await Assert.That(errors.Select(error => error.ToString())).IsEmpty();
            await Assert.That(tuners.All(tuner => tuner.Tuned)).IsTrue();
            await Assert.That(tuners.All(tuner => tuner.Signal() is { Locked: true })).IsTrue();
            await Assert.That(Interleaving(usb, Pe)).IsEmpty();
            // 機材は 1 回だけ開き、受信機はどれも 1 回だけ初期化する
            await Assert.That(usb.Log.Count(line => line == "BOOT")).IsEqualTo(1);
            foreach (var receiver in Pe.Receivers)
            {
                var x = $"I2C W {receiver.I2cBus} {receiver.DemodAddress + 2:X2} 1001";
                await Assert.That(usb.Log.Count(line => line == x)).IsEqualTo(1);
            }
        }
        finally
        {
            foreach (var tuner in tuners) tuner.Dispose();
        }
    }

    [Test]
    public async Task 最初の_J83B_の選局がほかの受信機の初期化や選局と重なっても_交わらず_動作中の受信機を初期化し直さない()
    {
        await Task.Yield();
        for (var round = 0; round < 10; round++)
        {
            var (usb, _, _) = Fake();
            var clock = new SharedClock();
            var port = $"11-2-{round}";
            var tuners = Pe.Receivers.Select(receiver => Tuner(usb, port, clock, receiver.Index)).ToArray();
            try
            {
                /*
                 * 受信機 0 と 3 は J.83B (最初の選局で全受信機を整合を保つ設定にする。It930xDevice.KeepMatching)、ほかは地上波。
                 * どの受信機もそろって始めるので、整合を保つ設定は、ほかの受信機の初期化の途中・初期化の直後・選局の途中・選局のあとのどれかに重なる
                 */
                var errors = Together(tuners.Length, index =>
                {
                    var channel = index is 0 or 3 ? "H40" : "T27";
                    tuners[index].Tune(ChannelTable.Parse(channel)!);
                    tuners[index].Tune(ChannelTable.Parse(index is 0 or 3 ? "H41" : "T22")!);
                });
                await Assert.That(errors.Select(error => error.ToString())).IsEmpty();
                await Assert.That(Interleaving(usb, Pe)).IsEmpty();
                // 整合を保つ設定が、動作中の受信機を初期化し直していない (し直すとスリープに戻り、ロックの状態を読めなくなる)
                await Assert.That(tuners.All(tuner => tuner.Tuned)).IsTrue();
                await Assert.That(tuners.All(tuner => tuner.Signal() is { Locked: true })).IsTrue();
                // どの受信機も整合を保つ設定になった
                var device = tuners[0].Device!;
                foreach (var receiver in Pe.Receivers) await Assert.That(device.Frontend(receiver.Index).KeepsMatching).IsTrue();
                // 初期化は受信機ごとに 2 回まで (設定の前に初期化した受信機を、待機させるためにもう一度初期化する。仕様書 4.7)
                foreach (var receiver in Pe.Receivers)
                {
                    var x = $"I2C W {receiver.I2cBus} {receiver.DemodAddress + 2:X2} 1001";
                    await Assert.That(usb.Log.Count(line => line == x)).IsLessThanOrEqualTo(2);
                }
            }
            finally
            {
                foreach (var tuner in tuners) tuner.Dispose();
            }
        }
    }

    [Test]
    public async Task 整合を保つ設定で初期化した直後の受信機は_もう一度初期化しない()
    {
        await Task.Yield();
        var (usb, _, bus3) = Fake();
        var clock = new SharedClock();
        var cable = Tuner(usb, "11-3", clock, 0);
        var ground = Tuner(usb, "11-3", clock, 3);
        try
        {
            // 受信機 0 が J.83B で整合を保つ設定にしたあと、受信機 3 は設定の中で初期化されて待機している
            cable.Tune(ChannelTable.Parse("H40")!);
            await Assert.That(bus3.Log.Count(line => line == "6C X 10=01")).IsEqualTo(1);
            // 初期化済みで待機中の受信機に、もう一度整合を保つ設定を求めても初期化し直さない
            cable.Device!.Frontend(3).KeepMatching(standby: true);
            await Assert.That(bus3.Log.Count(line => line == "6C X 10=01")).IsEqualTo(1);
            ground.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(bus3.Log.Count(line => line == "6C X 10=01")).IsEqualTo(1);
        }
        finally
        {
            cable.Dispose();
            ground.Dispose();
        }
    }

    /// <summary>EP 0x84 に、入力 0〜4 のパケットを 1 つずつ混ぜて流し続ける (どの受信機も流している TS の代わり)</summary>
    private static Func<byte[]?> AllInputs()
    {
        var number = 0;
        return () =>
        {
            var chunk = new List<byte>();
            for (var i = 0; i < 20; i++, number++)
            {
                for (var input = 0; input < It930xBridge.TsInputs; input++)
                {
                    var packet = new byte[188];
                    packet[0] = It930xBridge.SyncBytes[input];
                    packet[1] = (byte)input;
                    packet[2] = (byte)number;
                    chunk.AddRange(packet);
                }
            }
            return [.. chunk];
        };
    }

    /// <summary>出口から 1 パケット読めるか (2 秒で打ち切る)</summary>
    private static bool Flowing(It930xTuner tuner)
    {
        var read = Task.Run(() =>
        {
            var buffer = new byte[188];
            var got = 0;
            while (got < buffer.Length)
            {
                var n = tuner.Output.Read(buffer, got, buffer.Length - got);
                if (n == 0) return false;
                got += n;
            }
            return buffer[0] == 0x47;
        });
        return read.Wait(TimeSpan.FromSeconds(2)) && read.Result;
    }

    /// <summary>TS の経路のレジスタ (5 つの入力で共有する 0xDA00〜0xDAFF と EP の 0xDD00〜0xDDFF) への書き込みを、<paramref name="from"/> 行目から並べる</summary>
    private static List<string> RouteWrites(FakeIt930x usb, int from)
    {
        lock (usb.Log) return [.. usb.Log.Skip(from).Where(It930xDeviceTests.TsRouteWrite)];
    }

    [Test]
    public async Task 受信機を_1_つから_5_つまで足しても_捨てても_流している間はブリッジの_TS_の経路を書き換えない()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        usb.TsSource = AllInputs();
        var clock = new SharedClock();
        var tuners = Pe.Receivers.Select(receiver => Tuner(usb, "11-4", clock, receiver.Index)).ToArray();
        try
        {
            // 1 つ目の選局で機材を開く。入力 0〜4 はそのとき全部開ける
            tuners[0].Tune(ChannelTable.Parse("T27")!);
            int opened;
            lock (usb.Log) opened = usb.Log.LastIndexOf("W DA5A=1F") + 1;
            await Assert.That(opened).IsGreaterThan(0);
            foreach (var receiver in Pe.Receivers)
            {
                await Assert.That(usb.Registers.GetValueOrDefault(It930xBridge.TsEnable + (uint)receiver.TsInput)).IsEqualTo((byte)1);
            }
            await Assert.That(Flowing(tuners[0])).IsTrue();
            // 2 つ目から 5 つ目を 1 つずつ足す。足すたびに、流している受信機はどれも流れ続け、TS の経路には書かない
            for (var count = 2; count <= tuners.Length; count++)
            {
                tuners[count - 1].Tune(ChannelTable.Parse(count % 2 == 0 ? "T22" : "T27")!);
                for (var index = 0; index < count; index++) await Assert.That(Flowing(tuners[index])).IsTrue();
                await Assert.That(RouteWrites(usb, opened)).IsEmpty();
            }
            // 並べて選局し直しても、捨てても書かない (受信機 0 は使い続けて、機材を閉じない)
            var errors = Together(tuners.Length - 1, index =>
            {
                var tuner = tuners[index + 1];
                for (var i = 0; i < 3; i++) tuner.Tune(ChannelTable.Parse(i % 2 == 0 ? "T27" : "T22")!);
                tuner.Dispose();
            });
            await Assert.That(errors.Select(error => error.ToString())).IsEmpty();
            await Assert.That(Interleaving(usb, Pe)).IsEmpty();
            await Assert.That(RouteWrites(usb, opened)).IsEmpty();
            await Assert.That(tuners[0].Tuned).IsTrue();
            await Assert.That(Flowing(tuners[0])).IsTrue();
        }
        finally
        {
            foreach (var tuner in tuners) tuner.Dispose();
        }
        // 最後の受信機を捨てて閉じるときに、入力を全部閉じて EP 0x84 をリセットする (DRV_ResetRxPort)。そのあと読みを止める
        var after = RouteWrites(usb, 0).SkipWhile(line => line != "W DA5A=1F").Skip(1).ToList();
        await Assert.That(after).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        await Assert.That(usb.Log.IndexOf("TS 閉じる")).IsGreaterThan(usb.Log.LastIndexOf("W DA1D=00"));
    }

    [Test]
    public async Task 受信機の_TS_を読む側が止まっても_EP_0x84_の読みは止まらずその受信機のパケットだけを捨てる()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        // 受信機 1 (PX-MLT5PE の入力 1) のパケットを、1 回の読みで 348 個 (65,424 バイト) ずつ流し続ける
        var packet = new byte[188];
        packet[0] = It930xBridge.SyncBytes[1];
        var chunk = Enumerable.Repeat(packet, 348).SelectMany(bytes => bytes).ToArray();
        usb.TsSource = () => chunk;
        var tuner = Tuner(usb, "11-30", new SharedClock(), 1);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            var device = tuner.Device!;
            // 出口 (8 MB) を読まずに溢れさせる
            var deadline = DateTime.UtcNow + Stuck;
            while (tuner.Dropped == 0 && DateTime.UtcNow < deadline) Thread.Sleep(10);
            await Assert.That(tuner.Dropped).IsGreaterThan(0L);
            // 溢れたあとも EP 0x84 の読みは進み、捨てた数が増え続ける
            var reads = device.TsReads;
            var dropped = tuner.Dropped;
            while ((device.TsReads < reads + 50 || tuner.Dropped <= dropped) && DateTime.UtcNow < deadline) Thread.Sleep(10);
            await Assert.That(device.TsReads).IsGreaterThanOrEqualTo(reads + 50);
            await Assert.That(tuner.Dropped).IsGreaterThan(dropped);
            // 読む側が読み始めれば、また届く
            await Assert.That(Flowing(tuner)).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task TS_のバッファを捨てるときは入力を全部閉じてリセットし_開け直す()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        usb.TsSource = AllInputs();
        var clock = new SharedClock();
        var tuner = Tuner(usb, "11-12", clock, 1);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            int from;
            lock (usb.Log) from = usb.Log.Count;
            tuner.FlushTs();
            // SDK の DRV_ResetRxPort (閉じる側) のあと、IT930x_probe と同じ順で開け直す
            await Assert.That(RouteWrites(usb, from)).IsEquivalentTo(new[]
            {
                "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00",
                "W DA4C=01", "W DA4D=01", "W DA4E=01", "W DA4F=01", "W DA50=01", "W DA5A=1F",
            });
            await Assert.That(Flowing(tuner)).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task TS_のバッファを捨てるときに入力を閉じられなければ_開け直さずにその失敗を返す()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var device = It930xDevice.Acquire("11-13", () => (usb, Pe), _ => { }, () => 0, () => It930xFirmware.Code);
        try
        {
            int from;
            lock (usb.Log) from = usb.Log.Count;
            // 入力を閉じる最初の書き込みに応答しない
            usb.Silent = 1;
            Assert.Throws<It930xException>(device.FlushTs);
            await Assert.That(RouteWrites(usb, from).Where(line => line.EndsWith("=01", StringComparison.Ordinal))).IsEmpty();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("11-13", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task 閉じた機材では_TS_のバッファを捨てず_閉じた入力を開け直さない()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var device = It930xDevice.Acquire("11-14", () => (usb, Pe), _ => { }, () => 0, () => It930xFirmware.Code);
        device.Release();
        It930xDevice.CloseIfIdle("11-14", TimeSpan.Zero);
        int from;
        lock (usb.Log) from = usb.Log.Count;
        device.FlushTs();
        await Assert.That(RouteWrites(usb, from)).IsEmpty();
        await Assert.That(usb.Registers.GetValueOrDefault(It930xBridge.TsEnable)).IsEqualTo((byte)0);
    }

    [Test]
    public async Task TS_のバッファを捨てるのと閉じるのが重なっても_閉じたあとに入力は開いていない()
    {
        await Task.Yield();
        for (var round = 0; round < 20; round++)
        {
            var (usb, _, _) = Fake();
            var port = $"11-15-{round}";
            var device = It930xDevice.Acquire(port, () => (usb, Pe), _ => { }, () => 0, () => It930xFirmware.Code);
            device.Release();
            var errors = Together(2, index =>
            {
                if (index == 0) device.FlushTs();
                else It930xDevice.CloseIfIdle(port, TimeSpan.Zero);
            });
            await Assert.That(errors.Select(error => error.ToString())).IsEmpty();
            // 最後に書いたのは閉じる処理で、入力はどれも閉じている
            foreach (var receiver in Pe.Receivers)
            {
                await Assert.That(usb.Registers.GetValueOrDefault(It930xBridge.TsEnable + (uint)receiver.TsInput)).IsEqualTo((byte)0);
            }
        }
    }

    [Test]
    public async Task 電源を切ったあと_100_ms_待ってから_USB_を閉じる()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var clock = new FakeClock();
        var device = It930xDevice.Acquire("11-5", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code);
        device.Release();
        var before = clock.Sleeps.Count;
        It930xDevice.CloseIfIdle("11-5", TimeSpan.Zero);
        // GPIOH2 ← 0、GPIOH7 ← 1 のあと 100 ms (仕様書 1.5・10.3・11)。その前の 10 ms は、入力を全部閉じてから EP 0x84 をリセットするまでの待ち (DRV_ResetRxPort)
        await Assert.That(usb.Log.TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" });
        await Assert.That(clock.Sleeps.Skip(before)).IsEquivalentTo(new[] { It930xBridge.InputsOffSettleMs, It930xDevice.PowerOffSettleMs });
        await Assert.That(It930xDevice.PowerOffSettleMs).IsEqualTo(100);
    }

    [Test]
    public async Task 開き直した機材では整合を保つ設定を使わないところから始める()
    {
        await Task.Yield();
        var (usb, _, bus3) = Fake();
        var clock = new FakeClock();
        var cable = new It930xTuner("test 0", 0,
            () => It930xDevice.Acquire("11-6", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code), () => It930xDevice.CloseIfIdle("11-6", TimeSpan.Zero));
        cable.Tune(ChannelTable.Parse("H40")!);
        await Assert.That(cable.Device!.Frontend(3).KeepsMatching).IsTrue();
        // 全部閉じて電源を切る。開き直すと (GPIOH7 ← 0)、整合を保つ設定は使わないところから (仕様書 1.5)
        cable.Dispose();
        usb.ResetSequence();
        var ground = new It930xTuner("test 3", 3,
            () => It930xDevice.Acquire("11-6", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code), () => It930xDevice.CloseIfIdle("11-6", TimeSpan.Zero));
        try
        {
            var lines = bus3.Log.Count;
            ground.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(ground.Device!.Frontend(3).KeepsMatching).IsFalse();
            // 初期化の手順 2 は 00 (仕様書 4.2)
            await Assert.That(bus3.Log.Skip(lines)).Contains("6C U 67=00");
        }
        finally
        {
            ground.Dispose();
        }
    }

    /// <summary>電源の GPIOH7 の値の書き込み (仕様書 1.5)。開いたときの設定のぶんも数える</summary>
    private static int PowerWrites(FakeIt930x usb)
    {
        lock (usb.Log) return usb.Log.Count(line => line.StartsWith("W D8C3=", StringComparison.Ordinal));
    }

    /// <summary>EP 0x84 の読みを閉じたか (機材を閉じた)</summary>
    /// <summary>
    /// 機材を閉じ終えた (USB を閉じた)。読みのスレッドが残す「TS 閉じる」は、閉じる処理が電源を切るより前に出るので、
    /// それを待つと最後の書き込み (電源を切る) より先に確かめてしまう (Windows の CI で時々落ちていた)
    /// </summary>
    private static bool Closed(FakeIt930x usb) => usb.Disposed;

    private static It930xDevice OpenAt(FakeIt930x usb, string port) =>
        It930xDevice.Acquire(port, () => (usb, Pe), _ => { }, () => 0, () => It930xFirmware.Code);

    [Test]
    public async Task 返してから待つ間に取り直すと_電源を入り切りせずに同じ機材を使う()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var first = OpenAt(usb, "11-8");
        try
        {
            var powered = PowerWrites(usb);
            // カードの状態を確かめるたびに、使っていない内蔵カードリーダーを開いて閉じるのと同じ
            for (var i = 0; i < 5; i++)
            {
                first.Release();
                It930xDevice.CloseIfIdle("11-8", TimeSpan.FromSeconds(30));
                await Assert.That(OpenAt(usb, "11-8")).IsSameReferenceAs(first);
            }
            await Assert.That(PowerWrites(usb)).IsEqualTo(powered);
            await Assert.That(usb.Log.Count(line => line == "BOOT")).IsEqualTo(1);
            await Assert.That(It930xDevice.IdleGrace).IsEqualTo(TimeSpan.FromSeconds(30));
        }
        finally
        {
            first.Release();
            It930xDevice.CloseIfIdle("11-8", TimeSpan.Zero);
        }
        // 最後に書いたレジスタが電源を切る GPIOH7 (TS の読みを閉じた印は、読むスレッドが電源を切ったあとに残すことがある)
        await Assert.That(usb.Log.Last(entry => entry.StartsWith("W ", StringComparison.Ordinal))).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task 待つ間に取り直されなければ_そのあと閉じて電源を切る()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var device = OpenAt(usb, "11-9");
        device.Release();
        It930xDevice.CloseIfIdle("11-9", TimeSpan.FromMilliseconds(100));
        // まだ閉じていない
        await Assert.That(Closed(usb)).IsFalse();
        for (var i = 0; i < 100 && !Closed(usb); i++) await Task.Delay(50);
        await Assert.That(Closed(usb)).IsTrue();
        // 最後に書いたレジスタが電源を切る GPIOH7 (TS の読みを閉じた印は、読むスレッドが電源を切ったあとに残すことがある)
        await Assert.That(usb.Log.Last(entry => entry.StartsWith("W ", StringComparison.Ordinal))).IsEqualTo("W D8C3=01");
        // 閉じた機材は使わず、次の Acquire は開き直す
        usb.ResetSequence();
        var again = OpenAt(usb, "11-9");
        try
        {
            await Assert.That(again).IsNotSameReferenceAs(device);
        }
        finally
        {
            again.Release();
            It930xDevice.CloseIfIdle("11-9", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task エージェントを止めるときは待たずに閉じる()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var device = OpenAt(usb, "11-10");
        device.Release();
        It930xDevice.CloseIfIdle("11-10", TimeSpan.FromSeconds(30));
        await Assert.That(Closed(usb)).IsFalse();
        // CloseAll と同じ処理を、このテストのポートだけに
        It930xDevice.CloseAll(port => port == "11-10");
        await Assert.That(Closed(usb)).IsTrue();
        // 最後に書いたレジスタが電源を切る GPIOH7 (TS の読みを閉じた印は、読むスレッドが電源を切ったあとに残すことがある)
        await Assert.That(usb.Log.Last(entry => entry.StartsWith("W ", StringComparison.Ordinal))).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task 初期化の前にチューナーの_62_を読む()
    {
        await Task.Yield();
        var (usb, _, bus3) = Fake();
        bus3[0x65].Tuner[0x62] = 0x10;
        var clock = new FakeClock();
        var device = It930xDevice.Acquire("11-7", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code);
        try
        {
            var frontend = device.Frontend(0);
            await Assert.That(frontend.PowerProbe).IsEqualTo((byte)0x10);
            // 中継を開けてすぐ、仕様書 4.2 の手順 1 より前に読む (仕様書 10.3)
            var open = bus3.Log.IndexOf("65 X 08=01");
            await Assert.That(bus3.Log.Skip(open).Take(3)).IsEquivalentTo(new[] { "65 X 08=01", "65 U 62?", "65 U 01=00" });
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("11-7", TimeSpan.Zero);
        }
    }
}
