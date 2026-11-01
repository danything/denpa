using System.Security.Cryptography;

namespace Denpa.Agent;

/*
 * PIX-DT295 の暗号の部品 (仕様書 5.1)。AES-128 と AES-CMAC だけ。鍵も IV もここには持たず、いつも引数で受け取る。
 * 節の番号は DT295 の仕様書のもの (Dt295.cs の頭)。
 */

/// <summary>AES-128 の ECB・CBC と AES-CMAC (RFC 4493)、端数付き CBC 復号 (5.1)</summary>
public static class Dt295Crypto
{
    public const int Block = 16;

    private static Aes Create(ReadOnlySpan<byte> key)
    {
        if (key.Length != Block) throw new ArgumentException($"AES-128 の鍵は 16 バイトです ({key.Length} バイト)", nameof(key));
        var aes = Aes.Create();
        aes.Key = key.ToArray();
        return aes;
    }

    /// <summary>
    /// AES-CMAC (RFC 4493)。サブ鍵は <c>L = AES(K, 0^128)</c> から作る。最後のブロックがちょうど 16 バイトなら K1、
    /// 足りなければ 0x80 と 0 で埋めて K2。長さ 0 は埋めた 1 ブロックと K2
    /// </summary>
    public static byte[] Cmac(ReadOnlySpan<byte> key, ReadOnlySpan<byte> message)
    {
        using var aes = Create(key);
        Span<byte> l = stackalloc byte[Block];
        aes.EncryptEcb(new byte[Block], l, PaddingMode.None);
        Span<byte> k1 = stackalloc byte[Block];
        Span<byte> k2 = stackalloc byte[Block];
        Subkey(l, k1);
        Subkey(k1, k2);

        var blocks = Math.Max(1, (message.Length + Block - 1) / Block);
        var complete = message.Length > 0 && message.Length % Block == 0;
        Span<byte> last = stackalloc byte[Block];
        var tail = message[((blocks - 1) * Block)..];
        if (complete)
        {
            for (var i = 0; i < Block; i++) last[i] = (byte)(tail[i] ^ k1[i]);
        }
        else
        {
            last.Clear();
            tail.CopyTo(last);
            last[tail.Length] = 0x80;
            for (var i = 0; i < Block; i++) last[i] ^= k2[i];
        }

        Span<byte> x = stackalloc byte[Block];
        Span<byte> y = stackalloc byte[Block];
        x.Clear();
        for (var b = 0; b < blocks - 1; b++)
        {
            for (var i = 0; i < Block; i++) y[i] = (byte)(x[i] ^ message[b * Block + i]);
            aes.EncryptEcb(y, x, PaddingMode.None);
        }
        for (var i = 0; i < Block; i++) y[i] = (byte)(x[i] ^ last[i]);
        var mac = new byte[Block];
        aes.EncryptEcb(y, mac, PaddingMode.None);
        return mac;
    }

    /// <summary>1 ビット左へずらし、ずれ出たビットが 1 なら最後のバイトに 0x87 を XOR</summary>
    private static void Subkey(ReadOnlySpan<byte> from, Span<byte> to)
    {
        for (var i = 0; i < Block; i++) to[i] = (byte)((from[i] << 1) | (i + 1 < Block ? from[i + 1] >> 7 : 0));
        if ((from[0] & 0x80) != 0) to[Block - 1] ^= 0x87;
    }

    /// <summary>AES-128 で 1 ブロックを暗号化する</summary>
    public static void EncryptBlock(ReadOnlySpan<byte> key, ReadOnlySpan<byte> input, Span<byte> output)
    {
        using var aes = Create(key);
        aes.EncryptEcb(input[..Block], output[..Block], PaddingMode.None);
    }

