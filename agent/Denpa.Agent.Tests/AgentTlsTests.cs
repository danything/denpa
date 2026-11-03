using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;

namespace Denpa.Agent.Tests;

/*
 * denpa と組む (AgentTls.cs)。言葉 (指紋・proof) は denpa 側の TS と同じ値にならないと組めないので、
 * 決まった値で押さえる (openssl dgst -sha256 -hmac で出した値)。
 * TLS を張って当てるのは agent/conformance.test.ts
 */
public class AgentTlsTests
{
    private static readonly string A = new('a', 64);
    private static readonly string D = new('d', 64);

    private static string Fresh() => Directory.CreateTempSubdirectory("denpa-tls-").FullName;

    [Test]
    public async Task 指紋はDERのSHA256を小文字の16進で()
    {
        await Assert.That(AgentTls.FingerprintOf(Encoding.UTF8.GetBytes("hello")))
            .IsEqualTo("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    [Test]
    public async Task proofは役ごとにHMACをbase64urlで()
    {
        await Assert.That(AgentTls.Proof("token-for-test", "client", A, D)).IsEqualTo("z6PeESb_y_HVNx-B8hOdDACN033EGYtjnwWMZtIUKqQ");
        await Assert.That(AgentTls.Proof("token-for-test", "agent", A, D)).IsEqualTo("-fURODg1aztS2s1UNSJlvtKUoC-LYhgLeScEBWtY-mk");
    }

    [Test]
    public async Task 合言葉は32バイトをbase64urlで43字()
    {
        var token = AgentTls.NewToken();
        await Assert.That(token.Length).IsEqualTo(43);
        await Assert.That(token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')).IsTrue();
    }

    [Test]
    public async Task 合言葉は環境変数があればそれでファイルを作らない()
    {
        var file = Path.Combine(Fresh(), "pair-token");
        await Assert.That(AgentTls.ResolveToken(" given ", file)).IsEqualTo("given");
        await Assert.That(File.Exists(file)).IsFalse();
    }

    [Test]
    public async Task 合言葉は無ければファイルに作って次からはそれを使う()
    {
        var file = Path.Combine(Fresh(), "pair-token");
        var made = AgentTls.ResolveToken("", file);
        await Assert.That(File.ReadAllText(file).Trim()).IsEqualTo(made);
        await Assert.That(AgentTls.ResolveToken(null, file)).IsEqualTo(made);
        if (!OperatingSystem.IsWindows())
        {
            await Assert.That(File.GetUnixFileMode(file)).IsEqualTo(UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [Test]
    public async Task 組んだ相手は重ねずに足して読み直せる()
    {
        var file = Path.Combine(Fresh(), "clients");
        var clients = new PairedClients(file);
        await Assert.That(clients.Add(D)).IsTrue();
        await Assert.That(clients.Add(D)).IsFalse();
        await Assert.That(clients.Add(A)).IsTrue();
        await Assert.That(File.ReadAllLines(file)).IsEquivalentTo([A, D]);

        var again = new PairedClients(file);
        await Assert.That(again.Count).IsEqualTo(2);
        await Assert.That(again.Contains(D)).IsTrue();
        await Assert.That(File.Exists($"{file}.writing")).IsFalse();
    }

    [Test]
    public async Task 鍵と証明書は一度作ったら作り直さない()
    {
        var dir = Fresh();
        var first = AgentTls.Load(dir, "t");
        await Assert.That(first.Certificate.HasPrivateKey).IsTrue();
        await Assert.That(first.Certificate.Subject).IsEqualTo("CN=denpa-agent");
        await Assert.That(first.Fingerprint).IsEqualTo(
            AgentTls.FingerprintOf(X509Certificate2.CreateFromPem(File.ReadAllText(Path.Combine(dir, "agent.crt"))).RawData));
        var eku = first.Certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single();
        await Assert.That(eku.EnhancedKeyUsages[0].Value).IsEqualTo("1.3.6.1.5.5.7.3.1");
        await Assert.That(first.Certificate.NotAfter > DateTime.Now.AddYears(99)).IsTrue();
        await Assert.That(first.Certificate.NotBefore < DateTime.Now.AddHours(-12)).IsTrue();

        var second = AgentTls.Load(dir, "t");
        await Assert.That(second.Fingerprint).IsEqualTo(first.Fingerprint);
    }

    [Test]
    public async Task 門は組んだ相手だけ通し組んでいなければ組むAPIだけ受ける()
    {
        var tls = AgentTls.Load(Fresh(), "t");
        tls.Clients.Add(D);

        await Assert.That(tls.Decide(D, "GET", "/denpa/tuners")).IsEqualTo(AgentTls.Gate.Pass);
        await Assert.That(tls.Decide(A, "GET", "/denpa/tuners")).IsEqualTo(AgentTls.Gate.Refuse);
        await Assert.That(tls.Decide(null, "GET", "/denpa/tuners")).IsEqualTo(AgentTls.Gate.Refuse);
        await Assert.That(tls.Decide(A, "POST", "/denpa/pair")).IsEqualTo(AgentTls.Gate.Pair);
        // 自分の証明書で来た相手 (--status) も通す
        await Assert.That(tls.Decide(tls.Fingerprint, "GET", "/denpa/tuners")).IsEqualTo(AgentTls.Gate.Pass);
        // 組んだ相手からでも組む API に回す (組み直し)
        await Assert.That(tls.Decide(D, "POST", "/denpa/pair")).IsEqualTo(AgentTls.Gate.Pair);
        await Assert.That(tls.Decide(A, "GET", "/denpa/pair")).IsEqualTo(AgentTls.Gate.Refuse);
    }

    [Test]
    public async Task 合言葉から作ったproofなら組めてこちらのproofを返す()
    {
        var tls = AgentTls.Load(Fresh(), "token-for-test");
        var proof = AgentTls.Proof("token-for-test", "client", tls.Fingerprint, D);

        var result = tls.Pair(D, new JsonObject { ["client"] = D, ["proof"] = proof });

        await Assert.That(result.Status).IsEqualTo(200);
        await Assert.That(result.Proof).IsEqualTo(AgentTls.Proof("token-for-test", "agent", tls.Fingerprint, D));
        await Assert.That(tls.Clients.Contains(D)).IsTrue();
        await Assert.That(File.ReadAllText(Path.Combine(tls.Dir, "clients"))).IsEqualTo(D + "\n");
    }

    [Test]
    public async Task 組めないときは理由を付けて断り足さない()
    {
        var tls = AgentTls.Load(Fresh(), "token-for-test");
        var proof = AgentTls.Proof("token-for-test", "client", tls.Fingerprint, D);

        // 名乗りが接続の証明書と違う
        var other = tls.Pair(A, new JsonObject { ["client"] = D, ["proof"] = proof });
        await Assert.That(other).IsEqualTo(new AgentTls.PairResult(403, AgentTls.WrongClient, null));
        // 合言葉が違う
        var wrong = tls.Pair(D, new JsonObject { ["client"] = D, ["proof"] = AgentTls.Proof("other", "client", tls.Fingerprint, D) });
        await Assert.That(wrong).IsEqualTo(new AgentTls.PairResult(403, AgentTls.WrongProof, null));
        // こちらの proof を出しても組めない (役が違う)
        var reflected = tls.Pair(D, new JsonObject { ["client"] = D, ["proof"] = AgentTls.Proof("token-for-test", "agent", tls.Fingerprint, D) });
        await Assert.That(reflected.Status).IsEqualTo(403);
        // 本文が足りない
        await Assert.That(tls.Pair(D, new JsonObject { ["client"] = D }).Status).IsEqualTo(400);
        await Assert.That(tls.Pair(D, null).Status).IsEqualTo(400);

        await Assert.That(tls.Clients.Count).IsEqualTo(0);
    }
}
