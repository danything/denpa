using System.Buffers;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * B25 の解き方 (Descrambler)。
 *
 * 本物の放送もカードも要らない。PAT・PMT・ECM を自分で組み、中身を MULTI2 で
 * 掛けたパケットを作って流す。鍵はでたらめな「カード」(Cards) が ECM の頭の
 * 1 バイトで決めて返す。
 */
public class B25Tests
{
    private const int PmtPid = 0x0101;
    private const int VideoPid = 0x0111;
    private const int AudioPid = 0x0112;
    private const int EcmPid = 0x0901;

    private static readonly byte[] SystemKey = Enumerable.Range(0, 32).Select(i => (byte)(i * 7 + 3)).ToArray();
    private static readonly byte[] InitCbc = [0xfe, 0x27, 0x19, 0x99, 0x19, 0x69, 0x09, 0x11];

    /// <summary>ECM の頭の 1 バイトで鍵を決めるカード。**渡された ECM を全部覚えておく**</summary>
    private sealed class Cards : IKeySource
    {
        public List<byte[]> Asked { get; } = [];
        public Func<byte[], Exception?> Fail { get; set; } = _ => null;
        public int Code { get; set; } = 0x0200;

        public CardInit Init() => new(SystemKey, InitCbc, 0x0005, [1234567890123456]);

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            var copy = ecm.ToArray();
            Asked.Add(copy);
            if (Fail(copy) is { } error) throw error;
            return new EcmAnswer(Key(copy[0], even: false), Key(copy[0], even: true), Code);
        }
    }

    private static byte[] Key(byte generation, bool even) =>
        Enumerable.Range(0, 8).Select(i => (byte)(generation * 31 + i * 5 + (even ? 100 : 0))).ToArray();

    /// <summary>TS を組み立てる。**掛ける前の姿** (Plain) と**流す姿** (Wire) を並べて持つ</summary>
    private sealed class Ts
    {
        private readonly Dictionary<int, int> _counters = [];
        public List<byte> Wire { get; } = [];
        public List<byte> Plain { get; } = [];
        public int Scrambled { get; private set; }

        private byte Counter(int pid)
        {
            var next = _counters.GetValueOrDefault(pid);
            _counters[pid] = (next + 1) & 0x0F;
            return (byte)next;
        }

        /// <summary>節をパケットに分けて流す (pointer_field は 0、余りは 0xFF で詰める)</summary>
        public Ts Section(int pid, byte[] section)
        {
            var at = 0;
            var first = true;
            while (at < section.Length)
            {
                var packet = new byte[188];
                Array.Fill(packet, (byte)0xFF);
                packet[0] = 0x47;
                packet[1] = (byte)((first ? 0x40 : 0) | (pid >> 8));
                packet[2] = (byte)pid;
                packet[3] = (byte)(0x10 | Counter(pid));
                var start = 4;
                if (first) packet[start++] = 0;
                var take = Math.Min(188 - start, section.Length - at);
                section.AsSpan(at, take).CopyTo(packet.AsSpan(start));
                at += take;
                first = false;
                Wire.AddRange(packet);
                Plain.AddRange(packet);
            }
            return this;
        }

        public Ts Pat(params (int Number, int Pid)[] programs) =>
            Section(0, Psi(0x00, 1, programs.SelectMany(p => new[]
            {
                (byte)(p.Number >> 8), (byte)p.Number, (byte)(0xE0 | (p.Pid >> 8)), (byte)p.Pid,
            }).ToArray()));

        public Ts Pmt(int pid, int number, byte[] info, params (int Pid, byte[] Info)[] streams)
        {
            var body = new List<byte> { 0xE0 | (VideoPid >> 8), VideoPid & 0xFF, (byte)(0xF0 | (info.Length >> 8)), (byte)info.Length };
            body.AddRange(info);
            foreach (var (es, esInfo) in streams)
            {
                body.AddRange([0x02, (byte)(0xE0 | (es >> 8)), (byte)es, (byte)(0xF0 | (esInfo.Length >> 8)), (byte)esInfo.Length]);
                body.AddRange(esInfo);
            }
            return Section(pid, Psi(0x02, number, body.ToArray(), Version));
        }

        public int Version { get; set; }

        /// <summary>ECM。中身は鍵の世代 1 バイトと、それらしい長さにする詰め物</summary>
        public Ts Ecm(int pid, byte generation) =>
            Section(pid, Psi(0x82, 0, EcmBody(generation)));

        /// <summary>
        /// 中身のパケット。<paramref name="adaptation"/> バイトのアダプテーションを前に置き、
        /// 残りを <paramref name="even"/> の鍵で掛ける (null なら掛けない)
        /// </summary>
        public Ts Payload(int pid, byte? generation, bool even = true, int adaptation = -1, int seed = 0)
        {
            var packet = new byte[188];
            new Random(seed + Wire.Count).NextBytes(packet);
            packet[0] = 0x47;
            packet[1] = (byte)(pid >> 8);
            packet[2] = (byte)pid;
            var start = 4;
            if (adaptation >= 0)
            {
                packet[4] = (byte)adaptation;
                start = 5 + adaptation;
            }
            packet[3] = (byte)((adaptation >= 0 ? 0x20 : 0) | (start < 188 ? 0x10 : 0) | Counter(pid));
            Plain.AddRange(packet);

            if (generation is { } g)
            {
                var cipher = new Multi2(SystemKey, InitCbc);
                cipher.SetKeys(Key(g, even: false), Key(g, even: true));
                if (start < 188) cipher.Encrypt(even, packet.AsSpan(start));
                packet[3] |= (byte)(even ? 0x80 : 0xC0);
                Scrambled++;
            }
            Wire.AddRange(packet);
            return this;
        }

        public Ts Videos(int count, byte? generation, bool even = true)
        {
            for (var i = 0; i < count; i++) Payload(VideoPid, generation, even);
            return this;
        }
    }

    private static byte[] EcmBody(byte generation) =>
        [generation, .. Enumerable.Range(0, 100).Select(i => (byte)(i ^ 0x5A))];

    private static byte[] Ca(int ecmPid) => [0x09, 4, 0x00, 0x05, (byte)(0xE0 | (ecmPid >> 8)), (byte)ecmPid];

    private static byte[] Psi(byte tableId, int extension, byte[] body, int version = 0)
    {
        var length = 5 + body.Length + 4;
        var section = new List<byte>
        {
            tableId, (byte)(0xB0 | (length >> 8)), (byte)length,
            (byte)(extension >> 8), (byte)extension, (byte)(0xC1 | (version << 1)), 0, 0,
        };
        section.AddRange(body);
        var crc = Crc(section.ToArray());
        section.AddRange([(byte)(crc >> 24), (byte)(crc >> 16), (byte)(crc >> 8), (byte)crc]);
        return section.ToArray();
    }

    private static uint Crc(byte[] data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in data)
        {
            crc ^= (uint)value << 24;
            for (var bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        }
        return crc;
    }

    /// <summary>1本の番組、映像と音声に番組全体の ECM が掛かっている、よくある形の頭</summary>
    private static Ts Channel() => new Ts()
        .Pat((0x0400, PmtPid))
        .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []), (AudioPid, []));

    /// <summary>流したあと、掛けた印を下ろした姿。**解けたらこうなる**</summary>
    private static byte[] Expected(Ts ts)
    {
        var plain = ts.Plain.ToArray();
        for (var at = 0; at < plain.Length; at += 188) plain[at + 3] &= 0x3F;
        return plain;
    }

    private static byte[] Run(Descrambler descrambler, byte[] wire, int chunk = 188 * 64, bool flush = true)
    {
        var output = new ArrayBufferWriter<byte>();
        for (var at = 0; at < wire.Length; at += chunk)
        {
            descrambler.Decode(wire.AsSpan(at, Math.Min(chunk, wire.Length - at)), output);
        }
        if (flush) descrambler.Flush(output);
        return output.WrittenSpan.ToArray();
    }


    /// <summary>カードに聞いた ECM の世代を、聞いた順に</summary>
    private static string Generations(Cards cards) => string.Join(",", cards.Asked.Select(ecm => ecm[0]));

    /// <summary>最初に食い違ったバイトの位置。揃っていれば -1</summary>
    private static int Diff(byte[] actual, byte[] expected)
    {
        var common = Math.Min(actual.Length, expected.Length);
        for (var index = 0; index < common; index++)
        {
            if (actual[index] != expected[index]) return index;
        }
        return actual.Length == expected.Length ? -1 : common;
    }

    [Test]
    public async Task 番組全体のECMで解ける()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(50, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(50);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(descrambler.LastError).IsNull();
    }

    /// <summary>
    /// **カードに渡すのは節の頭 8 バイトと CRC を除いた中身。** libaribb25 と同じ切り方で、
    /// 拠点を跨いで鍵を貰う線がこれを運んでいる。変わると古いエージェントと通じなくなる
    /// </summary>
    [Test]
    public async Task カードに渡すのは節の頭とCRCを除いた中身()
    {
        var cards = new Cards();
        Run(new Descrambler(cards), Channel().Ecm(EcmPid, 3).Videos(3, 3).Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(Convert.ToHexString(cards.Asked[0])).IsEqualTo(Convert.ToHexString(EcmBody(3)));
    }

    /// <summary>節はパケットを跨ぐし、1つのパケットに2つ入ることもある (pointer_field の手前は前の節の尻尾)</summary>
    [Test]
    public async Task パケットを跨ぐ節も_1つのパケットに並ぶ節も読む()
    {
        // 1つ目の ECM (243 バイト) は2つのパケットを跨ぎ、2つ目のパケットにはその尻尾と2つ目の ECM が並ぶ
        byte[] body = [4, .. Enumerable.Range(0, 230).Select(i => (byte)i)];
        var first = Psi(0x82, 0, body);
        byte[] sections = [.. first, .. Psi(0x82, 0, EcmBody(5)), .. Enumerable.Repeat((byte)0xFF, 2 * 183)];
        var ts = Channel();
        byte[][] packets =
        [
            [0x47, 0x40 | (EcmPid >> 8), EcmPid & 0xFF, 0x10, 0, .. sections.AsSpan(0, 183)],
            [0x47, 0x40 | (EcmPid >> 8), EcmPid & 0xFF, 0x11, (byte)(first.Length - 183), .. sections.AsSpan(183, 183)],
        ];
        foreach (var packet in packets)
        {
            ts.Wire.AddRange(packet);
            ts.Plain.AddRange(packet);
        }
        ts.Videos(2, 5);
        var cards = new Cards();

        var output = Run(new Descrambler(cards), ts.Wire.ToArray());

        await Assert.That(Generations(cards)).IsEqualTo("4,5");
        await Assert.That(Convert.ToHexString(cards.Asked[0])).IsEqualTo(Convert.ToHexString(body));
        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
    }

    [Test]
    public async Task 同じECMはカードに聞き直さない()
    {
        var ts = Channel();
        for (var i = 0; i < 10; i++) ts.Ecm(EcmPid, 1).Videos(5, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
    }

    [Test]
    public async Task どこで区切って渡しても同じに解ける()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(20, 1).Ecm(EcmPid, 2).Videos(20, 2, even: false).Ecm(EcmPid, 2);
        var wire = ts.Wire.ToArray();
        var expected = Expected(ts);

        foreach (var chunk in new[] { 1, 7, 187, 188, 189, 376, 1000 })
        {
            var output = Run(new Descrambler(new Cards()), wire, chunk);
            await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        }

        // でたらめな長さで切っても
        var random = new Random(3);
        var descrambler = new Descrambler(new Cards());
        var writer = new ArrayBufferWriter<byte>();
        for (var at = 0; at < wire.Length;)
        {
            var take = Math.Min(random.Next(1, 700), wire.Length - at);
            descrambler.Decode(wire.AsSpan(at, take), writer);
            at += take;
        }
        descrambler.Flush(writer);
        await Assert.That(Diff(writer.WrittenSpan.ToArray(), expected)).IsEqualTo(-1);
    }

    [Test]
    public async Task ゴミを挟んでも並びを合わせ直す()
    {
        var head = Channel().Ecm(EcmPid, 1).Videos(10, 1);
        var tail = new Ts().Videos(10, 1);
        // 0x47 を混ぜたゴミ。1つだけの 0x47 に釣られないこと
        byte[] garbage = [0x00, 0x47, 0x12, 0x47, 0x47, 0x99, .. Enumerable.Repeat((byte)0x33, 300)];
        byte[] wire = [.. garbage.AsSpan(0, 50), .. head.Wire, .. garbage, .. tail.Wire];

        var descrambler = new Descrambler(new Cards());
        var output = Run(descrambler, wire, chunk: 100);

        byte[] expected = [.. Expected(head), .. Expected(tail)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Dropped).IsEqualTo(50 + garbage.Length);
    }

    [Test]
    public async Task アダプテーションの後ろだけを解く()
    {
        var ts = Channel().Ecm(EcmPid, 1)
            .Payload(VideoPid, 1, adaptation: 7)
            .Payload(VideoPid, 1, adaptation: 100)
            // 中身が 1 バイトだけ (丸ごとのブロックが無く、OFB だけで解く)
            .Payload(VideoPid, 1, adaptation: 182)
            // アダプテーションだけ。解くものは無く、印を下ろすだけ
            .Payload(VideoPid, 1, adaptation: 183);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
    }

    [Test]
    public async Task 奇数と偶数の鍵を行き来し_ECMが変われば鍵も変わる()
    {
        var ts = Channel()
            .Ecm(EcmPid, 1).Videos(5, 1, even: true).Videos(5, 1, even: false)
            .Ecm(EcmPid, 2).Videos(5, 2, even: false).Videos(5, 2, even: true)
            .Ecm(EcmPid, 3).Videos(5, 3, even: true);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(Generations(cards)).IsEqualTo("1,2,3");
    }

    /// <summary>
    /// ECM より先に来た掛かったパケットも、**溜めておいて後から来た鍵で解く**。
    /// 録画の頭が掛かったままにならない
    /// </summary>
    [Test]
    public async Task 鍵が来るまで溜めて_来たら頭から解く()
    {
        var before = Channel().Videos(30, 1);
        var ts = before.Ecm(EcmPid, 1).Videos(5, 1);
        var descrambler = new Descrambler(new Cards());
        var output = new ArrayBufferWriter<byte>();

        var wire = ts.Wire.ToArray();
        var ecmAt = (2 + 30) * 188;
        descrambler.Decode(wire.AsSpan(0, ecmAt), output);
        // 順番を崩さないので、PAT・PMT も含めて鍵を待って溜めている
        await Assert.That(output.WrittenCount).IsEqualTo(0);

        descrambler.Decode(wire.AsSpan(ecmAt), output);
        descrambler.Flush(output);
        await Assert.That(Diff(output.WrittenSpan.ToArray(), Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    /// <summary>
    /// **ECM より前は、ECM を挟んで続く偶奇の並びだけ解く。** その前の並びは
    /// 前の鍵かもしれない。解くと化けたものを「解けた」として流すので、掛かったまま流す。
    /// 並びは ECM ごとに見る — 音声だけ見ると奇数が続いていても、その間に映像が偶数へ切り替わっている
    /// </summary>
    [Test]
    public async Task 頭はECMを挟んで続く偶奇の並びだけ解く()
    {
        var ts = Channel()
            .Payload(AudioPid, 0, even: false).Payload(AudioPid, 0, even: false)
            .Videos(2, 1, even: true).Payload(AudioPid, 2, even: false)
            .Ecm(EcmPid, 2).Payload(AudioPid, 2, even: false);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.Undecodable).IsEqualTo(4);
        await Assert.That(descrambler.Decoded).IsEqualTo(2);
        var run = (2 + 4) * 188;
        await Assert.That(Diff(output[..run], ts.Wire.ToArray()[..run])).IsEqualTo(-1);
        await Assert.That(Diff(output[run..], Expected(ts)[run..])).IsEqualTo(-1);
    }

    /// <summary>**切り替わった直後に来た ECM は、もう前の鍵を持っていない。** ECM の手前で途切れた並びは解かない</summary>
    [Test]
    public async Task ECMの手前で途切れた偶奇の並びは解かない()
    {
        var ts = Channel().Videos(3, 1, even: true).Ecm(EcmPid, 2).Videos(3, 2, even: false);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.Undecodable).IsEqualTo(3);
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(Diff(output[(2 * 188)..(5 * 188)], ts.Wire.ToArray()[(2 * 188)..(5 * 188)])).IsEqualTo(-1);
    }

    /// <summary>**溜めている間に ECM が変わったら、そこで流す。** 溜めた頭は最初の鍵で、後ろは新しい鍵で解く</summary>
    [Test]
    public async Task 溜めている間にECMが変わっても溜めた頭は最初の鍵で解く()
    {
        const int other = 0x0902;
        // 2本目の ECM が来ないうちに、1本目が変わる
        var ts = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(other)))
            .Videos(3, 11, even: false).Ecm(EcmPid, 11).Videos(3, 11, even: false)
            .Ecm(EcmPid, 12).Videos(3, 12, even: false);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(9);
    }

    /// <summary>ECM が2本なら、**どちらも答えを貰うまで溜める** (片方の ES の頭が掛かったまま出ない)</summary>
    [Test]
    public async Task ECMが2本なら両方の答えを待ってから流す()
    {
        const int other = 0x0902;
        var ts = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(other)))
            .Ecm(EcmPid, 1).Videos(2, 1).Payload(AudioPid, 20);
        var before = ts.Wire.Count;
        ts.Ecm(other, 20).Payload(AudioPid, 20);
        var wire = ts.Wire.ToArray();
        var descrambler = new Descrambler(new Cards());
        var output = new ArrayBufferWriter<byte>();

        descrambler.Decode(wire.AsSpan(0, before), output);
        await Assert.That(output.WrittenCount).IsEqualTo(0);
        descrambler.Decode(wire.AsSpan(before), output);
        await Assert.That(Diff(output.WrittenSpan.ToArray(), Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    [Test]
    public async Task 鍵が来ないまま上限まで溜まったら_そのまま流す()
    {
        // PAT の無い TS。いくら待っても揃わない
        var ts = new Ts().Videos(Descrambler.HoldLimit / 188 + 10, 1);
        var wire = ts.Wire.ToArray();
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, wire, flush: false);

        // 上限に達したところで溜めたぶんを吐き、残りは溜めずに出てくる
        await Assert.That(output.Length).IsEqualTo(wire.Length);
        await Assert.That(Diff(output, wire[..output.Length])).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(output.Length / 188);
    }

    [Test]
    public async Task 掛かっていない番組は溜めずに流す()
    {
        var ts = new Ts().Pat((0x0400, PmtPid)).Pmt(PmtPid, 0x0400, [], (VideoPid, [])).Videos(10, null);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray(), flush: false);

        // PMT が揃った時点で出始める
        await Assert.That(output.Length).IsEqualTo(ts.Wire.Count);
        await Assert.That(Diff(output, ts.Wire.ToArray()[..output.Length])).IsEqualTo(-1);
    }

    [Test]
    public async Task ESごとのCA記述子が番組全体より優先する()
    {
        const int other = 0x0902;
        var ts = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []), (AudioPid, Ca(other)))
            .Ecm(EcmPid, 1).Ecm(other, 7)
            .Videos(3, 1).Payload(AudioPid, 7).Payload(AudioPid, 7, even: false).Videos(3, 1)
            .Ecm(other, 7);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(cards.Asked.Count).IsEqualTo(2);
    }

    [Test]
    public async Task 番組がいくつあっても_それぞれのECMで解く()
    {
        const int pmt2 = 0x0102, video2 = 0x0121, ecm2 = 0x0902;
        var ts = new Ts()
            .Pat((0x0400, PmtPid), (0x0401, pmt2))
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Pmt(pmt2, 0x0401, Ca(ecm2), (video2, []))
            .Ecm(EcmPid, 1).Ecm(ecm2, 9)
            .Videos(3, 1).Payload(video2, 9).Payload(video2, 9, even: false).Videos(3, 1, even: false)
            .Ecm(EcmPid, 1).Ecm(ecm2, 9);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(8);
    }

    [Test]
    public async Task PMTが変わってECMのPIDが替わっても追いかける()
    {
        const int moved = 0x0905;
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        ts.Version = 1;
        ts.Pmt(PmtPid, 0x0400, Ca(moved), (VideoPid, []), (AudioPid, []))
            .Ecm(EcmPid, 4) // もう誰も指していない。聞かない
            .Ecm(moved, 2).Videos(5, 2);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(Generations(cards)).IsEqualTo("1,2");
    }

    /// <summary>
    /// カードが失敗しても落ちない。掛かったまま流し、**次に ECM が変わったら聞き直す**
    /// </summary>
    [Test]
    public async Task カードが失敗しても流し続け_次のECMで聞き直す()
    {
        var failed = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var recovered = new Ts().Ecm(EcmPid, 2).Videos(5, 2);
        var cards = new Cards { Fail = ecm => ecm[0] == 1 ? new IOException("カードが抜けています") : null };
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, [.. failed.Wire, .. recovered.Wire]);

        // 失敗したところは掛かったまま (流す姿そのまま)、直ったところから解ける
        byte[] expected = [.. failed.Wire, .. Expected(recovered)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(5);
        await Assert.That(descrambler.Decoded).IsEqualTo(5);
        await Assert.That(descrambler.LastError).IsEqualTo("カードが抜けています");
    }

    /// <summary>
    /// **貰えなかった中身は、少し置けば同じ中身でも聞き直す。** すぐには聞き直さない —
    /// 0.1 秒おきに来る同じ ECM のたびに、固まった相手を待たない
    /// </summary>
    [Test]
    public async Task 貰えなかった中身は少し置いてから聞き直す()
    {
        var failures = 1;
        var cards = new Cards { Fail = _ => failures-- > 0 ? new IOException("カードが抜けています") : null };
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();

        descrambler.Decode(Channel().Ecm(EcmPid, 1).Videos(2, 1).Ecm(EcmPid, 1).Videos(2, 1).Wire.ToArray(), output);
        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(4);

        // 地上波で 2 秒ほど (Descrambler.RetryPackets) 流れたあとの同じ ECM
        descrambler.Decode(new Ts().Videos(25_000, null).Ecm(EcmPid, 1).Videos(2, 1).Wire.ToArray(), output);
        await Assert.That(cards.Asked.Count).IsEqualTo(2);
        await Assert.That(descrambler.Decoded).IsEqualTo(2);
    }

    [Test]
    public async Task 契約が無ければ解かずに理由を残す()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var descrambler = new Descrambler(new Cards { Code = 0x8901 });

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, ts.Wire.ToArray())).IsEqualTo(-1);
        // 解けなかったのではなく、解く資格が無い。**解除の失敗には数えない**
        await Assert.That(descrambler.Unentitled).IsEqualTo(5);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(descrambler.LastError!).Contains("0x8901");
    }


    /// <summary>**PMT より前に来た掛かったパケットも、溜めておいて、揃ったところで解く**</summary>
    [Test]
    public async Task PMTより前に来たパケットも解く()
    {
        var ts = new Ts().Pat((0x0400, PmtPid)).Videos(3, 1)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Videos(2, 1).Ecm(EcmPid, 1).Videos(2, 1);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(7);
    }

    /// <summary>
    /// **ECM が1本しか見えていなくても、PAT の PMT がみな来るまではそれで表に無い ES を解かない。**
    /// 2本目の番組の PMT がまだなだけで、その ES は別の ECM の鍵で掛かっている
    /// </summary>
    [Test]
    public async Task PMTが揃うまでは1本だけのECMで他の番組を解かない()
    {
        const int pmt2 = 0x0102, video2 = 0x0121, ecm2 = 0x0902;
        var ts = new Ts().Pat((0x0400, PmtPid), (0x0401, pmt2))
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Ecm(EcmPid, 1).Videos(2, 1)
            .Payload(video2, 9).Payload(video2, 9)
            .Pmt(pmt2, 0x0401, Ca(ecm2), (video2, []))
            .Ecm(ecm2, 9).Payload(video2, 9).Videos(2, 1);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(7);
    }

    [Test]
    public async Task 化けたECMはカードに渡さない()
    {
        var ts = Channel().Ecm(EcmPid, 1);
        // ECM の中身を 1 バイト化けさせる (CRC が合わなくなる)
        ts.Wire[2 * 188 + 20] ^= 0xFF;
        ts.Videos(3, 1);
        var cards = new Cards();

        Run(new Descrambler(cards), ts.Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(0);
    }

}
