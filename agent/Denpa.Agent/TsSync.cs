namespace Denpa.Agent;

/// <summary>
/// バイト列の中で TS パケットの先頭 (同期バイト 0x47) を探す。機材ごとに揃える側 (<see cref="NativeTsFramer"/>・<see cref="SianoTsAligner"/>・
/// <see cref="Mb86h47Framer"/>・<see cref="Descrambler"/>) が使う。どれも位置を返すだけで、持ち越しと捨てたバイトの数は呼ぶ側が持つ
/// </summary>
internal static class TsSync
{
    public const byte Byte = 0x47;
    public const int Packet = 188;

    /// <summary>パケットの PID (2・3 バイト目の下位 13 ビット)</summary>
    public static int Pid(ReadOnlySpan<byte> packet) => ((packet[1] & 0x1F) << 8) | packet[2];

    /// <summary>
    /// <paramref name="from"/> から 1 バイトずつ進めて、<c>i + offset</c> と <c>i + offset + stride</c> の両方が 0x47 になる最初の i を返す
    /// (TS の中身の 0x47 は珍しくないので、1 つだけでは先頭とみなさない)。2 つ目の位置がまだ届いていない i は候補にしない。
    /// 見つからなければ <c>Math.Max(from, data.Length - offset - stride)</c> を返す。
    /// 見つかったかどうかは、返した i で <c>i + offset + stride &lt; data.Length</c> が成り立つかで分かる
    /// </summary>
    public static int FindPair(ReadOnlySpan<byte> data, int from, int stride, int offset = 0)
    {
        var i = from;
        while (i + offset + stride < data.Length && (data[i + offset] != Byte || data[i + offset + stride] != Byte)) i++;
        return i;
    }

    /// <summary>
    /// <paramref name="from"/> から 1 バイトずつ進めて、残りが 188 バイト以上あり先頭が 0x47 の最初の位置を返す。
    /// 見つからなければ、残りが 188 バイトを切った最初の位置 (<c>Math.Max(from, data.Length - 187)</c>) を返す
    /// </summary>
    public static int FindSingle(ReadOnlySpan<byte> data, int from)
    {
        var i = from;
        while (data.Length - i >= Packet && data[i] != Byte) i++;
        return i;
    }

    /// <summary><paramref name="from"/> から、先頭が 0x47 の 188 バイトのパケットが続く範囲の終わりを返す。1 つも続かなければ <paramref name="from"/></summary>
    public static int RunEnd(ReadOnlySpan<byte> data, int from)
    {
        var at = from;
        while (data.Length - at >= Packet && data[at] == Byte) at += Packet;
        return at;
    }
}
