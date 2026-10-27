using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/px4-userland">px4-userland</a> に任せる機材
/// (PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系 …)。
///
/// <para>
/// **カーネルドライバを入れてもらわない。** px4-userland は libusb だけで USB を扱うユーザー空間のドライバで、
/// 同梱すれば <c>/dev/bus/usb</c> が見えるだけで動く。<c>px4d</c> が筐体 (USB 機能・受信機・カード) を持ち、
/// 受信機は px4d の制御ソケットで直に取って選局する (<see cref="Px4Tuner"/>)。**機種のことは何も持たない** —
/// 刺さっている筐体と受けられる方式は <c>px4d --list-json</c> に聞く (<see cref="Enclosures"/>)。
/// 作りは docs/agent.md「px4-userland の作り」。
/// </para>
///
/// <para>
/// 設定の <c>device</c> には <c>px4:&lt;筐体の番号&gt;:&lt;受信機番号&gt;</c> と書く。
/// 刺さっていれば <see cref="Detect"/> が見つけて組み立てるので、普通は書かなくてよい。
/// </para>
/// </summary>
public static class Px4Userland
{
    /// <summary>設定の <c>device</c> の頭。これで始まっていれば px4-userland で使う</summary>
    public const string Scheme = "px4:";

    /// <summary>
    /// 刺さっている筐体1台。
    ///
    /// <para>
    /// <c>Id</c> は設定の <c>px4:&lt;Id&gt;:&lt;受信機&gt;</c> に入る名前で、px4d のソケットの置き場の名前でもある。
    /// 番号が一意なら番号そのもの。**番号が重なる筐体** (PX-M1UR と PX-S1UR はどれも <c>000000000000001</c>) は
    /// USB ポートを足した名前 (<see cref="AliasOf"/>) にして、px4d を <c>--usb-path</c> と <c>--instance</c> で起こす
    /// (<see cref="UsbPaths"/> が空でない)。
    /// </para>
    /// </summary>
    public sealed record Enclosure(
        string Id,
        string Model,
        IReadOnlyList<Px4Receiver> Receivers,
        string? Serial = null,
        IReadOnlyList<string>? UsbPaths = null)
    {
        /// <summary>筐体の番号 (USB の serial)。px4d の <c>--device</c> に渡す</summary>
        public string Serial { get; init; } = Serial ?? Id;

        /// <summary>番号が重なるときだけ。px4d の <c>--usb-path</c> に渡す (dev 1 / dev 2 の順)</summary>
        public IReadOnlyList<string> UsbPaths { get; init; } = UsbPaths ?? [];

        /// <summary>
        /// 筐体の USB の位置 (ポート、分からなければ <c>BUS:ADDRESS</c>)。px4d が使っている間、その USB が一覧で
        /// <c>open_failed</c> と出ても黙るため (<see cref="ParseJson"/>)
        /// </summary>
        public IReadOnlyList<string> Places { get; init; } = [];
    }

    /// <summary>
    /// 番号が重なる筐体の名前。**番号とUSB ポート** (<c>000000000000001_1-2.3</c>)。
    ///
    /// <para>
    /// px4d の <c>--instance</c> にそのまま使えるよう、英数字と <c>_ - .</c> だけにする
    /// (px4-userland SPEC 4.1)。USB ポートが <c>BUS:ADDRESS</c> でしか分からないときは <c>b1a6</c> と書く。
    /// **USB ポートを変えると別の筐体になる** (px4-userland も「抜き差し後の物理個体を保証しない」と言っている)
    /// </para>
    /// </summary>
    public static string AliasOf(string serial, IEnumerable<string> places) => $"{serial}_{string.Join('_', places)}";

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("PX4_USERLAND_DIR") ?? "/opt/px4-userland";

    /// <summary>
    /// IT930x のファームウェア。**同梱してある** (Dockerfile)。
    ///
    /// <para>
    /// 本体には入っておらず、挿すたびにホストから RAM へ流し込むもの。
    /// px4-userland は受理するバージョンを SHA-256 で1つに固定していて、
    /// 違うものを渡すと <c>FIRMWARE_REJECTED</c> で起動しない。
    /// </para>
    /// </summary>
    public static string Firmware =>
        Environment.GetEnvironmentVariable("PX4_FIRMWARE") ?? Path.Combine(Dir, "firmware", "it930x-firmware.bin");

    /// <summary>px4d / px4ctl の実行ファイル。Windows だけ <c>.exe</c> が付く (配布 zip の中身のまま)</summary>
    public static string Executable(string dir, string name) =>
        Path.Combine(dir, OperatingSystem.IsWindows() ? $"{name}.exe" : name);

    /// <summary>
    /// px4d が socket を置く場所 (ランタイムルート)。
    ///
    /// <para>
    /// **Windows は <c>C:\denpa-run</c>** (install.ps1 が作る)。px4d はここを、持ち主が本人で、本人・SYSTEM・
    /// Administrators のほかに書ける人がいないときだけ使う。ユーザーのフォルダ (<c>%LOCALAPPDATA%</c>) の下に
    /// しないのは、ソケットのパスが UTF-8 で 108 バイトまでで、日本語のユーザー名だとすぐ溢れるのと、
    /// 非 ASCII のパスだと px4d の ready の行が途切れる (px4-userland #52) から (<see cref="RuntimeProblem"/>)
    /// </para>
    /// </summary>
    public static string RuntimeDir =>
        Environment.GetEnvironmentVariable("PX4_RUNTIME_DIR")
        ?? (OperatingSystem.IsWindows() ? @"C:\denpa-run" : "/run/px4-userland");

    /// <summary>
    /// ソケットのパスの上限 (UTF-8、末尾の NUL を入れて)。<c>sockaddr_un.sun_path</c> の大きさで、
    /// Linux と Windows は 108、macOS は 104
    /// </summary>
    private static int SocketPathLimit => OperatingSystem.IsMacOS() ? 104 : 108;

