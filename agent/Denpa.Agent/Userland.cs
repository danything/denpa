using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 同梱の常駐 (asicen-userland の <c>asicend</c>) を使う機材に共通する部分。
///
/// <para>
/// 設定の <c>device</c> の形式 (<c>&lt;接頭辞&gt;&lt;筐体&gt;:&lt;受信機&gt;</c>) と、受信機 (<see cref="UserlandReceiver"/>)、
/// 常駐の起動と停止 (<see cref="UserlandDaemon"/>)。制御ソケットでのやり取りは AsicenUdtv.cs、
/// 作りは docs/agent.md「asicen-userland の作り」。
/// </para>
/// </summary>
public static class Userland
{
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

    /// <summary>
    /// 常駐のランタイムルートを作る。常駐は下の階層しか作らない決まりで、asicend は持ち主だけが使えるもの (0700) を求める
    /// </summary>
    internal static void CreateRuntimeDir(string runtimeDir)
    {
        Directory.CreateDirectory(runtimeDir);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(runtimeDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    /// <summary>
    /// UNIX ドメインソケットのパスの上限 (Linux の <c>sun_path</c> は終わりの NUL を含めて 108 バイト)。
    /// 超えるパスでは、asicend は起動のときに断る
    /// </summary>
    internal const int MaxSocketPath = 107;

    /// <summary>
    /// 常駐かそのコマンドを起動する。標準出力と標準エラーは受け取る。
    /// fd を継がせて起動するときは、<paramref name="lend"/> で継がせる fd の複製を作り、その番号から <paramref name="args"/> で引数を組む。
    /// 複製は起動し終えたところで閉じる (子プロセスは自分の写しを持つ)。起動できなかったときも閉じる。
    ///
    /// <para>
    /// **複製を作ってから起動し終えるまでは、ほかの子プロセスを起動しない** (<see cref="Shell.SpawnGate"/>。複製を作るのもこのロックの中)。
    /// 同じ時にほかの子プロセスを起動すると、その子も同じ fd を継ぐ (.NET の Process.Start は close-on-exec の無い fd を閉じない)。
    /// asicend が別の筐体の fd を持ち続けると、その筐体の USB の確保が外れない。エージェントの子プロセスはどれも <see cref="Shell.Start"/> で起動し、同じロックを取る
    /// </para>
    /// </summary>
    internal static Process Start(string program, Func<IReadOnlyList<int>, IReadOnlyList<string>> args, Func<InheritedFds>? lend)
    {
        lock (Shell.SpawnGate)
        {
            using var inherit = lend?.Invoke();
            var start = new ProcessStartInfo(program, args(inherit?.Numbers ?? []))
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // 診断は UTF-8 (パスに日本語が入りうる)
                StandardErrorEncoding = System.Text.Encoding.UTF8,
                UseShellExecute = false,
            };
            return Shell.Start(start);
        }
    }
}

/// <summary>
/// 子プロセスに継がせる fd (Android でアプリから受け取った USB の機材)。**close-on-exec の無い複製**で、
/// <c>Userland.Start</c> が起動し終えたら閉じる。受け取った元の fd は <see cref="BrokerUsbHost"/> が持ち続ける。
///
/// <para>
/// .NET 11 の <c>ProcessStartInfo.InheritedHandles</c> は使わない。ほかの fd を閉じるのに <c>close_range</c> (Linux 5.9 から) を使い、
/// それより古いカーネルの端末では起動できない (ENOTSUP)
/// </para>
/// </summary>
public sealed class InheritedFds : IDisposable
{
    private readonly int[] _fds;
    private int _disposed;

    private InheritedFds(int[] fds) => _fds = fds;

    /// <summary>子プロセスの引数 (<c>--fd</c>) に書く番号。並びは複製した順</summary>
    public IReadOnlyList<int> Numbers => _fds;

