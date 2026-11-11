using System.Diagnostics;

namespace Denpa.Agent;

/*
 * Siano RIO 系の ISDB-T 用 USB チューナー (PLEX PX-S1UD など) 1 台を、USB を直に持って動かす。
 *
 * クリーンルームで、仕様書 (denpa-spec の siano/spec.md) だけから書いた。Linux カーネルの Siano のドライバ (smsusb・smscoreapi・smsdvb など) と
 * siano-userland のコードは読んでいない。コメントの「仕様書 x.y」は仕様書の節の番号。仕様書に無くて決めた所は「仕様書に無い」と書いてある。
 * 実機では確かめていない。仕様書が未確認としている値 (端点の一覧・バージョンの応答・統計の応答・TS のメッセージの長さ) は、初めて届いたときに記録に出す。
 */

/// <summary>待ちと時間切れ (仕様書 11)。テストは短い値に差し替える</summary>
/// <param name="SendMs">バルク OUT の送信の時間切れ</param>
/// <param name="ResponseMs">起動のメッセージと選局の応答を待つ上限 (選局の応答は、資料の 2 秒と 10 秒のうち長いほう。仕様書 12.3)</param>
/// <param name="RunSettleMs">実行の合図のあと、機材がファームウェアを動かし始めるのを待つ時間</param>
/// <param name="LockMs">選局の応答が届いてから、ロックを待つ期限</param>
/// <param name="StatsEveryMs">ロックを待つ間に統計の要求を送る間隔 (これより詰めない)</param>
/// <param name="StatsResponseMs">受信中に統計の応答を待つ上限</param>
/// <param name="ReadMs">IN の読みを 1 回待つ時間 (読みは出したままで、止める合図を確かめる間隔)</param>
internal sealed record SianoTimings(
    int SendMs = 1_000, int ResponseMs = 10_000, int RunSettleMs = 400, int LockMs = 10_000,
    int StatsEveryMs = 100, int StatsResponseMs = 2_000, int ReadMs = 200);

/// <summary>機材が応答しなかった。機材の状態が分からないので、呼ぶ側は閉じて、次に使うときにバージョンの問い合わせからやり直す</summary>
internal sealed class SianoSilentException(string message) : IOException(message);

/// <summary>
/// 開いた機材 1 台。開く (仕様書 2.2)・状態を見分けてファームウェアを送りモードを設定する (仕様書 4)・選局してロックを待つ (仕様書 5)・
/// TS を受ける (仕様書 6)・統計を読む (仕様書 7)・閉じる (仕様書 8)。
///
/// <para>
/// 制御の応答・通知・TS は同じ IN の端点に届く (仕様書 2.3)。読みを出したままにして専用のスレッドで受け、番号で振り分ける (仕様書 3.2)。
/// このスレッドは下流の詰まりで止めない (仕様書 6.3)。TS は <see cref="Attach"/> で渡された先へすぐ渡すだけで、渡す先が無い間は捨てる。
/// 要求は 1 つずつ送り、応答は番号だけで対応を取る (仕様書 2.4・3.4)。送る直前にその番号を受けた数を 0 に戻してから待つ
/// </para>
/// </summary>
internal sealed class SianoDevice : IDisposable
{
    /// <summary>ホストから機材へのバルク OUT。ディスクリプタに何と書いてあってもこの端点に送る (仕様書 2.1)</summary>
    public const byte OutEndpoint = 0x02;

    /// <summary>1 回の読みに渡すバッファの大きさ (仕様書 2.3。資料の 8,192 と 16,384 のうち、PX-S1UD で使われているほう)</summary>
    public const int TransferSize = 16_384;

    /// <summary>
    /// 出したままにする読みの数 (仕様書 2.3 の「32 個以上」)。macOS は、32 個で TS の連続性の欠けが出て 128 個で出なくなったという記録に合わせる
    /// </summary>
    public static int Depth => OperatingSystem.IsMacOS() ? 128 : 32;

