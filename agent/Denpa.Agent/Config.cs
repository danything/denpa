using System.Text.Json;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 繋いである機材1台ぶん。
///
/// <para>
/// **選局コマンドそのものは持たない。** 画面から書き換えられるようにした以上、
/// 自由な文字列を受けると「denpa に入れた人がチューナー側で好きなコマンドを
/// 走らせられる」ことになる (しかもあちらは機材に触れる。Helm では privileged)。持つのは
/// **デバイスと種別と LNB**だけ。選局は自分でやる (Tuning.cs)。
/// </para>
/// </summary>
public sealed record TunerSpec(
    string Name,
    string[] Types,
    bool Disabled,
    string? Device = null,
    string? Lnb = null)
{
    public JsonObject ToJson()
    {
        var node = new JsonObject
        {
            ["name"] = Name,
            ["types"] = Json.Strings(Types),
            ["disabled"] = Disabled,
            ["device"] = Device,
        };
        if (!string.IsNullOrEmpty(Lnb)) node["lnb"] = Lnb;
        return node;
    }

    /// <summary>
    /// 1台ぶんを読む。名前が無ければ null。**型が違えば <see cref="FormatException"/>** (どの項目かを添える)
    /// </summary>
    public static TunerSpec? FromJson(JsonNode? node)
    {
        if (node is not JsonObject item) return null;
        var name = Text(item["name"], "name") ?? "";
        if (name.Length == 0) return null;

        string[] types = item["types"] switch
        {
            null => [],
            JsonArray list => [.. list.Select(entry => Text(entry, $"{name}: types の中身")).OfType<string>().Where(type => type.Length > 0)],
            _ => throw new FormatException($"{name}: types は文字列の配列にします"),
        };
        return new TunerSpec(
            name,
            types,
            Flag(item["disabled"], $"{name}: disabled") ?? false,
            Text(item["device"], $"{name}: device"),
            Text(item["lnb"], $"{name}: lnb"));
    }

    private static string? Text(JsonNode? node, string what) => node switch
    {
        null => null,
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        _ => throw new FormatException($"{what} は文字列にします"),
    };

    private static bool? Flag(JsonNode? node, string what) => node switch
    {
        null => null,
        JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
        _ => throw new FormatException($"{what} は true か false にします"),
    };
}

/// <summary>
/// 設定ファイル2つ。**どちらも JSON で、どちらも denpa が書く。**
///
/// <list type="bullet">
/// <item><c>tuners.json</c> … 繋いである機材。画面から編集する</item>
/// <item><c>channels.json</c> … スキャンで分かったこと</item>
/// </list>
///
/// <para>
/// **YAML ではなく JSON。** 画面から書き換えるので、コメントを守るより書き戻せて壊れにくいほうがいい。
/// </para>
///
/// <para>
/// 中身を作るのはどちらもこちらではない。総当たりの選局こそ任されるが、NIT も
/// SDT も解析しないので「何があったか」は分からない。それでも控えを持つのはこちら側
/// にする — アンテナに何が映るかも、何台刺さっているかも、機材ごとの話だから。
/// </para>
/// </summary>
public sealed class Config(string tunersFile, string channelsFile)
{
    public string TunersFile { get; } = tunersFile;
    public string ChannelsFile { get; } = channelsFile;

    /// <summary>CECH-ZD1 J がチャンネルごとに覚えたロックの値 (tuners.json の隣。消してよい。Zd1j.cs の <see cref="Zd1jLocks"/>)</summary>
    public string Zd1jLocksFile => Path.Combine(Path.GetDirectoryName(Path.GetFullPath(TunersFile))!, "zd1j-locks.json");

    /// <summary>
    /// px4-userland の機材に流し込む IT930x のファームウェアを、取ってきて置く場所 (tuners.json の隣。
    /// イメージには入れない。<see cref="Px4Firmware"/>)
    /// </summary>
    public string Px4FirmwareFile => Path.Combine(Path.GetDirectoryName(Path.GetFullPath(TunersFile))!, Px4Firmware.FileName);

    public static Config FromEnvironment() => new(
        Environment.GetEnvironmentVariable("TUNERS_FILE") ?? Path.Combine(DefaultDir(), "tuners.json"),
        Environment.GetEnvironmentVariable("CHANNELS_FILE") ?? Path.Combine(DefaultDir(), "channels.json"));

