using System.Buffers.Binary;
using System.Text;

namespace Denpa.Agent;

/*
 * USB の CCID カードリーダーを直に叩く。**pcscd も pcsc-lite も使わない。**
 *
 * 3段:
 *
 * - UsbFs.cs … /dev/bus/usb をバルク転送で読み書きする口と、ディスクリプタの読み方
 * - Ccid.cs  … CCID の命令 (電源・パラメータ・XfrBlock) と、それを ICardLink にしたもの
 * - T1.cs    … ATR の読み方と、TPDU 単位の読み取り機のための T=1 のブロックのやり取り
 *
 * 本番は Gemalto (Gemplus) PC Twin Reader (08e6:3437) に B-CAS。これは TPDU 単位で、
 * ATR から勝手にパラメータを決めてくれない (dwFeatures 0x00010230) ので、
 * T=1 の枠組みも SetParameters もこちらが持つ。
 */

/// <summary>CCID の応答1つ</summary>
/// <param name="Status">bmStatus。下2bit がカードの状態、上2bit が命令の結果</param>
/// <param name="Error">bError。失敗のときの理由、時間延長のときは倍率</param>
/// <param name="Chain">bChainParameter (DataBlock) など、10 バイト目</param>
public sealed record CcidReply(byte Type, byte Slot, byte Seq, byte Status, byte Error, byte Chain, byte[] Data)
{
    /// <summary>0 = 挿さっていて電源が入っている、1 = 挿さっているが電源が切れている、2 = 無い</summary>
    public int Icc => Status & 0x03;

    /// <summary>0 = 成功、1 = 失敗、2 = 時間延長 (まだ終わっていない)</summary>
    public int Command => Status >> 6;

    public bool Absent => Icc == 2;
    public bool Failed => Command == 1;
    public bool TimeExtension => Command == 2;
}

/// <summary>CCID のメッセージの組み立てと読み方 (CCID 1.1 の 6.1 / 6.2)。**機材に触らない**</summary>
public static class CcidMessage
{
    public const int Header = 10;

    public const byte SetParameters = 0x61;
    public const byte PowerOn = 0x62;
    public const byte PowerOff = 0x63;
    public const byte GetSlotStatus = 0x65;
    public const byte XfrBlock = 0x6F;

    public const byte DataBlock = 0x80;
    public const byte SlotStatus = 0x81;
    public const byte Parameters = 0x82;

    // bError のうち、T=1 でブロックを頼み直せば済むもの
    public const byte IccMute = 0xFE;
    public const byte ParityError = 0xFD;
    public const byte Overrun = 0xFC;

    /// <summary>スロットはいつも 0 (bMaxSlotIndex が 0 のものしか扱わない)</summary>
    public static byte[] Command(byte type, byte seq, ReadOnlySpan<byte> data, byte p1 = 0, byte p2 = 0, byte p3 = 0)
    {
        var message = new byte[Header + data.Length];
        message[0] = type;
        BinaryPrimitives.WriteInt32LittleEndian(message.AsSpan(1), data.Length);
        message[6] = seq;
        message[7] = p1;
        message[8] = p2;
        message[9] = p3;
        data.CopyTo(message.AsSpan(Header));
        return message;
    }

    /// <summary>頭の dwLength が言うメッセージ全体の長さ</summary>
    public static int Length(ReadOnlySpan<byte> header) =>
        Header + (int)Math.Min(BinaryPrimitives.ReadUInt32LittleEndian(header[1..]), int.MaxValue - Header);

    public static CcidReply Parse(ReadOnlySpan<byte> message)
    {
        if (message.Length < Header || message.Length < Length(message))
        {
            throw new IOException("リーダーの応答が途中で切れています");
        }
        var data = message.Slice(Header, Length(message) - Header).ToArray();
        return new CcidReply(message[0], message[5], message[6], message[7], message[8], message[9], data);
    }