    /// <summary>全部の PID を流す指定 (仕様書 6.2)</summary>
    private const uint AllPids = 0x2000;

    /// <summary>帯域の区分: ISDB-T の 13 セグメント (仕様書 5.2)</summary>
    private const uint FullSeg = 8;

    /// <summary>選局のメッセージに入れる水晶の周波数 (Hz。仕様書 5.2)</summary>
    private const uint Crystal = 12_000_000;

    private readonly IUsbDevice _usb;
    private readonly string _name;
    private readonly Func<SianoFirmware> _firmware;
    private readonly SianoTimings _timings;
    private readonly Action<int> _sleep;
    private readonly Action<string> _log;

    /// <summary>未確認の値を記録に出すか (そのポートで初めて開いたときだけ)</summary>
    private readonly bool _describe;

    /// <summary>要求を 1 つずつにする (選局・統計の読み取り・閉じる)</summary>
    private readonly Lock _gate = new();

    /// <summary>読みのスレッドと要求を出す側で分け合う状態。Monitor.Wait で待つので object</summary>
    private readonly object _sync = new();
    private readonly Dictionary<ushort, int> _received = [];
    private readonly HashSet<ushort> _unknown = [];
    private byte[]? _versionPayload;
    private SianoStats? _stats;
    private bool _locked;
    private string? _fault;

    private IUsbInStream? _in;
    private Thread? _reader;
    private int _align;
    private volatile bool _closing;
    private SianoVersion? _version;
    private bool _pidAdded;
    private volatile Action<ReadOnlySpan<byte>>? _sink;
    private volatile Action<string>? _failed;
    private bool _statsDescribed;
    private bool _tsDescribed;
    private bool _splitDescribed;
    private int _broken;

    /// <summary>渡す先が無い間に捨てた TS のバイト数 (選局の前・ロック待ちの間・誰も読んでいない間。仕様書 6.3)</summary>
    public long DroppedTs => Interlocked.Read(ref _droppedTs);

    private long _droppedTs;

    /// <summary>読みが失敗した (機材が抜かれたなど)。閉じて開き直すまで使えない</summary>
    public bool Faulted
    {
        get
        {
            lock (_sync) return _fault is not null;
        }
    }

    /// <summary>最後に受けたバージョンの応答</summary>
    public SianoVersion? Version => _version;

    /// <param name="firmware">ファームウェアを読む。機材にファームウェアが入っていないときだけ呼ぶ</param>
    /// <param name="describe">未確認の値を記録に出す</param>
    public SianoDevice(IUsbDevice usb, string name, Func<SianoFirmware> firmware, SianoTimings? timings = null,
        Action<int>? sleep = null, Action<string>? log = null, bool describe = true)
    {
        _usb = usb;
        _name = name;
        _firmware = firmware;
        _timings = timings ?? new SianoTimings();
        _sleep = sleep ?? Thread.Sleep;
        _log = log ?? Log.Write;
        _describe = describe;
    }

    private void Note(string message) => _log($"[{_name}] {message}");

