/*
 * カードの部分 (Dt295ResidentCard) は、mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の
 * core/card.c・core/card_atr.c と userland/pcsc/ifd.c の card_command を移したもの。Copyright (c) 2026 huggy、
 * MIT License (全文は licenses/mAgicVISION.txt)。ボード・TS の読み出し・チューナーは denpa のもの (Zd1j.cs と同じ形)。
 */

using System.Diagnostics;
using System.IO.Pipelines;
using static Denpa.Agent.Dt295ResidentProtocol;

namespace Denpa.Agent;

/// <summary>
/// 常駐方式の PIX-DT295 1 台ぶんの持ち主。**USB のハンドルと常駐イメージとのやり取りは 1 台に 1 つだけ**で、チューナーとカードが取って使う。
/// 要求は <see cref="Locked{T}"/> の中で 1 つずつ送る (受信中の SERVICE とカードの要求が混ざらないように)。
///
/// <para>
/// 開くときに常駐イメージを入れるか、残っているものを引き継ぐ (<see cref="Dt295ResidentLoader"/>)。公式のファームウェアで動いた機材は
/// そのままでは入れられないので、Linux ではポートの電源を 1 回入れ直してからもう一度試す。閉じるときは常駐イメージを機材に残したまま手放す。
/// エージェントが動いている間は開いたまま (Zd1jBoard と同じ)。
/// </para>
/// </summary>
public sealed class Dt295ResidentBoard
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, Dt295ResidentBoard> Boards = [];

    private readonly Lock _gate = new();
    private int _users;
    private bool _closed;

    public string Port { get; }
    public IUsbDevice Usb { get; }
    public Dt295ResidentSession Session { get; }

    /// <summary>USB が抜けた・要求が通らなくなったなどで使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted { get; private set; }

    internal Dt295ResidentBoard(string port, IUsbDevice usb, Dt295ResidentSession session)
    {
        Port = port;
        Usb = usb;
        Session = session;
    }

    /// <summary>取る。開いていなければ、そのとき開いて常駐イメージを入れる (引き継ぐ)。**返すのは <see cref="Release"/>**</summary>
    public static Dt295ResidentBoard Acquire(string port) =>
        Acquire(port, () => Dt295.OpenUsb(port), OperatingSystem.IsLinux() ? () => UsbSysfs.PowerCycle(UsbSysfs.Devices, port, TimeSpan.FromSeconds(10)) : null);

    /// <param name="open">USB を開く</param>
    /// <param name="powerCycle">ポートの電源を入れ直す (Linux)。null ならつなぎ直しを求めて断る</param>
    internal static Dt295ResidentBoard Acquire(string port, Func<IUsbDevice> open, Action? powerCycle, Dt295ResidentImage? image = null,
        Func<long>? nowMs = null, Action<int>? delay = null)
    {
        lock (Registry)
        {
            if (Boards.TryGetValue(port, out var board) && !board.Faulted)
            {
                lock (board._gate) board._users++;
                return board;
            }
            Boards.Remove(port);
            image ??= Dt295ResidentImage.Bundled;
            var started = Stopwatch.StartNew();
            Dt295ResidentLoader.Outcome outcome;
            try
            {
                (board, outcome) = Open(port, open, image, nowMs, delay);
            }
            catch (Dt295ResidentColdException error) when (powerCycle is not null)
            {
                // 公式のファームウェアで動いたあとの機材。ポートの電源を入れ直すと、起動直後の状態に戻る
                Log.Write($"[{Dt295.Model} {port}] {error.Message}。USB のポートの電源を入れ直します");
                powerCycle();
                (board, outcome) = Open(port, open, image, nowMs, delay);
            }
            board._users = 1;
            Boards[port] = board;
            Log.Write($"[{Dt295.Model} {port}] 常駐イメージを{(outcome == Dt295ResidentLoader.Outcome.Adopted ? "引き継ぎ" : "入れ")}、"
                + $"開きました ({started.ElapsedMilliseconds}ms)");
            return board;
        }
    }

    private static (Dt295ResidentBoard Board, Dt295ResidentLoader.Outcome Outcome) Open(string port, Func<IUsbDevice> open, Dt295ResidentImage image,
        Func<long>? nowMs, Action<int>? delay)
    {
        var usb = open();
        var placed = false;
        var link = new Dt295ResidentLink(usb);
        var session = new Dt295ResidentSession(link, nowMs, delay);
        try
        {
            var (outcome, overview) = Dt295ResidentLoader.Start(link, session, image, placed: () => placed = true);
            if ((overview.StreamMask & 3) != 3) throw new Dt295ResidentException($"常駐イメージが地上波と衛星の両方の TS を出せません (TS の受信部 {overview.StreamMask})");
            return (new Dt295ResidentBoard(port, usb, session), outcome);
        }
        catch
        {
            if (placed)
            {
                try
                {
                    Dt295ResidentLoader.Close(session);
                }
                catch (Exception error) when (error is IOException or TimeoutException)
                {
                    // 開けなかった理由のほうを投げる。残ったイメージは次に開くときに引き継ぐ
                }
            }
            usb.Dispose();
            throw;
        }
    }

    /// <summary>要求を 1 つずつ送る。中で例外が出たら、USB が抜けたなら使えない印を付けて投げ直す</summary>
    public T Locked<T>(Func<Dt295ResidentSession, T> action)
    {
        lock (_gate)
        {
            if (_closed) throw new IOException($"{Dt295.Model} {Port} は閉じています");
            try
            {
                return action(Session);
            }
            catch (Exception error)
            {
                Fail(error);
                throw;
            }
        }
    }

    public void Locked(Action<Dt295ResidentSession> action) => Locked(session =>
    {
        action(session);
        return 0;
    });

    /// <summary>失敗が USB の抜けか、常駐イメージとのやり取りの崩れなら印を付ける (次に取る側は開き直す)</summary>
    public void Fail(Exception error)
    {
        if (error is UsbGoneException or Dt295ResidentException { Code: 0 }) Faulted = true;
    }

    /// <summary>返す。開いたままにする (使えなくなっていれば閉じる)</summary>
    public void Release()
    {
        lock (_gate)
        {
            if (--_users > 0) return;
        }
        if (Faulted)
        {
            lock (Registry)
            {
                if (Boards.TryGetValue(Port, out var current) && current == this) Boards.Remove(Port);
            }
            Close();
        }
    }

    /// <summary>誰も使っていなければ閉じる (チューナーが捨てられたとき)。カードが使っていれば開いたまま</summary>
    public static void CloseIfIdle(string port)
    {
        Dt295ResidentBoard? board;
        lock (Registry)
        {
            if (!Boards.TryGetValue(port, out board)) return;
            lock (board._gate)
            {
                if (board._users > 0) return;
            }
            Boards.Remove(port);
        }
        board.Close();
    }

    /// <summary>常駐イメージを機材に残したまま手放し、USB を閉じる</summary>
    private void Close()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            if (!Faulted)
            {
                try
                {
                    Dt295ResidentLoader.Close(Session);
                }
                catch (Exception error) when (error is IOException or TimeoutException)
                {
                    Log.Write($"[{Dt295.Model} {Port}] 常駐イメージを手放せませんでした ({error.Message})。次に開くときに引き継ぎます");
                }
            }
            Usb.Dispose();
            Log.Write($"[{Dt295.Model} {Port}] 閉じました");
        }
    }

    /// <summary>全部閉じる (エージェントを止めるとき)。使っている側がいても閉じる</summary>
    public static void CloseAll()
    {
        List<Dt295ResidentBoard> boards;
        lock (Registry)
        {
            boards = [.. Boards.Values];
            Boards.Clear();
        }
        foreach (var board in boards) board.Close();
    }
}

