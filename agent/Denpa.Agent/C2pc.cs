namespace Denpa.Agent;

/// <summary>
/// B-CAS が ECM に使っている暗号 (C2PC)。<see cref="Transform"/> は ECM の中身の暗号化と復号、
/// <see cref="GenerateMAC"/> は末尾の 4 バイトの MAC を作る。ECM の先頭の階層番号で方式を選ぶ。
/// 0x40 が立っているときは 512bit の鍵スケジュール、0x0c が立っているときはもう一方の初期化ベクトルを使う。
///
/// <para>
/// 構造と定数は SoftCAS (2012, wazoku.net) の C のソースから移植した。同じ入力での出力は
/// C の実装とバイト単位で一致する (<c>SoftCasTests</c> の既知応答ベクトル)。
/// </para>
/// </summary>
internal static class C2pc
{
    private static readonly byte[] Sbox =
    [
        0x46, 0xA2, 0x72, 0x41, 0xE2, 0x8C, 0xDF, 0x11,
        0x81, 0x7D, 0x18, 0x44, 0xB1, 0x0D, 0xD7, 0x42,
        0xBE, 0x76, 0x6D, 0x81, 0xAF, 0x7A, 0xD2, 0x05,
        0x76, 0x84, 0xFD, 0x2A, 0x62, 0x0D, 0x76, 0xA1,
    ];

    private static readonly byte[] LookupTable =
    [
        0xAA, 0xA2, 0x10, 0xFA, 0xA9, 0xF0, 0x40, 0x2F, 0xB1, 0x1C, 0x1A, 0x6F, 0x43, 0xB4, 0x73, 0xBC,
        0x69, 0x77, 0xC5, 0x00, 0xF3, 0xD4, 0x09, 0x7E, 0x58, 0x8D, 0x44, 0xC3, 0xF5, 0x54, 0x0C, 0xDD,
        0x3F, 0xB7, 0xD1, 0xD6, 0x9A, 0xD3, 0x39, 0x82, 0x01, 0x5E, 0x03, 0xED, 0x78, 0x63, 0x90, 0x49,
        0x9B, 0x15, 0xA8, 0x4F, 0x67, 0x52, 0xAC, 0xE4, 0x37, 0xEA, 0xF7, 0x23, 0x55, 0x0F, 0x42, 0x12,
        0xE3, 0x05, 0x5F, 0x2D, 0x2E, 0x7F, 0x11, 0x38, 0x07, 0xF4, 0x3C, 0xE2, 0xD5, 0x9F, 0xDF, 0xCF,
        0x30, 0x0B, 0xAD, 0x66, 0x22, 0x70, 0xEF, 0x7B, 0xA6, 0x24, 0x65, 0x0D, 0x5D, 0x79, 0x02, 0x4D,
        0x0E, 0x32, 0x84, 0x97, 0xB8, 0x57, 0x34, 0xE8, 0x41, 0x87, 0xC1, 0xF9, 0x9C, 0x56, 0xAE, 0x71,
        0xAB, 0xBF, 0xD0, 0x88, 0x25, 0xC8, 0x1F, 0xD7, 0xFE, 0x04, 0x4E, 0xCE, 0x51, 0x81, 0xBB, 0xCD,
        0x91, 0xA5, 0x14, 0x75, 0xA4, 0x60, 0x61, 0x6E, 0x7A, 0xE6, 0x99, 0xD8, 0xA0, 0x4C, 0xDC, 0x1B,
        0x06, 0x6C, 0x3E, 0x9E, 0xF8, 0xCB, 0x98, 0x92, 0x0A, 0xFB, 0x2A, 0xCA, 0x50, 0x7C, 0xC0, 0x83,
        0x94, 0xB5, 0x6A, 0x21, 0x95, 0xB3, 0x48, 0xD9, 0x16, 0xA7, 0xEE, 0x4B, 0xFD, 0x9D, 0xBD, 0x6B,
        0xC6, 0x80, 0x20, 0x3A, 0x53, 0x1E, 0x5C, 0xC7, 0xB6, 0x08, 0xAF, 0xA1, 0x2B, 0x19, 0x26, 0x8A,
        0x47, 0xE1, 0x86, 0x74, 0xE9, 0x59, 0x62, 0x8B, 0x28, 0x6D, 0xEC, 0x76, 0xB0, 0x45, 0xC2, 0x46,
        0x4A, 0xE0, 0xF2, 0x8C, 0xBE, 0x3B, 0x5B, 0xBA, 0x31, 0x96, 0xE5, 0x36, 0x8E, 0xEB, 0xE7, 0xB9,
        0xA3, 0x35, 0x17, 0x68, 0x27, 0x8F, 0x85, 0x89, 0x29, 0x93, 0xFF, 0xFC, 0xDE, 0x7D, 0x18, 0xDB,
        0x64, 0xF6, 0x1D, 0xB2, 0x3D, 0xF1, 0xC9, 0x13, 0xDA, 0xCC, 0xC4, 0x72, 0x33, 0x5A, 0xD2, 0x2C,
    ];

