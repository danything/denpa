using System.Buffers.Binary;
using System.Text;
using Denpa.Agent;
using static Denpa.Agent.Dt295ResidentProtocol;

namespace Denpa.Agent.Tests;

/*
 * 常駐方式の PIX-DT295 (Dt295Resident*.cs)。機材なしで確かめられる所: 同梱のファームウェアと SBC2 の読み取り、要求の形、
 * 導入・引き継ぎ・選局・停止・手放す手順 (常駐イメージの偽物を相手に)、TS の取り出し、ウィンドウの切り替え、ポートの電源の入れ直し。
 * SBC2 と常駐イメージはテストの中で作る偽物で、同梱のファームウェアは読めることと SHA-256 だけを確かめる。
 */
public class Dt295ResidentTests
{
    // ---------------------------------------------------------------------
    // ファームウェア
    // ---------------------------------------------------------------------

    [Test]
    public async Task 同梱のファームウェアが読める()
    {
        var image = Dt295ResidentImage.Bundled;
        await Assert.That(image.Resident.Length).IsEqualTo(Dt295ResidentImage.Bytes);
        await Assert.That(image.Original(Dt295ResidentImage.Code, Dt295ResidentImage.CodeBytes).Length).IsEqualTo(Dt295ResidentImage.CodeBytes);
        // 導入すると hook の値が変わる
        var original = image.Original(Dt295ResidentImage.Hook, Dt295ResidentImage.HookBytes).ToArray();
        await Assert.That(image.Installed(Dt295ResidentImage.Hook, Dt295ResidentImage.HookBytes)).IsNotEquivalentTo(original);
    }

