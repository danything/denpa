using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// **カードが無くても TS から分かること**を数える (スカパー！プレミアムの実機の報告のため。#1578)。
/// <c>--decode-file</c> と <c>--tune</c> の出力に足す (Probe.cs)。
///
/// <para>
/// **カードには何も渡さない。** 読むのはスクランブルされていない PSI/SI (ARIB STD-B10) だけで、ECM と EMM は
/// セクションの形 (table_id と長さ) を数えるだけにする。数えるものは次のとおり。
/// </para>
///
/// <list type="bullet">
/// <item>PAT の transport_stream_id と局の数、NIT の network_id</item>
/// <item>PMT (局ごと) と CAT の CA 記述子 (0x09) にある CA_system_id と、ECM・EMM の PID。B-CAS (0x0005) 以外の CA_system_id はそれと分かるように出す</item>
/// <item>ECM・EMM の PID に来たセクションの table_id ごとの数と長さ</item>
/// <item>番組表 (EIT) とロゴ (CDT) のセクションの数と、スクランブルされたパケット (transport_scrambling_control が 0 でないもの) の数</item>
/// </list>
///
/// <para>
/// 1 つの実体は 1 本のストリームからだけ呼ぶ。
/// </para>
/// </summary>
public sealed class TsObservation
{
    private const int PacketSize = 188;

    /// <summary>B-CAS の CA_system_id (ARIB STD-B25)</summary>
    public const int BcasSystemId = 0x0005;

    private const int PatPid = 0x0000;
    private const int CatPid = 0x0001;
    private const int NitPid = 0x0010;
    private const int CdtPid = 0x0029;

    /// <summary>EIT を運ぶ PID。0x0012 (H-EIT) と、地上波の 0x0026 (M-EIT)・0x0027 (L-EIT)</summary>
    private static readonly HashSet<int> EitPids = [0x0012, 0x0026, 0x0027];

    /// <summary>PID → 組み立て中のセクション。読む PID だけを入れる</summary>
    private readonly Dictionary<int, Assembler> _sections = new()
    {
        [PatPid] = new(), [CatPid] = new(), [NitPid] = new(), [CdtPid] = new(),
        [0x0012] = new(), [0x0026] = new(), [0x0027] = new(),
    };

    /// <summary>service_id → PMT の PID (PAT から)</summary>
    private readonly SortedDictionary<int, int> _programs = [];
    /// <summary>service_id → PMT の CA 記述子 (CA_system_id と ECM の PID)。番組全体と ES ごとを合わせる</summary>
    private readonly SortedDictionary<int, SortedSet<(int System, int Pid)>> _ecms = [];
    /// <summary>CAT の CA 記述子 (CA_system_id と EMM の PID)</summary>
    private readonly SortedSet<(int System, int Pid)> _emms = [];
    /// <summary>ECM・EMM の PID → そこに来たセクションの形</summary>
    private readonly SortedDictionary<int, Shape> _shapes = [];

    private int? _transportStreamId, _networkId;
    private bool _cat;
    private long _packets, _eitActual, _eitOther, _eitScrambled, _cdt, _cdtScrambled;

    /// <summary>PMT と CAT で見た CA_system_id (重なりなし・小さい順)</summary>
    public IReadOnlyList<int> CaSystemIds =>
        _ecms.Values.SelectMany(set => set).Concat(_emms).Select(ca => ca.System).Distinct().Order().ToList();