    /// <summary>
    /// px4d を起こす前に、ランタイムルートが使えるか確かめる。駄目なら理由 (使えれば null)。
    ///
    /// <para>
    /// **ソケットのパスの長さ** (どの OS でも)。超えると px4d は INVALID_ARGUMENT とだけ言って起きない。
    /// **Windows は持ち主と権限も** (px4-userland の windows_ipc.cpp と同じ決まり。<see cref="AclProblem"/>)。
    /// 合わなければ px4d が同じく INVALID_ARGUMENT で起きないので、先に理由を言う
    /// </para>
    /// </summary>
    public static string? RuntimeProblem(string runtimeDir, string id)
    {
        var endpoint = Px4Control.Endpoint(runtimeDir, id, "control.sock");
        var bytes = System.Text.Encoding.UTF8.GetByteCount(endpoint);
        if (bytes + 1 > SocketPathLimit)
        {
            return $"ソケットのパスが長すぎます ({endpoint} は {bytes} バイト。{SocketPathLimit - 1} バイトまで)。"
                + "PX4_RUNTIME_DIR を短いパスにしてください";
        }
        return OperatingSystem.IsWindows() ? WindowsRuntimeProblem(runtimeDir) : null;
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string? WindowsRuntimeProblem(string runtimeDir)
    {
        var info = new DirectoryInfo(runtimeDir);
        if (!info.Exists) return $"{runtimeDir} がありません (install.ps1 を流し直すと作ります)";
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return $"{runtimeDir} がリンクになっています (普通のフォルダにしてください)";
        var me = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? "";
        var security = info.GetAccessControl(
            System.Security.AccessControl.AccessControlSections.Owner | System.Security.AccessControl.AccessControlSections.Access);
        var owner = security.GetOwner(typeof(System.Security.Principal.SecurityIdentifier))?.Value;
        var aces = security.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier))
            .OfType<System.Security.AccessControl.FileSystemAccessRule>()
            .Select(rule => (rule.IdentityReference.Value,
                rule.AccessControlType == System.Security.AccessControl.AccessControlType.Allow, (uint)rule.FileSystemRights));
        return AclProblem(me, owner, aces) is { } problem
            ? $"{runtimeDir} の権限が px4d の決まりに合いません ({problem})。install.ps1 を流し直すと整えます"
            : null;
    }

    /// <summary>
    /// 書き込みに当たる権限 (px4-userland の <c>kUntrustedWriteMask</c> と同じ)。
    /// GENERIC_WRITE・GENERIC_ALL・DELETE・WRITE_DAC・WRITE_OWNER・FILE_WRITE_DATA・FILE_APPEND_DATA・
    /// FILE_WRITE_EA・FILE_WRITE_ATTRIBUTES・FILE_DELETE_CHILD
    /// </summary>
    private const uint WriteMask = 0x40000000 | 0x10000000 | 0x10000 | 0x40000 | 0x80000 | 0x2 | 0x4 | 0x10 | 0x100 | 0x40;

    /// <summary>本人のほかに書いてよい人 (SYSTEM・Administrators・CREATOR OWNER・OWNER RIGHTS)</summary>
    private static readonly HashSet<string> TrustedSids = ["S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"];

    /// <summary>
    /// ランタイムルートの持ち主と ACL が px4d の決まりに合うか (px4-userland の <c>verify_runtime_parent</c>)。
    /// 合わなければ理由。**持ち主が本人、許可の ACE だけ、本人が書ける、本人と <see cref="TrustedSids"/> のほかは
    /// 書けない。** OS を見ないので、どこでもテストできる
    /// </summary>
    internal static string? AclProblem(string me, string? owner, IEnumerable<(string Sid, bool Allow, uint Mask)> aces)
    {
        if (owner != me) return $"持ち主が本人ではありません ({owner ?? "不明"})";
        var writable = false;
        foreach (var (sid, allow, mask) in aces)
        {
            if (!allow) return $"拒否の設定があります ({sid})";
            if (sid == me)
            {
                writable |= (mask & WriteMask) != 0;
                continue;
            }
            if (!TrustedSids.Contains(sid) && (mask & WriteMask) != 0) return $"ほかの人 ({sid}) も書けます";
        }
        return writable ? null : "本人が書けません";
    }

    public static string Device(string id, int receiver) => $"{Scheme}{id}:{receiver}";

    /// <summary>
    /// <c>px4:00001205000960:2</c> を割る。形式が違えば null。
    ///
    /// <para>
    /// 番号の桁数や受信機の上限は見ない。**それを知っているのは px4-userland** で、
    /// 合わなければ px4d が理由を付けて断る。
    /// </para>
    /// </summary>
    public static (string Id, int Receiver)? Parse(string device) => Parse(device, Scheme, ValidId);

    /// <summary><c>&lt;頭&gt;&lt;筐体&gt;:&lt;受信機&gt;</c> を割る (<c>asicen:</c> も同じ形式)。形式が違えば null</summary>
    internal static (string Id, int Receiver)? Parse(string device, string scheme, Func<string, bool> validId)
    {
        if (!device.StartsWith(scheme, StringComparison.Ordinal)) return null;
        var parts = device[scheme.Length..].Split(':');
        if (parts.Length != 2 || !validId(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

    private static bool Digits(string value) => value.Length > 0 && value.All(char.IsAsciiDigit);

    /// <summary>番号そのもの、または番号とUSB ポート (<see cref="AliasOf"/>)</summary>
    internal static bool ValidId(string id)
    {
        var cut = id.IndexOf('_');
        if (cut < 0) return Digits(id);
        return Digits(id[..cut]) && id.Length <= 80 && cut < id.Length - 1
            && id[(cut + 1)..].All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');
    }

    /// <summary>
    /// 画面で筐体を見分ける短い名前。番号の末尾4桁、**番号が重なる筐体はUSB ポート**
    /// (末尾4桁が同じなので見分けにならない)
    /// </summary>
    public static string Label(string id)
    {
        var cut = id.IndexOf('_');
        return cut < 0 ? Tail(id) : $"USB {id[(cut + 1)..].Replace('_', '/')}";
    }

    /// <summary>番号の末尾4桁。桁数は見ていない (<see cref="Parse(string)"/>) ので、4桁に満たなければ全部</summary>
    internal static string Tail(string id) => id.Length > 4 ? id[^4..] : id;

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string id, int receiver) => $"{model}-{Label(id)} #{receiver}";

    /// <summary>
    /// 刺さっている筐体。**<c>px4d --list-json</c> に聞く。**
    ///
    /// <para>
    /// 読むだけで筐体を開かないので、px4d が動いていても聞ける。px4-userland が
    /// 入っていない環境 (手元の開発など) では空。<c>--list-json</c> は 0.1.9 から (古い px4d では筐体が挙がらない)。
    /// </para>
    /// </summary>
    /// <param name="warn">使えない筐体の理由を残す先。省けば記録 (<see cref="Log"/>)</param>
    public static List<Enclosure> Enclosures(Action<string>? warn = null)
    {
        warn ??= Log.Write;
        var px4d = Executable(Dir, "px4d");
        if (!File.Exists(px4d)) return [];
        var (code, output) = Shell.Run(px4d, ["--list-json"], TimeSpan.FromSeconds(15));
        if (code != 0)
        {
            warn($"px4-userland の筐体を挙げられません (px4d --list-json exit {code}: {output})");
            return [];
        }
        try
        {
            return ParseJson(output, warn, Px4Daemon.Owned());
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            // 文書として読めないときだけ。形式の違いは ParseJson が読めたところまで使う
            warn($"px4d --list-json の答えが読めません ({error.Message})");
            return [];
        }
    }

    /// <summary>
    /// <c>px4d --list-json</c> の出力を読む (px4-userland SPEC 4.6 v0.26)。**使えるのは <c>status=ready</c> の筐体。**
    /// 番号が重なる筐体 (<c>serial_unique=false</c>) はUSB ポートで見分ける (<see cref="AliasOf"/>)。
    ///
    /// <para>
    /// <c>{"enclosures":[{serial, model, usb, status, serial_unique, devices, candidates, receivers}],
    /// "ungrouped_usb_devices":[…]}</c> の1行。<c>schema_version</c> は無く、消費側は知らない鍵を
    /// 無視する決まり。**形式が違っても止まらない** — 無い鍵・型の違う値は既定で埋めて読み進め、
    /// バージョンのずれを疑う旨を1度だけ <paramref name="warn"/> で残す。止めるのは筐体の番号と受信機の番号
    /// (それが無いと <c>px4:&lt;番号&gt;:&lt;受信機&gt;</c> が作れない) が読めないときだけで、それも
    /// その筐体・受信機だけを飛ばす。
    /// </para>
    ///
    /// <para>
    /// 出力は stdout と stderr を繋げたもの (<see cref="Shell.Run"/>) なので、<c>{</c> で始まる最初の行を
    /// 文書とみなす。libusb が stderr に何か言っても読めるように。
    /// </para>
    ///
    /// <para>
    /// **px4d が使っている筐体を足す** (<paramref name="running"/>)。Windows の libusb は WinUSB の機材を
    /// 1つのプロセスでしか開けず、px4d が使っている筐体は一覧で <c>open_failed</c> になる (px4-userland の
    /// Windows の実機記録)。そのままだと、動いている間に自動検出し直すと筐体が顔ぶれから消える。
    /// 動いている px4d の筐体は起こしたときのものを使い、その USB の <c>open_failed</c> は記録しない。
    /// 同じ番号の筐体の片方の px4d が動いていると、もう片方は一覧で番号が一意に見えるので、
    /// **動いている px4d と番号が同じなら重なっているとみなす**
    /// </para>
    /// </summary>
    /// <param name="running">いま px4d が使っている筐体 (<see cref="Px4Daemon.Owned"/>)</param>
    /// <exception cref="JsonException">JSON として読めない</exception>
    /// <exception cref="FormatException">文書が無い・object でない</exception>
    public static List<Enclosure> ParseJson(string output, Action<string> warn, IReadOnlyList<Enclosure>? running = null)
    {
        var line = output.Split('\n').Select(raw => raw.Trim()).FirstOrDefault(raw => raw.StartsWith('{'))
            ?? throw new FormatException("JSON の文書がありません");
        var root = JsonNode.Parse(line) as JsonObject ?? throw new FormatException("JSON の文書が object ではありません");
        var shape = new JsonShape();
        var found = new List<Enclosure>();
        running ??= [];
        var claimed = running.SelectMany(enclosure => enclosure.Places).ToHashSet(StringComparer.Ordinal);

        foreach (var item in shape.Array(root, "enclosures", ""))
        {
            if (item is not JsonObject enclosure)
            {
                shape.Skew("enclosures[] が object ではない");
                continue;
            }
            var id = shape.Text(enclosure, "serial", "enclosures[]") ?? "";
            var model = shape.Text(enclosure, "model", "enclosures[]") ?? "px4";
            var status = shape.Text(enclosure, "status", "enclosures[]") ?? "";
            // 無ければ一意とみなす (バージョンのずれとしては残る)。番号が重なれば px4d が起動を断る (exit 2) だけ
            var unique = shape.Flag(enclosure, "serial_unique", "enclosures[]") ?? true;
            var devices = shape.Array(enclosure, "devices", "enclosures[]").OfType<JsonObject>()
                .Select(device => (
                    Device: shape.Number(device, "device", "devices[]", optional: true) ?? 0,
                    Port: shape.Text(device, "port", "devices[]", optional: true),
                    Bus: shape.Number(device, "bus", "devices[]", optional: true),
                    Address: shape.Number(device, "address", "devices[]", optional: true)))
                .OrderBy(device => device.Device)
                .ToList();
            var where = Where(
                devices.Select(device => (device.Port, device.Bus, device.Address)).Concat(
                    shape.Array(enclosure, "candidates", "enclosures[]").OfType<JsonObject>()
                        .Select(device => (shape.Text(device, "port", "candidates[]", optional: true),
                            shape.Number(device, "bus", "candidates[]", optional: true),
                            shape.Number(device, "address", "candidates[]", optional: true)))));

            /*
             * **番号が重なる筐体は、USB ポートで見分ける。** px4d にはUSB ポート (`--usb-path`) と、ソケットの
             * 置き場の名前 (`--instance`) を渡す。番号だけを選択子として控えるな、と SPEC 4.6 にある
             */
            IReadOnlyList<string> paths = [];
            var alias = id;
            if (unique && running.Any(other => other.Serial == id && other.UsbPaths.Count > 0)) unique = false;
            if (!unique && status == "ready" && Digits(id))
            {
                var places = devices.Select(device =>
                    device.Port is { Length: > 0 } port ? (Path: port, Name: port)
                    : device.Bus is { } bus && device.Address is { } address ? (Path: $"{bus}:{address}", Name: $"b{bus}a{address}")
                    : default).ToList();
                if (places.Count is 0 or > 2 || places.Any(place => place.Path is null))
                {
                    warn($"{model} {id} は使えません。同じ番号の筐体がほかにも刺さっていて、USB ポートも分からないので"
                        + $"見分けられません (serial_unique=false{where})");
                    continue;
                }
                paths = [.. places.Select(place => place.Path!)];
                alias = AliasOf(id, places.Select(place => place.Name!));
            }

            if (Usable(id, model, status, where, warn))
            {
                var receivers = new List<Px4Receiver>();
                foreach (var entry in shape.Array(enclosure, "receivers", "enclosures[]"))
                {
                    if (entry is not JsonObject receiver)
                    {
                        shape.Skew("receivers[] が object ではない");
                        continue;
                    }
                    var number = shape.Number(receiver, "receiver", "receivers[]");
                    var system = shape.Text(receiver, "system", "receivers[]");
                    if (number is null || system is null)
                    {
                        warn($"{model} {id} の受信機が読めません: {receiver.ToJsonString()}");
                        continue;
                    }
                    var lnb = shape.Flag(receiver, "lnb_15v_supported", "receivers[]");
                    if (Px4Receiver.From(number.Value, system, lnb, warn) is { } known) receivers.Add(known);
                }
                found.Add(new Enclosure(alias, model, receivers, id, paths)
                {
                    Places = [.. devices.Select(device => Place(device.Port, device.Bus, device.Address)).OfType<string>()],
                });
            }
        }

        foreach (var item in shape.Array(root, "ungrouped_usb_devices", ""))
        {
            if (item is not JsonObject device)
            {
                shape.Skew("ungrouped_usb_devices[] が object ではない");
                continue;
            }
            var port = shape.Text(device, "port", "ungrouped_usb_devices[]", optional: true);
            var bus = shape.Number(device, "bus", "ungrouped_usb_devices[]", optional: true);
            var address = shape.Number(device, "address", "ungrouped_usb_devices[]", optional: true);
            var status = shape.Text(device, "status", "ungrouped_usb_devices[]") ?? "";
            // px4d が使っているから開けないだけ (Windows)。理由として残すと見当違いになる
            if (status == "open_failed" && Place(port, bus, address) is { } place && claimed.Contains(place)) continue;
            Rejected(
                shape.Text(device, "model", "ungrouped_usb_devices[]"),
                shape.Text(device, "usb", "ungrouped_usb_devices[]"),
                status,
                Where([(port, bus, address)]),
                warn);
        }

        // 一覧に出なかった (px4d が使っていて開けなかった) 筐体は、起こしたときのものを使う
        found.AddRange(running.Where(enclosure => found.All(other => other.Id != enclosure.Id)));

        if (shape.Notes.Count > 0)
        {
            warn($"px4d --list-json の形式が思っていたのと違います (px4-userland のバージョンがずれている?)。読めたところだけ使います: {string.Join(", ", shape.Notes)}");
        }
        return found;
    }

    /// <summary>
    /// JSON の値を読み取る。**形式が違えば null を返し、違ったことを <see cref="Notes"/> に溜める。**
    /// リフレクションで型に流し込む方式 (JsonSerializer) は Native AOT で使えないので、木 (<c>JsonNode</c>) を直に読む
    /// </summary>
    private sealed class JsonShape
    {
        public SortedSet<string> Notes { get; } = new(StringComparer.Ordinal);

        public void Skew(string note) => Notes.Add(note);

        /// <summary>
        /// 鍵の値。無い・型が違う・(<paramref name="optional"/> でなければ) null はバージョンのずれとして残す。
        /// 位置 (bus など) は「取れなかった」を null で言う決まりなので optional
        /// </summary>
        private JsonValue? Value(JsonObject obj, string key, string where, bool optional)
        {
            if (!obj.TryGetPropertyValue(key, out var node))
            {
                Skew($"{where}.{key} が無い");
                return null;
            }
            if (node is null)
            {
                if (!optional) Skew($"{where}.{key} が null");
                return null;
            }
            if (node is JsonValue value) return value;
            Skew($"{where}.{key} の型が違う");
            return null;
        }

        public string? Text(JsonObject obj, string key, string where, bool optional = false) =>
            Read(obj, key, where, optional, "文字列", out string? text) ? text : null;

        public int? Number(JsonObject obj, string key, string where, bool optional = false) =>
            Read(obj, key, where, optional, "整数", out int number) ? number : null;

        public bool? Flag(JsonObject obj, string key, string where, bool optional = false) =>
            Read(obj, key, where, optional, "真偽値", out bool flag) ? flag : null;

        /// <summary>鍵の値を <typeparamref name="T"/> で読む。型が違えば「<paramref name="kind"/>ではない」と残す</summary>
        private bool Read<T>(JsonObject obj, string key, string where, bool optional, string kind, out T? result)
        {
            result = default;
            if (Value(obj, key, where, optional) is not { } value) return false;
            if (value.TryGetValue<T>(out result)) return true;
            Skew($"{where}.{key} が{kind}ではない");
            return false;
        }

        public IEnumerable<JsonNode?> Array(JsonObject obj, string key, string where)
        {
            var path = where.Length == 0 ? key : $"{where}.{key}";
            if (!obj.TryGetPropertyValue(key, out var node))
            {
                Skew($"{path} が無い");
                return [];
            }
            if (node is JsonArray array) return array;
            Skew($"{path} が配列ではない");
            return [];
        }
    }

    /// <summary>
    /// 筐体を使うか決める。使わないなら理由を残す。番号が重なる筐体 (<c>serial_unique=false</c>) も
    /// USB ポートを足した名前で使う (<see cref="AliasOf"/>。<see cref="ParseJson"/> が組み立てる)
    /// </summary>
    private static bool Usable(string id, string model, string status, string where, Action<string> warn)
    {
        if (status != "ready")
        {
            warn($"{model} {id} は使えません (px4d --list-json: status={status}{where})");
            return false;
        }
        if (!Digits(id))
        {
            warn($"{model} の番号 {id} が読めません (数字だけのはず)");
            return false;
        }
        return true;
    }

    /// <summary>まとめられなかった USB デバイスの理由を残す。権限が無いときに黙って「チューナーが無い」にならないように</summary>
    private static void Rejected(string? model, string? usb, string status, string where, Action<string> warn) =>
        warn($"{model} ({usb}) を使えません: {status}{where}"
            + (status != "open_failed" ? ""
                // Windows の libusb は WinUSB の機材しか開けず、開けるのも1つのプロセスだけ
                : OperatingSystem.IsWindows() ? $" ({WinUsbHint})"
                : " (/dev/bus/usb を開く権限が無いかもしれません)"));

    /// <summary>Windows で筐体を開けないときの手当て</summary>
    private const string WinUsbHint =
        "ドライバが WinUSB になっていないか、別のソフト (TVTest など) が使っています。Zadig で WinUSB に (docs/install-windows.md)";

    /// <summary>
    /// USB の場所を理由に添えるようにする (<c>, USB 1-2.3</c>)。同じ番号のものが並んだとき、どれの話か分かるように。
    /// 何も取れなければ空
    /// </summary>
    private static string Where(IEnumerable<(string? Port, int? Bus, int? Address)> places)
    {
        var named = places.Select(place => Place(place.Port, place.Bus, place.Address)).OfType<string>().ToArray();
        return named.Length == 0 ? "" : $", USB {string.Join(" / ", named)}";
    }

    /// <summary>USB の位置。ポート、分からなければ <c>BUS:ADDRESS</c>、どちらも無ければ null</summary>
    private static string? Place(string? port, int? bus, int? address) =>
        port ?? (bus is { } b && address is { } a ? $"{b}:{a}" : null);

    /// <summary>
    /// px4d の終了コード (px4-userland README) に、どうすればいいかを添える。分からないコードは何も足さない
    /// (<see cref="SianoUserland.Hint"/> と同じ作り)
    /// </summary>
    public static string Hint(int code) => code switch
    {
        2 => " — 引数かランタイムルートが合いません (同じ番号の筐体が並んでいる・ソケットのパスが長い・権限が合わない)",
        3 when OperatingSystem.IsWindows() => $" — 筐体が見つからないか開けません。抜けたか、{WinUsbHint}",
        3 => " — 筐体が見つからないか開けません (抜けたか、別のプロセスが使っている?)",
        4 => " — 同じ筐体の px4d がほかに動いています",
        7 => " — USB の読み書きに失敗しました (抜けた?)。次の選局で起こし直します",
        10 => " — ファームウェアを受け付けません (入れ直してください)",
        _ => "",
    };

    /// <summary>刺さっている筐体の受信機を、設定に書いたのと同じ形式で</summary>
    public static List<TunerSpec> Detect() => Specs(Enclosures());

    /// <summary>筐体の一覧から、設定の形式に組み立てる</summary>
    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
        Specs(enclosures.Select(enclosure => (enclosure.Id, enclosure.Model, enclosure.Receivers)), Name, Device);

    /// <summary>筐体ごとの受信機を設定の形式に (受けられる方式の無い受信機は除く。asicen-userland も同じ)</summary>
    internal static List<TunerSpec> Specs(
        IEnumerable<(string Id, string Model, IReadOnlyList<Px4Receiver> Receivers)> enclosures,
        Func<string, string, int, string> name, Func<string, int, string> device) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, device(enclosure.Id, receiver.Index)))),
    ];

    /// <summary>
    /// 受信機ごとの注意書き (<c>px4:&lt;番号&gt;:&lt;受信機&gt;</c> → 文)。選局は通るが設定どおりには
    /// 動いていないこと (15V を出せない受信機で 0V にした、など。<see cref="Px4Tuner.Lnb"/>) を
    /// チューナー画面に出す (<see cref="TunerPool.Status"/> の <c>error</c>)
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (object Owner, string Text)> Notices =
        new(StringComparer.Ordinal);

    public static string? Notice(string? device) =>
        device is not null && Notices.TryGetValue(device, out var notice) ? notice.Text : null;

    internal static void SetNotice(string device, object owner, string text) => Notices[device] = (owner, text);

    /// <summary>
    /// <paramref name="owner"/> が出したものだけ消す。設定を変えて開き直すとき、古いチューナーの後始末が
    /// 新しいチューナーの出したものを消さないように (文は同じなので、出した者で見分ける)
    /// </summary>
    internal static void ClearNotice(string device, object owner)
    {
        if (Notices.TryGetValue(device, out var notice) && ReferenceEquals(notice.Owner, owner))
        {
            Notices.TryRemove(new KeyValuePair<string, (object, string)>(device, notice));
        }
    }

    /// <summary>設定に出てくる筐体。px4d を起こす相手</summary>
    public static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs) => IdsIn(specs, Parse);

    /// <summary>設定に出てくる筐体 (<paramref name="parse"/> で割れる <c>device</c> のもの)</summary>
    internal static IEnumerable<string> IdsIn(IEnumerable<TunerSpec> specs, Func<string, (string Id, int Receiver)?> parse) => specs
        .Where(spec => !spec.Disabled && spec.Device is not null)
        .Select(spec => parse(spec.Device!)?.Id)
        .OfType<string>()
        .Distinct(StringComparer.Ordinal);
}

