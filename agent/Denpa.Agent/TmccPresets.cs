using System.Globalization;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// CXD2856ER の地上波のプリセット (Cxd2856.cs の <see cref="Cxd2856Frontend.TuneIsdbt"/>。仕様書 5.8) に使う TMCC の 13 バイト。
/// 周波数 (kHz) ごとに、TS がロックしたときに読んだ値を持つ。値は放送の組み方で決まり機材によらないので、機材と受信機をまたいで 1 つ。
///
/// <para>
/// 覚えていない周波数では、ほかの周波数で最後にロックしたときの値を代わりに渡す。同じ地域の地上波は TMCC がそろうことが多いため
/// (東京の実機で、放送のある 7 チャンネルが全部同じ値だった)。どの周波数の値も覚えていなければ (入れた直後など)、既定の値 (<see cref="DefaultTmcc"/>) を渡す。
/// 代わりの値 (ほかの周波数の値と既定の値) が合わなかった周波数には、このプロセスの間は代わりの値を渡さない。
/// </para>
///
/// <para>
/// ファイル (<see cref="Config.TmccPresetsFile"/>) に書き、再起動をまたぐ。書くのはロックして値が新しくなったときだけで、
/// 読めない・壊れているファイルは捨てて空から始める (選局し直しで覚え直すため)。既定の値は覚えた値ではないので書かない。
/// </para>
/// </summary>
public sealed class TmccPresets
{
    private const int Version = 1;

    /// <summary>
    /// どの周波数の値も覚えていないときに書く値。仕様書 5.8 にある <c>62</c>〜<c>6E</c> の既定の値 (Sony の資料のレジスタの既定)。
    /// 東京の実機 (PX-MLT8PE) で、放送のある地上波 7 チャンネルのどれも、ロックして読んだ値がこれと同じだった。
    /// 日本の地上波のふつうの組み方 (ワンセグとハイビジョン) を表していると推定している
    /// </summary>
    private static readonly byte[] DefaultTmcc = [0x3D, 0x25, 0x8B, 0x4B, 0x3F, 0xFF, 0x25, 0x8B, 0x4B, 0x3F, 0xFF, 0xFF, 0xFC];

    private readonly string? _path;
    private readonly Lock _gate = new();

    /// <summary>周波数ごとの値と、最後にロックした順 (大きいほど新しい)</summary>
    private readonly Dictionary<uint, (byte[] Tmcc, long Order)> _values = [];

    /// <summary>代わりの値が合わなかった周波数 (プロセスの中だけ)</summary>
    private readonly HashSet<uint> _noFallback = [];

    private long _order;

    /// <param name="path">ファイル。null なら書かない (メモリの上だけ)</param>
    public TmccPresets(string? path)
    {
        _path = path;
        if (path is null || !File.Exists(path)) return;
        try
        {
            var root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject
                ?? throw new FormatException("オブジェクトではありません");
            var version = root["version"]?.GetValue<int>();
            if (version != Version) throw new FormatException($"バージョンが {version?.ToString(CultureInfo.InvariantCulture) ?? "無し"} です ({Version} を読みます)");
            if (root["tmcc"] is not JsonObject values) throw new FormatException("tmcc がありません");
            // 後ろほど新しい
            foreach (var (key, node) in values)
            {
                if (!uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var khz)) throw new FormatException($"周波数「{key}」が読めません");
                var hex = node?.GetValue<string>() ?? throw new FormatException($"{key} の値がありません");
                var tmcc = Convert.FromHexString(hex);
                if (tmcc.Length != Cxd2856.TmccLength) throw new FormatException($"{key} の値が {tmcc.Length} バイトです ({Cxd2856.TmccLength} バイトを読みます)");
                _values[khz] = (tmcc, ++_order);
            }
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or FormatException or InvalidOperationException or ArgumentException or IOException or UnauthorizedAccessException)
        {
            Log.Write($"{path} を読めないので捨てて、空から覚え直します: {error.Message}");
            _values.Clear();
        }
    }

    /// <summary>
    /// その周波数で書く値と、その出どころ。覚えていればその値、無ければほかの周波数で最後にロックしたときの値、
    /// どの周波数の値も無ければ既定の値。代わりの値が合わなかった周波数では null (<see cref="TmccPresetSource.None"/>)
    /// </summary>
    public (byte[]? Tmcc, TmccPresetSource Source) For(uint khz)
    {
        lock (_gate)
        {
            if (_values.TryGetValue(khz, out var own)) return (own.Tmcc, TmccPresetSource.Own);
            if (_noFallback.Contains(khz)) return (null, TmccPresetSource.None);
            if (_values.Count == 0) return ([.. DefaultTmcc], TmccPresetSource.Default);
            return (_values.MaxBy(pair => pair.Value.Order).Value.Tmcc, TmccPresetSource.Other);
        }
    }

    /// <summary>その周波数で TS がロックしたときに読んだ値を覚える。値が新しくなったときだけファイルに書く</summary>
    public void Locked(uint khz, byte[] tmcc)
    {
        lock (_gate)
        {
            var changed = !_values.TryGetValue(khz, out var known) || !known.Tmcc.AsSpan().SequenceEqual(tmcc);
            _values[khz] = ([.. tmcc], ++_order);
            // 値が同じなら書かない。ファイルの順は、最後に書いたときの順になる
            if (changed) Save();
        }
    }

    /// <summary>
    /// <paramref name="tmcc"/> を書いた選局がロックしなかった。その周波数の値なら消す (その間にほかの受信機が覚え直した値は消さない)。
    /// 代わりの値 (ほかの周波数の値か既定の値) なら消さず、その周波数には次から代わりの値を渡さない
    /// </summary>
    public void Failed(uint khz, byte[] tmcc, TmccPresetSource source)
    {
        lock (_gate)
        {
            if (source != TmccPresetSource.Own) _noFallback.Add(khz);
            else if (_values.TryGetValue(khz, out var known) && ReferenceEquals(known.Tmcc, tmcc)) _values.Remove(khz);
        }
    }

    /// <summary>全部書く (古い順。置き換えは tuners.json と同じく、書きかけを読ませない形で)</summary>
    private void Save()
    {
        if (_path is null) return;
        var values = new JsonObject();
        foreach (var (khz, value) in _values.OrderBy(pair => pair.Value.Order))
        {
            values[khz.ToString(CultureInfo.InvariantCulture)] = Convert.ToHexString(value.Tmcc);
        }
        try
        {
            Config.WriteAtomic(_path, new JsonObject { ["version"] = Version, ["tmcc"] = values });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // 書けなくても選局は続ける。次に値が変わったときにまた書く
            Log.Write($"{_path} に書けません: {error.Message}");
        }
    }
}

/// <summary><see cref="TmccPresets.For"/> が返す値の出どころ</summary>
public enum TmccPresetSource
{
    /// <summary>値が無い (プリセットを外す)</summary>
    None,

    /// <summary>その周波数でロックしたときの値</summary>
    Own,

    /// <summary>ほかの周波数で最後にロックしたときの値</summary>
    Other,

    /// <summary>どの周波数の値も無いときの既定の値</summary>
    Default,
}
