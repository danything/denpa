namespace Denpa.Agent.Tests;

/*
 * 復調器 CXD2856ER とチューナー CXD2858ER の ISDB-C (ケーブルテレビのトランスモジュレーション方式) と、ほかの方式との切り替え (Cxd2856.cs・Cxd2858.cs)。
 * 偽のバス (Cxd2856Fakes.cs) の上で、書く順番と値を仕様書 (denpa-spec の cxd2856/spec.md) の表と照らす。添えた番号は仕様書の節。
 * 読んでから書く行 (マスクが FF でない行) は、読み (T C4?) のあとに書いた値が並ぶ。偽物のレジスタは書くまで 0。
 * ロックの状態は J.83B と同じレジスタ (バンク 40 の 88 と 10) なので、偽物の CableStatus・CableTs で決める
 */
public class Cxd2856IsdbcTests
{
    private const byte Demod = 0x65;

    /// <summary>C51 の中心周波数 (仕様書 8.2 の 225000 + 6000 × 28 = 393000 kHz = 0x5FF28)</summary>
    private const uint C51 = 393000;

    /// <summary>H40 の中心周波数 (J.83B。仕様書 7.1)</summary>
    private const uint H40 = 346750;

    /// <summary>BS15 の IF (仕様書 6.1)</summary>
    private const uint Bs15 = 1318000;

    private static (Cxd2856Frontend Frontend, FakeCxdBus Bus, FakeClock Clock) Make(Action<FakeCxdReceiver>? setup = null)
    {
        var bus = new FakeCxdBus(Demod);
        setup?.Invoke(bus[Demod]);
        var clock = new FakeClock();
        var frontend = new Cxd2856Frontend(bus, new Lock(), Demod, clock.Sleep, () => clock.Now, new());
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        return (frontend, bus, clock);
    }

    /// <summary>中継を開けてから閉じるまでの行 (最初の区切り)</summary>
    private static List<string> Relayed(List<string> log)
    {
        var start = log.IndexOf("X 08=01");
        var end = log.IndexOf("X 08=00", start);
        return log.GetRange(start + 1, end - start - 1);
    }

    /// <summary>ISDB-C の周波数の設定 (仕様書 4.6。C51)。J.83B (4.5) と違うのは 6E = 1A と 6F = 1C だけ</summary>
    private static readonly string[] IsdbcTunerLog =
    [
        "U 01=00", "U 74=02", "U 87=C440", "U 91=1626", "U 9C=0000", "U 5E=EE021E67101C78081C", "U 67?", "U 67=00",
        // 中心周波数 393000 kHz = 0x5FF28 の下位 8 ビット、次の 8 ビット、上位 4 ビット
        "U 68=0084000221001A1C28FF05FF01D90F2487", "U 88=00", "U 87=C0",
    ];

    /// <summary>J.83B の周波数の設定 (仕様書 4.5。H40)</summary>
    private static readonly string[] J83bTunerLog =
    [
        "U 01=00", "U 74=02", "U 87=C440", "U 91=1626", "U 9C=0000", "U 5E=EE021E67101C78081C", "U 67?", "U 67=00",
        "U 68=0084000221001B027E4A05FF01D90F2487", "U 88=00", "U 87=C0",
    ];

    /// <summary>選局を終える 3 行 (仕様書 2.3) と、ロックの判定 (仕様書 8.6。バンク 40 の 88 と 10)</summary>
    private static readonly string[] FinishAndLockLog = ["T 00=00", "T FE=01", "T C3=00", "T 00=40", "T 88?", "T 10?"];

