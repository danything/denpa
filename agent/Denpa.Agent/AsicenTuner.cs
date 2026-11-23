using System.Diagnostics;
using System.IO.Pipelines;

namespace Denpa.Agent;

/// <summary>
/// asicen-userland の受信機 1 つ (子プロセスの denpa-asicen。<see cref="AsicenChild"/>)。**試験的。実機では確かめていない。**
///
/// <para>
/// 選局のたびに、受信機を取り・選局して同期を待ち・TS を流し始める (子プロセスへの <c>tune</c> の命令 1 つで)。
/// 局を替えるときは、流れを止めて受信機を返してから取り直す (<c>denpa_asicen_stop</c>)。
/// </para>
///
/// <para>
/// LNB の給電は、選局の要求に 15 V を載せる。載せるのは設定に 15V と書いてあり、上流が給電に対応としている機種
/// (PX-W3U2・PX-W3U3・PX-W3U3 V2) の衛星の選局のときだけ。受信機ごとの要求は子プロセスの中のエンジンが数え、最後の受信機が返したら切る。
/// </para>
/// </summary>
/// <param name="name">設定のチューナーの名前。無ければ機種名の代わりに「ASICEN の機材」と付ける (機種は開くまで分からない)</param>
internal sealed class AsicenTuner(AsicenEnclosure enclosure, int receiver, string? lnb, string? name = null) : ITuneDevice
{
    /// <summary>同期を待つ上限。ほかのチューナーと同じ 5 秒</summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(5);

    /// <summary>同期のあと最初の TS が来るまでの猶予</summary>
    private static readonly TimeSpan FirstTsGrace = TimeSpan.FromSeconds(3);

    private readonly string _name = name ?? AsicenUserland.Name("ASICEN の機材", enclosure.Id, receiver);
    private readonly string _device = AsicenUserland.Device(enclosure.Id, receiver);
    private readonly Lock _gate = new();
    private AsicenStream? _stream;
    private bool _lnbWarned;

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false };
        }
    }

    /// <summary>同期しているかだけ。**C/N は取れない** (子プロセスが出さない)</summary>
    public TunerSignal? Signal() =>
        Volatile.Read(ref _stream) is { Ended: false } ? new TunerSignal(true, null, TunerSignal.Db, AtTune: true) : null;

    /// <summary>子プロセスに渡す周波数 (Hz)。選局表は地上波が Hz、衛星が中間周波数の kHz なので、衛星は 1000 倍する</summary>
    internal static ulong FrequencyHz(ChannelTable.Tuning tuning) => tuning.Satellite ? (ulong)tuning.Frequency * 1000 : tuning.Frequency;

    /// <summary>衛星の選び方。名前に TSID があれば TSID で、無ければ (NIT を読むための選局と CS) スロット 0 で選ぶ。地上波はどちらも使わない (0xffff)</summary>
    internal static (ushort Tsid, ushort Slot) Selection(ChannelTable.Tuning tuning) =>
        !tuning.Satellite ? ((ushort)0xffff, (ushort)0xffff)
        : tuning.StreamId != ChannelTable.NoStreamId ? ((ushort)tuning.StreamId, (ushort)0xffff)
        : ((ushort)0xffff, (ushort)0);

    public void Tune(ChannelTable.Tuning tuning)
    {
        lock (_gate)
        {
            Finish();
            AsicenChannel stream;
            try
            {
                stream = enclosure.Use((child, listed) =>
                {
                    AsicenReceiver.Check(listed.Receivers, receiver, tuning);
                    var (tsid, slot) = Selection(tuning);
                    return child.Tune(
                        receiver, tuning.Satellite ? AsicenChild.IsdbS : AsicenChild.IsdbT, FrequencyHz(tuning),
                        tsid, slot, Voltage(listed, tuning), (uint)TuneTimeout.TotalMilliseconds);
                });
            }
            catch (AsicenError error)
            {
                if (error.Lost) enclosure.MarkLost();
                throw new IOException(Reason(error), error);
            }
            _stream = AsicenStream.Start(stream, _name, enclosure.MarkLost, FirstTsGrace);
            Log.Write($"[{_name}] 受信機を取って選局しました");
        }
    }

    /// <summary>選局の失敗をこちらの言い方に</summary>
    private string Reason(AsicenError error) => error.Code switch
    {
        AsicenChild.Timeout => ITuneDevice.SyncFailed,
        AsicenChild.ChildExited => $"denpa-asicen が終了しました。次の選局で起動し直します ({error.Message})",
        AsicenChild.Busy => $"受信機 {receiver} はほかの選局が使っています (BUSY)",
        AsicenChild.Unsupported or AsicenChild.InvalidArgument => $"受信機 {receiver} ではこの選局を受けられません ({error.Message})",
        _ => $"選局できません ({error.Message})",
    };

    /// <summary>
    /// LNB の電圧 (0 か 15)。**設定に 15V と書いてあり、給電を操作できる筐体の衛星の選局のときだけ 15。**
    /// 操作できない機種 (PX-S3U・PX-S3U2) は給電せずに選局し、その理由を記録と画面に出す
    /// </summary>
    private byte Voltage(AsicenUserland.Listed listed, ChannelTable.Tuning tuning)
    {
        if (lnb != "15v" || !tuning.Satellite) return 0;
        if (listed.Lnb) return 15;
        var notice = $"{listed.Model} は LNB の給電を操作できないので、給電せずに選局しています (設定の LNB 15V は効きません。アンテナへの給電はほかの機器から)";
        TunerNotice.Set(_device, this, notice);
        if (!_lnbWarned) Log.Write($"[{_name}] {notice}");
        _lnbWarned = true;
        return 0;
    }

    /// <summary>流していれば止めて、受信機を返す</summary>
    private void Finish()
    {
        var stream = _stream;
        _stream = null;
        stream?.Stop();
    }

    public void Dispose()
    {
        lock (_gate) Finish();
        TunerNotice.Clear(_device, this);
    }
}

