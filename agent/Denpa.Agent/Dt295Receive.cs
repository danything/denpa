using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Denpa.Agent;

/*
 * PIX-DT295 の受信 (TRC。仕様書 9 章) に要る、公式パッケージの zip からは取れない 2 つ。どちらもコードではなくデータとして読む。
 *
 * - フィールド表 (12.5): 受信設定の領域に当てる (アドレス、シフト、幅、値) の並び。**使う人が置くファイル** (dt295-fields.json)。
 *   中身はここには書かない。無ければ選局は NoFields で断る (機材には触らない)。
 * - TS の IV (12.7): StationTV X (PIXELA の公式アプリ) の中にあるとされる 16 バイト。インストールされた StationTV X のファイルから
 *   SHA-256 の一致で探し、見つかれば置き場に写しておく。
 */

/// <summary>フィールド表の 1 行 (12.5)。部分書き換え (3.2) で当てる</summary>
public readonly record struct Dt295Field(ushort Address, int Shift, int Width, int Value);

/// <summary>フィールド表 (12.5)。読むときに形を確かめる</summary>
public sealed class Dt295FieldTable
{
    /// <summary>12.5 の 8 バイトの並び (アドレス LE16・シフト・幅・値 LE16・0 が 2 バイト) にした、参照実装の標準の表の SHA-256</summary>
    public const string ReferenceSha256 = "c06867bfec29c1269141b269138e4a9baf16c7dda8a4d74c8cbd933aa8815d4b";

    /// <summary>DMA の入力選択 (0x1002 のビット 8〜9)。最終値で一時停止の状態番号が決まる (9.3)</summary>
    private const ushort InputSelect = 0x1002;

    public IReadOnlyList<Dt295Field> Rows { get; }

    /// <summary>一時停止の状態番号 (9.3 の最後。1 なら 3、0 なら 4)</summary>
    public ushort Pause { get; }

    public Dt295FieldTable(IReadOnlyList<Dt295Field> rows)
    {
        if (rows.Count == 0) throw new InvalidDataException("フィールド表が空です");
        ushort input = 0;
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Address is < 0x1000 or > 0x1AFE || row.Address % 2 != 0) throw new InvalidDataException($"フィールド表の {i} 行目: アドレス 0x{row.Address:X4} は 0x1000〜0x1AFE の偶数ではありません");
            ushort applied;
            try
            {
                applied = Dt295Bridge.Field(row.Address == InputSelect ? input : (ushort)0, row.Shift, row.Width, row.Value);
            }
            catch (ArgumentOutOfRangeException error)
            {
                throw new InvalidDataException($"フィールド表の {i} 行目: {error.Message}");
            }
            if (row.Address == InputSelect) input = applied;
        }
        Pause = ((input >> 8) & 0x3) switch
        {
            1 => 3,
            0 => 4,
            var other => throw new InvalidDataException($"フィールド表で 0x1002 のビット 8〜9 が {other} になります (0 か 1 のはず。9.3)"),
        };
        Rows = rows;
    }

    /// <summary>領域を 0 で埋めたあとに、先頭から順に当てる (9.3 の手順 2)</summary>
    public void Apply(Dt295Bridge bridge)
    {
        foreach (var row in Rows) bridge.Modify16(row.Address, row.Shift, row.Width, row.Value);
    }

    /// <summary>12.5 の 8 バイトの並びにした SHA-256 (参照実装の表と同じかを記録に出すため)</summary>
    public string Sha256()
    {
        var bytes = new byte[Rows.Count * 8];
        for (var i = 0; i < Rows.Count; i++)
        {
            var at = bytes.AsSpan(i * 8);
            BinaryPrimitives.WriteUInt16LittleEndian(at, Rows[i].Address);
            at[2] = (byte)Rows[i].Shift;
            at[3] = (byte)Rows[i].Width;
            BinaryPrimitives.WriteUInt16LittleEndian(at[4..], (ushort)Rows[i].Value);
        }
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    /// <summary>
    /// JSON から読む: <c>{"fields": [{"address": "0x1002", "shift": 8, "width": 2, "value": 1}, …]}</c>。
    /// 数は 10 進でも <c>"0x…"</c> の文字列でもよい。ほかの項目 (<c>name</c> など) は読まない
    /// </summary>
    public static Dt295FieldTable Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("fields", out var fields) || fields.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("フィールド表に fields の配列がありません");
            }
            var rows = new List<Dt295Field>();
            foreach (var field in fields.EnumerateArray())
            {
                var address = Number(field, "address", rows.Count);
                if (address is < 0 or > 0xFFFF) throw new InvalidDataException($"フィールド表の {rows.Count} 行目: アドレスが 16 ビットに収まりません");
                rows.Add(new Dt295Field((ushort)address, Number(field, "shift", rows.Count), Number(field, "width", rows.Count), Number(field, "value", rows.Count)));
            }
            return new Dt295FieldTable(rows);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException($"フィールド表の JSON が読めません ({error.Message})");
        }
    }

    private static int Number(JsonElement row, string name, int index)
    {
        if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty(name, out var value)) throw new InvalidDataException($"フィールド表の {index} 行目に {name} がありません");
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
        if (value.ValueKind == JsonValueKind.String && value.GetString() is { } text
            && text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(text.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var hex))
        {
            return hex;
        }
        throw new InvalidDataException($"フィールド表の {index} 行目の {name} が数ではありません");
    }
}

