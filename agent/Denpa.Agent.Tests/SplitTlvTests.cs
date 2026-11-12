namespace Denpa.Agent.Tests;

/// <summary>テストで作る分割 TLV の単位 (SplitTlv.cs の冒頭の並び)</summary>
internal static class SplitTlvFake
{
    /// <summary>TLV パケット。中身の先頭 2 バイトに <paramref name="number"/> を入れて見分ける</summary>
    public static byte[] Tlv(int number, int length, byte type = 0xFF)
    {
        var packet = new byte[SplitTlv.TlvHeaderSize + length];
        packet[0] = SplitTlv.Sync;
        packet[1] = type;
        packet[2] = (byte)(length >> 8);
        packet[3] = (byte)length;
        for (var at = 4; at < packet.Length; at++) packet[at] = (byte)(number * 7 + at);
        if (length >= 2)
        {
            packet[4] = (byte)(number >> 8);
            packet[5] = (byte)number;
        }
        return packet;
    }

    /// <summary>単位の並びと、各単位が運ぶバイト列の範囲 (TLV のバイト列の中の位置)、開始の単位なら pointer の指す位置</summary>
    public sealed record Layout(List<byte[]> Units, List<(int Begin, int End, int? Start)> Spans, List<(int Begin, int End)> Packets);

    /// <summary>
    /// TLV パケットを並べて単位に分ける。TLV パケットが始まる単位は開始の単位にし、pointer にそこまでのバイト数を入れて 184 バイトを運ぶ。
    /// ほかは 185 バイトを運ぶ。最後の単位の余りは 0xFF で埋める。最後の <paramref name="cut"/> バイトは単位にしない (最後のパケットを終わらせない)
    /// </summary>
    public static Layout Units(IReadOnlyList<byte[]> packets, int cut = 1000)
    {
        var stream = packets.SelectMany(packet => packet).ToArray();
        var ranges = new List<(int, int)>();
        var offset = 0;
        foreach (var packet in packets)
        {
            ranges.Add((offset, offset + packet.Length));
            offset += packet.Length;
        }
        var starts = ranges.Select(range => range.Item1).ToList();
        var units = new List<byte[]>();
        var spans = new List<(int, int, int?)>();
        var at = 0;
        while (at < stream.Length - cut)
        {
            var unit = new byte[SplitTlv.UnitSize];
            unit[0] = 0x47;
            unit[2] = 0x2D;
            var next = starts.FirstOrDefault(start => start >= at && start - at < 184, -1);
            int size, body;
            if (next >= 0)
            {
                unit[1] = SplitTlv.StartFlag;
                unit[3] = (byte)(next - at);
                size = 184;
                body = 4;
            }
            else
            {
                size = 185;
                body = 3;
            }
            unit.AsSpan(body).Fill(0xFF);
            var take = Math.Min(size, stream.Length - at);
            stream.AsSpan(at, take).CopyTo(unit.AsSpan(body));
            units.Add(unit);
            spans.Add((at, at + size, next >= 0 ? next : null));
            at += size;
        }
        return new Layout(units, spans, ranges);
    }

    /// <summary>単位を順に渡して、組み立てた TLV パケットを集める</summary>
    public static List<byte[]> Assemble(SplitTlv tlv, IEnumerable<byte[]> units)
    {
        var output = new List<byte[]>();
        foreach (var unit in units) tlv.Push(unit, packet => output.Add(packet.ToArray()));
        return output;
    }

