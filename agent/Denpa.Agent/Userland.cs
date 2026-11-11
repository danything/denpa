using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Net.Sockets;

namespace Denpa.Agent;

/// <summary>
/// 同梱のユーザー空間ドライバ (asicen-userland・siano-userland) に共通する部分。
///
/// <para>
/// asicen-userland の <c>asicend</c> は、px4-userland の portable IPC (制御ソケットと TS のソケット) を取り込んだ常駐で、
/// 受信機は制御ソケットで直に取って選局する (<see cref="UserlandTuner"/>)。常駐の起動と見張りは <see cref="UserlandDaemon"/>、
/// 受信機の行 (<c>receiver=0 … system=ISDB-T</c>) は <see cref="UserlandReceiver"/>。siano-userland の <c>siano-ts</c> も
/// 受信機の行は同じ形式で返す。コメントの「SPEC」は px4-userland の SPEC.md (asicen-userland が取り込んだ IPC の仕様)。
/// 作りは docs/agent.md「asicen-userland の作り」。
/// </para>
/// </summary>
public static class Userland
{
    /// <summary>
    /// 同梱物の既定の置き場。Linux (コンテナ) は <paramref name="linux"/>、Mac と Windows はインストーラと同じ
    /// 実行ファイルの隣 (<c>bin/</c> の 1 つ上の <paramref name="name"/>)。常駐を止めて手で <c>--tune</c> を流したときに、
    /// 環境変数を渡さなくても常駐と同じものを使う (Config の置き場と同じ考え)
    /// </summary>
    public static string Beside(string name, string linux) => OperatingSystem.IsLinux()
        ? linux
        : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", name));

    /// <summary>同梱の実行ファイル。Windows だけ <c>.exe</c> が付く (配布 zip の中身のまま)</summary>
    public static string Executable(string dir, string name) =>
        Path.Combine(dir, OperatingSystem.IsWindows() ? $"{name}.exe" : name);

    /// <summary><c>&lt;接頭辞&gt;&lt;筐体&gt;:&lt;受信機&gt;</c> を割る (<c>asicen:1-2:1</c>)。形式が違えば null</summary>
    internal static (string Id, int Receiver)? Parse(string device, string scheme, Func<string, bool> validId)
    {
        if (!device.StartsWith(scheme, StringComparison.Ordinal)) return null;
        var parts = device[scheme.Length..].Split(':');
        if (parts.Length != 2 || !validId(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

    /// <summary>筐体ごとの受信機を設定の形式に (受けられる方式の無い受信機は除く)</summary>
    internal static List<TunerSpec> Specs(
        IEnumerable<(string Id, string Model, IReadOnlyList<UserlandReceiver> Receivers)> enclosures,
        Func<string, string, int, string> name, Func<string, int, string> device) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, device(enclosure.Id, receiver.Index)))),
    ];

    /// <summary>設定に出てくる筐体 (<paramref name="parse"/> で割れる <c>device</c> のもの)。常駐を起動する対象</summary>
    internal static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs, Func<string, (string Id, int Receiver)?> parse) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);
}

/// <summary>
/// 受信機 1 つ。**常駐 (<c>asicenctl list</c>) か <c>siano-ts --list</c> に問い合わせたもの。**
///
/// <para>
/// 受信機ごとに地上波か衛星かが決まっていて、1 つの受信機で両方を受けられる機種もある。
/// その違いはここに入ってくるだけで、こちらは機種を見ない。
/// <c>Lnb15v</c> は LNB に 15V を出せるか。**分からなければ null** で、そのときは要求どおり指定する (合わなければ常駐が断る)。
/// asicen-userland は LNB を出せないので false にする (<see cref="AsicenDaemon"/>)。
/// </para>
/// </summary>
public sealed record UserlandReceiver(int Index, bool Terrestrial, bool Satellite, bool? Lnb15v = null)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

    /// <summary>
    /// 受信機の行 (<c>asicenctl list</c> の出力と、<c>siano-ts --list</c> の受信機の行) を読む。
    ///
    /// <para>
    /// <c>receiver=0 device=1 local=0 system=ISDB-S</c> の行が受信機の数だけ並ぶ。
    /// <c>system</c> は <c>ISDB-T</c> / <c>ISDB-S</c> / <c>ISDB-T/S</c> (どちらも)。
    /// **対応していない値は飛ばして続ける。** 上流が新しくなって方式が増えても、
    /// 分かる受信機は使えるように。飛ばしたことは <paramref name="warn"/> で残す。
    /// </para>
    /// </summary>
    public static List<UserlandReceiver> ParseList(string output, Action<string> warn)
    {
        var found = new List<UserlandReceiver>();
        foreach (var line in output.Split('\n'))
        {
            var fields = Fields(line);
            if (!fields.TryGetValue("receiver", out var index) || !fields.TryGetValue("system", out var system)) continue;
            if (!int.TryParse(index, out var number))
            {
                warn($"受信機の一覧の受信機番号が読めません: {line.Trim()}");
                continue;
            }
            if (From(number, system, warn) is { } receiver) found.Add(receiver);
        }
        return found;
    }

    /// <summary>
    /// <c>key=value</c> を空白で並べた 1 行を割る。同じ鍵が 2 度あれば最初のもの。
    /// <c>siano-ts --list</c> の機材の行 (Siano.cs) も同じ形式
    /// </summary>
    internal static Dictionary<string, string> Fields(string line) => line
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .Select(field => field.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .GroupBy(pair => pair[0], StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.First()[1], StringComparer.Ordinal);

    /// <summary>方式の名前から組み立てる。対応していない方式なら理由を残して null</summary>
    private static UserlandReceiver? From(int number, string system, Action<string> warn)
    {
        (bool Terrestrial, bool Satellite)? kind = system switch
        {
            "ISDB-T" => (true, false),
            "ISDB-S" => (false, true),
            "ISDB-T/S" => (true, true),
            _ => null,
        };
        if (kind is { } known) return new UserlandReceiver(number, known.Terrestrial, known.Satellite);
        warn($"受信機 {number} の方式 {system} には対応していません (上流が新しい?)。この受信機は使いません");
        return null;
    }
}

