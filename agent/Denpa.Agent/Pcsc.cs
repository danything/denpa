using System.Runtime.InteropServices;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// macOS と Windows の USB カードリーダー。**OS に最初から入っている PC/SC 越しに扱う**
/// (macOS は PCSC.framework、Windows は winscard.dll)。
///
/// <para>
/// Linux では usbfs を直接扱っている (Ccid.cs) が、macOS には usbfs が無く、CCID の
/// リーダーは OS (CryptoTokenKit の ifd-ccid) が先に開く。横取りするより、OS が
/// 出している PC/SC の API を借りるほうが素直で、入れてもらうものも増えない。
/// T=1 の枠組みも ATR の読み方も向こうが持つので、ここは APDU を渡すだけ。
/// </para>
///
/// <para>
/// **macOS の PC/SC は型の幅が pcsc-lite と違う。** <c>SCARDCONTEXT</c> / <c>SCARDHANDLE</c> は
/// int32、<c>DWORD</c> は uint32、<c>LONG</c> (返り値) は int32 (64bit でも)。pcsc-lite の
/// 見本 (long / unsigned long = 64bit) を写すと引数がずれる。
/// </para>
///
/// <para>
/// **Windows も同じ API で、違うのは型の幅と名前だけ。** <c>SCARDCONTEXT</c> / <c>SCARDHANDLE</c> は
/// ポインタの幅 (64bit で 8 バイト)、文字列を取るものは <c>…W</c> (UTF-16) を呼ぶ。
/// 手順も番号 (共有・プロトコル・エラー) も同じなので、違いは下の <c>Mac</c> / <c>Win</c> と、
/// それを選ぶ数行だけに閉じ込めてある。Windows も macOS と同じく usbfs が無く、
/// CCID のリーダーは OS の標準ドライバが先に開いている。
/// </para>
///
/// <para>
/// **排他で開く** (<c>SCARD_SHARE_EXCLUSIVE</c>)。Linux の usbfs でもインターフェースを
/// 独り占めしている。共有にすると、macOS がカードを覗きに来る (CryptoTokenKit が
/// 挿したカードに APDU を投げる) ときに INT と ECM の間へ割り込まれうる。開けなければ
/// 理由 (共有違反) を返し、BCas が少し置いて探し直す。
/// </para>
/// </summary>
public sealed partial class PcscLink : ICardLink
{
    private const uint ScopeSystem = 2;
    private const uint ShareExclusive = 1;
    private const uint ProtocolT1 = 2;
    private const uint LeaveCard = 0;

    /// <summary><c>SCARD_IO_REQUEST</c> (dwProtocol, cbPciLength)。<c>g_rgSCardT1Pci</c> と同じ中身 (どちらも DWORD 2つ)</summary>
    private static readonly uint[] T1Pci = [ProtocolT1, 8];

    /// <summary>macOS。ハンドルは int32、文字列は UTF-8</summary>
    private static partial class Mac
    {
        private const string Framework = "/System/Library/Frameworks/PCSC.framework/PCSC";

        [LibraryImport(Framework)]
        public static partial int SCardEstablishContext(uint scope, nint reserved1, nint reserved2, out int context);

        [LibraryImport(Framework)]
        public static partial int SCardReleaseContext(int context);

        [LibraryImport(Framework)]
        public static partial int SCardListReaders(int context, nint groups, [Out] byte[]? readers, ref uint length);

        [LibraryImport(Framework, StringMarshalling = StringMarshalling.Utf8)]
        public static partial int SCardConnect(int context, string reader, uint share, uint protocols, out int card, out uint active);

        [LibraryImport(Framework)]
        public static partial int SCardStatus(
            int card, nint names, ref uint namesLength, out uint state, out uint protocol, [Out] byte[] atr, ref uint atrLength);

        [LibraryImport(Framework)]
        public static partial int SCardTransmit(
            int card, uint[] sendPci, ReadOnlySpan<byte> send, uint sendLength, nint receivePci, [Out] byte[] receive, ref uint receiveLength);

        [LibraryImport(Framework)]
        public static partial int SCardDisconnect(int card, uint disposition);
    }

    /// <summary>Windows。ハンドルはポインタの幅、文字列は UTF-16 (<c>…W</c>)</summary>
    private static partial class Win
    {
        private const string Dll = "winscard.dll";

        [LibraryImport(Dll)]
        public static partial int SCardEstablishContext(uint scope, nint reserved1, nint reserved2, out nint context);

        [LibraryImport(Dll)]
        public static partial int SCardReleaseContext(nint context);

        [LibraryImport(Dll, EntryPoint = "SCardListReadersW")]
        public static partial int SCardListReaders(nint context, nint groups, [Out] byte[]? readers, ref uint length);

        [LibraryImport(Dll, EntryPoint = "SCardConnectW", StringMarshalling = StringMarshalling.Utf16)]
        public static partial int SCardConnect(nint context, string reader, uint share, uint protocols, out nint card, out uint active);

