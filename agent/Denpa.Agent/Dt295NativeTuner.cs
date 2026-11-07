using System.Diagnostics;
using System.IO.Pipelines;

namespace Denpa.Agent;

/// <summary>
/// bulk IN から来たバイト列を 188 バイトのパケットにする。機材のプログラムは 188 バイトずつを隙間なく送るので、先頭の 0x47 から切るだけ。
/// 先頭が 0x47 でなければ 1 バイト捨てる (捨てた数は <see cref="Discarded"/>)
/// </summary>
internal sealed class NativeTsFramer
{
    private byte[] _store = new byte[8192 * 8];
    private int _used;

    public long Discarded { get; private set; }

    /// <summary>
    /// <see cref="Push"/> と同じく 188 バイトのパケットを取り出すが、同期バイトが続く範囲を 1 回でまとめて渡す (パケットごとの呼び出しとコピーを省く)。
    /// 前の呼び出しの残りが無ければ、<paramref name="data"/> を直接見て、足りない端数だけ持ち越す
    /// </summary>
    public void PushRuns(ReadOnlySpan<byte> data, Action<ReadOnlySpan<byte>> sink)
    {
        if (_used > 0)
        {
            Push(data, packet => sink(packet));
            return;
        }
        var at = 0;
        while (data.Length - at >= 188)
        {
            if (data[at] != 0x47)
            {
                at++;
                Discarded++;
                continue;
            }
            var start = at;
            while (data.Length - at >= 188 && data[at] == 0x47) at += 188;
            sink(data[start..at]);
        }
        var rest = data[at..];
        if (rest.Length > _store.Length) Array.Resize(ref _store, rest.Length);
        rest.CopyTo(_store);
        _used = rest.Length;
    }

    public void Push(ReadOnlySpan<byte> data, Action<ReadOnlySpan<byte>> sink)
    {
        if (_used + data.Length > _store.Length) Array.Resize(ref _store, Math.Max(_store.Length * 2, _used + data.Length));
        data.CopyTo(_store.AsSpan(_used));
        _used += data.Length;
        var at = 0;
        while (_used - at >= 188)
        {
            if (_store[at] != 0x47)
            {
                at++;
                Discarded++;
                continue;
            }
            sink(_store.AsSpan(at, 188));
            at += 188;
        }
        _store.AsSpan(at, _used - at).CopyTo(_store);
        _used -= at;
    }
}

/// <summary>
/// TS を 1 回流すぶん。取り込みを設定して始め (<see cref="Dt295NativeBoard"/>)、EP 0x81 の読みを出しっぱなしにして 188 バイトのパケットを取り出し、
/// <see cref="Pipe"/> に詰める。流している間は、別のスレッドで機材のプログラムに要求を送り続ける (1 回の要求で <see cref="KickPackets"/> 個のパケットを bulk IN へ送らせる)。
/// 要求を送っている間は制御転送が機材の中の処理の終わりまで返らない。通常の要求は <see cref="KickPackets"/> 個 (256 KiB。30 Mbps で約 70 ms) で、
/// 実機の試験では 30 Mbps を欠けなく送れ、ホストの CPU 時間も少なかった (32 個にすると CS22 の 6 秒で 313 ms から 797 ms に増えた)。
/// 同じ機材のカードが読み書きしている間 (<see cref="Dt295NativeLink.CardBusy"/>) だけ、UART の受信 FIFO (32 バイト) が溢れないよう、要求を <see cref="CardKickPackets"/> 個 (16 KiB。30 Mbps で約 4 ms) にする (仕様書に無い)
/// </summary>
internal sealed class Dt295NativeStream
{
    private const byte Endpoint = 0x81;

    /// <summary>1 本の読みの大きさと数 (8 KiB を 64 本)。以前の方式 (mAgicVISION のファームウェアを入れる方式) のときに実機で測って決めた値</summary>
    private const int TransferSize = 8192;

    private const int Depth = 64;

    private const int ReadTimeoutMs = 100;

    /// <summary>1 回の要求で送らせるパケット数 (512 バイトずつ)。カードが使っていないとき</summary>
    internal const uint KickPackets = 512;