/// <summary>
/// 受信機1つ。**<c>px4d --list-json</c> / <c>px4ctl list</c> で px4-userland に聞いたもの。**
///
/// <para>
/// Q3U4 は受信機ごとに地上波か衛星かが決まっていて、MLT5 系はどれも両方受けられる
/// (選局のたびに切り替える)。その違いはここに入ってくるだけで、こちらは機種を見ない。
/// </para>
///
/// <para>
/// <c>Lnb15v</c> は LNB に 15V を出せるか (<c>lnb_15v_supported</c>、px4-userland 0.1.9 から)。
/// **分からなければ null** で、そのときは言われたとおり指定する (合わなければ px4d が断る)。
/// <c>px4ctl list</c> には載らない (IPC の形式は変えないと SPEC 4.1 v0.26) ので、筐体の一覧から写す
/// (<see cref="Px4Daemon.Ensure"/>)。
/// </para>
/// </summary>
public sealed record Px4Receiver(int Index, bool Terrestrial, bool Satellite, bool? Lnb15v = null)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

    /// <summary>
    /// <c>px4ctl list</c> の出力 (<c>siano-ts --list</c> の受信機の行も同じ形式) を読む。
    ///
    /// <para>
    /// <c>receiver=0 device=1 local=0 system=ISDB-S</c> の行が受信機の数だけ並ぶ。
    /// <c>system</c> は <c>ISDB-T</c> / <c>ISDB-S</c> / <c>ISDB-T/S</c> (どちらも)。
    /// **知らない値は飛ばして続ける** — px4-userland が新しくなって方式が増えても、
    /// 分かる受信機は使えるように。飛ばしたことは <paramref name="warn"/> で残す。
    /// 15V の可否はここには載らない (<see cref="Px4Daemon.WithLnb"/> が一覧から写す)。
    /// </para>
    /// </summary>
    public static List<Px4Receiver> ParseList(string output, Action<string> warn)
    {
        var found = new List<Px4Receiver>();
        foreach (var line in output.Split('\n'))
        {
            var fields = Fields(line);
            if (!fields.TryGetValue("receiver", out var index) || !fields.TryGetValue("system", out var system)) continue;
            if (!int.TryParse(index, out var number))
            {
                warn($"px4ctl list の受信機番号が読めません: {line.Trim()}");
                continue;
            }
            if (From(number, system, null, warn) is { } receiver) found.Add(receiver);
        }
        return found;
    }

    /// <summary>
    /// <c>key=value</c> を空白で並べた1行を割る。同じ鍵が2度あれば最初のもの。
    /// <c>siano-ts --list</c> の機材の行 (Siano.cs) も同じ形式
    /// </summary>
    internal static Dictionary<string, string> Fields(string line) => line
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .Select(field => field.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .GroupBy(pair => pair[0], StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.First()[1], StringComparer.Ordinal);

    /// <summary>方式の名前から組み立てる。知らない方式なら理由を残して null</summary>
    internal static Px4Receiver? From(int number, string system, bool? lnb15v, Action<string> warn)
    {
        (bool Terrestrial, bool Satellite)? kind = system switch
        {
            "ISDB-T" => (true, false),
            "ISDB-S" => (false, true),
            "ISDB-T/S" => (true, true),
            _ => null,
        };
        if (kind is { } known) return new Px4Receiver(number, known.Terrestrial, known.Satellite, lnb15v);
        warn($"受信機 {number} の方式 {system} を知りません (px4-userland が新しい?)。この受信機は使いません");
        return null;
    }
}