    /// <summary>
    /// 開いたあとの手順 (仕様書 2.2 の 2〜6): 端点を見つけ、ストールをクリアし、読みを出してから、起動する。
    /// 失敗したら投げる (呼ぶ側が <see cref="Dispose"/> する)
    /// </summary>
    public void Start()
    {
        var pipes = _usb.Pipes();
        if (_describe) Note($"端点: {(pipes.Count == 0 ? "無し" : UsbDevices.DescribePipes(pipes.Select(pipe => (pipe.Endpoint, pipe.Type, pipe.MaxPacket))))}");
        // IN の端点はディスクリプタから探す (仕様書 2.1)。バルクの IN が 2 つ以上あるときの選び方は仕様書に無いので、最初のものを使って記録に出す
        var inputs = pipes.Where(pipe => pipe.In && pipe.Bulk).ToList();
        if (inputs.Count == 0) throw new IOException("インターフェース 0 にバルク IN の端点がありません");
        if (inputs.Count > 1) Note($"バルク IN の端点が {inputs.Count} つあります。最初の EP 0x{inputs[0].Endpoint:X2} を使います");
        var input = inputs[0];
        _align = SianoMessage.Align(input.MaxPacket);
        if (!pipes.Any(pipe => pipe.Endpoint == OutEndpoint && pipe.Bulk))
        {
            Note($"ディスクリプタにバルク OUT の EP 0x{OutEndpoint:X2} がありません。EP 0x{OutEndpoint:X2} に送ります");
        }

        // ストールをクリアする要求は、失敗しても続ける (仕様書 2.2 の 4)
        foreach (var endpoint in new[] { input.Endpoint, OutEndpoint })
        {
            try
            {
                _usb.ClearHalt(endpoint);
            }
            catch (IOException error) when (error is not UsbGoneException)
            {
                if (_describe) Note($"EP 0x{endpoint:X2} のストールをクリアできませんでした ({error.Message})。続けます");
            }
        }

        // 応答は IN に届くので、最初の要求を送る前に読みを出しておく (仕様書 2.2 の 5)
        _in = _usb.OpenInStream(input.Endpoint, TransferSize, Depth);
        _reader = new Thread(Read) { IsBackground = true, Name = $"{_name} IN" };
        _reader.Start();
        lock (_gate) Boot();
    }

    // ---- 読み (仕様書 2.3・3) ----