    /// <summary>カードが読み書きしている間の 1 回の要求のパケット数</summary>
    internal const uint CardKickPackets = 32;

    private const int PumpTimeoutMs = 10_000;

    private readonly Pipe _pipe = Px4Stream.NewBuffer();
    private readonly Dt295NativeDevice _device;
    private readonly IUsbInStream _in;
    private readonly Action _stalled;
    private readonly string _name;
    private readonly Thread _reader;
    private readonly Thread _kicker;
    private readonly ManualResetEventSlim _first = new();
    private Dt295NativeBoard.CaptureSaved? _capture;
    private Dt295NativeBoard.EndpointSaved? _endpoint;
    private bool _capturing;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    public DeviceStream Output { get; }

    public bool Ended => _ended;

    public string? Reason => _reason;

    /// <summary>最初の TS を詰めた時刻 (Stopwatch)。まだなら 0</summary>
    public long FirstAt { get; private set; }

    private Dt295NativeStream(Dt295NativeDevice device, IUsbInStream input, string name, Action stalled)
    {
        _device = device;
        _in = input;
        _name = name;
        _stalled = stalled;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        // Linux のスレッド名は 15 文字まで。CPU 時間をスレッドごとに見分けるため、機材の名前は付けない (--dt295-probe)
        _reader = new Thread(Read) { IsBackground = true, Name = "dt295-ts" };
        _kicker = new Thread(Kick) { IsBackground = true, Name = "dt295-kick" };
    }

    /// <summary>
    /// 取り込みの設定と端点の開始までを済ませ、読み出し側を開く。**取り込みはまだ始めない** (TS は出ない)。選局のあとの受信の確認の間に呼んで、
    /// 受信を確認できたらすぐ <see cref="Begin"/> できるようにする。受信が確認できなければ <see cref="Abort"/>
    /// </summary>
    public static Dt295NativeStream Prepare(Dt295NativeDevice device, string name, Action stalled)
    {
        var stream = new Dt295NativeStream(device, device.Usb.OpenInStream(Endpoint, TransferSize, Depth), name, stalled);
        try
        {
            stream.ArmCapture();
        }
        catch
        {
            stream.Abort();
            throw;
        }
        return stream;
    }

    /// <summary>機材のプログラムの状態を戻し、取り込みを始めて、読みと要求を動かす。TS はここから出る (<see cref="Prepare"/> のあと、受信を確認してから)</summary>
    public void Begin()
    {
        try
        {
            _device.Board.ResetPumpState();
            using (_device.Timeline.Step("取り込みの開始", "0x1902010 = 0x02000000")) _device.Board.StartCapture();
            _capturing = true;
        }
        catch
        {
            Abort();
            throw;
        }
        _reader.Start();
        _kicker.Start();
    }

    /// <summary><see cref="Begin"/> の前に取りやめる。設定を戻して、読み出し側を閉じる</summary>
    public void Abort()
    {
        EndCapture();
        _in.Dispose();
        Output.Dispose();
    }

    private void ArmCapture()
    {
        var board = _device.Board;
        var timeline = _device.Timeline;
        using (timeline.Step("取り込みの設定", "仕様書 8.1.3。28 項目を書いて読み戻す")) _capture = board.ConfigureCapture();
        using (timeline.Step("端点の開始", "仕様書 8.3.1")) _endpoint = board.StartEndpoint();
    }
    /// <summary>取り込みを止めて、端点と取り込みの設定を戻す。USB の制御が止まっていれば省く</summary>
    private void EndCapture()
    {
        var board = _device.Board;
        if (_device.Link.Dead) return;
        try
        {
            if (_capturing) board.StopCapture();
            if (_endpoint is not null) board.StopEndpoint(_endpoint);
            if (_capture is not null) board.RestoreCapture(_capture);
        }
        catch (Exception error) when (error is IOException or TimeoutException)
        {
            Log.Write($"[{_name}] 取り込みを止められませんでした ({error.Message})");
        }
        _capturing = false;
        _endpoint = null;
        _capture = null;
    }

