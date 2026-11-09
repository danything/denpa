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
    /// 前の呼び出しの残り (188 バイト未満) があれば、それを 1 パケットに埋めるぶんだけ <see cref="Push"/> で読み、続きは <paramref name="data"/> を直接見る。
    /// 足りない端数だけ持ち越す
    /// </summary>
    public void PushRuns(ReadOnlySpan<byte> data, Action<ReadOnlySpan<byte>> sink)
    {
        // 埋めるたびに 1 パケット渡すか、同期のずれを捨てて data を 1 バイト以上読む
        while (_used > 0 && data.Length > 0)
        {
            var take = Math.Min(188 - _used, data.Length);
            Push(data[..take], sink);
            data = data[take..];
        }
        if (_used > 0) return;
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
/// 同じ機材のカードが読み書きしている間 (<see cref="Dt295NativeLink.CardBusy"/>) だけ、要求を <see cref="CardKickPackets"/> 個 (64 KiB。30 Mbps で約 17 ms) にする (仕様書に無い。数は <see cref="CardKickPackets"/> の説明)
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

    /// <summary>
    /// カードが読み書きしている間の 1 回の要求のパケット数。
    ///
    /// <para>
    /// **小さくすると TS を取りこぼし、大きくするとカードの応答を読むのが遅れる。** カードの読み書きの制御転送が続く間は、
    /// TS の要求がロックを譲るので進まず、機材の取り込みのリング (192 KiB。37 Mbps で約 42 ms) が溢れる。
    /// 要求が大きいと、その間カードの受信 FIFO (32 バイト。19200 ボーで約 17 ms) を読めない。
    /// 128 個 (64 KiB) は、ホストがカードの UART を 1 バイトずつ読み書きしていたときに実機で測った値 (#2413):
    /// CS18 (37 Mbps) の 40 秒で、32 個だと連続性の飛びが 8142 個、64 個だと 1593 個、128 個だと 0 個。BS15 (24 Mbps) の 90 秒、
    /// 地上波 (T28) のライブ 40 秒、全 108 局の 15〜20 秒ずつでも 0 個だった。
    /// いまはカードの送受信を機材のプログラムに行わせる (<see cref="Dt295NativeLink.CardProgram"/>) ので、1 ブロックの制御転送は数回になり、
    /// TS の要求が譲る時間は短い。この形では、実機の BS15 と地上波 (T22) で連続性の飛びが 0 個だった (#2413)。CS18 ではまだ測っていない
    /// </para>
    /// </summary>
    internal const uint CardKickPackets = 128;

    private const int PumpTimeoutMs = 10_000;

    private readonly Pipe _pipe = TsBuffer.New();
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
        var writer = _pipe.Writer;
        try
        {
            while (!_stopped)
            {
                var got = _in.Read(raw, ReadTimeoutMs);
                if (got == 0) continue;
                var wrote = false;
                // 同期が続く範囲ごとにまとめて詰める (パケットごとのコピーと呼び出しを省く)
                framer.PushRuns(raw.AsSpan(0, got), run =>
                {
                    run.CopyTo(writer.GetSpan(run.Length));
                    writer.Advance(run.Length);
                    wrote = true;
                });
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

    /// <summary>書いたぶんを渡す (<see cref="Zd1jTuner.Flush"/>)。読む側がいないとみたら終わる</summary>
    private bool Flush(PipeWriter writer) => Zd1jTuner.Flush(writer, () => _stopped, () =>
    {
        _ended = true;
        _stalled();
    });

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

    /// <summary>同じチャンネルのまま受信が続いているかを確かめる時間の上限 (受かっていれば地上波は 1 周、衛星は数周で済む)</summary>
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

    public void Tune(ChannelTable.Tuning tuning)
    {
        var streamId = tuning.StreamId;
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
                if (before is { } was && ReferenceEquals(was.Device, device) && was.Tuning == tuning && was.StreamId == streamId
                    && frontend.IsTuned(tuning.Satellite, tuning.Satellite ? (uint)tuning.Frequency : (uint)((tuning.Frequency + 500UL) / 1000)))
                {
                    using (timeline.Step("同じチャンネル: 受信が続いているかを確かめる", "選局を省く"))
                    {
                        reuse = tuning.Satellite
                            ? frontend.WaitSatelliteLock(StillLockedWait, tsid)
                            : frontend.WaitTerrestrialLock(StillLockedWait);
                    }
                }
                if (!reuse)
                {
                    if (tuning.Satellite)
                    {
                        using (timeline.Step("選局 (衛星の周波数の設定)", "仕様書 7.3.2")) frontend.TuneSatellite(tuning.Frequency);
                    }
                    else
                    {
                        using (timeline.Step("選局 (地上波の周波数の設定)", "仕様書 7.2.2")) frontend.TuneTerrestrial((uint)((tuning.Frequency + 500UL) / 1000));
                    }
                }
                // 取り込みの設定は、受信の確認を待つ間に済ませておく (TS はまだ出ない)
                prepared = Dt295NativeStream.Prepare(device, _name, () => Task.Run(Stall));
                // 取り込みを始めるのは、受信の確認 (7.2.4・7.3.4) が済んでから (TMCC が確定する前の TS には transport_error_indicator が付く)
                if (!reuse && !(tuning.Satellite ? frontend.WaitSatelliteLock(LockWait, tsid) : frontend.WaitTerrestrialLock(LockWait)))
                {
                    throw new IOException(ITuneDevice.SyncFailed);
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
    /// いま受けているチャンネルの受信の状態と C/N の生の値 (<see cref="Dt295NativeFrontend.Signal"/>。dB にするのは <see cref="TunerSignal.Tc90522Db"/>)。
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
