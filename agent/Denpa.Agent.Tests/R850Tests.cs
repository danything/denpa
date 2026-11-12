using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * R850 (R850.cs) と RT710 (Rt710.cs)。期待値は仕様書 (denpa-spec の tc90522/spec.md) の節と付録の値で、付録 C の計算例は全部の行を照らす。
 * チューナーは、偽の TC90522 のアドレス (Tc90522Fakes.cs) の中継の先に置く。
 */
public class R850Tests
{
    private static (R850 Tuner, FakeTcBus Bus, FakeRafael Chip, FakeClock Clock) Fake(bool loopthrough = true)
    {
        var bus = new FakeTcBus(0x10);
        var chip = FakeRafael.R850();
        bus[0x10].Tuners[R850.Address] = chip;
        var clock = new FakeClock();
        return (new R850(new Tc90522Link(bus, 0x10).Tuner(R850.Address), loopthrough, clock.Sleep), bus, chip, clock);
    }

    // 仕様書 付録 C.1 の全部の行。RF、種類、ループスルー、水晶の駆動の強さ、M、N、S、待ち、2F、08〜2F の 40 バイト
    [Test]
    [Arguments(473143u, 0, true, 3, 8, 78, 0x2E16, 10, 0x42, "CA C0 72 50 00 E4 00 30 9F BB B8 B7 D2 10 CD 65 87 42 81 90 16 2E 09 23 21 F1 0C 5F C4 20 A9 8C C1 99 6B 44 53 57 6E 40")]
    [Arguments(473143u, 0, false, 3, 8, 78, 0x2E16, 10, 0x42, "4A C0 70 50 00 E4 00 30 9F BB B8 B7 D2 10 CD 65 87 42 81 90 16 2E 09 23 21 F1 0C 5F C4 20 A9 8C C1 99 6B 44 53 57 6E 40")]
    [Arguments(473143u, 1, true, 3, 8, 78, 0x2E16, 10, 0x47, "CA C0 72 50 00 E4 00 30 9F BB B8 B7 D2 10 CD 65 A7 42 81 90 16 2E 09 23 21 F1 0C 5F C4 20 A9 8C C1 99 6B 44 53 57 7E 45")]
    [Arguments(479143u, 0, true, 3, 8, 316, 0xB858, 40, 0x42, "CA C0 72 50 00 E4 00 30 9F BB B8 B7 D2 10 CD 65 87 42 81 CB 58 B8 0B 23 21 F1 0F 5F C4 20 A9 8C C1 99 6B 44 53 57 6E 40")]
    [Arguments(479143u, 1, true, 3, 8, 316, 0xB858, 40, 0x43, "CA C0 72 50 00 E4 00 30 9F BB B8 B7 D2 10 CD 65 A7 42 81 CB 58 B8 0B 23 21 F1 0F 5F C4 20 A9 8C C1 99 6B 44 53 57 7E 41")]
    [Arguments(557143u, 0, true, 3, 8, 92, 0x2E16, 10, 0x42, "CA C0 72 50 00 E4 00 30 8F BB B8 B7 D2 10 CD 65 87 42 81 93 16 2E 0B 23 21 F1 0C 5F C4 20 9A 5A C1 99 6B 44 53 57 6E 40")]
    [Arguments(557143u, 1, true, 3, 4, 46, 0x170C, 10, 0x47, "CA C0 72 50 00 E4 00 30 8F 3B B8 B7 D2 10 CD 65 A7 42 81 88 0C 17 05 23 20 F1 0C 5F C4 20 9A 5A C1 99 6B 44 53 53 7D 45")]
    [Arguments(683143u, 0, true, 3, 4, 56, 0x970C, 10, 0x42, "CA C0 32 50 00 E4 00 30 8E 3B B8 B7 D2 10 CD 65 87 42 81 8A 0C 97 07 22 00 F1 0C 5F C4 20 9A 5A C1 99 6B 45 73 43 6D 40")]
    [Arguments(695143u, 0, true, 3, 4, 57, 0x970C, 10, 0x42, "CA C0 32 50 00 E4 00 30 8E 3B B8 B7 D2 10 CD 65 87 42 C1 8B 0C 97 04 22 00 F1 0C 5F C4 20 9A 5B 53 99 6B 45 73 43 69 40")]
    [Arguments(767143u, 0, true, 3, 4, 63, 0x970C, 10, 0x42, "CA C0 72 50 00 E4 00 30 86 3B BB B7 D2 10 CD 65 87 42 81 8C 0C 97 06 23 20 F1 0C 5F C4 20 9A 5A C1 99 6B 44 53 53 6D 40")]
    [Arguments(111143u, 0, true, 3, 32, 71, 0x62FE, 10, 0x42, "CA C0 72 50 00 E4 68 31 9F 3B BA B7 D2 10 CD 65 84 40 81 8E FE 62 12 23 21 F1 0C 5F C4 20 AA 6B 30 99 4A 44 53 5F 6A 40")]
    [Arguments(111143u, 0, true, 1, 32, 71, 0x62FE, 10, 0x42, "CA C0 72 50 00 E4 68 31 9F 3B BA B7 D2 10 CD 65 84 40 81 8E FE 62 12 23 21 F1 1C 5F C4 20 AA 6B 30 99 4A 44 53 5F 6A 40")]
    [Arguments(167143u, 0, true, 3, 16, 54, 0x5C2A, 10, 0x42, "CA C0 72 50 00 E4 28 30 9F 3B B9 B7 D2 10 CD 65 84 40 81 8A 2A 5C 0D 23 21 F1 0C 5F C4 20 AA 6B 30 99 4A 44 53 5B 6A 40")]
    [Arguments(225143u, 0, true, 3, 16, 147, 0x62FE, 20, 0x42, "CA C0 72 50 00 E4 08 30 9F 3B B8 B7 D2 10 CD 65 84 40 81 A1 FE 62 0E 23 21 F1 0E 5F C4 20 AA 6B 30 99 4A 44 53 5B 6A 40")]
    public async Task 選局で書く値は仕様書の付録_C_1_の計算例と同じ(
        uint rf, int kind, bool loopthrough, int drive, int divider, int n, int fraction, int waitMs, int final, string registers)
    {
        var plan = R850.Plan(rf, kind, loopthrough, drive);
        await Assert.That(Convert.ToHexString(plan.Registers)).IsEqualTo(registers.Replace(" ", ""));
        await Assert.That(plan.Final).IsEqualTo((byte)final);
        await Assert.That((plan.Divider, plan.N, plan.Fraction, plan.WaitMs)).IsEqualTo((divider, n, fraction, waitMs));
    }