/// <summary>
/// 筐体を持つ常駐 (<c>asicend</c>)。**筐体 1 台につき 1 つ、使う受信機がある間だけ動かす。**
///
/// <para>
/// 起動するのは最初に要ったとき (起動時の <see cref="Prepare{T}"/> か、初めての選局)。
/// ファームウェアを流し込んでから ready になるので、数秒かかる。
/// 落ちていたら次に要ったときに起動し直す。受信機を全部使わない設定にしたら止める (<see cref="Prepare{T}"/>)。
/// </para>
/// </summary>
public abstract class UserlandDaemon(string name, string id)
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, UserlandDaemon> All = new(StringComparer.Ordinal);

    /// <summary>ready を待つ上限。ファームウェアの流し込みは数秒で済む</summary>
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(30);

    /// <summary>止めるときに後片付けを待つ上限。過ぎたら Kill</summary>
    private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(10);

    protected string Id { get; } = id;
    private readonly Lock _gate = new();
    private Process? _process;
    private volatile string _stderr = "";

    public bool Running => _process is { HasExited: false };

    /// <summary>
    /// 筐体に問い合わせた受信機。**ready になるまで null。** 問い合わせられなかったときも null のままで、
    /// そのときは選局を常駐に任せる (合わなければあちらが断る)
    /// </summary>
    public IReadOnlyList<UserlandReceiver>? Receivers { get; protected set; }

    protected static T For<T>(string id, Func<T> create) where T : UserlandDaemon
    {
        lock (Registry)
        {
            var key = $"{typeof(T).Name} {id}";
            if (!All.TryGetValue(key, out var daemon))
            {
                daemon = create();
                All[key] = daemon;
            }
            return (T)daemon;
        }
    }

    /// <summary>登録してある <typeparamref name="T"/> のうち、いま動いているもの</summary>
    protected static List<T> Live<T>() where T : UserlandDaemon
    {
        lock (Registry) return [.. All.Values.OfType<T>().Where(daemon => daemon.Running)];
    }

    /// <summary>内蔵カードリーダーの名前 (カードの候補に出る名前)</summary>
    public abstract string CardName { get; }

    /// <summary>
    /// 挙げた筐体ぶん起動して ready まで待ち、**挙げなかった <typeparamref name="T"/> は止める。**
    /// 起動時と、設定 (チューナー・カードリーダー) を書き換えたときと、機材を挿したとき。
    ///
    /// <para>
    /// **起動できなくても止まらない。** 筐体が抜けている・ファームウェアが無い、は
    /// その筐体だけの話で、他のチューナー (PT3 など) は変わらず使える。
    /// 理由は記録に残し、選局のときにもう一度試す。
    /// </para>
    ///
    /// <para>
    /// **受信機を全部使わない設定にした筐体は、常駐を止めて USB を手放す。** 動いたままだと、ほかのソフトに
    /// 機材を渡せない (docs/switch.md「並べて動かすとき」)。使う設定に戻せば、ここか次の選局で起動し直す。
    /// 起動したときに使う受信機の無い筐体を起動しないのと同じ。
    /// ただし、**内蔵カードリーダーをいま復号に使っているなら止めない** (<paramref name="cardInUse"/>)。
    /// 止めるとほかのチューナーの復号まで止まる。カードリーダーも使わない設定にすれば止まる
    /// </para>
    /// </summary>
    public static void Prepare<T>(IReadOnlyCollection<string> ids, Func<string, T> daemon, Func<string, bool> cardInUse)
        where T : UserlandDaemon
    {
        List<T> unused;
        lock (Registry) unused = [.. All.Values.OfType<T>().Where(target => target.Running && !ids.Contains(target.Id))];
        foreach (var target in unused)
        {
            if (cardInUse(target.CardName))
            {
                target.Write("使う受信機はありませんが、内蔵カードリーダーを復号に使っているので止めません");
                continue;
            }
            target.Write("使う受信機が無くなったので止めます");
            target.Stop();
        }

        foreach (var id in ids)
        {
            var target = daemon(id);
            try
            {
                target.Ensure();
            }
            catch (Exception error)
            {
                target.Write(error.Message);
            }
        }
    }

    /// <summary>動いていなければ起動して ready まで待つ。駄目なら理由を添えて投げる</summary>
    public abstract void Ensure();

    protected void Write(string message) => Log.Write($"[{name} {Id}] {message}");

    /// <summary>
    /// 起動して、<paramref name="ready"/> が通るまで待つ。<paramref name="runtimeDir"/> (ランタイムルート) は
    /// ここで作る (常駐は下の階層しか作らない決まり。Unix では本人だけが使えるようにする)
    /// </summary>
    internal void Launch(
        string program, IReadOnlyList<string> args, string runtimeDir, Func<bool> ready, Action onReady)
    {
        lock (_gate)
        {
            if (Running) return;
            _process?.Dispose();
            _process = null;

            Directory.CreateDirectory(runtimeDir);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(runtimeDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            var start = new ProcessStartInfo(program, args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // 診断は UTF-8 (パスに日本語が入りうる)
                StandardErrorEncoding = System.Text.Encoding.UTF8,
                UseShellExecute = false,
            };
            var process = Process.Start(start) ?? throw new IOException($"{name} を起動できません");
            _process = process;
            _stderr = "";
            _ = Task.Run(async () =>
            {
                // 診断は全部 stderr に来る
                using var reader = process.StandardError;
                while (await reader.ReadLineAsync() is { } line)
                {
                    _stderr = line;
                    Write(line);
                }
            });
            _ = process.StandardOutput.ReadToEndAsync();

            var deadline = DateTime.UtcNow + ReadyTimeout;
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited)
                {
                    throw new IOException($"{name} が終了しました (exit {process.ExitCode}: {_stderr})");
                }
                if (ready())
                {
                    Write("ready");
                    onReady();
                    return;
                }
                Thread.Sleep(500);
            }

            Stop();
            throw new IOException($"{name} が {ReadyTimeout.TotalSeconds} 秒以内に ready になりません ({_stderr})");
        }
    }

    /// <summary>受信機の行 (<see cref="UserlandReceiver.ParseList"/>) を読んで記録に残す。1 つも読めなければ null</summary>
    protected List<UserlandReceiver>? ListReceivers(string output, string command)
    {
        var receivers = UserlandReceiver.ParseList(output, Write);
        if (receivers.Count == 0)
        {
            Write($"受信機を問い合わせられません ({command}: {output})");
            return null;
        }
        Write($"受信機 {receivers.Count} つ: " + string.Join(", ", receivers.Select(r => $"#{r.Index} {string.Join("/", r.Types)}")));
        return receivers;
    }

    /// <summary>
    /// 止める。**SIGTERM で。** asicend は合図を受けると
    /// 後片付け (LNB を 0V に戻す・socket を消す) をしてから終わる。Kill だとそこが保証されない
    /// </summary>
    public void Stop()
    {
        lock (_gate)
        {
            var process = _process;
            _process = null;
            if (process is null) return;
            if (!process.HasExited)
            {
                Interop.Terminate(process.Id);
                if (!process.WaitForExit(StopGrace))
                {
                    Write($"{StopGrace.TotalSeconds:F0} 秒で終わらないので落とします");
                    process.Kill();
                }
            }
            process.Dispose();
        }
    }

    public static void StopAll()
    {
        List<UserlandDaemon> daemons;
        lock (Registry) daemons = [.. All.Values];
        foreach (var daemon in daemons) daemon.Stop();
    }
}

