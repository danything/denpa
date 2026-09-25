using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/px4-userland">px4-userland</a> に任せる機材
/// (PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系 …)。
///
/// <para>
/// **カーネルドライバを入れてもらわない。** px4_drv (DKMS) をホストに入れて
/// chardev を出す道は捨てた。px4-userland は libusb だけで USB を叩く
/// ユーザー空間のドライバで、静的リンクの実行ファイル3つとファームウェアを
/// イメージに同梱すれば、<c>/dev/bus/usb</c> が見えるだけで動く。
/// カードリーダーも同じデーモンが持っていて、pcscd には IFD ハンドラを
/// 1枚登録するだけで普通の PC/SC リーダーに見える。
/// </para>
///
/// <para>
/// **口は3つ。** <c>px4d</c> が筐体 (USB 機能・受信機・カード) を所有する
/// デーモンで、筐体1台につき1つ起こす。<c>px4-ts</c> は受信機を1本借りて
/// 選局し、TS を標準出力に流す。<c>px4ctl</c> は状態を聞く。3つとも同じ
/// ランタイムディレクトリと筐体の番号で Unix ドメインソケットを見つける。
/// </para>
///
/// <para>
/// **機種のことは何も持たない。** 刺さっている筐体と、それぞれの受信機が何を
/// 受けられるかは <c>px4d --list</c> に聞く (<see cref="Enclosures"/>)。USB ID や
/// 筐体の番号の決まりは px4-userland の中にあり、対応機種が増えても
/// px4-userland を上げるだけで追従する。
/// </para>
///
/// <para>
/// 設定の <c>device</c> には <c>px4:&lt;筐体の番号&gt;:&lt;受信機番号&gt;</c> と書く。
/// 刺さっていれば <see cref="Detect"/> が見つけて組み立てるので、普通は書かなくてよい。
/// </para>
/// </summary>
public static class Px4Userland
{
    /// <summary>設定の <c>device</c> の頭。これで始まっていれば px4-userland で掴む</summary>
    public const string Scheme = "px4:";

    /// <summary>刺さっている筐体1台。<c>Id</c> は px4d に <c>--device</c> で渡す番号</summary>
    public sealed record Enclosure(string Id, string Model, IReadOnlyList<Px4Receiver> Receivers);

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("PX4_USERLAND_DIR") ?? "/opt/px4-userland";

    /// <summary>
    /// IT930x のファームウェア。**同梱してある** (Dockerfile)。
    ///
    /// <para>
    /// 本体には入っておらず、挿すたびにホストから RAM へ流し込むもの。
    /// px4-userland は受理する版を SHA-256 で1つに固定していて、
    /// 違うものを渡すと <c>FIRMWARE_REJECTED</c> で起動しない。
    /// </para>
    /// </summary>
    public static string Firmware =>
        Environment.GetEnvironmentVariable("PX4_FIRMWARE") ?? Path.Combine(Dir, "firmware", "it930x-firmware.bin");

    /// <summary>px4d と px4-ts と IFD ハンドラが socket を置く場所</summary>
    public static string RuntimeDir =>
        Environment.GetEnvironmentVariable("PX4_RUNTIME_DIR") ?? "/run/px4-userland";

