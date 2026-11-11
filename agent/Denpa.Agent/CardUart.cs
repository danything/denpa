using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// MB86H47 のスマートカードの UART (MB86H47 の仕様書 13 章)。PIX-DT295 の MB86M01 も同じアドレスと同じ手順なので、
/// CECH-ZD1 J (<see cref="Mb86h47"/>・<see cref="Zd1jCard"/>) と PIX-DT295 (<see cref="Dt295NativeCard"/>) が使う。ATR と応答のブロックを受け切る手順と速さの読み方は、IT930x の機材の内蔵リーダー (<see cref="It930xCard"/>) も使う。
///
/// <para>
/// ここにあるのは両方で同じ所だけ: ATR から決める速さ、速さを変える、受けたバイトを読む、T=1 のブロックを送る、ATR と応答のブロックを受け切る。
/// 電源の入れ方と切り方、カードが挿さっているかの見方は機材ごとに違うので、それぞれのクラスに置く。
/// レジスタの読み書きには渡された関数を使う (CECH-ZD1 J はブリッジのロックの中で、PIX-DT295 は書いてよいレジスタを確かめてから)。
/// PIX-DT295 は、機材のプログラムが使えれば <see cref="Send"/>・<see cref="Read"/> の代わりに機材の中で同じ手順を実行させ
/// (<see cref="Dt295NativeLink.CardSend"/>・<see cref="Dt295NativeLink.CardReceive"/>)、<see cref="ReceiveAtr"/>・<see cref="ReceiveBlock"/> にはその読みを渡す
/// </para>
/// </summary>
/// <param name="read32">32 ビットのレジスタを読む</param>
/// <param name="write32">32 ビットのレジスタに書く</param>
internal sealed class CardUart(Func<uint, uint> read32, Action<uint, uint> write32)
{
    // レジスタ (MB86H47 の仕様書 13.1)
    internal const uint Enable = 0xFEA000;
    internal const uint Lines = 0xFEA004;
    internal const uint Baud = 0xFEA008;
    internal const uint Start = 0xFEA00C;
    internal const uint Control = 0xFEA010;
    internal const uint Count = 0xFEA014;
    internal const uint Mask = 0xFEA018;
    internal const uint Status = 0xFEA01C;
    internal const uint Cwt = 0xFEA020;
    internal const uint Bwt = 0xFEA024;
    internal const uint Tx = 0xFEA028;
    internal const uint Rx = 0xFEA02C;
    internal const uint Power = 0xFEA034;
    internal const uint TxLrc = 0xFEA038;
    internal const uint RxLrc = 0xFEA03C;

    /// <summary>ATR を待つ上限 (仕様書 13.7 の「1 秒まで」)</summary>
    private static readonly TimeSpan AtrTimeout = TimeSpan.FromSeconds(1);

    /// <summary>カードのクロック (Hz)。ATR を受ける 9600 ボー (F 372 / D 1) から 9600 × 372</summary>
    private const double CardClock = 9600.0 * 372;

    private static readonly int[] FiTable = [372, 372, 558, 744, 1116, 1488, 1860, 0, 0, 512, 768, 1024, 1536, 2048, 0, 0];
    private static readonly int[] DiTable = [0, 1, 2, 4, 8, 16, 32, 64, 12, 20, 0, 0, 0, 0, 0, 0];

    /// <summary>13.2 速さを変える (速さ・制御・CWT・BWT の順に)</summary>
    public void SetSpeed(uint baud, uint control, uint cwt, uint bwt)
    {
        write32(Baud, baud);
        write32(Control, control);
        write32(Cwt, cwt);
        write32(Bwt, bwt);
    }

    /// <summary>13.6 受けて読まれていないバイトを、<paramref name="max"/> まで読む。無ければ空</summary>
    public byte[] Read(int max)
    {
        var waiting = (int)(read32(Count) >> 16);
        var count = Math.Min(waiting, Math.Max(0, max));
        var received = new byte[count];
        for (var i = 0; i < count; i++) received[i] = (byte)read32(Rx);
        return received;
    }

    /// <summary>13.6 T=1 のブロックを LRC まで含めて丸ごと送る</summary>
    public void Send(ReadOnlySpan<byte> block)
    {
        write32(RxLrc, 0);
        write32(TxLrc, 0);
        foreach (var b in block) write32(Tx, b);
        write32(Status, 0x3FF);
        write32(Control, block.Length >= 256 ? 0x280u : 0x200u);
        write32(Start, 1);
    }

