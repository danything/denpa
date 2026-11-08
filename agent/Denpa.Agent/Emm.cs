using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// 契約の更新 (EMM) の受け口。**プロセスで 1 つ**で、どの選局の <see cref="Descrambler"/> もここに渡す
/// (docs/agent.md「契約の更新 (EMM) もカードに渡す」)。
///
/// <para>
/// **自分宛てかどうかは、復号のスレッドの中で決める** (<see cref="Section"/>)。EMM はカード ID ごとに並んでいて、
/// CS では 1 秒に 1,200 件ほど流れる。ペイロードの先頭 6 バイトをカードの番号 (<see cref="CardInit.Ids"/>。個別とグループ) と
/// 比べるだけにして、確保もハッシュもしない。合ったものだけを順番待ちに入れる。
/// </para>
///
/// <para>
/// **カードに送るのは作業スレッド 1 本だけ** (<see cref="IKeySource.Emm"/>)。手元のカードなら ECM・契約確認と同じロック
/// (<see cref="BCas"/>) を通るので、カードに同時に 2 つ送らない。復号のスレッドは EMM の答えを待たない。
/// </para>
///
/// <para>
/// 同じ EMM は受信期間の間くり返し流れる。カードが答えたもの (<c>0x2100</c>・<c>0xA102</c>・<c>0xA107</c>) は
/// バイト列のハッシュで 256 件まで覚え、もう送らない。カードと話せなかったものは覚えず、次に流れてきたら送り直す。
/// 順番待ちは 16 件で、溢れたら新しいほうを捨てる (次のくり返しで来る)。カードに送るのは 1 秒に 1 件まで。
/// </para>
/// </summary>
/// <param name="source">送る相手。送るたびに引く (<see cref="Keys.Source"/>)</param>
/// <param name="accepted">カードが受け入れた (<c>0x2100</c>) ときに呼ぶ (<see cref="CardNotice"/>)</param>
public sealed class Emm(Func<IKeySource> source, TimeProvider? clock = null, Action? accepted = null)
{
    private static readonly Lazy<Emm> _shared = new(() =>
    {
        var emm = new Emm(() => Keys.Source, accepted: () => CardNotice.Shared?.Accepted());
        emm.Start();
        return emm;
    });

    /// <summary>プロセスで 1 つの受け口。初めて使うときに作業スレッドを起こす (<see cref="TunerPool"/> の選局だけが使う)</summary>
    public static Emm Shared => _shared.Value;

    /// <summary>カードの返り値。正常終了</summary>
    public const int Accepted = 0x2100;

    /// <summary>ペイロードの最短 (カード ID 6・関連情報バイト長 1・プロトコル番号 1・事業体識別 1・更新番号 2・有効期限 2)</summary>
    public const int MinPayload = 13;

    /// <summary>ペイロードの最長。Lc は 1 バイトなので、これを超えるものはカードに送れない</summary>
    public const int MaxPayload = 255;

    private const int QueueLimit = 16;
    private const int RememberLimit = 256;
    private static readonly TimeSpan SendEvery = TimeSpan.FromSeconds(1);

    /// <summary>作業スレッドが何もせずに待つ長さ。番号の取り直し (<see cref="BCas.RetryAfter"/>) と 1 秒 1 件の間隔はこの粒で見る</summary>
    private static readonly TimeSpan Idle = TimeSpan.FromMilliseconds(500);

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly Lock _gate = new();
    private readonly SemaphoreSlim _signal = new(0);

    private long[]? _ids;
    private int _wantIds;
    private DateTimeOffset _idsFailedAt = DateTimeOffset.MinValue;

    private readonly Queue<(byte[] Payload, string Hash)> _queue = new();
    /// <summary>順番待ちと、いま送っているもの。送り終えるまで同じものを入れない</summary>
    private readonly HashSet<string> _queued = [];
    /// <summary>カードが答えたもの。古いものから捨てる</summary>
    private readonly HashSet<string> _answered = [];
    private readonly Queue<string> _answeredOrder = new();
    private DateTimeOffset _lastSend = DateTimeOffset.MinValue;
    private string? _logged;

