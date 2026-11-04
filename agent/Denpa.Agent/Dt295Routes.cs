using System.Buffers.Binary;

namespace Denpa.Agent;

/*
 * PIX-DT295 の PID ルート (仕様書 9.4・9.5・11 章)。ASSP には 64 個のスロットがあり、登録した PID と PAT だけが出てくる。
 * スロットの使い方 (11 章) は機器の仕様ではなく、参照実装が実機で安定して動いた方針。
 */

/// <summary>スロット 1 つ。<see cref="EcmSlot"/> は ECM を登録したスロットの番号 (無ければ 0。ECM 自身は自分の番号)</summary>
public readonly record struct Dt295Route(int Slot, int Pid, int EcmSlot);

/// <summary>主番組 (11.1)。PCR・映像・音声の PID と stream_type</summary>
public sealed record Dt295Program(int Number, int PmtPid, int PcrPid, int VideoPid, byte VideoType, int AudioPid, byte AudioType);

/// <summary>ルートの計画と、レジスターの場所</summary>
public static class Dt295Routes
{
    public const int Slots = 64;

    /// <summary>PAT のスロット (暗黙。レジスターは無い。9.4)</summary>
    public const int PatSlot = 4;

    /// <summary>ECM の CA_system_id (11.3)</summary>
    public const int BCasSystem = 0x0005;

    /// <summary>11.2 の固定の SI PID</summary>
    public static readonly int[] FixedSi = [0x0001, 0x0010, 0x0011, 0x0012, 0x0014, 0x0023, 0x0024, 0x0025, 0x0027, 0x0028, 0x0029];

    /// <summary>主番組に使う stream_type (11.1)</summary>
    public static readonly byte[] VideoTypes = [0x01, 0x02, 0x1B, 0x24];

    public static readonly byte[] AudioTypes = [0x03, 0x04, 0x0F, 0x11];

    /// <summary>PID レジスターのアドレス (9.4)。スロット 4 (PAT) は null</summary>
    public static uint? PidRegister(int slot) => slot switch
    {
        >= 0 and <= 3 => (uint)(0x101E + 2 * slot),
        PatSlot => null,
        >= 5 and < Slots => (uint)(0x1028 + 2 * (slot - 5)),
        _ => throw new ArgumentOutOfRangeException(nameof(slot)),
    };

    /// <summary>ECM 参照フィールドの場所 (9.4。幅 7 ビット)。スロット 2・3・4 は無い</summary>
    public static (uint Address, int Shift)? EcmField(int slot) => slot switch
    {
        0 => (0x10A2, 8),
        1 => (0x10A2, 0),
        2 or 3 or PatSlot => null,
        5 => (0x10A6, 0),
        >= 6 and < Slots => ((uint)(0x10A8 + 2 * ((slot - 6) / 2)), slot % 2 == 0 ? 8 : 0),
        _ => throw new ArgumentOutOfRangeException(nameof(slot)),
    };

