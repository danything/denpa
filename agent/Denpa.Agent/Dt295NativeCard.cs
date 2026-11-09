namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 の内蔵のカードの差し込み口 (B-CAS)。カードの UART (0xFEA000〜。MB86H47 と同じレジスタ) を、ホストが
/// <see cref="Dt295NativeLink"/> の 0xBC のメモリ要求で動かす (仕様書の常駐イメージの CARD 0x2C は使わない)。
/// 電源の投入・切断と速さの設定は、いつもホストが書く。
///
/// <para>
/// 電源投入・切断の手順は仕様書 §10 の表 (投入 17 段・切断 5 段)。各段のあとに 20 ms 待つ (投入の 15 段目の 0xFEA014 = 0x0D は 50 ms)。
/// 0xFEA004 に書く値の 4 つは、カードの端子の極性 (0xF00223) と、いまの 0xFEA004 から決める (§10 の設定確認)。
/// ATR を受ける・速さを変える・T=1 のブロックを送受信する手順は、CECH-ZD1 J の差し込み口と共通にしている (<see cref="CardUart"/>。UART のレジスタが同じ)。
/// ATR と T=1 のブロックの送受信は、機材のプログラムが使えれば (<see cref="Dt295NativeLink.CardProgram"/>) 機材の中で実行させる
/// (<see cref="Dt295NativeLink.CardSend"/>・<see cref="Dt295NativeLink.CardReceive"/>。1 バイトごとの制御転送を、1 ブロック数回にする)。
/// 使えなければホストが 1 バイトずつ読み書きする (<see cref="CardUart.Send"/>・<see cref="CardUart.Read"/>)。
/// 書いてよいレジスタは <see cref="Dt295NativeLink.AllowCardUart"/> が許した 0xFEA000〜0xFEA03F だけ。0xF00222〜0xF0022E は読むだけ
/// </para>
/// </summary>
public sealed class Dt295NativeCard : ICardLink
{
    private const uint Enable = CardUart.Enable, Lines = CardUart.Lines, Count = CardUart.Count, Status = CardUart.Status;

    /// <summary>カードの端子の極性の読み出し (仕様書 §10 の 0xF00223・0xF00224・0xF0022E)。4 の倍数のアドレスの語から取る</summary>
    private const uint PinWordA = 0xF00220, PinWordB = 0xF00224, PinWordC = 0xF0022C;

    private readonly Func<Dt295NativeLink> _acquire;
    private readonly Action<int> _delay;
    private readonly CardUart _uart;
    private Dt295NativeLink? _link;
    private T1Protocol? _t1;
    private int _blockWaitMs = 500;
    private bool _powered;
    private byte[]? _atr;

    /// <summary>電源の入れ方から T=1 までの流れ (<see cref="Reset"/>)、送受信 (<see cref="Transmit"/>)、電源を切る (<see cref="Dispose"/>) を 1 つずつ通す (準備を別のスレッドで進めるため)</summary>
    private readonly Lock _session = new();

    public string Name { get; }

    /// <param name="acquire">機材のリンクを取る (最初に使うとき)。機材に使えない印を付けるのは、持ち主の <see cref="Dt295NativeCardHandle"/></param>
    public Dt295NativeCard(string name, Func<Dt295NativeLink> acquire, Action<int>? delay = null)
    {
        Name = name;
        _acquire = acquire;
        _delay = delay ?? Thread.Sleep;
        _uart = new CardUart(address => Link.Read32(address), Write);
    }

    private Dt295NativeLink Link
    {
        get
        {
            if (_link is null)
            {
                _link = _acquire();
                _link.AllowCardUart = true;
            }
            return _link;
        }
    }

    /// <summary>端子の読み値。F00223 (極性)・F00224・F0022E は 1 バイトずつ (仕様書 §10)</summary>
    private (byte Polarity, byte Insert, byte Other) Pins()
    {
        var a = Link.Read32(PinWordA);
        var b = Link.Read32(PinWordB);
        var c = Link.Read32(PinWordC);
        return ((byte)a, (byte)(b >> 24), (byte)(c >> 8));
    }