/// <summary>
/// 常駐 (asicend) の受信機 1 つ。**常駐の制御ソケットで受信機を取り、取ったまま選局し直す。**
///
/// <para>
/// 最初の選局で <c>ACQUIRE → TUNE → START_STREAM → ATTACH_STREAM</c>、2 回目からは
/// <c>STOP_STREAM → TUNE → START_STREAM → ATTACH_STREAM</c> (SPEC 6.3)。
/// 返すのは <see cref="Dispose"/> (<c>RELEASE</c>) と、取ったままでは続けられない失敗のときだけ
/// (<see cref="Keeps"/>。返すと常駐が電源を落とし、次の選局が遅くなる)。
/// TS は <c>stream.sock</c> に来る (<see cref="UserlandStream"/>)。誰も読まなくなったら TS のストリームだけ畳み、
/// 次の選局は同じ lease で選局し直す (<see cref="Tuned"/>)。docs/agent.md「asicen-userland の作り」
/// </para>
/// </summary>
public sealed class UserlandTuner : ITuneDevice
{
    /// <summary>同期を待つ上限 (TUNE の <c>timeout_ms</c>)。DVB 側 (<c>DvbTuner.LockTimeout</c>) と同じ。総当たりの一周がこれで決まる</summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(5);

    /// <summary>同期のあと最初の TS が来るまでの猶予</summary>
    private static readonly TimeSpan FirstTsGrace = TimeSpan.FromSeconds(3);

    /// <summary>TUNE 以外の 1 回のやり取りの上限。px4-userland の px4-ts と同じ</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(4);

    /// <summary>
    /// TUNE が BUSY で返ったときに待ち直す上限。前の TS のストリームの後始末 (閉じた stream.sock を
    /// 常駐が畳む) と行き違うと、ほんの一瞬だけ BUSY になる
    /// </summary>
    private static readonly TimeSpan BusyRetry = TimeSpan.FromSeconds(1);

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly string _runtimeDir;
    private readonly Func<IReadOnlyList<UserlandReceiver>?> _prepare;
    private readonly string _name;

    /// <summary>通信する相手 (フレームのヘッダとソケットの置き場)</summary>
    private readonly UserlandWire _wire;

    /// <summary>設定の <c>device</c> (注意書きの鍵。<see cref="TunerNotice.Get"/>)</summary>
    private readonly string _device;

    private readonly Lock _gate = new();

    /// <summary>
    /// 筐体ごとの順番。**常駐に受信機の要求を送るのは、同じ筐体で 1 度に 1 つ。**
    ///
    /// <para>
    /// 常駐は同じブリッジの受信機の要求を 1 つのキューで順に片付ける。
    /// こちらの待つ上限 (TUNE なら 7 秒) は送ったときから数えるので、ほかの受信機の TUNE が
    /// キューに並んでいると、その待ちまで上限に含まれる。同期しない TUNE は 1 つ 5 秒かかり、
    /// 複数のチューナーでスキャンすると後ろのほうが時間切れになっていた。時間切れを
    /// 接続が切れたとみなして受信機を返し、取り直しは前の lease が残っていて BUSY で断られ、
    /// そのチャンネルが結果から落ちた (#1713)。こちらで 1 つずつ送れば、待つのは自分の処理のぶんだけ。
    /// どうせ常駐が順に処理するので、選局が遅くなるわけではない。
    /// </para>
    /// <para>
    /// 区切りは筐体 (制御ソケット) 単位。どの受信機が同じキューかは常駐の中の作りなので当てにしない
    /// (Q3U4 のようにキューが 2 つある筐体でも、ブリッジをまたいだ選局が少し待つだけ)。
    /// START_STREAM から ATTACH_STREAM までは常駐が 5 秒しか待たないので、その間も放さない。
    /// 閉じるとき (<see cref="Dispose"/>) は並ばない。応答が来なくても接続を閉じれば常駐が受信機を返す。
    /// カード (UserlandCard.cs) は常駐の別のキューなので入れない
    /// </para>
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Lock> Turns = new();

    private readonly Lock _turn;

    /// <summary>受信機を取っている制御ソケット。null なら取っていない</summary>
    private UserlandControl? _control;

    private ulong _lease;
    private byte[] _nonce = [];

    /// <summary>START_STREAM が通ってから STOP_STREAM を送るまで</summary>
    private bool _started;

    private UserlandStream? _stream;

    /// <summary>15V を落としたことを記録に残したか (<see cref="WarnLnb"/>)</summary>
    private bool _lnbWarned;

    /// <summary>最後の選局の応答の C/N (<see cref="Signal"/>)</summary>
    private TunerSignal? _tuned;

    /// <summary>STATS を問い合わせるタイマー。流している間だけ (<see cref="StartStats"/>)</summary>
    private Timer? _statsTimer;

    /// <summary>前に取得した数。**増えたぶんだけ記録に残す** (<see cref="UserlandCounters.Describe"/>)</summary>
    private UserlandCounters? _counters;