    /// <summary>
    /// 変数が無いときの置き場。Linux はコンテナの <c>/config</c>。Mac と Windows はインストーラと同じ
    /// <c>DENPA_HOME</c> (既定 <c>~/denpa</c>) の <c>config</c> — 常駐を止めて手で <c>--tune</c> などを流したときに、
    /// 書けない <c>/config</c> を見に行かず、常駐と同じファイルを使う
    /// </summary>
    private static string DefaultDir() => OperatingSystem.IsLinux()
        ? "/config"
        : Path.Combine(
            Environment.GetEnvironmentVariable("DENPA_HOME")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "denpa"),
            "config");

    private static JsonArray ReadArray(string path, string? key)
    {
        // まだ無い。空でよい (画面が「まだありません」と出す)
        if (!File.Exists(path)) return [];
        try
        {
            var parsed = JsonNode.Parse(File.ReadAllText(path));
            var found = key is null ? parsed : (parsed as JsonObject)?[key];
            if (found is JsonArray list) return list;
            Log.Write($"{path} の形式が違うので読みませんでした ({(key is null ? "配列" : $"{key} の配列")}が必要です)");
            return [];
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            // 起動できないよりは空として続ける。ただ黙って自動検出に戻ると気づけないので残す
            Log.Write($"{path} を読めませんでした。無いものとして続けます: {error.Message}");
            return [];
        }
    }

    internal static void WriteAtomic(string path, JsonNode body)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // 書きかけを読ませない。GET /denpa/channels や選局 (TSID を引く) は、書いている最中にもこのファイルを読みに来る
        var working = $"{path}.writing";
        File.WriteAllText(working, body.ToJsonString(Json.Pretty));
        File.Move(working, path, overwrite: true);
    }

    public List<TunerSpec> LoadTuners()
    {
        var tuners = new List<TunerSpec>();
        foreach (var item in ReadArray(TunersFile, "tuners"))
        {
            try
            {
                if (TunerSpec.FromJson(item) is { } tuner) tuners.Add(tuner);
            }
            catch (FormatException error)
            {
                // 1台の書き損じで全部を捨てない
                Log.Write($"{TunersFile} の1台を飛ばしました: {error.Message}");
            }
        }
        return tuners;
    }

    /// <summary>
    /// 画面から預かった機材で置き換える。
    ///
    /// <para>
    /// **空を渡すと設定そのものを消す。** そのまま「自動検出に戻す」になる。
    /// 1台も無い状態を書き込めるようにしておくより、無い状態=自分で探す、の
    /// ほうが後で困らない。
    /// </para>
    /// </summary>
    public void SaveTuners(List<TunerSpec> tuners)
    {
        if (tuners.Count == 0)
        {
            if (File.Exists(TunersFile)) File.Delete(TunersFile);
            Log.Write("チューナーの定義を消しました (次からは自動検出)");
            return;
        }

        WriteAtomic(TunersFile, new JsonObject { ["tuners"] = new JsonArray([.. tuners.Select(tuner => (JsonNode)tuner.ToJson())]) });
        Log.Write($"チューナーの定義を保存しました: {tuners.Count} 台");
    }

    /// <summary>
    /// 機材を決める。**書いてあればそれ、無ければ自分で見つける。**
    ///
    /// <para>
    /// 自動で分かるのは「刺さっているデバイスと、それが受けられる方式」だけ。
    /// LNB を足したい・1台だけ止めたい、は人にしか決められないので、そのときは画面から書く。
    /// </para>
    /// </summary>
    public (List<TunerSpec> Tuners, bool Detected) ResolveTuners()
    {
        var written = LoadTuners();
        if (written.Count > 0) return (written, false);

        var found = DeviceProbe.Detect();
        Log.Write(found.Count == 0
            ? $"チューナーが見つかりません ({TunersFile} に書けば、そちらを使います)"
            : $"{TunersFile} に定義が無いので、刺さっている機材を使います:");
        foreach (var tuner in found) Log.Write($"  {tuner.Name} [{string.Join(", ", tuner.Types)}] {tuner.Device}");
        return (found, true);
    }

    /// <summary>並べ替えの順。知らない種別は後ろに送る</summary>
    private static int TypeOrder(JsonNode entry) => entry["type"]?.GetValue<string>() switch
    {
        "GR" => 0,
        "BS" => 1,
        "CS" => 2,
        _ => 9,
    };

    public JsonArray LoadChannels() => ReadArray(ChannelsFile, null);

    /// <summary>
    /// チャンネル名から、スキャンで分かった TSID を引く。衛星の選局で相対番号を TSID に直すのに使い、
    /// 埋め込んだ表より優先する (<see cref="ChannelTable.StreamId"/>)
    /// </summary>
    public Func<string, int?> StreamIds()
    {
        var table = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in LoadChannels())
        {
            var channel = entry?["channel"]?.GetValue<string>();
            var id = entry?["transportStreamId"]?.GetValue<int>();
            if (channel is not null && id is > 0) table[channel] = id.Value;
        }
        return name => table.TryGetValue(name, out var id) ? id : null;
    }

    /// <summary>
    /// 預かった顔ぶれで差し替える。
    ///
    /// <para>
    /// **探した種別だけ**を入れ替え、他はそのまま残す。地上波だけスキャンした
    /// ときに全部を置き換えると、BS と CS が設定から消える (実際に消して、
    /// BS の予約が録れなくなった)。
    /// </para>
    /// </summary>
    public JsonArray SaveChannels(JsonArray found, HashSet<string> scanned)
    {
        var entries = LoadChannels().OfType<JsonNode>()
            .Where(kept => !scanned.Contains(kept["type"]?.GetValue<string>() ?? ""))
            .Concat(found.OfType<JsonNode>())
            .Select(entry => entry.DeepClone())
            // 種別ごとにまとまっているほうが読みやすい (画面もこの順で出る)
            .OrderBy(TypeOrder)
            .ThenBy(entry => entry["channel"]?.GetValue<string>() ?? "", StringComparer.Ordinal);
        JsonArray merged = [.. entries];
        WriteAtomic(ChannelsFile, merged);
        return merged;
    }
}