    /// <summary>
    /// スロットを割り当てる (11.1・11.3・11.5)。
    /// ECM はスロット 63 から下へ、主番組の映像・音声・PMT・PCR はスロット 0〜3 (ほかに登録済みなら入れない)、
    /// それ以外はスロット 5 から上へ。同じ PID は 2 つ登録しない。PID 0 と 0x1FFF は登録しない。
    /// <paramref name="ecmOf"/> は「保護された PID → その ECM の PID」。異なる ECM が 2 つ以上なら断る (11.5)
    /// </summary>
    public static Dt295Route[] Plan(Dt295Program? main, IEnumerable<int> pids, IReadOnlyDictionary<int, int>? ecmOf = null, bool satellite = false)
    {
        ecmOf ??= new Dictionary<int, int>();
        var slots = new int[Slots];
        Array.Fill(slots, -1);
        var at = new Dictionary<int, int>();

        static bool Registrable(int pid) => pid is > 0 and < 0x1FFF;

        var ecms = ecmOf.Values.Distinct().ToList();
        if (ecms.Count >= 2) throw new InvalidOperationException($"ECM が {ecms.Count} 本要ります。複数の ECM は扱えません (11.5)");
        foreach (var ecm in ecms)
        {
            if (!Registrable(ecm) || at.ContainsKey(ecm)) continue;
            var slot = Enumerable.Range(0, Slots).Reverse().FirstOrDefault(s => s != PatSlot && slots[s] < 0, -1);
            if (slot < 0) throw new InvalidOperationException("スロットが足りません");
            slots[slot] = ecm;
            at[ecm] = slot;
        }
        if (main is not null)
        {
            // 衛星は映像と PCR だけを専用にする。音声と PMT を専用のスロット (1・2) に入れると、機材が音声を流さず、PMT の ES の一覧を映像だけに書き換える (実機の BS1)
            int[] dedicated = satellite ? [main.VideoPid, 0, 0, main.PcrPid] : [main.VideoPid, main.AudioPid, main.PmtPid, main.PcrPid];
            for (var slot = 0; slot < dedicated.Length; slot++)
            {
                var pid = dedicated[slot];
                if (!Registrable(pid) || at.ContainsKey(pid)) continue;
                slots[slot] = pid;
                at[pid] = slot;
            }
        }
        foreach (var pid in pids)
        {
            if (!Registrable(pid) || at.ContainsKey(pid)) continue;
            var slot = Enumerable.Range(5, Slots - 5).FirstOrDefault(s => slots[s] < 0, -1);
            if (slot < 0) throw new InvalidOperationException("スロットが足りません (PAT を除いて 63 個まで。11.1)");
            slots[slot] = pid;
            at[pid] = slot;
        }

        var routes = new List<Dt295Route>();
        for (var slot = 0; slot < Slots; slot++)
        {
            if (slots[slot] < 0) continue;
            var pid = slots[slot];
            var ecmSlot = 0;
            if (ecms.Contains(pid)) ecmSlot = slot;
            else if (ecmOf.TryGetValue(pid, out var ecm) && at.TryGetValue(ecm, out var registered)) ecmSlot = registered;
            if (ecmSlot != 0 && EcmField(slot) is null) throw new InvalidOperationException($"スロット {slot} には ECM 参照を書けません (PID 0x{pid:X4})");
            routes.Add(new Dt295Route(slot, pid, ecmSlot));
        }
        return [.. routes];
    }

    /// <summary>
    /// 計画をレジスターに書く (9.3 の手順 3・4 と 9.5)。全 64 スロットを書き、計画に無いスロットは無効・PID 0・ECM 0 にする
    /// (参照実装は全部クリアしてから計画を書く。最後に残る値は同じ)。<paramref name="cleared"/> が true なら、領域を 0 で埋めた直後なので計画のスロットだけを書く
    /// (フィールド表が書くレジスター 0x1002〜0x101B は PID スロットの 0x101E 以降と重ならない)
    /// </summary>
    public static void Write(Dt295Bridge bridge, IReadOnlyList<Dt295Route> routes, Dt295Program? main, bool cleared = false, int program = 0)
    {
        var bySlot = routes.ToDictionary(route => route.Slot);
        for (var slot = 0; slot < Slots; slot++)
        {
            if (PidRegister(slot) is not { } register)
            {
                if (bySlot.TryGetValue(slot, out var pat) && pat.Pid != 0) throw new InvalidOperationException("スロット 4 は PAT だけです");
                continue;
            }
            var found = bySlot.TryGetValue(slot, out var route);
            // 領域を 0 で埋めた直後は、計画に無いスロットがすでに 0 なので書かない
            if (cleared && !found) continue;
            bridge.Modify16(register, 0, 13, found ? route.Pid : 0);
            bridge.Modify16(register, 15, 1, found ? 1 : 0);
            if (EcmField(slot) is { } field) bridge.Modify16(field.Address, field.Shift, 7, found ? route.EcmSlot : 0);
        }
        // 9.5 番組情報。主番組がまだ決まっていなければ、指定された番組番号 (無ければ 0)。
        // 0x1018 は機材が流す番組の番組番号で、0 なら PAT の最初の番組 (実機で確かめた。衛星は PMT の ES が空に書き換わり主番組が決まらないので、指定がここに効く)
        bridge.Write16(0x1018, (ushort)(main?.Number ?? program));
        bridge.Modify16(0x101C, 8, 8, main?.VideoType ?? 0);
        bridge.Modify16(0x101C, 0, 8, main?.AudioType ?? 0);
    }
}

