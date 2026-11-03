namespace Denpa.Agent;

/// <summary>
/// 機材の抜き差しを受け取って <c>changed</c> を呼ぶ (Program.cs の Rescan)。続けて起きた変化は 2 秒待ってまとめる
/// (挿してからドライバがデバイスのファイルを作り終えるまでの間)。
///
/// <list type="bullet">
/// <item>Linux: <c>/dev/bus/usb</c> の下にファイルができる・消えるのを inotify で受け取る (<see cref="FileSystemWatcher"/>)。
/// カーネルの uevent はコンテナのネットワーク名前空間には届かないので、コンテナでも届くファイルの変化を使う</item>
/// <item>Windows: 挿さっている USB 機材のパス (<see cref="WinUsbDevice.Fingerprint"/>) を 2 秒ごとに見比べる</item>
/// <item>macOS: 10 秒ごとに呼ぶ (探した結果を前回と比べ、増えた機材だけを足す。Config.Additions)</item>
/// </list>
/// </summary>
internal sealed class DeviceWatch : IDisposable
{
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(2);

    private readonly Action _changed;
    private readonly Timer _settle;
    private readonly FileSystemWatcher? _files;
    private readonly Timer? _poll;
    /// <summary>Rescan を重ねないための印</summary>
    private readonly Lock _gate = new();
    private readonly Lock _compare = new();
    private string? _last;

    public DeviceWatch(Action changed)
    {
        _changed = changed;
        _settle = new Timer(_ => Fire(), null, Timeout.Infinite, Timeout.Infinite);
        if (OperatingSystem.IsLinux())
        {
            if (!Directory.Exists("/dev/bus/usb")) return;
            _files = new FileSystemWatcher("/dev/bus/usb") { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName };
            _files.Created += (_, _) => Soon();
            _files.Deleted += (_, _) => Soon();
            _files.EnableRaisingEvents = true;
        }
        else if (OperatingSystem.IsWindows())
        {
            _last = WinUsbDevice.Fingerprint();
            _poll = new Timer(_ => Compare(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
        }
        else if (OperatingSystem.IsMacOS())
        {
            _poll = new Timer(_ => Fire(), null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
        }
    }

    private void Compare()
    {
        if (!OperatingSystem.IsWindows()) return;
        var now = WinUsbDevice.Fingerprint();
        lock (_compare)
        {
            if (now == _last) return;
            _last = now;
        }
        Soon();
    }

    private void Soon() => _settle.Change(Settle, Timeout.InfiniteTimeSpan);

    private void Fire()
    {
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
        _files?.Dispose();
        _poll?.Dispose();
        _settle.Dispose();
    }
}