/// <summary>
/// 筐体を持つ常駐 (<c>px4d</c> / <c>asicend</c>)。**筐体1台につき1つ、起こしたら止めるまで動き続ける。**
///
/// <para>
/// 起こすのは最初に要ったとき (起動時の <see cref="Prepare"/> か、初めての選局)。
/// ファームウェアを流し込んでから ready になるので、数秒かかる。
/// 落ちていたら次に要ったときに起こし直す。
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

    /// <summary>いまの常駐を標準入力で止めるか (<see cref="Launch"/> の <c>stopByStdin</c>)</summary>
    private bool _stopByStdin;

    public bool Running => _process is { HasExited: false };

    /// <summary>
    /// 筐体に聞いた受信機。**ready になるまで null。** 聞けなかったときも null のままで、
    /// そのときは選局を常駐に任せる (合わなければあちらが断る)
    /// </summary>
    public IReadOnlyList<Px4Receiver>? Receivers { get; protected set; }

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

    /// <summary>
    /// 挙げた筐体ぶん起こして ready まで待つ。**起動時と、設定を書き換えたとき。**
    ///
    /// <para>
    /// **起こせなくても止まらない。** 筐体が抜けている・ファームウェアが無い、は
    /// その筐体だけの話で、他のチューナー (PT3 など) は変わらず使える。
    /// 理由は記録に残し、選局のときにもう一度試す。
    /// </para>
    /// </summary>
    public static void Prepare(IEnumerable<string> ids, Func<string, UserlandDaemon> daemon)
    {
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

    /// <summary>動いていなければ起こして ready まで待つ。駄目なら理由を添えて投げる</summary>
    public abstract void Ensure();

    protected void Write(string message) => Log.Write($"[{name} {Id}] {message}");

    /// <summary>
    /// 起こして、<paramref name="ready"/> が通るまで待つ。<paramref name="runtimeDir"/> (ランタイムルート) は
    /// 呼ぶ側が用意する決まり (常駐は下の階層しか作らない)
    /// </summary>
    /// <param name="stopByStdin">
    /// **標準入力で止める** (Windows の px4d。<c>--exit-on-stdin-eof</c>)。標準入力は何も書かずに開けたまま持ち、
    /// 止めるときに閉じる。エージェントが落ちても (Kill されても) 書く側が閉じるので、常駐は後片付けをして終わる
    /// </param>
    /// <param name="hint">終了コードに添える手当て (<see cref="Px4Userland.Hint"/>)</param>
    internal void Launch(
        string program, IReadOnlyList<string> args, string runtimeDir, Func<bool> ready, Action onReady,
        bool stopByStdin = false, Func<int, string>? hint = null)
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
                RedirectStandardInput = stopByStdin,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // px4d の診断は UTF-8 (パスに日本語が入りうる)
                StandardErrorEncoding = System.Text.Encoding.UTF8,
                UseShellExecute = false,
            };
            var process = Process.Start(start) ?? throw new IOException($"{name} を起動できません");
            _process = process;
            _stopByStdin = stopByStdin;
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
            _ = Task.Run(() => process.StandardOutput.ReadToEndAsync());

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

    /// <summary>受信機の行 (<c>px4ctl list</c> の形式) を読んで記録に残す。1つも読めなければ null</summary>
    protected List<Px4Receiver>? ListReceivers(string output, string command)
    {
        var receivers = Px4Receiver.ParseList(output, Write);
        if (receivers.Count == 0)
        {
            Write($"受信機を聞けません ({command}: {output})");
            return null;
        }
        Write($"受信機 {receivers.Count} つ: " + string.Join(", ", receivers.Select(r => $"#{r.Index} {string.Join("/", r.Types)}")));
        return receivers;
    }

    /// <summary>
    /// 止める。**SIGTERM で** (Windows の px4d は標準入力を閉じて)。px4d / asicend は合図を受けると
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
                if (_stopByStdin)
                {
                    try
                    {
                        process.StandardInput.Close();
                    }
                    catch (IOException)
                    {
                        // もう終わりかけている
                    }
                }
                else
                {
                    Interop.Terminate(process.Id);
                }
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
/// <c>px4d</c> 1つ。**ready になったら受信機を聞く** (<c>px4ctl list</c>、<see cref="UserlandDaemon.Receivers"/>)。
/// いくつあって何を受けられるかは筐体の答えを使う。
/// </summary>
public sealed class Px4Daemon(string id) : UserlandDaemon("px4d", id)
{
    public static Px4Daemon For(string id) => For(id, () => new Px4Daemon(id));

