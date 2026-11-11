using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 鍵をどこから受け取るか。**プロセスで 1 つ**で、どのチューナーのストリームもここに問い合わせる。
///
/// <para>
/// 手元にカードがあれば自分で読み (<see cref="LocalCard"/>)、無い拠点は別の拠点に
/// ECM を送って鍵だけ受け取る (<see cref="RemoteCard"/>。<c>CARD_URL</c>)。
/// </para>
/// </summary>
public static class Keys
{
    /// <summary>自分に挿さっているカード。**鍵を配る API もこれを使う**</summary>
    public static LocalCard Local { get; } = new();

    private static IKeySource? _source;

    /// <summary>ストリームを復号するときに問い合わせる相手。<see cref="Configure"/> するまでは手元のカード</summary>
    public static IKeySource Source => _source ?? Local;

    /// <summary>
    /// CARD_URL が書いてあれば、そちらから受け取る。**起動したときに 1 回。**
    /// <paramref name="hops"/> は鍵を受け取る接続の TTL (<c>CARD_TTL</c>。<see cref="CardLanPolicy"/>)
    /// </summary>
    public static void Configure(string? cardUrl, int hops) =>
        _source = cardUrl is { Length: > 0 } ? new RemoteCard(cardUrl, hops) : Local;
}

/// <summary>
/// **自分に挿さっているカード。** 起動したときに開いておき (<see cref="Warm"/>)、開けなければ要ったときに探す。
///
/// <para>
/// 開けなければ投げて、次に要ったときにまた探す。カードを後から挿しても、
/// px4d が後から起動しても、エージェントを入れ直さずに読めるようになる。
/// 開いたあとの繋ぎ直しは <see cref="BCas"/> がやる。
/// </para>
/// </summary>
/// <param name="find">探すリーダー。既定は見えているもの全部 (<see cref="CardLinks.Find"/>)。<c>--tune zd1j:… --decode</c> (<c>dt295:</c>・<c>it930x:</c> も) は
/// その機材の内蔵の差し込み口だけを渡す (試験でほかの機材に触らない)</param>
/// <param name="open">カードを開く。既定は <paramref name="find"/> から探して開く (テストは偽のリーダーを開く関数を渡す)</param>
public sealed class LocalCard(Func<IReadOnlyList<CardLinkCandidate>>? find = null, Func<BCas>? open = null) : IKeySource
{
    private readonly Func<BCas> _open = open ?? (find is null ? CardLinks.Open : () => BCas.Open(find));
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
                _card = _open();
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

    /// <summary>
    /// **起動したときに開いておく。** 開くのはリーダーを探して電源を入れ、INT と IDI を読むことで、
    /// 最初の選局でこれを待つと、起動し直した直後の 1 回目だけ送り出しが 0.25〜0.45 秒遅れていた。
    ///
    /// <para>
    /// 開けなくても<b>断った記録は残さない。</b>起動の直後は px4d がまだ起動していないことがあり、
    /// 記録を残すと最初の選局が <see cref="BCas.RetryAfter"/> のあいだ探しもせずに断られる。
    /// 開けなかったときは今までどおり、要ったときに探す
    /// </para>
    /// </summary>
    public void Warm()
    {
        lock (_gate)
        {
            if (_card is not null) return;
            try
            {
                _card = _open();
                _failed = null;
                Log.Write($"カードを開きました ({_card.Name})");
            }
            catch (IOException error)
            {
                Log.Write($"カードはまだ開けません。要ったときにまた探します ({error.Message})");
            }
        }
    }

    public CardInit Init() => Card().Init();

    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => Card().Ecm(ecm);

