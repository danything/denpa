using System.Collections.Concurrent;

namespace Denpa.Agent;

/*
 * エージェントが USB を直に持つ機材 (いまは CECH-ZD1 J) のための小さな抽象。OS ごとの実装は
 * UsbFsDevice (Linux の usbfs)・WinUsbDevice (Windows の WinUSB)・IoKitDevice (macOS の IOKit)。どれも P/Invoke だけで、
 * 外のライブラリ (libusb など) は使わない。iso の転送は持たない (要る機材が無い)。
 */

/// <summary>開いた USB の機材1台。インターフェース 0 の代替設定 0 を選んだところから使う</summary>
public interface IUsbDevice : IDisposable
{
    /// <summary>記録に出す名前</summary>
    string Name { get; }

    /// <summary>EP0 の IN の制御転送。受けたバイト数を返す</summary>
    int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs);

    /// <summary>EP0 の OUT の制御転送</summary>
    void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>bulk の OUT を1回 (全部送れなければ投げる)</summary>
    void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>interrupt の IN を1回。時間切れなら 0</summary>
    int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs);

    /// <summary>
    /// IN の読みを <paramref name="depth"/> 本出しっぱなしにする。読みが出ていない間に来たものは抜ける機材 (TS) 向け。
    /// 止める (Dispose) と出していた読みを取り消して全部回収する
    /// </summary>
    IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth);
}

/// <summary>出しっぱなしの IN の読み</summary>
public interface IUsbInStream : IDisposable
{
    /// <summary>済んだ転送から順に詰めて返す。<paramref name="timeoutMs"/> の間に何も来なければ 0</summary>
    int Read(Span<byte> buffer, int timeoutMs);
}

/// <summary>機材が抜けた (挿し直すまで使えない)</summary>
public sealed class UsbGoneException(string message) : IOException(message);

/// <summary>刺さっている機材の場所。<see cref="Port"/> は Linux の sysfs の名前と同じ形 (<c>1-2.3</c>)</summary>
/// <param name="Path">OS が開くときに使う名前 (Windows のデバイスのパス・macOS の locationID)</param>
public sealed record UsbLocation(string Port, string Path);

/// <summary>OS ごとの、刺さっている機材を並べる・開く</summary>
public static class UsbDevices
{
    /// <summary>
    /// 刺さっている機材を並べる (Windows・macOS)。**開かない。** Windows は WinUSB でないものも並ぶ (開けるかは開くまで分からない)。
    /// Linux は呼ぶ側が sysfs で探すので空 (<see cref="Zd1j.Detect"/>)
    /// </summary>
    public static IReadOnlyList<UsbLocation> List(int vendor, int product)
    {
        if (OperatingSystem.IsWindows()) return WinUsbDevice.List(vendor, product);
        if (OperatingSystem.IsMacOS()) return IoKitDevice.List(vendor, product);
        return [];
    }

    /// <summary>
    /// Windows の場所の文字列 (<c>PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(2)</c>) からポートの名前 (<c>1-3.2</c>)。
    /// 頭の数は、ホストコントローラーの場所の文字列を並べた <paramref name="controllers"/> の何番目か (1 から)。分からなければ null
    /// </summary>
    public static string? WindowsPort(string location, IReadOnlyList<string> controllers)
    {
        var root = location.IndexOf("#USBROOT(", StringComparison.OrdinalIgnoreCase);
        if (root < 0) return null;
        var controller = location[..root];
        var bus = 0;
        for (var i = 0; i < controllers.Count && bus == 0; i++)
        {
            if (string.Equals(controllers[i], controller, StringComparison.OrdinalIgnoreCase)) bus = i + 1;
        }
        if (bus == 0) return null;
        var ports = new List<int>();
        foreach (var part in location[(root + 1)..].Split('#').Skip(1))
        {
            if (!part.StartsWith("USB(", StringComparison.OrdinalIgnoreCase) || !part.EndsWith(')')
                || !int.TryParse(part[4..^1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port)
                || port <= 0)
            {
                return null;
            }
            ports.Add(port);
        }
        return ports.Count == 0 ? null : $"{bus}-{string.Join('.', ports)}";
    }

    /// <summary>
    /// macOS の locationID からポートの名前。上の 8 ビット = バスの番号、続く 4 ビットずつ = ハブのポートを根から (0 で終わり)。
    /// <c>0x14320000</c> → <c>20-3.2</c>。根のハブそのもの (ポートが無い) は null
    /// </summary>
    public static string? MacPort(uint location)
    {
        var ports = new List<uint>();
        for (var shift = 20; shift >= 0; shift -= 4)
        {
            var port = (location >> shift) & 0xF;
            if (port == 0) break;
            ports.Add(port);
        }
        return ports.Count == 0 ? null : $"{location >> 24}-{string.Join('.', ports)}";
    }

    /// <summary>そのポートの機材を開く (Windows・macOS)。無ければ投げる</summary>
    public static IUsbDevice Open(string port, int vendor, int product)
    {
        var found = List(vendor, product).FirstOrDefault(location => location.Port == port)
            ?? throw new IOException($"USB のポート {port} に {vendor:x4}:{product:x4} が見当たりません");
        if (OperatingSystem.IsWindows()) return WinUsbDevice.Open(found);
        if (OperatingSystem.IsMacOS()) return IoKitDevice.Open(found, vendor, product);
        throw new PlatformNotSupportedException();
    }

    /// <summary>
    /// 端点の一覧を1行に (<c>EP 0x81 bulk 512 バイト、EP 0x83 interrupt 64 バイト</c>)。種類は USB の決まりの番号
    /// (0 = control、1 = isochronous、2 = bulk、3 = interrupt)。macOS で開いたときに1回だけ記録に出す
    /// </summary>
    public static string DescribePipes(IEnumerable<(byte Endpoint, int Type, int MaxPacket)> pipes) =>
        string.Join("、", pipes.Select(pipe =>
            $"EP 0x{pipe.Endpoint:X2} {pipe.Type switch { 0 => "control", 1 => "isochronous", 2 => "bulk", 3 => "interrupt", _ => $"種類 {pipe.Type}" }} {pipe.MaxPacket} バイト"));
}

/// <summary>
/// 端点の読みを1本ずつ出し続けて、届いた転送を順に溜める。**読む側の時間切れは溜めを待つ時間だけで、出した読みは取り消さない。**
///
/// <para>
/// macOS の IOUSBLib は interrupt のパイプに時間切れが効かない (IOUSBLib.h の <c>ReadPipeTO</c> の説明。interrupt は
/// 時間切れの無い <c>ReadPipe</c> で読む)。そこで時間切れの無い読みを専用のスレッドで出し続け、読む側は自前の時間で溜めを待つ。
/// 時間切れのたびに読みを取り消すと、取り消しと転送がすれ違ったときに届いた答えを落とし、データトグルの食い違いを直す手当ても要る。
/// 出し続けていれば取り消すのは閉じるときの1回だけで済み、時間切れのあとに届いた答えも次の読みで受け取れる
/// (CECH-ZD1 J は答えに通し番号を付けて古いものを捨てるので、遅れて届いた答えが混ざってもよい)。
/// </para>
///
/// <para>
/// 1回の転送が1つの答え。<see cref="Read"/> は溜めの頭の転送を1つ渡し、バッファに入りきらないぶんは捨てる
/// (Linux・Windows の1回の interrupt の読みと同じ振る舞い)。
/// </para>
/// </summary>
internal sealed class UsbReadPump : IDisposable
{
    /// <summary>出した読みを取り消してスレッドが戻るまで待つ上限</summary>
    private static readonly TimeSpan StopWait = TimeSpan.FromSeconds(2);