    /// <summary>bError を日本語に (CCID 1.1 の 6.2.6)</summary>
    public static string Describe(byte error) => error switch
    {
        IccMute => "カードが応答しません",
        ParityError => "パリティ誤り",
        Overrun => "受け取りが溢れました",
        0xFB => "リーダーの故障",
        0xF8 => "ATR の TS が不正です",
        0xF7 => "ATR の TCK が不正です",
        0xF6 => "対応していないプロトコルです",
        0xF5 => "対応していない電圧のカードです",
        0xF4 => "手続きバイトが食い違いました",
        0xF3 => "プロトコルが無効にされています",
        0xF2 => "リーダーが自動の処理の最中です",
        0xEF => "打ち切られました",
        0xE0 => "スロットが使用中です",
        0x00 => "リーダーが対応していない命令です",
        < 0x80 => $"命令の {error} バイト目をリーダーが受け付けません",
        _ => $"不明な誤り 0x{error:X2}",
    };
}

/// <summary>
/// CCID のリーダー1台 (のスロット 0) を <see cref="ICardLink"/> にしたもの。
///
/// <para>
/// **読み取り機の単位で道が分かれる。** TPDU 単位なら T=1 のブロックをこちらで組み
/// (<see cref="T1Protocol"/>)、APDU 単位なら APDU をそのまま XfrBlock に載せる。
/// 文字単位は断る。
/// </para>
///
/// <para>
/// 失敗はすべて <see cref="IOException"/>。抜かれた・カードが抜けたあとは使えないので、
/// 呼んだ側が捨てて <see cref="Ccid.Find"/> から開き直す (繋ぎ直しは B-CAS の側)。
/// </para>
/// </summary>
public sealed class CcidLink : ICardLink
{
    /// <summary>応答の読み違いを諦めるまでに読み飛ばす数 (前のプロセスが残した応答など)</summary>
    private const int MaxStale = 8;

    private readonly IBulkPipe _pipe;
    private byte _seq;
    private T1Protocol? _t1;
    private int _bwtMs = 1500;

    public string Name { get; }
    public CcidInterface Interface { get; }

    /// <summary>最後に <see cref="Reset"/> で読んだ ATR</summary>
    public Atr? Atr { get; private set; }

    /// <summary>TPDU 単位のとき、S(IFS) で決まったこちらの受け口</summary>
    public int? Ifsd => _t1?.Ifsd;

    public CcidLink(string name, IBulkPipe pipe, CcidInterface info)
    {
        Name = name;
        _pipe = pipe;
        Interface = info;
    }

    /// <summary>
    /// 電源を入れ直して ATR を返す。
    ///
    /// <para>
    /// **いったん切ってから入れる** (前のプロセスが入れたままにしていても、同じ所から始める)。
    /// 電圧を自分で選べないリーダーには 5V → 3V → 1.8V の順に試す (pcsc-lite の CCID ドライバと同じ順)。
    /// </para>
    ///
    /// <para>
    /// **SetParameters を忘れると、B-CAS とは話が通じない。** B-CAS は specific mode で、
    /// ATR の直後から TA1 の速さ (Di 2) で話すのに、PC Twin はそれを自分では読まない
    /// (dwFeatures に「ATR からパラメータを決める」0x02 が無い)。リーダーは既定の速さのまま
    /// 聞くので、最初のブロックから黙る。
    /// </para>
    /// </summary>
    /// <summary>電源を入れた (PowerOn を送った)。閉じるときに切る</summary>
    private bool _powered;

    public byte[] Reset()
    {
        if (!Interface.Tpdu && !Interface.Apdu)
        {
            throw new IOException($"{Name} は{Interface.Level}のリーダーで、対応していません");
        }
        _t1 = null;
        Atr = null;
        Call(CcidMessage.PowerOff, []);
        _powered = false;

        byte[]? raw = null;
        string? why = null;
        foreach (var select in PowerSelects())
        {
            var reply = Call(CcidMessage.PowerOn, [], select);
            _powered = true;
            if (reply.Absent) throw new CardAbsentException($"{Name} にカードが挿さっていません");
            if (!reply.Failed && reply.Data.Length > 0)
            {
                raw = reply.Data;
                break;
            }
            why = CcidMessage.Describe(reply.Error);
            Call(CcidMessage.PowerOff, []);
        }
        if (raw is null) throw new IOException($"{Name} のカードに電源を入れても ATR が来ません ({why})");

        var atr = Denpa.Agent.Atr.Parse(raw);
        if (Interface.Tpdu && !atr.T1) throw new IOException($"T=1 に対応していないカードです (ATR {Convert.ToHexString(raw)})");
        if (atr.T1 && (Interface.Features & CcidInterface.AutoParameters) == 0) SetT1Parameters(atr);

        // BWT = 2^BWI × 960 × 372 / f (Fd = 372 で数える)。USB の待ちはこれより長く取る
        var clock = Interface.ClockKhz > 0 ? Interface.ClockKhz : 4000;
        _bwtMs = (int)((1L << atr.Bwi) * 960 * 372 / clock) + 1;
        Atr = atr;

        if (Interface.Tpdu)
        {
            _t1 = new T1Protocol(atr, Exchange);
            // 1ブロック = NAD PCB LEN + INF + LRC。CCID の頭 10 バイトと一緒に1メッセージに収まる長さまで
            var ifsd = Math.Min(Interface.MaxIfsd > 0 ? Interface.MaxIfsd : 254, Interface.MaxMessage - CcidMessage.Header - 4);
            _t1.NegotiateIfsd(ifsd);
        }
        return raw;
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (Atr is null) throw new InvalidOperationException($"{Name} はまだ Reset していません");
        return _t1 is not null ? _t1.Transmit(apdu) : TransmitApdu(apdu);
    }

