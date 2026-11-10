using System.IO.Pipelines;

namespace Denpa.Agent.Tests;

/*
 * IT930x の TS の経路 (It930xBridge.ConfigureTs・EnableTsInputs・DisableTsInputs・ReadTsStatus)、分け方 (It930xTsDemux)、受信機ごとの出口 (It930xTsOutput)、
 * --it930x-probe --ts。レジスタの並びは ITE の SDK と照らし、期待値に SDK の関数名を添える。同期バイトの値はこちらで決めたもの。
 */
public class It930xTsTests
{
    // ---------------------------------------------------------------------
    // TS の経路の設定
    // ---------------------------------------------------------------------

    [Test]
    public async Task TS_の経路は_SDK_と同じ順と値で設定する()
    {
        var usb = new FakeIt930x();
        var bridge = new It930xBridge(usb, _ => { });
        var (before, after) = bridge.ConfigureTs(new bool[5]);
        await Assert.That(before.Empty).IsTrue();
        await Assert.That(after.Empty).IsTrue();
        await Assert.That(usb.Log).IsEquivalentTo(new[]
        {
            // 入力 0〜4 を閉じる (IT9300_disableTsPort。前のプロセスが開けたままでも、閉じた状態から設定する)
            "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00",
            // IT9300_initialize: p_br_mp2if_ignore_sync_byte
            "W DA1A=00",
            // IT9300_setOutTsType: dvbt_inten (bit 2) を 1、mpeg_full_speed を 0、dvbt_en を 1 (IT9300_writeRegisterBits は読んでから書く)
            "R F41F 1", "W F41F=04",
            "R DA10 1", "W DA10=00",
            "R F41A 1", "W F41A=01",
            // IT9300_configOutput: リセット → EP4 を止める → NAK を外す → 有効 → 転送の大きさ (65,424 / 4 = 0x3FE4) → 最大パケット長 (512 / 4)
            "R DA1D 1", "W DA1D=01",
            "R DD11 1", "W DD11=00",
            "R DD13 1", "W DD13=00",
            "R DD11 1", "W DD11=20",
            "W DD88=E43F",
            "W DD0C=80",
            // シリアル・パラレルの出力を止める → リセットを外す → p_br_reg_top_host_reverse
            "R DA05 1", "W DA05=00",
            "R DA06 1", "W DA06=00",
            "R DA1D 1", "W DA1D=00",
            "W D920=00",
            // IT9300_initialize: 残っている TS のバッファの数 (0xDA99 → 0xDA98)。0 なので捨てない。捨てたあとももう 1 度読む
            "R DA99 1", "R DA98 1",
            "R DA99 1", "R DA98 1",
            // IT9300_setInTsType (入力 0・1 だけ。シリアルは 0)
            "W DA58=00", "W DA59=00",
            // IT9300_setSyncByteMode (入力ごとに aggre_mode を 1、同期バイトはこちらで決めた値)
            "W DA73=01", "W DA78=17",
            "W DA74=01", "W DA79=27",
            "W DA75=01", "W DA7A=37",
            "W DA76=01", "W DA7B=57",
            "W DA77=01", "W DA7C=67",
        });
        // 入力はまだ開けない (誤りのあるパケットを通す設定も、入力を開けるときに書く)
        await Assert.That(usb.Log).DoesNotContain("W DA4C=01");
        await Assert.That(usb.Log).DoesNotContain("W DA5A=1F");
    }

    [Test]
    public async Task ビットだけ書き換えるときはほかのビットを残す()
    {
        var usb = new FakeIt930x();
        usb.Registers[It930xBridge.Ep4Enable] = 0x81;
        usb.Registers[It930xBridge.DvbtInterrupt] = 0xF0;
        new It930xBridge(usb, _ => { }).ConfigureTs(new bool[5]);
        // EP4 の有効 (bit 5) は、いったん 0 にしてから 1 にする
        await Assert.That(usb.Registers[It930xBridge.Ep4Enable]).IsEqualTo((byte)0xA1);
        await Assert.That(usb.Registers[It930xBridge.DvbtInterrupt]).IsEqualTo((byte)0xF4);
    }

