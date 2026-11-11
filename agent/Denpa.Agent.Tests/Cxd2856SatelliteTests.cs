namespace Denpa.Agent.Tests;

/*
 * 復調器 CXD2856ER とチューナー CXD2858ER の衛星 (ISDB-S) と、地上波との切り替え (Cxd2856.cs・Cxd2858.cs)。
 * 偽のバス (Cxd2856Fakes.cs) の上で、書く順番と値を仕様書 (denpa-spec の cxd2856/spec.md) の表と照らす。添えた番号は仕様書の節。
 * 読んでから書く行 (マスクが FF でない行) は、読み (T C4?) のあとに書いた値が並ぶ。偽物のレジスタは書くまで 0
 */
public class Cxd2856SatelliteTests
{
    private const byte Demod = 0x65;

    /// <summary>BS15 の IF (仕様書 6.1 の 1049480 + 38360 × 7)</summary>
    private const uint Bs15 = 1318000;

    /// <summary>BS15:16625 の TSID (0x40F1)</summary>
    private static readonly CxdStream Tsid16625 = new(16625);

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

    /// <summary>中継を開けてから閉じるまでの行 (<paramref name="nth"/> 番目の区切り)</summary>
    private static List<string> Relayed(List<string> log, int nth = 0)
    {
        var start = -1;
        for (var i = 0; i <= nth; i++) start = log.IndexOf("X 08=01", start + 1);
        var end = log.IndexOf("X 08=00", start);
        return log.GetRange(start + 1, end - start - 1);
    }

    /// <summary>BS15:16625 の最初の選局 (スリープから。仕様書 6.3)</summary>
    private static readonly string[] FirstTuneLog =
    [
        // 仕様書 6.3 の TS を選ぶ書き込み (TSID 16625 = 0x40F1)
        "T 00=C0", "T E9=40F100",
        // 仕様書 3.3 (ISDB-S。33 は高い 00)。C4 は 3.2 で 80 にしてある
        "T 00=00", "T C4?", "T D3?", "T D3=01", "T DE?", "T DE=00", "T DA?", "T DA=00", "T C4?", "T C4=80", "T D1?", "T D1=02", "T D9=10",
        "T 32?", "T 32=00", "T 33?", "T 33=00", "T 32?", "T 32=01", "T 00=10", "T 66?", "T 66=01", "T 00=40", "T 66?", "T 66=01",
        // 仕様書 6.2 の手順 1〜19
        "X 00=00", "X 17=0C", "T 00=00", "T 2D=00", "T A9=00", "T 2C=01", "X 28=31", "T 4B=31", "T 6A=00", "X 18=00",
        "T 00=00", "T 20=01", "T CE=0000", "T 00=AE", "T 20=07370A", "T 00=A0", "T D7=00", "T 00=00", "T 80?", "T 80=10",
        // 仕様書 5.5 (出力にする)
        "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=00",
        // 仕様書 4.4 (中継の中で)。q = (1318000 + 2) / 4 = 329500 = 0x5071C
        "X 08=01",
        "U 15=02", "U 43=06", "U 6A=0000", "U 75=99", "U 9D=00", "U 61=07", "U 01=01", "U 04=C4400200B4780830FF021E161C0705FF0001", "U 05=00", "U 04=C0",
        "X 08=00",
        // 仕様書 2.3
        "T 00=00", "T FE=01", "T C3=00",
        // 仕様書 6.3 のロックの判定 (バンク A0 の 10〜12)
        "T 00=A0", "T 10?",
    ];

