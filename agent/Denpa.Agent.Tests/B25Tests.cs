using System.Buffers;
using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * B25 の復号のしかた (Descrambler)。
 *
 * 本物の放送もカードも要らない。PAT・PMT・ECM を自分で組み、中身を MULTI2 で
 * スクランブルしたパケットを作って流す。鍵はでたらめな「カード」(Cards) が ECM の先頭の
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

    /// <summary>ECM の先頭の 1 バイトで鍵を決めるカード。**渡された ECM を全部記録しておく**</summary>
    private sealed class Cards : IKeySource
    {
        public List<byte[]> Asked { get; } = [];
        public Func<byte[], Exception?> Fail { get; set; } = _ => null;
        public int Code { get; set; } = 0x0200;
        /// <summary>キャッシュした応答を返した・ロックを待った、と返す (選局の内訳の記録)</summary>
        public bool Cached { get; set; }
        public long WaitedMs { get; set; }

        /// <summary>カードの番号 (EMM の宛先と比べる 48 ビット)</summary>
        public long[] Ids { get; set; } = [1234567890123456];
        /// <summary>カードに渡した EMM のペイロード (作業スレッドから足すので、読むときはロックを取る)</summary>
        public List<byte[]> Emms { get; } = [];
        /// <summary>EMM を渡されたときに呼ぶ (遅いカードを真似る)</summary>
        public Action? OnEmm { get; set; }

        public CardInit Init() => new(SystemKey, InitCbc, 0x0005, Ids);

        public int Emm(ReadOnlySpan<byte> payload)
        {
            lock (Emms) Emms.Add(payload.ToArray());
            OnEmm?.Invoke();
            return 0x2100;
        }

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            var copy = ecm.ToArray();
            Asked.Add(copy);
            if (Fail(copy) is { } error) throw error;
            return new EcmAnswer(Key(copy[0], even: false), Key(copy[0], even: true), Code, Cached, WaitedMs);
        }

        public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) => Code;
    }

    private static byte[] Key(byte generation, bool even) =>
        Enumerable.Range(0, 8).Select(i => (byte)(generation * 31 + i * 5 + (even ? 100 : 0))).ToArray();

    /// <summary>TS を組み立てる。**スクランブルする前の中身** (Plain) と**流す中身** (Wire) を並べて持つ</summary>
    private sealed class Ts
    {
        private readonly Dictionary<int, int> _counters = [];
        public List<byte> Wire { get; } = [];
        public List<byte> Plain { get; } = [];

        private byte Counter(int pid)
        {
            var next = _counters.GetValueOrDefault(pid);
            _counters[pid] = (next + 1) & 0x0F;
            return (byte)next;
        }

        /// <summary>セクションをパケットに分けて流す (pointer_field は 0、余りは 0xFF で詰める)</summary>
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
        /// 残りを <paramref name="even"/> の鍵でスクランブルする (null ならスクランブルしない)。<paramref name="pes"/> なら PES の先頭
        /// (payload_unit_start と <c>00 00 01</c>) にする。<paramref name="keyEven"/> を渡すと、印と違う偶奇の鍵でスクランブルする
        /// </summary>
        public Ts Payload(int pid, byte? generation, bool even = true, int adaptation = -1, int seed = 0, bool pes = false, bool? keyEven = null)
        {
            var packet = new byte[188];
            new Random(seed + Wire.Count).NextBytes(packet);
            packet[0] = 0x47;
            packet[1] = (byte)((pes ? 0x40 : 0) | (pid >> 8));
            packet[2] = (byte)pid;
            var start = 4;
            if (adaptation >= 0)
            {
                packet[4] = (byte)adaptation;
                start = 5 + adaptation;
            }
            packet[3] = (byte)((adaptation >= 0 ? 0x20 : 0) | (start < 188 ? 0x10 : 0) | Counter(pid));
            // 中身が 4 バイトに満たなければ、入るぶんだけ書く
            if (pes) new byte[] { 0x00, 0x00, 0x01, 0xE0 }.AsSpan(0, Math.Min(4, 188 - start)).CopyTo(packet.AsSpan(start));
            Plain.AddRange(packet);

            if (generation is { } g)
            {
                var cipher = new Multi2(SystemKey, InitCbc);
                cipher.SetKeys(Key(g, even: false), Key(g, even: true));
                if (start < 188) cipher.Encrypt(keyEven ?? even, packet.AsSpan(start));
                packet[3] |= (byte)(even ? 0x80 : 0xC0);
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

    /// <summary>1 本の番組、映像と音声に番組全体の ECM でスクランブルされた、よくある形式の先頭</summary>
    private static Ts Channel() => new Ts()
        .Pat((0x0400, PmtPid))
        .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []), (AudioPid, []));

    /// <summary>流したあと、スクランブルの印を下ろした中身。**復号できたらこうなる**</summary>
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

    /// <summary>カードに問い合わせた ECM の世代を、問い合わせた順に</summary>
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
    public async Task 番組全体の_ECM_で復号できる()
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
    /// **カードに渡すのはセクションの先頭 8 バイトと CRC を除いた中身。** libaribb25 と同じ切り方で、
    /// 拠点を跨いで鍵を受け取るときもこれを運ぶ。変わると古いエージェントとやり取りできなくなる
    /// </summary>
    [Test]
    public async Task カードに渡すのはセクションの先頭と_CRC_を除いた中身()
    {
        var cards = new Cards();
        Run(new Descrambler(cards), Channel().Ecm(EcmPid, 3).Videos(3, 3).Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(Convert.ToHexString(cards.Asked[0])).IsEqualTo(Convert.ToHexString(EcmBody(3)));
    }

    /// <summary>セクションはパケットを跨ぐし、1 つのパケットに 2 つ入ることもある (pointer_field の手前は前のセクションの尻尾)</summary>
    [Test]
    public async Task パケットを跨ぐセクションも_1_つのパケットに並ぶセクションも読む()
    {
        // 1 つ目の ECM (243 バイト) は 2 つのパケットを跨ぎ、2 つ目のパケットにはその尻尾と 2 つ目の ECM が並ぶ
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
    public async Task 同じ_ECM_でカードに問い合わせ直さない()
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
    public async Task どこで区切って渡しても同じに復号できる()
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
        // 0x47 を混ぜたゴミ。1 つだけの 0x47 に合わせないこと
        byte[] garbage = [0x00, 0x47, 0x12, 0x47, 0x47, 0x99, .. Enumerable.Repeat((byte)0x33, 300)];
        byte[] wire = [.. garbage.AsSpan(0, 50), .. head.Wire, .. garbage, .. tail.Wire];

        var descrambler = new Descrambler(new Cards());
        var output = Run(descrambler, wire, chunk: 100);

        byte[] expected = [.. Expected(head), .. Expected(tail)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
    }

    [Test]
    public async Task アダプテーションの後ろだけを復号する()
    {
        var ts = Channel().Ecm(EcmPid, 1)
            .Payload(VideoPid, 1, adaptation: 7)
            .Payload(VideoPid, 1, adaptation: 100)
            // 中身が 1 バイトだけ (丸ごとのブロックが無く、OFB だけで復号する)
            .Payload(VideoPid, 1, adaptation: 182)
            // アダプテーションだけ。復号するものは無く、印を下ろすだけ
            .Payload(VideoPid, 1, adaptation: 183);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
    }

    [Test]
    public async Task 奇数と偶数の鍵を行き来し_ECM_が変われば鍵も変わる()
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
    /// ECM より先に来たスクランブルされたパケットも、**溜めておいて後から来た鍵で復号する**。
    /// 録画の先頭がスクランブルされたままにならない
    /// </summary>
    [Test]
    public async Task 鍵が来るまで溜めて_来たら先頭から復号する()
    {
        var ts = Channel().Videos(30, 1).Ecm(EcmPid, 1).Videos(5, 1);
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
    /// **ECM より前は、ECM を挟んで続く偶奇の並びだけ復号する。** その前の並びは
    /// 前の鍵かもしれない。復号すると化けたものを「復号できた」として流すので、スクランブルされたまま流す。
    /// 並びは ECM ごとに確かめる。音声だけで確かめると奇数が続いていても、その間に映像が偶数へ切り替わっている
    /// </summary>
    [Test]
    public async Task 先頭は_ECM_を挟んで続く偶奇の並びだけ復号する()
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

    /// <summary>**切り替わった直後に来た ECM は、もう前の鍵を持っていない。** ECM の手前で途切れた並びは復号しない</summary>
    [Test]
    public async Task ECM_の手前で途切れた偶奇の並びは復号しない()
    {
        var ts = Channel().Videos(3, 1, even: true).Ecm(EcmPid, 2).Videos(3, 2, even: false);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.Undecodable).IsEqualTo(3);
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(Diff(output[(2 * 188)..(5 * 188)], ts.Wire.ToArray()[(2 * 188)..(5 * 188)])).IsEqualTo(-1);
    }

    /// <summary>**溜めている間に ECM が変わったら、そこで流す。** 溜めた先頭は最初の鍵で、後ろは新しい鍵で復号する</summary>
    [Test]
    public async Task 溜めている間に_ECM_が変わっても溜めた先頭は最初の鍵で復号する()
    {
        const int other = 0x0902;
        // 2 本目の ECM が来ないうちに、1 本目が変わる
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

    /// <summary>ECM が 2 本なら、**どちらも応答を受け取るまで溜める** (片方の ES の先頭がスクランブルされたまま出ない)</summary>
    [Test]
    public async Task ECM_が_2_本なら両方の応答を待ってから流す()
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

        // 上限に達したところで溜めたぶんを書き出し、残りは溜めずに出てくる
        await Assert.That(output.Length).IsEqualTo(wire.Length);
        await Assert.That(Diff(output, wire[..output.Length])).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(output.Length / 188);
    }

    [Test]
    public async Task スクランブルされていない番組は溜めずに流す()
    {
        var ts = new Ts().Pat((0x0400, PmtPid)).Pmt(PmtPid, 0x0400, [], (VideoPid, [])).Videos(10, null);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray(), flush: false);

        // PMT が揃った時点で出始める
        await Assert.That(output.Length).IsEqualTo(ts.Wire.Count);
        await Assert.That(Diff(output, ts.Wire.ToArray()[..output.Length])).IsEqualTo(-1);
    }

    [Test]
    public async Task ES_ごとの_CA_記述子が番組全体より優先する()
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

    /// <summary>
    /// **PES の先頭がどの鍵でも <c>00 00 01</c> にならなければ、スクランブルされたまま流す。** その PES の残りも次の PES の先頭まで
    /// スクランブルされたまま流し、Undecodable に数える (化けた中身を「復号できた」として流さない。契約の復号テストもこれで落ちる)
    /// </summary>
    [Test]
    public async Task 鍵が合わない_PES_はスクランブルされたまま流し_次の_PES_の先頭から復号する()
    {
        // カードが返すのは世代 1 の鍵。最初の PES だけ、カードが返さない世代 9 の鍵でスクランブルされている
        var ts = Channel().Ecm(EcmPid, 1).Payload(VideoPid, 9, pes: true).Videos(3, 9);
        var garbled = ts.Wire.Count;
        ts.Payload(VideoPid, 1, pes: true).Videos(3, 1);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        byte[] expected = [.. ts.Wire.Take(garbled), .. Expected(ts).Skip(garbled)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(4);
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
        await Assert.That(descrambler.LastError).IsNotNull();
    }

    /// <summary>
    /// **偶奇の対応は STD-B25 のとおり固定で、逆の鍵は試さない。** 印と違う偶奇の鍵でスクランブルされた PES は、
    /// 先頭で合わないと分かるので、その PES をスクランブルされたまま流して復号できなかったに数える
    /// </summary>
    [Test]
    public async Task 印と違う偶奇の鍵でスクランブルされた_PES_は復号できなかったに数える()
    {
        var ts = Channel().Ecm(EcmPid, 1)
            .Payload(VideoPid, 1, even: true, pes: true, keyEven: false)
            .Payload(VideoPid, 1, even: true, keyEven: false);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, ts.Wire.ToArray())).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(2);
        await Assert.That(descrambler.LastError).IsNotNull();
    }

    /// <summary>
    /// **中身が 3 バイトに満たず確かめられない PES の先頭は、前の PES が合わなかったことを引き継がない。** その PES は
    /// 今の鍵で復号する (前の PES の残りと同じに扱うと、次の PES の先頭までスクランブルされたまま流してしまう)
    /// </summary>
    [Test]
    public async Task 確かめられない短い_PES_の先頭からは_前の_PES_の不一致を引き継がない()
    {
        var ts = Channel().Ecm(EcmPid, 1).Payload(VideoPid, 9, pes: true).Videos(1, 9);
        var garbled = ts.Wire.Count;
        // アダプテーションが 182 バイトで、中身は 1 バイトだけ
        ts.Payload(VideoPid, 1, pes: true, adaptation: 182).Videos(2, 1);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        byte[] expected = [.. ts.Wire.Take(garbled), .. Expected(ts).Skip(garbled)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(2);
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
    }

    /// <summary>
    /// **stream_type 0x06 (字幕と、セクションのデータの両方に使う) は先頭を確かめない。** セクションを PES の先頭と
    /// 比べると、合っている鍵でもスクランブルされたままにしてしまう
    /// </summary>
    [Test]
    public async Task 字幕とデータの_ES_は先頭を確かめない()
    {
        var ts = new Ts().Pat((0x0400, PmtPid));
        var body = new List<byte> { 0xE0 | (VideoPid >> 8), VideoPid & 0xFF, 0xF0, 6 };
        body.AddRange(Ca(EcmPid));
        body.AddRange([0x06, 0xE0 | (AudioPid >> 8), AudioPid & 0xFF, 0xF0, 0]);
        ts.Section(PmtPid, Psi(0x02, 0x0400, [.. body]))
            .Ecm(EcmPid, 1)
            // データのセクション。payload_unit_start が立っていて、先頭は 00 00 01 ではない
            .Payload(AudioPid, 1, pes: true);
        var plain = ts.Plain.Count - 188;
        ts.Plain[plain + 6] = 0x02;
        // スクランブルする前の中身を変えたので、スクランブルしたものも作り直す
        var cipher = new Multi2(SystemKey, InitCbc);
        cipher.SetKeys(Key(1, even: false), Key(1, even: true));
        var packet = ts.Plain.Skip(plain).ToArray();
        cipher.Encrypt(true, packet.AsSpan(4));
        packet[3] |= 0x80;
        ts.Wire.RemoveRange(ts.Wire.Count - 188, 188);
        ts.Wire.AddRange(packet);
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    [Test]
    public async Task 番組がいくつあっても_それぞれの_ECM_で復号する()
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
    public async Task PMT_が変わって_ECM_の_PID_が替わっても追いかける()
    {
        const int moved = 0x0905;
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        ts.Version = 1;
        ts.Pmt(PmtPid, 0x0400, Ca(moved), (VideoPid, []), (AudioPid, []))
            .Ecm(EcmPid, 4) // もうどの PMT も挙げていない。問い合わせない
            .Ecm(moved, 2).Videos(5, 2);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(Generations(cards)).IsEqualTo("1,2");
    }

    /// <summary>
    /// カードが失敗しても止まらない。スクランブルされたまま流し、**次に ECM が変わったら問い合わせ直す**
    /// </summary>
    [Test]
    public async Task カードが失敗しても流し続け_次の_ECM_で問い合わせ直す()
    {
        var failed = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var recovered = new Ts().Ecm(EcmPid, 2).Videos(5, 2);
        var cards = new Cards { Fail = ecm => ecm[0] == 1 ? new IOException("カードが抜けています") : null };
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, [.. failed.Wire, .. recovered.Wire]);

        // 失敗したところはスクランブルされたまま (流す中身そのまま)、直ったところから復号できる
        byte[] expected = [.. failed.Wire, .. Expected(recovered)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(5);
        await Assert.That(descrambler.Decoded).IsEqualTo(5);
        await Assert.That(descrambler.LastError).IsEqualTo("カードが抜けています");
    }

    /// <summary>
    /// **鍵を受け取れなかった中身は、少し置けば同じ中身でも問い合わせ直す。** すぐには問い合わせ直さず、
    /// 0.1 秒おきに来る同じ ECM のたびに、応答しないカードを待たない
    /// </summary>
    [Test]
    public async Task 鍵を受け取れなかった中身は少し置いてから問い合わせ直す()
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
    public async Task 契約が無ければ復号せずに理由を残す()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var descrambler = new Descrambler(new Cards { Code = 0x8901 });

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, ts.Wire.ToArray())).IsEqualTo(-1);
        // 復号できなかったのではなく、復号する資格が無い。**復号の失敗には数えない**
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(descrambler.LastError!).Contains("0x8901");
    }

    /// <summary>**PMT より前に来たスクランブルされたパケットも、溜めておいて、揃ったところで復号する**</summary>
    [Test]
    public async Task PMT_より前に来たパケットも復号する()
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
    /// **ECM が 1 本しか来ていなくても、PAT の PMT がみな来るまではそれで表に無い ES を復号しない。**
    /// 2 本目の番組の PMT がまだなだけで、その ES は別の ECM の鍵でスクランブルされている
    /// </summary>
    [Test]
    public async Task PMT_が揃うまでは_1_本だけの_ECM_で他の番組を復号しない()
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

    /// <summary>
    /// **ワンセグの PMT がくり返し来ても、表に無い PID のスクランブルされたパケットが流れている間は溜め続ける。**
    /// 本番 (2026-11-11、PT3 の地上波 T19) では、ワンセグの PMT が 2 回来た時点で「来ない PMT は来ない」として溜めるのをやめ、
    /// 番組の PMT と ECM が来る前のパケットをスクランブルされたまま流していた (カード 0 回・1345 パケット)。
    /// 流れている ES は、その番組の PMT がまだ来ていないだけ
    /// </summary>
    [Test]
    public async Task ワンセグの_PMT_がくり返し来ても番組の_PMT_と_ECM_を待つ()
    {
        const int onesegPmt = 0x1FC8;
        var ts = new Ts()
            .Pmt(onesegPmt, 0x05A8, [], (0x0181, []))
            .Pat((0x0400, PmtPid), (0x0401, PmtPid + 1), (0x05A8, onesegPmt))
            .Videos(3, 1)
            .Pmt(onesegPmt, 0x05A8, [], (0x0181, []))
            .Videos(3, 1)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Ecm(EcmPid, 1).Videos(3, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>
    /// **ECM が 2 回来ても、PMT がそろうまでは溜めるのをやめない。** 本番 (2026-11-11、PT3 の地上波 T27・T23・T26) では、ほかの番組の
    /// PMT が挙げた ECM が 2 回来た時点で溜めるのをやめ、まだ PMT の来ていない番組の ES をスクランブルされたまま流していた
    /// (「PMT -」で 138〜538 パケット)。denpa はそれを「契約されていない」と読んで止めた
    /// </summary>
    [Test]
    public async Task ECM_が_2_回来ても_PMT_がそろうまでは溜める()
    {
        const int pmt2 = 0x0102, video2 = 0x0121;
        var ts = new Ts()
            .Pat((0x0400, PmtPid), (0x0401, pmt2))
            .Pmt(pmt2, 0x0401, Ca(EcmPid), (video2, []))
            .Ecm(EcmPid, 1).Videos(3, 1).Payload(video2, 1)
            .Ecm(EcmPid, 1).Videos(2, 1)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Videos(2, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>
    /// **PMT を待つ間に ECM が変わったら、新しい鍵で復号するのは新しい ECM を挟んで続く偶奇の並びだけ。**
    /// その前の並びは前の鍵で、新しい鍵で復号すると化けたものを「復号できた」として流す
    /// </summary>
    [Test]
    public async Task PMT_を待つ間に_ECM_が変わったら前の並びは復号しない()
    {
        const int pmt2 = 0x0102, video2 = 0x0121;
        var ts = new Ts()
            .Pat((0x0400, PmtPid), (0x0401, pmt2))
            .Pmt(pmt2, 0x0401, Ca(EcmPid), (video2, []))
            .Ecm(EcmPid, 1).Payload(video2, 1).Videos(3, 1, even: true);
        var run = ts.Wire.Count;
        ts.Ecm(EcmPid, 2).Videos(2, 2, even: false)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Videos(2, 2, even: false);
        var wire = ts.Wire.ToArray();
        var descrambler = new Descrambler(new Cards());

        var output = Run(descrambler, wire);

        // 前の鍵の並び (video2 の 1 つと映像の 3 つ) はスクランブルされたまま、新しい ECM のあとは復号できる
        var head = 3 * 188;
        await Assert.That(Diff(output[head..run], wire[head..run])).IsEqualTo(-1);
        await Assert.That(Diff(output[run..], Expected(ts)[run..])).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(4);
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
    }

    [Test]
    public async Task 化けた_ECM_はカードに渡さない()
    {
        var ts = Channel().Ecm(EcmPid, 1);
        // ECM の中身を 1 バイト化けさせる (CRC が合わなくなる)
        ts.Wire[2 * 188 + 20] ^= 0xFF;
        ts.Videos(3, 1);
        var cards = new Cards();

        Run(new Descrambler(cards), ts.Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(0);
    }

    /// <summary>
    /// **PAT より先に来た PMT・ECM を取っておく。** PAT が来た時点で鍵が揃っているので、PMT や ECM の
    /// 次の周を待たずに流し始める (前は PAT → PMT → ECM の順に来るまで溜めていた)
    /// </summary>
    [Test]
    public async Task PAT_より先に来た_PMT_と_ECM_で早く流し始める()
    {
        var ts = new Ts()
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []), (AudioPid, []))
            .Ecm(EcmPid, 1).Videos(3, 1)
            .Pat((0x0400, PmtPid))
            .Videos(3, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        // 終わりの書き出し (Flush) をしなくても、全部が復号されて出てくる
        var output = Run(descrambler, ts.Wire.ToArray(), flush: false);

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(6);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>PAT が挙げない PID から来ていた PMT は使わない。PAT の PID から来る PMT を待つ</summary>
    [Test]
    public async Task PAT_が挙げない_PID_の_PMT_は使わない()
    {
        var ts = new Ts()
            .Pmt(0x0105, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Ecm(EcmPid, 1)
            .Pat((0x0400, PmtPid))
            .Videos(3, 1);

        var output = Run(new Descrambler(new Cards()), ts.Wire.ToArray(), flush: false);

        // 確かめた PMT がまだ無いので溜めたまま
        await Assert.That(output.Length).IsEqualTo(0);
    }

    /// <summary>
    /// **PMT が挙げない PID の ECM は、鍵を使わないうえにカードに問い合わせもしない。** B-CAS のカードが断る ECM で問い合わせると、
    /// 断られるまで次のパケットへ進めない
    /// </summary>
    [Test]
    public async Task PMT_が挙げない_PID_の_ECM_は使わない()
    {
        const int stray = 0x0903;
        var ts = new Ts()
            .Ecm(stray, 7)
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Ecm(EcmPid, 1).Videos(3, 1)
            .Ecm(stray, 8).Videos(3, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>
    /// **PMT より先に来た ECM は、PMT が挙げたその場で問い合わせる。** 次の ECM を待たないので、PMT のすぐあとの
    /// ES のパケットで流し始める (前は PMT のあとに来る ECM を待ってから問い合わせていた)
    /// </summary>
    [Test]
    public async Task PMT_より先に来た_ECM_は_PMT_が挙げたその場で問い合わせる()
    {
        var head = new Ts()
            .Pat((0x0400, PmtPid))
            .Ecm(EcmPid, 1).Videos(3, 1)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Videos(1, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards);

        var output = Run(descrambler, head.Wire.ToArray(), flush: false);

        await Assert.That(Diff(output, Expected(head))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>
    /// **地上波の並びで、カードが断る ECM が流れていても、問い合わせずに鍵の揃った時点で流し始める。** PAT・PMT・ECM が
    /// 0.1 秒 (地上波の 1,120 パケットほど) おきに来て、番組は 3 つ (PMT が来ない臨時の番組と、スクランブルされていない
    /// ワンセグを含む)。番組の PMT は B-CAS と別の方式の CA 記述子も持ち、その方式の ECM はカードが断る。
    ///
    /// <para>
    /// 本番 (2026-10-26) では、先回りで読んだその ECM でカードに問い合わせ、断られるまでの 0.4 秒ほど止まっていた
    /// (選局から送り出しまで毎回 1 秒ほど)。止まっている時間はパケットの数では測れないので、断る ECM で
    /// 問い合わせないことと、流し始める位置が前の決め方 (PAT → PMT → その後の ECM で問い合わせる) より後ろにならないことを確かめる
    /// </para>
    /// </summary>
    [Test]
    public async Task 地上波の並びでカードが断る_ECM_で問い合わせずに流し始める()
    {
        const int period = 1120, onesegPmt = 0x1FC8, foreignEcm = 0x0904, refused = 0x99;
        byte[] foreignCa = [0x09, 4, 0x00, 0x06, (byte)(0xE0 | (foreignEcm >> 8)), foreignEcm & 0xFF];
        var ts = new Ts();
        // 周の中の位置
        const int atPat = 0, atPmt = 40, atOneseg = 80, atForeign = 120, atEcm = 160;
        for (var cycle = 0; cycle < 6; cycle++)
        {
            for (var i = 0; i < period; i++)
            {
                if (i == atPat) ts.Pat((0x0400, PmtPid), (0x0401, PmtPid + 1), (0x05A8, onesegPmt));
                else if (i == atPmt) ts.Pmt(PmtPid, 0x0400, [.. Ca(EcmPid), .. foreignCa], (VideoPid, []), (AudioPid, []));
                else if (i == atOneseg) ts.Pmt(onesegPmt, 0x05A8, [], (0x0181, []));
                else if (i == atForeign) ts.Section(foreignEcm, Psi(0x82, 0, EcmBody(refused)));
                else if (i == atEcm) ts.Ecm(EcmPid, 1);
                else if (i % 50 == 0) ts.Payload(0x0181, null);
                else ts.Payload(i % 10 == 0 ? AudioPid : VideoPid, 1);
            }
        }
        var wire = ts.Wire.ToArray();

        // 選局はどの位置からでも始まる
        foreach (var start in new[] { 0, 100, 150, 300, 700, 1100 })
        {
            var cards = new Cards { Fail = ecm => ecm[0] == refused ? new CardRefusedException("断った") : null };
            var descrambler = new Descrambler(cards);
            var output = new ArrayBufferWriter<byte>();
            var fed = 0;
            while (output.WrittenCount == 0)
            {
                descrambler.Decode(wire.AsSpan((start + fed) * 188, 188), output);
                fed++;
            }

            await Assert.That(Generations(cards)).IsEqualTo("1");
            await Assert.That(descrambler.LastError).IsNull();
            // 前の決め方: PAT のあとの PMT、そのあとの ECM で問い合わせ、PMT がもう一度来たか ECM がもう一度来たところで流す
            var pat = Next(start, atPat);
            var pmt = Next(pat, atPmt);
            var ecm = Next(pmt, atEcm);
            var before = Math.Min(Next(ecm, atPmt), Next(ecm + 1, atEcm)) + 1;
            await Assert.That(start + fed).IsLessThanOrEqualTo(before);
        }

        // at より後ろ (at を含む) で、周の中の位置が offset のパケット
        static int Next(int at, int offset) => at + ((offset - at % period) % period + period) % period;
    }

    /// <summary>
    /// **ES の PES の先頭を ECM と取り違えない。** PES は <c>00 00 01</c> で始まるので、セクションとして読むと
    /// pointer_field 0・table_id 0x00 になる。後ろに 0x82 が並んでいても ECM として読まない
    /// </summary>
    [Test]
    public async Task スクランブルされていない_PES_の先頭を_ECM_と読まない()
    {
        var ts = new Ts();
        byte[] pes = [0x47, 0x40 | (0x0113 >> 8), 0x0113 & 0xFF, 0x10, 0x00, 0x00, 0x01, 0xE0, .. Enumerable.Repeat((byte)0x82, 180)];
        byte[] shifted = [0x47, 0x40 | (0x0114 >> 8), 0x0114 & 0xFF, 0x10, 0x00, 0x00, 0x00, 0x01, .. Enumerable.Repeat((byte)0x82, 180)];
        foreach (var packet in new[] { pes, shifted })
        {
            ts.Wire.AddRange(packet);
            ts.Plain.AddRange(packet);
        }
        ts.Pat((0x0400, PmtPid)).Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, [])).Ecm(EcmPid, 1).Videos(3, 1);
        var cards = new Cards();

        var output = Run(new Descrambler(cards), ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(Generations(cards)).IsEqualTo("1");
    }

    /// <summary>
    /// **鍵の要らない利用者だけなら、カードに問い合わせず、溜めずにそのまま流す。** 番組表・ロゴ・スキャンが
    /// ライブ視聴や録画とカードのロックを取り合わない
    /// </summary>
    [Test]
    public async Task 鍵の要らない利用者だけならカードに問い合わせない()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1).Ecm(EcmPid, 2).Videos(5, 2, even: false);
        var cards = new Cards();
        var descrambler = new Descrambler(cards, keysWanted: () => false);

        var output = Run(descrambler, ts.Wire.ToArray(), flush: false);

        await Assert.That(Diff(output, ts.Wire.ToArray())).IsEqualTo(-1);
        await Assert.That(cards.Asked.Count).IsEqualTo(0);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(descrambler.CardUse()).IsEqualTo("カード 使わない");
    }

    /// <summary>
    /// **途中で鍵の要る利用者が来たら、溜め直して最初の鍵から復号する。** 来た利用者には先頭から復号したものが届く
    /// (ECM の手前でも、ECM を挟んで続いている偶奇の並びは復号する)
    /// </summary>
    [Test]
    public async Task 鍵の要る利用者が来たら溜め直して復号する()
    {
        var wanted = false;
        var cards = new Cards();
        var descrambler = new Descrambler(cards, keysWanted: () => wanted);
        var before = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var after = new Ts().Videos(2, 2).Ecm(EcmPid, 2).Videos(3, 2).Pat((0x0400, PmtPid));

        var first = Run(descrambler, before.Wire.ToArray(), flush: false);
        wanted = true;
        var second = Run(descrambler, after.Wire.ToArray());

        await Assert.That(Diff(first, before.Wire.ToArray())).IsEqualTo(-1);
        await Assert.That(Diff(second, Expected(after))).IsEqualTo(-1);
        await Assert.That(Generations(cards)).IsEqualTo("2");
    }

    [Test]
    public async Task 番組表とロゴとスキャンは鍵が要らない()
    {
        static bool Wants(string use) => new Sink(use, 1, _ => { }).WantsKeys;

        await Assert.That(Wants("epg T21")).IsFalse();
        await Assert.That(Wants("logo GR/T16")).IsFalse();
        await Assert.That(Wants("scan T21")).IsFalse();
        await Assert.That(Wants("epg")).IsFalse();
        await Assert.That(Wants("rec 12")).IsTrue();
        await Assert.That(Wants("live GR/T27")).IsTrue();
        // 決まっていない名乗りは要るとみなす
        await Assert.That(Wants("不明")).IsTrue();
        await Assert.That(Wants("epgx T21")).IsTrue();
    }

    /// <summary>
    /// **溜めていた間の内訳を 1 行に出せる** (選局して最初に送り出したときの記録。docs/stream.md「本番の記録で割る」)。
    /// そろった順と、鍵の出どころへ問い合わせた回数・キャッシュ・未契約・ロックの待ち
    /// </summary>
    [Test]
    public async Task 溜めていた間の内訳を数える()
    {
        const int ecm2 = 0x0902;
        var ts = new Ts().Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(ecm2)))
            .Ecm(EcmPid, 1).Videos(2, 1)
            .Ecm(ecm2, 2).Payload(AudioPid, 2)
            .Videos(2, 1);
        var cards = new Cards { Cached = true, WaitedMs = 7 };
        var descrambler = new Descrambler(cards);

        Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.HeldAt()).Matches(@"^PAT \d+ms / PMT \d+ms / ECM \d+ms \(0x0902\)$");
        await Assert.That(descrambler.CardUse()).Matches(@"^カード 2 回 計 \d+ms \(待ち 14ms・キャッシュ 2 回・未契約 0 回・準備 \d+ms\)$");
    }

    [Test]
    public async Task 未契約の応答も内訳に数える()
    {
        var cards = new Cards { Code = 0xa102 };
        var descrambler = new Descrambler(cards);

        Run(descrambler, Channel().Ecm(EcmPid, 1).Videos(2, 1).Wire.ToArray());

        await Assert.That(descrambler.CardUse()).Contains("未契約 1 回");
    }

    [Test]
    public async Task 揃う前は内訳に印を出さない()
    {
        var descrambler = new Descrambler(new Cards());

        Run(descrambler, new Ts().Videos(3, null).Wire.ToArray(), flush: false);

        await Assert.That(descrambler.HeldAt()).IsEqualTo("PAT - / PMT - / ECM -");
        await Assert.That(descrambler.CardUse()).IsEqualTo("カード 0 回 計 0ms (待ち 0ms・キャッシュ 0 回・未契約 0 回・準備 -)");
    }

    /*
     * 契約の更新 (EMM。Emm.cs)。CAT の CA 記述子で EMM の PID を挙げ、EMM セクション (0x84) にペイロードを並べて流す。
     * 渡し先 (Emm) の作業スレッドは起動せず、Step を呼んで 1 件ずつ送らせる (遅いカードのテストだけ作業スレッドを起動する)
     */
    private const int CatPid = 0x0001;
    private const int EmmPid = 0x0021;
    private const long Mine = 0x0000_1111_2222, MyGroup = 0x2000_3333_4444, Other = 0x0000_9999_8888;

    private static byte[] Cat(int pid, int version = 0) => Psi(0x01, 0xFFFF, Ca(pid), version);

    private static byte[] EmmSection(params byte[][] payloads) => Psi(0x84, 0, [.. payloads.SelectMany(p => p)]);

    /// <summary>番号を取り終えた渡し先 (番号を取るのは作業スレッドの仕事なので、ここで 1 回 Step を呼ぶ)</summary>
    private static (Emm Emm, StepClock Clock) Receiver(Cards cards)
    {
        var clock = new StepClock();
        var emm = new Emm(() => cards, clock);
        emm.Section(EmmSection());
        emm.Step();
        return (emm, clock);
    }

    /// <summary>順番待ちを全部送らせる (1 秒に 1 件なので、時計を進めながら)</summary>
    private static void Drain(Emm emm, StepClock clock)
    {
        for (var i = 0; i < 40; i++)
        {
            clock.Now += TimeSpan.FromSeconds(1);
            emm.Step();
        }
    }

    private static string[] Sent(Cards cards) => [.. cards.Emms.Select(Convert.ToHexString)];

    [Test]
    public async Task EMM_は_CAT_が挙げた_PID_から読み_自分宛てのペイロードだけをカードに渡す()
    {
        var cards = new Cards { Ids = [Mine, MyGroup] };
        var (emm, clock) = Receiver(cards);
        var mine = EmmTests.Payload(Mine, 1);
        var group = EmmTests.Payload(MyGroup, 2, variable: 20);
        var ts = Channel().Section(CatPid, Cat(EmmPid))
            .Section(EmmPid, EmmSection(EmmTests.Payload(Other, 3), mine, EmmTests.Payload(Other, 4)))
            .Section(EmmPid, EmmSection(group))
            .Ecm(EcmPid, 1).Videos(3, 1);

        var output = Run(new Descrambler(cards, emm: emm), ts.Wire.ToArray());
        Drain(emm, clock);

        await Assert.That(Sent(cards)).IsEquivalentTo(new[] { Convert.ToHexString(mine), Convert.ToHexString(group) }, CollectionOrdering.Matching);
        // EMM を読んでも、復号はいつもどおり
        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
    }

    [Test]
    public async Task 壊れた_EMM_と_はみ出したペイロードと_長すぎるペイロードと_EMM_メッセージは渡さない()
    {
        var cards = new Cards { Ids = [Mine] };
        var (emm, clock) = Receiver(cards);
        var badCrc = EmmSection(EmmTests.Payload(Mine, 1));
        badCrc[^1] ^= 0xFF;
        // 関連情報バイト長がセクションをはみ出す。そのセクションの残り (後ろの自分宛て) も捨てる
        var overrun = EmmTests.Payload(Mine, 2);
        overrun[6] = 0xF0;
        // 255 バイトを超えるペイロード (Lc に入らない)
        var huge = EmmTests.Payload(Mine, 3, variable: 245);
        var ts = Channel().Section(CatPid, Cat(EmmPid))
            .Section(EmmPid, badCrc)
            .Section(EmmPid, EmmSection(overrun, EmmTests.Payload(Mine, 5)))
            .Section(EmmPid, EmmSection(huge))
            .Section(EmmPid, Psi(0x85, 0, EmmTests.Payload(Mine, 4)))
            .Ecm(EcmPid, 1).Videos(3, 1);

        Run(new Descrambler(cards, emm: emm), ts.Wire.ToArray());
        Drain(emm, clock);

        await Assert.That(huge.Length).IsGreaterThan(255);
        await Assert.That(cards.Emms.Count).IsEqualTo(0);
    }

    [Test]
    public async Task 鍵の要らない利用者だけでも_EMM_は渡す()
    {
        var cards = new Cards { Ids = [Mine] };
        var (emm, clock) = Receiver(cards);
        var ts = Channel().Section(CatPid, Cat(EmmPid)).Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 1))).Ecm(EcmPid, 1).Videos(3, 1);

        Run(new Descrambler(cards, keysWanted: () => false, emm: emm), ts.Wire.ToArray());
        Drain(emm, clock);

        await Assert.That(cards.Emms.Count).IsEqualTo(1);
        await Assert.That(cards.Asked.Count).IsEqualTo(0);
    }

    /// <summary>録れたファイルの復号と実機の試しは渡し先を渡さない。古い録画の EMM をカードに渡さない</summary>
    [Test]
    public async Task 渡し先の無いデスクランブラは_EMM_を読まない()
    {
        var cards = new Cards { Ids = [Mine] };
        var (emm, clock) = Receiver(cards);
        var ts = Channel().Section(CatPid, Cat(EmmPid)).Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 1))).Ecm(EcmPid, 1).Videos(3, 1);

        var output = Run(new Descrambler(cards), ts.Wire.ToArray());
        Drain(emm, clock);

        await Assert.That(cards.Emms.Count).IsEqualTo(0);
        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
    }

    [Test]
    public async Task 同じペイロードのくり返しは_1_回だけ渡し_CAT_が替わったら新しい_PID_を読む()
    {
        var cards = new Cards { Ids = [Mine] };
        var (emm, clock) = Receiver(cards);
        const int moved = 0x0022;
        var first = EmmTests.Payload(Mine, 1);
        var second = EmmTests.Payload(Mine, 2);
        var ts = Channel().Section(CatPid, Cat(EmmPid))
            .Section(EmmPid, EmmSection(first)).Section(EmmPid, EmmSection(first));
        var descrambler = new Descrambler(cards, emm: emm);

        var output = new ArrayBufferWriter<byte>();
        descrambler.Decode(ts.Wire.ToArray(), output);
        Drain(emm, clock);
        // 送り終えたあとにまた流れてきても送らない
        var again = new Ts().Section(EmmPid, EmmSection(first))
            .Section(CatPid, Cat(moved, version: 1))
            // 替わったあとの古い PID は読まない
            .Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 9)))
            .Section(moved, EmmSection(second));
        descrambler.Decode(again.Wire.ToArray(), output);
        Drain(emm, clock);

        await Assert.That(Sent(cards)).IsEquivalentTo(new[] { Convert.ToHexString(first), Convert.ToHexString(second) }, CollectionOrdering.Matching);
    }

    /// <summary>
    /// **カードが EMM に応答するのが遅くても、復号のスレッドは待たない。** ECM の鍵の位置は変わらない
    /// (カードに送るのは渡し先の作業スレッドだけ)
    /// </summary>
    [Test]
    public async Task カードが_EMM_に遅くても復号は待たない()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var cards = new Cards
        {
            Ids = [Mine],
            OnEmm = () =>
            {
                entered.Set();
                release.Wait(TimeSpan.FromSeconds(30));
            },
        };
        var emm = new Emm(() => cards);
        using var stop = new CancellationTokenSource();
        emm.Start(stop.Token);
        try
        {
            var ts = Channel().Section(CatPid, Cat(EmmPid)).Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 1)));
            var primed = ts.Wire.Count;
            ts.Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 2))).Ecm(EcmPid, 1).Videos(5, 1);
            var blocked = ts.Wire.Count;
            ts.Section(EmmPid, EmmSection(EmmTests.Payload(Mine, 3))).Ecm(EcmPid, 2).Videos(5, 2, even: false);
            var wire = ts.Wire.ToArray();
            var descrambler = new Descrambler(cards, emm: emm);
            var output = new ArrayBufferWriter<byte>();

            // 1 つ目のセクションで番号を取らせる (取るまでの EMM は捨てる)
            descrambler.Decode(wire.AsSpan(0, primed), output);
            for (var i = 0; i < 100 && emm.Ids is null; i++) await Task.Delay(50);
            descrambler.Decode(wire.AsSpan(primed, blocked - primed), output);
            await Assert.That(entered.Wait(TimeSpan.FromSeconds(10))).IsTrue();

            // カードが EMM を抱えたままの間に、続きを復号する
            var rest = Task.Run(() =>
            {
                descrambler.Decode(wire.AsSpan(blocked), output);
                descrambler.Flush(output);
            });
            await Assert.That(rest.Wait(TimeSpan.FromSeconds(10))).IsTrue();

            await Assert.That(Diff(output.WrittenSpan.ToArray(), Expected(ts))).IsEqualTo(-1);
            await Assert.That(Generations(cards)).IsEqualTo("1,2");
        }
        finally
        {
            release.Set();
            stop.Cancel();
        }
    }
}
