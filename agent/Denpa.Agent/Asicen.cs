using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/asicen-userland">asicen-userland</a> に任せる機材
/// (PLEX PX-W3U3 など。ASICEN 系)。**試験的。上流の v1.0.0-beta (プレリリース) に合わせた実装で、実機では確かめていない。**
///
/// <para>
/// **asicen-userland を組み込んだ子プロセス (denpa-asicen。GPL-2.0-only) に機材を任せる** (<see cref="AsicenChild"/>)。子プロセスが無ければ何もしない
/// (<see cref="Installed"/>)。機材は <c>asicend --list-json</c> と同じ JSON で見つけ (<see cref="Enclosures"/>)、
/// 筐体ごとに 1 度開いて (<see cref="AsicenEnclosure"/>)、受信機ごとに選局する (<see cref="AsicenTuner"/>)。作りは docs/agent.md「asicen-userland の作り」。
/// </para>
///
/// <para>
/// **USB の serial が無いので、ポートで見分ける。** USB 機能が 2 つの機種 (PX-W3U2・PX-W3U3・PX-W3U3 V2) は内蔵ハブの
/// <c>.1</c> と <c>.2</c> に 1 つずつ現れるので、筐体の名前は内蔵ハブのポート (<c>1-2</c>) にする。USB 機能が 1 つの機種
/// (PX-S3U・PX-S3U2) は、その機能のポートを名前にする。**ポートを変えると別のチューナーになる。**
/// 設定の <c>device</c> は <c>asicen:&lt;ポート&gt;:&lt;受信機&gt;</c> (<c>asicen:1-2:1</c>)。
/// </para>
///
/// <para>
/// **Android (アプリから USB を受け取るとき。<see cref="BrokerUsbHost"/>) は、機材を開くのも並べるのもアプリ。** 子プロセスは libusb で機材を
/// 並べられないので、受け取った機材の VID・PID から筐体を組み (<see cref="Group"/>)、受け取った fd を子プロセスに継がせて開く (<see cref="BrokerUsbHost.Lend"/>)。
/// </para>
/// </summary>
public static class AsicenUserland
{
    /// <summary>設定の <c>device</c> の接頭辞</summary>
    public const string Scheme = "asicen:";

    /// <summary>
    /// 子プロセスとファームウェアの置き場。<c>ASICEN_USERLAND_DIR</c> があればそれ (Android はアプリの nativeLibraryDir)。
    /// 無ければ Linux は <c>/opt/asicen-userland</c> (agent/Dockerfile)、Windows と macOS はエージェントの実行ファイルの隣の <c>asicen/</c>
    /// </summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR")
        ?? (OperatingSystem.IsLinux() ? "/opt/asicen-userland" : Path.Combine(AppContext.BaseDirectory, "asicen"));

    /// <summary>ファームウェアのファイルの名前</summary>
    public const string FirmwareName = "asicen-loader.bin";

    /// <summary>
    /// 確かめたファームウェアの SHA-256 (上流 v1.0.0-beta の配布物のもの。agent/asicen/build.sh の ASICEN_FIRMWARE_SHA256 と同じ)。
    /// **中身は読まずに、無改変のものかだけを確かめる**
    /// </summary>
    internal const string FirmwareSha256 = "5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a";

    /// <summary>
    /// ASICEN のファームウェア。挿した直後の機材は「ファームウェア待ち」で現れ、開くときに子プロセスが流し込む
    /// (asicend と同じく、ファームウェアのファイルは必須)。
    ///
    /// <para>
    /// <c>ASICEN_FIRMWARE</c> があればそれ (Android はアプリが書き出したもの)。無ければ tuners.json の隣の <c>firmware/</c> に利用者が置いたもの、
    /// 次に <see cref="Dir"/> の <c>firmware/</c> (Linux のイメージに同梱したもの) の順に探す。
    /// **Windows と macOS の配布物には同梱しない** (再配布の許諾を確かめている途中。docs/licenses.md「ASICEN のファームウェア」)。
    /// 無ければ置き場として tuners.json の隣の <c>firmware/</c> を返す (<see cref="FirmwareProblem"/> が理由を出す)
    /// </para>
    /// </summary>
    public static string Firmware
    {
        get
        {
            if (Environment.GetEnvironmentVariable("ASICEN_FIRMWARE") is { Length: > 0 } given) return given;
            string[] places = [Path.Combine(Config.FromEnvironment().Dir, "firmware", FirmwareName), Path.Combine(Dir, "firmware", FirmwareName)];
            return places.FirstOrDefault(File.Exists) ?? places[0];
        }
    }

