using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * TC90522 の受信機 (Tc90522.cs)。Q3・W3 系の地上波の受信機と衛星の受信機を、偽のバス (Tc90522Fakes.cs) につないで確かめる。
 * 期待値は仕様書 (denpa-spec の px4/spec.md) の節の表の値と順。機材 (It930xDevice) を通した順は Tc90522BoardTests.cs。
 */
public class Tc90522Tests
{
    private static readonly It930xModel W3 = It930x.Find(0x0511, 0x083F)!;

    /// <summary>T27 (557143 kHz) で R850 に書く 40 バイト (仕様書 付録 C.1。種類 0・ループスルー有り)</summary>
    internal const string R850Ch27 = "CAC0725000E400308FBBB8B7D210CD6587428193162E0B2321F10C5FC4209A5AC1996B4453576E40";

    /// <summary>RT710 の選局の最初に書く 16 バイト (仕様書 8.3 (1))</summary>
    internal const string Rt710Start = "401D20104150ED250758396438F79035";

    /// <summary>RT710 の待機の 16 バイト (仕様書 8.5)</summary>
    internal const string Rt710Standby = "FF5C883041C8ED2547FC48A2080FF359";

    private static (Tc90522Terrestrial Frontend, FakeTcBus Bus, FakeClock Clock) Terrestrial(int receiver = 2)
    {
        var bus = FakeTcBus.W3();
        var clock = new FakeClock();
        return (new Tc90522Terrestrial(bus, new Lock(), W3.Receivers[receiver], clock.Sleep, () => clock.Now), bus, clock);
    }

    private static (Tc90522Satellite Frontend, FakeTcBus Bus, FakeClock Clock) Satellite(int receiver = 0)
    {
        var bus = FakeTcBus.W3();
        var clock = new FakeClock();
        return (new Tc90522Satellite(bus, new Lock(), W3.Receivers[receiver], clock.Sleep, () => clock.Now), bus, clock);
    }

    /// <summary>書き込みと読み出しを、バイト列のまま控えるバス (中継の形を確かめる)</summary>
    private sealed class RawBus : ICxdBus
    {
        public List<string> Log { get; } = [];

        public byte[] Next { get; set; } = [];

        public void Write(byte address, ReadOnlySpan<byte> data) => Log.Add($"W {address:X2} {Convert.ToHexString(data)}");

        public void Read(byte address, Span<byte> data)
        {
            Log.Add($"R {address:X2} {data.Length}");
            Next.AsSpan(0, data.Length).CopyTo(data);
        }
    }