    // 初期化ベクトル 2 つ (階層番号の 0x0c で選ぶ) と、ECM の復号の CBC が使う初期値
    private static readonly byte[] Iv1 = [0x32, 0x96, 0x57, 0xE8, 0x7B, 0x02, 0x4C, 0xD3];
    private static readonly byte[] Iv2 = [0x70, 0x39, 0xCD, 0x1A, 0x46, 0x52, 0xE8, 0xFB];
    private const uint TransformIv0 = 0x991927FE; // fe 27 19 99 を little-endian で読んだもの
    private const uint TransformIv1 = 0x11096919; // 19 69 09 11

    /// <summary>ECM の中身 (3 バイトの先頭より後ろ) を暗号化・復号する。CBC で、入力の長さが 8 の倍数でなければ最後の 1 ブロックを MAC のように使う</summary>
    internal static void Transform(byte protocol, ReadOnlySpan<byte> key, ReadOnlySpan<byte> input, Span<byte> output, bool decrypt)
    {
        var wide = (protocol & 0x40) != 0;
        var schedule = wide ? SetupKeySchedule4x(protocol, key) : SetupKeySchedule0x(protocol, key);
        var prev0 = TransformIv0;
        var prev1 = TransformIv1;

        var at = 0;
        while (input.Length - at >= 8)
        {
            var c0 = Read32(input, at);
            var c1 = Read32(input, at + 4);
            if (!decrypt)
            {
                c0 ^= prev0;
                c1 ^= prev1;
            }

            if (wide) ProcessBlock4x(ref c0, ref c1, schedule, protocol, decrypt);
            else ProcessBlock0x(ref c0, ref c1, schedule, decrypt);

            if (decrypt)
            {
                c0 ^= prev0;
                c1 ^= prev1;
            }

            Write32(output, at, c0);
            Write32(output, at + 4, c1);
            if (decrypt)
            {
                prev0 = Read32(input, at);
                prev1 = Read32(input, at + 4);
            }
            else
            {
                prev0 = c0;
                prev1 = c1;
            }

            at += 8;
        }

        var rest = input.Length - at;
        if (rest <= 0) return;
        // 端数 (1〜7 バイト) は、前のブロックを 1 回暗号化したものに XOR する
        var t0 = prev0;
        var t1 = prev1;
        if (wide) ProcessBlock4x(ref t0, ref t1, schedule, protocol, false);
        else ProcessBlock0x(ref t0, ref t1, schedule, false);
        Span<byte> tail = stackalloc byte[8];
        Write32(tail, 0, t0);
        Write32(tail, 4, t1);
        for (var i = 0; i < rest; i++) tail[i] = (byte)(tail[i] ^ input[at + i]);
        tail[..rest].CopyTo(output[at..]);
    }

    /// <summary>ペイロードの MAC を 4 バイト作る</summary>
    internal static void GenerateMAC(byte protocol, ReadOnlySpan<byte> key, ReadOnlySpan<byte> payload, Span<byte> mac)
    {
        if ((protocol & 0x40) != 0) GenerateMac4x(protocol, key, payload, mac);
        else GenerateMac0x(key, payload, mac);
    }

