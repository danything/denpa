using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 設定から最初の TS までの時間の内訳 (<c>--dt295-probe</c> が表にする)。段ごとに、開始の時刻・かかった時間・制御転送の数・I2C の転送の数を取る。
/// 段は入れ子にできる (親の行は子の行を含む)。待ち (<see cref="Wait"/>) は、仕様書の待ちか、ホストが決めた待ちかを理由に書く。
/// <see cref="Dt295NativeDevice"/> に渡さなければ (null) 何も取らない
/// </summary>
public sealed class Dt295Timeline
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<Row> _rows = [];
    private readonly Lock _gate = new();
    private int _depth;

    /// <summary>制御転送の数・I2C の転送の数を返す関数 (機材を開くときに結ぶ)</summary>
    public Func<long> Controls { get; set; } = () => 0;

    public Func<long> Transfers { get; set; } = () => 0;

    public sealed class Row
    {
        public int Depth;
        public string Name = "";
        public string? Reason;
        public string? Note;
        public bool IsWait;
        public double StartMs;
        public double Ms = -1;
        public long Controls;
        public long Transfers;
    }

    /// <summary>1 つの段。<see cref="IDisposable.Dispose"/> で終わる</summary>
    public sealed class Scope : IDisposable
    {
        private readonly Dt295Timeline _owner;
        private readonly Row _row;
        private readonly long _controls0, _transfers0;
        private bool _done;

        internal Scope(Dt295Timeline owner, Row row)
        {
            _owner = owner;
            _row = row;
            _controls0 = owner.Controls();
            _transfers0 = owner.Transfers();
        }

        /// <summary>行の末尾に出す補足 (待った回数など)</summary>
        public void Note(string note) => _row.Note = note;

        public void Dispose()
        {
            if (_done) return;
            _done = true;
            lock (_owner._gate)
            {
                _row.Ms = _owner._clock.Elapsed.TotalMilliseconds - _row.StartMs;
                _row.Controls = _owner.Controls() - _controls0;
                _row.Transfers = _owner.Transfers() - _transfers0;
                _owner._depth--;
            }
        }
    }

    /// <summary>ここまでの行 (終わっていない行は <see cref="Row.Ms"/> が負)</summary>
    public IReadOnlyList<Row> Rows
    {
        get
        {
            lock (_gate) return [.. _rows];
        }
    }

    /// <summary>段を始める</summary>
    public Scope Begin(string name, string? reason = null, bool wait = false)
    {
        lock (_gate)
        {
            var row = new Row { Depth = _depth, Name = name, Reason = reason, IsWait = wait, StartMs = _clock.Elapsed.TotalMilliseconds };
            _rows.Add(row);
            _depth++;
            return new Scope(this, row);
        }
    }

    /// <summary>1 つの段を終えたら次の段を始める、という並びを書きやすくする。終わりに <see cref="IDisposable.Dispose"/></summary>
    public sealed class Phases(Dt295Timeline? timeline) : IDisposable
    {
        private Scope? _current;

        public void Next(string name, string? reason = null)
        {
            _current?.Dispose();
            _current = timeline?.Begin(name, reason);
        }

        public void Dispose()
        {
            _current?.Dispose();
            _current = null;
        }
    }

    /// <summary>表にする</summary>
    public void Print(TextWriter output)
    {
        Row[] rows;
        lock (_gate) rows = [.. _rows];
        output.WriteLine("開始 ms  所要 ms  制御転送  I2C  内容");
        foreach (var row in rows)
        {
            var text = $"{new string(' ', row.Depth * 2)}{row.Name}"
                + (row.Reason is { } reason ? $" ({reason})" : "")
                + (row.Note is { } note ? $" [{note}]" : "");
            output.WriteLine($"{row.StartMs,7:F0}  {(row.Ms < 0 ? "  (途中)" : $"{row.Ms,8:F1}")}  {row.Controls,8}  {row.Transfers,4}  {text}");
        }
        // 待ちの合計。待ちの中の待ち (別の仕事を挟む待ちの中で、その仕事が待つもの) は外側の待ちに含まれるので数えない
        var count = 0;
        var sum = 0.0;
        int? waitDepth = null;
        foreach (var row in rows)
        {
            if (waitDepth is { } depth && row.Depth > depth) continue;
            waitDepth = null;
            if (!row.IsWait || row.Ms < 0) continue;
            count++;
            sum += row.Ms;
            waitDepth = row.Depth;
        }
        output.WriteLine($"固定の待ち: {count} 回、合計 {sum:F0} ms");
    }
}

/// <summary>null の <see cref="Dt295Timeline"/> でも呼べる形</summary>
public static class Dt295TimelineExtensions
{
    public static Dt295Timeline.Scope? Step(this Dt295Timeline? timeline, string name, string? reason = null) => timeline?.Begin(name, reason);

    /// <summary>決めた時間だけ待つ。待ちは表に出る</summary>
    public static void Wait(this Dt295Timeline? timeline, Action<int> sleep, int ms, string reason)
    {
        using var scope = timeline?.Begin($"待ち {ms} ms", reason, wait: true);
        sleep(ms);
    }
}
