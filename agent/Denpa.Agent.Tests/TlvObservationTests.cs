using System.Text;

namespace Denpa.Agent.Tests;

/// <summary>テストで作る TLV・MMTP・MMT-SI (TlvObservation.cs が読む並び)</summary>
internal static class TlvFake
{
    public static byte[] Tlv(byte type, byte[] body) => [SplitTlv.Sync, type, (byte)(body.Length >> 8), (byte)body.Length, .. body];

    /// <summary>CRC を持つセクション (table_id・section_length・table_id_extension・バージョン・section_number・last_section_number・中身・CRC)</summary>
    public static byte[] Section(byte table, ushort extension, byte[] body)
    {
        var length = 5 + body.Length + 4;
        byte[] head = [table, (byte)(0xF0 | (length >> 8)), (byte)length, (byte)(extension >> 8), (byte)extension, 0xC1, 0x00, 0x00];
        var without = head.Concat(body).ToArray();
        var crc = Descrambler.Crc32(without);
        return [.. without, (byte)(crc >> 24), (byte)(crc >> 16), (byte)(crc >> 8), (byte)crc];
    }

    /// <summary>MMT の記述子 (タグが 0xF000 以上なら長さ 2 バイト)</summary>
    public static byte[] Descriptor(ushort tag, byte[] body) => tag < 0xF000
        ? [(byte)(tag >> 8), (byte)tag, (byte)body.Length, .. body]
        : [(byte)(tag >> 8), (byte)tag, (byte)(body.Length >> 8), (byte)body.Length, .. body];

    /// <summary>M2 セクションメッセージ (0x8000) を運ぶ、スクランブルされていない MMTP の信号パケットを、ヘッダー圧縮した IP (ヘッダー無し 0x61) の TLV にしたもの</summary>
    public static byte[] M2(ushort pid, byte[] section)
    {
        byte[] message = [0x80, 0x00, 0x00, (byte)(section.Length >> 8), (byte)section.Length, .. section];
        byte[] mmtp = [0x40, 0x02, (byte)(pid >> 8), (byte)pid, 0, 0, 0, 0, 0, 0, 0, 1, 0x00, 0x00, .. message];
        return Tlv(0x03, [0x00, 0x10, 0x61, .. mmtp]);
    }

    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);
}

/*
 * カードが無くても TLV から分かること (TlvObservation.cs)。録画の 1,082 単位 (SplitTlvFake.Capture) と、組み立てた MMT-SI で確かめる
 */
public class TlvObservationTests
{
    private static TlvObservation Observe(IEnumerable<byte[]> packets)
    {
        var observation = new TlvObservation();
        foreach (var packet in packets) observation.Push(packet);
        return observation;
    }

    /// <summary>録画の単位を組み立てた TLV パケット</summary>
    private static List<byte[]> Captured() => SplitTlvFake.Assemble(new SplitTlv(), SplitTlvFake.Chunk(SplitTlvFake.Capture()));

    [Test]
    public async Task 録画の_MPT_から_CA_system_id_と_ECM_の_packet_id_を読み_ECM_を取っておく()
    {
        var observation = Observe(Captured());

        await Assert.That(observation.Package).IsEqualTo(0x00A1);
        await Assert.That(observation.AccessControl.ToList()).IsEquivalentTo(new List<(int, int)> { (0x0005, 0xFFF1) });
        var ecm = observation.Ecm;
        await Assert.That(ecm).IsNotNull();
        await Assert.That(ecm!.Value.Pid).IsEqualTo(0xFFF1);
        await Assert.That(ecm.Value.Section[0]).IsEqualTo((byte)0x82);
        await Assert.That(ecm.Value.Section.Length).IsEqualTo(160);
        await Assert.That(Descrambler.Crc32(ecm.Value.Section)).IsEqualTo(0u);
        // 映像 (0xF100) はどれも奇数の鍵でスクランブルされている
        var video = observation.Scrambling[0xF100];
        await Assert.That(video[3]).IsGreaterThan(0);
        await Assert.That(video[0] + video[1] + video[2]).IsEqualTo(0);
        // 信号 (PA メッセージ) はスクランブルされていない
        await Assert.That(observation.Scrambling[0xFF01][0]).IsGreaterThan(0);
        var lines = observation.Describe().ToList();
        await Assert.That(lines).Contains("MPT  package 0x00A1  CA_system_id 0x0005 ECM 0xFFF1  アセット hev1 0xF100 mp4a 0xF110 stpp 0xF130");
        await Assert.That(lines.Any(line => line.StartsWith("MMTP 0xF100 hev1  MPU ", StringComparison.Ordinal) && line.Contains("奇数 "))).IsTrue();
        await Assert.That(lines).Contains("ECM 0xFFF1  table_id 0x82 1 セクション (長さ 160)");
    }

    [Test]
    public async Task バイト列をどこで切って渡しても同じに読み_先頭の食い違いは読み飛ばす()
    {
        var packets = Captured();
        var whole = Observe(packets).Describe().ToList();
        var bytes = new byte[] { 0x12, 0x7F, 0x00 }.Concat(packets.SelectMany(packet => packet)).ToArray();
        var observation = new TlvObservation();
        var random = new Random(26);
        for (var at = 0; at < bytes.Length;)
        {
            var size = Math.Min(random.Next(1, 5000), bytes.Length - at);
            observation.Feed(bytes.AsSpan(at, size));
            at += size;
        }

        var lines = observation.Describe().ToList();
        await Assert.That(lines[0]).IsEqualTo(whole[0] + "  読み飛ばしたバイト 3");
        await Assert.That(lines.Skip(1)).IsEquivalentTo(whole.Skip(1));
    }

