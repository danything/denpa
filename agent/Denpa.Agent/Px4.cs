using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
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
/// 受けられるかは <c>px4d --list-json</c> に聞く (<see cref="Enclosures"/>)。USB ID や
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

    /// <summary>
    /// 刺さっている筐体1台。
    ///
    /// <para>
    /// <c>Id</c> は設定の <c>px4:&lt;Id&gt;:&lt;受信機&gt;</c> に入る名前で、px4d のソケットの置き場の名前でもある。
    /// 番号が一意なら番号そのもの。**番号が重なる筐体** (PX-M1UR と PX-S1UR はどれも <c>000000000000001</c>) は
    /// 挿し口を足した名前 (<see cref="AliasOf"/>) にして、px4d を <c>--usb-path</c> と <c>--instance</c> で起こす
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
    }

    /// <summary>
    /// 番号が重なる筐体の名前。**番号と挿し口** (<c>000000000000001_1-2.3</c>)。
    ///
    /// <para>
    /// px4d の <c>--instance</c> にそのまま使えるよう、英数字と <c>_ - .</c> だけにする
    /// (px4-userland SPEC 4.1)。挿し口が <c>BUS:ADDRESS</c> でしか分からないときは <c>b1a6</c> と書く。
    /// **挿し口を変えると別の筐体になる** (px4-userland も「抜き差し後の物理個体を保証しない」と言っている)
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

    /// <summary>
    /// <c>px4:00001205000960:2</c> を割る。形が違えば null。
    ///
    /// <para>
    /// 番号の桁数や受信機の上限は見ない。**それを知っているのは px4-userland** で、
    /// 合わなければ px4d が理由を付けて断る。
    /// </para>
    /// </summary>
    public static (string Id, int Receiver)? Parse(string device) => Parse(device, Scheme, ValidId);

    /// <summary><c>&lt;頭&gt;&lt;筐体&gt;:&lt;受信機&gt;</c> を割る (<c>asicen:</c> も同じ形)。形が違えば null</summary>
    internal static (string Id, int Receiver)? Parse(string device, string scheme, Func<string, bool> validId)
    {
        if (!device.StartsWith(scheme, StringComparison.Ordinal)) return null;
        var parts = device[scheme.Length..].Split(':');
        if (parts.Length != 2 || !validId(parts[0])) return null;
        if (!int.TryParse(parts[1], out var receiver) || receiver < 0) return null;
        return (parts[0], receiver);
    }

    private static bool Digits(string value) => value.Length > 0 && value.All(char.IsAsciiDigit);

    /// <summary>番号そのもの、または番号と挿し口 (<see cref="AliasOf"/>)</summary>
    internal static bool ValidId(string id)
    {
        var cut = id.IndexOf('_');
        if (cut < 0) return Digits(id);
        return Digits(id[..cut]) && id.Length <= 80 && cut < id.Length - 1
            && id[(cut + 1)..].All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');
    }

    /// <summary>
    /// 画面で筐体を見分ける短い名前。番号の末尾4桁、**番号が重なる筐体は挿し口**
    /// (末尾4桁が同じなので見分けにならない)
    /// </summary>
    public static string Label(string id)
    {
        var cut = id.IndexOf('_');
        return cut < 0 ? id[^4..] : $"USB {id[(cut + 1)..].Replace('_', '/')}";
    }

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string id, int receiver) => $"{model}-{Label(id)} #{receiver}";

    /// <summary>
    /// 刺さっている筐体。**<c>px4d --list-json</c> に聞く。**
    ///
    /// <para>
    /// 読むだけで筐体を掴まないので、px4d が動いていても聞ける。px4-userland が
    /// 入っていない環境 (手元の開発など) では空。
    /// </para>
    ///
    /// <para>
    /// <c>--list-json</c> は px4-userland 0.1.9 から (SPEC 4.6 v0.26)。テキストの <c>--list</c> は
    /// いずれ廃止すると言われていて、読まない。同梱するのは 0.1.9 以上 (Dockerfile / install.sh) なので、
    /// <c>PX4_USERLAND_DIR</c> で古い px4d を指したときだけ筐体が挙がらない (理由は記録に残る)。
    /// </para>
    /// </summary>
    /// <param name="warn">使えない筐体の理由を残す先。省けば記録 (<see cref="Log"/>)</param>
    public static List<Enclosure> Enclosures(Action<string>? warn = null)
    {
        warn ??= Log.Write;
        var px4d = Path.Combine(Dir, "px4d");
        if (!File.Exists(px4d)) return [];
        var (code, output) = Shell.Run(px4d, ["--list-json"], TimeSpan.FromSeconds(15));
        if (code != 0)
        {
            warn($"px4-userland の筐体を挙げられません (px4d --list-json exit {code}: {output})");
            return [];
        }
        try
        {
            return ParseJson(output, warn);
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            // 文書として読めないときだけ。形の違いは ParseJson が読めたところまで使う
            warn($"px4d --list-json の答えが読めません ({error.Message})");
            return [];
        }
    }

    /// <summary>
    /// <c>px4d --list-json</c> の出力を読む (px4-userland SPEC 4.6 v0.26)。**使えるのは <c>status=ready</c> の筐体。**
    /// 番号が重なる筐体 (<c>serial_unique=false</c>) は挿し口で見分ける (<see cref="AliasOf"/>)。
    ///
    /// <para>
    /// <c>{"enclosures":[{serial, model, usb, status, serial_unique, devices, candidates, receivers}],
    /// "ungrouped_usb_devices":[…]}</c> の1行。<c>schema_version</c> は無く、消費側は知らない鍵を
    /// 無視する決まり。**形が違っても止まらない** — 無い鍵・型の違う値は既定で埋めて読み進め、
    /// 版ずれを疑う旨を1度だけ <paramref name="warn"/> で残す。止めるのは筐体の番号と受信機の番号
    /// (それが無いと <c>px4:&lt;番号&gt;:&lt;受信機&gt;</c> が作れない) が読めないときだけで、それも
    /// その筐体・受信機だけを飛ばす。
    /// </para>
    ///
    /// <para>
    /// 出力は stdout と stderr を繋げたもの (<see cref="Shell.Run"/>) なので、<c>{</c> で始まる最初の行を
    /// 文書とみなす。libusb が stderr に何か言っても読めるように。
    /// </para>
    /// </summary>
    /// <exception cref="JsonException">JSON として読めない</exception>
    /// <exception cref="FormatException">文書が無い・object でない</exception>
    public static List<Enclosure> ParseJson(string output, Action<string> warn)
    {
        var line = output.Split('\n').Select(raw => raw.Trim()).FirstOrDefault(raw => raw.StartsWith('{'))
            ?? throw new FormatException("JSON の文書がありません");
        var root = JsonNode.Parse(line) as JsonObject ?? throw new FormatException("JSON の文書が object ではありません");
        var shape = new JsonShape();
        var found = new List<Enclosure>();

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
            // 無ければ一意とみなす (版ずれとしては残る)。番号が重なれば px4d が起動を断る (exit 2) だけ
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
                        .Select(device => (shape.Text(device, "port", "devices[]", optional: true),
                            shape.Number(device, "bus", "devices[]", optional: true),
                            shape.Number(device, "address", "devices[]", optional: true)))));

            /*
             * **番号が重なる筐体は、挿し口で見分ける。** px4d には挿し口 (`--usb-path`) と、ソケットの
             * 置き場の名前 (`--instance`) を渡す。番号だけを選択子として控えるな、と SPEC 4.6 にある
             */
            IReadOnlyList<string> paths = [];
            var alias = id;
            if (!unique && status == "ready" && Digits(id))
            {
                var places = devices.Select(device =>
                    device.Port is { Length: > 0 } port ? (Path: port, Name: port)
                    : device.Bus is { } bus && device.Address is { } address ? (Path: $"{bus}:{address}", Name: $"b{bus}a{address}")
                    : default).ToList();
                if (places.Count is 0 or > 2 || places.Any(place => place.Path is null))
                {
                    warn($"{model} {id} は使えません。同じ番号の筐体がほかにも刺さっていて、挿し口も分からないので"
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
                found.Add(new Enclosure(alias, model, receivers, id, paths));
            }
        }

        foreach (var item in shape.Array(root, "ungrouped_usb_devices", ""))
        {
            if (item is not JsonObject device)
            {
                shape.Skew("ungrouped_usb_devices[] が object ではない");
                continue;
            }
            Rejected(
                shape.Text(device, "model", "ungrouped_usb_devices[]"),
                shape.Text(device, "usb", "ungrouped_usb_devices[]"),
                shape.Text(device, "status", "ungrouped_usb_devices[]") ?? "",
                Where([(shape.Text(device, "port", "ungrouped_usb_devices[]", optional: true),
                    shape.Number(device, "bus", "ungrouped_usb_devices[]", optional: true),
                    shape.Number(device, "address", "ungrouped_usb_devices[]", optional: true))]),
                warn);
        }

        if (shape.Notes.Count > 0)
        {
            warn($"px4d --list-json の形が思っていたのと違います (px4-userland の版がずれている?)。読めたところだけ使います: {string.Join(", ", shape.Notes)}");
        }
        return found;
    }

    /// <summary>
    /// JSON の値を拾う。**形が違えば null を返し、違ったことを <see cref="Notes"/> に溜める。**
    /// 反射で型に流し込む道 (JsonSerializer) は Native AOT で使えないので、木 (<c>JsonNode</c>) を直に読む
    /// </summary>
    private sealed class JsonShape
    {
        public SortedSet<string> Notes { get; } = new(StringComparer.Ordinal);

        public void Skew(string note) => Notes.Add(note);

        /// <summary>
        /// 鍵の値。無い・型が違う・(<paramref name="optional"/> でなければ) null は版ずれとして残す。
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

        public string? Text(JsonObject obj, string key, string where, bool optional = false)
        {
            var value = Value(obj, key, where, optional);
            if (value is null) return null;
            if (value.TryGetValue<string>(out var text)) return text;
            Skew($"{where}.{key} が文字列ではない");
            return null;
        }

        public int? Number(JsonObject obj, string key, string where, bool optional = false)
        {
            var value = Value(obj, key, where, optional);
            if (value is null) return null;
            if (value.TryGetValue<int>(out var number)) return number;
            Skew($"{where}.{key} が整数ではない");
            return null;
        }

        public bool? Flag(JsonObject obj, string key, string where, bool optional = false)
        {
            var value = Value(obj, key, where, optional);
            if (value is null) return null;
            if (value.TryGetValue<bool>(out var flag)) return flag;
            Skew($"{where}.{key} が真偽値ではない");
            return null;
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
    /// 筐体を使うか決める。使わないなら理由を残す。
    ///
    /// <para>
    /// 番号が重なる筐体 (<c>serial_unique=false</c>) も使う。PX-M1UR と PX-S1UR はどれも USB の serial が
    /// <c>000000000000001</c> で、番号のままだと同じ <c>px4:000000000000001:0</c> が2冊でき、
    /// <c>px4d --device</c> も番号だけでは1台に決められず断る (exit 2)。そこで挿し口を足した名前にする
    /// (<see cref="ParseJson"/>)。前は使わずに理由だけ残していて、Home Assistant のアドオンが
    /// px4d / px4ctl を差し替えるラッパーで補っていた。
    /// </para>
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
            + (status == "open_failed" ? " (/dev/bus/usb を開く権限が無いかもしれません)" : ""));

    /// <summary>
    /// USB の場所を理由に添える形にする (<c>, USB 1-2.3</c>)。同じ番号のものが並んだとき、どれの話か分かるように。
    /// 何も取れなければ空
    /// </summary>
    private static string Where(IEnumerable<(string? Port, int? Bus, int? Address)> places)
    {
        var named = places
            .Select(place => place.Port ?? (place.Bus is { } bus && place.Address is { } address ? $"{bus}:{address}" : null))
            .OfType<string>()
            .ToArray();
        return named.Length == 0 ? "" : $", USB {string.Join(" / ", named)}";
    }

    /// <summary>刺さっている筐体の受信機を、設定に書いたのと同じ形で</summary>
    public static List<TunerSpec> Detect() => Specs(Enclosures());

    /// <summary>筐体の一覧から、設定の形に組み立てる</summary>
    public static List<TunerSpec> Specs(IEnumerable<Enclosure> enclosures) =>
    [
        .. enclosures.SelectMany(enclosure => enclosure.Receivers
            .Where(receiver => receiver.Types.Length > 0)
            .Select(receiver => new TunerSpec(
                Name(enclosure.Model, enclosure.Id, receiver.Index), receiver.Types, false, Device(enclosure.Id, receiver.Index)))),
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
    /// <paramref name="owner"/> が出したものだけ消す。設定を変えて開き直すとき、古い本の後始末が
    /// 新しい本の出したものを消さないように (文は同じなので、出した者で見分ける)
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
/// 受信機1本。**<c>px4d --list-json</c> / <c>px4ctl list</c> で px4-userland に聞いたもの。**
///
/// <para>
/// Q3U4 は受信機ごとに地上波か衛星かが決まっていて、MLT5 系はどれも両方受けられる
/// (選局のたびに切り替える)。その違いはここに入ってくるだけで、こちらは機種を見ない。
/// </para>
///
/// <para>
/// <c>Lnb15v</c> は LNB に 15V を出せるか (<c>lnb_15v_supported</c>、px4-userland 0.1.9 から)。
/// **分からなければ null** で、そのときは頼まれたとおり頼む (合わなければ px4d が断る)。
/// <c>px4ctl list</c> には載らない (IPC の形は変えないと SPEC 4.1 v0.26) ので、筐体の一覧から写す
/// (<see cref="Px4Daemon.Ensure"/>)。
/// </para>
/// </summary>
public sealed record Px4Receiver(int Index, bool Terrestrial, bool Satellite, bool? Lnb15v = null)
{
    public string[] Types => [.. Terrestrial ? ["GR"] : Array.Empty<string>(), .. Satellite ? ["BS", "CS"] : Array.Empty<string>()];

    public bool Accepts(ChannelTable.Tuning tuning) => tuning.Satellite ? Satellite : Terrestrial;

    /// <summary>
    /// <c>px4ctl list</c> の出力 (<c>siano-ts --list</c> の受信機の行も同じ形) を読む。
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
    /// <c>siano-ts --list</c> の機材の行 (Siano.cs) も同じ形
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
        switch (system)
        {
            case "ISDB-T":
                return new Px4Receiver(number, true, false, lnb15v);
            case "ISDB-S":
                return new Px4Receiver(number, false, true, lnb15v);
            case "ISDB-T/S":
                return new Px4Receiver(number, true, true, lnb15v);
            default:
                warn($"受信機 {number} の方式 {system} を知りません (px4-userland が新しい?)。この受信機は使いません");
                return null;
        }
    }
}

/// <summary>
/// 筐体を持つ常駐 (<c>px4d</c> / <c>asicend</c>)。**筐体1台につき1つ、起こしたら止めるまで居る。**
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

    protected string Id { get; } = id;
    private readonly Lock _gate = new();
    private Process? _process;
    private volatile string _stderr = "";

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
    protected void Launch(string program, IReadOnlyList<string> args, string runtimeDir, Func<bool> ready, Action onReady)
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
            _ = Task.Run(() => process.StandardOutput.ReadToEndAsync());

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

    /// <summary>受信機の行 (<c>px4ctl list</c> の形) を読んで記録に残す。1本も読めなければ null</summary>
    protected List<Px4Receiver>? ListReceivers(string output, string command)
    {
        var receivers = Px4Receiver.ParseList(output, Write);
        if (receivers.Count == 0)
        {
            Write($"受信機を聞けません ({command}: {output})");
            return null;
        }
        Write($"受信機 {receivers.Count} 本: " + string.Join(", ", receivers.Select(r => $"#{r.Index} {string.Join("/", r.Types)}")));
        return receivers;
    }

    /// <summary>
    /// 止める。**SIGTERM で。** px4d / asicend は合図を受けると後片付け (LNB を 0V に戻す・
    /// socket を消す) をしてから終わる。SIGKILL だとそこが保証されない
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
        List<UserlandDaemon> daemons;
        lock (Registry) daemons = [.. All.Values];
        foreach (var daemon in daemons) daemon.Stop();
    }
}