    /// <summary>比べるカードの番号。まだ取れていなければ空</summary>
    internal long[]? Ids => Volatile.Read(ref _ids);

    /// <summary>
    /// CRC の合った EMM セクション (table_id <c>0x84</c>) を 1 つ受ける。**復号のスレッドから呼ぶ。カードには触らない。**
    ///
    /// <para>
    /// ペイロードは「カード ID 6・関連情報バイト長 1・…」の並びで、1 つの長さは関連情報バイト長 + 7 (ARIB STD-B25 表 3-2)。
    /// はみ出したペイロードがあれば、そのセクションの残りを捨てる (libaribb25 の <c>proc_emm</c> と同じ)。
    /// カードの番号がまだ無ければ作業スレッドに取らせ、このセクションは捨てる
    /// </para>
    /// </summary>
    public void Section(ReadOnlySpan<byte> section)
    {
        var ids = Volatile.Read(ref _ids);
        if (ids is null)
        {
            if (Interlocked.Exchange(ref _wantIds, 1) == 0) _signal.Release();
            return;
        }
        var tail = section.Length - 4;
        for (var head = 8; head + MinPayload <= tail;)
        {
            var length = section[head + 6] + 7;
            if (head + length > tail) return;
            var payload = section.Slice(head, length);
            if (Addressed(payload, ids)) Offer(payload);
            head += length;
        }
    }

    /// <summary>ペイロードのカード ID (先頭 6 バイトを 48 ビットの数として読む) が、番号のどれかと合うか。確保しない</summary>
    internal static bool Addressed(ReadOnlySpan<byte> payload, long[] ids)
    {
        var id = 0L;
        for (var at = 0; at < 6; at++) id = (id << 8) | payload[at];
        foreach (var known in ids)
        {
            if (known == id) return true;
        }
        return false;
    }

    /// <summary>自分宛てのペイロード。まだ答えを貰っていなければ順番待ちに入れる。長すぎるものはカードに送れないので入れない</summary>
    internal void Offer(ReadOnlySpan<byte> payload)
    {
        if (payload.Length > MaxPayload) return;
        var hash = Convert.ToHexString(SHA256.HashData(payload));
        lock (_gate)
        {
            if (_answered.Contains(hash) || _queued.Contains(hash) || _queue.Count >= QueueLimit) return;
            _queue.Enqueue((payload.ToArray(), hash));
            _queued.Add(hash);
        }
        _signal.Release();
    }

