using System.Buffers;
using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Denpa.Agent;

/// <summary>
/// 選局の仕方。
/// </summary>
/// <param name="StreamIds">チャンネル名から TSID を引く。衛星の選局に要る</param>
/// <param name="FakeTune">
/// **適合テスト専用。** 選局を自分で掴む代わりに、このコマンドに
/// <c>&lt;種別&gt; &lt;チャンネル&gt;</c> を足して起こし、標準出力を読む
/// (<c>tests/fake/tune.ts</c>)。環境変数 <c>FAKE_TUNE</c> からだけ入る —
/// 設定ファイルにも画面にも、コマンドを書く口は無い。
/// </param>
public sealed record TuneOptions(Func<string, int?> StreamIds, string? FakeTune = null)
{
    public static TuneOptions None => new(_ => null);
}

/// <summary>
/// チューナーの取り合い。**エージェントの本体はここ。**
///
/// <para>
/// 「誰にどのチューナーを渡すか」はここだけで決まる。
/// </para>
///
/// <list type="bullet">
/// <item>**優先度に下限が無い。** 負の値もそのまま並ぶ (丸めない)</item>
/// <item>**番組表集めが特別扱いされない。** 録画もロゴも番組表も同じ「開きたい人」で、priority だけで並ぶ</item>
/// <item>**同じ物理チャンネルなら1本で足りる。** 番組表・ロゴ・録画が同じ選局に相乗りする</item>
/// </list>
///
/// <para>
/// 選局は**自分で掴む**。B25 も自分で解き、掴んだままチャンネルだけ変える
/// (Tuning.cs / B25.cs)。
/// </para>
/// </summary>
public sealed class TunerPool(
    IReadOnlyList<TunerSpec> specs, Action onChange, TuneOptions? tune = null)
{
    private readonly TuneOptions _tune = tune ?? TuneOptions.None;

    /// <summary>誰も読まなくなってから選局を畳むまでの間</summary>
    public static readonly TimeSpan Linger = TimeSpan.FromSeconds(5);

    /// <summary>読む側が遅れてよい上限 (バイト)</summary>
    public const long MaxLag = 64L * 1024 * 1024;

    private readonly Lock _gate = new();
    private readonly Dictionary<int, Lease> _leases = [];

    /// <summary>
    /// **開きっぱなしのデバイス。チューナー1本につき1つ。**
    ///
    /// <para>
    /// ここが選局 (lease) ごとではなく**チューナーごと**なのが肝。チャンネルを
    /// 変えるたびに開き直すと、前の選局がまだ持っているデバイスを開こうとして
    /// <c>Device or resource busy</c> で落ちる。実際そうなっていて、スキャンが
    /// 1チャンネル目以降ぜんぶ落ちた (docs/agent.md)。
    /// </para>
    /// </summary>
    private readonly Dictionary<int, Held> _held = [];

    /// <summary>
    /// <see cref="_held"/> を出し入れする間の錠。**取り合い (<see cref="_gate"/>) とは別。**
    ///
    /// <para>
    /// 選局は取り合いの錠を放してからやる (<see cref="Open"/>)。そのぶん、この
    /// 入れ物には錠のかかっていない道から触られることになるので、ここで守る。
    /// 掴む/手放すだけなので、待たされるのは一瞬。
    /// </para>
    /// </summary>
    private readonly Lock _deviceGate = new();

    /// <summary>1本ぶんの実体。**閉じるのは定義が変わったときと、止めるときだけ**</summary>
    private sealed class Held(ITuneDevice device) : IDisposable
    {
        public ITuneDevice Device { get; } = device;

        /// <summary>
        /// **この1本を選局し直す間の錠。本ごとに別**なので、他の本は待たない。
        ///
        /// <para>
        /// 選局の最中に、優先度の高い要求が同じ本を取り上げることがある。
        /// その相手が続けて選局を始めると、1つのデバイスに2つの選局が同時に
        /// 入ることになるので、ここで順番にする。
        /// </para>
        /// </summary>
        public Lock Gate { get; } = new();

        /// <summary>いま合わせているところ。**同じなら選局し直さない**</summary>
        public string? Channel { get; set; }

        public void Dispose() => Device.Dispose();
    }

    private IReadOnlyList<TunerSpec> _specs = specs;

    public IReadOnlyList<TunerSpec> Tuners => _specs;

    /// <summary>自動検出で決めたのか、書いてあるものを読んだのか。画面に出す</summary>
    public bool Detected { get; set; }

    /// <summary>
    /// 機材の定義を入れ替える。**画面から書き換えたとき。**
    ///
    /// <para>
    /// 走っている選局は**そのまま続ける**。名前が変わった・消えた本のものだけ、
    /// 失敗として畳む — 掴んでいるデバイスが別物になったのに流し続けると、
    /// 何が録れているのか分からなくなる。
    /// </para>
    /// </summary>
    public void Replace(IReadOnlyList<TunerSpec> next)
    {
        lock (_gate)
        {
            var before = _specs;
            _specs = next;
            foreach (var (index, lease) in _leases.ToList())
            {
                var was = index < before.Count ? before[index].Name : null;
                var now = index < next.Count ? next[index].Name : null;
                if (was == now && now is not null) continue;
                Release(lease, "チューナーの設定が変わりました");
                // 別の機材になったかもしれない。掴み直す
                Drop(index);
            }
        }
        onChange();
    }

    public sealed class TunerBusyException(string message) : Exception(message);

    /// <summary>
    /// 選局して読み口を返す。掴めなければ <see cref="TunerBusyException"/>。
    ///
    /// <para>同じ物理チャンネルが既に開いていればそこへ混ぜる。**チューナーは増えない。**</para>
    /// </summary>
    public Sink Open(string type, string channel, int priority, string use)
    {
        int index;
        TunerSpec spec;
        Lease lease;
        Sink sink;
        /** 蹴った相手。**止まりきるのを錠の外で待つ** (下の説明) */
        Lease? kicked = null;

        lock (_gate)
        {
            foreach (var open in _leases.Values)
            {
                if (open.Type == type && open.Channel == channel) return Join(open, priority, use);
            }

            index = Pick(type, channel, priority)
                ?? throw new TunerBusyException($"{type} のチューナーに空きがありません");

            // 蹴る相手が居れば先に片付ける。同じチューナーを2つの選局が掴まないように
            if (_leases.TryGetValue(index, out var victim))
            {
                Release(victim, "優先度の高い要求に譲りました");
                kicked = victim;
            }

            spec = Tuners[index];
            lease = new Lease(index, type, channel);
            _leases[index] = lease;
            /*
             * **読み手を入れてから錠を放す。** 選局はこの下、錠の外でやるので、
             * 入れないまま放すと `Pick` に「誰も読んでいない本」と見えて、
             * まだ選局している最中のチューナーを次の要求が持っていく
             */
            sink = Join(lease, priority, use);
        }

        /*
         * **選局は取り合いの錠を放してからやる。**
         *
         * 電波が来ていないチャンネルでは同期待ちに5秒かかる (Tuning.cs)。
         * 掴んだままにすると、その5秒のあいだ `/denpa/tuners` も、他の本への
         * 要求も止まる。実際そうなっていて、
         *
         * - チューナーが2本あっても総当たりは1本ずつしか進まなかった
         * - スキャンを始めてもチューナー画面が「空き」のまま動かなかった
         *
         * ここから先で触るのは、上で押さえた自分の本だけ。
         */

        /*
         * **蹴った相手が読み終わるまで待つ。**
         *
         * デバイスはチューナー1本につき1つで、選局を跨いで開きっぱなし。
         * 前の読み手がまだ回っているうちに次を始めると、**同じ読み口を2本で
         * 取り合い**、前の局のパケットが次の選局に混ざる。
         *
         * **錠は放してから待つ。** 握ったまま待つと、その間どの本も開けない。
         */
        kicked?.Await();

        try
        {
            // 自分で掴む。偽の選局を起こすのは適合テストだけ (TuneOptions.FakeTune)
            if (_tune.FakeTune is not { } fake)
            {
                var held = Acquire(index, spec);
                lock (held.Gate)
                {
                    /*
                     * **合っていても、生きていなければ選局し直す。** DVB は合ったまま
                     * だが、px4-userland は読み手が居なくなると px4-ts が切られる
                     * (Px4.cs)。合っている印だけ残っていて中身が無い、を掴まない
                     */
                    if (held.Channel != channel || !held.Device.Tuned)
                    {
                        var tuning = ChannelTable.Parse(channel)
                            ?? throw new IOException($"{channel} は選局表にありません");
                        // 途中で落ちたら「どこにも合っていない」。次は必ず選局し直す
                        held.Channel = null;
                        held.Device.Tune(tuning, ChannelTable.StreamId(channel, tuning, _tune.StreamIds));
                        held.Channel = channel;
                    }
                    lease.StartNative(held.Device, () => OnExit(index, lease));
                }
            }
            else
            {
                lease.Start(fake, () => OnExit(index, lease));
            }
        }
        catch (Exception error)
        {
            /*
             * **デバイスは閉じない。** 電波が来ていないチャンネルでは選局が
             * 失敗するのが普通で、そのたびに閉じていると次のチャンネルが
             * 「使用中」で開けなくなる (総当たりのスキャンが1本目以降ぜんぶ
             * 落ちたのはこれ)。次の選局で掴み直す
             */
            lock (_gate)
            {
                if (_leases.TryGetValue(index, out var mine) && mine == lease) _leases.Remove(index);
                lock (lease.Sinks) lease.Sinks.Clear();
            }
            sink.Fail($"{spec.Name}: {error.Message}");
            onChange();
            throw new IOException($"{spec.Name}: {error.Message}");
        }
        return sink;
    }

    /// <summary>開きっぱなしの実体を取り出す。**無ければ、そのとき1度だけ開く。**</summary>
    private Held Acquire(int index, TunerSpec spec)
    {
        lock (_deviceGate)
        {
            if (_held.TryGetValue(index, out var open))
            {
                return open;
            }

            var path = spec.Device ?? throw new IOException($"{spec.Name} のデバイスが指定されていません");
            var device = OpenDevice(path, spec.Lnb);

            var held = new Held(device);
            _held[index] = held;
            Log.Write($"[{spec.Name}] {path} を掴みました");
            return held;
        }
    }

    /// <summary>
    /// 設定の <c>device</c> から口を選ぶ。
    ///
    /// <list type="bullet">
    /// <item><c>/dev/dvb/adapterN/frontendM</c> … Linux DVB (Tuning.cs)</item>
    /// <item><c>px4:&lt;筐体の番号&gt;:&lt;受信機&gt;</c> … px4-userland の機材 (Px4.cs)</item>
    /// <item><c>siano:&lt;USB のポート&gt;</c> … siano-userland の機材 (Siano.cs)。カーネルが掴んでいれば開かない</item>
    /// </list>
    ///
    /// <para>それ以外は投げる。<c>px4_drv</c> の chardev はもう受け取らない</para>
    /// </summary>
    public static ITuneDevice OpenDevice(string path, string? lnb)
    {
        /*
         * **Windows は siano-userland の機材だけ。** DVB は無く、px4-userland は Windows を出していない。
         * 書いてあっても開かない (開けば libc を呼びにいって落ちる)
         */
        if (OperatingSystem.IsWindows() && !SianoUserland.Is(path))
        {
            throw new IOException($"{path} は Windows では使えません (Windows で使えるのは {SianoUserland.Scheme}<USB のポート> だけ)");
        }
        if (Px4Userland.Parse(path) is { } px4) return new Px4Tuner(px4.Id, px4.Receiver, lnb);
        if (SianoUserland.Parse(path) is { } port) return new SianoTuner(port);
        if (path.Contains("/dvb/", StringComparison.Ordinal)) return new DvbTuner(path, lnb);
        throw new IOException(
            $"{path} は対応していないデバイスです (/dev/dvb/adapterN/frontendM か {Px4Userland.Scheme}<筐体の番号>:<受信機> か {SianoUserland.Scheme}<USB のポート>)");
    }

    /// <summary>実体を手放す。**定義が変わったときと、止めるときだけ**</summary>
    private void Drop(int index)
    {
        lock (_deviceGate)
        {
            if (!_held.Remove(index, out var held)) return;
            held.Dispose();
        }
    }

    private void OnExit(int index, Lease lease)
    {
        lock (_gate)
        {
            if (!_leases.TryGetValue(index, out var held) || held != lease) return;
            _leases.Remove(index);
            // 選局が落ちた。読み手には失敗として伝える (黙って終わると空ファイルになる)
            var reason = lease.Error is null ? "" : $" ({lease.Error})";
            lock (lease.Sinks)
            {
                foreach (var sink in lease.Sinks) sink.Fail($"選局が終了しました{reason}");
                lease.Sinks.Clear();
            }
        }
        onChange();
    }

    private Sink Join(Lease lease, int priority, string use)
    {
        lease.CancelLinger();
        var sink = new Sink(use, priority, leaving =>
        {
            lock (_gate)
            {
                // 解き手が別のスレッドで配っているので、入れ物は Sinks の錠の下で触る
                lock (lease.Sinks) lease.Sinks.Remove(leaving);
                if (lease.Sinks.Count == 0) ScheduleRelease(lease);
            }
            onChange();
        });
        lock (lease.Sinks) lease.Sinks.Add(sink);
        // 溢れの報告に名前を残す。**抜けたあとに報告が回っても名乗れるように**
        lease.Saw(use);
        Task.Run(onChange);
        return sink;
    }

    private void ScheduleRelease(Lease lease)
    {
        lease.StartLinger(() =>
        {
            lock (_gate)
            {
                if (lease.Sinks.Count == 0) Release(lease, null);
            }
            onChange();
        }, Linger);
    }

    /**
     * 選局を畳む。**読み手に理由を伝えてから、読むのをやめさせる。**
     *
     * <para>
     * **`Sinks` はその錠の下で触る。** 読み手を配る側 (<c>StartNative</c>) は
     * `lock (Sinks)` して回しているので、こちらが素で書き換えると回している
     * 最中の一覧を壊すことになる。
     * </para>
     *
     * <para>
     * **止まるのを待つのは呼んだ側** (<see cref="Lease.Await"/> は最長2秒待つ)。
     * ここで待つと、取り合いの錠 (<see cref="_gate"/>) を握ったまま2秒止まり、
     * その間どの本も開けなくなる。
     * </para>
     */
    private void Release(Lease lease, string? reason)
    {
        lease.CancelLinger();
        if (_leases.TryGetValue(lease.Tuner, out var held) && held == lease) _leases.Remove(lease.Tuner);
        lock (lease.Sinks)
        {
            foreach (var sink in lease.Sinks)
            {
                if (reason is null) sink.End();
                else sink.Fail(reason);
            }
            lock (lease.Sinks) lease.Sinks.Clear();
        }
        // 読むのをやめろとだけ言う。止まりきるのを待つのは錠の外 (上の説明)
        lease.Stop();
    }

    /// <summary>
    /// どのチューナーを使うか決める。
    ///
    /// <list type="number">
    /// <item>**もうそのチャンネルに合っているもの**。選局し直さずに済む</item>
    /// <item>**誰も読んでいないもの** (畳むのを待っているだけ)。いま居る本を使い続ける</item>
    /// <item>空いているもの</item>
    /// <item>自分より弱い相手が掴んでいるもの。いちばん弱いところから取る</item>
    /// </list>
    ///
    /// <para>
    /// **1番目が無いと、戻るたびに選局し直しになる。** 実機で測ると選局し直しは
    /// 約 600ms、合っているものを使えば 10ms。合っているかどうかは
    /// <see cref="Held.Channel"/> が覚えている (実体はアダプタごとに開いたまま)。
    /// </para>
    ///
    /// <para>
    /// **2番目を3番目より先にしてあるのは、1人の視聴で本を2冊塞がないため。**
    /// 畳むのを待っているだけの本を放っておいて空いている本を取ると、余韻の
    /// 5秒間だけ2冊が埋まる。地上波が2本しかない機材では、その隙に録画が
    /// 2つ始まると弾かれる。**選局し直しの時間は変わらない** (どちらの本でも
    /// 同じだけ掛かる) ので、失うのは「直前のチャンネルに合った本が残る」ことだけ。
    /// </para>
    /// </summary>
    private int? Pick(string type, string channel, int priority)
    {
        var usable = Enumerable.Range(0, Tuners.Count)
            .Where(index => !Tuners[index].Disabled && Tuners[index].Types.Contains(type))
            .ToList();

        /*
         * **既に合っているものを先に採る。** ただし誰かが読んでいる最中のものは
         * 除く — 同じチャンネルなら相乗りできるが、それは呼ぶ側 (`Open`) の
         * 別の道で、ここへは来ない
         */
        foreach (var index in usable)
        {
            if (_leases.ContainsKey(index)) continue;
            /*
             * 錠の順は `_gate` → `_deviceGate`。`CloseAll` も同じ向きなので
             * 噛み合わない。`Channel` を `held.Gate` 無しで読むのは承知の上で、
             * 外れても「選局し直しが1回増える」だけ
             */
            lock (_deviceGate)
            {
                if (_held.TryGetValue(index, out var open) && open.Channel == channel) return index;
            }
        }
        // 畳むのを待っているだけの本を先に使い回す。1人の視聴で2冊塞がないため
        foreach (var index in usable)
        {
            if (_leases.TryGetValue(index, out var idle) && idle.Sinks.Count == 0) return index;
        }
        foreach (var index in usable)
        {
            if (!_leases.ContainsKey(index)) return index;
        }

        int? weakest = null;
        var lowest = priority;
        foreach (var index in usable)
        {
            if (!_leases.TryGetValue(index, out var held)) continue;
            if (held.Priority >= lowest) continue;
            weakest = index;
            lowest = held.Priority;
        }
        return weakest;
    }

    /// <summary>
    /// チューナー画面に出るもの。
    ///
    /// <para>
    /// 組み立てを <see cref="JsonNode"/> でやっているのは AOT のため。
    /// 匿名型を反射で書き出す道は、単一実行ファイルにすると使えない。
    /// </para>
    /// </summary>
    public JsonArray Status()
    {
        lock (_gate)
        {
            var list = new JsonArray();
            for (var index = 0; index < Tuners.Count; index++)
            {
                var spec = Tuners[index];
                _leases.TryGetValue(index, out var lease);

                var types = new JsonArray();
                foreach (var type in spec.Types) types.Add((JsonNode?)JsonValue.Create(type));

                var users = new JsonArray();
                if (lease is not null)
                {
                    lock (lease.Sinks)
                    {
                        foreach (var sink in lease.Sinks)
                        {
                            users.Add((JsonNode)new JsonObject { ["use"] = sink.Use, ["priority"] = sink.Priority });
                        }
                    }
                }

                list.Add((JsonNode)new JsonObject
                {
                    ["index"] = index,
                    ["name"] = spec.Name,
                    ["types"] = types,
                    ["disabled"] = spec.Disabled,
                    // 画面がそのまま編集できるように、定義もいっしょに返す
                    ["device"] = spec.Device,
                    ["lnb"] = spec.Lnb,
                    ["channel"] = lease is null
                        ? null
                        : new JsonObject { ["type"] = lease.Type, ["channel"] = lease.Channel },
                    ["users"] = users,
                    ["pid"] = lease?.Pid,
                    ["error"] = lease?.Error,
                });
            }
            return list;
        }
    }

    /// <summary>
    /// いま録画に使われているか。**止めるときに待つかどうかの判断だけに使う。**
    ///
    /// <para>
    /// 見ているのは <c>use</c> の頭。denpa は録画に <c>rec &lt;録画ID&gt;</c>、
    /// それ以外に <c>epg</c> / <c>logo</c> / <c>scan</c> を渡してくる
    /// (`src/lib/server/*.ts`)。番組表もロゴも切れたら取り直せばいいだけだが、
    /// **放送は二度と来ない**ので、録画だけは終わるまで待つ。
    /// </para>
    /// </summary>
    public bool Recording
    {
        get
        {
            lock (_gate)
            {
                return _leases.Values.Any(lease =>
                    lease.Sinks.Any(sink =>
                        sink.Use == "rec" || sink.Use.StartsWith("rec ", StringComparison.Ordinal)));
            }
        }
    }

    /// <summary>
    /// いまカードの鍵で解いているチューナーの名前 (画面の「カードリーダー」の表)。
    /// **カードは1枚を全部で使い回す** (<see cref="Keys"/>) ので、ここに並ぶのは
    /// どれも使用中のカードを使っている
    /// </summary>
    public IReadOnlyList<string> Descrambling()
    {
        lock (_gate)
        {
            return [.. _leases.Where(pair => pair.Value.Descrambling).OrderBy(pair => pair.Key).Select(pair => Tuners[pair.Key].Name)];
        }
    }

    /// <summary>全部畳む。止めるときに使う</summary>
    public void CloseAll()
    {
        lock (_gate)
        {
            foreach (var lease in _leases.Values.ToList()) Release(lease, "停止します");
            foreach (var index in _held.Keys.ToList()) Drop(index);
        }
    }
}

