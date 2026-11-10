namespace Denpa.Agent;

/*
 * ISDB-C の TSMF (1 つの搬送波に複数の TS を入れる多重フレーム) から、TS を 1 つ選ぶ (仕様書 7A.7)。
 *
 * クリーンルームで、仕様書 (denpa-spec の mlt5/spec.md。PLEX MLT5 系の CXD2856ER と CXD2858ER の動作を書いたもの) だけから書いた。
 * 参考にした実装のソースは見ていない。コメントの「仕様書 x.y」は仕様書の節の番号。仕様書に無くて決めた所は「仕様書に無い」、
 * 仕様書が推定としている所は「推定」と書いてある。復調器は TSMF の処理をせず (仕様書 7A.3 の手順 2)、多重した TS をヘッダーごと出す。
 */

/// <summary>TSMF の判定 (仕様書 7A.7 の「判定の待ち」)</summary>
public enum TsmfDecision
{
    /// <summary>まだ決まっていない (ヘッダーも、ヘッダーの無い搬送波と決める数のパケットも来ていない)</summary>
    Pending,

    /// <summary>ヘッダーの無い搬送波。搬送波の TS をそのまま出力する (0 本目を指定したときだけ)</summary>
    Passthrough,

    /// <summary>ヘッダーから相対 TS 番号を決めた。その TS のパケットだけを出力する</summary>
    Selected,

    /// <summary>指定した TS が無い (最初のヘッダーに k 本目が無い。ヘッダーの無い搬送波で 1 本目以降を指定した)</summary>
    Missing,
}

/// <summary>
/// TSMF のヘッダーのパケットを読んだもの (仕様書 7A.7 の「ヘッダーの中身」)。相対 TS 番号は 1〜15。
/// **TSID と original_network_id の並び (バイト 9〜68) は推定** で、実機では確かめられていない (仕様書 7A.7・13)。
/// 受信の状態と緊急のフラグ (バイト 69〜72) も並びが推定なので、分けずに 4 バイトのまま持つ
/// </summary>
/// <param name="Version">バイト 6 の bit7:5</param>
/// <param name="FrameType">バイト 6 の bit3:0 (フレームの種類。1 か 2)</param>
/// <param name="Valid">TS の状態 (バイト 7〜8)。bit15 が相対 TS 番号 1、bit1 が 15。1 なら有効</param>
/// <param name="TsType">TS の種類 (バイト 125〜126。並びは <paramref name="Valid"/> と同じ)。1 なら MPEG-2 TS、0 なら分割 TLV</param>
/// <param name="Ids">相対 TS 番号 1〜15 の TSID と original_network_id (推定の並び)</param>
/// <param name="Status">バイト 69〜72 (受信の状態と緊急のフラグ。並びは推定)</param>
/// <param name="Slots">スロット 1〜52 の相対 TS 番号 (バイト 73〜98)</param>
/// <param name="Raw">ヘッダーのパケットの 188 バイト</param>
public sealed record TsmfHeader(
    int Version, int FrameType, ushort Valid, ushort TsType,
    IReadOnlyList<(ushort Tsid, ushort Onid)> Ids, byte[] Status, byte[] Slots, byte[] Raw)
{
    /// <summary>相対 TS 番号の数</summary>
    public const int Streams = 15;

    /// <summary>1 フレームのスロットの数 (ヘッダーを除く。仕様書 7A.7)</summary>
    public const int SlotCount = 52;

    /// <summary>相対 TS 番号 <paramref name="relative"/> (1〜15) が有効か</summary>
    public bool IsValid(int relative) => relative is >= 1 and <= Streams && (Valid & (0x8000 >> (relative - 1))) != 0;

    /// <summary>相対 TS 番号 <paramref name="relative"/> (1〜15) が MPEG-2 TS か (false なら分割 TLV。仕様書 7A.7)</summary>
    public bool IsTs(int relative) => relative is >= 1 and <= Streams && (TsType & (0x8000 >> (relative - 1))) != 0;

    /// <summary>有効な TS の相対 TS 番号を、小さい順に並べたもの (仕様書 7A.7 の「TS の指定」)</summary>
    public IReadOnlyList<int> ValidStreams => [.. Enumerable.Range(1, Streams).Where(IsValid)];

    /// <summary>相対 TS 番号 <paramref name="relative"/> に割り当てたスロットの数</summary>
    public int SlotsOf(int relative) => Slots.Count(slot => slot == relative);

    /// <summary>
    /// パケットが TSMF のヘッダーか (仕様書 7A.7 の「ヘッダーのパケットの見分け方」)。同期バイト (バイト 0) は見ない。
    /// PID が <c>0x002F</c> で誤りのフラグ・開始のフラグ・優先のフラグが 0、バイト 3 の上位 4 ビットが 1、フレーム同期が <c>1A86</c> か <c>0579</c>、
    /// バイト 6 の bit4 が 0 でフレームの種類が 1 か 2、バイト 4〜187 の CRC-32 が 0
    /// </summary>
    public static bool IsHeader(ReadOnlySpan<byte> packet)
    {
        if (packet.Length != It930xTsDemux.PacketSize) return false;
        if (packet[1] != 0x00 || packet[2] != 0x2F || (packet[3] & 0xF0) != 0x10) return false;
        var sync = ((packet[4] & 0x1F) << 8) | packet[5];
        if (sync is not (0x1A86 or 0x0579)) return false;
        if ((packet[6] & 0x10) != 0 || (packet[6] & 0x0F) is not (1 or 2)) return false;
        return Descrambler.Crc32(packet[4..]) == 0;
    }

    /// <summary>PID が TSMF のヘッダーのもの (<c>0x002F</c>) か。CRC が合わなかったヘッダーを見分ける (仕様書 7A.7 の「パケットごとの処理」の 4)</summary>
    public static bool HasHeaderPid(ReadOnlySpan<byte> packet) => (((packet[1] & 0x1F) << 8) | packet[2]) == 0x002F;

    /// <summary>ヘッダーのパケット (<see cref="IsHeader"/> が true のもの) を読む</summary>
    public static TsmfHeader Parse(ReadOnlySpan<byte> packet)
    {
        var ids = new (ushort, ushort)[Streams];
        for (var i = 0; i < Streams; i++)
        {
            var at = 9 + 4 * i;
            ids[i] = ((ushort)((packet[at] << 8) | packet[at + 1]), (ushort)((packet[at + 2] << 8) | packet[at + 3]));
        }
        var slots = new byte[SlotCount];
        // 1 バイトに 2 スロットで、上位 4 ビットが先のスロット
        for (var i = 0; i < SlotCount; i++) slots[i] = (byte)(i % 2 == 0 ? packet[73 + i / 2] >> 4 : packet[73 + i / 2] & 0x0F);
        return new TsmfHeader(
            packet[6] >> 5, packet[6] & 0x0F,
            (ushort)((packet[7] << 8) | packet[8]), (ushort)((packet[125] << 8) | packet[126]),
            ids, packet.Slice(69, 4).ToArray(), slots, packet.ToArray());
    }
}

