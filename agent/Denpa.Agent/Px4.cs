using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

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
/// カードリーダーも同じデーモンが持っていて、control socket 越しに APDU を
/// 投げれば読める (Px4Card.cs)。
/// </para>
///
/// <para>
/// **使うのは2つ。** <c>px4d</c> が筐体 (USB 機能・受信機・カード) を所有する
/// デーモンで、筐体1台につき1つ起こす。<c>px4ctl</c> は状態を聞く。受信機は
/// px4d の制御ソケットで直に借りて選局し、TS も px4d から直に受ける (<see cref="Px4Tuner"/>)。
/// 同梱の <c>px4-ts</c> (1回1チャンネルの CLI) は使わない。どれも同じランタイム
/// ディレクトリと筐体の番号で Unix ドメインソケットを見つける。
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

    /// <summary>px4d が socket を置く場所</summary>
    public static string RuntimeDir =>
        Environment.GetEnvironmentVariable("PX4_RUNTIME_DIR") ?? "/run/px4-userland";

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary>
    /// <c>px4:00001205000960:2</c> を割る。形が違えば null。
    ///
    /// <para>
    /// 番号の桁数や受信機の上限は見ない。**それを知っているのは px4-userland** で、
    /// 合わなければ px4d が理由を付けて断る。
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

    /// <summary>
    /// <c>key=value</c> を空白で並べた1行を割る。同じ鍵が2度あれば最初のもの。
    /// 受信機の行 (<see cref="Px4Receiver.ParseList"/>) と <c>siano-ts --list</c> (Siano.cs) も同じ形
    /// </summary>
    internal static Dictionary<string, string> Fields(string line) => line
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
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
            var fields = Px4Userland.Fields(line);
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
    /// そのときは選局を px4d に任せる (合わなければあちらが断る)
    /// </summary>
    public IReadOnlyList<Px4Receiver>? Receivers { get; private set; }

    /// <summary>
    /// 挙げた筐体ぶん、px4d を起こして ready まで待つ。**起動時と、設定を書き換えたとき。**
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

            var start = new ProcessStartInfo(px4d,
            [
                "--device", _id,
                "--firmware", Px4Userland.Firmware,
                "--runtime-dir", Px4Userland.RuntimeDir,
                /*
                 * 15V を出してよいかの門は2段。ここは「頼まれたら出す」で開けておき、
                 * 本当に頼むかどうかは設定の `lnb` で決める (TUNE で 15V を頼むのは
                 * `15v` と書いてある本だけ。Px4Tuner.TuneRequest)
                 */
                "--allow-lnb-power",
            ])
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };

            var process = Process.Start(start) ?? throw new IOException("px4d を起動できません");
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
            throw new IOException($"px4d が {ReadyTimeout.TotalSeconds} 秒以内に ready になりません ({_stderr})");
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
/// px4-userland の受信機1本。**px4d の制御ソケットで受信機を借り、借りたまま選局し直す。**
///
/// <para>
/// 最初の選局で <c>ACQUIRE → TUNE → START_STREAM → ATTACH_STREAM</c>、2回目からは
/// <c>STOP_STREAM → TUNE → START_STREAM → ATTACH_STREAM</c> (px4-userland SPEC 6.3、v0.1.6 から)。
/// 返すのは <see cref="Dispose"/> (<c>RELEASE</c>) のときだけ。以前は選局ごとに <c>px4-ts</c> を
/// 起こしていて、px4-ts が終わるたびに lease が返り、最後の受信機なら px4d がチューナーの
/// 電源を落としていた。次の選局は電源を入れてチューナーを初期化し直すところからで、遅かった。
/// </para>
///
/// <para>
/// **TS は別のソケット (<c>stream.sock</c>) に来る。** 枠 (TS_DATA) をほどいて pipe に書き、
/// 読み口はその pipe を <see cref="DeviceStream"/> に載せる (<see cref="Px4Stream"/>)。
/// 読み手の振る舞い (電波が来なくても畳める・蹴られた読み手は 200ms で降りる) は DVB と同じ。
/// </para>
///
/// <para>
/// **誰も読まなくなったら TS の流れを畳む。** pipe が埋まったまま空かなければ、こちらから
/// stream.sock を閉じる (放っておくと px4d の溜めが溢れて <c>SLOW_CONSUMER</c> になる)。
/// 受信機は借りたままなので、次に頼まれたら同じ lease で選局し直す (<see cref="Tuned"/> を
/// TunerPool が見る)。
/// </para>
/// </summary>
public sealed class Px4Tuner : ITuneDevice
{
    /// <summary>同期を待つ上限 (TUNE の <c>timeout_ms</c>)。DVB 側 (<c>DvbTuner.LockTimeout</c>) と同じ。総当たりの一周がこれで決まる</summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(5);