/// <summary>
/// TS を 1 回流すぶん。EP 0x81 の読みを出しっぱなしにして 188 バイトのパケットを取り出し (<see cref="Dt295ResidentTs"/>)、
/// <see cref="Pipe"/> に詰める。流している間は、別のスレッドで SERVICE を約 1 ms ごとに送る (常駐イメージが TS を出し続けるのに要る)
/// </summary>
internal sealed class Dt295ResidentStream
{
    private const byte Endpoint = 0x81;

    /// <summary>1 本の読みの大きさと数。今の方式の実機の測定で決めた値 (8 KiB を 64 本。docs/tuners.md)</summary>
    private const int TransferSize = 8192;

    private const int Depth = 64;

    private const int ReadTimeoutMs = 100;

    /// <summary>SERVICE を送る間隔 (usbboot.c の capture_firmware と同じ 1 ms)</summary>
    private const int ServiceMs = 1;

    private readonly Pipe _pipe = Px4Stream.NewBuffer();
    private readonly Dt295ResidentBoard _board;
    private readonly IUsbInStream _in;
    private readonly Dt295ResidentTs _ts;
    private readonly string _name;
    private readonly Action _stalled;
    private readonly Thread _pump;
    private readonly Thread _service;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    public DeviceStream Output { get; }

