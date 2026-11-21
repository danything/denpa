using System.IO.Pipelines;

namespace Denpa.Agent;

/// <summary>
/// EP 0x84 から来た 1 本のバイト列を、ブリッジの入力 0〜4 ごとの 188 バイトのパケット列に分ける。
///
/// <para>
/// ブリッジは入力ごとにパケットの先頭の 0x47 を決めた値 (<see cref="It930xBridge.SyncBytes"/>) に付け替えて 1 本にまとめる (<c>IT9300_setSyncByteMode</c>)。
/// 先頭の 1 バイトで入力を見分け、0x47 に戻して入力の出口 (<see cref="It930xTsOutput"/>) に渡す。
/// </para>
///
/// <para>
/// 揃っていないときは、位置 i と i + 188 の両方が決めた同期バイトなら i をパケットの先頭とみなし、そうでなければ 1 バイト進める
/// (飛ばしたバイトは <see cref="Skipped"/>)。揃ったあとも 188 バイトごとに確かめる。先頭が決めた値でなくても、188 バイト先が決めた値なら
/// 知らない同期バイトのパケットとして 1 つ捨て (<see cref="Unknown"/>)、188 バイト先も違えば揃いが外れたとみなして揃え直す (<see cref="Lost"/>)。
/// TS の中身にたまたま同じ値が並ぶと 1 パケットぶん誤って揃うことがあるが、次のパケットで確かめたときに外れて揃え直す。
/// </para>
///
/// <para>
/// <see cref="Push"/> は 1 つのスレッドから呼ぶ。<see cref="Attach"/>・<see cref="Detach"/> はほかのスレッドから呼んでよい。
/// </para>
/// </summary>
internal sealed class It930xTsDemux
{
    public const int PacketSize = 188;

    /// <summary>同期バイトの値ごとの入力 (決めた値でなければ -1)</summary>
    private readonly int[] _input = new int[256];
    private readonly It930xTsOutput?[] _outputs;
    private readonly long[] _packets;
    private readonly It930xTsOutput?[] _targets;
    private byte[] _store = new byte[It930xBridge.TsRequestSize + 2 * PacketSize];
    private int _used;
    private bool _aligned;

    /// <param name="syncBytes">
    /// 入力 0、1、… の同期バイト (<see cref="It930xBridge.SyncBytes"/> か、機種ごとの <see cref="It930xModel.SyncBytes"/>)。0 の入力は使わない。
    /// CXD2856ER の機種には 0x47 を使わない (書き換えていないパケットと見分けるため)。Q3・W3 系の受信機 3 と、受信機が 1 つの機種は、
    /// TC90522 の仕様書 (1.2・11.1・11.2) の値が 0x47 なので、そのまま受ける
    /// </param>
    public It930xTsDemux(IReadOnlyList<byte> syncBytes)
    {
        Array.Fill(_input, -1);
        for (var i = 0; i < syncBytes.Count; i++)
        {
            if (syncBytes[i] == 0) continue;
            if (_input[syncBytes[i]] >= 0) throw new ArgumentException($"同期バイト 0x{syncBytes[i]:X2} が重なっています", nameof(syncBytes));
            _input[syncBytes[i]] = i;
        }
        _outputs = new It930xTsOutput?[syncBytes.Count];
        _packets = new long[syncBytes.Count];
        _targets = new It930xTsOutput?[syncBytes.Count];
    }

    /// <summary>入力ごとに分けたパケットの数</summary>
    public IReadOnlyList<long> Packets => _packets;

    /// <summary>入力 <paramref name="input"/> に分けたパケットの数。<see cref="Push"/> と別のスレッドから読む</summary>
    public long PacketsOf(int input) => Volatile.Read(ref _packets[input]);

    /// <summary>揃っていない間に飛ばしたバイトの数。EP からのバイト列が 188 バイトの並びから外れたときに増える。原因は USB の取りこぼしか、ブリッジの問題</summary>
    public long Skipped { get; private set; }

