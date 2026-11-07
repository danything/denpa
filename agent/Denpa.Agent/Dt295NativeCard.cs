using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 の内蔵のカードの差し込み口 (B-CAS)。ホストがカードの UART (0xFEA000〜。MB86H47 と同じレジスタ) を
/// <see cref="Dt295NativeLink"/> の 0xBC のメモリ要求で直に動かす (常駐のファームウェアの CARD 0x2C は使わない)。
///
/// <para>
/// 電源投入・切断の手順は仕様書 §10 の表 (投入 17 段・切断 5 段)。各段のあとに 20 ms 待つ (投入の 15 段目の 0xFEA014 = 0x0D は 50 ms)。
/// 0xFEA004 に書く値の 4 つは、カードの端子の極性 (0xF00223) と、いまの 0xFEA004 から決める (§10 の設定確認)。
/// ATR のあとの速さ・T=1 は CECH-ZD1 J の差し込み口と同じ (<see cref="Zd1jCard"/>。UART のレジスタが同じ)。
/// 書いてよいレジスタは <see cref="Dt295NativeLink.AllowCardUart"/> が許した 0xFEA000〜0xFEA03F だけ。0xF00222〜0xF0022E は読むだけ
/// </para>
/// </summary>
public sealed class Dt295NativeCard : ICardLink
{
    private const uint Enable = Mb86h47.CardEnable, Lines = Mb86h47.CardLines, Count = Mb86h47.CardCount, Status = Mb86h47.CardStatus;

    /// <summary>カードの端子の極性の読み出し (仕様書 §10 の 0xF00223・0xF00224・0xF0022E)。4 の倍数のアドレスの語から取る</summary>
    private const uint PinWordA = 0xF00220, PinWordB = 0xF00224, PinWordC = 0xF0022C;

    private static readonly TimeSpan AtrTimeout = TimeSpan.FromSeconds(1);

    private readonly Func<Dt295NativeLink> _acquire;
    private readonly Action? _release;
    private readonly Action<Exception>? _fail;
    private readonly Action<int> _delay;
    private readonly Action<string>? _log;
    private Dt295NativeLink? _link;
    private T1Protocol? _t1;
    private int _blockWaitMs = 500;
    private bool _powered;

    public string Name { get; }

    /// <param name="acquire">機材のリンクを取る (最初に使うとき。<see cref="Dt295NativeDevice.Acquire"/>)</param>
    /// <param name="release">リンクを返す (<see cref="Dispose"/> で 1 回)</param>
    /// <param name="fail">やり取りが失敗したときに渡す (機材に使えない印を付ける)</param>
    public Dt295NativeCard(string name, Func<Dt295NativeLink> acquire, Action? release = null, Action<Exception>? fail = null, Action<int>? delay = null, Action<string>? log = null)
    {
        Name = name;
        _acquire = acquire;
        _release = release;
        _fail = fail;
        _delay = delay ?? Thread.Sleep;
        _log = log;
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
    public (byte Polarity, byte Insert, byte Other) Pins()
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
        if (polarity == 1 && insert == 1 && other == 0) throw new Dt295NativeException("この端子の組み合わせ (0xF00223 = 1、0xF00224 = 1、0xF0022E = 0) は常駐のファームウェアも使えない扱いです");
        var first = Link.Read32(Lines) & ~4u;
        var third = polarity == 0 ? 8u : 0u;
        (uint Address, uint Value, int Wait)[] table =
        [
            (Status, 0x3FF, 20), (Lines, first, 20), (Count, 0, 20), (Enable, 0, 20), (Enable, 7, 20),
            (Lines, third, 20), (Mb86h47.CardBaud, 0xBA7F, 20), (Lines, third | 2, 20), (Enable, 0, 20), (Enable, 7, 20),
            (Mb86h47.CardRxLrc, 0x3B, 20), (Mb86h47.CardCwt, 0x2580, 20), (Mb86h47.CardBwt, 0, 20), (Mb86h47.CardMask, 0, 20),
            (Count, 0x0D, 50), (Mb86h47.CardPower, 1, 20), (Lines, third | 6, 20),
        ];
        _powered = true;
        foreach (var (address, value, wait) in table)
        {
            Write(address, value);
            _delay(wait);
        }
    }