    // --- 128bit 鍵スケジュールのほう (階層番号の 0x40 が立っていないもの) ---

    private static uint[] SetupKeySchedule0x(byte protocol, ReadOnlySpan<byte> key)
    {
        var k = new byte[16];
        key[..8].CopyTo(k);
        for (var i = 8; i < 16; i++) k[i] = (byte)i;

        var pass = (protocol & 0x0c) != 0 ? Read32([0x84, 0xE5, 0xC4, 0xE7]) : Read32([0x6A, 0xA3, 0x2B, 0x6F]);
        for (var i = 0; i < 8; i++)
        {
            var cipher = Read32(k, (i & 3) << 2);
            BlockCipher(ref cipher, pass, 0);
            pass = cipher;
            Write32(k, (i & 3) << 2, cipher);
        }

        return ToWords(k);
    }

    private static void ProcessBlock0x(ref uint c0, ref uint c1, uint[] schedule, bool decrypt)
    {
        var round = decrypt ? (byte)0x0F : (byte)0x00;
        var end = decrypt ? (byte)0xFF : (byte)0x10;
        var step = decrypt ? (byte)0xFF : (byte)0x01;
        while (round != end)
        {
            var copy = c1;
            c1 = c0;
            c0 = copy;

            var box = GetBox(round, (byte)(decrypt ? 1 : 0));
            var pass = schedule[round & 3];
            BlockCipher(ref c0, pass, box);
            c1 ^= c0;
            c0 = copy;
            round += step;
        }

        (c0, c1) = (c1, c0);
    }

    private static void GenerateMac0x(ReadOnlySpan<byte> key, ReadOnlySpan<byte> payload, Span<byte> mac)
    {
        var seed0 = Read32(key);
        var seed1 = Read32(key, 4);
        uint iv0 = 0, iv1 = 0, p0 = 0, p1 = 0;

        var at = 0;
        while (payload.Length - at >= 8)
        {
            p0 = Read32(payload, at) ^ iv0;
            p1 = Read32(payload, at + 4) ^ iv1;
            ProcessMac0x(ref p0, ref p1, seed0, seed1);
            iv0 = p0;
            iv1 = p1;
            at += 8;
        }

        var rest = payload.Length - at;
        if (rest > 0)
        {
            Span<byte> block = stackalloc byte[8];
            payload[at..].CopyTo(block);
            p0 = Read32(block) ^ iv0;
            p1 = Read32(block, 4) ^ iv1;
            ProcessMac0x(ref p0, ref p1, seed0, seed1);
        }

        Write32(mac, 0, p1);
    }

    private static void ProcessMac0x(ref uint p0, ref uint p1, uint seed0, uint seed1)
    {
        var copy = p1;
        p1 = p0;
        p0 = copy;
        BlockCipher(ref p0, seed0, 3);
        p1 ^= p0;
        p0 = copy;

        copy = p1;
        p1 = p0;
        p0 = copy;
        BlockCipher(ref p0, seed1, 3);
        p1 ^= p0;
        p0 = copy;
    }

    // --- 512bit 鍵スケジュールのほう (階層番号の 0x40 が立っているもの) ---

    private static uint[] SetupKeySchedule4x(byte protocol, ReadOnlySpan<byte> key)
    {
        var k = new byte[8];
        key[..8].CopyTo(k);
        var schedule = new byte[64];
        for (byte i = 0, j = 0; i < 16; i++, j += 4)
        {
            k[0] = (byte)(k[0] + LookupTable[k[1]]);
            schedule[j] = k[0];
            k[2] ^= LookupTable[k[3]];
            schedule[j + 1] = k[2];
            k[4] ^= LookupTable[k[5]];
            schedule[j + 2] = k[4];
            k[6] = (byte)(k[6] + LookupTable[k[7]]);
            schedule[j + 3] = k[6];
            var x = k[0];
            k[0] = k[1];
            k[1] = k[2];
            k[2] = k[3];
            k[3] = k[4];
            k[4] = k[5];
            k[5] = k[6];
            k[6] = k[7];
            k[7] = x;
        }

        return ToWords(schedule);
    }

