namespace Denpa.Agent.Tests;

/// <summary>テストで作る TSMF のヘッダーと TS のパケット (仕様書 8.7 の「ヘッダーの中身」の並び)</summary>
internal static class TsmfFake
{
    /// <summary>相対 TS 番号 2 と 3 が有効 (バイト 7 の bit6 と bit5)</summary>
    public const ushort Valid2And3 = 0x6000;

    /// <summary>スロット 1〜52 を、相対 TS 番号 2 と 3 に交互に割り当てたもの</summary>
    public static int[] Alternate(int first = 2, int second = 3) => [.. Enumerable.Range(0, TsmfHeader.SlotCount).Select(slot => slot % 2 == 0 ? first : second)];

    /// <summary>
    /// ヘッダーのパケット。<paramref name="slots"/> はスロット 1〜52 の相対 TS 番号、<paramref name="valid"/> は TS の状態 (bit15 が相対 TS 番号 1)。
    /// 相対 TS 番号 n の TSID は <c>0x1000 + n</c>、original_network_id は <c>0x0004</c> にする
    /// </summary>
    public static byte[] Header(int[] slots, ushort valid, int frameType = 1, bool inverted = false, byte sync = 0x47, ushort tsType = 0xFFFE)
    {
        var packet = new byte[188];
        packet[0] = sync;
        packet[1] = 0x00;
        packet[2] = 0x2F;
        packet[3] = 0x10;
        var frameSync = inverted ? 0x0579 : 0x1A86;
        packet[4] = (byte)(frameSync >> 8);
        packet[5] = (byte)frameSync;
        packet[6] = (byte)frameType;
        packet[7] = (byte)(valid >> 8);
        packet[8] = (byte)valid;
        for (var relative = 1; relative <= TsmfHeader.Streams; relative++)
        {
            var at = 9 + 4 * (relative - 1);
            packet[at] = 0x10;
            packet[at + 1] = (byte)relative;
            packet[at + 3] = 0x04;
        }
        packet[69] = 0xAB;
        for (var slot = 0; slot < slots.Length; slot++) packet[73 + slot / 2] |= (byte)(slot % 2 == 0 ? slots[slot] << 4 : slots[slot]);
        packet[125] = (byte)(tsType >> 8);
        packet[126] = (byte)tsType;
        var crc = Descrambler.Crc32(packet.AsSpan(4, 180));
        packet[184] = (byte)(crc >> 24);
        packet[185] = (byte)(crc >> 16);
        packet[186] = (byte)(crc >> 8);
        packet[187] = (byte)crc;
        return packet;
    }

    /// <summary>TS のパケット。バイト 4〜5 に <paramref name="number"/> を入れて見分ける</summary>
    public static byte[] Packet(int pid, int number, byte sync = 0x47)
    {
        var packet = new byte[188];
        packet[0] = sync;
        packet[1] = (byte)(pid >> 8);
        packet[2] = (byte)pid;
        packet[3] = 0x10;
        packet[4] = (byte)(number >> 8);
        packet[5] = (byte)number;
        return packet;
    }

    /// <summary>1 フレームの 52 パケット。スロットの相対 TS 番号 n のパケットは PID を <c>0x100 × n</c> にする</summary>
    public static IEnumerable<byte[]> Frame(int[] slots, int frame, byte sync = 0x47) =>
        slots.Select((relative, slot) => Packet(0x100 * relative, frame * 100 + slot, sync));

    /// <summary>PAT の先頭のパケット (transport_stream_id だけ入れたもの)</summary>
    public static byte[] Pat(ushort tsid)
    {
        var packet = new byte[188];
        packet[0] = 0x47;
        packet[1] = 0x40;
        packet[3] = 0x10;
        // pointer_field 0、table_id 0、section_length、transport_stream_id
        packet[6] = 0xB0;
        packet[7] = 0x0D;
        packet[8] = (byte)(tsid >> 8);
        packet[9] = (byte)tsid;
        return packet;
    }

    public static int Pid(ReadOnlySpan<byte> packet) => ((packet[1] & 0x1F) << 8) | packet[2];