    [Test]
    public async Task 偽の_SBC2_から_body_と_hook_を組み立てる()
    {
        var bundle = FakeBundle.Create();
        var image = Dt295ResidentImage.Parse(bundle.Bytes);
        // body の 4 バイト目は配置換えで、body の中の 0x40 を指すアドレスになる
        var body = image.Installed(Dt295ResidentImage.Body, 8);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(body.AsSpan(4))).IsEqualTo(Dt295ResidentImage.Body + 0x40);
        await Assert.That(body[0]).IsEqualTo((byte)0xB0);
        // hook は書き換えの値、元の写しは boot0 の値
        await Assert.That(image.Installed(Dt295ResidentImage.Hook, 8)).IsEquivalentTo(FakeBundle.Patch);
        await Assert.That(image.Original(Dt295ResidentImage.Hook, 8).ToArray()).IsEquivalentTo(bundle.Boot0(Dt295ResidentImage.Hook, 8));
        await Assert.That(image.Build.ToArray()).IsEquivalentTo(FakeBundle.BuildId);
    }

    [Test]
    public async Task 常駐イメージの合計が合わなければ断る()
    {
        var bundle = FakeBundle.Create();
        bundle.Bytes[bundle.ResidentOffset + 100] ^= 1;
        await Assert.That(() => Dt295ResidentImage.Parse(bundle.Bytes)).Throws<InvalidDataException>();
    }

    [Test]
    public async Task 配置換えの値が元と合わなければ断る()
    {
        var bundle = FakeBundle.Create();
        bundle.Bytes[bundle.BodyOffset + 7] ^= 1;
        await Assert.That(() => Dt295ResidentImage.Parse(bundle.Bytes)).Throws<InvalidDataException>();
    }

    // ---------------------------------------------------------------------
    // 要求の形
    // ---------------------------------------------------------------------

    [Test]
    public async Task 要求は_BE32_の並びと_40_バイトのデータ()
    {
        var data = new byte[DataSize];
        data[0] = 0xAA;
        var packet = Pack(7, ResidentDispatch, CommandTune, 1, 0x1234, data);
        await Assert.That(Convert.ToHexString(packet, 0, 24)).IsEqualTo("585A443100000007000000090000002200000001" + "00001234");
        await Assert.That(packet[24]).IsEqualTo((byte)0xAA);
        var response = (byte[])packet.Clone();
        await Assert.That(Matches(response, 7)).IsTrue();
        await Assert.That(Matches(response, 8)).IsFalse();
    }

    [Test]
    public async Task 地上波の選局は_kHz_と階層()
    {
        var resident = new FakeResident();
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var tuning = ChannelTable.Parse("T27")!;
        session.Tune(Dt295ResidentProbe.Request(tuning, tuning.StreamId), streaming: true);
        var tune = resident.Commands.Single(item => item.Command == CommandTune);
        // 557142857 Hz → 557143 kHz、A・B・C 全部、TS を出す、TSID は指さない
        await Assert.That(tune.Channel).IsEqualTo(0u);
        await Assert.That(Convert.ToHexString(tune.Data, 0, 9)).IsEqualTo("00088057FFFFE00100");
        await Assert.That(session.RequestValid).IsTrue();
        await Assert.That(session.Streaming).IsTrue();
    }

    [Test]
    public async Task 衛星の選局は_IF_に局発を足し_TSID_を指す()
    {
        var resident = new FakeResident();
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var tuning = ChannelTable.Parse("BS15:16625")!;
        session.Tune(Dt295ResidentProbe.Request(tuning, tuning.StreamId), streaming: true);
        var tune = resident.Commands.Single(item => item.Command == CommandTune);
        await Assert.That(tune.Channel).IsEqualTo(1u);
        await Assert.That(BinaryPrimitives.ReadUInt32BigEndian(tune.Data)).IsEqualTo(1318000u + SatelliteLocalKhz);
        // TSID 16625 = 0x40F1、階層は無し、TS を出す、TSID を指した
        await Assert.That(Convert.ToHexString(tune.Data, 4, 5)).IsEqualTo("40F1000101");
    }

    [Test]
    public async Task 落ち着かなければ時間切れで止める()
    {
        var resident = new FakeResident { NeverReady = true };
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var tuning = ChannelTable.Parse("T27")!;
        await Assert.That(() => session.Tune(Dt295ResidentProbe.Request(tuning, tuning.StreamId), streaming: true)).Throws<TimeoutException>();
        // 受理された選局は 1 回止めてある
        await Assert.That(resident.Commands.Count(item => item.Command == CommandStop)).IsEqualTo(1);
        await Assert.That(session.RequestValid).IsFalse();
        await Assert.That(session.StopPending).IsFalse();
    }

    [Test]
    public async Task 停止は_STOP_のあと止まり切るまで_SERVICE()
    {
        var resident = new FakeResident();
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var tuning = ChannelTable.Parse("T27")!;
        session.Tune(Dt295ResidentProbe.Request(tuning, tuning.StreamId), streaming: true);
        session.Stop(0);
        await Assert.That(session.StopPending).IsTrue();
        session.WaitStopped();
        await Assert.That(session.StopPending).IsFalse();
        await Assert.That(resident.Capturing).IsFalse();
    }

    [Test]
    public async Task 応答の番号が違えば投げる()
    {
        var resident = new FakeResident { WrongSequence = true };
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        await Assert.That(() => session.QueryOverview()).Throws<Dt295ResidentException>();
    }

    // ---------------------------------------------------------------------
    // 導入・引き継ぎ・手放す
    // ---------------------------------------------------------------------

    [Test]
    public async Task 起動直後の機材に入れて初期化する()
    {
        var bundle = FakeBundle.Create();
        var image = Dt295ResidentImage.Parse(bundle.Bytes);
        var resident = new FakeResident(bundle);
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var outcome = Dt295ResidentLoader.Start(resident, session, image);
        await Assert.That(outcome).IsEqualTo(Dt295ResidentLoader.Outcome.Installed);
        // body と hook が導入したあとの値になり、常駐イメージが全部書かれている
        await Assert.That(resident.Peek(Dt295ResidentImage.Hook, 8)).IsEquivalentTo(FakeBundle.Patch);
        await Assert.That(resident.Peek(Dt295ResidentImage.Body, 64)).IsEquivalentTo(image.Installed(Dt295ResidentImage.Body, 64));
        await Assert.That(resident.Resident).IsEquivalentTo(image.Resident.ToArray());
        await Assert.That(resident.BlockWrites).IsTrue();
        await Assert.That(resident.Initialized).IsTrue();
    }

    [Test]
    public async Task 起動直後でなければ入れない()
    {
        var bundle = FakeBundle.Create();
        var image = Dt295ResidentImage.Parse(bundle.Bytes);
        var resident = new FakeResident(bundle);
        resident.Poke(Dt295ResidentLoader.StateRegister, [0x00, 0x11]);
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        await Assert.That(() => Dt295ResidentLoader.Start(resident, session, image)).Throws<Dt295ResidentColdException>();
        await Assert.That(resident.Peek(Dt295ResidentImage.Hook, 8)).IsEquivalentTo(bundle.Boot0(Dt295ResidentImage.Hook, 8));
    }

    [Test]
    public async Task 手放したイメージを次に引き継ぐ()
    {
        var bundle = FakeBundle.Create();
        var image = Dt295ResidentImage.Parse(bundle.Bytes);
        var resident = new FakeResident(bundle);
        var first = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        Dt295ResidentLoader.Start(resident, first, image);
        var tuning = ChannelTable.Parse("T27")!;
        first.Tune(Dt295ResidentProbe.Request(tuning, tuning.StreamId), streaming: true);
        // 選局したまま持ち主がいなくなった (エージェントが落ちた)
        resident.BlockWrites = false;
        var second = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        var outcome = Dt295ResidentLoader.Start(resident, second, image);
        await Assert.That(outcome).IsEqualTo(Dt295ResidentLoader.Outcome.Adopted);
        await Assert.That(resident.Commands.Count(item => item.Command == CommandRecover)).IsGreaterThanOrEqualTo(1);
        await Assert.That(resident.Capturing).IsFalse();
        await Assert.That(resident.BlockWrites).IsTrue();
        Dt295ResidentLoader.Close(second);
        await Assert.That(resident.Initialized).IsFalse();
    }

    [Test]
    public async Task 違う常駐イメージは引き継がない()
    {
        var bundle = FakeBundle.Create();
        var image = Dt295ResidentImage.Parse(bundle.Bytes);
        var resident = new FakeResident(bundle);
        Dt295ResidentLoader.Start(resident, new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms), image);
        resident.Resident[200] ^= 1;
        var session = new Dt295ResidentSession(resident, () => resident.Now, ms => resident.Now += ms);
        await Assert.That(() => Dt295ResidentLoader.Start(resident, session, image)).Throws<Dt295ResidentColdException>();
        await Assert.That(resident.Commands.Count(item => item.Command == CommandRecover)).IsEqualTo(0);
    }

    // ---------------------------------------------------------------------
    // TS
    // ---------------------------------------------------------------------

    private static byte[] Packet(int pid, byte fill)
    {
        var packet = new byte[188];
        Array.Fill(packet, fill);
        packet[0] = 0x47;
        packet[1] = (byte)(pid >> 8);
        packet[2] = (byte)pid;
        packet[3] = 0x10;
        return packet;
    }

    private static byte[] Frame(uint channel, uint sequence, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[Dt295ResidentTs.FrameBytes];
        BinaryPrimitives.WriteUInt32BigEndian(frame, Dt295ResidentTs.MuxMagic);
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(4), channel);
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(8), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(12), (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(16));
        return frame;
    }

    [Test]
    public async Task MUX_のフレームから_192_バイトの記録を_188_バイトにする()
    {
        // 192 バイトの記録 (188 + 4) を 5 つ並べ、496 バイトずつフレームに詰める
        var records = new List<byte>();
        for (var i = 0; i < 5; i++)
        {
            records.AddRange(Packet(0x100 + i, (byte)i));
            records.AddRange(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF });
        }
        var stream = new List<byte>();
        var sequence = 0u;
        for (var at = 0; at < records.Count; at += Dt295ResidentTs.FramePayload)
        {
            stream.AddRange(Frame(1, sequence++, records.Skip(at).Take(Dt295ResidentTs.FramePayload).ToArray()));
        }
        var ts = new Dt295ResidentTs(FormatMux, 1, 192);
        var got = new List<int>();
        // USB の転送の切れ目はフレームの切れ目と合わない
        var bytes = stream.ToArray();
        await Assert.That(ts.Push(bytes.AsSpan(0, 700), packet => got.Add(((packet[1] & 0x1F) << 8) | packet[2]))).IsTrue();
        await Assert.That(ts.Push(bytes.AsSpan(700), packet => got.Add(((packet[1] & 0x1F) << 8) | packet[2]))).IsTrue();
        await Assert.That(got).IsEquivalentTo(new[] { 0x100, 0x101, 0x102, 0x103, 0x104 });
    }

    [Test]
    public async Task MUX_の番号が飛んだら受け取らない()
    {
        var ts = new Dt295ResidentTs(FormatMux, 0, 188);
        var payload = Packet(0x11, 0);
        await Assert.That(ts.Push(Frame(0, 0, payload), _ => { })).IsTrue();
        await Assert.That(ts.Push(Frame(0, 2, payload), _ => { })).IsFalse();
        await Assert.That(ts.Broken).IsNotNull();
        await Assert.That(ts.Push(Frame(0, 3, payload), _ => { })).IsFalse();
    }

    [Test]
    public async Task そのままの_TS_はごみを捨てて同期を探す()
    {
        var ts = new Dt295ResidentTs(FormatRaw, 0, 188);
        var data = new List<byte>(new byte[] { 0x47, 1, 2, 3, 4 });
        for (var i = 0; i < 4; i++) data.AddRange(Packet(0x200 + i, 0x55));
        var count = 0;
        await Assert.That(ts.Push(data.ToArray(), _ => count++)).IsTrue();
        // 先頭の 5 バイトを捨て、2 つ続けて 0x47 が並んだ所から全部渡す
        await Assert.That(count).IsEqualTo(4);
        await Assert.That(ts.Discarded).IsEqualTo(5L);
    }

    // ---------------------------------------------------------------------
    // ウィンドウ・ポート
    // ---------------------------------------------------------------------

    [Test]
    public async Task ウィンドウを通した読みはバンクを切り替えてから戻す()
    {
        var usb = new FakeDt295Usb();
        foreach (var window in new[] { Dt295ResidentLink.ReadWindow, Dt295ResidentLink.WriteWindow })
        {
            usb.Memory[window + 1] = 0xF0;
        }
        var link = new Dt295ResidentLink(usb);
        link.Read(0x803A0010, new byte[8]);
        await Assert.That(usb.Log).IsEquivalentTo(new[]
        {
            "40 BC 0E00 9EBC 803A0000",
            "40 BC 0E00 9EBC 00F00000",
        });
    }

    [Test]
    public async Task ウィンドウがふだんの値でなければ触らない()
    {
        var usb = new FakeDt295Usb();
        var link = new Dt295ResidentLink(usb);
        await Assert.That(() => link.Read(0x80380000, new byte[4])).Throws<Dt295ResidentException>();
        await Assert.That(usb.Log).IsEmpty();
    }

    [Test]
    public async Task 要求は制御_OUT_で渡して受け渡し場所から読む()
    {
        var usb = new FakeDt295Usb();
        var link = new Dt295ResidentLink(usb);
        var request = Pack(1, Dt295ResidentProtocol.Ping, 0, 0, 0, new byte[DataSize]);
        link.Exchange(request, new byte[PacketSize]);
        await Assert.That(usb.Log.Single()).IsEqualTo($"40 BC 0C7D 4620 {Convert.ToHexString(request)}");
    }

    [Test]
    public async Task ポートの電源を切って入れ直す()
    {
        var sysfs = Directory.CreateTempSubdirectory("dt295-sysfs").FullName;
        try
        {
            // 機材の port は、ハブの側のポートへのリンク (電源を切ると機材のディレクトリは消える)
            Directory.CreateDirectory(Path.Combine(sysfs, "1-0:1.0", "usb1-port2"));
            Directory.CreateDirectory(Path.Combine(sysfs, "1-2"));
            Directory.CreateSymbolicLink(Path.Combine(sysfs, "1-2", "port"), Path.Combine("..", "1-0:1.0", "usb1-port2"));
            var devnum = Path.Combine(sysfs, "1-2", "devnum");
            File.WriteAllText(devnum, "9\n");
            // 電源を入れ直す間に、新しい番号でつながる (前の番号のままでは戻らない)
            var reconnect = Task.Run(async () =>
            {
                await Task.Delay(800);
                File.WriteAllText(devnum, "10\n");
            });
            UsbSysfs.PowerCycle(sysfs, "1-2", TimeSpan.FromSeconds(3));
            await reconnect;
            await Assert.That(File.ReadAllText(devnum)).IsEqualTo("10\n");
            await Assert.That(File.ReadAllText(Path.Combine(sysfs, "1-0:1.0", "usb1-port2", "disable"))).IsEqualTo("0");
            await Assert.That(() => UsbSysfs.PowerCycle(sysfs, "3-4", TimeSpan.FromSeconds(1))).Throws<IOException>();
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }
}

