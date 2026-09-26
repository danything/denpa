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
            var start = new ProcessStartInfo(file, args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
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
/// カードが読めているか。**リーダーごとに**返す (画面の「カードリーダー」の表)。
///
/// <para>
/// リーダーが見えていてもカードを読めていないことがある (刺さっていない・USB が黙る)。
/// そうなると掛かったまま流すので、録画は成功したように見えて中身が全部
/// スクランブルされたまま、という分かりにくい壊れ方をする。**実際に INT を通して**
/// 確かめる。
/// </para>
///
/// <para>
/// **使うカードは1枚。** 鍵の出どころはプロセスで1つ (<see cref="Keys"/>) で、
/// INT に答えた最初のリーダーのカードを全部のチューナーで使い回す。カードに聞くのは
/// ECM の中身が変わったときだけなので、1枚で何本でも足りる。残りのリーダーは**予備** —
/// 使っているカードが答えなくなったら、繋ぎ直すときに探し直して拾う (<see cref="BCas"/>)。
/// チューナーごとにカードを割り当てることはしない。
/// </para>
/// </summary>
public static class Card
{
    private static readonly TimeSpan CheckFor = TimeSpan.FromSeconds(8);

    /// <summary>予備のリーダーを覗くのに使ってよい時間。**全部を並べて同時に**覗く</summary>
    private static readonly TimeSpan ProbeFor = TimeSpan.FromSeconds(3);

    private static readonly Lock Gate = new();
    private static Task<CardSurvey>? _checking;

    /// <summary>
    /// 走っている確かめに相乗りする。**同時に1本だけ** — 切り上げたあとも確かめは
    /// 走り続けるので、画面を開き直すたびに足すと錠の前に溜まっていく
    /// </summary>
    private static Task<CardSurvey> Checking()
    {
        lock (Gate)
        {
            if (_checking is { IsCompleted: false } running) return running;
            return _checking = Task.Run(() => Keys.Source is RemoteCard remote
                ? Remote(remote.Url, remote.Check)
                // 切り上げる前に答えを返せるよう、1秒残して覗き終える
                : Local(Keys.Local.Check, () => Keys.Local.Name, CardLinks.Find, CheckFor - TimeSpan.FromSeconds(1)));
        }
    }

    /// <param name="streaming">いま解いているチューナーの名前 (<see cref="TunerPool.Descrambling"/>)</param>
    public static JsonObject Status(Func<IReadOnlyList<string>> streaming)
    {
        /*
         * **denpa は 10 秒で諦める。** それより先に切り上げて理由を返す —
         * 間に合わないと、画面には「受け口に繋がりません」とエージェントのせいに見える
         */
        CardSurvey survey;
        try
        {
            var check = Checking();
            survey = check.Wait(CheckFor) ? check.Result : TimedOut();
        }
        catch (Exception error)
        {
            // リーダーを探すところで転んだ (sysfs が読めないなど)。画面には理由を出す
            survey = new CardSurvey(false, Unwrap(error).Message, [], [], (Keys.Source as RemoteCard)?.Url);
        }
        return Report(survey, streaming());
    }

    /// <summary>間に合わなかった。**リーダーの名前だけは並べる** (探すだけなら何も開かない)</summary>
    private static CardSurvey TimedOut()
    {
        var message = $"カードが {CheckFor.TotalSeconds:F0} 秒で答えません";
        if (Keys.Source is RemoteCard remote) return new CardSurvey(false, message, [], [], remote.Url);
        return new CardSurvey(
            false, message, [.. CardLinks.Find().Select(found => new ReaderState(found.Name, null, false, "確かめが間に合いません"))], [], null);
    }

    /// <summary>鍵を配る相手から貰っている。**手元のリーダーは使わない**ので並べない</summary>
    internal static CardSurvey Remote(string url, Func<CardInit> check)
    {
        try
        {
            return new CardSurvey(true, "", [], check().Ids, url);
        }
        catch (Exception error)
        {
            return new CardSurvey(false, Unwrap(error).Message, [], [], url);
        }
    }

    /// <summary>
    /// 手元のリーダーを並べる。
    ///
    /// <para>
    /// **使っているリーダーは開き直さない。** USB のリーダーは掴むと他からは開けない
    /// ので、覗こうとすると断られる (悪くすると流れている鍵の出どころを乱す)。その行は
    /// 鍵の出どころ自身に INT を通させた答え (<paramref name="check"/>) で埋め、
    /// **残りだけ**を開いて覗いて閉じる。
    /// </para>
    ///
    /// <para>
    /// 覗いている間に、使っているカードが落ちて繋ぎ直しが同じ予備を開こうとすると、
    /// 片方が掴めずに終わる。繋ぎ直しは 10 秒後にまた探すので、そこで拾い直す。
    /// </para>
    /// </summary>
    /// <param name="check">鍵の出どころに INT を1回通させる</param>
    /// <param name="active">鍵の出どころが使っているリーダーの名前</param>
    /// <param name="find">見えているリーダー</param>
    /// <param name="within">覗き終えるまでの時間 (INT を通すのに掛かったぶんも含めて)</param>
    internal static CardSurvey Local(
        Func<CardInit> check, Func<string> active, Func<IReadOnlyList<CardLinkCandidate>> find, TimeSpan within)
    {
        var started = Stopwatch.StartNew();
        CardInit? init = null;
        Exception? failure = null;
        try
        {
            init = check();
        }
        catch (Exception error)
        {
            failure = Unwrap(error);
        }

        var found = find();
        /*
         * **INT が通らなかったら覗かない。** 鍵の出どころ自身が全部のリーダーを試して、
         * リーダーごとの理由を持っている (BCas.Connect)。ここで覗くと、覗きが独占して掴んで
         * いる間 (固まったリーダーだと待つのをやめたあとも) 繋ぎ直しが掴めず、画面を開くたびに
         * 締め出し続けて、カードが二度と読めなくなる (実機で起きた)
         */
        if (init is null) return Failed(failure!, found);

        var used = active();
        var others = found.Where(candidate => candidate.Name != used).ToList();
        var left = within - started.Elapsed;
        var peeked = Probe(others, left < ProbeFor ? left : ProbeFor);

        var readers = new List<ReaderState>();
        var usedRow = used is null ? null : new ReaderState(used, init!.Ids, true, null);
        // 探し直したときに見えなくなっていても、使っているものは必ず出す
        if (usedRow is not null && others.Count == found.Count) readers.Add(usedRow);
        var next = 0;
        foreach (var candidate in found) readers.Add(candidate.Name == used ? usedRow! : peeked[next++]);

        return new CardSurvey(true, "", readers, init.Ids, null);
    }

    /// <summary>
    /// 鍵の出どころが INT を通せなかった。**リーダーごとの理由はその失敗が持っている**
    /// (<see cref="CardsUnreadableException"/>)。持っていなければ失敗の文をそのまま出す
    /// </summary>
    private static CardSurvey Failed(Exception failure, IReadOnlyList<CardLinkCandidate> found)
    {
        var known = (failure as CardsUnreadableException)?.Readers ?? [];
        var readers = found.Select(candidate =>
        {
            var reader = known.FirstOrDefault(reader => reader.Name == candidate.Name);
            // 挿さっていないだけなら理由を出さない (カードなし)
            return new ReaderState(candidate.Name, null, false, reader is { Absent: true } ? null : reader?.Reason ?? failure.Message);
        }).ToList();

        var message = readers.Count == 0 ? "カードリーダーが見つかりません"
            : readers.Any(reader => reader.Error is not null) ? "どのリーダーでもカードを読めません"
            : "どのリーダーにもカードが挿さっていません";
        return new CardSurvey(false, message, readers, [], null);
    }

    /// <summary>
    /// 予備のリーダーを並べて同時に覗く。**間に合わなかったものは待たない** —
    /// 固まったリーダー1つのせいで表ごと出なくなるより、その行だけ理由を出す
    /// </summary>
    internal static ReaderState[] Probe(IReadOnlyList<CardLinkCandidate> candidates, TimeSpan within)
    {
        /*
         * **1つずつ専用のスレッドで。** 固まったリーダーは何秒も塞ぐので、共用の池から
         * 借りると池が増えるまで他の覗きも待たされ、答えられるものまで「答えません」になる
         */
        var peeking = candidates.Select(Peeking).ToArray();
        if (peeking.Length > 0 && within > TimeSpan.Zero) Task.WaitAll(peeking, within);
        return
        [
            .. candidates.Select((candidate, at) => peeking[at].IsCompletedSuccessfully
                ? peeking[at].Result
                : new ReaderState(candidate.Name, null, false, $"{ProbeFor.TotalSeconds:F0} 秒で答えません")),
        ];
    }

    private static readonly Dictionary<string, Task<ReaderState>> Running = [];

    /// <summary>
    /// そのリーダーの覗き。**前の覗きが終わっていなければ、それに相乗りする** — 固まった
    /// リーダーは待つのをやめたあとも掴んだままなので、重ねて開くと自分で締め出す
    /// </summary>
    private static Task<ReaderState> Peeking(CardLinkCandidate candidate)
    {
        lock (Running)
        {
            if (Running.TryGetValue(candidate.Name, out var running) && !running.IsCompleted) return running;
            // 終わった覗きは溜めない (挿し直すと名前の USB の場所が変わり、キーが増えていく)
            foreach (var done in Running.Where(entry => entry.Value.IsCompleted).Select(entry => entry.Key).ToList()) Running.Remove(done);
            return Running[candidate.Name] = Task.Factory.StartNew(
                () => Peek(candidate), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }
    }

    /// <summary>開いて、電源を入れて INT と IDI を読み、閉じる</summary>
    private static ReaderState Peek(CardLinkCandidate candidate)
    {
        try
        {
            using var link = candidate.Open();
            return new ReaderState(candidate.Name, BCas.Read(link).Ids, false, null);
        }
        catch (CardAbsentException)
        {
            return new ReaderState(candidate.Name, null, false, null);
        }
        catch (Exception error)
        {
            return new ReaderState(candidate.Name, null, false, error.Message);
        }
    }

    /// <summary>
    /// 画面に返す形。**<c>message</c> は困っているときだけ** — リーダーの名前や
    /// カードの番号は表 (<c>readers</c>) に出るので繰り返さない
    /// </summary>
    internal static JsonObject Report(CardSurvey survey, IReadOnlyList<string> streaming)
    {
        var readers = new JsonArray();
        foreach (var reader in survey.Readers)
        {
            var row = new JsonObject
            {
                ["name"] = reader.Name,
                ["card"] = reader.Card,
                ["ids"] = Ids(reader.Ids ?? []),
                ["active"] = reader.Active,
                ["tuners"] = Names(reader.Active ? streaming : []),
            };
            if (reader.Error is not null) row["error"] = reader.Error;
            readers.Add((JsonNode)row);
        }

        var report = new JsonObject
        {
            ["ok"] = survey.Ok,
            ["message"] = survey.Message,
            ["source"] = survey.Remote is null ? "local" : "remote",
            ["readers"] = readers,
        };
        if (survey.Remote is not null)
        {
            report["remote"] = survey.Remote;
            report["ids"] = Ids(survey.Ids);
            report["tuners"] = Names(survey.Ok ? streaming : []);
        }
        return report;
    }

    /// <summary>番号は libaribb25 の頃と同じ 10 進 16 桁</summary>
    private static JsonArray Ids(long[] ids)
    {
        var list = new JsonArray();
        foreach (var id in ids) list.Add((JsonNode?)JsonValue.Create(id.ToString("D16")));
        return list;
    }

    private static JsonArray Names(IReadOnlyList<string> names)
    {
        var list = new JsonArray();
        foreach (var name in names) list.Add((JsonNode?)JsonValue.Create(name));
        return list;
    }

    private static Exception Unwrap(Exception error) =>
        error is AggregateException { InnerException: { } inner } ? inner : error;
}

/// <summary>1つのリーダーの様子</summary>
/// <param name="Ids">カードの番号。**カードが読めなければ null**</param>
/// <param name="Active">鍵の出どころが使っているリーダー</param>
/// <param name="Error">覗けなかった理由 (挿さっていないだけなら null)</param>
public sealed record ReaderState(string Name, long[]? Ids, bool Active, string? Error)
{
    public bool Card => Ids is not null;
}

/// <summary>確かめた結果。<paramref name="Remote"/> は鍵を配る相手から貰っているときの URL</summary>
public sealed record CardSurvey(bool Ok, string Message, IReadOnlyList<ReaderState> Readers, long[] Ids, string? Remote);

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

    /// <summary>掛かったまま録れてしまったものを、後から解く (<see cref="Descrambler"/>)</summary>
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
            var b25 = new Descrambler(Keys.Source);
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
