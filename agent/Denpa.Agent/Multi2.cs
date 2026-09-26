using System.Buffers.Binary;
using System.Numerics;
using System.Runtime.CompilerServices;

namespace Denpa.Agent;

/// <summary>
/// MULTI2 (ARIB STD-B25 のスクランブル)。**TS の中身ぜんぶに掛かる、いちばん重いところ。**
///
/// <para>
/// 64 ビットのブロック暗号で、鍵は2段になっている。カードの定数 (システム鍵 32 バイト) と、
/// ECM から貰う鍵 (8 バイト) を混ぜて作業鍵 8 語を作り、それで 1 パケットの中身を解く。
/// 作業鍵は**鍵が変わったとき (数秒に1回) に1回だけ作る** — パケットごとに作り直すと、
/// 解く手間の倍近くがそこに消える。
/// </para>
///
/// <para>
/// 並べ方は**パケットごとに CBC を初めからやり直す**。8 バイトに満たない尻尾だけは
/// OFB (直前の暗号ブロックをもう一度暗号化して XOR) で、パケットの長さが変わらない。
/// CBC の初期値はカードの定数 (<see cref="CardInit.InitCbc"/>)。
/// </para>
///
/// <para>
/// 1つの実体は**1本の流れからしか触らない**。鍵を書き換えている途中に別の流れが
/// 解くと半端な鍵で解いてしまうが、錠は掛けない (<see cref="Descrambler"/> が
/// 1本の読み手の中で順に呼ぶ)。
/// </para>
/// </summary>
public sealed class Multi2
{
    /// <summary>段数。放送は 4 (これ以外の値で送ってくる局は無い)</summary>
    public const int Rounds = 4;

    [InlineArray(8)]
    private struct Words
    {
        private uint _first;
    }

    private readonly Words _system;
    private readonly uint _ivLeft;
    private readonly uint _ivRight;
    private Words _odd;
    private Words _even;

    public Multi2(ReadOnlySpan<byte> systemKey, ReadOnlySpan<byte> initCbc)
    {
        if (systemKey.Length != 32) throw new ArgumentException("システム鍵は 32 バイトです", nameof(systemKey));
        if (initCbc.Length != 8) throw new ArgumentException("CBC の初期値は 8 バイトです", nameof(initCbc));
        for (var index = 0; index < 8; index++)
        {
            _system[index] = BinaryPrimitives.ReadUInt32BigEndian(systemKey[(index * 4)..]);
        }
        _ivLeft = BinaryPrimitives.ReadUInt32BigEndian(initCbc);
        _ivRight = BinaryPrimitives.ReadUInt32BigEndian(initCbc[4..]);
    }

    /// <summary>鍵が入っているか。**入る前に解くと、でたらめを書く**ので呼ぶ側が見る</summary>
    public bool HasKeys { get; private set; }

    /// <summary>ECM の答えの鍵 (奇数・偶数 8 バイトずつ) から作業鍵を作る</summary>
    public void SetKeys(ReadOnlySpan<byte> odd, ReadOnlySpan<byte> even)
    {
        if (odd.Length != 8 || even.Length != 8) throw new ArgumentException("鍵は 8 バイトずつです");
        Schedule(ref _odd, odd);
        Schedule(ref _even, even);
        HasKeys = true;
    }

    /// <summary>鍵を捨てる。**古い鍵で解き続けるより、掛かったまま流すほうが分かりやすい**</summary>
    public void Clear()
    {
        _odd = default;
        _even = default;
        HasKeys = false;
    }

    /// <summary>
    /// システム鍵とデータ鍵から作業鍵を作る。暗号化の 1 段と同じ π1〜π4 を、
    /// 鍵のほうを材料にして回し、途中の半分を1語ずつ拾っていく
    /// </summary>
    private void Schedule(ref Words work, ReadOnlySpan<byte> dataKey)
    {
        var left = BinaryPrimitives.ReadUInt32BigEndian(dataKey);
        var right = BinaryPrimitives.ReadUInt32BigEndian(dataKey[4..]);

        right ^= left;
        left ^= Pi2(right, _system[0]);
        work[0] = left;
        right ^= Pi3(left, _system[1], _system[2]);
        work[1] = right;
        left ^= Pi4(right, _system[3]);
        work[2] = left;
        right ^= left;
        work[3] = right;
        left ^= Pi2(right, _system[4]);
        work[4] = left;
        right ^= Pi3(left, _system[5], _system[6]);
        work[5] = right;
        left ^= Pi4(right, _system[7]);
        work[6] = left;
        right ^= left;
        work[7] = right;
    }