    public byte[] Reset()
    {
        try
        {
            return ResetCore();
        }
        catch (Exception error) when (error is IOException or TimeoutException)
        {
            _fail?.Invoke(error);
            throw;
        }
    }

    private byte[] ResetCore()
    {
        _t1 = null;
        if (_powered) PowerOff();
        PowerOn();
        var raw = ReadAtr();
        _log?.Invoke($"ATR: {Convert.ToHexString(raw)}");
        var atr = Atr.Parse(raw);
        if (!atr.T1) throw new IOException($"T=1 に対応していないカードです (ATR {Convert.ToHexString(raw)})");
        var (baud, control, cwt, bwt, rate) = Zd1jCard.Speed(atr);
        Write(Mb86h47.CardBaud, baud);
        Write(Mb86h47.CardControl, control);
        Write(Mb86h47.CardCwt, cwt);
        Write(Mb86h47.CardBwt, bwt);
        _blockWaitMs = Math.Min(3000, 500 << Math.Max(0, atr.Bwi - 4));
        _t1 = new T1Protocol(atr, Exchange);
        _t1.NegotiateIfsd(rate >= 38400 ? 254 : 251);
        return raw;
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_t1 is null) throw new IOException($"{Name} のカードに繋いでいません (Reset を先に)");
        try
        {
            if (!Present())
            {
                _t1 = null;
                throw new CardAbsentException($"{Name} のカードが抜かれました");
            }
            return _t1.Transmit(apdu);
        }
        catch (Exception error) when (error is IOException and not CardAbsentException or TimeoutException)
        {
            _fail?.Invoke(error);
            throw;
        }
    }

    private byte[] Read(int max)
    {
        var waiting = (int)(Link.Read32(Count) >> 16);
        var count = Math.Min(waiting, Math.Max(0, max));
        var received = new byte[count];
        for (var i = 0; i < count; i++) received[i] = (byte)Link.Read32(Mb86h47.CardRx);
        return received;
    }

    private byte[] ReadAtr()
    {
        var received = new List<byte>();
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < AtrTimeout)
        {
            var got = Read(33 - received.Count);
            received.AddRange(got);
            if (Zd1jCard.AtrLength(received) is { } length && received.Count >= length) return [.. received.Take(length)];
            if (got.Length == 0) _delay(2);
        }
        if (received.Count == 0) throw new IOException($"{Name} のカードが ATR を返しません");
        return [.. received];
    }

    /// <summary>T=1 のブロックを 1 つ送って 1 つ受ける (Zd1jCard と同じ。時間切れは null)</summary>
    private byte[]? Exchange(byte[] block, byte wtx)
    {
        Write(Mb86h47.CardRxLrc, 0);
        Write(Mb86h47.CardTxLrc, 0);
        foreach (var b in block) Write(Mb86h47.CardTx, b);
        Write(Status, 0x3FF);
        Write(Mb86h47.CardControl, block.Length >= 256 ? 0x280u : 0x200u);
        Write(Mb86h47.CardSend, 1);
        var limit = TimeSpan.FromMilliseconds(_blockWaitMs * Math.Max(1, (int)wtx));
        var received = new List<byte>();
        var since = Stopwatch.StartNew();
        while (since.Elapsed < limit)
        {
            var want = received.Count < 3 ? 3 - received.Count : received[2] + 4 - received.Count;
            if (want <= 0) return [.. received];
            var got = Read(want);
            received.AddRange(got);
            if (got.Length == 0) _delay(1);
        }
        return null;
    }

    public void Dispose()
    {
        _t1 = null;
        if (_link is null) return;
        try
        {
            if (_powered && !_link.Dead) PowerOff();
        }
        catch (Exception error) when (error is IOException or TimeoutException)
        {
            _log?.Invoke($"カードの電源を切れませんでした: {error.Message}");
        }
        finally
        {
            _link = null;
            _release?.Invoke();
        }
    }
}
