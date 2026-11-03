using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 挿さっている機材を探す (<c>GET /denpa/tuners/unlisted</c>)。**1 度に 1 つだけ探し、5 秒は結果を使い回す。**
/// 設定画面を複数の端末で同時に開くと、探すのが並んで走る (asicen はファームウェアも流し込む)
/// </summary>
internal static class Unlisted
{
    private static readonly TimeSpan Fresh = TimeSpan.FromSeconds(5);
    private static readonly Lock Gate = new();
    private static List<TunerSpec>? _found;
    private static readonly Stopwatch Since = new();

    public static List<TunerSpec> Detect()
    {
        lock (Gate)
        {
            if (_found is null || Since.Elapsed >= Fresh)
            {
                _found = DeviceProbe.Detect();
                Since.Restart();
            }
            return _found;
        }
    }
}
