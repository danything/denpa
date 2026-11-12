using System.Collections.Concurrent;

namespace Denpa.Agent;

/*
 * エージェントが USB を直に持つ機材 (CECH-ZD1 J・PIX-DT295・IT930x の機材・Siano) の、開いた 1 台の小さな抽象。OS ごとの実装は
 * UsbFsDevice (Linux の usbfs)・WinUsbDevice (Windows の WinUSB)・IoKitDevice (macOS の IOKit)。どれも P/Invoke だけで、
 * 外のライブラリ (libusb など) は使わない。iso の転送は持たない (要る機材が無い)。並べる・開くのは IUsbHost (UsbHost.cs)。
 */

/// <summary>開いた USB の機材 1 台。インターフェース 0 を確保したところから使う。代替設定 0 を選ぶかは開く側が決める (IT930x は選ばない)</summary>
public interface IUsbDevice : IDisposable
{
    /// <summary>記録に出す名前</summary>
    string Name { get; }

    /// <summary>EP0 の IN の制御転送。受けたバイト数を返す</summary>
    int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs);

    /// <summary>EP0 の OUT の制御転送</summary>
    void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>bulk の OUT を 1 回 (全部送れなければ例外を送出する)</summary>
    void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs);

    /// <summary>interrupt か bulk の IN を 1 回。時間切れなら 0。CECH-ZD1 J の応答 (interrupt) と IT930x の応答 (bulk) を読む</summary>
    int Read(byte endpoint, Span<byte> buffer, int timeoutMs);

    /// <summary>
    /// IN の転送要求を <paramref name="depth"/> 本出しっぱなしにする。転送要求が出ていない間に来たものは抜ける機材 (TS) 向け。
    /// 止める (Dispose) と出していた転送要求を取り消して全部回収する
    /// </summary>
    IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth);

    /// <summary>
    /// インターフェース 0 (代替設定 0) の端点の一覧。端点のアドレスを決め打ちにできない機材 (Siano。SianoDevice.cs) が、開いたあとに読む。
    /// 読めない実装は例外を送出する
    /// </summary>
    IReadOnlyList<UsbPipe> Pipes() => throw new NotSupportedException($"{Name} は端点の一覧を読めません");

    /// <summary>端点のストールをクリアする (CLEAR_FEATURE の ENDPOINT_HALT)。できなければ例外を送出する。持たない実装は何もしない</summary>
    void ClearHalt(byte endpoint)
    {
    }
}

/// <summary>出しっぱなしの IN の読み</summary>
public interface IUsbInStream : IDisposable
{
    /// <summary>済んだ転送から順に詰めて返す。<paramref name="timeoutMs"/> の間に何も来なければ 0</summary>
    int Read(Span<byte> buffer, int timeoutMs);

    /// <summary>
    /// 済んだ転送を 1 つだけ返す (転送の区切りを残す)。<paramref name="buffer"/> に入りきらないぶんは捨てる。0 バイトの転送は飛ばす。
    /// <paramref name="timeoutMs"/> の間に何も来なければ 0。1 回の転送が 1 つのメッセージになる機材 (Siano) が使う。
    /// <see cref="Read"/> と混ぜて呼ばない
    /// </summary>
    int ReadTransfer(Span<byte> buffer, int timeoutMs) => throw new NotSupportedException("転送ごとの読み出しを持たない実装です");
}

/// <summary>端点 1 つ。<paramref name="Type"/> は USB の決まりの番号 (0 = control、1 = isochronous、2 = bulk、3 = interrupt)</summary>
public readonly record struct UsbPipe(byte Endpoint, int Type, int MaxPacket)
{
    public bool In => (Endpoint & 0x80) != 0;

    public bool Bulk => Type == 2;
}

/// <summary>機材が抜けた (挿し直すまで使えない)</summary>
public sealed class UsbGoneException(string message) : IOException(message);

/// <summary>挿さっている機材の場所。<see cref="Port"/> は Linux の sysfs の名前と同じ形式 (<c>1-2.3</c>)</summary>
/// <param name="Path">OS が開くときに使う名前 (Windows のデバイスのパス・macOS の locationID)</param>
public sealed record UsbLocation(string Port, string Path);

/// <summary>OS の名前からポートの名前を作る部品と、記録に出す文言。並べる・開くのは <see cref="IUsbHost"/> (UsbHost.cs)</summary>
public static class UsbDevices
{
    /// <summary>
    /// Windows の場所の文字列 (<c>PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(2)</c>) からポートの名前 (<c>1-3.2</c>)。
    /// 先頭の数は、ホストコントローラーの場所の文字列を並べた <paramref name="controllers"/> の何番目か (1 から)。分からなければ null
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

    /// <summary>
    /// Windows のデバイスのパス (<c>\\?\usb#vid_0511&amp;pid_024a#&lt;シリアル番号&gt;#{…}</c>) の 3 つ目の区切りからシリアル番号。
    /// シリアル番号の無い機材は、ここに <c>&amp;</c> を含む OS が作った名前が入るので null。実機で確かめていない
    /// </summary>
    public static string? WindowsSerial(string path) =>
        path.Split('#') is [_, _, var serial, ..] && serial.Length > 0 && !serial.Contains('&') ? serial : null;

