using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * どの名前で呼ばれたら答えるか (AgentHosts.cs)。DNS リバインディングを防ぐため、
 * 攻める側が自分の名前として用意できないものだけを通す。
 *
 * 通す側の並びは、**denpa が実際にエージェントへ繋ぐときの名前を全部**入れてある
 * (TUNER_AGENT_URL の既定・chart の Service・Mac・Windows・install.sh/install.ps1 が書く値)。
 * 403 になる/ならないは agent/conformance.test.ts が本物に当てている
 */
public class AgentHostsTests
{
    [Test]
    // TUNER_AGENT_URL の既定、compose・charts/denpa の Service の名前
    [Arguments("tuner-agent:25252")]
    // 別の名前空間から Service を指す (charts/denpa-agent)
    [Arguments("tuner-agent.denpa.svc:25252")]
    [Arguments("tuner-agent.denpa.svc.cluster.local:25252")]
    [Arguments("tuner-agent.denpa.svc.cluster.local.:25252")]
    // denpa-aio・確かめるときの curl・Mac の AGENT_HOST=127.0.0.1
    [Arguments("127.0.0.1:25252")]
    [Arguments("localhost:25252")]
    [Arguments("[::1]:25252")]
    // Mac の compose.mac.yml (Docker Desktop / OrbStack)
    [Arguments("host.docker.internal:25252")]
    // Windows の install.ps1 は vEthernet の IP。LAN の IP・NodePort もここ
    [Arguments("172.29.80.1:25252")]
    [Arguments("192.168.1.5")]
    [Arguments("[fd00::5]:25252")]
    // エージェントだけ入れたとき install.sh / install.ps1 が案内する名前
    [Arguments("my-mac.local:25252")]
    [Arguments("DESKTOP-ABC123:25252")]
    // 家の中だけの名前
    [Arguments("tuner.lan")]
    [Arguments("tuner.home.arpa")]
    [Arguments("nas.internal")]
    [Arguments("denpa-agent.localhost")]
    public async Task 繋いでくる名前は通す(string host)
    {
        await Assert.That(AgentHosts.Parse(null).Allows(host)).IsTrue();
    }

    [Test]
    [Arguments("evil.example")]
    [Arguments("evil.example:25252")]
    [Arguments("127.0.0.1.nip.io:25252")]
    [Arguments("localhost.evil.example")]
    [Arguments("tuner.local.evil.example")]
    [Arguments("svc.evil.example")]
    // Service の「名前.名前空間」は外の名前と見分けられない。.svc まで書くか AGENT_ALLOWED_HOSTS に足す
    [Arguments("tuner-agent.denpa:25252")]
    // 名前が無い (HTTP/1.0)・読めない形
    [Arguments(null)]
    [Arguments("")]
    [Arguments(":25252")]
    [Arguments("[]:25252")]
    [Arguments("[evil.example]:25252")]
    [Arguments("evil example")]
    public async Task 知らない名前は通さない(string? host)
    {
        await Assert.That(AgentHosts.Parse(null).Allows(host)).IsFalse();
    }

    [Test]
    public async Task AGENT_ALLOWED_HOSTSの名前は通す_頭にドットでその下も()
    {
        var hosts = AgentHosts.Parse(" Tuner.Example.com , .tail1234.ts.net., ,");

        await Assert.That(hosts.Allows("tuner.example.com:25252")).IsTrue();
        await Assert.That(hosts.Allows("TUNER.EXAMPLE.COM.")).IsTrue();
        await Assert.That(hosts.Allows("tail1234.ts.net")).IsTrue();
        await Assert.That(hosts.Allows("agent.tail1234.ts.net:25252")).IsTrue();

        // 頭にドットが無ければ、その名前だけ
        await Assert.That(hosts.Allows("x.tuner.example.com")).IsFalse();
        await Assert.That(hosts.Allows("example.com")).IsFalse();
        await Assert.That(hosts.Allows("other.ts.net")).IsFalse();
        await Assert.That(hosts.Allows("eviltail1234.ts.net")).IsFalse();
    }

    [Test]
    public async Task 断った名前は1度だけ知らせる()
    {
        var hosts = AgentHosts.Parse(null);

        await Assert.That(hosts.FirstRefusal("evil.example")).IsTrue();
        await Assert.That(hosts.FirstRefusal("evil.example")).IsFalse();
        await Assert.That(hosts.FirstRefusal("other.example")).IsTrue();
    }
}