/// <summary>1人の読み手。相乗りしているぶんだけ居る</summary>
public sealed class Sink(string use, int priority, Action<Sink> onLeave)
{
    private readonly Channel<byte[]> _queue = Channel.CreateUnbounded<byte[]>(
        new UnboundedChannelOptions { SingleReader = true });
    private long _pending;
    private int _left;

    public string Use { get; } = use;
    public int Priority { get; } = priority;

    /// <summary>読み手が居なくなったか、蹴られたか。どちらでも読み出しは終わる</summary>
    public ChannelReader<byte[]> Reader => _queue.Reader;

    /// <summary>蹴られた理由。**失敗として伝えるために持つ**</summary>
    public string? FailedWith { get; private set; }

    public void Push(byte[] chunk)
    {
        if (_left != 0) return;
        Interlocked.Add(ref _pending, chunk.Length);
        if (!_queue.Writer.TryWrite(chunk)) return;

        /*
         * **録画は落とさない**方針なので遅れは溜める。ただし際限なく溜めると
         * プロセスごと落ちるので、ここを超えたらその読み手だけ切る。切られた
         * 側は「録画に失敗した」と分かるほうが、黙って全部が死ぬよりまし
         */
        if (Interlocked.Read(ref _pending) > TunerPool.MaxLag) Fail("読み出しが追いつかないため切断しました");
    }