    /// <summary>
    /// 起こしたときの筐体 (一覧で聞いたもの)。動いている間、一覧に出なくなっても (Windows では px4d が使っている
    /// 筐体は開けない) これを使う (<see cref="Owned"/>)
    /// </summary>
    private Px4Userland.Enclosure? _enclosure;

    /// <summary>いま px4d が使っている筐体 (<see cref="Px4Userland.ParseJson"/> が一覧に足す)</summary>
    public static IReadOnlyList<Px4Userland.Enclosure> Owned() =>
        [.. Live<Px4Daemon>().Select(daemon => daemon._enclosure).OfType<Px4Userland.Enclosure>()];

    public override void Ensure()
    {
        if (Running) return;
        /*
         * **15V を出せるかは起こす前に一覧で聞いておく。** px4ctl list (LIST) には載らない。
         * 一覧は筐体を開かないが、起こしたあとだと OS によっては開けない。ロックの外で聞く —
         * 一覧は最悪 15 秒待つので、ロックの中だとその間 Dispose も選局も待たされる。
         * 使えない筐体の理由は Detect が残すので、ここでは黙る
         */
        var enclosure = Px4Userland.Enclosures(_ => { }).FirstOrDefault(found => found.Id == Id);
        var listed = enclosure?.Receivers;
        /*
         * USB ポートで見分ける筐体は、一覧に無いと起こせない (USB ポートを知る手段が一覧しか無い)。
         * USB ポートを変えると別の名前になるので、設定に書いた名前は見つからなくなる
         */
        if (Id.Contains('_') && enclosure is null)
        {
            throw new IOException($"{Px4Userland.Label(Id)} の筐体が見つかりません (抜けたか、USB ポートを変えた?)");
        }
        if (!File.Exists(Px4Userland.Firmware))
        {
            throw new IOException($"ファームウェアがありません: {Px4Userland.Firmware}"
                + (OperatingSystem.IsWindows() ? " (install.ps1 を流し直すと切り出します)" : ""));
        }
        var px4d = Px4Userland.Executable(Px4Userland.Dir, "px4d");
        if (!File.Exists(px4d)) throw new IOException($"px4-userland が入っていません: {px4d}");
        // ランタイムルートが px4d の決まりに合わなければ、px4d の分かりにくい INVALID_ARGUMENT の前に理由を言う
        if (Px4Userland.RuntimeProblem(Px4Userland.RuntimeDir, Id) is { } problem) throw new IOException(problem);

        Launch(px4d,
            [
                .. Select(enclosure),
                "--firmware", Px4Userland.Firmware,
                "--runtime-dir", Px4Userland.RuntimeDir,
                /*
                 * 15V を出してよいかのチェックは2段。ここは「指定されたら出す」で開けておき、
                 * 本当に指定するかどうかは設定の `lnb` で決める (TUNE で 15V を指定するのは
                 * `15v` と書いてあるチューナーだけ。Px4Tuner.TuneRequest)
                 */
                "--allow-lnb-power",
                /*
                 * Windows には SIGTERM が無い。標準入力が閉じたら後片付けして終わってもらう (px4-userland 0.2.0 から)。
                 * エージェントが落ちても px4d が USB を持ったまま残らない
                 */
                .. OperatingSystem.IsWindows() ? ["--exit-on-stdin-eof"] : Array.Empty<string>(),
            ],
            Px4Userland.RuntimeDir,
            () => Control("status", TimeSpan.FromSeconds(5)).Code == 0,
            () =>
            {
                _enclosure = enclosure;
                Receivers = WithLnb(AskReceivers(), listed);
            },
            stopByStdin: OperatingSystem.IsWindows(),
            hint: Px4Userland.Hint);
    }

    /// <summary>
    /// 筐体が抜けた (DISCONNECTED / USB_IO) と言われたのに px4d がまだ動いていれば止める。次に要ったときに起こし直す
    /// (px4-userland は「同じ px4d のままの USB の繋ぎ直しは確かめていない」と言っている)
    /// </summary>
    public void Lost()
    {
        if (!Running) return;
        Write("筐体が抜けたと言われたので止めます。次の選局で起こし直します");
        Stop();
    }

    /// <summary>
    /// px4d にどの筐体かを伝える引数。番号が一意なら <c>--device</c> だけ、重なるならUSB ポートと
    /// ソケットの置き場の名前も (px4-userland SPEC 4.1。<c>--usb-path</c> には <c>--instance</c> が要る)
    /// </summary>
    private string[] Select(Px4Userland.Enclosure? enclosure) => enclosure is { UsbPaths.Count: > 0 }
        ? ["--device", enclosure.Serial, .. enclosure.UsbPaths.SelectMany(path => new[] { "--usb-path", path }), "--instance", Id]
        : ["--device", Id];

    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        Px4Userland.Executable(Px4Userland.Dir, "px4ctl"),
        // USB ポートで起こした筐体は、ソケットの置き場の名前で呼ぶ (番号で呼ぶと別の筐体に繋がりうる)
        [Id.Contains('_') ? "--instance" : "--device", Id, "--runtime-dir", Px4Userland.RuntimeDir, command],
        timeout);

    /// <summary>
    /// 筐体に聞いた受信機に、一覧で聞いた 15V の可否を写す。一覧に無い受信機 (一覧を聞けなかった) は
    /// null のまま
    /// </summary>
    internal static List<Px4Receiver>? WithLnb(List<Px4Receiver>? asked, IReadOnlyList<Px4Receiver>? listed) =>
        asked?.Select(receiver => receiver with
        {
            Lnb15v = listed?.FirstOrDefault(entry => entry.Index == receiver.Index)?.Lnb15v,
        }).ToList();

    /// <summary><c>px4ctl list</c> で受信機を聞く。聞けなければ null (理由は記録に)</summary>
    private List<Px4Receiver>? AskReceivers()
    {
        var (code, output) = Control("list", TimeSpan.FromSeconds(5));
        if (code == 0) return ListReceivers(output, "px4ctl list");
        Write($"受信機を聞けません (px4ctl list exit {code}: {output})");
        return null;
    }
}

