using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 鍵をどこから貰うか。**プロセスで1つ**で、どのチューナーのストリームもここに聞く。
///
/// <para>
/// 手元にカードがあれば自分で読み (<see cref="LocalCard"/>)、無い拠点は別の拠点に
/// ECM を投げて鍵だけ貰う (<see cref="RemoteCard"/>。<c>CARD_URL</c>)。
/// </para>
/// </summary>
public static class Keys
{
    /// <summary>自分に刺さっているカード。**鍵を配る API もこれを使う**</summary>
    public static LocalCard Local { get; } = new();

    private static IKeySource? _source;

    /// <summary>ストリームを復号するときに聞く相手。<see cref="Configure"/> するまでは手元のカード</summary>
    public static IKeySource Source => _source ?? Local;

    /// <summary>
    /// CARD_URL が書いてあれば、そちらから貰う。**起動したときに1回。**
    /// <paramref name="hops"/> は貰いに行く接続の TTL (<c>CARD_TTL</c>。<see cref="CardLanPolicy"/>)
    /// </summary>
    public static void Configure(string? cardUrl, int hops) =>
        _source = cardUrl is { Length: > 0 } ? new RemoteCard(cardUrl, hops) : Local;
}

/// <summary>
/// **自分に刺さっているカード。** 初めて要ったときに探して開く。
///
/// <para>
/// 開けなければ投げて、次に要ったときにまた探す — カードを後から挿しても、
/// px4d が後から起きても、エージェントを入れ直さずに読めるようになる。
/// 開いたあとの繋ぎ直しは <see cref="BCas"/> がやる。
/// </para>
/// </summary>
public sealed class LocalCard : IKeySource
{
    private readonly Lock _gate = new();
    private BCas? _card;
    private (DateTime At, IOException Error)? _failed;

    /// <summary>いま使っているリーダー。開いていなければ空</summary>
    public string Name => _card?.Name ?? "";

    /// <summary>
    /// 開いたカード。**開けなかったら、しばらくは探さずに同じ理由で断る**
    /// (<see cref="BCas.RetryAfter"/>。何本ものストリームが順番に全部のリーダーを開き直さない)
    /// </summary>
    private BCas Card()
    {
        lock (_gate)
        {
            if (_card is not null) return _card;
            if (_failed is { } failed && DateTime.UtcNow - failed.At < BCas.RetryAfter) throw failed.Error;
            try
            {
                _card = CardLinks.Open();
                _failed = null;
                return _card;
            }
            catch (IOException error)
            {
                _failed = (DateTime.UtcNow, error);
                throw;
            }
        }
    }

    public CardInit Init() => Card().Init();

    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => Card().Ecm(ecm);

    /// <summary>いまカードと話せるか。INT を1回通す (<see cref="BCas.Check"/>)</summary>
    public CardInit Check() => Card().Check();
}

/// <summary>
/// **カードを持っていない拠点。** ECM を投げて鍵だけ貰いに行く (docs/agent.md「カードは1枚でいい」)。
/// 拠点にカードがあるならそちらが速いし落ちないので、既定にはしない。
///
/// <para>
/// **繋ぐのは LAN の中だけ。** 接続には TTL を付け (既定 1。<see cref="CardLan.Connect"/>)、
/// 配る側も LAN の外には配らない (<see cref="CardLanPolicy"/>)。断られたら理由を画面に出す。
/// </para>
/// </summary>
public sealed class RemoteCard(string url, int hops) : IKeySource
{
    private readonly HttpClient _http = new(new SocketsHttpHandler
    {
        // ルーターの先に置いた配り役は、TTL で SYN-ACK が戻らず黙る。待ち続けずに理由を出す
        ConnectTimeout = TimeSpan.FromSeconds(5),
        ConnectCallback = (context, cancel) => CardLan.Connect(context.DnsEndPoint, hops, cancel),
    })
    {
        Timeout = TimeSpan.FromSeconds(10),
    };

    private readonly string _url = url.TrimEnd('/');
    private CardInit? _init;

    /// <summary>配り役の URL (画面に出す)</summary>
    public string Url => _url;

    /// <summary>素は1回貰えば変わらない。**貰えなかったら次に要ったときにまた聞く**</summary>
    public CardInit Init() => _init ?? Check();