    /// <summary>ファームウェアが使えない理由 (無い・中身が違う)。使えれば null</summary>
    /// <param name="sha256">確かめる SHA-256 (テストは置いたファイルのものを渡す)</param>
    internal static string? FirmwareProblem(string path, string sha256 = FirmwareSha256)
    {
        if (!File.Exists(path))
        {
            return $"ファームウェアがありません: {path} (Windows と macOS では利用者が置きます。docs/tuners.md「PX-W3U3 など」)";
        }
        var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
        return sha == sha256 ? null : $"{path} は確かめたファームウェアと違います (SHA-256 {sha})";
    }

    /// <summary>子プロセスを使えるか。**使えなければ機材を挙げない**</summary>
    public static bool Installed => AsicenChild.Available;

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

    /// <summary>ポート (<c>1-2</c>、<c>3-1.4</c>)。筐体の名前もこの形式</summary>
    internal static bool ValidId(string id) => id.Length <= 64 && UsbSysfs.IsPort(id);

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string id, int receiver) => $"{model} {id} #{receiver}";

    /// <summary>
    /// 上流が見分ける機種 (上流 README の表と <c>asicend --models</c>)。受信機の並びは README と上流の LIST の応答。
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

    /// <summary>筐体 1 台。<see cref="Ports"/> は USB 機能のポート (子プロセスの <c>--device usb:</c> に渡す)</summary>
    public sealed record Enclosure(string Id, string Model, IReadOnlyList<string> Ports, IReadOnlyList<AsicenReceiver> Receivers);

    /// <summary>開いた筐体の機種と受信機 (子プロセスが知らせたもの)。<paramref name="Lnb"/> は LNB の給電を操作できるか</summary>
    public sealed record Listed(string Model, IReadOnlyList<AsicenReceiver> Receivers, bool Lnb);

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
    /// 子プロセスの <c>--list-json</c> (<c>asicend --list-json</c> と同じ。dtv-userland-core の docs/json-discovery.md の
    /// <c>userland.discovery</c> 1.0) を読む。**使うのは <c>status=ready</c> で、機種が <see cref="Models"/> にあり、USB 機能の数が合う筐体だけ。**
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
        if (Text(schema, "name") != "userland.discovery" || Number(schema, "major") != 1 || product != "asicen" || version != AsicenChild.Version)
        {
            warn($"ASICEN の機材の一覧が {product} {version} ({Text(schema, "name")} {Number(schema, "major")}) です。"
                + $"対応を確かめたのは asicen {AsicenChild.Version} (userland.discovery 1) だけなので、ASICEN の機材は使いません");
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
                warn($"{model.Name} ({where}) は使えません (状態: {status})");
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
    /// 挿さっている筐体 (ファームウェア待ちのものには先に流し込む)。子プロセスが無ければ空。
    /// Android はアプリから受け取った機材から、ほかは子プロセスの <c>--list-json</c> から組む (USB のポートの名前は libusb のもの。
    /// Windows と macOS でもエージェントの USB の扱いとは混ぜない)
    /// </summary>
    public static List<Enclosure> Enclosures(Action<string>? warn = null)
    {
        warn ??= Log.Write;
        if (!Installed) return [];
        if (UsbHost.Current is BrokerUsbHost broker)
        {
            Boot(Scan(broker), warn);
            return Group(Scan(broker), warn);
        }
        try
        {
            var json = AsicenChild.ListJson();
            if (Boot(FunctionsIn(json), warn)) json = AsicenChild.ListJson();
            return ParseDiscovery(json, warn);
        }
        catch (IOException error)
        {
            warn(error.Message);
            return [];
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            warn($"ASICEN の機材の一覧が読めません ({error.Message})");
            return [];
        }
    }

    /// <summary>一覧の JSON に出てくる USB 機能 (筐体にまとまったものと、まとまらなかったもの)。ファームウェア待ちを見つけるのに使う</summary>
    internal static List<Function> FunctionsIn(string json)
    {
        var line = json.Split('\n').Select(raw => raw.Trim()).FirstOrDefault(raw => raw.StartsWith('{'))
            ?? throw new FormatException("JSON の文書がありません");
        var root = JsonNode.Parse(line) as JsonObject ?? throw new FormatException("JSON の文書が object ではありません");
        var devices = (root["enclosures"] as JsonArray ?? []).OfType<JsonObject>()
            .SelectMany(enclosure => (enclosure["devices"] as JsonArray ?? []).OfType<JsonObject>())
            .Concat((root["ungrouped_usb_devices"] as JsonArray ?? []).OfType<JsonObject>());
        return [.. devices
            .Select(device => (Usb: Text(device, "usb"), Port: Text(device, "port")))
            .Where(device => device.Usb is not null && device.Port is not null)
            .Select(device => new Function(device.Usb!, device.Port!, Loaders.Contains(device.Usb)))];
    }

    /// <summary>ファームウェア待ちの USB ID (上流の HARDWARE-VALIDATION.md)</summary>
    internal static readonly string[] Loaders = ["1738:5211", "1738:5216"];

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
    /// ASICEN の USB 機能を探す (<see cref="UsbIds"/>)。Android (アプリから受け取った機材) だけで使い、ファームウェア待ちの機材も
    /// 筐体もここから組む (<see cref="Boot"/>・<see cref="Group"/>)。カーネルのドライバが使っているものも並べる (流し込むかは子プロセスが決める)
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
    /// ファームウェア待ちの USB 機能を、子プロセスに渡す組にまとめる。**同じハブの <c>.1</c> と <c>.2</c> に ASICEN の USB 機能が
    /// 2 つあれば 1 つの筐体とみなして両方を、そうでなければその機能だけを渡す。** ファームウェア待ちの間は機種が分からないので、
    /// 外付けのハブの <c>.1</c> と <c>.2</c> に USB 機能が 1 つの機種を 2 台挿したときは見分けられない (子プロセスが断り、理由が記録に残る)
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
    /// 動いている USB 機能を筐体にまとめる (Android。一覧の JSON の代わり)。**USB 機能が 2 つの機種は、同じ内蔵ハブの
    /// <c>.1</c> と <c>.2</c> に同じ ID の機能が揃ったときだけ 1 つの筐体にする。** 受信機は機種の表 (<see cref="Models"/>) のもので、
    /// 開いたあとは子プロセスが知らせたものに替わる。
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

    /// <summary>起動したときに、子プロセスを使えるかを記録に出す。Android では、アプリの子プロセスから起動できるかもここで分かる</summary>
    public static void LogVersion() => Log.Write(Installed
        ? $"asicen-userland: {AsicenChild.Version} の子プロセスを使います ({AsicenChild.Program})"
        : $"asicen-userland: 使いません ({AsicenChild.Problem})");

    private static readonly Lock BootGate = new();

    /// <summary>流し込みを試した筐体。**同じ筐体に 2 度は試さない** (ファームウェア待ちでなくなったら、ここから消す)</summary>
    private static readonly HashSet<string> Booted = new(StringComparer.Ordinal);

    /// <summary>
    /// ファームウェア待ちの機材に流し込む。**子プロセスで 1 度開いて閉じる** (流し込むのは子プロセス。開くときに流し込み、つながり直すのを待つ)。
    ///
    /// <para>
    /// 設定に書いてある筐体は、開くときに流し込まれる。ここで扱うのは、まだ設定に無い機材を自動検出で挙げるとき。
    /// ファームウェア待ちの間は機種も受信機も分からないので、流し込んでから一覧を取る。
    /// **ファームウェアが無ければ流さずに「ファームウェアがありません」と残す。** すでに開いている筐体は飛ばす。
    /// Android は流し込んだあとの機材を追えないので、流し込んだら閉じる。つながり直した機材は別の VID・PID でアプリから届く
    /// 流し込んだ筐体があれば true (一覧を取り直す)
    /// </para>
    /// </summary>
    internal static bool Boot(IReadOnlyList<Function> functions, Action<string> warn)
    {
        var loaded = false;
        lock (BootGate)
        {
            var waiting = Waiting(functions);
            Booted.IntersectWith(waiting.Select(enclosure => enclosure.Id));
            foreach (var (id, ports) in waiting)
            {
                if (AsicenEnclosure.For(id).Opened || !Booted.Add(id)) continue;
                var where = string.Join(" / ", ports);
                if (FirmwareProblem(Firmware) is { } problem)
                {
                    warn($"{problem}。ファームウェア待ちの ASICEN の機材 (USB {where}) は使えません");
                    continue;
                }
                var loader = new AsicenEnclosure(id, () => AsicenEnclosure.Hardware(ports, Firmware, allowLnb: false, Lend()));
                try
                {
                    loader.Open();
                    Log.Write($"[asicen {id}] ファームウェアを流し込みました");
                    loaded = true;
                }
                catch (AsicenLoaded)
                {
                    Log.Write($"[asicen {id}] ファームウェアを流し込みました。つながり直した機材はアプリから届きます");
                }
                catch (IOException error)
                {
                    warn($"ASICEN の機材 (USB {where}) にファームウェアを流し込めません ({error.Message})");
                }
                finally
                {
                    loader.Close();
                }
            }
        }
        return loaded;
    }

    /// <summary>Android ならアプリから受け取った fd を子プロセスに継がせる手段</summary>
    internal static Func<IReadOnlyList<string>, InheritedFds>? Lend() =>
        OperatingSystem.IsLinux() && UsbHost.Current is BrokerUsbHost broker ? broker.Lend : null;

    /// <summary>挿さっている筐体の受信機を、設定に書くのと同じ形式で返す</summary>
    public static List<TunerSpec> Detect()
    {
        try
        {
            return Specs(Enclosures());
        }
        catch (IOException error)
        {
            // 自動検出のほかの機材 (CECH-ZD1 J・PIX-DT295・IT930x) まで並ばなくならないように、ここで止める
            Log.Write($"ASICEN の機材を探せませんでした ({error.Message})");
            return [];
        }
    }

    /// <summary>筐体ごとの受信機を設定の形式に (受けられる方式の無い受信機は除く)</summary>
    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                Name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, Device(enclosure.Id, receiver.Index)))),
    ];

    /// <summary>設定に出てくる筐体 (<c>device</c> が <c>asicen:</c> のもの)。開く対象</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => Parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);

    /// <summary>受信機 1 つを開く</summary>
    public static ITuneDevice Open(string id, int receiver, string? lnb, string? name = null) =>
        new AsicenTuner(AsicenEnclosure.For(id), receiver, lnb, name);
}