/// <summary>
/// <c>px4d</c> 1つ。**ready になったら受信機を聞く** (<c>px4ctl list</c>、<see cref="UserlandDaemon.Receivers"/>)。
/// 何本あって何を受けられるかは筐体の答えを使う。
/// </summary>
public sealed class Px4Daemon(string id) : UserlandDaemon("px4d", id)
{
    public static Px4Daemon For(string id) => For(id, () => new Px4Daemon(id));

    public override void Ensure()
    {
        if (Running) return;
        /*
         * **15V を出せるかは起こす前に一覧で聞いておく。** px4ctl list (LIST) には載らない。
         * 一覧は筐体を掴まないが、起こしたあとだと OS によっては開けない。錠の外で聞く —
         * 一覧は最悪 15 秒待つので、錠の中だとその間 Dispose も選局も待たされる。
         * 使えない筐体の理由は Detect が残すので、ここでは黙る
         */
        var enclosure = Px4Userland.Enclosures(_ => { }).FirstOrDefault(found => found.Id == Id);
        var listed = enclosure?.Receivers;
        /*
         * 挿し口で見分ける筐体は、一覧に居ないと起こせない (挿し口を知る手段が一覧しか無い)。
         * 挿し口を変えると別の名前になるので、設定に書いた名前は見つからなくなる
         */
        if (Id.Contains('_') && enclosure is null)
        {
            throw new IOException($"{Px4Userland.Label(Id)} の筐体が見つかりません (抜けたか、挿し口を変えた?)");
        }
        if (!File.Exists(Px4Userland.Firmware))
        {
            throw new IOException($"ファームウェアがありません: {Px4Userland.Firmware}");
        }
        var px4d = Path.Combine(Px4Userland.Dir, "px4d");
        if (!File.Exists(px4d)) throw new IOException($"px4-userland が入っていません: {px4d}");

        Launch(px4d,
            [
                .. Select(enclosure),
                "--firmware", Px4Userland.Firmware,
                "--runtime-dir", Px4Userland.RuntimeDir,
                /*
                 * 15V を出してよいかの門は2段。ここは「頼まれたら出す」で開けておき、
                 * 本当に頼むかどうかは設定の `lnb` で決める (TUNE で 15V を頼むのは
                 * `15v` と書いてある本だけ。Px4Tuner.TuneRequest)
                 */
                "--allow-lnb-power",
            ],
            Px4Userland.RuntimeDir,
            () => Control("status", TimeSpan.FromSeconds(5)).Code == 0,
            () => Receivers = WithLnb(AskReceivers(), listed));
    }

