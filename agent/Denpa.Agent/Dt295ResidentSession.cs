/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の core/session.c・core/device_query.c・
 * core/resident_image.c (書き込みと照合) を移したもの。Copyright (c) 2026 huggy、MIT License (全文は licenses/mAgicVISION.txt)。
 */

using System.Diagnostics;
using static Denpa.Agent.Dt295ResidentProtocol;

namespace Denpa.Agent;

/// <summary>常駐方式の PIX-DT295 との制御の経路。<see cref="Dt295ResidentLink"/> と、テストの偽物が実装する</summary>
public interface IDt295ResidentTransport
{
    /// <summary>機材のメモリーを読む。0x1000000 以上は窓を通す</summary>
    void Read(uint address, Span<byte> data);

    /// <summary>機材のメモリーに書く。アドレスと長さは 4 の倍数</summary>
    void Write(uint address, ReadOnlySpan<byte> data);

    /// <summary>要求 64 バイトを渡して応答 64 バイトを受ける。**失敗しても渡し直さない** (渡した要求が実行されたかもしれない)</summary>
    void Exchange(ReadOnlySpan<byte> request, Span<byte> response);

    /// <summary>書き込みを 64 バイトずつにする (オフなら 4 バイトずつ)</summary>
    bool BlockWrites { get; set; }
}

/// <summary>選局の中身 (frontend.h の mb86H_dvb_request のうち、DT295 で使うもの)</summary>
/// <param name="Source">0 が地上波、1 が衛星</param>
/// <param name="Frequency">地上波は Hz、衛星は LNB の IF の kHz</param>
/// <param name="StreamId">衛星の TSID。指さないなら null (中継器の先頭の TS)</param>
/// <param name="Layers">地上波の階層 (A=1・B=2・C=4)。衛星は 0</param>
public sealed record Dt295ResidentRequest(int Source, uint Frequency, int? StreamId, uint Layers);

/// <summary>
/// 常駐イメージとのやり取り 1 本 (session.c)。要求ごとに番号を振り、応答の番号が合わなければ投げる。**1 つのスレッドから使う**
/// (受信中の SERVICE とカードの要求も、呼ぶ側が順番にする)。どの要求も、失敗したら繰り返さない
/// </summary>
public sealed class Dt295ResidentSession(IDt295ResidentTransport transport, Func<long>? nowMs = null, Action<int>? delay = null)
{
    private readonly Func<long> _now = nowMs ?? (() => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency);
    private readonly Action<int> _delay = delay ?? Thread.Sleep;

    /// <summary>最後に振った要求の番号</summary>
    public uint Sequence { get; private set; }

    /// <summary>受理された選局の受信部と世代。<see cref="RequestValid"/> のときだけ意味がある</summary>
    public int Source { get; private set; }

    public uint Generation { get; private set; }

    public bool RequestValid { get; private set; }

    public bool Streaming { get; private set; }

    /// <summary>STOP を受理されて、止まり切るのを待っている</summary>
    public bool StopPending { get; private set; }

    public Dt295ResidentRequest? Request { get; private set; }

    /// <summary>選局が落ち着くのを待つ上限 (0 なら <see cref="SettleTimeoutMs"/>)</summary>
    public int TuneTimeoutMs { get; set; }

    /// <summary>選局を待つ間の SERVICE の間隔 (0 なら 10 ms)</summary>
    public int TunePollMs { get; set; }

    public long NowMs => _now();

    public void Delay(int ms) => _delay(ms);

    // ---------------------------------------------------------------------
    // 要求 1 つ (session.c の mb86H_session_exchange・mb86H_session_command)
    // ---------------------------------------------------------------------

    /// <summary>要求を組んで渡し、応答を返す。応答の magic と番号が合わなければ投げる</summary>
    public byte[] Exchange(uint operation, uint address, uint argument, uint budget, ReadOnlySpan<byte> data)
    {
        var sequence = ++Sequence;
        var request = Pack(sequence, operation, address, argument, budget, data);
        var response = new byte[PacketSize];
        transport.Exchange(request, response);
        if (!Matches(response, sequence)) throw new Dt295ResidentException($"応答の番号が要求 (操作 {operation}、番号 {sequence}) と合いません");
        return response;
    }