    /// <summary>揃っている間に来た、知らない同期バイトのパケットの数 (捨てた)</summary>
    public long Unknown { get; private set; }

    /// <summary>揃いが外れて揃え直した回数</summary>
    public long Lost { get; private set; }

    /// <summary>入力 <paramref name="input"/> のパケットを <paramref name="output"/> に渡しはじめる。前の出口があれば外して返す</summary>
    public It930xTsOutput? Attach(int input, It930xTsOutput output) => Interlocked.Exchange(ref _outputs[input], output);

    /// <summary>入力 <paramref name="input"/> の出口を外して返す。外したあとも、その時に動いている <see cref="Push"/> の 1 回ぶんは渡ることがある</summary>
    public It930xTsOutput? Detach(int input) => Interlocked.Exchange(ref _outputs[input], null);

    /// <summary>読んだバイト列を足し、取り出せたパケットを入力ごとの出口に渡す。188 バイトに満たない残りは次の呼び出しまで持ち越す</summary>
    public void Push(ReadOnlySpan<byte> data)
    {
        if (_used + data.Length > _store.Length) Array.Resize(ref _store, Math.Max(_store.Length * 2, _used + data.Length));
        data.CopyTo(_store.AsSpan(_used));
        _used += data.Length;

        // 1 回の呼び出しの間は、同じ出口に渡す (途中で付け替えられても、書きかけを別の出口に渡さない)
        var targets = _targets;
        for (var i = 0; i < targets.Length; i++) targets[i] = Volatile.Read(ref _outputs[i]);
        var written = 0;

        var at = 0;
        while (true)
        {
            var left = _used - at;
            if (_aligned)
            {
                if (left < PacketSize) break;
                var input = _input[_store[at]];
                if (input >= 0)
                {
                    _store[at] = 0x47;
                    _packets[input]++;
                    if (targets[input] is { } output)
                    {
                        output.Write(_store.AsSpan(at, PacketSize));
                        written |= 1 << input;
                    }
                    at += PacketSize;
                    continue;
                }
                // 先頭が決めた値でない。188 バイト先を見て、知らない値のパケットか、揃いが外れたかを決める
                if (left <= PacketSize) break;
                if (_input[_store[at + PacketSize]] >= 0)
                {
                    Unknown++;
                    at += PacketSize;
                    continue;
                }
                _aligned = false;
                Lost++;
            }
            if (left <= PacketSize) break;
            if (_input[_store[at]] >= 0 && _input[_store[at + PacketSize]] >= 0)
            {
                _aligned = true;
                continue;
            }
            at++;
            Skipped++;
        }
        _store.AsSpan(at, _used - at).CopyTo(_store);
        _used -= at;

        for (var i = 0; i < targets.Length; i++)
        {
            if ((written & (1 << i)) != 0) targets[i]!.Commit();
        }
        Array.Clear(targets);
    }
}

/// <summary>
/// 受信機 1 つぶんの TS の出口。<see cref="Pipe"/> (8 MB) に詰め、読み出し側は <see cref="DeviceStream"/>。Pipe は asicen-userland・CECH-ZD1 J・PIX-DT295・Siano の機材と同じ <see cref="TsBuffer"/> で作る。
/// 選局のたびに新しく作り、前の選局のパケットと混ぜない。
///
/// <para>
/// 読む側が詰まって Pipe が溢れたら、この受信機のパケットだけを捨てて数える (<see cref="Dropped"/>)。
/// EP 0x84 の読み出しは 5 つの入力で 1 本なので、待つとほかの受信機のパケットも欠けるため。読む側が追いついたら、また詰める。
/// 書くのは <see cref="It930xTsDemux"/> の 1 つのスレッドで、止める (<see cref="Complete"/>) のはほかのスレッドから呼んでよい。
/// </para>
/// </summary>
internal sealed class It930xTsOutput
{
    private readonly PipeWriter _writer;
    private readonly Lock _gate = new();
    private ValueTask<FlushResult> _flushing;
    private bool _waiting;
    private bool _unflushed;
    private bool _closed;
    private volatile string? _reason;

