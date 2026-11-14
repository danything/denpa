namespace Denpa.Agent;

/// <summary>
/// 止めるときの手順を、渡した順に通す (Program.cs の <c>ApplicationStopping</c>・<c>ApplicationStopped</c>)。**1 つが例外を送出しても、残りは通す。**
/// コールバックの中で例外が出ると同じコールバックの残りが飛び、IT930x の機材を閉じ損ねるとブリッジのバッファが溢れるため
/// </summary>
internal static class StopSteps
{
    public static void Run(params (string Name, Action Step)[] steps)
    {
        foreach (var (name, step) in steps)
        {
            try
            {
                step();
            }
            catch (Exception error)
            {
                Log.Write($"止める手順の「{name}」が失敗しました ({UsbDevices.Reason(error)})。残りの手順を続けます");
            }
        }
    }
}
