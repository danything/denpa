using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// **鍵を配るのは LAN の中だけ。** 配る側と受け取る側の決まり (docs/agent.md「鍵を配る範囲」)。
///
/// <para>
/// B-CAS カードは受信機ごとに貸し出されるもので、拠点の外から使い回せると危ない。
/// 鍵を使えるのは同じ世帯の機器だけで、LAN の中に限るのはその近似 (Discussion #760)。
/// そこで3つ重ねる。どれも設定で変えられるが、既定は安全側で、LAN の外へは広げられない
/// (アドレスは既定の範囲の中だけ、TTL は <see cref="MaxHops"/> まで)。
/// </para>
///
/// <list type="number">
/// <item>**専用のポート** (<see cref="Port"/>)。普通の API とは分け、書かなければ開かない</item>
/// <item>**相手のアドレス** (<see cref="Networks"/>)。ループバックとプライベートアドレスだけ</item>
/// <item>**TTL** (<see cref="Hops"/>)。既定は 1 で、ルーターを越えない。配る側も受け取る側も</item>
/// </list>
///
/// <para>
/// 加えて、往復時間の上限 (<see cref="MaxRoundTrip"/>) を選べる (DTCP-IP と同じ考え。既定はオフ)。
/// </para>
/// </summary>
/// <param name="Port">鍵を配るポート (<c>CARD_SHARE_PORT</c>)。null なら配らない</param>
/// <param name="Networks">鍵を配る相手のアドレス (<c>CARD_SHARE_NETWORKS</c>)</param>
/// <param name="Hops">鍵のやり取りに使う接続の TTL / hop limit (<c>CARD_TTL</c>)</param>
/// <param name="MaxRoundTrip">往復時間の上限 (<c>CARD_SHARE_MAX_RTT</c>)。null なら測らない</param>
public sealed record CardLanPolicy(int? Port, IReadOnlyList<IPNetwork> Networks, int Hops, TimeSpan? MaxRoundTrip)
{
    /// <summary>ルーターを1つも越えない</summary>
    public const int DefaultHops = 1;

    /// <summary>
    /// <c>CARD_TTL</c> の上限。Docker のブリッジを両側で使うと 3、Kubernetes でノードをまたぐと
    /// 3〜4 要る。家の中のルーターを越える余裕を足して 8。**それより大きくは書けない** —
    /// 64 や 255 にすると、TTL で届く先を絞る意味が無くなるため (docs/agent.md「鍵を配るのは LAN の中だけ」)
    /// </summary>
    public const int MaxHops = 8;

    /// <summary>
    /// ループバックと、LAN の中でだけ使うアドレス (RFC 1918・IPv6 の ULA とリンクローカル)。
    /// **CGNAT (100.64.0.0/10) は入れない** — Tailscale などは拠点の外を同じ網に見せる。
    /// <c>CARD_SHARE_NETWORKS</c> に書けるのもこの中の範囲だけ (狭めることはできても、外へは広げられない)
    /// </summary>
    public static IReadOnlyList<IPNetwork> DefaultNetworks { get; } =
    [
        IPNetwork.Parse("127.0.0.0/8"),
        IPNetwork.Parse("10.0.0.0/8"),
        IPNetwork.Parse("172.16.0.0/12"),
        IPNetwork.Parse("192.168.0.0/16"),
        IPNetwork.Parse("::1/128"),
        IPNetwork.Parse("fc00::/7"),
        IPNetwork.Parse("fe80::/10"),
    ];

    public static CardLanPolicy FromEnvironment() => Parse(Environment.GetEnvironmentVariable);