    /// <param name="prepare">
    /// 選局の前に呼ぶ。常駐を起動して、筐体に問い合わせた受信機を返す (問い合わせられていなければ null)。
    /// テストは偽の常駐を使うので何もしない
    /// </param>
    /// <param name="wire">通信する相手。省けば asicend (<see cref="UserlandWire.Asicen"/>)</param>
    /// <param name="device">設定の <c>device</c>。省けば <c>asicen:&lt;ポート&gt;:&lt;受信機&gt;</c></param>
    /// <param name="name">記録に出す名前。省けば <c>asicen-&lt;ポート&gt; #&lt;受信機&gt;</c></param>
    internal UserlandTuner(
        string id, int receiver, string? lnb, string runtimeDir, Func<IReadOnlyList<UserlandReceiver>?> prepare,
        UserlandWire? wire = null, string? device = null, string? name = null)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _runtimeDir = runtimeDir;
        _prepare = prepare;
        _wire = wire ?? UserlandWire.Asicen;
        _device = device ?? AsicenUserland.Device(id, receiver);
        _name = name ?? $"asicen-{id} #{receiver}";
        _turn = Turns.GetOrAdd(UserlandControl.Endpoint(runtimeDir, id, "control.sock", _wire), _ => new Lock());
    }

    /// <summary>読む側がいないままバッファが空かなければ、この時間で TS のストリームを畳む</summary>
    internal TimeSpan StallLimit { get; init; } = UserlandStream.DefaultStallLimit;

    /// <summary>
    /// 流している間に STATS を問い合わせる間隔。**誤りが増えたときだけ記録に残す。** 画面で途切れたとき、
    /// 受信機の側で落ちていたのか、届き方が揺れただけなのかを見分ける (#1210)
    /// </summary>
    internal TimeSpan StatsEvery { get; init; } = TimeSpan.FromSeconds(30);

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    /// <summary>
    /// 受信機を取っていて、TS がまだ流れているか。**ロックの下で読む。** <c>Dispose</c> は TunerPool の <c>Held.Close</c>
    /// や STATS の定期取得と別のスレッドから来るので、畳んでいる最中のものに触らないように
    /// </summary>
    public bool Tuned
    {
        get
        {
            lock (_gate) return _control is not null && _stream is { Ended: false };
        }
    }

    /// <summary>
    /// 選局したときの C/N。**常駐は C/N を TUNE の応答でしか返さない** (STATS には無い) ので、受信中は選局したときの値のまま。
    /// 取得し直すには選局し直すしかなく、それでは受信が途切れる。
    /// **ロックを取らない。** STATS の定期取得が <c>_gate</c> を握ったまま筐体の順番を最長数秒待つので、取ると TunerPool.ReadSignals がそこで止まる
    /// (3 つを別々に読む。選局し直しの最中に前の値か null が返るだけ)
    /// </summary>
    public TunerSignal? Signal() => Volatile.Read(ref _control) is not null && Volatile.Read(ref _stream) is { Ended: false } ? Volatile.Read(ref _tuned) : null;

    /// <summary>
    /// TUNE の応答 <c>u8 locked, i32 cnr_mdb</c> (SPEC 6.4。little-endian) の C/N。<c>cnr_mdb</c> は 0.001 dB 刻みで、
    /// 分からなければ <c>INT32_MIN</c>。C/N の付いていない応答なら C/N は null
    /// </summary>
    public static TunerSignal TuneSignal(ReadOnlySpan<byte> answer)
    {
        var locked = answer.Length >= 1 && answer[0] != 0;
        double? cn = answer.Length >= 5 && BinaryPrimitives.ReadInt32LittleEndian(answer[1..]) is var mdb && mdb != int.MinValue ? mdb / 1000.0 : null;
        return new TunerSignal(locked, cn, TunerSignal.Db, AtTune: true);
    }

    /// <summary>
    /// TUNE の中身 (SPEC 6.4)。**選局表の値をそのまま。**
    /// <c>u64 lease_id, u8 system, u64 frequency_khz, u16 stream_id, u16 slot, u32 bandwidth_hz, u8 lnb_voltage, u32 timeout_ms</c>
    ///
    /// <para>
    /// 周波数は kHz で指定する。選局表は DVB の決まりで地上波が Hz・衛星が kHz
    /// なので、地上波だけ 1000 で割る (473142857 Hz → 473142 kHz。端数は切る)。
    /// 衛星は名前に TSID があれば <c>stream_id</c> で、無ければ (NIT を読むための選局と CS) <c>slot</c> 0 で
    /// 中継器の先頭の TS を取る。使わないほうは 0xffff。
    /// 帯域は地上波が 6MHz、衛星は 0 (常駐がこれ以外を断る)。
    /// 15V は設定に <c>15v</c> と書いてあるチューナーだけ指定する (<c>11v</c> は IPC に無い)。
    /// </para>
    /// </summary>
    public static byte[] TuneRequest(ulong lease, ChannelTable.Tuning tuning, uint streamId, string? lnb)
    {
        const ushort unused = 0xffff;
        var payload = new byte[30];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, lease);
        payload[8] = (byte)(tuning.Satellite ? 2 : 1);
        BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(9), tuning.Satellite ? tuning.Frequency : tuning.Frequency / 1000);
        var byId = tuning.Satellite && streamId != ChannelTable.NoStreamId;
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(17), byId ? (ushort)streamId : unused);
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(19), tuning.Satellite && !byId ? (ushort)0 : unused);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(21), tuning.Satellite ? 0u : 6_000_000u);
        payload[25] = (byte)(tuning.Satellite && lnb == "15v" ? 15 : 0);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(26), (uint)TuneTimeout.TotalMilliseconds);
        return payload;
    }

    /// <summary>
    /// 選局する。**取っていれば取ったまま、切れていれば取り直す。**
    ///
    /// <para>
    /// 取っていたはずの接続が切れていた (常駐が起動し直された・lease が無い) ときは、
    /// その場で 1 度だけ取り直して続ける。同期しなかった (TIMEOUT) ときは受信機を取ったまま
    /// 投げる。総当たりのスキャンは同期しないチャンネルのほうが多く、そのたびに返すと
    /// 電源の入れ直しからやり直しになる。
    /// </para>
    /// </summary>
    public void Tune(ChannelTable.Tuning tuning)
    {
        var streamId = tuning.StreamId;
        lock (_gate)
        {
            var receivers = _prepare();
            Check(receivers, _receiver, tuning);
            var lnb = Lnb(receivers, _receiver, tuning, _lnb);
            if (lnb != _lnb) WarnLnb();
            DropStream();
            var reused = _control is not null;
            lock (_turn)
            {
                try
                {
                    Attempt(tuning, streamId, lnb);
                }
                catch (IOException error) when (reused && Lost(error))
                {
                    Log.Write($"[{_name}] {_wire.Daemon} との接続が切れていたので、受信機を取り直します ({error.Message})");
                    Attempt(tuning, streamId, lnb);
                }
            }
        }
    }

    /// <summary>
    /// TUNE で指定する LNB。**15V を出せない受信機なら、15V と書いてあっても 0V で選局する。**
    ///
    /// <para>
    /// asicend は LNB を出せず、15V の指定を断る (<see cref="AsicenUserland.Receivers"/>)。
    /// そのまま指定すると衛星の選局が全部落ち、EPG の取り直しもスキャンも衛星だけ通らなくなる。
    /// 断る代わりに 0V で合わせるのは、0V での衛星受信は使えて、
    /// アンテナは別の機器 (ほかのチューナー・ブースター・分配器) から給電されていることが多いから。
    /// 給電が無ければ「同期しませんでした」で落ちるので、なぜ 0V なのかは記録と画面に残す
    /// (<see cref="WarnLnb"/>)。可否が分からない (null) ときは要求どおり指定する。
    /// </para>
    /// </summary>
    public static string? Lnb(IReadOnlyList<UserlandReceiver>? receivers, int index, ChannelTable.Tuning tuning, string? lnb)
    {
        if (lnb != "15v" || !tuning.Satellite) return lnb;
        var receiver = receivers?.FirstOrDefault(r => r.Index == index);
        return receiver?.Lnb15v == false ? null : lnb;
    }

    /// <summary>15V を落としたことを残す。**記録は 1 度だけ** (局替えのたびに出すと埋もれる)、画面には出し続ける</summary>
    private void WarnLnb()
    {
        const string notice = "この受信機は LNB に 15V を出せないので、0V で選局しています (設定の LNB 15V は効きません。アンテナへの給電はほかの機器から)";
        TunerNotice.Set(_device, this, notice);
        if (_lnbWarned) return;
        _lnbWarned = true;
        Log.Write($"[{_name}] {notice}");
    }

    /// <summary>
    /// 制御ソケットが使えなくなった (常駐のエラーの応答ではない、または lease がもう無い)。
    /// **TS のストリームの失敗 (<see cref="UserlandStreamError"/>) は入れない。** 制御ソケットは使える状態で、
    /// ここで取り直すと「接続が切れていた」と誤った記録が残る
    /// </summary>
    private static bool Lost(IOException error) => error switch
    {
        UserlandStreamError => false,
        UserlandError failed => failed.Code == UserlandError.NotFound,
        _ => true,
    };

    /// <summary>
    /// 受信機を取ったまま次に進める失敗か。同期しなかった・指定が合わなかった (TUNE)、
    /// ATTACH は通ったが TS が駄目だった (<see cref="UserlandStreamError.KeepsLease"/>)。それ以外は受信機を返して閉じる
    /// </summary>
    private static bool Keeps(IOException error) =>
        error is UserlandStreamError { KeepsLease: true } || error is UserlandError { Code: UserlandError.Timeout or UserlandError.InvalidArgument };

    private void Attempt(ChannelTable.Tuning tuning, uint streamId, string? lnb)
    {
        try
        {
            if (_control is null) Open();
            Run(tuning, streamId, lnb);
        }
        catch (IOException error) when (!Keeps(error))
        {
            Close();
            throw;
        }
    }

    /// <summary>繋いで受信機を取る (HELLO → ACQUIRE)</summary>
    private void Open()
    {
        var control = UserlandControl.Connect(
            UserlandControl.Endpoint(_runtimeDir, _id, "control.sock", _wire), UserlandControl.StreamStatsCapability, RequestTimeout, _wire);
        try
        {
            var answer = control.Request(UserlandControl.Acquire, [(byte)_receiver]);
            if (answer.Length != 24) throw new IOException($"{_wire.Daemon} の ACQUIRE の応答が {answer.Length} バイトです (24 のはず)");
            var lease = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            if (lease == 0) throw new IOException($"{_wire.Daemon} の ACQUIRE の応答の lease が 0 です");
            _lease = lease;
            _nonce = answer[8..24];
        }
        catch (UserlandError error)
        {
            control.Dispose();
            throw new UserlandError(error.Code, $"受信機 {_receiver} を取れません ({error.Message})");
        }
        catch
        {
            control.Dispose();
            throw;
        }
        _control = control;
        _started = false;
        Log.Write($"[{_name}] 受信機を取りました");
    }

    /// <summary>STOP_STREAM / START_STREAM / RELEASE の中身 (lease だけ)</summary>
    private byte[] Lease() => UserlandControl.WithId(_lease);

    /// <summary>(流していれば止めて) 合わせて、流し始めて、TS を受け取りにいく</summary>
    private void Run(ChannelTable.Tuning tuning, uint streamId, string? lnb)
    {
        var control = _control!;
        var lease = Lease();

        if (_started)
        {
            StopStats();
            try
            {
                Counted(control.Request(UserlandControl.StopStream, lease, RequestTimeout));
            }
            catch (UserlandError error) when (error.Code == UserlandError.NotReady)
            {
                // もう止まっている (閉じた stream.sock を常駐が先に畳んだ)
            }
            _started = false;
        }

        // 選局し直しが失敗したら、前のチャンネルの C/N を残さない
        _tuned = null;
        var tune = TuneRequest(_lease, tuning, streamId, lnb);
        var busyUntil = DateTime.UtcNow + BusyRetry;
        byte[] answer;
        while (true)
        {
            try
            {
                // 常駐は timeout_ms で同期をやめて応答する。それより少し長く待つ (px4-userland の px4-ts と同じ +2 秒)
                answer = control.Request(UserlandControl.Tune, tune, TuneTimeout + TimeSpan.FromSeconds(2));
                break;
            }
            catch (UserlandError error) when (error.Code == UserlandError.Busy && DateTime.UtcNow < busyUntil)
            {
                Thread.Sleep(50);
            }
            catch (UserlandError error) when (error.Code == UserlandError.Timeout)
            {
                throw new UserlandError(UserlandError.Timeout, ITuneDevice.SyncFailed);
            }
        }
        // u8 locked, i32 cnr_mdb。常駐は同期したときしか成功を返さないが、px4-userland の px4-ts と同じく locked も見る
        if (answer.Length < 1 || answer[0] == 0) throw new UserlandError(UserlandError.Timeout, ITuneDevice.SyncFailed);
        _tuned = TuneSignal(answer);

        control.Request(UserlandControl.StartStream, lease, RequestTimeout);
        _started = true;
        _counters = null;
        _stream = UserlandStream.Attach(
            UserlandControl.Endpoint(_runtimeDir, _id, "stream.sock", _wire), _lease, _nonce, _name, StallLimit, FirstTsGrace, _wire);
        StartStats(control);
    }

    /// <summary>
    /// 流している間、STATS を <see cref="StatsEvery"/> ごとに問い合わせる。**常駐が STATS を持っていなければ問い合わせない**
    /// (HELLO で認められた機能に無い。テストの偽物もこれ)
    /// </summary>
    private void StartStats(UserlandControl control)
    {
        StopStats();
        if ((control.Capabilities & UserlandControl.StreamStatsCapability) == 0) return;
        _statsTimer = new Timer(_ => PollStats(), null, StatsEvery, StatsEvery);
    }

    private void StopStats()
    {
        _statsTimer?.Dispose();
        _statsTimer = null;
    }

    /// <summary>
    /// STATS を 1 回問い合わせる。**制御ソケットは選局と同じロックの下で使う** (1 本で同時に 1 つしか送れない)。
    /// 問い合わせられなくてもストリームは止めない。接続の不具合なら次の選局で分かる
    /// </summary>
    private void PollStats()
    {
        lock (_gate)
        {
            if (_control is not { } control || !_started || _stream is not { Ended: false } || _statsTimer is null) return;
            try
            {
                lock (_turn) Counted(control.Request(UserlandControl.Stats, Lease(), RequestTimeout));
            }
            catch (IOException error)
            {
                Log.Write($"[{_name}] {_wire.Daemon} に TS の数を問い合わせられませんでした。以降は問い合わせません ({error.Message})");
                StopStats();
            }
        }
    }

    /// <summary>STATS・STOP_STREAM の応答 (数) を読み、**誤りが増えていたら記録に残す**</summary>
    private void Counted(byte[] answer)
    {
        if (UserlandCounters.Parse(answer) is not { } now) return;
        if (UserlandCounters.Describe(_counters, now) is { } grew) Log.Write($"[{_name}] {_wire.Daemon} の TS の数: {grew}");
        _counters = now;
    }

    /// <summary>
    /// 筐体に問い合わせた受信機と、要求された選局が合っているか。**合わなければ常駐に送る前に断る。**
    /// 受信機を問い合わせられていなければ (<paramref name="receivers"/> が null) 見ずに通す (合わなければ常駐が断る)
    /// </summary>
    public static void Check(IReadOnlyList<UserlandReceiver>? receivers, int index, ChannelTable.Tuning tuning)
    {
        if (receivers is null) return;
        var receiver = receivers.FirstOrDefault(r => r.Index == index)
            ?? throw new IOException(
                $"受信機 {index} はありません (この筐体にあるのは {string.Join(", ", receivers.Select(r => r.Index))})");
        if (!receiver.Accepts(tuning))
        {
            throw new IOException(
                $"受信機 {index} は {string.Join("/", receiver.Types)} 用です ({tuning.Type} は受けられません)");
        }
    }

    /// <summary>
    /// TS のストリームを畳む。**stream.sock を閉じるのは TUNE より前に。** nonce は lease の間ずっと
    /// 同じなので、前の stream.sock の後始末を常駐が次の START_STREAM より後に回すと、
    /// 新しいストリームのほうを取り消してしまう (常駐は閉じた接続の後始末で同じ lease と nonce の
    /// ストリームを取り消す)。先に閉じておけば、常駐は TUNE に応答するより前にそれを検出する
    /// </summary>
    private void DropStream()
    {
        var stream = _stream;
        _stream = null;
        stream?.Stop();
    }

    /// <summary>受信機を返して閉じる。**失敗しても構わない。** 接続を閉じれば常駐の側で返される (SPEC 6.3)</summary>
    private void Close()
    {
        StopStats();
        DropStream();
        var control = _control;
        _control = null;
        if (control is null) return;
        var lease = Lease();
        try
        {
            if (_started) Counted(control.Request(UserlandControl.StopStream, lease, RequestTimeout));
        }
        catch (IOException)
        {
        }
        try
        {
            control.Request(UserlandControl.Release, lease, RequestTimeout);
        }
        catch (IOException)
        {
        }
        _started = false;
        control.Dispose();
        Log.Write($"[{_name}] 受信機を返しました");
    }

    public void Dispose()
    {
        lock (_gate) Close();
        // 設定が変わって閉じるときも通る。新しい定義で 15V をやめていれば、もう出さない
        TunerNotice.Clear(_device, this);
    }
}

