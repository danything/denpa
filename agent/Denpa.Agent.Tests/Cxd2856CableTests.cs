namespace Denpa.Agent.Tests;

/*
 * 復調器 CXD2856ER とチューナー CXD2858ER の J.83B (スカパー！プレミアムサービス光) と、ほかの方式との切り替え、
 * 待機中の地上波の RF 入力の整合を保つ設定 (Cxd2856.cs・Cxd2858.cs)。
 * 偽のバス (Cxd2856Fakes.cs) の上で、書く順番と値を仕様書 (denpa-spec の cxd2856/spec.md) の表と照らす。添えた番号は仕様書の節。
 * 読んでから書く行 (マスクが FF でない行) は、読み (T C4?) のあとに書いた値が並ぶ。偽物のレジスタは書くまで 0
 */
public class Cxd2856CableTests
{
    private const byte Demod = 0x65;

    /// <summary>H40 の中心周波数 (仕様書 7.1 の 93250 + 6500 × 39 = 346750 kHz = 0x54A7E)</summary>
    private const uint H40 = 346750;

    /// <summary>BS15 の IF (仕様書 6.1)</summary>
    private const uint Bs15 = 1318000;

    private static (Cxd2856Frontend Frontend, FakeCxdBus Bus, FakeClock Clock) Make(Action<FakeCxdReceiver>? setup = null)
    {
        var bus = new FakeCxdBus(Demod);
        setup?.Invoke(bus[Demod]);
        var clock = new FakeClock();
        var frontend = new Cxd2856Frontend(bus, new Lock(), Demod, clock.Sleep, () => clock.Now);
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        return (frontend, bus, clock);
    }

    /// <summary>中継を開けてから閉じるまでの行 (<paramref name="nth"/> 番目の区切り)</summary>
    private static List<string> Relayed(List<string> log, int nth = 0)
    {
        var start = -1;
        for (var i = 0; i <= nth; i++) start = log.IndexOf("X 08=01", start + 1);
        var end = log.IndexOf("X 08=00", start);
        return log.GetRange(start + 1, end - start - 1);
    }

    /// <summary>J.83B の周波数の設定 (仕様書 4.5。H40)。67 は整合を保つ設定でなければ 00 のまま</summary>
    private static readonly string[] CableTunerLog =
    [
        "U 01=00", "U 74=02", "U 87=C440", "U 91=1626", "U 9C=0000", "U 5E=EE021E67101C78081C", "U 67?", "U 67=00",
        // 中心周波数 346750 kHz = 0x54A7E の下位 8 ビット、次の 8 ビット、上位 4 ビット
        "U 68=0084000221001B027E4A05FF01D90F2487", "U 88=00", "U 87=C0",
    ];

    /// <summary>H40 の最初の選局 (スリープから。仕様書 7.4)</summary>
    private static readonly string[] FirstTuneLog =
    [
        // 仕様書 3.3 (J.83B。D3 は隙間を入れる 00、33 は高い 00)。C4 は 3.2 で 80 にしてある
        "T 00=00", "T C4?", "T D3?", "T D3=00", "T DE?", "T DE=00", "T DA?", "T DA=00", "T C4?", "T C4=80", "T D1?", "T D1=02", "T D9=10",
        "T 32?", "T 32=00", "T 33?", "T 33=00", "T 32?", "T 32=01", "T 00=10", "T 66?", "T 66=01", "T 00=40", "T 66?", "T 66=01",
        // 仕様書 7.2 の手順 1〜26
        "X 00=00", "X 17=08", "T 00=00", "T A9=00", "T 2C=01", "T 4B=74", "T 49=00", "X 18=00", "T 00=11", "T 6A=48", "T 00=10", "T A5=01",
        "T 00=40", "T 21=04", "T B3=05", "T 1E=80", "T 8E=58", "T 00=41", "T CF=99", "T 00=11", "T A3=14", "T 33=00033B",
        "T 00=00", "T CE=0101", "T 00=10", "T A6=31A8299B279C289E29A429A229A8",
        // 仕様書 7.3 (帯域の設定)
        "T 00=10", "T B6=140000", "T 00=40", "T 14=10", "T 26=07770777",
        // 仕様書 7.2 の手順 28〜29
        "T 00=00", "T 80?", "T 80=08",
        // 仕様書 5.5 (出力にする)
        "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=00",
        // 仕様書 4.5 (中継の中で)
        "X 08=01", .. CableTunerLog, "X 08=00",
        // 仕様書 2.3
        "T 00=00", "T FE=01", "T C3=00",
        // 仕様書 7.5 のロックの判定 (バンク 40 の 88 と 10)
        "T 00=40", "T 88?", "T 10?",
    ];

