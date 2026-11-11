using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * TC90522 の機種を、機材 (It930xDevice) とチューナー (It930xTuner) を通して確かめる。
 * Q3・W3 系の開く・閉じるの順 (Tc90522Board)、Q3 の 2 つの側の電源の連動、受信機が 1 つの機種 (Tc90522Single)、
 * 機種の表と自動検出 (It930x.cs)、--it930x-probe --chips。
 * 偽のブリッジ (It930xFakes.cs) の I2C を、偽の TC90522 のバス (Tc90522Fakes.cs) につなぐ。期待値は仕様書 (denpa-spec の px4/spec.md) の節の値と順。
 */
public class Tc90522BoardTests
{
    private static readonly It930xModel W3 = It930x.Find(0x0511, 0x083F)!;
    private static readonly It930xModel Q3 = It930x.Find(0x0511, 0x024A)!;

    /// <summary>R850 の水晶の駆動の強さを調べるときに書く 40 バイト (仕様書 7.3。種類 0)</summary>
    private const string R850Trial = "CAC0725000E0003086BBF8B0D281CD46374089925505080021F9845FC420A96C53AB5B46B3936E40";

    private static readonly string Zeros = new('0', 80);

    /// <summary>偽の R850 (電源を入れたときの 08〜2F は 0) を初期化したときの控え (仕様書 7.3)。<paramref name="demod"/> は中継に使う復調器</summary>
    private static string[] R850Init(string demod) =>
    [
        $"{demod} R850 ?1", $"{demod} R850 ?1", $"{demod} R850 ?1", $"{demod} R850 ?1", $"{demod} R850 ?48",
        $"{demod} R850 08={R850Trial}",
        $"{demod} R850 22=84", $"{demod} R850 ?3", $"{demod} R850 22=94", $"{demod} R850 ?3",
        $"{demod} R850 22=A4", $"{demod} R850 ?3", $"{demod} R850 22=B4", $"{demod} R850 ?3",
        $"{demod} R850 08={Zeros}",
    ];

    /// <summary>地上波の起動の 12 行 (仕様書 4.2)</summary>
    private static string[] WakeTerrestrial(string demod) =>
    [
        $"{demod} B0=A0", $"{demod} B2=3D", $"{demod} B3=25", $"{demod} B4=8B", $"{demod} B5=4B", $"{demod} B6=3F", $"{demod} B7=FF", $"{demod} B8=C0",
        $"{demod} 1F=00", $"{demod} 75=00", $"{demod} 1D=A8", $"{demod} 03=00",
    ];

    /// <summary>衛星の起動の 7 行 (仕様書 4.2)</summary>
    private static string[] WakeSatellite(string demod) =>
        [$"{demod} 15=00", $"{demod} 1D=00", $"{demod} 04=02", $"{demod} 1C=80", $"{demod} 1F=22", $"{demod} 13=00", $"{demod} 17=00"];

    /// <summary>衛星のスリープ (RT710 の待機と復調器。仕様書 4.1 の 3)</summary>
    private static string[] SleepSatellite(string demod) => [$"{demod} RT710 00={Tc90522Tests.Rt710Standby}", $"{demod} 13=80", $"{demod} 17=FF"];

    private static (FakeIt930x Usb, FakeTcBus Bus) Fake()
    {
        var usb = new FakeIt930x();
        var bus = FakeTcBus.W3();
        usb.I2c[2] = bus;
        return (usb, bus);
    }

    private static It930xDevice Open(FakeIt930x usb, string port, FakeClock clock, It930xModel model, Func<It930xDevice?>? link = null) =>
        It930xDevice.Acquire(port, () => (usb, model), clock.Sleep, () => clock.Now, () => It930xFirmware.Code, link: link);

    private static It930xTuner Tuner(FakeIt930x usb, string port, int receiver, FakeClock clock, It930xModel model, string? lnb = null, Func<It930xDevice?>? link = null) =>
        new($"test {receiver}", receiver, () => Open(usb, port, clock, model, link), () => It930xDevice.CloseIfIdle(port), lnb);

    private static List<string> Lines(FakeIt930x usb, Func<string, bool> pick)
    {
        lock (usb.Log) return [.. usb.Log.Where(pick)];
    }

    private static bool Starts(string line, params string[] prefixes) => prefixes.Any(prefix => line.StartsWith(prefix, StringComparison.Ordinal));

    // ---------------------------------------------------------------------
    // Q3・W3 系
    // ---------------------------------------------------------------------