/// <summary>
/// 受信機を取ったままの間に、TS のストリームが駄目だった (ATTACH を断られた・TS が来なかった)。
/// **受信機は返さない。** 次の選局で同じ lease のまま STOP_STREAM → TUNE からやり直せる
/// </summary>
internal sealed class UserlandStreamError(string message, bool keepsLease) : IOException(message)
{
    /// <summary>
    /// 受信機を取ったまま次に進めるか。**ATTACH_STREAM が通っていれば (ストリームが active) 進める。**
    /// 次の STOP_STREAM で畳める。通らなかったときは常駐の lease が「armed」のまま残り、
    /// TUNE も START_STREAM も BUSY で返るようになる (常駐は armed の期限切れを ATTACH でしか
    /// 見ない) ので、返して取り直すしかない
    /// </summary>
    public bool KeepsLease { get; } = keepsLease;
}

/// <summary>
/// 常駐から TS を受け取る 1 回ぶん (START_STREAM 1 回につき 1 つ)。
///
/// <para>
/// <c>stream.sock</c> に繋いで ATTACH_STREAM (lease と nonce) を送ると、あとは常駐が
/// TS_DATA のフレームを送り続け、止めると STREAM_END が来る (SPEC 6.3 / 6.4)。フレームの中身はソケットから
/// <see cref="Pipe"/> のメモリ (<see cref="PipeWriter.GetMemory"/>) へ直に受け、その読む側を読み出し側 (<see cref="DeviceStream"/>) に載せる。
/// OS の pipe は使わない (Windows に poll が無く、深さも OS ごとに違った) ので、バッファの深さは <see cref="TsBuffer.Depth"/> で決め打つ。
/// </para>
///
/// <para>
/// **読む側がいないとバッファが埋まる。** 書けないまま <see cref="DefaultStallLimit"/> 経ったら
/// stream.sock を閉じて終わる。放っておくと常駐のバッファ (地上波で 5 秒ほど) が溢れて SLOW_CONSUMER になるが、
/// その通知 (STREAM_END) も読まないソケットの奥に詰まって届かない。こちらで見切る。
/// </para>
/// </summary>
internal sealed class UserlandStream
{
    /// <summary>バッファが空かないまま待つ上限。常駐のバッファが溢れるのと同じくらい</summary>
    public static readonly TimeSpan DefaultStallLimit = TimeSpan.FromSeconds(5);