    public static int Number(ReadOnlySpan<byte> packet) => (packet[4] << 8) | packet[5];
}

/*
 * ISDB-C の TSMF から TS を 1 つ選ぶ処理 (Tsmf.cs)。期待値は仕様書 (denpa-spec の cxd2856/spec.md) の 8.7 から決めた。
 * ヘッダーのバイト 9〜72 (TSID・original_network_id・受信の状態) の並びは仕様書が推定としているもの。
 */
public class TsmfTests
{
    /// <summary>選ぶ処理に渡し、出力されたパケットを集める</summary>
    private sealed class Sink(TsmfSelector selector)
    {
        public List<byte[]> Out { get; } = [];

        public void Push(byte[] packet) => selector.Push(packet, emitted => Out.Add(emitted.ToArray()));

        public void Push(IEnumerable<byte[]> packets)
        {
            foreach (var packet in packets) Push(packet);
        }
    }

    private static (TsmfSelector Selector, Sink Sink) Make(int index, int discard = 0)
    {
        var selector = new TsmfSelector(index, discard);
        return (selector, new Sink(selector));
    }

    [Test]
    public async Task ヘッダーは_PID_とフレーム同期とフレームの種類と_CRC_で見分け_同期バイトは見ない()
    {
        var slots = TsmfFake.Alternate();
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Header(slots, TsmfFake.Valid2And3))).IsTrue();
        // フレーム同期の反転 (0579) とフレームの種類 2 も受け付ける
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Header(slots, TsmfFake.Valid2And3, frameType: 2, inverted: true))).IsTrue();
        // ブリッジが付け替えた同期バイトのままでもよい
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Header(slots, TsmfFake.Valid2And3, sync: 0x17))).IsTrue();
        // フレームの種類は 1 か 2 だけ。バイト 6 の bit4 は 0
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Header(slots, TsmfFake.Valid2And3, frameType: 3))).IsFalse();
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Header(slots, TsmfFake.Valid2And3, frameType: 0x11))).IsFalse();
        // CRC が合わない
        var broken = TsmfFake.Header(slots, TsmfFake.Valid2And3);
        broken[100] ^= 0x01;
        await Assert.That(TsmfHeader.IsHeader(broken)).IsFalse();
        await Assert.That(TsmfHeader.HasHeaderPid(broken)).IsTrue();
        // 開始のフラグが立っている・バイト 3 の上位 4 ビットが 1 でない・フレーム同期が違う (CRC は合わせ直していないが、先に弾く)
        foreach (var (at, value) in new[] { (1, (byte)0x40), (3, (byte)0x30), (5, (byte)0x87) })
        {
            var other = TsmfFake.Header(slots, TsmfFake.Valid2And3);
            other[at] = value;
            await Assert.That(TsmfHeader.IsHeader(other)).IsFalse();
        }
        await Assert.That(TsmfHeader.IsHeader(TsmfFake.Packet(0x100, 0))).IsFalse();
    }

    [Test]
    public async Task ヘッダーから有効な_TS_とスロットの割り当てと_TS_の種類を読む()
    {
        // スロット 1 が相対 TS 番号 2、スロット 2 が 3 (1 バイトに 2 スロットで、上位 4 ビットが先)
        var header = TsmfHeader.Parse(TsmfFake.Header(TsmfFake.Alternate(), TsmfFake.Valid2And3, frameType: 2, tsType: 0x4000));
        await Assert.That(header.FrameType).IsEqualTo(2);
        await Assert.That(header.ValidStreams).IsEquivalentTo(new[] { 2, 3 });
        await Assert.That(header.IsValid(1)).IsFalse();
        await Assert.That(header.Slots[0]).IsEqualTo((byte)2);
        await Assert.That(header.Slots[1]).IsEqualTo((byte)3);
        await Assert.That(header.Slots[51]).IsEqualTo((byte)3);
        await Assert.That(header.SlotsOf(2)).IsEqualTo(26);
        await Assert.That(header.SlotsOf(1)).IsEqualTo(0);
        // TS の種類は TS の状態と同じ並び (バイト 125〜126)。相対 TS 番号 2 だけが MPEG-2 TS
        await Assert.That(header.IsTs(2)).IsTrue();
        await Assert.That(header.IsTs(3)).IsFalse();
        // バイト 9 から 4 バイトずつ、TSID と original_network_id (仕様書の推定の並び)
        await Assert.That(header.Ids[1]).IsEqualTo(((ushort)0x1002, (ushort)0x0004));
        await Assert.That(header.Ids[14]).IsEqualTo(((ushort)0x100F, (ushort)0x0004));
        await Assert.That(header.Status).IsEquivalentTo(new byte[] { 0xAB, 0x00, 0x00, 0x00 });
        // 相対 TS 番号 15 はバイト 8 の bit1
        await Assert.That(TsmfHeader.Parse(TsmfFake.Header(TsmfFake.Alternate(), 0x0002)).ValidStreams).IsEquivalentTo(new[] { 15 });
    }

    [Test]
    public async Task 複数の_TS_のフレームから_k_本目の_TS_だけを_フレームがそろってから出力する()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 1);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        // 有効な TS は相対 TS 番号 2 と 3。1 本目 (0 から数える) は 3
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Selected);
        await Assert.That(selector.Relative).IsEqualTo(3);
        sink.Push(TsmfFake.Frame(slots, 0));
        // 次のヘッダーで 52 パケットがそろったと分かるまで出力しない
        await Assert.That(sink.Out).IsEmpty();
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(sink.Out.All(packet => TsmfFake.Pid(packet) == 0x300)).IsTrue();
        await Assert.That(sink.Out.Select(packet => TsmfFake.Number(packet))).IsEquivalentTo(Enumerable.Range(0, 26).Select(i => 2 * i + 1));
        await Assert.That(selector.Headers).IsEqualTo(2);

        // 0 本目は相対 TS 番号 2
        var (first, firstSink) = Make(index: 0);
        firstSink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        firstSink.Push(TsmfFake.Frame(slots, 0));
        firstSink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(first.Relative).IsEqualTo(2);
        await Assert.That(firstSink.Out.All(packet => TsmfFake.Pid(packet) == 0x200)).IsTrue();
    }

    [Test]
    public async Task ヘッダーの無い搬送波は_424_パケットで決め_0_本目ならそのまま出力する()
    {
        var (selector, sink) = Make(index: 0);
        sink.Push(Enumerable.Range(0, TsmfSelector.NoHeaderPackets - 1).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Pending);
        await Assert.That(sink.Out).IsEmpty();
        sink.Push(TsmfFake.Packet(0x100, 423));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Passthrough);
        sink.Push(TsmfFake.Packet(0x100, 424));
        // 決まったパケットから、そのまま出力する
        await Assert.That(sink.Out.Select(packet => TsmfFake.Number(packet))).IsEquivalentTo(new[] { 423, 424 });
        await Assert.That(selector.FirstHeader).IsNull();
    }

    [Test]
    public async Task ヘッダーの無い搬送波で_1_本目以降を指定したら_指定した_TS_が無い()
    {
        var (selector, sink) = Make(index: 1);
        sink.Push(Enumerable.Range(0, TsmfSelector.NoHeaderPackets + 10).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Missing);
        await Assert.That(sink.Out).IsEmpty();
    }

    [Test]
    public async Task 最初のヘッダーに_k_本目が無ければ_指定した_TS_が無い()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 2);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Missing);
        await Assert.That(selector.Relative).IsEqualTo(0);
        sink.Push(TsmfFake.Frame(slots, 0));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out).IsEmpty();
        // 0〜14 本目の外は作るときに断る
        Assert.Throws<ArgumentOutOfRangeException>(() => new TsmfSelector(15));
        Assert.Throws<ArgumentOutOfRangeException>(() => new TsmfSelector(-1));
    }

    [Test]
    public async Task ヘッダーが遅れて来ても_424_パケットより前なら_TSMF_の搬送波として選ぶ()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(Enumerable.Range(0, 300).Select(number => TsmfFake.Packet(0x200, number)));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Pending);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Selected);
        // ヘッダーより前のパケットは、フレームの位置が分からないので出力しない
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(sink.Out.All(packet => TsmfFake.Number(packet) >= 100)).IsTrue();
    }

    [Test]
    public async Task そのまま出力している間にヘッダーが来たら_TSMF_の搬送波として選び直す()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(Enumerable.Range(0, TsmfSelector.NoHeaderPackets).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Passthrough);
        sink.Out.Clear();
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Selected);
        sink.Push(TsmfFake.Frame(slots, 0));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(sink.Out.All(packet => TsmfFake.Pid(packet) == 0x200)).IsTrue();
    }

    [Test]
    public async Task ロックのあとの最初のパケットは判定に使わずに捨て_前の搬送波のヘッダーで決めない()
    {
        // 前の搬送波 (TSMF。相対 TS 番号 1 だけが有効) の残りが、新しい搬送波 (ヘッダーなし) のロックのあとに届く (仕様書 8.7 の「パケットごとの処理」の 1)
        var stale = Enumerable.Repeat(1, TsmfHeader.SlotCount).ToArray();
        var (selector, sink) = Make(index: 0, discard: TsmfSelector.DiscardPackets);
        for (var frame = 0; frame < 13; frame++)
        {
            sink.Push(TsmfFake.Header(stale, 0x8000));
            sink.Push(TsmfFake.Frame(stale, frame));
        }
        // 13 フレーム (689 パケット) は捨てる数 (816) より少ない
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Pending);
        await Assert.That(selector.FirstHeader).IsNull();
        sink.Push(Enumerable.Range(0, TsmfSelector.DiscardPackets - 689 + TsmfSelector.NoHeaderPackets).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Passthrough);
        await Assert.That(sink.Out.Count).IsEqualTo(1);
        await Assert.That(selector.Received).IsEqualTo(TsmfSelector.DiscardPackets + TsmfSelector.NoHeaderPackets);
        // 既定の捨てる数は 816 パケット (仕様書 11 の記録の値)
        await Assert.That(TsmfSelector.DiscardPackets).IsEqualTo(816);
    }

    [Test]
    public async Task 相対_TS_番号は最初のヘッダーで決め_有効な_TS_の組が変わっても変えない()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 1);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(selector.Relative).IsEqualTo(3);
        sink.Push(TsmfFake.Frame(slots, 0));
        // 相対 TS 番号 1 も有効になった (1 本目は 2 に変わる) が、3 のまま
        sink.Push(TsmfFake.Header(slots, 0xE000));
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, 0xE000));
        await Assert.That(selector.Relative).IsEqualTo(3);
        await Assert.That(sink.Out.Count).IsEqualTo(52);
        await Assert.That(sink.Out.All(packet => TsmfFake.Pid(packet) == 0x300)).IsTrue();

        // 3 がヘッダーで無効になったら何も出さない。有効に戻ったらまた出す
        sink.Out.Clear();
        sink.Push(TsmfFake.Frame(slots, 2));
        sink.Push(TsmfFake.Header(slots, 0xC000));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        sink.Out.Clear();
        sink.Push(TsmfFake.Frame(slots, 3));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out).IsEmpty();
        sink.Push(TsmfFake.Frame(slots, 4));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Selected);
    }

    [Test]
    public async Task _52_パケットがそろう前にヘッダーが来たフレームは出力しない()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 0).Take(40));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out).IsEmpty();
        await Assert.That(selector.BrokenFrames).IsEqualTo(1);
        // 次のフレームはそろえば出力する
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
    }

    [Test]
    public async Task ヘッダーの位置のパケットが_CRC_の合わないヘッダーなら_ためたフレームは出力し_次のフレームは前の割り当てでためて確かめてから出す()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 0));
        var broken = TsmfFake.Header(slots, TsmfFake.Valid2And3);
        broken[150] ^= 0xFF;
        sink.Push(broken);
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(selector.BadHeaders).IsEqualTo(1);
        // 次のフレームは前のヘッダーの割り当てでため、53 パケット後に割り当ての同じ正しいヘッダーが来たら出力する
        sink.Push(TsmfFake.Frame(slots, 1));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(52);
        await Assert.That(sink.Out.Skip(26).Select(packet => TsmfFake.Number(packet))).IsEquivalentTo(Enumerable.Range(0, 26).Select(i => 100 + 2 * i));
        await Assert.That(selector.HeldFrames).IsEqualTo(1);
        await Assert.That(selector.BrokenFrames).IsEqualTo(0);
        sink.Push(TsmfFake.Frame(slots, 2));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(78);
        await Assert.That(selector.Expected).IsEqualTo(78);
        await Assert.That(selector.Emitted).IsEqualTo(78);
    }

    [Test]
    public async Task CRC_の合わないヘッダーのあとで割り当てが変わっていたら_前の割り当てでためたフレームは捨てる()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 0));
        var broken = TsmfFake.Header(slots, TsmfFake.Valid2And3);
        broken[100] ^= 0x01;
        sink.Push(broken);
        sink.Push(TsmfFake.Frame(slots, 1));
        // 次の正しいヘッダーの割り当てが違う。間のフレームがどちらの割り当てだったか分からない
        var swapped = TsmfFake.Alternate(3, 2);
        sink.Push(TsmfFake.Header(swapped, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
        await Assert.That(selector.BrokenFrames).IsEqualTo(1);
        await Assert.That(selector.MappingChanges).IsEqualTo(1);
        // 新しい割り当てで続ける
        sink.Push(TsmfFake.Frame(swapped, 2));
        sink.Push(TsmfFake.Header(swapped, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Skip(26).Select(packet => TsmfFake.Number(packet))).IsEquivalentTo(Enumerable.Range(0, 26).Select(i => 201 + 2 * i));
    }

    [Test]
    public async Task ヘッダーの位置にほかのパケットが来ても_次のヘッダーが_53_パケットごとの位置に来れば_その前のフレームも出力する()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 0));
        // ヘッダーの PID が崩れた (位置がずれたのかは、まだ分からない)
        var garbled = TsmfFake.Header(slots, TsmfFake.Valid2And3);
        garbled[2] = 0x11;
        sink.Push(garbled);
        await Assert.That(sink.Out).IsEmpty();
        await Assert.That(selector.MissedHeaders).IsEqualTo(1);
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Select(packet => TsmfFake.Number(packet)))
            .IsEquivalentTo(Enumerable.Range(0, 26).Select(i => 2 * i).Concat(Enumerable.Range(0, 26).Select(i => 100 + 2 * i)));
        await Assert.That(selector.BrokenFrames).IsEqualTo(0);
    }

    [Test]
    public async Task ヘッダーの位置にほかのパケットが来て次のヘッダーの位置もずれたら_ためたフレームを捨てる()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        // ヘッダーの位置にほかのパケットが来て、次のヘッダーは 53 パケットより前に来た (パケットが欠けていた)
        sink.Push(TsmfFake.Frame(slots, 0));
        sink.Push(TsmfFake.Packet(0x200, 999));
        sink.Push(TsmfFake.Frame(slots, 1).Skip(1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out).IsEmpty();
        await Assert.That(selector.BrokenFrames).IsEqualTo(2);
        // 次のフレームはそろえば出力する
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
    }

    [Test]
    public async Task 正しいヘッダーが続けて来なければ_ためたフレームを捨て_そのまま出力には切り替えない()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 0));
        // ヘッダーが来なくなった
        sink.Push(Enumerable.Range(0, 2 * TsmfSelector.NoHeaderPackets).Select(number => TsmfFake.Packet(0x200, number)));
        await Assert.That(sink.Out).IsEmpty();
        await Assert.That(selector.BrokenFrames).IsEqualTo(TsmfSelector.MaxHeldFrames);
        // 一度ヘッダーを受けたあとは、ヘッダーが途切れてもそのまま出力には切り替えない
        await Assert.That(selector.Decision).IsEqualTo(TsmfDecision.Selected);
        // 正しいヘッダーが来たら、そこから選び直す
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        sink.Push(TsmfFake.Frame(slots, 1));
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(sink.Out.Count).IsEqualTo(26);
    }

    /// <summary>
    /// 実機の QU49 (J:COM。有効な TS は 1 本で、52 スロットのうち 48 を使う) に似せた搬送波のバイト列。スロットの割り当て (選んだ TS でない 4 スロットの位置) は
    /// 50 フレームごとに変え、選んだ TS のパケットは PID ごとに continuity_counter を進める。<paramref name="badHeaders"/> のフレームはヘッダーの CRC を崩す。
    /// ブリッジの入力 3 の同期バイトにし、入力 0 のパケットを 7 パケットごとに混ぜる
    /// </summary>
    private static byte[] Carrier(int frames, ISet<int> badHeaders)
    {
        var sync = It930xBridge.SyncBytes[3];
        int[] pids = [0x0000, 0x0100, 0x0110, 0x0111, 0x0130, 0x01F0];
        var counters = new int[0x2000];
        var bytes = new List<byte>();
        var mixed = 0;
        void Add(byte[] packet)
        {
            bytes.AddRange(packet);
            if (++mixed % 7 == 0) bytes.AddRange(TsmfFake.Packet(0x0100, mixed, It930xBridge.SyncBytes[0]));
        }
        for (var frame = 0; frame < frames; frame++)
        {
            var empty = frame / 50 % 13;
            var slots = Enumerable.Range(0, TsmfHeader.SlotCount).Select(slot => slot / 4 == empty ? 0 : 1).ToArray();
            var header = TsmfFake.Header(slots, 0x8000, sync: sync);
            if (badHeaders.Contains(frame)) header[120] ^= 0x10;
            Add(header);
            for (var slot = 0; slot < TsmfHeader.SlotCount; slot++)
            {
                if (slots[slot] == 0)
                {
                    Add(TsmfFake.Packet(0x1FFF, 0, sync));
                    continue;
                }
                var pid = pids[(frame * 7 + slot) % pids.Length];
                var packet = TsmfFake.Packet(pid, frame, sync);
                packet[3] = (byte)(0x10 | (counters[pid]++ & 0x0F));
                Add(packet);
            }
        }
        return [.. bytes];
    }

    [Test]
    public async Task 多くのフレームを転送の境目で切って渡し_CRC_の合わないヘッダーが混じっても_選んだ_TS_のパケットは欠けない()
    {
        const int frames = 1500;
        // 最初に捨てるパケットのあとで、割り当てを変える前後 (50 フレームごと) を避けて、CRC の合わないヘッダーを混ぜる
        var bad = Enumerable.Range(20, frames - 22).Where(frame => frame % 37 == 5 && frame % 50 is > 1 and < 49).ToHashSet();
        var data = Carrier(frames, bad);
        var selector = new TsmfSelector(0);
        var pipe = new System.IO.Pipelines.Pipe(new System.IO.Pipelines.PipeOptions(pauseWriterThreshold: 0, useSynchronizationContext: false));
        var demux = new It930xTsDemux(It930xBridge.SyncBytes);
        demux.Attach(3, new It930xTsOutput(pipe, selector));
        var random = new Random(2516);
        var output = new List<byte>();
        for (var at = 0; at < data.Length;)
        {
            // USB の転送の大きさはまちまちで、パケットの途中でも切れる
            var size = Math.Min(random.Next(1, 3 * It930xBridge.TsTransferSize), data.Length - at);
            demux.Push(data.AsSpan(at, size));
            at += size;
            if (pipe.Reader.TryRead(out var result))
            {
                output.AddRange(System.Buffers.BuffersExtensions.ToArray(result.Buffer));
                pipe.Reader.AdvanceTo(result.Buffer.End);
            }
        }

        var continuity = new ContinuityTracker();
        for (var at = 0; at + 188 <= output.Count; at += 188) continuity.Push(output.GetRange(at, 188).ToArray());
        await Assert.That(bad.Count).IsGreaterThan(20);
        await Assert.That(selector.BadHeaders).IsEqualTo(bad.Count);
        await Assert.That(selector.BrokenFrames).IsEqualTo(0);
        await Assert.That(selector.HeldFrames).IsEqualTo(bad.Count);
        await Assert.That(continuity.Jumps).IsEqualTo(0);
        await Assert.That(selector.ContinuityBefore.Jumps).IsEqualTo(0);
        await Assert.That(selector.ContinuityAfter.Jumps).IsEqualTo(0);
        await Assert.That(selector.SlotsPerFrame).IsEqualTo((48, 48));
        // 最初の 816 パケット (15 フレームと少し) は捨て、最後のフレームは次のヘッダーが来ないので出力しない。そのあいだの選んだ TS のパケットは全部出る
        var counted = frames - TsmfSelector.DiscardPackets / (TsmfHeader.SlotCount + 1) - 2;
        await Assert.That(selector.Emitted).IsEqualTo(48L * counted);
        await Assert.That(output.Count).IsEqualTo(188 * 48 * counted);
        await Assert.That(selector.Expected - selector.Emitted).IsEqualTo(48);
        await Assert.That(selector.MappingChanges).IsEqualTo((frames - 1) / 50);
    }

    [Test]
    public async Task 出力した_TS_の_PAT_から_TSID_を読む()
    {
        var slots = TsmfFake.Alternate();
        var (selector, sink) = Make(index: 0);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        // スロット 1 (相対 TS 番号 2) に選ぶ TS の PAT、スロット 2 (相対 TS 番号 3) に別の TS の PAT
        var frame = TsmfFake.Frame(slots, 0).ToList();
        frame[0] = TsmfFake.Pat(0x1002);
        frame[1] = TsmfFake.Pat(0x7777);
        sink.Push(frame);
        await Assert.That(selector.PatTsid).IsNull();
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(selector.PatTsid).IsEqualTo((ushort)0x1002);
    }

    [Test]
    public async Task 判定は決まるまで待ち_時間切れなら決まっていないまま返す()
    {
        var (selector, sink) = Make(index: 0);
        await Assert.That(selector.Wait(20)).IsEqualTo(TsmfDecision.Pending);
        sink.Push(TsmfFake.Header(TsmfFake.Alternate(), TsmfFake.Valid2And3));
        await Assert.That(selector.Wait(0)).IsEqualTo(TsmfDecision.Selected);
    }

    [Test]
    public async Task tune_の出力は_TSMF_の_TS_の一覧と選んだ_TS_と失敗の様子を書く()
    {
        var slots = TsmfFake.Alternate();
        // ロックしなかった
        await Assert.That(Probe.TsmfLines(false, null).Single()).Contains("ロックしませんでした");

        // ヘッダーあり。相対 TS 番号 2 と 3 が有効で、1 本目 (3) を選んだ
        var (selector, sink) = Make(index: 1);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        var lines = Probe.TsmfLines(true, selector).ToList();
        await Assert.That(lines[0]).IsEqualTo("ISDB-C: ロックしました");
        await Assert.That(lines[1]).IsEqualTo("TSMF: ヘッダーあり (バージョン 0、フレームの種類 1)。有効な TS は 2 本");
        await Assert.That(lines[2]).IsEqualTo("  相対 TS 番号 1: 無効  TSID 0x1001 (4097)  ONID 0x0004  MPEG-2 TS  スロット 0");
        await Assert.That(lines[3]).IsEqualTo("  相対 TS 番号 2: 有効  TSID 0x1002 (4098)  ONID 0x0004  MPEG-2 TS  スロット 26  0 本目");
        await Assert.That(lines[4]).IsEqualTo("  相対 TS 番号 3: 有効  TSID 0x1003 (4099)  ONID 0x0004  MPEG-2 TS  スロット 26  1 本目 (選んだ TS)");
        await Assert.That(lines[^1]).StartsWith("  ヘッダーのパケット 47002F10");

        // 指定した TS が無い
        var (missing, missingSink) = Make(index: 4);
        missingSink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        await Assert.That(Probe.TsmfLines(true, missing)).Contains("指定した 4 本目はありません (:0〜:1 を指定する)");

        // ヘッダーの無い搬送波
        var (plain, plainSink) = Make(index: 0);
        plainSink.Push(Enumerable.Range(0, TsmfSelector.NoHeaderPackets).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(Probe.TsmfLines(true, plain).Last()).Contains("ヘッダーなし");
        await Assert.That(Probe.TsmfLines(true, plain).Last()).Contains("そのまま出力します");
        var (second, secondSink) = Make(index: 1);
        secondSink.Push(Enumerable.Range(0, TsmfSelector.NoHeaderPackets).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(Probe.TsmfLines(true, second).Last()).Contains("指定した 1 本目はありません");

        // ロックしたが、判定に要るパケットが届かなかった
        var (pending, pendingSink) = Make(index: 0, discard: TsmfSelector.DiscardPackets);
        pendingSink.Push(Enumerable.Range(0, 5).Select(number => TsmfFake.Packet(0x100, number)));
        await Assert.That(Probe.TsmfLines(true, pending).Last()).Contains("判定できませんでした (ロックしたが、5 パケットしか届かなかった");

        // 受け終えたあと: 数と、PAT の TSID がヘッダーの TSID (推定の並び) と同じか
        var frame = TsmfFake.Frame(slots, 0).ToList();
        frame[1] = TsmfFake.Pat(0x1003);
        sink.Push(frame);
        sink.Push(TsmfFake.Header(slots, TsmfFake.Valid2And3));
        var after = Probe.TsmfAfterLines(selector).ToList();
        await Assert.That(after[0]).IsEqualTo("TSMF: 受けたパケット 54  ヘッダー 2  CRC が合わないヘッダー 0  ヘッダーの位置に来たほかのパケット 0  そろわずに捨てたフレーム 0");
        await Assert.That(after[1]).IsEqualTo("TSMF: 前のヘッダーの割り当てで受けたフレーム 0  スロットの割り当てが変わったヘッダー 0");
        await Assert.That(after[2]).IsEqualTo("TSMF: 1 フレームの選んだ TS のスロット 26 / 52  選んだ TS のスロットに来たパケット 26  出力したパケット 26");
        await Assert.That(after[3]).IsEqualTo("TSMF: 連続性の飛び (最初の 1 秒も数える) 選ぶ前 0 回  選んだあと 0 回  transport_error_indicator が 1 のパケット 選ぶ前 0  選んだあと 0");
        await Assert.That(after[^1]).IsEqualTo("出力した TS の PAT の TSID 0x1003 (4099)  ヘッダーの TSID と同じ");
    }

    [Test]
    public async Task tune_の出力は_ISDB_C_の変調と_ほかに読める値を書く()
    {
        var detail = new CxdIsdbcDetail(true, -46.875, 5.2734375, 1e-6, 5, 0x123);
        var lines = Probe.IsdbcSignalLines("64QAM", 0.001, detail).ToList();
        await Assert.That(lines[0]).IsEqualTo("変調 64QAM  PER 0.001 (未確認の値)");
        await Assert.That(lines[1]).IsEqualTo(
            "ほかの値 (未確認の読み方)  反転 あり  搬送波のずれ -46.9 kHz  シンボルレート 5.2734 Msps  RS の前の BER 1E-06  直せなかったパケット 5  IF の AGC 291");
        // 自動の探索がロックしていないときは、値の無いものを - にする
        var none = Probe.IsdbcSignalLines(null, null, new CxdIsdbcDetail(null, null, null, null, null, 0)).ToList();
        await Assert.That(none[0]).IsEqualTo("変調 -  PER -");
        await Assert.That(none[1]).Contains("反転 -  搬送波のずれ -  シンボルレート -  RS の前の BER -  直せなかったパケット -");
    }
}
