namespace Denpa.Agent;

/*
 * ITE IT930x (USB ブリッジ) のコマンドのフレーム。PLEX の PX-MLT5U・PX-MLT5PE と e-Better の DTV02A-5TS-P が積んでいる。
 *
 * ITE Tech. の IT930x の Linux ドライバ (SDK。api/brCmd.c・api/brCmd.h) を元に書いた。ITE Tech. から、そのコードを
 * チューナーエージェントの中で MPL-2.0 として使い、変え、公開してよいと確認を得ている (docs/licenses.md)。
 * コメントの関数名は SDK のもの。
 */

/// <summary>IT930x のコマンドが失敗した (時間切れ・壊れた応答・ブリッジのエラー)</summary>
public sealed class It930xException(string message) : IOException(message);

/// <summary>
/// IT930x のコマンドのフレームを組み立てて、応答を検査する。**状態を持たない** (シーケンス番号は呼ぶ側が持つ)。
///
/// <para>
/// 送るフレームは「長さ、コマンドの番号 (2 バイト、上位から)、シーケンス番号、中身、チェックサム (2 バイト、上位から)」。
/// 長さはフレーム全体のバイト数から 1 を引いた値 (<c>BrCmd_addChecksum</c>)。
/// 応答は「長さ、シーケンス番号 (推定。SDK は読まない)、状態、データ、チェックサム」で、状態が 0 以外ならブリッジのエラー
/// (<c>BrCmd_removeChecksum</c>)。
/// </para>
/// </summary>
public static class It930xFrame
{
    /// <summary>
    /// フレームの上限 (バイト)。SDK の USB の機材の値 (<c>it930x-drv.c</c> の <c>maxBusTxSize = 63</c>)。
    /// レジスタの書き込みは 1 回 51 バイトまで、読み出しは 58 バイトまでになる
    /// </summary>
    public const int Max = 63;

    /// <summary>送るフレームの、中身の前 (長さ・コマンド・シーケンス番号) と後ろ (チェックサム) のバイト数</summary>
    public const int Overhead = 6;

    /// <summary>応答のフレームの、データの前 (長さ・シーケンス番号・状態) と後ろ (チェックサム) のバイト数</summary>
    public const int ReplyOverhead = 5;

    // コマンドの番号 (brCmd.h)。USB の機材ではチップの番号を 12 ビット上に足す (BrCmd_buildCommand)。
    // MLT 系はブリッジが 1 つなのでチップは 0 と推定し、足さない
    public const ushort RegisterRead = 0x0000;
    public const ushort RegisterWrite = 0x0001;
    public const ushort QueryInfo = 0x0022;
    /// <summary>BOOT と REBOOT は同じ番号。BOOT は応答を読み、REBOOT は読まない (<c>BrCmd_reboot</c>)</summary>
    public const ushort Boot = 0x0023;
    public const ushort ScatterWrite = 0x0029;

    /// <summary>
    /// チェックサム。<paramref name="body"/> (フレームの位置 1 からチェックサムの手前まで) を 2 バイトずつ上位から 16 ビットの数として足し、
    /// 余った 1 バイトは上位に置いて足し、ビットを反転する (<c>BrCmd_addChecksum</c>。桁あふれは捨てる)
    /// </summary>
    public static ushort Checksum(ReadOnlySpan<byte> body)
    {
        ushort sum = 0;
        var i = 0;
        for (; i + 1 < body.Length; i += 2) sum = (ushort)(sum + ((body[i] << 8) | body[i + 1]));
        if (i < body.Length) sum = (ushort)(sum + (body[i] << 8));
        return (ushort)~sum;
    }

    /// <summary>送るフレームを組み立てる。<see cref="Max"/> を超えるなら投げる (分けるのは呼ぶ側)</summary>
    public static byte[] Build(ushort command, byte sequence, ReadOnlySpan<byte> payload)
    {
        var length = Overhead + payload.Length;
        if (length > Max) throw new ArgumentOutOfRangeException(nameof(payload), $"IT930x のフレームは {Max} バイトまでです ({length} バイト)");
        var frame = new byte[length];
        frame[0] = (byte)(length - 1);
        frame[1] = (byte)(command >> 8);
        frame[2] = (byte)command;
        frame[3] = sequence;
        payload.CopyTo(frame.AsSpan(4));
        var checksum = Checksum(frame.AsSpan(1, length - 3));
        frame[^2] = (byte)(checksum >> 8);
        frame[^1] = (byte)checksum;
        return frame;
    }

    /// <summary>
    /// 応答を検査してデータを返す。長さが <see cref="ReplyOverhead"/> + <paramref name="dataLength"/> でない・チェックサムが合わない・
    /// 状態が 0 でないときは <see cref="It930xException"/>
    /// </summary>
    /// <param name="command">記録に出すコマンドの番号</param>
    public static byte[] Parse(ReadOnlySpan<byte> reply, int dataLength, ushort command)
    {
        var expected = ReplyOverhead + dataLength;
        if (reply.Length != expected)
        {
            throw new It930xException($"IT930x の応答が壊れています (コマンド 0x{command:X4}。長さ {reply.Length} バイト、期待は {expected} バイト)");
        }
        var checksum = (ushort)((reply[^2] << 8) | reply[^1]);
        if (Checksum(reply[1..^2]) != checksum)
        {
            throw new It930xException($"IT930x の応答が壊れています (コマンド 0x{command:X4}。チェックサムが合いません)");
        }
        if (reply[2] != 0)
        {
            throw new It930xException($"IT930x がエラーを返しました (コマンド 0x{command:X4}、状態 0x{reply[2]:X2})");
        }
        return reply.Slice(3, dataLength).ToArray();
    }
}