    /// <summary>
    /// TS がこれだけ来なければ終わる。px4-userland の px4-ts と同じ 5 秒。**バッファに書けずに待っている間は数えない**
    /// (そちらは <see cref="DefaultStallLimit"/>)
    /// </summary>
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(5);

    /// <summary>TS_DATA の中身の先頭 (u64 sequence, u64 cumulative_drop_count, u32 byte_count)</summary>
    private const int TsHeaderSize = 20;

    private readonly Socket _socket;
    private readonly string _name;
    private readonly TimeSpan _stallLimit;
    private readonly UserlandWire _wire;
    private readonly ManualResetEventSlim _first = new();

    private readonly Pipe _pipe = TsBuffer.New();

    private Thread? _pump;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    /// <summary>ATTACH_STREAM が通ったか (常駐の側でストリームが active になった)</summary>
    private bool _attached;

    /// <summary>バッファに 1 フレームでも書けたか (Attach が待つのはこれ)</summary>
    private volatile bool _delivered;
    private ulong _sequence;

    public DeviceStream Output { get; }

    /// <summary>ストリームが終わった (常駐が止めた・切れた・読む側がいなくて畳んだ・こちらで止めた)</summary>
    public bool Ended => _ended;

    private UserlandStream(Socket socket, string name, TimeSpan stallLimit, UserlandWire wire)
    {
        _socket = socket;
        _name = name;
        _stallLimit = stallLimit;
        _wire = wire;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
    }