/// <summary>テストで作る SBC2。DT295 の分だけで、boot0 はでたらめな値、常駐イメージは説明と合計だけをそろえる</summary>
internal sealed class FakeBundle
{
    public static readonly byte[] Patch = [0x9F, 0x80, 0x00, 0x0E, 0x10, 0x00, 0xAB, 0xCD];
    public static readonly byte[] BuildId = [1, 2, 3, 4, 5, 6, 7, 8];

    public required byte[] Bytes { get; init; }
    public int ResidentOffset { get; init; }
    public int BodyOffset { get; init; }
    public int CodeOffset { get; init; }

    /// <summary>元の boot0 (写しの中の値)</summary>
    public byte[] Boot0(uint address, int length) => Bytes.AsSpan(CodeOffset + (int)(address - Dt295ResidentImage.Code), length).ToArray();

    public static byte[] ResidentImage()
    {
        var image = new byte[Dt295ResidentImage.Bytes];
        for (var i = 0; i < 0x1000; i++) image[i] = (byte)(i * 7);
        var meta = (int)(Dt295ResidentImage.Meta - Dt295ResidentImage.Base);
        uint[] words = [Dt295ResidentImage.HeaderMagic, AbiVersion, (uint)Dt295ResidentImage.Bytes, Dt295ResidentImage.Base,
            Dt295ResidentImage.ImmutableEnd, Dt295ResidentImage.ImmutableChecksum];
        for (var i = 0; i < words.Length; i++) BinaryPrimitives.WriteUInt32BigEndian(image.AsSpan(meta + i * 4), words[i]);
        BinaryPrimitives.WriteUInt32BigEndian(image.AsSpan((int)(Dt295ResidentImage.Commit - Dt295ResidentImage.Base)), Dt295ResidentImage.CommitMagic);
        BuildId.CopyTo(image, (int)(Dt295ResidentImage.BuildId - Dt295ResidentImage.Base));
        // 書き換えない範囲の合計を 0 にする
        var sum = 0u;
        for (var offset = 0; offset < (int)(Dt295ResidentImage.ImmutableEnd - Dt295ResidentImage.Base); offset += 4)
        {
            if (offset == (int)(Dt295ResidentImage.ImmutableChecksum - Dt295ResidentImage.Base)) continue;
            sum = unchecked(sum + BinaryPrimitives.ReadUInt32BigEndian(image.AsSpan(offset)));
        }
        BinaryPrimitives.WriteUInt32BigEndian(image.AsSpan((int)(Dt295ResidentImage.ImmutableChecksum - Dt295ResidentImage.Base)), unchecked(0u - sum));
        return image;
    }