/// <summary>
/// 受信機 1 つ。**子プロセスが知らせたもの** (<see cref="AsicenEnclosure.Listed"/>)。
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
    /// 筐体に問い合わせた受信機と、要求された選局が合っているか。**合わなければ子プロセスに渡す前に断る**
    /// </summary>
    public static void Check(IReadOnlyList<AsicenReceiver> receivers, int index, ChannelTable.Tuning tuning)
    {
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

/// 子プロセスで開いた筐体 1 台。**筐体 1 台につき子プロセスを 1 つ起動し、使う受信機がある間だけ開いておく。**
///
/// <para>
/// 開くのは最初に要ったとき (起動時の <see cref="Prepare"/> か、初めての選局)。ファームウェア待ちなら流し込んでから開くので、数秒かかる。
/// 受信機を全部使わない設定にしたら閉じて USB を手放す (<see cref="Prepare"/>)。機材が抜けた・USB の読み書きに失敗した印
/// (<see cref="MarkLost"/>) があるか、子プロセスが終わっていれば (落ちた)、次に要ったときに閉じて起動し直す。
/// </para>
///
/// <para>
/// 開くときの引数は asicend と同じ: <c>--device usb:&lt;ポート&gt;[,&lt;ポート&gt;] --firmware &lt;ファイル&gt; [--allow-lnb-power]</c>。
/// Android は <c>--device</c> の代わりに <c>--fd &lt;番号&gt;</c> (USB 機能が 2 つなら 2 回。<c>.1</c> が先) で、受け取った fd を子プロセスに継がせる。
/// </para>
/// </summary>
/// <param name="select">開く直前に呼ぶ。どの機材を開くかの引数 (<see cref="Hardware(string, string, Func{IEnumerable{AsicenUserland.Enclosure}}, Func{IReadOnlyList{string}, InheritedFds}, string)"/>)。使えなければ IOException を送出する</param>
/// <param name="open">子プロセスで開く (<see cref="AsicenChild.Open"/>)。テストは偽の機材を開く</param>
public sealed class AsicenEnclosure(string id, Func<AsicenEnclosure.Selection> select, Func<IReadOnlyList<string>, AsicenChild?>? open = null)
{
    private static readonly Lock Registry = new();
    private static readonly Dictionary<string, AsicenEnclosure> All = new(StringComparer.Ordinal);

    public string Id { get; } = id;

    /// <summary>開く・閉じる・使っている数を守る (<see cref="Monitor"/> で待つので object)</summary>
    private readonly object _gate = new();
    private AsicenChild? _child;
    private int _users;
    private volatile bool _lost;

    /// <summary>
    /// 子プロセスに渡す、機材を選ぶ引数。<paramref name="Lend"/> があれば (Android)、起動する直前にそれで fd の複製を作り、
    /// その番号を <c>--fd</c> にして <paramref name="Args"/> の前に足す。<paramref name="AllowLnb"/> は給電を許可して開くか
    /// </summary>
    public sealed record Selection(string[] Args, Func<InheritedFds>? Lend = null, bool AllowLnb = false);

    /// <summary>開いているか (子プロセスが動いているか)。**ロックを取らない** (開いている途中の筐体のロックを、ほかの筐体を開く Boot が待たないように)</summary>
    public bool Opened => Volatile.Read(ref _child) is { Exited: false };

    /// <summary>開いた筐体の機種と受信機。開くまで null</summary>
    public AsicenUserland.Listed? Listed { get; private set; }

    public static AsicenEnclosure For(string id) => For(id, () => new AsicenEnclosure(
        id,
        () => Hardware(id, AsicenUserland.Firmware, () => AsicenUserland.Enclosures(_ => { }), AsicenUserland.Lend())));

    /// <summary>筐体の 1 つ。まだ無ければ <paramref name="create"/> で作って控える (テストは偽の機材を開くものを渡す)</summary>
    internal static AsicenEnclosure For(string id, Func<AsicenEnclosure> create)
    {
        lock (Registry)
        {
            if (!All.TryGetValue(id, out var enclosure))
            {
                enclosure = create();
                All[id] = enclosure;
            }
            return enclosure;
        }
    }

    /// <summary>
    /// 挙げた筐体を開き、**挙げなかった筐体は閉じる。** 起動時と、チューナーの設定を書き換えたときと、機材を挿したとき。
    ///
    /// <para>
    /// **開けなくても止まらない。** 筐体が抜けている・ファームウェアが無い、はその筐体だけの話で、他のチューナー (PT3 など) は
    /// 変わらず使える。理由は記録に残し、選局のときにもう一度試す。
    /// </para>
    ///
    /// <para>
    /// **受信機を全部使わない設定にした筐体は、閉じて USB を手放す。** 開いたままだと、ほかのソフトに機材を渡せない
    /// (docs/switch.md「並べて動かすとき」)。使う設定に戻せば、ここか次の選局で開き直す。
    /// </para>
    /// </summary>
    public static void Prepare(IReadOnlyCollection<string> ids, Func<string, AsicenEnclosure> enclosure)
    {
        List<AsicenEnclosure> unused;
        lock (Registry) unused = [.. All.Values.Where(target => target.Opened && !ids.Contains(target.Id))];
        foreach (var target in unused)
        {
            target.Write("使う受信機が無くなったので閉じます");
            target.Close();
        }

        foreach (var id in ids)
        {
            var target = enclosure(id);
            try
            {
                target.Open();
            }
            catch (IOException error)
            {
                target.Write(error.Message);
            }
        }
    }

    public static void CloseAll()
    {
        List<AsicenEnclosure> enclosures;
        lock (Registry) enclosures = [.. All.Values];
        foreach (var enclosure in enclosures) enclosure.Close();
    }

    private void Write(string message) => Log.Write($"[asicen {Id}] {message}");

    /// <summary>子プロセスに渡す、機材を選ぶ引数 (asicend と同じ)</summary>
    internal static string[] Arguments(IReadOnlyList<string> ports, string firmware, bool allowLnb) =>
        ["--device", $"usb:{string.Join(',', ports)}", "--firmware", firmware, .. allowLnb ? ["--allow-lnb-power"] : Array.Empty<string>()];

    /// <summary>
    /// 継がせた fd で機材を選ぶ引数 (Android)。<c>--fd</c> は起動するときに前に足す (<see cref="FdOptions"/>)。
    /// **ファームウェアは動いている機材にも渡す** (<c>--firmware</c> は必須。動いている機材には流し込まない)
    /// </summary>
    internal static string[] FdArguments(string firmware, bool allowLnb) =>
        ["--firmware", firmware, .. allowLnb ? ["--allow-lnb-power"] : Array.Empty<string>()];

    /// <summary>継がせる fd の <c>--fd &lt;番号&gt;</c> を並べたもの (無ければ空)。2 つまでで、先が USB 機能の <c>.1</c></summary>
    internal static string[] FdOptions(IReadOnlyList<int> fds) =>
        [.. fds.SelectMany(fd => (string[])["--fd", fd.ToString(System.Globalization.CultureInfo.InvariantCulture)])];

    /// <summary>
    /// ポートを決めた機材を開く引数。<paramref name="lend"/> があれば (Android) fd を継がせる
    /// </summary>
    internal static Selection Hardware(IReadOnlyList<string> ports, string firmware, bool allowLnb, Func<IReadOnlyList<string>, InheritedFds>? lend) =>
        lend is null
            ? new Selection(Arguments(ports, firmware, allowLnb), null, allowLnb)
            : new Selection(FdArguments(firmware, allowLnb), () => lend(ports), allowLnb);

    /// <summary>
    /// 本物の機材を開く引数。**ファームウェアが無い・確かめたものと違えば開かない** (asicend と同じく必須)。
    /// 給電を許可するのは、上流が給電に対応としている機種のときだけ (給電するのは、設定に LNB 15V と書いた受信機の衛星の選局だけ。<see cref="AsicenTuner"/>)
    /// </summary>
    internal static Selection Hardware(
        string id, string firmware, Func<IEnumerable<AsicenUserland.Enclosure>> enclosures,
        Func<IReadOnlyList<string>, InheritedFds>? lend = null, string sha256 = AsicenUserland.FirmwareSha256)
    {
        if (AsicenUserland.FirmwareProblem(firmware, sha256) is { } problem) throw new IOException(problem);
        var enclosure = enclosures().FirstOrDefault(found => found.Id == id)
            ?? throw new IOException($"ASICEN の筐体 {id} が見つかりません (抜けたか、USB ポートを変えた?)");
        return Hardware(enclosure.Ports, firmware, AsicenUserland.PowersLnb(enclosure.Model), lend);
    }

    /// <summary>開いていなければ開く。駄目なら理由を添えて IOException。ファームウェアを流し込んだだけ (Android) なら <see cref="AsicenLoaded"/></summary>
    public void Open()
    {
        lock (_gate) OpenLocked();
    }

    private void OpenLocked()
    {
        if (_child is { Exited: false } && !_lost) return;
        if (_child is not null)
        {
            Write(_child.Exited
                ? "denpa-asicen が終了していたので、起動し直します"
                : "機材が抜けたか USB の読み書きに失敗したので、開き直します");
            CloseLocked();
        }
        // 機材を並べる (fd の複製は起動する直前に作る)
        var (args, lend, allowLnb) = select();
        AsicenChild? opened;
        try
        {
            opened = open is null ? AsicenChild.Open($"asicen {Id}", args, lend) : open(args);
        }
        catch (AsicenError error)
        {
            throw new IOException($"開けません: {error.Message}{Hint(error.Code)}", error);
        }
        _child = opened ?? throw new AsicenLoaded();
        _lost = false;
        var receivers = opened.Systems
            .Select((systems, index) => new AsicenReceiver(index, (systems & AsicenChild.IsdbT) != 0, (systems & AsicenChild.IsdbS) != 0))
            .ToList();
        // 偽の機材 (テスト) は引数で開かないので、給電は機材が操作できるかだけで決まる
        Listed = new AsicenUserland.Listed(opened.Model, receivers, opened.Lnb && (allowLnb || open is not null));
        Write($"{Listed.Model} を開きました。受信機 {receivers.Count} つ: "
            + string.Join(", ", receivers.Select(receiver => $"#{receiver.Index} {string.Join("/", receiver.Types)}")));
    }

    /// <summary>開いた筐体で <paramref name="action"/> を呼ぶ (開いていなければ開く)。呼んでいる間は閉じない</summary>
    public T Use<T>(Func<AsicenChild, AsicenUserland.Listed, T> action)
    {
        AsicenChild child;
        AsicenUserland.Listed listed;
        lock (_gate)
        {
            OpenLocked();
            child = _child!;
            listed = Listed!;
            _users++;
        }
        try
        {
            return action(child, listed);
        }
        finally
        {
            lock (_gate)
            {
                _users--;
                Monitor.PulseAll(_gate);
            }
        }
    }

    /// <summary>機材が抜けた・USB の読み書きに失敗した・子プロセスが終わった。次に要ったときに閉じて起動し直す</summary>
    public void MarkLost() => _lost = true;

    /// <summary>
    /// 閉じる。**使っている途中 (<see cref="Use"/>) なら終わるのを待つ。** 流している TS が残っていれば、子プロセスはそれを止めたときに後片付けを終える
    /// (LNB を 0 V に戻し、USB を手放して終わる)
    /// </summary>
    public void Close()
    {
        lock (_gate) CloseLocked();
    }

    private void CloseLocked()
    {
        while (_users > 0) Monitor.Wait(_gate);
        if (_child is null) return;
        _child.Close();
        _child = null;
        Listed = null;
    }

    /// <summary>開けなかった理由 (上流の Error) に、どうすればいいかを添える</summary>
    private static string Hint(int code) => code switch
    {
        AsicenChild.InvalidArgument => "。機材の組み合わせが合いません",
        3 or 5 => "。筐体が見つからないか開けません (抜けたか、ほかのソフトが使っている?)",
        AsicenChild.Busy => "。ほかのソフトが使っています",
        AsicenChild.UsbIo or AsicenChild.Disconnected => "。USB の読み書きに失敗しました (抜けた? Windows ではドライバが WinUSB か)",
        10 => "。ファームウェアを受け付けません",
        _ => "",
    };
}

/// <summary>ファームウェア待ちの機材に流し込んだだけで、開いていない (Android。つながり直した機材は別の VID・PID でアプリから届く)</summary>
public sealed class AsicenLoaded() : IOException("ファームウェアを流し込みました。機材がつながり直すのを待ちます");