    /// <summary>
    /// <c>--card</c> の差し込み口の行: ATR と、開いてから ATR までの時間。**見つからなくても 1 行出す**
    /// (macOS・Windows で OS に見えていないのか、開けないのかを分けるため)。どんな例外でも行にして次へ進む
    /// </summary>
    /// <param name="model">見つからないときに出す機材の名前</param>
    /// <param name="timed">ATR の行の時間が何を測ったか</param>
    public static void DescribeCards(string model, string timed, IReadOnlyList<CardLinkCandidate> cards, TextWriter output)
    {
        if (cards.Count == 0) output.WriteLine($"{model}: 見つかりません");
        foreach (var found in cards)
        {
            var started = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                using var link = found.Open();
                var atr = link.Reset();
                output.WriteLine($"内蔵 {found.Name}: ATR {Convert.ToHexString(atr)} ({started.ElapsedMilliseconds} ms。{timed})");
            }
            catch (Exception error)
            {
                output.WriteLine($"内蔵 {found.Name}: {Reason(error)} ({started.ElapsedMilliseconds} ms)");
            }
        }
    }

    /// <summary>失敗の理由。IOException 以外 (読み込めないライブラリなど) は型の名前も付ける</summary>
    public static string Reason(Exception error) => error is IOException ? error.Message : $"{error.GetType().Name}: {error.Message}";

    /// <summary>
    /// 端点の一覧を 1 行に (<c>EP 0x81 bulk 512 バイト、EP 0x83 interrupt 64 バイト</c>)。種類は USB の決まりの番号
    /// (0 = control、1 = isochronous、2 = bulk、3 = interrupt)。macOS で開いたとき (IoKitDevice) と、Siano の機材の様子を出すとき (SianoDevice) に使う
    /// </summary>
    public static string DescribePipes(IEnumerable<(byte Endpoint, int Type, int MaxPacket)> pipes) =>
        string.Join("、", pipes.Select(pipe =>
            $"EP 0x{pipe.Endpoint:X2} {pipe.Type switch { 0 => "control", 1 => "isochronous", 2 => "bulk", 3 => "interrupt", _ => $"種類 {pipe.Type}" }} {pipe.MaxPacket} バイト"));
}

/// <summary>
/// 端点の転送要求を 1 本ずつ出し続けて、届いた転送を順に溜める。**読む側の時間切れはバッファに届くのを待つ時間だけで、出した転送要求は取り消さない。**
///
/// <para>
/// macOS の IOUSBLib は interrupt のパイプに時間切れが効かない (IOUSBLib.h の <c>ReadPipeTO</c> の説明。interrupt は
/// 時間切れの無い <c>ReadPipe</c> で読む)。そこで時間切れの無い転送要求を専用のスレッドで出し続け、読む側は自前の時間切れでバッファに届くのを待つ。
/// 時間切れのたびに転送要求を取り消すと、取り消しと転送がすれ違ったときに届いた応答を取りこぼし、データトグルの食い違いを直す手当ても要る。
/// 出し続けていれば取り消すのは閉じるときの 1 回だけで済み、時間切れのあとに届いた応答も次の読み出しで受け取れる
/// (CECH-ZD1 J は応答に通し番号を付けて古いものを捨てるので、遅れて届いた応答が混ざってもよい)。
/// </para>
///
/// <para>
/// 1 回の転送が 1 つの応答。<see cref="Read"/> はバッファの先頭の転送を 1 つ渡し、バッファに入りきらないぶんは捨てる
/// (Linux・Windows の 1 回の interrupt の転送要求と同じ振る舞い)。
/// </para>
/// </summary>
internal sealed class UsbReadPump : IDisposable
{
    /// <summary>出した転送要求を取り消してスレッドが戻るまで待つ上限</summary>
    private static readonly TimeSpan StopWait = TimeSpan.FromSeconds(2);

    /// <summary>
    /// 溜めておく転送の上限。読む側が止まっていても溜め続けないよう、越えたら古いものから捨てる
    /// (CECH-ZD1 J の応答は送った塊ごとに 1 つで、通し番号で古いものを捨てるので、捨てても困らない)
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
    /// <param name="size">1 回の転送要求の大きさ (端点の最大パケット長。それより大きいと、ちょうどの長さの応答で転送が終わらない)</param>
    /// <param name="read">時間切れの無い転送要求を 1 回。受けたバイト数を返す (取り消されたら 0)。読めなければ例外を送出する</param>
    /// <param name="cancel">出している転送要求を取り消す (<paramref name="read"/> を戻らせる)。閉じるときだけ呼ぶ</param>
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
        // バッファは転送要求ごとに新しく作る (渡した配列はバッファにそのまま入る)。取り消しが間に合わず戻らないままでも、
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

    /// <summary>バッファの先頭の転送を 1 つ渡す。<paramref name="timeoutMs"/> の間に何も届かなければ 0。読み出しが失敗していれば例外を送出する</summary>
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

    /// <summary>出している転送要求を取り消して、スレッドが戻るのを待つ</summary>
    public void Dispose() => Stop();

    /// <summary>
    /// 出している転送要求を取り消して、スレッドが戻るのを <see cref="StopWait"/> まで待つ。戻ったら true
    /// (戻らなければ、呼ぶ側は転送要求が使っているもの (インターフェース) を手放さない)
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
