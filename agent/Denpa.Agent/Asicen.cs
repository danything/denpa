using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/asicen-userland">asicen-userland</a> に任せる機材
/// (PLEX PX-W3U3 など。ASICEN 系)。**試験的。上流の v1.0.0-beta (プレリリース) に合わせた実装で、実機では確かめていない。**
///
/// <para>
/// **配布物が無ければ何もしない** (<see cref="Installed"/>)。機材は <c>asicend --list-json</c> で見つけ (<see cref="Enclosures"/>)、
/// 筐体ごとに <c>asicend</c> を 1 つ起動して (<see cref="AsicenDaemon"/>)、制御ソケットで UDTV 1.0 を送る (AsicenUdtv.cs)。
/// 作りは docs/agent.md「asicen-userland の作り」。
/// </para>
///
/// <para>
/// 元にしたもの: 上流の README・リリースノート、dtv-userland-core v1.0.3 の docs/external-contract-1.0.0.md と docs/json-discovery.md、
/// 配布物のコマンドの <c>--help</c>・<c>--models</c>・<c>--list-json</c> の出力、模擬のデーモン (asicend-mock) に対する
/// 公式のクライアントの出力。**上流のソースは読んでいない。** 機材をつないだときの <c>--list-json</c> の出力は観察していない
/// (文書の例から書いた)。上流がバージョンを上げると動かなくなることがある。
/// </para>
///
/// <para>
/// **USB の serial が無いので、ポートで見分ける。** USB 機能が 2 つの機種 (PX-W3U2・PX-W3U3・PX-W3U3 V2) は内蔵ハブの
/// <c>.1</c> と <c>.2</c> に 1 つずつ現れるので、筐体の名前は内蔵ハブのポート (<c>1-2</c>) にする。USB 機能が 1 つの機種
/// (PX-S3U・PX-S3U2) は、その機能のポートを名前にする。名前は <c>asicend --instance</c> とソケットの置き場にもそのまま使う。
/// **ポートを変えると別のチューナーになる。** 設定の <c>device</c> は <c>asicen:&lt;ポート&gt;:&lt;受信機&gt;</c> (<c>asicen:1-2:1</c>)。
/// </para>
/// </summary>
public static class AsicenUserland
{
    /// <summary>設定の <c>device</c> の接頭辞</summary>
    public const string Scheme = "asicen:";

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)。v1.0.0-beta のアーカイブはフォルダ分けが無く、実行ファイルは直下にある</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR") ?? "/opt/asicen-userland";

    /// <summary>
    /// ASICEN のファームウェア。**上流の配布アーカイブに入っているものをそのまま使う** (Dockerfile)。
    ///
    /// <para>
    /// 挿した直後の機材は「ファームウェア待ち」で現れ、asicend が起動するときに流し込む (<c>--firmware</c> は必須。上流 README)。
    /// 再配布の許諾は確かめられていない。上流と同じ判断でイメージに同梱している (docs/licenses.md「ASICEN のファームウェアを同梱している判断」)。
    /// </para>
    /// </summary>
    public static string Firmware =>
        Environment.GetEnvironmentVariable("ASICEN_FIRMWARE") ?? Path.Combine(Dir, "firmware", "asicen-loader.bin");

    /// <summary>asicend がソケットを置く場所 (この下に <c>asicen-userland/v1/&lt;ポート&gt;/</c>)</summary>
    public static string RuntimeDir =>
        Environment.GetEnvironmentVariable("ASICEN_RUNTIME_DIR") ?? "/run/asicen-userland";

    /// <summary>実行ファイルの場所。配布アーカイブは直下。<c>bin/</c> の下にあればそちら</summary>
    public static string Bin(string dir, string name) =>
        File.Exists(Path.Combine(dir, "bin", name)) ? Path.Combine(dir, "bin", name) : Path.Combine(dir, name);

    /// <summary>配布物が入っているか。**入っていなければ機材を挙げない**</summary>
    public static bool Installed =>
        OperatingSystem.IsLinux() && File.Exists(Bin(Dir, "asicend")) && File.Exists(Bin(Dir, "asicenctl"));

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    /// <summary><c>asicen:1-2:1</c> を割る。形式が違えば null</summary>
    public static (string Id, int Receiver)? Parse(string device) => Px4Userland.Parse(device, Scheme, ValidId);

    /// <summary>
    /// ポート (<c>1-2</c>、<c>3-1.4</c>)。筐体の名前もこの形式で、asicend の <c>--instance</c> に
    /// そのまま通る (英数字で始まる、英数字と <c>_ . -</c>、64 文字まで。external-contract §3.2.1)
    /// </summary>
    internal static bool ValidId(string id) => id.Length <= 64 && UsbSysfs.IsPort(id);

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string id, int receiver) => $"{model} {id} #{receiver}";

    /// <summary>
    /// 上流が見分ける機種 (上流 README の表と <c>asicend --models</c>)。受信機の並びは README と、模擬の <c>asicenctl list</c> の出力。
    /// </summary>
    /// <param name="Functions">USB 機能の数</param>
    /// <param name="Systems">受信機ごとの方式 (番号順。<c>ISDB-T</c>・<c>ISDB-S</c> をコンマで並べる)</param>
    /// <param name="Lnb">
    /// 上流が LNB の給電に対応としているか。PX-S3U・PX-S3U2 は上流が給電の制御を未解明としているので false
    /// </param>
    public sealed record Model(string Name, string Usb, int Functions, string[] Systems, bool Lnb);

    public static readonly IReadOnlyList<Model> Models =
    [
        // 受信部 1 つを地上波と衛星で排他に使う
        new("PX-S3U", "0b06:0001", 1, ["ISDB-T,ISDB-S"], false),
        new("PX-S3U2", "0b06:0003", 1, ["ISDB-S", "ISDB-T"], false),
        new("PX-W3U2", "0b06:0004", 2, ["ISDB-S", "ISDB-T", "ISDB-S", "ISDB-T"], true),
        new("PX-W3U3", "0b06:0005", 2, ["ISDB-S", "ISDB-T", "ISDB-S", "ISDB-T"], true),
        new("PX-W3U3 V2", "0b06:0006", 2, ["ISDB-S", "ISDB-T", "ISDB-S", "ISDB-T"], true),
    ];

    /// <summary>LNB に給電してよい機種か (PX-W3U2・PX-W3U3・PX-W3U3 V2)</summary>
    public static bool PowersLnb(string model) => Models.Any(known => known.Name == model && known.Lnb);

    /// <summary>
    /// 受信機 1 つを方式の名前から組み立てる。<c>ISDB-T</c>・<c>ISDB-S</c> をコンマか <c>/</c> で並べたもの。
    /// 対応していない方式が混じっていれば理由を残して null
    /// </summary>
    internal static Px4Receiver? Receiver(int number, IEnumerable<string> systems, string model, Action<string> warn)
    {
        var names = systems.SelectMany(system => system.Split(',', '/')).Select(name => name.Trim()).Where(name => name.Length > 0).ToList();
        if (names.Count == 0 || names.Any(name => name is not ("ISDB-T" or "ISDB-S")))
        {
            warn($"受信機 {number} の方式 {string.Join(",", names)} には対応していません (asicen-userland が新しい?)。この受信機は使いません");
            return null;
        }
        var satellite = names.Contains("ISDB-S");
        return new Px4Receiver(number, names.Contains("ISDB-T"), satellite, satellite && PowersLnb(model));
    }

    /// <summary>筐体 1 台。<see cref="Ports"/> は USB 機能のポート (asicend の <c>--device usb:</c> に渡す)</summary>
    public sealed record Enclosure(string Id, string Model, IReadOnlyList<string> Ports, IReadOnlyList<Px4Receiver> Receivers);

    /// <summary>動いている asicend に問い合わせた機種と受信機 (<c>asicenctl list</c>)</summary>
    public sealed record Listed(string Model, IReadOnlyList<Px4Receiver> Receivers);

    /// <summary>
    /// 筐体の名前。USB 機能が 2 つなら同じ内蔵ハブの <c>.1</c> と <c>.2</c> のはずで、そのハブのポート。1 つならそのポート。
    /// どちらでもなければ null
    /// </summary>
    internal static string? IdOf(IReadOnlyList<string> ports)
    {
        if (ports.Count == 1) return ValidId(ports[0]) ? ports[0] : null;
        if (ports.Count != 2) return null;
        var parents = ports.Select(port => port.LastIndexOf('.') is var dot and > 0 ? port[..dot] : null).Distinct().ToList();
        return parents is [{ } parent] && ValidId(parent) ? parent : null;
    }

    /// <summary>
    /// <c>asicend --list-json</c> の出力 (dtv-userland-core の docs/json-discovery.md の <c>userland.discovery</c> 1.0) を読む。
    /// **使うのは <c>status=ready</c> で、機種が <see cref="Models"/> にあり、USB 機能の数が合う筐体だけ。**
    ///
    /// <para>
    /// **バージョンを固定する。** <c>producer</c> が asicen 1.0.0 でなければ、機材を挙げずに理由を残す。
    /// 受信機は出力にあればそれを、無ければ (文書では、構成が分からないデバイスは <c>receivers</c> を省く) 機種の表を使う。
    /// 使わない筐体と、まとめられなかった USB デバイスは、理由と USB のポートを残す。
    /// </para>
    /// </summary>
    /// <exception cref="JsonException">JSON として読めない</exception>
    /// <exception cref="FormatException">文書が無い・object でない</exception>
    public static List<Enclosure> ParseDiscovery(string output, Action<string> warn)
    {
        var line = output.Split('\n').Select(raw => raw.Trim()).FirstOrDefault(raw => raw.StartsWith('{'))
            ?? throw new FormatException("JSON の文書がありません");
        var root = JsonNode.Parse(line) as JsonObject ?? throw new FormatException("JSON の文書が object ではありません");
        var schema = root["schema"] as JsonObject;
        var producer = root["producer"] as JsonObject;
        var product = Text(producer, "product");
        var version = Text(producer, "version");
        if (Text(schema, "name") != "userland.discovery" || Number(schema, "major") != 1 || product != "asicen" || version != Udtv.Version)
        {
            warn($"asicend --list-json が {product} {version} ({Text(schema, "name")} {Number(schema, "major")}) です。"
                + $"対応を確かめたのは asicen {Udtv.Version} (userland.discovery 1) だけなので、ASICEN の機材は使いません");
            return [];
        }

        var found = new List<Enclosure>();
        foreach (var enclosure in (root["enclosures"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var devices = (enclosure["devices"] as JsonArray ?? []).OfType<JsonObject>().ToList();
            var ports = devices.Select(device => Text(device, "port")).OfType<string>().Order(StringComparer.Ordinal).ToList();
            var usb = devices.Select(device => Text(device, "usb")).OfType<string>().FirstOrDefault();
            var where = ports.Count > 0 ? $"USB {string.Join(" / ", ports)}" : "USB のポートは不明";
            var name = Text(enclosure, "model");
            var model = Models.FirstOrDefault(known => known.Name == name) ?? Models.FirstOrDefault(known => name is null && known.Usb == usb);
            var status = Text(enclosure, "status");
            if (model is null)
            {
                warn($"ASICEN の機材 {name ?? usb ?? "(機種不明)"} ({where}) は使えません (対応を確かめた機種ではありません)");
                continue;
            }
            if (status != "ready")
            {
                warn($"{model.Name} ({where}) は使えません (asicend --list-json: status={status})");
                continue;
            }
            if (ports.Count != model.Functions || ports.Count != devices.Count || IdOf(ports) is not { } id)
            {
                warn($"{model.Name} ({where}) は使えません (USB 機能が {model.Functions} つ揃っていないか、ポートが読めません)");
                continue;
            }

            var listed = devices.SelectMany(device => (device["receivers"] as JsonArray ?? []).OfType<JsonObject>())
                .Select(receiver => (
                    Number: Number(receiver, "receiver"),
                    Systems: (receiver["systems"] as JsonArray ?? []).Select(system => system is JsonValue value && value.TryGetValue<string>(out var text) ? text : "").ToList()))
                .ToList();
            var receivers = listed.Count > 0
                ? listed.Select(receiver => receiver.Number is { } number ? Receiver(number, receiver.Systems, model.Name, warn) : null)
                : model.Systems.Select((systems, index) => Receiver(index, [systems], model.Name, warn));
            found.Add(new Enclosure(id, model.Name, ports, [.. receivers.OfType<Px4Receiver>().OrderBy(receiver => receiver.Index)]));
        }

        foreach (var device in (root["ungrouped_usb_devices"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var usb = Text(device, "usb");
            // ファームウェア待ちの機材は Boot が扱い、理由もそちらが残す
            if (usb is not null && Loaders.Contains(usb)) continue;
            warn($"ASICEN の機材 {Text(device, "model") ?? usb} (USB {Text(device, "port")}) を使えません: {Text(device, "status")}"
                + (Text(device, "status") == "open_failed" ? " (/dev/bus/usb を開く権限が無いか、別のプロセスが使っています)" : ""));
        }
        return found;
    }

    private static string? Text(JsonObject? obj, string key) =>
        obj is not null && obj.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static int? Number(JsonObject? obj, string key) =>
        obj is not null && obj.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<int>(out var number) ? number : null;

    /// <summary>
    /// <c>asicenctl list</c> の出力を読む。**観察した形式: <c>model=PX-W3U3</c> の行と、受信機ごとの
    /// <c>receiver=0 device=1 local=0 system=ISDB-S</c> の行** (PX-S3U は <c>system=ISDB-T,ISDB-S</c>)。
    /// 機種が <see cref="Models"/> に無いか、受信機が 1 つも読めなければ null
    /// </summary>
    public static Listed? ParseList(string output, Action<string> warn)
    {
        string? model = null;
        var receivers = new List<Px4Receiver>();
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            // 機種の名前は空白を含む (PX-W3U3 V2) ので、行の残りを全部取る
            if (line.StartsWith("model=", StringComparison.Ordinal))
            {
                model = line["model=".Length..];
                continue;
            }
            var fields = Px4Receiver.Fields(line);
            if (!fields.TryGetValue("receiver", out var index) || !fields.TryGetValue("system", out var system)) continue;
            if (int.TryParse(index, out var number) && model is not null && Receiver(number, [system], model, warn) is { } receiver) receivers.Add(receiver);
        }
        if (model is null || Models.All(known => known.Name != model))
        {
            warn($"asicenctl list の機種 {model ?? "(なし)"} は、対応を確かめた機種ではありません");
            return null;
        }
        return receivers.Count == 0 ? null : new Listed(model, receivers);
    }

    /// <summary>挿さっている筐体 (ファームウェア待ちのものには先に流し込む)。配布物が無ければ空</summary>
    public static List<Enclosure> Enclosures(Action<string>? warn = null)
    {
        warn ??= Log.Write;
        if (!Installed) return [];
        Boot(warn);
        var (code, output) = Shell.Run(Bin(Dir, "asicend"), ["--list-json"], TimeSpan.FromSeconds(15));
        if (code != 0)
        {
            warn($"ASICEN の機材を挙げられません (asicend --list-json exit {code}: {output})");
            return [];
        }
        try
        {
            return ParseDiscovery(output, warn);
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            warn($"asicend --list-json の応答が読めません ({error.Message})");
            return [];
        }
    }

    /// <summary>ファームウェア待ちの USB ID (上流の HARDWARE-VALIDATION.md)</summary>
    private static readonly string[] Loaders = ["1738:5211", "1738:5216"];

    /// <summary>USB 機能 1 つ (sysfs のデバイス 1 つ)</summary>
    public sealed record Function(string Usb, string Port, bool Loader)
    {
        /// <summary>内蔵ハブのポート (<c>1-2.1</c> → <c>1-2</c>)。ハブの下に無ければ null</summary>
        public string? Parent => Port.LastIndexOf('.') is var dot and > 0 ? Port[..dot] : null;

        /// <summary>内蔵ハブのどのポートか (<c>1-2.1</c> → 1)</summary>
        public int Slot => Port.LastIndexOf('.') is var dot and > 0 && int.TryParse(Port[(dot + 1)..], out var slot) ? slot : 0;
    }

    /// <summary>
    /// sysfs から ASICEN の USB 機能を探す。**ファームウェア待ちの機材を見つけるためだけに使う** (<see cref="Boot"/>)。
    /// 5 機種 (<see cref="Models"/>) と、ファームウェア待ち (<c>1738:5211</c> / <c>1738:5216</c>)。読めないデバイスは飛ばす
    /// </summary>
    public static List<Function> Scan(string root = UsbSysfs.Devices)
    {
        if (!Directory.Exists(root)) return [];
        var found = new List<Function>();
        foreach (var dir in Directory.EnumerateDirectories(root).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(dir);
            if (!UsbSysfs.IsPort(port)) continue;
            var usb = $"{UsbSysfs.Read(dir, "idVendor")}:{UsbSysfs.Read(dir, "idProduct")}";
            var loader = Loaders.Contains(usb);
            if (!loader && Models.All(model => model.Usb != usb)) continue;
            found.Add(new Function(usb, port, loader));
        }
        return found;
    }

    /// <summary>
    /// ファームウェア待ちの USB 機能を、asicend に渡す組にまとめる。**同じハブの <c>.1</c> と <c>.2</c> に ASICEN の USB 機能が
    /// 2 つあれば 1 つの筐体とみなして両方を、そうでなければその機能だけを渡す。** ファームウェア待ちの間は機種が分からないので、
    /// 外付けのハブの <c>.1</c> と <c>.2</c> に USB 機能が 1 つの機種を 2 台挿したときは見分けられない (asicend が断り、理由が記録に残る)
    /// </summary>
    internal static List<(string Id, IReadOnlyList<string> Ports)> Waiting(IReadOnlyList<Function> functions)
    {
        var found = new List<(string, IReadOnlyList<string>)>();
        foreach (var loader in functions.Where(function => function.Loader))
        {
            var pair = functions.Where(other => other.Parent is not null && other.Parent == loader.Parent && other.Slot is 1 or 2)
                .OrderBy(other => other.Slot).ToList();
            IReadOnlyList<string> ports = pair.Count == 2 && pair[0].Slot == 1 && pair[1].Slot == 2 ? [pair[0].Port, pair[1].Port] : [loader.Port];
            if (IdOf(ports) is { } id && found.All(known => known.Item1 != id)) found.Add((id, ports));
        }
        return found;
    }

    private static readonly Lock BootGate = new();

    /// <summary>流し込みを試した筐体。**同じ筐体に 2 度は試さない** (ファームウェア待ちでなくなったら、ここから消す)</summary>
    private static readonly HashSet<string> Booted = new(StringComparer.Ordinal);

    /// <summary>
    /// ファームウェア待ちの機材に流し込む。**asicend を 1 度起動して ready まで待ち、止める** (流し込むのは asicend。上流 README)。
    ///
    /// <para>
    /// 設定に書いてある筐体は、asicend を起動したときに流し込まれる。ここで扱うのは、まだ設定に無い機材を自動検出で挙げるとき。
    /// ファームウェア待ちの間は機種も受信機も分からないので、流し込んでから一覧を取る。
    /// **ファームウェアが無ければ流さずに「ファームウェアがありません」と残す。** すでに asicend が動いている筐体は飛ばす。
    /// </para>
    /// </summary>
    internal static void Boot(Action<string> warn)
    {
        lock (BootGate)
        {
            var waiting = Waiting(Scan());
            Booted.IntersectWith(waiting.Select(enclosure => enclosure.Id));
            foreach (var (id, ports) in waiting)
            {
                if (AsicenDaemon.For(id).Running || !Booted.Add(id)) continue;
                var where = string.Join(" / ", ports);
                if (!File.Exists(Firmware))
                {
                    warn($"ファームウェアがありません: {Firmware} (asicen-userland の配布物に入っていませんでした)。"
                        + $"ファームウェア待ちの ASICEN の機材 (USB {where}) は使えません");
                    continue;
                }
                var loader = new AsicenDaemon(id, Dir, RuntimeDir, () => AsicenDaemon.Arguments(ports, Firmware, allowLnb: false));
                try
                {
                    loader.Ensure();
                    Log.Write($"[asicen {id}] ファームウェアを流し込みました");
                }
                catch (IOException error)
                {
                    warn($"ASICEN の機材 (USB {where}) にファームウェアを流し込めません ({error.Message})");
                }
                finally
                {
                    loader.Stop();
                }
            }
        }
    }

    /// <summary>挿さっている筐体の受信機を、設定に書いたのと同じ形式で</summary>
    public static List<TunerSpec> Detect() => Specs(Enclosures());

    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
        Px4Userland.Specs(enclosures.Select(enclosure => (enclosure.Id, enclosure.Model, enclosure.Receivers)), Name, Device);

    /// <summary>設定に出てくる筐体。asicend を起動する対象</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => Px4Userland.IdsIn(specs, Parse);

    private static volatile HashSet<string> _lnb = [];

    /// <summary>
    /// 設定を控える。**LNB 15V と書いた受信機がある筐体だけ、asicend に給電を許可して起動する** (<c>--allow-lnb-power</c>)。
    /// asicend を起動する前 (<see cref="UserlandDaemon.Prepare{T}"/> の前) に呼ぶ
    /// </summary>
    public static void Configure(IEnumerable<TunerSpec> specs) => _lnb =
    [
        .. specs.Where(spec => !spec.Disabled && spec.Lnb == "15v" && spec.Device is not null)
            .Select(spec => Parse(spec.Device!)?.Id).OfType<string>(),
    ];

    /// <summary>設定で LNB 15V と書いた受信機がある筐体か</summary>
    public static bool WantsLnb(string id) => _lnb.Contains(id);

    /// <summary>受信機 1 つを開く</summary>
    public static ITuneDevice Open(string id, int receiver, string? lnb) => new AsicenTuner(
        id, receiver, lnb, RuntimeDir,
        () =>
        {
            var daemon = AsicenDaemon.For(id);
            daemon.Ensure();
            return daemon.Listed;
        });

    /// <summary>
    /// 内蔵カードリーダー。**挙げない。** カードの操作 (CARD_CONNECT・CARD_TRANSMIT など) は形式が契約の文書に無く、
    /// 模擬のデーモンもカードに対応していない (<c>asicenctl card-status</c> が UNSUPPORTED で返る) ので、観察でも形式を起こせなかった。
    /// B-CAS カードは USB のカードリーダーで使う (docs/tuners.md)
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Cards() => [];
}

/// <summary>
/// <c>asicend</c> 1 つ (<see cref="UserlandDaemon"/>)。
///
/// <para>
/// 起動は <c>asicend --device usb:&lt;ポート&gt;[,&lt;ポート&gt;] --firmware &lt;ファイル&gt; [--allow-lnb-power] --runtime-dir … --instance &lt;筐体の名前&gt;</c>
/// (上流 README と <c>asicend --help</c>)。ファームウェア待ちの機材には、asicend が起動するときに流し込む。
/// ready は <c>asicenctl list</c> が通ることで見て、その出力から機種と受信機を読む (<see cref="Listed"/>)。
/// </para>
/// </summary>
/// <param name="select">
/// どの機材を使うかの引数 (<see cref="Arguments"/>)。起動する直前に呼ぶ。駄目なら例外を投げる。テストは模擬のデーモンの引数を返す
/// </param>
/// <param name="program">起動する実行ファイルの名前。テストは模擬 (<c>asicend-mock</c>)</param>
public sealed class AsicenDaemon(string id, string dir, string runtimeDir, Func<string[]> select, string program = "asicend")
    : UserlandDaemon("asicend", id)
{
    public static AsicenDaemon For(string id) => For(id, () => new AsicenDaemon(
        id, AsicenUserland.Dir, AsicenUserland.RuntimeDir,
        () => Hardware(id, AsicenUserland.Firmware, AsicenUserland.WantsLnb(id), () => AsicenUserland.Enclosures(_ => { }))));

    /// <summary>カードリーダーは挙げない (<see cref="AsicenUserland.Cards"/>) ので、どのカードの名前とも合わない</summary>
    public override string CardName => $"asicen-userland {Id} Internal Card Reader";

    /// <summary>動いている asicend に問い合わせた機種と受信機。ready になるまで、問い合わせられなかったときも null</summary>
    public AsicenUserland.Listed? Listed { get; private set; }

    /// <summary>いまの asicend を給電を許可して起動したか</summary>
    private bool _allowsLnb;

    /// <summary>asicend に渡す、機材を選ぶ引数</summary>
    internal static string[] Arguments(IReadOnlyList<string> ports, string firmware, bool allowLnb) =>
        ["--device", $"usb:{string.Join(',', ports)}", "--firmware", firmware, .. allowLnb ? ["--allow-lnb-power"] : Array.Empty<string>()];

    /// <summary>
    /// 本物の機材を使う引数。**ファームウェアが無ければ起動しない** (asicend が <c>--firmware</c> を必須にしている)。
    /// 給電を許可するのは、設定に LNB 15V があり、上流が給電に対応としている機種のときだけ
    /// </summary>
    internal static string[] Hardware(string id, string firmware, bool wantsLnb, Func<IEnumerable<AsicenUserland.Enclosure>> enclosures)
    {
        if (!File.Exists(firmware))
        {
            throw new IOException($"ファームウェアがありません: {firmware} (asicen-userland の配布物に入っていませんでした)");
        }
        var enclosure = enclosures().FirstOrDefault(found => found.Id == id)
            ?? throw new IOException($"ASICEN の筐体 {id} が見つかりません (抜けたか、USB ポートを変えた?)");
        return Arguments(enclosure.Ports, firmware, wantsLnb && AsicenUserland.PowersLnb(enclosure.Model));
    }

    public override void Ensure()
    {
        if (Running)
        {
            // 設定で LNB 15V を足したとき。給電は起動するときにしか許可できないので、起動し直す (この筐体のストリームは 1 度止まる)
            if (_allowsLnb || !AsicenUserland.WantsLnb(Id) || Listed is null || !AsicenUserland.PowersLnb(Listed.Model)) return;
            Write("設定に LNB 15V が足されたので、給電を許可して起動し直します");
            Stop();
        }
        var asicend = AsicenUserland.Bin(dir, program);
        if (!File.Exists(asicend)) throw new IOException($"asicen-userland が入っていません: {asicend}");
        // 機材を並べるのはロックの外で
        var args = select();
        var listed = "";
        // asicend は止まるときに給電を切る。前の給電の要求は消して、次の選局でオンにし直す
        AsicenLnb.Forget(Id);
        Listed = null;
        Receivers = null;
        _allowsLnb = args.Contains("--allow-lnb-power");
        Launch(asicend, [.. args, "--runtime-dir", runtimeDir, "--instance", Id], runtimeDir,
            () =>
            {
                var (code, output) = Control("list", TimeSpan.FromSeconds(5));
                listed = output;
                return code == 0;
            },
            () =>
            {
                Listed = AsicenUserland.ParseList(listed, Write);
                if (Listed is null)
                {
                    Write($"機種と受信機を問い合わせられません (asicenctl list: {listed})");
                    return;
                }
                Receivers = Listed.Receivers;
                Write($"{Listed.Model} 受信機 {Listed.Receivers.Count} つ: "
                    + string.Join(", ", Listed.Receivers.Select(receiver => $"#{receiver.Index} {string.Join("/", receiver.Types)}")));
            },
            hint: Hint);
    }

    /// <summary>asicend の終了コード (external-contract §3.7) に、どうすればいいかを添える</summary>
    private static string Hint(int code) => code switch
    {
        2 => "。引数かランタイムルートが合いません",
        3 => "。筐体が見つからないか開けません (抜けたか、別のプロセスが使っている?)",
        4 => "。同じ筐体の asicend がほかに動いています",
        7 => "。USB の読み書きに失敗しました (抜けた?)",
        10 => "。ファームウェアを受け付けません",
        _ => "",
    };

    /// <summary><c>asicenctl</c>。筐体はソケットの置き場の名前 (<c>--instance</c>) で呼ぶ (serial が無い)</summary>
    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        AsicenUserland.Bin(dir, "asicenctl"), ["--runtime-dir", runtimeDir, "--instance", Id, command], timeout);
}
