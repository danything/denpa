using System.Diagnostics;
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
///
/// <para>
/// **Android (アプリから USB を受け取るとき。<see cref="BrokerUsbHost"/>) は、機材を開くのも並べるのもアプリ。** asicend は libusb で機材を
/// 並べられないので、<c>--list-json</c> の代わりに受け取った機材の VID・PID から筐体を組み (<see cref="Group"/>)、
/// 受け取った fd を継がせて <c>asicend --fd</c> で起動する (<see cref="BrokerUsbHost.Lend"/>)。実行ファイルは APK の
/// <c>libasicend.so</c>・<c>libasicenctl.so</c> (<see cref="Bin"/>)。
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

    /// <summary>
    /// 実行ファイルの場所。配布アーカイブは直下。<c>bin/</c> の下にあればそちら。Android のアプリは <c>lib&lt;名前&gt;.so</c> の名前で
    /// nativeLibraryDir に置く (APK の jniLibs に入れたものしか実行できない)
    /// </summary>
    public static string Bin(string dir, string name)
    {
        foreach (var path in (string[])[Path.Combine(dir, "bin", name), Path.Combine(dir, $"lib{name}.so")])
        {
            if (File.Exists(path)) return path;
        }
        return Path.Combine(dir, name);
    }

    /// <summary>配布物が入っているか。**入っていなければ機材を挙げない**</summary>
    public static bool Installed =>
        OperatingSystem.IsLinux() && File.Exists(Bin(Dir, "asicend")) && File.Exists(Bin(Dir, "asicenctl"));

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    /// <summary><c>asicen:1-2:1</c> を割る。形式が違えば null</summary>
    public static (string Id, int Receiver)? Parse(string device)
    {
        if (!device.StartsWith(Scheme, StringComparison.Ordinal)) return null;
        var parts = device[Scheme.Length..].Split(':');
        if (parts.Length != 2 || !ValidId(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

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
    internal static AsicenReceiver? Receiver(int number, IEnumerable<string> systems, Action<string> warn)
    {
        var names = systems.SelectMany(system => system.Split(',', '/')).Select(name => name.Trim()).Where(name => name.Length > 0).ToList();
        if (names.Count == 0 || names.Any(name => name is not ("ISDB-T" or "ISDB-S")))
        {
            warn($"受信機 {number} の方式 {string.Join(",", names)} には対応していません (asicen-userland が新しい?)。この受信機は使いません");
            return null;
        }
        return new AsicenReceiver(number, names.Contains("ISDB-T"), names.Contains("ISDB-S"));
    }

    /// <summary><c>key=value</c> を空白で並べた 1 行を割る (<c>asicenctl list</c> の受信機の行)。同じキーが 2 度あれば最初のもの</summary>
    internal static Dictionary<string, string> Fields(string line) => line
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .Select(field => field.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .GroupBy(pair => pair[0], StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.First()[1], StringComparer.Ordinal);

    /// <summary>筐体 1 台。<see cref="Ports"/> は USB 機能のポート (asicend の <c>--device usb:</c> に渡す)</summary>
    public sealed record Enclosure(string Id, string Model, IReadOnlyList<string> Ports, IReadOnlyList<AsicenReceiver> Receivers);

    /// <summary>動いている asicend に問い合わせた機種と受信機 (<c>asicenctl list</c>)</summary>
    public sealed record Listed(string Model, IReadOnlyList<AsicenReceiver> Receivers);

    /// <summary>
    /// 筐体の名前。USB 機能が 2 つなら同じ内蔵ハブの <c>.1</c> と <c>.2</c> のはずで、そのハブのポート。1 つならそのポート。
    /// どちらでもなければ null
    /// </summary>
    internal static string? IdOf(IReadOnlyList<string> ports)
    {
        if (ports.Count == 1) return ValidId(ports[0]) ? ports[0] : null;
        if (ports.Count != 2) return null;
        var parents = ports.Select(HubOf).Distinct().ToList();
        return parents is [{ } parent] && ValidId(parent) ? parent : null;
    }

    /// <summary>内蔵ハブのポート (<c>1-2.1</c> → <c>1-2</c>)。ハブの下に無ければ null</summary>
    private static string? HubOf(string port) => port.LastIndexOf('.') is var dot and > 0 ? port[..dot] : null;

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
                ? listed.Select(receiver => receiver.Number is { } number ? Receiver(number, receiver.Systems, warn) : null)
                : model.Systems.Select((systems, index) => Receiver(index, [systems], warn));
            found.Add(new Enclosure(id, model.Name, ports, [.. receivers.OfType<AsicenReceiver>().OrderBy(receiver => receiver.Index)]));
        }

        foreach (var device in (root["ungrouped_usb_devices"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var usb = Text(device, "usb");
            // ファームウェア待ちの機材は Boot が扱い、理由もそちらが残す
            if (usb is not null && Loaders.Contains(usb)) continue;
            warn($"ASICEN の機材 {Text(device, "model") ?? usb} (USB {Text(device, "port")}) を使えません: {Text(device, "status")}"
                + (Text(device, "status") == "open_failed" ? " (/dev/bus/usb を開く権限が無いか、ほかのソフトが使っています)" : ""));
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
        var receivers = new List<AsicenReceiver>();
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            // 機種の名前は空白を含む (PX-W3U3 V2) ので、行の残りを全部取る
            if (line.StartsWith("model=", StringComparison.Ordinal))
            {
                model = line["model=".Length..];
                continue;
            }
            var fields = Fields(line);
            if (!fields.TryGetValue("receiver", out var index) || !fields.TryGetValue("system", out var system)) continue;
            if (int.TryParse(index, out var number) && model is not null && Receiver(number, [system], warn) is { } receiver) receivers.Add(receiver);
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
        if (UsbHost.Current is BrokerUsbHost broker) return Group(Scan(broker), warn);
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

    /// <summary>USB 機能 1 つ (USB のデバイス 1 つ)</summary>
    public sealed record Function(string Usb, string Port, bool Loader)
    {
        /// <summary>内蔵ハブのポート (<c>1-2.1</c> → <c>1-2</c>)。ハブの下に無ければ null</summary>
        public string? Parent => HubOf(Port);

        /// <summary>内蔵ハブのどのポートか (<c>1-2.1</c> → 1)</summary>
        public int Slot => Port.LastIndexOf('.') is var dot and > 0 && int.TryParse(Port[(dot + 1)..], out var slot) ? slot : 0;
    }

    /// <summary>
    /// 探す USB の ID。5 機種 (<see cref="Models"/>) と、ファームウェア待ち (<c>1738:5211</c> / <c>1738:5216</c>)。
    /// Android のアプリの device_filter.xml にも同じものを並べる (AndroidDeviceFilterTests)
    /// </summary>
    internal static IReadOnlyList<UsbId> UsbIds => [.. Loaders.Concat(Models.Select(model => model.Usb)).Select(UsbId.Parse).Distinct()];

    /// <summary>
    /// ASICEN の USB 機能を探す (<see cref="UsbIds"/>)。Linux はファームウェア待ちの機材を見つけるためだけに使い (<see cref="Boot"/>)、
    /// Android は筐体もここから組む (<see cref="Group"/>)。ID の読めないデバイスは飛ばす。
    /// カーネルのドライバが使っているものも並べる (流し込むかは asicend が決める)
    /// </summary>
    public static List<Function> Scan(IUsbHost host)
    {
        var found = new List<Function>();
        foreach (var item in host.List(UsbIds))
        {
            var usb = $"{item.Vendor:x4}:{item.Product:x4}";
            found.Add(new Function(usb, item.Port, Loaders.Contains(usb)));
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

    /// <summary>
    /// 動いている USB 機能を筐体にまとめる (Android。<c>asicend --list-json</c> の代わり)。**USB 機能が 2 つの機種は、同じ内蔵ハブの
    /// <c>.1</c> と <c>.2</c> に同じ ID の機能が揃ったときだけ 1 つの筐体にする。** 受信機は機種の表 (<see cref="Models"/>) のもので、
    /// asicend が起動したあとは <c>asicenctl list</c> のものに替わる。
    /// ポートの名前を作れないカーネル (5.3 より前。名前が <c>001-004</c>) では内蔵ハブが分からず、USB 機能が 2 つの機種は使えない
    /// </summary>
    internal static List<Enclosure> Group(IReadOnlyList<Function> functions, Action<string> warn)
    {
        var found = new List<Enclosure>();
        foreach (var group in functions.Where(function => !function.Loader).GroupBy(function => function.Usb))
        {
            var model = Models.First(known => known.Usb == group.Key);
            if (model.Functions == 1)
            {
                foreach (var function in group)
                {
                    found.Add(new Enclosure(function.Port, model.Name, [function.Port], Receivers(model, warn)));
                }
                continue;
            }
            foreach (var hub in group.GroupBy(function => function.Parent))
            {
                var ports = hub.OrderBy(function => function.Slot).Select(function => function.Port).ToList();
                if (hub.Key is not null && hub.Select(function => function.Slot).Order().SequenceEqual([1, 2]) && IdOf(ports) is { } id)
                {
                    found.Add(new Enclosure(id, model.Name, ports, Receivers(model, warn)));
                    continue;
                }
                warn($"{model.Name} (USB {string.Join(" / ", ports)}) は使えません (USB 機能が {model.Functions} つ揃っていないか、"
                    + "内蔵ハブのポートが読めません。ポートの名前を作れないカーネルでは、USB 機能が 2 つの機種は使えません)");
            }
        }
        return [.. found.OrderBy(enclosure => enclosure.Id, StringComparer.Ordinal)];
    }

    private static List<AsicenReceiver> Receivers(Model model, Action<string> warn) =>
        [.. model.Systems.Select((systems, index) => Receiver(index, [systems], warn)).OfType<AsicenReceiver>()];

    /// <summary>
    /// asicend のソケットのパスが <c>sun_path</c> に収まるか。**収まらなければ起動しない** (asicend が断る前に、理由を記録に出す)。
    /// Android の置き場 (<c>&lt;dataDir&gt;/r/asicen-userland/v1/&lt;筐体&gt;/control.sock</c>) は 80 バイトほど
    /// </summary>
    internal static void CheckSocketPath(string runtimeDir, string id)
    {
        var socket = UdtvControl.Endpoint(runtimeDir, id, "control.sock");
        var length = System.Text.Encoding.UTF8.GetByteCount(socket);
        if (length > MaxSocketPath)
        {
            throw new IOException($"asicend のソケットのパス {socket} が {length} バイトで、上限の {MaxSocketPath} バイトを超えるので起動しません"
                + " (ASICEN_RUNTIME_DIR を短い置き場にしてください)");
        }
    }

    /// <summary>
    /// UNIX ドメインソケットのパスの上限 (Linux の <c>sun_path</c> は終わりの NUL を含めて 108 バイト)。
    /// 超えるパスでは、asicend は起動のときに断る
    /// </summary>
    internal const int MaxSocketPath = 107;

    /// <summary>
    /// asicend のランタイムルートを作る。asicend は下の階層しか作らない決まりで、持ち主だけが使えるもの (0700) を求める
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
    /// asicend を起動する。標準出力と標準エラーは受け取る。
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

    /// <summary>入っている asicend のバージョンを記録に出す (起動したとき。Android では、アプリの子プロセスから起動できるかもここで分かる)</summary>
    public static void LogVersion()
    {
        if (!Installed) return;
        var asicend = Bin(Dir, "asicend");
        var (code, output) = Shell.Run(asicend, ["--version"], TimeSpan.FromSeconds(10));
        Log.Write(code == 0
            ? $"asicen-userland: {output} ({asicend})"
            : $"asicen-userland: {asicend} --version が通りません (exit {code}: {output})。ASICEN の機材は使えません");
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
            var waiting = Waiting(Scan(UsbHost.Current));
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
                if (OperatingSystem.IsLinux() && UsbHost.Current is BrokerUsbHost broker)
                {
                    Load(broker, id, ports, where, warn);
                    continue;
                }
                var loader = new AsicenDaemon(id, Dir, RuntimeDir, () => new(AsicenDaemon.Arguments(ports, Firmware, allowLnb: false)));
                try
                {
                    loader.Ensure();
                    Log.Write($"[asicend {id}] ファームウェアを流し込みました");
                }
                catch (Exception error) when (StartFailure(error))
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

    /// <summary>流し込みを待つ上限。16 KB を送るだけなので数秒で済む</summary>
    private static readonly TimeSpan LoadTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Android のファームウェア待ちの機材に流し込む。**<c>asicend --fd … --firmware …</c> を起動し、終わるまで待つ。**
    /// <c>--fd</c> の asicend は、流し込んだあとにつながり直した機材を追えないので、流し込んだら終わる (上流 README)。
    /// つながり直した機材は別の VID・PID でアプリから届き (<c>attached</c>)、探し直したときに <see cref="AsicenDaemon"/> が起動する。
    /// 終了コードは見ずに、asicend の出力を記録に出す
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("linux")]
    private static void Load(BrokerUsbHost broker, string id, IReadOnlyList<string> ports, string where, Action<string> warn)
    {
        try
        {
            CheckSocketPath(RuntimeDir, id);
            CreateRuntimeDir(RuntimeDir);
            using var process = Start(
                Bin(Dir, "asicend"),
                fds => [.. AsicenDaemon.FdArguments(fds, Firmware, allowLnb: false), "--runtime-dir", RuntimeDir, "--instance", id],
                () => broker.Lend(ports));
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(LoadTimeout))
            {
                Interop.Terminate(process.Id);
                if (!process.WaitForExit(TimeSpan.FromSeconds(10))) process.Kill();
                process.WaitForExit();
                warn($"ASICEN の機材 (USB {where}) への流し込みが {LoadTimeout.TotalSeconds:0} 秒で終わらないので止めました");
                return;
            }
            var output = $"{stdout.GetAwaiter().GetResult()}{stderr.GetAwaiter().GetResult()}".Trim();
            Log.Write($"[asicend {id}] ファームウェアの流し込みで asicend が終了しました (exit {process.ExitCode}: {output})。"
                + "流し込めていれば、機材がつながり直してアプリから届きます");
        }
        catch (Exception error) when (StartFailure(error))
        {
            warn($"ASICEN の機材 (USB {where}) にファームウェアを流し込めません ({error.Message})");
        }
    }

    /// <summary>挿さっている筐体の受信機を、設定に書くのと同じ形式で返す</summary>
    public static List<TunerSpec> Detect()
    {
        try
        {
            return Specs(Enclosures());
        }
        catch (Exception error) when (StartFailure(error))
        {
            // 自動検出のほかの機材 (CECH-ZD1 J・PIX-DT295・IT930x) まで並ばなくならないように、ここで止める
            Log.Write($"ASICEN の機材を探せませんでした ({error.Message})");
            return [];
        }
    }

    /// <summary>
    /// asicend を起動する・ソケットの置き場を作るときの、機材や配布物の側の失敗 (起動できない実行ファイルは <see cref="System.ComponentModel.Win32Exception"/>、
    /// 作れない置き場は <see cref="UnauthorizedAccessException"/>)
    /// </summary>
    private static bool StartFailure(Exception error) =>
        error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception;

    /// <summary>筐体ごとの受信機を設定の形式に (受けられる方式の無い受信機は除く)</summary>
    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                Name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, Device(enclosure.Id, receiver.Index)))),
    ];

    /// <summary>設定に出てくる筐体 (<c>device</c> が <c>asicen:</c> のもの)。asicend を起動する対象</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => Parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);

    private static volatile HashSet<string> _lnb = [];

    /// <summary>
    /// 設定を控える。**LNB 15V と書いた受信機がある筐体だけ、asicend に給電を許可して起動する** (<c>--allow-lnb-power</c>)。
    /// asicend を起動する前 (<see cref="AsicenDaemon.Prepare"/> の前) に呼ぶ
    /// </summary>
    public static void Configure(IEnumerable<TunerSpec> specs) => _lnb =
    [
        .. specs.Where(spec => !spec.Disabled && spec.Lnb == "15v" && spec.Device is not null)
            .Select(spec => Parse(spec.Device!)?.Id).OfType<string>(),
    ];

    /// <summary>設定で LNB 15V と書いた受信機がある筐体か</summary>
    public static bool WantsLnb(string id) => _lnb.Contains(id);

    /// <summary>受信機 1 つを開く</summary>
    public static ITuneDevice Open(string id, int receiver, string? lnb, string? name = null) => new AsicenTuner(
        id, receiver, lnb, RuntimeDir,
        () =>
        {
            var daemon = AsicenDaemon.For(id);
            daemon.Ensure();
            return daemon.Listed;
        },
        name);
}

/// <summary>
/// 受信機 1 つ。**asicend に問い合わせたもの** (<see cref="AsicenUserland.ParseList"/>)。
///
/// <para>
/// 受信機ごとに地上波か衛星かが決まっていて、1 つの受信機で両方を受けられる機種もある。
/// その違いはここに入ってくるだけで、こちらは機種を見ない。
/// </para>
/// </summary>
public sealed record AsicenReceiver(int Index, bool Terrestrial, bool Satellite)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

    /// <summary>
    /// 筐体に問い合わせた受信機と、要求された選局が合っているか。**合わなければ asicend に送る前に断る。**
    /// 受信機を問い合わせられていなければ (<paramref name="receivers"/> が null) 見ずに通す (合わなければ asicend が断る)
    /// </summary>
    public static void Check(IReadOnlyList<AsicenReceiver>? receivers, int index, ChannelTable.Tuning tuning)
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
}

/// <summary>
/// <c>asicend</c> 1 つ。**筐体 1 台につき 1 つ、使う受信機がある間だけ動かす。**
///
/// <para>
/// 起動するのは最初に要ったとき (起動時の <see cref="Prepare"/> か、初めての選局)。
/// ファームウェアを流し込んでから ready になるので、数秒かかる。
/// 終了していたら次に要ったときに起動し直す。受信機を全部使わない設定にしたら止める (<see cref="Prepare"/>)。
/// </para>
///
/// <para>
/// 起動は <c>asicend --device usb:&lt;ポート&gt;[,&lt;ポート&gt;] --firmware &lt;ファイル&gt; [--allow-lnb-power] --runtime-dir … --instance &lt;筐体の名前&gt;</c>
/// (上流 README と <c>asicend --help</c>)。ファームウェア待ちの機材には、asicend が起動するときに流し込む。
/// Android は <c>--device</c> の代わりに <c>--fd &lt;番号&gt;</c> (USB 機能が 2 つなら 2 回。<c>.1</c> が先) で、受け取った fd を継がせる。
/// ready は <c>asicenctl list</c> が通ることで見て、その出力から機種と受信機を読む (<see cref="Listed"/>)。
/// </para>
/// </summary>
/// <param name="select">
/// どの機材を使うかの引数と継がせる fd (<see cref="Hardware"/>)。起動する直前に呼ぶ。使えなければ IOException を送出する。テストは模擬のデーモンの引数を返す
/// </param>
/// <param name="program">起動する実行ファイルの名前。テストは模擬 (<c>asicend-mock</c>)</param>
public sealed class AsicenDaemon(string id, string dir, string runtimeDir, Func<AsicenDaemon.Selection> select, string program = "asicend")
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, AsicenDaemon> All = new(StringComparer.Ordinal);

    /// <summary>ready を待つ上限。ファームウェアの流し込みは数秒で済む</summary>
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(30);

    /// <summary>止めるときに後片付けを待つ上限。過ぎたら Kill</summary>
    private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(10);

    private string Id { get; } = id;
    private readonly Lock _gate = new();
    private Process? _process;
    private volatile string _stderr = "";

    public bool Running
    {
        get
        {
            // 止める側 (Stop) が _gate の中で Dispose するので、読んだあとに破棄されていたら止まったものとする
            var process = _process;
            try
            {
                return process is { HasExited: false };
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// asicend に渡す、機材を選ぶ引数。<paramref name="Lend"/> があれば (Android)、起動する直前にそれで fd の複製を作って継がせ、
    /// その番号を <c>--fd</c> にして <paramref name="Args"/> の前に足す (<see cref="FdOptions"/>)
    /// </summary>
    public sealed record Selection(string[] Args, Func<InheritedFds>? Lend = null);

    public static AsicenDaemon For(string id) => For(id, () => new AsicenDaemon(
        id, AsicenUserland.Dir, AsicenUserland.RuntimeDir,
        () => Hardware(
            id, AsicenUserland.Firmware, AsicenUserland.WantsLnb(id), () => AsicenUserland.Enclosures(_ => { }),
            OperatingSystem.IsLinux() && UsbHost.Current is BrokerUsbHost broker ? broker.Lend : null)));

    /// <summary>筐体の asicend。まだ無ければ <paramref name="create"/> で作って控える (テストは模擬の実行ファイルを渡す)</summary>
    internal static AsicenDaemon For(string id, Func<AsicenDaemon> create)
    {
        lock (Registry)
        {
            if (!All.TryGetValue(id, out var daemon))
            {
                daemon = create();
                All[id] = daemon;
            }
            return daemon;
        }
    }

    /// <summary>
    /// 挙げた筐体ぶん起動して ready まで待ち、**挙げなかった筐体の asicend は止める。**
    /// 起動時と、チューナーの設定を書き換えたときと、機材を挿したとき。
    ///
    /// <para>
    /// **起動できなくても止まらない。** 筐体が抜けている・ファームウェアが無い、は
    /// その筐体だけの話で、他のチューナー (PT3 など) は変わらず使える。
    /// 理由は記録に残し、選局のときにもう一度試す。
    /// </para>
    ///
    /// <para>
    /// **受信機を全部使わない設定にした筐体は、asicend を止めて USB を手放す。** 動いたままだと、ほかのソフトに
    /// 機材を渡せない (docs/switch.md「並べて動かすとき」)。使う設定に戻せば、ここか次の選局で起動し直す。
    /// 起動したときに使う受信機の無い筐体を起動しないのと同じ
    /// </para>
    /// </summary>
    public static void Prepare(IReadOnlyCollection<string> ids, Func<string, AsicenDaemon> daemon)
    {
        List<AsicenDaemon> unused;
        lock (Registry) unused = [.. All.Values.Where(target => target.Running && !ids.Contains(target.Id))];
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

    public static void StopAll()
    {
        List<AsicenDaemon> daemons;
        lock (Registry) daemons = [.. All.Values];
        foreach (var daemon in daemons) daemon.Stop();
    }

    private void Write(string message) => Log.Write($"[asicend {Id}] {message}");

    /// <summary>動いている asicend に問い合わせた機種と受信機。ready になるまで、問い合わせられなかったときも null</summary>
    public AsicenUserland.Listed? Listed { get; private set; }

    /// <summary>いまの asicend を給電を許可して起動したか</summary>
    private bool _allowsLnb;

    /// <summary>asicend に渡す、機材を選ぶ引数</summary>
    internal static string[] Arguments(IReadOnlyList<string> ports, string firmware, bool allowLnb) =>
        ["--device", $"usb:{string.Join(',', ports)}", "--firmware", firmware, .. allowLnb ? ["--allow-lnb-power"] : Array.Empty<string>()];

    /// <summary>
    /// 継がせた fd で機材を選ぶ引数 (Android)。<c>--fd</c> は 2 つまでで、先が USB 機能の <c>.1</c>。
    /// **ファームウェアは動いている機材にも渡す** (<c>--firmware</c> は必須。動いている機材には流し込まない。上流 README)
    /// </summary>
    internal static string[] FdArguments(IReadOnlyList<int> fds, string firmware, bool allowLnb) =>
        [.. FdOptions(fds), "--firmware", firmware, .. allowLnb ? ["--allow-lnb-power"] : Array.Empty<string>()];

    /// <summary>継がせた fd の <c>--fd &lt;番号&gt;</c> を並べたもの (無ければ空)</summary>
    internal static string[] FdOptions(IReadOnlyList<int> fds) =>
        [.. fds.SelectMany(fd => (string[])["--fd", fd.ToString(System.Globalization.CultureInfo.InvariantCulture)])];

    /// <summary>
    /// 本物の機材を使う引数。**ファームウェアが無ければ起動しない** (asicend が <c>--firmware</c> を必須にしている)。
    /// 給電を許可するのは、設定に LNB 15V があり、上流が給電に対応としている機種のときだけ。
    /// <paramref name="lend"/> があれば (Android)、筐体の USB 機能の fd を継がせる (複製を作るのは起動する直前。<see cref="AsicenUserland.Start"/>)
    /// </summary>
    internal static Selection Hardware(
        string id, string firmware, bool wantsLnb, Func<IEnumerable<AsicenUserland.Enclosure>> enclosures,
        Func<IReadOnlyList<string>, InheritedFds>? lend = null)
    {
        if (!File.Exists(firmware))
        {
            throw new IOException($"ファームウェアがありません: {firmware} (asicen-userland の配布物に入っていませんでした)");
        }
        var enclosure = enclosures().FirstOrDefault(found => found.Id == id)
            ?? throw new IOException($"ASICEN の筐体 {id} が見つかりません (抜けたか、USB ポートを変えた?)");
        var allowLnb = wantsLnb && AsicenUserland.PowersLnb(enclosure.Model);
        if (lend is null) return new Selection(Arguments(enclosure.Ports, firmware, allowLnb));
        return new Selection(FdArguments([], firmware, allowLnb), () => lend(enclosure.Ports));
    }

    /// <summary>
    /// 動いていなければ起動して ready まで待つ。駄目なら理由を添えて例外を送出する。
    /// ランタイムルートはここで作る (<see cref="AsicenUserland.CreateRuntimeDir"/>)
    /// </summary>
    public void Ensure()
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
        AsicenUserland.CheckSocketPath(runtimeDir, Id);
        // 機材を並べるのはロックの外で
        var (args, lend) = select();
        lock (_gate)
        {
            // 待つ間にほかの受信機の選局が起動していれば、その asicend と問い合わせた受信機をそのまま使う
            if (Running) return;
            _process?.Dispose();
            _process = null;
            // asicend は止まるときに給電を切る。前の給電の要求は消して、次の選局でオンにし直す
            AsicenLnb.Forget(Id);
            Listed = null;
            _allowsLnb = args.Contains("--allow-lnb-power");

            AsicenUserland.CreateRuntimeDir(runtimeDir);
            var process = AsicenUserland.Start(
                asicend, fds => [.. FdOptions(fds), .. args, "--runtime-dir", runtimeDir, "--instance", Id], lend);
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
                    throw new IOException($"asicend が終了しました (exit {process.ExitCode}: {_stderr}){Hint(process.ExitCode)}");
                }
                var (code, listed) = Control("list", TimeSpan.FromSeconds(5));
                if (code == 0)
                {
                    Write("ready");
                    Read(listed);
                    return;
                }
                Thread.Sleep(500);
            }

            Stop();
            throw new IOException($"asicend が {ReadyTimeout.TotalSeconds} 秒以内に ready になりません ({_stderr})");
        }
    }

    /// <summary>ready になった asicend の <c>asicenctl list</c> の出力から、機種と受信機を控える</summary>
    private void Read(string listed)
    {
        Listed = AsicenUserland.ParseList(listed, Write);
        if (Listed is null)
        {
            Write($"機種と受信機を問い合わせられません (asicenctl list: {listed})");
            return;
        }
        Write($"{Listed.Model} 受信機 {Listed.Receivers.Count} つ: "
            + string.Join(", ", Listed.Receivers.Select(receiver => $"#{receiver.Index} {string.Join("/", receiver.Types)}")));
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

    /// <summary>asicend の終了コード (external-contract §3.7) に、どうすればいいかを添える</summary>
    private static string Hint(int code) => code switch
    {
        2 => "。引数かランタイムルートが合いません",
        3 => "。筐体が見つからないか開けません (抜けたか、ほかのソフトが使っている?)",
        4 => "。同じ筐体の asicend がほかに動いています",
        7 => "。USB の読み書きに失敗しました (抜けた?)",
        10 => "。ファームウェアを受け付けません",
        _ => "",
    };

    /// <summary><c>asicenctl</c>。筐体はソケットの置き場の名前 (<c>--instance</c>) で呼ぶ (serial が無い)</summary>
    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        AsicenUserland.Bin(dir, "asicenctl"), ["--runtime-dir", runtimeDir, "--instance", Id, command], timeout);
}