    /// <summary>
    /// fd を close-on-exec の無い形で複製する。どれかを複製できなければ、複製したものを閉じて <see cref="IOException"/>
    /// </summary>
    public static InheritedFds Duplicate(IReadOnlyList<(int Fd, string Port)> received)
    {
        var fds = new List<int>();
        foreach (var (fd, port) in received)
        {
            var copy = Sys.DupInheritable(fd);
            if (copy < 0)
            {
                var message = System.Runtime.InteropServices.Marshal.GetLastPInvokeErrorMessage();
                foreach (var made in fds) Sys.Close(made);
                throw new IOException($"USB のポート {port} の機材を子プロセスに渡せません ({message})");
            }
            fds.Add(copy);
        }
        return new InheritedFds([.. fds]);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        foreach (var fd in _fds) Sys.Close(fd);
    }
}

/// <summary>
/// 受信機 1 つ。**常駐に問い合わせたもの** (<see cref="AsicenUserland.ParseList"/>)。
///
/// <para>
/// 受信機ごとに地上波か衛星かが決まっていて、1 つの受信機で両方を受けられる機種もある。
/// その違いはここに入ってくるだけで、こちらは機種を見ない。
/// <c>Lnb15v</c> は LNB に 15V を出せるか。**分からなければ null** で、そのときは要求どおり指定する。
/// </para>
/// </summary>
public sealed record UserlandReceiver(int Index, bool Terrestrial, bool Satellite, bool? Lnb15v = null)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

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

    /// <summary><c>key=value</c> を空白で並べた 1 行を割る。同じキーが 2 度あれば最初のもの</summary>
    internal static Dictionary<string, string> Fields(string line) => line
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .Select(field => field.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .GroupBy(pair => pair[0], StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.First()[1], StringComparer.Ordinal);
}

/// <summary>
/// 筐体を持つ常駐 (<c>asicend</c>)。**筐体 1 台につき 1 つ、使う受信機がある間だけ動かす。**
///
/// <para>
/// 起動するのは最初に要ったとき (起動時の <see cref="Prepare{T}"/> か、初めての選局)。
/// ファームウェアを流し込んでから ready になるので、数秒かかる。
/// 終了していたら次に要ったときに起動し直す。受信機を全部使わない設定にしたら止める (<see cref="Prepare{T}"/>)。
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

    /// <summary>
    /// 挙げた筐体ぶん起動して ready まで待ち、**挙げなかった <typeparamref name="T"/> は止める。**
    /// 起動時と、チューナーの設定を書き換えたときと、機材を挿したとき。
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
    /// 起動したときに使う受信機の無い筐体を起動しないのと同じ
    /// </para>
    /// </summary>
    public static void Prepare<T>(IReadOnlyCollection<string> ids, Func<string, T> daemon)
        where T : UserlandDaemon
    {
        List<T> unused;
        lock (Registry) unused = [.. All.Values.OfType<T>().Where(target => target.Running && !ids.Contains(target.Id))];
        foreach (var target in unused)
        {
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

    /// <summary>動いていなければ起動して ready まで待つ。駄目なら理由を添えて例外を送出する</summary>
    public abstract void Ensure();

    protected void Write(string message) => Log.Write($"[{name} {Id}] {message}");

    /// <summary>
    /// 起動して、<paramref name="ready"/> が通るまで待つ。<paramref name="runtimeDir"/> (ランタイムルート) は
    /// ここで作る (<see cref="Userland.CreateRuntimeDir"/>)
    /// </summary>
    /// <param name="hint">終了コードに添える手当て (<see cref="AsicenDaemon"/> の Hint など)</param>
    /// <param name="args">引数を、継がせた fd の番号から組む (<c>Userland.Start</c>)</param>
    /// <param name="lend">継がせる fd の複製を作る (Android)。起動する直前に呼ぶ</param>
    internal void Launch(
        string program, Func<IReadOnlyList<int>, IReadOnlyList<string>> args, string runtimeDir, Func<bool> ready, Action onReady,
        Func<int, string>? hint, Func<InheritedFds>? lend)
    {
        lock (_gate)
        {
            if (Running) return;
            _process?.Dispose();
            _process = null;

            Userland.CreateRuntimeDir(runtimeDir);
            var process = Userland.Start(program, args, lend);
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
                    throw new IOException($"{name} が終了しました (exit {process.ExitCode}: {_stderr}){hint?.Invoke(process.ExitCode)}");
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
                    Write($"{StopGrace.TotalSeconds:F0} 秒で終わらないので強制終了します");
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