    /// <summary>最初の TS を待つ。来なければ false</summary>
    public bool WaitFirst(TimeSpan timeout) => _first.Wait(timeout) || FirstAt != 0;

    private void Read()
    {
        var raw = new byte[TransferSize * Depth];
        var framer = new NativeTsFramer();
        var settle = new Settled();
        var writer = _pipe.Writer;
        try
        {
            while (!_stopped)
            {
                var got = _in.Read(raw, ReadTimeoutMs);
                if (got == 0) continue;
                var wrote = false;
                if (settle.IsOpen)
                {
                    // 通すだけの間は、同期が続く範囲ごとにまとめて詰める (パケットごとのコピーと呼び出しを省く)
                    framer.PushRuns(raw.AsSpan(0, got), run =>
                    {
                        run.CopyTo(writer.GetSpan(run.Length));
                        writer.Advance(run.Length);
                        wrote = true;
                    });
                }
                else
                {
                    framer.Push(raw.AsSpan(0, got), packet =>
                    {
                        if (!settle.Accept(packet)) return;
                        packet.CopyTo(writer.GetSpan(packet.Length));
                        writer.Advance(packet.Length);
                        wrote = true;
                    });
                }
                if (!wrote) continue;
                if (FirstAt == 0)
                {
                    FirstAt = Stopwatch.GetTimestamp();
                    _first.Set();
                }
                if (!Flush(writer)) return;
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            if (error is UsbGoneException) _device.Fail(error);
            End(error is UsbGoneException ? $"{error.Message}。挿し直してください" : $"TS を読めません ({error.Message})");
        }
        finally
        {
            _ended = true;
            writer.Complete();
        }
    }

    /// <summary>
    /// 地上波は復調のロックの印が立った時点で取り込みを始めるため、TMCC が確定するまで (ロックの約 400 ms 後まで) 復調が TEI 付きのパケットを出す。
    /// TEI の付かないパケットが <see cref="CleanRun"/> 個続くまでを捨て、続いたら以降は TEI の有無にかかわらず通す。
    /// TEI が <see cref="Give"/> を過ぎても続くときは、受信が悪いだけなので捨てるのをやめて全部通す
    /// </summary>
    internal sealed class Settled
    {
        public const int CleanRun = 8;
        public static readonly long Give = Stopwatch.Frequency * 2;

        private readonly long _since = Stopwatch.GetTimestamp();
        private int _clean;
        private bool _open;

        public bool IsOpen => _open;

        public bool Accept(ReadOnlySpan<byte> packet)
        {
            if (_open) return true;
            if ((packet[1] & 0x80) == 0)
            {
                if (++_clean >= CleanRun) _open = true;
            }
            else
            {
                _clean = 0;
            }
            if (!_open && Stopwatch.GetTimestamp() - _since > Give) _open = true;
            return _open;
        }
    }

    private void Kick()
    {
        try
        {
            while (!_stopped && !_ended)
            {
                var reply = _device.Link.Pump(_device.Link.CardBusy ? CardKickPackets : KickPackets, _device.IdlePolls, PumpTimeoutMs);
                if (reply.Result == Dt295NativePrograms.ResultBadWrite)
                {
                    End($"リングの書き込み位置 0x{reply.WritePosition:X} が長さ以上です (取り込みの異常)");
                    _ended = true;
                    Output.Stop();
                    return;
                }
                if (reply.Result == Dt295NativePrograms.ResultIdle) Thread.Sleep(1);
            }
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
        {
            if (error is UsbGoneException) _device.Fail(error);
            End($"受信を続けられません ({error.Message})");
            _ended = true;
            Output.Stop();
        }
    }

    /// <summary>書いたぶんを渡す。溜めが空かないまま <see cref="Zd1jTuner.StallLimit"/> 経ったら、読む側がいないとみて終わる</summary>
    private bool Flush(PipeWriter writer)
    {
        var flushing = writer.FlushAsync();
        if (!flushing.IsCompleted)
        {
            var waiting = flushing.AsTask();
            var stalled = Stopwatch.StartNew();
            while (!waiting.Wait(50))
            {
                if (_stopped)
                {
                    writer.CancelPendingFlush();
                    return false;
                }
                if (stalled.Elapsed >= Zd1jTuner.StallLimit)
                {
                    writer.CancelPendingFlush();
                    _ended = true;
                    _stalled();
                    return false;
                }
            }
            return !waiting.Result.IsCompleted;
        }
        return !flushing.Result.IsCompleted;
    }

    private void End(string reason)
    {
        if (_stopped) return;
        _reason ??= reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>止める。要求と読みを止め、取り込みを止めて設定を戻し、読みかけの読む側が戻ってから溜めを閉じる</summary>
    public void Stop()
    {
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        if (_kicker.IsAlive) _kicker.Join(TimeSpan.FromSeconds(3));
        _reader.Join(TimeSpan.FromSeconds(2));
        EndCapture();
        _in.Dispose();
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}

/// <summary>
/// PIX-DT295 のチューナー (地上波・BS・CS。復調は地上波と衛星の 2 つだが、TS を出すのは 1 つずつ)。
/// 機材は復号しないので、TS はスクランブルのまま出す (B25 はエージェントが復号する)。機材は選局している間だけ取る
/// </summary>
public sealed class Dt295NativeTuner : ITuneDevice
{
    /// <summary>受信の確認を待つ上限。地上波は約 0.4 秒、衛星は約 0.1 秒でロックした (実機)</summary>
    internal static readonly TimeSpan LockWait = TimeSpan.FromSeconds(10);

    /// <summary>ロックから最初の TS を待つ上限。取り込みを始めて約 3 ms で出た (実機)</summary>
    internal static readonly TimeSpan FirstTs = TimeSpan.FromSeconds(5);

    private readonly string _name;
    private readonly Func<Dt295NativeDevice> _acquire;
    private readonly Action? _closeIdle;
    private readonly Lock _gate = new();
    private Dt295NativeDevice? _device;
    private Dt295NativeStream? _stream;
    private bool _satellite;

    /// <summary>最後に合わせて受信を確認したもの (どの機材で、どのチャンネルか)。選局が途中で失敗したら null</summary>
    private (Dt295NativeDevice Device, ChannelTable.Tuning Tuning, uint StreamId)? _last;

    /// <summary>同じチャンネルのまま受信が続いているかを確かめる時間の上限 (1 回の読みで済む。地上波は 1 周、衛星は数周)</summary>
    internal static readonly TimeSpan StillLockedWait = TimeSpan.FromMilliseconds(30);

    /// <summary>設定の device (画面に出す理由の持ち主のキー)</summary>
    private readonly string _key;

    public Dt295NativeTuner(string port)
        : this($"{Dt295.Model} {port}", () => Dt295NativeDevice.Acquire(port), () => Dt295NativeDevice.CloseIfIdle(port), Dt295.Device(port))
    {
    }

    internal Dt295NativeTuner(string name, Func<Dt295NativeDevice> acquire, Action? closeIdle = null, string? key = null)
    {
        _name = name;
        _acquire = acquire;
        _closeIdle = closeIdle;
        _key = key ?? name;
    }

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false };
        }
    }

    internal Dt295NativeDevice? Device => _device;

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            Stop(release: false);
            try
            {
                _device ??= _acquire();
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or TimeoutException)
            {
                // 開けない、設定を書けない。空いているときも画面に出す
                Px4Userland.SetNotice(_key, this, error.Message);
                throw new IOException(error.Message, error);
            }
            Px4Userland.ClearNotice(_key, this);
            var device = _device;
            var timeline = device.Timeline;
            // 同じ機材のカードの準備を、選局と並べて始める (復号は TS が届いてからすぐ始められる)
            device.WarmCard();
            using var whole = timeline.Step("選局から最初の TS まで");
            Dt295NativeStream? prepared = null;
            var before = _last;
            _last = null;
            try
            {
                var frontend = device.Frontend;
                _satellite = tuning.Satellite;
                var tsid = streamId == ChannelTable.NoStreamId ? null : (int?)streamId;
                // 同じ機材が同じチャンネルに合ったまま (機材は開いたまま) なら、選局を省いて、受信が続いているかだけ確かめる
                var reuse = false;
                if (before is { } was && ReferenceEquals(was.Device, device) && was.Tuning == tuning && was.StreamId == streamId)
                {
                    using (timeline.Step("同じチャンネル: 受信が続いているかを確かめる", "選局を省く"))
                    {
                        reuse = tuning.Satellite
                            ? frontend.WaitSatelliteLock(StillLockedWait, tsid)
                            : frontend.WaitTerrestrialLock(StillLockedWait, layers: 0);
                    }
                }
                if (reuse)
                {
                    prepared = Dt295NativeStream.Prepare(device, _name, () => Task.Run(Stall));
                }
                else
                {
                    if (tuning.Satellite)
                    {
                        using (timeline.Step("選局 (衛星の周波数の設定)", "仕様書 7.3.2")) frontend.TuneSatellite(tuning.Frequency);
                    }
                    else
                    {
                        using (timeline.Step("選局 (地上波の周波数の設定)", "仕様書 7.2.2")) frontend.TuneTerrestrial((uint)((tuning.Frequency + 500UL) / 1000));
                    }
                    // 取り込みの設定は、受信の確認を待つ間に済ませておく (取り込みを始めるのは受信を確認してから。TS は出ない)
                    prepared = Dt295NativeStream.Prepare(device, _name, () => Task.Run(Stall));
                    // 地上波は復調のロックの印だけで取り込みを始める。TMCC が確定するまでの TEI 付きのパケットは、読み取り側が捨てる (Dt295NativeStream.Settled)
                    var locked = tuning.Satellite ? frontend.WaitSatelliteLock(LockWait, tsid) : frontend.WaitTerrestrialLock(LockWait, layers: 0);
                    if (!locked) throw new IOException(ITuneDevice.SyncFailed);
                }
                prepared.Begin();
                _stream = prepared;
                prepared = null;
                _last = (device, tuning, streamId);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
            {
                prepared?.Abort();
                if (error is UsbGoneException) device.Fail(error);
                Stop(release: device.Faulted);
                if (error is IOException) throw;
                throw new IOException(error.Message, error);
            }
            bool arrived;
            using (timeline.Step("最初の TS を待つ", "取り込みを始めてから、読み取り側が最初のパケットを詰めるまで")) arrived = _stream.WaitFirst(FirstTs);
            if (!arrived)
            {
                var reason = _stream.Reason ?? $"選局から {FirstTs.TotalSeconds:0} 秒、TS が来ません";
                Stop(release: false);
                throw new IOException(reason);
            }
        }
    }

