using System.Buffers.Binary;
using System.Collections.Concurrent;

namespace Denpa.Agent;

/// <summary>
/// 手元の B-CAS カード。**カードに送る APDU はここで組み立てる。**
///
/// <para>
/// 使うコマンドは3つ。初期設定条件 (INT, <c>90 30</c>) で鍵を作るための定数を、
/// カード ID 情報 (IDI, <c>90 32</c>) でカードの番号を、ECM 受信 (<c>90 34</c>) で
/// スクランブル鍵を貰う。**応答の読み方は libaribb25 と同じにしてある** —
/// 番号の出し方も鍵の順も、前と同じ値が出ないと画面の番号が変わって見える。
/// </para>
///
/// <para>
/// **1枚のカードを全部のチューナーで使い回す。** カードに触るのは順番に
/// (<see cref="_gate"/>)。カードに聞くのは ECM の中身が変わったとき (鍵が変わるとき) だけなので、待たされても僅か。
/// </para>
///
/// <para>
/// **線が切れたら繋ぎ直す。** カードを抜き差しした・リーダーを挿し直した・
/// px4d を起こし直した、のどれでも、次の ECM で探し直して INT からやり直す。
/// 1回繋ぎ直して駄目なら理由を添えて投げる。
/// </para>
/// </summary>
public sealed class BCas : IKeySource, IDisposable
{
    /// <summary>INT の応答はこれより短ければ読まない (SW1 SW2 込み)</summary>
    private const int InitLength = 57;

    /// <summary>IDI の応答の最短 (SW1 SW2 込み)</summary>
    private const int IdLength = 19;

    /// <summary>ECM の応答の最短 (SW1 SW2 込み)</summary>
    private const int EcmLength = 25;

    /// <summary>INT が「正常」のときの返り値</summary>
    private const int InitOk = 0x2100;

    /// <summary>
    /// ECM の応答が短かったときに**同じ線で**送り直す回数。libaribb25 と同じ 2 回。
    /// カードがたまに短く返すことがあり、繋ぎ直すまでもなく次は通る
    /// </summary>
    private const int ShortRetries = 2;

    /// <summary>鍵が変わる周期より短くする。長く持つと古い鍵を配る</summary>
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(3);

    /// <summary>
    /// 繋ぎ直しに失敗したら、**この間は探さずに同じ理由で断る。**
    ///
    /// <para>
    /// 探すのはリーダーを全部開いて電源を入れ直すことで、固まったリーダーだと
    /// 数十秒かかる。ECM は何本もの流れから数秒ごとに来るので、そのたびに探すと
    /// 錠の前に全部の流れが並ぶ。カードを挿し直したなら 10 秒後には読める
    /// </para>
    /// </summary>
    public static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(10);

    private readonly Func<IReadOnlyList<CardLinkCandidate>> _find;
    private readonly TimeProvider _clock;
    private readonly Lock _gate = new();

    /// <summary>
    /// 同じ ECM には同じ鍵。**同じチャンネルを見ている流れが多いほど効く。**
    ///
    /// <para>
    /// 録画・ライブ・番組表が同じ局に居れば、同じ ECM が同じ時刻に何本も来る。
    /// カードに聞くのは最初の1本だけで、残りは錠の外で答えを持っていく。
    /// </para>
    /// </summary>
    private readonly ConcurrentDictionary<string, (EcmAnswer Answer, DateTimeOffset At)> _cache = new();

    private ICardLink? _link;
    private CardInit? _init;
    private bool _disposed;
    private (DateTimeOffset At, IOException Error)? _failed;

    private BCas(Func<IReadOnlyList<CardLinkCandidate>> find, TimeProvider clock)
    {
        _find = find;
        _clock = clock;
    }

    /// <summary>
    /// 見つかったリーダーを順に試し、**カードが刺さっていて INT に答えた最初の1つ**で開く。
    /// どれも駄目なら理由を並べて投げる。
    /// </summary>
    /// <param name="find">
    /// リーダーを探す。**繋ぎ直すたびに呼び直す** — 挿し直した USB リーダーは
    /// 前と違う場所に出るので、初めに見つけた候補を持ち回しても開けない
    /// </param>
    public static BCas Open(Func<IReadOnlyList<CardLinkCandidate>> find, TimeProvider? clock = null)
    {
        var card = new BCas(find, clock ?? TimeProvider.System);
        lock (card._gate) card.Connect();
        return card;
    }

