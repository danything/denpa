namespace Denpa.Agent;

/// <summary>
/// IT930x の機材 (PX-MLT5U など) の内蔵のカードリーダー (B-CAS)。カードはブリッジの UART と GPIO につながっていて、
/// ブリッジのコマンド (<c>UART_SET_MODE</c>・<c>UART_SET_BAUDRATE</c>・<c>UART_WRITE</c>・<c>UART_READ</c>) とレジスタで動かす。
///
/// <para>
/// 手順は ITE の SDK (<c>api/IT9300.c</c> の <c>IT9300_bcas*</c>) を元に書いた。コメントの関数名は SDK のもの。
/// カードがあるかは GPIOH6 (0 ならある。<c>IT9300_bcasDetectCard</c>)、リセットは GPIOH14 (<c>IT9300_bcasResetCard</c>)。
/// SDK は ITE の評価基板の配線で、PX-MLT5PE の実機ではこの GPIO でカードをリセットして読めた。
/// PX-MLT5U と DTV02A-5TS-P の基板でも同じ GPIO につながっているかは実機で確かめていない (#1578)。
/// T=1 の枠組みは <see cref="T1Protocol"/>、ATR と応答のブロックを受け切る手順は <see cref="CardUart"/> と共通にしている。
/// </para>
///
/// <para>
/// **カードは受信機と同じ電源を使う** (仕様書 1.5)。機材 (<see cref="It930xDevice"/>) は最初に使うときに取り、使っている間は返さないので、
/// 受信機を全部閉じても電源は切れない。カードだけを使うときも、機材を開いて電源を入れる。閉じたら機材を返し、受信機も使っていなければ機材を閉じる
/// </para>
/// </summary>
public sealed class It930xCard : ICardLink
{
    /// <summary>UART の状態 (SDK のコメントの「uart_status」)。リセットのときに 2 を書く (<c>IT9300_bcasResetCard</c>。値の意味は SDK に無い)</summary>
    public const uint UartStatus = 0x7904;

    /// <summary>UART で受けて読まれていないバイトの数 (<c>OVA_UART_RX_LENGTH</c>)</summary>
    public const uint RxLength = 0x496B;

    /// <summary>
    /// 最後の区切りを渡す前に 1 を書く (<c>OVA_UART_REALSEND</c>。<c>IT9300_bcasSendData</c>)。
    /// ブリッジはそれまでに渡された区切りとまとめて送ると推定する (SDK に説明が無い)
    /// </summary>
    public const uint RealSend = 0x4965;

    /// <summary>カードがあるかを読む GPIOH (<c>IT9300_bcasDetectCard</c>)</summary>
    public const int DetectPin = 6;

    /// <summary>カードのリセットの GPIOH (<c>IT9300_bcasResetCard</c>)</summary>
    public const int ResetPin = 14;

    /// <summary>1 つのブロックで送れる上限 (<c>IT9300_bcasSendData</c> の長さは 1 バイトで、255 を超えると断る)</summary>
    public const int MaxBlock = 255;

    /// <summary>こちらが受けられる情報欄の長さ (S(IFS) でカードに伝える)。ブロック全体が 255 バイトに収まる値</summary>
    public const int Ifsd = 251;

    private readonly Func<It930xDevice> _acquire;
    private readonly Action? _closeIdle;
    private readonly Action<int> _delay;

    /// <summary>ブリッジから読んで、まだ渡していないバイト</summary>
    private readonly Queue<byte> _received = new();

    /// <summary>リセットから T=1 までの流れ、送受信、閉じるを 1 つずつ通す</summary>
    private readonly Lock _session = new();

    private It930xDevice? _device;

    /// <summary>UART をカードとのやり取りに使う設定 (<c>IT9300_bcasInit</c>) を済ませた機材</summary>
    private It930xDevice? _prepared;

    private T1Protocol? _t1;
    private byte[]? _atr;
    private int _blockWaitMs = 500;

    public string Name { get; }

    /// <summary>USB のポートの機材のカード。機材は <see cref="It930xDevice.Acquire(string)"/> で取る</summary>
    public It930xCard(string name, string port)
        : this(name, () => It930xDevice.Acquire(port), () => It930xDevice.CloseIfIdle(port))
    {
    }

    /// <param name="acquire">機材を取る (最初に使うときと、抜けたあと)。返すのは <see cref="It930xDevice.Release"/></param>
    /// <param name="closeIdle">閉じたあとに呼ぶ (受信機も使っていなければ機材を閉じる)</param>
    /// <param name="delay">待つ (ms)。テストは時計を進めるだけにする</param>
    internal It930xCard(string name, Func<It930xDevice> acquire, Action? closeIdle = null, Action<int>? delay = null)
    {
        Name = name;
        _acquire = acquire;
        _closeIdle = closeIdle;
        _delay = delay ?? Thread.Sleep;
    }

    /// <summary>いま取っている機材 (テストのため)。取っていなければ null</summary>
    internal It930xDevice? Device => _device;

