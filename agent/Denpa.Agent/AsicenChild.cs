using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// ASICEN 系の機材を扱う子プロセス <c>denpa-asicen</c> (agent/asicen/main.cpp。GPL-2.0-only) を起動して、やりとりする所。
/// **試験的。実機では確かめていない。**
///
/// <para>
/// 子プロセスはエージェントとは別のプログラムで、asicen-userland を組み込み、機材を開くのも USB を読み書きするのもそちら。
/// やりとりは標準入力 (選局と停止の命令。1 行に 1 つ) と標準出力 (見出し 8 バイトの付いた応答と TS) だけ (docs/agent.md「asicen-userland の作り」)。
/// ここは上流の表や値を持たない。筐体 1 台につき 1 つ起動し、使う受信機が無くなったら標準入力を閉じて終わらせる。
/// **子プロセスが落ちてもエージェントは落ちない。** 流していた TS は終わり (<see cref="ChildExited"/>)、次に要ったときに起動し直す (<see cref="AsicenEnclosure"/>)。
/// </para>
/// </summary>
public sealed class AsicenChild
{
    /// <summary>main.cpp のプロトコルのバージョン</summary>
    public const int Protocol = 1;

    /// <summary>対応を確かめた上流のバージョン (agent/asicen/build.sh で固定しているもの)</summary>
    public const string Version = "1.0.0";

    /// <summary>ファームウェア待ちの機材に流し込んだだけで、開いていない (main.cpp の 'L')</summary>
    public const int Loaded = 200;

    /// <summary>子プロセスが終わった (こちらで決めた番号。ストリームの終わりと選局の失敗に使う)</summary>
    public const int ChildExited = 1000;

    public const int IsdbT = 1;
    public const int IsdbS = 2;

    /// <summary>上流の Error の番号のうち、こちらが見分けるもの</summary>
    public const int InvalidArgument = 1;
    public const int Busy = 4;
    public const int Timeout = 6;
    public const int UsbIo = 7;
    public const int Disconnected = 8;
    public const int Unsupported = 11;

    /// <summary>開き終えるまで待つ上限。ファームウェアの流し込みと、機材がつながり直すのを待つぶん</summary>
    private static readonly TimeSpan OpenLimit = TimeSpan.FromSeconds(90);

    /// <summary>標準入力を閉じてから、終わるのを待つ上限 (LNB を 0 V に戻して USB を手放すぶん)。過ぎたら止める</summary>
    private static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(5);

    /// <summary>
    /// 子プロセスのパス。<c>ASICEN_CHILD</c> があればそれ (テスト)。無ければ <see cref="AsicenUserland.Dir"/> の
    /// <c>denpa-asicen</c> (Windows は <c>denpa-asicen.exe</c>、Android は jniLibs に入れた <c>libdenpa_asicen.so</c>)
    /// </summary>
    public static string Program
    {
        get
        {
            if (Environment.GetEnvironmentVariable("ASICEN_CHILD") is { Length: > 0 } path) return path;
            var dir = AsicenUserland.Dir;
            if (OperatingSystem.IsWindows()) return Path.Combine(dir, "denpa-asicen.exe");
            var android = Path.Combine(dir, "libdenpa_asicen.so");
            return File.Exists(android) ? android : Path.Combine(dir, "denpa-asicen");
        }
    }

    /// <summary>使えない理由 (使えれば null)</summary>
    public static string? Problem { get; private set; }

    private static readonly Lazy<bool> Checked = new(Check);

    /// <summary>子プロセスがあり、プロトコルと上流のバージョンが合うか (起動して <c>--version</c> を読む。1 度だけ)</summary>
    public static bool Available => Checked.Value;

    private static bool Check()
    {
        var program = Program;
        if (!File.Exists(program))
        {
            Problem = $"{program} がありません";
            return false;
        }
        var expected = $"denpa-asicen {Protocol} asicen-userland {Version}";
        var (code, output) = Shell.Run(program, ["--version"], TimeSpan.FromSeconds(10));
        if (code != 0 || output.Trim() != expected)
        {
            Problem = $"{program} --version が「{output.Trim()}」(exit {code}) でした。対応しているのは {expected} だけです";
            return false;
        }
        return true;
    }