    [Test]
    public async Task W3_を開くと仕様書_2_3_の値でブリッジを設定し_電源を入れる()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        var device = Open(usb, "6-1", clock, W3);
        try
        {
            // 中継の相手: 受信機 0〜3 の順に 0x22・0x26・0x20・0x24、バスはどれも 2。5 つ目の欄は書かない
            await Assert.That(Lines(usb, line => Starts(line, "W 4975", "W 4974", "W 4973", "W 4972", "W 4964", "W 4971", "W 4970", "W 496F", "W 496E", "W 4963"))).IsEquivalentTo(new[]
            {
                "W 4975=22", "W 4971=02", "W 4974=26", "W 4970=02", "W 4973=20", "W 496F=02", "W 4972=24", "W 496E=02",
            }, CollectionOrdering.Matching);
            // I2C の速さ
            await Assert.That(Lines(usb, line => Starts(line, "W F6A7", "W F103")).TakeLast(2)).IsEquivalentTo(new[] { "W F6A7=07", "W F103=07" }, CollectionOrdering.Matching);
            // 入力を全部閉じてから、TS 入力 1〜4 にまとめる設定と同期バイト (0x17・0x27・0x37・0x47)。入力 0 には書かない。読みを出してから、使う入力 1〜4 を開ける
            await Assert.That(Lines(usb, line => Starts(line, "W DA7", "W DA4", "W DA58", "W DA59"))).IsEquivalentTo(new[]
            {
                "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA58=00", "W DA59=00",
                "W DA74=01", "W DA79=17", "W DA75=01", "W DA7A=27", "W DA76=01", "W DA7B=37", "W DA77=01", "W DA7C=47",
                "W DA4D=01", "W DA4E=01", "W DA4F=01",
            }, CollectionOrdering.Matching);
            // GPIO (仕様書 2.5): GPIOH7 = 1、GPIOH2 = 0、GPIOH11 = 0 にしてから、電源を入れる (GPIOH7 ← 0、80 ms、GPIOH2 ← 1、20 ms)
            await Assert.That(Lines(usb, line => Starts(line, "W D8B", "W D8C", "W D8D"))).IsEquivalentTo(new[]
            {
                "W D8C4=01", "W D8C5=01", "W D8C3=01",
                "W D8B8=01", "W D8B9=01", "W D8B7=00",
                "W D8D4=01", "W D8D5=01", "W D8D3=00",
                "W D8C3=00", "W D8B7=01",
            }, CollectionOrdering.Matching);
            await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 20, 20, 80, 20 }, CollectionOrdering.Matching);
            // 受信機には、開くまで触らない
            await Assert.That(bus.Log).IsEmpty();
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("6-1", TimeSpan.Zero);
        }
        // 閉じると電源を切る (GPIOH2 ← 0、GPIOH7 ← 1)。受信機を開いていなければ、チップには何も書かない
        await Assert.That(Lines(usb, line => Starts(line, "W D8")).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" }, CollectionOrdering.Matching);
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 最初の受信機を開くとチューナーを_0_から_3_の順に初期化し_ほかをスリープにして_共通設定を書く()
    {
        var (usb, bus) = Fake();
        var device = Open(usb, "6-2", new FakeClock(), W3);
        try
        {
            // 受信機 2 (地上波 0x10) を開く (仕様書 4.1)
            var frontend = device.Frontend(2);
            await Assert.That(bus.Log).IsEquivalentTo((string[])
            [
                // 2: チューナーの初期化。受信機 0・1 は RT710 (03 を読む)、2・3 は R850
                "11 RT710 ?4", "13 RT710 ?4", .. R850Init("10"), .. R850Init("12"),
                // 3: 開く受信機のほかの 3 つをスリープに。衛星は RT710 の待機と復調器、地上波は復調器だけ
                .. SleepSatellite("11"), .. SleepSatellite("13"), "12 03=F0",
                // 4: 開く受信機の起動
                .. WakeTerrestrial("10"),
                // 5: TS 出力の共通設定 (仕様書 4.4)。受信機 0 の衛星のアドレスと、受信機 2 の地上波のアドレスに書く
                "11 07=31", "11 08=77", "10 0E=77", "10 0F=13",
            ], CollectionOrdering.Matching);
            await Assert.That(frontend.Chips).IsEqualTo("TC90522 0x10 + R850 (種類 0、水晶の駆動の強さ 3)");

            // 2 つ目からは起動だけ (仕様書 4.2)
            bus.Log.Clear();
            await Assert.That(device.Frontend(1).Chips).IsEqualTo("TC90522 0x13 + RT710");
            await Assert.That(bus.Log).IsEquivalentTo(WakeSatellite("13"), CollectionOrdering.Matching);
            // 開いている受信機は、もう一度取っても何も書かない
            bus.Log.Clear();
            device.Frontend(2);
            await Assert.That(bus.Log).IsEmpty();

            // 閉じる (仕様書 11.3): ほかに開いている受信機があればスリープにする。最後の受信機は何も書かない
            device.Rest(1);
            await Assert.That(bus.Log).IsEquivalentTo(SleepSatellite("13"), CollectionOrdering.Matching);
            bus.Log.Clear();
            device.Rest(2);
            await Assert.That(bus.Log).IsEmpty();

            // 電源が入ったまま、開いている受信機が無い状態から開くときは、初期化からやり直す (仕様書 2.6)
            device.Frontend(0);
            await Assert.That(bus.Log.Take(2)).IsEquivalentTo(new[] { "11 RT710 ?4", "13 RT710 ?4" }, CollectionOrdering.Matching);
            await Assert.That(bus.Log.TakeLast(11)).IsEquivalentTo((string[])
            [
                .. WakeSatellite("11"), "11 07=31", "11 08=77", "10 0E=77", "10 0F=13",
            ], CollectionOrdering.Matching);
            // 受信機 0 を開くときにスリープにするのは 1・2・3
            await Assert.That(bus.Log).Contains("10 03=F0");
            await Assert.That(bus.Log).DoesNotContain($"11 RT710 00={Tc90522Tests.Rt710Standby}");
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("6-2", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task チューナーを初期化できなければ受信機を開かず_次にもう一度試す()
    {
        var (usb, bus) = Fake();
        var device = Open(usb, "6-3", new FakeClock(), W3);
        try
        {
            // 受信機 3 の R850 が応答しない (種類の読み出しが 4 回とも誤り)。電源を入れ直した 2 回目も同じ
            bus[0x12].Tuners[R850.Address].FailReads = 8;
            var error = Assert.Throws<IOException>(() => device.Frontend(2));
            await Assert.That(error.Message).Contains("PLEX PX-W3U4 6-3 の受信機 2 を初期化できません");
            await Assert.That(device.Faulted).IsFalse();
            // 電源を入れ直すのは 1 回だけ (開いたときの 1 回と合わせて、GPIOH7 ← 0 は 2 回)
            await Assert.That(Lines(usb, line => line == "W D8C3=00").Count).IsEqualTo(2);
            // スリープや起動には進んでいない
            await Assert.That(bus.Log.Any(line => line.StartsWith("10 B0=", StringComparison.Ordinal))).IsFalse();
            // 次は初期化からやり直して開ける
            bus.Log.Clear();
            device.Frontend(2);
            await Assert.That(bus.Log.Take(2)).IsEquivalentTo(new[] { "11 RT710 ?4", "13 RT710 ?4" }, CollectionOrdering.Matching);
            await Assert.That(bus.Log[^1]).IsEqualTo("10 0F=13");
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("6-3", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task 最初の受信機の初期化に失敗したら_電源を入れ直して_1_回だけやり直す()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        var device = Open(usb, "6-7", clock, W3);
        try
        {
            // 受信機 0 の RT710 が、電源を入れた直後の 1 回だけ応答しない
            bus[0x11].Tuners[Rt710.Address].FailReads = 1;
            var before = clock.Sleeps.Count;
            var frontend = device.Frontend(2);
            await Assert.That(frontend.Chips).StartsWith("TC90522 0x10");
            // 切る (GPIOH2 ← 0、GPIOH7 ← 1) → 20 ms → 入れる (GPIOH7 ← 0、80 ms、GPIOH2 ← 1、20 ms)。順と待ちは開くときと同じ
            await Assert.That(Lines(usb, line => Starts(line, "W D8C3", "W D8B7")).TakeLast(4)).IsEquivalentTo(new[]
            {
                "W D8B7=00", "W D8C3=01", "W D8C3=00", "W D8B7=01",
            }, CollectionOrdering.Matching);
            await Assert.That(clock.Sleeps.Skip(before).Take(3)).IsEquivalentTo(new[] { 20, 80, 20 }, CollectionOrdering.Matching);
            // やり直しは、チューナーの初期化の先頭から
            await Assert.That(bus.Log.Count(line => line == "11 RT710 ?4")).IsEqualTo(2);
            await Assert.That(bus.Log[^1]).IsEqualTo("10 0F=13");
        }
        finally
        {
            device.Release();
            It930xDevice.CloseIfIdle("6-7", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task ほかに使っている側がいれば_初期化に失敗しても電源を入れ直さない()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        // カードや、Q3 のもう片方の側が同じ機材を取っている (使っている側が 2 つ)
        var device = Open(usb, "6-8", clock, W3);
        var other = Open(usb, "6-8", clock, W3);
        try
        {
            bus[0x11].Tuners[Rt710.Address].FailReads = 1;
            Assert.Throws<IOException>(() => device.Frontend(2));
            await Assert.That(Lines(usb, line => line == "W D8C3=00").Count).IsEqualTo(1);
            // 次の呼び出しは、初期化からやり直して開ける (電源は入れ直さない)
            device.Frontend(2);
            await Assert.That(Lines(usb, line => line == "W D8C3=00").Count).IsEqualTo(1);
        }
        finally
        {
            other.Release();
            device.Release();
            It930xDevice.CloseIfIdle("6-8", TimeSpan.Zero);
        }
    }

    [Test]
    public async Task 受信機が_1_つの機種も_初期化に失敗したら電源を入れ直してやり直す()
    {
        var model = It930x.Find(0x0511, 0x0854)!;
        var (usb, bus) = Single(model);
        bus[0x10].Tuners[R850.Address].FailReads = 4;
        var tuner = Tuner(usb, "5-8", 0, new FakeClock(), model);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(tuner.Tuned).IsTrue();
            // 1 回目の失敗で電源を切り (GPIOH3 ← 1)、開き直すときに入れ直す
            await Assert.That(Lines(usb, line => Starts(line, "W D8B3")).Skip(1)).IsEquivalentTo(new[] { "W D8B3=00", "W D8B3=01", "W D8B3=00" }, CollectionOrdering.Matching);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 選局に失敗したあとも_チューナーに書いた値と_PLL_と復調器の状態を出す()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        var ground = Tuner(usb, "6-9", 2, clock, W3);
        var dish = Tuner(usb, "6-9", 0, clock, W3);
        try
        {
            // 選局する前と、受けられない種別を断ったあとは、出すものが無い
            await Assert.That(ground.Diagnose()).IsEmpty();
            Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(ground.Diagnose()).IsEmpty();

            // 地上波がロックしない (80 の bit3)
            bus[0x10].Status[0x80] = 0x08;
            var error = Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
            await Assert.That(ground.Diagnose()).IsEquivalentTo(new[]
            {
                $"R850  種類 0 (00 = 0x00)  水晶の駆動の強さ 3  M 8  N 92  S 2E16  08〜2F {Tc90522Tests.R850Ch27}  2F 42",
                "R850 の PLL  ロックしている (02 = 0x7E。bit6 がロック)",
                "復調器 0x10  80 = 0x08  B0 = 0x88  (ロックは、80 の bit5 と bit3 が 0 で、B0 の下位 4 ビットが 8 以上)",
            }, CollectionOrdering.Matching);

            // R850 の PLL がロックしない
            bus[0x10].Tuners[R850.Address].Status[0x02] = 0x3E;
            Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(ground.Diagnose()[1]).IsEqualTo("R850 の PLL  ロックしていない (02 = 0x3E。bit6 がロック)");

            // 衛星がロックしない (C3 の bit4)。TMCC は読めた値のまま出す
            bus[0x11].Status[0xC3] = 0x10;
            bus[0x11].Status[0xCE] = 0x40;
            bus[0x11].Status[0xCF] = 0xF1;
            Assert.Throws<IOException>(() => dish.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(dish.Diagnose()).IsEquivalentTo(new[]
            {
                $"RT710 (03 = 0x70)  書いた値 00={Tc90522Tests.Rt710Start} 04=41 05=4A 04=41 07=EA 06=AE 0A=39 02=20 08=07 0E=90 0F=45",
                "RT710 の PLL  ロックしている (02 = 0x80。bit7 がロック)",
                "復調器 0x11  C3 = 0x10  (ロックは bit4 が 0)",
                "TMCC の TSID  0:16625 1:0 2:0 3:0 4:0 5:0 6:0 7:0  選ばれている TSID 0",
            }, CollectionOrdering.Matching);

            // チューナーが応答しないときは、読めなかった理由を出して、ほかの行は出す
            bus[0x11].Tuners[Rt710.Address].FailReads = 1;
            await Assert.That(dish.Diagnose()[1]).IsEqualTo("RT710 の PLL  読めません (RT710 が応答しません (偽物))");
        }
        finally
        {
            ground.Dispose();
            dish.Dispose();
        }
    }

    [Test]
    public async Task 地上波を選局すると_TS_入力を開けて端子を出し_捨てると端子を止めて電源を切る()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        var tuner = Tuner(usb, "6-4", 2, clock, W3);
        tuner.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(tuner.Tuned).IsTrue();
        // 受信機 2 は TS 入力 3 (仕様書 2.2)。ブリッジの入力は機材を開いたときに開けてあり、選局したら復調器の TS の端子を出す (仕様書 11.1)
        await Assert.That(Lines(usb, line => Starts(line, "W DA4F", "I2C W 2 10 1D"))).IsEquivalentTo(new[] { "W DA4F=00", "W DA4F=01", "I2C W 2 10 1DA8", "I2C W 2 10 1D00" }, CollectionOrdering.Matching);
        await Assert.That(bus.Log).Contains($"10 R850 08={Tc90522Tests.R850Ch27}");
        var signal = tuner.Signal()!;
        await Assert.That((signal.Locked, signal.Unit)).IsEqualTo((true, TunerSignal.Db));
        await Assert.That(tuner.Notes()[^1]).StartsWith("R850  種類 0");
        // 同期バイト 0x37 のパケットが、この受信機の出口に 0x47 で届く
        var packet = new byte[188];
        packet[0] = 0x37;
        packet[1] = 0x12;
        usb.Ts.Enqueue([.. packet, .. packet, .. packet]);
        var buffer = new byte[188];
        var read = await tuner.Output.ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That((read, buffer[0], buffer[1])).IsEqualTo((188, (byte)0x47, (byte)0x12));

        bus.Log.Clear();
        // 受信の停止 (仕様書 11.2): 端子を止める。最後の受信機なのでスリープは書かない (仕様書 11.3)。機材を閉じるときにブリッジの入力を閉じる
        // 受信の停止 (仕様書 11.2): ブリッジの入力を閉じ、端子を止める。最後の受信機なのでスリープは書かない (仕様書 11.3)
        await Assert.That(Lines(usb, line => Starts(line, "W DA4F")).Last()).IsEqualTo("W DA4F=00");
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "10 1D=A8" }, CollectionOrdering.Matching);
        // 電源を切ってから閉じる
        await Assert.That(usb.Log[^1]).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task 衛星は_15V_なら給電を入れてから選局し_閉じるときは給電を先に切る()
    {
        var (usb, bus) = Fake();
        var clock = new FakeClock();
        var first = Tuner(usb, "6-5", 0, clock, W3, "15v");
        var second = Tuner(usb, "6-5", 1, clock, W3, "15v");
        var ground = Tuner(usb, "6-5", 3, clock, W3, "15v");
        try
        {
            first.Tune(ChannelTable.Parse("BS15:16625")!);
            // GPIOH11 ← 1 は、受信機 0 の選局の書き込み (0A ← 00) より前
            List<string> log;
            lock (usb.Log) log = [.. usb.Log];
            var setup = log.IndexOf("W D8D5=01") + 2;
            await Assert.That(log.IndexOf("W D8D3=01", setup)).IsLessThan(log.IndexOf("I2C W 2 11 0A00"));
            await Assert.That(log.IndexOf("W D8D3=01", setup)).IsGreaterThan(0);
            await Assert.That(first.SatelliteStreams()).IsNotNull();
            // 給電している間は、--tune に短絡の検出の入力も出す (仕様書 10。GPIOH10 を有効にして入力にし、値を読む)
            await Assert.That(first.Notes()[^1]).IsEqualTo("LNB の短絡の検出 (GPIOH10)  0 (短絡)  (未確認の値)");
            usb.Registers[0xD8D6] = 1;
            await Assert.That(first.Notes()[^1]).IsEqualTo("LNB の短絡の検出 (GPIOH10)  1 (正常)  (未確認の値)");
            await Assert.That(Lines(usb, line => Starts(line, "W D8D9", "W D8D8", "R D8D6")).TakeLast(3)).IsEquivalentTo(new[] { "W D8D9=01", "W D8D8=00", "R D8D6 1" }, CollectionOrdering.Matching);
            // 2 つ目の衛星の受信機が求めても、給電は 1 つなので書かない (仕様書 10)。地上波の受信機は 15v の設定でも求めない
            second.Tune(ChannelTable.Parse("BS01:16400")!);
            ground.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(Lines(usb, line => line == "W D8D3=01").Count).IsEqualTo(1);
            await Assert.That(first.Device!.LnbUsers).IsEqualTo(2);
            first.Dispose();
            await Assert.That(Lines(usb, line => line == "W D8D3=00").Count).IsEqualTo(1);
            // 最後の衛星の受信機を閉じるとき、給電を切ってからスリープにする (仕様書 11.3 の 1・2)
            bus.Log.Clear();
            second.Dispose();
            lock (usb.Log) log = [.. usb.Log];
            await Assert.That(log.LastIndexOf("W D8D3=00")).IsLessThan(log.LastIndexOf($"I2C W 2 13 FEF400{Tc90522Tests.Rt710Standby}"));
            await Assert.That(log.Count(line => line == "W D8D3=00")).IsEqualTo(2);
        }
        finally
        {
            first.Dispose();
            second.Dispose();
            ground.Dispose();
        }
    }

    [Test]
    public async Task 受けられない種別は機材に触る前に断る()
    {
        // 機種が開かずに分かるとき (sysfs などで調べられる): USB を開かない
        var opened = 0;
        var ground = new It930xTuner("地上波の受信機", 2, () =>
        {
            opened++;
            throw new InvalidOperationException("開かない");
        }, identify: () => Q3);
        var satellite = Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("BS15:16625")!));
        await Assert.That(satellite.Message).IsEqualTo("地上波の受信機 (PLEX PX-Q3PE4 の受信機 2) は BS を受けられません (受けられるのは地上波)");
        var cable = Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("H40")!));
        await Assert.That(cable.Message).Contains("スカパー！プレミアムを受けられません");
        // ISDB-C を受けられるのは CXD2856ER の受信機だけ (受けられる種別には入れていないので、選局で断る)
        var isdbc = Assert.Throws<IOException>(() => ground.Tune(ChannelTable.Parse("QC51")!));
        await Assert.That(isdbc.Message).IsEqualTo("地上波の受信機 (PLEX PX-Q3PE4 の受信機 2) は ISDB-C (ケーブルテレビ) を受けられません (受けられるのは地上波)");
        await Assert.That(It930x.Find(0x0511, 0x024E)!.Receivers[0].Takes(ChannelTable.Parse("QC51")!)).IsTrue();
        await Assert.That(It930x.Find(0x0511, 0x0854)!.Receivers[0].Takes(ChannelTable.Parse("QC51")!)).IsFalse();
        var dish = new It930xTuner("衛星の受信機", 1, () => throw new InvalidOperationException("開かない"), identify: () => Q3);
        var terrestrial = Assert.Throws<IOException>(() => dish.Tune(ChannelTable.Parse("T27")!));
        await Assert.That(terrestrial.Message).IsEqualTo("衛星の受信機 (PLEX PX-Q3PE4 の受信機 1) は地上波を受けられません (受けられるのは BS・CS)");
        // 機種に無い受信機の番号
        var missing = new It930xTuner("無い受信機", 4, () => throw new InvalidOperationException("開かない"), identify: () => Q3);
        await Assert.That(Assert.Throws<IOException>(() => missing.Tune(ChannelTable.Parse("T27")!)).Message).IsEqualTo("PLEX PX-Q3PE4 に受信機 4 はありません (0〜3)");
        await Assert.That(opened).IsEqualTo(0);

        // 機種が開くまで分からないとき: 開いたあと、受信機 (チップ) には触らずに断る
        var (usb, bus) = Fake();
        var tuner = Tuner(usb, "6-6", 0, new FakeClock(), W3);
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(error.Message).Contains("PLEX PX-W3U4 の受信機 0) は地上波を受けられません");
            await Assert.That(bus.Log).IsEmpty();
            // 受けられる種別はそのまま選局できる
            tuner.Tune(ChannelTable.Parse("BS15:16625")!);
            await Assert.That(tuner.Tuned).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 設定の受信機が受けられる種別は_機種の表の受信機ごとの種別()
    {
        It930xModel? Identify(string port) => port switch
        {
            "3-1" => Q3,
            "3-2" => It930x.Find(0x0511, 0x024E),
            "3-3" => It930x.Find(0x0511, 0x0855),
            _ => null,
        };
        await Assert.That(It930x.Receivable("it930x:3-1:0", Identify)!).IsEquivalentTo(new[] { "BS", "CS" }, CollectionOrdering.Matching);
        await Assert.That(It930x.Receivable("it930x:3-1:3", Identify)!).IsEquivalentTo(new[] { "GR" }, CollectionOrdering.Matching);
        await Assert.That(It930x.Receivable("it930x:3-2:4", Identify)!).IsEquivalentTo(new[] { "GR", "BS", "CS", "CATV", "SKY" }, CollectionOrdering.Matching);
        await Assert.That(It930x.Receivable("it930x:3-3:0", Identify)!).IsEquivalentTo(new[] { "GR" }, CollectionOrdering.Matching);
        // その機種に無い受信機の番号は、何も受けられない
        await Assert.That(It930x.Receivable("it930x:3-1:4", Identify)!).IsEmpty();
        // 機種が分からない (抜いてある) ときは、どの機種かを決められないので全部
        await Assert.That(It930x.Receivable("it930x:3-9:0", Identify)!).IsEquivalentTo(new[] { "GR", "BS", "CS", "CATV", "SKY" }, CollectionOrdering.Matching);
        await Assert.That(It930x.Receivable("px4:00001205000960:0", Identify)).IsNull();
    }

    [Test]
    public async Task 給電は_15V_だけで_ほかの電圧は開く前に断る()
    {
        var tuner = new It930xTuner("test", 0, () => throw new InvalidOperationException("開かない"), lnb: "11v", identify: () => W3);
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).IsEqualTo("test の LNB の給電は 15V だけです (設定は 11v)");
    }

    // ---------------------------------------------------------------------
    // Q3 の 2 つの側
    // ---------------------------------------------------------------------

    [Test]
    public async Task Q3_のシリアル番号は筐体の_14_桁と側の_1_桁に分ける()
    {
        await Assert.That(It930x.Side("000012050009601")!.Value).IsEqualTo(("00001205000960", 1));
        await Assert.That(It930x.Side("000012050009602")!.Value).IsEqualTo(("00001205000960", 2));
        // 15 桁の数字でない・末尾が 1 でも 2 でもないものは組にしない (仕様書 1.5)
        await Assert.That(It930x.Side("000012050009603")).IsNull();
        await Assert.That(It930x.Side("00001205000961")).IsNull();
        await Assert.That(It930x.Side("00001205000960A")).IsNull();
        await Assert.That(It930x.Side(null)).IsNull();
        // Windows のデバイスのパスの 3 つ目の区切りがシリアル番号。OS が作った名前 (& を含む) はシリアル番号ではない
        await Assert.That(It930x.WindowsSerial(@"\\?\usb#vid_0511&pid_024a#000012050009601#{a5dcbf10-6530-11d2-901f-00c04fb951ed}")).IsEqualTo("000012050009601");
        await Assert.That(It930x.WindowsSerial(@"\\?\usb#vid_0511&pid_024a#6&2f0a1c3&0&2#{a5dcbf10-6530-11d2-901f-00c04fb951ed}")).IsNull();
    }

    [Test]
    public async Task Q3_のもう片方の側は_14_桁が同じで末尾が違う_USB_デバイス()
    {
        var q3u4 = It930x.Find(0x0511, 0x084A)!;
        var found = new List<(string Port, It930xModel Model)> { ("3-1", Q3), ("3-2", Q3), ("3-3", Q3), ("3-4", W3), ("3-5", q3u4), ("3-6", Q3) };
        var serials = new Dictionary<string, string?>
        {
            ["3-1"] = "000012050009602", ["3-2"] = "000012050009601", ["3-3"] = "000012050001231", ["3-4"] = "000012050009601",
            ["3-5"] = "000012050009601", ["3-6"] = null,
        };
        string? Serial(string port) => serials[port];
        await Assert.That(It930x.Partner("3-1", Q3, found, Serial)).IsEqualTo("3-2");
        await Assert.That(It930x.Partner("3-2", Q3, found, Serial)).IsEqualTo("3-1");
        // 片側だけ・シリアル番号が読めない・Q3 でない機種は組にしない。機種が違えば、番号が合っても組にしない
        await Assert.That(It930x.Partner("3-3", Q3, found, Serial)).IsNull();
        await Assert.That(It930x.Partner("3-6", Q3, found, Serial)).IsNull();
        await Assert.That(It930x.Partner("3-4", W3, found, Serial)).IsNull();
        await Assert.That(It930x.Partner("3-5", q3u4, found, Serial)).IsNull();
        // 同じ筐体の番号で同じ側が 2 つ見えたら、どれも選ばない (仕様書 1.5)
        found.Add(("3-7", Q3));
        serials["3-7"] = "000012050009601";
        await Assert.That(It930x.Partner("3-1", Q3, found, Serial)).IsNull();
    }

    [Test]
    public async Task Q3_は側_1_の受信機_4_つのあとに側_2_の_4_つを並べ_受信機ごとの種別を付ける()
    {
        // 側 2 が先に見つかっても、側 1 を先に並べる (仕様書 1.5)。片側だけの Q3 と W3 は見つけた順のまま
        var found = new List<(string Port, It930xModel Model)> { ("3-1", Q3), ("3-2", W3), ("3-3", Q3), ("3-4", Q3) };
        var serials = new Dictionary<string, string?> { ["3-1"] = "000012050009602", ["3-3"] = "000099990000011", ["3-4"] = "000012050009601" };
        var specs = It930x.Specs(found, port => serials.GetValueOrDefault(port));
        await Assert.That(specs.Select(spec => spec.Device)).IsEquivalentTo(new[]
        {
            "it930x:3-4:0", "it930x:3-4:1", "it930x:3-4:2", "it930x:3-4:3",
            "it930x:3-1:0", "it930x:3-1:1", "it930x:3-1:2", "it930x:3-1:3",
            "it930x:3-2:0", "it930x:3-2:1", "it930x:3-2:2", "it930x:3-2:3",
            "it930x:3-3:0", "it930x:3-3:1", "it930x:3-3:2", "it930x:3-3:3",
        }, CollectionOrdering.Matching);
        // 受信機 0・1 は衛星 (BS・CS)、2・3 は地上波 (仕様書 2.2)
        await Assert.That(specs.Take(4).Select(spec => string.Join("/", spec.Types))).IsEquivalentTo(new[] { "BS/CS", "BS/CS", "GR", "GR" }, CollectionOrdering.Matching);
        await Assert.That(specs[0].Name).IsEqualTo("PLEX PX-Q3PE4 3-4 #0");
        // カードリーダーは、Q3 は末尾が 1 の側だけ (仕様書 1.4)。W3 はその USB デバイス
        await Assert.That(It930x.Cards(found, port => serials.GetValueOrDefault(port)).Select(card => card.Name)).IsEquivalentTo(new[]
        {
            "PLEX PX-W3U4 3-2 Card Reader", "PLEX PX-Q3PE4 3-3 Card Reader", "PLEX PX-Q3PE4 3-4 Card Reader",
        }, CollectionOrdering.Matching);
        // シリアル番号から側が分からない Q3 (macOS ではいつも読めない) は、どちらの側かを決められないので両方を挙げ、理由を出す
        var warned = new List<string>();
        var unknown = It930x.Cards([("3-9", Q3), ("3-10", Q3), ("3-11", W3)], port => port == "3-10" ? "ABC" : null, warned.Add);
        await Assert.That(unknown.Select(card => card.Name)).IsEquivalentTo(new[]
        {
            "PLEX PX-Q3PE4 3-9 Card Reader", "PLEX PX-Q3PE4 3-10 Card Reader", "PLEX PX-W3U4 3-11 Card Reader",
        }, CollectionOrdering.Matching);
        await Assert.That(warned).IsEquivalentTo(new[]
        {
            "[PLEX PX-Q3PE4 3-9] USB のシリアル番号を読めないので、カードスロットのある側か分かりません。この側の内蔵カードリーダーも挙げます",
            "[PLEX PX-Q3PE4 3-10] USB のシリアル番号 (ABC) が 15 桁の数字で末尾が 1 か 2 の形でないので、カードスロットのある側か分かりません。この側の内蔵カードリーダーも挙げます",
        }, CollectionOrdering.Matching);
        await Assert.That(It930x.Card("3-9", Q3).Name).IsEqualTo("PLEX PX-Q3PE4 3-9 Card Reader");
    }

    [Test]
    public async Task Q3_は受信機を開いている間_もう片方の側の電源も入れておく()
    {
        var (side1, bus1) = Fake();
        var (side2, bus2) = Fake();
        var clock = new FakeClock();
        var linked = 0;
        // 側 2 (7-2) の受信機を開くと、側 1 (7-1) の機材を取る
        var tuner = Tuner(side2, "7-2", 2, clock, Q3, link: () =>
        {
            linked++;
            return Open(side1, "7-1", clock, Q3);
        });
        tuner.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That((linked, tuner.Device!.Linked)).IsEqualTo((1, true));
        // 側 1 は、ファームウェアを起動して電源を入れただけ (仕様書 2.6)。チップは初期化していない
        await Assert.That(Lines(side1, line => Starts(line, "W D8C3", "W D8B7")).TakeLast(2)).IsEquivalentTo(new[] { "W D8C3=00", "W D8B7=01" }, CollectionOrdering.Matching);
        await Assert.That(bus1.Log).IsEmpty();
        await Assert.That(bus2.Log).Contains($"10 R850 08={Tc90522Tests.R850Ch27}");
        // 選局し直しても、取り直さない
        tuner.Tune(ChannelTable.Parse("T21")!);
        await Assert.That(linked).IsEqualTo(1);

        tuner.Dispose();
        // 側 2 の最後の受信機を閉じると、側 1 を返す。側 1 もほかに使っていないので電源を切って閉じる
        await Assert.That(Lines(side1, line => Starts(line, "W D8C3", "W D8B7")).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" }, CollectionOrdering.Matching);
        await Assert.That(side1.Log[^1]).IsEqualTo("W D8C3=01");
        await Assert.That(Lines(side2, line => Starts(line, "W D8C3", "W D8B7")).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" }, CollectionOrdering.Matching);
        await Assert.That(bus1.Log).IsEmpty();
    }

    [Test]
    public async Task Q3_の両方の側を使っている間は_片方の受信機を全部閉じても電源を切らない()
    {
        var (side1, bus1) = Fake();
        var (side2, _) = Fake();
        var clock = new FakeClock();
        It930xDevice One() => Open(side1, "7-3", clock, Q3, Two);
        It930xDevice Two() => Open(side2, "7-4", clock, Q3, One);
        var first = new It930xTuner("側 1", 2, One, () => It930xDevice.CloseIfIdle("7-3", TimeSpan.Zero));
        var second = new It930xTuner("側 2", 0, Two, () => It930xDevice.CloseIfIdle("7-4", TimeSpan.Zero));
        try
        {
            first.Tune(ChannelTable.Parse("T27")!);
            second.Tune(ChannelTable.Parse("BS15:16625")!);
            await Assert.That((first.Device!.Linked, second.Device!.Linked)).IsEqualTo((true, true));
            var before = Lines(side1, _ => true).Count;
            bus1.Log.Clear();
            first.Dispose();
            // 側 1 は、側 2 の受信機が開いているので電源を切らない (仕様書 2.6 の 3)。最後の受信機なのでスリープも書かない (仕様書 11.3)
            var after = Lines(side1, _ => true).Skip(before).ToList();
            await Assert.That(after.Any(line => Starts(line, "W D8C3", "W D8B7"))).IsFalse();
            await Assert.That(bus1.Log).IsEquivalentTo(new[] { "10 1D=A8" }, CollectionOrdering.Matching);
            // そのあと側 1 の受信機を開くと、初期化からやり直す (電源は入れ直さない)
            first = new It930xTuner("側 1", 3, One, () => It930xDevice.CloseIfIdle("7-3", TimeSpan.Zero));
            first.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(bus1.Log.Count(line => line.EndsWith("R850 ?48", StringComparison.Ordinal))).IsEqualTo(2);
            await Assert.That(Lines(side1, _ => true).Skip(before).Any(line => Starts(line, "W D8C3", "W D8B7"))).IsFalse();
        }
        finally
        {
            first.Dispose();
            second.Dispose();
        }
        // 両方を閉じると、両方の電源が切れる
        await Assert.That(Lines(side1, line => Starts(line, "W D8C3")).Last()).IsEqualTo("W D8C3=01");
        await Assert.That(Lines(side2, line => Starts(line, "W D8C3")).Last()).IsEqualTo("W D8C3=01");
    }

    [Test]
    public async Task Q3_のもう片方の側が見つからない_開けないときは_見つかった側だけを使う()
    {
        var (usb, _) = Fake();
        var alone = Tuner(usb, "7-5", 2, new FakeClock(), Q3, link: () => null);
        alone.Tune(ChannelTable.Parse("T27")!);
        await Assert.That((alone.Tuned, alone.Device!.Linked)).IsEqualTo((true, false));
        alone.Dispose();

        var (other, _) = Fake();
        var broken = Tuner(other, "7-6", 2, new FakeClock(), Q3, link: () => throw new IOException("ほかのソフトが使っています"));
        broken.Tune(ChannelTable.Parse("T27")!);
        await Assert.That((broken.Tuned, broken.Device!.Linked)).IsEqualTo((true, false));
        broken.Dispose();

        // W3 は、もう片方の側を取らない
        var (w3, _) = Fake();
        var single = Tuner(w3, "7-7", 2, new FakeClock(), W3, link: () => throw new InvalidOperationException("W3 では呼ばない"));
        single.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(single.Tuned).IsTrue();
        single.Dispose();
    }

    [Test]
    public async Task Q3_のカードだけを使うときは_その側の電源だけを入れる()
    {
        var (usb, bus) = Fake();
        usb.CardAtr = Convert.FromHexString("3BF01200FF9181B17C451F0399");
        usb.CardResponder = _ => T1Protocol.Block(0x00, [0x90, 0x00]);
        var clock = new FakeClock();
        var linked = 0;
        var card = new It930xCard("Q3 のカード", () => Open(usb, "7-8", clock, Q3, () =>
        {
            linked++;
            return null;
        }), () => It930xDevice.CloseIfIdle("7-8", TimeSpan.Zero), clock.Sleep);
        await Assert.That(card.Reset().Length).IsEqualTo(13);
        // 電源を入れてからカードを読む (仕様書 1.4)。もう片方の側は取らず (仕様書 2.6)、チップも初期化しない
        await Assert.That(Lines(usb, line => Starts(line, "W D8C3")).Last()).IsEqualTo("W D8C3=00");
        await Assert.That(linked).IsEqualTo(0);
        await Assert.That(bus.Log).IsEmpty();
        card.Dispose();
        await Assert.That(Lines(usb, line => Starts(line, "W D8C3")).Last()).IsEqualTo("W D8C3=01");
    }

    // ---------------------------------------------------------------------
    // 受信機が 1 つの機種 (仕様書 13.3・13.4)
    // ---------------------------------------------------------------------

    /// <summary>ISDB2056 系の偽の機材。バス 3 に地上波 0x10 (先に R850) と衛星のアドレス (先に RT710。PX-S1UR は無い)</summary>
    private static (FakeIt930x Usb, FakeTcBus Bus) Single(It930xModel model)
    {
        var wiring = model.Receivers[0];
        var bus = wiring.Demod == It930xDemod.Isdbt2071
            ? new FakeTcBus(wiring.DemodAddress)
            : new FakeTcBus([.. new[] { wiring.DemodAddress, wiring.SatelliteAddress, wiring.SatelliteTsAddress }.Distinct()]);
        bus[wiring.DemodAddress].Tuners[R850.Address] = FakeRafael.R850();
        bus[wiring.DemodAddress].Status[0xB0] = 0x88;
        if (wiring.Tuner == It930xTunerChip.R850Rt710) bus[wiring.SatelliteAddress].Tuners[Rt710.Address] = FakeRafael.Rt710();
        var usb = new FakeIt930x();
        usb.I2c[wiring.I2cBus] = bus;
        return (usb, bus);
    }

    /// <summary>T27 で、ループスルーが無しの R850 に書く 40 バイト (付録 C.1 の 27ch の先頭 08 を 4A、0A を 70 にしたもの)</summary>
    private const string R850Ch27NoLoop = "4AC0705000E400308FBBB8B7D210CD6587428193162E0B2321F10C5FC4209A5AC1996B4453576E40";

    private static readonly string[] Rt710Bs15 =
    [
        $"RT710 00={Tc90522Tests.Rt710Start}", "RT710 04=41", "RT710 05=4A", "RT710 04=41", "RT710 07=EA", "RT710 06=AE",
        "RT710 0A=39", "RT710 02=20", "RT710 08=07", "RT710 0E=90", "RT710 0F=45", "RT710 ?3",
    ];

    [Test]
    public async Task PX_M1UR_は開いても電源を入れず_受信機を開くときに入れて_閉じるときに切る()
    {
        var model = It930x.Find(0x0511, 0x0854)!;
        var (usb, bus) = Single(model);
        var clock = new FakeClock();
        var tuner = Tuner(usb, "5-1", 0, clock, model);
        var device = Open(usb, "5-1", clock, model);
        try
        {
            // ブリッジの設定 (仕様書 13.3): 中継の相手は 1 つ目の欄だけ (0x20、バス 3)。TS 入力 0 に同期バイト 0x47、入力 1〜4 は使わないので開けない
            await Assert.That(Lines(usb, line => Starts(line, "W 4975", "W 4974", "W 4973", "W 4972", "W 4964", "W 4971", "W 4970", "W 496F", "W 496E", "W 4963"))).IsEquivalentTo(new[] { "W 4975=20", "W 4971=03" }, CollectionOrdering.Matching);
            await Assert.That(Lines(usb, line => Starts(line, "W DA7", "W DA4", "W DA50", "W DA58"))).IsEquivalentTo(new[]
            {
                "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA58=00", "W DA73=01", "W DA78=47", "W DA4C=01",
            }, CollectionOrdering.Matching);
            // GPIOH3 = 1 (電源を切った状態)、GPIOH2 = 0。GPIOH11 (LNB) は設定も操作もしない
            await Assert.That(Lines(usb, line => Starts(line, "W D8B", "W D8C", "W D8D"))).IsEquivalentTo(new[]
            {
                "W D8B4=01", "W D8B5=01", "W D8B3=01", "W D8B8=01", "W D8B9=01", "W D8B7=00",
            }, CollectionOrdering.Matching);
            await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 20, 20 }, CollectionOrdering.Matching);

            tuner.Tune(ChannelTable.Parse("T27")!);
            // 電源を入れる: GPIOH3 ← 0、100 ms、GPIOH2 ← 1、20 ms
            await Assert.That(Lines(usb, line => Starts(line, "W D8B3", "W D8B7")).TakeLast(2)).IsEquivalentTo(new[] { "W D8B3=00", "W D8B7=01" }, CollectionOrdering.Matching);
            await Assert.That(clock.Sleeps.Skip(2).Take(2)).IsEquivalentTo(new[] { 100, 20 }, CollectionOrdering.Matching);
            await Assert.That(bus.Log).IsEquivalentTo((string[])
            [
                // 開く (仕様書 13.3): R850 と RT710 の初期化、地上波の初期の設定 8 行、端子を止めてスリープ、衛星の側も端子を止めてスリープ
                .. R850Init("10"), "11 RT710 ?4",
                "10 B0=A0", "10 B2=3D", "10 B3=25", "10 B4=8B", "10 B5=4B", "10 B6=3F", "10 B7=FF", "10 B8=C0",
                "10 1D=A8", "10 03=F0",
                "11 15=00", "11 1D=00", "11 1C=80", "11 1F=22", "11 13=80", "11 17=FF",
                // 地上波の選局 (仕様書 13.3 の 1〜14)
                "10 47=30", "10 25=00", "10 20=00", "10 23=4D", "10 01=50",
                "11 13=80", "11 17=FF",
                "10 0E=77", "10 0F=10", "10 71=20", "10 03=00", "10 76=0C", "10 1F=30",
                $"10 R850 08={R850Ch27NoLoop}", "10 R850 2F=42", "10 R850 ?3",
                "10 25=00", "10 20=00", "10 23=4C", "10 01=50", "10 71=01", "10 72=25", "10 75=00",
                // 100 ms 待ってからロック
                "10 80?", "10 B0?",
                // 受信の開始: 地上波の TS の端子を出す
                "10 1D=00",
            ], CollectionOrdering.Matching);
            // R850 の 10 ms、選局のあとの 100 ms、ロックのあとの待ち足し 350 ms
            await Assert.That(clock.Sleeps.Skip(4)).IsEquivalentTo(new[] { 10, 100, 350 }, CollectionOrdering.Matching);
            await Assert.That(Lines(usb, line => Starts(line, "W DA4C")).Last()).IsEqualTo("W DA4C=01");

            // 衛星に切り替える (仕様書 13.3 の衛星の選局)。先に受信を止める
            bus.Log.Clear();
            tuner.Tune(ChannelTable.Parse("BS15:16625")!);
            await Assert.That(bus.Log).IsEquivalentTo((string[])
            [
                "10 1D=A8",
                "11 0A=00", "11 10=B0", "11 11=02", "11 03=01",
                "10 0E=11", "10 0F=70", "10 03=F0",
                "11 07=77", "11 08=10",
                "11 13=00", "11 17=00", "11 04=02", "11 8E=02",
                "10 1F=20",
                .. Rt710Bs15.Select(line => $"11 {line}"),
                "11 0A=FF", "11 10=B2", "11 11=00", "11 03=01",
                "11 C3?", "11 8F=40F1", "11 E6?2",
                "11 1C=00", "11 1F=00",
            ], CollectionOrdering.Matching);
            await Assert.That(tuner.SatelliteStreams()).IsNotNull();

            // 閉じる: 衛星の TS の端子を止め、電源を切る (スリープの書き込みはしない)
            bus.Log.Clear();
            tuner.Dispose();
            await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 1C=80", "11 1F=22" }, CollectionOrdering.Matching);
            await Assert.That(Lines(usb, line => Starts(line, "W D8B3", "W D8B7")).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8B3=01" }, CollectionOrdering.Matching);
        }
        finally
        {
            tuner.Dispose();
            device.Release();
            It930xDevice.CloseIfIdle("5-1", TimeSpan.Zero);
        }
        // 機材を閉じるときに、電源の GPIO をもう一度は書かない
        await Assert.That(Lines(usb, line => Starts(line, "W D8B3")).Count(line => line == "W D8B3=01")).IsEqualTo(2);
    }

    [Test]
    public async Task ISDB2056N_は衛星のアドレスが_0x13_で_10_と_08_の値が違う()
    {
        var model = It930x.Find(0x0511, 0x084B)!;
        var (usb, bus) = Single(model);
        var tuner = Tuner(usb, "5-2", 0, new FakeClock(), model);
        try
        {
            tuner.Tune(ChannelTable.Parse("BS15:16625")!);
            var tune = bus.Log.SkipWhile(line => line != "13 0A=00").ToList();
            await Assert.That(tune).IsEquivalentTo((string[])
            [
                "13 0A=00", "13 10=30", "13 11=02", "13 03=01",
                "10 0E=11", "10 0F=70", "10 03=F0",
                // TS の設定は 0x11 に書く (復調に使う衛星のアドレスは 0x13)
                "11 07=77", "11 08=37",
                "13 13=00", "13 17=00", "13 04=02", "13 8E=02",
                "10 1F=20",
                .. Rt710Bs15.Select(line => $"13 {line}"),
                "13 0A=FF", "13 10=32", "13 11=00", "13 03=01",
                "13 C3?", "13 8F=40F1", "13 E6?2",
                "13 1C=00", "13 1F=00",
            ], CollectionOrdering.Matching);
            // 開くときの衛星の側の書き込みも 0x13
            await Assert.That(bus.Log).Contains("13 15=00");
            await Assert.That(bus.Log.Any(line => line.StartsWith("11 15=", StringComparison.Ordinal))).IsFalse();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task PX_S1UR_は地上波だけで_衛星のアドレスには初期化の書き込みだけをする()
    {
        var model = It930x.Find(0x0511, 0x0855)!;
        var (usb, bus) = Single(model);
        var tuner = Tuner(usb, "5-3", 0, new FakeClock(), model);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(tuner.Tuned).IsTrue();
            // RT710 は無いので読まない。衛星のアドレス 0x11 への 6 行は書く (仕様書 13.3)
            await Assert.That(bus.Log.Any(line => line.Contains("RT710", StringComparison.Ordinal))).IsFalse();
            await Assert.That(bus.Log.Where(line => line.StartsWith("11 ", StringComparison.Ordinal)).Take(6)).IsEquivalentTo(new[]
            {
                "11 15=00", "11 1D=00", "11 1C=80", "11 1F=22", "11 13=80", "11 17=FF",
            }, CollectionOrdering.Matching);
            // 衛星の選局は断る。チップには何も書かない
            bus.Log.Clear();
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(error.Message).Contains("PLEX PX-S1UR の受信機 0) は BS を受けられません (受けられるのは地上波)");
            await Assert.That(bus.Log).IsEmpty();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 受信機が_1_つの機種は_LNB_に給電できないので_15V_の指定を開く前に断る()
    {
        var model = It930x.Find(0x0511, 0x0854)!;
        var tuner = new It930xTuner("M1UR", 0, () => throw new InvalidOperationException("開かない"), lnb: "15v", identify: () => model);
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).IsEqualTo("M1UR (PLEX PX-M1UR) は LNB に給電できません。設定の LNB を空にして、ほかの機器から給電してください");
        // 地上波は 15v の設定のままでも選局できる (給電は衛星の選局のときだけ)
        var (usb, _) = Single(model);
        var ground = Tuner(usb, "5-4", 0, new FakeClock(), model, "15v");
        ground.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(ground.Tuned).IsTrue();
        ground.Dispose();
        await Assert.That(Lines(usb, line => Starts(line, "W D8D"))).IsEmpty();
    }

    [Test]
    public async Task 受信機が_1_つの機種のカードは_電源を入れずに読む()
    {
        var model = It930x.Find(0x0511, 0x004B)!;
        var (usb, bus) = Single(model);
        usb.CardAtr = Convert.FromHexString("3BF01200FF9181B17C451F0399");
        usb.CardResponder = _ => T1Protocol.Block(0x00, [0x90, 0x00]);
        var clock = new FakeClock();
        var card = new It930xCard("ISDB2056 のカード", () => Open(usb, "5-5", clock, model), () => It930xDevice.CloseIfIdle("5-5", TimeSpan.Zero), clock.Sleep);
        await Assert.That(card.Reset().Length).IsEqualTo(13);
        // 基板の電源 (GPIOH3) は切ったまま (仕様書 1.4・13.3)
        await Assert.That(Lines(usb, line => line == "W D8B3=00")).IsEmpty();
        await Assert.That(bus.Log).IsEmpty();
        card.Dispose();
    }

    [Test]
    public async Task DTV03A_1TU_は仕様書_13_4_の値で開いて選局する()
    {
        var model = It930x.Find(0x0511, 0x0052)!;
        var (usb, bus) = Single(model);
        var clock = new FakeClock();
        var tuner = Tuner(usb, "5-6", 0, clock, model);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            // ブリッジの設定: 中継の相手 0x30 (0x18 の 8 ビット)、バス 3。TS 入力 4 に同期バイト 0x47、入力 0〜3 は使わないので開けない
            await Assert.That(Lines(usb, line => Starts(line, "W 4975", "W 4974", "W 4973", "W 4972", "W 4964", "W 4971", "W 4970", "W 496F", "W 496E", "W 4963"))).IsEquivalentTo(new[] { "W 4975=30", "W 4971=03" }, CollectionOrdering.Matching);
            await Assert.That(Lines(usb, line => Starts(line, "W DA7", "W DA4", "W DA50"))).IsEquivalentTo(new[]
            {
                "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA77=01", "W DA7C=47", "W DA50=01",
            }, CollectionOrdering.Matching);
            await Assert.That(bus.Log).IsEquivalentTo((string[])
            [
                // 開く: R850 の初期化、復調器の 17 行、端子を止めてスリープから戻す
                .. R850Init("18"),
                "18 04=00", "18 10=00", "18 11=2D", "18 12=02", "18 13=62", "18 14=60", "18 15=00", "18 16=00",
                "18 1D=05", "18 1E=15", "18 1F=40", "18 30=20", "18 31=0B", "18 32=8F", "18 34=0F", "18 38=01", "18 39=1C",
                "18 1D=A8", "18 03=00",
                // 選局
                "18 47=30", "18 25=00", "18 20=00", "18 23=4D", "18 01=50", "18 76=03", "18 77=01", "18 3B=10", "18 3C=10", "18 3D=24",
                $"18 R850 08={R850Ch27NoLoop}", "18 R850 2F=42", "18 R850 ?3",
                "18 25=00", "18 20=00", "18 23=4C", "18 01=50",
                "18 80?", "18 B0?",
                "18 1D=00",
            ], CollectionOrdering.Matching);
            // 電源の 100 ms と 20 ms、R850 の 10 ms、選局のあとの 100 ms、ロックのあとの待ち足し
            await Assert.That(clock.Sleeps.Skip(2)).IsEquivalentTo(new[] { 100, 20, 10, 100, 350 }, CollectionOrdering.Matching);
            // 衛星は断る
            Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
        }
        finally
        {
            tuner.Dispose();
        }
        await Assert.That(bus.Log[^1]).IsEqualTo("18 1D=A8");
    }

    // ---------------------------------------------------------------------
    // 機種の表と自動検出
    // ---------------------------------------------------------------------

    [Test]
    [Arguments(0x083F, "PLEX PX-W3U4", 4, false)]
    [Arguments(0x023F, "PLEX PX-W3PE4", 4, false)]
    [Arguments(0x073F, "PLEX PX-W3PE5", 4, false)]
    [Arguments(0x084A, "PLEX PX-Q3U4", 4, true)]
    [Arguments(0x024A, "PLEX PX-Q3PE4", 4, true)]
    [Arguments(0x074A, "PLEX PX-Q3PE5", 4, true)]
    public async Task Q3_W3_系の_6_機種は仕様書_2_2_の割り当て(int product, string name, int receivers, bool paired)
    {
        var model = It930x.Find(0x0511, product)!;
        await Assert.That((model.Name, model.Receivers.Count, model.Paired, model.Lnb, model.Card, model.PowerPin)).IsEqualTo((name, receivers, paired, true, true, 7));
        // 受信機、方式、復調器、バス、TS 入力、同期バイト、チューナー、「2 つ目」の印、ループスルー
        await Assert.That(model.Receivers.Select(r => (r.Index, r.Demod, r.DemodAddress, r.I2cBus, r.TsInput, r.SyncByte, r.Tuner, r.Second, r.Loopthrough))).IsEquivalentTo(new[]
        {
            (0, It930xDemod.Tc90522S, (byte)0x11, (byte)2, 1, (byte)0x17, It930xTunerChip.Rt710, false, false),
            (1, It930xDemod.Tc90522S, (byte)0x13, (byte)2, 2, (byte)0x27, It930xTunerChip.Rt710, true, false),
            (2, It930xDemod.Tc90522T, (byte)0x10, (byte)2, 3, (byte)0x37, It930xTunerChip.R850, false, true),
            (3, It930xDemod.Tc90522T, (byte)0x12, (byte)2, 4, (byte)0x47, It930xTunerChip.R850, false, false),
        }, CollectionOrdering.Matching);
        await Assert.That(model.Receivers.Select(r => string.Join("/", r.Types))).IsEquivalentTo(new[] { "BS/CS", "BS/CS", "GR", "GR" }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task PX_MLT8PE_と_DTV02A_4TS_P_は_MLT5_系と同じチップで_割り当ては仕様書_13_1_と_13_2()
    {
        var five = It930x.Find(0x0511, 0x0253)!;
        var three = It930x.Find(0x0511, 0x0252)!;
        var four = It930x.Find(0x0511, 0x0254)!;
        await Assert.That((five.Name, three.Name, four.Name)).IsEqualTo(("PLEX PX-MLT8PE", "PLEX PX-MLT8PE", "e-Better DTV02A-4TS-P"));
        await Assert.That(five.Receivers.Select(r => (r.I2cBus, r.DemodAddress, r.TsInput))).IsEquivalentTo(new (byte, byte, int)[]
        {
            (1, 0x65, 0), (1, 0x64, 1), (1, 0x6C, 2), (3, 0x6C, 3), (3, 0x64, 4),
        }, CollectionOrdering.Matching);
        await Assert.That(three.Receivers.Select(r => (r.I2cBus, r.DemodAddress, r.TsInput))).IsEquivalentTo(new (byte, byte, int)[]
        {
            (3, 0x65, 0), (3, 0x6C, 3), (3, 0x64, 4),
        }, CollectionOrdering.Matching);
        await Assert.That(four.Receivers.Select(r => (r.I2cBus, r.DemodAddress, r.TsInput))).IsEquivalentTo(new (byte, byte, int)[]
        {
            (3, 0x65, 0), (1, 0x6C, 1), (1, 0x64, 2), (3, 0x64, 4),
        }, CollectionOrdering.Matching);
        // カードリーダーは 5 受信機の側だけ (仕様書 1.4)。2 つの USB デバイスは組にしない
        await Assert.That((five.Card, three.Card, four.Card, five.Paired, three.Paired)).IsEqualTo((true, false, true, false, false));
        foreach (var model in new[] { five, three, four })
        {
            await Assert.That(model.Receivers.All(r => r.Demod == It930xDemod.Cxd2856 && r.Tuner == It930xTunerChip.Cxd2858 && r.Types.SequenceEqual(It930x.Types))).IsTrue();
            await Assert.That((model.Lnb, model.PowerPin)).IsEqualTo((true, 7));
        }
        // 同期バイトは TS 入力の番号で決める (こちらで決めてよい値)。使わない入力は 0
        await Assert.That(three.SyncBytes).IsEquivalentTo(new byte[] { 0x17, 0, 0, 0x57, 0x67 }, CollectionOrdering.Matching);
        await Assert.That(four.SyncBytes).IsEquivalentTo(new byte[] { 0x17, 0x27, 0x37, 0, 0x67 }, CollectionOrdering.Matching);
        await Assert.That(It930x.Cards([("2-1", five), ("2-2", three)]).Select(card => card.Name)).IsEquivalentTo(new[] { "PLEX PX-MLT8PE 2-1 Card Reader" });
    }

    [Test]
    public async Task PX_MLT8PE_の_3_受信機の側は_使わない_TS_入力を閉じて_受信機を選局できる()
    {
        var three = It930x.Find(0x0511, 0x0252)!;
        var usb = new FakeIt930x();
        var bus3 = new FakeCxdBus(0x65, 0x6C, 0x64);
        usb.I2c[3] = bus3;
        var tuner = Tuner(usb, "5-7", 1, new FakeClock(), three);
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(tuner.Tuned).IsTrue();
            // 中継の相手は 3 つ目の欄まで。TS 入力 1・2 は閉じ、受信機 1 は TS 入力 3 を開ける (仕様書 13.1)
            await Assert.That(Lines(usb, line => Starts(line, "W 4975", "W 4974", "W 4973", "W 4972", "W 4964", "W 4971", "W 4970", "W 496F", "W 496E", "W 4963"))).IsEquivalentTo(new[]
            {
                "W 4975=CA", "W 4971=03", "W 4974=D8", "W 4970=03", "W 4973=C8", "W 496F=03",
            }, CollectionOrdering.Matching);
            await Assert.That(Lines(usb, line => Starts(line, "W DA4"))).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA4C=01", "W DA4F=01" }, CollectionOrdering.Matching);
            await Assert.That(bus3.Log.Any(line => line.StartsWith("6C T ", StringComparison.Ordinal))).IsTrue();
            // 機種に無い受信機の番号は断る
            var missing = Tuner(usb, "5-7", 3, new FakeClock(), three);
            await Assert.That(Assert.Throws<IOException>(() => missing.Tune(ChannelTable.Parse("T27")!)).Message).IsEqualTo("PLEX PX-MLT8PE に受信機 3 はありません (0〜2)");
            missing.Dispose();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    [Arguments(0x004B, "Digibest ISDB2056", 0x11, false, "GR/BS/CS", It930xTunerChip.R850Rt710)]
    [Arguments(0x084B, "Digibest ISDB2056N", 0x13, true, "GR/BS/CS", It930xTunerChip.R850Rt710)]
    [Arguments(0x0854, "PLEX PX-M1UR", 0x11, false, "GR/BS/CS", It930xTunerChip.R850Rt710)]
    [Arguments(0x0855, "PLEX PX-S1UR", 0x11, false, "GR", It930xTunerChip.R850)]
    public async Task ISDB2056_系は仕様書_13_3_の割り当て(int product, string name, int satellite, bool second, string types, It930xTunerChip chip)
    {
        var model = It930x.Find(0x0511, product)!;
        var wiring = model.Receivers.Single();
        await Assert.That((model.Name, model.Lnb, model.Card, model.Paired, model.PowerPin, model.PowerWaitMs, model.PowerWhileOpen)).IsEqualTo((name, false, true, false, 3, 100, false));
        await Assert.That((wiring.Demod, wiring.I2cBus, wiring.DemodAddress, wiring.SatelliteAddress, wiring.SatelliteTsAddress, wiring.TsInput, wiring.SyncByte, wiring.Second, wiring.Loopthrough, wiring.Tuner))
            .IsEqualTo((It930xDemod.Tc90522Switch, (byte)3, (byte)0x10, (byte)satellite, (byte)0x11, 0, (byte)0x47, second, false, chip));
        await Assert.That(string.Join("/", wiring.Types)).IsEqualTo(types);
    }

    [Test]
    public async Task DTV03A_1TU_は仕様書_13_4_の割り当て()
    {
        var model = It930x.Find(0x0511, 0x0052)!;
        var wiring = model.Receivers.Single();
        await Assert.That((model.Name, model.Lnb, model.Card, model.PowerPin)).IsEqualTo(("e-Better DTV03A-1TU", false, true, 3));
        await Assert.That((wiring.Demod, wiring.I2cBus, wiring.DemodAddress, wiring.TsInput, wiring.SyncByte, wiring.Tuner, wiring.Loopthrough))
            .IsEqualTo((It930xDemod.Isdbt2071, (byte)3, (byte)0x18, 4, (byte)0x47, It930xTunerChip.R850, false));
        await Assert.That(string.Join("/", wiring.Types)).IsEqualTo("GR");
    }

    [Test]
    public async Task sysfs_から表の全部の機種を見つけ_受信機ごとの種別で挙げる()
    {
        // sysfs は Linux だけ (インターフェースの名前の「:」は Windows のファイル名に使えない)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("it930xfamily");
        try
        {
            void Usb(string name, int product, string? serial = null)
            {
                var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
                File.WriteAllText(Path.Combine(at, "idVendor"), "0511\n");
                File.WriteAllText(Path.Combine(at, "idProduct"), $"{product:x4}\n");
                if (serial is not null) File.WriteAllText(Path.Combine(at, "serial"), serial + "\n");
            }
            // ポート 1-1 から順に、表の機種を 1 つずつ。Q3PE4 だけは 2 つの側 (側 2 が先のポート)
            var index = 0;
            foreach (var model in It930x.Family)
            {
                index++;
                if (model.Product == 0x024A) Usb("2-1", model.Product, "000012050009602");
                Usb($"1-{index}", model.Product, model.Paired ? "000012050009601" : "000000000000001");
            }
            // 表に無い ID (PX-MLT8UT) は挙げない
            Usb("3-1", 0x0051);
            var found = It930x.Found(dir.FullName, null);
            await Assert.That(found.Count).IsEqualTo(It930x.Family.Count + 1);
            await Assert.That(found.Select(item => item.Model).Distinct().Count()).IsEqualTo(It930x.Family.Count);
            await Assert.That(It930x.SysfsSerial(dir.FullName, "2-1")).IsEqualTo("000012050009602");
            await Assert.That(It930x.SysfsSerial(dir.FullName, "3-1")).IsNull();

            var specs = It930x.Specs(found, port => It930x.SysfsSerial(dir.FullName, port));
            // 受信機の数: MLT5 系 5 × 3、Q3・W3 系 4 × 7 (Q3PE4 は 2 つの側)、MLT8PE 5 + 3、DTV02A-4TS-P 4、受信機が 1 つの機種 5
            await Assert.That(specs.Count).IsEqualTo(15 + 28 + 8 + 4 + 5);
            string Types(string device) => string.Join("/", specs.Single(spec => spec.Device == device).Types);
            // CXD2856ER の受信機は GR・BS・CS (CATV と SKY は最初からは選ばない)。Q3・W3 系は受信機ごと。受信機が 1 つの機種は機種ごと
            var port = (int product) => $"1-{It930x.Family.ToList().FindIndex(model => model.Product == product) + 1}";
            await Assert.That(Types($"it930x:{port(0x024E)}:4")).IsEqualTo("GR/BS/CS");
            await Assert.That(Types($"it930x:{port(0x0252)}:2")).IsEqualTo("GR/BS/CS");
            await Assert.That(Types($"it930x:{port(0x0254)}:3")).IsEqualTo("GR/BS/CS");
            await Assert.That(Types($"it930x:{port(0x073F)}:1")).IsEqualTo("BS/CS");
            await Assert.That(Types($"it930x:{port(0x073F)}:3")).IsEqualTo("GR");
            await Assert.That(Types($"it930x:{port(0x0854)}:0")).IsEqualTo("GR/BS/CS");
            await Assert.That(Types($"it930x:{port(0x0855)}:0")).IsEqualTo("GR");
            await Assert.That(Types($"it930x:{port(0x0052)}:0")).IsEqualTo("GR");
            // Q3PE4 は側 1 (1-x) の 4 つのあとに側 2 (2-1) の 4 つ
            var devices = specs.Select(spec => spec.Device).ToList();
            await Assert.That(devices.IndexOf("it930x:2-1:0")).IsEqualTo(devices.IndexOf($"it930x:{port(0x024A)}:3") + 1);
            await Assert.That(It930x.Partner("2-1", It930x.Find(0x0511, 0x024A)!, found, p => It930x.SysfsSerial(dir.FullName, p))).IsEqualTo(port(0x024A));
            // 設定の画面に返す、受けられる種別 (最後に探したときの機種から)。機種が分からなければ全部
            await Assert.That(specs.All(spec => spec.Types.Length > 0 && !spec.Disabled)).IsTrue();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // ---------------------------------------------------------------------
    // --it930x-probe
    // ---------------------------------------------------------------------

    [Test]
    public async Task probe_の_chips_は電源を入れて_復調器の応答とチューナーの種類を出す()
    {
        var (usb, bus) = Fake();
        usb.Registers[It930xProbe.EepromValid] = 0x01;
        // 受信機 1 の RT710 は RT720、受信機 3 の R850 は種類 1 で、水晶の駆動の強さは 1 回目で決まる。受信機 0 の衛星のアドレスは C3 = 10
        bus[0x13].Tuners[Rt710.Address].Status[0x03] = 0x60;
        var r850 = bus[0x12].Tuners[R850.Address];
        r850.Status[0x00] = 0x08;
        r850.Status[0x02] = 0x40 | 20;
        for (var i = 8; i < 48; i++) r850.Registers[i] = (byte)i;
        bus[0x11].Status[0xC3] = 0x10;
        var output = new StringWriter();
        var clock = new FakeClock();
        var code = It930xProbe.Execute(() => usb, () => It930xFirmware.Code, output, clock.Sleep, null, null, W3);
        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains("EEPROM の有効の印 0x01");
        await Assert.That(text).Contains("電源: 入れました (GPIOH7 ← 0、80 ms、GPIOH2 ← 1、20 ms)");
        await Assert.That(text).Contains("受信機 0 (バス 2) 衛星 0x11: 応答あり (C3 = 0x10)");
        await Assert.That(text).Contains("受信機 0 (バス 2) RT710: 03 = 0x70 (ビットの並びを直した値) → RT710");
        await Assert.That(text).Contains("受信機 1 (バス 2) RT710: 03 = 0x60 (ビットの並びを直した値) → RT720");
        await Assert.That(text).Contains("受信機 2 (バス 2) 地上波 0x10: 応答あり (80 = 0x00、B0 = 0x88)");
        await Assert.That(text).Contains("受信機 2 (バス 2) R850: 00 = 0x00 (ビットの並びを直した値) → 種類 0、水晶の駆動の強さ 3");
        await Assert.That(text).Contains("受信機 3 (バス 2) R850: 00 = 0x08 (ビットの並びを直した値) → 種類 1、水晶の駆動の強さ 1");
        await Assert.That(text).Contains("  電源を入れたあとの 08〜2F: 08090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F202122232425262728292A2B2C2D2E2F");
        await Assert.That(text).Contains("  書き戻したあとの 08〜2F:   08090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F202122232425262728292A2B2C2D2E2F (同じ)");
        await Assert.That(text).Contains("電源: 切りました");
        // 電源を切ってから REBOOT する
        var log = Lines(usb, _ => true);
        await Assert.That(log.LastIndexOf("W D8C3=01")).IsLessThan(log.LastIndexOf("REBOOT"));
        await Assert.That(log.LastIndexOf("W D8C3=01")).IsGreaterThan(log.LastIndexOf("W D8C3=00"));
        // 選局の書き込みはしない
        await Assert.That(bus.Log.Any(line => line.Contains(" 47=", StringComparison.Ordinal) || line.Contains(" 0A=", StringComparison.Ordinal))).IsFalse();
    }

    [Test]
    public async Task probe_の_chips_は応答しないチップの理由を出して次へ進む()
    {
        var usb = new FakeIt930x();
        // 受信機 0 の RT710 と受信機 2 の R850 が応答しない (読み出しが I2C の誤りになる)
        var bus = FakeTcBus.W3();
        usb.I2c[2] = bus;
        bus[0x11].Tuners[Rt710.Address].FailReads = 1;
        bus[0x10].Tuners[R850.Address].FailReads = 4;
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => usb, () => It930xFirmware.Code, output, _ => { }, null, null, Q3);
        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains("受信機 0 (バス 2) RT710: 読めません (RT710 が応答しません (偽物))");
        await Assert.That(text).Contains("受信機 2 (バス 2) R850: 読めません (R850 が応答しません (偽物))");
        await Assert.That(text).Contains("受信機 3 (バス 2) R850: 00 = 0x00");
        await Assert.That(text).Contains("電源: 切りました");
    }

    [Test]
    public async Task probe_は見つけた機材をシリアル番号と_Q3_の側と一緒に並べる()
    {
        var found = new List<(string Port, It930xModel Model)> { ("3-1", Q3), ("3-2", Q3), ("3-3", W3), ("3-4", Q3) };
        var serials = new Dictionary<string, string?> { ["3-1"] = "000012050009601", ["3-2"] = "000012050009602", ["3-3"] = "000001711009061", ["3-4"] = "ABC" };
        var output = new StringWriter();
        It930xProbe.List(found, port => serials.GetValueOrDefault(port), output);
        var lines = output.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        await Assert.That(lines).IsEquivalentTo(new[]
        {
            "PLEX PX-Q3PE4 (USB 0511:024a、ポート 3-1、受信機 4 つ、シリアル番号 000012050009601)  側 1、もう片方の側 3-2",
            "PLEX PX-Q3PE4 (USB 0511:024a、ポート 3-2、受信機 4 つ、シリアル番号 000012050009602)  側 2、もう片方の側 3-1",
            "PLEX PX-W3U4 (USB 0511:083f、ポート 3-3、受信機 4 つ、シリアル番号 000001711009061)",
            "PLEX PX-Q3PE4 (USB 0511:024a、ポート 3-4、受信機 4 つ、シリアル番号 ABC)  シリアル番号が 15 桁の数字で末尾が 1 か 2 の形でないので、もう片方の側と組にできません",
        }, CollectionOrdering.Matching);
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--port", "3-1", "--chips"])).IsEqualTo(new It930xProbe.Options("3-1", false, null, true));
    }
}