    /// <summary>機材のブリッジ。取っていなければ取り、初めての機材なら UART をカードとやり取りする設定にする</summary>
    private It930xBridge Bridge()
    {
        if (_device is { Faulted: true }) Drop();
        _device ??= _acquire();
        var bridge = _device.Bridge;
        if (_prepared != _device)
        {
            // 機材を開くたびに 1 回 (IT9300_bcasInit)。開き直した機材は設定が消えているので、もう一度送る
            bridge.UartCardMode();
            _prepared = _device;
        }
        return bridge;
    }

    /// <summary>カードがあるか。GPIOH6 が 0 ならある (<c>IT9300_bcasDetectCard</c>)</summary>
    private static bool Present(It930xBridge bridge) => !bridge.GpioRead(DetectPin);

    /// <summary>
    /// リセットして ATR を返す。**T=1 の準備が済んでいて、カードがあれば、リセットし直さずにその ATR を返す**。送受信が失敗したあとはリセットし直す
    /// </summary>
    public byte[] Reset()
    {
        lock (_session)
        {
            try
            {
                var bridge = Bridge();
                if (_t1 is not null && _atr is { } ready && Present(bridge)) return ready;
                return _atr = ResetCore(bridge);
            }
            catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
            {
                Forget(error);
                throw;
            }
        }
    }

    private byte[] ResetCore(It930xBridge bridge)
    {
        _t1 = null;
        _atr = null;
        if (!Present(bridge)) throw new CardAbsentException($"{Name} にカードが挿さっていません");
        _received.Clear();
        // IT9300_bcasResetCard: GPIOH14 を出力にして 0、UART の状態に 2、速さを 9600、5 ms 待つ、1 に戻して出力をやめる
        bridge.GpioSetup(ResetPin, false);
        bridge.WriteRegister(UartStatus, 2);
        bridge.UartBaudrate(9600);
        _delay(5);
        bridge.Gpio(ResetPin, true);
        bridge.GpioRelease(ResetPin);
        var raw = CardUart.ReceiveAtr(Read, _delay, Name);
        var atr = Atr.Parse(raw);
        if (!atr.T1) throw new IOException($"T=1 に対応していないカードです (ATR {Convert.ToHexString(raw)})");
        var baud = Baudrate(atr);
        // B-CAS は TA1 の 19200 で通信する (specific mode)。PX-MLT5PE の実機で、19200 でやり取りできることを確かめた
        if (baud != 9600) bridge.UartBaudrate(baud);
        _blockWaitMs = CardUart.BlockWaitMs(atr);
        var t1 = new T1Protocol(atr, Exchange);
        // こちらが受けられる長さを S(IFS) で広げる。既定の 32 のままだと、実機の B-CAS は 61 バイトの応答を連結せずに、
        // 長さのバイトだけを 32 にして 1 つのブロックで送ってきた (PX-MLT5PE の実機)。
        // ブリッジの受けた数は 1 バイトなので、ブロック全体 (先頭 3 バイトと LRC を足す) が 255 バイトに収まる 251 にする
        t1.NegotiateIfsd(Ifsd);
        _t1 = t1;
        return raw;
    }

    /// <summary>
    /// ATR のあとに使う速さ。specific mode (TA2 がある) なら TA1 の速さ、そうでなければ 9600 (PPS は送らない)。
    /// ブリッジの UART が扱うのは 9600 と 19200 だけ (<c>IT9300_bcasSetBaudrate</c>) なので、ほかの速さのカードは断る
    /// </summary>
    internal static int Baudrate(Atr atr)
    {
        if (!atr.Specific) return 9600;
        var rate = CardUart.Speed(atr).Rate;
        return rate is 9600 or 19200 ? rate : throw new IOException($"ATR の速さ ({rate} ボー。TA1 0x{atr.FiDi:X2}) は内蔵のカードリーダーで使えません (9600 と 19200 だけ)");
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        lock (_session)
        {
            if (_t1 is null || _device is null) throw new IOException($"{Name} のカードに繋いでいません (Reset を先に)");
            try
            {
                // 抜き差しの通知は無いので、APDU の前ごとに見る
                if (!Present(_device.Bridge))
                {
                    _t1 = null;
                    _atr = null;
                    throw new CardAbsentException($"{Name} のカードが抜かれました");
                }
                return _t1.Transmit(apdu);
            }
            catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
            {
                // T=1 のやり取りの状態が崩れたかもしれない。次の Reset はリセットからやり直す
                Forget(error);
                throw;
            }
        }
    }

    /// <summary>失敗のあと。T=1 の準備を捨て、USB が抜けていれば機材を返す (次に使うときに開き直す)</summary>
    private void Forget(Exception error)
    {
        _t1 = null;
        _atr = null;
        if (_device is not { } device) return;
        device.Fail(error);
        if (device.Faulted) Drop();
    }

    /// <summary>受けた数が増えなくなったとみなすまでの間隔 (ms)。19200 ボーの 1 バイトは約 0.6 ms、ATR の 9600 ボーは約 1.3 ms</summary>
    private const int SettleMs = 4;

