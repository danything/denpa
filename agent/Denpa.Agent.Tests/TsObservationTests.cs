namespace Denpa.Agent.Tests;

/*
 * カード無しで分かること (TsObservation)。--decode-file と --tune の出力に足す。
 *
 * 本物の放送は要らない。PAT・PMT・CAT・NIT・EIT・CDT・ECM・EMM を自分で組んで流す。
 * スカパー！プレミアムの CA_system_id は分かっていないので、B-CAS (0x0005) 以外の値には作り物の 0x000B を使う
 */
public class TsObservationTests
{
    private const int PmtPid = 0x0101;
    private const int EcmPid = 0x0901;
    private const int EmmPid = 0x0020;
    private const int OtherSystem = 0x000B;

    /// <summary>TS を組み立てる (pointer_field は 0、余りは 0xFF で詰める)</summary>
    private sealed class Ts
    {
        private readonly Dictionary<int, int> _counters = [];
        public List<byte> Bytes { get; } = [];

        private byte Counter(int pid)
        {
            var next = _counters.GetValueOrDefault(pid);
            _counters[pid] = (next + 1) & 0x0F;
            return (byte)next;
        }

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
                Bytes.AddRange(packet);
            }
            return this;
        }

        /// <summary>スクランブルされたパケット (transport_scrambling_control が 0b10)。中身は読めないでたらめ</summary>
        public Ts Scrambled(int pid, int count = 1)
        {
            for (var i = 0; i < count; i++)
            {
                var packet = new byte[188];
                new Random(Bytes.Count).NextBytes(packet);
                packet[0] = 0x47;
                packet[1] = (byte)(0x40 | (pid >> 8));
                packet[2] = (byte)pid;
                packet[3] = (byte)(0x90 | Counter(pid));
                Bytes.AddRange(packet);
            }
            return this;
        }

        public Ts Pat(int tsid, params (int Number, int Pid)[] programs) =>
            Section(0, Psi(0x00, tsid, programs.SelectMany(p => new[]
            {
                (byte)(p.Number >> 8), (byte)p.Number, (byte)(0xE0 | (p.Pid >> 8)), (byte)p.Pid,
            }).ToArray()));

        /// <summary>PMT。番組全体の記述子と、映像の ES 1 つの記述子</summary>
        public Ts Pmt(int pid, int number, byte[] info, byte[] esInfo)
        {
            var body = new List<byte> { 0xE1, 0x11, (byte)(0xF0 | (info.Length >> 8)), (byte)info.Length };
            body.AddRange(info);
            body.AddRange([0x02, 0xE1, 0x11, (byte)(0xF0 | (esInfo.Length >> 8)), (byte)esInfo.Length]);
            body.AddRange(esInfo);
            return Section(pid, Psi(0x02, number, [.. body]));
        }

        public Ts Cat(byte[] descriptors) => Section(0x0001, Psi(0x01, 0xFFFF, descriptors));

        /// <summary>NIT (自ネットワーク)。記述子も TS の並びも空</summary>
        public Ts Nit(int networkId) => Section(0x0010, Psi(0x40, networkId, [0xF0, 0x00, 0xF0, 0x00]));

        /// <summary>EIT。番組の無いセクション (service_id 以下の固定部だけ)</summary>
        public Ts Eit(byte tableId, int pid = 0x0012) =>
            Section(pid, Psi(tableId, 0x0101, [0x00, 0x04, 0x00, 0x0A, 0x00, tableId]));

        /// <summary>CDT。ロゴの中身は入れない</summary>
        public Ts Cdt() => Section(0x0029, Psi(0xC8, 0x0001, [0x00, 0x0A, 0x01, 0xF0, 0x00]));
    }

    private static byte[] Ca(int system, int pid) =>
        [0x09, 4, (byte)(system >> 8), (byte)system, (byte)(0xE0 | (pid >> 8)), (byte)pid];

    private static byte[] Psi(byte tableId, int extension, byte[] body)
    {
        var length = 5 + body.Length + 4;
        var section = new List<byte>
        {
            tableId, (byte)(0xB0 | (length >> 8)), (byte)length,
            (byte)(extension >> 8), (byte)extension, 0xC1, 0, 0,
        };
        section.AddRange(body);
        var crc = Descrambler.Crc32([.. section]);
        section.AddRange([(byte)(crc >> 24), (byte)(crc >> 16), (byte)(crc >> 8), (byte)crc]);
        return [.. section];
    }

    /// <summary>CRC を持たない形式のセクション (section_syntax_indicator が 0)。B-CAS 以外の方式の EMM がこの形でも数えられるか</summary>
    private static byte[] Plain(byte tableId, int length) =>
        [tableId, (byte)(0x70 | (length >> 8)), (byte)length, .. Enumerable.Range(0, length).Select(i => (byte)i)];

    private static List<string> Lines(Ts ts)
    {
        var observation = new TsObservation();
        var bytes = ts.Bytes.ToArray();
        for (var at = 0; at + 188 <= bytes.Length; at += 188) observation.Push(bytes.AsSpan(at, 188));
        return [.. observation.Describe()];
    }

    [Test]
    public async Task B_CAS_以外の_CA_system_id_を_PMT_と_CAT_から読み_ECM_と_EMM_の_PID_と並べて出す()
    {
        var lines = Lines(new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Nit(0x000A)
            .Pmt(PmtPid, 0x0101, Ca(OtherSystem, EcmPid), [])
            .Cat(Ca(OtherSystem, EmmPid)));

        await Assert.That(lines).Contains("TS  network_id 0x000A  transport_stream_id 0x0004  局 1 (PAT)");
        await Assert.That(lines).Contains("局 0x0101 (PMT 0x0101)  CA_system_id 0x000B (B-CAS 以外) ECM 0x0901");
        await Assert.That(lines).Contains("CAT  CA_system_id 0x000B (B-CAS 以外) EMM 0x0020");
        await Assert.That(lines).Contains("B-CAS (0x0005) 以外の CA_system_id  0x000B");
    }

    [Test]
    public async Task ES_ごとの_CA_記述子も読み_B_CAS_だけなら_B_CAS_以外の行を出さない()
    {
        var lines = Lines(new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Pmt(PmtPid, 0x0101, [], Ca(0x0005, EcmPid)));

        await Assert.That(lines).Contains("局 0x0101 (PMT 0x0101)  CA_system_id 0x0005 (B-CAS) ECM 0x0901");
        // NIT と CAT が来ていないことも、そのまま出す
        await Assert.That(lines).Contains("TS  network_id -  transport_stream_id 0x0004  局 1 (PAT)");
        await Assert.That(lines).Contains("CAT  来ていません");
        await Assert.That(lines.Any(line => line.Contains("以外の CA_system_id"))).IsFalse();
    }

    [Test]
    public async Task スクランブルされていない_EIT_は自_TS_とほかの_TS_に分けて数える()
    {
        var lines = Lines(new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Eit(0x4E)
            .Eit(0x50)
            .Eit(0x60)
            .Eit(0x4F, pid: 0x0026)
            .Cdt());

        await Assert.That(lines).Contains("番組表 (EIT)  読めます  自 TS 2・ほかの TS 2 セクション  スクランブルされたパケット 0");
        await Assert.That(lines).Contains("ロゴ (CDT)  読めます  1 セクション  スクランブルされたパケット 0");
    }

    [Test]
    public async Task スクランブルされた_EIT_と_CDT_は読まずに_パケットの数だけ出す()
    {
        var lines = Lines(new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Scrambled(0x0012, 3)
            .Scrambled(0x0029));

        await Assert.That(lines).Contains("番組表 (EIT)  スクランブルされています  自 TS 0・ほかの TS 0 セクション  スクランブルされたパケット 3");
        await Assert.That(lines).Contains("ロゴ (CDT)  スクランブルされています  0 セクション  スクランブルされたパケット 1");
    }

    [Test]
    public async Task EIT_も_CDT_も来なければ来ていないと出す()
    {
        var lines = Lines(new Ts().Pat(0x0004, (0x0101, PmtPid)));

        await Assert.That(lines).Contains("番組表 (EIT)  来ていません  自 TS 0・ほかの TS 0 セクション  スクランブルされたパケット 0");
        await Assert.That(lines).Contains("ロゴ (CDT)  来ていません  0 セクション  スクランブルされたパケット 0");
        // PMT が来ていない局も出す
        await Assert.That(lines).Contains("局 0x0101 (PMT 0x0101)  PMT が来ていません");
    }

    [Test]
    public async Task ECM_と_EMM_の_PID_に来たセクションの_table_id_と長さを数え_CRC_の無い形式と合わないものも数える()
    {
        // section_syntax_indicator は 1 なのに、末尾が CRC でないセクション (CRC を持つ形かは分かっていない)
        var garbled = Psi(0x86, 0, new byte[20]);
        garbled[^1] ^= 0xFF;
        var lines = Lines(new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Pmt(PmtPid, 0x0101, Ca(OtherSystem, EcmPid), [])
            .Cat(Ca(OtherSystem, EmmPid))
            .Section(EcmPid, Psi(0x82, 0, new byte[100]))
            .Section(EcmPid, Psi(0x82, 0, new byte[100]))
            .Section(EmmPid, Plain(0x84, 40))
            .Section(EmmPid, Plain(0x85, 200))
            .Section(EmmPid, garbled)
            .Scrambled(EmmPid));

        await Assert.That(lines).Contains("ECM・EMM 0x0020  table_id 0x84 × 1 table_id 0x85 × 1 table_id 0x86 × 1 (32〜203 バイト)  CRC 合う 0・合わない 1  スクランブルされたパケット 1");
        await Assert.That(lines).Contains("ECM・EMM 0x0901  table_id 0x82 × 2 (112 バイト)  CRC 合う 2・合わない 0  スクランブルされたパケット 0");
    }

    [Test]
    public async Task 化けた_PMT_は読まない()
    {
        var pmt = new Ts().Pmt(PmtPid, 0x0101, Ca(OtherSystem, EcmPid), []).Bytes.ToArray();
        // CA_system_id の 1 バイトを変える (CRC が合わなくなる)
        pmt[4 + 1 + 12 + 3] ^= 0x01;
        var ts = new Ts().Pat(0x0004, (0x0101, PmtPid));
        ts.Bytes.AddRange(pmt);

        var lines = Lines(ts);

        await Assert.That(lines).Contains("局 0x0101 (PMT 0x0101)  PMT が来ていません");
        await Assert.That(lines.Any(line => line.Contains("0x000B"))).IsFalse();
    }

    [Test]
    public async Task decode_file_に書き出す先を渡さなければ_復号せずにずれた並びを合わせ直して数える()
    {
        var ts = new Ts()
            .Pat(0x0004, (0x0101, PmtPid))
            .Pmt(PmtPid, 0x0101, Ca(OtherSystem, EcmPid), [])
            .Scrambled(0x0111, 2)
            .Eit(0x4E);
        // 先頭に半端なバイトを置く (録れたファイルが途中から始まっている)
        using var input = new MemoryStream([0x12, 0x34, 0x47, .. ts.Bytes]);
        using var output = new StringWriter();

        Probe.Observe(input, output);

        var lines = output.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        await Assert.That(lines[0]).IsEqualTo("5 パケット  40.0% がスクランブルされています (復号していません)");
        await Assert.That(lines).Contains("局 0x0101 (PMT 0x0101)  CA_system_id 0x000B (B-CAS 以外) ECM 0x0901");
        await Assert.That(lines).Contains("番組表 (EIT)  読めます  自 TS 1・ほかの TS 0 セクション  スクランブルされたパケット 0");
    }
}