    /// <summary>
    /// いま受けているチャンネルの受信の状態と C/N の生の値 (<see cref="Dt295NativeFrontend.Signal"/>。dB には直していない)。
    /// 受けていなければ null。I2C を読むだけで、受信中の TS には影響しない
    /// </summary>
    public Dt295Signal? Signal()
    {
        lock (_gate) return _stream is { Ended: false } && _device is { } device ? device.Frontend.Signal(_satellite) : null;
    }

    TunerSignal? ITuneDevice.Signal() => Signal() is { } signal ? TunerSignal.From(signal) : null;

    /// <summary>いま受けている側の復調のレジスタ 0x00〜0xFF の読み値 (診断用)。受けていなければ null</summary>
    public byte[]? DumpDemod()
    {
        lock (_gate) return _stream is { Ended: false } && _device is { } device ? device.Frontend.DumpDemod(_satellite) : null;
    }

    private void Stall()
    {
        lock (_gate)
        {
            if (_stream is { Ended: true }) Stop(release: true);
        }
    }

    /// <summary>流すのをやめる (取り込みを止める)。<paramref name="release"/> なら機材も返す</summary>
    private void Stop(bool release)
    {
        var stream = _stream;
        _stream = null;
        stream?.Stop();
        var device = _device;
        if (!release || device is null) return;
        _device = null;
        device.Release();
    }

    /// <summary>捨てる (定義が変わった・止める)。機材はカードが使っていなければ閉じる</summary>
    public void Dispose()
    {
        lock (_gate) Stop(release: true);
        _closeIdle?.Invoke();
    }
}