    [Test]
    public async Task 水晶の駆動の強さは_LO_が_130000_kHz_より低い選局だけで_22_の_bit5_4_に入る()
    {
        // 仕様書 6.5 (4) の手順 2。LO = RF − 4063
        byte Drive(uint rf, int strength) => (byte)((R850.Plan(rf, 0, true, strength).Registers[0x22 - 8] >> 4) & 3);
        // LO < 100000: 強さ 2 以上は 3 − 強さ、1 は 2
        await Assert.That(new[] { Drive(93143, 1), Drive(93143, 2), Drive(93143, 3) }).IsEquivalentTo(new byte[] { 2, 1, 0 }, CollectionOrdering.Matching);
        // 100000 ≦ LO < 130000: 強さ 3 は 0、ほかは 1
        await Assert.That(new[] { Drive(104063, 1), Drive(104063, 2), Drive(104063, 3) }).IsEquivalentTo(new byte[] { 1, 1, 0 }, CollectionOrdering.Matching);
        await Assert.That(new[] { Drive(134062, 1), Drive(134062, 2) }).IsEquivalentTo(new byte[] { 1, 1 }, CollectionOrdering.Matching);
        // LO ≧ 130000 は 0
        await Assert.That(new[] { Drive(134063, 1), Drive(134063, 2), Drive(473143, 1) }).IsEquivalentTo(new byte[] { 0, 0, 0 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 帯の端の周波数は仕様書の区切りで値が変わる()
    {
        // 周波数ごとの表の行 (付録 A.2)。a2 は 27 に入る
        byte A2(uint rf) => R850.Plan(rf, 0, true, 3).Registers[0x27 - 8];
        await Assert.That(new[] { A2(340000), A2(340001), A2(469999), A2(470000), A2(487999), A2(488000) })
            .IsEquivalentTo(new byte[] { 0x6B, 0x5A, 0x5A, 0x8C, 0x8C, 0x5A }, CollectionOrdering.Matching);
        await Assert.That(new[] { A2(679999), A2(680000), A2(691999), A2(692000), A2(697999), A2(698000) })
            .IsEquivalentTo(new byte[] { 0x5A, 0x5A, 0x5A, 0x5B, 0x5B, 0x5A }, CollectionOrdering.Matching);
        // 680000〜691999 の行は a13 (0A の bit6) が 0。それ以外の行 (698000) は 1
        await Assert.That((R850.Plan(680000, 0, true, 3).Registers[0x0A - 8] & 0x40, R850.Plan(698000, 0, true, 3).Registers[0x0A - 8] & 0x40)).IsEqualTo((0, 0x40));
        // 水晶を 4 で割るのは 478000 ≦ RF < 482000 だけ (仕様書 6.5 (4) の手順 7)。種類 1 の 2F の bit3〜2 も、481999 までは 00
        await Assert.That(new[] { 477999u, 478000u, 481999u, 482000u }.Select(rf => R850.Plan(rf, 1, true, 3).WaitMs)).IsEquivalentTo(new[] { 10, 40, 40, 10 }, CollectionOrdering.Matching);
        await Assert.That(new[] { 477999u, 478000u, 481999u, 482000u }.Select(rf => R850.Plan(rf, 1, true, 3).Final & 0x0C)).IsEquivalentTo(new[] { 4, 0, 0, 4 }, CollectionOrdering.Matching);
        // 受け付ける範囲の両端 (40000・1002000 kHz) も計算できる。VCO の分周は 6 回 (M = 128) まで
        await Assert.That(R850.Plan(R850.MinKhz, 0, true, 3).Divider).IsEqualTo(64);
        await Assert.That(R850.Plan(R850.MaxKhz, 0, true, 3).Divider).IsEqualTo(4);
        // LO の区切り (付録 A.3 の (d)・(e))。LO = 480000 と 580000 の前後で 10 の値が変わる
        byte R10(uint lo) => R850.Plan(lo + R850.IfKhz, 0, true, 3).Registers[0x10 - 8];
        await Assert.That(new[] { R10(479999), R10(480000), R10(549999), R10(550000), R10(579999), R10(580000), R10(900000) })
            .IsEquivalentTo(new byte[] { 0x9F, 0x97, 0x97, 0x8F, 0x8F, 0x89, 0x80 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task PLL_の小数の丸めは仕様書_6_5_の手順_13()
    {
        // 水晶 24000。VCO = 2 × 24000 × N + F
        const int x = 24000;
        // F < X / 64 は 0 に
        await Assert.That(RafaelPll.Divide(2L * x * 80 + 374, x)).IsEqualTo((80, 0, true));
        // F > X × 127 / 64 は 0 にして N を 1 増やす
        await Assert.That(RafaelPll.Divide(2L * x * 80 + 47626, x)).IsEqualTo((81, 0, true));
        // X × 127 / 128 < F < X は X × 127 / 128 (23812) に、X < F < X × 129 / 128 は X × 129 / 128 (24187) に
        await Assert.That(RafaelPll.Divide(2L * x * 80 + 23900, x)).IsEqualTo(RafaelPll.Divide(2L * x * 80 + 23812, x));
        await Assert.That(RafaelPll.Divide(2L * x * 80 + 24100, x)).IsEqualTo(RafaelPll.Divide(2L * x * 80 + 24187, x));
        // F = X はそのまま。小数は、切り捨てを重ねた 0x7FFE になる (手順 15)
        await Assert.That(RafaelPll.Divide(2L * x * 80 + x, x)).IsEqualTo((80, 0x7FFE, false));
    }

    [Test]
    public async Task 中継の先から読んだ値はビットの並びを直す()
    {
        var (_, bus, chip, _) = Fake();
        chip.Status[0x00] = 0x01;
        chip.Status[0x01] = 0xA5;
        var port = new Tc90522Link(bus, 0x10).Tuner(R850.Address);
        // 偽のチューナーはビットの並びを逆にした 80・A5 を返し、こちらで 01・A5 に戻す (A5 は逆にしても A5)
        await Assert.That(port.Read(2)).IsEquivalentTo(new byte[] { 0x01, 0xA5 }, CollectionOrdering.Matching);
        await Assert.That(Tc90522Link.Reverse(0x01)).IsEqualTo((byte)0x80);
        await Assert.That(Tc90522Link.Reverse(0x4C)).IsEqualTo((byte)0x32);
    }

    [Test]
    public async Task 初期化は種類を見分けて_08_から_2F_を読み_水晶の駆動の強さを調べて書き戻す()
    {
        var (tuner, bus, chip, clock) = Fake();
        // 電源を入れたときの値 (偽物で決めた値)
        for (var i = 8; i < 48; i++) chip.Registers[i] = (byte)(0x80 + i);
        var power = chip.Registers[8..];
        tuner.Init();
        await Assert.That((tuner.Kind, tuner.XtalDrive)).IsEqualTo((0, 3));
        await Assert.That(tuner.Saved!).IsEquivalentTo(power, CollectionOrdering.Matching);
        var trial = "CAC0725000E0003086BBF8B0D281CD46374089925505080021F9845FC420A96C53AB5B46B3936E40";
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 種類を見分ける (仕様書 6.3 の手順 1)。00 が (値 & 0x98) == 0 のままなので 4 回読んで種類 0
            "10 R850 ?1", "10 R850 ?1", "10 R850 ?1", "10 R850 ?1",
            // 08〜2F を読んで取っておく (00 から 48 バイト)
            "10 R850 ?48",
            // 水晶の駆動の強さ: 付録 A.1 の初期値の 7 つを書き換えた 40 バイト、22 ← 84・94・A4・B4 と 02 の読み出し
            $"10 R850 08={trial}",
            "10 R850 22=84", "10 R850 ?3", "10 R850 22=94", "10 R850 ?3", "10 R850 22=A4", "10 R850 ?3", "10 R850 22=B4", "10 R850 ?3",
            // 取っておいた 40 バイトを書き戻す
            $"10 R850 08={Convert.ToHexString(power)}",
        }, CollectionOrdering.Matching);
        // 待ちは無い (仕様書 10)
        await Assert.That(clock.Sleeps).IsEmpty();
    }

    [Test]
    [Arguments(0x08, 1)]
    [Arguments(0x10, 1)]
    [Arguments(0x80, 1)]
    [Arguments(0x67, 0)]
    public async Task 種類は_00_の_0x98_のビットで見分ける(int id, int kind)
    {
        var (tuner, bus, chip, _) = Fake();
        chip.Status[0x00] = (byte)id;
        tuner.Init();
        await Assert.That((tuner.Kind, tuner.Id)).IsEqualTo((kind, (byte)id));
        // 種類 1 は最初の読み出しで決まる。種類 1 のときの試しの 2F は 41 (種類 0 は 40)
        await Assert.That(bus.Log.TakeWhile(line => line == "10 R850 ?1").Count()).IsEqualTo(kind == 1 ? 1 : 4);
        await Assert.That(bus.Log.First(line => line.StartsWith("10 R850 08=", StringComparison.Ordinal))).EndsWith(kind == 1 ? "41" : "40");
    }

    [Test]
    public async Task 種類の読み出しは_3_回までの誤りを読み直し_4_回目も誤りなら失敗()
    {
        var (tuner, _, chip, _) = Fake();
        chip.FailReads = 3;
        tuner.Init();
        await Assert.That(tuner.Kind).IsEqualTo(0);
        chip.FailReads = 4;
        Assert.Throws<It930xException>(() => tuner.Init());
    }

    [Test]
    [Arguments(0, 1)]
    [Arguments(1, 2)]
    [Arguments(2, 3)]
    [Arguments(3, 3)]
    [Arguments(9, 3)]
    public async Task 水晶の駆動の強さは_PLL_がロックして下位_6_ビットが_61_以下になった回に_1_を足す(int passes, int expected)
    {
        var (tuner, _, chip, _) = Fake();
        // 02 を読むのは、種類の 4 回と 48 バイトの 1 回のあと (6 回目から)。passes 回目 (0 から) の読み出しだけ、ロックして下位 6 ビットが 61
        chip.OnRead = count => chip.Status[0x02] = (byte)(count - 6 == passes ? 0x40 | 61 : 0x40 | 62);
        tuner.Init();
        await Assert.That(tuner.XtalDrive).IsEqualTo(expected);
    }

    [Test]
    public async Task ロックしていない_02_は水晶の駆動の強さの条件に当てはまらない()
    {
        var (tuner, _, chip, _) = Fake();
        // bit6 が 0 (PLL がロックしていない) なら、下位 6 ビットが小さくても当てはまらない
        chip.Status[0x02] = 0x05;
        tuner.Init();
        await Assert.That(tuner.XtalDrive).IsEqualTo(3);
    }

    [Test]
    public async Task 周波数の設定は_40_バイトを書いて待ち_2F_を書く()
    {
        var (tuner, bus, _, clock) = Fake();
        tuner.SetFrequency(479143);
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            "10 R850 08=CAC0725000E400309FBBB8B7D210CD65874281CB58B80B2321F10F5FC420A98CC1996B4453576E40",
            "10 R850 2F=42",
        }, CollectionOrdering.Matching);
        // 水晶を 4 で割る選局は 40 ms 待つ (仕様書 6.5 (5))
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 40 }, CollectionOrdering.Matching);
        // 前の選局の値を引き継がない (選局のたびに初期値から作り直す。仕様書 6.5 の終わり)。14ch のあとの 13ch も付録 C.1 と同じ
        bus.Log.Clear();
        tuner.SetFrequency(473143);
        await Assert.That(bus.Log[0]).IsEqualTo("10 R850 08=CAC0725000E400309FBBB8B7D210CD6587428190162E092321F10C5FC420A98CC1996B4453576E40");
        await Assert.That(tuner.Written!.Final).IsEqualTo((byte)0x42);
    }