    /// <summary>bPowerSelect の試す順。0 = 自動、1 = 5V、2 = 3V、3 = 1.8V</summary>
    private IEnumerable<byte> PowerSelects()
    {
        if ((Interface.Features & CcidInterface.AutoVoltage) != 0 || (Interface.Voltages & 0x07) == 0)
        {
            yield return 0;
            yield break;
        }
        for (var bit = 0; bit < 3; bit++)
        {
            if ((Interface.Voltages & (1 << bit)) != 0) yield return (byte)(bit + 1);
        }
    }

    /// <summary>
    /// T=1 のパラメータを教える (abProtocolDataStructure の 7 バイト)。
    ///
    /// <para>
    /// 速さ (Fi/Di) は **specific mode なら TA1 そのもの**。negotiable mode のカードは PPS を
    /// しない限り既定の速さ (0x11) のままなので、リーダーが PPS を自分でする (0x80) ときだけ TA1 を渡す
    /// </para>
    /// </summary>
    private void SetT1Parameters(Atr atr)
    {
        var fiDi = atr.Specific || (Interface.Features & CcidInterface.AutoPps) != 0 ? atr.FiDi : (byte)0x11;
        byte[] data =
        [
            fiDi,
            (byte)(0x10 | (atr.Crc ? 1 : 0) | (atr.Inverse ? 2 : 0)),
            atr.GuardN,
            (byte)((atr.Bwi << 4) | atr.Cwi),
            0x00,
            (byte)atr.Ifsc,
            0x00,
        ];
        var reply = Call(CcidMessage.SetParameters, data, 1);
        Check(reply, "T=1 のパラメータを設定できません");
    }

    /// <summary>
    /// T=1 のブロックを1つ送って1つ受ける (<see cref="T1Protocol"/> の下の口)。
    /// カードが黙った・化けたは null (T=1 の側で頼み直す)
    /// </summary>
    private byte[]? Exchange(byte[] block, byte wtx)
    {
        var reply = Call(CcidMessage.XfrBlock, block, wtx, timeoutMs: 5000 + _bwtMs * Math.Max(1, (int)wtx));
        if (reply.Absent) throw new IOException($"{Name} のカードが抜かれました");
        if (reply.Failed)
        {
            if (reply.Error is CcidMessage.IccMute or CcidMessage.ParityError or CcidMessage.Overrun) return null;
            throw new IOException($"{Name}: {CcidMessage.Describe(reply.Error)}");
        }
        return reply.Data;
    }

    /// <summary>
    /// APDU 単位のリーダー。**1メッセージに収まらなければ wLevelParameter で連結する**
    /// (extended APDU 単位。送るとき 1 = 始め、3 = 続き、2 = 終わり、受けるとき 0x10 で続きを頼む)
    /// </summary>
    private byte[] TransmitApdu(ReadOnlySpan<byte> apdu)
    {
        var room = Interface.MaxMessage - CcidMessage.Header;
        CcidReply reply;
        if (apdu.Length <= room)
        {
            reply = Xfr(apdu, 0);
        }
        else
        {
            var offset = 0;
            for (; ; )
            {
                var length = Math.Min(room, apdu.Length - offset);
                var level = offset == 0 ? 1 : offset + length == apdu.Length ? 2 : 3;
                reply = Xfr(apdu.Slice(offset, length), level);
                offset += length;
                if (offset == apdu.Length) break;
            }
        }

        var response = new List<byte>(reply.Data);
        while (reply.Chain is 1 or 3)
        {
            reply = Xfr([], 0x10);
            response.AddRange(reply.Data);
        }
        return [.. response];
    }