    /// <summary>常駐イメージのコマンド。<paramref name="channel"/> は受信部か、コマンドによっては中身を選ぶ値</summary>
    public byte[] Command(uint command, uint channel, ReadOnlySpan<byte> data = default) =>
        Exchange(ResidentDispatch, command, channel, unchecked((uint)_now()), data);

    private static bool IsOk(ReadOnlySpan<byte> response) => Result(response) == Ok;

    /// <summary>応答が失敗なら、その理由の値 (負の数)。理由が無ければ -5 (EIO)。成功なら 0</summary>
    private static int Failure(ReadOnlySpan<byte> response)
    {
        if (IsOk(response)) return 0;
        var rc = Error(response);
        return rc < 0 ? rc : -5;
    }

    private static void Check(ReadOnlySpan<byte> response, string what)
    {
        var rc = Failure(response);
        if (rc != 0) throw new Dt295ResidentException($"{what}が失敗しました (結果 {Result(response)}、理由 {rc})", rc);
    }

    // ---------------------------------------------------------------------
    // 状態の問い合わせ (device_query.c)
    // ---------------------------------------------------------------------

    private byte[] Query(uint page, int source)
    {
        if (source is < 0 or >= SourceCount) throw new ArgumentOutOfRangeException(nameof(source));
        var data = new byte[DataSize];
        data[0] = QueryVersion;
        data[1] = (byte)source;
        var response = Command(CommandDeviceQuery, page, data);
        if (Word(response, 12) != CommandDeviceQuery || Word(response, 16) != page || response[24] != QueryVersion || response[25] != page
            || response[26] != source)
        {
            throw new Dt295ResidentException($"状態の問い合わせ (ページ {page}) の応答の形が違います");
        }
        var rc = Error(response);
        if (Result(response) == Fatal && rc < 0) throw new Dt295ResidentException($"状態の問い合わせ (ページ {page}) が失敗しました (理由 {rc})", rc);
        if (!IsOk(response) || rc != 0) throw new Dt295ResidentException($"状態の問い合わせ (ページ {page}) が失敗しました (結果 {Result(response)}、理由 {rc})");
        return response;
    }

    public Dt295ResidentOverview QueryOverview()
    {
        var response = Query(PageOverview, 0);
        if (response[27] != 0) throw new Dt295ResidentException("常駐イメージの様子の応答の形が違います");
        for (var word = 4; word < 9; word++)
        {
            if (QueryWord(response, word) != 0) throw new Dt295ResidentException("常駐イメージの様子の応答の形が違います");
        }
        var overview = new Dt295ResidentOverview(QueryWord(response, 0), QueryWord(response, 1), QueryWord(response, 2), QueryWord(response, 3));
        if ((overview.RfMask & ~((1u << SourceCount) - 1)) != 0 || (overview.StreamMask & ~overview.RfMask) != 0 || overview.ResidentAbi != AbiVersion
            || (overview.WindowVersion != 0 && overview.WindowVersion != StreamWindowVersion))
        {
            throw new Dt295ResidentException($"常駐イメージの様子が想定と違います ({overview})");
        }
        return overview;
    }

    public Dt295ResidentSource QuerySource(int source)
    {
        var response = Query(PageSource, source);
        var described = new Dt295ResidentSource(QueryWord(response, 0), QueryWord(response, 1), QueryWord(response, 2), QueryWord(response, 3),
            QueryWord(response, 4), QueryWord(response, 5), QueryWord(response, 6), response[27]);
        if ((described.Flags & ~(SourcePresent | SourceStream | SourceAutoTsid)) != 0 || (described.Flags & SourcePresent) == 0
            || described.FrequencyMin == 0 || described.FrequencyMin > described.FrequencyMax || described.FrequencyStep == 0
            || described.RecordSize is not (188 or 192) || described.StreamFormat is not (FormatMux or FormatRaw)
            || QueryWord(response, 7) != 0 || QueryWord(response, 8) != 0)
        {
            throw new Dt295ResidentException($"受信部 {source} の説明が想定と違います ({described})");
        }
        return described;
    }