    /// <summary>
    /// TA1 から UART の 4 つのレジスタ (仕様書 13.2)。B-CAS は TA1 = 0x12 (F 372 / D 2) で 19200 ボー。
    /// <c>N = F / D</c>、速さ = <c>(N &lt;&lt; 7) | min(N &gt;&gt; 1, 0x7F)</c>、CWT = <c>3 × 2^CWI + 11</c>、
    /// BWT = <c>6,800,000 × D / F</c> (16 ビットまで)、制御 = <c>TC1 &lt;&lt; 16</c> (TC1 が 0xFF なら 1)
    /// </summary>
    internal static (uint Baud, uint Control, uint Cwt, uint Bwt, int Rate) Speed(Atr atr)
    {
        var f = FiTable[atr.FiDi >> 4];
        var d = DiTable[atr.FiDi & 0xF];
        if (f == 0 || d == 0 || f % d != 0) throw new IOException($"ATR の速さ (TA1 0x{atr.FiDi:X2}) に対応していません");
        var n = (uint)(f / d);
        var baud = (n << 7) | Math.Min(n >> 1, 0x7F);
        var cwt = (uint)(3 * (1 << atr.Cwi) + 11);
        var bwt = (uint)Math.Min(0xFFFF, 6_800_000L * d / f);
        var control = (uint)(atr.GuardN == 0xFF ? 1 : atr.GuardN) << 16;
        return (baud, control, cwt, bwt, (int)(CardClock / n));
    }

    /// <summary>1 ブロックの待ち (仕様書 13.7 の「500ms から。ATR の BWI で変わる」。3 秒まで)</summary>
    internal static int BlockWaitMs(Atr atr) => Math.Min(3000, 500 << Math.Max(0, atr.Bwi - 4));

    /// <summary>ATR の長さ。まだ決まらなければ null</summary>
    internal static int? AtrLength(IReadOnlyList<byte> atr)
    {
        if (atr.Count < 2) return null;
        var y = atr[1] >> 4;
        var historical = atr[1] & 0x0F;
        var at = 2;
        var tck = false;
        for (; ; )
        {
            var td = (y & 8) != 0;
            at += int.PopCount(y & 7) + (td ? 1 : 0);
            if (!td) break;
            if (at > atr.Count) return null;
            var d = atr[at - 1];
            if ((d & 0x0F) != 0) tck = true;
            y = d >> 4;
        }
        return at + historical + (tck ? 1 : 0);
    }

    /// <summary>
    /// ATR を 1 秒まで受ける。長さは T0 と TDi から決まる。1 バイトも来なければ <see cref="IOException"/>
    /// </summary>
    /// <param name="read">受けたバイトを最大いくつまで読むか渡して読む (<see cref="Read"/>)</param>
    /// <param name="delay">何も来なかったときに待つ (ms)</param>
    internal static byte[] ReceiveAtr(Func<int, byte[]> read, Action<int> delay, string name)
    {
        var received = new List<byte>();
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < AtrTimeout)
        {
            var got = read(33 - received.Count);
            received.AddRange(got);
            if (AtrLength(received) is { } length && received.Count >= length) return [.. received.Take(length)];
            if (got.Length == 0) delay(2);
        }
        if (received.Count == 0) throw new IOException($"{name} のカードが ATR を返しません");
        return [.. received];
    }

    /// <summary>
    /// 送ったブロックの応答を 1 つ受ける。受けは「受けた数が 0 でなくなる」だけを合図に先頭の 3 バイトを読み、
    /// 長さぶんと LRC を読む。<paramref name="limitMs"/> の間に揃わなければ null (T1Protocol が送り直す)
    /// </summary>
    internal static byte[]? ReceiveBlock(Func<int, byte[]> read, Action<int> delay, int limitMs)
    {
        var limit = TimeSpan.FromMilliseconds(limitMs);
        var received = new List<byte>();
        var since = Stopwatch.StartNew();
        while (since.Elapsed < limit)
        {
            var got = read(received.Count < 3 ? 3 - received.Count : received[2] + 4 - received.Count);
            received.AddRange(got);
            // 揃ったかは読んだ直後に見る。待ちの最後に揃ったものを捨てて送り直させない
            if (received.Count >= 3 && received.Count >= received[2] + 4) return [.. received];
            if (got.Length == 0) delay(1);
        }
        return null;
    }
}
