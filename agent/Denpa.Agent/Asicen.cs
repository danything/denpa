using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/asicen-userland">asicen-userland</a> に任せる機材
/// (PLEX PX-W3U3。ASICEN 系)。**試験的。上流がまだリリースを出していない。**
///
/// <para>
/// **配布物が無ければ何もしない。** <see cref="Dir"/> に <c>asicend</c> と <c>asicenctl</c> が
/// 無ければ機材を挙げず、選局もしない。イメージには上流が 0.1.0 を出すまで入らない
/// (agent/Dockerfile の <c>ASICEN_USERLAND_VERSION=0.0.0</c> が「まだ無い」の印)。
/// </para>
///
/// <para>
/// **IPC は px4-userland と同じ。** asicen-userland は px4-userland の portable IPC を取り込み、
/// 枠の頭とソケットの置き場だけ変えている (<see cref="Px4Wire.Asicen"/>)。受信機の貸し借り・選局・
/// TS・内蔵カードは px4d と同じ道 (<see cref="Px4Tuner"/> / <see cref="Px4Card"/>) を通す。
/// 同梱の <c>asicen-ts</c> (1回1チャンネルの CLI) と IFD ハンドラ (<c>libifd-asicen.so</c>) は使わない
/// (px4-ts と px4-userland の IFD を使わないのと同じ理由。docs/agent.md)。
/// </para>
///
/// <para>
/// **USB の serial が無いので、挿し口で見分ける。** PX-W3U3 は1つの筐体に USB 機能が2つあり
/// (内蔵ハブの <c>.1</c> と <c>.2</c>)、それぞれに衛星と地上波の受信機が1本ずつ。筐体の名前は
/// 内蔵ハブの挿し口 (<c>1-2</c>) にし、<c>asicend --instance</c> とソケットの置き場にもそのまま使う
/// (px4-userland の PX-M1UR を挿し口で見分けるのと同じ考え。Px4.cs)。
/// **挿し口を変えると別のチューナーになる。** 受信機は上流の決まりどおり <c>0:S, 1:T, 2:S, 3:T</c>。
/// </para>
///
/// <para>
/// **機材は sysfs で見つける。** 上流の配布物 (bin/ の asicend・asicenctl・asicen-ts) には並べる道具が無く
/// (<c>asicen-probe</c> は入らない。<c>asicend --list</c> も実機ではまだ並べない)、asicend には USB の
/// 番地と挿し口を自分で渡す決まりなので、<c>/sys/bus/usb/devices</c> の USB ID と番地を読む
/// (siano-userland でカーネルが掴んでいるかを見るのと同じ場所)。見る USB ID は上流の asicend が受け付けるもの
/// (<c>0b06:0005</c> と、ファームウェア待ちの <c>1738:5211</c> / <c>1738:5216</c>) だけ。
/// 上流が並べる口を出したら、そちらに聞くよう変える。
/// </para>
///
/// <para>
/// 設定の <c>device</c> は <c>asicen:&lt;挿し口&gt;:&lt;受信機&gt;</c> (<c>asicen:1-2:1</c>)。
/// 刺さっていれば <see cref="Detect"/> が組み立てるので、普通は書かなくてよい。
/// </para>
/// </summary>
public static class AsicenUserland
{
    /// <summary>設定の <c>device</c> の頭</summary>
    public const string Scheme = "asicen:";

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)。実行ファイルは <c>bin/</c> の下</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR") ?? "/opt/asicen-userland";

    /// <summary>
    /// ASICEN のファームウェア。**上流の配布アーカイブに入っているものをそのまま使う** (Dockerfile)。
    ///
    /// <para>
    /// 挿した直後の PX-W3U3 は「ファームウェア待ち」(<c>1738:5211</c> / <c>1738:5216</c>) で現れ、
    /// 流し込むと <c>0b06:0005</c> で出直す。asicend は自分では流し込まない (上流 README:
    /// 自動のダウンロードはしない) ので、配布物に <c>asicen-probe</c> があればそれで流す (<see cref="Boot"/>)。
    /// 再配布の権利は確かめられていない (上流 NOTICES.md と、アーカイブの licenses/VENDOR-FIRMWARE-NOTICE.txt)。
    /// </para>
    /// </summary>
    public static string Firmware =>
        Environment.GetEnvironmentVariable("ASICEN_FIRMWARE") ?? Path.Combine(Dir, "firmware", "asicen-loader.bin");

    /// <summary>asicend が socket を置く場所 (この下に <c>asicen-userland/&lt;挿し口&gt;/</c>)</summary>
    public static string RuntimeDir =>
        Environment.GetEnvironmentVariable("ASICEN_RUNTIME_DIR") ?? "/run/asicen-userland";

    /// <summary>USB デバイスが並ぶ sysfs</summary>
    private const string Sysfs = "/sys/bus/usb/devices";

    /// <summary>実行ファイルの場所。配布アーカイブは <c>bin/</c> の下、手で組んだもの (テスト) は直下</summary>
    public static string Bin(string dir, string name) =>
        !File.Exists(Path.Combine(dir, "bin", name)) && File.Exists(Path.Combine(dir, name))
            ? Path.Combine(dir, name)
            : Path.Combine(dir, "bin", name);

    /// <summary>配布物が入っているか。**入っていなければ機材を挙げない** (上流のリリース前はずっとこれ)</summary>
    public static bool Installed =>
        OperatingSystem.IsLinux() && File.Exists(Bin(Dir, "asicend")) && File.Exists(Bin(Dir, "asicenctl"));

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>asicen:1-2:1</c> を割る。形が違えば null</summary>
    public static (string Id, int Receiver)? Parse(string device)
    {
        if (!Is(device)) return null;
        var parts = device[Scheme.Length..].Split(':');
        if (parts.Length != 2 || !ValidId(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

    /// <summary>
    /// 挿し口 (<c>1-2</c>、<c>3-1.4</c>)。筐体の名前もこの形で、asicend の <c>--instance</c> に
    /// そのまま通る (英数字と <c>- .</c>、80 文字まで、数字だけの 14・15 桁ではない)
    /// </summary>
    internal static bool ValidId(string id)
    {
        var dash = id.IndexOf('-');
        if (id.Length > 80 || dash <= 0 || dash == id.Length - 1) return false;
        return id[..dash].All(char.IsAsciiDigit)
            && id[(dash + 1)..].Split('.').All(part => part.Length > 0 && part.All(char.IsAsciiDigit));
    }

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string id, int receiver) => $"{model} {id} #{receiver}";

    /// <summary>USB 機能1つ (sysfs のデバイス1つ)</summary>
    public sealed record Function(string Usb, int Bus, int Address, string Port, bool Loader)
    {
        /// <summary>内蔵ハブの挿し口 (<c>1-2.1</c> → <c>1-2</c>)。ハブの下に無ければ null</summary>
        public string? Parent => Port.LastIndexOf('.') is var dot and > 0 ? Port[..dot] : null;

        /// <summary>内蔵ハブのどの口か (<c>1-2.1</c> → 1)</summary>
        public int Slot => Port.LastIndexOf('.') is var dot and > 0 && int.TryParse(Port[(dot + 1)..], out var slot) ? slot : 0;

        /// <summary>asicend / asicen-probe に渡す番地 (<c>BUS:ADDR</c>)</summary>
        public string Location => $"{Bus}:{Address}";
    }

    /// <summary>
    /// 筐体1台。asicend には USB 機能を2つとも渡す (<c>--primary</c> が内蔵ハブの <c>.1</c>、
    /// <c>--sibling</c> が <c>.2</c>。上流がこの並び以外を断る)
    /// </summary>
    public sealed record Enclosure(string Id, string Model, Function Primary, Function Sibling, IReadOnlyList<Px4Receiver> Receivers);

    /// <summary>
    /// sysfs から ASICEN の USB 機能を拾う。**上流の asicend が受け付ける USB ID だけ。**
    /// PX-W3U3 (<c>0b06:0005</c>) と、ファームウェア待ち (<c>1738:5211</c> / <c>1738:5216</c>)。
    /// 読めないデバイスは黙って飛ばす (抜けかけ・権限)
    /// </summary>
    public static List<Function> Scan(string root = Sysfs)
    {
        if (!Directory.Exists(root)) return [];
        var found = new List<Function>();
        foreach (var dir in Directory.EnumerateDirectories(root).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(dir);
            if (!ValidId(port)) continue;
            var vid = Read(dir, "idVendor");
            var pid = Read(dir, "idProduct");
            var loader = vid == "1738" && pid is "5211" or "5216";
            if (!(vid == "0b06" && pid == "0005") && !loader) continue;
            if (!int.TryParse(Read(dir, "busnum"), out var bus) || !int.TryParse(Read(dir, "devnum"), out var address)) continue;
            found.Add(new Function($"{vid}:{pid}", bus, address, port, loader));
        }
        return found;
    }

    private static string? Read(string dir, string name)
    {
        try
        {
            return File.ReadAllText(Path.Combine(dir, name)).Trim();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// USB 機能を筐体にまとめる。**同じ内蔵ハブの <c>.1</c> と <c>.2</c> が揃っていて、
    /// <c>.1</c> にファームウェアが入っているものだけ使う。**
    ///
    /// <para>
    /// <c>.2</c> はファームウェア待ちのままでも asicend が受け付ける (上流 hardware_ownership.cpp。
    /// いま選局できるのは <c>.1</c> の受信機 0・1 だけ)。使わないものは理由と USB の場所を残す。
    /// </para>
    /// </summary>
    public static List<Enclosure> Group(IEnumerable<Function> functions, Action<string> warn)
    {
        var found = new List<Enclosure>();
        foreach (var group in functions.GroupBy(f => f.Parent ?? f.Port, StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var members = group.ToList();
            var where = string.Join(" / ", members.Select(f => $"{f.Port} ({f.Usb})"));
            var primary = members.FirstOrDefault(f => f.Slot == 1);
            var sibling = members.FirstOrDefault(f => f.Slot == 2);
            if (members.Count != 2 || primary is null || sibling is null || primary.Bus != sibling.Bus || !ValidId(group.Key))
            {
                warn($"ASICEN の機材 (USB {where}) は使えません (同じ内蔵ハブの .1 と .2 の USB 機能が揃っていません)");
                continue;
            }
            if (primary.Loader)
            {
                warn($"ASICEN の機材 (USB {where}) はファームウェア待ちのままなので使いません");
                continue;
            }
            found.Add(new Enclosure(group.Key, "PX-W3U3", primary, sibling, Receivers(4)));
        }
        return found;
    }

    /// <summary>
    /// 受信機の並び。**上流の決まり (<c>0:S, 1:T, 2:S, 3:T</c>。USB 機能ごとに衛星・地上波の順)。**
    /// asicend を起こしたあとは <c>asicenctl list</c> の答えで置き換える (<see cref="AsicenDaemon"/>)。
    /// LNB の給電はできない (上流が断る) ので、15V と書いてあっても 0V で選局する (<see cref="Px4Tuner.Lnb"/>)
    /// </summary>
    public static List<Px4Receiver> Receivers(int count) =>
        [.. Enumerable.Range(0, Math.Max(count, 0)).Select(index => new Px4Receiver(index, index % 2 == 1, index % 2 == 0, false))];

    /// <summary>刺さっている筐体 (ファームウェア待ちのものには先に流し込む)。配布物が無ければ空</summary>
    public static List<Enclosure> Enclosures(Action<string>? warn = null)
    {
        warn ??= Log.Write;
        if (!Installed) return [];
        Boot(warn);
        return Group(Scan(), warn);
    }

    private static readonly Lock BootGate = new();

    /// <summary>流し込んだあと、USB の出直しを待つ長さ</summary>
    private static readonly TimeSpan Reenumerate = TimeSpan.FromSeconds(3);

    /// <summary>
    /// ファームウェア待ちの USB 機能に流し込む。**1つずつ、毎回並べ直して。**
    ///
    /// <para>
    /// 流し込むと USB の番地が変わり、上流の観測では同じ筐体のもう片方まで抜けて出直す
    /// (HARDWARE-VALIDATION.md「Sibling impact」)。古い番地に流さないよう、1つ流すたびに並べ直す。
    /// 同じ挿し口に2度は流さない (上がらなければ諦めて理由を残す。上流も頼み直しはしない)。
    /// **ファームウェアが無ければ流さずに「ファームウェアがありません」と残す。**
    /// 流す道具 (<c>asicen-probe</c>) が配布物に無ければ、そう残す。
    /// </para>
    /// </summary>
    internal static void Boot(Action<string> warn)
    {
        lock (BootGate)
        {
            var tried = new HashSet<string>(StringComparer.Ordinal);
            for (var round = 0; round < 8; round++)
            {
                // .1 を先に (asicend が要るのは .1。.2 は待ちのままでも起こせる)
                var loaders = Scan().Where(f => f.Loader).OrderBy(f => f.Slot).ThenBy(f => f.Port, StringComparer.Ordinal).ToList();
                if (loaders.Count == 0) return;
                var where = string.Join(" / ", loaders.Select(f => f.Port));
                if (!File.Exists(Firmware))
                {
                    warn($"ファームウェアがありません: {Firmware} (asicen-userland の配布物に入っていませんでした)。"
                        + $"ファームウェア待ちの ASICEN の機材 (USB {where}) は使えません");
                    return;
                }
                var probe = Bin(Dir, "asicen-probe");
                if (!File.Exists(probe))
                {
                    warn($"ASICEN の機材 (USB {where}) がファームウェア待ちですが、流し込む道具 (asicen-probe) が配布物にありません");
                    return;
                }
                var target = loaders.FirstOrDefault(f => !tried.Contains(f.Port));
                if (target is null)
                {
                    warn($"ASICEN の機材にファームウェアを流し込みましたが上がってきません (USB {where})。抜き差ししてください");
                    return;
                }
                tried.Add(target.Port);
                var (code, output) = Shell.Run(
                    probe, ["--device", target.Location, "--firmware", Firmware, "load-firmware"], TimeSpan.FromSeconds(30));
                if (code != 0)
                {
                    warn($"ASICEN の機材 (USB {target.Port}) にファームウェアを流し込めません (asicen-probe load-firmware exit {code}: {output})");
                    return;
                }
                Log.Write($"[asicen {target.Port}] ファームウェアを流し込みました");
                Thread.Sleep(Reenumerate);
            }
        }
    }

    /// <summary>刺さっている筐体の受信機を、設定に書いたのと同じ形で</summary>
    public static List<TunerSpec> Detect() => Specs(Enclosures());

    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                Name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, Device(enclosure.Id, receiver.Index)))),
    ];

    /// <summary>設定に出てくる筐体。asicend を起こす相手</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => Parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);

    /// <summary>受信機1本を開く。**受信機の貸し借りと選局は px4d と同じ道** (<see cref="Px4Tuner"/>)</summary>
    public static ITuneDevice Open(string id, int receiver, string? lnb) => new Px4Tuner(
        id, receiver, lnb, RuntimeDir,
        () =>
        {
            var daemon = AsicenDaemon.For(id);
            daemon.Ensure();
            // 聞けなかったときも上流の決まりの並びで見る。null だと 15V をそのまま頼んで断られる
            return daemon.Receivers ?? Receivers(4);
        },
        Px4Wire.Asicen, Device(id, receiver), $"asicen-{id} #{receiver}");

    /// <summary>asicend が起きている筐体の内蔵カードリーダー (px4d と同じ IPC。<see cref="Px4Card"/>)</summary>
    public static IReadOnlyList<CardLinkCandidate> Cards() => Cards(RuntimeDir);

    internal static IReadOnlyList<CardLinkCandidate> Cards(string runtimeDir) =>
        Px4Card.Find(runtimeDir, Px4Wire.Asicen, ValidId, id => $"asicen-userland {id} Internal Card Reader");
}

