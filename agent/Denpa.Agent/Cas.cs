namespace Denpa.Agent;

/*
 * B-CAS まわりの境目。**libaribb25 も pcscd も使わない。**
 *
 * 3段に分けてある。上から:
 *
 * - Descrambler … TS を読んで ECM を拾い、鍵を貰って MULTI2 で解く (B25.cs / Multi2.cs)
 * - IKeySource  … ECM を渡すと鍵を返す相手。手元のカード (BCas.cs) か、別の拠点 (CardShare.cs)
 * - ICardLink   … カードと APDU をやり取りする線。USB の CCID リーダーを直に叩く (Ccid.cs) か、
 *                 px4d の内蔵リーダー (Px4Card.cs)
 */

/// <summary>カードの素。**鍵を作るのに要る定数**で、初めに1回だけ貰う</summary>
/// <param name="SystemKey">32 バイト</param>
/// <param name="InitCbc">8 バイト</param>
/// <param name="Ids">カードの番号 (表示用。10進16桁で見せる)</param>
public sealed record CardInit(byte[] SystemKey, byte[] InitCbc, int CaSystemId, long[] Ids);

/// <summary>ECM の答え。鍵は奇数・偶数の順に 8 バイトずつ</summary>
/// <param name="Code">カードの返り値 (0x0200 など。契約の有無が分かる)</param>
public readonly record struct EcmAnswer(byte[] Odd, byte[] Even, int Code);

/// <summary>
/// ECM を渡すと鍵を返す相手。**何本の流れから同時に呼ばれてもよい**こと
/// (順番に通すのは実装の側)。
///
/// <para>
/// 失敗は投げる (<see cref="IOException"/>)。繋ぎ直せるものは中で繋ぎ直してから
/// 投げる — カードを抜き差ししたり px4d を起こし直したりしても、次の ECM では
/// 読めているのが正しい。
/// </para>
/// </summary>
public interface IKeySource
{
    CardInit Init();
    EcmAnswer Ecm(ReadOnlySpan<byte> ecm);
}

/// <summary>見つかったカードリーダー。開くまでは何も掴まない</summary>
public sealed record CardLinkCandidate(string Name, Func<ICardLink> Open);

/// <summary>
/// カードとの線。**APDU の単位**でやり取りする (T=1 の枠組みは線の側が持つ)。
/// 1本の線を同時に2つから叩かない (呼ぶ側が順番にする)。
/// </summary>
public interface ICardLink : IDisposable
{
    /// <summary>画面やログに出す名前 (「Gemalto PC Twin Reader (usb 4-11)」など)</summary>
    string Name { get; }

    /// <summary>電源を入れて ATR を返す。カードが無ければ投げる</summary>
    byte[] Reset();

    /// <summary>APDU を1つ送り、SW1 SW2 まで含んだ応答を返す</summary>
    byte[] Transmit(ReadOnlySpan<byte> apdu);
}