/// <summary>PAT の 1 行</summary>
public readonly record struct Dt295PatEntry(int Number, int Pid);

/// <summary>PMT の中身 (計画に要る分だけ)。<see cref="EcmOf"/> は「保護された PID → ECM の PID」</summary>
public sealed record Dt295Pmt(int Number, int PcrPid, IReadOnlyList<(byte Type, int Pid)> Streams, IReadOnlyList<int> CaPids, IReadOnlyDictionary<int, int> EcmOf);

/// <summary>
/// PSI のセクションを PID ごとに組み立てる。**暗号化されていない (transport_scrambling_control = 00) パケットだけ**を受け取る。
/// 1 つのパケットに収まらないセクションもつなぐ。CRC が合わないものは捨てる
/// </summary>
public sealed class Dt295SectionReader
{
    private readonly Dictionary<int, List<byte>> _partial = [];

    /// <summary>パケット 1 つを渡す。組み上がったセクションを返す (無ければ空)</summary>
    public List<byte[]> Push(ReadOnlySpan<byte> packet)
    {
        var done = new List<byte[]>();
        if (packet.Length != 188 || packet[0] != 0x47 || (packet[1] & 0x80) != 0 || packet[3] >> 6 != 0) return done;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        var control = (packet[3] >> 4) & 0x3;
        if ((control & 1) == 0) return done;
        var start = 4;
        if (control == 3)
        {
            start = 5 + packet[4];
            if (start >= 188) return done;
        }
        var payload = packet[start..];
        var unitStart = (packet[1] & 0x40) != 0;
        if (unitStart)
        {
            var pointer = payload[0];
            if (1 + pointer > payload.Length) return done;
            // 前のセクションの続き
            if (_partial.TryGetValue(pid, out var tail)) Feed(tail, payload.Slice(1, pointer), done);
            _partial[pid] = [];
            Feed(_partial[pid], payload[(1 + pointer)..], done);
        }
        else if (_partial.TryGetValue(pid, out var partial))
        {
            Feed(partial, payload, done);
        }
        return done;
    }

    private static void Feed(List<byte> buffer, ReadOnlySpan<byte> data, List<byte[]> done)
    {
        foreach (var value in data) buffer.Add(value);
        while (buffer.Count >= 3)
        {
            if (buffer[0] == 0xFF)
            {
                // 詰め物。この PID のこのパケットの残りは使わない
                buffer.Clear();
                return;
            }
            var length = 3 + (((buffer[1] & 0x0F) << 8) | buffer[2]);
            if (buffer.Count < length) return;
            var section = buffer.GetRange(0, length).ToArray();
            buffer.RemoveRange(0, length);
            if (Descrambler.Crc32(section) == 0) done.Add(section);
        }
    }

    /// <summary>PAT を読む (table_id 0)。合わなければ null</summary>
    public static List<Dt295PatEntry>? Pat(ReadOnlySpan<byte> section)
    {
        if (section.Length < 12 || section[0] != 0x00) return null;
        var entries = new List<Dt295PatEntry>();
        for (var at = 8; at + 4 <= section.Length - 4; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(section[at..]);
            var pid = BinaryPrimitives.ReadUInt16BigEndian(section[(at + 2)..]) & 0x1FFF;
            entries.Add(new Dt295PatEntry(number, pid));
        }
        return entries;
    }

