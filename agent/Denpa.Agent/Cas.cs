namespace Denpa.Agent;

/*
 * B-CAS まわりの境目。**libaribb25 も pcscd も使わない。**
 *
 * 上から順に 3 段に分けてある。
 *
 * - Descrambler … TS を読んで ECM を取り出し、鍵を受け取って MULTI2 で復号する (B25.cs / Multi2.cs)。
 *                 選局のときは CAT から EMM も取り出し、自分宛てだけを渡し先に渡す (Emm.cs)
 * - IKeySource  … ECM を渡すと鍵を返す相手。手元のカード (LocalCard → BCas.cs) か、別の拠点 (RemoteCard)。どちらも CardShare.cs
 * - ICardLink   … カードと APDU をやり取りする接続。USB の CCID リーダーを直接扱う (Ccid.cs。
 *                 macOS / Windows は OS の PC/SC 越し、Pcsc.cs) か、asicend の内蔵リーダー (UserlandCard.cs) か、IT930x の機材の内蔵リーダー (It930xCard.cs) か、
 *                 CECH-ZD1 J と PIX-DT295 の差し込み口 (Zd1j.cs の Zd1jCard・Dt295NativeCard.cs の Dt295NativeCard) か、
 *                 IT930x の機材の内蔵リーダー (It930xCard.cs)
 */

/// <summary>カードの定数。**鍵を作るのに要る定数**で、初めに 1 回だけ受け取る</summary>
/// <param name="SystemKey">32 バイト</param>
/// <param name="InitCbc">8 バイト</param>
/// <param name="Ids">カードの番号 (個別とグループ)。画面には 10 進 16 桁で表示し、EMM が自分宛てかもこれと比べる (<see cref="Emm"/>)</param>
public sealed record CardInit(byte[] SystemKey, byte[] InitCbc, int CaSystemId, long[] Ids);

/// <summary>ECM の応答。鍵は奇数・偶数の順に 8 バイトずつ</summary>
/// <param name="Code">カードの返り値 (0x0200 など。契約の有無を示す)</param>
/// <param name="Cached">
/// カードに問い合わせず、キャッシュした応答を返した (同じ ECM で別のストリームが先に問い合わせていた)。
/// 選局の内訳の記録に出すだけで、鍵の扱いは変わらない。拠点のあいだでは運ばない (<see cref="CardWire"/>)
/// </param>
/// <param name="WaitedMs">カードを順番に使うロック (<see cref="BCas"/>) を待った時間 (ミリ秒)。記録に出すだけ</param>
public readonly record struct EcmAnswer(byte[] Odd, byte[] Even, int Code, bool Cached = false, long WaitedMs = 0);

/// <summary>
/// ECM を渡すと鍵を返す相手。**何本のストリームから同時に呼ばれてもよい**こと
/// (順番に通すのは実装の側)。
///
/// <para>
/// 失敗は投げる (<see cref="IOException"/>)。カードを抜き差ししたり asicend を起動し直したりしても
/// 次の ECM では読めているように、繋ぎ直せるものは中で繋ぎ直してから投げる。
/// </para>
/// </summary>
public interface IKeySource
{
    CardInit Init();
    EcmAnswer Ecm(ReadOnlySpan<byte> ecm);
    int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd);

    /// <summary>
    /// 契約の更新 (EMM 受信、<c>90 36</c>)。渡すのは EMM セクションの中のペイロード 1 つ (カード ID から MAC まで)。
    /// 返すのはカードの返り値 (<c>0x2100</c> が正常終了)。カードと通信できなければ投げる (<see cref="Emm"/>)
    /// </summary>
    int Emm(ReadOnlySpan<byte> payload);
}

/// <summary>
/// リーダーにカードが挿さっていない。**壊れているのではない**ので、画面では
/// 「エラー」ではなく「カードなし」と出す (<see cref="Card.Status"/>)
/// </summary>
public sealed class CardAbsentException(string message) : IOException(message);

/// <summary>
/// どのリーダーでもカードを読めなかった。**リーダーごとの理由を持つ。** 画面の表は
/// これをそのまま行にする (文を切り分けて読み直さない)
/// </summary>
public sealed class CardsUnreadableException(IReadOnlyList<CardsUnreadableException.Reader> readers)
    : IOException($"どのカードリーダーでもカードを読めません ({string.Join(" / ", readers.Select(reader => $"{reader.Name}: {reader.Reason}"))})")
{
    /// <param name="Absent">挿さっていないだけ</param>
    public sealed record Reader(string Name, string Reason, bool Absent);

    public IReadOnlyList<Reader> Readers { get; } = readers;
}

/// <summary>見つかったカードリーダー。開くまでは何も使わない</summary>
/// <param name="Device">チューナーの差し込み口なら、そのチューナーのデバイス (<c>dt295:3-5</c>)。使わない設定にしたとき、チューナーも使っていなければ USB を閉じる</param>
public sealed record CardLinkCandidate(string Name, Func<ICardLink> Open, string? Device = null);

/// <summary>
/// カードとの接続。**APDU の単位**でやり取りする (T=1 の枠組みは接続の側が持つ)。
/// 1 本の接続を同時に 2 つから使わない (呼ぶ側が順番にする)。
/// </summary>
public interface ICardLink : IDisposable
{
    /// <summary>画面やログに出す名前 (「Gemalto PC Twin Reader (usb 4-11)」など)</summary>
    string Name { get; }

    /// <summary>電源を入れて ATR を返す。カードが無ければ投げる</summary>
    byte[] Reset();

    /// <summary>APDU を 1 つ送り、SW1 SW2 まで含んだ応答を返す</summary>
    byte[] Transmit(ReadOnlySpan<byte> apdu);
}