    public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) =>
        Card().Confirm(verificationData, dateMjd);

    public int Emm(ReadOnlySpan<byte> payload) => Card().Emm(payload);

    /// <summary>いまカードとやり取りできるか。INT を 1 回通す (<see cref="BCas.Check"/>)</summary>
    public CardInit Check() => Card().Check();

    /// <summary>使っているリーダーを使わない設定にしたら手放して繋ぎ直す (<see cref="BCas.Release"/>)。開いていなければ、開けなかった記録だけ消す (次に要ったときにすぐ探す)</summary>
    public void Release(IReadOnlySet<string> names)
    {
        BCas? card;
        lock (_gate)
        {
            card = _card;
            _failed = null;
        }
        card?.Release(names);
    }
}

/// <summary>
/// **カードを持っていない拠点。** ECM を送って鍵だけ受け取る (docs/agent.md「カードは 1 枚でいい」)。
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
        // ルーターの先に置いた配る側には TTL で届かず、応答が無いまま待たされる。待ち続けずに理由を出す
        ConnectTimeout = TimeSpan.FromSeconds(5),
        ConnectCallback = (context, cancel) => CardLan.Connect(context.DnsEndPoint, hops, cancel),
    })
    {
        Timeout = TimeSpan.FromSeconds(10),
    };

    private CardInit? _init;

    /// <summary>配る側の URL (画面に出す)</summary>
    public string Url { get; } = url.TrimEnd('/');

    /// <summary>カードの定数は 1 回受け取れば変わらない。**受け取れなかったら次に要ったときにまた問い合わせる**</summary>
    public CardInit Init() => _init ?? Check();

    /// <summary>いま配る側とやり取りできるか。**保持している定数を使わずに問い合わせ直す** (画面の「カードリーダー」行)</summary>
    public CardInit Check() =>
        _init = CardWire.ReadInit(Send(new HttpRequestMessage(HttpMethod.Get, $"{Url}/denpa/card/init"), "カードの情報"));

    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => CardWire.ReadEcm(Post("ecm", ecm.ToArray(), "鍵"));

    public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd)
    {
        CardWire.CheckConfirm(verificationData);
        var payload = new byte[2 + verificationData.Length];
        BinaryPrimitives.WriteUInt16BigEndian(payload, dateMjd);
        verificationData.CopyTo(payload.AsSpan(2));
        return CardWire.ReadCode(Post("confirm", payload, "契約確認"), "契約確認");
    }

    /// <summary>配る側が <c>/denpa/card/emm</c> を持っていない (古いエージェント)。分かったら、もう送らない</summary>
    private int _emmMissing;

    /// <summary>
    /// 契約の更新 (EMM) を配る側に渡し、配る側のカードの返り値を返す (<c>POST /denpa/card/emm</c>)。
    /// **配る側が古くて 404 なら、記録に 1 回だけ出し、それからは送らずに <see cref="NotSupportedException"/> を投げる。**
    /// 鍵と契約確認はそのまま使う
    /// </summary>
    public int Emm(ReadOnlySpan<byte> payload)
    {
        if (Volatile.Read(ref _emmMissing) == 1) throw new NotSupportedException(EmmMissing);
        try
        {
            return CardWire.ReadCode(Post("emm", payload.ToArray(), "EMM の返り値"), "EMM ");
        }
        catch (ShareRefusedException error) when (error.Status == 404)
        {
            if (Interlocked.Exchange(ref _emmMissing, 1) == 0) Log.Write($"{EmmMissing} ({Url})");
            throw new NotSupportedException(EmmMissing, error);
        }
    }

    private const string EmmMissing = "鍵を配る拠点のエージェントが古く、契約の更新 (EMM) を受け取れません。鍵と契約確認はそのまま使います";

    /// <summary><c>/denpa/card/&lt;path&gt;</c> にバイト列を POST して中身を受け取る (<see cref="Send"/>)</summary>
    private byte[] Post(string path, byte[] body, string what)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return Send(new HttpRequestMessage(HttpMethod.Post, $"{Url}/denpa/card/{path}") { Content = content }, what);
    }

    /// <summary>送って中身を受け取る。**受け取れなければ、何が起きたかの分かる文で投げる**。<paramref name="request"/> はここで閉じる</summary>
    private byte[] Send(HttpRequestMessage request, string what)
    {
        using var sending = request;
        try
        {
            using var response = _http.Send(request);
            var body = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode) return body;
            throw new ShareRefusedException((int)response.StatusCode, Refused(Url, (int)response.StatusCode, body, what));
        }
        catch (HttpRequestException error)
        {
            throw new IOException(Unreachable(error), error);
        }
        catch (OperationCanceledException error)
        {
            throw new IOException("鍵を配る拠点から応答がありません。ルーターを越えた先や LAN の外には届きません (CARD_TTL)", error);
        }
    }

    /// <summary>配る側は応答したが、求めたものを返さなかった</summary>
    internal static string Refused(string url, int status, byte[] body, string what)
    {
        var reason = Reason(body);
        return status switch
        {
            403 => $"鍵を配る拠点に断られました: {reason ?? "理由は返っていません"}",
            // CARD_URL が鍵を配る API の無い所を指している。普通の API のポート (TLS だけ) なら、ここへは来ずに繋がらない
            404 => $"{url} では鍵を配っていません (404)。CARD_URL には配る側の CARD_SHARE_PORT のポートを書きます",
            _ => $"鍵を配る拠点から{what}を受け取れません ({status}{(reason is null ? "" : $": {reason}")})",
        };
    }

    /// <summary>配る側が返した <c>{"error": "…"}</c></summary>
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