    /// <summary>読み出した分だけ遅れを減らす</summary>
    public void Consumed(int bytes) => Interlocked.Add(ref _pending, -bytes);

    public void End()
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        _queue.Writer.TryComplete();
    }

    public void Fail(string reason)
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        FailedWith = reason;
        _queue.Writer.TryComplete();
    }

    /// <summary>読む側が去った。相乗りから抜ける</summary>
    public void Leave()
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        _queue.Writer.TryComplete();
        onLeave(this);
    }
}

/// <summary>1本の選局。相乗りしている読み手をまとめて持つ</summary>
internal sealed class Lease(int tuner, string type, string channel)
{
    private Process? _child;
    private CancellationTokenSource? _linger;
    private string _stderr = "";

    public int Tuner { get; } = tuner;
    public string Type { get; } = type;
    public string Channel { get; } = channel;
    public List<Sink> Sinks { get; } = [];

    /// <summary>
    /// **前の報告からあとに、読み手として居たもの。**
    ///
    /// <para>
    /// 溢れの報告に添える名前を、報告した瞬間の <see cref="Sinks"/> から採って
    /// いた頃は、**溢れた本人が名乗らない**ことがあった — 報告は1分に1回で、
    /// その間に読み手が抜けていれば「読み手なし」になる。実機の24時間で
    /// **302回のうち128回 (42%) が「読み手なし」**で、その多くは直後の報告に
    /// 同じ局・同じチューナーで `live` が付いていた。
    /// </para>
    /// <para>
    /// 名前を添えるのは「番組表集めなのか観ている人なのかで次に見るところが
    /// 変わる」ためなので、**当てにならない名前は無いのと同じ**。居た者を
    /// 覚えておいて、報告のたびに吐き出す。
    /// </para>
    /// </summary>
    private readonly HashSet<string> _seen = [];