/// <summary>受信に要るもの (フィールド表と TS の IV)</summary>
public sealed record Dt295ReceiveData(Dt295FieldTable Fields, byte[] TsIv);

/// <summary>受信に要るものを置き場 (tuners.json の隣) とインストールされた StationTV X から揃える</summary>
public static class Dt295Receive
{
    public const string FieldsFile = "dt295-fields.json";
    public const string IvFile = "dt295-ts-iv.bin";

    /// <summary>StationTV X のファイルを写して置ける場所 (置き場の下。Windows 以外で使う)</summary>
    public const string AppFolder = "stationtvx";

    /// <summary>TS の IV の確かめ (12.7)</summary>
    internal const string TsIvSha256 = "69a206b3bbcd395b81b201f762355fb224c4e9e16439090663b8dfc1f5b03301";

    public static string NoFields(string folder) =>
        $"{Dt295.Model} の受信にはフィールド表が要ります (まだ未対応)。{Path.Combine(folder, FieldsFile)} を置くと使います";

    public static string NoIv(string folder) =>
        $"{Dt295.Model} の受信に要る値が StationTV X から見つかりません。PIXELA の StationTV X をインストールするか、"
        + $"そのフォルダーを {Path.Combine(folder, AppFolder)} に写してください";

    private static readonly Lazy<Dt295ReceiveStore> Default = new(() =>
        new Dt295ReceiveStore(Dt295Firmware.Folder, AppFolders(Dt295Firmware.Folder), TimeProvider.System));

    /// <summary>揃えて返す。揃わなければ理由を添えて <see cref="IOException"/></summary>
    public static Dt295ReceiveData Ensure() => Default.Value.Ensure();

    /// <summary>StationTV X を探す場所。置き場の下の写しと、Windows ならインストール先</summary>
    internal static List<string> AppFolders(string folder)
    {
        List<string> folders = [Path.Combine(folder, AppFolder)];
        if (OperatingSystem.IsWindows())
        {
            foreach (var root in new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles })
            {
                var path = Environment.GetFolderPath(root);
                if (path.Length > 0) folders.Add(Path.Combine(path, "PIXELA"));
            }
        }
        return [.. folders.Distinct(StringComparer.OrdinalIgnoreCase)];
    }
}