/// <summary><see cref="TsmfSelector.Push"/> が出力するパケットを受け取る</summary>
public delegate void TsmfEmit(ReadOnlySpan<byte> packet);

/// <summary>
/// 受け取った TS から、TSMF の TS を 1 つ選ぶ (仕様書 7A.7)。選局のたびに新しく作る (判定の状態を最初に戻す。仕様書 7A.4 の手順 1)。
///
/// <para>
/// TS は「有効な TS を相対 TS 番号の小さい順に並べたときの k 本目」(k = 0〜14) で指定する。選局してから最初に受けたヘッダーで k 本目の相対 TS 番号 r を決め、
/// そのあとは r を変えない。r がヘッダーで無効になったら何も出さない。ヘッダーが 424 パケットの間に 1 つも来なければ TSMF を使わない搬送波とし、
/// k = 0 なら搬送波の TS をそのまま出力する。
/// </para>
///
/// <para>
/// <see cref="Push"/> は 1 つのスレッド (<see cref="It930xTsDemux"/>) から呼ぶ。判定 (<see cref="Decision"/>・<see cref="Wait"/>) と
/// <c>--tune</c> が出す値は、ほかのスレッドから読んでよい。
/// 選局のたびに作り直すので、仕様書 7A.7 の「受信を止めて始め直したときに判定を保つ」場面は無い。
/// NULL パケットは除かない (ほかの方式と同じく、選んだ TS をそのまま流す)。分割 TLV の取り出しはしない (仕様書 13 の範囲の外)
/// </para>
/// </summary>
public sealed class TsmfSelector
{
    /// <summary>ヘッダーの無い搬送波と決めるまでのパケットの数 (8 フレーム分。仕様書 7A.7・11)</summary>
    public const int NoHeaderPackets = 424;