    /// <summary>
    /// PMT を読む (table_id 2)。CA 記述子 (タグ 0x09 と 0xF6) の PID を集め、タグ 0x09 で CA_system_id 0x0005 のものを ECM とする (11.3)。
    /// CA 記述子の PID 欄は上位 3 ビットが 111 であること。PID が 0x0010 未満なら不正で null、0x1FFF は無視。
    /// 1 つの範囲 (番組全体・1 つの ES) に ECM が 2 つ以上あれば null (11.5)
    /// </summary>
    public static Dt295Pmt? Pmt(ReadOnlySpan<byte> section)
    {
        if (section.Length < 16 || section[0] != 0x02) return null;
        var number = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        var pcr = BinaryPrimitives.ReadUInt16BigEndian(section[8..]) & 0x1FFF;
        var infoLength = BinaryPrimitives.ReadUInt16BigEndian(section[10..]) & 0x0FFF;
        var end = section.Length - 4;
        if (12 + infoLength > end) return null;
        var caPids = new List<int>();
        var ecmOf = new Dictionary<int, int>();
        if (!Descriptors(section.Slice(12, infoLength), caPids, out var programEcm)) return null;
        var streams = new List<(byte, int)>();
        for (var at = 12 + infoLength; at + 5 <= end;)
        {
            var type = section[at];
            var pid = BinaryPrimitives.ReadUInt16BigEndian(section[(at + 1)..]) & 0x1FFF;
            var esLength = BinaryPrimitives.ReadUInt16BigEndian(section[(at + 3)..]) & 0x0FFF;
            if (at + 5 + esLength > end) return null;
            if (!Descriptors(section.Slice(at + 5, esLength), caPids, out var streamEcm)) return null;
            streams.Add((type, pid));
            if ((streamEcm ?? programEcm) is { } ecm) ecmOf[pid] = ecm;
            at += 5 + esLength;
        }
        return new Dt295Pmt(number, pcr, streams, caPids, ecmOf);
    }

    /// <summary>CAT を読む (table_id 1)。CA 記述子 (タグ 0x09 と 0xF6) の PID (EMM) を返す。不正なら null (11.3)</summary>
    public static List<int>? Cat(ReadOnlySpan<byte> section)
    {
        if (section.Length < 12 || section[0] != 0x01) return null;
        var pids = new List<int>();
        return Descriptors(section[8..^4], pids, out _, singleEcm: false) ? pids : null;
    }

    /// <summary>記述子の並びから CA 記述子を取り出す。範囲の ECM (B-CAS) を返す。不正なら false</summary>
    private static bool Descriptors(ReadOnlySpan<byte> data, List<int> caPids, out int? ecm, bool singleEcm = true)
    {
        ecm = null;
        for (var at = 0; at + 2 <= data.Length;)
        {
            var tag = data[at];
            var length = data[at + 1];
            if (at + 2 + length > data.Length) return false;
            if (tag is 0x09 or 0xF6 && length >= 4)
            {
                var system = BinaryPrimitives.ReadUInt16BigEndian(data[(at + 2)..]);
                var field = BinaryPrimitives.ReadUInt16BigEndian(data[(at + 4)..]);
                if (field >> 13 != 0x7) return false;
                var pid = field & 0x1FFF;
                if (pid < 0x0010) return false;
                if (pid != 0x1FFF)
                {
                    caPids.Add(pid);
                    if (tag == 0x09 && system == Dt295Routes.BCasSystem)
                    {
                        if (singleEcm && ecm is not null && ecm != pid) return false;
                        ecm = pid;
                    }
                }
            }
            at += 2 + length;
        }
        return true;
    }

