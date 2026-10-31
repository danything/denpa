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
/// **適合テスト専用。** 自分で選局する代わりに、このコマンドに
/// <c>&lt;種別&gt; &lt;チャンネル&gt;</c> を足して起こし、標準出力を読む
/// (<c>tests/fake/tune.ts</c>)。環境変数 <c>FAKE_TUNE</c> からだけ入る —
/// 設定ファイルにも画面にも、コマンドを書く場所は無い。
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
/// <item>**同じ物理チャンネルなら1台で足りる。** 番組表・ロゴ・録画が同じ選局を共有する</item>
/// </list>
///
/// <para>
/// 選局は**自分でやる**。B25 も自分で復号し、デバイスを確保したままチャンネルだけ変える
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
    /// **開きっぱなしのデバイス。チューナー1台につき1つ。**
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
    /// <see cref="_held"/> を出し入れする間のロック。**取り合い (<see cref="_gate"/>) とは別。**
    ///
    /// <para>
    /// 選局は取り合いのロックを放してからやる (<see cref="Open"/>)。そのぶん、この
    /// 入れ物にはロックのかかっていない経路から触られることになるので、ここで守る。
    /// 確保する/手放すだけなので、待たされるのは一瞬。
    /// </para>
    /// </summary>
    private readonly Lock _deviceGate = new();

    /// <summary>1台ぶんの実体。**閉じるのは定義が変わったときと、止めるときだけ**</summary>
    private sealed class Held(ITuneDevice device) : IDisposable
    {
        public ITuneDevice Device { get; } = device;

        /// <summary>
        /// **この1台を選局し直す間のロック。チューナーごとに別**なので、他のチューナーは待たない。
        ///
        /// <para>
        /// 選局の最中に、優先度の高い要求が同じチューナーを取り上げることがある。
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
    /// 走っている選局は**そのまま続ける**。名前が変わった・消えたチューナーのものだけ、
    /// 失敗として畳む — 使っているデバイスが別物になったのに流し続けると、
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
                // 別の機材になったかもしれない。取り直す
                Drop(index);
            }
        }
        onChange();
    }

    public sealed class TunerBusyException(string message) : Exception(message);

    /// <summary>
    /// 選局して読み出し側を返す。確保できなければ <see cref="TunerBusyException"/>。
    ///
    /// <para>同じ物理チャンネルが既に開いていればそこへ混ぜる。**チューナーは増えない。**</para>
    ///
    /// <para>
    /// **<paramref name="after"/> の利用者は、もう離れたものとして選ぶ** (引き継ぎ。docs/agent.md「選ぶ順の約束」の4)。
    /// 選んだチューナーにその利用者がいれば、正常に終わらせてから同じチューナーで選局し直す。
    /// </para>
    /// </summary>
    public Sink Open(string type, string channel, int priority, string use, IReadOnlySet<string>? after = null)
    {
        int index;
        TunerSpec spec;
        Lease lease;
        Sink sink;
        // 譲らせた相手。**止まりきるのをロックの外で待つ** (下の説明)
        Lease? kicked = null;

        lock (_gate)
        {
            /*
             * **自分と同じか優先度の高い利用者がいれば、どのチューナーでもその選局を共有する** (約束3)。優先度の低い
             * 利用者しかいない選局と余韻だけの選局は、そのチューナーが選ぶ順で先頭の組のときだけ `Pick` が選んで下で共有する
             * (わけは docs/agent.md「選ぶ順の約束」)
             */
            after ??= new HashSet<string>();
            foreach (var open in _leases.Values)
            {
                if (open.Type != type || open.Channel != channel) continue;
                bool strong;
                lock (open.Sinks) strong = open.Sinks.Any(sink => !after.Contains(sink.Use) && sink.Priority >= priority);
                if (strong) return Join(open, priority, use);
            }

            index = Pick(type, channel, priority, after)
                ?? throw new TunerBusyException($"{type} のチューナーに空きがありません");

            if (_leases.TryGetValue(index, out var victim))
            {
                // 引き継ぐ相手は正常に終わらせる (取り上げられたのではない)。残りの優先度の低い利用者は下で切断する
                lock (victim.Sinks)
                {
                    foreach (var leaving in victim.Sinks.Where(s => after.Contains(s.Use)).ToList())
                    {
                        leaving.End();
                        victim.Sinks.Remove(leaving);
                    }
                }
                // 同じチャンネルなら、選局し直さずにそのまま共有する (余韻ならそのまま使い回し、優先度の低い利用者も残す)
                if (victim.Type == type && victim.Channel == channel)
                {
                    return Join(victim, priority, use);
                }
                // 取り上げる相手がいれば先に片付ける。同じチューナーを2つの選局が使わないように
                Release(victim, "優先度の高い要求に譲りました");
                kicked = victim;
            }

            spec = Tuners[index];
            lease = new Lease(index, type, channel);
            _leases[index] = lease;
            /*
             * **利用者を入れてからロックを放す。** 選局はこの下、ロックの外でやるので、
             * 入れないまま放すと `Pick` に「誰も読んでいないチューナー」と見えて、
             * まだ選局している最中のチューナーを次の要求が持っていく
             */
            sink = Join(lease, priority, use);
        }

        /*
         * **選局は取り合いのロックを放してからやる** (同期待ちの5秒、ほかの要求を止めない。
         * docs/agent.md「選局は取り合いの錠の外でやる」)。ここから先で触るのは、上で押さえた自分のチューナーだけ。
         *
         * **譲らせた相手が読み終わるまで待つ。** 前の読み出しが回っているうちに次を始めると、同じ読み出し側を
         * 2本で取り合い、前の局のパケットが混ざる (docs/agent.md「前の利用者が抜けるまで、次の選局を始めない」)
         */
        if (kicked is not null)
        {
            kicked.Await();
            lease.KickedMs = lease.Clock.ElapsedMilliseconds;
        }

        try
        {
            // 自分で選局する。偽の選局を起こすのは適合テストだけ (TuneOptions.FakeTune)
            if (_tune.FakeTune is not { } fake)
            {
                var held = Acquire(index, spec);
                lock (held.Gate)
                {
                    /*
                     * **合っていても、生きていなければ選局し直す。** DVB は合ったまま
                     * だが、px4-userland は利用者がいなくなると TS のストリームを畳む
                     * (受信機は取ったまま。Px4.cs)。合っている印だけ残っていて中身が無い、を信じない
                     */
                    if (held.Channel != channel || !held.Device.Tuned)
                    {
                        var tuning = ChannelTable.Parse(channel)
                            ?? throw new IOException($"{channel} は選局表にありません");
                        // 途中で落ちたら「どこにも合っていない」。次は必ず選局し直す
                        held.Channel = null;
                        held.Device.Tune(tuning, ChannelTable.StreamId(channel, tuning, _tune.StreamIds));
                        held.Channel = channel;
                        lease.TunedMs = lease.Clock.ElapsedMilliseconds;
                    }
                    lease.StartNative(held.Device, () => OnExit(lease));
                }
            }
            else
            {
                lease.Start(fake, () => OnExit(lease));
            }
        }
        catch (Exception error)
        {
            /*
             * **デバイスは閉じない。** 電波が来ていないチャンネルでは選局が
             * 失敗するのが普通で、そのたびに閉じていると次のチャンネルが
             * 「使用中」で開けなくなる (総当たりのスキャンが1本目以降ぜんぶ
             * 落ちたのはこれ)。次の選局で取り直す
             */
            lock (_gate)
            {
                Forget(lease);
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
            // CECH-ZD1 J は、設定に1台だけなら挿し替えたポートに付いていく (2台以上はポートで見分ける。Zd1j.Follow)
            var device = OpenDevice(path, spec.Lnb, followZd1j: _specs.Count(other => Zd1j.Is(other.Device)) == 1);

            var held = new Held(device);
            _held[index] = held;
            Log.Write($"[{spec.Name}] {path} を確保しました");
            return held;
        }
    }

    /// <summary>
    /// 設定の <c>device</c> から使う仕組みを選ぶ。
    ///
    /// <list type="bullet">
    /// <item><c>/dev/dvb/adapterN/frontendM</c> … Linux DVB (Tuning.cs)</item>
    /// <item><c>px4:&lt;筐体の番号&gt;:&lt;受信機&gt;</c> … px4-userland の機材 (Px4.cs)</item>
    /// <item><c>siano:&lt;USB のポート&gt;</c> … siano-userland の機材 (Siano.cs)。カーネルが使っていれば開かない</item>
    /// <item><c>asicen:&lt;USB ポート&gt;:&lt;受信機&gt;</c> … asicen-userland の機材 (Asicen.cs。試験的)</item>
    /// <item><c>zd1j:&lt;USB のポート&gt;</c> … Sony CECH-ZD1 J (Zd1j.cs)。エージェントが USB を直に持つ (Linux・Windows・macOS)</item>
    /// </list>
    ///
    /// <para>それ以外は投げる。<c>px4_drv</c> の chardev はもう受け取らない</para>
    /// </summary>
    /// <param name="followZd1j">CECH-ZD1 J が設定のポートに見当たらなければ、ほかに1台だけ挿さっているものを使う (<see cref="Zd1j.Follow(string)"/>)</param>
    public static ITuneDevice OpenDevice(string path, string? lnb, bool followZd1j = false)
    {
        /*
         * **Windows は siano-userland と px4-userland の機材と CECH-ZD1 J だけ。** DVB は無く、asicen-userland は Windows を出していない。
         * 書いてあっても開かない (開けば libc を呼びにいって落ちる)
         */
        if (OperatingSystem.IsWindows() && !SianoUserland.Is(path) && !Zd1j.Is(path) && Px4Userland.Parse(path) is null)
        {
            throw new IOException(
                $"{path} は Windows では使えません (Windows で使えるのは {Px4Userland.Scheme}<筐体の番号>:<受信機> と {SianoUserland.Scheme}<USB のポート> と {Zd1j.Scheme}<USB のポート> だけ)");
        }
        if (Zd1j.Parse(path) is { } zd1j) return new Zd1jTuner(zd1j, followZd1j);
        if (Px4Userland.Parse(path) is { } px4) return new Px4Tuner(px4.Id, px4.Receiver, lnb);
        if (SianoUserland.Parse(path) is { } port) return new SianoTuner(port);
        if (AsicenUserland.Parse(path) is { } asicen) return AsicenUserland.Open(asicen.Id, asicen.Receiver, lnb);
        if (path.Contains("/dvb/", StringComparison.Ordinal)) return new DvbTuner(path, lnb);
        throw new IOException(
            $"{path} は対応していないデバイスです (/dev/dvb/adapterN/frontendM か {Px4Userland.Scheme}<筐体の番号>:<受信機> か {SianoUserland.Scheme}<USB のポート> か {AsicenUserland.Scheme}<USB のポート>:<受信機> か {Zd1j.Scheme}<USB のポート>)");
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

    /// <summary>まだ自分のチューナーの選局なら外す。取り上げられたあとの古い選局なら何もしない (false)</summary>
    private bool Forget(Lease lease)
    {
        if (!_leases.TryGetValue(lease.Tuner, out var held) || held != lease) return false;
        _leases.Remove(lease.Tuner);
        return true;
    }

    private void OnExit(Lease lease)
    {
        lock (_gate)
        {
            if (!Forget(lease)) return;
            // 選局が落ちた。利用者には失敗として伝える (黙って終わると空ファイルになる)
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
                // デスクランブラが別のスレッドで配っているので、入れ物は Sinks のロックの下で触る
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
     * 選局を畳む。**利用者に理由を伝えてから、読むのをやめさせる。**
     *
     * <para>
     * **`Sinks` はそのロックの下で触る。** 利用者に配る側 (<c>StartNative</c>) は
     * `lock (Sinks)` して回しているので、こちらが素で書き換えると回している
     * 最中の一覧を壊すことになる。
     * </para>
     *
     * <para>
     * **止まるのを待つのは呼んだ側** (<see cref="Lease.Await"/> は最長2秒待つ)。
     * ここで待つと、取り合いのロック (<see cref="_gate"/>) を握ったまま2秒止まり、
     * その間どのチューナーも開けなくなる。
     * </para>
     */
    private void Release(Lease lease, string? reason)
    {
        lease.CancelLinger();
        Forget(lease);
        lock (lease.Sinks)
        {
            foreach (var sink in lease.Sinks)
            {
                if (reason is null) sink.End();
                else sink.Fail(reason);
            }
            lease.Sinks.Clear();
        }
        // 読むのをやめろとだけ言う。止まりきるのを待つのはロックの外 (上の説明)
        lease.Stop();
    }

    /// <summary>
    /// **選ぶ順** (<c>GET /denpa/tuners</c> の <c>rank</c>)。小さいほど先に使う。無効なチューナーは null。
    ///
    /// <para>
    /// **受けられる種別の少ないチューナーほど先。** 数が同じなら、その種別の組が定義に先に出てくるほうが先。
    /// **受けられる種別がまったく同じチューナーには同じ順位を付ける** — どれを使っても後に響かないので、
    /// もう合っているチューナーや余韻のチューナーを使い回してよい (<see cref="Pick"/>)。
    /// わけと denpa との約束は docs/agent.md「選ぶ順の約束」(同じ場面を両方のテストに通している。tests/fake/tuner-scenes.ts)
    /// </para>
    /// </summary>
    public static int?[] Ranks(IReadOnlyList<TunerSpec> specs)
    {
        static string Key(TunerSpec spec) => string.Join(',', spec.Types.Distinct().Order(StringComparer.Ordinal));
        var groups = specs
            .Select((spec, index) => (spec, index))
            .Where(pair => !pair.spec.Disabled)
            .GroupBy(pair => Key(pair.spec))
            .OrderBy(group => group.First().spec.Types.Distinct().Count())
            .ThenBy(group => group.First().index)
            .Select(group => group.Key)
            .ToList();
        return [.. specs.Select(spec => spec.Disabled ? (int?)null : groups.IndexOf(Key(spec)))];
    }

    /// <summary>
    /// どのチューナーを使うか決める。**denpa との約束** (docs/agent.md「選ぶ順の約束」の2):
    /// 空いているチューナー (余韻だけのものも) と**自分より優先度の低い利用者しかいないチューナー**のうち、
    /// 受けられて**順位 (<see cref="Ranks"/>) がいちばん小さい組**から選ぶ。空いている兼用のチューナーへ逃げずに、
    /// 優先度の低い相手から取り上げる。
    ///
    /// <para>
    /// 組の中では、同じチャンネルの選局 → もうそのチャンネルに合っているもの (<see cref="Held.Channel"/>。
    /// 実測 0.6〜0.8 秒の選局し直しが 10ms になる) → ほかの余韻 (1人の視聴で2台塞がない) → 空いているもの →
    /// いちばん優先度の低い相手が使っているもの、の順 (docs/agent.md「取り合いの決まり」)
    /// </para>
    /// </summary>
    private int? Pick(string type, string channel, int priority, IReadOnlySet<string> after)
    {
        var ranks = Ranks(Tuners);
        // 残る利用者の優先度。引き継ぐ相手 (`after`) はもう離れたものとして数えない。誰もいなければ null
        int? Strongest(int index)
        {
            if (!_leases.TryGetValue(index, out var lease)) return null;
            lock (lease.Sinks)
            {
                var staying = lease.Sinks.Where(sink => !after.Contains(sink.Use)).ToList();
                return staying.Count == 0 ? null : staying.Max(sink => sink.Priority);
            }
        }
        bool Idle(int index) => _leases.ContainsKey(index) && Strongest(index) is null;
        bool Usable(int index) => Strongest(index) is not { } strongest || strongest < priority;

        var usable = Enumerable.Range(0, Tuners.Count)
            .Where(index => ranks[index] is not null && Tuners[index].Types.Contains(type) && Usable(index))
            .ToList();
        if (usable.Count == 0) return null;
        var best = usable.Min(index => ranks[index]);
        var group = usable.Where(index => ranks[index] == best).ToList();

        foreach (var index in group)
        {
            // 組の中に同じチャンネルの選局があれば共有する (余韻か、優先度の低い利用者しかいないもの)
            if (_leases.TryGetValue(index, out var same) && same.Type == type && same.Channel == channel) return index;
        }
        foreach (var index in group)
        {
            if (_leases.ContainsKey(index)) continue;
            /*
             * ロックの順は `_gate` → `_deviceGate`。`CloseAll` も同じ向きなので
             * 噛み合わない。`Channel` を `held.Gate` 無しで読むのは承知の上で、
             * 外れても「選局し直しが1回増える」だけ
             */
            lock (_deviceGate)
            {
                if (_held.TryGetValue(index, out var open) && open.Channel == channel) return index;
            }
        }
        foreach (var index in group)
        {
            if (Idle(index)) return index;
        }
        foreach (var index in group)
        {
            if (!_leases.ContainsKey(index)) return index;
        }
        return group.MinBy(index => Strongest(index) ?? int.MinValue);
    }

    /// <summary>チューナー画面に出るもの (<see cref="JsonNode"/> で組むわけは <see cref="Json"/>)</summary>
    public JsonArray Status()
    {
        lock (_gate)
        {
            var list = new JsonArray();
            var ranks = Ranks(Tuners);
            for (var index = 0; index < Tuners.Count; index++)
            {
                var spec = Tuners[index];
                _leases.TryGetValue(index, out var lease);

                JsonArray users = [];
                if (lease is not null)
                {
                    // JsonNode にしてから入れる (JsonObject のままだと総称の Add<T> になり、AOT で使えない)
                    lock (lease.Sinks) users = [.. lease.Sinks.Select(sink => (JsonNode)new JsonObject { ["use"] = sink.Use, ["priority"] = sink.Priority })];
                }

                list.Add((JsonNode)new JsonObject
                {
                    ["index"] = index,
                    // 選ぶ順。denpa はこの順どおりに確保される前提で予約を割り振る (docs/agent.md「選ぶ順の約束」)
                    ["rank"] = ranks[index],
                    ["name"] = spec.Name,
                    ["types"] = Json.Strings(spec.Types),
                    ["disabled"] = spec.Disabled,
                    // 画面がそのまま編集できるように、定義もいっしょに返す
                    ["device"] = spec.Device,
                    ["lnb"] = spec.Lnb,
                    ["channel"] = lease is null
                        ? null
                        : new JsonObject { ["type"] = lease.Type, ["channel"] = lease.Channel },
                    ["users"] = users,
                    ["pid"] = lease?.Pid,
                    /*
                     * 選局の失敗が無ければ、受信機の注意書き (15V を出せないので 0V にした、など。
                     * Px4Userland.Notice)。画面は空いているチューナーの error を出すので、新しい欄は作らない
                     */
                    ["error"] = lease?.Error ?? Px4Userland.Notice(spec.Device),
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
    /// それ以外に <c>epg</c> / <c>logo</c> / <c>scan</c> / <c>live</c> を渡してくる
    /// (<c>StreamUse</c>、src/lib/server/tuner.ts)。番組表もロゴも切れたら取り直せばいいだけだが、
    /// **放送は二度と来ない**ので、録画だけは終わるまで待つ。
    /// </para>
    /// </summary>
    public bool Recording
    {
        get
        {
            lock (_gate) return _leases.Values.Any(lease => lease.Sinks.Any(sink => sink.Use == "rec" || sink.Use.StartsWith("rec ", StringComparison.Ordinal)));
        }
    }

    /// <summary>
    /// いまカードの鍵で復号しているチューナーの名前 (画面の「カードリーダー」の表)。
    /// **カードは1枚を全部で使い回す** (<see cref="Keys"/>) ので、ここに並ぶのは
    /// どれも使用中のカードを使っている
    /// </summary>
    public IReadOnlyList<string> Descrambling()
    {
        lock (_gate) return [.. _leases.Where(pair => pair.Value.Descrambling).OrderBy(pair => pair.Key).Select(pair => Tuners[pair.Key].Name)];
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

/// <summary>1人の利用者。選局を共有しているぶんだけいる</summary>
public sealed class Sink(string use, int priority, Action<Sink> onLeave)
{
    private readonly Channel<byte[]> _queue = Channel.CreateUnbounded<byte[]>(
        new UnboundedChannelOptions { SingleReader = true });
    private long _pending;
    private int _left;

    public string Use { get; } = use;
    public int Priority { get; } = priority;

    /// <summary>
    /// **鍵が要るか。名乗り (<c>use</c>) の頭の語で決める。** 番組表 (<c>epg</c>)・ロゴ (<c>logo</c>)・
    /// スキャン (<c>scan</c>) が読むのは掛かっていない SI (EIT・CDT・全受信機共通データ・NIT・SDT) だけなので要らない。
    /// 知らない名乗りは要るとみなす (録れないよりまし)。放送の中身ではなく、denpa が名乗る利用者の種類だけを見る
    /// </summary>
    public bool WantsKeys { get; } = !KeylessUses.Contains(use.Split(' ', 2)[0]);

    /// <summary>鍵の要らない利用者の名乗り (denpa の <c>StreamUse</c>)</summary>
    private static readonly HashSet<string> KeylessUses = ["epg", "logo", "scan"];

    /// <summary>利用者がいなくなったか、チューナーを取り上げられたか。どちらでも読み出しは終わる</summary>
    public ChannelReader<byte[]> Reader => _queue.Reader;

    /// <summary>取り上げられた理由。**失敗として伝えるために持つ**</summary>
    public string? FailedWith { get; private set; }

    public void Push(byte[] chunk)
    {
        if (_left != 0) return;
        Interlocked.Add(ref _pending, chunk.Length);
        if (!_queue.Writer.TryWrite(chunk)) return;

        /*
         * **録画は落とさない**方針なので遅れは溜める。ただし際限なく溜めると
         * プロセスごと落ちるので、ここを超えたらその利用者だけ切る。切られた
         * 側は「録画に失敗した」と分かるほうが、黙って全部が死ぬよりまし
         */
        if (Interlocked.Read(ref _pending) > TunerPool.MaxLag) Fail("読み出しが追いつかないため切断しました");
    }

    /// <summary>読み出した分だけ遅れを減らす</summary>
    public void Consumed(int bytes) => Interlocked.Add(ref _pending, -bytes);

    public void End() => Close();

    public void Fail(string reason) => Close(reason);

    /// <summary>読む側が去った。共有から抜ける</summary>
    public void Leave()
    {
        if (Close()) onLeave(this);
    }

    /// <summary>読み出しを終わらせる。**最初の1回だけ効く** (2回目からは false)</summary>
    private bool Close(string? reason = null)
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return false;
        FailedWith = reason;
        _queue.Writer.TryComplete();
        return true;
    }
}

/// <summary>1本の選局。共有している利用者をまとめて持つ</summary>
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
    /// **選局の内訳を測る時計** (取った時点から)。最初に送り出したときに1行残す —
    /// 局替えの遅さがどこにあるか (前の読み出し待ち・同期・最初の TS・鍵) を実機で割るため。行の形は docs/stream.md「本番の記録で割る」
    /// </summary>
    public Stopwatch Clock { get; } = Stopwatch.StartNew();

    /// <summary>前の読み出しが止まった時点 (取り上げていなければ -1)</summary>
    public long KickedMs { get; set; } = -1;

    /// <summary>同期した時点。選局し直さずに済んだら -1</summary>
    public long TunedMs { get; set; } = -1;

    private long _firstReadMs = -1;

    /// <summary>
    /// **前の報告からあとに、利用者としていたもの。** 溢れの報告は1分に1回なので、報告した瞬間の
    /// <see cref="Sinks"/> だけだと溢れた本人が抜けたあとで「利用者なし」になる (実機の24時間で 42%)。
    /// いた者を覚えておいて、報告のたびに吐き出す
    /// </summary>
    private readonly HashSet<string> _seen = [];

    /// <summary>利用者が来たことを覚える (<see cref="Readers"/>)</summary>
    public void Saw(string use)
    {
        lock (Sinks) _seen.Add(use);
    }

    /// <summary>
    /// 報告に添える名前。**いまいる者と、前の報告からあとにいた者**を並べる。
    /// 読んだら、いまいる者だけに戻す
    /// </summary>
    public string Readers()
    {
        lock (Sinks)
        {
            var now = Sinks.Select(sink => sink.Use).ToArray();
            var who = _seen.Union(now).Order().ToArray();
            _seen.Clear();
            foreach (var use in now) _seen.Add(use);
            return who.Length == 0 ? "利用者なし" : string.Join("・", who);
        }
    }

    public string? Error { get; private set; }
    public int? Pid => _child?.HasExited == false ? _child.Id : null;

    private volatile bool _stopped;
    private Task? _pump;
    /// <summary>デスクランブラが終わった (失敗も含む)。**読み出しも止まる** — 残ると読み出し側を開いたまま回り続ける</summary>
    private volatile bool _drained;
    /// <summary>デスクランブラが回っている (<see cref="TunerPool.Descrambling"/>)</summary>
    public bool Descrambling => _descrambling;
    private volatile bool _descrambling;
    /// <summary>読み出しとデスクランブラの間に溜まっているバイト数</summary>
    private long _queued;

    /// <summary>
    /// 読み出しとデスクランブラの間に溜められる量。**64MB** — 地上波で 25 秒、衛星の中継器まるごとでも 10 秒ほどで、
    /// カードや配り役を待つ上限 (CCID 5 秒・配り役 10 秒・繋ぎ直しの見送り 10 秒) を丸ごと呑める。
    /// **数ではなくバイトで測る** — 読み出し側は溜まっているぶんだけ返すので、1回の読みは小さいこともある
    /// </summary>
    private const long QueueLimit = 64 * 1024 * 1024;

    /// <summary>
    /// **確保したままのデバイスから読んで、復号して配る。** 選局そのものはプールがやる。
    ///
    /// <para>
    /// デバイスは**チューナーごとに開きっぱなし**で、ここでは閉じない (畳むときも読むのをやめるだけ。<see cref="Stop"/>)。
    /// **ストリームが途切れたら失敗として畳む** — 黙って終わると空のファイルが残る。
    /// </para>
    ///
    /// <para>
    /// **読み出しとデスクランブラは別のスレッドで、間にキューを置く** (<see cref="QueueLimit"/>)。カードが固まって
    /// デスクランブラが止まっても、読み出しが待つとデバイスの溜めが溢れて録画が欠ける (docs/agent.md「B25 の復号もカードリーダーも自前」)。
    /// **デスクランブラは選局ごとに作る** — 持ち回さなければ、前の局の鍵が残ることも2本から呼ばれることも起きようがない。
    /// </para>
    /// </summary>
    public void StartNative(ITuneDevice tuner, Action onExit)
    {
        var queue = System.Threading.Channels.Channel.CreateUnbounded<(byte[] Rented, int Length)>(
            new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        // **どちらも専用のスレッドで。** 流れている間ずっと塞ぐので、共用のスレッドプールから借りると
        // HTTP の API が、プールが増えるまで待たされる
        _pump = Task.Factory.StartNew(
            () => Read(tuner, queue.Writer), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        // デスクランブラは待たない (Await)。デバイスに触らず、配り先も畳むときに空になっている
        _ = Task.Factory.StartNew(
            () => Descramble(queue.Reader, onExit), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    /// <summary>
    /// 鍵の要る利用者がいるか (<see cref="Sink.WantsKeys"/>)。番組表・ロゴ・スキャンだけならカードに聞かない
    /// (<see cref="Descrambler"/>)。利用者がいない間 (畳むのを待っている間) は null — 今のままにして、
    /// 戻ってきたライブを溜め直させない
    /// </summary>
    private bool? WantsKeys()
    {
        lock (Sinks) return Sinks.Count == 0 ? null : Sinks.Any(sink => sink.WantsKeys);
    }

    /// <summary>読み出し。読んだぶんを写してキューへ入れる。終わったらキューを閉じる</summary>
    private void Read(ITuneDevice tuner, ChannelWriter<(byte[] Rented, int Length)> queue)
    {
        var buffer = new byte[188 * 1024];
        /*
         * **降りる合図を読み出し側まで渡す。** 渡さないと、電波が来ていない間は
         * `Read` が永久に戻らず、チューナーを取り上げられてもここに残り続ける (Tuning.cs)
         */
        var ring = tuner.Output as DeviceStream;
        // **その選局のぶんだけ数える** — 局を変えている間の溢れを読む側のせいにしない (DeviceStream.Begin)
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
                if (_firstReadMs < 0) _firstReadMs = Clock.ElapsedMilliseconds;

                if (Interlocked.Add(ref _queued, read) > QueueLimit)
                {
                    // デスクランブラが止まったまま埋まった。空くまで読むのを待つ (まれなので、起きて見に行く形で足りる)
                    if (!waited) Log.Write($"[{Tuner}] {Channel}: 復号が追いつかずキューが埋まったので、読むのを待ちます");
                    waited = true;
                    while (Volatile.Read(ref _queued) > QueueLimit && !_stopped && !_drained) Thread.Sleep(10);
                }
                // 写す先は借り物。デスクランブラが復号し終えたら返す (1回が 192KB なので、毎回確保すると大きな塊の置き場を汚す)
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

    /// <summary>デスクランブラ。キューから取って復号し、利用者たちに配る。キューが閉じて空になったら終わる</summary>
    private void Descramble(ChannelReader<(byte[] Rented, int Length)> queue, Action onExit)
    {
        // 選局の時計を渡す。溜めの内訳 (PAT・PMT・ECM) が選局の内訳と同じ物差しで並ぶ
        var b25 = new Descrambler(Keys.Source, Clock, WantsKeys);
        _descrambling = true;
        var decoded = new ArrayBufferWriter<byte>();
        var pushed = false;
        void Push()
        {
            if (decoded.WrittenCount == 0) return;
            if (!pushed)
            {
                pushed = true;
                string At(long ms) => ms < 0 ? "-" : $"{ms}ms";
                Log.Write($"[{Tuner}] {Channel}: 前の読み出し {At(KickedMs)} / 同期 {At(TunedMs)} / "
                    + $"最初の TS {At(_firstReadMs)} / {b25.HeldAt()} / 送り出し {Clock.ElapsedMilliseconds}ms / {b25.CardUse()}"
                    + (b25.Undecodable > 0 ? $" (掛かったまま {b25.Undecodable} パケット)" : ""));
            }
            Broadcast(decoded.WrittenSpan.ToArray());
            decoded.ResetWrittenCount();
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
        _descrambling = false;
        /*
         * **復号できなかったぶんを残す。** 掛かったまま流したものは、録画が
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

    /// <summary>
    /// 溢れを報せる間隔。**終わりにだけ出していた頃は、ライブ視聴と録画が終わるまで一度も報せず**、
    /// 観ている最中に止まった局が落としていたのか分からなかった
    /// </summary>
    private static readonly TimeSpan OverflowReport = TimeSpan.FromMinutes(1);

    /// <summary>
    /// 溢れたぶんを吐き出して記録する。**溢れても選局は生きている**ので畳まない。
    /// 誰が読んでいたか (<see cref="Readers"/>) と、いちばん空いた時間も添える (読み方は docs/agent.md「リングバッファが溢れても畳まない」)
    /// </summary>
    private void ReportOverflows(DeviceStream? ring)
    {
        if (ring is null) return;
        var (count, worstGap, stale) = ring.TakeOverflows();
        if (count == 0)
        {
            // 選局の前に埋まっていたぶんは読む側のせいではない。数には入れず、そうと分かる言い方で残す
            if (stale > 0) Log.Write($"[{Tuner}] {Channel}: 選局前にリングバッファが {stale} 回溢れていました");
            return;
        }
        Log.Write(
            $"[{Tuner}] {Channel}: リングバッファが {count} 回溢れました "
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
        var child = Process.Start(new ProcessStartInfo("setsid", ["sh", "-c", $"{command} \"$1\" \"$2\"", "sh", Type, Channel])
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        })!;
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
                    Broadcast(buffer[..read]);
                }
            }
            catch (Exception error)
            {
                _stderr = error.Message;
            }
        });

        var stderr = Task.Run(async () =>
        {
            // 選局が失敗した理由を読み取るため、末尾だけ持つ
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

    /// <summary>利用者たちに配る。デスクランブラが別のスレッドで回すので、入れ物は Sinks のロックの下で</summary>
    private void Broadcast(byte[] chunk)
    {
        lock (Sinks)
        {
            foreach (var sink in Sinks.ToList()) sink.Push(chunk);
        }
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
     * 確保したままのデバイスは閉じない — チューナーごとに開いたままで、次の選局が
     * 同じものを使う。ここでやるのは合図だけ。読み出し側は 200ms ごとに起きて
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
     * **止まりきるまで待つ。呼ぶのはロックの外で。** 次の選局はこれが返ってから始める (<see cref="TunerPool.Open"/>)。
     * 待つのは読み出しだけ — デスクランブラはデバイスに触らず、配り先も畳むときに空になっている。
     * それでも止まらないときは記録に残す (黙って進むと、取り合いの窓が開いていたのか確かめようが無い)
     */
    public void Await()
    {
        var pump = _pump;
        _pump = null;
        if (pump?.Wait(StopWait) == false) Log.Write($"[{Tuner}] {Channel}: 読み出しが {StopWait.TotalSeconds} 秒で止まりませんでした");
    }

    /// <summary>止まるのを待つ上限。読み出し側は 200ms ごとに起きるので、十分に長い</summary>
    private static readonly TimeSpan StopWait = TimeSpan.FromSeconds(2);
}