/// <summary>
/// 置き場 1 つ。フィールド表は毎回読み直す (置いたらすぐ使えるように)。TS の IV は置き場の写しを使い、無ければ StationTV X から探して写す。
/// 見つからなければ <see cref="Dt295Firmware.Backoff"/> のあいだ探し直さない (探すのに時間がかかる)
/// </summary>
internal sealed class Dt295ReceiveStore(string folder, IReadOnlyList<string> apps, TimeProvider clock)
{
    /// <summary>探すファイル。大きすぎるものは読まない</summary>
    private static readonly string[] Extensions = [".exe", ".dll", ".ax", ".bin", ".dat"];

    private const long FileLimit = 64L << 20;

    private readonly Lock _gate = new();
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;
    private string? _fieldsHash;

    public Dt295ReceiveData Ensure()
    {
        lock (_gate)
        {
            var fields = Fields() ?? throw new IOException(Dt295Receive.NoFields(folder));
            var iv = Iv() ?? throw new IOException(Dt295Receive.NoIv(folder));
            return new Dt295ReceiveData(fields, iv);
        }
    }

    private Dt295FieldTable? Fields()
    {
        var path = Path.Combine(folder, Dt295Receive.FieldsFile);
        if (!File.Exists(path)) return null;
        Dt295FieldTable table;
        try
        {
            table = Dt295FieldTable.Parse(File.ReadAllText(path));
        }
        catch (InvalidDataException error)
        {
            throw new IOException($"{path}: {error.Message}", error);
        }
        var hash = table.Sha256();
        if (hash != _fieldsHash)
        {
            _fieldsHash = hash;
            Log.Write($"{Dt295.Model} のフィールド表を読みました ({table.Rows.Count} 行{(hash == Dt295FieldTable.ReferenceSha256 ? "。参照実装の表と同じ" : "")})");
        }
        return table;
    }

    private byte[]? Iv()
    {
        var path = Path.Combine(folder, Dt295Receive.IvFile);
        if (File.Exists(path))
        {
            var cached = File.ReadAllBytes(path);
            if (Matches(cached)) return cached;
        }
        if (clock.GetUtcNow() < _retryAt) return null;
        var found = Search();
        if (found is null)
        {
            _retryAt = clock.GetUtcNow() + Dt295Firmware.Backoff;
            return null;
        }
        try
        {
            Directory.CreateDirectory(folder);
            File.WriteAllBytes(path, found);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Log.Write($"{path} に写せません ({error.Message})。次も探し直します");
        }
        return found;
    }

    private static bool Matches(ReadOnlySpan<byte> data) =>
        data.Length == 16 && Convert.ToHexStringLower(SHA256.HashData(data)) == Dt295Receive.TsIvSha256;

    /// <summary>StationTV X のファイルの 16 バイトの窓を全部、SHA-256 で確かめる</summary>
    private byte[]? Search()
    {
        var expected = Convert.FromHexString(Dt295Receive.TsIvSha256);
        Span<byte> hash = stackalloc byte[32];
        foreach (var app in apps.Where(Directory.Exists))
        {
            Log.Write($"{Dt295.Model} の受信に要る値を {app} から探します");
            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(app, "*", SearchOption.AllDirectories)
                    .Where(file => Extensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase))
                    .Order(StringComparer.Ordinal)
                    .ToList();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Log.Write($"{app} を読めません ({error.Message})");
                continue;
            }
            foreach (var file in files)
            {
                byte[] data;
                try
                {
                    if (new FileInfo(file).Length > FileLimit) continue;
                    data = File.ReadAllBytes(file);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    continue;
                }
                for (var at = 0; at + 16 <= data.Length; at++)
                {
                    SHA256.HashData(data.AsSpan(at, 16), hash);
                    if (hash.SequenceEqual(expected))
                    {
                        Log.Write($"{Dt295.Model} の受信に要る値を {Path.GetFileName(file)} で見つけました");
                        return data.AsSpan(at, 16).ToArray();
                    }
                }
            }
        }
        return null;
    }
}