    /// <summary>録画 (qc26.ts) の 1,082 単位 (TSMF から選んだ分割 TLV の単位のまま)</summary>
    public static byte[] Capture()
    {
        using var stream = typeof(SplitTlvFake).Assembly.GetManifestResourceStream("qc26-split-tlv.bin")
            ?? throw new InvalidOperationException("qc26-split-tlv.bin が埋め込まれていません");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    public static IEnumerable<byte[]> Chunk(byte[] data) =>
        Enumerable.Range(0, data.Length / SplitTlv.UnitSize).Select(index => data.AsSpan(index * SplitTlv.UnitSize, SplitTlv.UnitSize).ToArray());
}

/*
 * 分割 TLV の単位から TLV パケットを組み立て直す処理 (SplitTlv.cs)。単位の並びは QC26 の録画で確かめたもの (docs/agent.md「IT930x の機材を直に持つ作り」)。
 */
public class SplitTlvTests
{
    /// <summary>長さがまちまちの TLV パケット。単位をまたぐもの、3 つ以上の単位にまたがるもの、1 つの単位に複数入るものを含む。最後は終わらないパケット</summary>
    private static List<byte[]> Packets()
    {
        var random = new Random(4096);
        var packets = new List<byte[]> { SplitTlvFake.Tlv(0, 10), SplitTlvFake.Tlv(1, 700, 0x03), SplitTlvFake.Tlv(2, 1), SplitTlvFake.Tlv(3, 0), SplitTlvFake.Tlv(4, 5) };
        byte[] types = [0x01, 0x02, 0x03, 0xFE, 0xFF];
        for (var number = 5; number < 400; number++)
        {
            var length = random.Next(4) switch { 0 => random.Next(0, 20), 1 => random.Next(150, 400), 2 => random.Next(400, 1600), _ => random.Next(20, 150) };
            packets.Add(SplitTlvFake.Tlv(number, length, types[random.Next(types.Length)]));
        }
        // ストリームの終わりで終わらないパケット (出力しない。TSMF のフレームの残りを埋める単位を足しても終わらない長さ)
        packets.Add(SplitTlvFake.Tlv(9999, 60000));
        return packets;
    }

    private static async Task SameAs(List<byte[]> actual, IEnumerable<byte[]> expected)
    {
        var want = expected.ToList();
        await Assert.That(actual.Count).IsEqualTo(want.Count);
        for (var index = 0; index < want.Count; index++) await Assert.That(actual[index].AsSpan().SequenceEqual(want[index])).IsTrue().Because($"{index} 番目");
    }

    [Test]
    public async Task 単位をまたぐパケットも_1_つの単位に入る複数のパケットも_そのまま組み立てる()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        var tlv = new SplitTlv();

        var output = SplitTlvFake.Assemble(tlv, layout.Units);

        // 最初の単位は pointer が 0
        await Assert.That(layout.Units[0][1]).IsEqualTo(SplitTlv.StartFlag);
        await Assert.That(layout.Units[0][3]).IsEqualTo((byte)0);
        await Assert.That(layout.Packets.Any(range => layout.Spans.Count(span => span.Begin < range.End && range.Begin < span.End) >= 3)).IsTrue();
        await SameAs(output, packets.Take(packets.Count - 1));
        await Assert.That(tlv.Units).IsEqualTo(layout.Units.Count);
        await Assert.That(tlv.Starts).IsEqualTo(layout.Units.Count(unit => (unit[1] & SplitTlv.StartFlag) != 0));
        await Assert.That(tlv.Packets).IsEqualTo(packets.Count - 1);
        await Assert.That(tlv.DroppedBytes).IsEqualTo(0);
        await Assert.That(tlv.Resyncs).IsEqualTo(0);
        await Assert.That(tlv.OtherHeaders).IsEqualTo(0);
        await Assert.That(tlv.ByType.Sum(pair => pair.Count)).IsEqualTo(tlv.Packets);
    }

    [Test]
    public async Task 最初の開始の単位より前は捨てる()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        // 途中から受け始める。最初に受けるのが開始の印の無い単位になるようにする
        var from = Enumerable.Range(1, layout.Units.Count - 1).First(index => layout.Spans[index].Start is null);
        var start = layout.Spans.Skip(from).First(span => span.Start is not null).Start!.Value;
        var tlv = new SplitTlv();