    public Dt295ResidentState QueryState(int source)
    {
        var response = Query(PageState, source);
        if (response[27] != 0) throw new Dt295ResidentException($"受信部 {source} の状態の応答の形が違います");
        var state = new Dt295ResidentState(QueryWord(response, 0), (int)QueryWord(response, 1), (int)QueryWord(response, 2), QueryWord(response, 3),
            QueryWord(response, 4), QueryWord(response, 5), QueryWord(response, 6), QueryWord(response, 7), QueryWord(response, 8));
        if ((state.Flags & ~StateMask) != 0 || (state.CaptureMask & ~((1u << SourceCount) - 1)) != 0 || state.Phase > PhaseFailed || state.Tsid > 0xFFFF)
        {
            throw new Dt295ResidentException($"受信部 {source} の状態が想定と違います ({state})");
        }
        return state;
    }

    /// <summary>状態を問い合わせ、受信部か持ち主に失敗が記録されていれば投げる (session.c の queried_state)</summary>
    private Dt295ResidentState Queried(int source)
    {
        var state = QueryState(source);
        if (state.OwnerError < 0) throw new Dt295ResidentException($"常駐イメージが失敗を記録しています (理由 {state.OwnerError})", state.OwnerError);
        if (state.Error < 0) throw new Dt295ResidentException($"受信部 {source} が失敗を記録しています (理由 {state.Error})", state.Error);
        return state;
    }

    // ---------------------------------------------------------------------
    // 初期化・落ち着くのを待つ (session.c)
    // ---------------------------------------------------------------------

    /// <summary>INITIALIZE を 1 回送り、何も選局していない状態に落ち着くのを待つ (mb86H_session_initialize)</summary>
    public void Initialize()
    {
        Check(Command(CommandInitialize, 0), "初期化");
        Settle(0, 0, ready: false, streaming: false);
    }

    /// <summary>
    /// 状態がそろうまで SERVICE を送る (session.c の session_settle)。失敗が記録されたら後始末を待ってから投げる。
    /// 時間切れなら <see cref="TimeoutException"/>
    /// </summary>
    public void Settle(int source, uint generation, bool ready, bool streaming)
    {
        if (source is < 0 or >= SourceCount) throw new ArgumentOutOfRangeException(nameof(source));
        var timeout = TuneTimeoutMs != 0 && generation != 0 ? TuneTimeoutMs : SettleTimeoutMs;
        var start = _now();
        while (true)
        {
            var response = Command(CommandService, (uint)source);
            Dt295ResidentState? state = null;
            Dt295ResidentException? failure = null;
            try
            {
                state = Queried(source);
            }
            catch (Dt295ResidentException error)
            {
                // 問い合わせの失敗も、記録された失敗と同じく後始末を待ってから投げる (後始末の失敗のほうを先に投げる)
                failure = error;
            }
            var rc = Failure(response);
            if (failure is not null || rc != 0)
            {
                FinishCleanup(source, response);
                throw failure ?? new Dt295ResidentException($"受信部 {source} が失敗しました (理由 {rc})", rc);
            }
            if (Complete(state!, source, generation, ready, streaming)) return;
            if (_now() - start > timeout) throw new TimeoutException($"受信部 {source} が {timeout} ms のうちに落ち着きませんでした ({state})");
            _delay(generation != 0 && TunePollMs != 0 ? TunePollMs : 10);
        }
    }

    /// <summary>状態が待っている形になったか (session.c の query_complete)</summary>
    internal static bool Complete(Dt295ResidentState state, int source, uint generation, bool ready, bool streaming)
    {
        // 初期化のあとは、選局がまだ無いので段階は QUIET で世代は 0 のまま
        var initializedIdle = generation == 0 && !ready && !streaming && state.Generation == 0 && state.Phase == PhaseQuiet;
        if ((!initializedIdle && state.Phase != PhaseComplete) || !state.Has(StateInitialized)
            || state.Has(StateShuttingDown | StateRestorePending) || state.Has(StateReady) != ready)
        {
            return false;
        }
        if (generation != 0 && state.Generation != generation) return false;
        if (state.Has(StateCapturing) != streaming) return false;
        if (streaming && (!state.Has(StateStreamReady) || state.CaptureGeneration != generation)) return false;
        return ((state.CaptureMask & (1u << source)) != 0) == streaming;
    }