    private static void ProcessBlock4x(ref uint c0, ref uint c1, uint[] schedule, byte protocol, bool decrypt)
    {
        // C は u64 として IV を足した Cipher をそのままラウンドに使う (同じメモリを書き換える)。
        // Word_t[2] は [0] が下位 32bit なので、u64 にするときは c0 が下位
        var iv = (ulong)Read32((protocol & 0x0c) != 0 ? Iv2 : Iv1) | ((ulong)Read32((protocol & 0x0c) != 0 ? Iv2 : Iv1, 4) << 32);
        var e = ((ulong)c0 | ((ulong)c1 << 32)) + iv;
        c0 = (uint)e;
        c1 = (uint)(e >> 32);

        var index = decrypt ? (byte)0x0F : (byte)0x00;
        var step = decrypt ? (byte)0xFF : (byte)0x01;
        for (var i = 0; i < 16; i++)
        {
            c0 ^= Scramble(c1, schedule[index]);
            index += step;
            if (i != 15) (c0, c1) = (c1, c0);
        }

        e = ((ulong)c0 | ((ulong)c1 << 32)) - iv;
        c0 = (uint)e;
        c1 = (uint)(e >> 32);
    }

    private static void GenerateMac4x(byte protocol, ReadOnlySpan<byte> key, ReadOnlySpan<byte> payload, Span<byte> mac)
    {
        var wide = (protocol & 0x0c) != 0;
        uint counter = 0;
        var t0 = Read32(key);
        var t1 = Read32(wide ? Iv2 : Iv1);
        MacStep(ref t0, ref t1, ref counter);

        var at = 0;
        while (payload.Length - at >= 4)
        {
            t0 = Read32(payload, at);
            MacStep(ref t0, ref t1, ref counter);
            at += 4;
        }

        var rest = payload.Length - at; // 0〜3
        switch (payload.Length & 7)
        {
            case 0:
                break;
            case 1 or 2 or 3:
                Span<byte> block = stackalloc byte[4];
                payload[at..].CopyTo(block);
                t0 = Read32(block);
                MacStep(ref t0, ref t1, ref counter);
                t0 = 0;
                MacStep(ref t0, ref t1, ref counter);
                break;
            case 4:
                t0 = 0;
                MacStep(ref t0, ref t1, ref counter);
                break;
            default:
                if (rest == 0) break;
                Span<byte> tail = stackalloc byte[4];
                payload[at..].CopyTo(tail);
                t0 = Read32(tail);
                MacStep(ref t0, ref t1, ref counter);
                break;
        }

        t0 = Read32(wide ? Iv2 : Iv1, 4) + Read32(key, 4) + counter + 1;
        MacStep(ref t0, ref t1, ref counter);
        Write32(mac, 0, t1);
    }

    private static void MacStep(ref uint t0, ref uint t1, ref uint counter)
    {
        counter++;
        t0 = Scramble(t0, t1);
        t1 += t0;
    }

    // --- 共通の部品 ---

    private static byte GetBox(byte round, byte workKey)
    {
        var box = Sbox[((round & 0x0C) >> 2) + ((workKey & 0xE0) >> 3)];
        for (var i = (0xFF ^ round) & 3; i > 0; i--) box >>= 2;
        return box;
    }

