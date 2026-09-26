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

    /// <summary>
    /// 溜めの上限を超えるだけの、掛かっていない詰め物 (null パケット)。**答えを待つのを
    /// やめさせる** (<see cref="Descrambler.HoldLimit"/>)
    /// </summary>
    private static readonly byte[] Overflow = BuildOverflow();

    private static byte[] BuildOverflow()
    {
        var wire = new byte[(Descrambler.HoldLimit / 188 + 1) * 188];
        for (var at = 0; at < wire.Length; at += 188)
        {
            wire[at] = 0x47;
            wire[at + 1] = 0x1F;
            wire[at + 2] = 0xFF;
            wire[at + 3] = (byte)(0x10 | (at / 188 & 0x0F));
        }
        return wire;
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
        var descrambler = new Descrambler(cards, background: false);

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
        Run(new Descrambler(cards, background: false), Channel().Ecm(EcmPid, 3).Videos(3, 3).Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(Convert.ToHexString(cards.Asked[0])).IsEqualTo(Convert.ToHexString(EcmBody(3)));
    }

    [Test]
    public async Task 同じECMはカードに聞き直さない()
    {
        var ts = Channel();
        for (var i = 0; i < 10; i++) ts.Ecm(EcmPid, 1).Videos(5, 1);
        var cards = new Cards();
        var descrambler = new Descrambler(cards, background: false);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(1);
        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
    }

    [Test]
    public async Task どこで区切って渡しても同じに解ける()
    {
        // 切り替わりのあとの ECM の繰り返しで、切り替わった先も 2 の鍵と分かる (Descrambler.Decide)
        var ts = Channel().Ecm(EcmPid, 1).Videos(20, 1).Ecm(EcmPid, 2).Videos(20, 2, even: false).Ecm(EcmPid, 2);
        var wire = ts.Wire.ToArray();
        var expected = Expected(ts);

        foreach (var chunk in new[] { 1, 7, 187, 188, 189, 376, 1000 })
        {
            var output = Run(new Descrambler(new Cards(), background: false), wire, chunk);
            await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        }

        // でたらめな長さで切っても
        var random = new Random(3);
        var descrambler = new Descrambler(new Cards(), background: false);
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

        var descrambler = new Descrambler(new Cards(), background: false);
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
        var descrambler = new Descrambler(new Cards(), background: false);

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
        var descrambler = new Descrambler(cards, background: false);

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
        var descrambler = new Descrambler(new Cards(), background: false);
        var output = new ArrayBufferWriter<byte>();

        var wire = ts.Wire.ToArray();
        var ecmAt = (2 + 30) * 188;
        descrambler.Decode(wire.AsSpan(0, ecmAt), output);
        // 出ているのは掛かっていない PAT と PMT だけ。掛かった頭は鍵を待って溜めている
        await Assert.That(output.WrittenCount).IsEqualTo(2 * 188);

        descrambler.Decode(wire.AsSpan(ecmAt), output);
        descrambler.Flush(output);
        await Assert.That(Diff(output.WrittenSpan.ToArray(), Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    [Test]
    public async Task 鍵が来ないまま上限まで溜まったら_そのまま流す()
    {
        // PAT の無い TS。いくら待っても揃わない
        var ts = new Ts().Videos(Descrambler.HoldLimit / 188 + 10, 1);
        var wire = ts.Wire.ToArray();
        var descrambler = new Descrambler(new Cards(), background: false);

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
        var descrambler = new Descrambler(new Cards(), background: false);

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
        var descrambler = new Descrambler(cards, background: false);

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
        var descrambler = new Descrambler(new Cards(), background: false);

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
        var descrambler = new Descrambler(cards, background: false);

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
        var descrambler = new Descrambler(cards, background: false);

        var output = Run(descrambler, [.. failed.Wire, .. recovered.Wire]);

        // 失敗したところは掛かったまま (流す姿そのまま)、直ったところから解ける
        byte[] expected = [.. failed.Wire, .. Expected(recovered)];
        await Assert.That(Diff(output, expected)).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(5);
        await Assert.That(descrambler.Decoded).IsEqualTo(5);
        await Assert.That(descrambler.LastError).IsEqualTo("カードが抜けています");
    }

    [Test]
    public async Task 契約が無ければ解かずに理由を残す()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        var descrambler = new Descrambler(new Cards { Code = 0x8901 }, background: false);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, ts.Wire.ToArray())).IsEqualTo(-1);
        // 解けなかったのではなく、解く資格が無い。**解除の失敗には数えない**
        await Assert.That(descrambler.Unentitled).IsEqualTo(5);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
        await Assert.That(descrambler.LastError!).Contains("0x8901");
    }

    /// <summary>カードが答えるまで止まる相手。**読み手がそこで待たないこと**を確かめる</summary>
    private sealed class SlowCards : IKeySource
    {
        public ManualResetEventSlim Gate { get; } = new();
        private readonly Cards _inner = new();
        public CardInit Init() => _inner.Init();

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            var copy = ecm.ToArray();
            Gate.Wait(TimeSpan.FromSeconds(10));
            return _inner.Ecm(copy);
        }
    }

    [Test]
    public async Task 鍵を待つ間も読み手は止まらず_答えが来たら頭から解く()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(20, 1);
        var cards = new SlowCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();

        var started = DateTime.UtcNow;
        descrambler.Decode(ts.Wire.ToArray(), output);
        // カードが黙っていても戻ってくる。掛かったものは鍵を待って溜めている (出たのは PAT・PMT・ECM だけ)
        await Assert.That(DateTime.UtcNow - started).IsLessThan(TimeSpan.FromSeconds(2));
        await Assert.That(output.WrittenCount).IsEqualTo(3 * 188);

        cards.Gate.Set();
        var more = Channel().Videos(0, 1);
        for (var tries = 0; tries < 200 && output.WrittenCount < ts.Wire.Count; tries++)
        {
            await Task.Delay(10);
            descrambler.Decode(more.Wire.ToArray(), output);
        }
        var head = output.WrittenSpan[..ts.Wire.Count].ToArray();
        await Assert.That(Diff(head, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    /// <summary>世代が <see cref="From"/> 以上の ECM だけ、門が開くまで答えない</summary>
    private sealed class GatedCards : IKeySource
    {
        public ManualResetEventSlim Gate { get; } = new();
        public int From { get; init; }
        public int Done;
        private readonly Cards _inner = new();
        public CardInit Init() => _inner.Init();

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            var copy = ecm.ToArray();
            if (copy[0] >= From) Gate.Wait(TimeSpan.FromSeconds(10));
            Interlocked.Increment(ref Done);
            lock (_inner) return _inner.Ecm(copy);
        }
    }

    /// <summary>
    /// **待っている間に次の中身が来た ECM が幾つもあっても落ちない。** 答えを拾う途中で
    /// 聞き直すと、見ている並びが縮んで読み手ごと落ちていた
    /// </summary>
    [Test]
    public async Task 待っている間に中身が変わったECMが幾つあっても落ちない()
    {
        var cards = new GatedCards { From = 0 };
        var descrambler = new Descrambler(cards);
        var ts = new Ts().Pat((1, 0x101), (2, 0x102), (3, 0x103))
            .Pmt(0x101, 1, Ca(0x901), (0x111, []))
            .Pmt(0x102, 2, Ca(0x902), (0x121, []))
            .Pmt(0x103, 3, Ca(0x903), (0x131, []))
            .Ecm(0x901, 1).Ecm(0x902, 2).Ecm(0x903, 3)
            .Ecm(0x903, 13);
        var output = new ArrayBufferWriter<byte>();
        descrambler.Decode(ts.Wire.ToArray(), output);
        cards.Gate.Set();
        for (var tries = 0; tries < 500 && Volatile.Read(ref cards.Done) < 3; tries++) await Task.Delay(10);
        await Task.Delay(50);

        descrambler.Decode(new Ts().Videos(1, null).Wire.ToArray(), output);
        await Assert.That(descrambler.LastError).IsNull();
    }

    /// <summary>
    /// **答えを待ちきれなかったら、今の偶奇だけ前の鍵で解く。** 逆の偶奇の鍵は入れ替わるので、
    /// 答えより先に切り替わったぶんは古い鍵で解かずに素通しする (化けたものを「解けた」にしない)
    /// </summary>
    [Test]
    public async Task 答えを待つ間に偶奇が切り替わったら古い鍵で解かない()
    {
        var cards = new GatedCards { From = 10 };
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = Channel().Ecm(EcmPid, 1).Videos(3, 1, even: true);
        descrambler.Decode(head.Wire.ToArray(), output);
        for (var tries = 0; tries < 500 && descrambler.Decoded < 3; tries++)
        {
            await Task.Delay(10);
            descrambler.Decode(Channel().Wire.ToArray(), output);
        }
        await Assert.That(descrambler.Decoded).IsEqualTo(3);

        // 次の ECM の答えが来ないうちに、奇数に切り替わった。答えを待って溜める
        var switched = new Ts().Ecm(EcmPid, 12).Videos(3, 12, even: false);
        output.ResetWrittenCount();
        descrambler.Decode(switched.Wire.ToArray(), output);
        await Assert.That(output.WrittenCount).IsEqualTo(188);

        // 溜めが溢れて待つのをやめても、切り替わったぶんは古い鍵で解かない
        descrambler.Decode(Overflow, output);
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(descrambler.Undecodable).IsEqualTo(3);
        // 掛かったまま、元のバイトのまま流れている
        var got = output.WrittenSpan[..switched.Wire.Count].ToArray();
        await Assert.That(Diff(got, switched.Wire.ToArray())).IsEqualTo(-1);
        cards.Gate.Set();
    }

    /// <summary>世代ごとに門のある相手。開けた世代から答える</summary>
    private sealed class StepCards : IKeySource
    {
        private readonly Cards _inner = new();
        private readonly System.Collections.Concurrent.ConcurrentDictionary<byte, ManualResetEventSlim> _gates = new();
        private int _answered;
        public int Answered => Volatile.Read(ref _answered);
        public ManualResetEventSlim Gate(byte generation) => _gates.GetOrAdd(generation, _ => new());
        public CardInit Init() => _inner.Init();

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
        {
            var copy = ecm.ToArray();
            if (copy[0] >= 10) Gate(copy[0]).Wait(TimeSpan.FromSeconds(10));
            Interlocked.Increment(ref _answered);
            lock (_inner) return _inner.Ecm(copy);
        }
    }

    /// <summary>
    /// **溜めている間に鍵が変わったら、そこで流す。** 答えを待ってから流すと、溜めた頭まで
    /// 新しい鍵で解いて化ける。ECM が2本あって、片方がまだ来ないうちに1本目が変わる形
    /// (後からの解除は流し直すときに ECM を順に聞き直すので起きない。流れのときだけ)
    /// </summary>
    [Test]
    public async Task 溜めている間に鍵が変わったら今の鍵で解けるところまで先に出す()
    {
        const int other = 0x0902;
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(other)))
            .Ecm(EcmPid, 1);
        descrambler.Decode(head.Wire.ToArray(), output);
        for (var tries = 0; tries < 500 && cards.Answered < 1; tries++) await Task.Delay(1);

        // 1 の鍵で掛かった頭を溜めているうちに、1本目の ECM が 11 に変わる (答えは来ない)
        var early = new Ts().Videos(3, 1).Ecm(EcmPid, 11);
        descrambler.Decode(early.Wire.ToArray(), output);
        cards.Gate(11).Set();
        for (var tries = 0; tries < 500 && output.WrittenCount < (head.Wire.Count + early.Wire.Count); tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }

        var expected = Expected(head).Concat(Expected(early)).ToArray();
        var got = output.WrittenSpan[..expected.Length].ToArray();
        await Assert.That(Diff(got, expected)).IsEqualTo(-1);
    }

    /// <summary>
    /// **最初の答えを待つ間に ECM が変わっても、溜めた頭は最初の鍵で解く。** 12 の答えは
    /// 12 のあとのパケットにだけ当てる。新しい鍵で頭まで解くと化ける
    /// </summary>
    [Test]
    public async Task 最初の答えを待つ間にECMが変わっても溜めた頭は最初の鍵で解く()
    {
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = Channel().Videos(3, 11, even: false).Ecm(EcmPid, 11).Videos(3, 11, even: false)
            .Ecm(EcmPid, 12).Videos(3, 12, even: false);
        descrambler.Decode(head.Wire.ToArray(), output);
        cards.Gate(11).Set();
        cards.Gate(12).Set();
        for (var tries = 0; tries < 500 && output.WrittenCount < head.Wire.Count; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }

        var got = output.WrittenSpan[..head.Wire.Count].ToArray();
        await Assert.That(Diff(got, Expected(head))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(9);
    }

    /// <summary>
    /// **最初の答えを待つ間に ECM が変わって偶奇も切り替わったら、切り替わったぶんは古い鍵で解かない。**
    /// 12 で入れ替わった奇数の鍵は 11 には無い。12 の答えを待ちきれずに 11 の鍵を当てると化ける
    /// </summary>
    [Test]
    public async Task 溜めている間に切り替わった偶奇は流し直しでも古い鍵で解かない()
    {
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = Channel().Ecm(EcmPid, 11).Videos(3, 11, even: true).Ecm(EcmPid, 12).Videos(3, 12, even: false);
        descrambler.Decode(head.Wire.ToArray(), output);
        cards.Gate(11).Set();
        for (var tries = 0; tries < 500 && descrambler.Decoded < 3; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }
        // 12 の答えは来ない。溜めが溢れるまで待ってから流す
        descrambler.Decode(Overflow, output);

        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(descrambler.Undecodable).IsEqualTo(3);
        // 切り替わったあとの3つは、元のバイトのまま (掛かったまま) 出ている
        var tail = output.WrittenSpan[(head.Wire.Count - 3 * 188)..head.Wire.Count].ToArray();
        await Assert.That(Diff(tail, head.Wire.ToArray()[^(3 * 188)..])).IsEqualTo(-1);
        cards.Gate(12).Set();
    }

    /// <summary>
    /// **流れの中でも同じ。** 11 を待つ間に 12 が来て、11 の答えより先に奇数へ切り替わったら、
    /// 11 の答えが来たあとも 12 の答えまで奇数は解かない (聞き始めた時点の偶奇で門を決めない)
    /// </summary>
    [Test]
    public async Task 答えを待つ間にECMがまた変わって切り替わった偶奇は次の答えまで解かない()
    {
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        descrambler.Decode(Channel().Ecm(EcmPid, 1).Videos(2, 1, even: true).Wire.ToArray(), output);
        for (var tries = 0; tries < 500 && descrambler.Decoded < 2; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(Channel().Wire.ToArray(), output);
        }

        descrambler.Decode(new Ts().Ecm(EcmPid, 11).Ecm(EcmPid, 12).Videos(2, 12, even: false).Wire.ToArray(), output);
        cards.Gate(11).Set();
        for (var tries = 0; tries < 500 && cards.Answered < 2; tries++) await Task.Delay(1);
        await Task.Delay(20);

        var decoded = descrambler.Decoded;
        descrambler.Decode(new Ts().Videos(20, 12, even: false).Wire.ToArray(), output);
        await Assert.That(descrambler.Decoded).IsEqualTo(decoded);
        // 溢れて待つのをやめても、11 の鍵では解かない
        descrambler.Decode(Overflow, output);
        await Assert.That(descrambler.Decoded).IsEqualTo(decoded);
        await Assert.That(descrambler.Undecodable).IsEqualTo(22);
        cards.Gate(12).Set();
    }

    /// <summary>
    /// **答えを待つ間に同じ ECM が2回変わったら、今の鍵はどちらの偶奇にも使わない。**
    /// 1回目と2回目のあいだに切り替わった偶奇を古い鍵で解くと化ける。
    /// もう1本の ECM の答えも遅い形
    /// </summary>
    [Test]
    public async Task 溜めている間に同じECMが2回変わったら今の鍵は使わない()
    {
        const int other = 0x0902;
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(other)))
            .Ecm(EcmPid, 1).Ecm(other, 20);
        descrambler.Decode(head.Wire.ToArray(), output);
        for (var tries = 0; tries < 500 && cards.Answered < 1; tries++) await Task.Delay(1);
        var body = new Ts().Ecm(other, 21).Videos(3, 1, even: false).Ecm(EcmPid, 12)
            .Videos(3, 12, even: true).Ecm(EcmPid, 13).Videos(3, 12, even: true);
        descrambler.Decode(body.Wire.ToArray(), output);
        cards.Gate(20).Set();
        for (var tries = 0; tries < 500 && descrambler.Decoded < 3; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }
        // 12 も 13 も答えが来ないまま溢れる
        descrambler.Decode(Overflow, output);
        cards.Gate(12).Set();
        cards.Gate(13).Set();
        cards.Gate(21).Set();
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(descrambler.Undecodable).IsEqualTo(6);
    }

    /// <summary>
    /// **1本目の鍵が揃っても、2本目の ECM の最初の答えが来るまではその ES から先を流さない。**
    /// 流してしまうと、そちらの ES の頭が掛かったまま出る
    /// </summary>
    [Test]
    public async Task 溜めている間に鍵が変わっても他のECMの最初の答えを待つ()
    {
        const int other = 0x0902;
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var head = new Ts()
            .Pat((0x0400, PmtPid))
            .Pmt(PmtPid, 0x0400, [], (VideoPid, Ca(EcmPid)), (AudioPid, Ca(other)))
            .Ecm(EcmPid, 1).Videos(2, 1)
            .Ecm(other, 20).Payload(AudioPid, 20)
            .Ecm(EcmPid, 2);
        descrambler.Decode(head.Wire.ToArray(), output);
        // 1本目の答えは来たが、2本目の最初の答えがまだ。音声の手前 (PAT・PMT・ECM・映像2つ・ECM) までしか出ない
        const int beforeAudio = 6 * 188;
        for (var tries = 0; tries < 500 && output.WrittenCount < beforeAudio; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }
        await Assert.That(output.WrittenCount).IsEqualTo(beforeAudio);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);

        cards.Gate(20).Set();
        for (var tries = 0; tries < 500 && output.WrittenCount < head.Wire.Count; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }
        await Assert.That(descrambler.Decoded).IsEqualTo(3);
        await Assert.That(descrambler.Undecodable).IsEqualTo(0);
    }

    /// <summary>
    /// **前の鍵で解いてよい偶奇は、ECM が変わるのを見た時点で流れていた偶奇。** 待っている
    /// パケットの偶奇も数える。数えないと、今流れている偶奇を止めて、古い鍵の偶奇を通す
    /// </summary>
    [Test]
    public async Task 門で止めた偶奇も次の門に使う()
    {
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        async Task Feed(Ts ts)
        {
            descrambler.Decode(ts.Wire.ToArray(), output);
            await Task.Delay(1);
        }

        await Feed(Channel().Ecm(EcmPid, 1).Videos(2, 1, even: false));
        for (var tries = 0; tries < 500 && descrambler.Decoded < 2; tries++) await Feed(Channel());

        // 11 を待つ間に偶数へ切り替わり (待つ)、12 が来る。12 のあとも偶数は 11 の鍵のまま
        await Feed(new Ts().Ecm(EcmPid, 11).Videos(2, 11, even: true).Ecm(EcmPid, 12).Videos(1, 11, even: true));
        // 11 の答えが来る。12 の答えより先に奇数へ切り替わる
        cards.Gate(11).Set();
        for (var tries = 0; tries < 500 && descrambler.Decoded < 2 + 2; tries++) await Feed(new Ts().Pat((0x0400, PmtPid)));
        await Assert.That(descrambler.Decoded).IsEqualTo(4);
        await Feed(new Ts().Videos(2, 12, even: false));

        // 12 の答えを待ちきれなかった。12 を見た時点で流れていた偶数は 11 の鍵で解け、奇数は解かない
        descrambler.Decode(Overflow, output);
        await Assert.That(descrambler.Decoded).IsEqualTo(5);
        await Assert.That(descrambler.Undecodable).IsEqualTo(2);
        cards.Gate(12).Set();
    }

    /// <summary>**PMT より前に来た掛かったパケットも、PMT で ECM が分かったところで札を付けて解く**</summary>
    [Test]
    public async Task PMTより前に来たパケットも解く()
    {
        var ts = new Ts().Pat((0x0400, PmtPid)).Videos(3, 1)
            .Pmt(PmtPid, 0x0400, Ca(EcmPid), (VideoPid, []))
            .Videos(2, 1).Ecm(EcmPid, 1).Videos(2, 1);
        var descrambler = new Descrambler(new Cards(), background: false);

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
        var descrambler = new Descrambler(new Cards(), background: false);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(Diff(output, Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(7);
    }

    /// <summary>
    /// **答えを待つ間に来た中身は、飛ばさずに順に聞く。** どれにも札の付いたパケットが待っている。
    /// 最新だけ聞くと、間の中身の鍵が要るパケットが掛かったまま出る
    /// </summary>
    [Test]
    public async Task 答えを待つ間に来た中身は飛ばさずに順に聞く()
    {
        var cards = new StepCards();
        var descrambler = new Descrambler(cards);
        var output = new ArrayBufferWriter<byte>();
        var ts = Channel().Ecm(EcmPid, 11).Videos(2, 11, even: true)
            .Ecm(EcmPid, 12).Videos(2, 12, even: false)
            .Ecm(EcmPid, 13).Videos(2, 13, even: true).Ecm(EcmPid, 13);
        descrambler.Decode(ts.Wire.ToArray(), output);
        cards.Gate(11).Set();
        cards.Gate(12).Set();
        cards.Gate(13).Set();
        for (var tries = 0; tries < 500 && output.WrittenCount < ts.Wire.Count; tries++)
        {
            await Task.Delay(1);
            descrambler.Decode(new Ts().Pat((0x0400, PmtPid)).Wire.ToArray(), output);
        }

        await Assert.That(Diff(output.WrittenSpan[..ts.Wire.Count].ToArray(), Expected(ts))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(6);
    }

    /// <summary>
    /// **新しい ECM が来ないまま偶奇が2回変わったら、古い中身の鍵で解かない。** 中身が持つのは
    /// 今と次の鍵だけで、次の次は次の中身にしか無い
    /// </summary>
    [Test]
    public async Task ECMが来ないまま偶奇が2回変わったら古い中身で解かない()
    {
        var ts = Channel().Ecm(EcmPid, 1).Videos(2, 1, even: true).Videos(2, 1, even: false)
            .Ecm(EcmPid, 1).Videos(3, 3, even: true);
        var descrambler = new Descrambler(new Cards(), background: false);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.Decoded).IsEqualTo(4);
        await Assert.That(descrambler.Undecodable).IsEqualTo(3);
        await Assert.That(Diff(output[^(3 * 188)..], ts.Wire.ToArray()[^(3 * 188)..])).IsEqualTo(-1);
    }

    /// <summary>
    /// **中身を見たあとに偶奇が変わったら、次の ECM を受けてから解く。** 録り始めに見た中身が
    /// もう切り替わったあとのものだと、次の切り替わりの先はその中身に無い。ふつうは次の中身が
    /// 先に来るが、ECM の PID が PMT より先に移ると来ない。何も来ないまま PMT から外れたら解かない
    /// </summary>
    [Test]
    public async Task 偶奇が変わったあとECMが来ないままPMTから外れたら解かない()
    {
        const int moved = 0x0905;
        var ts = Channel().Ecm(EcmPid, 1).Videos(2, 1, even: false)
            // 1 の中身に無い鍵へ切り替わった (新しい ECM は、まだ PMT に載っていない PID で来ている)
            .Videos(2, 3, even: true);
        ts.Version = 1;
        ts.Pmt(PmtPid, 0x0400, Ca(moved), (VideoPid, []), (AudioPid, []))
            .Ecm(moved, 3).Videos(2, 3, even: true);
        var descrambler = new Descrambler(new Cards(), background: false);

        var output = Run(descrambler, ts.Wire.ToArray());

        await Assert.That(descrambler.Decoded).IsEqualTo(4);
        await Assert.That(descrambler.Undecodable).IsEqualTo(2);
        var at = (3 + 2) * 188;
        await Assert.That(Diff(output[at..(at + 2 * 188)], ts.Wire.ToArray()[at..(at + 2 * 188)])).IsEqualTo(-1);
    }

    [Test]
    public async Task 化けたECMはカードに渡さない()
    {
        var ts = Channel().Ecm(EcmPid, 1);
        // ECM の中身を 1 バイト化けさせる (CRC が合わなくなる)
        ts.Wire[2 * 188 + 20] ^= 0xFF;
        ts.Videos(3, 1);
        var cards = new Cards();

        Run(new Descrambler(cards, background: false), ts.Wire.ToArray());

        await Assert.That(cards.Asked.Count).IsEqualTo(0);
    }

    /// <summary>選局を変えたら前の PMT と鍵を忘れ、次のチャンネルを初めから読む</summary>
    [Test]
    public async Task Resetで前のチャンネルを忘れる()
    {
        var cards = new Cards();
        var descrambler = new Descrambler(cards, background: false);
        var first = Channel().Ecm(EcmPid, 1).Videos(5, 1);
        Run(descrambler, first.Wire.ToArray());

        descrambler.Reset();
        await Assert.That(descrambler.Decoded).IsEqualTo(0);

        const int pmt2 = 0x0102, video2 = 0x0121, ecm2 = 0x0902;
        // 前と同じ ES の PID でも、前の鍵では解かない (次の局の ECM を待って溜める)
        var second = new Ts()
            .Pat((0x0500, pmt2))
            .Pmt(pmt2, 0x0500, Ca(ecm2), (video2, []), (VideoPid, []))
            .Videos(3, 5)
            .Ecm(ecm2, 5)
            .Payload(video2, 5).Videos(3, 5);
        var output = Run(descrambler, second.Wire.ToArray());

        await Assert.That(Diff(output, Expected(second))).IsEqualTo(-1);
        await Assert.That(descrambler.Decoded).IsEqualTo(7);
        await Assert.That(Generations(cards)).IsEqualTo("1,5");
    }
}
