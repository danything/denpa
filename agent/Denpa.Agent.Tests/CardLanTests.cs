using System.Net;
using System.Net.Sockets;
using System.Text;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * 鍵を配るのは LAN の中だけ (CardLan.cs)。
 *
 * アドレスの判定・設定の読み方・断ったときの文と、TTL と往復時間が本物のソケットに
 * 効くことを確かめる。ポートを分けたことと 403 の答えは適合テスト (agent/conformance.test.ts) が
 * 本物を起こして当てている。
 */
public class CardLanTests
{
    private static CardLanPolicy Read(params (string Name, string Value)[] env) =>
        CardLanPolicy.Parse(name => env.FirstOrDefault(entry => entry.Name == name).Value);

    [Test]
    public async Task 既定では配らず_TTL_は_1_で往復時間は見ない()
    {
        var policy = Read();
        await Assert.That(policy.Port).IsNull();
        await Assert.That(policy.Hops).IsEqualTo(1);
        await Assert.That(policy.MaxRoundTrip).IsNull();
        await Assert.That(policy.Networks.Select(network => network.ToString()).ToArray()).IsEquivalentTo(new[]
        {
            "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7", "fe80::/10",
        });
    }

    [Test]
    [Arguments("127.0.0.1")]
    [Arguments("10.1.2.3")]
    [Arguments("172.16.0.1")]
    [Arguments("172.31.255.254")]
    [Arguments("192.168.1.20")]
    [Arguments("::1")]
    [Arguments("fd12:3456::1")]
    [Arguments("fe80::1%2")]
    [Arguments("::ffff:192.168.1.20")]
    [Arguments("::ffff:127.0.0.1")]
    public async Task LAN_の中には配る(string address)
    {
        await Assert.That(Read().Refuse(IPAddress.Parse(address), null)).IsNull();
    }

    [Test]
    [Arguments("8.8.8.8")]
    [Arguments("172.32.0.1")]
    [Arguments("100.64.0.1")] // CGNAT (Tailscale など) は入れない
    [Arguments("169.254.1.1")]
    [Arguments("2001:db8::1")]
    [Arguments("::ffff:8.8.8.8")] // IPv4 射影でも中身は外
    [Arguments("::ffff:100.100.1.1")]
    [Arguments("64:ff9b::808:808")] // NAT64
    public async Task LAN_の外には配らない(string address)
    {
        var refusal = Read().Refuse(IPAddress.Parse(address), null);
        await Assert.That(refusal).IsNotNull();
        await Assert.That(refusal!.Rule).IsEqualTo("CARD_SHARE_NETWORKS");
        await Assert.That(refusal.Message).Contains("LAN の中にだけ");
        // 射影アドレスは IPv4 の形で出す (ログと画面で読めるように)
        await Assert.That(refusal.Message).DoesNotContain("::ffff:");
    }

    [Test]
    public async Task 相手が分からなければ配らない()
    {
        await Assert.That(Read().Refuse(null, null)).IsNotNull();
    }

    [Test]
    public async Task 範囲は狭めることも足すこともできる()
    {
        var policy = Read(("CARD_SHARE_NETWORKS", "192.168.10.0/24, 100.64.0.0/10 192.168.1.20"));
        await Assert.That(policy.Refuse(IPAddress.Parse("192.168.10.5"), null)).IsNull();
        await Assert.That(policy.Refuse(IPAddress.Parse("100.100.1.1"), null)).IsNull();
        await Assert.That(policy.Refuse(IPAddress.Parse("192.168.1.20"), null)).IsNull();
        // 既定の範囲は書いたもので置き換わる
        await Assert.That(policy.Refuse(IPAddress.Parse("192.168.1.21"), null)).IsNotNull();
        await Assert.That(policy.Refuse(IPAddress.Parse("127.0.0.1"), null)).IsNotNull();
    }