/// <summary>
/// 子プロセスから TS を受け取る 1 回ぶん (選局 1 回につき 1 つ)。
///
/// <para>
/// 読み取りのスレッドが子プロセスから届いた TS (<see cref="AsicenChannel"/>) を読み (待つのは 200 ms ずつ)、<see cref="Pipe"/> に詰める (CECH-ZD1 J の <c>Zd1jStream</c> と同じく Pipelines)。
/// 止めるときは子プロセスに <c>stop</c> を送り、受信機を返し終えるのを待つ。
/// </para>
/// </summary>
internal sealed class AsicenStream
{
    /// <summary>TS がこれだけ来なければ終わる</summary>
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(5);

    /// <summary>1 回に読む上限 (188 の倍数)</summary>
    private const int Chunk = 188 * 1024;

    private readonly AsicenChannel _stream;
    private readonly string _name;
    private readonly Action _lost;
    private readonly ManualResetEventSlim _first = new();
    private readonly Pipe _pipe = TsBuffer.New();
    private readonly Thread _pump;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;
    private volatile bool _delivered;
    private int _released;

    public DeviceStream Output { get; }

    public bool Ended => _ended;

    private AsicenStream(AsicenChannel stream, string name, Action lost)
    {
        _stream = stream;
        _name = name;
        _lost = lost;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        _pump = new Thread(Pump) { IsBackground = true, Name = $"{name} TS" };
    }

    /// <summary>読み始め、最初の TS が来るまで待つ。来なければ止めて IOException</summary>
    public static AsicenStream Start(AsicenChannel stream, string name, Action lost, TimeSpan firstTs)
    {
        var started = new AsicenStream(stream, name, lost);
        started._pump.Start();
        if (!started._first.Wait(firstTs))
        {
            started.Stop();
            throw new IOException($"同期したのに TS が {firstTs.TotalSeconds:F0} 秒来ません");
        }
        if (!started._delivered)
        {
            var reason = started._reason ?? "TS が止まりました";
            started.Stop();
            throw new IOException(reason);
        }
        return started;
    }

    private void Pump()
    {
        var writer = _pipe.Writer;
        try
        {
            var heard = Stopwatch.StartNew();
            while (!_stopped)
            {
                var (length, ended, terminal) = _stream.Read(writer.GetSpan(Chunk)[..Chunk], 200);
                if (length > 0)
                {
                    writer.Advance(length);
                    if (!Flush(writer)) return;
                    _delivered = true;
                    _first.Set();
                    heard.Restart();
                }
                if (ended)
                {
                    // 抜けた・USB の読み書きに失敗した・子プロセスが終わった筐体は、次に要ったときに開き直す
                    if (terminal is 2 or 6 or AsicenChild.ChildExited) _lost();
                    End($"TS が止まりました ({AsicenChild.Terminal(terminal)})");
                    return;
                }
                if (length == 0 && heard.Elapsed >= SilenceLimit)
                {
                    End($"TS が {SilenceLimit.TotalSeconds:F0} 秒来ません");
                    return;
                }
            }
        }
        catch (IOException error)
        {
            End(error.Message);
        }
        finally
        {
            _ended = true;
            writer.Complete();
            _first.Set();
        }
    }

    /// <summary>読み出し側がいないまま <see cref="TsBuffer.StallLimit"/> 経ったら、TS のストリームを閉じる (USB を直に持つ機材から受ける TS と同じ上限)</summary>
    private bool Flush(PipeWriter writer) => TsBuffer.Flush(writer, () => _stopped, TsBuffer.StallLimit,
        () => End($"読み出し側がいないまま {TsBuffer.StallLimit.TotalSeconds:F0} 秒経ったので TS のストリームを閉じました"),
        () => End("TS を渡せません (読み出し側が閉じました)"));

    private void End(string reason)
    {
        if (_stopped) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>止めて、受信機を返す。読み取りのスレッドが抜けるのを待ってから、子プロセスに止める命令を送る</summary>
    public void Stop()
    {
        _stopped = true;
        ChildTs.Close(Output, () =>
        {
            // 読みの待ちは 200 ms ずつなので、すぐに抜ける
            if (!_pump.Join(TimeSpan.FromSeconds(5))) Log.Write($"[{_name}] TS の読み取りが 5 秒で止まりません");
            if (Interlocked.Exchange(ref _released, 1) == 0) _stream.Stop();
            _first.Dispose();
        });
        _ended = true;
    }
}