    private static uint Scramble(uint t0, uint t1)
    {
        t0 ^= t1;
        var b0 = LookupTable[(byte)t0];
        var b1 = LookupTable[(byte)(t0 >> 8)];
        var b2 = LookupTable[(byte)(t0 >> 16)];
        var b3 = LookupTable[(byte)(t0 >> 24)];
        b1 = (byte)(b1 ^ RotateByteLeft(b0));
        b0 = (byte)(b0 ^ RotateByteLeft(b1));
        b3 = (byte)(b3 ^ RotateByteLeft(b2));
        b2 = (byte)(b2 ^ RotateByteLeft(b3));
        b1 = (byte)(b1 ^ RotateByteLeft(RotateByteLeft(b2)));
        b2 = (byte)(b2 ^ RotateByteLeft(RotateByteLeft(b1)));
        b3 = (byte)(b3 ^ RotateByteLeft(RotateByteLeft(b0)));
        b0 = (byte)(b0 ^ RotateByteLeft(RotateByteLeft(b3)));
        return (uint)b0 | (uint)b1 << 8 | (uint)b2 << 16 | (uint)b3 << 24;
    }

    private static void BlockCipher(ref uint cipher, uint pass, byte box)
    {
        uint cc = (byte)((box & 2) != 0 ? 0x53 : 0);
        cc = (cc << 8) | (cc & 0xFF);
        var s0 = (ushort)(Reverse16((ushort)cipher) + Reverse16((ushort)pass) + cc);
        var s1 = (ushort)(Reverse16((ushort)(cipher >> 16)) + Reverse16((ushort)(pass >> 16)) + cc);
        cipher = (uint)Reverse16(s0) | (uint)Reverse16(s1) << 16;
        cipher = ((cipher & 0xF0F0F0F0) >> 4) | ((cipher & 0x0F0F0F0F) << 4);

        var rot = RotateLeft(pass);
        var mask = cipher & rot;
        var x = (byte)((mask >> 24) ^ (mask >> 16) ^ (mask >> 8) ^ mask);
        if (OddParity(x)) cipher ^= 0xFFFFFFFF ^ rot;

        var t = Reverse32(cipher);
        t = (box & 1) == 0
            ? ((t & 0x00000055) << 1) | ((t & 0x0000AA00) << 7) | ((t & 0x00550000) << 9) | ((t & 0x000000AA) << 16) |
              (t & 0x55000000) | ((t & 0x00AA5500) >> 8) | ((t & 0xAA000000) >> 17)
            : ((t & 0x00AA0000) << 7) | ((t & 0x00005500) << 9) | ((t & 0x00000055) << 16) | (t & 0xAA000000) |
              ((t & 0x000000AA) >> 1) | ((t & 0x0055AA00) >> 8) | ((t & 0x55000000) >> 15);
        cipher = Reverse32(t);
        cipher ^= Reverse32((t << 8) | (t >> 24)) ^ RotateLeft(cipher);
    }

    private static uint RotateLeft(uint value)
    {
        value = Reverse32(value);
        value = (value << 1) | (value >> 31);
        return Reverse32(value);
    }

    private static byte RotateByteLeft(byte value) => (byte)((value << 1) | (value >> 7));

    private static bool OddParity(byte value)
    {
        var count = 0;
        for (var i = 0; i < 8; i++)
        {
            if ((value & 1) != 0) count++;
            value >>= 1;
        }

        return (count & 1) != 0;
    }

    private static uint[] ToWords(byte[] bytes)
    {
        var words = new uint[bytes.Length / 4];
        for (var i = 0; i < words.Length; i++) words[i] = Read32(bytes, i * 4);
        return words;
    }

    private static ushort Reverse16(ushort value) => (ushort)((value >> 8) | (value << 8));

    private static uint Reverse32(uint value) => (value & 0xFF) << 24 | (value & 0xFF00) << 8 | (value >> 8) & 0xFF00 | (value >> 24) & 0xFF;

    private static uint Read32(ReadOnlySpan<byte> bytes, int at = 0) => (uint)bytes[at] | (uint)bytes[at + 1] << 8 | (uint)bytes[at + 2] << 16 | (uint)bytes[at + 3] << 24;

    private static void Write32(Span<byte> bytes, int at, uint value)
    {
        bytes[at] = (byte)value;
        bytes[at + 1] = (byte)(value >> 8);
        bytes[at + 2] = (byte)(value >> 16);
        bytes[at + 3] = (byte)(value >> 24);
    }
}