    /// <summary>pcscd が起動時に読む reader.conf の置き場 (Debian の pcscd は <c>serialconfdir</c> がここ)</summary>
    public static string ReaderConfDir =>
        Environment.GetEnvironmentVariable("PCSC_READER_CONF_DIR") ?? "/etc/reader.conf.d";

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary>
    /// <c>px4:00001205000960:2</c> を割る。形が違えば null。
    ///
    /// <para>
    /// 番号の桁数や受信機の上限は見ない。**それを知っているのは px4-userland** で、
    /// 合わなければ px4d / px4-ts が理由を付けて断る。
    /// </para>
    /// </summary>
    public static (string Id, int Receiver)? Parse(string device)
    {
        if (!Is(device)) return null;
        var parts = device[Scheme.Length..].Split(':');
        if (parts.Length != 2 || !Digits(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

    private static bool Digits(string value) => value.Length > 0 && value.All(char.IsAsciiDigit);

    /// <summary>画面に出す名前。筐体は番号の末尾4桁で見分ける</summary>
    public static string Name(string model, string id, int receiver) => $"{model}-{id[^4..]} #{receiver}";

    /// <summary>
    /// 刺さっている筐体。**<c>px4d --list</c> に聞く。**
    ///
    /// <para>
    /// 読むだけで筐体を掴まないので、px4d が動いていても聞ける。px4-userland が
    /// 入っていない環境 (手元の開発など) では空。
    /// </para>
    /// </summary>
    public static List<Enclosure> Enclosures()
    {
        var px4d = Path.Combine(Dir, "px4d");
        if (!File.Exists(px4d)) return [];
        var (code, output) = Shell.Run(px4d, ["--list"], TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();
        if (code != 0)
        {
            Log.Write($"px4-userland の筐体を挙げられません (px4d --list exit {code}: {output})");
            return [];
        }
        return ParseList(output, Log.Write);
    }

    /// <summary>
    /// <c>px4d --list</c> の出力を読む (px4-userland SPEC 4.6)。**使えるのは <c>status=ready</c> の筐体だけ。**
    ///
    /// <para>
    /// <c>serial=… model=… usb=… status=… receivers=N</c> の行のあとに、
    /// <c>px4ctl list</c> と同じ形の受信機の行が N 行続く。まとめられなかった
    /// USB デバイスは <c>rejected …</c> の行で来る。使えない筐体と rejected は
    /// 理由を <paramref name="warn"/> で残す — 権限が無いとき (<c>open_failed</c>) に
    /// 黙って「チューナーが無い」にならないように。
    /// </para>
    /// </summary>
    public static List<Enclosure> ParseList(string output, Action<string> warn)
    {
        var found = new List<Enclosure>();
        Dictionary<string, string>? current = null;
        var receivers = new System.Text.StringBuilder();

        void Flush()
        {
            if (current is null) return;
            var id = current.GetValueOrDefault("serial") ?? "";
            var model = current.GetValueOrDefault("model") ?? "px4";
            var status = current.GetValueOrDefault("status") ?? "";
            if (status != "ready")
            {
                warn($"{model} {id} は使えません (px4d --list: status={status})");
            }
            else if (!Digits(id))
            {
                warn($"{model} の番号 {id} が読めません (数字だけのはず)");
            }
            else
            {
                found.Add(new Enclosure(id, model, Px4Receiver.ParseList(receivers.ToString(), warn)));
            }
            current = null;
            receivers.Clear();
        }

        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("serial=", StringComparison.Ordinal))
            {
                Flush();
                current = Fields(line);
            }
            else if (line.StartsWith("receiver=", StringComparison.Ordinal))
            {
                if (current is not null) receivers.AppendLine(line);
            }
            else if (line.StartsWith("rejected ", StringComparison.Ordinal))
            {
                Flush();
                var fields = Fields(line["rejected ".Length..]);
                var status = fields.GetValueOrDefault("status") ?? "";
                warn($"{fields.GetValueOrDefault("model")} ({fields.GetValueOrDefault("usb")}) を使えません: {status}"
                    + (status == "open_failed" ? " (/dev/bus/usb を開く権限が無いかもしれません)" : ""));
            }
        }
        Flush();
        return found;
    }

    private static Dictionary<string, string> Fields(string line) => line
        .Split(' ', StringSplitOptions.RemoveEmptyEntries)
        .Select(field => field.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .GroupBy(pair => pair[0], StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.First()[1], StringComparer.Ordinal);

    /// <summary>刺さっている筐体の受信機を、設定に書いたのと同じ形で</summary>
    public static List<TunerSpec> Detect() => Specs(Enclosures());

    /// <summary>筐体の一覧から、設定の形に組み立てる</summary>
    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures)
    {
        var found = new List<TunerSpec>();
        foreach (var enclosure in enclosures)
        {
            foreach (var receiver in enclosure.Receivers)
            {
                if (receiver.Types.Length == 0) continue;
                found.Add(new TunerSpec(
                    Name(enclosure.Model, enclosure.Id, receiver.Index),
                    receiver.Types,
                    false,
                    Device(enclosure.Id, receiver.Index)));
            }
        }
        return found;
    }

    /// <summary>設定に出てくる筐体。px4d を起こす相手</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => Parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);

    /// <summary>
    /// 内蔵カードリーダーを pcscd に見せる reader.conf を、筐体ぶん揃える。
    /// **pcscd を起こす前に呼ぶ。** 新しく増えたか中身が変わったら true。
    ///
    /// <para>
    /// Debian の pcscd (libudev 版) は reader.conf を**起動したときにしか読まない**
    /// (<c>pcscd --hotplug</c> は何もしない)。なので先に書いてから起こす。
    /// 書くのに要るのは筐体の番号だけで、px4d を待たなくてよい — IFD は px4d が
    /// 居なくても登録され、居ない間は「カードなし」と答えて、px4d が来たら
    /// 自分で繋ぐ (px4-userland 0.1.6)。px4d を起こし直したときも同じで、
    /// pcscd を入れ直さなくてよい。
    /// </para>
    ///
    /// <para>
    /// もう無い筐体の reader.conf は消す。残すと、居ない筐体のリーダーが
    /// 「カードなし」で並び続ける。
    /// </para>
    /// </summary>
    public static bool WriteReaderConfs(IEnumerable<string> ids, string? dir = null, string? ifd = null)
    {
        dir ??= ReaderConfDir;
        ifd ??= Path.Combine(Dir, "ifd", "px4-userland-ifd.so");
        var wanted = ids.ToHashSet(StringComparer.Ordinal);
        if (wanted.Count > 0 && !File.Exists(ifd))
        {
            Log.Write($"IFD ハンドラが無いので内蔵カードリーダーは使えません: {ifd}");
            return false;
        }

        var changed = false;
        try
        {
            Directory.CreateDirectory(dir);
            foreach (var path in Directory.EnumerateFiles(dir, "px4-userland-*.conf"))
            {
                var id = Path.GetFileNameWithoutExtension(path)["px4-userland-".Length..];
                if (!wanted.Contains(id)) File.Delete(path);
            }
            foreach (var id in wanted)
            {
                var path = Path.Combine(dir, $"px4-userland-{id}.conf");
                var conf = ReaderConf(id, RuntimeDir, ifd);
                if (File.Exists(path) && File.ReadAllText(path) == conf) continue;
                File.WriteAllText(path, conf);
                changed = true;
            }
        }
        catch (Exception error)
        {
            Log.Write($"reader.conf を書けません: {error.Message}");
        }
        return changed;
    }

    /// <summary>pcscd の reader.conf。1筐体1枚 (配布アーカイブの雛形と同じ形。px4d と pcscd は同じ root)</summary>
    public static string ReaderConf(string id, string runtimeDir, string ifd) =>
        $"""
        # denpa-agent が書いたもの。筐体 {id} の内蔵カードリーダー (px4-userland)
        FRIENDLYNAME "px4-userland {id[^4..]} Internal Card Reader"
        DEVICENAME   px4-userland:runtime={runtimeDir}:device={id}:access=user
        LIBPATH      {ifd}
        CHANNELID    0

        """;
}

/// <summary>
/// 受信機1本。**<c>px4d --list</c> / <c>px4ctl list</c> で px4-userland に聞いたもの。**
///
/// <para>
/// Q3U4 は受信機ごとに地上波か衛星かが決まっていて、MLT5 系はどれも両方受けられる
/// (選局のたびに切り替える)。その違いはここに入ってくるだけで、こちらは機種を見ない。
/// </para>
/// </summary>
public sealed record Px4Receiver(int Index, bool Terrestrial, bool Satellite)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

    /// <summary>
    /// <c>px4ctl list</c> の出力 (<c>px4d --list</c> の受信機の行も同じ形) を読む。
    ///
    /// <para>
    /// <c>receiver=0 device=1 local=0 system=ISDB-S</c> の行が受信機の数だけ並ぶ。
    /// <c>system</c> は <c>ISDB-T</c> / <c>ISDB-S</c> / <c>ISDB-T/S</c> (どちらも)。
    /// **知らない値は飛ばして続ける** — px4-userland が新しくなって方式が増えても、
    /// 分かる受信機は使えるように。飛ばしたことは <paramref name="warn"/> で残す。
    /// </para>
    /// </summary>
    public static List<Px4Receiver> ParseList(string output, Action<string> warn)
    {
        var found = new List<Px4Receiver>();
        foreach (var line in output.Split('\n'))
        {
            var fields = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Select(field => field.Split('=', 2))
                .Where(pair => pair.Length == 2)
                .ToDictionary(pair => pair[0], pair => pair[1], StringComparer.Ordinal);
            if (!fields.TryGetValue("receiver", out var index) || !fields.TryGetValue("system", out var system)) continue;
            if (!int.TryParse(index, out var number))
            {
                warn($"px4ctl list の受信機番号が読めません: {line.Trim()}");
                continue;
            }
            switch (system)
            {
                case "ISDB-T":
                    found.Add(new Px4Receiver(number, true, false));
                    break;
                case "ISDB-S":
                    found.Add(new Px4Receiver(number, false, true));
                    break;
                case "ISDB-T/S":
                    found.Add(new Px4Receiver(number, true, true));
                    break;
                default:
                    warn($"受信機 {number} の方式 {system} を知りません (px4-userland が新しい?)。この受信機は使いません");
                    break;
            }
        }
        return found;
    }
}

/// <summary>
/// <c>px4d</c> 1つ。**筐体1台につき1つ、起こしたら止めるまで居る。**
///
/// <para>
/// 起こすのは最初に要ったとき (起動時の <see cref="Prepare"/> か、初めての選局)。
/// ファームウェアを流し込んでから ready になるので、数秒かかる。
/// 落ちていたら次に要ったときに起こし直す。
/// </para>
///
/// <para>
/// **ready になったら受信機を聞く** (<c>px4ctl list</c>、<see cref="Receivers"/>)。
/// 何本あって何を受けられるかは筐体の答えを使う。
/// </para>
///
/// <para>
/// 内蔵カードリーダーの reader.conf はここでは書かない。pcscd を起こす前に
/// まとめて書く (<see cref="Px4Userland.WriteReaderConfs"/>)。IFD は px4d が
/// 居なくても登録され、ready になったら自分で繋ぐ。
/// </para>
/// </summary>
public sealed class Px4Daemon
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, Px4Daemon> All = new(StringComparer.Ordinal);