        [LibraryImport(Dll, EntryPoint = "SCardStatusW")]
        public static partial int SCardStatus(
            nint card, nint names, ref uint namesLength, out uint state, out uint protocol, [Out] byte[] atr, ref uint atrLength);

        [LibraryImport(Dll)]
        public static partial int SCardTransmit(
            nint card, uint[] sendPci, ReadOnlySpan<byte> send, uint sendLength, nint receivePci, [Out] byte[] receive, ref uint receiveLength);

        [LibraryImport(Dll)]
        public static partial int SCardDisconnect(nint card, uint disposition);
    }

    // --- どちらを呼ぶか。**OS の違いはここまで** (ハンドルは nint で持ち、macOS へは int に詰めて渡す) ---

    private static int Establish(out nint context)
    {
        if (OperatingSystem.IsWindows()) return Win.SCardEstablishContext(ScopeSystem, 0, 0, out context);
        var result = Mac.SCardEstablishContext(ScopeSystem, 0, 0, out var mac);
        context = mac;
        return result;
    }

    private static void Release(nint context)
    {
        if (OperatingSystem.IsWindows()) Win.SCardReleaseContext(context);
        else Mac.SCardReleaseContext((int)context);
    }

    private static int ListReaders(nint context, byte[]? readers, ref uint length) =>
        OperatingSystem.IsWindows()
            ? Win.SCardListReaders(context, 0, readers, ref length)
            : Mac.SCardListReaders((int)context, 0, readers, ref length);

    /// <summary>NUL 区切りで、最後に NUL が2つ。**Windows は長さを UTF-16 の文字で数える。** 読めなければ空</summary>
    private static List<string> List(nint context)
    {
        uint length = 0;
        if (ListReaders(context, null, ref length) != 0 || length == 0) return [];
        var encoding = OperatingSystem.IsWindows() ? Encoding.Unicode : Encoding.UTF8;
        var width = OperatingSystem.IsWindows() ? 2 : 1;
        var buffer = new byte[length * width];
        if (ListReaders(context, buffer, ref length) != 0) return [];
        return [.. encoding.GetString(buffer, 0, (int)length * width).Split('\0', StringSplitOptions.RemoveEmptyEntries)];
    }

    private static int Connect(nint context, string reader, out nint card)
    {
        if (OperatingSystem.IsWindows()) return Win.SCardConnect(context, reader, ShareExclusive, ProtocolT1, out card, out _);
        var result = Mac.SCardConnect((int)context, reader, ShareExclusive, ProtocolT1, out var mac, out _);
        card = mac;
        return result;
    }

    private static int Status(nint card, byte[] atr, ref uint atrLength)
    {
        uint namesLength = 0;
        return OperatingSystem.IsWindows()
            ? Win.SCardStatus(card, 0, ref namesLength, out _, out _, atr, ref atrLength)
            : Mac.SCardStatus((int)card, 0, ref namesLength, out _, out _, atr, ref atrLength);
    }

    private static int Send(nint card, ReadOnlySpan<byte> apdu, byte[] receive, ref uint length) =>
        OperatingSystem.IsWindows()
            ? Win.SCardTransmit(card, T1Pci, apdu, (uint)apdu.Length, 0, receive, ref length)
            : Mac.SCardTransmit((int)card, T1Pci, apdu, (uint)apdu.Length, 0, receive, ref length);

    private static void Disconnect(nint card)
    {
        if (OperatingSystem.IsWindows()) Win.SCardDisconnect(card, LeaveCard);
        else Mac.SCardDisconnect((int)card, LeaveCard);
    }

    private readonly nint _context;
    private nint _card;

    public string Name { get; }

    private PcscLink(string name, nint context)
    {
        Name = name;
        _context = context;
    }

    /// <summary>OS に見えているリーダー。**開かない** (カードに触らない)。PC/SC が答えなければ空</summary>
    public static IReadOnlyList<CardLinkCandidate> Find() =>
        [.. Readers().Select(name => new CardLinkCandidate(name, () => Open(name)))];

    /// <summary>
    /// リーダーの名前を並べる。リーダーが1つも無いと、macOS は PC/SC のサービスごと閉じていて
    /// <c>SCardEstablishContext</c> から断られる (<c>SCARD_E_NO_SERVICE</c>。Windows も Smart Card
    /// サービスが止まっていれば同じ)。それも空として扱う
    /// </summary>
    public static List<string> Readers()
    {
        if (!(OperatingSystem.IsMacOS() || OperatingSystem.IsWindows()) || Establish(out var context) != 0) return [];
        try
        {
            return List(context);
        }
        finally
        {
            Release(context);
        }
    }

    private static PcscLink Open(string name)
    {
        Check(Establish(out var context), name, "PC/SC に繋がりません");
        return new PcscLink(name, context);
    }

