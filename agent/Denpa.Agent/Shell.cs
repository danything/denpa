using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>子プロセスを最後まで回して、出力をまとめて受け取る (px4d --list-json・px4ctl・siano-ts --list・asicen-probe・asicenctl)</summary>
public static class Shell
{
    /// <summary>上限を過ぎたら子ごと落とす。起こせなかった・落とした、は exit -1 と理由で返す</summary>
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
            using var child = Process.Start(start)!;
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            if (!child.WaitForExit(timeout)) child.Kill(entireProcessTree: true);
            return (child.ExitCode, $"{stdout.GetAwaiter().GetResult()}{stderr.GetAwaiter().GetResult()}".Trim());
        }
        catch (Exception error)
        {
            return (-1, error.Message);
        }
    }
}
