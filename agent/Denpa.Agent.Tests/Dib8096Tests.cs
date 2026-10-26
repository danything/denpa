using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * DiB8096 (Dib8096.cs)。**期待する並びは仕様書から手で写した** (実装の出力を写して golden にしていない)。
 * 手で計算した値は、その計算をコメントに残す。
 */
public class Dib8096Tests
{
    private static (Dib8096 Dib, FakeI2c I2c, DibModel Model, FakeTime Time) Make(Action<string>? trace = null, DibMemory? memory = null)
    {
        var model = new DibModel();
        var i2c = new FakeI2c(model);
        var time = new FakeTime();
        return (new Dib8096(i2c, time, trace, memory), i2c, model, time);
    }

    /// <summary><paramref name="expected"/> が <paramref name="log"/> にこの順で出てくるか (間に別の行があってよい)</summary>
    private static async Task InOrder(List<string> log, params string[] expected)
    {
        var at = 0;
        foreach (var line in expected)
        {
            var found = log.IndexOf(line, at);
            if (found < 0) throw new InvalidOperationException($"{line} が {at} 行目より後にありません (直前: {string.Join(" ", log.Skip(Math.Max(0, at - 5)).Take(10))})");
            at = found + 1;
        }
        await Assert.That(at).IsGreaterThan(0);
    }

    [Test]
    public async Task 初期化は仕様書_4_7_と_6_2_の順に書く()
    {
        var (dib, i2c, _, _) = Make();
        dib.Initialize();
        string[] expected =
        [
            "D1287=0003",
            "D896?", "D896?", "D897?",
            "D1025=0100",
            "D1287=0003",
            "D1025=0100", "D1028=0000",
            // 電源 = すべて (6.4)
            "D900?", "D1280?", "D774=0000", "D775=0000", "D776=0000", "D900=0000", "D1280=0000",
            // ADC = 切 (6.5)
            "D907=3000", "D908=007A",
            "D770=FFFF", "D771=FFFF", "D772=FFFC", "D898=000C", "D1280=004D", "D1281=000C",
            "D770=0000", "D771=0000", "D772=0000", "D898=0004", "D1280=0000", "D1281=0000",
            "D906=2D98",
            "D901=0112", "D902=050F", "D902=0507", "D904=1E80", "D23=0337", "D24=F980", "D27=0000", "D28=0000", "D26=0000", "D922=D257",
            "D898=0004",
            "D1029=FFFF", "D1030=0000", "D1032=FFFF", "D1037=0000",
            // 出力 = ハイインピーダンス (6.6)。s = (0 & 0x50) | 0x02 | 0x20
            "D299?", "D299=0022", "D300=0700", "D1286=0000", "D1291=0205",
            "D40=0755",
            "D7=0004", "D8=0400", "D9=0814", "D11=001B",
        ];
        await Assert.That(string.Join(" ", i2c.Log.Take(expected.Length))).IsEqualTo(string.Join(" ", expected));
        // 6.2 の後半: 既定値の表の最後 → 903 → 1285 → タイミングの周波数 (20,199,727 = 0x0134392F) → ADC の較正
        await InOrder(i2c.Log, "D338=1461", "D903=0031", "D1285&FFFD|0000", "D29=0134", "D30=392F", "D923=0000", "D924=0308", "D923=0001", "D923=0000", "D565?");
    }

    [Test]
    public async Task DiB0090_に話す前にゲートを開け_開けっぱなしにする()
    {
        var (dib, i2c, _, _) = Make();
        dib.Initialize();
        var gate = i2c.Log.IndexOf("D1025=C000");
        await Assert.That(gate).IsGreaterThan(i2c.Log.IndexOf("D1028=0000", i2c.Log.IndexOf("D565?")));
        await Assert.That(gate).IsLessThan(i2c.Log.FindIndex(line => line.StartsWith('T')));
        // ゲートを閉じる書き込み (D[1025] = 0x0100) は初期化の頭の3回だけ
        await Assert.That(i2c.Log.Count(line => line == "D1025=0100")).IsEqualTo(2);
        await Assert.That(i2c.Log.Skip(gate).Any(line => line == "D1025=0100")).IsFalse();
    }

