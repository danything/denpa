using System.Buffers.Binary;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// **カードが無くても TLV (4K の MMT/TLV) から分かること**を数える。<see cref="TsObservation"/> と同じことを TLV でして、<c>--tune</c> の出力に足す (Probe.cs)。
/// 診断のためだけに読み、流すバイト列には何もしない。
///
/// <para>
/// 読むのは、TLV パケット (ARIB STD-B32 第 3 部) の種類、ヘッダー圧縮した IP と IPv6 の UDP、MMTP (ARIB STD-B60) のヘッダーとスクランブルの印、
/// スクランブルされていない信号 (PA メッセージの MPT、M2 セクションメッセージの MH-EIT・MH-SDT・ECM)、伝送制御信号の TLV-NIT。
/// MPT のアクセス制御記述子 (<c>0x8004</c>) から CA_system_id と ECM の packet_id を読み、その packet_id に来た ECM のセクション (table_id <c>0x82</c>) を 1 つ取っておく
/// (<see cref="Ecm"/>。<c>--ecm-test</c> がカードに渡す)。オフセットのうち、QC26 の録りで確かめたのは MPT・ECM・MH-EIT・MH-SDT・TLV-NIT の読み方で、ほかは規格の要約からの推定。
/// </para>
///
/// <para>
/// 1 つの実体は 1 本のストリームからだけ呼ぶ。
/// </para>
/// </summary>
public sealed class TlvObservation
{
    /// <summary>MMTP の packet_id ごとの数</summary>
    private sealed class PidStat
    {
        public long Packets;
        /// <summary>スクランブルの印 (なし・予約・偶数・奇数) ごとの数</summary>
        public readonly long[] Scramble = new long[4];
        /// <summary>payload_type ごとの数 (MPU 0x00・信号 0x02 など)</summary>
        public readonly SortedDictionary<int, long> Types = [];
    }

    private readonly byte[] _buffer = new byte[2 * (SplitTlv.TlvHeaderSize + ushort.MaxValue)];
    private int _buffered;
    private readonly long[] _types = new long[256];
    private readonly SortedDictionary<int, long> _headerTypes = [];
    private readonly SortedSet<int> _cids = [];
    private readonly SortedDictionary<int, PidStat> _pids = [];
    private readonly Dictionary<int, List<byte>> _fragments = [];
    private readonly SortedDictionary<int, long> _messages = [];
    private readonly SortedDictionary<int, long> _otherTables = [];
    /// <summary>MPT のアクセス制御記述子 (CA_system_id と ECM の packet_id)。package とアセットのもの</summary>
    private readonly SortedSet<(int System, int Pid)> _access = [];
    private readonly SortedDictionary<int, (string Type, int Pid)> _assets = [];
    /// <summary>table_id 0x82 のセクションが来た packet_id → (数、長さ、最初のセクション)</summary>
    private readonly SortedDictionary<int, (long Count, int Length, byte[] First)> _ecms = [];
    private readonly SortedDictionary<int, (string Name, bool Actual, int FreeCa)> _services = [];
    private long _packets, _skipped, _ntp, _broken, _mpt, _plt, _emm;
    private long _eit, _eitBad, _sdtActual, _sdtOther, _sdtBad, _nit, _nitBad, _amt;
    private int? _package, _networkId;
    private string? _networkName;
    private (int Service, string Name)? _eitSample;

    /// <summary>MH-EIT のセクション (CRC が合ったもの) の数</summary>
    public long EitSections => _eit;

    /// <summary>MH-SDT のセクション (CRC が合ったもの) の数</summary>
    public long SdtSections => _sdtActual + _sdtOther;

    /// <summary>TLV-NIT のセクション (CRC が合ったもの) の数</summary>
    public long NitSections => _nit;

    /// <summary>MPT の package (MMT_package_id が 2 バイトならその値。service_id と同じ)。MPT が来ていなければ null</summary>
    public int? Package => _package;

    /// <summary>MPT のアクセス制御記述子にあった CA_system_id と ECM の packet_id (重なりなし)</summary>
    public IReadOnlyCollection<(int System, int Pid)> AccessControl => _access;

    /// <summary>packet_id ごとの、スクランブルの印 (なし・予約・偶数・奇数) の数</summary>
    public IReadOnlyDictionary<int, long[]> Scrambling => _pids.ToDictionary(pair => pair.Key, pair => pair.Value.Scramble);