    public bool Ended => _ended;

    public string? Reason => _reason;

    /// <summary>最初の TS を詰めた時刻 (Stopwatch)。まだなら 0</summary>
    public long FirstAt { get; private set; }

    private readonly ManualResetEventSlim _first = new();

    private Dt295ResidentStream(Dt295ResidentBoard board, IUsbInStream input, Dt295ResidentTs ts, string name, Action stalled)
    {
        _board = board;
        _in = input;
        _ts = ts;
        _name = name;
        _stalled = stalled;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        _pump = new Thread(Pump) { IsBackground = true, Name = $"{name} TS" };
        _service = new Thread(Service) { IsBackground = true, Name = $"{name} SERVICE" };
    }

    /// <summary>読みを出して読み出しを始める。**選局の前に呼ぶ** (選局の途中から TS が出る)。SERVICE は <see cref="Serve"/> から</summary>
    public static Dt295ResidentStream Open(Dt295ResidentBoard board, Dt295ResidentSource source, int index, string name, Action stalled)
    {
        var ts = new Dt295ResidentTs(source.StreamFormat, index, (int)source.RecordSize);
        var stream = new Dt295ResidentStream(board, board.Usb.OpenInStream(Endpoint, TransferSize, Depth), ts, name, stalled);
        stream._pump.Start();
        return stream;
    }

    /// <summary>選局が受理されたら、SERVICE を送り始める</summary>
    public void Serve() => _service.Start();

    /// <summary>最初の TS を待つ。来なければ false</summary>
    public bool WaitFirst(TimeSpan timeout) => _first.Wait(timeout) || FirstAt != 0;

