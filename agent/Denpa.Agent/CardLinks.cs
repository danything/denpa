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
    /// 内蔵リーダーは px4d の向こうにあり、1 回ごとにソケットを 1 往復する。
    /// 両方にカードが挿さっているなら、直接扱えるほうを使う。
    /// </para>
    ///
    /// <para>
    /// USB のリーダーは、Linux なら usbfs を直に (Ccid.cs)、macOS と Windows なら OS の PC/SC 越しに
    /// (Pcsc.cs)。**macOS と Windows には usbfs が無い。** px4d の内蔵リーダーとは Windows でも同じ IPC (AF_UNIX) で通信する。
    /// asicen-userland の asicend も内蔵カードを px4d と同じ IPC で出す (Asicen.cs。Windows 用は無い)。
    /// PX-MLT5 系 (IT930x の機材) の内蔵カードリーダーは px4d のすぐ後ろ (It930xCard.cs。px4d が持っていた頃と同じ順で選ぶ)。
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
        OperatingSystem.IsWindows() ? [.. PcscLink.Find(), .. Px4Card.Find(), .. It930x.Cards(), .. Zd1j.Cards(), .. Dt295.Cards()]
        : [.. OperatingSystem.IsLinux() ? Ccid.Find() : PcscLink.Find(), .. Px4Card.Find(), .. It930x.Cards(), .. AsicenUserland.Cards(), .. Zd1j.Cards(), .. Dt295.Cards()];

    /// <summary>
    /// カードが挿さっていて INT に応答した最初のリーダーで B-CAS を開く。どれも駄目なら例外を投げる。
    /// 繋ぎ直すときも <see cref="Find"/> から探し直す (<see cref="BCas.Open"/>)
    /// </summary>
    public static BCas Open() => BCas.Open(Find);
}
