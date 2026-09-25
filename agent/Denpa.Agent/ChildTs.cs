using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// 選局した TS を**子プロセスの標準出力**で受け取る口。px4-ts (Px4.cs) と
/// siano-ts (Siano.cs) が同じ作りなので、ここで1つにする。
///
/// <para>
/// **どちらも1回1チャンネル。** 選局のたびに子を起こし直す。
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
    /// 次の子が使い回すと、降りかけの読み手が新しい pipe を読んでしまう)
    /// </summary>
    private static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);

    private Child? _child;
    private DeviceStream? _stream;

    /// <summary>
    /// 子1つぶん。**印は子ごとに持つ。** 止めたかどうかを1つの旗で持つと、
    /// 前の子の後始末が次の子の旗を読む (起こし直した直後に前の子の終了が回ってくる)
    /// </summary>
    private sealed class Child(Process process)
    {
        public Process Process { get; } = process;

        /// <summary>stderr の末尾。失敗の理由はここに出る</summary>
        public volatile string Stderr = "";

        /// <summary>こちらから止めたか。**自分で止めた終わりは失敗ではない**</summary>
        public volatile bool Dropped;
    }

    public Stream Output => _stream ?? throw new InvalidOperationException($"{name} はまだ選局していません");

    /// <summary>前の子がまだ生きているか。呼ぶ側の錠の下で読む</summary>
    public bool Alive => _stream is not null && _child is { Process.HasExited: false };

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

        var process = Process.Start(start) ?? throw new IOException($"{program} を起こせません");
        var child = new Child(process);
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

        var handle = ((FileStream)process.StandardOutput.BaseStream).SafeFileHandle;
        var fd = (int)handle.DangerousGetHandle();
        if (Sys.Fcntl(fd, Sys.SetPipeSize, PipeSize) < 0 && Sys.Fcntl(fd, Sys.SetPipeSize, FallbackPipeSize) < 0)
        {
            Log.Write($"[{name}] pipe を広げられませんでした ({Marshal.GetLastPInvokeErrorMessage()})");
        }

        var deadline = DateTime.UtcNow + syncTimeout;
        var synced = false;
        while (DateTime.UtcNow < deadline)
        {
            var (readable, ended) = Sys.PollIn(fd, 100);
            if (ended || process.HasExited)
            {
                // 先に終わった。理由は stderr に出ている (同期しなかった・使用中・USB…)
                process.WaitForExit(TimeSpan.FromSeconds(2));
                var reason = Reason(process.ExitCode, child.Stderr);
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

        _stream = new DeviceStream(handle, () => EndReason(child));
        _ = process.WaitForExitAsync().ContinueWith(_ =>
        {
            if (child.Dropped) return;
            // 読み手が居なくなって切られたのも、USB が抜けたのもここに来る
            Log.Write($"[{name}] {Reason(process.ExitCode, child.Stderr)}");
        }, TaskScheduler.Default);
    }

    private string Reason(int code, string stderr) =>
        $"{program} が終了しました (exit {code}{(stderr.Length == 0 ? "" : $": {stderr}")})";

    /// <summary>
    /// 読み口が尽きたときの理由。**理由の分かる終わり方をする** (DeviceStream)。
    /// EOF は子が終わったということなので、終了コードと stderr の末尾を添える
    /// </summary>
    private string? EndReason(Child child)
    {
        if (child.Dropped) return null;
        if (!child.Process.WaitForExit(TimeSpan.FromSeconds(2))) return $"{program} が黙りました";
        return Reason(child.Process.ExitCode, child.Stderr);
    }

    /// <summary>
    /// 走っている子を止める。**SIGTERM で。** px4-ts は受信機の lease を返し、
    /// siano-ts は USB を手放してから終わる。読み手が降りきってから fd を閉じる
    /// (<see cref="ReaderDrain"/>)
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
        process.Dispose();
    }
}