    /// <summary>同期のあと最初の TS が来るまでの猶予</summary>
    private static readonly TimeSpan FirstTsGrace = TimeSpan.FromSeconds(3);

    /// <summary>TUNE 以外の1回のやり取りの上限。px4-ts と同じ</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(4);

    /// <summary>
    /// TUNE が BUSY で返ったときに待ち直す上限。前の TS の流れの後始末 (閉じた stream.sock を
    /// px4d が畳む) と行き違うと、ほんの一瞬だけ BUSY になる
    /// </summary>
    private static readonly TimeSpan BusyRetry = TimeSpan.FromSeconds(1);

    private const string SyncFailed = "同期しませんでした (電波が来ていないか、その周波数に放送がありません)";

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly string _runtimeDir;
    private readonly Func<IReadOnlyList<Px4Receiver>?> _prepare;
    private readonly string _name;
    private readonly Lock _gate = new();

    /// <summary>受信機を借りている制御ソケット。null なら借りていない</summary>
    private Px4Control? _control;

    private ulong _lease;
    private byte[] _nonce = [];

    /// <summary>START_STREAM が通ってから STOP_STREAM を言うまで</summary>
    private bool _started;

    private Px4Stream? _stream;

    public Px4Tuner(string id, int receiver, string? lnb)
        : this(id, receiver, lnb, Px4Userland.RuntimeDir, () =>
        {
            var daemon = Px4Daemon.For(id);
            daemon.Ensure();
            return daemon.Receivers;
        })
    {
    }

