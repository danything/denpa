namespace Denpa.Agent;

/// <summary>
/// ATR から T=1 で話すのに要る値だけ読んだもの (ISO/IEC 7816-3 の 8)。
///
/// <para>
/// B-CAS は <c>3B F0 12 00 FF 91 81 B1 7C 45 1F 03 99</c>。TA2 (<c>81</c>) があるので
/// **specific mode** — カードは ATR の直後から TA1 (<c>12</c> = Fi 372 / Di 2) の速さで話す。
/// PPS は要らないが、読み取り機にその速さを教えないと話が通じない (<see cref="CcidLink"/>)。
/// T=1 用の値は TD3 が T=1 を示したあとの TA4 (IFSC = 0x7C) と TB4 (BWI 4 / CWI 5)。
/// </para>
/// </summary>
/// <param name="FiDi">TA1。無ければ既定の 0x11</param>
/// <param name="GuardN">TC1 (追加の保護時間)</param>
/// <param name="Specific">TA2 がある (specific mode)</param>
/// <param name="Protocols">カードが話せるプロトコルの bit (bit0 = T=0、bit1 = T=1)</param>
/// <param name="Crc">T=1 の誤り検出が CRC (無ければ LRC)</param>
/// <param name="Inverse">逆方向の規約 (TS = 3F)</param>
public sealed record Atr(
    byte[] Raw, byte FiDi, byte GuardN, bool Specific, int Protocols,
    int Ifsc, int Bwi, int Cwi, bool Crc, bool Inverse)
{
    public bool T1 => (Protocols & 2) != 0;

    public static Atr Parse(ReadOnlySpan<byte> atr)
    {
        if (atr.Length < 2) throw new IOException("ATR が短すぎます");
        var inverse = atr[0] switch
        {
            0x3B => false,
            0x3F => true,
            _ => throw new IOException($"ATR の TS が読めません (0x{atr[0]:X2})"),
        };

        byte fiDi = 0x11, guard = 0;
        var specific = false;
        var protocols = 0;
        int ifsc = 32, bwi = 4, cwi = 13;
        bool crc = false, sawIfsc = false, sawBw = false, sawEdc = false;
        var needTck = false;

        var at = 1;
        var y = atr[1] >> 4;
        var historical = atr[1] & 0x0f;
        at++;
        // i は TA_i などの i。protocol は直前の TD_{i-1} が示したプロトコル (最初は T=0)
        var protocol = 0;
        for (var i = 1; ; i++)
        {
            byte? ta = null, tb = null, tc = null, td = null;
            if ((y & 1) != 0) ta = Next(atr, ref at);
            if ((y & 2) != 0) tb = Next(atr, ref at);
            if ((y & 4) != 0) tc = Next(atr, ref at);
            if ((y & 8) != 0) td = Next(atr, ref at);

            if (i == 1)
            {
                if (ta is { } a) fiDi = a;
                if (tc is { } c) guard = c;
            }
            else if (i == 2)
            {
                specific = ta is not null;
            }
            // T=1 の値は、T=1 を示した TD のあとの最初の TA / TB / TC (i > 2)
            else if (protocol == 1)
            {
                if (ta is { } a && !sawIfsc)
                {
                    ifsc = a;
                    sawIfsc = true;
                }
                if (tb is { } b && !sawBw)
                {
                    bwi = b >> 4;
                    cwi = b & 0x0f;
                    sawBw = true;
                }
                if (tc is { } c && !sawEdc)
                {
                    crc = (c & 1) != 0;
                    sawEdc = true;
                }
            }

            if (td is not { } d) break;
            protocol = d & 0x0f;
            if (protocol != 15) protocols |= 1 << protocol;
            if (protocol != 0) needTck = true;
            y = d >> 4;
        }
        // TD1 が無ければ T=0 だけ
        if (protocols == 0) protocols = 1;

        at += historical;
        if (at > atr.Length) throw new IOException("ATR が途中で切れています");
        if (needTck)
        {
            if (at >= atr.Length) throw new IOException("ATR に TCK がありません");
            byte sum = 0;
            for (var k = 1; k <= at; k++) sum ^= atr[k];
            if (sum != 0) throw new IOException("ATR の TCK が合いません");
        }
        // IFSC 0 と 255 は使えない値。既定に戻す
        if (ifsc is 0 or 255) ifsc = 32;
        return new Atr(atr.ToArray(), fiDi, guard, specific, protocols, ifsc, bwi, cwi, crc, inverse);
    }

    private static byte Next(ReadOnlySpan<byte> atr, ref int at)
    {
        if (at >= atr.Length) throw new IOException("ATR が途中で切れています");
        return atr[at++];
    }

    public override string ToString() =>
        $"{Convert.ToHexString(Raw)} (T=1 {(T1 ? "可" : "不可")}, Fi/Di 0x{FiDi:X2}{(Specific ? " specific" : "")}, "
        + $"IFSC {Ifsc}, BWI {Bwi}, CWI {Cwi}, {(Crc ? "CRC" : "LRC")})";
}

