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
    /// CECH-ZD1 J の内蔵の差し込み口と PIX-DT295 の差し込み口と IT930x の機材 (PX-MLT5U など) の内蔵カードリーダーはいちばん後ろ
    /// (Zd1j.cs・Dt295.cs・It930xCard.cs。ほかのチューナーの復号にも使う。IT930x の機材は設定の it930x: でエージェントが持つものだけ)。
    /// **使わない設定にしたリーダーは入れない** (<see cref="CardChoice"/>)
    /// </para>
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Find() => Without(All(), CardChoice.Disabled);

    /// <summary>使わないリーダーを除く</summary>
    internal static IReadOnlyList<CardLinkCandidate> Without(IReadOnlyList<CardLinkCandidate> found, IReadOnlySet<string> disabled) =>
        disabled.Count == 0 ? found : [.. found.Where(candidate => !disabled.Contains(candidate.Name))];

    /// <summary>使わないものも含めて、見えているリーダー全部。**探すだけで何も開かない**</summary>
    public static IReadOnlyList<CardLinkCandidate> All() =>
        OperatingSystem.IsWindows() ? [.. PcscLink.Find(), .. Px4Card.Find(), .. Zd1j.Cards(), .. Dt295.Cards(), .. It930x.Cards()]
        : [.. OperatingSystem.IsLinux() ? Ccid.Find() : PcscLink.Find(), .. Px4Card.Find(), .. AsicenUserland.Cards(), .. Zd1j.Cards(), .. Dt295.Cards(), .. It930x.Cards()];

    /// <summary>
    /// カードが挿さっていて INT に応答した最初のリーダーで B-CAS を開く。どれも駄目なら例外を投げる。
    /// 繋ぎ直すときも <see cref="Find"/> から探し直す (<see cref="BCas.Open"/>)
    /// </summary>
    public static BCas Open() => BCas.Open(Find);
}