    /// <param name="prepare">
    /// 選局の前に呼ぶ。px4d を起こして、筐体に聞いた受信機を返す (聞けていなければ null)。
    /// テストは px4d のふりをするので何もしない
    /// </param>
    internal Px4Tuner(string id, int receiver, string? lnb, string runtimeDir, Func<IReadOnlyList<Px4Receiver>?> prepare)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _runtimeDir = runtimeDir;
        _prepare = prepare;
        _name = $"px4-{id[^4..]} #{receiver}";
    }

    /// <summary>読み手が居ないまま pipe が空かなければ、この時間で TS の流れを畳む</summary>
    internal TimeSpan StallLimit { get; init; } = Px4Stream.DefaultStallLimit;

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    /// <summary>
    /// 受信機を借りていて、TS がまだ流れているか。**錠の下で読む** — <c>Dispose</c> は別の
    /// 錠 (<c>TunerPool._deviceGate</c>) から来るので、畳んでいる最中のものに触らないように
    /// </summary>
    public bool Tuned
    {
        get
        {
            lock (_gate)
            {
                return _control is not null && _stream is { Ended: false };
            }
        }
    }

    /// <summary>
    /// TUNE の中身 (SPEC 6.4)。**選局表の値をそのまま。**
    /// <c>u64 lease_id, u8 system, u64 frequency_khz, u16 stream_id, u16 slot, u32 bandwidth_hz, u8 lnb_voltage, u32 timeout_ms</c>
    ///
    /// <para>
    /// 周波数は kHz で言う。選局表は DVB の決まりで地上波が Hz・衛星が kHz
    /// なので、地上波だけ 1000 で割る (473142857 Hz → 473142 kHz。端数は切る)。
    /// 衛星は TSID が分かっていれば <c>stream_id</c>、分からなければ相対番号を
    /// <c>slot</c> で (CS は1本しか乗っていないので 0)。使わないほうは 0xffff。
    /// 帯域は地上波が 6MHz、衛星は 0 (px4d がこれ以外を断る)。
    /// 15V は設定に <c>15v</c> と書いてある本だけ頼む (<c>11v</c> は px4-userland に無い)。
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
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(19), tuning.Satellite && !byId ? (ushort)tuning.Slot : unused);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(21), tuning.Satellite ? 0u : 6_000_000u);
        payload[25] = (byte)(tuning.Satellite && lnb == "15v" ? 15 : 0);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(26), (uint)TuneTimeout.TotalMilliseconds);
        return payload;
    }

    /// <summary>
    /// 選局する。**借りていれば借りたまま、切れていれば借り直す。**
    ///
    /// <para>
    /// 借りていたはずの接続が切れていた (px4d が起こし直された・lease が無い) ときは、
    /// その場で1度だけ借り直して続ける。同期しなかった (TIMEOUT) ときは受信機を借りたまま
    /// 投げる — 総当たりのスキャンは同期しないチャンネルのほうが多く、そのたびに返すと
    /// 電源の入れ直しからやり直しになる。
    /// </para>
    /// </summary>
    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            Check(_prepare(), _receiver, tuning);
            DropStream();
            var reused = _control is not null;
            try
            {
                Attempt(tuning, streamId);
            }
            catch (IOException error) when (reused && Lost(error))
            {
                Log.Write($"[{_name}] px4d との接続が切れていたので、受信機を借り直します ({error.Message})");
                Attempt(tuning, streamId);
            }
        }
    }

    /// <summary>
    /// 制御ソケットごと失くした (px4d のエラーの答えではない、または lease がもう無い)。
    /// **TS の流れの失敗 (<see cref="Px4StreamError"/>) は入れない** — 制御ソケットは生きていて、
    /// 黙って借り直すと「接続が切れていた」と嘘の記録が残る
    /// </summary>
    private static bool Lost(IOException error) => error switch
    {
        Px4StreamError => false,
        Px4Error failed => failed.Code == Px4Error.NotFound,
        _ => true,
    };

    /// <summary>
    /// 受信機を借りたまま次に進める失敗か。同期しなかった・頼み方が合わなかった (TUNE)、
    /// ATTACH は通ったが TS が駄目だった (<see cref="Px4StreamError.KeepsLease"/>)。それ以外は受信機を返して閉じる
    /// </summary>
    private static bool Keeps(IOException error) =>
        error is Px4StreamError { KeepsLease: true } || error is Px4Error { Code: Px4Error.Timeout or Px4Error.InvalidArgument };

    private void Attempt(ChannelTable.Tuning tuning, uint streamId)
    {
        try
        {
            if (_control is null) Open();
            Run(tuning, streamId);
        }
        catch (IOException error) when (!Keeps(error))
        {
            Close();
            throw;
        }
    }

    /// <summary>繋いで受信機を借りる (HELLO → ACQUIRE)</summary>
    private void Open()
    {
        var control = Px4Control.Connect(Px4Control.Endpoint(_runtimeDir, _id, "control.sock"), 0, RequestTimeout);
        try
        {
            var answer = control.Request(Px4Control.Acquire, [(byte)_receiver]);
            if (answer.Length != 24) throw new IOException($"px4d の ACQUIRE の答えが {answer.Length} バイトです (24 のはず)");
            var lease = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            if (lease == 0) throw new IOException("px4d の ACQUIRE の答えの lease が 0 です");
            _lease = lease;
            _nonce = answer[8..24];
        }
        catch (Px4Error error)
        {
            control.Dispose();
            throw new Px4Error(error.Code, $"受信機 {_receiver} を借りられません ({error.Message})");
        }
        catch
        {
            control.Dispose();
            throw;
        }
        _control = control;
        _started = false;
        Log.Write($"[{_name}] 受信機を借りました");
    }

    /// <summary>(流していれば止めて) 合わせて、流し始めて、TS を受け取りにいく</summary>
    private void Run(ChannelTable.Tuning tuning, uint streamId)
    {
        var control = _control!;
        var lease = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(lease, _lease);

        if (_started)
        {
            try
            {
                control.Request(Px4Control.StopStream, lease, RequestTimeout);
            }
            catch (Px4Error error) when (error.Code == Px4Error.NotReady)
            {
                // もう止まっている (閉じた stream.sock を px4d が先に畳んだ)
            }
            _started = false;
        }

        var tune = TuneRequest(_lease, tuning, streamId, _lnb);
        var busyUntil = DateTime.UtcNow + BusyRetry;
        byte[] answer;
        while (true)
        {
            try
            {
                // px4d は timeout_ms で同期を諦めて答える。それより少し長く待つ (px4-ts と同じ +2 秒)
                answer = control.Request(Px4Control.Tune, tune, TuneTimeout + TimeSpan.FromSeconds(2));
                break;
            }
            catch (Px4Error error) when (error.Code == Px4Error.Busy && DateTime.UtcNow < busyUntil)
            {
                Thread.Sleep(50);
            }
            catch (Px4Error error) when (error.Code == Px4Error.Timeout)
            {
                throw new Px4Error(Px4Error.Timeout, SyncFailed);
            }
        }
        // u8 locked, i32 cnr_mdb。px4d は同期したときしか成功で答えないが、px4-ts と同じく locked も見る
        if (answer.Length < 1 || answer[0] == 0) throw new Px4Error(Px4Error.Timeout, SyncFailed);

        control.Request(Px4Control.StartStream, lease, RequestTimeout);
        _started = true;
        _stream = Px4Stream.Attach(
            Px4Control.Endpoint(_runtimeDir, _id, "stream.sock"), _lease, _nonce, _name, StallLimit, FirstTsGrace);
    }

    /// <summary>
    /// 筐体に聞いた受信機と、頼まれた選局が合っているか。**合わなければ px4d に頼む前に断る。**
    /// 受信機を聞けていなければ (<paramref name="receivers"/> が null) 見ずに通す (合わなければ px4d が断る)
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

    /// <summary>
    /// TS の流れを畳む。**stream.sock を閉じるのは TUNE より前に。** nonce は lease の間ずっと
    /// 同じなので、前の stream.sock の後始末を px4d が次の START_STREAM より後に回すと、
    /// 新しい流れのほうを取り消してしまう (px4d は閉じた接続の後始末で同じ lease と nonce の
    /// 流れを取り消す)。先に閉じておけば、px4d は TUNE に答えるより前にそれを見る
    /// </summary>
    private void DropStream()
    {
        var stream = _stream;
        _stream = null;
        stream?.Stop();
    }

    /// <summary>受信機を返して閉じる。**失敗しても構わない** — 接続を閉じれば px4d の側で返される (SPEC 6.3)</summary>
    private void Close()
    {
        DropStream();
        var control = _control;
        _control = null;
        if (control is null) return;
        var lease = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(lease, _lease);
        try
        {
            if (_started) control.Request(Px4Control.StopStream, lease, RequestTimeout);
        }
        catch (IOException)
        {
        }
        try
        {
            control.Request(Px4Control.Release, lease, RequestTimeout);
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
    }
}