    /// <summary>いま配り役と話せるか。**覚えている素を使わずに聞き直す** (画面の「カードリーダー」行)</summary>
    public CardInit Check() =>
        _init = CardWire.ReadInit(Send(new HttpRequestMessage(HttpMethod.Get, $"{_url}/denpa/card/init"), "カードの情報"));

    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{_url}/denpa/card/ecm")
        {
            Content = new ByteArrayContent(ecm.ToArray()),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return CardWire.ReadEcm(Send(request, "鍵"));
    }

    /// <summary>送って中身を受け取る。**受け取れなければ、何が起きたかの分かる文で投げる**</summary>
    private byte[] Send(HttpRequestMessage request, string what)
    {
        try
        {
            using var response = _http.Send(request);
            var body = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode) return body;
            throw new IOException(Refused(_url, (int)response.StatusCode, body, what));
        }
        catch (HttpRequestException error)
        {
            throw new IOException(Unreachable(error), error);
        }
        catch (OperationCanceledException error)
        {
            throw new IOException("鍵を配る拠点から答えがありません。ルーターを越えた先や LAN の外には届きません (CARD_TTL)", error);
        }
    }

    /// <summary>配り役が答えたが、渡してくれなかった</summary>
    internal static string Refused(string url, int status, byte[] body, string what)
    {
        var reason = Reason(body);
        return status switch
        {
            403 => $"鍵を配る拠点に断られました: {reason ?? "理由は返っていません"}",
            // 前のバージョンの CARD_URL (普通の API のポート) のまま。鍵を配る API は専用のポートに移った
            404 => $"{url} では鍵を配っていません (404)。CARD_URL には配る側の CARD_SHARE_PORT のポートを書きます",
            _ => $"鍵を配る拠点から{what}を受け取れません ({status}{(reason is null ? "" : $": {reason}")})",
        };
    }

    /// <summary>配り役が返した <c>{"error": "…"}</c></summary>
    private static string? Reason(byte[] body)
    {
        try
        {
            return JsonNode.Parse(body)?["error"]?.GetValue<string>();
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    private static string Unreachable(HttpRequestException error)
    {
        var socket = error.InnerException as SocketException;
        return socket?.SocketErrorCode switch
        {
            SocketError.ConnectionRefused =>
                $"鍵を配る拠点に繋がりません ({error.Message})。配る側で CARD_SHARE_PORT を開いているか確かめてください",
            SocketError.TimedOut or SocketError.HostUnreachable or SocketError.NetworkUnreachable =>
                $"鍵を配る拠点に繋がりません ({error.Message})。ルーターを越えた先や LAN の外には届きません (CARD_TTL)",
            _ => $"鍵を配る拠点に繋がりません: {error.Message}",
        };
    }
}

/// <summary>
/// 拠点のあいだで鍵をやり取りする形式。**前のバージョンのエージェントとも話せる**ように、
/// libaribb25 を使っていた頃と同じバイト列にしてある。
/// </summary>
public static class CardWire
{
    /// <summary>32 バイトの system_key + 8 バイトの init_cbc + ca_system_id (BE32) + カード番号 (BE64 の並び)</summary>
    public static byte[] Pack(CardInit init)
    {
        var body = new byte[44 + init.Ids.Length * 8];
        init.SystemKey.CopyTo(body, 0);
        init.InitCbc.CopyTo(body, 32);
        BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(40), init.CaSystemId);
        for (var at = 0; at < init.Ids.Length; at++)
        {
            BinaryPrimitives.WriteInt64BigEndian(body.AsSpan(44 + at * 8), init.Ids[at]);
        }
        return body;
    }

    public static CardInit ReadInit(byte[] body)
    {
        if (body.Length < 44) throw new IOException("カードの情報が短すぎます");
        var ids = new long[(body.Length - 44) / 8];
        for (var at = 0; at < ids.Length; at++)
        {
            ids[at] = BinaryPrimitives.ReadInt64BigEndian(body.AsSpan(44 + at * 8));
        }
        return new CardInit(body[..32], body[32..40], BinaryPrimitives.ReadInt32BigEndian(body.AsSpan(40)), ids);
    }

    /// <summary>奇数鍵 8 バイト + 偶数鍵 8 バイト + 返り値 (BE16)</summary>
    public static byte[] Pack(EcmAnswer answer)
    {
        var body = new byte[18];
        answer.Odd.CopyTo(body, 0);
        answer.Even.CopyTo(body, 8);
        BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(16), (ushort)answer.Code);
        return body;
    }

    public static EcmAnswer ReadEcm(byte[] body)
    {
        if (body.Length < 18) throw new IOException("鍵の答えが短すぎます");
        return new EcmAnswer(body[..8], body[8..16], BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(16)));
    }
}