        var output = SplitTlvFake.Assemble(tlv, layout.Units.Skip(from));

        var expected = packets.Where((_, index) => layout.Packets[index].Begin >= start).SkipLast(1);
        await SameAs(output, expected);
        await Assert.That(tlv.DroppedBytes).IsEqualTo(start - layout.Spans[from].Begin);
    }

    [Test]
    public async Task 単位が欠けたら_組み立て中のパケットを捨て_次の開始の単位から組み立て直す()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        // パケットの途中で 1 つ欠ける (欠けた単位の前で終わっていないパケットがある)
        var lost = Enumerable.Range(10, layout.Units.Count - 20).First(index =>
            layout.Packets.Any(range => range.Begin < layout.Spans[index - 1].End && range.End > layout.Spans[index - 1].End));
        var resume = layout.Spans.Skip(lost + 1).First(span => span.Start is not null).Start!.Value;
        var tlv = new SplitTlv();
        var output = new List<byte[]>();
        for (var index = 0; index < layout.Units.Count; index++)
        {
            if (index == lost)
            {
                tlv.Break();
                continue;
            }
            tlv.Push(layout.Units[index], packet => output.Add(packet.ToArray()));
        }

        var before = layout.Spans[lost - 1].End;
        var expected = packets.Where((_, index) => layout.Packets[index].End <= before || layout.Packets[index].Begin >= resume).SkipLast(1).ToList();
        await Assert.That(expected.Count).IsLessThan(packets.Count - 1);
        await SameAs(output, expected);
        await Assert.That(tlv.Breaks).IsEqualTo(1);
        await Assert.That(tlv.Resyncs).IsEqualTo(0);
    }

    [Test]
    public async Task 先頭が_0x7F_でないパケットで合わせ直す()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        var broken = Enumerable.Range(10, layout.Units.Count - 20).First(index => layout.Spans[index].Start is not null);
        var target = layout.Spans[broken].Start!.Value;
        var units = layout.Units.Select(unit => unit.ToArray()).ToList();
        units[broken][4 + units[broken][3]] = 0x00;
        var resume = layout.Spans.Skip(broken + 1).First(span => span.Start is not null).Start!.Value;
        var tlv = new SplitTlv();

        var output = SplitTlvFake.Assemble(tlv, units);

        var expected = packets.Where((_, index) => layout.Packets[index].End <= target || layout.Packets[index].Begin >= resume).SkipLast(1);
        await SameAs(output, expected);
        await Assert.That(tlv.Resyncs).IsEqualTo(1);
        await Assert.That(tlv.DroppedBytes).IsEqualTo(resume - target);
    }

    [Test]
    public async Task 開始の単位の_pointer_の位置で前のパケットが終わっていなければ_捨てて_pointer_から始める()
    {
        // 1 つ目のパケットは 2 つ目の単位の途中まで。2 つ目の単位の pointer を、1 つ目が終わるより前に置く (そこから正しいパケットを始める)
        var first = SplitTlvFake.Tlv(0, 300);
        var second = SplitTlvFake.Tlv(1, 50);
        var third = SplitTlvFake.Tlv(2, 2000);
        var units = new List<byte[]>();
        var one = new byte[188];
        one[0] = 0x47;
        one[1] = SplitTlv.StartFlag;
        one[2] = 0x2D;
        first.AsSpan(0, 184).CopyTo(one.AsSpan(4));
        units.Add(one);
        var two = new byte[188];
        two[0] = 0x47;
        two[1] = SplitTlv.StartFlag;
        two[2] = 0x2D;
        two[3] = 10;
        first.AsSpan(184, 10).CopyTo(two.AsSpan(4));
        second.CopyTo(two.AsSpan(14));
        third.AsSpan(0, 184 - 10 - second.Length).CopyTo(two.AsSpan(14 + second.Length));
        units.Add(two);
        var tlv = new SplitTlv();

        var output = SplitTlvFake.Assemble(tlv, units);

        await SameAs(output, [second]);
        await Assert.That(tlv.Resyncs).IsEqualTo(1);
        await Assert.That(tlv.DroppedBytes).IsEqualTo(194);
    }

    [Test]
    public async Task 録画の単位は読み飛ばさずに組み立てられ_数がほかの数え方と合う()
    {
        var units = SplitTlvFake.Chunk(SplitTlvFake.Capture()).ToList();
        var tlv = new SplitTlv();

        var output = SplitTlvFake.Assemble(tlv, units);

        // 375 は、別に書いた数え方 (単位の中身をつなぎ、最初の開始の単位から TLV の長さで区切る。録画を解析したスクリプトと同じ読み方) で数えた値
        await Assert.That(units.Count).IsEqualTo(1082);
        await Assert.That(tlv.Packets).IsEqualTo(375);
        await Assert.That(output.Count).IsEqualTo(375);
        await Assert.That(string.Join(" ", tlv.ByType.Select(pair => $"{pair.Type:X2}:{pair.Count}"))).IsEqualTo("02:1 03:127 FF:247");
        await Assert.That(tlv.Resyncs).IsEqualTo(0);
        await Assert.That(tlv.Breaks).IsEqualTo(0);
        await Assert.That(tlv.OtherHeaders).IsEqualTo(0);
        // pointer の指す先はどれも TLV パケットの先頭
        foreach (var unit in units.Where(unit => (unit[1] & SplitTlv.StartFlag) != 0)) await Assert.That(unit[4 + unit[3]]).IsEqualTo(SplitTlv.Sync);
    }

    /// <summary>TSMF のヘッダーで、相対 TS 番号 2 を分割 TLV にしたもの (相対 TS 番号 3 は MPEG-2 TS)</summary>
    private static byte[] TlvHeader(ushort tsType = 0xBFFE) => TsmfFake.Header(TsmfFake.Alternate(), TsmfFake.Valid2And3, tsType: tsType);

    /// <summary>
    /// フレームを並べる。相対 TS 番号 2 のスロットに分割 TLV の単位を順に入れ、3 には TS のパケットを入れる。
    /// <paramref name="skip"/> のフレームでは、2 のスロットの単位を 1 つ抜く (フレームがそろわない)。最後にヘッダーを 1 つ足す (最後のフレームを確かめるため)
    /// </summary>
    private static List<byte[]> Frames(List<byte[]> units, int? skip = null, Func<int, ushort>? tsType = null)
    {
        var packets = new List<byte[]>();
        var next = 0;
        var skipped = false;
        var slots = TsmfFake.Alternate();
        // 単位が尽きたあとのスロットは、続きのバイトだけの単位で埋める (最後の終わらないパケットの続きになる)
        var filler = new byte[SplitTlv.UnitSize];
        filler.AsSpan(3).Fill(0xFF);
        filler[0] = 0x47;
        filler[2] = 0x2D;
        for (var frame = 0; next < units.Count; frame++)
        {
            packets.Add(TlvHeader(tsType?.Invoke(frame) ?? 0xBFFE));
            foreach (var relative in slots)
            {
                if (relative != 2)
                {
                    packets.Add(TsmfFake.Packet(0x300, frame));
                    continue;
                }
                var unit = next < units.Count ? units[next++] : filler;
                if (frame == skip && !skipped)
                {
                    skipped = true;
                    continue;
                }
                packets.Add(unit);
            }
        }
        packets.Add(TlvHeader());
        return packets;
    }

    private static List<byte[]> Read(System.IO.Pipelines.Pipe pipe)
    {
        var bytes = new List<byte>();
        while (pipe.Reader.TryRead(out var result))
        {
            bytes.AddRange(System.Buffers.BuffersExtensions.ToArray(result.Buffer));
            pipe.Reader.AdvanceTo(result.Buffer.End);
            if (result.Buffer.IsEmpty || result.IsCompleted) break;
        }
        var packets = new List<byte[]>();
        var data = bytes.ToArray();
        for (var at = 0; at + 4 <= data.Length;)
        {
            var length = 4 + ((data[at + 2] << 8) | data[at + 3]);
            packets.Add(data[at..(at + length)]);
            at += length;
        }
        return packets;
    }

    [Test]
    public async Task TSMF_で選んだ_TS_が分割_TLV_なら_TLV_パケットに組み立てて詰める()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        var selector = new TsmfSelector(0, discard: 0);
        var tlv = new SplitTlv();
        var pipe = new System.IO.Pipelines.Pipe(new System.IO.Pipelines.PipeOptions(pauseWriterThreshold: 0, useSynchronizationContext: false));
        var output = new It930xTsOutput(pipe, selector, tlv);

        foreach (var packet in Frames(layout.Units)) output.Write(packet);
        output.Commit();

        await Assert.That(selector.Format).IsEqualTo(StreamFormat.Tlv);
        await SameAs(Read(pipe), packets.Take(packets.Count - 1));
        await Assert.That(tlv.Units).IsGreaterThanOrEqualTo(layout.Units.Count);
        await Assert.That(tlv.Breaks).IsEqualTo(0);
    }

    [Test]
    public async Task TSMF_のフレームが欠けたら_組み立て中のパケットを捨てる()
    {
        var packets = Packets();
        var layout = SplitTlvFake.Units(packets);
        var selector = new TsmfSelector(0, discard: 0);
        var tlv = new SplitTlv();
        var pipe = new System.IO.Pipelines.Pipe(new System.IO.Pipelines.PipeOptions(pauseWriterThreshold: 0, useSynchronizationContext: false));
        var output = new It930xTsOutput(pipe, selector, tlv);

        // 5 フレーム目の単位を 1 つ抜く。そのフレームの 26 単位は丸ごと捨てられる
        foreach (var packet in Frames(layout.Units, skip: 5)) output.Write(packet);
        output.Commit();

        var lostFrom = layout.Spans[5 * 26].Begin;
        var lostTo = layout.Spans[6 * 26 - 1].End;
        var resume = layout.Spans.Skip(6 * 26).First(span => span.Start is not null).Start!.Value;
        var expected = packets.Where((_, index) => layout.Packets[index].End <= lostFrom || layout.Packets[index].Begin >= resume).SkipLast(1).ToList();
        await Assert.That(selector.BrokenFrames).IsEqualTo(1);
        await Assert.That(selector.Gaps).IsEqualTo(1);
        await Assert.That(tlv.Breaks).IsEqualTo(1);
        await Assert.That(resume).IsGreaterThanOrEqualTo(lostTo);
        await SameAs(Read(pipe), expected);
    }

    [Test]
    public async Task 選局の途中で選んだ_TS_の種類が変わったら_出力を止める()
    {
        var layout = SplitTlvFake.Units(Packets());
        var selector = new TsmfSelector(0, discard: 0);
        var tlv = new SplitTlv();
        var pipe = new System.IO.Pipelines.Pipe(new System.IO.Pipelines.PipeOptions(pauseWriterThreshold: 0, useSynchronizationContext: false));
        var output = new It930xTsOutput(pipe, selector, tlv);

        // 4 フレーム目から、相対 TS 番号 2 が MPEG-2 TS になる
        foreach (var packet in Frames(layout.Units, tsType: frame => frame >= 4 ? (ushort)0xFFFE : (ushort)0xBFFE)) output.Write(packet);

        await Assert.That(selector.Format).IsEqualTo(StreamFormat.Tlv);
        await Assert.That(selector.FormatChanged).IsTrue();
        await Assert.That(output.Closed).IsTrue();
        await Assert.That(tlv.Units).IsLessThanOrEqualTo(4 * 26);
    }
}
