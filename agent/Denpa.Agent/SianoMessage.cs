using System.Buffers.Binary;

namespace Denpa.Agent;

/*
 * Siano RIO 系の ISDB-T 用 USB チューナー (PLEX PX-S1UD など) とやり取りするメッセージの組み立てと読み取り。
 *
 * クリーンルームで、仕様書 (denpa-spec の siano/spec.md。Siano RIO 系の機材を USB で直に動かす手順を書いたもの) だけから書いた。
 * Linux カーネルの Siano のドライバ (smsusb・smscoreapi・smsdvb など) と siano-userland のコードは読んでいない。
 * コメントの「仕様書 x.y」は仕様書の節の番号で、メッセージの番号と欄の位置はその節の表のまま持つ。仕様書に無くて決めた所は「仕様書に無い」と書いてある。
 * 機材を開いて動かす側は SianoDevice.cs、ファームウェアのファイルは SianoFirmware.cs、TS を 188 バイトに揃える側は SianoTs.cs、
 * 設定と自動検出は SianoNative.cs。実機では確かめていない (docs/tuner-px-s1ud.md)。
 */

/// <summary>メッセージの番号・ID と、ヘッダの組み立て・読み取り (仕様書 3)。複数バイトの数はどれもリトルエンディアン</summary>
internal static class SianoMessage
{
    /// <summary>ヘッダの長さ (仕様書 3.1)。番号 u16・送り手 u8・受け手 u8・長さ u16 (ヘッダを含む)・フラグ u16</summary>
    public const int HeaderSize = 8;

    // 仕様書 3.5 の番号。応答はどれも要求の番号 + 1 (仕様書 3.4)
    public const ushort ModeInit = 578;
    public const ushort ModeInitDone = 579;
    public const ushort AddPid = 601;
    public const ushort AddPidDone = 602;
    public const ushort StatsOld = 615;
    public const ushort StatsOldDone = 616;
    public const ushort StatsNew = 653;
    public const ushort StatsNewDone = 654;
    public const ushort Resumed = 655;
    public const ushort DataWrite = 660;
    public const ushort DataWriteDone = 661;
    public const ushort DataCheck = 662;
    public const ushort DataCheckDone = 663;
    public const ushort Run = 664;
    public const ushort RunDone = 665;
    public const ushort Version = 668;
    public const ushort VersionDone = 669;
    public const ushort Ts = 693;
    public const ushort Tune = 776;
    public const ushort TuneDone = 777;
    public const ushort SignalFound = 827;
    public const ushort SignalLost = 828;

    /// <summary>送り手の ID: 起動のメッセージ (バージョンの問い合わせ・ファームウェア・モードの初期化。仕様書 3.2)</summary>
    public const byte FromBoot = 0;

    /// <summary>送り手の ID: 選局・PID を足す・統計の要求 (仕様書 3.2)</summary>
    public const byte FromTuner = 201;

    /// <summary>受け手の ID: 機材の中の、ホストとやり取りする窓口 (仕様書 3.2)</summary>
    public const byte ToDevice = 11;

    /// <summary>1 つの「データの書き込み」に入れるデータの上限 (仕様書 3.5・4.2)</summary>
    public const int DataWriteMax = 240;

    /// <summary>受けたヘッダのフラグのうち、中身が転送の途中から始まることを表すビット (仕様書 3.3)</summary>
    public const ushort SplitFlag = 0x0004;

    /// <summary>中身が u32 の並びのメッセージ (仕様書 3.1)。フラグは 0</summary>
    public static byte[] Build(ushort number, byte sender, params ReadOnlySpan<uint> words)
    {
        var message = new byte[HeaderSize + words.Length * 4];
        Header(message, number, sender);
        for (var i = 0; i < words.Length; i++) BinaryPrimitives.WriteUInt32LittleEndian(message.AsSpan(HeaderSize + i * 4), words[i]);
        return message;
    }