    public static FakeBundle Create()
    {
        const int header = 64;
        const int profiles = header;
        const int references = profiles + 64;
        const int patches = references + 16;
        const int relocations = patches + 16;
        const int body = relocations + 12;
        const int bodySize = 0x80;
        const int patchData = body + bodySize;
        const int code = patchData + 8;
        var resident = code + Dt295ResidentImage.CodeBytes;
        var size = resident + Dt295ResidentImage.Bytes;
        var bytes = new byte[size];
        void Put(int at, uint value) => BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(at), value);
        Put(0, 0x53424332);
        Put(4, 1);
        Put(8, header);
        Put(12, (uint)size);
        Put(16, profiles);
        Put(20, 1);
        Put(24, body);
        Put(28, bodySize);
        Put(32, relocations);
        Put(36, 1);
        Put(40, (uint)resident);
        Put(44, (uint)Dt295ResidentImage.Bytes);
        // DT295 の分
        Put(profiles, 3);
        Put(profiles + 4, Dt295ResidentImage.Body);
        Put(profiles + 8, (uint)Dt295ResidentImage.BodyBytes);
        Put(profiles + 12, references);
        Put(profiles + 16, 1);
        Put(profiles + 20, patches);
        Put(profiles + 24, 1);
        // 元の boot0 の写し (コードの範囲全部)
        Put(references, Dt295ResidentImage.Code);
        Put(references + 4, (uint)Dt295ResidentImage.CodeBytes);
        Put(references + 8, (uint)code);
        for (var i = 0; i < Dt295ResidentImage.CodeBytes; i++) bytes[code + i] = (byte)(0x31 * i + 5);
        // hook の書き換え
        Put(patches, Dt295ResidentImage.Hook);
        Put(patches + 4, 8);
        Put(patches + 8, patchData);
        FakeBundle.Patch.CopyTo(bytes, patchData);
        // 配置換え 1 つ (body の 4 バイト目の 32 ビットの値が、body の中の 0x40 を指す)
        Put(relocations, 4);
        Put(relocations + 4, 32);
        Put(relocations + 8, 0x40);
        for (var i = 0; i < bodySize; i++) bytes[body + i] = (byte)(0xB0 + i);
        Put(body + 4, 0x40);
        ResidentImage().CopyTo(bytes, resident);
        return new FakeBundle { Bytes = bytes, ResidentOffset = resident, BodyOffset = body, CodeOffset = code };
    }
}

