using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// **選局で読んだ PAT と PMT を覚えておく。** 次に同じ局を選局したとき、本物の PAT・PMT を待たずに流し始めるため (<see cref="Descrambler"/>)。
/// 鍵は種別・チャンネル・service_id。PAT はチャンネルごとに 1 つ、PMT は局ごとに 1 つ持つ。
///
/// <para>
/// 持つのはセクションのバイト列 (CRC まで) だけで、デスクランブラが本物と同じ読み方で読む。
/// 置き場はメモリだけで、<see cref="TunerPool"/> が 1 つ持つ (機材と受信機をまたいで 1 つ)。起動し直せば空になる。
/// 番組表・ロゴ・スキャンの選局で読んだものも覚える。
/// </para>
///
/// <para>
/// 新しい PAT の transport_stream_id が覚えたものと違えば、そのチャンネルの PMT を全部捨てる (チャンネルの定義が変わった・別の中継を受けた)。
/// 同じでも、新しい PAT が挙げていない局と、PMT の PID が変わった局の PMT は捨てる。
/// service_id だけを鍵にしないのは、ケーブルの再送信で同じ service_id の局が別のチャンネルに入っていることがあるため (推定)。
/// 大きさは局 1 つにつき PMT 1 つ (1KB まで) で、BS・CS を全部覚えても数百 KB (推定)
/// </para>
/// </summary>
public sealed class PsiMemory
{
    private readonly Lock _gate = new();
    private readonly Dictionary<(string Type, string Channel), Tables> _channels = [];

    private sealed class Tables(byte[] pat)
    {
        public byte[] Pat = pat;
        /// <summary>program_number → PMT の PID と中身</summary>
        public readonly Dictionary<int, (int Pid, byte[] Section)> Pmts = [];
    }

    /// <summary>覚えた PAT と、観る局の PMT (program_number → PID と中身)</summary>
    public sealed record Recalled(byte[] Pat, IReadOnlyDictionary<int, (int Pid, byte[] Section)> Pmts);

    /// <summary>1 つのチャンネルの置き場 (<see cref="Descrambler"/> に渡す)</summary>
    public Slot For(string type, string channel) => new(this, type, channel);

    /// <summary>1 つのチャンネルの PAT・PMT を読み書きする</summary>
    public sealed class Slot(PsiMemory memory, string type, string channel)
    {
        /// <summary>
        /// 観る局の PMT がどれも覚えてあり、覚えた PAT がどれも同じ PID で挙げていれば、その PAT と PMT。1 つでも欠ければ null
        /// </summary>
        public Recalled? Recall(IReadOnlySet<int> services) => memory.Recall((type, channel), services);

        /// <summary>本物の PAT を読んだ (中身が前と変わったとき)</summary>
        public void Pat(ReadOnlySpan<byte> section) => memory.Pat((type, channel), section);

        /// <summary>本物の PMT を読んだ (中身が前と変わったとき)。PAT が同じ PID で挙げている局だけ覚える</summary>
        public void Pmt(int number, int pid, ReadOnlySpan<byte> section) => memory.Pmt((type, channel), number, pid, section);
    }

    private Recalled? Recall((string, string) key, IReadOnlySet<int> services)
    {
        lock (_gate)
        {
            if (services.Count == 0 || !_channels.TryGetValue(key, out var tables)) return null;
            var programs = Programs(tables.Pat);
            var pmts = new Dictionary<int, (int Pid, byte[] Section)>();
            foreach (var number in services)
            {
                if (!tables.Pmts.TryGetValue(number, out var pmt)) return null;
                if (!programs.TryGetValue(number, out var pid) || pid != pmt.Pid) return null;
                pmts[number] = pmt;
            }
            return new Recalled(tables.Pat, pmts);
        }
    }

    private void Pat((string, string) key, ReadOnlySpan<byte> section)
    {
        lock (_gate)
        {
            if (!_channels.TryGetValue(key, out var tables))
            {
                _channels[key] = new Tables(section.ToArray());
                return;
            }
            if (Tsid(tables.Pat) != Tsid(section)) tables.Pmts.Clear();
            tables.Pat = section.ToArray();
            var programs = Programs(tables.Pat);
            foreach (var (number, (pid, _)) in tables.Pmts.ToList())
            {
                if (!programs.TryGetValue(number, out var listed) || listed != pid) tables.Pmts.Remove(number);
            }
        }
    }

    private void Pmt((string, string) key, int number, int pid, ReadOnlySpan<byte> section)
    {
        lock (_gate)
        {
            if (!_channels.TryGetValue(key, out var tables)) return;
            if (!Programs(tables.Pat).TryGetValue(number, out var listed) || listed != pid) return;
            tables.Pmts[number] = (pid, section.ToArray());
        }
    }

    /// <summary>PAT の transport_stream_id</summary>
    internal static int Tsid(ReadOnlySpan<byte> pat) => BinaryPrimitives.ReadUInt16BigEndian(pat[3..]);

    /// <summary>PAT の program_number → PMT の PID (番組 0 の NIT は入れない)</summary>
    internal static Dictionary<int, int> Programs(ReadOnlySpan<byte> pat)
    {
        var programs = new Dictionary<int, int>();
        var loop = pat[8..^4];
        for (var at = 0; at + 4 <= loop.Length; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(loop[at..]);
            if (number != 0) programs[number] = BinaryPrimitives.ReadUInt16BigEndian(loop[(at + 2)..]) & 0x1FFF;
        }
        return programs;
    }
}
