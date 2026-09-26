namespace Denpa.Agent;

/// <summary>
/// カードリーダーを探して、B-CAS を開く。**USB のリーダーと px4d の内蔵リーダーを区別しない。**
/// </summary>
public static class CardLinks
{
    /// <summary>
    /// 見えているリーダー全部。**USB のリーダーが先。**
    ///
    /// <para>
    /// 内蔵リーダーは px4d の向こうにあり、1回ごとにソケットを1往復する。
    /// 両方にカードが刺さっているなら、直に叩けるほうを使う。
    /// </para>
    ///
    /// <para>
    /// USB のリーダーは、Linux なら usbfs を直に (Ccid.cs)、macOS と Windows なら OS の PC/SC 越しに
    /// (Pcsc.cs)。**macOS と Windows には usbfs が無い。** Windows には px4-userland も無い
    /// </para>
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Find() =>
        OperatingSystem.IsWindows() ? PcscLink.Find()
        : [.. OperatingSystem.IsLinux() ? Ccid.Find() : PcscLink.Find(), .. Px4Card.Find()];

    /// <summary>
    /// カードが刺さっていて INT に答えた最初のリーダーで B-CAS を開く。どれも駄目なら投げる。
    /// 繋ぎ直すときも <see cref="Find"/> から探し直す (<see cref="BCas.Open"/>)
    /// </summary>
    public static BCas Open() => BCas.Open(Find);
}