/// <summary>
/// <c>asicend</c> 1つ。**筐体1台につき1つ、起こしたら止めるまで居る** (<see cref="Px4Daemon"/> と同じ扱い)。
///
/// <para>
/// asicend には USB の番地と挿し口を2組とも渡す (<c>--hardware --primary BUS:ADDR --primary-port …
/// --sibling … --sibling-port …</c>)。番地は挿し直すたびに変わるので、起こす直前に
/// sysfs で聞き直す (<see cref="AsicenUserland.Scan"/>)。ready は <c>asicenctl list</c> が通ることで見る
/// (<c>status</c> はカードの様子も要るので、カードが無いと通らない)。
/// </para>
///
/// <para>
/// **上流はいま1台のホストで1筐体まで** (筐体の錠が <c>/tmp/asicen-userland-enclosure.lock</c> の1つ)。
/// 2台目の asicend は BUSY (exit 4) で終わり、理由は記録に残る。
/// </para>
/// </summary>
public sealed class AsicenDaemon
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, AsicenDaemon> All = new(StringComparer.Ordinal);

    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(30);

    private readonly string _id;
    private readonly string _dir;
    private readonly string _runtimeDir;
    private readonly Func<string[]> _select;
    private readonly Lock _gate = new();
    private Process? _process;
    private string _stderr = "";

    /// <param name="select">
    /// どの機材を掴むかの引数 (<c>--hardware …</c>)。起こす直前に呼ぶ。駄目なら投げる。
    /// テストは <c>--mock</c> を返す (上流の模擬の asicend。機材にもファームウェアにも触らない)
    /// </param>
    internal AsicenDaemon(string id, string dir, string runtimeDir, Func<string[]> select)
    {
        _id = id;
        _dir = dir;
        _runtimeDir = runtimeDir;
        _select = select;
    }

    public static AsicenDaemon For(string id)
    {
        lock (Registry)
        {
            if (!All.TryGetValue(id, out var daemon))
            {
                daemon = new AsicenDaemon(id, AsicenUserland.Dir, AsicenUserland.RuntimeDir, () => Hardware(id));
                All[id] = daemon;
            }
            return daemon;
        }
    }

    /// <summary>
    /// 本物の機材を掴む引数。**ファームウェアが無ければ起こさない** (上流の配布物に入っていなかった)。
    /// ファームウェア待ちのものには先に流し込む (<see cref="AsicenUserland.Enclosures"/>)
    /// </summary>
    private static string[] Hardware(string id)
    {
        if (!File.Exists(AsicenUserland.Firmware))
        {
            throw new IOException($"ファームウェアがありません: {AsicenUserland.Firmware} (asicen-userland の配布物に入っていませんでした)");
        }
        var enclosure = AsicenUserland.Enclosures(_ => { }).FirstOrDefault(found => found.Id == id)
            ?? throw new IOException($"ASICEN の筐体 {id} が見つかりません (抜けたか、挿し口を変えた?)");
        return
        [
            "--hardware",
            "--primary", enclosure.Primary.Location, "--primary-port", enclosure.Primary.Port,
            "--sibling", enclosure.Sibling.Location, "--sibling-port", enclosure.Sibling.Port,
        ];
    }

    public bool Running => _process is { HasExited: false };

    /// <summary>筐体に聞いた受信機 (<c>asicenctl list</c>)。聞けていなければ null</summary>
    public IReadOnlyList<Px4Receiver>? Receivers { get; private set; }

    /// <summary>挙げた筐体ぶん起こす。**起こせなくても止まらない** (理由は記録に、選局のときにもう一度)</summary>
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
                Log.Write($"[asicend {id}] {error.Message}");
            }
        }
    }

    /// <summary>動いていなければ起こして ready まで待つ。駄目なら理由を添えて投げる</summary>
    public void Ensure()
    {
        if (Running) return;
        var asicend = AsicenUserland.Bin(_dir, "asicend");
        if (!File.Exists(asicend)) throw new IOException($"asicen-userland が入っていません: {asicend}");
        // 機材を並べる (最悪 15 秒 + ファームウェアの流し込み) のは錠の外で
        var select = _select();

        lock (_gate)
        {
            if (Running) return;
            _process?.Dispose();
            _process = null;

            // ランタイムルートは呼ぶ側が用意する決まり (px4d と同じ)
            Directory.CreateDirectory(_runtimeDir);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(_runtimeDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            var start = new ProcessStartInfo(asicend, [.. select, "--runtime-dir", _runtimeDir, "--instance", _id])
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            var process = Process.Start(start) ?? throw new IOException("asicend を起動できません");
            _process = process;
            _stderr = "";
            _ = Task.Run(async () =>
            {
                using var reader = process.StandardError;
                while (await reader.ReadLineAsync() is { } line)
                {
                    _stderr = line;
                    Log.Write($"[asicend {_id}] {line}");
                }
            });
            _ = Task.Run(() => process.StandardOutput.ReadToEndAsync());

            var deadline = DateTime.UtcNow + ReadyTimeout;
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited)
                {
                    throw new IOException($"asicend が終了しました (exit {process.ExitCode}: {_stderr})");
                }
                var (code, output) = Control("list", TimeSpan.FromSeconds(5));
                if (code == 0)
                {
                    Log.Write($"[asicend {_id}] ready");
                    Receivers = ListReceivers(output);
                    return;
                }
                Thread.Sleep(500);
            }

            Stop();
            throw new IOException($"asicend が {ReadyTimeout.TotalSeconds} 秒以内に ready になりません ({_stderr})");
        }
    }

    /// <summary><c>asicenctl</c>。筐体はソケットの置き場の名前 (<c>--instance</c>) で呼ぶ (serial が無い)</summary>
    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        AsicenUserland.Bin(_dir, "asicenctl"), ["--instance", _id, "--runtime-dir", _runtimeDir, command], timeout);

    /// <summary>
    /// <c>asicenctl list</c> の受信機の行 (px4ctl list と同じ形)。**LNB は出せない** (上流が断る) ので
    /// 15V の可否は false にする。読めなければ null
    /// </summary>
    private List<Px4Receiver>? ListReceivers(string output)
    {
        var receivers = Px4Receiver.ParseList(output, message => Log.Write($"[asicend {_id}] {message}"))
            .Select(receiver => receiver with { Lnb15v = false })
            .ToList();
        if (receivers.Count == 0)
        {
            Log.Write($"[asicend {_id}] 受信機を聞けません (asicenctl list: {output})");
            return null;
        }
        Log.Write($"[asicend {_id}] 受信機 {receivers.Count} 本: "
            + string.Join(", ", receivers.Select(r => $"#{r.Index} {string.Join("/", r.Types)}")));
        return receivers;
    }

    /// <summary>止める。**SIGTERM で** (asicend は合図で後片付けをしてから終わる)</summary>
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
        List<AsicenDaemon> daemons;
        lock (Registry) daemons = [.. All.Values];
        foreach (var daemon in daemons) daemon.Stop();
    }
}