/// <summary>
/// px4-userland の受信機1つ。**px4d の制御ソケットで受信機を取り、取ったまま選局し直す。**
///
/// <para>
/// 最初の選局で <c>ACQUIRE → TUNE → START_STREAM → ATTACH_STREAM</c>、2回目からは
/// <c>STOP_STREAM → TUNE → START_STREAM → ATTACH_STREAM</c> (px4-userland SPEC 6.3)。
/// 返すのは <see cref="Dispose"/> (<c>RELEASE</c>) のときだけ (返すと px4d が電源を落とし、次の選局が遅くなる)。
/// TS は <c>stream.sock</c> に来る (<see cref="Px4Stream"/>)。誰も読まなくなったら TS のストリームだけ畳み、
/// 次の選局は同じ lease で選局し直す (<see cref="Tuned"/>)。docs/agent.md「px4-userland の作り」
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
    /// TUNE が BUSY で返ったときに待ち直す上限。前の TS のストリームの後始末 (閉じた stream.sock を
    /// px4d が畳む) と行き違うと、ほんの一瞬だけ BUSY になる
    /// </summary>
    private static readonly TimeSpan BusyRetry = TimeSpan.FromSeconds(1);

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly string _runtimeDir;
    private readonly Func<IReadOnlyList<Px4Receiver>?> _prepare;
    private readonly string _name;

    /// <summary>話す相手 (px4d か asicend)。IPC は同じで、枠の頭とソケットの置き場だけ違う</summary>
    private readonly Px4Wire _wire;

    /// <summary>設定の <c>device</c> (注意書きの鍵。<see cref="Px4Userland.Notice"/>)</summary>
    private readonly string _device;

    /// <summary>筐体が抜けたと言われたときに呼ぶ (px4d を止めて、次の選局で起こし直す。<see cref="Px4Daemon.Lost"/>)</summary>
    private readonly Action? _lost;
    private readonly Lock _gate = new();

    /// <summary>受信機を取っている制御ソケット。null なら取っていない</summary>
    private Px4Control? _control;

    private ulong _lease;
    private byte[] _nonce = [];

    /// <summary>START_STREAM が通ってから STOP_STREAM を言うまで</summary>
    private bool _started;

    private Px4Stream? _stream;

    /// <summary>15V を落としたことを記録に残したか (<see cref="WarnLnb"/>)</summary>
    private bool _lnbWarned;

    /// <summary>STATS を聞く目覚まし。流している間だけ (<see cref="StartStats"/>)</summary>
    private Timer? _statsTimer;

    /// <summary>前に聞いた数。**増えたぶんだけ記録に残す** (<see cref="Px4Counters.Describe"/>)</summary>
    private Px4Counters? _counters;

    public Px4Tuner(string id, int receiver, string? lnb)
        : this(id, receiver, lnb, Px4Userland.RuntimeDir, () =>
        {
            var daemon = Px4Daemon.For(id);
            daemon.Ensure();
            return daemon.Receivers;
        }, lost: () => Px4Daemon.For(id).Lost())
    {
    }

    /// <param name="prepare">
    /// 選局の前に呼ぶ。px4d を起こして、筐体に聞いた受信機を返す (聞けていなければ null)。
    /// テストは px4d のふりをするので何もしない
    /// </param>
    /// <param name="wire">話す相手。省けば px4d。asicen-userland の機材は <see cref="Px4Wire.Asicen"/> (Asicen.cs)</param>
    /// <param name="device">設定の <c>device</c>。省けば <c>px4:&lt;番号&gt;:&lt;受信機&gt;</c></param>
    /// <param name="name">記録に出す名前。省けば <c>px4-&lt;番号の末尾4桁&gt; #&lt;受信機&gt;</c></param>
    /// <param name="lost">筐体が抜けた (DISCONNECTED / USB_IO) と言われたときに呼ぶ。省けば何もしない</param>
    internal Px4Tuner(
        string id, int receiver, string? lnb, string runtimeDir, Func<IReadOnlyList<Px4Receiver>?> prepare,
        Px4Wire? wire = null, string? device = null, string? name = null, Action? lost = null)
    {
        _lost = lost;
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _runtimeDir = runtimeDir;
        _prepare = prepare;
        _wire = wire ?? Px4Wire.Px4;
        _device = device ?? Px4Userland.Device(id, receiver);
        _name = name ?? $"px4-{Px4Userland.Tail(id)} #{receiver}";
    }

    /// <summary>読む側がいないまま溜めが空かなければ、この時間で TS のストリームを畳む</summary>
    internal TimeSpan StallLimit { get; init; } = Px4Stream.DefaultStallLimit;

    /// <summary>
    /// 流している間に STATS を聞く間隔。**誤りが増えたときだけ記録に残す** — 画面で途切れたとき、
    /// 受信機の側で落ちていたのか、届き方が揺れただけなのかを見分ける (#1210)
    /// </summary>
    internal TimeSpan StatsEvery { get; init; } = TimeSpan.FromSeconds(30);

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    /// <summary>
    /// 受信機を取っていて、TS がまだ流れているか。**ロックの下で読む** — <c>Dispose</c> は別の
    /// ロック (<c>TunerPool._deviceGate</c>) から来るので、畳んでいる最中のものに触らないように
    /// </summary>
    public bool Tuned
    {
        get
        {
            lock (_gate) return _control is not null && _stream is { Ended: false };
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
    /// <c>slot</c> で (CS は1本しか入っていないので 0)。使わないほうは 0xffff。
    /// 帯域は地上波が 6MHz、衛星は 0 (px4d がこれ以外を断る)。
    /// 15V は設定に <c>15v</c> と書いてあるチューナーだけ指定する (<c>11v</c> は px4-userland に無い)。
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
    /// 選局する。**取っていれば取ったまま、切れていれば取り直す。**
    ///
    /// <para>
    /// 取っていたはずの接続が切れていた (px4d が起こし直された・lease が無い) ときは、
    /// その場で1度だけ取り直して続ける。同期しなかった (TIMEOUT) ときは受信機を取ったまま
    /// 投げる — 総当たりのスキャンは同期しないチャンネルのほうが多く、そのたびに返すと
    /// 電源の入れ直しからやり直しになる。
    /// </para>
    /// </summary>
    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            var receivers = _prepare();
            Check(receivers, _receiver, tuning);
            var lnb = Lnb(receivers, _receiver, tuning, _lnb);
            if (lnb != _lnb) WarnLnb();
            DropStream();
            var reused = _control is not null;
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

    /// <summary>
    /// TUNE で指定する LNB。**15V を出せない受信機なら、15V と書いてあっても 0V で選局する。**
    ///
    /// <para>
    /// px4-userland 0.1.8 から、1受信機の機種 (PX-M1UR / DTV02-1T1S-U など) は 15V の指定を
    /// <c>--allow-lnb-power</c> があっても UNSUPPORTED で断る (給電の経路が無い。SPEC 4.2)。
    /// そのまま指定すると衛星の選局が全部落ち、EPG の取り直しもスキャンも衛星だけ通らなくなる。
    /// 断る代わりに 0V で合わせるのは、この機種は 0V での衛星受信を対応範囲にしていて、
    /// アンテナは別の機器 (ほかのチューナー・ブースター・分配器) から給電されていることが多いから。
    /// 給電が無ければ「同期しませんでした」で落ちるので、なぜ 0V なのかは記録と画面に残す
    /// (<see cref="WarnLnb"/>)。可否が分からない (null) ときは言われたとおり指定する。
    /// </para>
    /// </summary>
    public static string? Lnb(IReadOnlyList<Px4Receiver>? receivers, int index, ChannelTable.Tuning tuning, string? lnb)
    {
        if (lnb != "15v" || !tuning.Satellite) return lnb;
        var receiver = receivers?.FirstOrDefault(r => r.Index == index);
        return receiver?.Lnb15v == false ? null : lnb;
    }

    /// <summary>15V を落としたことを残す。**記録は1度だけ** (局替えのたびに出すと埋もれる)、画面には出し続ける</summary>
    private void WarnLnb()
    {
        const string notice = "この受信機は LNB に 15V を出せないので、0V で選局しています (設定の LNB 15V は効きません。アンテナへの給電はほかの機器から)";
        Px4Userland.SetNotice(_device, this, notice);
        if (_lnbWarned) return;
        _lnbWarned = true;
        Log.Write($"[{_name}] {notice}");
    }

    /// <summary>
    /// 制御ソケットごと失くした (px4d のエラーの答えではない、または lease がもう無い)。
    /// **TS のストリームの失敗 (<see cref="Px4StreamError"/>) は入れない** — 制御ソケットは生きていて、
    /// 黙って取り直すと「接続が切れていた」と嘘の記録が残る
    /// </summary>
    private static bool Lost(IOException error) => error switch
    {
        Px4StreamError => false,
        Px4Error failed => failed.Code == Px4Error.NotFound,
        _ => true,
    };

    /// <summary>
    /// 受信機を取ったまま次に進める失敗か。同期しなかった・指定が合わなかった (TUNE)、
    /// ATTACH は通ったが TS が駄目だった (<see cref="Px4StreamError.KeepsLease"/>)。それ以外は受信機を返して閉じる
    /// </summary>
    private static bool Keeps(IOException error) =>
        error is Px4StreamError { KeepsLease: true } || error is Px4Error { Code: Px4Error.Timeout or Px4Error.InvalidArgument };

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
            if (error is Px4Error { Code: Px4Error.UsbIo or Px4Error.Disconnected }) _lost?.Invoke();
            throw;
        }
    }

    /// <summary>繋いで受信機を取る (HELLO → ACQUIRE)</summary>
    private void Open()
    {
        var control = Px4Control.Connect(
            Px4Control.Endpoint(_runtimeDir, _id, "control.sock", _wire), Px4Control.StreamStatsCapability, RequestTimeout, _wire);
        try
        {
            var answer = control.Request(Px4Control.Acquire, [(byte)_receiver]);
            if (answer.Length != 24) throw new IOException($"{_wire.Daemon} の ACQUIRE の答えが {answer.Length} バイトです (24 のはず)");
            var lease = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            if (lease == 0) throw new IOException($"{_wire.Daemon} の ACQUIRE の答えの lease が 0 です");
            _lease = lease;
            _nonce = answer[8..24];
        }
        catch (Px4Error error)
        {
            control.Dispose();
            throw new Px4Error(error.Code, $"受信機 {_receiver} を取れません ({error.Message})");
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
    private byte[] Lease() => Px4Control.WithId(_lease);

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
                Counted(control.Request(Px4Control.StopStream, lease, RequestTimeout));
            }
            catch (Px4Error error) when (error.Code == Px4Error.NotReady)
            {
                // もう止まっている (閉じた stream.sock を px4d が先に畳んだ)
            }
            _started = false;
        }

        var tune = TuneRequest(_lease, tuning, streamId, lnb);
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
                throw new Px4Error(Px4Error.Timeout, ITuneDevice.SyncFailed);
            }
        }
        // u8 locked, i32 cnr_mdb。px4d は同期したときしか成功で答えないが、px4-ts と同じく locked も見る
        if (answer.Length < 1 || answer[0] == 0) throw new Px4Error(Px4Error.Timeout, ITuneDevice.SyncFailed);

        control.Request(Px4Control.StartStream, lease, RequestTimeout);
        _started = true;
        _counters = null;
        _stream = Px4Stream.Attach(
            Px4Control.Endpoint(_runtimeDir, _id, "stream.sock", _wire), _lease, _nonce, _name, StallLimit, FirstTsGrace, _wire);
        StartStats(control);
    }

    /// <summary>
    /// 流している間、STATS を <see cref="StatsEvery"/> ごとに聞く。**px4d が STATS を持っていなければ聞かない**
    /// (HELLO で認められた機能に無い。テストの偽物もこれ)
    /// </summary>
    private void StartStats(Px4Control control)
    {
        StopStats();
        if ((control.Capabilities & Px4Control.StreamStatsCapability) == 0) return;
        _statsTimer = new Timer(_ => PollStats(), null, StatsEvery, StatsEvery);
    }

    private void StopStats()
    {
        _statsTimer?.Dispose();
        _statsTimer = null;
    }

    /// <summary>
    /// STATS を1回聞く。**制御ソケットは選局と同じ錠の下で使う** (1本で同時に1つしか送れない)。
    /// 聞けなくても流れは止めない — 繋がりの不具合なら次の選局が見つける
    /// </summary>
    private void PollStats()
    {
        lock (_gate)
        {
            if (_control is not { } control || !_started || _stream is not { Ended: false } || _statsTimer is null) return;
            try
            {
                Counted(control.Request(Px4Control.Stats, Lease(), RequestTimeout));
            }
            catch (IOException error)
            {
                Log.Write($"[{_name}] {_wire.Daemon} に TS の数を聞けませんでした。もう聞きません ({error.Message})");
                StopStats();
            }
        }
    }

    /// <summary>STATS・STOP_STREAM の答え (数) を読み、**誤りが増えていたら記録に残す**</summary>
    private void Counted(byte[] answer)
    {
        if (Px4Counters.Parse(answer) is not { } now) return;
        if (Px4Counters.Describe(_counters, now) is { } grew) Log.Write($"[{_name}] {_wire.Daemon} の TS の数: {grew}");
        _counters = now;
    }

    /// <summary>
    /// 筐体に聞いた受信機と、要求された選局が合っているか。**合わなければ px4d に送る前に断る。**
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
    /// TS のストリームを畳む。**stream.sock を閉じるのは TUNE より前に。** nonce は lease の間ずっと
    /// 同じなので、前の stream.sock の後始末を px4d が次の START_STREAM より後に回すと、
    /// 新しいストリームのほうを取り消してしまう (px4d は閉じた接続の後始末で同じ lease と nonce の
    /// ストリームを取り消す)。先に閉じておけば、px4d は TUNE に答えるより前にそれを見る
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
        StopStats();
        DropStream();
        var control = _control;
        _control = null;
        if (control is null) return;
        var lease = Lease();
        try
        {
            if (_started) Counted(control.Request(Px4Control.StopStream, lease, RequestTimeout));
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
        // 設定が変わって閉じるときも通る。新しい定義で 15V をやめていれば、もう出さない
        Px4Userland.ClearNotice(_device, this);
    }
}