    /// <summary>上流の Error の名前 (<c>TIMEOUT</c>)</summary>
    public static string ErrorName(int code) => code switch
    {
        0 => "OK",
        InvalidArgument => "INVALID_ARGUMENT",
        3 => "NOT_FOUND",
        Busy => "BUSY",
        5 => "NOT_READY",
        Timeout => "TIMEOUT",
        UsbIo => "USB_IO",
        Disconnected => "DISCONNECTED",
        10 => "FIRMWARE_REJECTED",
        Unsupported => "UNSUPPORTED",
        255 => "INTERNAL",
        Loaded => "LOADED",
        ChildExited => "CHILD_EXITED",
        _ => code.ToString(CultureInfo.InvariantCulture),
    };

    /// <summary>TS が終わった理由 (上流の TunerStreamTerminal と <see cref="ChildExited"/>)</summary>
    public static string Terminal(int terminal) => terminal switch
    {
        1 => "読み出しが追いつきませんでした",
        2 => "USB の読み書きに失敗しました",
        3 => "同期が外れました",
        4 => "機材の内部で失敗しました",
        5 => "止めました",
        6 => "機材が抜けました",
        ChildExited => "子プロセスが終了しました",
        _ => $"理由 {terminal}",
    };

    /// <summary>挿さっている機材の JSON (<c>asicend --list-json</c> と同じ)。子プロセスを起動して読む</summary>
    public static string ListJson()
    {
        var (code, output) = Shell.Run(Program, ["--list-json"], TimeSpan.FromSeconds(15));
        return code == 0 ? output : throw new IOException($"ASICEN の機材を並べられません (denpa-asicen --list-json exit {code}: {output})");
    }