    [Test]
    public async Task 衛星の最初の選局は仕様書の表の順に書き_TSID_と周波数を埋める()
    {
        var (frontend, bus, clock) = Make();
        var tuning = ChannelTable.Parse("BS15:16625")!;
        await Assert.That(frontend.TuneIsdbs(tuning.Frequency, CxdStream.From(tuning.StreamId))).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(FirstTuneLog);
        // 仕様書 4.4 の手順 8 のあと 10 ms、手順 10 のあと 50 ms。ISDB-S はロックのあとに待ち足さない (仕様書 5.6 は ISDB-T だけ)
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10, 50 });
        await Assert.That(frontend.LockMs).IsEqualTo(0);
    }

    [Test]
    public async Task TSID_が無ければ相対_TS_番号_0_で選ぶ()
    {
        var (frontend, bus, _) = Make();
        // CS は TSID を選り分けない (選局表)。相対 TS 番号で選ぶ形は 00、n、01 (仕様書 6.3)
        var tuning = ChannelTable.Parse("CS4")!;
        frontend.TuneIsdbs(tuning.Frequency, CxdStream.From(tuning.StreamId));
        await Assert.That(bus.Log.Take(2)).IsEquivalentTo(new[] { "T 00=C0", "T E9=000001" });
        bus.Log.Clear();
        frontend.TuneIsdbs(Bs15, new CxdStream(null, 3));
        await Assert.That(bus.Log[1]).IsEqualTo("T E9=000301");
    }

    [Test]
    public async Task 相対_TS_番号は_7_までで_それより上は何も書かずに断る()
    {
        var (frontend, bus, _) = Make();
        Assert.Throws<IOException>(() => frontend.TuneIsdbs(Bs15, new CxdStream(null, 8)));
        Assert.Throws<IOException>(() => frontend.TuneIsdbs(Cxd2858.MaxSatelliteKhz + 1, Tsid16625));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 衛星の周波数は_4_kHz_単位に丸めて_20_ビットで書く()
    {
        // q = (f + 2) / 4 の下位 8 ビット、次の 8 ビット、上位 4 ビット (仕様書 4.4)。CS2 は 1613000 → 403250 = 0x62732
        var row = Cxd2858.SatelliteRows(1613000)[7];
        await Assert.That(row.Values.Skip(12).Take(3)).IsEquivalentTo(new byte[] { 0x32, 0x27, 0x06 });
        // 2 kHz は切り上げ、1 kHz は切り捨て
        await Assert.That(Cxd2858.SatelliteRows(1049482)[7].Values[12]).IsEqualTo((byte)0xE3);
        await Assert.That(Cxd2858.SatelliteRows(1049481)[7].Values[12]).IsEqualTo((byte)0xE2);
        // 上限の周波数は q がちょうど 20 ビットいっぱい
        await Assert.That(Cxd2858.SatelliteRows(Cxd2858.MaxSatelliteKhz)[7].Values.Skip(12).Take(3)).IsEquivalentTo(new byte[] { 0xFF, 0xFF, 0x0F });
    }

    [Test]
    public async Task 衛星のまま選局し直すときは_TS_を選んでから止め_起動しない()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbs(1049480, new CxdStream(16400))).IsTrue();
        // 仕様書 6.3 の手順 1 → 2 (T 00 ← 00、C3 ← 01) → 3 (チューナー。衛星側のままなので止めない。仕様書 10.2)
        await Assert.That(bus.Log.Take(5)).IsEquivalentTo(new[] { "T 00=C0", "T E9=401000", "T 00=00", "T C3=01", "X 08=01" });
        await Assert.That(bus.Log).DoesNotContain("X 17=0C");
        await Assert.That(Relayed(bus.Log)[0]).IsEqualTo("U 15=02");
        await Assert.That(Relayed(bus.Log)).DoesNotContain("U 0C=140000");
    }

    [Test]
    public async Task ロックしなければ_3_秒で時間切れにする()
    {
        var (frontend, _, clock) = Make(demod => demod.SatelliteStatus = _ => 0x20);
        await Assert.That(frontend.TuneIsdbs(Bs15, Tsid16625)).IsFalse();
        // 10 ms と 50 ms (仕様書 4.4) のあと、10 ms ごとに 3 秒まで (仕様書 11)。TMCC だけのロック (bit5) ではロックにしない
        await Assert.That(clock.Sleeps.Skip(2).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
        await Assert.That(clock.Sleeps.Skip(2).Sum()).IsEqualTo(Cxd2856Frontend.IsdbsLockTimeoutMs);
        await Assert.That(frontend.LockMs).IsEqualTo(-1);
    }

    [Test]
    public async Task 途中でロックしたらそこで返す()
    {
        var (frontend, _, _) = Make(demod => demod.SatelliteStatus = read => read > 25 ? (byte)0x60 : (byte)0x00);
        await Assert.That(frontend.TuneIsdbs(Bs15, Tsid16625)).IsTrue();
        await Assert.That(frontend.LockMs).IsEqualTo(250);
    }

    [Test]
    public async Task 地上波から衛星へは_TS_を選び_ISDB_T_のスリープから起動し直す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbs(Bs15, Tsid16625)).IsTrue();
        var log = bus.Log;
        // TS を選ぶ (仕様書 6.3 の手順 1) → ISDB-T のスリープ (5.7。最後は 2.4 の X 17 ← 01) → ISDB-S の起動 (3.3・6.2) (仕様書 10.1)
        await Assert.That(log.Take(2)).IsEquivalentTo(new[] { "T 00=C0", "T E9=40F100" });
        var sleep = log.IndexOf("T 38=0102");
        var sleptAt = log.IndexOf("X 17=01");
        var start = log.IndexOf("X 17=0C");
        await Assert.That(sleep).IsGreaterThan(1);
        await Assert.That(sleptAt).IsGreaterThan(sleep);
        await Assert.That(start).IsGreaterThan(sleptAt);
        await Assert.That(log).Contains("T 33=00");
        // チューナーは地上波側を止めてから衛星の周波数 (仕様書 4.4 の手順 0・4.7・10.2)
        await Assert.That(Relayed(log)).IsEquivalentTo(new[]
        {
            "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0",
            "U 15=02", "U 43=06", "U 6A=0000", "U 75=99", "U 9D=00", "U 61=07", "U 01=01", "U 04=C4400200B4780830FF021E161C0705FF0001", "U 05=00", "U 04=C0",
        });
    }

    [Test]
    public async Task 衛星から地上波へは_ISDB_S_のスリープから起動し直す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        var log = bus.Log;
        // ISDB-S のスリープ (仕様書 6.5) → ISDB-T の起動 (3.3・5.2) (仕様書 10.1)。TS を選ぶ書き込みは無い
        await Assert.That(log).DoesNotContain("T 00=C0");
        await Assert.That(log.Take(3)).IsEquivalentTo(new[] { "T 00=00", "T C3=01", "T 80?" });
        var sleep = log.IndexOf("X 28=13");
        var start = log.IndexOf("X 17=06");
        await Assert.That(sleep).IsGreaterThan(0);
        await Assert.That(start).IsGreaterThan(sleep);
        // ISDB-S のスリープは共通の後始末 (2.4) を使わない
        await Assert.That(log).DoesNotContain("T 49=33");
        await Assert.That(log).Contains("T 33=02");
        // チューナーは衛星側を止めてから地上波の周波数 (仕様書 4.3 の手順 0・4.7・10.2)
        var relayed = Relayed(log);
        await Assert.That(relayed.Take(7)).IsEquivalentTo(new[] { "U 15=02", "U 43=07", "U 0C=140000", "U 01=00", "U 05=00", "U 04=C0", "U 01=00" });
        await Assert.That(relayed).Contains("U 68=0088000B2200171B578008FF0199002487");
    }

    [Test]
    public async Task 衛星のスリープはチューナーの衛星側を止めてから仕様書の_6_5_の順に書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 4.7 の衛星側の停止 (中継の中で)
            "X 08=01", "U 15=02", "U 43=07", "U 0C=140000", "U 01=00", "U 05=00", "U 04=C0", "X 08=00",
            // 仕様書 6.5 の手順 1〜3
            "T 00=00", "T C3=01", "T 80?", "T 80=1F",
            // 5.5 (高インピーダンス)
            "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=01",
            // 6.5 の手順 5〜17
            "X 00=00", "X 18=01", "T 00=00", "T 6A=11", "T 4B=21", "X 28=13", "T FE=01", "T 2C=00", "T A9=00", "T 2D=00", "X 17=01", "T 00=A0", "T D7=00",
        });
        // スリープからの選局は起動からやり直す
        bus.Log.Clear();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        await Assert.That(bus.Log).Contains("X 17=0C");
    }

    [Test]
    public async Task 衛星の選局の途中で失敗しても使い終えたら衛星のスリープにする()
    {
        var (frontend, bus, _) = Make();
        var failing = true;
        bus.OnWrite = () =>
        {
            if (failing && bus.Log[^1] == "U 01=01") throw new IOException("I2C の失敗 (テスト)");
        };
        Assert.Throws<IOException>(() => frontend.TuneIsdbs(Bs15, Tsid16625));
        // 中継は閉じる (仕様書 1.4)
        await Assert.That(bus.Log[^1]).IsEqualTo("X 08=00");
        failing = false;
        bus.Log.Clear();
        frontend.Sleep();
        // チューナーの衛星側を止め (仕様書 4.7)、ISDB-S のスリープ (仕様書 6.5) を送る
        await Assert.That(bus.Log).Contains("U 0C=140000");
        await Assert.That(bus.Log).Contains("X 28=13");
        await Assert.That(bus.Log).DoesNotContain("T 49=33");
        // 次の選局は初期化から
        bus.Log.Clear();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        await Assert.That(bus.Log.Take(2)).IsEquivalentTo(new[] { "X 00=00", "X 10=01" });
    }

    [Test]
    public async Task 衛星の信号品質は_13_ビットの値を付録_A_の表で引き強度を復調器から求める()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        var demod = bus[Demod];
        // b0 の bit0 が 1 (計算が終わった)。b1 の上位 3 ビットは使わない (13 ビット。仕様書 9.2)。r = 0x0130 → 8.0 dB
        demod.T[(0xA1, 0x10)] = 0x01;
        demod.T[(0xA1, 0x11)] = 0xE1;
        demod.T[(0xA1, 0x12)] = 0x30;
        // v = 0x0193 = 403 (x0 の上位 3 ビットは使わない)。利得 = 403 × (-1400) / 403 + 9700 = 8300 → -83.0 (仕様書 9.7 の衛星)
        demod.T[(0xA0, 0x1F)] = 0xE1;
        demod.T[(0xA0, 0x20)] = 0x93;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "T 00=A0", "T 10?", "T 00=A1", "T 10?", "T 00=A0", "T 1F?" });
        await Assert.That(signal.Locked).IsTrue();
        await Assert.That(signal.Cn).IsEqualTo(8.0);
        await Assert.That(signal.Unit).IsEqualTo(TunerSignal.Db);
        // 衛星の強度は dBm として扱えるかが未確認なので、画面に出す強度には入れず、--tune の出力のための値にだけ入れる
        await Assert.That(signal.StrengthDbm).IsNull();
        await Assert.That(frontend.SatelliteLevelDb).IsEqualTo(-83.0);
        // 計算が終わっていなければ C/N は無い
        demod.T[(0xA1, 0x10)] = 0x00;
        await Assert.That(frontend.Signal()!.Cn).IsNull();
    }

    [Test]
    public async Task C_N_の表は_r_以上で最も小さい値の行を引く()
    {
        // 付録 A は 192 行で、値の大きいほうから並ぶ
        await Assert.That(Cxd2856.IsdbsCnTable.Count).IsEqualTo(192);
        await Assert.That(Cxd2856.IsdbsCnTable.Zip(Cxd2856.IsdbsCnTable.Skip(1)).All(pair => pair.First.Raw > pair.Second.Raw)).IsTrue();
        // 表の最初以上は 0.0 dB、最後以下は 20.0 dB (仕様書 9.2 の手順 5)
        await Assert.That(Cxd2856.IsdbsCnDb(0x05AF)).IsEqualTo(0.0);
        await Assert.That(Cxd2856.IsdbsCnDb(0x1FFF)).IsEqualTo(0.0);
        await Assert.That(Cxd2856.IsdbsCnDb(0x0014)).IsEqualTo(20.0);
        await Assert.That(Cxd2856.IsdbsCnDb(0x0000)).IsEqualTo(20.0);
        // 同じ値はその dB、間の値は r 以上で最も小さい値 (0x0590 は 0x0597 の 0.1 dB)
        await Assert.That(Cxd2856.IsdbsCnDb(0x0597)).IsEqualTo(0.1);
        await Assert.That(Cxd2856.IsdbsCnDb(0x0598)).IsEqualTo(0.0);
        await Assert.That(Cxd2856.IsdbsCnDb(0x0590)).IsEqualTo(0.1);
        // 0.1 dB とびでない所 (17.6 の次が 17.8)
        await Assert.That(Cxd2856.IsdbsCnDb(0x0022)).IsEqualTo(17.8);
        await Assert.That(Cxd2856.IsdbsCnDb(0x0015)).IsEqualTo(19.9);
    }

    [Test]
    public async Task 衛星の強度は利得を四捨五入して求める()
    {
        // v = 0 → 9700 → -97.0、v = 1 → -1400 / 403 = -3.47 → -3 → 9697 → -96.97
        await Assert.That(Cxd2856.IsdbsLevelDb(0)).IsEqualTo(-97.0);
        await Assert.That(Cxd2856.IsdbsLevelDb(1)).IsEqualTo(-96.97);
        // v = 2 → -6.95 → -7
        await Assert.That(Cxd2856.IsdbsLevelDb(2)).IsEqualTo(-96.93);
    }

    [Test]
    public async Task TMCC_の_TSID_は値を固めて読み_TMCC_がロックしていなければ読まない()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbs(Bs15, Tsid16625);
        var demod = bus[Demod];
        demod.T[(0xC0, 0x31)] = 0x40;
        demod.T[(0xC0, 0x32)] = 0xF1;
        demod.T[(0xC0, 0x33)] = 0x40;
        demod.T[(0xC0, 0x34)] = 0xF2;
        bus.Log.Clear();
        var tsids = frontend.SatelliteStreams()!;
        // 仕様書 6.4: 固める (2.3) → バンク C0 の 31〜40 (相対 TS 0〜7 の TSID。2 バイトずつ上位から) → 戻す
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "T 00=A0", "T 10?", "T 01=01", "T 00=C0", "T 31?", "T 01=00" });
        await Assert.That(tsids).IsEquivalentTo(new ushort[] { 0x40F1, 0x40F2, 0, 0, 0, 0, 0, 0 });
        // TS はロックしていても TMCC がロックしていなければ読まない
        demod.SatelliteStatus = _ => 0x40;
        bus.Log.Clear();
        await Assert.That(frontend.SatelliteStreams()).IsNull();
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "T 00=A0", "T 10?" });
    }

    [Test]
    public async Task 地上波で動作中は_TMCC_を読まない()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        await Assert.That(frontend.SatelliteStreams()).IsNull();
        await Assert.That(bus.Log).IsEmpty();
    }
}