    /// <summary>失敗のあと、常駐イメージが後始末を終えるまで SERVICE を送る (mb86H_session_finish_cleanup)</summary>
    private void FinishCleanup(int source, byte[] response)
    {
        var start = _now();
        while (true)
        {
            var status = Result(response);
            if (status != Ok && status != Fatal) throw new Dt295ResidentException($"受信部 {source} の後始末の応答が想定と違います (結果 {status})");
            var state = Queried(source);
            if (state.Phase is PhaseQuiet or PhaseComplete or PhaseFailed && !state.Has(StateStarted | StateOwned | StateRestorePending)) return;
            if (_now() - start > SettleTimeoutMs) throw new TimeoutException($"受信部 {source} の後始末が {SettleTimeoutMs} ms のうちに終わりませんでした");
            _delay(10);
            response = Command(CommandService, 0);
        }
    }

    // ---------------------------------------------------------------------
    // 選局・停止 (session.c)
    // ---------------------------------------------------------------------

    /// <summary>
    /// TUNE を送り、受かって (<paramref name="streaming"/> なら TS を出し始めて) 落ち着くのを待つ (mb86H_session_tune)。
    /// 前の選局の停止が済んでいなければ先に待つ。時間切れのときは、受理された選局を 1 回止めてから <see cref="TimeoutException"/> を投げる
    /// </summary>
    public void Tune(Dt295ResidentRequest request, bool streaming)
    {
        if (request.Source is < 0 or >= SourceCount) throw new ArgumentOutOfRangeException(nameof(request));
        WaitStopped();
        var data = new byte[DataSize];
        var frequency = request.Source != 0 ? request.Frequency + SatelliteLocalKhz : (uint)((request.Frequency + 500UL) / 1000);
        Put(data, 0, frequency);
        var streamId = request.StreamId ?? 0xFFFF;
        data[4] = (byte)(streamId >> 8);
        data[5] = (byte)streamId;
        data[6] = request.Source != 0 ? (byte)0 : (byte)(((request.Layers & 1) << 7) | ((request.Layers & 2) << 5) | ((request.Layers & 4) << 3));
        data[7] = streaming ? (byte)1 : (byte)0;
        data[8] = request.StreamId is null ? (byte)0 : (byte)1;
        RequestValid = false;
        Streaming = false;
        var response = Command(CommandTune, (uint)request.Source, data);
        Check(response, "選局");
        var generation = Word(response, 16);
        if (generation == 0) throw new Dt295ResidentException("選局の応答に世代がありません");
        try
        {
            Settle(request.Source, generation, ready: true, streaming);
        }
        catch (TimeoutException)
        {
            // TUNE は受理されているので、この世代は常駐イメージの中で生きている。次の選局の前に 1 回だけ止める
            Begin(request, generation);
            Stop(request.Source);
            WaitStopped();
            RequestValid = false;
            throw;
        }
        Begin(request, generation);
        Streaming = streaming;
    }

    private void Begin(Dt295ResidentRequest request, uint generation)
    {
        Request = request;
        Source = request.Source;
        Generation = generation;
        RequestValid = generation != 0;
        Streaming = false;
        StopPending = false;
    }

    /// <summary>STOP を送る。受理されたら戻る (止まり切るのは <see cref="WaitStopped"/> で待つ。mb86H_session_stop)</summary>
    public void Stop(int source)
    {
        if (!RequestValid || Source != source) throw new InvalidOperationException($"受信部 {source} は選局していません");
        Streaming = false;
        if (StopPending) return;
        var response = Command(CommandStop, (uint)source);
        var rc = Failure(response);
        if (rc != 0)
        {
            RequestValid = false;
            throw new Dt295ResidentException($"停止が失敗しました (理由 {rc})", rc);
        }
        var generation = Word(response, 16);
        if (generation == 0)
        {
            RequestValid = false;
            throw new Dt295ResidentException("停止の応答に世代がありません");
        }
        Generation = generation;
        StopPending = true;
    }