    private CcidReply Xfr(ReadOnlySpan<byte> data, int level)
    {
        var reply = Call(CcidMessage.XfrBlock, data, 0, (byte)level, (byte)(level >> 8), 5000 + _bwtMs);
        if (reply.Absent) throw new IOException($"{Name} のカードが抜かれました");
        Check(reply, "カードとやり取りできません");
        return reply;
    }

    private void Check(CcidReply reply, string what)
    {
        if (reply.Failed) throw new IOException($"{Name}: {what} ({CcidMessage.Describe(reply.Error)})");
    }

    /// <summary>
    /// 命令を1つ送って、**同じ番号の**答えを返す。
    ///
    /// <para>
    /// 番号の違う応答は読み飛ばす (前のプロセスが途中で死んで残した応答など)。
    /// 時間延長 (カードがまだ考えている) は来るたびに読み直す。
    /// </para>
    /// </summary>
    private CcidReply Call(byte type, ReadOnlySpan<byte> data, byte p1 = 0, byte p2 = 0, byte p3 = 0, int timeoutMs = 5000)
    {
        var seq = _seq++;
        _pipe.Write(CcidMessage.Command(type, seq, data, p1, p2, p3));
        for (var stale = 0; ;)
        {
            var reply = CcidMessage.Parse(ReadMessage(timeoutMs));
            if (reply.Seq != seq)
            {
                if (++stale > MaxStale) throw new IOException($"{Name} の応答の番号が合いません");
                continue;
            }
            if (reply.TimeExtension) continue;
            return reply;
        }
    }

    /// <summary>
    /// CCID のメッセージを1つ読む。
    ///
    /// <para>
    /// **長さぴったりに頼む。** メッセージがパケットの大きさの倍数で終わるとき、
    /// ZLP を送らないリーダーがあり、大きめの受け口で待つと時間切れまで返らない。
    /// 先に1パケット読んで頭の dwLength を知り、残りをパケットの倍数に切り上げて頼む。
    /// 前のメッセージのあとの ZLP (0 バイト) は読み飛ばす。
    /// </para>
    /// </summary>
    private byte[] ReadMessage(int timeoutMs)
    {
        var packet = Interface.MaxPacketIn;
        var buffer = new byte[(CcidMessage.Header + packet - 1) / packet * packet];
        var total = 0;
        for (var empty = 0; total < CcidMessage.Header;)
        {
            var got = _pipe.Read(buffer.AsSpan(total), timeoutMs);
            if (got == 0)
            {
                if (total > 0 || ++empty > 4) throw new IOException($"{Name} から空の応答が続きます");
                continue;
            }
            total += got;
            // 短いパケットはメッセージの終わり。頭も揃わないうちに終わるのは壊れている
            if (total < CcidMessage.Header && got % packet != 0)
            {
                throw new IOException($"{Name} の応答が短すぎます ({total} バイト)");
            }
        }

        var length = CcidMessage.Length(buffer);
        if (length > Math.Max(Interface.MaxMessage, 271) + packet)
        {
            throw new IOException($"{Name} の応答の長さがおかしい ({length} バイト)");
        }
        if (total < length)
        {
            var rounded = (length - total + packet - 1) / packet * packet;
            Array.Resize(ref buffer, total + rounded);
            while (total < length)
            {
                var got = _pipe.Read(buffer.AsSpan(total), timeoutMs);
                if (got == 0) throw new IOException($"{Name} の応答が途中で切れています");
                total += got;
            }
        }
        return buffer[..length];
    }

    public void Dispose()
    {
        try
        {
            // ATR を読めずに失敗したときも、電源を入れたなら切っておく
            if (_powered) Call(CcidMessage.PowerOff, [], timeoutMs: 1000);
        }
        catch (IOException)
        {
            // 抜かれたあとなら切るものも無い
        }
        _pipe.Dispose();
    }
}

/// <summary>USB の CCID リーダーを探す</summary>
public static class Ccid
{
    private const string Sysfs = "/sys/bus/usb/devices";
    private const string DevUsb = "/dev/bus/usb";