    /// <summary>C51 の最初の選局 (スリープから。仕様書 8.4)</summary>
    private static readonly string[] FirstTuneLog =
    [
        // 仕様書 8.3 の手順 1〜2 (TSMF の処理をしない。TS クロックの設定より前)
        "T 00=49", "T 36?", "T 36=00",
        // 仕様書 3.3 (ISDB-C。D3 は隙間を入れない 01、33 は高い 00)。C4 は 3.2 で 80 にしてある
        "T 00=00", "T C4?", "T D3?", "T D3=01", "T DE?", "T DE=00", "T DA?", "T DA=00", "T C4?", "T C4=80", "T D1?", "T D1=02", "T D9=10",
        "T 32?", "T 32=00", "T 33?", "T 33=00", "T 32?", "T 32=01", "T 00=10", "T 66?", "T 66=01", "T 00=40", "T 66?", "T 66=01",
        // 仕様書 8.3 の手順 4〜30
        "X 00=00", "X 17=09", "T 00=00", "T A9=00", "T 2C=01", "T 4B=74", "T 49=00", "X 18=00", "T 00=11", "T 6A=48", "T 00=10", "T A5=01",
        "T 00=11", "T 33=00033B", "T 00=48", "T 2C=03", "T 00=00", "T CE=0101",
        "T 00=10", "T A6=31A8299B279C289E29A429A229A8", "T B6=13BBBC", "T 00=11", "T A3=14",
        "T 00=40", "T 14=14", "T 1E=80", "T 26=07080708",
        // 仕様書 8.3 の手順 31〜32
        "T 00=00", "T 80?", "T 80=08",
        // 仕様書 5.5 (出力にする)
        "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=00",
        // 仕様書 4.6 (中継の中で)
        "X 08=01", .. IsdbcTunerLog, "X 08=00",
        .. FinishAndLockLog,
    ];