    /// <summary>データの書き込み (660。仕様書 4.2): u32 のアドレスに続けて <paramref name="data"/> (240 バイトまで)</summary>
    public static byte[] BuildDataWrite(uint address, ReadOnlySpan<byte> data)
    {
        if (data.Length > DataWriteMax) throw new ArgumentOutOfRangeException(nameof(data), $"データの書き込みは {DataWriteMax} バイトまでです ({data.Length} バイト)");
        var message = new byte[HeaderSize + 4 + data.Length];
        Header(message, DataWrite, FromBoot);
        BinaryPrimitives.WriteUInt32LittleEndian(message.AsSpan(HeaderSize), address);
        data.CopyTo(message.AsSpan(HeaderSize + 4));
        return message;
    }

    private static void Header(Span<byte> message, ushort number, byte sender)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(message, number);
        message[2] = sender;
        message[3] = ToDevice;
        BinaryPrimitives.WriteUInt16LittleEndian(message[4..], (ushort)message.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(message[6..], 0);
    }

    /// <summary>
    /// 中身のずれを決める幅 (仕様書 2.1 の「そろえ幅」)。IN の最大パケット長 − 8。最大パケット長が 8 以下なら 0 (ずれを使わない)
    /// </summary>
    public static int Align(int maxPacket) => maxPacket > HeaderSize ? maxPacket - HeaderSize : 0;

    /// <summary>
    /// 1 回の IN の転送を 1 つのメッセージとして読む (仕様書 2.3・3.1・3.3)。壊れていれば false で、<paramref name="why"/> に理由。
    ///
    /// <para>
    /// ヘッダは転送の先頭 8 バイト。フラグのビット 2 が立っていて <paramref name="align"/> が 0 でなければ、
    /// 中身は「<paramref name="align"/> + ((フラグ >> 8) &amp; 3) + 8」バイト目から「長さ − 8」バイト。立っていなければ 8 バイト目から。
    /// 転送のうち、メッセージの終わりより後ろは読まない。送り手と受け手の ID は見ない (番号だけで見分ける。仕様書 3.2)
    /// </para>
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> transfer, int align, out ushort number, out ushort flags, out ReadOnlySpan<byte> payload, out string why)
    {
        number = 0;
        flags = 0;
        payload = default;
        if (transfer.Length < HeaderSize)
        {
            why = $"転送が {transfer.Length} バイトで、ヘッダに足りません";
            return false;
        }
        number = BinaryPrimitives.ReadUInt16LittleEndian(transfer);
        var length = BinaryPrimitives.ReadUInt16LittleEndian(transfer[4..]);
        flags = BinaryPrimitives.ReadUInt16LittleEndian(transfer[6..]);
        if (length < HeaderSize)
        {
            why = $"メッセージ {number} の長さが {length} で、ヘッダより短い";
            return false;
        }
        var shift = (flags & SplitFlag) != 0 && align != 0 ? align + ((flags >> 8) & 3) : 0;
        if (shift + length > transfer.Length)
        {
            why = $"メッセージ {number} の長さ {length} (ずれ {shift}) が転送の {transfer.Length} バイトに収まりません";
            return false;
        }
        payload = transfer.Slice(shift + HeaderSize, length - HeaderSize);
        why = "";
        return true;
    }
}

/// <summary>
/// バージョンの応答 (669) の中身 (仕様書 4.1)。位置はヘッダのあとの中身の先頭から
/// </summary>
/// <param name="Chip">チップの型番 (位置 0〜1)。記録に出すだけ</param>
/// <param name="Mode">動いているファームウェアのモード (位置 4)。255 はファームウェアが入っていない</param>
/// <param name="Modes">対応しているモードのビットの並び (位置 5。ビット n がモード n)</param>
/// <param name="Firmware">ファームウェアのバージョン (位置 6〜9)。記録に出すだけ</param>
/// <param name="RomMajor">ROM のバージョンの上位 (位置 10)</param>
/// <param name="RomMinor">ROM のバージョンの下位 (位置 11)</param>
internal sealed record SianoVersion(ushort Chip, byte Mode, byte Modes, byte[] Firmware, byte RomMajor, byte RomMinor)
{
    /// <summary>ISDB-T のモードの番号 (仕様書 4.3)</summary>
    public const byte Isdbt = 6;