    private readonly TsmfSelector? _tsmf;
    private readonly SplitTlv? _tlv;
    private readonly TsmfEmit _route;
    private readonly TlvEmit _storeTlv;
    private long _gaps;

    /// <summary>選局の途中で、TSMF のヘッダーにある選んだ TS の種類が変わったときに、読む側に伝える理由 (<see cref="TsmfSelector.FormatChanged"/>)</summary>
    public const string FormatChangedReason = "選んだ TS の形式が変わりました";

    /// <param name="tsmf">ISDB-C のとき、TSMF から TS を 1 つ選ぶ処理 (CXD2856 の仕様書 8.7)。ほかの方式は通さない (CXD2856 の仕様書 10.1) ので null</param>
    /// <param name="tlv">ISDB-C のとき、選んだ TS が分割 TLV なら TLV パケットに組み立てる処理。<paramref name="tsmf"/> と組で渡す</param>
    public It930xTsOutput(TsmfSelector? tsmf = null, SplitTlv? tlv = null) : this(TsBuffer.New(), tsmf, tlv)
    {
    }

    /// <summary>Pipe を渡すのはテストのため (溢れる大きさを小さくする)</summary>
    internal It930xTsOutput(Pipe pipe, TsmfSelector? tsmf = null, SplitTlv? tlv = null)
    {
        _writer = pipe.Writer;
        _tsmf = tsmf;
        _tlv = tlv;
        _route = Route;
        _storeTlv = Store;
        Output = new DeviceStream(pipe.Reader, () => _reason);
    }

    public DeviceStream Output { get; }

    /// <summary>欠けを数える処理 (<see cref="WatchLoss"/>)。書くのは呼んだスレッド、読むのは <see cref="It930xTsDemux"/> のスレッド</summary>
    private It930xTsLoss? _loss;

    /// <summary>
    /// このあと詰めるパケットの欠け (連続性の飛び) を数え始める (<see cref="It930xTuner"/> が、全体の溢れが立ったままの機材で TS を確かめるとき)。
    /// 呼ぶたびに数え直す。数えるのは TSMF を通す前のパケットなので、ISDB-C では使わない (TSMF のフレームには複数の TS の同じ PID が混じる)
    /// </summary>
    internal It930xTsLoss WatchLoss()
    {
        var loss = new It930xTsLoss();
        Volatile.Write(ref _loss, loss);
        return loss;
    }

    /// <summary>詰めたパケットの数 (TLV に組み立てているときは TLV パケットの数)。テストが、閉じたあとに詰めていないことを見る</summary>
    internal long Packets { get; private set; }

    /// <summary>Pipe が溢れていて捨てたパケットの数 (TLV に組み立てているときは TLV パケットの数)</summary>
    public long Dropped { get; private set; }

    /// <summary>読む側が閉じたか、止めた</summary>
    public bool Closed
    {
        get
        {
            lock (_gate) return _closed;
        }
    }

    /// <summary>
    /// パケットを 1 つ詰める (まだ渡さない。<see cref="Commit"/> で渡す)。溢れていれば捨てて数える。
    /// ISDB-C のときは TSMF の処理に通し、選んだ TS のパケットだけを詰める (CXD2856 の仕様書 8.7)。選んだ TS が分割 TLV なら、TLV パケットに組み立ててから詰める。
    /// 選局の途中で選んだ TS の種類が変わったら、出力を止めて読む側に理由を伝える (形式の違うバイト列を混ぜて流さない)
    /// </summary>
    public void Write(ReadOnlySpan<byte> packet)
    {
        Volatile.Read(ref _loss)?.Push(packet, Environment.TickCount64);
        if (_tsmf is not { } tsmf)
        {
            Store(packet);
            return;
        }
        tsmf.Push(packet, _route);
        if (tsmf.FormatChanged) Complete(FormatChangedReason);
    }