/// <summary>
/// 常駐方式の DT295 の偽物。boot0 のメモリー (状態・コード・body・hook) と、PING・常駐イメージの読み書き・
/// CAPABILITIES・DEVICE_QUERY・INITIALIZE・TUNE・SERVICE・STATUS・STOP・SHUTDOWN・RECOVER に答える。選局はすぐ落ち着く
/// </summary>
internal sealed class FakeResident : IDt295ResidentTransport
{
    private readonly Dictionary<uint, byte> _memory = [];

    public FakeResident(FakeBundle? bundle = null)
    {
        if (bundle is null)
        {
            Initialized = true;
            return;
        }
        Poke(Dt295ResidentImage.Code, bundle.Boot0(Dt295ResidentImage.Code, Dt295ResidentImage.CodeBytes));
        BuildId = FakeBundle.BuildId;
    }

    public long Now { get; set; }
    public bool BlockWrites { get; set; }
    public byte[] Resident { get; } = new byte[Dt295ResidentImage.Bytes];
    public byte[] BuildId { get; set; } = new byte[8];
    public bool Initialized { get; private set; }
    public bool Capturing { get; private set; }
    public bool NeverReady { get; set; }
    public bool WrongSequence { get; set; }
    public List<(uint Command, uint Channel, byte[] Data)> Commands { get; } = [];

