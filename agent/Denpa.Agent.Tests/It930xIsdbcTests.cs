namespace Denpa.Agent.Tests;

/*
 * IT930x の受信機の ISDB-C の選局 (It930xDevice.cs の It930xTuner)。ロックのあとに TS 入力を開け、受け取った TS から TSMF の TS を選ぶ (仕様書 7A.4・7A.7)。
 * 偽のブリッジ (It930xFakes.cs) の EP 0x84 に、流れ続ける TS を作って渡す。ロックの状態は偽の復調器 (Cxd2856Fakes.cs) の CableStatus で決める。
 *
 * **固まったら失敗にする。** 各テストは最初に `await Task.Yield()` する
 */
[Timeout(60_000)]
public class It930xIsdbcTests
{
    private static readonly It930xModel Pe = It930x.Find(0x0511, 0x024E)!;

    /// <summary>PX-MLT5PE の受信機 0 の TS 入力の同期バイト (仕様書 1.2・3.4)</summary>
    private static readonly byte Sync = It930xBridge.SyncBytes[Pe.Receivers.First(item => item.Index == 0).TsInput];

    private static readonly uint TsEnable = It930xBridge.TsEnable + (uint)Pe.Receivers.First(item => item.Index == 0).TsInput;

    private static (FakeIt930x Usb, FakeCxdBus Bus1, FakeCxdBus Bus3) Fake()
    {
        var usb = new FakeIt930x();
        var bus1 = new FakeCxdBus(0x6C, 0x64);
        var bus3 = new FakeCxdBus(0x65, 0x6C, 0x64);
        usb.I2c[1] = bus1;
        usb.I2c[3] = bus3;
        return (usb, bus1, bus3);
    }

    /// <summary>受信機 0 のチューナー。復調器のロックの待ちは偽の時計で進め、TSMF の判定の待ちだけが実際の時間</summary>
    private static It930xTuner Tuner(FakeIt930x usb, string port, int tsmfTimeoutMs = TsmfSelector.TimeoutMs)
    {
        var clock = new FakeClock();
        return new It930xTuner(
            "test", 0, () => It930xDevice.Acquire(port, () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code), () => It930xDevice.CloseIfIdle(port, TimeSpan.Zero))
        {
            TsmfTimeoutMs = tsmfTimeoutMs,
        };
    }

    /// <summary>受信機 0 の TS 入力を、最後に閉じたままか (開ける書き込みより、閉じる書き込みがあと)</summary>
    private static bool InputClosed(FakeIt930x usb)
    {
        lock (usb.Log) return usb.Log.LastIndexOf($"W {TsEnable:X4}=00") > usb.Log.LastIndexOf($"W {TsEnable:X4}=01");
    }

    /// <summary>TSMF の搬送波の TS (相対 TS 番号 2 と 3 が有効で、スロットを交互に使う)。1 回の読みで 4 フレーム</summary>
    private static Func<byte[]?> TsmfCarrier()
    {
        var slots = TsmfFake.Alternate();
        var frame = 0;
        return () =>
        {
            var chunk = new List<byte>();
            for (var i = 0; i < 4; i++, frame++)
            {
                chunk.AddRange(TsmfFake.Header(slots, TsmfFake.Valid2And3, sync: Sync));
                foreach (var packet in TsmfFake.Frame(slots, frame % 600, Sync)) chunk.AddRange(packet);
            }
            return [.. chunk];
        };
    }

    /// <summary>ヘッダーの無い搬送波の TS。1 回の読みで 200 パケット</summary>
    private static Func<byte[]?> PlainCarrier()
    {
        var number = 0;
        return () => [.. Enumerable.Range(0, 200).SelectMany(_ => TsmfFake.Packet(0x100, number++ & 0x7FFF, Sync))];
    }

    /// <summary>出口から <paramref name="count"/> パケットを読む (5 秒で打ち切る)</summary>
    private static List<byte[]> Read(Stream output, int count)
    {
        var buffer = new byte[count * 188];
        var used = 0;
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (used < buffer.Length && DateTime.UtcNow < deadline) used += output.Read(buffer, used, buffer.Length - used);
        return [.. Enumerable.Range(0, used / 188).Select(i => buffer.AsSpan(i * 188, 188).ToArray())];
    }

    /// <summary>チューナーに書いた周波数 (kHz。チューナーの 70〜72)</summary>
    private static int TunedKhz(FakeCxdReceiver demod) =>
        demod.Tuner.GetValueOrDefault((byte)0x70) | (demod.Tuner.GetValueOrDefault((byte)0x71) << 8) | ((demod.Tuner.GetValueOrDefault((byte)0x72) & 0x0F) << 16);

