namespace Denpa.Agent;

/*
 * TS の IV (12.7) を、受けた TS から割り出す。
 *
 * 機材は TS のペイロードを、パケットごとに AES-CBC (IV はいつも同じ 16 バイト) で暗号化して出す。CBC は 2 つ目のブロックから先が
 * IV に頼らないので、IV を 0 にして復号すると、各ペイロードの**最初の 16 バイトだけ**が (本当の中身 XOR IV) になって出る。
 * 最初の 16 バイトが決まった形になるパケット (PAT・映像の PES の頭) があるので、その形から IV を引ける。
 * 形から決まらない 3 バイト (PES の stream_id・フラグ・PTS の末尾) は、全部試して、SHA-256 が合うものを選ぶ
 * (<see cref="Dt295Receive.TsIvSha256"/>。IV そのものはコードに持たない)。
 *
 * 見る形 (ペイロードの先頭からのバイト位置):
 * - PAT (PID 0、ポインターは 0): 0:00 1:00 (table_id) 2:0xB0 (section_syntax_indicator と length の上位) 7:00 8:00 (section_number・
 *   last_section_number) 9〜12:00 00 E0 10 (最初の番組は番組番号 0 = NIT で、PID は 0x0010)
 * - 映像の PES (PUSI): 0〜2:00 00 01 3:stream_id 4〜5:00 00 (PES_packet_length は 0) 6:0x80〜0x8F 7:0x80 か 0xC0
 *   8:header_data_length 14〜15:00 00 (ES の頭の開始コード。PTS だけのとき)
 * (PES の 7・8 バイト目の形は、PAT から決めた IV のバイトでは確かめない。SHA-256 が確かめる)
 */

/// <summary>割り出す部品。受けた TS (IV を 0 で復号したもの。188 バイトずつ) を渡して、足りたら <see cref="TryDerive"/></summary>
public sealed class Dt295IvLearner
{
    public const int Block = 16;
    private const int Packet = 188;

    /// <summary>PID ごとに溜める PUSI パケットの先頭ブロックの数の上限</summary>
    private const int KeepPerPid = 200;

    private readonly Dictionary<int, List<byte[]>> _blocks = [];
    private readonly byte[] _carry = new byte[Packet];
    private int _carried;
    private long _since;

    /// <summary>最後に試してから渡したパケットの数</summary>
    public long PacketsSinceTry => _since;

    /// <summary>
    /// 渡す。188 バイトにそろっていなくてよい (端数は次につなぐ)。先頭は 0x47 から始まっている前提
    /// (<see cref="Dt295TsFilter"/> の出力はそうなっている)
    /// </summary>
    public void Push(ReadOnlySpan<byte> data)
    {
        if (_carried > 0)
        {
            var take = Math.Min(Packet - _carried, data.Length);
            data[..take].CopyTo(_carry.AsSpan(_carried));
            _carried += take;
            data = data[take..];
            if (_carried < Packet) return;
            _carried = 0;
            One(_carry);
        }
        while (data.Length >= Packet)
        {
            One(data[..Packet]);
            data = data[Packet..];
        }
        data.CopyTo(_carry);
        _carried = data.Length;
    }

    private void One(ReadOnlySpan<byte> packet)
    {
        _since++;
        if (packet[0] != 0x47 || (packet[1] & 0x40) == 0) return; // PUSI だけ
        var control = (packet[3] >> 4) & 3;
        if (control is 0 or 2) return;
        var start = control == 3 ? 5 + packet[4] : 4;
        if (start + Block > Packet) return;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if (pid == 0x1FFF) return;
        if (!_blocks.TryGetValue(pid, out var list)) _blocks[pid] = list = [];
        if (list.Count < KeepPerPid) list.Add(packet.Slice(start, Block).ToArray());
    }

    /// <summary>
    /// 割り出す。PAT と、先頭が決まった形の PES のグループが揃っていなければ null。<paramref name="accept"/> が
    /// 真を返した IV を返す (本物の確かめは SHA-256)
    /// </summary>
    public byte[]? TryDerive(Func<byte[], bool> accept)
    {
        _since = 0;
        if (!_blocks.TryGetValue(0, out var pat) || pat.Count < 3) return null;
        var modalPat = Modal(pat);
        var others = _blocks.Where(e => e.Key != 0 && e.Value.Count >= 8).OrderByDescending(e => e.Value.Count).Take(4).Select(e => Modal(e.Value)).ToList();
        foreach (var modal in others)
        {
            var iv = new byte[Block];
            // PAT から決まるバイト
            iv[0] = (byte)(modalPat[0] ^ 0x00);
            iv[1] = (byte)(modalPat[1] ^ 0x00);
            iv[2] = (byte)(modalPat[2] ^ 0xB0);
            iv[7] = (byte)(modalPat[7] ^ 0x00);
            iv[8] = (byte)(modalPat[8] ^ 0x00);
            iv[9] = (byte)(modalPat[9] ^ 0x00);
            iv[10] = (byte)(modalPat[10] ^ 0x00);
            iv[11] = (byte)(modalPat[11] ^ 0xE0);
            iv[12] = (byte)(modalPat[12] ^ 0x10);
            // PES から決まるバイト
            iv[4] = (byte)(modal[4] ^ 0x00);
            iv[5] = (byte)(modal[5] ^ 0x00);
            iv[14] = (byte)(modal[14] ^ 0x00);
            iv[15] = (byte)(modal[15] ^ 0x00);
            // PES の頭 00 00 01 が、PAT から決めた IV と合うか
            if ((modal[0] ^ iv[0]) != 0x00 || (modal[1] ^ iv[1]) != 0x00 || (modal[2] ^ iv[2]) != 0x01) continue;
            // 形から決まらない 3 バイト: stream_id (0xC0〜0xEF)・フラグ (0x80〜0x8F)・PTS の末尾 (全部)
            for (var id = 0xC0; id <= 0xEF; id++)
            {
                iv[3] = (byte)(modal[3] ^ id);
                for (var flags = 0x80; flags <= 0x8F; flags++)
                {
                    iv[6] = (byte)(modal[6] ^ flags);
                    for (var tail = 0; tail <= 0xFF; tail++)
                    {
                        iv[13] = (byte)tail;
                        if (accept(iv)) return (byte[])iv.Clone();
                    }
                }
            }
        }
        return null;
    }

    /// <summary>位置ごとに、いちばん多い値を並べたブロック</summary>
    private static byte[] Modal(List<byte[]> blocks)
    {
        var modal = new byte[Block];
        for (var j = 0; j < Block; j++)
        {
            var counts = new int[256];
            foreach (var block in blocks) counts[block[j]]++;
            modal[j] = (byte)Array.IndexOf(counts, counts.Max());
        }
        return modal;
    }
}