    /// <summary>
    /// 繋いで ATTACH_STREAM を送り、**最初の TS が来るまで待つ。** 来なければ理由を添えて
    /// <see cref="UserlandStreamError"/> を投げる (繋いだものは閉じてある)
    /// </summary>
    public static UserlandStream Attach(
        string socketPath, ulong lease, byte[] nonce, string name, TimeSpan stallLimit, TimeSpan firstTs, UserlandWire? wire = null)
    {
        wire ??= UserlandWire.Asicen;
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = 4000,
            ReceiveTimeout = 4000,
        };
        var stream = new UserlandStream(socket, name, stallLimit, wire);
        try
        {
            UserlandControl.ConnectWithin(socket, socketPath, TimeSpan.FromSeconds(4), wire);
            var payload = UserlandControl.WithId(lease, 8 + nonce.Length);
            nonce.CopyTo(payload, 8);
            // px4-userland の px4-ts と同じく request_id 0。最初のフレームは ATTACH_STREAM でなければならない (HELLO は無い)
            UserlandControl.SendAll(socket, UserlandControl.Encode(UserlandControl.AttachStream, 0, 0, payload, wire));
            var (type, flags, _, body) = UserlandControl.ReadFrame(socket, UserlandControl.MaxPayload, wire);
            if (type != UserlandControl.AttachStream || (flags & UserlandControl.ResponseFlag) == 0)
            {
                throw new IOException($"{wire.Daemon} から ATTACH_STREAM の応答ではないものが来ました (型 0x{type:x4})");
            }
            if ((flags & UserlandControl.ErrorFlag) != 0) throw UserlandControl.Failed(body, wire);
            stream._attached = true;
            // 待つのは pump のほう。ここからは Poll で戻るので、読むときの上限は途中で詰まったときだけ
            socket.ReceiveTimeout = (int)SilenceLimit.TotalMilliseconds;
            // **専用のスレッドで。** 流れている間ずっと塞ぐ
            stream._pump = new Thread(stream.Pump) { IsBackground = true, Name = $"{name} TS" };
            stream._pump.Start();
        }
        catch (Exception error) when (error is IOException or SocketException)
        {
            socket.Dispose();
            stream._first.Dispose();
            throw new UserlandStreamError($"{wire.Daemon} から TS を受け取れません ({error.Message})", stream._attached);
        }