/// <summary>
/// ISO/IEC 7816-3 の T=1 (ブロックの送り合い)。**TPDU 単位の読み取り機のときだけ**使う。
///
/// <para>
/// 読み取り機はブロックを1つ送って1つ受けるだけで、順番の番号・連結・再送はこちらが持つ。
/// 下の口 (<c>exchange</c>) は「送ったブロックと、返ってきたブロック」だけを扱い、
/// **返ってこなかった・化けた (カードが黙った、パリティ誤り) は null** で知らせる。
/// 投げるのは読み取り機そのものが駄目なとき (抜かれた、カードが無い) だけ。
/// 2つめの引数は WTX で延ばす倍率 (0 なら延ばさない)。
/// </para>
///
/// <para>
/// LRC のカードだけ。CRC のカードは断る (B-CAS は LRC。CRC は試せる相手が居ない)。
/// NAD はいつも 0。
/// </para>
/// </summary>
public sealed class T1Protocol
{
    /// <summary>1つのブロックを諦めるまでに再送を頼む回数</summary>
    private const int MaxRetries = 3;

    /// <summary>
    /// 1つの APDU のあいだに受ける S(WTX) / S(IFS) の上限。**これが無いと、求め続ける
    /// カードで永久に返らない** — カードは1枚を全チューナーで共有しているので、1本が
    /// ここで止まると全部の解除が道連れになる。B-CAS の ECM は普通 1〜2 回で済む
    /// </summary>
    private const int MaxSupervisory = 16;

    private readonly Func<byte[], byte, byte[]?> _exchange;
    private byte _ns;
    private byte _nr;

    /// <summary>カードが受けられる情報欄の長さ</summary>
    public int Ifsc { get; private set; }

    /// <summary>こちらが受けられる情報欄の長さ。<see cref="NegotiateIfsd"/> で上げる</summary>
    public int Ifsd { get; private set; } = 32;

    public T1Protocol(Atr atr, Func<byte[], byte, byte[]?> exchange)
    {
        if (atr.Crc) throw new IOException("CRC で誤りを検出する T=1 カードには対応していません");
        Ifsc = atr.Ifsc;
        _exchange = exchange;
    }

    private const byte RBlock = 0x80;
    private const byte SBlock = 0xC0;
    private const byte SResponse = 0x20;
    private const byte SIfs = 0x01;
    private const byte SAbort = 0x02;
    private const byte SWtx = 0x03;

    public static byte Lrc(ReadOnlySpan<byte> data)
    {
        byte sum = 0;
        foreach (var b in data) sum ^= b;
        return sum;
    }

    public static byte[] Block(byte pcb, ReadOnlySpan<byte> inf)
    {
        var block = new byte[inf.Length + 4];
        block[1] = pcb;
        block[2] = (byte)inf.Length;
        inf.CopyTo(block.AsSpan(3));
        block[^1] = Lrc(block.AsSpan(0, block.Length - 1));
        return block;
    }

    /// <summary>正しい形のブロックなら (PCB, INF)。長さ・LRC が合わなければ null</summary>
    public static (byte Pcb, byte[] Inf)? Check(byte[]? block, int ifsd)
    {
        if (block is null || block.Length < 4) return null;
        int length = block[2];
        if (length == 0xff || block.Length != length + 4) return null;
        if (Lrc(block) != 0) return null;
        var pcb = block[1];
        if ((pcb & 0x80) == 0 && length > ifsd) return null;
        if ((pcb & 0xC0) == RBlock && length != 0) return null;
        return (pcb, block[3..^1]);
    }

    /// <summary>
    /// S(IFS) でこちらの受け口を広げる。**答えなければ既定の 32 のまま続ける** (連結で
    /// 受ければ済むので致命的ではない)。ATR の直後に1回だけ呼ぶ
    /// </summary>
    public void NegotiateIfsd(int ifsd)
    {
        ifsd = Math.Clamp(ifsd, 1, 254);
        var request = Block(SBlock | SIfs, [(byte)ifsd]);
        for (var attempt = 0; attempt <= MaxRetries; attempt++)
        {
            var reply = Check(_exchange(request, 0), Ifsd);
            if (reply is { Pcb: SBlock | SResponse | SIfs, Inf: [var got] } && got == ifsd)
            {
                Ifsd = ifsd;
                return;
            }
        }
    }