    /// <summary>STOP のあと、TS が止まり切るまで SERVICE を送る (mb86H_session_wait_stopped)</summary>
    public void WaitStopped()
    {
        var start = _now();
        while (StopPending)
        {
            Check(Command(CommandService, (uint)Source), "停止を待つ間の SERVICE");
            var state = Queried(Source);
            if (state.Generation == Generation && state.Phase == PhaseComplete && !state.Has(StateCapturing) && (state.CaptureMask & (1u << Source)) == 0)
            {
                StopPending = false;
                break;
            }
            if (_now() - start > SettleTimeoutMs) throw new TimeoutException($"受信部 {Source} が {SettleTimeoutMs} ms のうちに止まりませんでした");
            _delay(10);
        }
    }

    /// <summary>受信中に SERVICE を 1 回送る (mb86H_session_service)。USB の DT295 は、TS を出している間これを送り続ける</summary>
    public void Service()
    {
        if (!RequestValid) throw new InvalidOperationException("選局していません");
        Check(Command(CommandService, (uint)Source), "SERVICE");
    }

    /// <summary>今の選局が受かっているか (mb86H_session_locked)</summary>
    public bool Locked(int source)
    {
        if (!RequestValid || Source != source) throw new InvalidOperationException($"受信部 {source} は選局していません");
        Check(Command(CommandStatus, (uint)source), "受信の状態");
        var state = Queried(source);
        return state.Generation == Generation && state.Phase == PhaseComplete && state.Has(StateReady);
    }

    /// <summary>
    /// SHUTDOWN を 1 回送り、持ち主が全部手放すまで SERVICE を送る (session.c の session_shutdown)。
    /// <paramref name="detach"/> なら、同じイメージをもう一度初期化してよいと常駐イメージが言っていれば、冷えた状態を求められても通す
    /// (DT295 は常駐イメージを機材に残したまま閉じる)
    /// </summary>
    public void Shutdown(bool detach)
    {
        var response = Command(CommandShutdown, 0);
        Check(response, "SHUTDOWN");
        var start = _now();
        while (true)
        {
            var state = QueryState(0);
            if (state.OwnerError < 0) throw new Dt295ResidentException($"常駐イメージが失敗を記録しています (理由 {state.OwnerError})", state.OwnerError);
            if (Released(state))
            {
                // 補助の写しが読めず、電源を入れ直さないと戻らない状態。イメージの上書きや戻しをしてよい合図にはしない
                if (state.Has(StateColdRequired) && (!detach || !state.Has(StateReinitializable)))
                {
                    throw new Dt295ResidentException("常駐イメージが、電源を入れ直すまで使えない状態です (-16)", -16);
                }
                RequestValid = Streaming = StopPending = false;
                return;
            }
            Check(response, "SHUTDOWN");
            if (_now() - start > SettleTimeoutMs) throw new TimeoutException($"常駐イメージが {SettleTimeoutMs} ms のうちに手放しませんでした");
            _delay(10);
            response = Command(CommandService, 0);
            Check(response, "SHUTDOWN を待つ間の SERVICE");
        }
    }

    /// <summary>持ち主が全部手放した (session.c の shutdown_released)</summary>
    internal static bool Released(Dt295ResidentState state) =>
        !state.Has(StateStarted | StateInitialized | StateShuttingDown | StateRestorePending | StateOwned | StateCapturing | StateStreamReady)
        && state.CaptureMask == 0;

    // ---------------------------------------------------------------------
    // 常駐イメージの読み書き (resident_image.c)
    // ---------------------------------------------------------------------

    /// <summary>1 回に読み書きする常駐イメージの長さ (MB86H_RESIDENT_BLOCK_BYTES)</summary>
    public const int BlockBytes = 40;