        if (!stream._first.Wait(firstTs))
        {
            stream.Stop();
            throw new UserlandStreamError($"同期したのに TS が {firstTs.TotalSeconds:F0} 秒来ません", keepsLease: true);
        }
        // 1 フレームでも渡せていれば成功。すぐ後に終わっても、読む側は TS を読んでから理由を受け取る
        if (!stream._delivered)
        {
            var reason = stream._reason ?? $"{wire.Daemon} との TS の接続が切れました";
            stream.Stop();
            throw new UserlandStreamError(reason, keepsLease: true);
        }
        return stream;
    }

    private void Pump()
    {
        var writer = _pipe.Writer;
        Span<byte> header = stackalloc byte[UserlandControl.HeaderSize];
        Span<byte> ts = stackalloc byte[TsHeaderSize];
        try
        {
            var heard = Stopwatch.StartNew();
            while (!_stopped)
            {
                if (!_socket.Poll(TimeSpan.FromMilliseconds(200), SelectMode.SelectRead))
                {
                    if (heard.Elapsed < SilenceLimit) continue;
                    End($"{_wire.Daemon} から TS が {SilenceLimit.TotalSeconds:F0} 秒来ません");
                    return;
                }
                var (type, flags, _, length) = UserlandControl.ReadHeader(_socket, header, UserlandControl.MaxTsPayload, _wire);
                if (type != UserlandControl.TsData)
                {
                    // TS_DATA 以外 (STREAM_END) は小さい。いつもどおり byte[] で受ける
                    if (length > UserlandControl.MaxPayload)
                    {
                        End($"{_wire.Daemon} のフレームが長すぎます (型 0x{type:x4}、{length} バイト)");
                        return;
                    }
                    var body = new byte[length];
                    UserlandControl.Receive(_socket, body, _wire);
                    if (type == UserlandControl.StreamEnd && body.Length >= UserlandCounters.Size + 4)
                    {
                        // final counters (u64 × 8) のあとに u32 error_code。**誤りがあれば数も残す** (途切れの切り分けに)
                        if (UserlandCounters.Parse(body) is { } final && UserlandCounters.Describe(null, final) is { } errors)
                        {
                            Log.Write($"[{_name}] {_wire.Daemon} の TS の数 (止まるまで): {errors}");
                        }
                        var code = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(UserlandCounters.Size));
                        End(code == 0 ? $"{_wire.Daemon} が TS を止めました" : $"{_wire.Daemon} が TS を止めました ({UserlandControl.Reason(code)})");
                        return;
                    }
                    End(type == UserlandControl.StreamEnd
                        ? $"{_wire.Daemon} が TS を止めました (STREAM_END が短くて理由が読めません、{length} バイト)"
                        : $"{_wire.Daemon} から想定していない型のフレームが来ました (型 0x{type:x4})");
                    return;
                }
                if (flags != 0 || length < TsHeaderSize)
                {
                    End($"{_wire.Daemon} の TS_DATA のフレームが崩れています (flags 0x{flags:x4}、{length} バイト)");
                    return;
                }
                // u64 sequence, u64 cumulative_drop_count, u32 byte_count, bytes
                UserlandControl.Receive(_socket, ts, _wire);
                var sequence = BinaryPrimitives.ReadUInt64LittleEndian(ts);
                var dropped = BinaryPrimitives.ReadUInt64LittleEndian(ts[8..]);
                var count = BinaryPrimitives.ReadUInt32LittleEndian(ts[16..]);
                if (count != length - TsHeaderSize || count % 188 != 0)
                {
                    End($"{_wire.Daemon} の TS_DATA の長さが崩れています ({count} バイト)");
                    return;
                }
                if (dropped != 0)
                {
                    End($"{_wire.Daemon} が TS を {dropped} 回捨てました ({UserlandControl.Reason(UserlandError.SlowConsumer)})");
                    return;
                }
                if (sequence != _sequence)
                {
                    End($"{_wire.Daemon} の TS_DATA の番号が飛びました ({_sequence} のはずが {sequence})");
                    return;
                }
                _sequence++;
                // 中身はバッファのメモリに直に受ける。途中で切れたら渡さずに終わる (Advance しない)
                var size = (int)count;
                UserlandControl.Receive(_socket, writer.GetMemory(size).Span[..size], _wire);
                writer.Advance(size);
                if (!Flush(writer)) return;
                _delivered = true;
                _first.Set();
                heard.Restart();
            }
        }
        catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
        {
            End($"{_wire.Daemon} との TS の接続が切れました ({error.Message})");
        }
        finally
        {
            _ended = true;
            _socket.Dispose();
            // 読む側はこれで尽き、_reason を添えて終わる (DeviceStream の ended)
            writer.Complete();
            _first.Set();
        }
    }

    /// <summary>書いたぶんを読む側に渡す (<see cref="TsBuffer.Flush"/>)。**バッファが空かないまま <see cref="_stallLimit"/> 経ったらやめる** (読む側がいない)</summary>
    private bool Flush(PipeWriter writer) => TsBuffer.Flush(writer, () => _stopped, _stallLimit,
        () => End($"読む側がいないまま {_stallLimit.TotalSeconds:F0} 秒経ったので TS のストリームを閉じました (受信機は取ったまま)"),
        // 読み出し側が閉じた (こちらで止めた。理由は End が残さない)
        () => End("TS を渡せません (読み出し側が閉じました)"));

    /// <summary>終わった理由を残す。**こちらで止めたときは残さない** (読む側には普通の終わり)</summary>
    private void End(string reason)
    {
        if (_stopped) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>
    /// 止める。pump を止めて stream.sock を閉じ、読みかけの読む側が戻ってからバッファを閉じる
    /// (<see cref="DeviceStream.WaitReaders"/>、長くても <see cref="ChildTs.ReaderDrain"/>。
    /// 抜けかけの読む側が閉じたバッファに触らないように)。**局替えのたびに通る**ので、固定では待たない
    /// </summary>
    public void Stop()
    {
        /*
         * **理由は消さない。** ここから先は End が理由を残さない (_stopped) ので、残っているのは
         * 止める前に向こうから終わった理由だけ。読む側がバッファの残りを読み切る前に次の選局が
         * 来ても、読む側には「常駐が TS を止めました (…)」が届く
         */
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        // pump を今すぐ戻す (Poll の 200ms を待たない)。Shutdown を呼べば Poll が戻り、読めば 0 で抜ける
        try
        {
            _socket.Shutdown(SocketShutdown.Both);
        }
        catch (Exception error) when (error is SocketException or ObjectDisposedException)
        {
            // 繋がっていない・もう閉じた
        }
        if (_pump is { } pump && !pump.Join(TimeSpan.FromSeconds(1)))
        {
            _socket.Dispose();
            pump.Join(TimeSpan.FromSeconds(1));
        }
        _socket.Dispose();
        // pump が抜けてから閉じる。抜けきれずに残っていると最後に Set するので、そのときは閉じない (GC に任せる)
        if (_pump is not { IsAlive: true }) _first.Dispose();
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}
