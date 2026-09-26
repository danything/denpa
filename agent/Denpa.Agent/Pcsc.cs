using System.Runtime.InteropServices;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// macOS の USB カードリーダー。**OS に最初から入っている PCSC.framework 越しに叩く。**
///
/// <para>
/// Linux では usbfs を直に叩いている (Ccid.cs) が、macOS には usbfs が無く、CCID の
/// リーダーは OS (CryptoTokenKit の ifd-ccid) が先に掴む。横取りするより、OS が
/// 出している PC/SC の口を借りるほうが素直で、入れてもらうものも増えない。
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
/// **排他で掴む** (<c>SCARD_SHARE_EXCLUSIVE</c>)。Linux の usbfs でもインターフェースを
/// 独り占めしている。共有にすると、macOS がカードを覗きに来る (CryptoTokenKit が
/// 挿したカードに APDU を投げる) ときに INT と ECM の間へ割り込まれうる。掴めなければ
/// 理由 (共有違反) を返し、BCas が少し置いて探し直す。
/// </para>
/// </summary>
public sealed partial class PcscLink : ICardLink
{
    private const string Framework = "/System/Library/Frameworks/PCSC.framework/PCSC";

    private const uint ScopeSystem = 2;
    private const uint ShareExclusive = 1;
    private const uint ProtocolT1 = 2;
    private const uint LeaveCard = 0;
    private const uint ResetCard = 1;

    /// <summary><c>SCARD_IO_REQUEST</c> (dwProtocol, cbPciLength)。<c>g_rgSCardT1Pci</c> と同じ中身</summary>
    private static readonly uint[] T1Pci = [ProtocolT1, 8];

    [LibraryImport(Framework)]
    private static partial int SCardEstablishContext(uint scope, nint reserved1, nint reserved2, out int context);

    [LibraryImport(Framework)]
    private static partial int SCardReleaseContext(int context);

    [LibraryImport(Framework)]
    private static partial int SCardListReaders(int context, nint groups, [Out] byte[]? readers, ref uint length);

    [LibraryImport(Framework, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int SCardConnect(int context, string reader, uint share, uint protocols, out int card, out uint active);

    [LibraryImport(Framework)]
    private static partial int SCardReconnect(int card, uint share, uint protocols, uint initialization, out uint active);

    [LibraryImport(Framework)]
    private static partial int SCardStatus(
        int card, nint names, ref uint namesLength, out uint state, out uint protocol, [Out] byte[] atr, ref uint atrLength);

    [LibraryImport(Framework)]
    private static partial int SCardTransmit(
        int card, uint[] sendPci, ReadOnlySpan<byte> send, uint sendLength, nint receivePci, [Out] byte[] receive, ref uint receiveLength);

    [LibraryImport(Framework)]
    private static partial int SCardDisconnect(int card, uint disposition);

    private readonly int _context;
    private int _card;

    public string Name { get; }

    private PcscLink(string name, int context)
    {
        Name = name;
        _context = context;
    }

    /// <summary>OS に見えているリーダー。**開かない** (カードに触らない)。PC/SC が答えなければ空</summary>
    public static IReadOnlyList<CardLinkCandidate> Find() =>
        [.. Readers().Select(name => new CardLinkCandidate(name, () => Open(name)))];

    /// <summary>
    /// リーダーの名前を並べる。リーダーが1つも無いと、macOS は PC/SC の口ごと閉じていて
    /// <c>SCardEstablishContext</c> から断られる (<c>SCARD_E_NO_SERVICE</c>)。それも空として扱う
    /// </summary>
    public static List<string> Readers()
    {
        if (!OperatingSystem.IsMacOS() || SCardEstablishContext(ScopeSystem, 0, 0, out var context) != 0) return [];
        try
        {
            uint length = 0;
            if (SCardListReaders(context, 0, null, ref length) != 0 || length == 0) return [];
            var buffer = new byte[length];
            if (SCardListReaders(context, 0, buffer, ref length) != 0) return [];
            // NUL 区切りで、最後に NUL が2つ
            return [.. Encoding.UTF8.GetString(buffer, 0, (int)length).Split('\0', StringSplitOptions.RemoveEmptyEntries)];
        }
        finally
        {
            SCardReleaseContext(context);
        }
    }

    private static PcscLink Open(string name)
    {
        Check(SCardEstablishContext(ScopeSystem, 0, 0, out var context), name, "PC/SC に繋がりません");
        return new PcscLink(name, context);
    }

    public byte[] Reset()
    {
        // 初めは繋ぐだけで電源が入る。2回目からは起こし直す (BCas が繋ぎ直すとき)
        if (_card == 0) Check(SCardConnect(_context, Name, ShareExclusive, ProtocolT1, out _card, out _), Name, "リーダーを掴めません");
        else Check(SCardReconnect(_card, ShareExclusive, ProtocolT1, ResetCard, out _), Name, "カードを起こし直せません");

        var atr = new byte[36];
        uint atrLength = (uint)atr.Length, namesLength = 0;
        Check(SCardStatus(_card, 0, ref namesLength, out _, out _, atr, ref atrLength), Name, "ATR を読めません");
        return atr[..(int)atrLength];
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_card == 0) throw new IOException($"{Name}: カードに繋いでいません (Reset を先に)");
        var receive = new byte[258];
        var length = (uint)receive.Length;
        Check(SCardTransmit(_card, T1Pci, apdu, (uint)apdu.Length, 0, receive, ref length), Name, "APDU を送れません");
        return receive[..(int)length];
    }

    public void Dispose()
    {
        if (_card != 0) SCardDisconnect(_card, LeaveCard);
        _card = 0;
        SCardReleaseContext(_context);
    }

    private static void Check(int result, string name, string what)
    {
        if (result == 0) return;
        throw new IOException($"{name}: {what} (PC/SC 0x{result:x8}{Explain(result)})");
    }

    /// <summary>よく出るものだけ言葉にする (pcsc-lite の pcsclite.h と同じ番号)</summary>
    private static string Explain(int result) => unchecked((uint)result) switch
    {
        0x8010000B => ": 他のアプリが掴んでいます",
        0x8010000C or 0x80100069 => ": カードが刺さっていません",
        0x8010001D => ": PC/SC が動いていません",
        0x8010002E => ": リーダーが見つかりません",
        0x80100066 => ": カードが答えません",
        _ => "",
    };

    /// <summary>診断用 (<c>denpa-agent --card</c>)。見えているリーダーを並べる</summary>
    public static string Describe()
    {
        var readers = Readers();
        return readers.Count == 0
            ? "PC/SC のカードリーダーが見つかりません (USB のリーダーが刺さっていないか、macOS が認識していません)"
            : string.Join('\n', readers.Select(name => $"PC/SC {name}"));
    }
}