    [Test]
    public async Task チューナーあての通信は復調器の_FE_に包む()
    {
        // 仕様書 3.2 の例。受信機 2 の R850 (0x7C) の 08 へ 2 バイト → 復調器 0x10 へ FE F8 08 xx yy
        var bus = new RawBus();
        new Tc90522Link(bus, 0x10).Tuner(R850.Address).Write([0x08, 0xAB, 0xCD]);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "W 10 FEF808ABCD" }, CollectionOrdering.Matching);
        // 受信機 0 の RT710 (0x7A) から 4 バイト → 0x11 へ FE F4 00、0x11 へ FE F5、0x11 から 4 バイト読む。読んだ値はビットの並びを直す
        bus.Log.Clear();
        bus.Next = [0x80, 0x40, 0x0F, 0x0E];
        var read = new Tc90522Link(bus, 0x11).Tuner(Rt710.Address).Read(4);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "W 11 FEF400", "W 11 FEF5", "R 11 4" }, CollectionOrdering.Matching);
        await Assert.That(read).IsEquivalentTo(new byte[] { 0x01, 0x02, 0xF0, 0x70 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 復調器のレジスタは番号に続けて書き_読むときは番号だけを書いてから読む()
    {
        var bus = new RawBus { Next = [0x12, 0x34] };
        var link = new Tc90522Link(bus, 0x11);
        link.Write(0x8F, 0x40, 0x10);
        var read = link.Read(0xE6, 2);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "W 11 8F4010", "W 11 E6", "R 11 2" }, CollectionOrdering.Matching);
        await Assert.That(read).IsEquivalentTo(new byte[] { 0x12, 0x34 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 地上波の起動とスリープは仕様書_4_2_と_4_3_の表()
    {
        var (frontend, bus, clock) = Terrestrial();
        frontend.Wake();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            "10 B0=A0", "10 B2=3D", "10 B3=25", "10 B4=8B", "10 B5=4B", "10 B6=3F", "10 B7=FF", "10 B8=C0",
            "10 1F=00", "10 75=00", "10 1D=A8", "10 03=00",
        }, CollectionOrdering.Matching);
        bus.Log.Clear();
        frontend.Rest();
        // TS の端子を止めてからスリープにする (端子は仕様書に無い)。R850 には何も書かない (仕様書 7.7)
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "10 1D=A8", "10 03=F0" }, CollectionOrdering.Matching);
        await Assert.That(clock.Sleeps).IsEmpty();
    }

    [Test]
    public async Task 衛星の起動とスリープは仕様書_4_2_と_4_3_の表()
    {
        var (frontend, bus, clock) = Satellite();
        frontend.Wake();
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 15=00", "11 1D=00", "11 04=02", "11 1C=80", "11 1F=22", "11 13=00", "11 17=00" }, CollectionOrdering.Matching);
        bus.Log.Clear();
        frontend.Rest();
        // TS の端子を止め (仕様書に無い)、RT710 を待機にして、続けて復調器をスリープにする (仕様書 4.1 の 3)
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 1C=80", "11 1F=22", $"11 RT710 00={Rt710Standby}", "11 13=80", "11 17=FF" }, CollectionOrdering.Matching);
        await Assert.That(clock.Sleeps).IsEmpty();
    }

    [Test]
    public async Task 地上波の選局は仕様書_5_2_の順に書いてロックを待つ()
    {
        var (frontend, bus, clock) = Terrestrial();
        var locked = frontend.Tune(ChannelTable.Parse("T27")!);
        await Assert.That(locked).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 1〜6
            "10 47=30", "10 25=00", "10 20=00", "10 23=4D", "10 01=50", "10 76=0C",
            // 7: R850 の周波数 (付録 C.1 の 557143 kHz)
            $"10 R850 08={R850Ch27}", "10 R850 2F=42",
            // 8: PLL のロック
            "10 R850 ?3",
            // 9〜15
            "10 25=00", "10 20=00", "10 23=4C", "10 01=50", "10 71=21", "10 72=25", "10 75=08",
            // 16: ロック (80 と B0)
            "10 80?", "10 B0?",
        }, CollectionOrdering.Matching);
        // R850 の 40 バイトのあと 10 ms。ロックが早いので、確かめ始めてから 350 ms になるまで待つ (仕様書 5.3)
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10, 350 }, CollectionOrdering.Matching);
        await Assert.That(frontend.LockMs).IsEqualTo(0L);
    }

    [Test]
    public async Task 地上波のロックは_80_の_bit5_と_bit3_が_0_で_B0_の下位が_8_以上()
    {
        var (frontend, bus, clock) = Terrestrial();
        var demod = bus[0x10];
        // 39 回目まではロックしていない (80 の bit3)。40 回目にロックする
        demod.OnRead = (register, count) => register == 0x80 ? (byte)(count < 40 ? 0x08 : 0x00) : null;
        await Assert.That(frontend.Tune(ChannelTable.Parse("T27")!)).IsTrue();
        // 10 ms おきに確かめ、350 ms を過ぎてからのロックは待ち足さない
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 39), CollectionOrdering.Matching);
        await Assert.That(frontend.LockMs).IsEqualTo(390L);
        // B0 は 80 が通ったときだけ読む
        await Assert.That((demod.Reads[0x80], demod.Reads[0xB0])).IsEqualTo((40, 1));

        // 20 回目のロックは、350 ms になるまで待ってから返す (残りの 15 回ぶん)
        (frontend, bus, clock) = Terrestrial();
        bus[0x10].OnRead = (register, count) => register == 0x80 ? (byte)(count <= 20 ? 0x20 : 0x00) : null;
        await Assert.That(frontend.Tune(ChannelTable.Parse("T27")!)).IsTrue();
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 20).Append(150), CollectionOrdering.Matching);
    }

    [Test]
    [Arguments(0x80, 0x20)]
    [Arguments(0x80, 0x08)]
    [Arguments(0xB0, 0x87)]
    public async Task 地上波がロックしなければ_300_回確かめて_false(int register, int value)
    {
        var (frontend, bus, clock) = Terrestrial();
        bus[0x10].Status[(byte)register] = (byte)value;
        await Assert.That(frontend.Tune(ChannelTable.Parse("T27")!)).IsFalse();
        await Assert.That(bus[0x10].Reads[0x80]).IsEqualTo(Tc90522Frontend.LockPolls);
        // R850 の待ちのあと、10 ms を 300 回 (仕様書 12)
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 300), CollectionOrdering.Matching);
        await Assert.That(frontend.LockMs).IsEqualTo(-1L);
        // ロックしていないときは C/N を読まない
        var signal = frontend.Signal()!;
        await Assert.That((signal.Locked, signal.Cn)).IsEqualTo((false, (double?)null));
    }

    [Test]
    public async Task R850_の_PLL_がロックしなければ_50_回確かめて失敗にする()
    {
        var (frontend, bus, clock) = Terrestrial();
        bus[0x10].Tuners[R850.Address].Status[0x02] = 0x00;
        var error = Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).IsEqualTo("R850 の PLL がロックしませんでした");
        await Assert.That(bus.Log.Count(line => line == "10 R850 ?3")).IsEqualTo(50);
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 50), CollectionOrdering.Matching);
        // AGC を動かす書き込み (23 ← 4C) には進まない
        await Assert.That(bus.Log).DoesNotContain("10 23=4C");
        await Assert.That(frontend.Signal()).IsNull();
    }

    [Test]
    public async Task 地上波の受信機は受けられない方式と範囲の外の周波数を何も書かずに断る()
    {
        var (frontend, bus, _) = Terrestrial();
        var satellite = Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("BS15:16625")!));
        await Assert.That(satellite.Message).IsEqualTo("この受信機は地上波だけを受けられます (BS は選局できません)");
        Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("H40")!));
        // ISDB-C は地上波と同じ帯の周波数だが、地上波として選局しない
        Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("QC51")!));
        Assert.Throws<IOException>(() => frontend.Tune(new ChannelTable.Tuning("GR", ChannelTable.SysIsdbt, 1_002_001_000, ChannelTable.NoStreamId)));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 衛星の選局は仕様書_6_2_の順に書き_ロックのあと_TSID_で_TS_を選ぶ()
    {
        var (frontend, bus, clock) = Satellite();
        // BS15 は 1318000 kHz (IF)。TSID 16625 = 0x40F1
        var locked = frontend.Tune(ChannelTable.Parse("BS15:16625")!);
        await Assert.That(locked).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 1〜6
            "11 0A=00", "11 10=B0", "11 11=02", "11 03=01", "11 8E=06", "11 A3=F7",
            // 7: RT710 の周波数 (付録 C.2 の 1318000 kHz)
            $"11 RT710 00={Rt710Start}", "11 RT710 04=41", "11 RT710 05=4A", "11 RT710 04=41", "11 RT710 07=EA", "11 RT710 06=AE",
            "11 RT710 0A=39", "11 RT710 02=20", "11 RT710 08=07", "11 RT710 0E=90", "11 RT710 0F=45",
            // 8: PLL のロック
            "11 RT710 ?3",
            // 9〜12
            "11 0A=FF", "11 10=B2", "11 11=00", "11 03=01",
            // 13: ロック (C3 の bit4)
            "11 C3?",
            // 14: TSID を 2 バイトで書き、選ばれている TSID を読む (仕様書 6.4)
            "11 8F=40F1", "11 E6?2",
        }, CollectionOrdering.Matching);
        // RT710 の PLL の値を書いたあとの 10 ms だけ。ISDB-S はロックのあとに待ち足さない
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 衛星の_2_つ目の受信機は_AGC_の_10_の値が違う()
    {
        var (frontend, bus, _) = Satellite(receiver: 1);
        await Assert.That(frontend.Tune(ChannelTable.Parse("BS15:16625")!)).IsTrue();
        // 受信機 1 (0x13) は 30・32 (仕様書 6.2 の「2 つ目」の値)
        await Assert.That(bus.Log.Where(line => line.StartsWith("13 10=", StringComparison.Ordinal))).IsEquivalentTo(new[] { "13 10=30", "13 10=32" }, CollectionOrdering.Matching);
        await Assert.That(bus.Log.All(line => line.StartsWith("13 ", StringComparison.Ordinal))).IsTrue();
    }

    [Test]
    public async Task TSID_の指定が無ければ相対_TS_番号_0_の_TSID_を_TMCC_から読んで選ぶ()
    {
        var (frontend, bus, clock) = Satellite();
        var demod = bus[0x11];
        // TMCC の TSID は 3 回目の読みで入る (それまでは 0)
        demod.OnRead = (register, count) => register == 0xCE ? (byte)(count < 3 ? 0x00 : 0x40) : register == 0xCF ? (byte)(count < 3 ? 0x00 : 0x10) : null;
        await Assert.That(frontend.Tune(ChannelTable.Parse("BS01")!)).IsTrue();
        var after = bus.Log.SkipWhile(line => line != "11 C3?").ToList();
        await Assert.That(after).IsEquivalentTo(new[] { "11 C3?", "11 CE?2", "11 CE?2", "11 CE?2", "11 8F=4010", "11 E6?2" }, CollectionOrdering.Matching);
        // 0 が読めた 2 回は 10 ms 待つ
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10, 10, 10 }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 相対_TS_番号の_TS_が無ければ_100_回読んで_false()
    {
        var (frontend, bus, clock) = Satellite();
        await Assert.That(frontend.Tune(ChannelTable.Parse("BS01")!)).IsFalse();
        await Assert.That(bus[0x11].Reads[0xCE]).IsEqualTo(100);
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 100), CollectionOrdering.Matching);
        // TSID は書かない
        await Assert.That(bus.Log.Any(line => line.StartsWith("11 8F=", StringComparison.Ordinal))).IsFalse();
    }

    [Test]
    public async Task 選んだ_TSID_に切り替わらなければ_100_回読んで_false()
    {
        var (frontend, bus, clock) = Satellite();
        // 選ばれている TSID がいつまでも前の値 (0x4010)
        bus[0x11].Status[0xE6] = 0x40;
        bus[0x11].Status[0xE7] = 0x10;
        await Assert.That(frontend.Tune(ChannelTable.Parse("BS15:16625")!)).IsFalse();
        await Assert.That(bus[0x11].Reads[0xE6]).IsEqualTo(100);
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 100), CollectionOrdering.Matching);
        // ロックはしていた
        await Assert.That(frontend.LockMs).IsEqualTo(0L);
    }

    [Test]
    public async Task 衛星がロックしなければ_300_回確かめて_false_で_TS_は選ばない()
    {
        var (frontend, bus, clock) = Satellite();
        bus[0x11].Status[0xC3] = 0x10;
        await Assert.That(frontend.Tune(ChannelTable.Parse("BS15:16625")!)).IsFalse();
        await Assert.That(bus[0x11].Reads[0xC3]).IsEqualTo(300);
        await Assert.That(clock.Sleeps.Skip(1)).IsEquivalentTo(Enumerable.Repeat(10, 300), CollectionOrdering.Matching);
        await Assert.That(bus.Log.Any(line => line.StartsWith("11 8F=", StringComparison.Ordinal))).IsFalse();
        await Assert.That(frontend.LockMs).IsEqualTo(-1L);
    }

    [Test]
    public async Task RT710_の_PLL_がロックしなければ失敗にする()
    {
        var (frontend, bus, _) = Satellite();
        bus[0x11].Tuners[Rt710.Address].Status[0x02] = 0x40;
        var error = Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).IsEqualTo("RT710 の PLL がロックしませんでした");
        await Assert.That(bus.Log.Count(line => line == "11 RT710 ?3")).IsEqualTo(50);
        await Assert.That(bus.Log).DoesNotContain("11 0A=FF");
    }

    [Test]
    public async Task 衛星の受信機は地上波と_J83B_を何も書かずに断る()
    {
        var (frontend, bus, _) = Satellite();
        var error = Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).IsEqualTo("この受信機は衛星だけを受けられます (GR は選局できません)");
        Assert.Throws<IOException>(() => frontend.Tune(ChannelTable.Parse("H40")!));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task TS_の端子は仕様書_4_5_の値で出して止める()
    {
        var (terrestrial, bus, _) = Terrestrial(receiver: 3);
        terrestrial.Stream(true);
        terrestrial.Stream(false);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "12 1D=00", "12 1D=A8" }, CollectionOrdering.Matching);
        var (satellite, other, _) = Satellite();
        satellite.Stream(true);
        satellite.Stream(false);
        await Assert.That(other.Log).IsEquivalentTo(new[] { "11 1C=00", "11 1F=00", "11 1C=80", "11 1F=22" }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task 地上波の_CN_は_8B_の_24_ビットを式で_dB_にする()
    {
        var (frontend, bus, _) = Terrestrial();
        // 選局するまでは読まない
        await Assert.That(frontend.Signal()).IsNull();
        frontend.Tune(ChannelTable.Parse("T27")!);
        bus[0x10].Status[0x8B] = 0x00;
        bus[0x10].Status[0x8C] = 0x30;
        bus[0x10].Status[0x8D] = 0x39;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        // ロックを確かめてから、8B から 3 バイト (上位が先) を読む (仕様書 9.1)
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "10 80?", "10 B0?", "10 8B?3" }, CollectionOrdering.Matching);
        await Assert.That(signal.Locked).IsTrue();
        await Assert.That(signal.Unit).IsEqualTo(TunerSignal.Db);
        // r = 12345。P = 10 × log10(5505024 / 12345) = 26.49…、C/N は 4 次の式で 27.6 dB ほど
        var p = 10 * Math.Log10(5505024.0 / 12345);
        var expected = 0.000024 * Math.Pow(p, 4) - 0.0016 * Math.Pow(p, 3) + 0.0398 * p * p + 0.5491 * p + 3.0965;
        await Assert.That(Math.Abs(signal.Cn!.Value - expected)).IsLessThan(1e-9);
        await Assert.That(signal.Cn!.Value is > 27.0 and < 28.5).IsTrue();
        // r が 0 なら値は無い
        bus[0x10].Status[0x8C] = 0x00;
        bus[0x10].Status[0x8D] = 0x00;
        await Assert.That(frontend.Signal()!.Cn).IsNull();
    }

    [Test]
    public async Task 衛星の_CN_は_BC_の_16_ビットを式で_dB_にする()
    {
        var (frontend, bus, _) = Satellite();
        frontend.Tune(ChannelTable.Parse("BS15:16625")!);
        bus[0x11].Status[0xBC] = 0x1B;
        bus[0x11].Status[0xBD] = 0x58;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 C3?", "11 BC?2" }, CollectionOrdering.Matching);
        // r = 7000。p = sqrt(7000 − 3000) / 64 = 0.988…、C/N は 5 次の式で 20.9 dB ほど (仕様書 9.2)
        var p = Math.Sqrt(7000 - 3000) / 64;
        var expected = -1.6346 * Math.Pow(p, 5) + 14.341 * Math.Pow(p, 4) - 50.259 * Math.Pow(p, 3) + 88.977 * p * p - 89.565 * p + 58.857;
        await Assert.That(Math.Abs(signal.Cn!.Value - expected)).IsLessThan(1e-9);
        await Assert.That(signal.Cn!.Value is > 20.0 and < 21.5).IsTrue();
        // 3000 未満なら値は無い。ロックしていなければ読まない
        bus[0x11].Status[0xBC] = 0x0B;
        bus[0x11].Status[0xBD] = 0xB7;
        await Assert.That(frontend.Signal()!.Cn).IsNull();
        bus[0x11].Status[0xC3] = 0x10;
        bus.Log.Clear();
        await Assert.That(frontend.Signal()!.Locked).IsFalse();
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 C3?" }, CollectionOrdering.Matching);
    }

    [Test]
    public async Task TMCC_の_TSID_の一覧は読む前とあとにロックを確かめる()
    {
        var (frontend, bus, _) = Satellite();
        await Assert.That(frontend.SatelliteStreams()).IsNull();
        frontend.Tune(ChannelTable.Parse("BS15:16625")!);
        var demod = bus[0x11];
        byte[] tmcc = [0x40, 0xF0, 0x40, 0xF1, 0x40, 0xF2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        for (var i = 0; i < tmcc.Length; i++) demod.Status[(byte)(0xCE + i)] = tmcc[i];
        bus.Log.Clear();
        await Assert.That(frontend.SatelliteStreams()!).IsEquivalentTo(new ushort[] { 16624, 16625, 16626, 0, 0, 0, 0, 0 }, CollectionOrdering.Matching);
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "11 C3?", "11 CE?16", "11 C3?" }, CollectionOrdering.Matching);
        // 読んだあとにロックが外れていたら、一覧を返さない
        var reads = 0;
        demod.OnRead = (register, _) => register == 0xC3 ? (byte)(++reads == 2 ? 0x10 : 0x00) : null;
        await Assert.That(frontend.SatelliteStreams()).IsNull();
    }

    [Test]
    public async Task tune_に出す行は_TMCC_と誤り率とチューナーに書いた値()
    {
        var (terrestrial, bus, _) = Terrestrial();
        await Assert.That(terrestrial.Notes()).IsEmpty();
        terrestrial.Tune(ChannelTable.Parse("T27")!);
        var demod = bus[0x10];
        // モード 3 (B0 の bit7〜6 = 2)、ガードインターバル 1/8 (bit5〜4 = 2)、部分受信あり (B2 の bit0)
        demod.Status[0xB0] = 0xA8;
        demod.Status[0xB2] = 0x01;
        // A 階層: 誤り 0x000010、パケット 0x0100。B 階層: 誤り 0、パケット 0x0200。C 階層はパケット 0
        demod.Status[0x9F] = 0x10;
        demod.Status[0xA6] = 0x01;
        demod.Status[0xA8] = 0x02;
        var notes = terrestrial.Notes();
        await Assert.That(notes[0]).IsEqualTo("TMCC  モード 3  ガードインターバル 1/8  部分受信 あり");
        await Assert.That(notes[1]).IsEqualTo("誤り率 (未確認の値)  A 3.83E-05  B 0  C -");
        await Assert.That(notes[2]).IsEqualTo($"R850  種類 0 (00 = 0x00)  水晶の駆動の強さ 3  M 8  N 92  S 2E16  08〜2F {R850Ch27}  2F 42");

        var (satellite, other, _) = Satellite();
        satellite.Tune(ChannelTable.Parse("BS15:16625")!);
        // 高階層: 誤り 0x000100、パケット 0x1000。RT710 の 01 は利得の番号 5 (表は 74)。1318000 kHz の基準は 170
        other[0x11].Status[0xEC] = 0x01;
        other[0x11].Status[0xEE] = 0x10;
        other[0x11].Tuners[Rt710.Address].Status[0x01] = 0x50;
        var lines = satellite.Notes();
        await Assert.That(lines[0]).IsEqualTo("誤り率 (未確認の値)  高階層 3.83E-05  低階層 -");
        await Assert.That(lines[1]).IsEqualTo("RT710 (03 = 0x00)  入力のレベル -24400 (単位は 0.001 dBm と推定)");
    }
}
