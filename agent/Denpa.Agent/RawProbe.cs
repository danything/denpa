using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 元の TS の置き場 (<c>RAW_DIR</c>) が denpa と同じに見えているかを、denpa に確かめさせる (<c>POST /denpa/raw/probe</c>)。
///
/// <para>
/// denpa は <c>RAW_DIR/.denpa/probe-&lt;エージェントの ID&gt;-&lt;乱数&gt;</c> に乱数を書き、ここに置き場からの相対パスを渡す。
/// こちらはその中身の SHA-256 を返し、denpa が書いたものと比べる (denpa の <c>scramble.ts</c> の <c>probeRaw</c>)。
/// 合えば、後から復号する (<c>/denpa/decode</c>) ときに同じファイルを読める。エージェントが何台もあるとき、復号させる先を選ぶのに使う。
/// </para>
///
/// <para>
/// **読むのは置き場の <c>.denpa/</c> の下の小さなファイルだけ。** ほかのパスは断る (録画の中身の手がかりを返さない)。
/// </para>
/// </summary>
public static class RawProbe
{
    /// <summary>読んでよい置き場の中のディレクトリ</summary>
    public const string Dir = ".denpa";

    /// <summary>読む大きさの上限 (バイト)。denpa が書くのは 64 字</summary>
    public const int MaxBytes = 4096;

    /// <summary>答えの HTTP ステータスと本文。見つかれば 200 と <c>sha256</c>、無ければ 404、断るときは 400</summary>
    public static (int Status, JsonObject Body) Hash(string recorded, string? path)
    {
        static (int, JsonObject) Failed(int status, string error) => (status, new JsonObject { ["error"] = error });
        if (string.IsNullOrEmpty(path)) return Failed(400, "path は文字列で書きます");
        var root = Path.GetFullPath(Path.Combine(recorded, Dir));
        var full = Path.GetFullPath(Path.Combine(recorded, path));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            return Failed(400, $"読めるのは元の TS の保存先の {Dir}/ の下だけです");
        var file = new FileInfo(full);
        if (!file.Exists) return Failed(404, $"{full} が見つかりません。エージェントにも denpa と同じ保存先 (RAW_DIR) を見せてください");
        // リンクは辿らない (置き場の外のファイルの手がかりを返さない)
        if (file.LinkTarget is not null) return Failed(400, "リンクは読みません");
        if (file.Length > MaxBytes) return Failed(400, $"{MaxBytes} バイトより大きいファイルは読みません");
        return (200, new JsonObject { ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(full))) });
    }
}