    [Test]
    public async Task DiB0090_のリセットとデジタル部と確かめ()
    {
        var (dib, i2c, _, time) = Make();
        dib.Initialize();
        // GPIO 0 を Low (起こす)、GPIO 5 を Low → High (リセット)。間は 10ms ずつ (6.8)
        await InOrder(i2c.Log,
            "D1029&FFFE|0000", "D1030&FFFE|0000",
            "D1029&FFDF|0000", "D1030&FFDF|0000",
            "D1029&FFDF|0000", "D1030&FFDF|0020",
            "T24=0022", "T1B=00A2", "T20=3B00", "T23=0A30", "T21?", "T21=8000", "T1A?",
            // (0x0223 >> 5) & 2 = 0 → 0x00A2
            "T1A?", "T1B=00A2",
            "T01=0000", "T02=99A0", "T19=149E", "T1C=FF2D", "T39=0000", "T1E=07FF", "T1F=0007", "T24=22EB", "T3C=03FF", "T3D=0111",
            // ヒューズ (6.10): T[0x26] = T[0x28] = 0 → c = 0 → 32、n = 0 → 3、h = 0 → 34
            "T26?", "T28?", "T13=8800", "T02=1A20",
            "T14=0002");
        await Assert.That(string.Join(",", time.Sleeps.Skip(1).Take(3))).IsEqualTo("10,10,10");
        await Assert.That(dib.P1g).IsFalse();
        await Assert.That(dib.TunerVersion).IsEqualTo((byte)0x23);
    }

    [Test]
    public async Task 知らない部品なら開かない()
    {
        var (dib, _, model, _) = Make();
        model.Id = 0x0000;
        Assert.Throws<IOException>(dib.Initialize);

        (dib, _, model, _) = Make();
        model.Version = 0x8090;  // DiB8096P はレジスタの並びが違う
        var error = Assert.Throws<IOException>(dib.Initialize);
        await Assert.That(error.Message).Contains("0x8090");

        (dib, _, model, _) = Make();
        model.TunerId = 0x0200;  // P1-A/B
        Assert.Throws<IOException>(dib.Initialize);
    }

    [Test]
    public async Task UHF_27ch_の選局()
    {
        var (dib, i2c, _, _) = Make();
        dib.Initialize();
        i2c.Log.Clear();
        // 473,142,857 + 14 × 6,000,000 = 557,142,857 Hz → 557,142 kHz
        var result = dib.Tune(557_142_857);
        await Assert.That(result).IsEqualTo(DibLock.DataLocked);
        await InOrder(i2c.Log,
            // UHF なので GPIO 3 = Low
            "D1029&FFF7|0000", "D1030&FFF7|0000",
            // req = 557,142 - 63 = 557,079。通常の表の 650000 の行 (切替 2) と、PLL の表の 580000 の行 (帯 1・符号 3・分周 6・前置 6)
            // vco = 6 × 557,079 × 2 = 6,684,948、/ 6 = 1,114,158、fb = 557、rest = 158 → 200 → 200 × 6528 / 200 = 6528
            "T0B=B802", "T15=022D", "T16=FF06", "T17=1980",
            // lo5 = 0x049E | (3 << 11) | (1 << 7)、lo6 = 0xFF28 | 6
            "T19=1C9E", "T1C=FF2E",
            // (0x22E9 & 0xFF9F) | 2 | 4 | 2
            "T24=228F",
            // 段 0: 利得 6 → (6 << 13) | (3 << 11) | 0x0781 | 2
            "T1E=07FF", "T10=DF83", "T09=006F", "T0C=0300", "T0D=1D12", "T0E=B9CE",
            "T01=8000", "T03=6008", "T04=0001", "T02=2A16", "T05=ABCD",
            // PLL の倍率: x = 557,142 × 256 / 1000 = 142,628。k = 17 で f = 3264、余り 2276 → 988 (> 717、いちばん大きい)
            "D1856?", "D901=0111", "D29=0146", "D30=5AAA",
            // WBD の目標: 557MHz の行。熱 = 616 - (36 × 557 >> 6) = 303、冷 = 700 - (34 × 557 >> 6) = 405、
            // 温度 55 → 405 + ((303 - 405) × 55 >> 7) = 361。基準 = (361 × 8 × 18 / 33 + 1) / 2 = 788
            "D106=0314",
            // DDS のずれ: -63 kHz → 63 × -1242 を符号無し 32 ビットで = 0xFFFECE5A
            "D26=0000", "D27=01FE", "D28=CE5A",
            "D1286=0400");
    }