    /// <summary>
    /// カードが挿さっているか。0xFEA01C の bit10 と 0xF00224 の XOR (仕様書 §10)。XOR が 1 なら挿さっている。
    /// 実機の観測 (仕様書に無い): カードを挿すと、0xF00224 = 0 のまま 0xFEA01C の bit10 が 1 になる
    /// (CECH-ZD1 J の MB86H47 は逆に、bit10 が 0 のとき挿さっている)
    /// </summary>
    public bool Present()
    {
        var bit10 = (Link.Read32(Status) >> 10) & 1;
        return (bit10 ^ (Pins().Insert & 1u)) == 1;
    }

    private void Write(uint address, uint value) => Link.Write32(address, value);

    /// <summary>電源を切る (仕様書 §10 の切断の表 5 段)</summary>
    private void PowerOff()
    {
        foreach (var (address, value) in new (uint, uint)[] { (Lines, 2), (Count, 0), (Enable, 3), (Lines, 0), (Lines, 8) })
        {
            Write(address, value);
            _delay(20);
        }
        _powered = false;
    }

    /// <summary>
    /// 電源を入れる (仕様書 §10 の投入の 17 段)。0xFEA004 の 4 つの値は設定確認で決まる:
    /// 段 1 = いまの 0xFEA004 の bit2 を落とした値、段 5 = (0xF00223 が 0) を bit3 にした値、段 7 = 段 5 | 2、段 16 = 段 5 | 6
    /// </summary>
    private void PowerOn()
    {
        var (polarity, insert, other) = Pins();
        if (polarity > 1 || insert > 1 || other > 1) throw new Dt295NativeException($"カードの端子の読み値が仕様書の範囲外です (0xF00223 = {polarity}、0xF00224 = {insert}、0xF0022E = {other})");
        if (polarity == 1 && insert == 1 && other == 0) throw new Dt295NativeException("この端子の組み合わせ (0xF00223 = 1、0xF00224 = 1、0xF0022E = 0) は仕様書で使えない扱いです");
        var first = Link.Read32(Lines) & ~4u;
        var third = polarity == 0 ? 8u : 0u;
        (uint Address, uint Value, int Wait)[] table =
        [
            (Status, 0x3FF, 20), (Lines, first, 20), (Count, 0, 20), (Enable, 0, 20), (Enable, 7, 20),
            (Lines, third, 20), (CardUart.Baud, 0xBA7F, 20), (Lines, third | 2, 20), (Enable, 0, 20), (Enable, 7, 20),
            (CardUart.RxLrc, 0x3B, 20), (CardUart.Cwt, 0x2580, 20), (CardUart.Bwt, 0, 20), (CardUart.Mask, 0, 20),
            (Count, 0x0D, 50), (CardUart.Power, 1, 20), (Lines, third | 6, 20),
        ];
        _powered = true;
        foreach (var (address, value, wait) in table)
        {
            Write(address, value);
            _delay(wait);
        }
    }

    /// <summary>
    /// 電源を入れて ATR を返す。***電源が入って T=1 の取り決め (IFSD) が済んでいて、カードが挿さっていれば、入れ直さずにその ATR を返す**
    /// (機材を開いたあと、選局と並べて準備しておくため。<see cref="Dt295NativeDevice.WarmCard"/>)。送受信が失敗したあとは入れ直す
    /// </summary>
    public byte[] Reset()
    {
        lock (_session)
        {
            if (_t1 is not null && _atr is { } ready && Present()) return ready;
            return _atr = ResetCore();
        }
    }

