using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 機材から受けた TS のバッファ (AsicenStream・Zd1jStream・Dt295NativeStream・SianoStream。OS の pipe ではなく Pipelines) を閉じるときの決まり。
/// 読み出し側はどれも <see cref="DeviceStream"/> に載せる
/// </summary>
internal static class ChildTs
{
    /// <summary>
    /// 読む側が抜けきるまで待つ上限。<see cref="DeviceStream"/> は 200 ms ごとに印を確かめるので、
    /// バッファを閉じるのは読む側が戻ってから。待つのは読みかけがいるときだけ (<see cref="DeviceStream.WaitReaders"/>)。
    /// asicend・CECH-ZD1 J・PIX-DT295・Siano の機材の TS の後始末 (<see cref="Close"/>) で使う
    /// </summary>
    internal static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);

    /// <summary>
    /// TS の後始末 (AsicenStream.Stop・Zd1jStream.Stop・Dt295NativeStream.Stop・SianoStream.Stop)。読む側の待ちを終わらせ (<see cref="DeviceStream.Stop"/>)、
    /// <paramref name="stopWriter"/> で書く側のスレッドと機材の読み出しを止め、読みかけの読む側が戻るのを待ってからバッファを閉じる。
    /// 待つ上限の <see cref="ReaderDrain"/> は、読む側の待ちを終わらせたときから数える
    /// </summary>
    internal static void Close(DeviceStream output, Action stopWriter)
    {
        var stopped = Stopwatch.StartNew();
        output.Stop();
        stopWriter();
        output.WaitReaders(ReaderDrain - stopped.Elapsed);
        output.Dispose();
    }
}