    /// <summary>受けた数が増えなくなるのを待つ回数の上限 (<see cref="SettleMs"/> × 64 = 256 ms)</summary>
    private const int SettleLimit = 64;

    /// <summary>
    /// 受けて読まれていないバイトを <paramref name="max"/> まで読む。受けた数 (<see cref="RxLength"/>) を読み、<see cref="SettleMs"/> 待っても
    /// 増えなくなってから、<c>IT9300_bcasGetData</c> と同じく 32 バイトまでずつ読む。
    /// カードが送っている途中に UART_READ で読むと、そのとき届いたバイトが落ちることがある (PX-MLT5PE の実機で、61 バイトの応答の途中と末尾が落ちた) ので、
    /// 届き終わるのを待つ
    /// </summary>
    private byte[] Read(int max)
    {
        if (_received.Count == 0)
        {
            var bridge = _device!.Bridge;
            var waiting = (int)bridge.ReadRegister(RxLength);
            if (waiting > 0)
            {
                // 255 バイトが 19200 ボーで届き切る時間 (約 150 ms) を越える 256 ms (SettleLimit) より長く待たない。増え続けるなら、そこまでに届いたぶんを読む
                for (var settle = 0; settle < SettleLimit; settle++)
                {
                    _delay(SettleMs);
                    var again = (int)bridge.ReadRegister(RxLength);
                    if (again == waiting) break;
                    waiting = again;
                }
                // 受けた数は 1 バイトなので、多くても 255 バイト (32 バイトずつ 8 回)
                for (var i = 0; i < 8 && waiting > 0; i++)
                {
                    foreach (var b in bridge.UartRead(Math.Min(waiting, It930xBridge.MaxUartRead))) _received.Enqueue(b);
                    waiting = (int)bridge.ReadRegister(RxLength);
                }
            }
        }
        var count = Math.Min(Math.Max(0, max), _received.Count);
        var got = new byte[count];
        for (var i = 0; i < count; i++) got[i] = _received.Dequeue();
        return got;
    }

    /// <summary>
    /// 前のやり取りの残り (時間切れのあとに遅れて届いた応答) を捨てる。仕様書と SDK に無い:
    /// 遅れて届いたバイトが次の応答の先頭に混ざらないように、送る前に受けた数を読んで、残っていれば読み捨てる
    /// </summary>
    private void Discard(It930xBridge bridge)
    {
        _received.Clear();
        // 受けた数は 1 バイトなので、多くても 255 バイト (32 バイトずつ 8 回)
        for (var i = 0; i < 8; i++)
        {
            var waiting = (int)bridge.ReadRegister(RxLength);
            if (waiting == 0) return;
            bridge.UartRead(Math.Min(waiting, It930xBridge.MaxUartRead));
            if (i == 0) Log.Write($"[{Name}] 前のやり取りの残りを読み捨てました ({waiting} バイト)");
        }
    }

    /// <summary>
    /// ブロックを送る (<c>IT9300_bcasSendData</c>)。48 バイトずつ UART_WRITE で渡し、最後の区切りの前に <see cref="RealSend"/> に 1 を書く
    /// </summary>
    private static void Send(It930xBridge bridge, ReadOnlySpan<byte> block)
    {
        if (block.Length > MaxBlock) throw new IOException($"カードに送るブロックが長すぎます ({block.Length} バイト。{MaxBlock} バイトまで)");
        var at = 0;
        for (; block.Length - at > It930xBridge.MaxUartWrite; at += It930xBridge.MaxUartWrite)
        {
            bridge.UartWrite(block.Slice(at, It930xBridge.MaxUartWrite));
        }
        bridge.WriteRegister(RealSend, 1);
        bridge.UartWrite(block[at..]);
    }

    /// <summary>T=1 のブロックを 1 つ送って 1 つ受ける。時間切れは null (<see cref="CardUart.ReceiveBlock"/>)</summary>
    private byte[]? Exchange(byte[] block, byte wtx)
    {
        var bridge = _device!.Bridge;
        Discard(bridge);
        Send(bridge, block);
        var limitMs = _blockWaitMs * Math.Max(1, (int)wtx);
        var reply = CardUart.ReceiveBlock(Read, _delay, limitMs);
        // 応答が揃わないと T1Protocol が送り直す。再送の回数を記録から数えられるように残す
        if (reply is null) Log.Write($"[{Name}] カードの応答が {limitMs} ms の間に揃いませんでした");
        return reply;
    }

    /// <summary>機材を返す</summary>
    private void Drop()
    {
        var device = _device;
        _device = null;
        _prepared = null;
        _received.Clear();
        device?.Release();
    }

    /// <summary>閉じる。機材を返し、受信機も使っていなければ機材を閉じる (電源を切る)</summary>
    public void Dispose()
    {
        lock (_session)
        {
            _t1 = null;
            _atr = null;
            Drop();
        }
        _closeIdle?.Invoke();
    }
}
