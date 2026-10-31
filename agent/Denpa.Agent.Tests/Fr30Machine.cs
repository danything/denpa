namespace Denpa.Agent.Tests;

/// <summary>
/// テスト用の小さな FR30 の真似。Fr30.cs のアセンブラが出す命令だけを、富士通の公開している命令の手引きの振る舞いで動かす
/// (比較は Ri − Rj でフラグを立て、C は借り。AND・OR は N と Z だけ。シフトは N・Z・C。分岐の飛び先は PC + 2 + rel × 2)。
/// メモリの読み書きは <see cref="Load"/>・<see cref="Store"/> に渡す (機材のレジスタの振る舞いはテストが決める)
/// </summary>
internal sealed class Fr30Machine
{
    public readonly uint[] R = new uint[16];
    public uint Pc;
    public uint Rp;
    public bool N, Z, V, C;

    public required Func<uint, int, uint> Load { get; init; }
    public required Action<uint, int, uint> Store { get; init; }

    /// <summary>命令の語を読む (プログラムを置いた所)</summary>
    public required Func<uint, ushort> Fetch { get; init; }

    /// <summary><paramref name="stop"/> が true を返すまで (上限まで) 動かす。来たら true</summary>
    public bool RunUntil(Func<uint, bool> stop, long limit = 1_000_000)
    {
        for (var i = 0L; i < limit; i++)
        {
            if (stop(Pc)) return true;
            Step();
        }
        return false;
    }

    private void Flags(uint result)
    {
        N = (int)result < 0;
        Z = result == 0;
    }

    private uint AddFlags(uint a, uint b)
    {
        var result = a + b;
        Flags(result);
        C = result < a;
        V = ((~(a ^ b) & (a ^ result)) >> 31) != 0;
        return result;
    }

    private uint SubFlags(uint a, uint b)
    {
        var result = a - b;
        Flags(result);
        C = a < b;
        V = (((a ^ b) & (a ^ result)) >> 31) != 0;
        return result;
    }

    private bool Condition(int cond) => cond switch
    {
        0x0 => true,
        0x1 => false,
        0x2 => Z,
        0x3 => !Z,
        0x4 => C,
        0x5 => !C,
        0x6 => N,
        0x7 => !N,
        0x8 => V,
        0x9 => !V,
        0xA => N ^ V,
        0xB => !(N ^ V),
        0xC => (N ^ V) || Z,
        0xD => !((N ^ V) || Z),
        0xE => C || Z,
        _ => !(C || Z),
    };

    public void Step()
    {
        var at = Pc;
        var op = Fetch(at);
        var next = at + 2;
        var ri = op & 0xF;
        var rj = (op >> 4) & 0xF;
        var top = op >> 8;
        switch (op >> 12)
        {
            case 0xC:
                R[ri] = (uint)((op >> 4) & 0xFF);
                break;
            case 0xE:
            {
                var rel = (sbyte)(op & 0xFF);
                if ((top & 0xF0) == 0xE0 && Condition(top & 0xF)) next = (uint)(at + 2 + rel * 2);
                break;
            }
            case 0xD when (op & 0x0800) == 0:
            {
                var rel = (op & 0x7FF) << 21 >> 21;
                Rp = at + 2;
                next = (uint)(at + 2 + rel * 2);
                break;
            }
            case 0x2:
                R[ri] = Load((uint)(R[14] + ((sbyte)((op >> 4) & 0xFF) * 4)), 4);
                break;
            case 0x3:
                Store((uint)(R[14] + ((sbyte)((op >> 4) & 0xFF) * 4)), 4, R[ri]);
                break;
            default:
                next = Wide(op, at, ri, rj, top, next);
                break;
        }
        Pc = next;
    }

    private uint Wide(int op, uint at, int ri, int rj, int top, uint next)
    {
        switch (top)
        {
            case 0x00:
                R[ri] = Load(R[13] + R[rj], 4);
                return next;
            case 0x10:
                Store(R[13] + R[rj], 4, R[ri]);
                return next;
            case 0x04:
                R[ri] = Load(R[rj], 4);
                return next;
            case 0x05:
                R[ri] = Load(R[rj], 2);
                return next;
            case 0x06:
                R[ri] = Load(R[rj], 1);
                return next;
            case 0x14:
                Store(R[rj], 4, R[ri]);
                return next;
            case 0x15:
                Store(R[rj], 2, R[ri] & 0xFFFF);
                return next;
            case 0x16:
                Store(R[rj], 1, R[ri] & 0xFF);
                return next;
            case 0x17 when op == 0x1781:
                R[15] -= 4;
                Store(R[15], 4, Rp);
                return next;
            case 0x07 when op == 0x0781:
                Rp = Load(R[15], 4);
                R[15] += 4;
                return next;
            case 0x8B:
                R[ri] = R[rj];
                return next;
            case 0xA6:
                R[ri] = AddFlags(R[ri], R[rj]);
                return next;
            case 0xA4:
                R[ri] = AddFlags(R[ri], (uint)rj);
                return next;
            case 0xA5:
                R[ri] = AddFlags(R[ri], (uint)(rj - 16));
                return next;
            case 0xAC:
                R[ri] = SubFlags(R[ri], R[rj]);
                return next;
            case 0xAA:
                SubFlags(R[ri], R[rj]);
                return next;
            case 0xA8:
                SubFlags(R[ri], (uint)rj);
                return next;
            case 0x82:
                R[ri] &= R[rj];
                Flags(R[ri]);
                return next;
            case 0x92:
                R[ri] |= R[rj];
                Flags(R[ri]);
                return next;
            case 0xB4 or 0xB5:
            {
                var count = rj + (top == 0xB5 ? 16 : 0);
                C = count != 0 && ((R[ri] >> (32 - count)) & 1) != 0;
                R[ri] <<= count;
                Flags(R[ri]);
                return next;
            }
            case 0xB0 or 0xB1:
            {
                var count = rj + (top == 0xB1 ? 16 : 0);
                C = count != 0 && ((R[ri] >> (count - 1)) & 1) != 0;
                R[ri] >>= count;
                Flags(R[ri]);
                return next;
            }
            case 0x9B:
                R[ri] = ((uint)rj << 16) | Fetch(at + 2);
                return at + 4;
            case 0x9F when (op & 0xF0) == 0x80:
                R[ri] = ((uint)Fetch(at + 2) << 16) | Fetch(at + 4);
                return at + 6;
            case 0x9F when op == 0x9FA0:
                return next;
            case 0x97 when (op & 0xF0) == 0x00:
                return R[ri];
            case 0x97 when op == 0x9720:
                return Rp;
            default:
                throw new InvalidOperationException($"知らない命令 0x{op:X4} (0x{at:X})");
        }
    }
}