    [Test]
    public async Task 範囲の外の周波数は何も書かずに断る()
    {
        var (tuner, bus, _, _) = Fake();
        Assert.Throws<IOException>(() => tuner.SetFrequency(39999));
        Assert.Throws<IOException>(() => tuner.SetFrequency(1002001));
        await Assert.That(bus.Log).IsEmpty();
        tuner.SetFrequency(40000);
        tuner.SetFrequency(1002000);
        await Assert.That(bus.Log.Count).IsEqualTo(4);
    }

    [Test]
    public async Task PLL_のロックは_02_の_bit6()
    {
        var (tuner, bus, chip, _) = Fake();
        chip.Status[0x02] = 0x40;
        await Assert.That(tuner.PllLocked()).IsTrue();
        chip.Status[0x02] = 0xBF;
        await Assert.That(tuner.PllLocked()).IsFalse();
        // 02 は、00 から 3 バイト読んだ 3 つ目 (仕様書 6.6)
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "10 R850 ?3", "10 R850 ?3" }, CollectionOrdering.Matching);
    }
}

public class Rt710Tests
{
    private static (Rt710 Tuner, FakeTcBus Bus, FakeRafael Chip, FakeClock Clock) Fake()
    {
        var bus = new FakeTcBus(0x11);
        var chip = FakeRafael.Rt710();
        bus[0x11].Tuners[Rt710.Address] = chip;
        var clock = new FakeClock();
        return (new Rt710(new Tc90522Link(bus, 0x11).Tuner(Rt710.Address), clock.Sleep), bus, chip, clock);
    }