    /// <summary>常駐イメージの <paramref name="offset"/> から書く (40 バイトまで。mb86H_resident_image_block の書く側)</summary>
    public void WriteBlock(uint offset, ReadOnlySpan<byte> data)
    {
        CheckBlock(offset, data.Length);
        var request = new byte[DataSize];
        data.CopyTo(request);
        var response = Exchange(ResidentBlock, offset, 1, (uint)data.Length, request);
        if (!IsOk(response) || Word(response, 12) != data.Length || Word(response, 16) != offset)
        {
            throw new Dt295ResidentException($"常駐イメージの 0x{offset:X} に書けません (結果 {Result(response)})");
        }
    }

    /// <summary>常駐イメージの <paramref name="offset"/> から読む (40 バイトまで)</summary>
    public void ReadBlock(uint offset, Span<byte> data)
    {
        CheckBlock(offset, data.Length);
        var response = Exchange(ResidentBlock, offset, 0, (uint)data.Length, new byte[DataSize]);
        if (!IsOk(response) || Word(response, 12) != data.Length || Word(response, 16) != offset)
        {
            throw new Dt295ResidentException($"常駐イメージの 0x{offset:X} を読めません (結果 {Result(response)})");
        }
        response.AsSpan(DataOffset, data.Length).CopyTo(data);
    }

    private static void CheckBlock(uint offset, int length)
    {
        if (length is <= 0 or > BlockBytes || (offset & 3) != 0 || (length & 3) != 0 || offset > Dt295ResidentImage.Bytes - length)
        {
            throw new ArgumentOutOfRangeException(nameof(offset), $"常駐イメージの 0x{offset:X} から {length} バイトは読み書きできません");
        }
    }

    /// <summary>
    /// 常駐イメージを書く (mb86H_resident_image_program)。書き終えた印を 0 にしてから全体を書き、印以外を照合し、最後に印を書いて読み戻す
    /// </summary>
    public void Program(ReadOnlySpan<byte> image)
    {
        Dt295ResidentImage.Validate(image);
        var commit = Dt295ResidentImage.Commit - Dt295ResidentImage.Base;
        WriteBlock(commit, new byte[4]);
        for (var offset = 0u; offset < Dt295ResidentImage.Bytes; offset += BlockBytes)
        {
            var length = (uint)Math.Min(BlockBytes, Dt295ResidentImage.Bytes - (int)offset);
            if (offset <= commit && commit < offset + length)
            {
                var before = commit - offset;
                var after = before + 4;
                if (before != 0) WriteBlock(offset, image.Slice((int)offset, (int)before));
                if (after < length) WriteBlock(offset + after, image.Slice((int)(offset + after), (int)(length - after)));
            }
            else
            {
                WriteBlock(offset, image.Slice((int)offset, (int)length));
            }
        }
        Verify(image, skipCommit: true);
        WriteBlock(commit, image.Slice((int)commit, 4));
        Span<byte> got = stackalloc byte[4];
        ReadBlock(commit, got);
        if (!got.SequenceEqual(image.Slice((int)commit, 4))) throw new Dt295ResidentException("常駐イメージの書き終えた印が読み戻せません");
    }

    /// <summary>常駐イメージを全部読んで照合する (mb86H_resident_image_verify)。<paramref name="skipCommit"/> なら書き終えた印は比べない</summary>
    public void Verify(ReadOnlySpan<byte> image, bool skipCommit)
    {
        var commit = (int)(Dt295ResidentImage.Commit - Dt295ResidentImage.Base);
        Span<byte> got = stackalloc byte[BlockBytes];
        for (var offset = 0; offset < Dt295ResidentImage.Bytes; offset += BlockBytes)
        {
            var length = Math.Min(BlockBytes, Dt295ResidentImage.Bytes - offset);
            ReadBlock((uint)offset, got[..length]);
            for (var i = 0; i < length; i++)
            {
                if ((!skipCommit || offset + i < commit || offset + i >= commit + 4) && got[i] != image[offset + i])
                {
                    throw new Dt295ResidentException(
                        $"常駐イメージの 0x{Dt295ResidentImage.Base + offset + i:X8} が書いたものと違います (書いた {image[offset + i]:X2}、読んだ {got[i]:X2})");
                }
            }
        }
    }
}
