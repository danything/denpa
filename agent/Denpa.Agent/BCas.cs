using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 手元の B-CAS カード。**カードに送る APDU はここで組み立てる。**
///
/// <para>
/// 使うコマンドは 5 つ。初期設定条件 (INT, <c>90 30</c>) で鍵を作るための定数を、
/// カード ID 情報 (IDI, <c>90 32</c>) でカードの番号を、ECM 受信 (<c>90 34</c>) で
/// スクランブル鍵を、契約確認 (<c>90 3C</c>) で有料放送の契約の有無を受け取り、EMM 受信 (<c>90 36</c>) で
/// 契約の更新を渡す。**応答の読み方は libaribb25 と同じにしてある。**
/// 番号の出し方も鍵の順も、前と同じ値が出ないと画面の番号が変わって見える。
/// </para>
///
/// <para>
/// **1 枚のカードを全部のチューナーで使い回す。** カードに触るのは順番に
/// (<see cref="_gate"/>)。カードに問い合わせるのは ECM の中身が変わったとき (鍵が変わるとき) だけなので、待たされても僅か。
/// </para>
///
/// <para>
/// **接続が切れたら繋ぎ直す。** カードを抜き差ししても、リーダーを挿し直しても、
/// 次の ECM で探し直して INT からやり直す。
/// 1 回繋ぎ直して駄目なら理由を添えた例外を送出する。
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

    /// <summary>契約確認の応答の最短 (SW1 SW2 込み)</summary>
    private const int ConfirmLength = 8;

    /// <summary>EMM 受信の応答の最短 (SW1 SW2 込み)</summary>
    private const int EmmLength = 8;

    /// <summary>INT が「正常」のときの返り値</summary>
    private const int InitOk = 0x2100;

    /// <summary>
    /// ECM・契約確認・EMM の応答が短かったときに**同じ接続で**送り直す回数。libaribb25 と同じ 2 回。
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
    /// 数十秒かかる。ECM は何本ものストリームから数秒ごとに来るので、そのたびに探すと
    /// ロックの前に全部のストリームが並ぶ。カードを挿し直したなら 10 秒後には読める
    /// </para>
    /// </summary>
    public static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(10);

    private readonly Func<IReadOnlyList<CardLinkCandidate>> _find;
    private readonly TimeProvider _clock;
    private readonly Lock _gate = new();

    /// <summary>
    /// 同じ ECM には同じ鍵。**同じチャンネルを受信しているストリームが多いほど効く。**
    ///
    /// <para>
    /// 録画・ライブ・番組表が同じ局にいれば、同じ ECM が同じ時刻に何本も来る。
    /// カードに問い合わせるのは最初の 1 本だけで、残りはロックの外でキャッシュした鍵を使う。
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
    /// 見つかったリーダーを順に試し、**カードが挿さっていて INT に応答した最初の 1 つ**で開く。
    /// どれも駄目なら理由を並べた例外を送出する。
    /// </summary>
    /// <param name="find">
    /// リーダーを探す。**繋ぎ直すたびに呼び直す。** 挿し直した USB リーダーは
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
    /// 使っているリーダーが <paramref name="names"/> にあれば手放し、**すぐに次のリーダーで繋ぎ直す**
    /// (画面で使わない設定にしたとき。<see cref="CardChoice"/>)。繋ぎ直せなくても例外を送出しない。
    /// 次の ECM で、ふだんと同じく探し直す
    /// </summary>
    public void Release(IReadOnlySet<string> names)
    {
        lock (_gate)
        {
            if (_disposed) return;
            // 繋ぎ直しに失敗したあとなら、その記録を消して次の ECM ですぐ探し直す (壊れたリーダーを外したばかりかもしれない)
            if (_link is null)
            {
                _failed = null;
                return;
            }
            if (!names.Contains(_link.Name)) return;
            var was = _link.Name;
            Drop();
            _failed = null;
            try
            {
                Connect();
                Log.Write($"{was} を使わない設定にしたため、{_link!.Name} に切り替えました");
            }
            catch (IOException error)
            {
                _failed = (_clock.GetUtcNow(), error);
                Log.Write($"{was} を使わない設定にしました。ほかに使えるカードリーダーがありません ({error.Message})");
            }
        }
    }

    /// <summary>
    /// **いまカードとやり取りできるか**、INT を 1 回通して確かめる (画面の「カードリーダー」行)。
    /// 切れていれば繋ぎ直し、駄目なら例外を送出する
    /// </summary>
    public CardInit Check()
    {
        lock (_gate)
        {
            Run(Initial);
            return _init!;
        }
    }

    /// <summary>最後に繋いだときに読んだカードの定数。**カードに触らない**</summary>
    public CardInit Init()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _init!;
        }
    }

    /// <summary>
    /// ECM を 1 つ復号して鍵を返す。
    ///
    /// <para>
    /// 渡すのは **ECM セクションの中身**: 8 バイトの見出しの後ろから、末尾の CRC32 の
    /// 手前まで (libaribb25 が <c>proc_ecm</c> に渡していたのと同じ切り方)。
    /// </para>
    ///
    /// <para>
    /// 契約が無いなどでカードが断ったときは例外にせず、<see cref="EcmAnswer.Code"/> で返す。
    /// 例外を送出するのはカードとやり取りできなかったときだけ。
    /// </para>
    /// </summary>
    public EcmAnswer Ecm(ReadOnlySpan<byte> ecm)
    {
        // Lc は 1 バイト。**切り詰めて送ると別の ECM になる**ので、送らずに断る
        if (ecm.Length is < 1 or > CardWire.MaxEcm) throw new IOException($"ECM の長さがおかしいです ({ecm.Length} バイト)");

        var name = Convert.ToBase64String(ecm);
        if (Cached(name) is { } hit) return hit with { Cached = true };

        var apdu = new byte[ecm.Length + 6];
        apdu[0] = 0x90;
        apdu[1] = 0x34;
        apdu[4] = (byte)ecm.Length;
        ecm.CopyTo(apdu.AsSpan(5));

        var queued = Stopwatch.GetTimestamp();
        lock (_gate)
        {
            // 別のストリームがカードとのやり取りを終えるのを待った時間 (選局の内訳の記録に出す)
            var waited = (long)Stopwatch.GetElapsedTime(queued).TotalMilliseconds;
            // 待っている間に、同じ ECM を先に問い合わせたストリームがあるかもしれない
            if (Cached(name) is { } again) return again with { Cached = true, WaitedMs = waited };

            var answer = Run(link =>
            {
                var response = Transmit(link, apdu, EcmLength, " ECM ");
                return new EcmAnswer(response[6..14], response[14..22], Code(response));
            });

            if (_cache.Count > 256) _cache.Clear();  // 溜め込まない。ECM は数秒で入れ替わる
            _cache[name] = (answer, _clock.GetUtcNow());
            return answer with { WaitedMs = waited };
        }
    }

    /// <summary>
    /// 契約確認コマンド (0x90 0x3C)。
    ///
    /// <para>
    /// EIT の CA 契約情報記述子 (0xCB) に載っている verificationData と
    /// 対象日時 (MJD) をカードに渡し、返り値コード (0x0800: ティア有効など) を返す。
    /// 選局せずにカード単体でミリ秒で応答を返す。
    /// </para>
    /// </summary>
    public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd)
    {
        CardWire.CheckConfirm(verificationData);
        var apdu = new byte[verificationData.Length + 8];
        apdu[0] = 0x90;
        apdu[1] = 0x3C;
        apdu[2] = 0x00;
        apdu[3] = 0x00;
        apdu[4] = (byte)(verificationData.Length + 2);
        BinaryPrimitives.WriteUInt16BigEndian(apdu.AsSpan(5), dateMjd);
        verificationData.CopyTo(apdu.AsSpan(7));
        apdu[^1] = 0x00;

        lock (_gate) return Run(link => Code(Transmit(link, apdu, ConfirmLength, "契約確認")));
    }

    /// <summary>
    /// EMM 受信 (<c>90 36</c>)。契約の更新を 1 つカードに渡し、返り値 (<c>0x2100</c> が正常終了) を返す。
    ///
    /// <para>
    /// 渡すのは EMM セクションの中のペイロード 1 つ (カード ID から MAC まで丸ごと。libaribb25 の
    /// <c>setup_emm_receive_command</c> と同じ)。応答の返り値は ECM・契約確認と同じ 5〜6 バイト目にある。
    /// </para>
    ///
    /// <para>
    /// **受け入れたら、キャッシュした ECM の応答を捨てる。** 契約が変わると、同じ ECM でも応答が変わる
    /// (libaribb25 も EMM のあとに全部の ECM を問い合わせ直す)。
    /// </para>
    /// </summary>
    public int Emm(ReadOnlySpan<byte> payload)
    {
        // Lc は 1 バイト。切り詰めて送ると別の EMM になるので、送らずに断る
        if (payload.Length is < Denpa.Agent.Emm.MinPayload or > Denpa.Agent.Emm.MaxPayload)
            throw new IOException($"EMM の長さがおかしいです ({payload.Length} バイト)");

        var apdu = new byte[payload.Length + 6];
        apdu[0] = 0x90;
        apdu[1] = 0x36;
        apdu[4] = (byte)payload.Length;
        payload.CopyTo(apdu.AsSpan(5));

        lock (_gate)
        {
            var code = Run(link => Code(Transmit(link, apdu, EmmLength, " EMM ")));
            if (code == Denpa.Agent.Emm.Accepted) _cache.Clear();
            return code;
        }
    }

    /// <summary>
    /// 送って応答を受ける。応答が <paramref name="least"/> バイトより短ければ、**同じ接続で**送り直す (<see cref="ShortRetries"/>)。
    /// それでも短ければ断る。**接続は生きている**ので繋ぎ直さない (繋ぎ直しても同じ要求には同じ応答)
    /// </summary>
    /// <param name="what">「カードが…に応答しません」に入れる要求の名前</param>
    private static byte[] Transmit(ICardLink link, byte[] apdu, int least, string what)
    {
        var response = link.Transmit(apdu);
        for (var retry = 0; retry < ShortRetries && response.Length < least; retry++) response = link.Transmit(apdu);
        if (response.Length < least) throw new CardRefusedException($"カードが{what}に応答しません (応答 {response.Length} バイト)");
        return response;
    }

    /// <summary>ECM・契約確認・EMM の応答の返り値。どれも 5〜6 バイト目にある</summary>
    private static int Code(byte[] response) => BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(4));

    private EcmAnswer? Cached(string name) =>
        _cache.TryGetValue(name, out var cached) && _clock.GetUtcNow() - cached.At < CacheFor ? cached.Answer : null;

    /// <summary>
    /// カードに 1 つ要求を送る。**接続が切れていたら 1 回だけ繋ぎ直して送り直す。**
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

    /// <summary>探し直す。**失敗したら <see cref="RetryAfter"/> のあいだは探さずに同じ理由で断る**</summary>
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
    /// リーダーを探して、カードが応答した最初の 1 つを使う。INT と IDI もここで読む。
    /// **駄目だったリーダーの理由は全部残す。** 1 つ目が空で 2 つ目が壊れている、を
    /// 「カードが読めません」の 1 行で済ませると、どこを見ればよいか分からない
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
    /// 開いた接続でカードに電源を入れ、INT と IDI を読む。**B-CAS でなければ例外を送出する。**
    /// 予備のリーダーを確かめるのにも使う (Card.cs の Peek、Probe.cs の `--card zd1j:`・`--card dt295:`・`--card it930x:`、Dt295NativeProbe.cs)
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
            // もう切れている接続は、閉じるときに例外を送出することがある。捨てるのが目的なので構わない
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
        var code = Code(response);
        if (code != InitOk) throw new IOException($"INT を拒否されました (返り値 0x{code:x4})。B-CAS カードか確かめてください");
        return (response[16..48], response[48..56], BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(6)));
    }

    /// <summary>
    /// IDI (カード ID 情報)。**番号は libaribb25 と同じ読み方。**
    ///
    /// <para>
    /// 7 バイト目が番号の数で、その後ろに 10 バイトずつ並ぶ。1 つの 10 バイトのうち
    /// **3〜8 バイト目の 48 ビットを、そのまま符号なしの数として**読む
    /// (先頭の 2 バイトと後ろのチェックコードは見ない)。画面にはこれを 10 進 16 桁で出す
    /// (<c>ToString("D16")</c>)。
    /// </para>
    ///
    /// <para>
    /// 並びが応答の長さを越えたら読まない。**長さには末尾の SW1 SW2 も数える。**
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

/// <summary>カードは応答したが、使える応答ではなかった。**接続の故障ではない**ので繋ぎ直さない</summary>
public sealed class CardRefusedException(string message) : Exception(message);
