using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>子プロセスを起動する所 (エージェントが起動する子プロセスは、どれもここを通す)</summary>
public static class Shell
{
    /// <summary>起動する。起動できなければ例外</summary>
    public static Process Start(ProcessStartInfo start) =>
        Process.Start(start) ?? throw new IOException($"{Path.GetFileName(start.FileName)} を起動できません");

    /// <summary>
    /// 子プロセスを最後まで回して、出力をまとめて受け取る (defaults・scutil)。
    /// 上限を過ぎたら子プロセスごと止める。起動できなかった・止めた、は exit -1 と理由で返す
    /// </summary>
    public static (int Code, string Output) Run(string file, IEnumerable<string> args, TimeSpan timeout)
    {
        try
        {
            var start = new ProcessStartInfo(file, args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var child = Start(start);
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            if (!child.WaitForExit(timeout))
            {
                // Kill は終わるのを待たない。待たずに ExitCode を読むと例外になり、時間切れの理由が残らない
                child.Kill(entireProcessTree: true);
                child.WaitForExit();
                return (-1, $"{Path.GetFileName(file)} が {timeout.TotalSeconds:0} 秒で終わらないので止めました");
            }
            return (child.ExitCode, $"{stdout.GetAwaiter().GetResult()}{stderr.GetAwaiter().GetResult()}".Trim());
        }
        catch (Exception error)
        {
            return (-1, error.Message);
        }
    }
}
