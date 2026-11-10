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
            () => It930xDevice.CloseIfIdle(port));

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

    [Test]
    public async Task 選局と捨てるのを繰り返しても_TS_入力は使っている受信機のものだけが開いている()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var clock = new SharedClock();
        var tuners = Pe.Receivers.Select(receiver => Tuner(usb, "11-4", clock, receiver.Index)).ToArray();
        // 受信機 0 だけは最後まで使い続ける (機材を閉じないように)
        tuners[0].Tune(ChannelTable.Parse("T27")!);
        try
        {
            var errors = Together(tuners.Length - 1, index =>
            {
                var tuner = tuners[index + 1];
                for (var i = 0; i < 5; i++)
                {
                    tuner.Tune(ChannelTable.Parse(i % 2 == 0 ? "T22" : "T27")!);
                    // 読み出しを止めるのと同じく、選局のあと TS を止める (StopOutput) のは次の選局
                }
            });
            await Assert.That(errors.Select(error => error.ToString())).IsEmpty();
            await Assert.That(Interleaving(usb, Pe)).IsEmpty();
            // 開いている TS 入力は、選局している 5 つの受信機のぶん
            foreach (var receiver in Pe.Receivers)
            {
                await Assert.That(usb.Registers.GetValueOrDefault(It930xBridge.TsEnable + (uint)receiver.TsInput)).IsEqualTo((byte)1);
            }
            for (var index = 1; index < tuners.Length; index++) tuners[index].Dispose();
            // 捨てた受信機の入力は閉じ、使っている受信機 0 の入力は開いたまま
            foreach (var receiver in Pe.Receivers)
            {
                var expected = (byte)(receiver.Index == 0 ? 1 : 0);
                await Assert.That(usb.Registers.GetValueOrDefault(It930xBridge.TsEnable + (uint)receiver.TsInput)).IsEqualTo(expected);
            }
            await Assert.That(tuners[0].Tuned).IsTrue();
        }
        finally
        {
            foreach (var tuner in tuners) tuner.Dispose();
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
        It930xDevice.CloseIfIdle("11-5");
        // GPIOH2 ← 0、GPIOH7 ← 1 のあと 100 ms (仕様書 1.5・10.3・11)
        await Assert.That(usb.Log.TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" });
        await Assert.That(clock.Sleeps.Skip(before)).IsEquivalentTo(new[] { It930xDevice.PowerOffSettleMs });
        await Assert.That(It930xDevice.PowerOffSettleMs).IsEqualTo(100);
    }

    [Test]
    public async Task 開き直した機材では整合を保つ設定を使わないところから始める()
    {
        await Task.Yield();
        var (usb, _, bus3) = Fake();
        var clock = new FakeClock();
        var cable = new It930xTuner("test 0", 0,
            () => It930xDevice.Acquire("11-6", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code), () => It930xDevice.CloseIfIdle("11-6"));
        cable.Tune(ChannelTable.Parse("H40")!);
        await Assert.That(cable.Device!.Frontend(3).KeepsMatching).IsTrue();
        // 全部閉じて電源を切る。開き直すと (GPIOH7 ← 0)、整合を保つ設定は使わないところから (仕様書 1.5)
        cable.Dispose();
        usb.ResetSequence();
        var ground = new It930xTuner("test 3", 3,
            () => It930xDevice.Acquire("11-6", () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code), () => It930xDevice.CloseIfIdle("11-6"));
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
            It930xDevice.CloseIfIdle("11-7");
        }
    }
}