    /// <summary>TSMF から選んだ単位を、TS ならそのまま、分割 TLV なら組み立ててから詰める</summary>
    private void Route(ReadOnlySpan<byte> unit)
    {
        if (_tlv is not { } tlv || _tsmf!.Format != StreamFormat.Tlv)
        {
            Store(unit);
            return;
        }
        // フレームが欠けたあとの単位は、前と続いていない。組み立て中の TLV パケットを捨てる
        var gaps = _tsmf.Gaps;
        if (gaps != _gaps)
        {
            _gaps = gaps;
            tlv.Break();
        }
        tlv.Push(unit, _storeTlv);
    }

    private void Store(ReadOnlySpan<byte> packet)
    {
        lock (_gate)
        {
            if (_closed) return;
            if (Full())
            {
                if (!_closed) Dropped++;
                return;
            }
            packet.CopyTo(_writer.GetSpan(packet.Length));
            _writer.Advance(packet.Length);
            _unflushed = true;
            Packets++;
        }
    }

    /// <summary>詰めたぶんを読む側に渡す。待たない。溢れていれば、読む側が追いつくまで <see cref="Write"/> が捨てる</summary>
    public void Commit()
    {
        lock (_gate)
        {
            if (_closed || !_unflushed || Full()) return;
            _unflushed = false;
            var flushing = _writer.FlushAsync();
            if (flushing.IsCompleted)
            {
                Finished(flushing.GetAwaiter().GetResult());
                return;
            }
            _flushing = flushing;
            _waiting = true;
        }
    }

    /// <summary>
    /// 前の <see cref="Commit"/> の FlushAsync がまだ済んでいない (Pipe が溢れている) か。済んでいれば結果を受け取る。ロックの中で呼ぶ
    /// </summary>
    private bool Full()
    {
        if (!_waiting) return false;
        if (!_flushing.IsCompleted) return true;
        _waiting = false;
        Finished(_flushing.GetAwaiter().GetResult());
        return _closed;
    }

    /// <summary>FlushAsync の結果。読む側が閉じていれば、この出口を閉じる</summary>
    private void Finished(FlushResult result)
    {
        if (!result.IsCompleted) return;
        _closed = true;
        _writer.Complete();
    }

    /// <summary>止める。読む側は、残っているぶんを読み終えると尽きる。<paramref name="reason"/> があれば、読む側にその理由で終わったと伝える</summary>
    public void Complete(string? reason = null)
    {
        lock (_gate)
        {
            if (_closed) return;
            _reason = reason;
            _closed = true;
            if (_waiting) _writer.CancelPendingFlush();
            _writer.Complete();
        }
    }
}

/// <summary>
/// 受信機 1 つの TS の欠けを数える (<see cref="It930xTsOutput.WatchLoss"/>)。全体の溢れが立ったままの機材で、届いた TS が欠けていないかを確かめるため (<see cref="It930xTuner"/>)。
///
/// <para>
/// 連続性の飛びは <see cref="ContinuityTracker"/> で数える。**前に同じ PID を受けてから transport_error_indicator が 1 のパケットが来ていれば、その飛びは電波の誤りとして数えない**
/// (<see cref="Excused"/>)。電波の誤りのパケットは復調器が印を付けて出すので、印の無い飛びはブリッジから先でパケットが落ちたと読む (推定)。
/// 選局の直後の最初の 1 秒には、印の付いたパケットが 1 チャンネルあたり 18〜67 個あった (TC90522 の地上波。docs/agent.md) ので、それを欠けに数えないため。
/// </para>
/// <para>
/// 飛びは、最初のパケットからの <see cref="SlotMs"/> ごとの区間に分けて、飛んだ区間の数 (<see cref="Slots"/>) も数える。
/// ブリッジに残っていた前の選局のパケットと、この選局のパケットのつなぎ目では、同じ PID が 1 回飛ぶ。それは最初の区間に収まるので、区間で数えれば 1 つで済む。
/// 続けて欠けるときも、間を置いて何度も欠けるときも、区間の数が増える。
/// </para>
/// <para>
/// <see cref="Push"/> は <see cref="It930xTsDemux"/> の 1 つのスレッドから呼び、数はほかのスレッドから読む。
/// </para>
/// </summary>
internal sealed class It930xTsLoss
{
    /// <summary>飛びを数える区間の長さ (ms)。EP 0x84 の 1 回の転送 (65,424 バイト) が地上波 1 本 (約 17 Mbps) で埋まる約 31 ms の 3 倍ほど</summary>
    public const int SlotMs = 100;