    private void Pump()
    {
        var raw = new byte[TransferSize * Depth];
        var writer = _pipe.Writer;
        try
        {
            while (!_stopped)
            {
                var got = _in.Read(raw, ReadTimeoutMs);
                if (got == 0) continue;
                var wrote = false;
                if (!_ts.Push(raw.AsSpan(0, got), packet =>
                {
                    packet.CopyTo(writer.GetSpan(packet.Length));
                    writer.Advance(packet.Length);
                    wrote = true;
                }))
                {
                    End($"TS の並びが崩れました ({_ts.Broken})");
                    return;
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
            End(error is UsbGoneException ? $"{error.Message}。挿し直してください" : $"TS を読めません ({error.Message})");
        }
        finally
        {
            _ended = true;
            writer.Complete();
        }
    }

    private void Service()
    {
        try
        {
            while (!_stopped && !_ended)
            {
                _board.Locked(session => session.Service());
                Thread.Sleep(ServiceMs);
            }
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
        {
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

    /// <summary>止める。SERVICE と読みを止め、読みを取り消し、読みかけの読む側が戻ってから溜めを閉じる</summary>
    public void Stop()
    {
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        if (_service.IsAlive) _service.Join(TimeSpan.FromSeconds(2));
        _pump.Join(TimeSpan.FromSeconds(2));
        _in.Dispose();
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}

/// <summary>
/// 常駐方式の PIX-DT295 のチューナー (地上波・BS・CS。受信部は地上波と衛星の 2 つだが、TS を出すのは 1 つずつ)。
/// 機材は復号しないので、TS はスクランブルのまま出す (B25 はエージェントが復号する)。ボードは流している間だけ取る
/// </summary>
public sealed class Dt295ResidentTuner : ITuneDevice
{
    /// <summary>選局から最初の TS を待つ上限。地上波は受かるまで 1 秒ほど、TS はそのあと 0.3 秒ほどで来る (docs/tuners.md)</summary>
    internal static readonly TimeSpan FirstTs = TimeSpan.FromSeconds(10);

    private readonly string _name;
    private readonly Func<Dt295ResidentBoard> _acquire;
    private readonly Action? _closeIdle;
    private readonly TimeSpan _firstTs;
    private readonly Lock _gate = new();
    private Dt295ResidentBoard? _board;
    private Dt295ResidentStream? _stream;
    private int _source = -1;

    /// <summary>設定の device (画面に出す理由の持ち主のキー)</summary>
    private readonly string _device;

    public Dt295ResidentTuner(string port)
        : this($"{Dt295.Model} {port}", () => Dt295ResidentBoard.Acquire(port), () => Dt295ResidentBoard.CloseIfIdle(port), device: Dt295.Device(port))
    {
    }

    internal Dt295ResidentTuner(string name, Func<Dt295ResidentBoard> acquire, Action? closeIdle = null, TimeSpan? firstTs = null, string? device = null)
    {
        _name = name;
        _acquire = acquire;
        _closeIdle = closeIdle;
        _firstTs = firstTs ?? FirstTs;
        _device = device ?? name;
    }

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false };
        }
    }

    internal Dt295ResidentBoard? Board => _board;

    /// <summary>denpa のチャンネルから、常駐イメージへの選局の中身を作る</summary>
    public static Dt295ResidentRequest Request(ChannelTable.Tuning tuning, uint streamId) =>
        tuning.Satellite
            ? new Dt295ResidentRequest(SourceSatellite, tuning.Frequency, streamId == ChannelTable.NoStreamId ? null : (int)streamId, 0)
            // 地上波は 3 つの階層を全部受ける
            : new Dt295ResidentRequest(SourceTerrestrial, tuning.Frequency, null, 7);

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            Stop(release: false);
            var request = Request(tuning, streamId);
            try
            {
                _board ??= _acquire();
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or TimeoutException)
            {
                // ファームウェアが読めない、開けない、常駐イメージを入れられない。空いているときも画面に出す
                Px4Userland.SetNotice(_device, this, error.Message);
                throw new IOException(error.Message, error);
            }
            Px4Userland.ClearNotice(_device, this);
            var board = _board;
            try
            {
                var source = board.Locked(session => session.QuerySource(request.Source));
                if ((source.Flags & SourceStream) == 0 || source.WindowRecords != 0)
                {
                    throw new IOException($"{_name} の受信部 {request.Source} は、USB で TS を出せません (フラグ 0x{source.Flags:X})");
                }
                if (request.Frequency < source.FrequencyMin || request.Frequency > source.FrequencyMax)
                {
                    throw new IOException($"{_name} では選べない周波数です ({request.Frequency}。{source.FrequencyMin}〜{source.FrequencyMax})");
                }
                _stream = Dt295ResidentStream.Open(board, source, request.Source, _name, () => Task.Run(Stall));
                _source = request.Source;
                board.Locked(session => session.Tune(request, streaming: true));
                _stream.Serve();
            }
            catch (TimeoutException error)
            {
                Stop(release: false);
                throw new IOException(ITuneDevice.SyncFailed, error);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException)
            {
                Stop(release: board.Faulted);
                throw new IOException(error is UsbGoneException ? $"{error.Message}。挿し直してください" : error.Message, error);
            }

            if (!_stream.WaitFirst(_firstTs))
            {
                var reason = _stream.Reason ?? $"選局から {_firstTs.TotalSeconds:0} 秒、TS が来ません";
                Stop(release: false);
                throw new IOException(reason);
            }
        }
    }

    private void Stall()
    {
        lock (_gate)
        {
            if (_stream is { Ended: true }) Stop(release: true);
        }
    }

    /// <summary>流すのをやめる。常駐イメージの受信も止める。<paramref name="release"/> ならボードも返す</summary>
    private void Stop(bool release)
    {
        var stream = _stream;
        _stream = null;
        var board = _board;
        stream?.Stop();
        if (board is not null && _source >= 0)
        {
            try
            {
                board.Locked(session =>
                {
                    if (session.RequestValid && session.Source == _source) session.Stop(_source);
                    session.WaitStopped();
                });
            }
            catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
            {
                Log.Write($"[{_name}] 受信を止められませんでした ({error.Message})");
            }
            _source = -1;
        }
        if (!release || board is null) return;
        _board = null;
        board.Release();
    }

    /// <summary>捨てる (定義が変わった・止める)。ボードはカードが使っていなければ閉じる</summary>
    public void Dispose()
    {
        lock (_gate) Stop(release: true);
        _closeIdle?.Invoke();
    }
}

/// <summary>
/// 常駐方式の PIX-DT295 の差し込み口 (card.c)。CARD コマンドで APDU を渡し、T=1 の枠組みは常駐イメージが組む。
/// 要求ごとに <see cref="Dt295ResidentBoard.Locked{T}"/> を取り、待つ間は手放す (受信中の SERVICE を止めない)
/// </summary>
public sealed class Dt295ResidentCard : ICardLink
{
    // CARD コマンドの中身 (constants.h の MB86H_CARD_*)
    public const byte Version = 2;
    public const uint OpStatus = 0;
    public const uint OpPowerOn = 1;
    public const uint OpService = 2;
    public const uint OpPowerOff = 3;
    public const uint OpTxBegin = 4;
    public const uint OpTxData = 5;
    public const uint OpTransmit = 6;
    public const uint OpRxRead = 7;
    public const uint OpAtrRead = 8;
    public const uint OpReset = 9;
    public const int MaxTx = 256;
    public const int MaxRx = 512;
    public const int MaxAtr = 33;
    public const int Chunk = 32;