    [Test]
    public async Task 設定を読む()
    {
        var policy = Read(("CARD_SHARE_PORT", "25253"), ("CARD_TTL", "2"), ("CARD_SHARE_MAX_RTT", "7"));
        await Assert.That(policy.Port).IsEqualTo(25253);
        await Assert.That(policy.Hops).IsEqualTo(2);
        await Assert.That(policy.MaxRoundTrip).IsEqualTo(TimeSpan.FromMilliseconds(7));

        // 空や 0 は書いていないのと同じ
        var blank = Read(("CARD_SHARE_PORT", " "), ("CARD_SHARE_NETWORKS", ""), ("CARD_SHARE_MAX_RTT", "0"));
        await Assert.That(blank.Port).IsNull();
        await Assert.That(blank.Networks.Count).IsEqualTo(CardLanPolicy.DefaultNetworks.Count);
        await Assert.That(blank.MaxRoundTrip).IsNull();
    }

    [Test]
    [Arguments("CARD_SHARE_PORT", "0")]
    [Arguments("CARD_SHARE_PORT", "70000")]
    [Arguments("CARD_SHARE_PORT", "share")]
    [Arguments("CARD_SHARE_NETWORKS", "lan")]
    [Arguments("CARD_SHARE_NETWORKS", "10.0.0.0/33")]
    [Arguments("CARD_SHARE_NETWORKS", ",")]
    [Arguments("CARD_TTL", "0")]
    [Arguments("CARD_TTL", "256")]
    [Arguments("CARD_TTL", "one")]
    [Arguments("CARD_SHARE_MAX_RTT", "-1")]
    [Arguments("CARD_SHARE_MAX_RTT", "7ms")]
    public async Task 読めない値は既定に戻さずに断る(string name, string value)
    {
        var error = Assert.Throws<ArgumentException>(() => Read((name, value)));
        await Assert.That(error.Message).Contains(name);
    }

    [Test]
    public async Task 往復が上限を超える相手には配らない()
    {
        var policy = Read(("CARD_SHARE_MAX_RTT", "7"));
        var near = IPAddress.Parse("192.168.1.20");
        await Assert.That(policy.Refuse(near, TimeSpan.FromMilliseconds(0.4))).IsNull();
        await Assert.That(policy.Refuse(near, TimeSpan.FromMilliseconds(7))).IsNull();

        var far = policy.Refuse(near, TimeSpan.FromMilliseconds(12.5));
        await Assert.That(far!.Rule).IsEqualTo("CARD_SHARE_MAX_RTT");
        await Assert.That(far.Message).Contains("12.5ms");
        // 測れなければ配らない
        await Assert.That(policy.Refuse(near, null)!.Rule).IsEqualTo("CARD_SHARE_MAX_RTT");
        // 上限を決めていなければ測れなくてもよい
        await Assert.That(Read().Refuse(near, null)).IsNull();
        // 範囲の外はそもそも配らない
        await Assert.That(policy.Refuse(IPAddress.Parse("8.8.8.8"), TimeSpan.FromMilliseconds(1))!.Rule)
            .IsEqualTo("CARD_SHARE_NETWORKS");
    }

    [Test]
    public async Task 決まりをデータで出す()
    {
        var json = Read(("CARD_SHARE_PORT", "25253"), ("CARD_SHARE_MAX_RTT", "7")).ToJson();
        await Assert.That(json["port"]!.GetValue<int>()).IsEqualTo(25253);
        await Assert.That(json["ttl"]!.GetValue<int>()).IsEqualTo(1);
        await Assert.That(json["maxRtt"]!.GetValue<double>()).IsEqualTo(7);
        await Assert.That(json["networks"]!.AsArray().Count).IsEqualTo(7);
        await Assert.That(Read().ToJson()["maxRtt"]).IsNull();
    }