    private uint _generation;
    private uint _phase;
    private bool _ready;
    private int _source;

    public void Poke(uint address, ReadOnlySpan<byte> data)
    {
        for (var i = 0; i < data.Length; i++) _memory[address + (uint)i] = data[i];
    }

    public byte[] Peek(uint address, int length) => [.. Enumerable.Range(0, length).Select(i => _memory.GetValueOrDefault(address + (uint)i))];

    public void Read(uint address, Span<byte> data)
    {
        for (var i = 0; i < data.Length; i++) data[i] = _memory.GetValueOrDefault(address + (uint)i);
    }

    public void Write(uint address, ReadOnlySpan<byte> data) => Poke(address, data);

    public void Exchange(ReadOnlySpan<byte> request, Span<byte> response)
    {
        request.CopyTo(response);
        if (WrongSequence) Put(response, 4, Word(request, 4) + 1);
        var operation = Word(request, 8);
        var address = Word(request, 12);
        var argument = Word(request, 16);
        var budget = Word(request, 20);
        var data = request.Slice(DataOffset, DataSize).ToArray();
        response[8..].Clear();
        Put(response, 8, Ok);
        switch (operation)
        {
            case Dt295ResidentProtocol.Ping:
                Put(response, 12, 1);
                return;
            case ResidentBlock:
                if (argument == 1) data.AsSpan(0, (int)budget).CopyTo(Resident.AsSpan((int)address));
                else Resident.AsSpan((int)address, (int)budget).CopyTo(response[DataOffset..]);
                Put(response, 12, budget);
                Put(response, 16, address);
                return;
        }
        Commands.Add((address, argument, data));
        switch (address)
        {
            case CommandCapabilities:
                Put(response, 16, AbiVersion);
                Encoding.ASCII.GetBytes(Identity).CopyTo(response[DataOffset..]);
                response[DataOffset + 15] = RfMask;
                Resident.AsSpan((int)(Dt295ResidentImage.BuildId - Dt295ResidentImage.Base), 8).CopyTo(response[(DataOffset + 16)..]);
                Resident.AsSpan((int)(Dt295ResidentImage.BuildId - Dt295ResidentImage.Base), 8).CopyTo(response[(DataOffset + 24)..]);
                return;
            case CommandInitialize:
                // 初期化のあとは、まだ選局が無い (世代 0、段階は QUIET)
                Initialized = true;
                _generation = 0;
                _phase = PhaseQuiet;
                return;
            case CommandTune:
                _generation++;
                _source = (int)argument;
                _phase = NeverReady ? 3u : PhaseComplete;
                _ready = !NeverReady;
                Capturing = !NeverReady && data[7] == 1;
                Put(response, 16, _generation);
                return;
            case CommandStop:
                _generation++;
                _phase = PhaseComplete;
                _ready = false;
                Capturing = false;
                Put(response, 16, _generation);
                return;
            case CommandShutdown:
            case CommandRecover:
                Initialized = false;
                Capturing = false;
                _ready = false;
                _phase = PhaseQuiet;
                return;
            case CommandService:
            case CommandStatus:
                return;
            case CommandDeviceQuery:
                Put(response, 12, CommandDeviceQuery);
                Put(response, 16, argument);
                response[24] = QueryVersion;
                response[25] = (byte)argument;
                response[26] = data[1];
                var words = argument switch
                {
                    PageOverview => new uint[] { 3, 3, AbiVersion, 0 },
                    PageSource => new uint[] { 1, 2, 1, 188, FormatMux, 0, 7 },
                    _ => new uint[]
                    {
                        _generation, 0, 0, _phase,
                        (Initialized ? StateInitialized | StateStarted : 0) | (_ready ? StateReady : 0) | (Capturing ? StateCapturing | StateStreamReady : 0),
                        Capturing ? _generation : 0, 0, 0, Capturing ? 1u << _source : 0,
                    },
                };
                if (argument == PageSource) response[27] = SourcePresent | SourceStream;
                for (var i = 0; i < words.Length; i++) Put(response, DataOffset + 4 + i * 4, words[i]);
                return;
        }
    }
}