/// <summary>
/// 受信機を借りたままの間に、TS の流れが駄目だった (ATTACH を断られた・TS が来なかった)。
/// **受信機は返さない** — 次の選局で同じ lease のまま STOP_STREAM → TUNE からやり直せる
/// </summary>
internal sealed class Px4StreamError(string message, bool keepsLease) : IOException(message)
{
    /// <summary>
    /// 受信機を借りたまま次に進めるか。**ATTACH_STREAM が通っていれば (流れが active) 進める** —
    /// 次の STOP_STREAM で畳める。通らなかったときは px4d の lease が「armed」のまま残り、
    /// TUNE も START_STREAM も BUSY で返るようになる (px4d は armed の期限切れを ATTACH でしか
    /// 見ない) ので、返して借り直すしかない
    /// </summary>
    public bool KeepsLease { get; } = keepsLease;
}

/// <summary>
/// px4d から TS を受け取る1回ぶん (START_STREAM 1回につき1つ)。
///
/// <para>
/// <c>stream.sock</c> に繋いで ATTACH_STREAM (lease と nonce) を送ると、あとは px4d が
/// TS_DATA の枠を送り続け、止めると STREAM_END が来る (SPEC 6.3 / 6.4)。枠をほどいた中身を
/// pipe に書き、読み口はその pipe の読む側 (<see cref="DeviceStream"/>)。pipe は子の標準出力と
/// 同じく広げる (<see cref="ChildTs.WidenPipe"/>)。
/// </para>
///
/// <para>
/// **読み手が居ないと pipe が埋まる。** 書けないまま <see cref="DefaultStallLimit"/> 経ったら
/// stream.sock を閉じて終わる。こちらが読まないままだと px4d の溜め (既定 65,536 パケット、
/// 地上波で5秒ほど) が溢れて SLOW_CONSUMER になるが、その知らせ (STREAM_END) も読まない
/// ソケットの奥に詰まって届かない。こちらで見切る。
/// </para>
/// </summary>
internal sealed unsafe class Px4Stream
{
    /// <summary>pipe が空かないまま待つ上限。px4d の溜めが溢れるのと同じくらい</summary>
    public static readonly TimeSpan DefaultStallLimit = TimeSpan.FromSeconds(5);

