namespace Denpa.Agent;

/// <summary>
/// 機材の抜き差しを受け取って <c>changed</c> を呼ぶ (Program.cs の Rescan)。続けて起きた変化は 2 秒待ってまとめる
/// (挿してからドライバがデバイスのファイルを作り終えるまでの間)。
/// 受け取り方は OS ごとで、<see cref="IUsbHost.Watch"/> に任せる (Linux は <c>/dev/bus/usb</c> の inotify、Android はアプリからの attached・detached、Windows は 2 秒ごとの見比べ、macOS は 10 秒ごと)
/// </summary>
internal sealed class DeviceWatch : IDisposable
{
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(2);

    private readonly Action _changed;
    private readonly Timer _settle;
    private readonly IDisposable _watch;
    /// <summary>Rescan を重ねないための印</summary>
    private readonly Lock _gate = new();
    private volatile bool _disposed;

    public DeviceWatch(IUsbHost host, Action changed)
    {
        _changed = changed;
        _settle = new Timer(_ => Fire(), null, Timeout.Infinite, Timeout.Infinite);
        _watch = host.Watch(Soon);
    }

    private void Soon()
    {
        if (_disposed) return;
        try
        {
            _settle.Change(Settle, Timeout.InfiniteTimeSpan);
        }
        catch (ObjectDisposedException)
        {
            // 止めたのと入れ違いに届いた抜き差しは捨てる (止めたタイマーの Change は例外を送出し、タイマーや監視のスレッドの外へ出るとプロセスが終了する)
        }
    }

    private void Fire()
    {
        if (_disposed) return;
        // 探すのは数百 ms かかる。前の回が終わっていなければ重ねず、少し待って探し直す (その間の抜き差しを取りこぼさない)
        if (!_gate.TryEnter())
        {
            Soon();
            return;
        }
        try
        {
            _changed();
        }
        catch (Exception error)
        {
            Log.Write($"挿した機材を足せませんでした ({error.Message})");
        }
        finally
        {
            _gate.Exit();
        }
    }

    public void Dispose()
    {
        _disposed = true;
        _watch.Dispose();
        _settle.Dispose();
    }
}
