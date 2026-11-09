using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// カードが読めているか。**リーダーごとに**返す (画面の「カードリーダー」の表)。
///
/// <para>
/// リーダーが見えていてもカードを読めていないことがある (挿さっていない・USB が応答しなくなる)。
/// そうなるとスクランブルされたまま流すので、録画は成功したように見えて中身が全部
/// 再生できない、という分かりにくい壊れ方をする。**実際に INT を通して**
/// 確かめる。
/// </para>
///
/// <para>
/// **使うカードは 1 枚。** 鍵の出どころはプロセスで 1 つ (<see cref="Keys"/>) で、
/// INT に応答した最初のリーダーのカードを全部のチューナーで使い回す。カードに問い合わせるのは
/// ECM の中身が変わったときだけなので、1 枚で何台でも足りる。残りのリーダーは**予備**で、
/// 使っているカードが応答しなくなったら、繋ぎ直すときに探し直して使う (<see cref="BCas"/>)。
/// チューナーごとにカードを割り当てることはしない。
/// </para>
/// </summary>
public static class Card
{
    private static readonly TimeSpan CheckFor = TimeSpan.FromSeconds(8);

    /// <summary>予備のリーダーを確かめるのに使ってよい時間。**全部を並べて同時に**確かめる</summary>
    private static readonly TimeSpan ProbeFor = TimeSpan.FromSeconds(3);

    private static readonly Lock Gate = new();
    private static Task<CardSurvey>? _checking;

    /// <summary>
    /// 走っている確認の結果を共有する。**同時に 1 本だけ。** 切り上げたあとも確認は
    /// 走り続けるので、画面を開き直すたびに足すとロックの前に溜まっていく
    /// </summary>
    private static Task<CardSurvey> Checking()
    {
        lock (Gate)
        {
            if (_checking is { IsCompleted: false } running) return running;
            return _checking = Task.Run(() => Keys.Source is RemoteCard remote
                ? Remote(remote.Url, remote.Check)
                // 切り上げる前に結果を返せるよう、1 秒残して確認を終える
                : Local(Keys.Local.Check, () => Keys.Local.Name, CardLinks.Find, CheckFor - TimeSpan.FromSeconds(1)));
        }
    }

    /// <param name="streaming">いま復号しているチューナーの名前 (<see cref="TunerPool.Descrambling"/>)</param>
    public static JsonObject Status(Func<IReadOnlyList<string>> streaming)
    {
        /*
         * **denpa は 10 秒で待つのをやめる。** それより先に切り上げて理由を返す。
         * 間に合わないと、画面には「カードの状態を確かめるエージェントに繋がりません」と、エージェントの問題に見える
         */
        CardSurvey survey;
        try
        {
            var check = Checking();
            survey = check.Wait(CheckFor) ? check.Result : TimedOut();
        }
        catch (Exception error)
        {
            // リーダーを探すところで失敗した (sysfs が読めないなど)。画面には理由を出す
            survey = new CardSurvey(false, Unwrap(error).Message, [], [], (Keys.Source as RemoteCard)?.Url);
        }
        return Report(WithDisabled(survey, CardChoice.Disabled, CardLinks.All), streaming());
    }

    /// <summary>
    /// 使わない設定のリーダーを、**開かずに**後ろへ足す (画面でオンに戻せるように)。挿さっていないものは足さない。
    /// 鍵を配る相手から受け取っているときは手元のリーダーを並べないので足さない
    /// </summary>
    internal static CardSurvey WithDisabled(CardSurvey survey, IReadOnlySet<string> disabled, Func<IReadOnlyList<CardLinkCandidate>> all)
    {
        if (survey.Remote is not null || disabled.Count == 0) return survey;
        IReadOnlyList<CardLinkCandidate> found;
        try
        {
            found = all();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return survey;
        }
        var listed = survey.Readers.Select(reader => reader.Name).ToHashSet();
        var off = found.Where(candidate => disabled.Contains(candidate.Name) && !listed.Contains(candidate.Name))
            .Select(candidate => new ReaderState(candidate.Name, null, false, null, Disabled: true)).ToList();
        if (off.Count == 0) return survey;
        // 1 つも使っていないのに「見つかりません」と出すと、挿さっていないように見える
        var message = survey.Ok || survey.Readers.Count > 0 ? survey.Message : "使うカードリーダーがありません。カードリーダーをオンにしてください";
        return survey with { Message = message, Readers = [.. survey.Readers, .. off] };
    }

