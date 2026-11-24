namespace Denpa.Agent;

/*
 * ソフト B-CAS。**リーダーもカードも要らない。**
 *
 * カードの APDU をこの中で直接さばく。初期設定条件 (INT) とカード ID 情報 (IDI) は
 * 決まった値を返し、ECM 受信は <see cref="C2pc"/> で復号して鍵を渡す。
 * EMM 受信 (契約の更新) は受け取るだけで使わない (鍵は中に書き込んだものだけなので、
 * 0x2100 と返して打ち切る)。契約確認は ECM が通るのと同じ理屈で常に「有効」で返す。
 *
 * 元は SoftCAS (2012, wazoku.net) の winscard.dll で、暗号と鍵の引き方はそれと同じ
 * (同じ入力の出力はバイト単位で一致する。SoftCasTests の既知応答ベクトルは C の
 * 実装をそのまま走らせて作った)。鍵は workkey/B-CASワーク鍵.txt から 2026-11-24
 * 現在のものを入れてある。次の鍵更新でここも書き換える必要がある。
 *
 * 使うには環境変数 CARD_SOFT (値は何でもよい)。実在のカードリーダーがあるときは
 * そちらを先に試す (<see cref="CardLinks.All"/> の最後)。
 */
internal static class SoftCas
{
    /// <summary>画面に出す名前。「カードリーダー」でこの名で使わない設定にできる (<see cref="CardChoice"/>)</summary>
    internal const string LinkName = "SoftCAS (組み込み)";

    /// <summary>CARD_SOFT が書いてあるときだけ候補に入れる。書いていない間は実在のカードと同じ動き</summary>
    internal static bool Enabled => Config.Given("CARD_SOFT") is not null;

    internal static IReadOnlyList<CardLinkCandidate> Cards() =>
        Enabled ? [new CardLinkCandidate(LinkName, () => new SoftCasCard(LinkName))] : [];
}

/// <summary><see cref="SoftCas"/> のカードそのもの。APDU を 1 つ受けて応答を返すだけ</summary>
internal sealed class SoftCasCard : ICardLink
{
    /// <summary>ECM の最短 (中身 26 + MAC 4)。これより短ければ読まない (C の sizeof(ECM_t) + sizeof(MAC_t) と同じ)</summary>
    private const int MinEcm = 30;

    private readonly string _name;
    private bool _disposed;

    internal SoftCasCard(string name) => _name = name;

    public string Name => _name;

