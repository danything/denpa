using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text;
using Denpa.Agent;
using static Denpa.Agent.Dt295ResidentProtocol;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 をチューナーとカードとして持つところ (Dt295.cs の名前と検出、Dt295ResidentTuner.cs)。
 * USB は偽物 (FakeResidentUsb。常駐イメージの偽物 FakeResident を制御転送の形で包む)、SBC2 と TS は合成のもの。
 */
public class Dt295Tests
{
    // ---------------------------------------------------------------------
    // 名前と検出
    // ---------------------------------------------------------------------

    [Test]
    public async Task 設定の_device_は_dt295_とポート()
    {
        await Assert.That(Dt295.Device("4-12.1")).IsEqualTo("dt295:4-12.1");
        await Assert.That(Dt295.Parse("dt295:4-12.1")).IsEqualTo("4-12.1");
        await Assert.That(Dt295.Parse("dt295:abc")).IsNull();
        await Assert.That(Dt295.Parse("zd1j:4-12.1")).IsNull();
        await Assert.That(Dt295.Is("dt295:1-2")).IsTrue();
        await Assert.That(Dt295.Is(null)).IsFalse();
    }

    private static void Usb(DirectoryInfo dir, string name, string vendor, string product)
    {
        var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
        File.WriteAllText(Path.Combine(at, "idVendor"), vendor + "\n");
        File.WriteAllText(Path.Combine(at, "idProduct"), product + "\n");
    }

