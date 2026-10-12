using System.Diagnostics;
using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 子プロセスの標準出力を fd として使うところ (siano-ts)。
 *
 * .NET 10 の Unix ではリダイレクトした標準出力が FileStream ではない。
 * FileStream へキャストすると Specified cast is not valid で、
 * 選局の前に全チャンネルが落ちる。本物のチューナーは要らない。
 */
public class ChildTsTests
{
    [Test]
    // Windows は fd を使わず、.NET の Stream のまま読む (ChildTs.Stdout)
    [ExcludeOn(OS.Windows)]
    public async Task Unixの標準出力でもfdを使える()
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
}