    /// <summary>APDU 1 つの応答を待つ上限を常駐イメージに渡す (card.c の 3000)</summary>
    private const uint TransmitTimeoutMs = 3000;

    /// <summary>常駐イメージがカードの操作を終えるのを待つ上限 (card.c の settle の 5000)</summary>
    private const int SettleMs = 5000;

    private readonly Func<Dt295ResidentBoard> _acquire;
    private readonly Func<long> _now;
    private readonly Action<int> _delay;
    private Dt295ResidentBoard? _board;
    private uint _generation;
    private bool _active;
    private Exception? _failed;

    public string Name { get; }

    public Dt295ResidentCard(string name, Func<Dt295ResidentBoard> acquire, Func<long>? nowMs = null, Action<int>? delay = null)
    {
        Name = name;
        _acquire = acquire;
        _now = nowMs ?? (() => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency);
        _delay = delay ?? Thread.Sleep;
    }

    private Dt295ResidentBoard Board => _board ??= _acquire();

    /// <summary>
    /// CARD コマンドを 1 つ (card.c の command)。応答の結果を返す (1 は「まだ」で、<see cref="Settle"/> が待つ)。
    /// やり取りの失敗と応答の形の崩れは、この接続をそれきり使えなくする (要求が実行されたかもしれない)
    /// </summary>
    private int Command(uint op, byte[] data, out byte[] response)
    {
        if (_failed is not null) throw new IOException($"{Name} は使えなくなっています ({_failed.Message})", _failed);
        data[0] = Version;
        Put(data, 4, _generation);
        try
        {
            response = Board.Locked(session => session.Command(CommandCard, op, data));
        }
        catch (Exception error) when (error is IOException)
        {
            _failed = error;
            throw;
        }
        var rc = Error(response);
        if (Result(response) != Ok && rc < 0) return Fail(op, rc);
        if (response[24] != Version || rc > 1 || Result(response) != Ok)
        {
            _failed = new Dt295ResidentException($"{Name} の応答の形が違います (結果 {Result(response)}、理由 {rc})");
            throw _failed;
        }
        if ((op == OpPowerOn || op == OpReset) && rc >= 0) _generation = Word(response, 16);
        else if (op != OpStatus && op != OpPowerOff && Word(response, 16) != _generation)
        {
            _failed = new Dt295ResidentException($"{Name} の応答の世代が違います");
            throw _failed;
        }
        return rc < 0 ? Fail(op, rc) : rc;
    }

    /// <summary>常駐イメージのカードの失敗 (card.c の result)。理由ごとに文言を決めて投げる</summary>
    private int Fail(uint op, int rc) => throw new IOException((rc switch
    {
        -2600 => $"{Name} のカードは使用中です",
        -2601 => $"{Name} のカードでは使えない操作です",
        -2602 => $"{Name} のカードとのやり取りに失敗しました",
        -2603 => $"{Name} のカードが時間内に答えませんでした",
        -2604 => $"{Name} のカードの応答が長すぎます",
        _ => $"{Name} のカードの操作が失敗しました",
    }) + $" (操作 {op}、理由 {rc})");