    [Test]
    public async Task sysfs_から_06b8_103b_だけを並べる()
    {
        // sysfs は Linux だけ (インターフェースの名前の「:」は Windows のファイル名に使えない)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("dt295sysfs");
        try
        {
            Usb(dir, "1-2", "06b8", "103b");
            Usb(dir, "1-3", "054c", "04b2");
            Usb(dir, "1-2:1.0", "06b8", "103b");
            Usb(dir, "2-1.4", "06b8", "103b");
            await Assert.That(Dt295.Ports(dir.FullName, null)).IsEquivalentTo(new[] { "1-2", "2-1.4" });
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    [Arguments(0x06B8, 0x103B, "PIXELA PIX-DT295", true)]
    [Arguments(0x06B8, 0x103C, "PIXELA PIX-DT295 W", false)]
    [Arguments(0x06B8, 0x1038, "PIXELA PIX-DT420", false)]
    [Arguments(0x06B8, 0x1039, "PIXELA PIX-DT410", false)]
    [Arguments(0x04C5, 0x202F, "PIX-DTxxx (SPI モード)", false)]
    public async Task 公式_INF_の_ID_を見分けて_DT295_だけを使う(int vendor, int product, string name, bool supported)
    {
        var model = Dt295.Find(vendor, product);
        await Assert.That(model).IsNotNull();
        await Assert.That(model!.Name).IsEqualTo(name);
        await Assert.That(model.Supported).IsEqualTo(supported);
    }

    [Test]
    public async Task 未確認の機材は_USB_に触らずに断る()
    {
        var opened = 0;
        IUsbDevice Open(Dt295Model model)
        {
            opened++;
            return new FakeResidentUsb(new FakeResident());
        }
        foreach (var model in Dt295.Family.Where(model => !model.Supported))
        {
            var error = Assert.Throws<IOException>(() => Dt295.OpenUsb("3-1", _ => model, Open));
            await Assert.That(error.Message).Contains(model.Name);
            await Assert.That(error.Message).Contains("未確認");
        }
        Assert.Throws<IOException>(() => Dt295.OpenUsb("3-1", _ => null, Open));
        await Assert.That(opened).IsEqualTo(0);
    }

    [Test]
    public async Task sysfs_から同じドライバーの機材を見分けて並べる()
    {
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("dt295family");
        try
        {
            Usb(dir, "1-1", "06b8", "103b");
            Usb(dir, "1-2", "06b8", "103c");
            Usb(dir, "1-3", "06b8", "1038");
            Usb(dir, "1-6", "06b8", "103a");
            await Assert.That(Dt295.Identify(dir.FullName, "1-3")?.Name).IsEqualTo("PIXELA PIX-DT420");
            await Assert.That(Dt295.Identify(dir.FullName, "1-6")).IsNull();
            List<string> warnings = [];
            await Assert.That(Dt295.Ports(dir.FullName, warnings.Add)).IsEquivalentTo(new[] { "1-1" });
            await Assert.That(warnings.Count).IsEqualTo(2);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task dt295_の_device_は開かずに常駐方式のチューナーにする()
    {
        using var tuner = TunerPool.OpenDevice("dt295:1-2", null);
        await Assert.That(tuner).IsTypeOf<Dt295ResidentTuner>();
        await Assert.That(tuner.Tuned).IsFalse();
        Assert.Throws<IOException>(() => TunerPool.OpenDevice("dt295:bad", null));
    }

    // ---------------------------------------------------------------------
    // ボード
    // ---------------------------------------------------------------------

    private static int _ports;

    /// <summary>テストごとに別のポート (ボードの置き場はプロセスで 1 つ)</summary>
    private static string NewPort() => $"9-{Interlocked.Increment(ref _ports)}";

    private static (FakeResident Resident, FakeResidentUsb Usb, Dt295ResidentImage Image) Device()
    {
        var bundle = FakeBundle.Create();
        var resident = new FakeResident(bundle);
        return (resident, new FakeResidentUsb(resident), Dt295ResidentImage.Parse(bundle.Bytes));
    }

    private static Dt295ResidentBoard Acquire(string port, FakeResidentUsb usb, Dt295ResidentImage image, Action? powerCycle = null) =>
        Dt295ResidentBoard.Acquire(port, () => usb, powerCycle, image, () => usb.Resident.Now, ms => usb.Resident.Now += ms);

    [Test]
    public async Task 公式のファームウェアで動いた機材は電源を入れ直してから入れる()
    {
        var (resident, usb, image) = Device();
        resident.Poke(Dt295ResidentLoader.StateRegister, [0x00, 0x11]);
        var cycles = 0;
        var port = NewPort();
        var board = Acquire(port, usb, image, () =>
        {
            cycles++;
            resident.Poke(Dt295ResidentLoader.StateRegister, [0, 0]);
        });
        try
        {
            await Assert.That(cycles).IsEqualTo(1);
            await Assert.That(resident.Initialized).IsTrue();
            await Assert.That(resident.Peek(Dt295ResidentImage.Hook, 8)).IsEquivalentTo(FakeBundle.Patch);
            // 2 回目はそのまま同じボード
            await Assert.That(Acquire(port, usb, image)).IsSameReferenceAs(board);
            board.Release();
        }
        finally
        {
            board.Release();
            Dt295ResidentBoard.CloseIfIdle(port);
        }
        // 閉じるときは常駐イメージを残して手放す
        await Assert.That(resident.Initialized).IsFalse();
        await Assert.That(usb.Disposed).IsTrue();
    }

    [Test]
    public async Task 電源を入れ直せなければ断る()
    {
        var (resident, usb, image) = Device();
        resident.Poke(Dt295ResidentLoader.StateRegister, [0x00, 0x11]);
        await Assert.That(() => Acquire(NewPort(), usb, image)).Throws<Dt295ResidentColdException>();
        await Assert.That(usb.Disposed).IsTrue();
    }

    // ---------------------------------------------------------------------
    // チューナー
    // ---------------------------------------------------------------------

    private static byte[] Packets(int count, int pid)
    {
        var bytes = new byte[188 * count];
        for (var i = 0; i < count; i++)
        {
            bytes[i * 188] = 0x47;
            bytes[i * 188 + 1] = (byte)(pid >> 8);
            bytes[i * 188 + 2] = (byte)pid;
            bytes[i * 188 + 3] = (byte)(0x90 | (i & 15));
        }
        return bytes;
    }

    private static byte[] MuxFrames(uint channel, ref uint sequence, ReadOnlySpan<byte> payload)
    {
        var bytes = new List<byte>();
        for (var at = 0; at < payload.Length; at += Dt295ResidentTs.FramePayload)
        {
            var chunk = payload.Slice(at, Math.Min(Dt295ResidentTs.FramePayload, payload.Length - at));
            var frame = new byte[Dt295ResidentTs.FrameBytes];
            BinaryPrimitives.WriteUInt32BigEndian(frame, Dt295ResidentTs.MuxMagic);
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(4), channel);
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(8), sequence++);
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(12), (uint)chunk.Length);
            chunk.CopyTo(frame.AsSpan(Dt295ResidentTs.FrameHeader));
            bytes.AddRange(frame);
        }
        return [.. bytes];
    }

    [Test]
    public async Task 選局すると読みを出してから_TUNE_し_落ち着いたあとの_TS_を渡す()
    {
        var (resident, usb, image) = Device();
        resident.StreamFormat = FormatMux;
        var activeChannel = 0u;
        var muxSequence = 0u;
        var serviceCalls = 0;
        resident.OnTune = () =>
        {
            activeChannel = resident.Commands.Last(item => item.Command == CommandTune).Channel;
            muxSequence = 0;
            serviceCalls = 0;
            // 選局の途中で出る MUX の 0 番 (まだ落ち着いていない TS)
            usb.Ts.Enqueue(MuxFrames(activeChannel, ref muxSequence, Packets(2, 0x110)));
        };
        resident.OnService = () =>
        {
            // Settle の中の SERVICE (1 回目) も落ち着く前。Serve のあとの 2 回目から落ち着いたあとの TS を出す
            var pid = ++serviceCalls == 1 ? 0x110 : 0x111;
            if (serviceCalls <= 2) usb.Ts.Enqueue(MuxFrames(activeChannel, ref muxSequence, Packets(serviceCalls == 1 ? 2 : 10, pid)));
        };
        var port = NewPort();
        using (var tuner = new Dt295ResidentTuner("DT295", () => Acquire(port, usb, image), () => Dt295ResidentBoard.CloseIfIdle(port)))
        {
            tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
            await Assert.That(tuner.Tuned).IsTrue();
            await Assert.That(tuner.Board!.Session.TunePollMs).IsEqualTo(1);
            // 読みを出したのは TUNE より前
            await Assert.That(usb.StreamOpenedBeforeTune).IsTrue();
            var buffer = new byte[188 * 10];
            var got = 0;
            while (got < buffer.Length) got += await tuner.Output.ReadAsync(buffer.AsMemory(got));
            // 落ち着く前の 0x110 は捨て、MUX の連番を保ったまま Serve のあとの 0x111 から流れる
            for (var i = 0; i < 10; i++)
            {
                await Assert.That(buffer[188 * i]).IsEqualTo((byte)0x47);
                await Assert.That(buffer[188 * i + 2]).IsEqualTo((byte)0x11);
            }

            // 選局し直すと、前の受信を止めてから
            tuner.Tune(ChannelTable.Parse("BS15")!, ChannelTable.NoStreamId);
            int stops;
            uint channel;
            // SERVICE を送るスレッドも書き足すので、偽物の鍵の中で数える
            lock (resident)
            {
                stops = resident.Commands.Count(item => item.Command == CommandStop);
                channel = resident.Commands.Last(item => item.Command == CommandTune).Channel;
            }
            await Assert.That(stops).IsGreaterThanOrEqualTo(1);
            await Assert.That(channel).IsEqualTo(1u);
        }
        await Assert.That(usb.Disposed).IsTrue();
    }

    [Test]
    public async Task TS_が来なければ止めて断る()
    {
        var (_, usb, image) = Device();
        var port = NewPort();
        using var tuner = new Dt295ResidentTuner("DT295", () => Acquire(port, usb, image), () => Dt295ResidentBoard.CloseIfIdle(port), TimeSpan.FromMilliseconds(200));
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("TS が来ません");
        await Assert.That(tuner.Tuned).IsFalse();
    }

    [Test]
    public async Task 受からなければ同期しなかったと伝える()
    {
        var (resident, usb, image) = Device();
        resident.NeverReady = true;
        var port = NewPort();
        using var tuner = new Dt295ResidentTuner("DT295", () => Acquire(port, usb, image), () => Dt295ResidentBoard.CloseIfIdle(port));
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
    }

    // ---------------------------------------------------------------------
    // カード
    // ---------------------------------------------------------------------

    [Test]
    public async Task カードは_ATR_を読み_APDU_を_32_バイトずつ渡す()
    {
        var (resident, usb, image) = Device();
        resident.CardInserted = true;
        var port = NewPort();
        using (var card = new Dt295ResidentCard("DT295 Card Reader", () => Acquire(port, usb, image), () => resident.Now, ms => resident.Now += ms))
        {
            await Assert.That(card.Reset()).IsEquivalentTo(FakeResident.Atr);
            // 電源が入ったままもう一度リセットしても通る (B-CAS を読む処理がリセットし直す)
            await Assert.That(card.Reset()).IsEquivalentTo(FakeResident.Atr);
            var apdu = Enumerable.Range(0, 70).Select(i => (byte)i).ToArray();
            var answer = card.Transmit(apdu);
            // 偽物はそのまま返して 90 00 を付ける
            await Assert.That(answer).IsEquivalentTo(apdu.Concat(new byte[] { 0x90, 0x00 }).ToArray());
            await Assert.That(resident.CardTxChunks).IsEqualTo(3);
        }
        Dt295ResidentBoard.CloseIfIdle(port);
        await Assert.That(usb.Disposed).IsTrue();
    }

    [Test]
    public async Task カードが無ければ_CardAbsentException()
    {
        var (_, usb, image) = Device();
        var port = NewPort();
        using var card = new Dt295ResidentCard("DT295 Card Reader", () => Acquire(port, usb, image));
        await Assert.That(() => card.Reset()).Throws<CardAbsentException>();
        card.Dispose();
        Dt295ResidentBoard.CloseIfIdle(port);
    }

    [Test]
    public async Task card_は_PIX_DT295_が無くても_1_行出し_どんな失敗も行にする()
    {
        var none = new StringWriter();
        Dt295.DescribeCards([], none);
        await Assert.That(none.ToString().Trim()).IsEqualTo("PIXELA PIX-DT295: 見つかりません");

        var output = new StringWriter();
        Dt295.DescribeCards(
        [
            new CardLinkCandidate("PIXELA PIX-DT295 9-15 Card Reader", () => throw new DllNotFoundException("IOKit を読み込めません")),
            new CardLinkCandidate("PIXELA PIX-DT295 9-16 Card Reader", () => throw new IOException("usb 9-16 を開けません")),
        ], output);
        var lines = output.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        await Assert.That(lines.Length).IsEqualTo(2);
        await Assert.That(lines[0]).StartsWith("内蔵 PIXELA PIX-DT295 9-15 Card Reader: DllNotFoundException: IOKit を読み込めません (");
        await Assert.That(lines[1]).StartsWith("内蔵 PIXELA PIX-DT295 9-16 Card Reader: usb 9-16 を開けません (");
    }
}

/// <summary>
/// <see cref="FakeResident"/> を USB の制御転送の形で包んだもの。0xBC の読み書きはメモリー、wValue 0x0C7D・wIndex 0x4620 の OUT は要求で、
/// 応答を受け渡し場所 (0xC4620) に置く。TS は <see cref="Ts"/> に積んだものを EP 0x81 から返す
/// </summary>
internal sealed class FakeResidentUsb(FakeResident resident) : IUsbDevice
{
    private byte[] _response = new byte[PacketSize];