    /// <summary>ファームウェアが入っていない (ROM のまま) ときのモードの値 (仕様書 4.1)</summary>
    public const byte NoFirmware = 255;

    /// <summary>モードの初期化を送るか・統計の要求がどちらの形式かを分ける値 (仕様書 4.1・7.1)</summary>
    public const int NewFormatFrom = 0x0800;

    /// <summary>状態を見分けるのに要る中身の長さ (仕様書 4.1。これより短い応答は使わない)</summary>
    public const int MinLength = 12;

    /// <summary>ROM のバージョンを 1 つの値にしたもの (上位 × 256 + 下位。仕様書 4.1)</summary>
    public int Value => (RomMajor << 8) | RomMinor;

    public bool Ready => Mode == Isdbt;

    /// <summary>ROM のままで ISDB-T のモードに対応しているか (位置 5 のビット 6)</summary>
    public bool SupportsIsdbt => (Modes & (1 << Isdbt)) != 0;

    /// <summary>統計の要求と応答が新しい形式 (653 → 654) か (仕様書 7.1)</summary>
    public bool NewStats => Value >= NewFormatFrom;

    /// <summary>中身が 12 バイトより短ければ null</summary>
    public static SianoVersion? Parse(ReadOnlySpan<byte> payload) =>
        payload.Length < MinLength ? null
        : new SianoVersion(BinaryPrimitives.ReadUInt16LittleEndian(payload), payload[4], payload[5], payload.Slice(6, 4).ToArray(), payload[10], payload[11]);

    public string Describe() =>
        $"チップ 0x{Chip:X4}、モード {Mode}、対応モード 0x{Modes:X2}、ファームウェア {string.Join('.', Firmware)}、ROM {RomMajor}.{RomMinor} (値 0x{Value:X4})";
}

/// <summary>
/// 統計の応答 (新しい形式 654・古い形式 616) から読んだ値 (仕様書 7.2・7.3)。届いた長さの中にある欄だけを読み、無い欄は null。
/// 復調のロックの位置 (新しい形式 16・古い形式 12) のほかは、仕様書でも 1 つの資料だけによる位置で、実機で確かめていない
/// </summary>
/// <param name="Locked">復調のロック (0 以外ならロックしている)</param>
/// <param name="SnrDb">SNR (dB、整数)</param>
/// <param name="PowerDbm">帯域の中の受信電力 (dBm、整数)</param>
/// <param name="Length">届いた中身の長さ</param>
internal sealed record SianoStats(bool Locked, int? SnrDb, int? PowerDbm, int Length)
{
    /// <summary>
    /// 番号が 654 なら先頭の 4 バイト (要求の結果) を飛ばした並び、616 なら飛ばさない並びで読む。
    /// 復調のロックの欄まで届いていなければ null (ロックの判定に使わない)
    /// </summary>
    public static SianoStats? Parse(ushort number, ReadOnlySpan<byte> payload)
    {
        // 新しい形式は、古い形式の欄が 4 バイト後ろにずれて並ぶ (仕様書 7.3)
        var skip = number == SianoMessage.StatsNewDone ? 4 : 0;
        if (U32(payload, skip + 12) is not { } demod) return null;
        var snr = S32(payload, skip + 20);
        var power = S32(payload, skip + 28);
        // 古い形式で統計の種類 (位置 0) が 0 の応答は、ロックと受信電力だけを返し、受信電力は伝送モードの欄 (位置 44) に入っている (仕様書 7.3)
        if (skip == 0 && U32(payload, 0) == 0)
        {
            snr = null;
            power = S32(payload, 44);
        }
        return new SianoStats(demod != 0, snr, power, payload.Length);
    }

    private static uint? U32(ReadOnlySpan<byte> payload, int at) =>
        at + 4 <= payload.Length ? BinaryPrimitives.ReadUInt32LittleEndian(payload[at..]) : null;

    private static int? S32(ReadOnlySpan<byte> payload, int at) =>
        at + 4 <= payload.Length ? BinaryPrimitives.ReadInt32LittleEndian(payload[at..]) : null;
}