/// <summary>配る側は応答したが、求めたものを返さなかった。HTTP の状態を持つ</summary>
public sealed class ShareRefusedException(int status, string message) : IOException(message)
{
    public int Status { get; } = status;
}

/// <summary>
/// 拠点のあいだで鍵をやり取りする形式。**前のバージョンのエージェントともやり取りできる**ように、
/// libaribb25 を使っていた頃と同じバイト列にしてある。
/// </summary>
public static class CardWire
{
    /// <summary>配る側が受け取る ECM の上限 (バイト。CardShareServer.cs)。カードに渡す APDU の Lc が 1 バイトなので 255 (<see cref="BCas.Ecm"/>)</summary>
    internal const int MaxEcm = 255;

    /// <summary>契約確認データの長さを確かめる (1〜253 バイト。<see cref="BCas.Confirm"/> と配る側に渡す前で同じ)</summary>
    internal static void CheckConfirm(ReadOnlySpan<byte> verificationData)
    {
        if (verificationData.Length is < 1 or > 253)
        {
            throw new IOException($"契約確認データの長さがおかしいです ({verificationData.Length} バイト)");
        }
    }

    /// <summary>
    /// 本文を <paramref name="limit"/> バイトまで読む。超えたら、その時点で読むのをやめて null。
    /// 先に全部読むと、LAN の相手が上限の何倍もの本文を溜めさせられる
    /// </summary>
    internal static async Task<byte[]?> ReadUpTo(Stream body, int limit)
    {
        var buffer = new byte[limit + 1];
        var length = 0;
        while (length < buffer.Length)
        {
            var got = await body.ReadAsync(buffer.AsMemory(length));
            if (got == 0) return buffer[..length];
            length += got;
        }
        return null;
    }

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
        if (body.Length < 18) throw new IOException("鍵の応答が短すぎます");
        return new EcmAnswer(body[..8], body[8..16], BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(16)));
    }

    /// <summary>返り値コード (BE16)。契約確認と EMM の応答はこれだけ</summary>
    public static byte[] Pack(int code)
    {
        var body = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(body, (ushort)code);
        return body;
    }

    /// <summary>契約確認と EMM の応答 (返り値の BE16)</summary>
    /// <param name="what">短すぎたときの「…の応答が短すぎます」に入れる要求の名前</param>
    public static int ReadCode(byte[] body, string what)
    {
        if (body.Length < 2) throw new IOException($"{what}の応答が短すぎます");
        return BinaryPrimitives.ReadUInt16BigEndian(body);
    }
}