    /// <summary>
    /// 環境変数から読む。**読めない値は既定に戻さずに断る** — 書き間違えた範囲を黙って
    /// 広げたり狭めたりしない (起動時に理由を出して止まる)
    /// </summary>
    /// <exception cref="ArgumentException">値が読めない</exception>
    public static CardLanPolicy Parse(Func<string, string?> env)
    {
        int? port = null;
        if (Given(env("CARD_SHARE_PORT")) is { } portText)
        {
            if (!int.TryParse(portText, CultureInfo.InvariantCulture, out var value) || value is < 1 or > 65535)
            {
                throw new ArgumentException($"CARD_SHARE_PORT はポート番号 (1〜65535) で書きます (いまは「{portText}」)");
            }
            port = value;
        }

        var networks = DefaultNetworks;
        if (Given(env("CARD_SHARE_NETWORKS")) is { } networksText)
        {
            networks = [.. networksText.Split([',', ' ', '\t', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(Network)];
            if (networks.Count == 0) throw new ArgumentException("CARD_SHARE_NETWORKS に範囲が1つもありません");
            // IPNetwork は struct なので、FirstOrDefault では「無い」が 0.0.0.0/0 になる。null にできる形で探す
            if (networks.Where(network => !Inside(network)).Cast<IPNetwork?>().FirstOrDefault() is { } outside)
            {
                throw new ArgumentException(
                    $"CARD_SHARE_NETWORKS の「{outside}」は LAN の外を含みます。鍵は同じ世帯の機器にだけ配るので、"
                    + $"{string.Join("・", DefaultNetworks)} の中の範囲だけを書けます");
            }
        }

        var hops = DefaultHops;
        if (Given(env("CARD_TTL")) is { } hopsText)
        {
            if (!int.TryParse(hopsText, CultureInfo.InvariantCulture, out hops) || hops is < 1 or > MaxHops)
            {
                throw new ArgumentException($"CARD_TTL は 1〜{MaxHops} で書きます (いまは「{hopsText}」)");
            }
        }

        TimeSpan? maxRoundTrip = null;
        if (Given(env("CARD_SHARE_MAX_RTT")) is { } rttText)
        {
            if (!double.TryParse(rttText, NumberStyles.Float, CultureInfo.InvariantCulture, out var ms) || ms < 0 || !double.IsFinite(ms))
            {
                throw new ArgumentException($"CARD_SHARE_MAX_RTT はミリ秒の数で書きます (いまは「{rttText}」)");
            }
            if (ms > 0) maxRoundTrip = TimeSpan.FromMilliseconds(ms);
        }

        return new CardLanPolicy(port, networks, hops, maxRoundTrip);
    }

    private static string? Given(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// 範囲がまるごと既定の範囲 (<see cref="DefaultNetworks"/>) のどれかに収まるか。同じ種類のアドレスで、
    /// 既定と同じかより狭く (接頭辞が長い)、先頭のアドレスが既定の中にあれば収まる。
    /// **IPv4 射影の範囲 (::ffff:0:0/96 など) は書けない** — 相手のアドレスは IPv4 に直して比べるので
    /// 当たることが無く、IPNetwork.Contains の射影の扱いにも頼らない (アドレス1つなら IPv4 に直して読む)。
    /// 比べるのはビット列そのもの
    /// </summary>
    public static bool Inside(IPNetwork network)
    {
        var address = network.BaseAddress;
        if (address.IsIPv4MappedToIPv6) return false;
        var bytes = address.GetAddressBytes();
        return DefaultNetworks.Any(allowed =>
            allowed.BaseAddress.AddressFamily == address.AddressFamily
            && network.PrefixLength >= allowed.PrefixLength
            && SamePrefix(allowed.BaseAddress.GetAddressBytes(), bytes, allowed.PrefixLength));
    }

    /// <summary>先頭の <paramref name="bits"/> ビットが同じか</summary>
    private static bool SamePrefix(byte[] a, byte[] b, int bits)
    {
        for (var i = 0; i < bits / 8; i++)
        {
            if (a[i] != b[i]) return false;
        }
        var rest = bits % 8;
        if (rest == 0) return true;
        var mask = (byte)(0xFF << (8 - rest));
        return (a[bits / 8] & mask) == (b[bits / 8] & mask);
    }

    /// <summary><c>10.0.0.0/8</c> の形か、アドレス1つ (<c>192.168.1.20</c>)</summary>
    private static IPNetwork Network(string text)
    {
        if (text.Contains('/'))
        {
            if (IPNetwork.TryParse(text, out var network)) return network;
        }
        else if (IPAddress.TryParse(text, out var address))
        {
            address = Plain(address);
            return new IPNetwork(address, address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128);
        }
        throw new ArgumentException(
            $"CARD_SHARE_NETWORKS の「{text}」が読めません。10.0.0.0/8 のような範囲か、アドレス1つをカンマで区切って書きます");
    }

    /// <summary>
    /// 配ってよい相手か。**断るなら理由を返す。** 往復時間は上限を決めたときだけ見る
    /// (<paramref name="roundTrip"/> は測れなければ null。上限があって測れなければ断る)
    /// </summary>
    public CardRefusal? Refuse(IPAddress? remote, TimeSpan? roundTrip)
    {
        if (remote is null) return new CardRefusal("CARD_SHARE_NETWORKS", "相手のアドレスが分からないので、鍵を配りません");
        var address = Plain(remote);
        if (!Networks.Any(network => network.Contains(address)))
        {
            return new CardRefusal(
                "CARD_SHARE_NETWORKS", $"{address} は鍵を配る範囲 (CARD_SHARE_NETWORKS) の外です。鍵は LAN の中にだけ配ります");
        }

        if (MaxRoundTrip is not { } max) return null;
        if (roundTrip is not { } measured) return new CardRefusal("CARD_SHARE_MAX_RTT", "往復時間を測れないので、鍵を配りません");
        if (measured > max)
        {
            return new CardRefusal(
                "CARD_SHARE_MAX_RTT", $"往復に {Ms(measured)} 掛かっています。往復 {Ms(max)} までの相手にだけ鍵を配ります");
        }
        return null;
    }

    /// <summary>
    /// 比べる形に揃える。**IPv4 射影アドレス (::ffff:192.168.1.2) は IPv4 として**見る —
    /// そのままだと IPv4 の範囲に入らず、IPv6 の範囲 (::/0 など) には入ってしまう。スコープ (%eth0) は外す
    /// </summary>
    public static IPAddress Plain(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) return address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.ScopeId != 0) return new IPAddress(address.GetAddressBytes());
        return address;
    }

    private static string Ms(TimeSpan span) => $"{span.TotalMilliseconds.ToString("0.###", CultureInfo.InvariantCulture)}ms";
}

/// <summary>断った理由。<paramref name="Rule"/> はどの決まりか (設定の名前)</summary>
public sealed record CardRefusal(string Rule, string Message);

/// <summary>鍵をやり取りするソケットの細工。TTL と往復時間</summary>
public static class CardLan
{
    /// <summary>
    /// TTL (IPv6 は hop limit) を <paramref name="hops"/> にする。**効いたかを読み直して確かめ、
    /// 効いていなければ投げる** (黙って遠くまで届くより、繋がらないほうがいい)。
    /// IPv6 のソケットで IPv4 の相手と繋がっている (IPv4 射影) なら、効くのは IPv4 の TTL なのでそちらも
    /// </summary>
    /// <exception cref="IOException">設定できない・読み直すと違う</exception>
    public static void LimitHops(Socket socket, int hops)
    {
        switch (socket.AddressFamily)
        {
            case AddressFamily.InterNetwork:
                socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.IpTimeToLive, hops);
                break;
            case AddressFamily.InterNetworkV6:
                // IPv6 の IpTimeToLive は IPV6_UNICAST_HOPS (Socket.Ttl と同じ)
                socket.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.IpTimeToLive, hops);
                /*
                 * **DualMode では決めない。** macOS では IPv6 だけで受けた接続でも DualMode が立って見え、
                 * そこへ IPv4 の TTL を付けると EINVAL で断られる (CI で実際に起きた)
                 */
                if (MappedIPv4(socket)) socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.IpTimeToLive, hops);
                break;
            default:
                throw new IOException($"{socket.AddressFamily} のソケットには TTL を付けられません");
        }

        var actual = Hops(socket);
        if (actual != hops) throw new IOException($"TTL を {hops} にできません (読み直すと {actual})");
    }

    /// <summary>いまの TTL (IPv6 は hop limit。IPv4 射影で繋がっていれば IPv4 の TTL)</summary>
    public static int Hops(Socket socket) => (int)socket.GetSocketOption(
        socket.AddressFamily == AddressFamily.InterNetworkV6 && !MappedIPv4(socket) ? SocketOptionLevel.IPv6 : SocketOptionLevel.IP,
        SocketOptionName.IpTimeToLive)!;

    private static bool MappedIPv4(Socket socket) =>
        socket.AddressFamily == AddressFamily.InterNetworkV6 && socket.Connected
        && socket.RemoteEndPoint is IPEndPoint { Address.IsIPv4MappedToIPv6: true };

    /// <summary>
    /// 鍵を配るポートの待ち受け。**IPv4 と IPv6 を別々のソケットで**受ける — 両方を1つで受けると
    /// IPv4 の相手には IPv6 の hop limit ではなく IPv4 の TTL が効き、OS によってはそれを付けられない。
    /// 待ち受けにも TTL を付けておくと、SYN-ACK からルーターを越えない
    /// </summary>
    public static Socket Listen(IPEndPoint endpoint, int hops)
    {
        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            if (endpoint.AddressFamily == AddressFamily.InterNetworkV6) socket.DualMode = false;
            LimitHops(socket, hops);
            socket.Bind(endpoint);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>
    /// 受け取る側の接続。**繋ぐ前に TTL を付ける** (SYN からルーターを越えない)。
    /// 名前が複数のアドレスを返せば順に試す
    /// </summary>
    public static async ValueTask<Stream> Connect(DnsEndPoint target, int hops, CancellationToken cancel)
    {
        var host = target.Host.Trim('[', ']');
        var addresses = IPAddress.TryParse(host, out var literal) ? new[] { literal } : await Dns.GetHostAddressesAsync(host, cancel);
        Exception? failure = null;
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                LimitHops(socket, hops);
                await socket.ConnectAsync(new IPEndPoint(address, target.Port), cancel);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (SocketException error)
            {
                socket.Dispose();
                failure = error;
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
        throw failure ?? new SocketException((int)SocketError.HostNotFound);
    }

    /// <summary>
    /// TCP の往復時間を **OS から**読む (カーネルが ACK から測っている平滑化した値)。
    /// 相手が遅らせて大きく見せることはできても、小さく見せることはできない。
    /// 測れなければ null (まだ1回も測っていない・OS が教えない)
    /// </summary>
    public static TimeSpan? RoundTrip(Socket socket)
    {
        try
        {
            Span<byte> info = stackalloc byte[256];
            if (OperatingSystem.IsLinux())
            {
                // struct tcp_info の tcpi_rtt (µs)。0 はまだ測っていない (測れば 1µs 以上になる)
                var length = socket.GetRawSocketOption(IpProtoTcp, LinuxTcpInfo, info);
                if (length < 72) return null;
                var us = MemoryMarshal.Read<uint>(info[68..]);
                return us == 0 ? null : TimeSpan.FromMicroseconds(us);
            }
            if (OperatingSystem.IsMacOS())
            {
                // struct tcp_connection_info の tcpi_srtt (ms)。刻みが 1ms なので、0 は「1ms 未満」として扱う
                // (受けた側も SYN-ACK への ACK から測るので、たいていは繋がった時点で測ってある)
                var length = socket.GetRawSocketOption(IpProtoTcp, MacTcpConnectionInfo, info);
                if (length < 48) return null;
                return TimeSpan.FromMilliseconds(MemoryMarshal.Read<uint>(info[44..]));
            }
            if (OperatingSystem.IsWindows())
            {
                // SIO_TCP_INFO で TCP_INFO_v0 (88 バイト) を読む。RttUs (µs) は 20 バイト目から。0 はまだ測っていない
                var output = new byte[88];
                if (socket.IOControl(WindowsSioTcpInfo, BitConverter.GetBytes(0), output) < 24) return null;
                var rtt = BitConverter.ToUInt32(output, 20);
                return rtt == 0 ? null : TimeSpan.FromMicroseconds(rtt);
            }
        }
        catch (Exception error) when (error is SocketException or PlatformNotSupportedException or NotSupportedException)
        {
            return null;
        }
        return null;
    }

    private const int IpProtoTcp = 6;
    private const int LinuxTcpInfo = 11;
    private const int MacTcpConnectionInfo = 0x106;
    private const int WindowsSioTcpInfo = unchecked((int)0xD8000027);
}
