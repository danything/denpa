namespace Denpa.Agent.Tests;

/*
 * 止めるときの手順 (Program.cs の StopSteps)。ApplicationStopping・ApplicationStopped のコールバックの中で、
 * IT930x の機材を閉じる手順をほかの手順より先に通し、1 つが失敗しても残りを通す。
 */
public class StopStepsTests
{
    [Test]
    public async Task 渡した順に通し_1_つが例外を送出しても残りを通す()
    {
        var done = new List<string>();
        StopSteps.Run(
            ("IT930x の機材を閉じる", () => done.Add("it930x")),
            ("選局を離す", () => throw new InvalidOperationException("チューナーを閉じられません")),
            ("CECH-ZD1 J を閉じる", () => done.Add("zd1j")));
        await Assert.That(string.Join(" ", done)).IsEqualTo("it930x zd1j");
        var lines = Log.Recent.Snapshot().Select(line => line.Text).ToList();
        await Assert.That(lines.Any(text => text.Contains("止める手順の「選局を離す」が失敗しました") && text.Contains("チューナーを閉じられません"))).IsTrue();
    }
}