    [Test]
    public async Task ブリッジに_TS_が残っていれば捨てる()
    {
        var usb = new FakeIt930x();
        usb.Registers[0xDA99] = 2;
        var (before, _) = new It930xBridge(usb, _ => { }).ConfigureTs(new bool[5]);
        await Assert.That(before).IsEqualTo(new It930xPsb(0, 2));
        // IT9300_initialize: 0xDA05 に 1 を書いてから 0 を書き、もう 1 度読む
        var at = usb.Log.IndexOf("W DA05=01");
        await Assert.That(usb.Log.Skip(at).Take(4)).IsEquivalentTo(new[] { "W DA05=01", "W DA05=00", "R DA99 1", "R DA98 1" });
    }

    [Test]
    public async Task 入力の形は入力_0_と_1_だけ設定する()
    {
        var usb = new FakeIt930x();
        var bridge = new It930xBridge(usb, _ => { });
        bridge.ConfigureTs([true, false, true, true, true]);
        await Assert.That(usb.Log.Where(line => line.StartsWith("W DA58", StringComparison.Ordinal) || line.StartsWith("W DA59", StringComparison.Ordinal)))
            .IsEquivalentTo(new[] { "W DA58=01", "W DA59=00" });
        Assert.Throws<ArgumentException>(() => bridge.ConfigureTs(new bool[4]));
    }

