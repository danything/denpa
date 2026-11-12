using System.Buffers.Binary;
using System.Text;

namespace Denpa.Agent.Tests;

/*
 * LAN に知らせる mDNS (Mdns.cs)。Linux の自前の応答が組むパケットを、DNS の決まりどおりに読み戻して確かめる。
 * denpa の側の読み取り (src/lib/server/agent-mdns.ts) も同じ形式を読む
 */
public class MdnsTests
{
    private const string Id = "0123456789abcdef";
    private static readonly MdnsService Service = new(Mdns.InstanceName("居間", Id), "tuner.local", 25252, Mdns.Txt(Id, "居間"));
    private static readonly string[] Browse = ["_denpa-agent", "_tcp", "local"];

    [Test]
    public async Task インスタンスの名前は指紋を足した_1_つのラベル()
    {
        await Assert.That(Mdns.InstanceName("居間", Id)).IsEqualTo("居間 (01234567)");
        // ラベルの区切りにしない
        await Assert.That(Mdns.InstanceName("tuner.local", Id)).IsEqualTo("tuner-local (01234567)");
        var longName = Mdns.InstanceName(new string('あ', 40), Id);
        await Assert.That(Encoding.UTF8.GetByteCount(longName)).IsLessThanOrEqualTo(63);
        await Assert.That(longName).EndsWith(" (01234567)");
    }

    [Test]
    public async Task TXT_はバージョンと_id_と名前だけ()
    {
        await Assert.That(Strings(Mdns.Txt(Id, "居間"))).IsEquivalentTo(new[] { "v=1", $"id={Id}", "name=居間" });
    }

    [Test]
    public async Task 型の問いには_PTR_を返し_SRV_と_TXT_を足す()
    {
        var query = MdnsMessage.ReadQuery(Query(0, Browse, 12));
        await Assert.That(query).IsNotNull();
        var answers = MdnsMessage.Answers(Service, query!.Questions);
        await Assert.That(answers).IsEquivalentTo(new[] { MdnsAnswer.Browse });

        var packet = Read(MdnsMessage.Response(Service, 0, null, answers));
        await Assert.That(packet.Id).IsEqualTo((ushort)0);
        await Assert.That(packet.Questions).IsEmpty();
        await Assert.That(packet.Answers.Count).IsEqualTo(1);
        var ptr = packet.Answers[0];
        await Assert.That(ptr.Name).IsEqualTo("_denpa-agent._tcp.local");
        await Assert.That(ptr.Type).IsEqualTo((ushort)12);
        await Assert.That(ptr.Class).IsEqualTo((ushort)1);
        await Assert.That(ptr.Ttl).IsEqualTo(4500u);
        await Assert.That(ptr.Target).IsEqualTo("居間 (01234567)._denpa-agent._tcp.local");

        await Assert.That(packet.Additional.Count).IsEqualTo(2);
        var srv = packet.Additional.Single(record => record.Type == 33);
        await Assert.That(srv.Name).IsEqualTo("居間 (01234567)._denpa-agent._tcp.local");
        // キャッシュを捨てる印 (0x8000) が付く
        await Assert.That(srv.Class).IsEqualTo((ushort)0x8001);
        await Assert.That(srv.Ttl).IsEqualTo(120u);
        await Assert.That(srv.Port).IsEqualTo((ushort)25252);
        await Assert.That(srv.Target).IsEqualTo("tuner.local");
        var txt = packet.Additional.Single(record => record.Type == 16);
        await Assert.That(Strings(txt.Data)).IsEquivalentTo(new[] { "v=1", $"id={Id}", "name=居間" });
    }

    [Test]
    public async Task 送り元が_5353_でない問いには_ID_と問いを付け_TTL_を短くする()
    {
        var query = MdnsMessage.ReadQuery(Query(0x1234, Browse, 12))!;
        var packet = Read(MdnsMessage.Response(Service, query.Id, query.Questions, MdnsMessage.Answers(Service, query.Questions)));
        await Assert.That(packet.Id).IsEqualTo((ushort)0x1234);
        await Assert.That(packet.Questions).IsEquivalentTo(new[] { "_denpa-agent._tcp.local" });
        foreach (var record in packet.Answers.Concat(packet.Additional))
        {
            await Assert.That(record.Ttl).IsLessThanOrEqualTo(10u);
            await Assert.That(record.Class).IsEqualTo((ushort)1);
        }
    }

