using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Denpa.Agent;

/// <summary>
/// 選局した TS を**子プロセスの標準出力**で受け取る口 (px4-ts。Px4.cs)。
/// siano-ts は起こしたまま選局し直すので別の作り (Siano.cs) だが、pipe の扱い
/// (<see cref="StdoutHandle"/> / <see cref="WidenPipe"/>) と子の印 (<see cref="TsChild"/>) は
/// ここのものを使う。
///
/// <para>
/// **1回1チャンネル。** 選局のたびに子を起こし直す。
/// 子は同期するまで標準出力に1バイトも書かない (書くのは TS だけ、診断は stderr)。
/// なので「最初の1バイトが読めた = 同期した」「先に終わった = 失敗、理由は stderr の末尾」
/// 「何も無いまま時間が過ぎた = 電波が来ていない」で見分ける。
/// </para>
///
/// <para>
/// **読み口は <see cref="DeviceStream"/> に載せる。** 子の標準出力の pipe を
/// そのまま fd として poll で待つので、電波が来なくても畳めるし、蹴られた
/// 読み手は 200ms で降りる (DVB と同じ振る舞い)。
/// </para>
/// </summary>
internal sealed class ChildTs(string name, string program)
{
    /// <summary>
    /// 標準出力の pipe の深さ。
    ///
    /// <para>
    /// 既定 (64KB) だと地上波の 18Mbit/秒 で **30ms** しか無い。読む側が GC で
    /// 一瞬止まるだけで子の write が詰まり、px4d 側の溜めも埋まれば
    /// <c>SLOW_CONSUMER</c> で切られる。DVB の環 (8MB = 3.5秒) に揃える。
    /// 上限 (<c>/proc/sys/fs/pipe-max-size</c>、既定 1MB) を超えるには
    /// CAP_SYS_RESOURCE が要るが、コンテナは privileged なので通る。
    /// 通らなければ 1MB で妥協する
    /// </para>
    /// </summary>
    private const int PipeSize = 8 * 1024 * 1024;

    private const int FallbackPipeSize = 1024 * 1024;