    [Test]
    public async Task 断られたら理由の分かる文にする()
    {
        var refused = RemoteCard.Refused(
            "http://card:25253", 403, Encoding.UTF8.GetBytes("""{"error":"203.0.113.5 は鍵を配る範囲 (CARD_SHARE_NETWORKS) の外です"}"""), "鍵");
        await Assert.That(refused).StartsWith("鍵を配る拠点に断られました: ");
        await Assert.That(refused).Contains("203.0.113.5");

        // 前の版の CARD_URL (普通の API のポート) のまま
        var old = RemoteCard.Refused("http://card:25252", 404, Encoding.UTF8.GetBytes("""{"ok":false,"error":"not found"}"""), "鍵");
        await Assert.That(old).Contains("CARD_SHARE_PORT");

        var down = RemoteCard.Refused("http://card:25253", 503, Encoding.UTF8.GetBytes("""{"error":"カードリーダーが見つかりません"}"""), "カードの情報");
        await Assert.That(down).IsEqualTo("鍵を配る拠点からカードの情報を受け取れません (503: カードリーダーが見つかりません)");
        await Assert.That(RemoteCard.Refused("http://card:25253", 502, [], "鍵")).IsEqualTo("鍵を配る拠点から鍵を受け取れません (502)");
    }

    /// <summary>待ち受けて、繋いで、受け取った側と繋いだ側のソケットを返す</summary>
    private static async Task<(Socket Listener, Socket Accepted, Socket Client)> Pair(IPAddress address, int listenHops)
    {
        var listener = CardLan.Listen(new IPEndPoint(address, 0), listenHops);
        listener.Listen();
        var client = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        var accepting = listener.AcceptAsync();
        await client.ConnectAsync(listener.LocalEndPoint!);
        return (listener, await accepting, client);
    }

    private static IEnumerable<IPAddress> Loopbacks() =>
        Socket.OSSupportsIPv6 ? new[] { IPAddress.Loopback, IPAddress.IPv6Loopback } : new[] { IPAddress.Loopback };

    [Test]
    public async Task 受けた接続に_TTL_が効く()
    {
        foreach (var address in Loopbacks())
        {
            var (listener, accepted, client) = await Pair(address, 1);
            using (listener)
            using (accepted)
            using (client)
            {
                await Assert.That(CardLan.Hops(listener)).IsEqualTo(1);
                // 鍵を配る側は受けたあとにも付け直す (CardShareServer.Accepted)
                CardLan.LimitHops(accepted, 1);
                await Assert.That(CardLan.Hops(accepted)).IsEqualTo(1);
            }
        }
    }

    [Test]
    public async Task Linux_では待ち受けの_TTL_を受けた接続が引き継ぐ()
    {
        // 付け直すので引き継がなくても困らないが、SYN-ACK から効いていることの裏付け
        if (!OperatingSystem.IsLinux()) return;
        foreach (var address in Loopbacks())
        {
            var (listener, accepted, client) = await Pair(address, 3);
            using (listener)
            using (accepted)
            using (client)
            {
                await Assert.That(CardLan.Hops(accepted)).IsEqualTo(3);
            }
        }
    }

    [Test]
    public async Task 貰いに行く接続にも_TTL_が効く()
    {
        foreach (var address in Loopbacks())
        {
            using var listener = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            listener.Bind(new IPEndPoint(address, 0));
            listener.Listen();
            var port = ((IPEndPoint)listener.LocalEndPoint!).Port;
            var host = address.AddressFamily == AddressFamily.InterNetworkV6 ? $"[{address}]" : address.ToString();
            var accepting = listener.AcceptAsync();
            await using var stream = (NetworkStream)await CardLan.Connect(new DnsEndPoint(host, port), 1, CancellationToken.None);
            using var accepted = await accepting;
            await Assert.That(CardLan.Hops(stream.Socket)).IsEqualTo(1);
        }
    }

    [Test]
    public async Task 往復時間を_OS_から読める()
    {
        var (listener, accepted, client) = await Pair(IPAddress.Loopback, 1);
        using (listener)
        using (accepted)
        using (client)
        {
            // 何度かやり取りして、カーネルに測らせる
            var buffer = new byte[1];
            for (var round = 0; round < 5; round++)
            {
                await client.SendAsync(new byte[] { 1 }.AsMemory());
                await accepted.ReceiveAsync(buffer.AsMemory());
                await accepted.SendAsync(new byte[] { 2 }.AsMemory());
                await client.ReceiveAsync(buffer.AsMemory());
            }

            var rtt = CardLan.RoundTrip(accepted);
            await Assert.That(rtt).IsNotNull();
            await Assert.That(rtt!.Value).IsLessThan(TimeSpan.FromMilliseconds(50));
        }
    }
}