    /// <summary>
    /// APDU を1つ送って応答を受ける。
    ///
    /// <para>
    /// 送る側の連結: IFSC ごとに切って M を立てた I ブロックで送り、カードの R(次の番号) を待つ。
    /// 受ける側の連結: M の立った I ブロックが来たら R(次の番号) で続きを頼む。
    /// 化けた・来なかったときは R ブロックで再送を頼み、カードの R(こちらの番号) には
    /// 最後の I ブロックを送り直す。
    /// </para>
    /// </summary>
    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        var command = apdu.ToArray();
        var offset = 0;
        var current = NextChunk(command, ref offset);
        var sending = true;
        var toSend = current;
        var response = new List<byte>();
        var errors = 0;
        var supervisory = 0;
        byte wtx = 0;

        for (; ; )
        {
            var raw = _exchange(toSend, wtx);
            wtx = 0;
            var reply = Check(raw, Ifsd);
            if (reply is not { } block)
            {
                if (++errors > MaxRetries) throw new IOException("カードとのやり取りが化け続けます (T=1)");
                // 誤りの種類: 1 = EDC / パリティ、2 = それ以外
                toSend = Block((byte)(RBlock | (_nr << 4) | (raw is null ? 2 : 1)), []);
                continue;
            }

            var pcb = block.Pcb;
            if ((pcb & 0x80) == 0)
            {
                // I ブロック。こちらの最後の I ブロックが受け取られたことにもなる
                if (sending)
                {
                    if (offset < command.Length) throw new IOException("カードが連結の途中で応答しました (T=1)");
                    _ns ^= 1;
                    sending = false;
                }
                if (((pcb >> 6) & 1) != _nr)
                {
                    // 前に受けたものの繰り返し。もう一度頼み直す
                    if (++errors > MaxRetries) throw new IOException("カードの I ブロックの番号が合いません (T=1)");
                    toSend = Block((byte)(RBlock | (_nr << 4)), []);
                    continue;
                }
                _nr ^= 1;
                errors = 0;
                response.AddRange(block.Inf);
                if ((pcb & 0x20) == 0) return [.. response];
                toSend = Block((byte)(RBlock | (_nr << 4)), []);
            }
            else if ((pcb & 0xC0) == RBlock)
            {
                var wanted = (pcb >> 4) & 1;
                if (sending && wanted != _ns && offset < command.Length)
                {
                    // 連結の途中の I ブロックを受け取った。次を送る
                    _ns ^= 1;
                    errors = 0;
                    current = NextChunk(command, ref offset);
                    toSend = current;
                    continue;
                }
                // 送り直しの求め (こちらが最後に送ったものが届いていない)
                if (++errors > MaxRetries) throw new IOException("カードが再送を求め続けます (T=1)");
                toSend = sending ? current : Block((byte)(RBlock | (_nr << 4)), []);
            }
            else
            {
                switch (pcb & 0x3f)
                {
                    case SWtx or SIfs when ++supervisory > MaxSupervisory:
                        throw new IOException($"カードが待ちの延長や長さの変更を求め続けます (T=1、{MaxSupervisory} 回)");
                    case SWtx when block.Inf is [var multiplier]:
                        toSend = Block(SBlock | SResponse | SWtx, [multiplier]);
                        wtx = multiplier;
                        break;
                    case SIfs when block.Inf is [var ifsc] && ifsc is > 0 and < 255:
                        Ifsc = ifsc;
                        toSend = Block(SBlock | SResponse | SIfs, [ifsc]);
                        break;
                    case SAbort:
                        throw new IOException("カードがやり取りを打ち切りました (T=1 S(ABORT))");
                    default:
                        if (++errors > MaxRetries) throw new IOException($"カードから思わぬ S ブロックが来ました (PCB 0x{pcb:X2})");
                        toSend = sending ? current : Block((byte)(RBlock | (_nr << 4)), []);
                        break;
                }
            }
        }
    }

    private byte[] NextChunk(byte[] command, ref int offset)
    {
        var length = Math.Min(Ifsc, command.Length - offset);
        var more = offset + length < command.Length;
        var pcb = (byte)((_ns << 6) | (more ? 0x20 : 0));
        var block = Block(pcb, command.AsSpan(offset, length));
        offset += length;
        return block;
    }
}