    [Test]
    public async Task ISDB_C_の最初の選局は仕様書の表の順に書き周波数を埋める()
    {
        var (frontend, bus, clock) = Make();
        var tuning = ChannelTable.Parse("QC51")!;
        await Assert.That(frontend.TuneIsdbc(It930xTuner.Khz(tuning.Frequency))).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(FirstTuneLog);
        // 仕様書 4.6 の手順 8 のあと 50 ms。ISDB-C はロックのあとに待ち足さない (仕様書 8.6)
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 50 });
        await Assert.That(frontend.LockMs).IsEqualTo(0);
    }

    [Test]
    [Arguments("QV1", "U 68=0084000221001A1C486B01FF01D90F2487")]    // 93000 kHz = 0x16B48
    [Arguments("QC22", "U 68=0084000221001A1C588C02FF01D90F2487")]   // 167000 kHz = 0x28C58
    [Arguments("QU20", "U 68=0084000221001A1CB8DB07FF01D90F2487")]   // 515000 kHz = 0x7DBB8
    [Arguments("QU62", "U 68=0084000221001A1C18B40BFF01D90F2487")]   // 767000 kHz = 0xBB418
    public async Task チューナーには中心周波数の_kHz_を下位から_20_ビットで書く(string name, string row)
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(It930xTuner.Khz(ChannelTable.Parse(name)!.Frequency));
        await Assert.That(Relayed(bus.Log)[8]).IsEqualTo(row);
    }

    [Test]
    public async Task ISDB_C_のまま選局し直すときは_TS_を止める_2_行だけを書き_起動しない()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(C51);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbc(C51)).IsTrue();
        // 仕様書 8.4: T 00 ← 00、C3 ← 01 だけ (帯域も IF も TSMF の設定も書き直さない) → チューナー (地上波側のままなので止めない。仕様書 10.2)
        string[] expected = ["T 00=00", "T C3=01", "X 08=01", .. IsdbcTunerLog, "X 08=00", .. FinishAndLockLog];
        await Assert.That(bus.Log).IsEquivalentTo(expected);
    }

    [Test]
    public async Task ロックしなければ_1_秒で時間切れにする()
    {
        var (frontend, _, clock) = Make(demod => demod.CableStatus = _ => 0x00);
        await Assert.That(frontend.TuneIsdbc(C51)).IsFalse();
        // 50 ms (仕様書 4.6) のあと、10 ms ごとに 1 秒まで (仕様書 8.6・11)
        await Assert.That(clock.Sleeps.Skip(1).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
        await Assert.That(clock.Sleeps.Skip(1).Sum()).IsEqualTo(Cxd2856Frontend.IsdbcLockTimeoutMs);
        await Assert.That(Cxd2856Frontend.IsdbcLockTimeoutMs).IsEqualTo(1000);
        await Assert.That(frontend.LockMs).IsEqualTo(-1);
    }

    [Test]
    public async Task 復調だけのロックでは_TS_がロックするまで待ち_途中でロックしたらそこで返す()
    {
        // 88 の bit0 (復調のロック) と 10 の bit5 (TS のロック) がどちらも立ってロック (仕様書 8.6)。bit1 (信号が無いと分かった) は使わない
        var (frontend, _, clock) = Make(demod =>
        {
            demod.CableStatus = _ => 0x03;
            demod.CableTs = 0x00;
        });
        await Assert.That(frontend.TuneIsdbc(C51)).IsFalse();
        await Assert.That(clock.Sleeps.Skip(1).Sum()).IsEqualTo(Cxd2856Frontend.IsdbcLockTimeoutMs);

        var (later, _, _) = Make(demod => demod.CableStatus = read => read > 19 ? (byte)0x01 : (byte)0x00);
        await Assert.That(later.TuneIsdbc(C51)).IsTrue();
        await Assert.That(later.LockMs).IsEqualTo(190);
    }

    [Test]
    public async Task 周波数が_20_ビットを超えたら何も書かずに断る()
    {
        var (frontend, bus, _) = Make();
        Assert.Throws<IOException>(() => frontend.TuneIsdbc(Cxd2858.MaxTerrestrialKhz + 1));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task ISDB_C_のスリープはチューナーを止めてから仕様書の_8_5_の順に書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(C51);
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 4.7 の地上波側の停止 (中継の中で)
            "X 08=01", "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0", "X 08=00",
            // 仕様書 8.5 の手順 1〜3
            "T 00=00", "T C3=01", "T 80?", "T 80=1F",
            // 5.5 (高インピーダンス)
            "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=01",
            // 8.5 の手順 5〜11 (バンク 49 の 36 は戻さない)
            "T 00=11", "T A3=00", "T 00=48", "T 2C=01", "T 00=40", "T 14=1F", "T 1E=00",
            // 2.4 の共通の後始末
            "X 00=00", "X 18=01", "T 00=00", "T 49=33", "T 4B=21", "T FE=01", "T 2C=00", "T A9=00", "X 17=01",
        });
        // スリープからの選局は起動からやり直す
        bus.Log.Clear();
        frontend.TuneIsdbc(C51);
        await Assert.That(bus.Log).IsEquivalentTo(FirstTuneLog);
    }

    [Test]
    public async Task 地上波から_ISDB_C_へは_ISDB_T_のスリープから起動し_チューナーは止めずに書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbc(C51)).IsTrue();
        var log = bus.Log;
        // ISDB-T のスリープ (仕様書 5.7。最後は 2.4 の X 17 ← 01) → ISDB-C の起動 (8.3 は TSMF の設定から) (仕様書 10.1)
        var sleep = log.IndexOf("T 38=0102");
        var sleptAt = log.IndexOf("X 17=01");
        await Assert.That(sleep).IsGreaterThan(0);
        await Assert.That(sleptAt).IsGreaterThan(sleep);
        await Assert.That(log.Skip(sleptAt + 1)).IsEquivalentTo(FirstTuneLog);
    }

    [Test]
    public async Task 衛星から_ISDB_C_へはチューナーの衛星側を止めてから書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, new CxdStream(16625));
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbc(C51)).IsTrue();
        var log = bus.Log;
        // ISDB-S のスリープ (仕様書 6.5) → ISDB-C の起動 (仕様書 10.1)
        await Assert.That(log.IndexOf("X 17=09")).IsGreaterThan(log.IndexOf("X 28=13"));
        await Assert.That(log.IndexOf("T 00=49")).IsGreaterThan(log.IndexOf("X 28=13"));
        // 衛星側の停止 (仕様書 4.7) → ISDB-C の周波数 (仕様書 4.6・10.2)
        await Assert.That(Relayed(log)).IsEquivalentTo(new[] { "U 15=02", "U 43=07", "U 0C=140000", "U 01=00", "U 05=00", "U 04=C0" }.Concat(IsdbcTunerLog));
    }

    [Test]
    public async Task J83B_から_ISDB_C_へは_J83B_のスリープから起動し_チューナーは止めずに書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneJ83b(H40);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbc(C51)).IsTrue();
        var log = bus.Log;
        // J.83B のスリープ (仕様書 7.4 と 2.4) → ISDB-C の起動 (仕様書 10.1)
        var sleep = log.IndexOf("T 26=099A00EE");
        var sleptAt = log.IndexOf("X 17=01");
        await Assert.That(sleep).IsGreaterThanOrEqualTo(0);
        await Assert.That(sleptAt).IsGreaterThan(sleep);
        await Assert.That(log.Skip(sleptAt + 1)).IsEquivalentTo(FirstTuneLog);
    }

    [Test]
    public async Task ISDB_C_から_J83B_へは_ISDB_C_のスリープから起動し_チューナーは止めずに書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(C51);
        bus.Log.Clear();
        await Assert.That(frontend.TuneJ83b(H40)).IsTrue();
        var log = bus.Log;
        // ISDB-C のスリープ (仕様書 8.5。バンク 48 の 2C を戻すのは ISDB-C だけ) → 2.4 → J.83B の起動 (仕様書 10.1)
        await Assert.That(log.Take(2)).IsEquivalentTo(new[] { "T 00=00", "T C3=01" });
        var sleep = log.IndexOf("T 00=48");
        var sleptAt = log.IndexOf("X 17=01");
        var start = log.IndexOf("X 17=08");
        await Assert.That(sleep).IsGreaterThan(0);
        await Assert.That(sleptAt).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(sleptAt);
        // J.83B の起動は TSMF の設定 (バンク 49) を書かない
        await Assert.That(log).DoesNotContain("T 00=49");
        // チューナーは地上波側のまま、J.83B の周波数を全部書き直す (仕様書 10.2)
        await Assert.That(Relayed(log)).IsEquivalentTo(J83bTunerLog);
    }

    [Test]
    public async Task ISDB_C_から衛星と地上波へは_ISDB_C_のスリープから起動し直す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(C51);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbs(Bs15, new CxdStream(16625))).IsTrue();
        var log = bus.Log;
        // TS を選ぶ (仕様書 6.3) → ISDB-C のスリープ (仕様書 8.5 と 2.4) → ISDB-S の起動 (仕様書 10.1)
        await Assert.That(log.Take(2)).IsEquivalentTo(new[] { "T 00=C0", "T E9=40F100" });
        var sleep = log.IndexOf("T 00=48");
        var common = log.IndexOf("T 49=33");
        await Assert.That(sleep).IsGreaterThan(1);
        await Assert.That(common).IsGreaterThan(sleep);
        await Assert.That(log.IndexOf("X 17=0C")).IsGreaterThan(common);
        // チューナーは地上波側を止めてから衛星の周波数 (仕様書 4.7・10.2)
        await Assert.That(Relayed(log).Take(6)).IsEquivalentTo(new[] { "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0" });

        var (other, otherBus, _) = Make();
        other.TuneIsdbc(C51);
        otherBus.Log.Clear();
        await Assert.That(other.TuneIsdbt(557143)).IsTrue();
        await Assert.That(otherBus.Log.IndexOf("X 17=06")).IsGreaterThan(otherBus.Log.IndexOf("T 00=48"));
        await Assert.That(otherBus.Log.IndexOf("T 00=48")).IsGreaterThan(0);
    }

    [Test]
    public async Task ISDB_C_の起動が途中で終わったら次の選局は_ISDB_C_のスリープからやり直す()
    {
        var (frontend, bus, _) = Make();
        string? failAt = "T 2C=03";
        bus.OnWrite = () =>
        {
            if (failAt is not null && bus.Log[^1] == failAt) throw new IOException("I2C の失敗 (テスト)");
        };
        Assert.Throws<IOException>(() => frontend.TuneIsdbc(C51));

        // スリープが途中で失敗したら、ほかの方式の起動を始めない (仕様書 8.5・10.1)
        failAt = "T 14=1F";
        bus.Log.Clear();
        Assert.Throws<IOException>(() => frontend.TuneIsdbt(557143));
        await Assert.That(bus.Log).DoesNotContain("X 10=01");
        await Assert.That(bus.Log).DoesNotContain("X 17=06");

        // 次の選局も ISDB-C のスリープから。済んだら初期化して ISDB-T を起動する
        failAt = null;
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        var log = bus.Log;
        var sleep = log.IndexOf("T 14=1F");
        var init = log.IndexOf("X 10=01");
        var start = log.IndexOf("X 17=06");
        await Assert.That(sleep).IsGreaterThanOrEqualTo(0);
        await Assert.That(init).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(init);
    }

    [Test]
    public async Task ISDB_C_の信号品質は固めて変調と_C_N_を読み_PER_とほかの値は固めずに読む()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbc(C51);
        var demod = bus[Demod];
        // 変調 2 (64QAM)、bit7 は反転を見つけた。r = 0x0408 = 1032 (b0 の上位 3 ビットは使わない)
        demod.T[(0x40, 0x19)] = 0x82;
        demod.T[(0x40, 0x4C)] = 0xE4;
        demod.T[(0x40, 0x4D)] = 0x08;
        // 搬送波のずれ: 14 ビットの 2 の補数で 0x3FF0 = -16 (上位 2 ビットは使わない)
        demod.T[(0x40, 0x15)] = 0xFF;
        demod.T[(0x40, 0x16)] = 0xF0;
        // シンボルレート: t = 0x708 = 1800 (上位 4 ビットは使わない)、i = 0x00800000、d = 0 → 1800.5
        demod.T[(0x40, 0x1A)] = 0xF7;
        demod.T[(0x40, 0x1B)] = 0x08;
        demod.T[(0x40, 0x9C)] = 0x80;
        // PER: n = 10 (1024 パケット)、b1 の bit2 が 1 (値がある)、e = 2
        demod.T[(0x40, 0x5C)] = 0x0A;
        demod.T[(0x40, 0x5D)] = 0x04;
        demod.T[(0x40, 0x5F)] = 0x02;
        // RS の前の BER: 60 の下位 5 ビットが n = 11、62 の bit7 が 1 (値がある)、e = 0x10
        demod.T[(0x40, 0x60)] = 0xEB;
        demod.T[(0x40, 0x62)] = 0x80;
        demod.T[(0x40, 0x64)] = 0x10;
        // 直せなかったパケット: EC の bit0 が 1 (値がある)、EA〜EB が 5
        demod.T[(0x40, 0xEB)] = 0x05;
        demod.T[(0x40, 0xEC)] = 0x01;
        // IF の AGC: 12 ビットで 0x123
        demod.T[(0x40, 0x49)] = 0xF1;
        demod.T[(0x40, 0x4A)] = 0x23;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 9.4 と 9.5 の「ロックが前提」の値 (固めて読む。仕様書 2.3)
            "T 01=01", "T 00=40", "T 88?", "T 10?", "T 19?", "T 4C?", "T 15?", "T 1A?", "T 9B?", "T 01=00",
            // 固めずに読む値 (PER、RS の前の BER、直せなかったパケットの数、IF の AGC)
            "T 5C?", "T 60?", "T 62?", "T EA?", "T 49?",
            // 仕様書 9.7 の地上波・J.83B・ISDB-C (チューナーから読む)
            "X 08=01", "U 87=C441", "U 59=0501", "U 5B?", "U 59=0301", "U 5B?", "U 59=04", "U 88=00", "U 87=C0", "U 69?", "X 08=00",
        });
        await Assert.That(signal.Locked).IsTrue();
        await Assert.That(signal.Cn).IsEqualTo(-9.5 * Math.Log(1032) + 95.941);
        // ISDB-C の補正は J.83B と同じ -1.5 dB (仕様書 9.7)
        await Assert.That(signal.StrengthDbm).IsEqualTo(Cxd2858.InputLevel(0, 0, 4, C51, -150) / 100.0);
        await Assert.That(frontend.CableModulation).IsEqualTo("64QAM");
        await Assert.That(frontend.CablePer).IsEqualTo(2 / 1024.0);
        var detail = frontend.IsdbcDetail!;
        await Assert.That(detail.Inverted).IsEqualTo(true);
        await Assert.That(detail.CarrierOffsetKhz).IsEqualTo(-16 * 48000.0 / 16384);
        await Assert.That(detail.SymbolRateMsps).IsEqualTo(1800.5 * 48 / 16384);
        await Assert.That(detail.PreRsBer).IsEqualTo(16 / (2048.0 * 204 * 8));
        await Assert.That(detail.Uncorrected).IsEqualTo(5);
        await Assert.That(detail.IfAgc).IsEqualTo(0x123);

        // 自動の探索がロックしていなければ、変調と C/N と「ロックが前提」の値は読まない。固めずに読む値は読む
        demod.CableStatus = _ => 0x00;
        bus.Log.Clear();
        signal = frontend.Signal()!;
        await Assert.That(bus.Log.Take(10)).IsEquivalentTo(new[] { "T 01=01", "T 00=40", "T 88?", "T 10?", "T 01=00", "T 5C?", "T 60?", "T 62?", "T EA?", "T 49?" });
        await Assert.That(signal.Locked).IsFalse();
        await Assert.That(signal.Cn).IsNull();
        await Assert.That(frontend.CableModulation).IsNull();
        await Assert.That(frontend.IsdbcDetail!.Inverted).IsNull();
        await Assert.That(frontend.IsdbcDetail!.SymbolRateMsps).IsNull();
        await Assert.That(frontend.IsdbcDetail!.Uncorrected).IsEqualTo(5);
    }

    [Test]
    public async Task ISDB_C_の_C_N_は_64QAM_と_256QAM_だけで求め_値の印が無い読みは出さない()
    {
        // ISDB-C では変調 2 (64QAM) と 4 (256QAM) だけを使い、ほかは誤りとして C/N を返さない (仕様書 9.4)
        await Assert.That(Cxd2856.IsdbcCnDb(4, 0)).IsEqualTo(-9.5 * Math.Log(126) + 95.941);
        await Assert.That(Cxd2856.IsdbcCnDb(2, 2000)).IsEqualTo(-9.5 * Math.Log(2000) + 95.941);
        await Assert.That(Cxd2856.IsdbcCnDb(3, 500)).IsNull();
        await Assert.That(Cxd2856.IsdbcCnDb(1, 500)).IsNull();
        // 62 の bit7 が 0 なら BER は無い。EC の bit0 が 0 なら直せなかったパケットの数は無い (仕様書 9.5)
        var none = Cxd2856.IsdbcDetail(new CxdIsdbcSignal(0x01, 0x20, 2, 500, null, null, 0x0B, [0x00, 0x00, 0x10], [0x00, 0x05, 0x00], 0));
        await Assert.That(none.PreRsBer).IsNull();
        await Assert.That(none.Uncorrected).IsNull();
        // 搬送波のずれは正の値も、シンボルレートの端数は負の値と d も読む (i は 32 ビットの 2 の補数、d は 9F の下位 2 ビット)
        var read = Cxd2856.IsdbcDetail(new CxdIsdbcSignal(0x01, 0x20, 4, 500, null,
            [0x04, 0x00, 0x10, 0x07, 0x08, 0xFF, 0x00, 0x00, 0x00, 0x01], 0x0B, null, null, 0));
        await Assert.That(read.Inverted).IsEqualTo(false);
        await Assert.That(read.CarrierOffsetKhz).IsEqualTo(16 * 48000.0 / 16384);
        await Assert.That(read.SymbolRateMsps).IsEqualTo((1800 - 16777216 / Math.Pow(2, 25)) * 48 / 16384);
    }
}
