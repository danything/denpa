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
/// **TSID と original_network_id の並び (バイト 9〜68) は推定** (仕様書 7A.7・13)。PX-MLT5PE の実機では、選んだ TS の TSID が出力した TS の PAT の TSID と同じだった。original_network_id は確かめられていない。
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
/// ヘッダーの位置 (前のヘッダーから 53 パケット目) に正しいヘッダーが来なかったときは、続くフレームを前のヘッダーのスロットの割り当てでためておき、
/// 次の正しいヘッダーで確かめてから出力する (<see cref="MaxHeldFrames"/>)。仕様書 7A.7 の「パケットごとの処理」の 4 は、
/// 次の正しいヘッダーまで何もためないとしている。そのとおりにすると、ヘッダーの受信の誤り 1 回ごとに選んだ TS の 1 フレーム分 (52 スロットのうち選んだ TS の分) が欠ける。
/// 次の正しいヘッダーが 53 パケットごとの位置に来れば、間でパケットは欠けていない。そのヘッダーのスロットの割り当てが前の正しいヘッダーと同じなら、
/// ためたフレームも同じ割り当てだったとみなして出力し、違えば捨てる (仕様書に無い。割り当てが変わって間のフレームだけで戻ることは無いと推定)。
/// ヘッダーの位置に PID が <c>0x002F</c> でないパケットが来たときは、その前のフレームも確かめるまで出力しない (パケットが欠けて位置がずれたかもしれないため)
/// </para>
///
/// <para>
/// <see cref="Push"/> は 1 つのスレッド (<see cref="It930xTsDemux"/>) から呼ぶ。判定 (<see cref="Decision"/>・<see cref="Wait"/>) と
/// <c>--tune</c> が出す値は、ほかのスレッドから読んでよい。
/// 選局のたびに作り直すので、仕様書 7A.7 の「受信を止めて始め直したときに判定を保つ」場面は無い。
/// NULL パケットは除かない (ほかの方式と同じく、選んだ TS をそのまま流す)。選んだ TS が分割 TLV のときも 188 バイトの単位のまま出力し、
/// TLV パケットに組み立てるのは受け取る側 (<see cref="SplitTlv"/>。仕様書 13 の範囲の外)。受け取る側は <see cref="Format"/> で形式を、
/// <see cref="Gaps"/> で出力が前と続いていない所を知る
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

    /// <summary>
    /// ヘッダーの位置に正しいヘッダーが来ないまま、前のヘッダーの割り当てでためるフレームの数の上限 (仕様書に無い)。
    /// ヘッダーの無い搬送波と決める長さ (<see cref="NoHeaderPackets"/>) と同じ 8 フレーム。これより続けて来なければ、位置が分からなくなったものとしてためたフレームを捨て、
    /// 次の正しいヘッダーまで何もためない
    /// </summary>
    public const int MaxHeldFrames = NoHeaderPackets / (TsmfHeader.SlotCount + 1);

    private readonly ManualResetEventSlim _decided = new();
    private readonly byte[] _frame = new byte[MaxHeldFrames * TsmfHeader.SlotCount * It930xTsDemux.PacketSize];
    private readonly ContinuityTracker _before = new();
    private readonly ContinuityTracker _after = new();
    private int _discard;
    private int _frameUsed;
    private int _headerless;
    private int _position;
    /// <summary>ためたまま、次の正しいヘッダーで確かめるのを待っている、そろったフレームの数</summary>
    private int _pending;
    /// <summary>ためているフレーム (今のフレームを含む) のうち、前のヘッダーの割り当てでためたものの数</summary>
    private int _borrowed;
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
    private long _missedHeaders;
    private long _brokenFrames;
    private long _heldFrames;
    private long _mappingChanges;
    private long _expected;
    private long _emitted;
    private volatile int _fewestSlots = -1;
    private volatile int _mostSlots = -1;
    private volatile int _format = (int)StreamFormat.Ts;
    private volatile bool _formatChanged;
    private long _gaps;

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

    /// <summary>最後に受けた正しいヘッダー</summary>
    public TsmfHeader? LastHeader => _last;

    /// <summary>
    /// 判定に使ったヘッダーにある有効な TS の数 (1〜15。<c>/denpa/stream</c> の <c>X-Denpa-Tsmf-Streams</c>)。
    /// TS を選んだ (<see cref="TsmfDecision.Selected"/>) ときだけで、ヘッダーの無い搬送波やまだ決まっていないときは null
    /// </summary>
    public int? Streams => Decision == TsmfDecision.Selected && _first is { } header ? header.ValidStreams.Count : null;

    /// <summary>
    /// 出力した TS の PAT にあった transport_stream_id (<c>--tune</c> が、ヘッダーの TSID の並びの推定を確かめるために出す。仕様書 7A.7)。
    /// PAT をまだ出力していなければ null。PAT のセクションの CRC は確かめない (目安)
    /// </summary>
    public ushort? PatTsid => _patTsid < 0 ? null : (ushort)_patTsid;

    /// <summary>受けたパケットの数 (最初に捨てたものを含む)</summary>
    public long Received => Interlocked.Read(ref _received);

    /// <summary>受けた正しいヘッダーの数</summary>
    public long Headers => Interlocked.Read(ref _headers);

    /// <summary>ヘッダーの位置に来た、CRC などが合わないヘッダー (PID が <c>0x002F</c>) の数</summary>
    public long BadHeaders => Interlocked.Read(ref _badHeaders);

    /// <summary>ヘッダーの位置に来た、PID が <c>0x002F</c> でないパケットの数 (ヘッダーの PID が崩れたか、パケットが欠けて位置がずれた)</summary>
    public long MissedHeaders => Interlocked.Read(ref _missedHeaders);

    /// <summary>出力せずに捨てたフレームの数。52 パケットがそろわなかったものと、前のヘッダーの割り当てでためたが次のヘッダーで確かめられなかったもの</summary>
    public long BrokenFrames => Interlocked.Read(ref _brokenFrames);

    /// <summary>正しいヘッダーが来なかったため前のヘッダーの割り当てでため、次のヘッダーで確かめて出力したフレームの数</summary>
    public long HeldFrames => Interlocked.Read(ref _heldFrames);

    /// <summary>スロットの割り当てが前の正しいヘッダーと違ったヘッダーの数</summary>
    public long MappingChanges => Interlocked.Read(ref _mappingChanges);

    /// <summary>選んだ TS のスロットに来たパケットの数 (r が有効なフレームだけ)。捨てたフレームが無ければ <see cref="Emitted"/> と同じになる</summary>
    public long Expected => Interlocked.Read(ref _expected);

    /// <summary>出力したパケットの数</summary>
    public long Emitted => Interlocked.Read(ref _emitted);

    /// <summary>
    /// 選んだ TS の形式。最初のヘッダーで TS を選んだときに、その相対 TS 番号の TS の種類 (<see cref="TsmfHeader.IsTs"/>) で決め、そのあとは変えない。
    /// TS を選ぶまでと、ヘッダーの無い搬送波は <see cref="StreamFormat.Ts"/>
    /// </summary>
    public StreamFormat Format => (StreamFormat)_format;

    /// <summary>
    /// 選局のあと、ヘッダーにある選んだ TS の種類が <see cref="Format"/> と変わった。変わったあとは何も出力しない (形式の違うバイト列を混ぜて流さないため)。
    /// 起きるかは確かめていない
    /// </summary>
    public bool FormatChanged => _formatChanged;

    /// <summary>
    /// 出力が前と続いていない所の数。フレームを捨てたときと、選んだ TS がヘッダーで無効になって出力を止めたときに増える。
    /// TLV に組み立てる側 (<see cref="SplitTlv"/>) は、この値が変わったら組み立て中の TLV パケットを捨てる (単位に連続性の番号が無いため)
    /// </summary>
    public long Gaps => Interlocked.Read(ref _gaps);

    /// <summary>選んだ TS に割り当てたスロットの数の、ヘッダーごとの最小と最大 (1 フレームの 52 スロットのうち)。TS を選んでいなければ null</summary>
    public (int Fewest, int Most)? SlotsPerFrame => _fewestSlots < 0 ? null : (_fewestSlots, _mostSlots);

    /// <summary>選んだ TS のスロットに来たパケット (選ぶ前) の、連続性の飛びの数と transport_error_indicator が 1 のパケットの数</summary>
    public (long Jumps, long Errors) ContinuityBefore => (_before.Jumps, _before.Errors);

    /// <summary>出力したパケット (選んだあと) の、連続性の飛びの数と transport_error_indicator が 1 のパケットの数</summary>
    public (long Jumps, long Errors) ContinuityAfter => (_after.Jumps, _after.Errors);

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
            Header(TsmfHeader.Parse(packet), emit);
            return;
        }

        if (_first is null)
        {
            // ヘッダーをまだ 1 つも受けていない。424 パケットの間に来なければ、TSMF を使わない搬送波とする
            if (Decision == TsmfDecision.Pending && ++_headerless >= NoHeaderPackets)
            {
                Decide(Index == 0 ? TsmfDecision.Passthrough : TsmfDecision.Missing);
            }
            if (Decision == TsmfDecision.Passthrough)
            {
                Interlocked.Increment(ref _expected);
                _before.Push(packet);
                Emit(packet, emit);
            }
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
                Interlocked.Increment(ref _expected);
                _before.Push(packet);
                packet.CopyTo(_frame.AsSpan(_frameUsed));
                _frameUsed += It930xTsDemux.PacketSize;
            }
            return;
        }

        // 4. ヘッダーの位置に来たパケットが正しいヘッダーでない。PID が 0x002F なら CRC などが合わなかったヘッダー、
        // そうでなければヘッダーの PID が崩れたか、パケットが欠けて位置がずれた。どちらだったかは、次の正しいヘッダーが来る位置で分かる
        var badHeader = TsmfHeader.HasHeaderPid(packet);
        Interlocked.Increment(ref badHeader ? ref _badHeaders : ref _missedHeaders);
        if (badHeader && _pending == 0 && _borrowed == 0)
        {
            // 直前のフレームは正しいヘッダーで始まり、ヘッダーの位置にヘッダーの PID が来た。52 パケットがそろったので出力する (仕様書 7A.7 の 4)
            Flush(emit);
        }
        else if (++_pending >= MaxHeldFrames)
        {
            // 確かめられないフレームが続いた。位置が分からなくなったものとして、ためたフレームを捨て、次の正しいヘッダーまで何もためない
            Drop(_pending);
            _inFrame = false;
            return;
        }
        // 前のヘッダーの割り当てで、次のフレームもためる。次の正しいヘッダーで確かめてから出力する
        _borrowed++;
        _position = 0;
    }

    /// <summary>正しいヘッダーを受けた (仕様書 7A.7 の「パケットごとの処理」の 2)</summary>
    private void Header(TsmfHeader header, TsmfEmit emit)
    {
        var previous = _last;
        var same = previous is not null && previous.Slots.AsSpan().SequenceEqual(header.Slots);
        if (_inFrame && _position == TsmfHeader.SlotCount)
        {
            // 直前のフレームの 52 パケットがそろい、ヘッダーが 53 パケットごとの位置に来た (間でパケットは欠けていない)。
            // 前のヘッダーの割り当てでためたフレームは、割り当てが変わっていなければ出力する
            if (_borrowed == 0 || same)
            {
                Interlocked.Add(ref _heldFrames, _borrowed);
                Flush(emit);
            }
            else
            {
                Drop(_pending + 1);
            }
        }
        else if (_inFrame)
        {
            // そろう前にヘッダーが来た (パケットが欠けた)。ためたフレームを捨てる
            Drop(_pending + 1);
        }
        _pending = 0;
        _borrowed = 0;
        _frameUsed = 0;
        Interlocked.Increment(ref _headers);
        if (previous is not null && !same) Interlocked.Increment(ref _mappingChanges);
        _last = header;
        if (_first is null)
        {
            // 最初のヘッダーで k 本目の相対 TS 番号 r を決める。そのまま出力している間にヘッダーが来たときも、TSMF の搬送波として選び直す
            _first = header;
            var valid = header.ValidStreams;
            if (Index < valid.Count)
            {
                _relative = valid[Index];
                // 形式は判定を知らせる前に決める (選局が戻ったときに読む。ITuneDevice.Format)。そのまま出力していたときは、
                // 読む側に TS と伝えたあとなので変えない。選んだ TS が TLV なら、下で形式が変わったとして止める
                if (Decision != TsmfDecision.Passthrough) _format = (int)(header.IsTs(_relative) ? StreamFormat.Ts : StreamFormat.Tlv);
                Decide(TsmfDecision.Selected);
            }
            else
            {
                Decide(TsmfDecision.Missing);
            }
        }
        _position = 0;
        _inFrame = true;
        // r がヘッダーで無効になったら何も出さない。TS の種類が変わったら、そのあとは何も出さない
        var collecting = _collect;
        if (Decision == TsmfDecision.Selected && header.IsValid(_relative) && header.IsTs(_relative) != (Format == StreamFormat.Ts)) _formatChanged = true;
        _collect = Decision == TsmfDecision.Selected && header.IsValid(_relative) && !_formatChanged;
        if (collecting && !_collect) Interlocked.Increment(ref _gaps);
        if (_collect)
        {
            var slots = header.SlotsOf(_relative);
            if (_fewestSlots < 0 || slots < _fewestSlots) _fewestSlots = slots;
            if (slots > _mostSlots) _mostSlots = slots;
        }
    }

    /// <summary>ためたフレームを出力せずに捨てる</summary>
    private void Drop(int frames)
    {
        Interlocked.Add(ref _brokenFrames, frames);
        Interlocked.Increment(ref _gaps);
        _frameUsed = 0;
        _pending = 0;
        _borrowed = 0;
    }

    private void Flush(TsmfEmit emit)
    {
        for (var at = 0; at < _frameUsed; at += It930xTsDemux.PacketSize) Emit(_frame.AsSpan(at, It930xTsDemux.PacketSize), emit);
        _frameUsed = 0;
    }

    private void Emit(ReadOnlySpan<byte> packet, TsmfEmit emit)
    {
        if (_patTsid < 0) ReadPat(packet);
        Interlocked.Increment(ref _emitted);
        _after.Push(packet);
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