    [Test]
    public async Task J83B_の最初の選局は仕様書の表の順に書き周波数を埋める()
    {
        var (frontend, bus, clock) = Make();
        var tuning = ChannelTable.Parse("H40")!;
        await Assert.That(frontend.TuneJ83b(It930xTuner.Khz(tuning.Frequency))).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(FirstTuneLog);
        // 仕様書 4.5 の手順 8 のあと 50 ms。J.83B はロックのあとに待ち足さない (仕様書 5.6 は ISDB-T だけ)
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 50 });
        await Assert.That(frontend.LockMs).IsEqualTo(0);
    }

    [Test]
    public async Task J83B_のまま選局し直すときは止めて帯域を書き直し_起動しない()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneJ83b(H40);
        bus.Log.Clear();
        await Assert.That(frontend.TuneJ83b(H40 + 6500)).IsTrue();
        // 仕様書 7.4: T 00 ← 00、C3 ← 01、7.3 の帯域の設定 → チューナー (地上波側のままなので止めない。仕様書 10.2)
        await Assert.That(bus.Log.Take(8)).IsEquivalentTo(new[]
        {
            "T 00=00", "T C3=01", "T 00=10", "T B6=140000", "T 00=40", "T 14=10", "T 26=07770777", "X 08=01",
        });
        await Assert.That(bus.Log).DoesNotContain("X 17=08");
        await Assert.That(Relayed(bus.Log)[0]).IsEqualTo("U 01=00");
        await Assert.That(Relayed(bus.Log)).DoesNotContain("U 5E=150000");
    }

    [Test]
    public async Task ロックしなければ_1_秒で時間切れにする()
    {
        var (frontend, _, clock) = Make(demod => demod.CableStatus = _ => 0x00);
        await Assert.That(frontend.TuneJ83b(H40)).IsFalse();
        // 50 ms (仕様書 4.5) のあと、10 ms ごとに 1 秒まで (仕様書 7.5・11)
        await Assert.That(clock.Sleeps.Skip(1).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
        await Assert.That(clock.Sleeps.Skip(1).Sum()).IsEqualTo(Cxd2856Frontend.J83bLockTimeoutMs);
        await Assert.That(frontend.LockMs).IsEqualTo(-1);
    }

    [Test]
    public async Task 復調だけのロックでは_TS_がロックするまで待つ()
    {
        // 88 の bit0 (復調のロック) と 10 の bit5 (TS のロック) がどちらも立ってロック (仕様書 7.5)。bit1 (ロックしないと分かった) は使わない
        var (frontend, _, clock) = Make(demod =>
        {
            demod.CableStatus = _ => 0x03;
            demod.CableTs = 0x00;
        });
        await Assert.That(frontend.TuneJ83b(H40)).IsFalse();
        await Assert.That(clock.Sleeps.Skip(1).Sum()).IsEqualTo(Cxd2856Frontend.J83bLockTimeoutMs);
    }

    [Test]
    public async Task 途中でロックしたらそこで返す()
    {
        var (frontend, _, _) = Make(demod => demod.CableStatus = read => read > 25 ? (byte)0x01 : (byte)0x00);
        await Assert.That(frontend.TuneJ83b(H40)).IsTrue();
        await Assert.That(frontend.LockMs).IsEqualTo(250);
    }

    [Test]
    public async Task 周波数が_20_ビットを超えたら何も書かずに断る()
    {
        var (frontend, bus, _) = Make();
        Assert.Throws<IOException>(() => frontend.TuneJ83b(Cxd2858.MaxTerrestrialKhz + 1));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 地上波から_J83B_へは_ISDB_T_のスリープから起動し_チューナーは止めずに書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        await Assert.That(frontend.TuneJ83b(H40)).IsTrue();
        var log = bus.Log;
        // ISDB-T のスリープ (仕様書 5.7。最後は 2.4 の X 17 ← 01) → J.83B の起動 (3.3・7.2) (仕様書 10.1)
        var sleep = log.IndexOf("T 38=0102");
        var sleptAt = log.IndexOf("X 17=01");
        var start = log.IndexOf("X 17=08");
        await Assert.That(sleep).IsGreaterThan(0);
        await Assert.That(sleptAt).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(sleptAt);
        await Assert.That(log).Contains("T D3=00");
        // チューナーは地上波側のまま、J.83B の周波数を全部書き直す (仕様書 10.2)
        await Assert.That(Relayed(log)).IsEquivalentTo(CableTunerLog);
    }

    [Test]
    public async Task 衛星から_J83B_へはチューナーの衛星側を止めてから書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, new CxdStream(16625));
        bus.Log.Clear();
        await Assert.That(frontend.TuneJ83b(H40)).IsTrue();
        var log = bus.Log;
        // ISDB-S のスリープ (仕様書 6.5) → J.83B の起動 (仕様書 10.1)
        await Assert.That(log.IndexOf("X 17=08")).IsGreaterThan(log.IndexOf("X 28=13"));
        // 衛星側の停止 (仕様書 4.7) → J.83B の周波数 (仕様書 4.5・10.2)
        await Assert.That(Relayed(log)).IsEquivalentTo(new[] { "U 15=02", "U 43=07", "U 0C=140000", "U 01=00", "U 05=00", "U 04=C0" }.Concat(CableTunerLog));
    }

    [Test]
    public async Task J83B_から衛星へは_TS_を選び_J83B_のスリープから起動し直す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneJ83b(H40);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbs(Bs15, new CxdStream(16625))).IsTrue();
        var log = bus.Log;
        // TS を選ぶ (仕様書 6.3) → J.83B のスリープ (仕様書 7.4 と 2.4) → ISDB-S の起動 (仕様書 10.1)
        await Assert.That(log.Take(2)).IsEquivalentTo(new[] { "T 00=C0", "T E9=40F100" });
        var sleep = log.IndexOf("T 26=099A00EE");
        var common = log.IndexOf("T 49=33");
        var start = log.IndexOf("X 17=0C");
        await Assert.That(sleep).IsGreaterThan(1);
        await Assert.That(common).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(common);
        // チューナーは地上波側を止めてから衛星の周波数 (仕様書 4.7・10.2)
        await Assert.That(Relayed(log).Take(6)).IsEquivalentTo(new[] { "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0" });
    }

    [Test]
    public async Task J83B_のスリープはチューナーを止めてから仕様書の_7_4_の順に書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneJ83b(H40);
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 4.7 の地上波側の停止 (中継の中で)
            "X 08=01", "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0", "X 08=00",
            // 仕様書 7.4 の手順 1〜3
            "T 00=00", "T C3=01", "T 80?", "T 80=1F",
            // 5.5 (高インピーダンス)
            "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=01",
            // 7.4 の手順 5〜17
            "T 00=11", "T A3=00", "T 00=40", "T 21=00", "T C3=00", "T B3=02", "T 1E=00", "T 8E=0E", "T 00=41", "T CF=77", "T 00=40", "T 14=1F", "T 26=099A00EE",
            // 2.4 の共通の後始末
            "X 00=00", "X 18=01", "T 00=00", "T 49=33", "T 4B=21", "T FE=01", "T 2C=00", "T A9=00", "X 17=01",
        });
        // スリープからの選局は起動からやり直す
        bus.Log.Clear();
        frontend.TuneJ83b(H40);
        await Assert.That(bus.Log).Contains("X 17=08");
    }

    [Test]
    public async Task J83B_の起動が途中で終わったら次の選局は_J83B_のスリープからやり直す()
    {
        var (frontend, bus, _) = Make();
        string? failAt = "T 21=04";
        bus.OnWrite = () =>
        {
            if (failAt is not null && bus.Log[^1] == failAt) throw new IOException("I2C の失敗 (テスト)");
        };
        Assert.Throws<IOException>(() => frontend.TuneJ83b(H40));

        // スリープが途中で失敗したら、ほかの方式の起動を始めない (仕様書 7.4・10.1)
        failAt = "T CF=77";
        bus.Log.Clear();
        Assert.Throws<IOException>(() => frontend.TuneIsdbt(557143));
        await Assert.That(bus.Log).DoesNotContain("X 10=01");
        await Assert.That(bus.Log).DoesNotContain("X 17=06");

        // 次の選局も J.83B のスリープから。済んだら初期化して ISDB-T を起動する
        failAt = null;
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        var log = bus.Log;
        var sleep = log.IndexOf("T 26=099A00EE");
        var init = log.IndexOf("X 10=01");
        var start = log.IndexOf("X 17=06");
        await Assert.That(sleep).IsGreaterThanOrEqualTo(0);
        await Assert.That(init).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(init);
    }

    [Test]
    public async Task J83B_の信号品質は値を固めて変調と_C_N_と_PER_を読み強度をチューナーから求める()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneJ83b(H40);
        var demod = bus[Demod];
        // 変調 4 (256QAM。上位 5 ビットは使わない)、r = 0x0408 = 1032 (b0 の上位 3 ビットは使わない)
        demod.T[(0x40, 0x19)] = 0xF4;
        demod.T[(0x40, 0x4C)] = 0xE4;
        demod.T[(0x40, 0x4D)] = 0x08;
        // PER: n = 10 (1024 パケット)、b1 の bit2 が 1 (値がある)、e = 2
        demod.T[(0x40, 0x5C)] = 0x0A;
        demod.T[(0x40, 0x5D)] = 0x04;
        demod.T[(0x40, 0x5E)] = 0x00;
        demod.T[(0x40, 0x5F)] = 0x02;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 9.4 (固めて読む。仕様書 2.3)
            "T 01=01", "T 00=40", "T 88?", "T 10?", "T 19?", "T 4C?", "T 5C?", "T 01=00",
            // 仕様書 9.7 の地上波・J.83B (チューナーから読む)
            "X 08=01", "U 87=C441", "U 59=0501", "U 5B?", "U 59=0301", "U 5B?", "U 59=04", "U 88=00", "U 87=C0", "U 69?", "X 08=00",
        });
        await Assert.That(signal.Locked).IsTrue();
        await Assert.That(signal.Cn).IsEqualTo(-9.5 * Math.Log(1032) + 95.941);
        await Assert.That(signal.Unit).IsEqualTo(TunerSignal.Db);
        // 偽物の AGC は 0、IF の帯域通過フィルタの利得の番号は選局で書いた 84 の下位 4 ビット。J.83B の補正は -1.5 dB (仕様書 9.7)
        await Assert.That(signal.StrengthDbm).IsEqualTo(Cxd2858.InputLevel(0, 0, 4, H40, -150) / 100.0);
        await Assert.That(frontend.CableModulation).IsEqualTo("256QAM");
        await Assert.That(frontend.CablePer).IsEqualTo(2 / 1024.0);

        // 自動の探索がロックしていなければ、変調と C/N と PER は読まない
        demod.CableStatus = _ => 0x00;
        bus.Log.Clear();
        signal = frontend.Signal()!;
        await Assert.That(bus.Log.Take(5)).IsEquivalentTo(new[] { "T 01=01", "T 00=40", "T 88?", "T 10?", "T 01=00" });
        await Assert.That(signal.Locked).IsFalse();
        await Assert.That(signal.Cn).IsNull();
        await Assert.That(frontend.CableModulation).IsNull();
        await Assert.That(frontend.CablePer).IsNull();
    }

    [Test]
    public async Task C_N_は変調ごとの式で_r_の下限をそろえて求める()
    {
        // 64QAM・256QAM は r を 126 以上に、32QAM・128QAM は 69 以上にする (仕様書 9.4 の手順 6・7)
        await Assert.That(Cxd2856.J83bCnDb(4, 0)).IsEqualTo(-9.5 * Math.Log(126) + 95.941);
        await Assert.That(Cxd2856.J83bCnDb(2, 100)).IsEqualTo(Cxd2856.J83bCnDb(2, 126));
        await Assert.That(Cxd2856.J83bCnDb(2, 2000)).IsEqualTo(-9.5 * Math.Log(2000) + 95.941);
        await Assert.That(Cxd2856.J83bCnDb(3, 50)).IsEqualTo(-8.8 * Math.Log(69) + 86.99);
        await Assert.That(Cxd2856.J83bCnDb(1, 500)).IsEqualTo(-8.8 * Math.Log(500) + 86.99);
        // 16QAM と表に無い値は、式が仕様書に無いので出さない
        await Assert.That(Cxd2856.J83bCnDb(0, 500)).IsNull();
        await Assert.That(Cxd2856.J83bCnDb(5, 500)).IsNull();
        await Assert.That(Cxd2856.J83bModulationName(2)).IsEqualTo("64QAM");
        await Assert.That(Cxd2856.J83bModulationName(7)).IsNull();
    }

    [Test]
    public async Task PER_は値の印が無いか壊れていれば出さない()
    {
        // b1 の bit2 が 0 なら値は無い (仕様書 9.4)
        await Assert.That(Cxd2856.J83bPer([0x0A, 0x00, 0x00, 0x02])).IsNull();
        // e = ((b1 & 0x03) << 16) | (b2 << 8) | b3。e > 2^n は壊れている
        await Assert.That(Cxd2856.J83bPer([0x02, 0x04, 0x00, 0x05])).IsNull();
        await Assert.That(Cxd2856.J83bPer([0x02, 0x04, 0x00, 0x04])).IsEqualTo(1.0);
        // n は b0 の下位 5 ビット (0xF4 → 20)、e は b1 の下位 2 ビットから 18 ビット
        await Assert.That(Cxd2856.J83bPer([0xF4, 0x07, 0x01, 0x00])).IsEqualTo(((3 << 16) | 0x100) / 1048576.0);
        await Assert.That(Cxd2856.J83bPer(null)).IsNull();
    }

    [Test]
    public async Task 整合を保つ設定は閉じている受信機を初期化し直し_待機にする書き込みで_67_の_bit1_を立てる()
    {
        var (frontend, bus, _) = Make();
        // 閉じている (スリープの) 受信機は、初期化し直して待機させる (仕様書 4.8)。初期化の手順 2 が 02 (仕様書 4.2)
        frontend.KeepMatching(standby: true);
        await Assert.That(frontend.KeepsMatching).IsTrue();
        await Assert.That(bus.Log.Take(2)).IsEquivalentTo(new[] { "X 00=00", "X 10=01" });
        // 中継を開けてすぐ、初期化の前に 62 を読む (仕様書 10.3)
        await Assert.That(Relayed(bus.Log).Take(3)).IsEquivalentTo(new[] { "U 62?", "U 01=00", "U 67=02" });

        // 選局では bit1 を 0 にし (仕様書 4.5 の手順 7)、止めるときに 02 に戻す (仕様書 4.7 の手順 2)
        bus.Log.Clear();
        frontend.TuneJ83b(H40);
        await Assert.That(Relayed(bus.Log)).Contains("U 67=00");
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(Relayed(bus.Log).Take(3)).IsEquivalentTo(new[] { "U 74=02", "U 67?", "U 67=02" });

        // 衛星を受ける前に、手順 1A で 67 の bit1 を 0 にする (仕様書 4.4。推定の手順)。地上波側の停止 (仕様書 4.7) で立てた bit1 を戻す
        bus.Log.Clear();
        frontend.TuneIsdbs(Bs15, new CxdStream(16625));
        await Assert.That(Relayed(bus.Log).Take(3)).IsEquivalentTo(new[] { "U 15=02", "U 67?", "U 67=00" });
        await Assert.That(Relayed(bus.Log)[3]).IsEqualTo("U 43=06");

        // 衛星側の停止のあとにも 67 の bit1 を立てる (仕様書 4.7)
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(Relayed(bus.Log)).IsEquivalentTo(new[] { "U 15=02", "U 43=07", "U 0C=140000", "U 01=00", "U 05=00", "U 04=C0", "U 67?", "U 67=02" });
    }

    [Test]
    public async Task 動作中の受信機は整合を保つ設定を立てるだけで_止めるときに書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        frontend.KeepMatching(standby: true);
        await Assert.That(bus.Log).IsEmpty();
        frontend.Sleep();
        await Assert.That(Relayed(bus.Log).Take(3)).IsEquivalentTo(new[] { "U 74=02", "U 67?", "U 67=02" });
        // 待機させない呼び方は、スリープでも書かない (これから選局する受信機)
        var (other, otherBus, _) = Make();
        other.KeepMatching(standby: false);
        await Assert.That(otherBus.Log).IsEmpty();
        await Assert.That(other.KeepsMatching).IsTrue();
    }
}