    /// <summary>ready を待つ上限。ファームウェアの流し込みは数秒で済む</summary>
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(30);

    private readonly string _id;
    private readonly Lock _gate = new();
    private Process? _process;
    private string _stderr = "";

    private Px4Daemon(string id) => _id = id;

    public static Px4Daemon For(string id)
    {
        lock (Registry)
        {
            if (!All.TryGetValue(id, out var daemon))
            {
                daemon = new Px4Daemon(id);
                All[id] = daemon;
            }
            return daemon;
        }
    }

    public bool Running => _process is { HasExited: false };

    /// <summary>
    /// 筐体に聞いた受信機。**ready になるまで null。** 聞けなかったときも null のままで、
    /// そのときは選局を px4-ts に任せる (合わなければあちらが断る)
    /// </summary>
    public IReadOnlyList<Px4Receiver>? Receivers { get; private set; }

    /// <summary>
    /// 挙げた筐体ぶん、px4d を起こしてリーダーを繋ぐ。**起動時と、設定を書き換えたとき。**
    ///
    /// <para>
    /// **起こせなくても止まらない。** 筐体が抜けている・ファームウェアが無い、は
    /// その筐体だけの話で、他のチューナー (PT3 など) は変わらず使える。
    /// 理由は記録に残し、選局のときにもう一度試す。
    /// </para>
    /// </summary>
    public static void Prepare(IEnumerable<string> ids)
    {
        foreach (var id in ids)
        {
            try
            {
                For(id).Ensure();
            }
            catch (Exception error)
            {
                Log.Write($"[px4d {id}] {error.Message}");
            }
        }
    }