    /// <summary>間に合わなかった。**リーダーの名前だけは並べる** (探すだけなら何も開かない)</summary>
    private static CardSurvey TimedOut()
    {
        var message = $"カードが {CheckFor.TotalSeconds:F0} 秒以内に応答しません";
        if (Keys.Source is RemoteCard remote) return new CardSurvey(false, message, [], [], remote.Url);
        return new CardSurvey(
            false, message, [.. CardLinks.Find().Select(found => new ReaderState(found.Name, null, false, "確認が間に合いません"))], [], null);
    }

    /// <summary>鍵を配る相手から受け取っている。**手元のリーダーは使わない**ので並べない</summary>
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
    /// **使っているリーダーは開き直さない。** USB のリーダーは開いている間は他から開けない
    /// ので、確かめようと開くと断られる (悪くすると使っている鍵の出どころを乱す)。その行は
    /// 鍵の出どころ自身に INT を通させた結果 (<paramref name="check"/>) で埋め、
    /// **残りだけ**を開いて確かめて閉じる。
    /// </para>
    ///
    /// <para>
    /// 確かめている間に、使っているカードが落ちて繋ぎ直しが同じ予備を開こうとすると、
    /// 片方が開けずに終わる。繋ぎ直しは 10 秒後にまた探すので、そこで見つけ直す。
    /// </para>
    /// </summary>
    /// <param name="check">鍵の出どころに INT を 1 回通させる</param>
    /// <param name="active">鍵の出どころが使っているリーダーの名前</param>
    /// <param name="find">見えているリーダー</param>
    /// <param name="within">確認を終えるまでの時間 (INT を通すのに掛かったぶんも含めて)</param>
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
         * **INT が通らなかったら確かめない。** 鍵の出どころ自身が全部のリーダーを試して、
         * リーダーごとの理由を持っている (BCas.Connect)。ここで確かめると、確認がリーダーを独占して
         * 開いている間 (固まったリーダーだと待つのをやめたあとも) 繋ぎ直しが開けない。画面を開くたびに
         * これが続いて、カードが二度と読めなくなる (実機で起きた)
         */
        if (init is null) return Failed(failure!, found);

        var used = active();
        var others = found.Where(candidate => candidate.Name != used).ToList();
        var left = within - started.Elapsed;
        var peeked = Probe(others, left < ProbeFor ? left : ProbeFor);

        var readers = new List<ReaderState>();
        var usedRow = new ReaderState(used, init.Ids, true, null);
        // 探し直したときに見えなくなっていても、使っているものは必ず出す
        if (others.Count == found.Count) readers.Add(usedRow);
        var next = 0;
        foreach (var candidate in found) readers.Add(candidate.Name == used ? usedRow : peeked[next++]);

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
            : readers.Any(reader => reader.Error is not null) ? "どのカードリーダーでもカードを読めません"
            : "どのカードリーダーにもカードが挿さっていません";
        return new CardSurvey(false, message, readers, [], null);
    }

    /// <summary>
    /// 予備のリーダーを並べて同時に確かめる。**間に合わなかったものは待たない。**
    /// 固まったリーダー 1 つが原因で表ごと出なくなるより、その行だけ理由を出す
    /// </summary>
    private static ReaderState[] Probe(IReadOnlyList<CardLinkCandidate> candidates, TimeSpan within)
    {
        /*
         * **1 つずつ専用のスレッドで。** 固まったリーダーは何秒も塞ぐので、共用のスレッドプールで
         * 動かすとプールが増えるまで他の確認も待たされ、応答できるリーダーまで「応答しません」になる
         */
        var peeking = candidates.Select(Peeking).ToArray();
        if (peeking.Length > 0 && within > TimeSpan.Zero) Task.WaitAll(peeking, within);
        // 待ったのは渡された残りの時間だけ (ProbeFor より短いこともある)。残っていなければ待っていない
        var late = within > TimeSpan.Zero ? $"{within.TotalSeconds:0.#} 秒以内に応答しません" : "確認が間に合いません";
        return
        [
            .. candidates.Select((candidate, at) => peeking[at].IsCompletedSuccessfully
                ? peeking[at].Result
                : new ReaderState(candidate.Name, null, false, late)),
        ];
    }

    private static readonly Dictionary<string, Task<ReaderState>> Running = [];

    /// <summary>
    /// そのリーダーの確認。**前の確認が終わっていなければ、その結果を共有する。** 固まった
    /// リーダーは待つのをやめたあとも開いたままなので、重ねて開こうとすると開けない
    /// </summary>
    private static Task<ReaderState> Peeking(CardLinkCandidate candidate)
    {
        lock (Running)
        {
            if (Running.TryGetValue(candidate.Name, out var running) && !running.IsCompleted) return running;
            // 終わった確認は溜めない (挿し直すと名前の USB の場所が変わり、キーが増えていく)
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
    /// 画面に返す形式。**<c>message</c> は問題があるときだけ。** リーダーの名前や
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
                ["tuners"] = Json.Strings(reader.Active ? streaming : []),
                ["disabled"] = reader.Disabled,
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
            report["tuners"] = Json.Strings(survey.Ok ? streaming : []);
        }
        return report;
    }

    /// <summary>番号は libaribb25 の頃と同じ 10 進 16 桁</summary>
    private static JsonArray Ids(long[] ids) => Json.Strings(ids.Select(id => id.ToString("D16")));

    private static Exception Unwrap(Exception error) =>
        error is AggregateException { InnerException: { } inner } ? inner : error;
}