    /// <summary>
    /// ロックのあと、判定に使わずに捨てるパケットの数 (仕様書 7A.7 の「パケットごとの処理」の 1・11)。選局し直した直後は、前の搬送波の TS がブリッジに残っていて、
    /// 新しい搬送波のロックのあとに届くため。仕様書は「ブリッジの転送 1 回分」と書き、参考にした実装の値 (816 パケット) と、残りが最大 710 パケットだった記録を挙げる。
    /// denpa の転送 1 回分 (<see cref="It930xBridge.TsTransferSize"/>) は 348 パケットで記録の 710 より小さいので、816 を使う (推定。残る量が転送の大きさで決まるかは仕様書に無い)
    /// </summary>
    public const int DiscardPackets = 816;

    /// <summary>判定の時間切れ (ロックのあと 3 秒。仕様書 7A.7・11)</summary>
    public const int TimeoutMs = 3000;

    /// <summary>指定できる k の最大 (TS0〜TS14。仕様書 7A.7)</summary>
    public const int MaxIndex = TsmfHeader.Streams - 1;

    private readonly ManualResetEventSlim _decided = new();
    private readonly byte[] _frame = new byte[TsmfHeader.SlotCount * It930xTsDemux.PacketSize];
    private int _discard;
    private int _frameUsed;
    private int _headerless;
    private int _position;
    private bool _inFrame;
    private bool _collect;
    private volatile int _decision = (int)TsmfDecision.Pending;
    private volatile int _relative;
    private volatile TsmfHeader? _first;
    private volatile TsmfHeader? _last;
    private volatile int _patTsid = -1;
    private long _received;
    private long _headers;
    private long _badHeaders;
    private long _brokenFrames;

    /// <param name="index">有効な TS を相対 TS 番号の小さい順に並べたときの何本目か (0〜14)</param>
    /// <param name="discard">最初に、判定に使わずに捨てるパケットの数</param>
    public TsmfSelector(int index, int discard = DiscardPackets)
    {
        if (index is < 0 or > MaxIndex) throw new ArgumentOutOfRangeException(nameof(index), $"TSMF の TS は 0〜{MaxIndex} 本目で指定します ({index})");
        Index = index;
        _discard = discard;
    }

    /// <summary>指定した k (0〜14)</summary>
    public int Index { get; }

    public TsmfDecision Decision => (TsmfDecision)_decision;

    /// <summary>選んだ相対 TS 番号 r (1〜15)。<see cref="TsmfDecision.Selected"/> でなければ 0</summary>
    public int Relative => _relative;

    /// <summary>判定に使ったヘッダー (選局してから最初に受けたもの)。受けていなければ null</summary>
    public TsmfHeader? FirstHeader => _first;

    /// <summary>最後に受けたヘッダー</summary>
    public TsmfHeader? LastHeader => _last;

    /// <summary>
    /// 出力した TS の PAT にあった transport_stream_id (<c>--tune</c> が、ヘッダーの TSID の並びの推定を確かめるために出す。仕様書 7A.7)。
    /// PAT をまだ出力していなければ null。PAT のセクションの CRC は確かめない (目安)
    /// </summary>
    public ushort? PatTsid => _patTsid < 0 ? null : (ushort)_patTsid;

    /// <summary>受けたパケットの数 (最初に捨てたものを含む)</summary>
    public long Received => Interlocked.Read(ref _received);

    /// <summary>受けたヘッダーの数</summary>
    public long Headers => Interlocked.Read(ref _headers);

    /// <summary>ヘッダーの位置に来た、CRC などが合わないヘッダー (PID が <c>0x002F</c>) の数</summary>
    public long BadHeaders => Interlocked.Read(ref _badHeaders);

    /// <summary>52 パケットがそろわずに捨てたフレームの数</summary>
    public long BrokenFrames => Interlocked.Read(ref _brokenFrames);

    /// <summary>
    /// 判定が決まる (<see cref="TsmfDecision.Pending"/> でなくなる) まで待つ。<paramref name="timeoutMs"/> で打ち切る。
    /// 仕様書 7A.7 は 20 ms ごとに確かめるとしているが、決まったときの合図を待つ (決まり次第戻る。時間切れは同じ)
    /// </summary>
    public TsmfDecision Wait(int timeoutMs)
    {
        _decided.Wait(timeoutMs);
        return Decision;
    }

    private void Decide(TsmfDecision decision)
    {
        _decision = (int)decision;
        _decided.Set();
    }