    /// <summary>188 バイトのパケットを 1 つ。同期バイトの無いものと誤りの印が立っているものは読まない</summary>
    public void Push(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < PacketSize || packet[0] != 0x47 || (packet[1] & 0x80) != 0) return;
        _packets++;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if (packet[3] >> 6 != 0)
        {
            // スクランブルされている。中身は読めないので、数えるだけ
            if (EitPids.Contains(pid)) _eitScrambled++;
            else if (pid == CdtPid) _cdtScrambled++;
            else if (_shapes.TryGetValue(pid, out var scrambled)) scrambled.Scrambled++;
            return;
        }
        if (!_sections.TryGetValue(pid, out var assembler)) return;
        var start = PayloadStart(packet);
        if (start < 0) return;
        foreach (var section in assembler.Feed(packet[start..], (packet[1] & 0x40) != 0)) Complete(pid, section);
    }

    /// <summary>
    /// 分かったことを 1 行ずつ。**報告にそのまま貼れる形にする** (docs/tuners.md「スカパー！プレミアムでカード無しで分かること」)
    /// </summary>
    public IEnumerable<string> Describe()
    {
        if (_packets == 0)
        {
            yield return "TS  読めるパケットがありません";
            yield break;
        }
        yield return _transportStreamId is { } tsid
            ? $"TS  network_id {Hex(_networkId)}  transport_stream_id 0x{tsid:X4}  局 {_programs.Count} (PAT)"
            : $"TS  network_id {Hex(_networkId)}  PAT が来ていません";
        foreach (var (service, pmt) in _programs)
        {
            var found = _ecms.TryGetValue(service, out var set) ? set : null;
            var what = found is null ? "PMT が来ていません"
                : found.Count == 0 ? "CA 記述子なし"
                : string.Join(" / ", found.Select(ca => $"CA_system_id {CaName(ca.System)} ECM 0x{ca.Pid:X4}"));
            yield return $"局 0x{service:X4} (PMT 0x{pmt:X4})  {what}";
        }
        yield return !_cat ? "CAT  来ていません"
            : _emms.Count == 0 ? "CAT  CA 記述子なし"
            : "CAT  " + string.Join(" / ", _emms.Select(ca => $"CA_system_id {CaName(ca.System)} EMM 0x{ca.Pid:X4}"));
        foreach (var (pid, shape) in _shapes)
        {
            yield return $"ECM・EMM 0x{pid:X4}  {shape}";
        }
        yield return $"番組表 (EIT)  {Arrival(_eitActual + _eitOther, _eitScrambled)}  自 TS {_eitActual}・ほかの TS {_eitOther} セクション  スクランブルされたパケット {_eitScrambled}";
        yield return $"ロゴ (CDT)  {Arrival(_cdt, _cdtScrambled)}  {_cdt} セクション  スクランブルされたパケット {_cdtScrambled}";
        var others = CaSystemIds.Where(id => id != BcasSystemId).ToList();
        if (others.Count > 0)
        {
            yield return $"B-CAS (0x{BcasSystemId:X4}) 以外の CA_system_id  {string.Join(" ", others.Select(id => $"0x{id:X4}"))}";
        }
    }

    /// <summary>セクションが読めたか・スクランブルされていたか・来ていないか</summary>
    private static string Arrival(long sections, long scrambled) =>
        sections > 0 ? "読めます" : scrambled > 0 ? "スクランブルされています" : "来ていません";

    private static string Hex(int? value) => value is { } known ? $"0x{known:X4}" : "-";

    private static string CaName(int id) => id == BcasSystemId ? $"0x{id:X4} (B-CAS)" : $"0x{id:X4} (B-CAS 以外)";

    /// <summary>中身の始まり。中身が無い・アダプテーションの長さが壊れていれば -1</summary>
    private static int PayloadStart(ReadOnlySpan<byte> packet)
    {
        var control = (packet[3] >> 4) & 0x03;
        if ((control & 0x01) == 0) return -1;
        if ((control & 0x02) == 0) return 4;
        var start = 5 + packet[4];
        return start < PacketSize ? start : -1;
    }

    private void Complete(int pid, byte[] section)
    {
        var syntax = (section[1] & 0x80) != 0;
        if (_shapes.TryGetValue(pid, out var shape))
        {
            /*
             * ECM・EMM は形を数えるだけ。**CRC で捨てずに全部数える。** スカパー！プレミアムの ECM・EMM が
             * 末尾に CRC を持つ形かは分かっていないので、section_syntax_indicator が 1 のものは CRC が合ったかを別に数える
             */
            shape.Add(section, syntax ? Descrambler.Crc32(section) == 0 : null);
            return;
        }
        // ここから先の PSI/SI はどれも CRC を持つ形式。CRC で確かめ、化けたセクションで嘘の CA_system_id を出さない
        if (!syntax || section.Length < 12 || Descrambler.Crc32(section) != 0) return;
        var table = section[0];
        if (pid == PatPid && table == 0x00) OnPat(section);
        else if (pid == CatPid && table == 0x01) OnCat(section);
        else if (pid == NitPid && table == 0x40) _networkId = BinaryPrimitives.ReadUInt16BigEndian(section.AsSpan(3));
        else if (pid == CdtPid && table == 0xC8) _cdt++;
        else if (EitPids.Contains(pid))
        {
            // 自 TS は p/f (0x4E) と schedule (0x50〜0x5F)、ほかの TS は p/f (0x4F) と schedule (0x60〜0x6F)
            if (table is 0x4E or >= 0x50 and <= 0x5F) _eitActual++;
            else if (table is 0x4F or >= 0x60 and <= 0x6F) _eitOther++;
        }
        else if (table == 0x02) OnPmt(section);
    }

    private void OnPat(byte[] section)
    {
        _transportStreamId = BinaryPrimitives.ReadUInt16BigEndian(section.AsSpan(3));
        var loop = section.AsSpan(8, section.Length - 12);
        for (var at = 0; at + 4 <= loop.Length; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(loop[at..]);
            // 番組 0 は NIT の PID。PMT ではない
            if (number == 0) continue;
            var pid = BinaryPrimitives.ReadUInt16BigEndian(loop[(at + 2)..]) & 0x1FFF;
            _programs[number] = pid;
            _sections.TryAdd(pid, new Assembler());
        }
    }

    private void OnPmt(byte[] section)
    {
        var number = BinaryPrimitives.ReadUInt16BigEndian(section.AsSpan(3));
        if (!_programs.ContainsKey(number)) return;
        var found = new SortedSet<(int System, int Pid)>();
        var end = section.Length - 4;
        var at = 12 + (BinaryPrimitives.ReadUInt16BigEndian(section.AsSpan(10)) & 0x0FFF);
        if (at > end) return;
        Descriptors(section.AsSpan(12, at - 12), found);
        while (at + 5 <= end)
        {
            var length = BinaryPrimitives.ReadUInt16BigEndian(section.AsSpan(at + 3)) & 0x0FFF;
            at += 5;
            if (at + length > end) break;
            Descriptors(section.AsSpan(at, length), found);
            at += length;
        }
        _ecms[number] = found;
        Track(found);
    }

    private void OnCat(byte[] section)
    {
        _cat = true;
        var found = new SortedSet<(int System, int Pid)>();
        Descriptors(section.AsSpan(8, section.Length - 12), found);
        _emms.UnionWith(found);
        Track(found);
    }

    /// <summary>ECM・EMM の PID を、形を数える PID に足す</summary>
    private void Track(IEnumerable<(int System, int Pid)> found)
    {
        foreach (var (_, pid) in found)
        {
            if (_shapes.ContainsKey(pid) || _sections.ContainsKey(pid)) continue;
            _shapes[pid] = new Shape();
            _sections[pid] = new Assembler();
        }
    }

    /// <summary>CA 記述子 (0x09) の CA_system_id と CA_PID。CA_PID の 0x1FFF は「無い」の意味なので除く</summary>
    private static void Descriptors(ReadOnlySpan<byte> descriptors, SortedSet<(int System, int Pid)> found)
    {
        for (var at = 0; at + 2 <= descriptors.Length; at += 2 + descriptors[at + 1])
        {
            var length = descriptors[at + 1];
            var body = descriptors[(at + 2)..];
            if (descriptors[at] != 0x09 || length < 4 || length > body.Length) continue;
            var pid = BinaryPrimitives.ReadUInt16BigEndian(body[2..]) & 0x1FFF;
            if (pid is 0 or 0x1FFF) continue;
            found.Add((BinaryPrimitives.ReadUInt16BigEndian(body), pid));
        }
    }

    /// <summary>
    /// ECM・EMM の PID に来たセクションの形。table_id ごとの数と、長さの最小・最大、
    /// section_syntax_indicator が 1 のもののうち末尾の CRC が合った数と合わなかった数
    /// </summary>
    private sealed class Shape
    {
        private readonly SortedDictionary<int, long> _tables = [];
        private int _shortest = int.MaxValue, _longest;
        private long _crcOk, _crcBad;
        public long Scrambled;

        /// <param name="crc">CRC が合ったか。section_syntax_indicator が 0 (CRC を持たない形) なら null</param>
        public void Add(byte[] section, bool? crc)
        {
            _tables[section[0]] = _tables.GetValueOrDefault(section[0]) + 1;
            _shortest = Math.Min(_shortest, section.Length);
            _longest = Math.Max(_longest, section.Length);
            if (crc == true) _crcOk++;
            else if (crc == false) _crcBad++;
        }

        public override string ToString()
        {
            var tables = _tables.Count == 0 ? "セクションが来ていません"
                : string.Join(" ", _tables.Select(pair => $"table_id 0x{pair.Key:X2} × {pair.Value}"))
                  + (_shortest == _longest ? $" ({_shortest} バイト)" : $" ({_shortest}〜{_longest} バイト)")
                  + $"  CRC 合う {_crcOk}・合わない {_crcBad}";
            return $"{tables}  スクランブルされたパケット {Scrambled}";
        }
    }

    /// <summary>
    /// 1 つの PID のセクションを組み立てる。セクションはパケットを跨ぎ、1 つのパケットに幾つも入ることもある
    /// (pointer_field が次のセクションの先頭を指す)。0xFF は詰め物で、その先にセクションは無い
    /// </summary>
    private sealed class Assembler
    {
        private readonly List<byte> _buffer = [];
        private bool _active;

        public List<byte[]> Feed(ReadOnlySpan<byte> payload, bool unitStart)
        {
            var done = new List<byte[]>();
            if (unitStart)
            {
                if (payload.IsEmpty) return done;
                var pointer = payload[0];
                payload = payload[1..];
                if (pointer > payload.Length)
                {
                    Reset();
                    return done;
                }
                // pointer_field の手前は前のセクションの続き。そこで揃わなければ捨てる
                if (_active)
                {
                    _buffer.AddRange(payload[..pointer]);
                    Take(done);
                }
                _buffer.Clear();
                _buffer.AddRange(payload[pointer..]);
                _active = true;
                Take(done);
            }
            else if (_active)
            {
                _buffer.AddRange(payload);
                Take(done);
            }
            return done;
        }

        private void Take(List<byte[]> done)
        {
            while (_buffer.Count >= 3 && _buffer[0] != 0xFF)
            {
                var length = 3 + (((_buffer[1] & 0x0F) << 8) | _buffer[2]);
                if (_buffer.Count < length) return;
                done.Add([.. _buffer.GetRange(0, length)]);
                _buffer.RemoveRange(0, length);
            }
            if (_buffer.Count == 0 || _buffer[0] == 0xFF) Reset();
        }

        private void Reset()
        {
            _buffer.Clear();
            _active = false;
        }
    }
}
