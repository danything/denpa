using System.Diagnostics;
using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 子プロセスの標準出力を fd として掴むところ (px4-ts / siano-ts)。
 *
 * .NET 10 の Unix ではリダイレクトした標準出力が FileStream ではない。
 * FileStream へキャストすると Specified cast is not valid で、
 * 選局の前に全チャンネルが落ちる。本物のチューナーは要らない。
 */
public class ChildTsTests
{
    [Test]
    // Windows は fd を掴まず、.NET の Stream のまま読む (ChildTs.Stdout)
    [ExcludeOn(OS.Windows)]
    public async Task Unixの標準出力でもfdを掴める()
    {
        using var process = Process.Start(new ProcessStartInfo("/bin/sleep")
        {
            ArgumentList = { "30" },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("sleep を起こせません");
        try
        {
            var stream = process.StandardOutput.BaseStream;
            if (OperatingSystem.IsLinux())
            {
                await Assert.That(stream is FileStream).IsFalse();
            }

            var handle = ChildTs.StdoutHandle(process);
            await Assert.That(handle.IsInvalid).IsFalse();
        }
        finally
        {
            if (!process.HasExited) process.Kill();
            process.WaitForExit();
        }
    }

    /// <summary>
    /// 起こして止めるのを繰り返しても fd が残らない。Process.Dispose だけでは
    /// 標準出力の pipe が閉じず、選局のたびに1本ずつ増えていた
    /// </summary>
    [Test]
    [NotInParallel]
    public async Task 起こして止めても標準出力のfdが残らない()
    {
        if (!OperatingSystem.IsLinux()) return;
        static int Fds() => Directory.GetFiles("/proc/self/fd").Length;

        var child = new ChildTs("test", "sh");
        var before = Fds();
        for (var i = 0; i < 10; i++)
        {
            // 最初の1バイトで同期したことになる。本物と同じく、書いたあとも居座る
            child.Start(
                new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", "echo x; exec sleep 30" } },
                TimeSpan.FromSeconds(5));
            child.Drop();
        }
        // 漏れていれば 10 本増える。他の片付けの揺れは数本に収まる
        await Assert.That(Fds() - before).IsLessThan(5);
    }
}