    /// <summary>動いていなければ起こして ready まで待つ。駄目なら理由を添えて投げる</summary>
    public void Ensure()
    {
        lock (_gate)
        {
            if (Running) return;
            _process?.Dispose();
            _process = null;

            if (!File.Exists(Px4Userland.Firmware))
            {
                throw new IOException($"ファームウェアがありません: {Px4Userland.Firmware}");
            }
            var px4d = Path.Combine(Px4Userland.Dir, "px4d");
            if (!File.Exists(px4d)) throw new IOException($"px4-userland が入っていません: {px4d}");

            // ランタイムルートは呼ぶ側が用意する決まり (px4d は下の階層しか作らない)
            Directory.CreateDirectory(Px4Userland.RuntimeDir);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(
                    Px4Userland.RuntimeDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            var start = new ProcessStartInfo(px4d)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var arg in new[]
            {
                "--device", _id,
                "--firmware", Px4Userland.Firmware,
                "--runtime-dir", Px4Userland.RuntimeDir,
                /*
                 * 15V を出してよいかの門は2段。ここは「頼まれたら出す」で開けておき、
                 * 本当に頼むかどうかは設定の `lnb` で決める (px4-ts に `--lnb-voltage 15`
                 * を渡すのは `15v` と書いてある本だけ。Px4Tuner.Arguments)
                 */
                "--allow-lnb-power",
            })
            {
                start.ArgumentList.Add(arg);
            }

            var process = Process.Start(start) ?? throw new IOException("px4d を起こせません");
            _process = process;
            _stderr = "";
            _ = Task.Run(async () =>
            {
                // 診断は全部 stderr に来る。ready の合図もここ
                using var reader = process.StandardError;
                while (await reader.ReadLineAsync() is { } line)
                {
                    _stderr = line;
                    Log.Write($"[px4d {_id}] {line}");
                }
            });
            _ = Task.Run(() => process.StandardOutput.ReadToEndAsync());

            var deadline = DateTime.UtcNow + ReadyTimeout;
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited)
                {
                    throw new IOException($"px4d が終了しました (exit {process.ExitCode}: {_stderr})");
                }
                if (Status(TimeSpan.FromSeconds(5)).Code == 0)
                {
                    Log.Write($"[px4d {_id}] ready");
                    Receivers = ListReceivers();
                    return;
                }
                Thread.Sleep(500);
            }