/// <summary>1 つのリーダーの様子</summary>
/// <param name="Ids">カードの番号。**カードが読めなければ null**</param>
/// <param name="Active">鍵の出どころが使っているリーダー</param>
/// <param name="Error">確かめられなかった理由 (挿さっていないだけなら null)</param>
/// <param name="Disabled">使わない設定のリーダー (<see cref="CardChoice"/>)。開いていないので、カードの有無も分からない</param>
public sealed record ReaderState(string Name, long[]? Ids, bool Active, string? Error, bool Disabled = false)
{
    public bool Card => Ids is not null;
}

/// <summary>確かめた結果。<paramref name="Remote"/> は鍵を配る相手から受け取っているときの URL</summary>
public sealed record CardSurvey(bool Ok, string Message, IReadOnlyList<ReaderState> Readers, long[] Ids, string? Remote);

/// <summary>
/// スクランブルされたまま録れた TS を復号する。
///
/// <para>
/// **こちらが返す結果だけでは足りない。** 復号に成功と返しても、スクランブルされたままのファイルが出来る経路が
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

    /// <summary>スクランブルされたまま録れてしまったものを、後から復号する (<see cref="Descrambler"/>)</summary>
    public static JsonObject Decode(string recorded, string? input, string? output)
    {
        static JsonObject Failed(string error) => new() { ["ok"] = false, ["error"] = error };
        var source = Inside(recorded, input);
        var target = Inside(recorded, output);
        if (source is null || target is null) return Failed("元の TS の保存先の外にあるファイルは復号できません");
        if (!File.Exists(source)) return Failed($"{source} が見つかりません。エージェントにも denpa と同じ保存先 (RAW_DIR) を見せてください");
        // 書き出す先は新しく作る。もうあるファイルは上書きしない (置き場の中の録画を潰させない)
        if (File.Exists(target)) return Failed($"{target} はもうあります。上書きはしません");

        // 自分で作ったか。駄目だったときに消すのは自分で作った書きかけだけ (やり直しが「もうあります」で断られないように)
        var created = false;
        try
        {
            var b25 = new Descrambler(Keys.Source);
            using (var reading = File.OpenRead(source))
            using (var writing = new FileStream(target, FileMode.CreateNew, FileAccess.Write))
            {
                created = true;
                b25.DecodeAll(reading, writing);
            }

            /*
             * **復号できなかったのに成功を返さない。** カードが無い・ECM が流れていない
             * ときも、スクランブルされたまま全部書き出せてしまう。1% を超えて残ったら断る
             */
            if (b25.Undecodable * 100 > b25.Decoded)
            {
                File.Delete(target);
                return Failed($"{b25.Undecodable} パケットがスクランブルのままです ({b25.LastError ?? "鍵を受け取れませんでした"})");
            }
        }
        catch (Exception error)
        {
            if (created)
            {
                try
                {
                    File.Delete(target);
                }
                catch (Exception)
                {
                    // 消せなくても、理由は元のほうを返す
                }
            }
            return Failed(error.Message);
        }
        return new JsonObject { ["ok"] = true, ["error"] = "" };
    }
}