    [Test]
    public async Task インスタンスとサービスの一覧の問いにも答え_ほかには答えない()
    {
        string[] instance = ["居間 (01234567)", "_denpa-agent", "_tcp", "local"];
        await Assert.That(AnswersTo(instance, 33)).IsEquivalentTo(new[] { MdnsAnswer.Srv });
        await Assert.That(AnswersTo(instance, 255)).IsEquivalentTo(new[] { MdnsAnswer.Srv, MdnsAnswer.Txt });
        await Assert.That(AnswersTo(["_services", "_dns-sd", "_udp", "local"], 12)).IsEquivalentTo(new[] { MdnsAnswer.Services });
        // 大文字と小文字は区別しない
        await Assert.That(AnswersTo(["_DENPA-AGENT", "_TCP", "LOCAL"], 12)).IsEquivalentTo(new[] { MdnsAnswer.Browse });
        await Assert.That(AnswersTo(["_http", "_tcp", "local"], 12)).IsEmpty();
    }

    [Test]
    public async Task 止めるときは_TTL_0_で送る()
    {
        var packet = Read(MdnsMessage.Response(Service, 0, null, MdnsMessage.Announcement, goodbye: true));
        await Assert.That(packet.Answers.Count + packet.Additional.Count).IsEqualTo(3);
        foreach (var record in packet.Answers.Concat(packet.Additional)) await Assert.That(record.Ttl).IsEqualTo(0u);
    }

    [Test]
    public async Task 答えと壊れたパケットは問いとして読まない()
    {
        await Assert.That(MdnsMessage.ReadQuery(MdnsMessage.Response(Service, 0, null, MdnsMessage.Announcement))).IsNull();
        await Assert.That(MdnsMessage.ReadQuery(new byte[5])).IsNull();
        // 名前の圧縮が自分を指す (輪)
        byte[] loop = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1];
        await Assert.That(MdnsMessage.ReadQuery(loop)).IsNull();
    }

    // --- 読み書きの手伝い ---------------------------------------------------

    private static List<MdnsAnswer> AnswersTo(string[] name, ushort type) =>
        MdnsMessage.Answers(Service, MdnsMessage.ReadQuery(Query(0, name, type))!.Questions);

    private static byte[] Query(ushort id, string[] name, ushort type)
    {
        var bytes = new List<byte> { (byte)(id >> 8), (byte)id, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0 };
        foreach (var label in name)
        {
            var encoded = Encoding.UTF8.GetBytes(label);
            bytes.Add((byte)encoded.Length);
            bytes.AddRange(encoded);
        }
        bytes.AddRange([0, (byte)(type >> 8), (byte)type, 0, 1]);
        return [.. bytes];
    }

    private static string[] Strings(byte[] txt)
    {
        List<string> found = [];
        for (var at = 0; at < txt.Length; at += 1 + txt[at]) found.Add(Encoding.UTF8.GetString(txt, at + 1, txt[at]));
        return [.. found];
    }

    private sealed record Rr(string Name, ushort Type, ushort Class, uint Ttl, byte[] Data, string? Target, ushort Port);

    private sealed record Packet(ushort Id, List<string> Questions, List<Rr> Answers, List<Rr> Additional);

    private static string NameAt(byte[] bytes, ref int offset) => string.Join('.', MdnsMessage.ReadName(bytes, ref offset)!);

    private static Packet Read(byte[] bytes)
    {
        var id = BinaryPrimitives.ReadUInt16BigEndian(bytes);
        if (BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(2)) != 0x8400) throw new InvalidDataException("答えの印が無い");
        int Count(int at) => BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(at));
        var offset = 12;
        List<string> questions = [];
        for (var index = 0; index < Count(4); index++)
        {
            questions.Add(NameAt(bytes, ref offset));
            offset += 4;
        }
        List<Rr> Records(int count)
        {
            List<Rr> records = [];
            for (var index = 0; index < count; index++)
            {
                var name = NameAt(bytes, ref offset);
                var type = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset));
                var klass = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset + 2));
                var ttl = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset + 4));
                var length = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset + 8));
                offset += 10;
                var data = bytes.AsSpan(offset, length).ToArray();
                string? target = null;
                ushort port = 0;
                var inner = offset;
                if (type == 12) target = NameAt(bytes, ref inner);
                if (type == 33)
                {
                    port = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset + 4));
                    inner = offset + 6;
                    target = NameAt(bytes, ref inner);
                }
                offset += length;
                records.Add(new Rr(name, type, klass, ttl, data, target, port));
            }
            return records;
        }
        var answers = Records(Count(6));
        Records(Count(8));
        var additional = Records(Count(10));
        if (offset != bytes.Length) throw new InvalidDataException("余りがある");
        return new Packet(id, questions, answers, additional);
    }
}