    /// <summary>AES-128-CBC で暗号化する (埋めない。長さは 16 の倍数)</summary>
    public static void CbcEncrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv, Span<byte> data)
    {
        if (data.Length % Block != 0) throw new ArgumentException($"CBC は 16 の倍数の長さだけです ({data.Length} バイト)", nameof(data));
        using var aes = Create(key);
        aes.EncryptCbc(data, iv, data, PaddingMode.None);
    }

    /// <summary>
    /// 端数付き CBC 復号 (5.1)。先頭から 16 バイトずつ普通に CBC で復号し、16 バイトに満たない端数が残れば、
    /// 直前の暗号ブロック (1 つも無ければ IV) を AES で<b>暗号化</b>したものと XOR する。その場で書き換える
    /// </summary>
    public static void CbcDecryptWithResidual(ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv, Span<byte> data)
    {
        if (iv.Length != Block) throw new ArgumentException($"IV は 16 バイトです ({iv.Length} バイト)", nameof(iv));
        using var aes = Create(key);
        var whole = data.Length / Block * Block;
        Span<byte> previous = stackalloc byte[Block];
        // 端数に使う「直前の暗号ブロック」は復号で上書きされる前に取っておく
        (whole == 0 ? iv : data.Slice(whole - Block, Block)).CopyTo(previous);
        if (whole > 0) aes.DecryptCbc(data[..whole], iv, data[..whole], PaddingMode.None);
        var rest = data[whole..];
        if (rest.IsEmpty) return;
        Span<byte> stream = stackalloc byte[Block];
        aes.EncryptEcb(previous, stream, PaddingMode.None);
        for (var i = 0; i < rest.Length; i++) rest[i] ^= stream[i];
    }
}

/// <summary>パケット 1 つの復号の結果 (10.3)</summary>
public enum Dt295PacketResult
{
    /// <summary>暗号化されていなかった (transport_scrambling_control = 00)。そのまま</summary>
    Clear,

    /// <summary>復号して transport_scrambling_control を 00 に戻した</summary>
    Decrypted,

    /// <summary>不正なパケット (同期バイト・TEI・adaptation field の長さ・10 と 11 の保護)。参照実装はここで受信を止める</summary>
    Invalid,
}

/// <summary>
/// 機器が TS にかけ直した AES を外す (10.3)。**TS の IV はここで持たず、呼ぶ側が渡す。**
/// IV は公式パッケージからの取り出し方が分かっていない (12.7・14 章の 2) ので、denpa はまだ持っていない。
/// </summary>
public interface IDt295PacketDecryptor
{
    /// <summary>188 バイトのパケットを 1 つ、その場で復号する</summary>
    Dt295PacketResult Decrypt(Span<byte> packet, ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv);
}

/// <summary>10.3 の手順そのまま。状態を持たない</summary>
public sealed class Dt295PacketDecryptor : IDt295PacketDecryptor
{
    public const int PacketSize = 188;

    public Dt295PacketResult Decrypt(Span<byte> packet, ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        var (result, start) = Classify(packet);
        if (result != Dt295PacketResult.Decrypted) return result;
        // 7. ペイロードを端数付き CBC 復号。IV はパケットごとに始め直す (184 バイトなら 11 ブロックと 8 バイト)
        Dt295Crypto.CbcDecryptWithResidual(key, iv, packet[start..]);
        // 8. transport_scrambling_control を 00 に
        packet[3] &= 0x3F;
        return Dt295PacketResult.Decrypted;
    }

    /// <summary>
    /// 10.3 の手順 1〜6 だけ (鍵が要らない)。不正・暗号化されていない・復号すべき (Decrypted と返す) を見分け、ペイロードの始まりも返す
    /// </summary>
    public static (Dt295PacketResult Result, int Start) Classify(ReadOnlySpan<byte> packet)
    {
        if (packet.Length != PacketSize) throw new ArgumentException($"TS のパケットは 188 バイトです ({packet.Length} バイト)", nameof(packet));
        // 1. 同期バイトと TEI
        if (packet[0] != 0x47 || (packet[1] & 0x80) != 0) return (Dt295PacketResult.Invalid, 0);
        // 2. adaptation_field_control が 0 は不正
        var control = (packet[3] >> 4) & 0x3;
        if (control == 0) return (Dt295PacketResult.Invalid, 0);
        // 3. ペイロードの始まり
        var start = 4;
        if (control is 2 or 3)
        {
            start = 5 + packet[4];
            if (control == 2 && start != PacketSize) return (Dt295PacketResult.Invalid, 0);
            if (control == 3 && start >= PacketSize) return (Dt295PacketResult.Invalid, 0);
        }
        // 4. 暗号化されていない
        var scrambling = packet[3] >> 6;
        if (scrambling == 0) return (Dt295PacketResult.Clear, start);
        // 5. 01 以外は対応していない保護
        if (scrambling != 1) return (Dt295PacketResult.Invalid, 0);
        // 6. 01 なのにペイロードが無い
        if (control == 2) return (Dt295PacketResult.Invalid, 0);
        return (Dt295PacketResult.Decrypted, start);
    }
}