    [Test]
    public async Task VHF_の_C24_では_GPIO_3_を_High_にして_VHF_の表を使う()
    {
        var (dib, i2c, _, _) = Make();
        dib.Initialize();
        i2c.Log.Clear();
        // C24 = 231,142,857 Hz → req = 231,142 - 143 = 230,999 kHz
        var result = dib.Tune(ChannelTable.Parse("C24")!.Frequency);
        await Assert.That(result).IsEqualTo(DibLock.DataLocked);
        await InOrder(i2c.Log,
            "D1029&FFF7|0000", "D1030&FFF7|0008",
            // 通常の表の 380000 の行 (切替 1)。PLL の表の 280000 の行 (帯 1・符号 5・分周 12・前置 6)
            // vco = 12 × 230,999 × 2 = 5,543,976、/ 6 = 923,996、fb = 461、rest = 1996 > 1900 → 0、fb = 462
            "T0B=B801", "T15=01CE", "T16=0106", "T17=0000",
            // lo5 = 0x049F | (5 << 11) | (1 << 7)、lo6 = 0xFFF8
            "T19=2C9F", "T1C=FFF8", "T24=448F");
    }

    [Test]
    public async Task CBAND_の_C13_ではソフトの_AGC_を回して外付けのアッテネーターを入れる()
    {
        var (dib, i2c, _, _) = Make();
        dib.Initialize();
        i2c.Log.Clear();
        var result = dib.Tune(ChannelTable.Parse("C13")!.Frequency);
        await Assert.That(result).IsEqualTo(DibLock.DataLocked);
        await InOrder(i2c.Log,
            "D1029&FFF7|0000", "D1030&FFF7|0008",
            // 7.3.9 の始め
            "T04=0000", "T32=0000", "T39=0000",
            // 段 0 の間は GPIO 6 = High
            "D1029&FFBF|0000", "D1030&FFBF|0040",
            // 終わり
            "T02=99A0", "T04=0001",
            // PWM に渡す (CBAND の表)
            "T2A=FFFF", "T2C=22E7",
            // CBAND 用の AGC の設定: D[108] = 0
            "D108=0000");
    }

    [Test]
    public async Task CATV_の_C13_から_C63_まで選局できて帯で切り替えを選ぶ()
    {
        var (dib, i2c, model, _) = Make();
        dib.Initialize();
        for (var channel = 13; channel <= 63; channel++)
        {
            var hz = ChannelTable.Parse($"C{channel}")!.Frequency;
            await Assert.That(dib.Tune(hz)).IsEqualTo(DibLock.DataLocked);
            // UHF の帯 (250MHz を超える) だけ Low
            var high = (model.Demod[1030] & 0x0008) != 0;
            await Assert.That(high).IsEqualTo(hz / 1000 <= 250_000);
        }
    }

    [Test]
    public async Task 電波が無ければ失敗の結果を返す()
    {
        var (dib, _, model, _) = Make();
        dib.Initialize();
        model.Signal = false;
        await Assert.That(dib.Tune(557_142_857)).IsEqualTo(DibLock.Failed);
    }

    [Test]
    public async Task 範囲外の周波数は断る()
    {
        var (dib, _, _, _) = Make();
        dib.Initialize();
        Assert.Throws<IOException>(() => dib.Tune(30_000_000));
        await Task.CompletedTask;
    }

    [Test]
    public async Task LED_のピンは選局をまたいで残る()
    {
        var (dib, _, model, _) = Make();
        dib.Initialize();
        dib.Led(true);
        dib.Tune(557_142_857);
        dib.Tune(ChannelTable.Parse("C13")!.Frequency);
        await Assert.That(model.Demod[1029] & 0x0002).IsEqualTo(0);
        await Assert.That(model.Demod[1030] & 0x0002).IsEqualTo(2);
        dib.Led(false);
        await Assert.That(model.Demod[1029] & 0x0002).IsEqualTo(2);
    }

    [Test]
    public async Task 探索の1歩は最低_10ms_空ける()
    {
        var (dib, _, _, time) = Make();
        dib.Initialize();
        time.Sleeps.Clear();
        dib.Tune(557_142_857);
        // 30ms はダイバーシティの切り替え (バージョン 0x8002)。選局ごとに3回
        await Assert.That(time.Sleeps.Count(ms => ms == 30)).IsEqualTo(3);
        await Assert.That(time.Sleeps.Count(ms => ms >= 10)).IsGreaterThan(5);
    }

    [Test]
    public async Task 待ちの丸め上げ()
    {
        // 既定は参考の実装と同じ: 0.1ms 単位の t を floor(10 × (t + 99) / 100) ms。t = 0 でも 9ms
        var (dib, _, _, time) = Make();
        dib.Initialize();
        time.Sleeps.Clear();
        dib.Tune(557_142_857);
        await Assert.That(time.Sleeps).Contains(9);
        await Assert.That(time.Sleeps.Min()).IsGreaterThanOrEqualTo(1);
    }

