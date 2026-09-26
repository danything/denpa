using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>子プロセスに合図を送る。<c>Process.Kill()</c> は SIGKILL しか送れない</summary>
public static partial class Interop
{
    private const int Sigterm = 15;
    private const int Sigkill = 9;

    /// <summary>止めるときの猶予。過ぎたら SIGKILL</summary>
    private static readonly TimeSpan KillGrace = TimeSpan.FromSeconds(3);

    [LibraryImport("libc", SetLastError = true)]
    private static partial int kill(int pid, int sig);

    /// <summary>
    /// **プロセスグループごと**終わらせる。偽の選局 (適合テストの <c>FAKE_TUNE</c>) だけ。
    ///
    /// <para>
    /// <c>sh -c</c> 越しなので、sh を1つ殺すだけでは中身が生き残る。<c>setsid</c> で
    /// 起こしてあるので子の PID がそのままグループ ID で、負の PID で送ればグループ全体に届く。
    /// </para>
    /// </summary>
    public static void KillGroup(int pid)
    {
        kill(-pid, Sigterm);
        _ = Task.Delay(KillGrace).ContinueWith(_ => kill(-pid, Sigkill), TaskScheduler.Default);
    }

    /// <summary>
    /// 1つのプロセスに SIGTERM。**待たない。**
    ///
    /// <para>
    /// px4-userland の <c>px4d</c> と <c>px4-ts</c> は SIGTERM で lease を返し LNB を
    /// 0V に戻してから終わるので、まずこちらで頼み、聞かなければ呼んだ側が SIGKILL にする
    /// (Px4.cs / ChildTs.cs / Siano.cs)
    /// </para>
    /// </summary>
    public static void Terminate(int pid) => kill(pid, Sigterm);
}