    /// <summary>作業スレッドを起こす (<see cref="Shared"/> が 1 回だけ呼ぶ。テストは止める合図を渡す)</summary>
    public void Start(CancellationToken stop = default)
    {
        var worker = new Thread(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    if (!Step()) _signal.Wait(Idle, stop);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception error)
                {
                    Note($"契約の更新 (EMM) を渡す処理が失敗しました ({error.Message})");
                    Thread.Sleep(Idle);
                }
            }
        })
        {
            IsBackground = true,
            Name = "emm",
        };
        worker.Start();
    }

    /// <summary>
    /// 作業スレッドの 1 回分。番号が要れば取り、1 秒に 1 件までペイロードを 1 つカードに送る。送ろうとしたら true
    /// </summary>
    internal bool Step()
    {
        var now = _clock.GetUtcNow();
        if (Volatile.Read(ref _wantIds) == 1 && now - _idsFailedAt >= BCas.RetryAfter) Refresh(now);

        (byte[] Payload, string Hash) item;
        lock (_gate)
        {
            if (_queue.Count == 0 || now - _lastSend < SendEvery) return false;
            item = _queue.Dequeue();
            _lastSend = now;
        }
        try
        {
            Send(item.Payload, item.Hash, now);
        }
        finally
        {
            lock (_gate) _queued.Remove(item.Hash);
        }
        return true;
    }

    /// <summary>カードの番号を取る。取れなければ <see cref="BCas.RetryAfter"/> のあいだは取らず、その間の EMM は捨てる</summary>
    private void Refresh(DateTimeOffset now)
    {
        try
        {
            Volatile.Write(ref _ids, source().Init().Ids);
            Volatile.Write(ref _wantIds, 0);
        }
        catch (Exception error)
        {
            _idsFailedAt = now;
            Note($"カードの番号を取れないため、契約の更新 (EMM) を渡せません ({error.Message})");
        }
    }

    private void Send(byte[] payload, string hash, DateTimeOffset now)
    {
        var card = source();
        /*
         * **送る直前に番号を取り直して選び直す。** カードを替えていたら、古い番号で選んだものは送らない。
         * 手元のカードは繋ぎ直すと INT・IDI からやり直すので、そのとき番号も替わる
         */
        long[] ids;
        try
        {
            ids = card.Init().Ids;
            Volatile.Write(ref _ids, ids);
        }
        catch (Exception error)
        {
            Volatile.Write(ref _ids, null);
            Volatile.Write(ref _wantIds, 1);
            _idsFailedAt = now;
            Note($"カードの番号を取れないため、契約の更新 (EMM) を渡せません ({error.Message})");
            return;
        }
        if (!Addressed(payload, ids)) return;

        int code;
        try
        {
            code = card.Emm(payload);
        }
        catch (NotSupportedException)
        {
            // 配り役が古い。記録には RemoteCard が 1 回だけ出している
            return;
        }
        catch (Exception error)
        {
            // 覚えない。次に流れてきたら送り直す
            Note($"契約の更新 (EMM) をカードに渡せません ({error.Message})");
            return;
        }
        if (code is Accepted or 0xA102 or 0xA107)
        {
            lock (_gate) Remember(hash);
        }
        _logged = null;
        if (code != Accepted)
        {
            Log.Write($"カードが契約の更新 (EMM) を受け入れませんでした (返り値 0x{code:X4})");
            return;
        }
        Log.Write("カードが契約の更新 (EMM) を受け入れました");
        accepted?.Invoke();
    }

    /// <summary><see cref="_gate"/> を握ったまま呼ぶ</summary>
    private void Remember(string hash)
    {
        if (!_answered.Add(hash)) return;
        _answeredOrder.Enqueue(hash);
        if (_answeredOrder.Count > RememberLimit) _answered.Remove(_answeredOrder.Dequeue());
    }

    /// <summary>同じ失敗を続けて記録に出さない</summary>
    private void Note(string message)
    {
        if (_logged == message) return;
        _logged = message;
        Log.Write(message);
    }

    /// <summary>
    /// 配り役 (<c>CARD_SHARE_PORT</c>) が別の拠点から受けた EMM を手元のカードに渡す (CardShareServer.cs)。
    /// 受け入れたら自分の denpa にも知らせる (その denpa もこのカードの契約を確かめ直せるように)
    /// </summary>
    internal static int Forwarded(IKeySource card, byte[] payload, Action? accepted)
    {
        var code = card.Emm(payload);
        if (code == Accepted)
        {
            Log.Write("別の拠点から渡された契約の更新 (EMM) を、カードが受け入れました");
            accepted?.Invoke();
        }
        return code;
    }

    /// <summary>配り役が受けた EMM の長さを確かめる。おかしければ 400 で返す理由</summary>
    internal static string? Problem(byte[]? body) => body switch
    {
        null => $"EMM が長すぎます ({MaxPayload} バイトまで)",
        { Length: 0 } => "EMM が入っていません",
        { Length: < MinPayload } => $"EMM が短すぎます ({MinPayload} バイト以上)",
        _ => null,
    };
}

/// <summary>
/// カードが契約の更新 (EMM) を受け入れたことを denpa に知らせる (<c>/denpa/events</c> の <c>card</c>)。
/// denpa はこれを受けて契約を確かめ直す。**1 分に 1 回まで** (続けて受け入れても denpa は 10 秒置いてから 1 回だけ確かめ直す)
/// </summary>
public sealed class CardNotice(Action emit, TimeProvider? clock = null)
{
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(1);

    /// <summary>プロセスで 1 つ。起動したときに通知につなぐ (Program.cs)</summary>
    public static CardNotice? Shared { get; set; }

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly Lock _gate = new();
    private DateTimeOffset _last = DateTimeOffset.MinValue;

    public void Accepted()
    {
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            if (now - _last < Every) return;
            _last = now;
        }
        emit();
    }
}