    /// <summary>
    /// 刺さっている CCID のインターフェース (bInterfaceClass 0x0b) を並べる。**開かない。**
    /// sysfs だけを読むので、別のプロセスが掴んでいても並ぶ (開くときに断られる)
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Find() => Find(Sysfs, DevUsb);

    internal static List<CardLinkCandidate> Find(string sysfs, string devUsb)
    {
        var found = new List<CardLinkCandidate>();
        if (!Directory.Exists(sysfs)) return found;
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs, "*:*").Order(StringComparer.Ordinal))
        {
            // 4-11:1.0 → 機材 4-11、構成 1、インターフェース 0
            var name = Path.GetFileName(entry);
            var colon = name.IndexOf(':');
            var dot = name.IndexOf('.', colon + 1);
            if (colon <= 0 || dot < 0 || !int.TryParse(name.AsSpan(colon + 1, dot - colon - 1), out var config)) continue;
            if (Attribute(entry, "bInterfaceClass") != "0b") continue;
            if (!int.TryParse(Attribute(entry, "bInterfaceNumber"), System.Globalization.NumberStyles.HexNumber, null, out var number))
            {
                continue;
            }

            var port = name[..colon];
            var device = Path.Combine(sysfs, port);
            if (!int.TryParse(Attribute(device, "busnum"), out var bus)
                || !int.TryParse(Attribute(device, "devnum"), out var address)
                || !int.TryParse(Attribute(device, "idVendor"), System.Globalization.NumberStyles.HexNumber, null, out var vendor)
                || !int.TryParse(Attribute(device, "idProduct"), System.Globalization.NumberStyles.HexNumber, null, out var product))
            {
                continue;
            }

            var label = Label(Attribute(device, "manufacturer"), Attribute(device, "product"), vendor, product);
            var where = number == 0 ? port : $"{port}:{config}.{number}";
            var display = $"{label} (usb {where})";
            var path = $"{devUsb}/{bus:000}/{address:000}";
            found.Add(new CardLinkCandidate(display, () =>
            {
                var pipe = UsbFsPipe.Open(path, vendor, product, config, number);
                return new CcidLink(display, pipe, pipe.Interface);
            }));
        }
        return found;
    }

    /// <summary>画面に出す名前。製品名に作り手の名前が入っていなければ前に付ける</summary>
    internal static string Label(string? manufacturer, string? product, int vendor, int productId)
    {
        if (string.IsNullOrEmpty(product)) return $"CCID {vendor:x4}:{productId:x4}";
        if (string.IsNullOrEmpty(manufacturer) || product.StartsWith(manufacturer, StringComparison.OrdinalIgnoreCase)) return product;
        return $"{manufacturer} {product}";
    }

    private static string? Attribute(string dir, string name)
    {
        try
        {
            return File.ReadAllText(Path.Combine(dir, name)).Trim();
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// 診断用。見つかったリーダーを並べ、<paramref name="reset"/> なら最初の1台のカードに
    /// 電源を入れて ATR と読み取り機の形を書く。**実機で最初に当てるのはここ。**
    /// </summary>
    public static string Describe(bool reset = false)
    {
        var text = new StringBuilder();
        var found = Find();
        if (found.Count == 0)
        {
            return $"CCID のカードリーダーが見つかりません ({Sysfs} に bInterfaceClass 0b のインターフェースがありません)";
        }
        foreach (var candidate in found) text.AppendLine(candidate.Name);
        if (!reset) return text.ToString().TrimEnd();

        try
        {
            using var link = (CcidLink)found[0].Open();
            var info = link.Interface;
            text.AppendLine($"{link.Name}: {info.Level} 単位, dwFeatures 0x{info.Features:x8}, "
                + $"メッセージ {info.MaxMessage} バイトまで, 電圧 0x{info.Voltages:x2}, "
                + $"bulk in 0x{info.BulkIn:x2} / out 0x{info.BulkOut:x2}");
            link.Reset();
            text.AppendLine($"ATR {link.Atr}");
            if (link.Ifsd is { } ifsd) text.AppendLine($"T=1 IFSD {ifsd}");
        }
        catch (IOException error)
        {
            text.AppendLine(error.Message);
        }
        return text.ToString().TrimEnd();
    }
}