            Stop();
            throw new IOException($"px4d が {ReadyTimeout.TotalSeconds} 秒で ready になりません ({_stderr})");
        }
    }

    /// <summary><c>px4ctl status</c>。exit 0 なら ready</summary>
    public (int Code, string Output) Status(TimeSpan timeout) => Control("status", timeout);

    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        Path.Combine(Px4Userland.Dir, "px4ctl"),
        ["--device", _id, "--runtime-dir", Px4Userland.RuntimeDir, command],
        timeout).GetAwaiter().GetResult();

    /// <summary><c>px4ctl list</c> で受信機を聞く。聞けなければ null (理由は記録に)</summary>
    private List<Px4Receiver>? ListReceivers()
    {
        var (code, output) = Control("list", TimeSpan.FromSeconds(5));
        if (code != 0)
        {
            Log.Write($"[px4d {_id}] 受信機を聞けません (px4ctl list exit {code}: {output})");
            return null;
        }
        var receivers = Px4Receiver.ParseList(output, message => Log.Write($"[px4d {_id}] {message}"));
        Log.Write($"[px4d {_id}] 受信機 {receivers.Count} 本: "
            + string.Join(", ", receivers.Select(r => $"#{r.Index} {string.Join("/", r.Types)}")));
        return receivers;
    }

    /// <summary>
    /// 止める。**SIGTERM で。** px4d は合図を受けると LNB を 0V に戻し、
    /// socket を消してから終わる。SIGKILL だとそこが保証されない
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
                if (!process.WaitForExit(TimeSpan.FromSeconds(10))) process.Kill();
            }
            process.Dispose();
        }
    }

    public static void StopAll()
    {
        List<Px4Daemon> daemons;
        lock (Registry) daemons = [.. All.Values];
        foreach (var daemon in daemons) daemon.Stop();
    }
}