    [Test]
    public async Task ISDB_C_はロックのあとに_TS_入力を開け_TSMF_の_k_本目の_TS_だけを流す()
    {
        await Task.Yield();
        var (usb, bus1, bus3) = Fake();
        usb.TsSource = TsmfCarrier();
        var tuner = Tuner(usb, "10-1");
        try
        {
            tuner.Tune(ChannelTable.Parse("QC51:1")!);
            await Assert.That(tuner.Tuned).IsTrue();
            await Assert.That(tuner.IsdbcLocked).IsTrue();
            await Assert.That(tuner.CableFrequency).IsEqualTo(393_000_000u);
            // 復調の方式は ISDB-C (仕様書 7A.3)。TS 入力はロックのあとに開ける
            await Assert.That(bus3.Log).Contains("65 X 17=09");
            await Assert.That(usb.Log).Contains($"W {TsEnable:X4}=01");
            // 有効な TS は相対 TS 番号 2 と 3。1 本目 (0 から数える) は 3
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Selected);
            await Assert.That(tuner.Tsmf!.Relative).IsEqualTo(3);
            var packets = Read(tuner.Output, 60);
            await Assert.That(packets.Count).IsEqualTo(60);
            await Assert.That(packets.All(packet => packet[0] == 0x47 && TsmfFake.Pid(packet) == 0x300)).IsTrue();
            await Assert.That(tuner.Signal()!.Locked).IsTrue();
            // 初めての ISDB-C の選局で、まだ使っていない受信機を整合を保つ設定で初期化して待機させる (仕様書 4.7・10.1)
            await Assert.That(bus1.Log).Contains("64 U 67=02");
            await Assert.That(bus3.Log).Contains("6C U 67=02");

            // ほかの方式を選局したら TSMF の処理は通さない (仕様書 10.1)
            usb.TsSource = PlainCarrier();
            // 前の搬送波の、読んでいる途中だったぶんが届き終わるのを待つ (地上波には、ロックのあとに捨てる処理が無い)
            Thread.Sleep(50);
            tuner.Tune(ChannelTable.Parse("T27")!);
            await Assert.That(tuner.Tsmf).IsNull();
            await Assert.That(tuner.IsdbcLocked).IsFalse();
            await Assert.That(tuner.CableFrequency).IsNull();
            await Assert.That(Read(tuner.Output, 10).All(packet => TsmfFake.Pid(packet) == 0x100)).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task ヘッダーの無い搬送波は_0_本目の指定でそのまま流す()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        usb.TsSource = PlainCarrier();
        var tuner = Tuner(usb, "10-2");
        try
        {
            tuner.Tune(ChannelTable.Parse("QU20")!);
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Passthrough);
            await Assert.That(tuner.Tsmf!.FirstHeader).IsNull();
            var packets = Read(tuner.Output, 30);
            await Assert.That(packets.Count).IsEqualTo(30);
            await Assert.That(packets.All(packet => TsmfFake.Pid(packet) == 0x100)).IsTrue();
            // 続きの番号で流れる (途中を落とさない)
            await Assert.That(packets.Zip(packets.Skip(1)).All(pair => TsmfFake.Number(pair.Second) == ((TsmfFake.Number(pair.First) + 1) & 0x7FFF))).IsTrue();
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 指定した_TS_が無ければ_ロックしないときとは別の失敗にして_TS_を止める()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        usb.TsSource = TsmfCarrier();
        var tuner = Tuner(usb, "10-3");
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("QC51:2")!));
            await Assert.That(error.Message).StartsWith(It930xTuner.TsmfMissing);
            await Assert.That(error.Message).Contains("有効な TS は 2 本");
            await Assert.That(tuner.Tuned).IsFalse();
            // --tune が出すために、ロックしたことと TSMF の判定と信号品質は残す
            await Assert.That(tuner.IsdbcLocked).IsTrue();
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Missing);
            await Assert.That(tuner.IsdbcFailedSignal!.Locked).IsTrue();
            await Assert.That(InputClosed(usb)).IsTrue();

            // ヘッダーの無い搬送波で 1 本目を指定したときも同じ失敗
            usb.TsSource = PlainCarrier();
            error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("QU20:1")!));
            await Assert.That(error.Message).StartsWith(It930xTuner.TsmfMissing);
            await Assert.That(error.Message).Contains("TSMF を使わない搬送波");
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task ロックしても_TS_が来なければ_時間切れで_TS_が届かない文で失敗にする()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        var tuner = Tuner(usb, "10-4", tsmfTimeoutMs: 100);
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("QC51")!));
            // 1 パケットも届かないのは、電波ではなくブリッジから先で止まっている (仕様書 3.6)。同期しなかった文とは分ける
            await Assert.That(error.Message).IsEqualTo(It930xTuner.TsMissing);
            await Assert.That(tuner.Tuned).IsFalse();
            await Assert.That(tuner.IsdbcLocked).IsTrue();
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Pending);
            // 判定の時間切れは 3 秒 (仕様書 7A.7・11)
            await Assert.That(TsmfSelector.TimeoutMs).IsEqualTo(3000);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task C24_から_C27_は表の周波数でロックしなければ_2_MHz_ずらした周波数を試す()
    {
        await Task.Yield();
        var (usb, _, bus3) = Fake();
        usb.TsSource = PlainCarrier();
        var demod = bus3[0x65];
        // どちらでもロックしない: 231000 kHz と 233000 kHz を試して、同期しなかった文で失敗にする (仕様書 7A.2 の推定の使い方)
        demod.CableStatus = _ => 0x00;
        var tuner = Tuner(usb, "10-5");
        try
        {
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("QC24")!));
            await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
            await Assert.That(tuner.IsdbcLocked).IsFalse();
            await Assert.That(tuner.Tsmf).IsNull();
            await Assert.That(tuner.CableFrequency).IsNull();
            await Assert.That(bus3.Log.Where(line => line.StartsWith("65 U 68=", StringComparison.Ordinal))).IsEquivalentTo(new[]
            {
                // 231000 kHz = 0x38658、233000 kHz = 0x38E28
                "65 U 68=0084000221001A1C588603FF01D90F2487", "65 U 68=0084000221001A1C288E03FF01D90F2487",
            });

            // ずらした周波数でだけロックする
            demod.CableStatus = _ => TunedKhz(demod) == 233000 ? (byte)0x01 : (byte)0x00;
            tuner.Tune(ChannelTable.Parse("QC24")!);
            await Assert.That(tuner.CableFrequency).IsEqualTo(233_000_000u);
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Passthrough);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task ISDB_C_の種別_CATV_は受けられる種別に挙げ_最初からは選ばない()
    {
        await Task.Yield();
        // 並びは GR → BS → CS → CATV → SKY (サーバの種別の並び)
        await Assert.That(It930x.Types).IsEquivalentTo(new[] { "GR", "BS", "CS", ChannelTable.Catv, ChannelTable.Sky }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.Receivable("it930x:4-12.1:0")).IsEquivalentTo(new[] { "GR", "BS", "CS", "CATV", "SKY" });
        // ケーブルテレビの回線でしか受けられず、選ぶとチャンネルスキャンが 113 チャンネル増えるので、見つけた受信機には付けない
        await Assert.That(It930x.DetectedTypes).IsEquivalentTo(new[] { "GR", "BS", "CS" }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
    }

    [Test]
    public async Task TSMF_の有効な_TS_の数を_利用者に渡す()
    {
        await Task.Yield();
        var (usb, _, _) = Fake();
        usb.TsSource = TsmfCarrier();
        var tuner = Tuner(usb, "10-6");
        try
        {
            tuner.Tune(ChannelTable.Parse("QC51")!);
            // 有効な TS は相対 TS 番号 2 と 3 の 2 本 (/denpa/stream の X-Denpa-Tsmf-Streams)
            await Assert.That(tuner.Tsmf!.Streams).IsEqualTo(2);
            var sink = new Sink("live", 5, _ => { }) { Owner = new Lease(0, ChannelTable.Catv, "QC51") { TsmfStreams = tuner.Tsmf!.Streams } };
            await Assert.That(sink.TsmfStreams).IsEqualTo(2);
            await Assert.That(Sink.TsmfStreamsHeader).IsEqualTo("X-Denpa-Tsmf-Streams");

            // TSMF を使わない搬送波は数を渡さない (ヘッダーを付けない)
            usb.TsSource = PlainCarrier();
            Thread.Sleep(50);
            tuner.Tune(ChannelTable.Parse("QU20")!);
            await Assert.That(tuner.Tsmf!.Decision).IsEqualTo(TsmfDecision.Passthrough);
            await Assert.That(tuner.Tsmf!.Streams).IsNull();
            var plain = new Sink("live", 5, _ => { }) { Owner = new Lease(0, ChannelTable.Catv, "QU20") { TsmfStreams = tuner.Tsmf!.Streams } };
            await Assert.That(plain.TsmfStreams).IsNull();
            // プールの外で作った利用者 (選局の無いもの) も null
            await Assert.That(new Sink("live", 5, _ => { }).TsmfStreams).IsNull();
        }
        finally
        {
            tuner.Dispose();
        }
    }
}
