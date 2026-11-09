namespace Denpa.Agent.Tests;

/*
 * 復調器 CXD2856ER とチューナー CXD2858ER (Cxd2856.cs・Cxd2858.cs)。偽のバス (Cxd2856Fakes.cs) の上で、書く順番と値を仕様書の表と照らす。
 * 期待値は仕様書 (denpa-spec の mlt5/spec.md) の表を 1 行ずつ写したもので、添えた番号は仕様書の節。
 * 読んでから書く行 (マスクが FF でない行) は、読み (T C4?) のあとに書いた値が並ぶ。偽物のレジスタは書くまで 0
 */
public class Cxd2856Tests
{
    private const byte Demod = 0x65;

    private static (Cxd2856Frontend Frontend, FakeCxdBus Bus, FakeClock Clock) Make(Action<FakeCxdReceiver>? setup = null)
    {
        var bus = new FakeCxdBus(Demod);
        setup?.Invoke(bus[Demod]);
        var clock = new FakeClock();
        return (new Cxd2856Frontend(bus, new Lock(), Demod, clock.Sleep, () => clock.Now), bus, clock);
    }

    /// <summary>初期化 (仕様書 2.2 → 4.2 → 3.2)</summary>
    private static readonly string[] InitLog =
    [
        // 仕様書 2.2 の手順 1〜13
        "X 00=00", "X 10=01", "X 18=01", "X 28=13", "X 17=01", "X 1D=00", "X 14=01", "X 1C=03", "X 50=00", "X 10=00", "X 00=00", "X 1A=01", "T 00=00",
        // 手順 14 (識別)
        "T FD?",
        // 中継を開ける (仕様書 1.4)
        "X 08=01",
        // 仕様書 4.2 (負荷容量は 4.8 の B3。VCO の電流は 19 の値 A5 の上位 4 ビット)
        "U 01=00", "U 67=00", "U 43=07", "U 5E=150000", "U 0C=14", "U 99=7A01", "U 81=1084B3000000C44010004575071C3F0210200A00", "U 9B=00",
        "U 1A?", "U 17=9006", "U 19?", "U 95=0A", "U 74=02", "U 88=00", "U 87=C0", "U 80=01", "U 41=0700",
        "X 08=00",
        // 仕様書 3.2
        "T 00=00", "T C4?", "T C4=80", "T C5?", "T C5=01", "T C6?", "T C6=03", "T 00=60", "T 52?", "T 52=03", "T 00=00", "T C8?", "T C8=03", "T C9?", "T C9=03",
        "T 00=A0", "T B9?", "T B9=01",
    ];