    /// <summary>いま使っているリーダーの名前。繋がっていなければ空</summary>
    public string Name
    {
        get
        {
            lock (_gate) return _link?.Name ?? "";
        }
    }

    /// <summary>
    /// **いまカードと話せるか**、INT を1回通して確かめる (画面の「カードリーダー」行)。
    /// 切れていれば繋ぎ直し、駄目なら投げる
    /// </summary>
    public CardInit Check()
    {
        lock (_gate)
        {
            Run(Initial);
            return _init!;
        }
    }

    /// <summary>最後に繋いだときに読んだカードの素。**カードに触らない**</summary>
    public CardInit Init()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _init!;
        }
    }

    /// <summary>
    /// ECM を1つ解いて鍵を返す。
    ///
    /// <para>
    /// 渡すのは **ECM セクションの中身**: 8 バイトの見出しの後ろから、末尾の CRC32 の
    /// 手前まで (libaribb25 が <c>proc_ecm</c> に渡していたのと同じ切り方)。
    /// </para>
    ///
    /// <para>
    /// 契約が無いなどでカードが断ったときは投げずに <see cref="EcmAnswer.Code"/> で返す。
    /// 投げるのはカードと話せなかったときだけ。
    /// </para>
    /// </summary>
    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
    {
        // Lc は 1 バイト。**切り詰めて送ると別の ECM になる**ので、送らずに断る
        if (ecm.Length is < 1 or > 255) throw new IOException($"ECM の長さがおかしいです ({ecm.Length} バイト)");

        var name = Convert.ToBase64String(ecm);
        if (Cached(name) is { } hit) return hit;

        var apdu = new byte[ecm.Length + 6];
        apdu[0] = 0x90;
        apdu[1] = 0x34;
        apdu[4] = (byte)ecm.Length;
        ecm.CopyTo(apdu.AsSpan(5));

        lock (_gate)
        {
            // 待っている間に、同じ ECM を先に聞いた流れがいるかもしれない
            if (Cached(name) is { } again) return again;

            var answer = Run(link =>
            {
                var response = link.Transmit(apdu);
                for (var retry = 0; retry < ShortRetries && response.Length < EcmLength; retry++)
                {
                    response = link.Transmit(apdu);
                }
                if (response.Length < EcmLength)
                {
                    // **線は生きている。** 繋ぎ直しても同じ ECM には同じ答えなので、繋ぎ直さない
                    throw new CardRefusedException($"カードが ECM に答えません (応答 {response.Length} バイト)");
                }
                return new EcmAnswer(
                    response[6..14], response[14..22], BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(4)));
            });

            if (_cache.Count > 256) _cache.Clear();  // 溜め込まない。ECM は数秒で入れ替わる
            _cache[name] = (answer, _clock.GetUtcNow());
            return answer;
        }
    }

    private EcmAnswer? Cached(string name) =>
        _cache.TryGetValue(name, out var cached) && _clock.GetUtcNow() - cached.At < CacheFor ? cached.Answer : null;

    /// <summary>
    /// カードに1つ頼む。**線が切れていたら1回だけ繋ぎ直して頼み直す。**
    /// <see cref="_gate"/> を握ったまま呼ぶ
    /// </summary>
    private T Run<T>(Func<ICardLink, T> command)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        // 前に切れたまま (繋ぎ直しにも失敗した) なら、まずここで探し直す
        if (_link is null) Reconnect();

        try
        {
            return command(_link!);
        }
        catch (IOException first)
        {
            Log.Write($"カードとのやり取りに失敗しました。繋ぎ直します ({_link?.Name}: {first.Message})");
            Drop();
            try
            {
                Reconnect();
                return command(_link!);
            }
            catch (IOException again)
            {
                Drop();
                throw new IOException($"カードとやり取りできません ({first.Message} / 繋ぎ直しても: {again.Message})", again);
            }
        }
    }

    /// <summary>探し直す。**しくじったら <see cref="RetryAfter"/> のあいだは探さずに同じ理由で断る**</summary>
    private void Reconnect()
    {
        if (_failed is { } failed && _clock.GetUtcNow() - failed.At < RetryAfter) throw failed.Error;
        try
        {
            Connect();
            _failed = null;
        }
        catch (IOException error)
        {
            _failed = (_clock.GetUtcNow(), error);
            throw;
        }
    }

    /// <summary>
    /// リーダーを探して、カードが答えた最初の1つを掴む。INT と IDI もここで読む。
    /// **駄目だったリーダーの理由は全部残す** — 1つ目が空で2つ目が壊れている、を
    /// 「カードが読めません」の1行で済ませると、どこを見ればよいか分からない
    /// </summary>
    private void Connect()
    {
        var candidates = _find();
        if (candidates.Count == 0) throw new IOException("カードリーダーが見つかりません");

        var reasons = new List<CardsUnreadableException.Reader>();
        foreach (var candidate in candidates)
        {
            ICardLink? link = null;
            try
            {
                link = candidate.Open();
                _init = Read(link);
                _link = link;
                return;
            }
            catch (Exception error)
            {
                // 開けない・カードが無い・B-CAS ではない。どれも次のリーダーを試す
                link?.Dispose();
                reasons.Add(new(candidate.Name, error.Message, error is CardAbsentException));
            }
        }
        throw new CardsUnreadableException(reasons);
    }

    /// <summary>
    /// 開いた線でカードに電源を入れ、INT と IDI を読む。**B-CAS でなければ投げる。**
    /// 予備のリーダーを覗くのにも使う (<see cref="Card.Status"/>)
    /// </summary>
    internal static CardInit Read(ICardLink link)
    {
        link.Reset();
        var (systemKey, initCbc, caSystemId) = Initial(link);
        return new CardInit(systemKey, initCbc, caSystemId, Ids(link));
    }

    private void Drop()
    {
        try
        {
            _link?.Dispose();
        }
        catch (Exception error)
        {
            // もう切れている線を閉じようとして投げることがある。捨てるのが目的なので構わない
            Log.Write($"カードリーダーを閉じられません: {error.Message}");
        }
        _link = null;
    }

    /// <summary>
    /// INT (初期設定条件)。**返り値が 0x2100 でなければ B-CAS ではない**として断る。
    ///
    /// <para>
    /// 応答の並びは、2 バイト目からカード状態・返り値・CA_system_id・カード ID (6)・
    /// system key (32)・CBC の初期値 (8)。使うのは system key と CBC と CA_system_id。
    /// </para>
    /// </summary>
    private static (byte[] SystemKey, byte[] InitCbc, int CaSystemId) Initial(ICardLink link)
    {
        var response = link.Transmit([0x90, 0x30, 0x00, 0x00, 0x00]);
        if (response.Length < InitLength) throw new IOException($"INT の応答が短すぎます ({response.Length} バイト)");
        var code = BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(4));
        if (code != InitOk) throw new IOException($"INT を断られました (返り値 0x{code:x4}。B-CAS カードですか)");
        return (response[16..48], response[48..56], BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(6)));
    }

    /// <summary>
    /// IDI (カード ID 情報)。**番号は libaribb25 と同じ読み方。**
    ///
    /// <para>
    /// 7 バイト目が番号の数で、その後ろに 10 バイトずつ並ぶ。1つの 10 バイトのうち
    /// **3〜8 バイト目の 48 ビットを、そのまま符号なしの数として**読む
    /// (頭の 2 バイトと後ろのチェックコードは見ない)。画面にはこれを 10 進 16 桁で出す
    /// (<c>ToString("D16")</c>)。
    /// </para>
    ///
    /// <para>
    /// 並びが応答の長さを越えたら読まない。**長さには末尾の SW1 SW2 も数える** —
    /// libaribb25 がそう数えていて、そこで断ると前は出ていた番号が出なくなる。
    /// </para>
    /// </summary>
    private static long[] Ids(ICardLink link)
    {
        var response = link.Transmit([0x90, 0x32, 0x00, 0x00, 0x00]);
        if (response.Length < IdLength) throw new IOException($"IDI の応答が短すぎます ({response.Length} バイト)");

        var ids = new long[response[6]];
        for (var at = 0; at < ids.Length; at++)
        {
            var entry = 7 + at * 10;
            if (entry + 10 > response.Length) throw new IOException("IDI の応答が番号の数より短いです");
            var id = 0L;
            for (var index = 2; index < 8; index++) id = (id << 8) | response[entry + index];
            ids[at] = id;
        }
        return ids;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            Drop();
        }
    }
}

/// <summary>カードは答えたが、使える答えではなかった。**線の故障ではない**ので繋ぎ直さない</summary>
public sealed class CardRefusedException(string message) : Exception(message);