    [Test]
    public async Task 入力は全部まとめて開け_閉じるときは_10_ms_待って_EP_0x84_をリセットする()
    {
        var usb = new FakeIt930x();
        var sleeps = new List<int>();
        var bridge = new It930xBridge(usb, sleeps.Add);
        bridge.EnableTsInputs();
        // IT930x_probe の「Enable TsPort」: IT9300_enableTsPort を入力ごと (p_br_reg_ts0_en + 入力) → IT9300_setIgnoreFail
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "W DA4C=01", "W DA4D=01", "W DA4E=01", "W DA4F=01", "W DA50=01", "W DA5A=1F" });
        usb.Log.Clear();
        bridge.DisableTsInputs();
        // DRV_ResetRxPort の閉じる側: IT9300_disableTsPort を入力ごと → mdelay(10) → 0xDA1D に 1、0
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        await Assert.That(sleeps).IsEquivalentTo(new[] { It930xBridge.InputsOffSettleMs });
        await Assert.That(It930xBridge.InputsOffSettleMs).IsEqualTo(10);
    }

    [Test]
    public async Task TS_の経路の状態は読むだけで書かない()
    {
        var usb = new FakeIt930x();
        usb.Registers[0xDA99] = 1;
        usb.Registers[It930xBridge.TsEnable + 2] = 1;
        usb.Registers[It930xBridge.TsOverflow1 + 1] = 1;
        usb.Registers[It930xBridge.LostPackets] = 0x34;
        usb.Registers[It930xBridge.LostPackets + 1] = 0x12;
        usb.Registers[It930xBridge.Ep4Stall] = 0x20;
        var status = new It930xBridge(usb, _ => { }).ReadTsStatus();
        await Assert.That(usb.Log.Any(line => line.StartsWith('W'))).IsFalse();
        await Assert.That(status.Psb).IsEqualTo(new It930xPsb(0, 1));
        await Assert.That(status.Enabled).IsEquivalentTo(new byte[] { 0, 0, 1, 0, 0 });
        // 入力 0 は 0xDA57、入力 1〜4 は 0xDA8B から
        await Assert.That(status.Overflow).IsEquivalentTo(new byte[] { 0, 0, 1, 0, 0 });
        await Assert.That(status.LostPackets).IsEqualTo((ushort)0x1234);
        var text = status.Describe();
        await Assert.That(text).Contains("入力の開閉 (0xDA4C〜) 0 0 1 0 0");
        await Assert.That(text).Contains("ストール 1");
        await Assert.That(text).Contains("0xF53A = 00");
    }

    [Test]
    public async Task EP_0x84_の読みは_SDK_と同じ大きさで_SDK_より多く出す()
    {
        // URB_BUFSIZE (188 × 348) は 188 バイトのパケットの区切りで、EP 0x84 の転送の大きさ (0xDD88) は 4 バイト単位
        await Assert.That(It930xBridge.TsTransferSize).IsEqualTo(188 * 348);
        await Assert.That(It930xBridge.TsTransferSize % 188).IsEqualTo(0);
        await Assert.That(It930xBridge.TsTransferSize % 4).IsEqualTo(0);
        // BR_URB_COUNT (8) より少なくしない
        await Assert.That(It930xBridge.SdkTsDepth).IsEqualTo(8);
        await Assert.That(It930xBridge.TsDepth).IsGreaterThanOrEqualTo(It930xBridge.SdkTsDepth);
    }

    // ---------------------------------------------------------------------
    // 分け方
    // ---------------------------------------------------------------------

    /// <summary>入力 <paramref name="input"/> の <paramref name="number"/> 番目のパケット (ブリッジが同期バイトを付け替えた形)</summary>
    private static byte[] Packet(int input, int number, byte? sync = null)
    {
        var packet = new byte[188];
        Array.Fill(packet, (byte)0xFF);
        packet[0] = sync ?? It930xBridge.SyncBytes[input];
        packet[1] = (byte)input;
        packet[2] = (byte)number;
        return packet;
    }

    /// <summary>入力 0〜4 のパケットを 1 つずつ順に混ぜたもの (<paramref name="rounds"/> 回)</summary>
    private static byte[] Mixed(int rounds) =>
        [.. Enumerable.Range(0, rounds).SelectMany(number => Enumerable.Range(0, 5).SelectMany(input => Packet(input, number)))];

    private static Pipe SmallPipe(int pause = 1 << 20, int resume = 1 << 19) => new(new PipeOptions(
        pauseWriterThreshold: pause,
        resumeWriterThreshold: resume,
        readerScheduler: PipeScheduler.Inline,
        writerScheduler: PipeScheduler.Inline,
        useSynchronizationContext: false));

    /// <summary>入力ごとの出口を付けた分け器と、出口の読み出し側</summary>
    private static (It930xTsDemux Demux, Pipe[] Pipes) Demux()
    {
        var demux = new It930xTsDemux(It930xBridge.SyncBytes);
        var pipes = new Pipe[5];
        for (var input = 0; input < 5; input++)
        {
            pipes[input] = SmallPipe();
            demux.Attach(input, new It930xTsOutput(pipes[input]));
        }
        return (demux, pipes);
    }

    /// <summary>出口に渡ったパケットの (入力, 番号)。どれも先頭が 0x47 に戻っていること</summary>
    private static List<(int Input, int Number)> Received(Pipe pipe)
    {
        var got = new List<(int, int)>();
        if (!pipe.Reader.TryRead(out var result)) return got;
        var bytes = System.Buffers.BuffersExtensions.ToArray(result.Buffer);
        pipe.Reader.AdvanceTo(result.Buffer.End);
        if (bytes.Length % 188 != 0) throw new InvalidOperationException($"188 バイトの倍数でない ({bytes.Length})");
        for (var at = 0; at < bytes.Length; at += 188)
        {
            if (bytes[at] != 0x47) throw new InvalidOperationException($"先頭が 0x{bytes[at]:X2}");
            got.Add((bytes[at + 1], bytes[at + 2]));
        }
        return got;
    }

    [Test]
    public async Task 混ざった_5_本を入力ごとに分けて同期バイトを_0x47_に戻す()
    {
        var (demux, pipes) = Demux();
        demux.Push(Mixed(10));
        for (var input = 0; input < 5; input++)
        {
            await Assert.That(Received(pipes[input])).IsEquivalentTo(Enumerable.Range(0, 10).Select(number => (input, number)).ToList());
            await Assert.That(demux.Packets[input]).IsEqualTo(10L);
        }
        await Assert.That(demux.Skipped + demux.Unknown + demux.Lost).IsEqualTo(0L);
    }

    [Test]
    [Arguments(1)]
    [Arguments(7)]
    [Arguments(187)]
    [Arguments(188)]
    [Arguments(189)]
    [Arguments(1000)]
    public async Task 境目で切れた塊も同じに分ける(int size)
    {
        var (demux, pipes) = Demux();
        var data = Mixed(10);
        for (var at = 0; at < data.Length; at += size) demux.Push(data.AsSpan(at, Math.Min(size, data.Length - at)));
        for (var input = 0; input < 5; input++)
        {
            await Assert.That(Received(pipes[input])).IsEquivalentTo(Enumerable.Range(0, 10).Select(number => (input, number)).ToList());
        }
        await Assert.That(demux.Skipped + demux.Unknown + demux.Lost).IsEqualTo(0L);
    }

    [Test]
    public async Task 知らない同期バイトのパケットは捨てて数える()
    {
        var (demux, pipes) = Demux();
        // 揃ったあとに、書き換えていないパケット (0x47) と、決めていない値 (0x99) が間に入る
        demux.Push([.. Packet(0, 0), .. Packet(0, 1), .. Packet(1, 0, 0x47), .. Packet(0, 2), .. Packet(2, 0, 0x99), .. Packet(0, 3)]);
        await Assert.That(Received(pipes[0])).IsEquivalentTo(new List<(int, int)> { (0, 0), (0, 1), (0, 2), (0, 3) });
        await Assert.That(Received(pipes[1])).IsEmpty();
        await Assert.That(demux.Unknown).IsEqualTo(2L);
        await Assert.That(demux.Skipped + demux.Lost).IsEqualTo(0L);
    }

    [Test]
    public async Task 揃っていない先頭は飛ばして数える()
    {
        var (demux, pipes) = Demux();
        // 100 バイトの半端。途中に同期バイトと同じ値があっても、188 バイト先が同期バイトでなければ揃えない
        var head = new byte[100];
        head[30] = 0x17;
        demux.Push([.. head, .. Mixed(3)]);
        await Assert.That(demux.Skipped).IsEqualTo(100L);
        await Assert.That(demux.Lost).IsEqualTo(0L);
        for (var input = 0; input < 5; input++) await Assert.That(Received(pipes[input]).Count).IsEqualTo(3);
    }

    [Test]
    public async Task 途中で欠けたら揃え直す()
    {
        var (demux, pipes) = Demux();
        // 入力 0 の 4 番目のパケットの 10 バイト目から 50 バイトが抜けた
        var packets = Enumerable.Range(0, 10).Select(number => Packet(0, number)).ToList();
        packets[4] = [.. packets[4].Take(10), .. packets[4].Skip(60)];
        demux.Push([.. packets.SelectMany(packet => packet)]);
        // 4 番目は次のパケットの先頭 50 バイトまでを含めて渡る (欠けを見分けられない)。5 番目の残り 138 バイトを飛ばして、6 番目から揃え直す
        var got = Received(pipes[0]);
        await Assert.That(got.Select(item => item.Number)).IsEquivalentTo(new[] { 0, 1, 2, 3, 4, 6, 7, 8, 9 });
        await Assert.That(demux.Lost).IsEqualTo(1L);
        await Assert.That(demux.Skipped).IsEqualTo(138L);
    }

    [Test]
    [Arguments(1)]
    [Arguments(100)]
    [Arguments(188)]
    [Arguments(189)]
    [Arguments(500)]
    public async Task 知らない同期バイトと揃え直しは境目で切れても同じに数える(int size)
    {
        var (demux, pipes) = Demux();
        var packets = Enumerable.Range(0, 10).Select(number => Packet(0, number)).ToList();
        packets[2] = Packet(1, 0, 0x47);
        packets[6] = [.. packets[6].Take(10), .. packets[6].Skip(60)];
        var data = packets.SelectMany(packet => packet).ToArray();
        for (var at = 0; at < data.Length; at += size) demux.Push(data.AsSpan(at, Math.Min(size, data.Length - at)));
        await Assert.That(Received(pipes[0]).Select(item => item.Number)).IsEquivalentTo(new[] { 0, 1, 3, 4, 5, 6, 8, 9 });
        await Assert.That(demux.Unknown).IsEqualTo(1L);
        await Assert.That(demux.Lost).IsEqualTo(1L);
        await Assert.That(demux.Skipped).IsEqualTo(138L);
    }

    [Test]
    public async Task 出口を付け替えたら前の選局のパケットは新しい出口に入らない()
    {
        var demux = new It930xTsDemux(It930xBridge.SyncBytes);
        var first = SmallPipe();
        demux.Attach(0, new It930xTsOutput(first));
        demux.Push([.. Packet(0, 0), .. Packet(0, 1)]);
        var second = SmallPipe();
        var old = demux.Attach(0, new It930xTsOutput(second));
        old!.Complete();
        demux.Push([.. Packet(0, 2), .. Packet(0, 3)]);
        await Assert.That(Received(first).Select(item => item.Number)).IsEquivalentTo(new[] { 0, 1 });
        await Assert.That(Received(second).Select(item => item.Number)).IsEquivalentTo(new[] { 2, 3 });
        // 出口が無い入力も数える
        demux.Detach(0)!.Complete();
        demux.Push([.. Packet(0, 4), .. Packet(0, 5)]);
        await Assert.That(demux.Packets[0]).IsEqualTo(6L);
    }

    [Test]
    public async Task 同期バイトに_0x47_や重なった値は使えない()
    {
        Assert.Throws<ArgumentException>(() => new It930xTsDemux([0x17, 0x47]));
        Assert.Throws<ArgumentException>(() => new It930xTsDemux([0x17, 0x17]));
        await Task.CompletedTask;
    }

    // ---------------------------------------------------------------------
    // 受信機ごとの出口
    // ---------------------------------------------------------------------

    [Test]
    public async Task 読む側が詰まったらその受信機のパケットだけを捨てて数え_追いついたらまた詰める()
    {
        var pipe = SmallPipe(pause: 188 * 4, resume: 188 * 2);
        var output = new It930xTsOutput(pipe);
        for (var i = 0; i < 5; i++) output.Write(Packet(0, i));
        output.Commit();
        // 溢れている間は待たずに捨てる
        for (var i = 5; i < 8; i++) output.Write(Packet(0, i));
        output.Commit();
        await Assert.That(output.Packets).IsEqualTo(5L);
        await Assert.That(output.Dropped).IsEqualTo(3L);
        await Assert.That(pipe.Reader.TryRead(out var first)).IsTrue();
        await Assert.That(first.Buffer.Length).IsEqualTo(188L * 5);
        pipe.Reader.AdvanceTo(first.Buffer.End);
        // 読む側が追いついたら、また詰める
        output.Write(Packet(0, 8));
        output.Commit();
        await Assert.That(output.Packets).IsEqualTo(6L);
        await Assert.That(pipe.Reader.TryRead(out var second)).IsTrue();
        await Assert.That(second.Buffer.Length).IsEqualTo(188L);
    }

    [Test]
    public async Task 読む側が閉じたら詰めるのをやめる()
    {
        var pipe = SmallPipe();
        var output = new It930xTsOutput(pipe);
        pipe.Reader.Complete();
        output.Write(Packet(0, 0));
        output.Commit();
        await Assert.That(output.Closed).IsTrue();
        output.Write(Packet(0, 1));
        output.Commit();
        await Assert.That(output.Packets).IsEqualTo(1L);
        await Assert.That(output.Dropped).IsEqualTo(0L);
    }

    [Test]
    public async Task 出口の読み出し側は詰めたパケットを読んでから尽きる()
    {
        var output = new It930xTsOutput();
        output.Write(Packet(0, 0));
        output.Write(Packet(0, 1));
        output.Commit();
        output.Complete();
        var read = new MemoryStream();
        var buffer = new byte[4096];
        int got;
        while ((got = output.Output.Read(buffer, 0, buffer.Length)) > 0) read.Write(buffer, 0, got);
        await Assert.That(read.Length).IsEqualTo(188L * 2);
        output.Output.Dispose();
    }

    // ---------------------------------------------------------------------
    // --it930x-probe --ts
    // ---------------------------------------------------------------------

    [Test]
    public async Task probe_の_ts_は秒数を整数で受ける()
    {
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--ts", "10"])!.Ts).IsEqualTo(TimeSpan.FromSeconds(10));
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--port", "1-2", "--ts", "3", "--trace"]))
            .IsEqualTo(new It930xProbe.Options("1-2", true, TimeSpan.FromSeconds(3)));
        await Assert.That(It930xProbe.Parse(["--it930x-probe"])!.Ts).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--ts"])).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--ts", "0"])).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--ts", "1.5"])).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--ts", "601"])).IsNull();
    }

    [Test]
    public async Task probe_の_ts_は経路を設定して_EP_0x84_を読み入力ごとの数を出す()
    {
        var usb = new FakeIt930x();
        usb.Ts.Enqueue([.. Packet(0, 0), .. Packet(4, 0), .. Packet(0, 1)]);
        usb.Ts.Enqueue([.. Packet(1, 0, 0x47), .. Packet(0, 2), .. Packet(4, 1)]);
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => usb, () => It930xFirmware.Code, output, _ => { }, null, TimeSpan.FromMilliseconds(100));
        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains("TS の経路: 設定しました");
        await Assert.That(text).Contains("2 回で 1128 バイト");
        await Assert.That(text).Contains("入力ごとのパケット: 0 (0x17) 3、1 (0x27) 0、2 (0x37) 0、3 (0x57) 0、4 (0x67) 2");
        await Assert.That(text).Contains("飛ばした 0 バイト、知らない同期バイトのパケット 1 個、揃いが外れた 0 回");
        // 読みを出してから入力を開け、終わったら入力を閉じて EP 0x84 をリセットしてから読みを閉じる。そのあと REBOOT する
        var log = usb.Log;
        var opened = log.IndexOf($"TS {It930xBridge.TsTransferSize} {It930xBridge.TsDepth}");
        await Assert.That(opened).IsGreaterThan(log.IndexOf("W DA7C=67"));
        await Assert.That(log.Skip(opened + 1).Take(6)).IsEquivalentTo(new[] { "W DA4C=01", "W DA4D=01", "W DA4E=01", "W DA4F=01", "W DA50=01", "W DA5A=1F" });
        var closed = log.IndexOf("TS 閉じる");
        await Assert.That(log.Skip(closed - 7).Take(7)).IsEquivalentTo(new[] { "W DA4C=00", "W DA4D=00", "W DA4E=00", "W DA4F=00", "W DA50=00", "W DA1D=01", "W DA1D=00" });
        await Assert.That(log.IndexOf("REBOOT")).IsGreaterThan(closed);
        // 閉じたあとにブリッジの TS の経路の状態を出す
        await Assert.That(text).Contains("ブリッジ: 残りのバッファ");
    }

    // ---------------------------------------------------------------------
    // --tune --steps
    // ---------------------------------------------------------------------

    [Test]
    public async Task steps_は受信機の数を増えていく並びで書く()
    {
        await Assert.That(It930xSteps.ParseSteps("2,3,5", 5)).IsEquivalentTo(new[] { 2, 3, 5 });
        await Assert.That(It930xSteps.ParseSteps("1", 1)).IsEquivalentTo(new[] { 1 });
        await Assert.That(It930xSteps.ParseSteps("2,2", 5)).IsNull();
        await Assert.That(It930xSteps.ParseSteps("3,2", 5)).IsNull();
        await Assert.That(It930xSteps.ParseSteps("2,6", 5)).IsNull();
        await Assert.That(It930xSteps.ParseSteps("0,2", 5)).IsNull();
        await Assert.That(It930xSteps.ParseSteps("2,x", 5)).IsNull();
        await Assert.That(It930xSteps.ParseSteps(null, 5)).IsNull();
    }
}