    /// <summary>
    /// MPT が ECM の packet_id に挙げた所に来た、CRC の合う最初の ECM のセクション (table_id から CRC まで) と、その packet_id。
    /// MPT か ECM が来ていなければ null
    /// </summary>
    public (int Pid, byte[] Section)? Ecm
    {
        get
        {
            foreach (var (_, pid) in _access)
            {
                if (_ecms.TryGetValue(pid, out var found)) return (pid, found.First);
            }
            return null;
        }
    }

    /// <summary>
    /// 受けたバイト列を渡す (区切りはどこでもよい)。TLV パケットに分けて <see cref="Push"/> に渡す。
    /// 先頭が <c>0x7F</c> でない所は 1 バイトずつ読み飛ばして数える
    /// </summary>
    public void Feed(ReadOnlySpan<byte> data)
    {
        while (data.Length > 0)
        {
            var take = Math.Min(_buffer.Length - _buffered, data.Length);
            data[..take].CopyTo(_buffer.AsSpan(_buffered));
            _buffered += take;
            data = data[take..];
            var at = 0;
            while (_buffered - at >= SplitTlv.TlvHeaderSize)
            {
                if (_buffer[at] != SplitTlv.Sync || !SplitTlv.Types.ContainsKey(_buffer[at + 1]))
                {
                    at++;
                    _skipped++;
                    continue;
                }
                var length = SplitTlv.TlvHeaderSize + BinaryPrimitives.ReadUInt16BigEndian(_buffer.AsSpan(at + 2));
                if (_buffered - at < length) break;
                Push(_buffer.AsSpan(at, length));
                at += length;
            }
            _buffer.AsSpan(at, _buffered - at).CopyTo(_buffer);
            _buffered -= at;
        }
    }