/// <summary>
/// 受信機を取ったままの間に、TS のストリームが駄目だった (ATTACH を断られた・TS が来なかった)。
/// **受信機は返さない** — 次の選局で同じ lease のまま STOP_STREAM → TUNE からやり直せる
/// </summary>
internal sealed class Px4StreamError(string message, bool keepsLease) : IOException(message)
{
    /// <summary>
    /// 受信機を取ったまま次に進めるか。**ATTACH_STREAM が通っていれば (ストリームが active) 進める** —
    /// 次の STOP_STREAM で畳める。通らなかったときは px4d の lease が「armed」のまま残り、
    /// TUNE も START_STREAM も BUSY で返るようになる (px4d は armed の期限切れを ATTACH でしか
    /// 見ない) ので、返して取り直すしかない
    /// </summary>
    public bool KeepsLease { get; } = keepsLease;
}

/// <summary>
/// px4d から TS を受け取る1回ぶん (START_STREAM 1回につき1つ)。
///
/// <para>
/// <c>stream.sock</c> に繋いで ATTACH_STREAM (lease と nonce) を送ると、あとは px4d が
/// TS_DATA の枠を送り続け、止めると STREAM_END が来る (SPEC 6.3 / 6.4)。枠の中身はソケットから
/// <see cref="Pipe"/> のメモリ (<see cref="PipeWriter.GetMemory"/>) へ直に受け、読み出し側はその読む側 (<see cref="DeviceStream"/>)。
/// OS の pipe は使わない (Windows に poll が無く、深さも OS ごとに違った) ので、溜めの深さは <see cref="Depth"/> で決め打つ。
/// </para>
///
/// <para>
/// **読む側がいないと溜めが埋まる。** 書けないまま <see cref="DefaultStallLimit"/> 経ったら
/// stream.sock を閉じて終わる。放っておくと px4d の溜め (地上波で5秒ほど) が溢れて SLOW_CONSUMER になるが、
/// その通知 (STREAM_END) も読まないソケットの奥に詰まって届かない。こちらで見切る。
/// </para>
/// </summary>
internal sealed class Px4Stream
{
    /// <summary>溜めが空かないまま待つ上限。px4d の溜めが溢れるのと同じくらい</summary>
    public static readonly TimeSpan DefaultStallLimit = TimeSpan.FromSeconds(5);

    /// <summary>
    /// 溜めの深さ。前の Linux の pipe (<c>F_SETPIPE_SZ</c> で広げた 8MB) と同じで、地上波で 3.5 秒ぶん。
    /// これを超えたら書く側が待つ
    /// </summary>
    internal const int Depth = 8 * 1024 * 1024;

    /// <summary>
    /// TS がこれだけ来なければ終わる。px4-ts と同じ5秒。**溜めに書けずに待っている間は数えない**
    /// (そちらは <see cref="DefaultStallLimit"/>)
    /// </summary>
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(5);

    /// <summary>TS_DATA の中身の頭 (u64 sequence, u64 cumulative_drop_count, u32 byte_count)</summary>
    private const int TsHeaderSize = 20;

    private readonly Socket _socket;
    private readonly string _name;
    private readonly TimeSpan _stallLimit;
    private readonly Px4Wire _wire;
    private readonly ManualResetEventSlim _first = new();

    private readonly Pipe _pipe = NewBuffer();