    /// <summary>「まだ」の間、SERVICE を送って待つ (card.c の settle)。待つ間は <see cref="Dt295ResidentBoard.Locked{T}"/> を手放す</summary>
    private void Settle(int rc)
    {
        var start = _now();
        while (rc == 1)
        {
            if (_now() - start >= SettleMs)
            {
                _failed = new TimeoutException($"{Name} のカードの操作が {SettleMs} ms のうちに終わりませんでした");
                throw new IOException(_failed.Message, _failed);
            }
            _delay(10);
            rc = Command(OpService, new byte[DataSize], out _);
        }
    }

    /// <summary>挿さっていれば true (card.c の mb86H_card_status)。抜けていて電源が入っていれば切る</summary>
    private bool Present()
    {
        Command(OpStatus, new byte[DataSize], out var response);
        if (response[39] != 0) return true;
        _active = false;
        if (response[38] != 0) Settle(Command(OpPowerOff, new byte[DataSize], out _));
        return false;
    }

    /// <summary>ATR か応答を 32 バイトずつ読む (card.c の read_bytes)</summary>
    private byte[] ReadBytes(uint op, int limit)
    {
        var bytes = new List<byte>();
        var total = 0;
        do
        {
            var data = new byte[DataSize];
            data[1] = Chunk;
            data[2] = (byte)(bytes.Count >> 8);
            data[3] = (byte)bytes.Count;
            Command(op, data, out var response);
            var reported = (response[26] << 8) | response[27];
            var n = (int)response[25];
            if (reported > limit || (bytes.Count != 0 && reported != total) || n == 0 || n > Chunk || bytes.Count + n > reported)
            {
                _failed = new Dt295ResidentException($"{Name} の応答の長さが合いません ({bytes.Count} + {n} / {reported})");
                throw _failed;
            }
            total = reported;
            bytes.AddRange(response.AsSpan(32, n));
        }
        while (bytes.Count < total);
        return [.. bytes];
    }

    public byte[] Reset()
    {
        if (!Present()) throw new CardAbsentException($"{Name} にカードが挿さっていません");
        _active = false;
        // 電源が入っていればリセット、入っていなければ電源を入れる (card.c の activate)
        Settle(Command(OpPowerOn, new byte[DataSize], out _));
        var atr = ReadBytes(OpAtrRead, MaxAtr);
        if (atr.Length < 2 || atr[0] is not (0x3B or 0x3F)) throw new IOException($"{Name} のカードの ATR が読めません ({Convert.ToHexString(atr)})");
        _active = true;
        return atr;
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (!_active) throw new IOException($"{Name} のカードに繋いでいません (Reset を先に)");
        if (apdu.IsEmpty || apdu.Length > MaxTx) throw new ArgumentException($"APDU は 1〜{MaxTx} バイトです", nameof(apdu));
        try
        {
            var data = new byte[DataSize];
            data[2] = (byte)(apdu.Length >> 8);
            data[3] = (byte)apdu.Length;
            Put(data, 8, TransmitTimeoutMs);
            Command(OpTxBegin, data, out _);
            for (var at = 0; at < apdu.Length;)
            {
                var n = Math.Min(Chunk, apdu.Length - at);
                data = new byte[DataSize];
                data[1] = (byte)n;
                data[2] = (byte)(at >> 8);
                data[3] = (byte)at;
                apdu.Slice(at, n).CopyTo(data.AsSpan(8));
                Command(OpTxData, data, out _);
                at += n;
            }
            Settle(Command(OpTransmit, new byte[DataSize], out _));
            return ReadBytes(OpRxRead, MaxRx);
        }
        catch (IOException error) when (error is not CardAbsentException)
        {
            _active = false;
            // 抜かれたのなら、そう伝える (B25 はカードを探し直す)。確かめられなければ元の失敗のまま
            bool present;
            try
            {
                present = Present();
            }
            catch (IOException)
            {
                throw error;
            }
            if (!present) throw new CardAbsentException($"{Name} のカードが抜かれました");
            throw;
        }
    }

    public void Dispose()
    {
        _active = false;
        var board = _board;
        _board = null;
        board?.Release();
    }
}