    /// <summary>
    /// PMT から主番組を選ぶ (11.1)。映像 (0x01・0x02・0x1B・0x24) と音声 (0x03・0x04・0x0F・0x11) の両方を持つこと。
    /// それぞれ最初に見つかったもの
    /// </summary>
    public static Dt295Program? MainProgram(int pmtPid, Dt295Pmt pmt)
    {
        var video = pmt.Streams.FirstOrDefault(stream => Dt295Routes.VideoTypes.Contains(stream.Type));
        var audio = pmt.Streams.FirstOrDefault(stream => Dt295Routes.AudioTypes.Contains(stream.Type));
        if (video == default || audio == default) return null;
        return new Dt295Program(pmt.Number, pmtPid, pmt.PcrPid, video.Pid, video.Type, audio.Pid, audio.Type);
    }
}

/// <summary>
/// <see cref="Dt295RouteTracker"/> の写し。同じチャンネルを選び直したとき、最初の準備から全部のルートを書くために取っておく。
/// 届く PSI と見比べて、違えば捨てる (<see cref="Dt295RouteTracker.Seed"/>)
/// </summary>
public sealed record Dt295RouteSnapshot(
    IReadOnlyList<Dt295PatEntry> Pat,
    IReadOnlyDictionary<int, Dt295Pmt> Pmts,
    IReadOnlyList<int>? Emms,
    IReadOnlyList<int> Pids,
    IReadOnlyDictionary<int, int> EcmOf,
    Dt295Program? Main);

/// <summary>
/// 届いた PSI からルートの計画を組み立てる (11.2・11.3)。始めは PAT (暗黙) と固定の SI PID。PAT が読めたら NIT とすべての PMT を足し、
/// PMT が読めたら PCR・CA 記述子の PID・ES を足す。主番組は PAT の順で最初の、映像と音声を持つ番組で、**一度決めたら替えない** (11.3)。
/// CAT が読めたら EMM (CA 記述子の PID) を足す。
/// 読むのは AES を外したあとの、暗号化されていない (transport_scrambling_control = 00) パケットだけで、PAT・CAT・PAT に載った PMT の PID のものだけを使う。
/// 版数の追従 (11.4) と、録画中の PMT の変化の扱い (11.3 の後半) はまだ持たない (最初の PAT・CAT と、PMT ごとに最初の 1 つだけを使う)。
/// <see cref="Seed"/> で前回の写しを渡したときだけは、最初に届く PAT・CAT・PMT を写しと見比べ、違えば写しを捨てて届いたものに替える
/// </summary>
/// <param name="needCat">そろったとみるのに CAT を待つか (地上波は待ち、衛星は待たない。11.2・8.6)</param>
/// <param name="satellite">衛星か。専用のスロットの使い方が変わる (<see cref="Dt295Routes.Plan"/>)</param>
/// <param name="service">受ける番組の番組番号。指定すると PAT のうち NIT とこの番組だけを追い、主番組もこの番組にする。null なら全番組を追う</param>
public sealed class Dt295RouteTracker(bool needCat = true, int? service = null, bool satellite = false)
{
    private readonly Dt295SectionReader _sections = new();
    private List<int> _pids = [.. Dt295Routes.FixedSi];
    private readonly Dictionary<int, int> _ecmOf = [];
    private readonly Dictionary<int, Dt295Pmt> _pmts = [];
    private List<Dt295PatEntry>? _pat;
    private bool _cat;
    private List<int> _emms = [];

    /// <summary>写しを渡されて、まだ届いたものと見比べていないもの</summary>
    private bool _patUnchecked;
    private bool _catUnchecked;
    private readonly HashSet<int> _pmtsUnchecked = [];

    /// <summary>PAT・(地上波は) CAT・PAT に載ったすべての番組の PMT がそろった (11.2 の手順 3)</summary>
    public bool Settled =>
        _pat is not null && (_cat || !needCat) && _pat.Where(entry => entry.Number != 0).All(entry => _pmts.ContainsKey(entry.Pid));