/// <summary>
/// px4-userland の受信機1本。<c>px4-ts</c> を起こして標準出力を読む。
///
/// <para>
/// **選局のたびに px4-ts を起こし直す。** 1回1チャンネルの作りで、掴んだまま
/// 変える口が無い。ただし受信機を持っているのは px4d のほうなので、
/// 起こし直す間に別のものが割り込むことはない (同じエージェントの中では
/// TunerPool が本ごとに順番を守る)。
/// </para>
///
/// <para>
/// 子を起こして標準出力を読むところは siano-ts と同じなので ChildTs.cs にある。
/// </para>
///
/// <para>
/// **誰も読まなくなると px4-ts は死ぬ。** pipe が埋まると px4d が
/// <c>SLOW_CONSUMER</c> として切る。それは失敗ではなく、受信機を離しただけ。
/// 次に同じチャンネルを頼まれたら起こし直す (<see cref="Tuned"/> を
/// TunerPool が見る)。
/// </para>
/// </summary>
public sealed class Px4Tuner : ITuneDevice
{
    /// <summary>同期を待つ上限。DVB 側 (<c>DvbTuner.LockTimeout</c>) と同じ。総当たりの一周がこれで決まる</summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(5);

    /// <summary>px4-ts が同期のあと最初の TS を出すまでの猶予。同期の上限に足す</summary>
    private static readonly TimeSpan FirstTsGrace = TimeSpan.FromSeconds(3);

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly Lock _gate = new();
    private readonly ChildTs _ts;

    public Px4Tuner(string id, int receiver, string? lnb)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _ts = new ChildTs($"px4-{id[^4..]} #{receiver}", "px4-ts");
    }

    public Stream Output => _ts.Output;

    /// <summary>
    /// 前の px4-ts がまだ生きているか。**錠の下で読む** — <c>Dispose</c> は別の
    /// 錠 (<c>TunerPool._deviceGate</c>) から来るので、畳んでいる最中の
    /// <c>Process</c> に触らないように
    /// </summary>
    public bool Tuned
    {
        get
        {
            lock (_gate)
            {
                return _ts.Alive;
            }
        }
    }

    /// <summary>
    /// px4-ts に渡す引数。**選局表の値をそのまま。**
    ///
    /// <para>
    /// 周波数は kHz で言う。選局表は DVB の決まりで地上波が Hz・衛星が kHz
    /// なので、地上波だけ 1000 で割る (473142857 Hz → 473142 kHz。端数は切る)。
    /// 衛星は TSID が分かっていれば <c>--stream-id</c>、分からなければ
    /// 相対番号を <c>--slot</c> で (CS は1本しか乗っていないので 0)。
    /// 15V は設定に <c>15v</c> と書いてある本だけ頼む。
    /// </para>
    /// </summary>
    public static List<string> Arguments(
        string id, int receiver, ChannelTable.Tuning tuning, uint streamId, string? lnb)
    {
        var args = new List<string>
        {
            "--device", id,
            "--receiver", receiver.ToString(),
            "--system", tuning.Satellite ? "isdb-s" : "isdb-t",
            "--frequency-khz", (tuning.Satellite ? tuning.Frequency : tuning.Frequency / 1000).ToString(),
            "--tune-timeout-ms", ((int)TuneTimeout.TotalMilliseconds).ToString(),
            "--output", "-",
        };
        if (tuning.Satellite)
        {
            if (streamId != ChannelTable.NoStreamId)
            {
                args.AddRange(["--stream-id", streamId.ToString()]);
            }
            else
            {
                args.AddRange(["--slot", tuning.Slot.ToString()]);
            }
            if (lnb == "15v") args.AddRange(["--lnb-voltage", "15"]);
        }
        return args;
    }

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            var daemon = Px4Daemon.For(_id);
            daemon.Ensure();
            Check(daemon.Receivers, _receiver, tuning);
            var start = new ProcessStartInfo(Path.Combine(Px4Userland.Dir, "px4-ts"));
            foreach (var arg in Arguments(_id, _receiver, tuning, streamId, _lnb)) start.ArgumentList.Add(arg);
            start.ArgumentList.Add("--runtime-dir");
            start.ArgumentList.Add(Px4Userland.RuntimeDir);
            _ts.Start(start, TuneTimeout + FirstTsGrace);
        }
    }

    /// <summary>
    /// 筐体に聞いた受信機と、頼まれた選局が合っているか。**合わなければ px4-ts を起こす前に断る。**
    /// 受信機を聞けていなければ (<paramref name="receivers"/> が null) 見ずに通す
    /// </summary>
    public static void Check(IReadOnlyList<Px4Receiver>? receivers, int index, ChannelTable.Tuning tuning)
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

    public void Dispose()
    {
        lock (_gate) _ts.Drop();
    }
}
