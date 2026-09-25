using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/px4-userland">px4-userland</a> に任せる機材
/// (PLEX PX-Q3U4 / PX-MLT5PE / e-Better DTV02A-5TS-P …)。
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
/// **機種ごとの違いは、できるだけ px4-userland に聞く。** 受信機が何本あって
/// それぞれ何を受けられるかは、px4d を起こしてから <c>px4ctl list</c> で聞く
/// (<see cref="Px4Receiver"/>)。こちらで持つのは <see cref="Models"/> の
/// **USB での見分け方だけ** — px4-userland には「刺さっている筐体を挙げる」口が
/// 無く、px4d を誰のために起こすかはこちらで決めるしかないため。対応機種が
/// 増えたら、ここに1行足せば済む。
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

    /// <summary>
    /// px4-userland が対応している機種の USB での見分け方 (px4-userland SPEC 4.1)。
    ///
    /// <para>
    /// <c>UsbFunctions</c> は筐体1台が出す USB デバイスの数。2つ以上出す機種は
    /// シリアルの**末尾1桁**が機能の番号で、残りが筐体の番号になる
    /// (Q3U4 の <c>000012050009601</c> / <c>…602</c> → <c>00001205000960</c>)。
    /// 1つの機種はシリアル全体が筐体の番号。
    /// </para>
    /// </summary>
    public sealed record Model(string Vendor, string Product, string Name, int UsbFunctions);

    public static readonly Model[] Models =
    [
        new("0511", "084a", "PX-Q3U4", 2),
        new("0511", "024e", "PX-MLT5PE", 1),
        new("0511", "924e", "DTV02A-5TS-P", 1),
    ];

    /// <summary>刺さっている筐体1台。<c>Id</c> は px4d に <c>--device</c> で渡す番号</summary>
    public sealed record Enclosure(string Id, string Model);

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
    /// 刺さっている筐体。**USB 機能が全部見えているものだけ。**
    ///
    /// <para>
    /// sysfs を読む。libusb を呼ばなくても <c>/sys/bus/usb/devices/*/{idVendor,idProduct,serial}</c>
    /// で足りる (コンテナからも読める)。機能が欠けている筐体は px4d が
    /// ready にならないので、ここで落として理由を残す。
    /// </para>
    /// </summary>
    public static List<Enclosure> Enclosures(string sysfs = "/sys/bus/usb/devices")
    {
        var seen = new Dictionary<string, (Model Model, int Count)>(StringComparer.Ordinal);
        if (!Directory.Exists(sysfs)) return [];
        foreach (var entry in Directory.EnumerateDirectories(sysfs))
        {
            var vendor = Attribute(entry, "idVendor");
            var product = Attribute(entry, "idProduct");
            if (Models.FirstOrDefault(m => m.Vendor == vendor && m.Product == product) is not { } model) continue;
            if (Attribute(entry, "serial") is not { } serial) continue;
            var id = model.UsbFunctions > 1 ? serial[..^1] : serial;
            if (!Digits(id))
            {
                Log.Write($"{model.Name} のシリアル {serial} が読めません (数字だけのはず)");
                continue;
            }
            seen[id] = (model, seen.GetValueOrDefault(id).Count + 1);
        }

        var found = new List<Enclosure>();
        foreach (var (id, (model, count)) in seen.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (count == model.UsbFunctions)
            {
                found.Add(new Enclosure(id, model.Name));
                continue;
            }
            Log.Write($"{model.Name} {id} は USB が {count} 機能しか見えていません ({model.UsbFunctions} つ揃わないと使えません)");
        }
        return found;
    }

    private static string? Attribute(string directory, string name)
    {
        try
        {
            var path = Path.Combine(directory, name);
            return File.Exists(path) ? File.ReadAllText(path).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 刺さっている筐体の受信機を、設定に書いたのと同じ形で。
    ///
    /// <para>
    /// **px4d が ready になって受信機を聞けた筐体だけ。** 起動直後はまだ空で、
    /// 聞けたところでエージェントが組み直す (Program.cs の <c>PreparePx4</c>)。
    /// </para>
    /// </summary>
    public static List<TunerSpec> Detect(string sysfs = "/sys/bus/usb/devices") =>
        Specs(Enclosures(sysfs), id => Px4Daemon.For(id).Receivers);

    /// <summary>筐体と受信機の一覧から、設定の形に組み立てる</summary>
    public static List<TunerSpec> Specs(
        IEnumerable<Enclosure> enclosures, Func<string, IReadOnlyList<Px4Receiver>?> receivers)
    {
        var found = new List<TunerSpec>();
        foreach (var enclosure in enclosures)
        {
            foreach (var receiver in receivers(enclosure.Id) ?? [])
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
/// 受信機1本。**<c>px4ctl list</c> で筐体に聞いたもの。**
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
    /// <c>px4ctl list</c> の出力を読む。
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
/// **カードリーダーもここが繋ぐ。** ready になったら pcscd 向けの reader.conf を
/// 書き、pcscd が既に動いていれば読み直させる。IFD ハンドラは登録された
/// 時点で px4d に繋ぎに来るので、**px4d が先**でないとリーダーが登録されない。
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
                    RegisterReader();
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
    /// 内蔵カードリーダーを pcscd に見せる。
    ///
    /// <para>
    /// 配布アーカイブの雛形 (<c>reader.conf.d/px4-userland.conf</c>) と同じ形。
    /// px4d と pcscd は同じユーザー (root) で動くので private mode (<c>access=user</c>)。
    /// pcscd が既に動いていれば <c>--hotplug</c> で読み直させる (起動前なら
    /// 起動時に読む。Card.EnsurePcscd はこの後に呼ぶ)。
    /// </para>
    /// </summary>
    private void RegisterReader()
    {
        var ifd = Path.Combine(Px4Userland.Dir, "ifd", "px4-userland-ifd.so");
        if (!File.Exists(ifd))
        {
            Log.Write($"[px4d {_id}] IFD ハンドラが無いので内蔵カードリーダーは使えません: {ifd}");
            return;
        }

        try
        {
            Directory.CreateDirectory(Px4Userland.ReaderConfDir);
            var conf = Path.Combine(Px4Userland.ReaderConfDir, $"px4-userland-{_id}.conf");
            File.WriteAllText(conf, ReaderConf(_id, Px4Userland.RuntimeDir, ifd));
        }
        catch (Exception error)
        {
            Log.Write($"[px4d {_id}] reader.conf を書けません: {error.Message}");
            return;
        }

        var pcscd = Shell.Run("pgrep", ["-x", "pcscd"], TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        if (pcscd.Code != 0) return;
        var reload = Shell.Run("pcscd", ["--hotplug"], TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        Log.Write(reload.Code == 0
            ? $"[px4d {_id}] pcscd に内蔵カードリーダーを読み直させました"
            : $"[px4d {_id}] pcscd に読み直しを頼めません: {reload.Output}");
    }

    /// <summary>pcscd の reader.conf。1筐体1枚</summary>
    public static string ReaderConf(string id, string runtimeDir, string ifd) =>
        $"""
        # denpa-agent が書いたもの。筐体 {id} の内蔵カードリーダー (px4-userland)
        FRIENDLYNAME "px4-userland {id[^4..]} Internal Card Reader"
        DEVICENAME   px4-userland:runtime={runtimeDir}:device={id}:access=user
        LIBPATH      {ifd}
        CHANNELID    0

        """;

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
/// **読み口は <see cref="DeviceStream"/> に載せる。** 子の標準出力の pipe を
/// そのまま fd として poll で待つので、電波が来なくても畳めるし、蹴られた
/// 読み手は 200ms で降りる (DVB と同じ振る舞い)。
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

    /// <summary>
    /// 標準出力の pipe の深さ。
    ///
    /// <para>
    /// 既定 (64KB) だと地上波の 18Mbit/秒 で **30ms** しか無い。読む側が GC で
    /// 一瞬止まるだけで px4-ts の write が詰まり、px4d 側の溜めも埋まれば
    /// <c>SLOW_CONSUMER</c> で切られる。DVB の環 (8MB = 3.5秒) に揃える。
    /// 上限 (<c>/proc/sys/fs/pipe-max-size</c>、既定 1MB) を超えるには
    /// CAP_SYS_RESOURCE が要るが、コンテナは privileged なので通る。
    /// 通らなければ 1MB で妥協する
    /// </para>
    /// </summary>
    private const int PipeSize = 8 * 1024 * 1024;

    private const int FallbackPipeSize = 1024 * 1024;

    /// <summary>
    /// 読み手が降りきるまでの猶予。<see cref="DeviceStream"/> は 200ms ごとに
    /// 起きて印を見るので、fd を閉じるのはそれより後にする (閉じた番号を
    /// 次の子が使い回すと、降りかけの読み手が新しい pipe を読んでしまう)
    /// </summary>
    private static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly string _name;
    private readonly Lock _gate = new();
    private Child? _child;
    private DeviceStream? _stream;

    /// <summary>
    /// px4-ts 1つぶん。**印は子ごとに持つ。** 止めたかどうかを1つの旗で持つと、
    /// 前の子の後始末が次の子の旗を読む (起こし直した直後に前の子の終了が回ってくる)
    /// </summary>
    private sealed class Child(Process process)
    {
        public Process Process { get; } = process;

        /// <summary>stderr の末尾。失敗の理由はここに出る</summary>
        public volatile string Stderr = "";

        /// <summary>こちらから止めたか。**自分で止めた終わりは失敗ではない**</summary>
        public volatile bool Dropped;
    }

    public Px4Tuner(string id, int receiver, string? lnb)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _name = $"px4-{id[^4..]} #{receiver}";
    }

    public Stream Output => _stream ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

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
                return _stream is not null && _child is { Process.HasExited: false };
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
            Drop();

            var start = new ProcessStartInfo(Path.Combine(Px4Userland.Dir, "px4-ts"))
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var arg in Arguments(_id, _receiver, tuning, streamId, _lnb)) start.ArgumentList.Add(arg);
            start.ArgumentList.Add("--runtime-dir");
            start.ArgumentList.Add(Px4Userland.RuntimeDir);

            var process = Process.Start(start) ?? throw new IOException("px4-ts を起こせません");
            var child = new Child(process);
            _child = child;
            _ = Task.Run(async () =>
            {
                // 失敗の理由は stderr の末尾に出る。全部は持たない
                using var reader = process.StandardError;
                while (await reader.ReadLineAsync() is { } line)
                {
                    if (line.Trim().Length > 0) child.Stderr = line.Trim();
                }
            });

            var handle = ((FileStream)process.StandardOutput.BaseStream).SafeFileHandle;
            var fd = (int)handle.DangerousGetHandle();
            if (Sys.Fcntl(fd, Sys.SetPipeSize, PipeSize) < 0 && Sys.Fcntl(fd, Sys.SetPipeSize, FallbackPipeSize) < 0)
            {
                Log.Write($"[{_name}] pipe を広げられませんでした ({Marshal.GetLastPInvokeErrorMessage()})");
            }

            /*
             * **同期を待つ。** px4-ts は同期するまで標準出力に1バイトも書かない
             * (書くのは TS だけ)。最初の1バイトが読めるようになったら同期した、
             * 先に終わったら失敗 (理由は stderr)。何も無いまま時間が過ぎたら
             * 電波が来ていない
             */
            var deadline = DateTime.UtcNow + TuneTimeout + FirstTsGrace;
            var synced = false;
            while (DateTime.UtcNow < deadline)
            {
                var (readable, ended) = Sys.PollIn(fd, 100);
                if (ended || process.HasExited)
                {
                    // 先に終わった。理由は stderr に出ている (同期しなかった・受信機が使用中・USB…)
                    process.WaitForExit(TimeSpan.FromSeconds(2));
                    var reason = Reason(process.ExitCode, child.Stderr);
                    Drop();
                    throw new IOException(reason);
                }
                if (readable)
                {
                    synced = true;
                    break;
                }
            }
            if (!synced)
            {
                Drop();
                throw new IOException("同期しませんでした (電波が来ていないか、その周波数に放送がありません)");
            }

            _stream = new DeviceStream(handle, () => EndReason(child));
            _ = process.WaitForExitAsync().ContinueWith(_ =>
            {
                if (child.Dropped) return;
                // 読み手が居なくなって px4d に切られたのも、USB が抜けたのもここに来る
                Log.Write($"[{_name}] {Reason(process.ExitCode, child.Stderr)}");
            }, TaskScheduler.Default);
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

    private static string Reason(int code, string stderr) =>
        $"px4-ts が終了しました (exit {code}{(stderr.Length == 0 ? "" : $": {stderr}")})";

    /// <summary>
    /// 読み口が尽きたときの理由。**理由の分かる終わり方をする** (DeviceStream)。
    /// EOF は子が終わったということなので、終了コードと stderr の末尾を添える
    /// </summary>
    private static string? EndReason(Child child)
    {
        if (child.Dropped) return null;
        if (!child.Process.WaitForExit(TimeSpan.FromSeconds(2))) return "px4-ts が黙りました";
        return Reason(child.Process.ExitCode, child.Stderr);
    }

    /// <summary>
    /// 走っている px4-ts を止める。**SIGTERM で。** 受信機の lease を返してから終わる。
    /// 読み手が降りきってから fd を閉じる (<see cref="ReaderDrain"/>)
    /// </summary>
    private void Drop()
    {
        var child = _child;
        var stream = _stream;
        _child = null;
        _stream = null;
        if (child is null) return;

        child.Dropped = true;
        stream?.Stop();
        var stopped = Stopwatch.StartNew();
        var process = child.Process;
        if (!process.HasExited)
        {
            Interop.Terminate(process.Id);
            if (!process.WaitForExit(TimeSpan.FromSeconds(2))) process.Kill();
        }
        var rest = ReaderDrain - stopped.Elapsed;
        if (stream is not null && rest > TimeSpan.Zero) Thread.Sleep(rest);
        stream?.Dispose();
        process.Dispose();
    }

    public void Dispose()
    {
        lock (_gate) Drop();
    }
}