    public Dt295Route[] Plan { get; private set; } = Dt295Routes.Plan(null, Dt295Routes.FixedSi);

    public Dt295Program? Main { get; private set; }

    public bool PatSeen => _pat is not null;

    /// <summary>最初の番組の PMT の PID (PAT が読めるまで null)</summary>
    public int? FirstPmtPid => _pat?.FirstOrDefault(entry => entry.Number != 0) is { Pid: > 0 } first ? first.Pid : null;

    public bool PmtSeen(int pid) => _pmts.ContainsKey(pid);

    /// <summary>計画を作り直せなかった理由 (複数の ECM・スロットの不足。11.5)。前の計画のまま続ける</summary>
    public string? Problem { get; private set; }

    /// <summary>
    /// いまの状態の写し。PAT と、PAT に載ったすべての PMT (地上波は CAT も) がそろっているときだけ返す (そろっていなければ null)
    /// </summary>
    public Dt295RouteSnapshot? Snapshot() => Settled
        ? new Dt295RouteSnapshot([.. _pat!], new Dictionary<int, Dt295Pmt>(_pmts), needCat ? [.. _emms] : null, [.. _pids], new Dictionary<int, int>(_ecmOf), Main)
        : null;

    /// <summary>
    /// 前回の写しから始める。計画は最初から全部のルートを持つ。届く PAT・CAT・PMT は、最初の 1 つずつを写しと見比べ、
    /// 同じなら何もせず、違えば写しのその部分を捨てて届いたものに替える
    /// </summary>
    public void Seed(Dt295RouteSnapshot snapshot)
    {
        _pat = [.. snapshot.Pat];
        _pmts.Clear();
        foreach (var (pid, pmt) in snapshot.Pmts) _pmts[pid] = pmt;
        _cat = snapshot.Emms is not null;
        _emms = snapshot.Emms is null ? [] : [.. snapshot.Emms];
        _pids = [.. snapshot.Pids];
        _ecmOf.Clear();
        foreach (var (guarded, ecm) in snapshot.EcmOf) _ecmOf[guarded] = ecm;
        Main = snapshot.Main;
        _patUnchecked = true;
        _catUnchecked = _cat;
        _pmtsUnchecked.Clear();
        foreach (var pid in _pmts.Keys) _pmtsUnchecked.Add(pid);
        Replan();
    }

    /// <summary>パケット 1 つを渡す。計画が変わったら true</summary>
    public bool Push(ReadOnlySpan<byte> packet)
    {
        var changed = false;
        var pid = packet.Length == 188 ? ((packet[1] & 0x1F) << 8) | packet[2] : -1;
        // 使うのは PAT・CAT・PAT に載った PMT だけ。映像などのパケットはセクションに組まない
        if (pid != 0 && pid != 1 && !(_pat is not null && _pat.Any(entry => entry.Pid == pid))) return false;
        foreach (var section in _sections.Push(packet))
        {
            if (pid == 0 && (_pat is null || _patUnchecked) && Dt295SectionReader.Pat(section) is { } pat)
            {
                // 番組番号の指定があれば、NIT (番組番号 0) とその番組だけを追う
                var read = service is null ? pat : pat.Where(entry => entry.Number == 0 || entry.Number == service).ToList();
                if (_pat is not null && _patUnchecked)
                {
                    _patUnchecked = false;
                    if (read.SequenceEqual(_pat)) continue;
                    // 写しと違う。PMT 以降は読み直す
                    Discard();
                }
                _pat = read;
                // NIT (番組番号 0) とすべての PMT (11.2 の手順 2)
                foreach (var entry in _pat) _pids.Add(entry.Pid);
                changed = true;
            }
            else if (pid == 1 && (!_cat || _catUnchecked) && Dt295SectionReader.Cat(section) is { } emms)
            {
                if (_cat && _catUnchecked)
                {
                    _catUnchecked = false;
                    if (emms.SequenceEqual(_emms)) continue;
                    _emms = [.. emms];
                    _pids.AddRange(emms.Where(emm => !_pids.Contains(emm)));
                    changed = true;
                    continue;
                }
                _cat = true;
                _emms = [.. emms];
                _pids.AddRange(emms);
                changed = true;
            }
            else if (_pat is not null && (!_pmts.ContainsKey(pid) || _pmtsUnchecked.Contains(pid))
                && _pat.Any(entry => entry.Number != 0 && entry.Pid == pid)
                && Dt295SectionReader.Pmt(section) is { } pmt)
            {
                if (_pmtsUnchecked.Remove(pid))
                {
                    if (SamePmt(_pmts[pid], pmt)) continue;
                    // 写しと違う。この PMT に替えて、PID と ECM の対応と主番組を組み直す
                    _pmts[pid] = pmt;
                    Rebuild();
                    Main = ChooseMain();
                    changed = true;
                    continue;
                }
                _pmts[pid] = pmt;
                _pids.AddRange(pmt.CaPids);
                _pids.Add(pmt.PcrPid);
                _pids.AddRange(pmt.Streams.Select(stream => stream.Pid));
                foreach (var (guarded, ecm) in pmt.EcmOf) _ecmOf.TryAdd(guarded, ecm);
                Main ??= ChooseMain();
                changed = true;
            }
        }
        return changed && Replan();
    }

