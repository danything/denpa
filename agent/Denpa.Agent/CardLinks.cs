namespace Denpa.Agent;

/// <summary>
/// カードリーダーを探して、B-CAS を開く。**USB のリーダーと内蔵リーダーを区別しない。**
/// </summary>
public static class CardLinks
{
    /// <summary>
    /// 見えているリーダー全部。**USB のリーダーが先。**
    ///
    /// <para>
    /// 内蔵リーダーは機材の向こうにあり、1 回ごとに USB を 1 往復する。
    /// 両方にカードが挿さっているなら、直接扱えるほうを使う。
    /// </para>
    ///
    /// <para>
    /// USB のリーダーは、Linux なら usbfs を直に (Ccid.cs)、macOS と Windows なら OS の PC/SC 越しに
    /// (Pcsc.cs)。どちらにするかは <see cref="IUsbHost.Readers"/> が null かで決める (**macOS と Windows には usbfs が無い**)。
    /// IT930x の機材 (PX-MLT5・PX-Q3・PX-W3 系など) の内蔵カードリーダーはそのすぐ後ろ (It930xCard.cs)。
    /// asicen-userland の機材の内蔵カードリーダーは扱わない (<see cref="AsicenUserland.Cards"/> は空。Asicen.cs)。
    /// CECH-ZD1 J の内蔵の差し込み口と PIX-DT295 の差し込み口はいちばん後ろ (Zd1j.cs・Dt295.cs)。どれもほかのチューナーの復号にも使う。
    /// **使わない設定にしたリーダーは入れない** (<see cref="CardChoice"/>)
    /// </para>
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Find() => Without(All(), CardChoice.Disabled);

    /// <summary>使わないリーダーを除く</summary>
    internal static IReadOnlyList<CardLinkCandidate> Without(IReadOnlyList<CardLinkCandidate> found, IReadOnlySet<string> disabled) =>
        disabled.Count == 0 ? found : [.. found.Where(candidate => !disabled.Contains(candidate.Name))];

    /// <summary>使わないものも含めて、見えているリーダー全部。**探すだけで何も開かない**</summary>
    public static IReadOnlyList<CardLinkCandidate> All() =>
        [.. Ccid.Find() ?? PcscLink.Find(), .. It930x.Cards(), .. AsicenUserland.Cards(), .. Zd1j.Cards(), .. Dt295.Cards()];

    /// <summary>
    /// カードが挿さっていて INT に応答した最初のリーダーで B-CAS を開く。どれも駄目なら例外を投げる。
    /// 繋ぎ直すときも <see cref="Find"/> から探し直す (<see cref="BCas.Open"/>)
    /// </summary>
    public static BCas Open() => BCas.Open(Find);
}