    private readonly ContinuityTracker _tracker = new();

    /// <summary>PID ごとの、前にその PID を受けたときの transport_error_indicator が 1 のパケットの数</summary>
    private readonly long[] _errorsAt = new long[8192];

    private long _first = -1;
    private long _lastSlot = -1;
    private long _packets;
    private long _jumps;
    private long _excused;
    private long _slots;

    /// <summary>受けたパケットの数</summary>
    public long Packets => Volatile.Read(ref _packets);

    /// <summary>電波の誤りでは説明できない連続性の飛びの数 (PID ごとに数える)</summary>
    public long Jumps => Volatile.Read(ref _jumps);

    /// <summary>前に同じ PID を受けてから transport_error_indicator が 1 のパケットが来ていたので、数えなかった飛びの数</summary>
    public long Excused => Volatile.Read(ref _excused);

    /// <summary><see cref="Jumps"/> の飛びがあった <see cref="SlotMs"/> ごとの区間の数</summary>
    public long Slots => Volatile.Read(ref _slots);

    /// <summary>transport_error_indicator が 1 のパケットの数</summary>
    public long Errors => _tracker.Errors;

    /// <summary>最初のパケットを受けてからの時間 (ms)。まだ受けていなければ 0</summary>
    public long Span(long nowMs)
    {
        var first = Volatile.Read(ref _first);
        return first < 0 ? 0 : nowMs - first;
    }

    /// <param name="packet">188 バイトのパケット (先頭は 0x47 に戻したもの)</param>
    /// <param name="nowMs">今の時刻 (ms。<see cref="Environment.TickCount64"/>)</param>
    public void Push(ReadOnlySpan<byte> packet, long nowMs)
    {
        if (_first < 0) Volatile.Write(ref _first, nowMs);
        Volatile.Write(ref _packets, _packets + 1);
        var errors = _tracker.Errors;
        var pid = _tracker.Push(packet);
        if (packet.Length < 4 || packet[0] != 0x47 || (packet[1] & 0x80) != 0) return;
        var at = TsSync.Pid(packet);
        var before = _errorsAt[at];
        _errorsAt[at] = errors;
        if (pid < 0) return;
        if (errors > before)
        {
            Volatile.Write(ref _excused, _excused + 1);
            return;
        }
        Volatile.Write(ref _jumps, _jumps + 1);
        var slot = (nowMs - _first) / SlotMs;
        if (slot == _lastSlot) return;
        _lastSlot = slot;
        Volatile.Write(ref _slots, _slots + 1);
    }

    /// <summary>記録に添える 1 行の中身 (「1000 ms でパケット 5,000 個、…」)</summary>
    public string Describe(long spanMs) =>
        $"{spanMs} ms でパケット {Packets:N0} 個、連続性の飛び {Jumps} 回 ({SlotMs} ms ごとに区切って {Slots} 区間)、"
        + $"transport_error_indicator が 1 のパケット {Errors} 個 (そのあとの飛び {Excused} 回は数えない)";
}
