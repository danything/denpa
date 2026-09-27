using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Denpa.Agent;

/// <summary>
/// 選局した TS を **pipe で受け取る**ときの共通の口。子プロセス (siano-ts) の標準出力を
/// 読み口にするところ (<see cref="Stdout"/>) と、pipe の扱い (<see cref="WidenPipe"/> /
/// <see cref="ReaderDrain"/>)、子の印 (<see cref="TsChild"/>)。px4d から受けた TS を
/// 流す pipe (Px4Stream。Px4.cs) も、広げ方と閉じ方はここに揃える。
///
/// <para>
/// **読み口は <see cref="DeviceStream"/> に載せる。** pipe をそのまま fd として poll で待つので、
/// 電波が来なくても畳めるし、蹴られた読み手は 200ms で降りる (DVB と同じ振る舞い)。
/// </para>
/// </summary>
internal static class ChildTs
{
    /// <summary>
    /// pipe の深さ。
    ///
    /// <para>
    /// 既定 (64KB) だと地上波の 18Mbit/秒 で **30ms** しか無い。読む側が GC で
    /// 一瞬止まるだけで書き手が詰まり、向こうの溜め (px4d / siano-ts) も埋まれば
    /// 切られる。DVB の環 (8MB = 3.5秒) に揃える。
    /// 上限 (<c>/proc/sys/fs/pipe-max-size</c>、既定 1MB) を超えるには
    /// CAP_SYS_RESOURCE が要るが、コンテナは privileged なので通る。
    /// 通らなければ 1MB で妥協する
    /// </para>
    /// </summary>
    private const int PipeSize = 8 * 1024 * 1024;

    private const int FallbackPipeSize = 1024 * 1024;

    /// <summary>
    /// 読み手が降りきるまで待つ上限。<see cref="DeviceStream"/> は 200ms ごとに
    /// 起きて印を見るので、fd を閉じるのは読み手が戻ってから (閉じた番号を
    /// 次の pipe が使い回すと、降りかけの読み手が新しい pipe を読んでしまう)。
    /// 待つのは読みかけが居るときだけ (<see cref="DeviceStream.WaitReaders"/>)。
    /// siano-ts の後始末 (SianoTuner.Drop) と px4d の TS の後始末 (Px4Stream.Stop) で使う
    /// </summary>
    internal static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);

    /// <summary>
    /// 子の標準出力の fd。.NET 10 の Unix では <c>AnonymousPipeClientStream</c>。
    /// 閉じるのは <c>process.StandardOutput</c> を閉じたとき (SianoTuner.Drop)。
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
    /// pipe を広げる (<see cref="PipeSize"/>)。通らなければ記録に残して続ける。
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
}

/// <summary>
/// 子1つぶん (siano-ts)。**印は子ごとに持つ。** 止めたかどうかを1つの旗で
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
