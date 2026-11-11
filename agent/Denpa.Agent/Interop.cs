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
    /// <c>sh -c</c> 越しなので、sh を 1 つ終わらせるだけでは中のコマンドが残る。<c>setsid</c> で
    /// 起動してあるので子の PID がそのままグループ ID で、負の PID で送ればグループ全体に届く。
    /// </para>
    /// </summary>
    public static void KillGroup(int pid)
    {
        // 偽の選局は setsid で起動するので、Windows では動かさない
        if (OperatingSystem.IsWindows()) return;
        kill(-pid, Sigterm);
        _ = Task.Delay(KillGrace).ContinueWith(_ => kill(-pid, Sigkill), TaskScheduler.Default);
    }

    /// <summary>
    /// 1 つのプロセスに SIGTERM。**待たない。**
    ///
    /// <para>
    /// px4-userland の <c>px4d</c> は SIGTERM で LNB を 0V に戻してから終わるので、
    /// まず SIGTERM を送り、終わらなければ呼んだ側が SIGKILL を送る (Px4.cs)
    /// </para>
    ///
    /// <para>
    /// **Windows では何もしない。** SIGTERM に当たるものが無く (Ctrl+C の合図は同じコンソールの
    /// プロセスグループにしか送れない)、呼んだ側が猶予のあとで <c>Kill</c> (TerminateProcess) にする
    /// </para>
    /// </summary>
    public static void Terminate(int pid)
    {
        if (!OperatingSystem.IsWindows()) kill(pid, Sigterm);
    }
}