    [Test]
    public async Task ロックまでの内訳を出せる()
    {
        var lines = new List<string>();
        var (dib, _, _, _) = Make(lines.Add);
        dib.Initialize();
        dib.Tune(557_142_857);
        var line = lines.Single();
        await Assert.That(line).Contains("DataLocked");
        await Assert.That(line).Contains("DiB0090 温度");
        // DC の較正は開くときに済ませてある
        await Assert.That(line).DoesNotContain("DC の較正");
        await Assert.That(line).Contains("AGC の立ち上げ (7.4)");
        await Assert.That(line).Contains("探索 Step1");
        await Assert.That(line).Contains("探索 Step10");
    }

    [Test]
    public async Task 前にロックした値を覚えて次は探索せずに合わせる()
    {
        var (dib, i2c, _, _) = Make(memory: new DibMemory());
        dib.Initialize();
        // DC の較正は開くときに済む
        await Assert.That(i2c.Log).Contains("T1F=0004");

        i2c.Log.Clear();
        await Assert.That(dib.Tune(557_142_857)).IsEqualTo(DibLock.DataLocked);
        // 初めてのチャンネルは FFT を 8K と決めて、ガードだけ探す (D[355] = 3)。FFT の探索 (D[355] = 2) はしない
        await Assert.That(dib.LastPath).IsEqualTo("既定 (8K) でガードだけ探した");
        await Assert.That(i2c.Log).Contains("D355=0003");
        await Assert.That(i2c.Log).DoesNotContain("D355=0002");
        await Assert.That(i2c.Log).DoesNotContain("T1F=0004");

        i2c.Log.Clear();
        await Assert.That(dib.Tune(557_142_857)).IsEqualTo(DibLock.DataLocked);
        await Assert.That(dib.LastPath).IsEqualTo("覚えた値で合わせた");
        await Assert.That(i2c.Log.Any(line => line.StartsWith("D355=", StringComparison.Ordinal))).IsFalse();
        // 段 3 の共通設定 (探索ではない): 8K = モード 3 → D[0] の上 3 ビットが 3 (下は差動のセグメントのマスク)
        await Assert.That(i2c.Log.Any(line => line.StartsWith("D0=6", StringComparison.Ordinal) || line.StartsWith("D0=7", StringComparison.Ordinal))).IsTrue();
    }

    [Test]
    public async Task TMCC_の同期が揃わなくても段_3_で書いた値を覚える()
    {
        var (dib, _, model, _) = Make(memory: new DibMemory());
        model.Tmcc = false;
        dib.Initialize();
        dib.Tune(557_142_857);
        await Assert.That(dib.LastPath).IsEqualTo("既定 (8K) でガードだけ探した");
        await Assert.That(dib.Tune(557_142_857)).IsEqualTo(DibLock.DataLocked);
        await Assert.That(dib.LastPath).IsEqualTo("覚えた値で合わせた");
    }

    [Test]
    public async Task 覚えた値で合わなければ探索に戻る()
    {
        var memory = new DibMemory();
        var (dib, _, model, _) = Make(memory: memory);
        dib.Initialize();
        dib.Tune(557_142_857);
        model.Signal = false;
        await Assert.That(dib.Tune(557_142_857)).IsEqualTo(DibLock.Failed);
        await Assert.That(dib.LastPath).IsEqualTo("覚えた値で合わず探索した");
        await Assert.That(memory.Channels.Count).IsEqualTo(0);
    }

    [Test]
    public async Task PLL_の倍率()
    {
        await Assert.That(Dib8096.PllRatio(557_142)).IsEqualTo(17);
        // x = 473,142 × 256 / 1000 = 121,124。17: 3264 → 356、18: 3456 → 164、19: 3648 → 740、20: 3840 → 2084 → 1756 (いちばん大きい)
        await Assert.That(Dib8096.PllRatio(473_142)).IsEqualTo(20);
    }

    [Test]
    public async Task 信号の強さと_C_N()
    {
        await Assert.That(Dib8096.Strength(60000)).IsEqualTo(-22.5);
        await Assert.That(Dib8096.Strength(42010)).IsEqualTo(-51.0);
        // 51356 と 51112 の真ん中くらい: 100000 + (51234 - 51112) × 1000 / 244 = 100500
        await Assert.That(Dib8096.Strength(51234)).IsEqualTo(-30.5);
        // N = 1 << 16、S = 100 << 16 → snr >> 16 = 100 → 20 dB
        await Assert.That(Dib8096.CarrierToNoise(1 << 6, 100 << 6)).IsEqualTo(20.0);
        await Assert.That(Dib8096.CarrierToNoise(0, 100 << 6)).IsNull();
    }
}
