using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Denpa.Agent;

/// <summary>
/// 起きたことを知らせるエンドポイント (SSE)。denpa がチューナーの様子・局の入れ替わり・カードの契約の更新・機材の異常を受け取るのに使う。
///
/// <para>
/// 流すのは**こちらが持っている事実だけ**。
/// スキャンを進めているのは denpa 自身なので、スキャンの進み具合はここに入れない。
/// </para>
/// </summary>
public sealed class Events
{
    /// <summary>新しい購読者に送り直す通知の数 (<see cref="Emit(string, JsonObject, bool)"/> の <c>retain</c>)</summary>
    internal const int Retained = 20;

    private readonly Lock _gate = new();
    private readonly List<Channel<string>> _listeners = [];
    private readonly Queue<string> _retained = new();

    public Channel<string> Subscribe()
    {
        /*
         * 詰まった購読者に引きずられない。画面が固まっているだけで選局まで
         * 止まるのは困るので、溜まったら**古いほうを捨てる**
         */
        var queue = Channel.CreateBounded<string>(
            new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest });
        lock (_gate)
        {
            // 取っておいた通知を先に送る。denpa が入れ替わっている間に起きた機材の異常も、繋ぎ直した denpa に届く (受ける側が同じものを重ねない)
            foreach (var block in _retained) queue.Writer.TryWrite(block);
            _listeners.Add(queue);
        }
        return queue;
    }

    public void Unsubscribe(Channel<string> queue)
    {
        lock (_gate) _listeners.Remove(queue);
        queue.Writer.TryComplete();
    }

    /// <summary>名前だけの通知 (<c>data</c> は <c>{}</c>)</summary>
    public void Emit(string name) => Send($"event: {name}\ndata: {{}}\n\n", retain: false);

    /// <summary>
    /// 中身のある通知。<paramref name="retain"/> なら直近 <see cref="Retained"/> 件を取っておき、あとから購読した側にも送る
    /// (受ける側が同じものを重ねないこと。<c>fault</c> は時刻と文で見分ける)
    /// </summary>
    public void Emit(string name, JsonObject data, bool retain) =>
        // JSON の文字列の改行はエスケープされるので、data は 1 行に収まる
        Send($"event: {name}\ndata: {data.ToJsonString(Json.Compact)}\n\n", retain);

    private void Send(string block, bool retain)
    {
        lock (_gate)
        {
            if (retain)
            {
                _retained.Enqueue(block);
                while (_retained.Count > Retained) _retained.Dequeue();
            }
            foreach (var listener in _listeners) listener.Writer.TryWrite(block);
        }
    }

    /// <summary>機材の異常の行に添える、直前の記録の長さ (ms)</summary>
    internal const long FaultContextMs = 5 * 60 * 1000;

    /// <summary>機材の異常の行に添える、直前の記録の行数の上限</summary>
    internal const int FaultContextLines = 200;

    /// <summary>
    /// <c>fault</c> の中身: <c>{"at":ミリ秒,"text":"…","context":[{"at":ミリ秒,"text":"…"}]}</c>。
    /// <c>at</c> は直近の記録 (<paramref name="recent"/>。古い順) でその行に付いた時刻で、<c>context</c> はその行より前の <see cref="FaultContextMs"/> の記録
    /// (<see cref="FaultContextLines"/> 行まで、古い順)。何を選局していたか (同時に開いていた受信機・番組表の取得・ライブ) を、エージェントを入れ替えたあとも読めるようにする。
    /// 直近の記録にその行が無ければ (記録が溢れて押し出された)、<paramref name="now"/> を時刻にして全部を前の記録として扱う
    /// </summary>
    internal static JsonObject FaultData(string text, IReadOnlyList<(long At, string Text)> recent, long now)
    {
        var index = -1;
        for (var i = recent.Count - 1; i >= 0; i--)
        {
            if (recent[i].Text != text) continue;
            index = i;
            break;
        }
        var at = index >= 0 ? recent[index].At : now;
        var before = index >= 0 ? recent.Take(index) : recent;
        var context = before
            .Where(line => line.At >= at - FaultContextMs)
            .TakeLast(FaultContextLines)
            .Select(line => (JsonNode)new JsonObject { ["at"] = line.At, ["text"] = line.Text });
        return new JsonObject { ["at"] = at, ["text"] = text, ["context"] = new JsonArray([.. context]) };
    }
}