    /// <summary>
    /// 受け取ったパケットを 1 つ渡す (188 バイト)。出力するパケットを <paramref name="emit"/> に渡す (仕様書 7A.7 の「パケットごとの処理」)。
    /// TSMF の TS は、フレームの 52 パケットがそろったことを次のヘッダーで確かめてから出力する (位置がずれたフレームから別の TS のパケットを出さないため)
    /// </summary>
    public void Push(ReadOnlySpan<byte> packet, TsmfEmit emit)
    {
        Interlocked.Increment(ref _received);
        // 1. 前の搬送波の残りを、判定に使わずに捨てる
        if (_discard > 0)
        {
            _discard--;
            return;
        }

        if (TsmfHeader.IsHeader(packet))
        {
            // 2. 直前のフレームの 52 パケットがそろっていれば、ためたパケットを出力する。そろっていなければ捨てる
            if (_inFrame && _position == TsmfHeader.SlotCount) Flush(emit);
            else if (_inFrame) Interlocked.Increment(ref _brokenFrames);
            _frameUsed = 0;
            var header = TsmfHeader.Parse(packet);
            Interlocked.Increment(ref _headers);
            _last = header;
            if (_first is null)
            {
                // 最初のヘッダーで k 本目の相対 TS 番号 r を決める。そのまま出力している間にヘッダーが来たときも、TSMF の搬送波として選び直す
                _first = header;
                var valid = header.ValidStreams;
                if (Index < valid.Count)
                {
                    _relative = valid[Index];
                    Decide(TsmfDecision.Selected);
                }
                else
                {
                    Decide(TsmfDecision.Missing);
                }
            }
            _position = 0;
            _inFrame = true;
            // r がヘッダーで無効になったら何も出さない
            _collect = Decision == TsmfDecision.Selected && header.IsValid(_relative);
            return;
        }

        if (_first is null)
        {
            // ヘッダーをまだ 1 つも受けていない。424 パケットの間に来なければ、TSMF を使わない搬送波とする
            if (Decision == TsmfDecision.Pending && ++_headerless >= NoHeaderPackets)
            {
                Decide(Index == 0 ? TsmfDecision.Passthrough : TsmfDecision.Missing);
            }
            if (Decision == TsmfDecision.Passthrough) Emit(packet, emit);
            return;
        }

        // 一度ヘッダーを受けたあとは、ヘッダーが途切れてもそのまま出力には切り替えない
        if (!_inFrame) return;
        if (_position < TsmfHeader.SlotCount)
        {
            // 3. スロットの位置を 1 つ進め、そのスロットの相対 TS 番号が r のときだけためる。出力は次のヘッダーまで待つ
            var slot = _last!.Slots[_position++];
            if (_collect && slot == _relative)
            {
                packet.CopyTo(_frame.AsSpan(_frameUsed));
                _frameUsed += It930xTsDemux.PacketSize;
            }
            return;
        }

        // 4. ヘッダーの位置に来たパケットがヘッダーでない
        if (TsmfHeader.HasHeaderPid(packet))
        {
            // 受信の誤りで CRC が合わなかったヘッダー。ためたフレームは出力し、次の正しいヘッダーまでは何もためない
            Interlocked.Increment(ref _badHeaders);
            Flush(emit);
        }
        else
        {
            // パケットが欠けて位置が分からなくなった。ためたフレームを捨て、次のヘッダーまで何もためない
            Interlocked.Increment(ref _brokenFrames);
        }
        _frameUsed = 0;
        _inFrame = false;
    }

    private void Flush(TsmfEmit emit)
    {
        for (var at = 0; at < _frameUsed; at += It930xTsDemux.PacketSize) Emit(_frame.AsSpan(at, It930xTsDemux.PacketSize), emit);
        _frameUsed = 0;
    }

    private void Emit(ReadOnlySpan<byte> packet, TsmfEmit emit)
    {
        if (_patTsid < 0) ReadPat(packet);
        emit(packet);
    }

    /// <summary>PAT (PID 0) の先頭のパケットから transport_stream_id を読む</summary>
    private void ReadPat(ReadOnlySpan<byte> packet)
    {
        // 誤りのフラグが無く、開始のフラグがあり、PID が 0 で、ペイロードがある
        if ((packet[1] & 0xDF) != 0x40 || packet[2] != 0x00 || (packet[3] & 0x10) == 0) return;
        var at = 4;
        if ((packet[3] & 0x20) != 0) at += 1 + packet[4];
        if (at >= packet.Length) return;
        // pointer_field のあとがセクション。table_id (00)、section_length (2 バイト)、transport_stream_id (2 バイト)
        at += 1 + packet[at];
        if (at + 5 > packet.Length || packet[at] != 0x00) return;
        _patTsid = (packet[at + 3] << 8) | packet[at + 4];
    }
}