    public FakeResident Resident => resident;
    public ConcurrentQueue<byte[]> Ts { get; } = new();
    public List<string> Log { get; } = [];
    public bool Disposed { get; private set; }
    public bool StreamOpenedBeforeTune { get; private set; }
    private bool _streamOpen;

    public string Name => "fake dt295";

    private static uint Address(ushort value, ushort index) => ((uint)(value >> 8) << 16) | index;

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        var address = Address(value, index);
        if (address == Dt295ResidentLink.Staging)
        {
            _response.AsSpan(0, data.Length).CopyTo(data);
            return data.Length;
        }
        lock (resident) resident.Read(address, data);
        return data.Length;
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        lock (Log) Log.Add($"{requestType:X2} {request:X2} {value:X4} {index:X4} {Convert.ToHexString(data)}");
        if (value == 0x0C7D && index == 0x4620)
        {
            var response = new byte[PacketSize];
            lock (resident)
            {
                if (Word(data, 8) == ResidentDispatch && Word(data, 12) == CommandTune && !StreamOpenedBeforeTune) StreamOpenedBeforeTune = _streamOpen;
                resident.Exchange(data, response);
            }
            _response = response;
            return;
        }
        lock (resident) resident.Write(Address(value, index), data);
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs) => throw new NotSupportedException();

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs) => 0;

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        _streamOpen = true;
        return new InStream(this);
    }

    private sealed class InStream(FakeResidentUsb usb) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (usb.Ts.TryDequeue(out var chunk))
            {
                chunk.CopyTo(buffer);
                return chunk.Length;
            }
            if (timeoutMs > 0) Thread.Sleep(Math.Min(timeoutMs, 5));
            return 0;
        }

        public void Dispose()
        {
        }
    }

    public void Dispose() => Disposed = true;
}
