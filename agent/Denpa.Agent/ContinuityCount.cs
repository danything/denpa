namespace Denpa.Agent;

/// <summary>
/// PID ごとの continuity_counter を覚え、パケットごとに飛んだかを返す (<see cref="ContinuityCount"/> と、TSMF で選ぶ前後の数え (<see cref="TsmfSelector"/>) が使う)。
///
/// <list type="bullet">
/// <item>ペイロードの無いパケット (adaptation_field_control が 2) は数を進めないので、比べない</item>
/// <item>同じ数の 2 回目は重送 (規格で 1 回まで許される) として飛びにしない</item>
/// <item>discontinuity_indicator が立っていれば、そこからやり直す</item>
/// <item>NULL パケット (PID 0x1FFF) と、transport_error_indicator が 1 のパケットは見ない (PID も崩れているため)</item>
/// </list>
///
/// 覚える量は PID の数 (8192) で決まり、長く受けても増えない
/// </summary>
public sealed class ContinuityTracker
{
    /// <summary>PID ごとの前の continuity_counter に 1 を足したもの (0 はまだ受けていない)</summary>
    private readonly byte[] _last = new byte[8192];

    /// <summary>飛んだ回数 (PID ごとに数える)</summary>
    public long Jumps { get; private set; }

    /// <summary>transport_error_indicator が 1 のパケットの数</summary>
    public long Errors { get; private set; }

    /// <summary>パケットを 1 つ渡す。飛んでいたらその PID、飛んでいなければ -1</summary>
    public int Push(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 4 || packet[0] != 0x47) return -1;
        if ((packet[1] & 0x80) != 0)
        {
            Errors++;
            return -1;
        }
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if (pid == 0x1FFF) return -1;
        var control = (packet[3] >> 4) & 3;
        if ((control & 1) == 0) return -1;
        var counter = packet[3] & 0x0F;
        var reset = control == 3 && packet.Length > 5 && packet[4] > 0 && (packet[5] & 0x80) != 0;
        var known = _last[pid];
        _last[pid] = (byte)(counter + 1);
        if (reset || known == 0) return -1;
        var last = known - 1;
        if (counter == last || counter == ((last + 1) & 0x0F)) return -1;
        Jumps++;
        return pid;
    }
}

/// <summary>
/// TS の連続性の飛びを数える (<c>--tune</c> の集計。Probe.cs)。PID ごとに continuity_counter が 1 ずつ進むかを見る (見方は <see cref="ContinuityTracker"/>)。
///
/// 受信の欠けでは、多くの PID が同じところで一緒に飛ぶ。**近くで起きた飛びは 1 か所にまとめる** (<see cref="Places"/>)。
/// 選局の直後 (最初の 1 秒) は落ち着く前の並びが混じるので数えない
/// </summary>
public sealed class ContinuityCount
{
    /// <summary>同じか所にまとめる間。これより離れた飛びは別のか所</summary>
    private static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(200);

    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(1);

    private readonly ContinuityTracker _tracker = new();

    /// <summary>飛んだ回数 (PID ごとに数える)</summary>
    public long Jumps { get; private set; }

    /// <summary>飛んだか所。始めからの時刻と、そこで飛んだ PID の数と、最初に飛んだ PID</summary>
    public List<(TimeSpan At, int Pids, int Pid)> Places { get; } = [];

    private TimeSpan _lastJump;
    private readonly HashSet<int> _placePids = [];

    /// <param name="packet">188 バイトのパケット</param>
    /// <param name="at">受け始めてからの時刻</param>
    public void Push(ReadOnlySpan<byte> packet, TimeSpan at)
    {
        var pid = _tracker.Push(packet);
        if (pid < 0 || at < Settle) return;
        Jumps++;
        if (Places.Count == 0 || at - _lastJump > Gap)
        {
            Places.Add((at, 0, pid));
            _placePids.Clear();
        }
        _lastJump = at;
        if (_placePids.Add(pid)) Places[^1] = (Places[^1].At, _placePids.Count, Places[^1].Pid);
    }

    /// <summary><c>--tune</c> に出すか所の書き方。1 つの PID だけが飛んだか所は、その PID も書く</summary>
    public static string Describe((TimeSpan At, int Pids, int Pid) place) =>
        place.Pids == 1 ? $"{place.At.TotalSeconds:F1}s(PID 0x{place.Pid:X4})" : $"{place.At.TotalSeconds:F1}s({place.Pids} PID)";
}
