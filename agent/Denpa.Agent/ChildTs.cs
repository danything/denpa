namespace Denpa.Agent;

/// <summary>
/// 機材から受けた TS のバッファ (AsicenStream・Zd1jStream・Dt295NativeStream・SianoStream・It930xTsOutput。OS の pipe ではなく Pipelines) を閉じるときの決まり。
/// 読み出し側はどれも <see cref="DeviceStream"/> に載せる
/// </summary>
internal static class ChildTs
{
    /// <summary>
    /// 読む側が抜けきるまで待つ上限。<see cref="DeviceStream"/> は 200ms ごとに印を確かめるので、
    /// バッファを閉じるのは読む側が戻ってから。待つのは読みかけがいるときだけ (<see cref="DeviceStream.WaitReaders"/>)。
    /// asicend・CECH-ZD1 J・PIX-DT295・Siano の機材の TS の後始末 (AsicenStream.Stop・Zd1jStream.Stop・Dt295NativeStream.Stop・SianoStream.Stop) で使う
    /// </summary>
    internal static readonly TimeSpan ReaderDrain = TimeSpan.FromMilliseconds(300);
}