    /*
     * π1〜π4。どれも「片方の半分から作った値を、もう片方へ XOR する」形なので、
     * **同じ関数を逆の順に当てれば戻る** (解くのに別の関数は要らない)。
     * π1 は right ^= left だけなので、呼ぶ側に直に書いてある
     */

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static uint Pi2(uint right, uint key)
    {
        var t = right + key;
        t = BitOperations.RotateLeft(t, 1) + t - 1;
        return BitOperations.RotateLeft(t, 4) ^ t;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static uint Pi3(uint left, uint key1, uint key2)
    {
        var t = left + key1;
        t = BitOperations.RotateLeft(t, 2) + t + 1;
        t = (BitOperations.RotateLeft(t, 8) ^ t) + key2;
        t = BitOperations.RotateLeft(t, 1) - t;
        return BitOperations.RotateLeft(t, 16) ^ (t | left);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static uint Pi4(uint right, uint key)
    {
        var t = right + key;
        return BitOperations.RotateLeft(t, 2) + t + 1;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void EncryptBlock(ref uint left, ref uint right, in Words k)
    {
        uint l = left, r = right;
        for (var round = 0; round < Rounds; round++)
        {
            r ^= l;
            l ^= Pi2(r, k[0]);
            r ^= Pi3(l, k[1], k[2]);
            l ^= Pi4(r, k[3]);
            r ^= l;
            l ^= Pi2(r, k[4]);
            r ^= Pi3(l, k[5], k[6]);
            l ^= Pi4(r, k[7]);
        }
        left = l;
        right = r;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void DecryptBlock(ref uint left, ref uint right, in Words k)
    {
        uint l = left, r = right;
        for (var round = 0; round < Rounds; round++)
        {
            l ^= Pi4(r, k[7]);
            r ^= Pi3(l, k[5], k[6]);
            l ^= Pi2(r, k[4]);
            r ^= l;
            l ^= Pi4(r, k[3]);
            r ^= Pi3(l, k[1], k[2]);
            l ^= Pi2(r, k[0]);
            r ^= l;
        }
        left = l;
        right = r;
    }

    /// <summary>
    /// 1 パケットぶんの中身をその場で解く。
    /// <paramref name="even"/> は transport_scrambling_control が 0b10 のとき
    /// </summary>
    public void Decrypt(bool even, Span<byte> data)
    {
        ref readonly var k = ref even ? ref _even : ref _odd;
        uint cbcLeft = _ivLeft, cbcRight = _ivRight;

        var at = 0;
        /*
         * **CBC は解く向きならブロックどうしが独立している** (前の暗号文と XOR するのは
         * 解いた後)。1 パケットの 23 ブロックを SIMD の幅 (AVX2 なら 8 本) で並べて
         * 一度に回す。掛ける向きは前の結果を待つので並べられない
         */
        if (Vector.IsHardwareAccelerated && data.Length >= Vector<uint>.Count * 8)
        {
            at = DecryptWide(data, k, ref cbcLeft, ref cbcRight);
        }

        for (; at + 8 <= data.Length; at += 8)
        {
            var block = data.Slice(at, 8);
            var cipherLeft = BinaryPrimitives.ReadUInt32BigEndian(block);
            var cipherRight = BinaryPrimitives.ReadUInt32BigEndian(block[4..]);
            uint l = cipherLeft, r = cipherRight;
            DecryptBlock(ref l, ref r, k);
            BinaryPrimitives.WriteUInt32BigEndian(block, l ^ cbcLeft);
            BinaryPrimitives.WriteUInt32BigEndian(block[4..], r ^ cbcRight);
            cbcLeft = cipherLeft;
            cbcRight = cipherRight;
        }

        Tail(data[at..], cbcLeft, cbcRight, k);
    }

    /// <summary>1 パケット (184 バイト = 23 ブロック) が収まる幅。長いものは区切って回す</summary>
    private const int WideBlocks = 32;

    /// <summary>
    /// 丸ごとのブロックを SIMD で解く。左右の半分を別々の列に並べ直してから回し、
    /// 書き戻しながら CBC の XOR を掛ける。解き終えたところまでのバイト数を返す
    /// </summary>
    private static int DecryptWide(Span<byte> data, in Words k, ref uint cbcLeft, ref uint cbcRight)
    {
        Span<uint> lefts = stackalloc uint[WideBlocks];
        Span<uint> rights = stackalloc uint[WideBlocks];
        var width = Vector<uint>.Count;
        var k0 = new Vector<uint>(k[0]);
        var k1 = new Vector<uint>(k[1]);
        var k2 = new Vector<uint>(k[2]);
        var k3 = new Vector<uint>(k[3]);
        var k4 = new Vector<uint>(k[4]);
        var k5 = new Vector<uint>(k[5]);
        var k6 = new Vector<uint>(k[6]);
        var k7 = new Vector<uint>(k[7]);

        var at = 0;
        while (data.Length - at >= width * 8)
        {
            // 幅の倍数に切り上げると余りのぶんまで回るが、そこは捨てる (書き戻さない)
            var blocks = Math.Min((data.Length - at) / 8, WideBlocks);
            var chunk = data.Slice(at, blocks * 8);
            for (var index = 0; index < blocks; index++)
            {
                lefts[index] = BinaryPrimitives.ReadUInt32BigEndian(chunk[(index * 8)..]);
                rights[index] = BinaryPrimitives.ReadUInt32BigEndian(chunk[(index * 8 + 4)..]);
            }

            for (var index = 0; index + width <= WideBlocks && index < blocks; index += width)
            {
                var l = Vector.LoadUnsafe(ref lefts[0], (nuint)index);
                var r = Vector.LoadUnsafe(ref rights[0], (nuint)index);
                for (var round = 0; round < Rounds; round++)
                {
                    l ^= Pi4(r, k7);
                    r ^= Pi3(l, k5, k6);
                    l ^= Pi2(r, k4);
                    r ^= l;
                    l ^= Pi4(r, k3);
                    r ^= Pi3(l, k1, k2);
                    l ^= Pi2(r, k0);
                    r ^= l;
                }
                l.StoreUnsafe(ref lefts[0], (nuint)index);
                r.StoreUnsafe(ref rights[0], (nuint)index);
            }

            for (var index = 0; index < blocks; index++)
            {
                var block = chunk.Slice(index * 8, 8);
                var cipherLeft = BinaryPrimitives.ReadUInt32BigEndian(block);
                var cipherRight = BinaryPrimitives.ReadUInt32BigEndian(block[4..]);
                BinaryPrimitives.WriteUInt32BigEndian(block, lefts[index] ^ cbcLeft);
                BinaryPrimitives.WriteUInt32BigEndian(block[4..], rights[index] ^ cbcRight);
                cbcLeft = cipherLeft;
                cbcRight = cipherRight;
            }
            at += blocks * 8;
        }
        return at;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static Vector<uint> RotateLeft(Vector<uint> value, int count) =>
        Vector.ShiftLeft(value, count) | Vector.ShiftRightLogical(value, 32 - count);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static Vector<uint> Pi2(Vector<uint> right, Vector<uint> key)
    {
        var t = right + key;
        t = RotateLeft(t, 1) + t - Vector<uint>.One;
        return RotateLeft(t, 4) ^ t;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static Vector<uint> Pi3(Vector<uint> left, Vector<uint> key1, Vector<uint> key2)
    {
        var t = left + key1;
        t = RotateLeft(t, 2) + t + Vector<uint>.One;
        t = (RotateLeft(t, 8) ^ t) + key2;
        t = RotateLeft(t, 1) - t;
        return RotateLeft(t, 16) ^ (t | left);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static Vector<uint> Pi4(Vector<uint> right, Vector<uint> key)
    {
        var t = right + key;
        return RotateLeft(t, 2) + t + Vector<uint>.One;
    }

    /// <summary>掛ける向き。**放送を作る側の処理**で、ここではテストで TS を作るのに使う</summary>
    public void Encrypt(bool even, Span<byte> data)
    {
        ref readonly var k = ref even ? ref _even : ref _odd;
        uint cbcLeft = _ivLeft, cbcRight = _ivRight;

        var at = 0;
        for (; at + 8 <= data.Length; at += 8)
        {
            var block = data.Slice(at, 8);
            cbcLeft ^= BinaryPrimitives.ReadUInt32BigEndian(block);
            cbcRight ^= BinaryPrimitives.ReadUInt32BigEndian(block[4..]);
            EncryptBlock(ref cbcLeft, ref cbcRight, k);
            BinaryPrimitives.WriteUInt32BigEndian(block, cbcLeft);
            BinaryPrimitives.WriteUInt32BigEndian(block[4..], cbcRight);
        }

        Tail(data[at..], cbcLeft, cbcRight, k);
    }

    /// <summary>8 バイトに満たない尻尾。**掛けるのも解くのも同じ** (OFB は XOR するだけ)</summary>
    private static void Tail(Span<byte> tail, uint left, uint right, in Words k)
    {
        if (tail.IsEmpty) return;
        EncryptBlock(ref left, ref right, k);
        Span<byte> pad = stackalloc byte[8];
        BinaryPrimitives.WriteUInt32BigEndian(pad, left);
        BinaryPrimitives.WriteUInt32BigEndian(pad[4..], right);
        for (var index = 0; index < tail.Length; index++) tail[index] ^= pad[index];
    }
}