    /// <summary>
    /// 読み手が降りきるまでの猶予。<see cref="DeviceStream"/> は 200ms ごとに
    /// 起きて印を見るので、fd を閉じるのはそれより後にする (閉じた番号を
    /// 次の子が使い回すと、降りかけの読み手が新しい pipe を読んでしまう)。
    /// siano-ts の後始末 (SianoTuner.Drop) も同じ理由でこれを使う
    /// </summary>
    internal static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);

    private TsChild? _child;
    private DeviceStream? _stream;

    public Stream Output => _stream ?? throw new InvalidOperationException($"{name} はまだ選局していません");

    /// <summary>前の子がまだ生きているか。呼ぶ側の錠の下で読む</summary>
    public bool Alive => _stream is not null && _child is { Process.HasExited: false };

    /// <summary>
    /// 子の標準出力の fd。.NET 10 の Unix では <c>AnonymousPipeClientStream</c>。
    /// 閉じるのは <c>process.StandardOutput</c> を閉じたとき (<see cref="Drop"/>)。
    /// こちらが閉じると読み口が二重に閉じる。
    /// </summary>
    internal static SafeFileHandle StdoutHandle(Process process)
    {
        var stream = process.StandardOutput.BaseStream;
        if (stream is FileStream file) return file.SafeFileHandle;
        if (stream is PipeStream pipe)
        {
            return new SafeFileHandle(pipe.SafePipeHandle.DangerousGetHandle(), ownsHandle: false);
        }
        throw new IOException($"子の標準出力を掴めません ({stream.GetType().Name})");
    }

    /// <summary>
    /// 子の標準出力の pipe を広げる (<see cref="PipeSize"/>)。通らなければ記録に残して続ける。
    ///
    /// <para>
    /// **macOS では何もしない。** <c>F_SETPIPE_SZ</c> が無く、pipe の深さは OS 任せ
    /// (書き手が詰まると 64KB まで自分で伸びる)。溜めは px4d / siano-ts の側にもあるので、
    /// 読み手が一瞬止まる程度なら持つ。ただし Linux の 8MB より浅いことは変わらない
    /// </para>
    /// </summary>
    internal static void WidenPipe(int fd, string name)
    {
        if (!OperatingSystem.IsLinux()) return;
        if (Sys.Fcntl(fd, Sys.SetPipeSize, PipeSize) < 0 && Sys.Fcntl(fd, Sys.SetPipeSize, FallbackPipeSize) < 0)
        {
            Log.Write($"[{name}] pipe を広げられませんでした ({Marshal.GetLastPInvokeErrorMessage()})");
        }
    }

    /// <summary>
    /// 子の標準出力を読み口にする (siano-ts)。Unix は fd を poll で待ち (pipe を広げてから)、
    /// **Windows は .NET の Stream のまま** (<see cref="DeviceStream(Stream, Func{string?}?)"/>)
    /// </summary>
    internal static DeviceStream Stdout(Process process, string name, Func<string?> ended)
    {
        if (OperatingSystem.IsWindows()) return new DeviceStream(process.StandardOutput.BaseStream, ended);
        var handle = StdoutHandle(process);
        WidenPipe((int)handle.DangerousGetHandle(), name);
        return new DeviceStream(handle, ended);
    }

    /// <summary>
    /// 子を起こして同期を待つ。前の子が居れば先に止める。
    /// 同期しなければ理由を添えて投げる (子は止めてある)
    /// </summary>
    public void Start(ProcessStartInfo start, TimeSpan syncTimeout)
    {
        Drop();
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.UseShellExecute = false;

        var process = Process.Start(start) ?? throw new IOException($"{program} を起動できません");
        var child = new TsChild(program, process);
        _child = child;
        _ = Task.Run(async () =>
        {
            // 失敗の理由は stderr の末尾に出る。全部は持たない
            using var reader = process.StandardError;
            while (await reader.ReadLineAsync() is { } line)
            {
                if (line.Trim().Length > 0) child.Stderr = line.Trim();
            }
        });

        var handle = StdoutHandle(process);
        var fd = (int)handle.DangerousGetHandle();
        WidenPipe(fd, name);

        var deadline = DateTime.UtcNow + syncTimeout;
        var synced = false;
        while (DateTime.UtcNow < deadline)
        {
            var (readable, ended) = Sys.PollIn(fd, 100);
            if (ended || process.HasExited)
            {
                // 先に終わった。理由は stderr に出ている (同期しなかった・使用中・USB…)
                process.WaitForExit(TimeSpan.FromSeconds(2));
                var reason = child.Exited(process.ExitCode);
                Drop();
                throw new IOException(reason);
            }
            if (readable)
            {
                synced = true;
                break;
            }
        }
        if (!synced)
        {
            Drop();
            throw new IOException("同期しませんでした (電波が来ていないか、その周波数に放送がありません)");
        }

        _stream = new DeviceStream(handle, child.EndReason);
        _ = process.WaitForExitAsync().ContinueWith(_ =>
        {
            if (child.Dropped) return;
            // 読み手が居なくなって切られたのも、USB が抜けたのもここに来る
            Log.Write($"[{name}] {child.Exited(process.ExitCode)}");
        }, TaskScheduler.Default);
    }

    /// <summary>
    /// 走っている子を止める。**SIGTERM で。** px4-ts は受信機の lease を返してから
    /// 終わる。読み手が降りきってから fd を閉じる (<see cref="ReaderDrain"/>)
    /// </summary>
    public void Drop()
    {
        var child = _child;
        var stream = _stream;
        _child = null;
        _stream = null;
        if (child is null) return;

        child.Dropped = true;
        stream?.Stop();
        var stopped = Stopwatch.StartNew();
        var process = child.Process;
        if (!process.HasExited)
        {
            Interop.Terminate(process.Id);
            if (!process.WaitForExit(TimeSpan.FromSeconds(2))) process.Kill();
        }
        var rest = ReaderDrain - stopped.Elapsed;
        if (stream is not null && rest > TimeSpan.Zero) Thread.Sleep(rest);
        stream?.Dispose();
        /*
         * **標準出力は自分で閉じる。** StandardOutput に触った (同期読みにした) 子は、
         * Process.Dispose が標準出力の pipe を閉じない。GC まで fd が1つずつ残り、
         * 選局のたびに増える (.NET 10 で 50 回起こして 54 本残った)
         */
        process.StandardOutput.Dispose();
        process.Dispose();
    }
}

/// <summary>
/// 子1つぶん (px4-ts / siano-ts)。**印は子ごとに持つ。** 止めたかどうかを1つの旗で
/// 持つと、前の子の後始末が次の子の旗を読む (起こし直した直後に前の子の終了が回ってくる)
/// </summary>
internal class TsChild(string program, Process process)
{
    public Process Process { get; } = process;

    /// <summary>stderr の最後の行。失敗・終わった理由はここに出る</summary>
    public volatile string Stderr = "";

    /// <summary>こちらから止めたか。**自分で止めた終わりは失敗ではない**</summary>
    public volatile bool Dropped;

    public string Exited(int code)
    {
        var stderr = Stderr;
        return $"{program} が終了しました (exit {code}{(stderr.Length == 0 ? "" : $": {stderr}")})";
    }

    /// <summary>
    /// 読み口が尽きたときの理由。**理由の分かる終わり方をする** (DeviceStream)。
    /// EOF は子が終わったということなので、終了コードと stderr の末尾を添える
    /// </summary>
    public string? EndReason()
    {
        if (Dropped) return null;
        if (!Process.WaitForExit(TimeSpan.FromSeconds(2))) return $"{program} が応答しなくなりました";
        return Exited(Process.ExitCode);
    }
}
