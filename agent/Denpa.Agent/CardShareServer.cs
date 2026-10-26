using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Transport.Sockets;

namespace Denpa.Agent;

/// <summary>
/// 鍵を配る API。**カードを1枚だけ置いて、LAN の中の他の拠点にも使わせる** (受け取る側は CardShare.cs)。
///
/// <para>
/// **普通の API (<c>AGENT_PORT</c>) とは別のポートで受ける** (<see cref="CardLanPolicy.Port"/>)。
/// 鍵を配るために普通の API まで開かずに済むように (普通の API も /denpa/stream が復号済みの TS を返すので、
/// 世帯の外へは出さない。docs/agent.md「エージェントは認証を持たない」)。このポートで答えるのは
/// <c>/denpa/card/init</c> と <c>/denpa/card/ecm</c> だけで、どちらも相手のアドレスと
/// (決めてあれば) 往復時間を確かめてから答える。接続には TTL を付ける (<see cref="CardLan"/>)。
/// </para>
///
/// <para>
/// **自分にカードが刺さっていなければ、503 を返すだけ。**
/// </para>
/// </summary>
internal sealed class CardShareServer(CardLanPolicy policy, int port)
{
    /// <summary>同じ相手を同じ理由で断ったログは、この間は繰り返さない (ECM は数秒おきに来る)</summary>
    private static readonly TimeSpan QuietFor = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, DateTime> _logged = new();

    public int Port => port;

    /// <summary>
    /// 待ち受けのソケットを自分で作る。**IPv4 と IPv6 を別々に、TTL を付けて** (<see cref="CardLan.Listen"/>)。
    /// 普通の API のポートは Kestrel の既定のまま
    /// </summary>
    public Socket Bind(EndPoint endpoint) =>
        endpoint is IPEndPoint ip && ip.Port == port
            ? CardLan.Listen(ip, policy.Hops)
            : SocketTransportOptions.CreateDefaultBoundListenSocket(endpoint);

    public void Listen(KestrelServerOptions options)
    {
        options.Listen(IPAddress.Any, port, listen => listen.Use(Accepted));
        if (IPv6()) options.Listen(IPAddress.IPv6Any, port, listen => listen.Use(Accepted));
    }

    /// <summary>IPv6 で待ち受けられるか。切ってあるホスト・コンテナでは IPv4 だけにする (起動ごと転ばない)</summary>
    private static bool IPv6()
    {
        if (!Socket.OSSupportsIPv6) return false;
        try
        {
            using var probe = new Socket(AddressFamily.InterNetworkV6, SocketType.Stream, ProtocolType.Tcp) { DualMode = false };
            probe.Bind(new IPEndPoint(IPAddress.IPv6Any, 0));
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    /// <summary>
    /// 受けた接続にも TTL を付け直して確かめる。**待ち受けから引き継ぐかは OS 任せにしない。**
    /// 付けられなければ、何も答えずに切る
    /// </summary>
    private ConnectionDelegate Accepted(ConnectionDelegate next) => async connection =>
    {
        var socket = connection.Features.Get<IConnectionSocketFeature>()?.Socket;
        try
        {
            if (socket is null) throw new IOException("ソケットが見えません");
            CardLan.LimitHops(socket, policy.Hops);
        }
        catch (Exception error) when (error is IOException or SocketException)
        {
            Log.Write($"鍵を配る接続に TTL {policy.Hops} を付けられないので切ります ({connection.RemoteEndPoint}): {error.Message}");
            connection.Abort();
            return;
        }

        await next(connection);
    };

    /// <summary>このポートに来たものは、普通の API には回さない</summary>
    public Task Serve(HttpContext http, RequestDelegate next) => http.Connection.LocalPort == port ? Answer(http) : next(http);

    private async Task Answer(HttpContext http)
    {
        // 受けたソケットは接続の機能として HTTP からも見える (Kestrel のソケットの transport)
        var socket = http.Features.Get<IConnectionSocketFeature>()?.Socket;
        var roundTrip = policy.MaxRoundTrip is not null && socket is not null ? CardLan.RoundTrip(socket) : null;
        if (policy.Refuse(http.Connection.RemoteIpAddress, roundTrip) is { } refusal)
        {
            Note(http.Connection.RemoteIpAddress, refusal);
            await Respond.Error(http, refusal.Message, 403);
            return;
        }

        var method = http.Request.Method;
        await (http.Request.Path.Value switch
        {
            "/denpa/card/init" when HttpMethods.IsGet(method) => Init(http),
            "/denpa/card/ecm" when HttpMethods.IsPost(method) => Ecm(http),
            _ => Respond.Error(http, "not found", 404),
        });
    }

    /// <summary>断ったことを短く残す。どこから・どの決まりで</summary>
    private void Note(IPAddress? remote, CardRefusal refusal)
    {
        var key = $"{remote}|{refusal.Rule}";
        var now = DateTime.UtcNow;
        if (_logged.TryGetValue(key, out var at) && now - at < QuietFor) return;
        // 相手を変えて何度も呼ばれても溜め込まない
        if (_logged.Count > 1000) _logged.Clear();
        _logged[key] = now;
        Log.Write($"鍵を配るのを断りました: {(remote is null ? "?" : CardLanPolicy.Plain(remote))} ({refusal.Rule}) {refusal.Message}");
    }

    private static Task Init(HttpContext http) => Reply(http, () => CardWire.Pack(Keys.Local.Check()));

    private static async Task Ecm(HttpContext http)
    {
        using var body = new MemoryStream();
        await http.Request.Body.CopyToAsync(body);
        if (body.Length is 0 or > 4096)
        {
            await Respond.Error(http, "ECM が入っていません", 400);
            return;
        }
        var ecm = body.ToArray();
        await Reply(http, () => CardWire.Pack(Keys.Local.Ecm(ecm)));
    }

    /// <summary>カードに聞いて (別のスレッドで) バイト列で返す。カードが駄目なら 503</summary>
    private static async Task Reply(HttpContext http, Func<byte[]> ask)
    {
        try
        {
            var answer = await Task.Run(ask);
            http.Response.ContentType = "application/octet-stream";
            await http.Response.Body.WriteAsync(answer);
        }
        catch (Exception error)
        {
            await Respond.Error(http, error.Message, 503);
        }
    }
}