    /// <summary>
    /// 子プロセスを起動する。標準入力・標準出力・標準エラーは受け取る。
    /// fd を継がせて起動するときは (Android)、<paramref name="lend"/> で継がせる fd の複製を作り、その番号から <paramref name="args"/> で引数を組む。
    /// 複製は起動し終えたところで閉じる (子プロセスは自分の写しを持つ)。起動できなかったときも閉じる。
    ///
    /// <para>
    /// **複製を作ってから起動し終えるまでは、ほかの子プロセスを起動しない** (<see cref="Shell.SpawnGate"/>。複製を作るのもこのロックの中)。
    /// 同じ時にほかの子プロセスを起動すると、その子も同じ fd を継ぐ (.NET の Process.Start は close-on-exec の無い fd を閉じない)。
    /// 子プロセスが別の筐体の fd を持ち続けると、その筐体の USB の確保が外れない。エージェントの子プロセスはどれも <see cref="Shell.Start"/> で起動し、同じロックを取る
    /// </para>
    /// </summary>
    internal static Process Start(string program, Func<IReadOnlyList<int>, IReadOnlyList<string>> args, Func<InheritedFds>? lend)
    {
        lock (Shell.SpawnGate)
        {
            using var inherit = lend?.Invoke();
            var start = new ProcessStartInfo(program, args(inherit?.Numbers ?? []))
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // 診断は UTF-8 (パスに日本語が入りうる)
                StandardErrorEncoding = Encoding.UTF8,
                UseShellExecute = false,
                // Windows でコンソールの窓を出さない
                CreateNoWindow = true,
            };
            return Shell.Start(start);
        }
    }

    /// <summary>
    /// 筐体を開く子プロセスを起動し、開き終えるまで待つ。引数は asicend と同じ (<see cref="AsicenEnclosure.Arguments"/>)。
    /// 開けなければ番号と子プロセスのメッセージを添えて <see cref="AsicenError"/>。ファームウェアを流し込んだだけなら null (<see cref="Loaded"/>)
    /// </summary>
    /// <param name="name">記録に付ける名前 (<c>asicen 1-2</c>)</param>
    public static AsicenChild? Open(string name, IReadOnlyList<string> args, Func<InheritedFds>? lend = null) =>
        Begin(name, Start(Program, fds => [.. AsicenEnclosure.FdOptions(fds), .. args], lend));

    /// <summary>偽の機材で開く (テスト用に組んだ子プロセスだけ)</summary>
    public static AsicenChild OpenMock(string name, int receivers) =>
        Begin(name, Start(Program, _ => ["--mock", receivers.ToString(CultureInfo.InvariantCulture)], null))
        ?? throw new IOException("偽の機材を開けません");

    private static AsicenChild? Begin(string name, Process process)
    {
        var child = new AsicenChild(name, process);
        (char Kind, byte[] Body) first;
        try
        {
            if (!child._first.Task.Wait(OpenLimit)) throw new IOException($"{OpenLimit.TotalSeconds:F0} 秒待っても開き終わりません");
            first = child._first.Task.Result;
        }
        catch (Exception error) when (error is IOException or AggregateException)
        {
            child.Kill();
            throw new AsicenError(ChildExited, error is AggregateException { InnerException: { } inner } ? inner.Message : error.Message);
        }
        switch (first.Kind)
        {
            case 'O':
                var root = JsonNode.Parse(first.Body) as JsonObject ?? throw new IOException("開いた筐体の知らせが読めません");
                child.Model = root["model"]?.GetValue<string>() ?? "";
                child.Systems = [.. (root["systems"] as JsonArray ?? []).Select(node => node?.GetValue<int>() ?? 0)];
                child.Lnb = root["lnb"]?.GetValue<bool>() ?? false;
                return child;
            case 'L':
                Log.Write($"[{name}] {Encoding.UTF8.GetString(first.Body)}");
                child.Close();
                return null;
            default:
                child.Close();
                var code = first.Body.Length >= 4 ? BinaryPrimitives.ReadInt32LittleEndian(first.Body) : 255;
                var message = first.Body.Length > 4 ? Encoding.UTF8.GetString(first.Body, 4, first.Body.Length - 4) : "";
                throw new AsicenError(code, $"{message} ({ErrorName(code)})");
        }
    }

    private readonly string _name;
    private readonly Process _process;
    private readonly Lock _gate = new();
    private readonly Dictionary<int, AsicenChannel> _channels = [];
    private readonly TaskCompletionSource<(char, byte[])> _first = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _next;
    private bool _closing;
    private int _shut;
    private volatile bool _exited;

    /// <summary>開いた筐体の機種の名前</summary>
    public string Model { get; private set; } = "";

    /// <summary>受信機ごとの方式 (<see cref="IsdbT"/>・<see cref="IsdbS"/> のビット)</summary>
    public int[] Systems { get; private set; } = [];

    /// <summary>LNB の給電を操作できるか</summary>
    public bool Lnb { get; private set; }

    /// <summary>子プロセスが終わったか (落ちた・閉じた)</summary>
    public bool Exited => _exited;

    private AsicenChild(string name, Process process)
    {
        _name = name;
        _process = process;
        _process.StandardInput.NewLine = "\n";
        new Thread(ReadOutput) { IsBackground = true, Name = $"{name} denpa-asicen" }.Start();
        new Thread(ReadErrors) { IsBackground = true, Name = $"{name} denpa-asicen stderr" }.Start();
    }

    /// <summary>上流の診断と子プロセスのメッセージを記録に写す</summary>
    private void ReadErrors()
    {
        try
        {
            while (_process.StandardError.ReadLine() is { } line)
            {
                if (line.Length > 0) Log.Write($"[{_name}] {line}");
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
        }
    }

    /// <summary>標準出力の応答を読み、ストリームごとに振り分ける。終わったら (落ちた・閉じた) 全部のストリームを終える</summary>
    private void ReadOutput()
    {
        var output = _process.StandardOutput.BaseStream;
        var header = new byte[8];
        try
        {
            while (true)
            {
                if (!Fill(output, header)) break;
                var kind = (char)header[0];
                var id = header[1];
                var length = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4));
                if (length is < 0 or > 16 << 20) throw new IOException($"応答の長さ {length} は読めません");
                var body = new byte[length];
                if (!Fill(output, body)) break;
                Dispatch(kind, id, body);
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
        {
            Log.Write($"[{_name}] denpa-asicen の応答を読めません ({error.Message})");
        }
        _exited = true;
        List<AsicenChannel> left;
        lock (_gate)
        {
            left = [.. _channels.Values];
            _channels.Clear();
        }
        foreach (var channel in left) channel.Gone();
        int? code = null;
        try
        {
            if (_process.WaitForExit(TimeSpan.FromSeconds(5))) code = _process.ExitCode;
        }
        catch (InvalidOperationException)
        {
        }
        _first.TrySetException(new IOException($"denpa-asicen が開き終える前に終了しました (exit {code?.ToString(CultureInfo.InvariantCulture) ?? "?"})"));
        if (Volatile.Read(ref _shut) == 0) Log.Write($"[{_name}] denpa-asicen が終了しました (exit {code?.ToString(CultureInfo.InvariantCulture) ?? "?"})");
    }

    private static bool Fill(Stream stream, byte[] buffer)
    {
        var at = 0;
        while (at < buffer.Length)
        {
            var read = stream.Read(buffer, at, buffer.Length - at);
            if (read == 0) return false;
            at += read;
        }
        return true;
    }

    private void Dispatch(char kind, int id, byte[] body)
    {
        if (kind is 'O' or 'F' or 'L')
        {
            _first.TrySetResult((kind, body));
            return;
        }
        AsicenChannel? channel;
        lock (_gate) _channels.TryGetValue(id, out channel);
        if (channel is null) return;
        switch (kind)
        {
            case 'T':
                channel.Tuned(BinaryPrimitives.ReadInt32LittleEndian(body));
                break;
            case 'D':
                channel.Push(body);
                break;
            case 'E':
                channel.End(BinaryPrimitives.ReadInt32LittleEndian(body));
                break;
            case 'S':
                bool last;
                lock (_gate)
                {
                    _channels.Remove(id);
                    last = _closing && _channels.Count == 0;
                }
                channel.Stopped();
                if (last) Shut();
                break;
        }
    }

    /// <summary>命令を 1 行送る。送れなければ (子プロセスが終わった) false</summary>
    internal bool Send(string line)
    {
        lock (_process)
        {
            try
            {
                _process.StandardInput.WriteLine(line);
                _process.StandardInput.Flush();
                return true;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// 受信機を取り、選局して同期を待ち、TS を流し始める。失敗すれば番号を添えて <see cref="AsicenError"/>
    /// (同期しなければ <see cref="Timeout"/>、子プロセスが終わっていれば <see cref="ChildExited"/>)
    /// </summary>
    public AsicenChannel Tune(int receiver, int system, ulong frequencyHz, ushort tsid, ushort slot, byte lnbVoltage, uint timeoutMs)
    {
        AsicenChannel channel;
        lock (_gate)
        {
            if (_exited || _closing) throw new AsicenError(ChildExited, "denpa-asicen が終了しています");
            var id = Enumerable.Range(1, 255).Select(offset => (_next + offset) % 255 + 1).FirstOrDefault(free => !_channels.ContainsKey(free));
            if (id == 0) throw new AsicenError(Busy, "同時に流せる数を超えました");
            _next = id;
            channel = new AsicenChannel(this, id);
            _channels[id] = channel;
        }
        if (!Send(string.Join(' ', "tune", channel.Id, receiver, system, frequencyHz, tsid, slot, lnbVoltage, timeoutMs)))
        {
            Forget(channel);
            throw new AsicenError(ChildExited, "denpa-asicen に選局を送れません");
        }
        var code = channel.WaitTuned(TimeSpan.FromMilliseconds(timeoutMs) + TimeSpan.FromSeconds(10));
        if (code == 0) return channel;
        channel.WaitStopped();
        Forget(channel);
        throw new AsicenError(code, ErrorName(code));
    }

    private void Forget(AsicenChannel channel)
    {
        lock (_gate) _channels.Remove(channel.Id);
    }

    /// <summary>
    /// 閉じる。**流しているストリームが残っていれば、それを全部止めたときに閉じ終える** (子プロセスは標準入力が閉じたら筐体を閉じて終わる)
    /// </summary>
    public void Close()
    {
        bool now;
        lock (_gate)
        {
            _closing = true;
            now = _channels.Count == 0;
        }
        if (now) Shut();
    }

    /// <summary>標準入力を閉じて終わるのを待ち、<see cref="ExitGrace"/> を過ぎたら止める。待つのは背景で</summary>
    private void Shut()
    {
        if (Interlocked.Exchange(ref _shut, 1) != 0) return;
        lock (_process)
        {
            try
            {
                _process.StandardInput.Close();
            }
            catch (Exception error) when (error is IOException or InvalidOperationException)
            {
            }
        }
        _ = Task.Run(() =>
        {
            try
            {
                if (_process.WaitForExit(ExitGrace)) return;
                Log.Write($"[{_name}] denpa-asicen が {ExitGrace.TotalSeconds:F0} 秒で終わらないので止めます");
                _process.Kill(entireProcessTree: true);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
        });
    }

    /// <summary>すぐに止める (開き終わらないとき。テストは落ちたときの扱いを確かめる)</summary>
    internal void Kill()
    {
        Interlocked.Exchange(ref _shut, 1);
        try
        {
            _process.Kill(entireProcessTree: true);
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }
}

/// <summary>
/// 子プロセスの中のストリーム 1 つ (選局 1 回ぶん)。届いた TS は読まれるまでここに溜める。
/// **溜まったまま <see cref="Backlog"/> を超えたら、読み出しが追いつかないとして止める** (子プロセスの書き込みを止めて、ほかの受信機の TS まで止めないため)
/// </summary>
public sealed class AsicenChannel(AsicenChild child, int id)
{
    /// <summary>読まれずに溜めておける上限</summary>
    private const int Backlog = 64 << 20;

    /// <summary>溜めた TS と終わりを守る (<see cref="Monitor"/> で待つので object)</summary>
    private readonly object _gate = new();
    private readonly Queue<byte[]> _chunks = new();
    private readonly ManualResetEventSlim _stopped = new();
    private readonly TaskCompletionSource<int> _tuned = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private byte[]? _head;
    private int _offset;
    private int _queued;
    private int? _terminal;

    public int Id { get; } = id;

    internal void Tuned(int code) => _tuned.TrySetResult(code);

    internal int WaitTuned(TimeSpan limit) =>
        _tuned.Task.Wait(limit) ? _tuned.Task.Result : AsicenChild.Timeout;

    internal void WaitStopped() => _stopped.Wait(TimeSpan.FromSeconds(5));

    internal void Push(byte[] chunk)
    {
        var overflow = false;
        lock (_gate)
        {
            if (_terminal is not null) return;
            _chunks.Enqueue(chunk);
            _queued += chunk.Length;
            if (_queued > Backlog)
            {
                _terminal = 1;
                overflow = true;
            }
            Monitor.PulseAll(_gate);
        }
        if (overflow) child.Send($"stop {Id}");
    }

    internal void End(int terminal)
    {
        lock (_gate)
        {
            _terminal ??= terminal;
            Monitor.PulseAll(_gate);
        }
    }

    internal void Stopped()
    {
        End(5);
        _stopped.Set();
    }

    /// <summary>子プロセスが終わった。選局の途中なら失敗にし、流していれば終える</summary>
    internal void Gone()
    {
        _tuned.TrySetResult(AsicenChild.ChildExited);
        End(AsicenChild.ChildExited);
        _stopped.Set();
    }

    /// <summary>TS を読む。<paramref name="timeoutMs"/> まで待って来なければ 0 バイト。溜めたものを読み切って終わっていれば Ended と理由</summary>
    public (int Length, bool Ended, int Terminal) Read(Span<byte> output, int timeoutMs)
    {
        lock (_gate)
        {
            if (_head is null && _chunks.Count == 0 && _terminal is null) Monitor.Wait(_gate, timeoutMs);
            var written = 0;
            while (written < output.Length)
            {
                if (_head is null)
                {
                    if (!_chunks.TryDequeue(out _head)) break;
                    _offset = 0;
                }
                var take = Math.Min(output.Length - written, _head.Length - _offset);
                _head.AsSpan(_offset, take).CopyTo(output[written..]);
                written += take;
                _offset += take;
                _queued -= take;
                if (_offset == _head.Length) _head = null;
            }
            var ended = _terminal is not null && _head is null && _chunks.Count == 0;
            return (written, ended, ended ? _terminal!.Value : 0);
        }
    }

    /// <summary>止めて、子プロセスが受信機を返すのを待つ (5 秒まで)</summary>
    public void Stop()
    {
        if (!_stopped.IsSet && child.Send($"stop {Id}")) WaitStopped();
    }
}

/// <summary>子プロセスが返した失敗 (上流の Error の番号つき)</summary>
internal sealed class AsicenError(int code, string message) : IOException(message)
{
    public int Code { get; } = code;

    /// <summary>機材が抜けた・USB の読み書きに失敗した・子プロセスが終わった (筐体を開き直す)</summary>
    public bool Lost => Code is AsicenChild.UsbIo or AsicenChild.Disconnected or AsicenChild.ChildExited;
}