    private byte[] ResetCore()
    {
        _t1 = null;
        _atr = null;
        if (_powered) PowerOff();
        // 電源を入れてから ATR を受け切るまで、TS の要求を小さくさせる (受けたバイトを早く読み、受信 FIFO が溢れないように)
        byte[] raw;
        Link.EnterCard();
        try
        {
            PowerOn();
            raw = ReadAtr();
        }
        finally
        {
            Link.LeaveCard();
        }
        var atr = Atr.Parse(raw);
        if (!atr.T1) throw new IOException($"T=1 に対応していないカードです (ATR {Convert.ToHexString(raw)})");
        var (baud, control, cwt, bwt, rate) = CardUart.Speed(atr);
        _uart.SetSpeed(baud, control, cwt, bwt);
        _blockWaitMs = CardUart.BlockWaitMs(atr);
        _t1 = new T1Protocol(atr, Exchange);
        _t1.NegotiateIfsd(rate >= 38400 ? 254 : 251);
        return raw;
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        lock (_session)
        {
            if (_t1 is null) throw new IOException($"{Name} のカードに繋いでいません (Reset を先に)");
            try
            {
                if (!Present())
                {
                    _t1 = null;
                    _atr = null;
                    throw new CardAbsentException($"{Name} のカードが抜かれました");
                }
                return _t1.Transmit(apdu);
            }
            catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
            {
                // T=1 のやり取りの状態が崩れたかもしれない。次の Reset は電源から入れ直す
                _t1 = null;
                _atr = null;
                throw;
            }
        }
    }

    private byte[] ReadAtr() => CardUart.ReceiveAtr(Read, _delay, Name);

    /// <summary>受けて読まれていないバイトを <paramref name="max"/> まで読む。機材のプログラムが使えればそれで、使えなければホストが 1 バイトずつ</summary>
    private byte[] Read(int max) => Link.CardProgram ? Link.CardReceive(max) : _uart.Read(max);

    /// <summary>T=1 のブロックを LRC まで含めて送る。機材のプログラムが使えればそれで、使えなければホストが 1 バイトずつ</summary>
    private void Send(byte[] block)
    {
        if (Link.CardProgram) Link.CardSend(block);
        else _uart.Send(block);
    }

    /// <summary>T=1 のブロックを 1 つ送って 1 つ受ける。時間切れは null (<see cref="CardUart.ReceiveBlock"/>)</summary>
    private byte[]? Exchange(byte[] block, byte wtx)
    {
        // 送ってから受け切るまで、TS の要求を小さくさせる (受けたバイトを早く読み、受信 FIFO が溢れないように)
        var link = Link;
        link.EnterCard();
        try
        {
            Send(block);
            var limitMs = _blockWaitMs * Math.Max(1, (int)wtx);
            var reply = CardUart.ReceiveBlock(Read, _delay, limitMs);
            // 応答が揃わないと T1Protocol が送り直す。送り直しの回数を記録から数えられるように残す
            if (reply is null) Log.Write($"[{Name}] カードの応答が {limitMs} ms の間に揃いませんでした");
            return reply;
        }
        finally
        {
            link.LeaveCard();
        }
    }

    public void Dispose()
    {
        lock (_session)
        {
            _t1 = null;
            _atr = null;
            if (_link is null) return;
            try
            {
                if (_powered && !_link.Dead) PowerOff();
            }
            catch (Exception error) when (error is IOException or TimeoutException or ObjectDisposedException)
            {
                // 機材が先に閉じられていたとき (エージェントを止めるとき) も、ここから例外を出さない
                Log.Write($"[{Name}] カードの電源を切れませんでした ({error.Message})");
            }
            finally
            {
                // カードを閉じたあとは、カードの UART に書けないようにする (許可はカードが使っている間だけ)
                _link.AllowCardUart = false;
                _link = null;
            }
        }
    }
}

/// <summary>
/// 機材 1 台のカード (<see cref="Dt295NativeDevice.Card"/>) を、カードリーダーの並び (CardLinks) に出す入れ物。
/// カードは機材を開いている間は電源が入ったままで (選局と並べて準備するため)、これを閉じても電源は切らない。機材を閉じるときに切る
/// </summary>
public sealed class Dt295NativeCardHandle(string name, Dt295NativeDevice device) : ICardLink
{
    private int _disposed;

    public string Name { get; } = name;

    public byte[] Reset()
    {
        try
        {
            return device.Card.Reset();
        }
        catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
        {
            device.Fail(error);
            throw;
        }
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        try
        {
            return device.Card.Transmit(apdu);
        }
        catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
        {
            device.Fail(error);
            throw;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0) device.Release();
    }
}