    private void Read()
    {
        var buffer = new byte[TransferSize];
        try
        {
            while (!_closing)
            {
                var got = _in!.ReadTransfer(buffer, _timings.ReadMs);
                if (got > 0) Dispatch(buffer.AsSpan(0, got));
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            if (_closing) return;
            // 入出力の誤り・端点のストール・機材が無い、のどれも機材が使えなくなったものとして扱う (仕様書 10)
            var reason = error is UsbGoneException ? $"{error.Message}。挿し直してください" : $"機材から読めなくなりました ({error.Message})";
            lock (_sync)
            {
                _fault = reason;
                Monitor.PulseAll(_sync);
            }
            Note(reason);
            _failed?.Invoke(reason);
        }
    }

    /// <summary>1 回の転送を 1 つのメッセージとして読み、番号で振り分ける。表に無い番号は捨てる (仕様書 3.5)</summary>
    internal void Dispatch(ReadOnlySpan<byte> transfer)
    {
        if (!SianoMessage.TryParse(transfer, _align, out var number, out var flags, out var payload, out var why))
        {
            // 壊れたメッセージは捨てる (仕様書 3.1・3.3)。記録に出すのは初めの 3 回だけ
            if (++_broken <= 3) Note($"壊れたメッセージを捨てました: {why}");
            return;
        }
        if (_describe && !_splitDescribed && (flags & SianoMessage.SplitFlag) != 0)
        {
            _splitDescribed = true;
            Note($"中身が転送の途中から始まるメッセージが届きました (番号 {number}、フラグ 0x{flags:X4}、長さ {payload.Length + SianoMessage.HeaderSize}、転送 {transfer.Length} バイト)");
        }
        if (number == SianoMessage.Ts)
        {
            if (_describe && !_tsDescribed && payload.Length > 0)
            {
                _tsDescribed = true;
                Note($"TS のメッセージ: 中身 {payload.Length} バイト (188 で割った余り {payload.Length % 188})、先頭 0x{payload[0]:X2}、"
                    + $"送り手 {transfer[2]}、受け手 {transfer[3]}、フラグ 0x{flags:X4}、転送 {transfer.Length} バイト");
            }
            if (_sink is { } sink) sink(payload);
            else Interlocked.Add(ref _droppedTs, payload.Length);
            return;
        }
        lock (_sync)
        {
            switch (number)
            {
                case SianoMessage.StatsNewDone or SianoMessage.StatsOldDone:
                    if (_describe && !_statsDescribed)
                    {
                        _statsDescribed = true;
                        Note($"統計の応答 {number}: 中身 {payload.Length} バイト {Convert.ToHexString(payload[..Math.Min(payload.Length, 96)])}{(payload.Length > 96 ? "…" : "")}");
                    }
                    // 復調のロックの欄まで届いていない応答は、前の値を残して使わない
                    if (SianoStats.Parse(number, payload) is { } stats)
                    {
                        _stats = stats;
                        // ロック待ちの印は立てるだけ。消すのは通知 828 と、選局し直すとき (仕様書 5.3)
                        if (stats.Locked) _locked = true;
                    }
                    break;
                case SianoMessage.SignalFound:
                    _locked = true;
                    break;
                case SianoMessage.SignalLost:
                    _locked = false;
                    break;
                case SianoMessage.VersionDone:
                    _versionPayload = payload.ToArray();
                    break;
                case SianoMessage.DataWriteDone or SianoMessage.DataCheckDone or SianoMessage.RunDone or SianoMessage.ModeInitDone
                    or SianoMessage.TuneDone or SianoMessage.Resumed or SianoMessage.AddPidDone:
                    break;
                default:
                    if (_describe && _unknown.Count < 16 && _unknown.Add(number)) Note($"扱わないメッセージ {number} を捨てました (中身 {payload.Length} バイト)");
                    break;
            }
            _received[number] = _received.GetValueOrDefault(number) + 1;
            Monitor.PulseAll(_sync);
        }
    }

    // ---- 送る・応答を待つ (仕様書 2.4・3.4) ----

    private void Send(byte[] message) => _usb.BulkWrite(OutEndpoint, message, _timings.SendMs);

    /// <summary>
    /// <paramref name="done"/> が true を返すまで、長くても <paramref name="timeoutMs"/> 待つ (<see cref="_sync"/> を取った中で呼ばれる)。
    /// 読みが失敗していれば投げる
    /// </summary>
    private bool Wait(Func<bool> done, int timeoutMs)
    {
        var started = Stopwatch.GetTimestamp();
        lock (_sync)
        {
            for (; ; )
            {
                if (_fault is { } fault) throw new IOException(fault);
                if (_closing) throw new ObjectDisposedException(_name);
                if (done()) return true;
                var left = timeoutMs - (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                if (left <= 0) return false;
                Monitor.Wait(_sync, left);
            }
        }
    }

    /// <summary>要求を送って、その応答 (番号 + 1) を待つ。応答の中身は読まず、届いたことだけを成功とする (仕様書 3.4)。届かなければ投げる</summary>
    private void Request(byte[] message, string what)
    {
        var response = (ushort)(System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(message) + 1);
        // 前の要求の遅れた応答を、この要求の応答と取り違えないように、送る直前に数を戻す (仕様書 3.4)
        lock (_sync) _received[response] = 0;
        Send(message);
        if (!Wait(() => _received.GetValueOrDefault(response) > 0, _timings.ResponseMs))
        {
            throw new SianoSilentException($"{what}に機材が応答しません ({_timings.ResponseMs / 1000.0:0.#} 秒待ちました)");
        }
    }

    // ---- 起動 (仕様書 4) ----

    /// <summary>バージョンの問い合わせ (668 → 669。仕様書 4.1)。やり直しはしない (仕様書 12.3 の「どちらでもよい」のうち、PX-S1UD で使われているほう)</summary>
    private SianoVersion AskVersion(string when)
    {
        lock (_sync) _versionPayload = null;
        Request(SianoMessage.Build(SianoMessage.Version, SianoMessage.FromBoot), "バージョンの問い合わせ");
        byte[] payload;
        lock (_sync) payload = _versionPayload ?? [];
        if (_describe) Note($"バージョンの応答 ({when}): 中身 {payload.Length} バイト {Convert.ToHexString(payload)}");
        var version = SianoVersion.Parse(payload)
            ?? throw new IOException($"バージョンの応答が短く、機材の状態を見分けられません (中身 {payload.Length} バイト)");
        if (_describe) Note($"バージョン ({when}): {version.Describe()}");
        return _version = version;
    }

    /// <summary>状態を見分けて、要るときだけファームウェアを送り、モードを設定する (仕様書 4.1〜4.3・9 の 3〜5)</summary>
    private void Boot()
    {
        var version = AskVersion("開いたとき");
        // モードが既に 6 なら何も送らない。送り直すと、機材が次の要求に応答しなくなる (仕様書 4.1 の注意)
        if (version.Ready) return;
        if (version.Mode == SianoVersion.NoFirmware)
        {
            if (!version.SupportsIsdbt)
            {
                SendFirmware();
                version = AskVersion("ファームウェアを送ったあと");
            }
        }
        else if (!version.SupportsIsdbt)
        {
            // 動いているファームウェアを入れ替える手順 (仕様書 4.4) は、実機で通した記録が無いので実装していない
            throw new IOException($"機材で別のモード ({version.Mode}) のファームウェアが動いています。機材を抜いて挿し直してください");
        }
        // 仕様書 4.3 の表: モードが 6 でなく、バージョンの値が 0x0800 以上のときだけ、モードの初期化を 1 回送る
        if (!version.Ready && version.Value >= SianoVersion.NewFormatFrom)
        {
            Request(SianoMessage.Build(SianoMessage.ModeInit, SianoMessage.FromBoot, SianoVersion.Isdbt), "モードの初期化");
        }
    }

    /// <summary>ファームウェアを送る (仕様書 4.2 の手順 1〜3)。USB はつながったままで、同じ端点を使い続ける</summary>
    private void SendFirmware()
    {
        // ファイルが無い・形式が違うときは、ここで投げて機材には何も送らない (仕様書 10)
        var firmware = _firmware();
        var started = Stopwatch.StartNew();
        var sent = 0;
        try
        {
            foreach (var (address, chunk) in firmware.Chunks(firmware.Address))
            {
                Request(SianoMessage.BuildDataWrite(address, chunk.Span), $"ファームウェアの書き込み ({sent + 1}/{firmware.ChunkCount} 個目、アドレス 0x{address:X8})");
                sent++;
            }
            // 検査: アドレス・本体の長さ・0 (ふつうの検査)。応答の中身は読まない (検査に落ちたときの応答は仕様書でも未確認)
            Request(SianoMessage.Build(SianoMessage.DataCheck, SianoMessage.FromBoot, firmware.Address, firmware.Length, 0), "ファームウェアの検査");
            // 実行の合図: 実行を始めるアドレス・優先度 6・スタックの大きさ 0x200・引数 0・タスクの番号 4
            Request(SianoMessage.Build(SianoMessage.Run, SianoMessage.FromBoot, firmware.Address, 6, 0x200, 0, 4), "ファームウェアの実行の合図");
        }
        catch (SianoSilentException error)
        {
            // 途中まで書いた機材の状態は仕様書でも未確認。抜き差しでファームウェアの無い状態に戻ると推定されている (仕様書 10)
            throw new SianoSilentException($"{error.Message}。機材を抜いて挿し直してください");
        }
        _sleep(_timings.RunSettleMs);
        Note($"ファームウェアを送りました ({firmware.Data.Length} バイト、{firmware.ChunkCount} 個、{started.ElapsedMilliseconds} ms)");
    }

    // ---- 選局 (仕様書 5) ----

    /// <summary>
    /// 選局してロックを待つ (仕様書 5.3)。ロックしたら true、期限までにロックしなければ false (機材は開いたままで、次の選局を受け付ける)。
    /// 選局の応答が届かない・送れないときは投げる。呼ぶ前に <see cref="Detach"/> しておく (ロックを確かめるまでの TS は捨てる。仕様書 6.3)
    /// </summary>
    public bool Tune(uint frequencyHz)
    {
        if (frequencyHz == 0) throw new IOException("周波数が 0 です");
        lock (_gate)
        {
            lock (_sync) _locked = false;
            Request(SianoMessage.Build(SianoMessage.Tune, SianoMessage.FromTuner, frequencyHz, FullSeg, Crystal, 0), "選局");
            // 選局の応答より前に届いた統計と通知は、前の周波数のもの (遅れて届いた応答など)。その印は使わない
            lock (_sync) _locked = false;
            // 選局の応答は、要求を受け取ったという意味だけ。ここからロックを待つ
            var started = Stopwatch.GetTimestamp();
            var requests = 0;
            int before;
            lock (_sync) before = StatsReceived;
            for (; ; )
            {
                if (Locked()) break;
                if (Stopwatch.GetElapsedTime(started).TotalMilliseconds >= _timings.LockMs)
                {
                    int answered;
                    lock (_sync) answered = StatsReceived - before;
                    Note($"{frequencyHz} Hz でロックしませんでした (統計の要求 {requests} 回、応答 {answered} 回)");
                    return false;
                }
                // 統計の応答は待たない。読みのスレッドが受けて印を立てる
                Send(StatsRequest());
                requests++;
                // 間隔は詰めない。印が立ったら待ちを切り上げる
                Wait(() => _locked, _timings.StatsEveryMs);
            }
            // 全部の PID を流す指定は、開いてから最初にロックしたときに 1 回だけ送る。応答は待たない (仕様書 6.2)
            if (!_pidAdded)
            {
                Send(SianoMessage.Build(SianoMessage.AddPid, SianoMessage.FromTuner, AllPids));
                _pidAdded = true;
            }
            return true;
        }
    }

    private bool Locked()
    {
        lock (_sync) return _locked;
    }

    /// <summary>受けた統計の応答の数 (どちらの形式でも。<see cref="_sync"/> を取って読む)</summary>
    private int StatsReceived =>
        _received.GetValueOrDefault(SianoMessage.StatsNewDone) + _received.GetValueOrDefault(SianoMessage.StatsOldDone);

    /// <summary>統計の要求。バージョンの値が 0x0800 以上なら新しい形式、それより小さければ古い形式 (仕様書 7.1)。バージョンは最後に受けた応答のもの</summary>
    private byte[] StatsRequest() =>
        SianoMessage.Build(_version is { NewStats: false } ? SianoMessage.StatsOld : SianoMessage.StatsNew, SianoMessage.FromTuner);

    /// <summary>
    /// 統計を 1 回読む (仕様書 7)。応答はどちらの形式が届いても読む。<see cref="SianoTimings.StatsResponseMs"/> の間に届かなければ null。
    /// ロックしているかは、届いた値をそのまま使う (仕様書 12.3)
    /// </summary>
    public SianoStats? ReadStats()
    {
        lock (_gate)
        {
            lock (_sync) _stats = null;
            Send(StatsRequest());
            Wait(() => _stats is not null, _timings.StatsResponseMs);
            lock (_sync) return _stats;
        }
    }

    // ---- TS (仕様書 6) ----

    /// <summary>TS のメッセージの中身を渡す先を決める。<paramref name="sink"/> は読みのスレッドから呼ばれるので、待たずに戻ること</summary>
    /// <param name="failed">読みが失敗したとき (機材が抜かれたなど) に理由を渡す先</param>
    public void Attach(Action<ReadOnlySpan<byte>> sink, Action<string> failed)
    {
        _failed = failed;
        _sink = sink;
    }

    /// <summary>TS を渡すのをやめる (届いた TS は捨てる)。機材には何も送らない (仕様書 6.4)</summary>
    public void Detach()
    {
        _sink = null;
        _failed = null;
    }

    /// <summary>
    /// 閉じる (仕様書 8): 出してある読みを取り消して済むのを待ち、インターフェースを手放して、機材を閉じる。
    /// 機材に止めるメッセージは送らない。USB の電源が入っている間はファームウェアが残り、次に開いたときは送り直さない
    /// </summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _closing, true)) return;
        Detach();
        lock (_sync) Monitor.PulseAll(_sync);
        lock (_gate)
        {
            _reader?.Join(TimeSpan.FromSeconds(2));
            _in?.Dispose();
            _usb.Dispose();
        }
    }
}