    /// <summary>
    /// 溜めておく転送の上限。読む側が止まっていても溜め続けないよう、越えたら古いものから捨てる
    /// (CECH-ZD1 J の答えは送った塊ごとに1つで、通し番号で古いものを捨てるので、落ちても困らない)
    /// </summary>
    internal const int Capacity = 64;

    private readonly string _name;
    private readonly Func<byte[], int> _read;
    private readonly Action _cancel;
    private readonly int _size;
    private readonly BlockingCollection<byte[]> _chunks = new(new ConcurrentQueue<byte[]>());
    private readonly Thread _thread;
    private volatile bool _closing;
    private volatile Exception? _error;

    /// <param name="name">スレッドの名前</param>
    /// <param name="size">1回の読みの大きさ (端点の最大パケット長。それより大きいと、ちょうどの長さの答えで読みが終わらない)</param>
    /// <param name="read">時間切れの無い読みを1回。受けたバイト数を返す (取り消されたら 0)。読めなければ投げる</param>
    /// <param name="cancel">出している読みを取り消す (<paramref name="read"/> を戻らせる)。閉じるときだけ呼ぶ</param>
    public UsbReadPump(string name, int size, Func<byte[], int> read, Action cancel)
    {
        _name = name;
        _size = size;
        _read = read;
        _cancel = cancel;
        _thread = new Thread(Run) { IsBackground = true, Name = name };
        _thread.Start();
    }

    private void Run()
    {
        // バッファは読みごとに新しく作る (渡した配列は溜めにそのまま入る)。取り消しが間に合わず戻らないままでも、
        // バッファはこのスレッドが持っているので、閉じた側が解放してしまうことはない
        while (!_closing)
        {
            var buffer = new byte[_size];
            int got;
            try
            {
                got = _read(buffer);
            }
            catch (Exception error)
            {
                if (!_closing) _error = error;
                break;
            }
            if (_closing) break;
            if (got <= 0) continue;
            while (_chunks.Count >= Capacity) _chunks.TryTake(out _);
            _chunks.Add(got == buffer.Length ? buffer : buffer[..got]);
        }
        _chunks.CompleteAdding();
    }

    /// <summary>溜めの頭の転送を1つ渡す。<paramref name="timeoutMs"/> の間に何も届かなければ 0。読みが失敗していれば投げる</summary>
    public int Read(Span<byte> buffer, int timeoutMs)
    {
        ObjectDisposedException.ThrowIf(_closing, _name);
        if (!_chunks.TryTake(out var chunk, Math.Max(0, timeoutMs)))
        {
            if (_error is { } error) throw error as IOException ?? new IOException($"{_name}: {error.Message}", error);
            return 0;
        }
        var length = Math.Min(chunk.Length, buffer.Length);
        chunk.AsSpan(0, length).CopyTo(buffer);
        return length;
    }

    /// <summary>出している読みを取り消して、スレッドが戻るのを待つ</summary>
    public void Dispose() => Stop();

    /// <summary>
    /// 出している読みを取り消して、スレッドが戻るのを <see cref="StopWait"/> まで待つ。戻ったら true
    /// (戻らなければ、呼ぶ側は読みが使っているもの (インターフェース) を手放さない)
    /// </summary>
    public bool Stop()
    {
        if (!_closing)
        {
            _closing = true;
            _cancel();
        }
        return _thread.Join(StopWait);
    }
}