    /// <summary>
    /// TS がこれだけ来なければ終わる。px4-ts と同じ5秒。**pipe に書けずに待っている間は数えない**
    /// (そちらは <see cref="DefaultStallLimit"/>)
    /// </summary>
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(5);

    private readonly Socket _socket;
    private readonly string _name;
    private readonly TimeSpan _stallLimit;
    private readonly ManualResetEventSlim _first = new();
    private SafeFileHandle? _write;
    private Thread? _pump;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    /// <summary>ATTACH_STREAM が通ったか (px4d の側で流れが active になった)</summary>
    private bool _attached;

    /// <summary>pipe に1枚でも書けたか (Attach が待つのはこれ)</summary>
    private volatile bool _delivered;
    private ulong _sequence;

    public DeviceStream Output { get; private set; } = null!;

    /// <summary>流れが終わった (px4d が止めた・切れた・読み手が居なくて畳んだ・こちらで止めた)</summary>
    public bool Ended => _ended;

    private Px4Stream(Socket socket, string name, TimeSpan stallLimit)
    {
        _socket = socket;
        _name = name;
        _stallLimit = stallLimit;
    }

    /// <summary>
    /// 繋いで ATTACH_STREAM を送り、**最初の TS が来るまで待つ。** 来なければ理由を添えて
    /// <see cref="Px4StreamError"/> を投げる (繋いだものは閉じてある)
    /// </summary>
    public static Px4Stream Attach(
        string socketPath, ulong lease, byte[] nonce, string name, TimeSpan stallLimit, TimeSpan firstTs)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = 4000,
            ReceiveTimeout = 4000,
        };
        var stream = new Px4Stream(socket, name, stallLimit);
        try
        {
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var payload = new byte[8 + nonce.Length];
            BinaryPrimitives.WriteUInt64LittleEndian(payload, lease);
            nonce.CopyTo(payload, 8);
            // px4-ts と同じく request_id 0。最初の枠は ATTACH_STREAM でなければならない (HELLO は無い)
            Px4Control.SendAll(socket, Px4Control.Encode(Px4Control.AttachStream, 0, 0, payload));
            var (type, flags, _, body) = Px4Control.ReadFrame(socket, Px4Control.MaxPayload);
            if (type != Px4Control.AttachStream || (flags & Px4Control.ResponseFlag) == 0)
            {
                throw new IOException($"px4d から ATTACH_STREAM の答えではないものが来ました (型 0x{type:x4})");
            }
            if ((flags & Px4Control.ErrorFlag) != 0) throw Px4Control.Failed(body);
            stream._attached = true;
            // 待つのは pump のほう。ここからは Poll で起きるので、読むときの上限は途中で詰まったときだけ
            socket.ReceiveTimeout = (int)SilenceLimit.TotalMilliseconds;
            stream.StartPump();
        }
        catch (Exception error) when (error is IOException or SocketException)
        {
            socket.Dispose();
            throw new Px4StreamError($"px4d から TS を受け取れません ({error.Message})", stream._attached);
        }

        if (!stream._first.Wait(firstTs))
        {
            stream.Stop();
            throw new Px4StreamError($"同期したのに TS が {firstTs.TotalSeconds:F0} 秒来ません", keepsLease: true);
        }
        // 1枚でも渡せていれば成功。すぐ後に終わっても、読み手は TS を読んでから理由を受け取る
        if (!stream._delivered)
        {
            var reason = stream._reason ?? "px4d との TS の接続が切れました";
            stream.Stop();
            throw new Px4StreamError(reason, keepsLease: true);
        }
        return stream;
    }

    private void StartPump()
    {
        var fds = stackalloc int[2];
        if (Sys.Pipe(fds) < 0) throw new IOException($"pipe を作れません ({Marshal.GetLastPInvokeErrorMessage()})");
        var read = new SafeFileHandle(fds[0], ownsHandle: true);
        _write = new SafeFileHandle(fds[1], ownsHandle: true);
        try
        {
            ChildTs.WidenPipe(fds[1], _name);
            // 書く側は待たない。空きは poll で待ち、その間も止めろと言われていないか見る
            Sys.SetNonBlocking(fds[1]);
        }
        catch
        {
            read.Dispose();
            _write.Dispose();
            throw;
        }
        Output = new DeviceStream(read, () => _reason);
        // **専用のスレッドで。** 流れている間ずっと塞ぐ
        _pump = new Thread(Pump) { IsBackground = true, Name = $"{_name} TS" };
        _pump.Start();
    }

    private void Pump()
    {
        try
        {
            var heard = Stopwatch.StartNew();
            while (!_stopped)
            {
                if (!_socket.Poll(TimeSpan.FromMilliseconds(200), SelectMode.SelectRead))
                {
                    if (heard.Elapsed < SilenceLimit) continue;
                    End($"px4d から TS が {SilenceLimit.TotalSeconds:F0} 秒来ません");
                    return;
                }
                var (type, flags, _, body) = Px4Control.ReadFrame(_socket, Px4Control.MaxTsPayload);
                if (type == Px4Control.StreamEnd && body.Length >= 68)
                {
                    // final counters (u64 × 8) のあとに u32 error_code
                    var code = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(64));
                    End(code == 0 ? "px4d が TS を止めました" : $"px4d が TS を止めました ({Px4Control.Reason(code)})");
                    return;
                }
                if (type != Px4Control.TsData || flags != 0 || body.Length < 20)
                {
                    End($"px4d から知らない枠が来ました (型 0x{type:x4})");
                    return;
                }
                // u64 sequence, u64 cumulative_drop_count, u32 byte_count, bytes
                var sequence = BinaryPrimitives.ReadUInt64LittleEndian(body);
                var dropped = BinaryPrimitives.ReadUInt64LittleEndian(body.AsSpan(8));
                var count = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(16));
                if (count != body.Length - 20 || count % 188 != 0)
                {
                    End($"px4d の TS_DATA の長さが崩れています ({count} バイト)");
                    return;
                }
                if (dropped != 0)
                {
                    End($"px4d が TS を {dropped} 回捨てました ({Px4Control.Reason(15)})");
                    return;
                }
                if (sequence != _sequence)
                {
                    End($"px4d の TS_DATA の番号が飛びました ({_sequence} のはずが {sequence})");
                    return;
                }
                _sequence++;
                if (!Write(body.AsSpan(20))) return;
                _delivered = true;
                _first.Set();
                heard.Restart();
            }
        }
        catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
        {
            End($"px4d との TS の接続が切れました ({error.Message})");
        }
        finally
        {
            _ended = true;
            _socket.Dispose();
            // 読む側はこれで EOF になり、_reason を添えて終わる (DeviceStream の ended)
            _write?.Dispose();
            _first.Set();
        }
    }

    /// <summary>pipe に書き切る。**空かないまま <see cref="_stallLimit"/> 経ったら諦める** (読み手が居ない)</summary>
    private bool Write(ReadOnlySpan<byte> bytes)
    {
        var fd = (int)_write!.DangerousGetHandle();
        Stopwatch? stalled = null;
        while (bytes.Length > 0)
        {
            if (_stopped) return false;
            nint written;
            fixed (byte* source = bytes) written = Sys.WriteFd(fd, source, (nuint)bytes.Length);
            if (written > 0)
            {
                bytes = bytes[(int)written..];
                stalled = null;
                continue;
            }
            var failure = Marshal.GetLastPInvokeError();
            if (failure == 4) continue;  // EINTR
            if (failure != (OperatingSystem.IsMacOS() ? 35 : 11))  // EAGAIN
            {
                End($"TS を渡せません ({Marshal.GetLastPInvokeErrorMessage()})");
                return false;
            }
            stalled ??= Stopwatch.StartNew();
            if (stalled.Elapsed >= _stallLimit)
            {
                End($"読み手が居ないまま {_stallLimit.TotalSeconds:F0} 秒経ったので TS の流れを畳みました (受信機は借りたまま)");
                return false;
            }
            // 止めろと言われたらすぐ降りたいので短く待つ
            Sys.PollOut(fd, 50);
        }
        return true;
    }

    /// <summary>終わった理由を残す。**こちらで止めたときは残さない** (読み手には普通の終わり)</summary>
    private void End(string reason)
    {
        if (_stopped) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>
    /// 止める。pump を降ろして stream.sock を閉じ、読みかけの読み手が戻ってから pipe を閉じる
    /// (<see cref="DeviceStream.WaitReaders"/>、長くても <see cref="ChildTs.ReaderDrain"/>。
    /// 閉じた番号を次の pipe が使い回すと、降りかけの読み手が新しい流れを読んでしまう)。
    /// **局替えのたびに通る**ので、固定では待たない
    /// </summary>
    public void Stop()
    {
        /*
         * **理由は消さない。** ここから先は End が理由を残さない (_stopped) ので、残っているのは
         * 止める前に向こうから終わった理由だけ。読み手が pipe の残りを読み切る前に次の選局が
         * 来ても、読み手には「px4d が TS を止めました (…)」が届く
         */
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output?.Stop();
        // pump を今すぐ起こす (Poll の 200ms を待たない)。閉じる向きを言えば Poll が起き、読めば 0 で降りる
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
        var rest = ChildTs.ReaderDrain - stopped.Elapsed;
        if (rest > TimeSpan.Zero) Output?.WaitReaders(rest);
        Output?.Dispose();
        _ended = true;
    }
}