    /// <summary>読み手が来たことを覚える (<see cref="Readers"/>)</summary>
    public void Saw(string use)
    {
        lock (Sinks) _seen.Add(use);
    }

    /// <summary>
    /// 報告に添える名前。**いま居る者と、前の報告からあとに居た者**を並べる。
    /// 読んだら、いま居る者だけに戻す
    /// </summary>
    public string Readers()
    {
        lock (Sinks)
        {
            var now = Sinks.Select(sink => sink.Use).ToArray();
            var who = _seen.Union(now).Order().ToArray();
            _seen.Clear();
            foreach (var use in now) _seen.Add(use);
            return who.Length == 0 ? "読み手なし" : string.Join("・", who);
        }
    }

    public string? Error { get; private set; }
    public int? Pid => _child?.HasExited == false ? _child.Id : null;

    public int Priority => Sinks.Count == 0 ? int.MinValue : Sinks.Max(sink => sink.Priority);

    private volatile bool _stopped;
    private Task? _pump;
    /// <summary>解き手が終わった (失敗も含む)。**読み手も降りる** — 残ると読み口を掴んだまま回り続ける</summary>
    private volatile bool _drained;
    /// <summary>解き手が回っている (<see cref="TunerPool.Descrambling"/>)</summary>
    public bool Descrambling { get => _descrambling; private set => _descrambling = value; }
    private volatile bool _descrambling;
    /// <summary>読み手と解き手の間に溜まっているバイト数</summary>
    private long _queued;