    /// <summary>
    /// 溜め (<see cref="Depth"/>)。待ちは Inline で起こす (スレッドプールに回さない。pump は専用のスレッドで、
    /// 読む側も 200ms ごとに自分で起きる)。CECH-ZD1 J の TS も同じ溜めに詰める (Zd1jStream)
    /// </summary>
    internal static Pipe NewBuffer() => new(new PipeOptions(
        pauseWriterThreshold: Depth,
        resumeWriterThreshold: Depth * 3 / 4,
        minimumSegmentSize: 64 * 1024,
        readerScheduler: PipeScheduler.Inline,
        writerScheduler: PipeScheduler.Inline,
        useSynchronizationContext: false));

    private Thread? _pump;
    private volatile bool _stopped;
    private volatile bool _ended;
    private volatile string? _reason;

    /// <summary>ATTACH_STREAM が通ったか (px4d の側でストリームが active になった)</summary>
    private bool _attached;

    /// <summary>溜めに1枚でも書けたか (Attach が待つのはこれ)</summary>
    private volatile bool _delivered;
    private ulong _sequence;

    public DeviceStream Output { get; }

    /// <summary>ストリームが終わった (px4d が止めた・切れた・読む側がいなくて畳んだ・こちらで止めた)</summary>
    public bool Ended => _ended;

    private Px4Stream(Socket socket, string name, TimeSpan stallLimit, Px4Wire wire)
    {
        _socket = socket;
        _name = name;
        _stallLimit = stallLimit;
        _wire = wire;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
    }

    /// <summary>
    /// 繋いで ATTACH_STREAM を送り、**最初の TS が来るまで待つ。** 来なければ理由を添えて
    /// <see cref="Px4StreamError"/> を投げる (繋いだものは閉じてある)
    /// </summary>
    public static Px4Stream Attach(
        string socketPath, ulong lease, byte[] nonce, string name, TimeSpan stallLimit, TimeSpan firstTs, Px4Wire? wire = null)
    {
        wire ??= Px4Wire.Px4;
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = 4000,
            ReceiveTimeout = 4000,
        };
        var stream = new Px4Stream(socket, name, stallLimit, wire);
        try
        {
            Px4Control.ConnectWithin(socket, socketPath, TimeSpan.FromSeconds(4), wire);
            var payload = Px4Control.WithId(lease, 8 + nonce.Length);
            nonce.CopyTo(payload, 8);
            // px4-ts と同じく request_id 0。最初の枠は ATTACH_STREAM でなければならない (HELLO は無い)
            Px4Control.SendAll(socket, Px4Control.Encode(Px4Control.AttachStream, 0, 0, payload, wire));
            var (type, flags, _, body) = Px4Control.ReadFrame(socket, Px4Control.MaxPayload, wire);
            if (type != Px4Control.AttachStream || (flags & Px4Control.ResponseFlag) == 0)
            {
                throw new IOException($"{wire.Daemon} から ATTACH_STREAM の答えではないものが来ました (型 0x{type:x4})");
            }
            if ((flags & Px4Control.ErrorFlag) != 0) throw Px4Control.Failed(body, wire);
            stream._attached = true;
            // 待つのは pump のほう。ここからは Poll で起きるので、読むときの上限は途中で詰まったときだけ
            socket.ReceiveTimeout = (int)SilenceLimit.TotalMilliseconds;
            // **専用のスレッドで。** 流れている間ずっと塞ぐ
            stream._pump = new Thread(stream.Pump) { IsBackground = true, Name = $"{name} TS" };
            stream._pump.Start();
        }
        catch (Exception error) when (error is IOException or SocketException)
        {
            socket.Dispose();
            throw new Px4StreamError($"{wire.Daemon} から TS を受け取れません ({error.Message})", stream._attached);
        }

        if (!stream._first.Wait(firstTs))
        {
            stream.Stop();
            throw new Px4StreamError($"同期したのに TS が {firstTs.TotalSeconds:F0} 秒来ません", keepsLease: true);
        }
        // 1枚でも渡せていれば成功。すぐ後に終わっても、読む側は TS を読んでから理由を受け取る
        if (!stream._delivered)
        {
            var reason = stream._reason ?? $"{wire.Daemon} との TS の接続が切れました";
            stream.Stop();
            throw new Px4StreamError(reason, keepsLease: true);
        }
        return stream;
    }

    private void Pump()
    {
        var writer = _pipe.Writer;
        Span<byte> header = stackalloc byte[Px4Control.HeaderSize];
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
                var (type, flags, _, length) = Px4Control.ReadHeader(_socket, header, Px4Control.MaxTsPayload, _wire);
                if (type != Px4Control.TsData)
                {
                    // TS_DATA 以外 (STREAM_END) は小さい。いつもどおり byte[] で受ける
                    if (length > Px4Control.MaxPayload)
                    {
                        End($"{_wire.Daemon} の枠が長すぎます (型 0x{type:x4}、{length} バイト)");
                        return;
                    }
                    var body = new byte[length];
                    Px4Control.Receive(_socket, body, _wire);
                    if (type == Px4Control.StreamEnd && body.Length >= 68)
                    {
                        // final counters (u64 × 8) のあとに u32 error_code。**誤りがあれば数も残す** (途切れの切り分けに)
                        if (Px4Counters.Parse(body) is { } final && Px4Counters.Describe(null, final) is { } errors)
                        {
                            Log.Write($"[{_name}] {_wire.Daemon} の TS の数 (止まるまで): {errors}");
                        }
                        var code = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(64));
                        End(code == 0 ? $"{_wire.Daemon} が TS を止めました" : $"{_wire.Daemon} が TS を止めました ({Px4Control.Reason(code)})");
                        return;
                    }
                }
                if (type != Px4Control.TsData || flags != 0 || length < TsHeaderSize)
                {
                    End($"{_wire.Daemon} から知らない枠が来ました (型 0x{type:x4})");
                    return;
                }
                // u64 sequence, u64 cumulative_drop_count, u32 byte_count, bytes
                Px4Control.Receive(_socket, ts, _wire);
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
                    End($"{_wire.Daemon} が TS を {dropped} 回捨てました ({Px4Control.Reason(Px4Error.SlowConsumer)})");
                    return;
                }
                if (sequence != _sequence)
                {
                    End($"{_wire.Daemon} の TS_DATA の番号が飛びました ({_sequence} のはずが {sequence})");
                    return;
                }
                _sequence++;
                // 中身は溜めのメモリに直に受ける。途中で切れたら渡さずに終わる (Advance しない)
                var size = (int)count;
                Px4Control.Receive(_socket, writer.GetMemory(size).Span[..size], _wire);
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

    /// <summary>
    /// 書いたぶんを読む側に渡す。**溜めが空かないまま <see cref="_stallLimit"/> 経ったら諦める** (読む側がいない)。
    /// 止めろと言われたらすぐ降りる (50ms ごとに見る)
    /// </summary>
    private bool Flush(PipeWriter writer)
    {
        var flushing = writer.FlushAsync();
        FlushResult result;
        if (flushing.IsCompleted)
        {
            result = flushing.GetAwaiter().GetResult();
        }
        else
        {
            var waiting = flushing.AsTask();
            var stalled = Stopwatch.StartNew();
            while (!waiting.Wait(50))
            {
                if (_stopped)
                {
                    writer.CancelPendingFlush();
                    return false;
                }
                if (stalled.Elapsed >= _stallLimit)
                {
                    writer.CancelPendingFlush();
                    End($"読む側がいないまま {_stallLimit.TotalSeconds:F0} 秒経ったので TS のストリームを閉じました (受信機は取ったまま)");
                    return false;
                }
            }
            result = waiting.GetAwaiter().GetResult();
        }
        if (result.IsCompleted)
        {
            // 読み出し側が閉じた (こちらで止めた。理由は End が残さない)
            End("TS を渡せません (読み出し側が閉じました)");
            return false;
        }
        return !result.IsCanceled;
    }

    /// <summary>終わった理由を残す。**こちらで止めたときは残さない** (読む側には普通の終わり)</summary>
    private void End(string reason)
    {
        if (_stopped) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>
    /// 止める。pump を降ろして stream.sock を閉じ、読みかけの読む側が戻ってから溜めを閉じる
    /// (<see cref="DeviceStream.WaitReaders"/>、長くても <see cref="ChildTs.ReaderDrain"/>。
    /// 抜けかけの読む側が閉じた溜めに触らないように)。**局替えのたびに通る**ので、固定では待たない
    /// </summary>
    public void Stop()
    {
        /*
         * **理由は消さない。** ここから先は End が理由を残さない (_stopped) ので、残っているのは
         * 止める前に向こうから終わった理由だけ。読む側が溜めの残りを読み切る前に次の選局が
         * 来ても、読む側には「px4d が TS を止めました (…)」が届く
         */
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
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
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}
