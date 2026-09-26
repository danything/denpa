using System.Buffers.Binary;
using System.Net.Http.Headers;

namespace Denpa.Agent;

/// <summary>
/// 鍵をどこから貰うか。**プロセスで1つ**で、どのチューナーの流れもここに聞く。
///
/// <para>
/// 手元にカードがあれば自分で読み (<see cref="LocalCard"/>)、無い拠点は別の拠点に
/// ECM を投げて鍵だけ貰う (<see cref="RemoteCard"/>。<c>CARD_URL</c>)。
/// </para>
/// </summary>
public static class Keys
{
    /// <summary>自分に刺さっているカード。**鍵を配る口もこれを使う**</summary>
    public static LocalCard Local { get; } = new();

    private static IKeySource? _source;

    /// <summary>流れを解くときに聞く相手。<see cref="Configure"/> するまでは手元のカード</summary>
    public static IKeySource Source => _source ?? Local;

    /// <summary>CARD_URL が書いてあれば、そちらから貰う。**起動したときに1回**</summary>
    public static void Configure(string? cardUrl) =>
        _source = cardUrl is { Length: > 0 } ? new RemoteCard(cardUrl) : Local;
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
    /// (<see cref="BCas.RetryAfter"/>。何本もの流れが順番に全部のリーダーを開き直さない)
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
/// **カードを持っていない拠点。** 鍵だけ貰いに行く。
///
/// <para>
/// 拠点ごとにエージェントとチューナーがある形だと、カードは1箇所にしかない。そこで
/// **カードごと持っていくのではなく、ECM を投げて鍵を貰う。** ECM は 200 バイトほど、
/// 返るのは 16 バイトの鍵だけなので拠点を跨いでも安く、重い MULTI2 は各拠点の手元に残る。
/// </para>
///
/// <para>
/// **拠点にカードがあるならそちらが速いし、落ちない。** 配るのは「カードが
/// 無い拠点」のためのもので、既定にはしない (docs/agent.md)。
/// </para>
///
/// <para>
/// 呼ぶのは解き手のスレッドで、読み手とは別 (TunerPool.cs)。相手が遅くても
/// 間のキュー (64MB) が呑むうちは録画は欠けず、答えが来てから続きを解く。
/// </para>
/// </summary>
public sealed class RemoteCard(string url) : IKeySource
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly string _url = url.TrimEnd('/');
    private CardInit? _init;

    /// <summary>配り役の URL (画面に出す)</summary>
    public string Url => _url;

    /// <summary>素は1回貰えば変わらない。**貰えなかったら次に要ったときにまた聞く**</summary>
    public CardInit Init() => _init ?? Check();

    /// <summary>いま配り役と話せるか。**覚えている素を使わずに聞き直す** (画面の「カードリーダー」行)</summary>
    public CardInit Check()
    {
        using var response = Http.Send(new HttpRequestMessage(HttpMethod.Get, $"{_url}/denpa/card/init"));
        if (!response.IsSuccessStatusCode)
        {
            throw new IOException($"鍵を配る相手からカードの素を貰えません ({(int)response.StatusCode})");
        }
        return _init = CardWire.ReadInit(Body(response));
    }

    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{_url}/denpa/card/ecm")
        {
            Content = new ByteArrayContent(ecm.ToArray()),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        try
        {
            using var response = Http.Send(request);
            if (!response.IsSuccessStatusCode) throw new IOException($"鍵を貰えません ({(int)response.StatusCode})");
            return CardWire.ReadEcm(Body(response));
        }
        catch (HttpRequestException error)
        {
            throw new IOException($"鍵を配る相手に繋がりません: {error.Message}", error);
        }
    }

    private static byte[] Body(HttpResponseMessage response) =>
        response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
}

/// <summary>
/// 拠点のあいだで鍵をやり取りする形。**前の版のエージェントとも話せる**ように、
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
        if (body.Length < 44) throw new IOException("カードの素が短すぎます");
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