    /// <summary>
    /// 読み手と解き手の間に溜められる量。**64MB** — 地上波で 25 秒、衛星の中継器まるごとでも 10 秒ほど。
    /// 解き手が止まるのはカードや配り役を待つときで、それぞれ上限がある (CCID は 5 秒で諦め、
    /// 繋ぎ直しに失敗したら 10 秒は探さずに断り、配り役は 10 秒で切る) ので、その間を丸ごと呑める。
    /// **数ではなくバイトで測る** — 読み口は溜まっているぶんだけ返すので、1回の読みは小さいこともある
    /// </summary>
    private const long QueueLimit = 64 * 1024 * 1024;

    /// <summary>
    /// **掴んだままのデバイスから読んで、解いて配る。** 選局そのものはプールがやる。
    ///
    /// <para>
    /// デバイスは**チューナーごとに開きっぱなし**で、ここでは閉じない。
    /// 畳むときも読むのをやめるだけ (<see cref="Stop"/>)。
    /// **流れが途切れたら失敗として畳む** — 黙って終わると空のファイルが残る。
    /// </para>
    ///
    /// <para>
    /// **読み手と解き手は別のスレッドで、間に 64MB のキューを置く** (<see cref="QueueLimit"/>)。
    /// 解き手は ECM が変わるとその場で鍵を貰うので、カードや配り役が固まると何秒も止まる。
    /// 読み手がそこで待つとデバイスの溜め (3.5 秒ぶん) が溢れて**録画が欠ける** —
    /// 欠けたものは後から解いても戻らない。キューが埋まったときだけ読み手も待つ。
    /// </para>
    ///
    /// <para>
    /// **復号器は選局ごとに作る。** 中身は PAT・PMT・鍵だけで、作るのは安い。
    /// 選局を跨いで持ち回さなければ、前の局の鍵が残ることも、2本から同時に
    /// 叩かれることも起きようがない。
    /// </para>
    /// </summary>
    public void StartNative(ITuneDevice tuner, Action onExit)
    {
        var queue = System.Threading.Channels.Channel.CreateUnbounded<(byte[] Rented, int Length)>(
            new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        // **どちらも専用のスレッドで。** 流れている間ずっと塞ぐので、共用の池から借りると
        // HTTP の口が、池が増えるまで待たされる
        _pump = Task.Factory.StartNew(
            () => Read(tuner, queue.Writer), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        // 解き手は待たない (Await)。デバイスに触らず、配り先も畳むときに空になっている
        _ = Task.Factory.StartNew(
            () => Descramble(queue.Reader, onExit), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    /// <summary>読み手。読んだぶんを写してキューへ入れる。終わったらキューを閉じる</summary>
    private void Read(ITuneDevice tuner, ChannelWriter<(byte[] Rented, int Length)> queue)
    {
        var buffer = new byte[188 * 1024];
        /*
         * **降りる合図を読み口まで渡す。** 渡さないと、電波が来ていない間は
         * `Read` が永久に戻らず、蹴られてもここに居座る (Tuning.cs)
         */
        var ring = tuner.Output as DeviceStream;
        /*
         * **その選局のぶんだけ数える。**
         *
         * デバイスは選局を跨いで開きっぱなしなので、**局を変えている間は
         * 誰も読んでいない**。その間もドライバは電波を積むので、読み始めた
         * 最初の1回が必ず溢れとして返り、しかも「空いた時間」は
         * 選局に掛かった時間そのものになる。
         *
         * 実機ではロゴ集めが局を飛び回るチューナーで **4.1秒・4.3秒** と
         * 出た。溜めは 3.5秒ぶんなので「読み手が遅い」に見えるが、
         * **前の局の読み終わりからの時間**を測っていただけだった。
         * ここで測り直せば、残るのは本当に追いつかなかったぶんになる
         */
        ring?.Begin();
        var since = Stopwatch.StartNew();
        var waited = false;
        try
        {
            while (!_stopped && !_drained)
            {
                var read = ring is null
                    ? tuner.Output.Read(buffer, 0, buffer.Length)
                    : ring.Read(buffer, 0, buffer.Length, () => _stopped || _drained);
                if (read <= 0) break;

                if (Interlocked.Add(ref _queued, read) > QueueLimit)
                {
                    // 解き手が止まったまま埋まった。空くまで読むのを待つ (まれなので、起きて見に行く形で足りる)
                    if (!waited) Log.Write($"[{Tuner}] {Channel}: 解くのが追いつかずキューが埋まったので、読むのを待ちます");
                    waited = true;
                    while (Volatile.Read(ref _queued) > QueueLimit && !_stopped && !_drained) Thread.Sleep(10);
                }
                // 写す先は借り物。解き手が解き終えたら返す (1回が 192KB なので、毎回確保すると大きな塊の置き場を汚す)
                var rented = ArrayPool<byte>.Shared.Rent(read);
                buffer.AsSpan(0, read).CopyTo(rented);
                if (!queue.TryWrite((rented, read))) ArrayPool<byte>.Shared.Return(rented);

                if (since.Elapsed < OverflowReport) continue;
                since.Restart();
                ReportOverflows(ring);
            }
        }
        catch (Exception error)
        {
            Error = error.Message;
        }
        ReportOverflows(ring);
        queue.TryComplete();
    }

    /// <summary>解き手。キューから取って解き、読み手たちに配る。キューが閉じて空になったら終わる</summary>
    private void Descramble(ChannelReader<(byte[] Rented, int Length)> queue, Action onExit)
    {
        var b25 = new Descrambler(Keys.Source);
        Descrambling = true;
        var decoded = new ArrayBufferWriter<byte>();
        void Push()
        {
            if (decoded.WrittenCount == 0) return;
            var chunk = decoded.WrittenSpan.ToArray();
            decoded.ResetWrittenCount();
            lock (Sinks)
            {
                foreach (var sink in Sinks.ToList()) sink.Push(chunk);
            }
        }

        try
        {
            while (!_stopped && queue.WaitToReadAsync().AsTask().GetAwaiter().GetResult())
            {
                while (!_stopped && queue.TryRead(out var chunk))
                {
                    Interlocked.Add(ref _queued, -chunk.Length);
                    try
                    {
                        b25.Decode(chunk.Rented.AsSpan(0, chunk.Length), decoded);
                    }
                    finally
                    {
                        ArrayPool<byte>.Shared.Return(chunk.Rented);
                    }
                    Push();
                }
            }
            if (!_stopped)
            {
                b25.Flush(decoded);
                Push();
            }
        }
        catch (Exception error)
        {
            Error ??= error.Message;
        }
        _drained = true;
        Descrambling = false;
        /*
         * **解けなかったぶんを残す。** 掛かったまま流したものは、録画が
         * 成功したように見えて中身が見られない。理由も添える
         */
        if (b25.Undecodable > 0)
        {
            Log.Write($"[{Tuner}] {Channel}: {b25.Undecodable} パケットを掛かったまま流しました"
                + (b25.LastError is { } why ? $" ({why})" : ""));
        }
        // 畳めと言われて終わったのなら、それは失敗ではない
        if (!_stopped) onExit();
    }

    /**
     * 溢れを報せる間隔。
     *
     * **終わりにだけ出していた頃は、長い選局が一度も報せなかった。** 番組表集めは
     * 数分で終わるので出るが、**ライブ視聴と録画は終わるまで一度も出ない** —
     * 実機で「観ている最中に一瞬止まる」と言われて記録を見ても、出ているのは
     * 番組表のぶんだけで、観ている局が落としているのかどうかが分からなかった。
     */
    private static readonly TimeSpan OverflowReport = TimeSpan.FromMinutes(1);

    /// <summary>
    /// 溢れたぶんを吐き出して記録する。**溢れても選局は生きている**ので畳まない。
    ///
    /// <para>
    /// **誰が読んでいたかも添える。** 溢れっぱなしなら読む側が遅いということで、
    /// 相手が番組表集めなのか観ている人なのかで、次に見るところが変わる。
    /// 名前は**その間に居た者**を並べる (<see cref="Readers"/>) — いま居る者だけを
    /// 見ていた頃は、抜けたあとに報告が回って「読み手なし」になっていた。
    /// </para>
    /// </summary>
    private void ReportOverflows(DeviceStream? ring)
    {
        if (ring is null) return;
        var (count, worstGap, stale) = ring.TakeOverflows();
        if (count == 0)
        {
            /*
             * **選局の前に埋まっていたぶんは、読み手のせいではない。**
             * 数には入れないが、黙って捨てると「本当に落ちていないのか」が
             * 分からなくなるので、そうと分かる言い方で残す
             */
            if (stale > 0) Log.Write($"[{Tuner}] {Channel}: 選局前に環が {stale} 回溢れていました");
            return;
        }
        /*
         * **空いた時間も出す。** 環は 8MB = 地上波で 3.5 秒ぶんなので、
         * ここが 1 秒あたりで頭打ちなら**広げたはずの溜めが効いていない**
         * (カーネルの既定 1.8MB のまま)。3.5 秒を超えているなら、
         * 溜めの深さではなく読み手が止まる理由のほうが本題になる
         */
        Log.Write(
            $"[{Tuner}] {Channel}: 環が {count} 回溢れました "
                + $"(読むのが追いつきません: {Readers()}、いちばん空いたのは {worstGap / 1000.0:0.0}秒)");
    }

    /// <summary>
    /// 偽の選局を起こす。**適合テストだけ** (TuneOptions.FakeTune)。
    ///
    /// <para>
    /// **`setsid` を噛ませる。** `sh -c` 越しなので、止めるときはグループごと
    /// 落とす (<see cref="Interop.KillGroup"/>)。
    /// </para>
    /// </summary>
    public void Start(string command, Action onExit)
    {
        var start = new ProcessStartInfo("setsid")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("sh");
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add($"{command} \"$1\" \"$2\"");
        start.ArgumentList.Add("sh");
        start.ArgumentList.Add(Type);
        start.ArgumentList.Add(Channel);

        var child = Process.Start(start)!;
        _child = child;

        _ = Task.Run(async () =>
        {
            var buffer = new byte[64 * 1024];
            var stream = child.StandardOutput.BaseStream;
            try
            {
                for (; ; )
                {
                    var read = await stream.ReadAsync(buffer);
                    if (read <= 0) break;
                    var chunk = buffer[..read];
                    lock (Sinks)
                    {
                        foreach (var sink in Sinks.ToList()) sink.Push(chunk);
                    }
                }
            }
            catch (Exception error)
            {
                _stderr = error.Message;
            }
        });

        var stderr = Task.Run(async () =>
        {
            // 選局が失敗した理由を拾うため、末尾だけ持つ
            _stderr += await child.StandardError.ReadToEndAsync();
            if (_stderr.Length > 2000) _stderr = _stderr[^2000..];
        });

        _ = Task.Run(async () =>
        {
            await child.WaitForExitAsync();
            // 終わっても stderr を読み切っているとは限らない。理由を取りこぼさないよう待つ
            await stderr;
            Error = _stderr.Trim().Split('\n').LastOrDefault()?.Trim() is { Length: > 0 } tail ? tail : null;
            onExit();
        });
    }

    public void StartLinger(Action release, TimeSpan after)
    {
        if (_linger is not null) return;
        var source = new CancellationTokenSource();
        _linger = source;
        _ = Task.Delay(after, source.Token).ContinueWith(task =>
        {
            if (task.IsCanceled) return;
            _linger = null;
            release();
        }, TaskScheduler.Default);
    }

    public void CancelLinger()
    {
        _linger?.Cancel();
        _linger = null;
    }

    /**
     * **読むのをやめろと言う。待たない。**
     *
     * <para>
     * 掴んだままのデバイスは閉じない — チューナーごとに開いたままで、次の選局が
     * 同じものを使う。ここでやるのは合図だけ。読み口は 200ms ごとに起きて
     * この印を見るので (<c>DeviceStream.Read</c>)、電波が来ていなくても止まる。
     * </para>
     */
    public void Stop()
    {
        _stopped = true;

        var child = _child;
        _child = null;
        if (child is null || child.HasExited) return;
        Interop.KillGroup(child.Id);
    }

    /**
     * **止まりきるまで待つ。呼ぶのは錠の外で。**
     *
     * <para>
     * 次の選局は、これが返ってから始める。待たずに始めると**同じ読み口を
     * 2本で取り合い**、前の局のパケットが次の選局に混ざる。待つのは読み手だけ —
     * 解き手はデバイスに触らず、配り先も畳むときに空になっている (鍵を待っていれば
     * 止まるのはその答えのあと)。
     * </para>
     *
     * <para>
     * それでも止まらないときは**記録に残す。** 黙って先へ進んでいた頃は、
     * 窓が開いていたのかどうかを確かめようが無かった。
     * </para>
     */
    public void Await()
    {
        var pump = _pump;
        _pump = null;
        if (pump is null) return;
        if (!pump.Wait(StopWait))
        {
            Log.Write($"[{Tuner}] {Channel}: 読み手が {StopWait.TotalSeconds} 秒で止まりませんでした");
        }
    }

    /// <summary>止まるのを待つ上限。読み口は 200ms ごとに起きるので、十分に長い</summary>
    private static readonly TimeSpan StopWait = TimeSpan.FromSeconds(2);
}