    /// <summary>ATR。合成した値で、denpa は中身を読みません (B-CAS かどうかは INT の返り値で決まる)</summary>
    public byte[] Reset()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return [0x3B, 0x80, 0x11, 0x11, 0x80];
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (apdu.Length < 5) throw new IOException($"APDU が短すぎます ({apdu.Length} バイト)");
        return apdu[1] switch
        {
            0x30 => Init(),
            0x32 => Ids(),
            0x34 => Ecm(apdu),
            0x36 => Reply(0x2100),
            0x3C => Reply(0x0800),
            _ => Reply(0xA1FE),
        };
    }

    public void Dispose() => _disposed = true;

    /// <summary>
    /// INT の応答 (61 バイト)。system key と CBC の初期値は SoftCAS が持っていた値で、
    /// 本物のカードとは違う。**denpa はこれを鍵作りに使うだけ**なので、値が違っても中の復号は続く。
    /// </summary>
    private static byte[] Init() =>
    [
        0x00, 0x39, 0x00, 0x00, 0x21, 0x00, 0x00, 0x05, 0xc0, 0xff, 0xee, 0xc0, 0xff, 0xee, 0x01, 0x50,
        0x36, 0x31, 0x04, 0x66, 0x4b, 0x17, 0xea, 0x5c, 0x32, 0xdf, 0x9c, 0xf5, 0xc4, 0xc3, 0x6c, 0x1b,
        0xec, 0x99, 0x39, 0x21, 0x68, 0x9d, 0x4b, 0xb7, 0xb7, 0x4e, 0x40, 0x84, 0x0d, 0x2e, 0x7d, 0x98,
        0xfe, 0x27, 0x19, 0x99, 0x19, 0x69, 0x09, 0x11, 0x01, 0x02, 0x01, 0x90, 0x00,
    ];

    /// <summary>IDI の応答 (19 バイト)。番号は合成した 1 枚ぶん (winscard.dll 版と同じ値で、画面には E0000030008674422 と出る)</summary>
    private static byte[] Ids() =>
    [
        0x00, 0x0f, 0x00, 0x00, 0x21, 0x00, 0x01, 0x54, 0x02, 0x00, 0x06, 0xfc, 0xa8, 0x08, 0x76, 0xf4,
        0xd8, 0x90, 0x00,
    ];

    /// <summary>
    /// ECM 受信。C の Decoder-ECM.cpp と同じ順で、先頭 3 バイトを残して復号し、
    /// 末尾の MAC を確かめて、通ればスクランブル鍵 (奇数・偶数) を 0x0200 と共に返す。
    /// 鍵を知らない・MAC が合わないときは 0x0401 (未契約と同じ扱い) を返す
    /// </summary>
    private static byte[] Ecm(ReadOnlySpan<byte> apdu)
    {
        // 応答は 25 バイト。返り値が 4〜5、鍵が 6〜21 (2012 年版の winscard.dll と同じ並び)
        var response = new byte[25];
        response[1] = 0x15;
        response[4] = 0x04;
        response[5] = 0x01;
        response[22] = 0x01;
        response[23] = 0x90;

        var length = apdu[4];
        if (length < MinEcm || apdu.Length < 5 + length) return response;

        var ecm = apdu.Slice(5, length);
        Span<byte> key = stackalloc byte[8];
        if (!TryGetKey(ecm[1], ecm[2], key)) return response;

        // length は 1 バイト (最大 255) なので、どんなときでもスタックに置ける
        Span<byte> plain = stackalloc byte[length];
        ecm[..3].CopyTo(plain);
        C2pc.Transform(ecm[0], key, ecm[3..], plain[3..], decrypt: true);

        Span<byte> mac = stackalloc byte[4];
        C2pc.GenerateMAC(ecm[0], key, plain[..^4], mac);
        if (!mac.SequenceEqual(plain[^4..])) return response;

        plain[3..19].CopyTo(response.AsSpan(6));
        response[4] = 0x02;
        response[5] = 0x00;
        return response;
    }

    /// <summary>返り値だけの応答 (EMM・契約確認・知らないコマンド)。SW は常に 90 00</summary>
    private static byte[] Reply(int code) => [0x00, 0x04, 0x00, 0x00, (byte)(code >> 8), (byte)code, 0x90, 0x00];

    /// <summary>
    /// ワーク鍵。事業体識別ごとに偶数・奇数の 2 つ組で、引き当ては C の Keyset.cpp と同じ
    /// (ワーク鍵識別の 1 ビット目でスロットを選ぶ)。
    ///
    /// <para>
    /// 2026-11-24 現在 (workkey/B-CASワーク鍵.txt から)。BS10 プレミアムは 2026-04-01 に
    /// 事業体識別 17 (スカパー！) へ移ったので、0x03 は最後の値のまま使われない残骸。
    /// 「運用中」と「次期運用予定」を入れてある。
    /// </para>
    /// </summary>
    private static readonly (byte Bid, (byte Id, byte[] Key) Even, (byte Id, byte[] Key) Odd)[] Keysets =
    [
        (0x01, (0x02, [0x8d, 0x82, 0x06, 0xc6, 0x2e, 0xb1, 0x41, 0x0d]), (0x01, [0x15, 0xf8, 0xc5, 0xbf, 0x84, 0x0b, 0x66, 0x94])), // NHK (メール)
        (0x02, (0x0c, [0xa4, 0x06, 0x5a, 0x58, 0xc1, 0x43, 0x67, 0x7d]), (0x0d, [0xf6, 0x27, 0x9a, 0xc9, 0xbb, 0x37, 0x44, 0x66])), // WOWOW (0c 運用中 / 0d 次期)
        (0x03, (0x08, [0x75, 0x09, 0x07, 0x44, 0x06, 0x20, 0x01, 0x06]), (0x09, [0x41, 0x40, 0x21, 0x51, 0x30, 0x07, 0x12, 0x77])), // BS10 プレミアム (旧スターチャンネル。2026-04-01 で 17 に移行、残骸)
        (0x17, (0x0c, [0xbd, 0x2a, 0xa1, 0x15, 0xc1, 0x85, 0x6f, 0x52]), (0x0b, [0xd6, 0x7a, 0xbc, 0x4d, 0x21, 0xcd, 0x5d, 0x70])), // スカパー！ (0b 運用中 / 0c 次期。BS10 プレミアムもここ)
        (0x1d, (0x00, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), (0x01, [0xdb, 0xa4, 0x96, 0xac, 0xec, 0xef, 0x81, 0x28])), // セーフティネット
        (0x1e, (0x02, [0x8d, 0x82, 0x06, 0xc6, 0x2e, 0xb1, 0x41, 0x0d]), (0x01, [0x15, 0xf8, 0xc5, 0xbf, 0x84, 0x0b, 0x66, 0x94])), // NHK
        (0x20, (0x00, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), (0x00, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), // メール
    ];

    private static bool TryGetKey(byte bid, byte workKeyId, Span<byte> key)
    {
        foreach (var set in Keysets)
        {
            if (set.Bid != bid) continue;
            var slot = (workKeyId & 1) == 0 ? set.Even : set.Odd;
            if (slot.Id != workKeyId) return false;
            slot.Key.CopyTo(key);
            return true;
        }

        return false;
    }
}