    /// <summary>TLV パケットを 1 つ (ヘッダーの 4 バイトを含む) 渡す</summary>
    public void Push(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < SplitTlv.TlvHeaderSize || packet[0] != SplitTlv.Sync) return;
        _packets++;
        var type = packet[1];
        _types[type]++;
        var body = packet[SplitTlv.TlvHeaderSize..];
        try
        {
            switch (type)
            {
                case 0x02:
                    // IPv6 (次のヘッダーが UDP で宛先のポートが 123 なら NTP)
                    if (body.Length >= 48 && body[6] == 17 && BinaryPrimitives.ReadUInt16BigEndian(body[42..]) == 123) _ntp++;
                    break;
                case 0x03:
                    CompressedIp(body);
                    break;
                case 0xFE:
                    Signalling(body);
                    break;
            }
        }
        catch (Exception error) when (error is ArgumentOutOfRangeException or IndexOutOfRangeException)
        {
            // 長さの食い違い。読めなかったものとして数える
            _broken++;
        }
    }

    /// <summary>ヘッダー圧縮した IP パケット (CID 12 ビット・SN 4 ビット・CID_header_type)。UDP の中身を MMTP として読む (IPv6 の 0x60・0x61 だけ)</summary>
    private void CompressedIp(ReadOnlySpan<byte> body)
    {
        if (body.Length < 3) return;
        _cids.Add((body[0] << 4) | (body[1] >> 4));
        var header = body[2];
        _headerTypes[header] = _headerTypes.GetValueOrDefault(header) + 1;
        /*
         * 0x60 は IPv6 のヘッダーから payload_length を除いた 38 バイトと、UDP のヘッダーからポートだけを残した 4 バイト (QC26 の録りで、そのあとに MMTP のヘッダーが続くのを確かめた)。
         * 0x61 はヘッダー無し。IPv4 の 0x20・0x21 は録りに無く、並びを確かめていないので数えるだけにする
         */
        var payload = header switch
        {
            0x60 => body[(3 + 38 + 4)..],
            0x61 => body[3..],
            _ => [],
        };
        if (payload.Length > 0) Mmtp(payload);
    }

    /// <summary>MMTP パケット (ARIB STD-B60)。ヘッダー拡張のスクランブルの印を数え、信号を読む</summary>
    private void Mmtp(ReadOnlySpan<byte> m)
    {
        if (m.Length < 12)
        {
            _broken++;
            return;
        }
        var counter = (m[0] & 0x20) != 0;
        var extension = (m[0] & 0x02) != 0;
        var payloadType = m[1] & 0x3F;
        var pid = BinaryPrimitives.ReadUInt16BigEndian(m[2..]);
        var at = 12 + (counter ? 4 : 0);
        var scramble = 0;
        if (extension)
        {
            var extensionType = BinaryPrimitives.ReadUInt16BigEndian(m[at..]) & 0x7FFF;
            var length = BinaryPrimitives.ReadUInt16BigEndian(m[(at + 2)..]);
            var items = m.Slice(at + 4, length);
            at += 4 + length;
            // 種類 0x0000 の中に、種類・長さ・中身の並び。種類 0x0001 の先頭 2 ビットがスクランブルの印 (ARIB STD-B61。QC26 で確かめた)
            if (extensionType == 0x0000)
            {
                for (var item = 0; item + 4 <= items.Length;)
                {
                    var itemType = BinaryPrimitives.ReadUInt16BigEndian(items[item..]);
                    var itemLength = BinaryPrimitives.ReadUInt16BigEndian(items[(item + 2)..]);
                    if ((itemType & 0x7FFF) == 0x0001 && itemLength > 0) scramble = items[item + 4] >> 6;
                    item += 4 + itemLength;
                    if ((itemType & 0x8000) != 0) break;
                }
            }
        }
        if (!_pids.TryGetValue(pid, out var stat)) _pids[pid] = stat = new PidStat();
        stat.Packets++;
        stat.Scramble[scramble]++;
        stat.Types[payloadType] = stat.Types.GetValueOrDefault(payloadType) + 1;
        // 信号 (payload_type 0x02) で、スクランブルされていないものだけ読む
        if (payloadType == 0x02 && scramble == 0) Signal(pid, m[at..]);
    }

    /// <summary>信号メッセージのペイロード (分割と集約を組み立てる)</summary>
    private void Signal(int pid, ReadOnlySpan<byte> payload)
    {
        if (payload.Length < 2) return;
        var fragmentation = payload[0] >> 6;
        var longLength = (payload[0] & 0x02) != 0;
        var aggregated = (payload[0] & 0x01) != 0;
        var body = payload[2..];
        byte[] whole;
        switch (fragmentation)
        {
            case 0:
                whole = body.ToArray();
                break;
            case 1:
                _fragments[pid] = [.. body];
                return;
            case 2:
                if (_fragments.TryGetValue(pid, out var middle)) middle.AddRange(body);
                return;
            default:
                if (!_fragments.Remove(pid, out var first)) return;
                first.AddRange(body);
                whole = [.. first];
                break;
        }
        if (!aggregated)
        {
            Message(pid, whole);
            return;
        }
        var width = longLength ? 4 : 2;
        for (var at = 0; at + width <= whole.Length;)
        {
            var length = (int)(longLength ? BinaryPrimitives.ReadUInt32BigEndian(whole.AsSpan(at)) : BinaryPrimitives.ReadUInt16BigEndian(whole.AsSpan(at)));
            at += width;
            Message(pid, whole.AsSpan(at, Math.Min(length, whole.Length - at)));
            at += length;
        }
    }

    /// <summary>信号メッセージを 1 つ。PA メッセージ (0x0000) と M2 セクションメッセージ (0x8000) の表を読む</summary>
    private void Message(int pid, ReadOnlySpan<byte> message)
    {
        if (message.Length < 5) return;
        var id = BinaryPrimitives.ReadUInt16BigEndian(message);
        _messages[id] = _messages.GetValueOrDefault(id) + 1;
        if (id == 0x0000)
        {
            // message_id・version・length (4 バイト)・number_of_tables と表の一覧 (4 バイトずつ)。そのあとに表が並ぶ
            var end = Math.Min(message.Length, 7 + (int)BinaryPrimitives.ReadUInt32BigEndian(message[3..]));
            var at = 8 + 4 * message[7];
            while (at + 4 <= end)
            {
                var length = 4 + BinaryPrimitives.ReadUInt16BigEndian(message[(at + 2)..]);
                Table(pid, message.Slice(at, Math.Min(length, end - at)));
                at += length;
            }
        }
        else if (id == 0x8000)
        {
            // message_id・version・length (2 バイト) のあとにセクションが 1 つ
            Table(pid, message[5..]);
        }
    }

    /// <summary>表を 1 つ (table_id から)</summary>
    private void Table(int pid, ReadOnlySpan<byte> table)
    {
        if (table.Length < 4) return;
        var id = table[0];
        switch (id)
        {
            case 0x20:
                Mpt(table);
                return;
            case 0x80:
                _plt++;
                return;
            case 0x84 or 0x85:
                _emm++;
                return;
        }
        if (id is not (0x82 or (>= 0x8B and <= 0x9B) or 0x9F or 0xA0))
        {
            _otherTables[id] = _otherTables.GetValueOrDefault(id) + 1;
            return;
        }
        // ここから下は CRC を持つセクション
        var section = Section(table);
        if (section.IsEmpty)
        {
            if (id == 0x82) _broken++;
            else if (id is 0x9F or 0xA0) _sdtBad++;
            else _eitBad++;
            return;
        }
        if (id == 0x82)
        {
            _ecms[pid] = _ecms.TryGetValue(pid, out var known) ? (known.Count + 1, section.Length, known.First) : (1, section.Length, section.ToArray());
        }
        else if (id is 0x9F or 0xA0) Sdt(section);
        else Eit(section);
    }

    /// <summary>CRC を持つセクション。section_length の長さで切り、CRC が合えば返す</summary>
    private static ReadOnlySpan<byte> Section(ReadOnlySpan<byte> table)
    {
        if (table.Length < 3) return [];
        var length = 3 + (((table[1] & 0x0F) << 8) | table[2]);
        if (length < 12 || length > table.Length) return [];
        var section = table[..length];
        return Descrambler.Crc32(section) == 0 ? section : [];
    }

    /// <summary>MPT (MMT パッケージテーブル)。package とアセット、アクセス制御記述子を読む</summary>
    private void Mpt(ReadOnlySpan<byte> table)
    {
        _mpt++;
        var at = 5;
        var packageLength = table[at++];
        var package = table.Slice(at, packageLength);
        if (packageLength == 2) _package = BinaryPrimitives.ReadUInt16BigEndian(package);
        at += packageLength;
        var descriptorsLength = BinaryPrimitives.ReadUInt16BigEndian(table[at..]);
        Descriptors(table.Slice(at + 2, descriptorsLength));
        at += 2 + descriptorsLength;
        var assets = table[at++];
        for (var i = 0; i < assets; i++)
        {
            // identifier_type・asset_id_scheme (4)・asset_id_length・asset_id
            var idLength = table[at + 5];
            at += 6 + idLength;
            var type = Encoding.ASCII.GetString(table.Slice(at, 4));
            var clock = (table[at + 4] & 0x01) != 0;
            at += 5;
            if (clock) at += 2 + ((table[at + 1] & 0x01) != 0 ? 4 : 0);
            int? pid = null;
            var locations = table[at++];
            for (var l = 0; l < locations; l++)
            {
                var locationType = table[at++];
                switch (locationType)
                {
                    case 0x00:
                        pid ??= BinaryPrimitives.ReadUInt16BigEndian(table[at..]);
                        at += 2;
                        break;
                    case 0x01: at += 12; break;
                    case 0x02: at += 36; break;
                    case 0x03: at += 4; break;
                    case 0x04: at += 36; break;
                    case 0x05: at += 1 + table[at]; break;
                    default: return;
                }
            }
            var assetDescriptors = BinaryPrimitives.ReadUInt16BigEndian(table[at..]);
            Descriptors(table.Slice(at + 2, assetDescriptors));
            at += 2 + assetDescriptors;
            if (pid is { } found) _assets[found] = (type, found);
        }
    }

    /// <summary>MMT の記述子の並び (タグが 0xF000 未満なら長さ 1 バイト、以上なら 2 バイト)。アクセス制御記述子 (0x8004) を読む</summary>
    private void Descriptors(ReadOnlySpan<byte> list)
    {
        foreach (var (tag, body) in MmtDescriptors(list))
        {
            // CA_system_ID (2)・MMT_general_location_info (location_type 0x00 なら packet_id)
            if (tag == 0x8004 && body.Length >= 5 && body[2] == 0x00)
            {
                _access.Add((BinaryPrimitives.ReadUInt16BigEndian(body), BinaryPrimitives.ReadUInt16BigEndian(body[3..])));
            }
        }
    }

    /// <summary>MMT の記述子の並びを、タグと中身に分ける</summary>
    private static List<(int Tag, byte[] Body)> MmtDescriptors(ReadOnlySpan<byte> list)
    {
        var found = new List<(int, byte[])>();
        var at = 0;
        while (at + 3 <= list.Length)
        {
            var tag = BinaryPrimitives.ReadUInt16BigEndian(list[at..]);
            int length;
            if (tag < 0xF000)
            {
                length = list[at + 2];
                at += 3;
            }
            else
            {
                if (at + 4 > list.Length) break;
                length = BinaryPrimitives.ReadUInt16BigEndian(list[(at + 2)..]);
                at += 4;
            }
            if (at + length > list.Length) break;
            found.Add((tag, list.Slice(at, length).ToArray()));
            at += length;
        }
        return found;
    }

    /// <summary>MH-SDT。局ごとの service_id・free_CA_mode と、サービス記述子 (0x8019) の局名</summary>
    private void Sdt(ReadOnlySpan<byte> section)
    {
        var actual = section[0] == 0x9F;
        if (actual) _sdtActual++;
        else _sdtOther++;
        var end = section.Length - 4;
        for (var at = 11; at + 5 <= end;)
        {
            var service = BinaryPrimitives.ReadUInt16BigEndian(section[at..]);
            var freeCa = (section[at + 3] >> 4) & 1;
            var length = ((section[at + 3] & 0x0F) << 8) | section[at + 4];
            var name = "";
            foreach (var (tag, body) in MmtDescriptors(section.Slice(at + 5, Math.Min(length, end - at - 5))))
            {
                // service_type・provider_name_length・provider_name・service_name_length・service_name (UTF-8)
                if (tag != 0x8019 || body.Length < 3) continue;
                var provider = body[1];
                if (2 + provider >= body.Length) continue;
                var nameLength = body[2 + provider];
                name = Utf8(body.AsSpan(3 + provider, Math.Min(nameLength, body.Length - 3 - provider)));
            }
            _services[service] = (name, actual, freeCa);
            at += 5 + length;
        }
    }

    /// <summary>MH-EIT。最初に読めた番組名 (MH-短形式イベント記述子 0xF001) を 1 つ控える</summary>
    private void Eit(ReadOnlySpan<byte> section)
    {
        _eit++;
        if (_eitSample is not null) return;
        var service = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        var end = section.Length - 4;
        for (var at = 14; at + 12 <= end;)
        {
            var length = ((section[at + 10] & 0x0F) << 8) | section[at + 11];
            foreach (var (tag, body) in MmtDescriptors(section.Slice(at + 12, Math.Min(length, end - at - 12))))
            {
                // ISO_639_language_code (3)・event_name_length・event_name (UTF-8)
                if (tag != 0xF001 || body.Length < 4) continue;
                _eitSample = (service, Utf8(body.AsSpan(4, Math.Min(body[3], body.Length - 4))));
                return;
            }
            at += 12 + length;
        }
    }

    /// <summary>伝送制御信号 (TLV-SI)。セクションが並ぶ。TLV-NIT (0x40・0x41) と AMT (0xFE) を数える</summary>
    private void Signalling(ReadOnlySpan<byte> body)
    {
        var at = 0;
        while (at + 3 <= body.Length && body[at] != 0xFF)
        {
            var length = 3 + (((body[at + 1] & 0x0F) << 8) | body[at + 2]);
            var table = body.Slice(at, Math.Min(length, body.Length - at));
            at += length;
            var id = table[0];
            if (id == 0xFE)
            {
                _amt++;
                continue;
            }
            if (id is not (0x40 or 0x41))
            {
                _otherTables[id] = _otherTables.GetValueOrDefault(id) + 1;
                continue;
            }
            var section = Section(table);
            if (section.IsEmpty)
            {
                _nitBad++;
                continue;
            }
            _nit++;
            if (id != 0x40) continue;
            _networkId = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
            // network_descriptors_length のあとの記述子 (TS と同じ 1 バイトのタグ)。ネットワーク名記述子 (0x40) の中身は UTF-8
            var descriptors = ((section[8] & 0x0F) << 8) | section[9];
            for (var d = 10; d + 2 <= 10 + descriptors && d + 2 <= section.Length;)
            {
                var tag = section[d];
                var size = section[d + 1];
                if (tag == 0x40) _networkName = Utf8(section.Slice(d + 2, Math.Min(size, section.Length - d - 2)));
                d += 2 + size;
            }
        }
    }

    private static string Utf8(ReadOnlySpan<byte> text)
    {
        var decoded = Encoding.UTF8.GetString(text);
        if (decoded.Length <= 40) return decoded;
        // サロゲートペア (絵文字など) の途中で切らない
        return decoded[..(char.IsHighSurrogate(decoded[39]) ? 39 : 40)] + "…";
    }

    /// <summary><c>--tune</c> に出す行</summary>
    public IEnumerable<string> Describe()
    {
        if (_packets == 0)
        {
            yield return "TLV  読めるパケットがありません";
            yield break;
        }
        var types = string.Join("  ", Enumerable.Range(0, 256).Where(type => _types[type] > 0)
            .Select(type => $"{SplitTlv.Types.GetValueOrDefault((byte)type, "?")} (0x{type:X2}) {_types[type]}"));
        yield return $"TLV  {_packets} パケット  {types}{(_broken > 0 ? $"  読めなかったもの {_broken}" : "")}{(_skipped > 0 ? $"  読み飛ばしたバイト {_skipped}" : "")}";
        if (_headerTypes.Count > 0 || _ntp > 0)
        {
            var headers = string.Join("・", _headerTypes.Select(pair => $"0x{pair.Key:X2} {pair.Value}"));
            yield return $"IP  ヘッダー圧縮の CID {string.Join(" ", _cids)}  圧縮の種類 {(headers.Length == 0 ? "-" : headers)}  IPv6 の NTP {_ntp}";
        }
        foreach (var (pid, stat) in _pids)
        {
            var kinds = string.Join("・", stat.Types.Select(pair => $"{PayloadName(pair.Key)} {pair.Value}"));
            var asset = _assets.TryGetValue(pid, out var found) ? $" {found.Type}" : "";
            yield return $"MMTP 0x{pid:X4}{asset}  {kinds}  スクランブル なし {stat.Scramble[0]}・偶数 {stat.Scramble[2]}・奇数 {stat.Scramble[3]}"
                + (stat.Scramble[1] > 0 ? $"・予約の値 {stat.Scramble[1]}" : "");
        }
        if (_messages.Count > 0)
        {
            yield return $"信号メッセージ  {string.Join("  ", _messages.Select(pair => $"0x{pair.Key:X4} {pair.Value}"))}  (PA メッセージの MPT {_mpt}・PLT {_plt})";
        }
        yield return _mpt == 0 ? "MPT  来ていません"
            : $"MPT  package {(_package is { } package ? $"0x{package:X4}" : "-")}  "
                + (_access.Count == 0 ? "アクセス制御記述子なし" : string.Join(" / ", _access.Select(ca => $"CA_system_id 0x{ca.System:X4} ECM 0x{ca.Pid:X4}")))
                + $"  アセット {(_assets.Count == 0 ? "-" : string.Join(" ", _assets.Values.Select(a => $"{a.Type} 0x{a.Pid:X4}")))}";
        foreach (var (pid, ecm) in _ecms) yield return $"ECM 0x{pid:X4}  table_id 0x82 {ecm.Count} セクション (長さ {ecm.Length})";
        if (_emm > 0) yield return $"EMM  {_emm} セクション";
        yield return _nit > 0
            ? $"TLV-NIT  読めます  network_id {(_networkId is { } network ? $"0x{network:X4}" : "-")}{(_networkName is { } name ? $"「{name}」" : "")}  {_nit} セクション"
            : _nitBad > 0 ? $"TLV-NIT  CRC が合いません ({_nitBad} セクション)" : "TLV-NIT  来ていません";
        yield return SdtSections > 0
            ? $"MH-SDT  読めます  自 TLV ストリーム {_sdtActual}・ほか {_sdtOther} セクション  "
                + string.Join(" / ", _services.Select(pair => $"0x{pair.Key:X4}「{pair.Value.Name}」{(pair.Value.Actual ? "" : " (ほか)")} free_CA_mode {pair.Value.FreeCa}"))
            : _sdtBad > 0 ? $"MH-SDT  CRC が合いません ({_sdtBad} セクション)" : "MH-SDT  来ていません";
        yield return _eit > 0
            ? $"MH-EIT  読めます  {_eit} セクション{(_eitSample is { } sample ? $"  局 0x{sample.Service:X4}「{sample.Name}」" : "")}"
            : _eitBad > 0 ? $"MH-EIT  CRC が合いません ({_eitBad} セクション)" : "MH-EIT  来ていません";
        if (_otherTables.Count > 0) yield return $"ほかの表  {string.Join("  ", _otherTables.Select(pair => $"0x{pair.Key:X2} {pair.Value}"))}";
        if (_access.Any(ca => ca.System == TsObservation.BcasSystemId))
        {
            yield return $"CA_system_id 0x{TsObservation.BcasSystemId:X4} は B-CAS と同じ値です。B-CAS のカードが鍵を返すかは --ecm-test で確かめます";
        }
    }

    private static string PayloadName(int type) => type switch
    {
        0x00 => "MPU",
        0x01 => "汎用データ",
        0x02 => "信号",
        0x03 => "繰り返し",
        _ => $"0x{type:X2}",
    };
}