    /// <summary>
    /// px4d にどの筐体かを伝える引数。番号が一意なら <c>--device</c> だけ、重なるなら挿し口と
    /// ソケットの置き場の名前も (px4-userland SPEC 4.1。<c>--usb-path</c> には <c>--instance</c> が要る)
    /// </summary>
    private string[] Select(Px4Userland.Enclosure? enclosure) => enclosure is { UsbPaths.Count: > 0 }
        ? ["--device", enclosure.Serial, .. enclosure.UsbPaths.SelectMany(path => new[] { "--usb-path", path }), "--instance", Id]
        : ["--device", Id];

    private (int Code, string Output) Control(string command, TimeSpan timeout) => Shell.Run(
        Path.Combine(Px4Userland.Dir, "px4ctl"),
        // 挿し口で起こした筐体は、ソケットの置き場の名前で呼ぶ (番号で呼ぶと別の筐体に繋がりうる)
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

    /// <summary>話す相手 (px4d か asicend)。IPC は同じで、枠の頭とソケットの置き場だけ違う</summary>
    private readonly Px4Wire _wire;

    /// <summary>設定の <c>device</c> (注意書きの鍵。<see cref="Px4Userland.Notice"/>)</summary>
    private readonly string _device;
    private readonly Lock _gate = new();

    /// <summary>受信機を借りている制御ソケット。null なら借りていない</summary>
    private Px4Control? _control;

    private ulong _lease;
    private byte[] _nonce = [];

    /// <summary>START_STREAM が通ってから STOP_STREAM を言うまで</summary>
    private bool _started;

    private Px4Stream? _stream;

    /// <summary>15V を落としたことを記録に残したか (<see cref="WarnLnb"/>)</summary>
    private bool _lnbWarned;

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
    /// <param name="wire">話す相手。省けば px4d。asicen-userland の機材は <see cref="Px4Wire.Asicen"/> (Asicen.cs)</param>
    /// <param name="device">設定の <c>device</c>。省けば <c>px4:&lt;番号&gt;:&lt;受信機&gt;</c></param>
    /// <param name="name">記録に出す名前。省けば <c>px4-&lt;番号の末尾4桁&gt; #&lt;受信機&gt;</c></param>
    internal Px4Tuner(
        string id, int receiver, string? lnb, string runtimeDir, Func<IReadOnlyList<Px4Receiver>?> prepare,
        Px4Wire? wire = null, string? device = null, string? name = null)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _runtimeDir = runtimeDir;
        _prepare = prepare;
        _wire = wire ?? Px4Wire.Px4;
        _device = device ?? Px4Userland.Device(id, receiver);
        _name = name ?? $"px4-{id[^4..]} #{receiver}";
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
                Log.Write($"[{_name}] {_wire.Daemon} との接続が切れていたので、受信機を借り直します ({error.Message})");
                Attempt(tuning, streamId, lnb);
            }
        }
    }

    /// <summary>
    /// TUNE で頼む LNB。**15V を出せない受信機なら、15V と書いてあっても 0V で選局する。**
    ///
    /// <para>
    /// px4-userland 0.1.8 から、1受信機の機種 (PX-M1UR / DTV02-1T1S-U など) は 15V の頼みを
    /// <c>--allow-lnb-power</c> があっても UNSUPPORTED で断る (給電の経路が無い。SPEC 4.2)。
    /// そのまま頼むと衛星の選局が全部落ち、EPG の取り直しもスキャンも衛星だけ通らなくなる。
    /// 断る代わりに 0V で合わせるのは、この機種は 0V での衛星受信を対応範囲にしていて、
    /// アンテナは別の機器 (ほかのチューナー・ブースター・分配器) から給電されていることが多いから。
    /// 給電が無ければ「同期しませんでした」で落ちるので、なぜ 0V なのかは記録と画面に残す
    /// (<see cref="WarnLnb"/>)。可否が分からない (null) ときは頼まれたとおり頼む。
    /// </para>
    /// </summary>
    public static string? Lnb(IReadOnlyList<Px4Receiver>? receivers, int index, ChannelTable.Tuning tuning, string? lnb)
    {
        if (lnb != "15v" || !tuning.Satellite) return lnb;
        var receiver = receivers?.FirstOrDefault(r => r.Index == index);
        return receiver?.Lnb15v == false ? null : lnb;
    }

    /// <summary>15V を落としたことを残す。**記録は1度だけ** (局替えのたびに出すと埋もれる)、画面には居る間ずっと</summary>
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

    /// <summary>繋いで受信機を借りる (HELLO → ACQUIRE)</summary>
    private void Open()
    {
        var control = Px4Control.Connect(Px4Control.Endpoint(_runtimeDir, _id, "control.sock", _wire), 0, RequestTimeout, _wire);
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

    /// <summary>STOP_STREAM / START_STREAM / RELEASE の中身 (lease だけ)</summary>
    private byte[] Lease()
    {
        var lease = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(lease, _lease);
        return lease;
    }

    /// <summary>(流していれば止めて) 合わせて、流し始めて、TS を受け取りにいく</summary>
    private void Run(ChannelTable.Tuning tuning, uint streamId, string? lnb)
    {
        var control = _control!;
        var lease = Lease();

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
                throw new Px4Error(Px4Error.Timeout, SyncFailed);
            }
        }
        // u8 locked, i32 cnr_mdb。px4d は同期したときしか成功で答えないが、px4-ts と同じく locked も見る
        if (answer.Length < 1 || answer[0] == 0) throw new Px4Error(Px4Error.Timeout, SyncFailed);

        control.Request(Px4Control.StartStream, lease, RequestTimeout);
        _started = true;
        _stream = Px4Stream.Attach(
            Px4Control.Endpoint(_runtimeDir, _id, "stream.sock", _wire), _lease, _nonce, _name, StallLimit, FirstTsGrace, _wire);
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
        var lease = Lease();
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
        // 設定が変わって閉じるときも通る。次の本が 15V をやめていれば、もう出さない
        Px4Userland.ClearNotice(_device, this);
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
    private readonly Px4Wire _wire;
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

    private Px4Stream(Socket socket, string name, TimeSpan stallLimit, Px4Wire wire)
    {
        _socket = socket;
        _name = name;
        _stallLimit = stallLimit;
        _wire = wire;
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
            var payload = new byte[8 + nonce.Length];
            BinaryPrimitives.WriteUInt64LittleEndian(payload, lease);
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
            stream.StartPump();
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
        // 1枚でも渡せていれば成功。すぐ後に終わっても、読み手は TS を読んでから理由を受け取る
        if (!stream._delivered)
        {
            var reason = stream._reason ?? $"{wire.Daemon} との TS の接続が切れました";
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
                    End($"{_wire.Daemon} から TS が {SilenceLimit.TotalSeconds:F0} 秒来ません");
                    return;
                }
                var (type, flags, _, body) = Px4Control.ReadFrame(_socket, Px4Control.MaxTsPayload, _wire);
                if (type == Px4Control.StreamEnd && body.Length >= 68)
                {
                    // final counters (u64 × 8) のあとに u32 error_code
                    var code = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(64));
                    End(code == 0 ? $"{_wire.Daemon} が TS を止めました" : $"{_wire.Daemon} が TS を止めました ({Px4Control.Reason(code)})");
                    return;
                }
                if (type != Px4Control.TsData || flags != 0 || body.Length < 20)
                {
                    End($"{_wire.Daemon} から知らない枠が来ました (型 0x{type:x4})");
                    return;
                }
                // u64 sequence, u64 cumulative_drop_count, u32 byte_count, bytes
                var sequence = BinaryPrimitives.ReadUInt64LittleEndian(body);
                var dropped = BinaryPrimitives.ReadUInt64LittleEndian(body.AsSpan(8));
                var count = BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(16));
                if (count != body.Length - 20 || count % 188 != 0)
                {
                    End($"{_wire.Daemon} の TS_DATA の長さが崩れています ({count} バイト)");
                    return;
                }
                if (dropped != 0)
                {
                    End($"{_wire.Daemon} が TS を {dropped} 回捨てました ({Px4Control.Reason(15)})");
                    return;
                }
                if (sequence != _sequence)
                {
                    End($"{_wire.Daemon} の TS_DATA の番号が飛びました ({_sequence} のはずが {sequence})");
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
            End($"{_wire.Daemon} との TS の接続が切れました ({error.Message})");
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
