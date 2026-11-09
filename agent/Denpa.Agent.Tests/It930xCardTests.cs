namespace Denpa.Agent.Tests;

/*
 * IT930x の機材の内蔵カードリーダー (It930xCard.cs) を、偽のブリッジ (It930xFakes.cs の UART のモデル) で確かめる。
 * 手順と番地は ITE の SDK (api/IT9300.c の IT9300_bcas*、brRegister.h・brVariable.h) のもの。
 * 偽のカードの振る舞い (OVA_UART_REALSEND のあとの区切りでまとめて渡す、GPIOH14 を 1 に戻すと ATR を返す) は偽物で決めたもので、実機の値ではない。
 */
public class It930xCardTests
{
    private static readonly It930xModel Pe = It930x.Find(0x0511, 0x024E)!;

    /// <summary>B-CAS の ATR (specific mode、TA1 0x12 = 19200 ボー、T=1、IFSC 0x7C)</summary>
    private static readonly byte[] BcasAtr = Convert.FromHexString("3BF01200FF9181B17C451F0399");

    /// <summary>I ブロックには 90 00 を返す</summary>
    private static byte[] Respond(byte[] block) => T1Protocol.Block(0x00, [0x90, 0x00]);

    private static (FakeIt930x Usb, FakeClock Clock, It930xCard Card) Rig(string port)
    {
        var usb = new FakeIt930x { CardAtr = BcasAtr, CardResponder = Respond };
        var clock = new FakeClock();
        var card = new It930xCard(
            "テストのカード", () => Open(usb, port, clock), () => It930xDevice.CloseIfIdle(port), clock.Sleep);
        return (usb, clock, card);
    }

    private static It930xDevice Open(FakeIt930x usb, string port, FakeClock clock) =>
        It930xDevice.Acquire(port, () => (usb, Pe), clock.Sleep, () => clock.Now, () => It930xFirmware.Code);

    /// <summary>控えのうち、カードに関わる行 (UART のコマンド、GPIOH6・GPIOH14、UART の状態・受けた数・まとめて送る印)</summary>
    private static List<string> CardLog(FakeIt930x usb)
    {
        lock (usb.Log)
        {
            return [.. usb.Log.Where(line => line.StartsWith("UART", StringComparison.Ordinal)
                || line.Contains("D8C", StringComparison.Ordinal) && !line.StartsWith("W D8C3", StringComparison.Ordinal) && !line.StartsWith("W D8C4", StringComparison.Ordinal) && !line.StartsWith("W D8C5", StringComparison.Ordinal)
                || line.Contains("D8E", StringComparison.Ordinal) || line.Contains("7904", StringComparison.Ordinal)
                || line.Contains("496B", StringComparison.Ordinal) || line.Contains("4965", StringComparison.Ordinal))];
        }
    }

