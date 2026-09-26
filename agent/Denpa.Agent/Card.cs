using System.Buffers;
using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>子プロセスを最後まで回して、出力をまとめて受け取る</summary>
public static class Shell
{
    public static async Task<(int Code, string Output)> Run(
        string file, IEnumerable<string> args, TimeSpan? timeout = null)
    {
        try
        {
            var start = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var arg in args) start.ArgumentList.Add(arg);

            using var child = Process.Start(start)!;
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            using var limit = new CancellationTokenSource(timeout ?? TimeSpan.FromMinutes(30));
            try
            {
                await child.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                child.Kill(entireProcessTree: true);
            }
            return (child.ExitCode, $"{await stdout}{await stderr}".Trim());
        }
        catch (Exception error)
        {
            return (-1, error.Message);
        }
    }
}

/// <summary>
/// カードが読めているか。
///
/// <para>
/// リーダーが見えていてもカードを読めていないことがある (刺さっていない・USB が黙る)。
/// そうなると掛かったまま流すので、録画は成功したように見えて中身が全部
/// スクランブルされたまま、という分かりにくい壊れ方をする。**実際に INT を通して**
/// 確かめる。
/// </para>
/// </summary>
public static class Card
{
    public static JsonObject Status()
    {
        var readers = new JsonArray();
        foreach (var found in CardLinks.Find()) readers.Add((JsonNode?)JsonValue.Create(found.Name));

        string message;
        var ok = false;
        try
        {
            var init = Keys.Source is RemoteCard remote ? remote.Check() : Keys.Local.Check();
            var ids = string.Join(" / ", init.Ids.Select(id => id.ToString("D16")));
            var from = Keys.Source is RemoteCard ? "鍵を配る相手" : Keys.Local.Name;
            message = $"カードが読めています ({from}{(ids.Length > 0 ? $"、{ids}" : "")})";
            ok = true;
        }
        catch (Exception error)
        {
            message = readers.Count == 0 && Keys.Source is not RemoteCard
                ? "カードリーダーが見つかりません"
                : error.Message;
        }

        return new JsonObject { ["ok"] = ok, ["readers"] = readers, ["message"] = message };
    }
}

/// <summary>
/// 掛かったまま録れたTSを解く。
///
/// <para>
/// **こちらの返事だけでは足りない。** 解けたつもりで掛かったままのものが出来る道が
/// 残る (鍵が合わない・ECM が流れていない) ので、出来上がったものを読んで
/// 確かめるのは呼び出し側 (denpa の <c>scramble.ts</c>)。
/// </para>
/// </summary>
public static class Scramble
{
    /// <summary>置き場の中に収まるパスだけ受け付ける。外を読み書きさせない</summary>
    private static string? Inside(string root, string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        var full = Path.GetFullPath(Path.Combine(root, name));
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? full : null;
    }

    /// <summary>
    /// 掛かったまま録れてしまったものを、後から解く。
    ///
    /// <para>**自分で解く** (B25.cs)。</para>
    /// </summary>
    public static JsonObject Decode(string recorded, string? input, string? output)
    {
        var source = Inside(recorded, input);
        var target = Inside(recorded, output);
        if (source is null || target is null)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "生TSの置き場の外は解除に回せません" };
        }
        if (!File.Exists(source))
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = $"{source} が見えません。denpa と同じ置き場をこのコンテナにも見せてください",
            };
        }

        try
        {
            var b25 = new Descrambler(Keys.Source, background: false);
            using var reading = File.OpenRead(source);
            using var writing = File.Create(target);
            var buffer = new byte[188 * 1024];
            var decoded = new ArrayBufferWriter<byte>();
            int read;
            while ((read = reading.Read(buffer)) > 0)
            {
                decoded.ResetWrittenCount();
                b25.Decode(buffer.AsSpan(0, read), decoded);
                writing.Write(decoded.WrittenSpan);
            }
            decoded.ResetWrittenCount();
            b25.Flush(decoded);
            writing.Write(decoded.WrittenSpan);

            /*
             * **解けなかったのに成功とは言わない。** カードが無い・ECM が流れていない
             * ときも、掛かったまま全部書き出せてしまう。1% を超えて残ったら断る
             */
            if (b25.Undecodable * 100 > b25.Decoded)
            {
                return new JsonObject
                {
                    ["ok"] = false,
                    ["error"] = $"{b25.Undecodable} パケットが掛かったままです ({b25.LastError ?? "鍵を貰えませんでした"})",
                };
            }
        }
        catch (Exception error)
        {
            return new JsonObject { ["ok"] = false, ["error"] = error.Message };
        }
        return new JsonObject { ["ok"] = true, ["error"] = "" };
    }
}