    [Test]
    public async Task TLV_NIT_と_MH_SDT_と_MH_EIT_が読めるかを出す()
    {
        // TLV-NIT: network_id 0x000B、ネットワーク名記述子 (0x40)。TLV ストリームの並びは空
        var name = TlvFake.Utf8("高度ＢＳデジタル放送");
        byte[] nitBody = [(byte)(0xF0 | ((name.Length + 2) >> 8)), (byte)(name.Length + 2), 0x40, (byte)name.Length, .. name, 0xF0, 0x00];
        var nit = TlvFake.Tlv(0xFE, TlvFake.Section(0x40, 0x000B, nitBody));
        // MH-SDT[other]: original_network_id 0x000B、局 0x0097 のサービス記述子 (0x8019)
        var service = TlvFake.Utf8("ＢＳ朝日　４Ｋ");
        var serviceDescriptor = TlvFake.Descriptor(0x8019, [0x01, 0x00, (byte)service.Length, .. service]);
        byte[] sdtBody = [0x00, 0x0B, 0xFF, 0x00, 0x97, 0xFC, (byte)(0x80 | (serviceDescriptor.Length >> 8)), (byte)serviceDescriptor.Length, .. serviceDescriptor];
        var sdt = TlvFake.M2(0x8004, TlvFake.Section(0xA0, 0xB070, sdtBody));
        // MH-EIT[p/f]: 局 0x00A1 の番組。MH-短形式イベント記述子 (0xF001。長さ 2 バイト)
        var title = TlvFake.Utf8("🈑報道１９３０");
        var shortEvent = TlvFake.Descriptor(0xF001, [(byte)'j', (byte)'p', (byte)'n', (byte)title.Length, .. title, 0x00, 0x00]);
        byte[] eitBody = [0xB1, 0x11, 0x00, 0x0B, 0x00, 0x8B, 0x00, 0x01, 0xEB, 0x3C, 0x19, 0x30, 0x00, 0x01, 0x00, 0x00, 0x80 | 0x00, (byte)shortEvent.Length, .. shortEvent];
        var eit = TlvFake.M2(0x8000, TlvFake.Section(0x8B, 0x00A1, eitBody));

        var lines = Observe([nit, sdt, eit]).Describe().ToList();

        await Assert.That(lines).Contains("TLV-NIT  読めます  network_id 0x000B「高度ＢＳデジタル放送」  1 セクション");
        await Assert.That(lines).Contains("MH-SDT  読めます  自 TLV ストリーム 0・ほか 1 セクション  0x0097「ＢＳ朝日　４Ｋ」 (ほか) free_CA_mode 0");
        await Assert.That(lines).Contains("MH-EIT  読めます  1 セクション  局 0x00A1「🈑報道１９３０」");
        await Assert.That(lines).Contains("MPT  来ていません");
    }

    [Test]
    public async Task CRC_の合わない_MH_EIT_は読めたとしない()
    {
        var section = TlvFake.Section(0x8B, 0x00A1, [0xB1, 0x11, 0x00, 0x0B, 0x00, 0x8B]);
        section[^1] ^= 0x01;

        var lines = Observe([TlvFake.M2(0x8000, section)]).Describe().ToList();

        await Assert.That(lines).Contains("MH-EIT  CRC が合いません (1 セクション)");
        await Assert.That(lines).Contains("MH-SDT  来ていません");
        await Assert.That(lines).Contains("TLV-NIT  来ていません");
    }

    /// <summary>ECM を受け取って、決めた返り値を返すカード</summary>
    private sealed class FakeCard(int code) : IKeySource
    {
        public byte[]? Asked { get; private set; }

        public CardInit Init() => new(new byte[32], new byte[8], 0x0005, [1]);

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            Asked = ecm.ToArray();
            return new EcmAnswer(new byte[8], new byte[8], code);
        }

        public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) => throw new NotSupportedException();

        public int Emm(ReadOnlySpan<byte> payload) => throw new NotSupportedException();
    }

    [Test]
    public async Task ECM_の試験は_B25_と同じ切り方で_ECM_をカードに渡し_鍵を返したかを出す()
    {
        var observation = Observe(Captured());
        var section = observation.Ecm!.Value.Section;

        var refused = new FakeCard(0xA102);
        var lines = Probe.EcmTestLines(observation, refused).ToList();
        await Assert.That(refused.Asked!.AsSpan().SequenceEqual(section.AsSpan(8, section.Length - 12))).IsTrue();
        await Assert.That(lines[0]).IsEqualTo("ECM の試験: packet_id 0xFFF1 の ECM (table_id 0x82、160 バイト。カードに渡すのは 148 バイト) をカードに渡します");
        await Assert.That(lines[1]).IsEqualTo("ECM の試験: カードの CA_system_id 0x0005。カードが鍵を返しません (0xA102)");

        var entitled = Probe.EcmTestLines(observation, new FakeCard(0x0200)).ToList();
        await Assert.That(entitled[1]).Contains("カードが鍵を返しました (0x0200)");
    }

    [Test]
    public async Task ECM_が来ていなければ_カードに渡さない()
    {
        var card = new FakeCard(0x0200);

        var lines = Probe.EcmTestLines(new TlvObservation(), card).ToList();

        await Assert.That(card.Asked).IsNull();
        await Assert.That(lines).IsEquivalentTo(new List<string> { "ECM の試験: MPT のアクセス制御記述子が来なかったため、ECM の packet_id が分かりません" });
    }
}