    [Test]
    public async Task リセットは_SDK_の順で_GPIOH14_と_UART_を動かし_ATR_の速さに替える()
    {
        var (usb, clock, card) = Rig("8-1");
        try
        {
            await Assert.That(card.Reset()).IsEquivalentTo(BcasAtr);
            await Assert.That(CardLog(usb)).IsEquivalentTo(new[]
            {
                // IT9300_bcasInit (機材を開いて最初の 1 回)
                "UART MODE 1",
                // IT9300_bcasDetectCard: GPIOH6 の機能を有効にし、出力をやめ、入力を読む
                "W D8C9=01", "W D8C8=00", "R D8C6 1",
                // IT9300_bcasResetCard: GPIOH14 を出力・有効にして 0、UART の状態に 2、9600 (番号 0)、5 ms、1 に戻して出力をやめる
                "W D8E4=01", "W D8E5=01", "W D8E3=00", "W 7904=02", "UART BAUD 0", "W D8E3=01", "W D8E4=00",
                // ATR: 受けた数を読み、その数だけ読む (IT9300_bcasGetData)
                "R 496B 1", "UART R 13",
                // TA1 0x12 (specific mode) の 19200 (番号 1)
                "UART BAUD 1",
            }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
            await Assert.That(clock.Sleeps).Contains(5);
            // こちらの受けられる長さを広げる S(IFS) は送らない (仕様書と SDK に無いので既定の 32 のまま)
            await Assert.That(usb.UartBlocks).IsEmpty();

            // 準備が済んでいてカードがあれば、リセットし直さない
            lock (usb.Log) usb.Log.Clear();
            await Assert.That(card.Reset()).IsEquivalentTo(BcasAtr);
            await Assert.That(CardLog(usb)).IsEquivalentTo(new[] { "W D8C9=01", "W D8C8=00", "R D8C6 1" }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task 送るブロックは_48_バイトずつ渡し_最後の区切りの前にまとめて送る印を書く()
    {
        var (usb, _, card) = Rig("8-2");
        try
        {
            card.Reset();
            lock (usb.Log) usb.Log.Clear();
            // IFSC 0x7C (124) いっぱいの APDU は 128 バイトのブロック (48 + 48 + 32)
            var apdu = Enumerable.Range(0, 124).Select(i => (byte)i).ToArray();
            await Assert.That(card.Transmit(apdu)).IsEquivalentTo(new byte[] { 0x90, 0x00 });
            await Assert.That(usb.UartBlocks.Single()).IsEquivalentTo(T1Protocol.Block(0x00, apdu));
            await Assert.That(CardLog(usb)).IsEquivalentTo(new[]
            {
                // APDU の前ごとにカードがあるかを見る
                "W D8C9=01", "W D8C8=00", "R D8C6 1",
                // 前のやり取りの残りが無いか見る
                "R 496B 1",
                // IT9300_bcasSendData
                "UART W 48", "UART W 48", "W 4965=01", "UART W 32",
                // 応答 (6 バイト) を受けた数だけ読む
                "R 496B 1", "UART R 6",
            }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task 長い応答は_32_バイトずつ読む()
    {
        var (usb, _, card) = Rig("8-3");
        try
        {
            card.Reset();
            var inf = Enumerable.Range(0, 30).Select(i => (byte)(i + 1)).Concat(new byte[] { 0x90, 0x00 }).ToArray();
            usb.CardResponder = _ => T1Protocol.Block(0x00, inf);
            lock (usb.Log) usb.Log.Clear();
            await Assert.That(card.Transmit([0x90, 0x30, 0x00, 0x00, 0x00])).IsEquivalentTo(inf);
            // ブロックは 36 バイト: 32 バイトと残りの 4 バイト
            await Assert.That(CardLog(usb).Where(line => line.StartsWith("UART R", StringComparison.Ordinal))).IsEquivalentTo(new[] { "UART R 32", "UART R 4" });
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task 前のやり取りの残りは送る前に読み捨てる()
    {
        var (usb, _, card) = Rig("8-4");
        try
        {
            card.Reset();
            // 時間切れのあとに遅れて届いた応答のつもり
            foreach (var b in T1Protocol.Block(0x40, [0x6F, 0x00])) usb.UartRx.Enqueue(b);
            await Assert.That(card.Transmit([0x90, 0x30, 0x00, 0x00, 0x00])).IsEquivalentTo(new byte[] { 0x90, 0x00 });
            await Assert.That(usb.UartRx).IsEmpty();
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task カードが無ければリセットせずに断り_抜かれたら次の_APDU_で断る()
    {
        var (usb, _, card) = Rig("8-5");
        try
        {
            // GPIOH6 が 1 ならカードは無い
            usb.Registers[FakeIt930x.CardDetectInput] = 1;
            Assert.Throws<CardAbsentException>(() => card.Reset());
            await Assert.That(CardLog(usb).Any(line => line.Contains("D8E3", StringComparison.Ordinal))).IsFalse();

            usb.Registers[FakeIt930x.CardDetectInput] = 0;
            await Assert.That(card.Reset()).IsEquivalentTo(BcasAtr);
            usb.Registers[FakeIt930x.CardDetectInput] = 1;
            Assert.Throws<CardAbsentException>(() => card.Transmit([0x90, 0x30, 0x00, 0x00, 0x00]));
            await Assert.That(usb.UartBlocks).IsEmpty();
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task カードが_ATR_を返さなければ断る()
    {
        var (usb, _, card) = Rig("8-6");
        try
        {
            usb.CardAtr = null;
            var error = Assert.Throws<IOException>(() => card.Reset());
            await Assert.That(error!.Message).Contains("ATR を返しません");
        }
        finally
        {
            card.Dispose();
        }
    }

    [Test]
    public async Task カードを使っている間は受信機を全部返しても電源を切らず_カードを閉じたら切る()
    {
        var (usb, _, card) = Rig("8-7");
        var clock = new FakeClock();
        // カードだけでも機材を開いて電源を入れる (GPIOH7 ← 0。仕様書 1.5)
        card.Reset();
        await Assert.That(usb.Log).Contains("W D8C3=00");
        lock (usb.Log) usb.Log.Clear();
        // 受信機のつもりで同じ機材を取り、返す
        var tuner = Open(usb, "8-7", clock);
        await Assert.That(tuner).IsSameReferenceAs(card.Device);
        tuner.Release();
        It930xDevice.CloseIfIdle("8-7");
        await Assert.That(usb.Log).DoesNotContain("W D8C3=01");
        // カードを閉じると、誰も使っていないので電源を切る (GPIOH2 ← 0、GPIOH7 ← 1)
        card.Dispose();
        await Assert.That(usb.Log.Where(line => line.StartsWith("W D8", StringComparison.Ordinal)).TakeLast(2)).IsEquivalentTo(new[] { "W D8B7=00", "W D8C3=01" });
        await Assert.That(card.Device).IsNull();
    }

    [Test]
    public async Task 受信機を使っている間にカードを閉じても電源を切らない()
    {
        var (usb, clock, card) = Rig("8-8");
        var tuner = Open(usb, "8-8", clock);
        try
        {
            card.Reset();
            lock (usb.Log) usb.Log.Clear();
            card.Dispose();
            await Assert.That(usb.Log).DoesNotContain("W D8C3=01");
        }
        finally
        {
            tuner.Release();
            It930xDevice.CloseIfIdle("8-8");
        }
        await Assert.That(usb.Log).Contains("W D8C3=01");
    }

    [Test]
    public async Task 速さは_specific_mode_なら_TA1_から_ほかは_9600_で_SDK_に無い速さは断る()
    {
        // 9600 と 19200 だけ (IT9300_bcasSetBaudrate)
        await Assert.That(It930xCard.Baudrate(Atr.Parse(BcasAtr))).IsEqualTo(19200);
        await Assert.That(It930xCard.Baudrate(new Atr([], 0x12, 0, false, 2, 32, 4, 13, false, false))).IsEqualTo(9600);
        await Assert.That(It930xCard.Baudrate(new Atr([], 0x11, 0, true, 2, 32, 4, 13, false, false))).IsEqualTo(9600);
        Assert.Throws<IOException>(() => It930xCard.Baudrate(new Atr([], 0x13, 0, true, 2, 32, 4, 13, false, false)));
    }

    [Test]
    public async Task UART_のコマンドは長さを確かめてから送る()
    {
        var usb = new FakeIt930x();
        var bridge = new It930xBridge(usb, _ => { });
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.UartWrite(new byte[It930xBridge.MaxUartWrite + 1]));
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.UartWrite([]));
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.UartRead(It930xBridge.MaxUartRead + 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.UartBaudrate(38400));
        // 送らずに断ったので、偽のブリッジには何も届いていない
        await Assert.That(usb.Log).IsEmpty();
        bridge.UartCardMode();
        bridge.UartBaudrate(19200);
        bridge.UartWrite([0x00, 0xC1, 0x01, 0xFE, 0x3E]);
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "UART MODE 1", "UART BAUD 1", "UART W 5" }, TUnit.Assertions.Enums.CollectionOrdering.Matching);
    }

    [Test]
    public async Task カードリーダーはエージェントが持つポートの機材だけで_px4d_が使っている筐体のポートは並べない()
    {
        var claimed = new HashSet<string>(StringComparer.Ordinal) { "1-1", "1-2" };
        var found = new List<(string, It930xModel)> { ("1-1", Pe), ("1-2", Pe), ("1-3", Pe) };
        var cards = It930x.Cards(claimed, found, ["1-2"]);
        await Assert.That(cards.Select(card => card.Name)).IsEquivalentTo(new[] { "PLEX PX-MLT5PE 1-1 Card Reader" });
        await Assert.That(It930x.Cards(new HashSet<string>(), found, [])).IsEmpty();
    }

    [Test]
    [Arguments("it930x:4-12.1", "4-12.1")]
    [Arguments("it930x:4-12.1:0", null)]
    [Arguments("it930x:", null)]
    [Arguments("dt295:3-5", null)]
    public async Task カードの_device_は受信機の番号を付けないポートだけ(string device, string? port)
    {
        await Assert.That(It930x.CardPort(device)).IsEqualTo(port);
    }
}