    /// <summary>写しの PAT が届いた PAT と違った。PMT と主番組は捨てて、届いた PAT から組み立て直す</summary>
    private void Discard()
    {
        _pmts.Clear();
        _pmtsUnchecked.Clear();
        _ecmOf.Clear();
        Main = null;
        _pids = [.. Dt295Routes.FixedSi];
        if (_cat) _pids.AddRange(_emms);
    }

    /// <summary>PAT・CAT・PMT から、計画に入れる PID と ECM の対応を組み直す (PAT の順)</summary>
    private void Rebuild()
    {
        _pids = [.. Dt295Routes.FixedSi];
        _ecmOf.Clear();
        if (_cat) _pids.AddRange(_emms);
        foreach (var entry in _pat!) _pids.Add(entry.Pid);
        foreach (var entry in _pat.Where(entry => entry.Number != 0))
        {
            if (!_pmts.TryGetValue(entry.Pid, out var pmt)) continue;
            _pids.AddRange(pmt.CaPids);
            _pids.Add(pmt.PcrPid);
            _pids.AddRange(pmt.Streams.Select(stream => stream.Pid));
            foreach (var (guarded, ecm) in pmt.EcmOf) _ecmOf.TryAdd(guarded, ecm);
        }
    }

    private static bool SamePmt(Dt295Pmt a, Dt295Pmt b) =>
        a.Number == b.Number && a.PcrPid == b.PcrPid && a.Streams.SequenceEqual(b.Streams) && a.CaPids.SequenceEqual(b.CaPids)
        && a.EcmOf.Count == b.EcmOf.Count && a.EcmOf.All(pair => b.EcmOf.TryGetValue(pair.Key, out var ecm) && ecm == pair.Value);

    /// <summary>PAT の順に見る。PMT がまだ来ていない番組に当たったら、まだ決めない</summary>
    private Dt295Program? ChooseMain()
    {
        foreach (var entry in _pat!.Where(entry => entry.Number != 0))
        {
            if (!_pmts.TryGetValue(entry.Pid, out var pmt)) return null;
            if (Dt295SectionReader.MainProgram(entry.Pid, pmt) is { } main) return main;
        }
        return null;
    }

    private bool Replan()
    {
        Dt295Route[] plan;
        try
        {
            plan = Dt295Routes.Plan(Main, _pids, _ecmOf, satellite);
        }
        catch (InvalidOperationException error)
        {
            Problem = error.Message;
            return false;
        }
        Problem = null;
        if (plan.SequenceEqual(Plan)) return false;
        Plan = plan;
        return true;
    }
}