    [Test]
    public async Task 初期化は仕様書の_2_2_と_4_2_と_3_2_の表の順に書く()
    {
        var (frontend, bus, clock) = Make();
        frontend.Init();
        await Assert.That(bus.Log).IsEquivalentTo(InitLog);
        // 仕様書 2.2 のクロックのあと 4 ms、50 と リセットを解いたあと 1 ms ずつ、4.2 の 9B のあと 10 ms、VCO の電流のあと 1 ms
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 4, 1, 1, 10, 1 });
        await Assert.That(frontend.ChipId).IsEqualTo((byte)0x90);
    }

    [Test]
    public async Task 識別が合わなければ中継を開けずに失敗にする()
    {
        var (frontend, bus, _) = Make(demod => demod.ChipId = 0x00);
        var error = Assert.Throws<IOException>(frontend.Init);
        await Assert.That(error.Message).Contains("識別が合いません (0x00)");
        await Assert.That(bus.Log).DoesNotContain("X 08=01");
    }

    [Test]
    public async Task チューナーの初期化に失敗しても中継を閉じる()
    {
        var (frontend, bus, _) = Make(demod => demod.TunerCpu = 0x01);
        var error = Assert.Throws<IOException>(frontend.Init);
        await Assert.That(error.Message).Contains("CPU の状態 0x01");
        await Assert.That(bus.Log[^1]).IsEqualTo("X 08=00");
    }

    /// <summary>T27 (中心 557,143 kHz = 0x88057) の最初の選局 (スリープから。仕様書 5.4)</summary>
    private static readonly string[] FirstTuneLog =
    [
        // 仕様書 3.3 (ISDB-T)。C4 は 3.2 で 80 にしてある
        "T 00=00", "T C4?", "T D3?", "T D3=01", "T DE?", "T DE=00", "T DA?", "T DA=00", "T C4?", "T C4=80", "T D1?", "T D1=02", "T D9=10",
        "T 32?", "T 32=00", "T 33?", "T 33=02", "T 32?", "T 32=01", "T 00=10", "T 66?", "T 66=01", "T 00=40", "T 66?", "T 66=01",
        // 仕様書 5.2 の手順 1〜35
        "X 00=00", "X 17=06", "T 00=00", "T A9=00", "T 2C=01", "T 4B=74", "T 49=00", "X 18=00", "T 00=11", "T 6A=50", "T 00=10", "T A5=01",
        "T 00=00", "T CE=0000", "T 00=10", "T 69=04", "T 6B=03", "T 9D=50", "T D3=06", "T ED=00", "T E2=CE", "T F2=13", "T DE=2E",
        "T 00=15", "T DE=02", "T 00=17", "T 38=0003", "T 00=1E", "T 73=68", "T 00=63", "T 81=00", "T 00=11", "T 33=00033B", "T 00=60", "T A8=B71B",
        // 仕様書 5.3
        "T 00=10", "T 9F=17A0800000", "T A6=31A8299B279C289E29A429A229A8", "T B6=12EEEF", "T D7=04", "T D9=1F79", "T 00=12", "T 71=07", "T 00=15", "T BE=02",
        // 仕様書 5.2 の手順 37〜38
        "T 00=00", "T 80?", "T 80=08",
        // 仕様書 5.5 (出力にする。C4 & 88 が 80 なのでマスクは 01)
        "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=00",
        // 仕様書 4.3 (中継の中で)
        "X 08=01",
        "U 01=00", "U 74=02", "U 87=C440", "U 91=1020", "U 9C=0000", "U 5E=EE021E6702B4780830", "U 67?", "U 67=00",
        "U 68=0088000B2200171B578008FF0199002487", "U 88=00", "U 87=C0",
        "X 08=00",
        // 仕様書 2.3
        "T 00=00", "T FE=01", "T C3=00",
        // 仕様書 5.6
        "T 00=60", "T 10?",
    ];

    [Test]
    public async Task 地上波の最初の選局は仕様書の表の順に書き周波数を埋める()
    {
        var (frontend, bus, clock) = Make();
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(It930xTuner.Khz(ChannelTable.Parse("T27")!.Frequency))).IsTrue();
        await Assert.That(bus.Log).IsEquivalentTo(FirstTuneLog);
        // 周波数の設定のあと 50 ms (仕様書 4.3)。すぐロックしたので、確かめ始めてから 350 ms になるまで待つ (仕様書 5.6)
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 50, 350 });
        await Assert.That(frontend.LockMs).IsEqualTo(0);
    }

    [Test]
    public async Task 地上波のまま選局し直すときは止めてから帯域を書き直す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(473143)).IsTrue();
        // 仕様書 5.4 の手順 1 (T 00 ← 00、C3 ← 01、5.3)。起動 (5.2) はしない
        await Assert.That(bus.Log.Take(12)).IsEquivalentTo(new[]
        {
            "T 00=00", "T C3=01", "T 00=10", "T 9F=17A0800000", "T A6=31A8299B279C289E29A429A229A8", "T B6=12EEEF", "T D7=04", "T D9=1F79",
            "T 00=12", "T 71=07", "T 00=15", "T BE=02",
        });
        await Assert.That(bus.Log[12]).IsEqualTo("X 08=01");
        // T13 の中心 473,143 kHz = 0x73837
        await Assert.That(bus.Log).Contains("U 68=0088000B2200171B373807FF0199002487");
        await Assert.That(bus.Log).DoesNotContain("X 17=06");
    }

    [Test]
    public async Task ロックしなければ_1_5_秒で時間切れにする()
    {
        var (frontend, _, clock) = Make(demod => demod.Status = _ => 0x00);
        frontend.Init();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsFalse();
        // 50 ms のあと、10 ms ごとに 1.5 秒まで
        await Assert.That(clock.Sleeps.Skip(1).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
        await Assert.That(clock.Sleeps.Skip(1).Sum()).IsEqualTo(Cxd2856Frontend.IsdbtLockTimeoutMs);
        await Assert.That(frontend.LockMs).IsEqualTo(-1);
    }

    [Test]
    public async Task 信号が無いと分かれば待たずに失敗にする()
    {
        var (frontend, _, clock) = Make(demod => demod.Status = read => read < 3 ? (byte)0x00 : (byte)0x10);
        frontend.Init();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsFalse();
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 50, 10, 10 });
    }

    [Test]
    public async Task _350_ms_を過ぎてからロックしたら待ち足さない()
    {
        var (frontend, _, clock) = Make(demod => demod.Status = read => read > 40 ? (byte)0x01 : (byte)0x00);
        frontend.Init();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        await Assert.That(frontend.LockMs).IsEqualTo(400);
        await Assert.That(clock.Sleeps.Skip(1).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
    }

    [Test]
    public async Task _350_ms_より早くロックしたら_350_ms_まで待つ()
    {
        var (frontend, _, clock) = Make(demod => demod.Status = read => read > 12 ? (byte)0x01 : (byte)0x00);
        frontend.Init();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        await Assert.That(frontend.LockMs).IsEqualTo(120);
        await Assert.That(clock.Sleeps[^1]).IsEqualTo(230);
    }

    [Test]
    public async Task スリープはチューナーを止めてから仕様書の_5_7_と_2_4_の順に書く()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus.Log.Clear();
        frontend.Sleep();
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            // 仕様書 4.6 の地上波側の停止 (中継の中で)
            "X 08=01", "U 74=02", "U 67?", "U 67=00", "U 5E=150000", "U 88=00", "U 87=C0", "X 08=00",
            // 仕様書 5.7 の手順 1〜3
            "T 00=00", "T C3=01", "T 80?", "T 80=1F",
            // 5.5 (高インピーダンス)
            "T 00=00", "T C4?", "T 00=00", "T 81?", "T 81=01",
            // 5.7 の手順 5〜21
            "T 00=10", "T 69=05", "T 6B=07", "T 9D=14", "T D3=00", "T ED=01", "T E2=4E", "T F2=03", "T DE=32", "T 00=15", "T DE=03",
            "T 00=17", "T 38=0102", "T 00=1E", "T 73=00", "T 00=63", "T 81=01",
            // 2.4 の共通の後始末
            "X 00=00", "X 18=01", "T 00=00", "T 49=33", "T 4B=21", "T FE=01", "T 2C=00", "T A9=00", "X 17=01",
        });
        // スリープからの選局は起動からやり直す
        bus.Log.Clear();
        frontend.TuneIsdbt(557143);
        await Assert.That(bus.Log).Contains("X 17=06");
    }

    [Test]
    public async Task 信号品質は値を固めて読み_C_N_と強度を返す()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        var demod = bus[Demod];
        demod.T[(0x60, 0x28)] = 0x0C;
        demod.T[(0x60, 0x29)] = 0x80;
        demod.Tuner[0x5B] = 0x00;
        demod.Tuner[0x69] = 0x88;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        // 仕様書 8.1 と 8.6
        await Assert.That(bus.Log).IsEquivalentTo(new[]
        {
            "T 01=01", "T 00=60", "T 10?", "T 28?", "T 01=00",
            "X 08=01", "U 87=C441", "U 59=0501", "U 5B?", "U 59=0301", "U 5B?", "U 59=04", "U 88=00", "U 87=C0", "U 69?", "X 08=00",
        });
        await Assert.That(signal.Locked).IsTrue();
        // r = 0x0C80 = 3200。10 × log10(3200 / 8) = 26.02 dB
        await Assert.That(signal.Cn!.Value).IsEqualTo(10 * Math.Log10(400)).Within(1e-9);
        await Assert.That(signal.Unit).IsEqualTo(TunerSignal.Db);
        await Assert.That(signal.StrengthDbm).IsEqualTo(-94.89);
    }

    [Test]
    public async Task 復調がロックしていなければ_C_N_は無い()
    {
        var (frontend, bus, _) = Make();
        frontend.TuneIsdbt(557143);
        bus[Demod].Status = _ => 0x00;
        bus.Log.Clear();
        var signal = frontend.Signal()!;
        await Assert.That(signal.Locked).IsFalse();
        await Assert.That(signal.Cn).IsNull();
        // 固めるのは解く (仕様書 2.3)
        await Assert.That(bus.Log.Take(4)).IsEquivalentTo(new[] { "T 01=01", "T 00=60", "T 10?", "T 01=00" });
    }

    [Test]
    public async Task 動作中でなければ信号品質を読まない()
    {
        var (frontend, bus, _) = Make();
        frontend.Init();
        bus.Log.Clear();
        await Assert.That(frontend.Signal()).IsNull();
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 入力のレベルは仕様書_8_6_の式で求める()
    {
        // a = b = 0、g = 8 (利得 10 dB)、557,143 kHz (M = 4170)、ISDB-T の補正 -4.5 dB
        // IF の利得 = 870 + 1000 + (769 × 9945 + 1275) / 2550 = 870 + 1000 + 2999 = 4869。RF の利得 = 4170
        await Assert.That(Cxd2858.InputLevel(0, 0, 8, 557143, -450)).IsEqualTo(-4869 - 4170 - 450);
        // a = 100 (a × 140 = 14000 > 9945)、b = 50、g = 0。m = 14000 で 8823 以上 24786 未満
        // IF の利得 = 870。RF の利得 = 4170 - 154 - (70 × (14000 - 8823) + 127) / 255 = 4170 - 154 - 1421 = 2595
        await Assert.That(Cxd2858.InputLevel(100, 50, 0, 557143, -450)).IsEqualTo(-870 - 2595 - 450);
        // m = 255 × 140 = 35700 (30090 以上)。RF の利得 = 4020 - 4536 - 1186 - (160 × 5610 + 127) / 255 = -1702 - 3520
        await Assert.That(Cxd2858.InputLevel(255, 0, 15, 50000, 0)).IsEqualTo(-(870 + 2000) - (4020 - 4536 - 1186 - 3520));
        await Assert.That(Cxd2858.MaxRfGain(700001)).IsEqualTo(4150);
        await Assert.That(Cxd2858.MaxRfGain(700000)).IsEqualTo(4130);
        await Assert.That(Cxd2858.MaxRfGain(65000)).IsEqualTo(4020);
    }

    [Test]
    public async Task 途中で失敗したら次の選局は初期化からやり直す()
    {
        var (frontend, bus, _) = Make();
        frontend.Init();
        var failing = true;
        bus.OnWrite = () =>
        {
            if (failing && bus.Log[^1] == "U 01=00") throw new IOException("I2C の失敗 (テスト)");
        };
        Assert.Throws<IOException>(() => frontend.TuneIsdbt(557143));
        // 中継は閉じる (仕様書 1.4)
        await Assert.That(bus.Log[^1]).IsEqualTo("X 08=00");
        failing = false;
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        await Assert.That(bus.Log[0]).IsEqualTo("X 00=00");
        await Assert.That(bus.Log[1]).IsEqualTo("X 10=01");
    }

    [Test]
    public async Task _20_ビットを超える周波数は何も書かずに断る()
    {
        var (frontend, bus, _) = Make();
        frontend.Init();
        bus.Log.Clear();
        Assert.Throws<IOException>(() => frontend.TuneIsdbt(Cxd2858.MaxTerrestrialKhz + 1));
        await Assert.That(bus.Log).IsEmpty();
    }

    [Test]
    public async Task 選局の途中で失敗しても使い終えたらスリープにする()
    {
        var (frontend, bus, _) = Make();
        frontend.Init();
        var failing = true;
        bus.OnWrite = () =>
        {
            if (failing && bus.Log[^1] == "U 87=C440") throw new IOException("I2C の失敗 (テスト)");
        };
        Assert.Throws<IOException>(() => frontend.TuneIsdbt(557143));
        failing = false;
        bus.Log.Clear();
        frontend.Sleep();
        // チューナーを止めて (仕様書 4.6)、復調器をスリープにする (仕様書 5.7・2.4)
        await Assert.That(bus.Log).Contains("U 74=02");
        await Assert.That(bus.Log[^1]).IsEqualTo("X 17=01");
        // 次の選局は初期化から
        bus.Log.Clear();
        frontend.TuneIsdbt(557143);
        await Assert.That(bus.Log[1]).IsEqualTo("X 10=01");
    }

    [Test]
    public async Task 同じバスの受信機は中継を開けてから閉じるまで交わらない()
    {
        // バス 1 の受信機 1 (0x6C) と 2 (0x64)。偽物は中継が 2 つ開いたままチューナーに届くと失敗にする
        var bus = new FakeCxdBus(0x6C, 0x64);
        bus.OnWrite = () => Thread.Yield();
        var busLock = new Lock();
        var frontends = new[] { (byte)0x6C, (byte)0x64 }.Select(address =>
        {
            var clock = new FakeClock();
            return new Cxd2856Frontend(bus, busLock, address, ms =>
            {
                clock.Sleep(ms);
                Thread.Sleep(Math.Min(ms, 2));
            }, () => clock.Now);
        }).ToList();
        var tasks = frontends.Select(frontend => Task.Run(() =>
        {
            for (var i = 0; i < 5; i++)
            {
                if (!frontend.TuneIsdbt((uint)(473143 + i * 6000))) throw new InvalidOperationException("ロックしなかった");
                frontend.Signal();
            }
            frontend.Sleep();
        })).ToArray();
        await Task.WhenAll(tasks);
        // 中継の区切りは、開けた受信機が閉じるまで、ほかの受信機の行を挟まない
        string? open = null;
        foreach (var line in bus.Log)
        {
            var who = line[..2];
            if (line.EndsWith("X 08=01", StringComparison.Ordinal)) open = who;
            else if (line.EndsWith("X 08=00", StringComparison.Ordinal)) open = null;
            else if (open is not null) await Assert.That(who).IsEqualTo(open);
        }
    }

    [Test]
    public async Task 書き込みは_X_を_T_の_2_つ上のアドレスに出す()
    {
        var link = new CxdLink(new FakeCxdBus(0x6C), 0x6C, _ => { });
        await Assert.That(link.Address(CxdTarget.T)).IsEqualTo((byte)0x6C);
        await Assert.That(link.Address(CxdTarget.X)).IsEqualTo((byte)0x6E);
        await Assert.That(link.Address(CxdTarget.Tuner)).IsEqualTo((byte)0x60);
    }
}