    // 仕様書 付録 C.2 の全部の行。f、04 (1 回目)、05、04 (2 回目)、07、06、10 ms のあとの 0A、02、08、0E
    [Test]
    [Arguments(1049480u, "40", "92", "40", "74", "EC", "39", "20", "07", "90")]
    [Arguments(1318000u, "41", "4A", "41", "EA", "AE", "39", "20", "07", "90")]
    [Arguments(1471440u, "41", "0C", "41", "4F", "5E", "39", "20", "07", "90")]
    [Arguments(1613000u, "41", "8D", "41", "35", "58", "39", "60", "87", "90")]
    [Arguments(1933000u, "41", "D0", "41", "8A", "AE", "39", "60", "87", "90")]
    [Arguments(1973000u, "41", "51", "41", "35", "58", "38", "20", "07", "90")]
    [Arguments(2053000u, "41", "12", "41", "8A", "AE", "38", "20", "07", "98")]
    public async Task 選局で書く値は仕様書の付録_C_2_の計算例と同じ(
        uint khz, string first04, string r05, string second04, string r07, string r06, string r0A, string r02, string r08, string r0E)
    {
        var (tuner, bus, _, clock) = Fake();
        tuner.Init();
        bus.Log.Clear();
        tuner.SetFrequency(khz);
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 最初に 16 バイト (仕様書 7.3 (1))
            "11 RT710 00=401D20104150ED250758396438F79035",
            $"11 RT710 04={first04}", $"11 RT710 05={r05}", $"11 RT710 04={second04}", $"11 RT710 07={r07}", $"11 RT710 06={r06}",
            $"11 RT710 0A={r0A}", $"11 RT710 02={r02}", $"11 RT710 08={r08}", $"11 RT710 0E={r0E}",
            // 最後に帯域
            "11 RT710 0F=45",
        }, CollectionOrdering.Matching);
        // PLL の値を書いたあと 10 ms (仕様書 7.3 (2) の手順 10)。06 のあと、0A の前
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10 }, CollectionOrdering.Matching);
        var plan = Rt710.Plan(khz, rt720: false);
        await Assert.That(plan.FindIndex(write => write.Register == Rt710.Wait)).IsEqualTo(6);
    }

    [Test]
    public async Task VCO_の分周は_2350000_から_4700000_に入るまで_2_倍にする()
    {
        // 04 の bit0 は分周の番号 k の bit0。M = 2 は k = 1、M = 4 は k = 0 (仕様書 7.3 (2) の手順 1〜3)
        byte First04(uint khz) => Rt710.Plan(khz, false)[1].Values[0];
        await Assert.That(new[] { First04(1175000), First04(1174999), First04(2350000), First04(587500), First04(587499) })
            .IsEquivalentTo(new byte[] { 0x41, 0x40, 0x41, 0x40, 0x40 }, CollectionOrdering.Matching);
        // 周波数で変える値の区切り (仕様書 7.3 (3)): 1600000 と 1950000 と 2000000
        (byte R02, byte R0A, byte R0E) Late(uint khz)
        {
            var plan = Rt710.Plan(khz, false);
            return (plan.Single(w => w.Register == 0x02).Values[0], plan.Single(w => w.Register == 0x0A).Values[0], plan.Single(w => w.Register == 0x0E).Values[0]);
        }
        await Assert.That(new[] { Late(1599999), Late(1600000), Late(1949999), Late(1950000), Late(1999999), Late(2000000) }).IsEquivalentTo(new (byte, byte, byte)[]
        {
            (0x20, 0x39, 0x90), (0x60, 0x39, 0x90), (0x60, 0x39, 0x90), (0x20, 0x38, 0x90), (0x20, 0x38, 0x90), (0x20, 0x38, 0x98),
        }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task RT720_は初期値と書く順が違う()
    {
        var (tuner, bus, chip, _) = Fake();
        // 03 の上位 4 ビットが 7 でなければ RT720 (仕様書 7.2)
        chip.Status[0x03] = 0x60;
        tuner.Init();
        await Assert.That((tuner.Rt720, tuner.Name, tuner.Id)).IsEqualTo((true, "RT720", (byte)0x60));
        // 初期化は 03 を読むだけ (00 から 4 バイト読んで 4 つ目)。チップへは何も書かない
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 RT710 ?4" }, CollectionOrdering.Matching);
        bus.Log.Clear();
        // BS-1 (M = 4、k = 0)。08 の bit4 ← k の bit1、04 の bit7〜6 ← 01、0C の bit4 ← 1 を書き、周波数で変える値は 0B だけ (仕様書 7.3)
        tuner.SetFrequency(1049480);
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            "11 RT710 00=001C00104148DA4B0758384037F74C59",
            "11 RT710 04=40", "11 RT710 08=07", "11 RT710 04=40", "11 RT710 0C=37",
            "11 RT710 05=92", "11 RT710 04=40", "11 RT710 07=74", "11 RT710 06=EC",
            "11 RT710 0B=40", "11 RT710 0F=45",
        }, CollectionOrdering.Matching);
        // M = 8 (k = 2) なら 08 の bit4 が 1、04 の bit7〜6 が 10、0C の bit4 が 0
        var plan = Rt710.Plan(500000, rt720: true);
        await Assert.That(plan.Skip(1).Take(4).Select(write => $"{write.Register:X2}={write.Values[0]:X2}")).IsEquivalentTo(new[] { "04=40", "08=17", "04=80", "0C=27" }, CollectionOrdering.Matching);
        bus.Log.Clear();
        tuner.Standby();
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 RT710 00=FF5E883041C8ED2547FC48A2080FF359" }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 待機は_16_バイトを_1_回で書く_ロックは_02_の_bit7()
    {
        var (tuner, bus, chip, _) = Fake();
        tuner.Init();
        await Assert.That((tuner.Rt720, tuner.Name)).IsEqualTo((false, "RT710"));
        bus.Log.Clear();
        tuner.Standby();
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 RT710 00=FF5C883041C8ED2547FC48A2080FF359" }, CollectionOrdering.Matching);
        await Assert.That(tuner.PllLocked()).IsTrue();
        // R850 のロックのビット (bit6) では、RT710 はロックとみなさない (仕様書 7.4)
        chip.Status[0x02] = 0x40;
        await Assert.That(tuner.PllLocked()).IsFalse();
    }

    [Test]
    public async Task 入力のレベルは_01_の利得の番号と周波数から求める()
    {
        // 仕様書 8.4。g = (値 >> 4) | ((値 & 1) << 4)。g ≦ 2 は n = 0、基準は f < 1200000 が 190
        await Assert.That(Rt710.Level(0x20, 1049480)).IsEqualTo(-100 * (190 + 0));
        // g = 5 → n = 3 (表は 74)。1200000 ≦ f < 1800000 は 170
        await Assert.That(Rt710.Level(0x50, 1318000)).IsEqualTo(-100 * (170 + 74));
        // g = 12 → n = 7、g = 22 → n = 17、g = 31 → n = 18。f ≧ 1800000 は 140
        await Assert.That(Rt710.Level(0xC0, 2053000)).IsEqualTo(-100 * (140 + 181));
        await Assert.That(Rt710.Level(0x61, 2053000)).IsEqualTo(-100 * (140 + 389));
        await Assert.That(Rt710.Level(0xF1, 2053000)).IsEqualTo(-100 * (140 + 409));
        // チップから読むのは 01 (00 から 2 バイト読んだ 2 つ目)。RT720 は読まない
        var (tuner, bus, chip, _) = Fake();
        chip.Status[0x01] = 0x50;
        await Assert.That(tuner.Level(1318000)).IsEqualTo(-24400);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 RT710 ?2" }, CollectionOrdering.Matching);
        chip.Status[0x03] = 0x00;
        tuner.Init();
        await Assert.That(tuner.Level(1318000)).IsNull();
    }
}
