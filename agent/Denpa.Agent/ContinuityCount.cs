namespace Denpa.Agent;

/// <summary>
/// TS の連続性の飛びを数える (<c>--tune</c> の集計。Probe.cs)。PID ごとに continuity_counter が 1 ずつ進むかを見る。
///
/// <list type="bullet">
/// <item>ペイロードの無いパケット (adaptation_field_control が 2) は数を進めないので、比べない</item>
/// <item>同じ数の 2 回目は重送 (規格で 1 回まで許される) として飛びにしない</item>
/// <item>discontinuity_indicator が立っていれば、そこからやり直す</item>
/// <item>NULL パケット (PID 0x1FFF) と、transport_error_indicator が 1 のパケットは見ない (PID も崩れているため)</item>
/// </list>
///
/// 受信の欠けでは、多くの PID が同じところで一緒に飛ぶ。**近くで起きた飛びは 1 か所にまとめる** (<see cref="Places"/>)。
/// 選局の直後 (最初の 1 秒) は落ち着く前の並びが混じるので数えない
/// </summary>
public sealed class ContinuityCount
{
    /// <summary>同じか所にまとめる間。これより離れた飛びは別のか所</summary>
    private static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(200);

    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(1);

    private readonly Dictionary<int, int> _last = [];

    /// <summary>飛んだ回数 (PID ごとに数える)</summary>
    public long Jumps { get; private set; }

    /// <summary>飛んだか所。始めからの時刻と、そこで飛んだ PID の数</summary>
    public List<(TimeSpan At, int Pids)> Places { get; } = [];

    private TimeSpan _lastJump;
    private readonly HashSet<int> _placePids = [];

    /// <param name="packet">188 バイトのパケット</param>
    /// <param name="at">受け始めてからの時刻</param>
    public void Push(ReadOnlySpan<byte> packet, TimeSpan at)
    {
        if (packet.Length < 4 || packet[0] != 0x47 || (packet[1] & 0x80) != 0) return;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if (pid == 0x1FFF) return;
        var control = (packet[3] >> 4) & 3;
        if ((control & 1) == 0) return;
        var counter = packet[3] & 0x0F;
        var reset = control == 3 && packet.Length > 5 && packet[4] > 0 && (packet[5] & 0x80) != 0;
        if (reset || !_last.TryGetValue(pid, out var last))
        {
            _last[pid] = counter;
            return;
        }
        _last[pid] = counter;
        if (counter == last || counter == ((last + 1) & 0x0F)) return;
        if (at < Settle) return;
        Jumps++;
        if (Places.Count == 0 || at - _lastJump > Gap)
        {
            Places.Add((at, 0));
            _placePids.Clear();
        }
        _lastJump = at;
        if (_placePids.Add(pid)) Places[^1] = (Places[^1].At, _placePids.Count);
    }
}