    public byte[] Reset()
    {
        /*
         * 繋ぐだけで電源が入る。**呼ばれるのは開いた直後の1回だけ** — BCas は失敗したら閉じて開き直す。
         *
         * macOS の標準の CCID ドライバ (Apple のもの) では B-CAS に繋がらないリーダーがある (IDBridge CT30 の報告)。
         * 怪しいのは速さ — B-CAS は specific mode で ATR の直後から TA1 の速さで話し、PC Twin の系統のリーダーは
         * それをドライバに設定してもらう必要がある (Ccid.cs の Reset と SetT1Parameters)。速さは PC/SC からは
         * 変えられない (SCardControl も Apple のドライバは受けない) ので、ここでは手を打たず、失敗したら
         * ドライバを切り替える案内を出す (Check。docs/install-mac.md「カードが読めないとき」)
         */
        Check(Connect(_context, Name, out _card), Name, "カードリーダーに接続できません");

        var atr = new byte[36];
        var atrLength = (uint)atr.Length;
        Check(Status(_card, atr, ref atrLength), Name, "ATR を読めません");
        return atr[..(int)atrLength];
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_card == 0) throw new IOException($"{Name}: カードに繋いでいません (Reset を先に)");
        var receive = new byte[258];
        var length = (uint)receive.Length;
        Check(Send(_card, apdu, receive, ref length), Name, "APDU を送れません");
        return receive[..(int)length];
    }

    public void Dispose()
    {
        if (_card != 0) Disconnect(_card);
        _card = 0;
        Release(_context);
    }

    /// <summary>
    /// 失敗なら投げる。**カードが挿さっていないだけなら <see cref="CardAbsentException"/>** (画面では「カードなし」)。
    /// macOS でカードと話せなかったときは、ドライバを切り替える案内を足す (docs/install-mac.md「カードが読めないとき」)
    /// </summary>
    private static void Check(int result, string name, string what)
    {
        if (result == 0) return;
        var code = unchecked((uint)result);
        var hint = OperatingSystem.IsMacOS() && code is not (NoSmartcard or RemovedCard or SharingViolation)
            ? "。macOS の標準の CCID ドライバで読めないリーダーがあります。docs/install-mac.md の「カードが読めないとき」を見てください"
            : "";
        var message = $"{name}: {what} (PC/SC 0x{result:x8}{Explain(result)}){hint}";
        throw code is NoSmartcard or RemovedCard ? new CardAbsentException(message) : new IOException(message);
    }

    private const uint SharingViolation = 0x8010000B;
    private const uint NoSmartcard = 0x8010000C;
    private const uint RemovedCard = 0x80100069;

    /// <summary>よく出るものだけ言葉にする (pcsc-lite の pcsclite.h と同じ番号。Windows の winerror.h も同じ)</summary>
    private static string Explain(int result) => unchecked((uint)result) switch
    {
        SharingViolation => ": 他のアプリが使用中です",
        NoSmartcard or RemovedCard => ": カードが挿さっていません",
        0x8010000F => ": カードと方式が合いません",
        0x80100013 => ": カードリーダーとの通信に失敗しました",
        0x8010001D => ": PC/SC が動いていません",
        0x8010002E => ": リーダーが見つかりません",
        0x80100066 => ": カードが応答しません",
        0x80100067 => ": カードに電源が入りません",
        _ => "",
    };

    /// <summary>診断用 (<c>denpa-agent --card</c>)。見えているリーダーと、macOS ならどちらの CCID ドライバか</summary>
    public static string Describe()
    {
        var readers = Readers();
        var list = readers.Count == 0
            ? "PC/SC のカードリーダーが見つかりません (USB のカードリーダーが挿さっていないか、OS が認識していません)"
            : string.Join('\n', readers.Select(name => $"PC/SC {name}"));
        return CcidDriver() is { } driver ? $"{list}\nCCID ドライバ: {DriverLabel(driver)}" : list;
    }

    /// <summary>
    /// macOS の CCID ドライバ。<c>"ifd-ccid"</c> (従来のもの) か <c>"apple"</c> (macOS の標準のもの)。macOS 以外は null。
    /// 呼ぶたびに `defaults` を1回起こす (上限 5 秒)。<c>--card</c> と <c>GET /denpa/about</c> (About.cs) が使う
    /// (docs/install-mac.md「カードが読めないとき」)
    /// </summary>
    public static string? CcidDriver()
    {
        if (!OperatingSystem.IsMacOS()) return null;
        var (code, output) = Shell.Run(
            "defaults", ["read", "/Library/Preferences/com.apple.security.smartcard", "useIFDCCID"], TimeSpan.FromSeconds(5));
        return CcidDriverFrom(code, output);
    }

    /// <summary>`defaults read … useIFDCCID` の結果から。1 なら従来の ifd-ccid、無い (読めない) か 0 なら Apple の標準のもの</summary>
    public static string CcidDriverFrom(int code, string output) =>
        code == 0 && output.Trim() == "1" ? "ifd-ccid" : "apple";

    private static string DriverLabel(string driver) =>
        driver == "ifd-ccid" ? "従来のもの (useIFDCCID)" : "macOS の標準のもの";
}
