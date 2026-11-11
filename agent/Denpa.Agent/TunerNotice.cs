namespace Denpa.Agent;

/// <summary>
/// 受信機ごとの注意書き (設定の <c>device</c> → 文)。選局は通るが設定どおりには動いていないこと
/// (LNB に給電せずに選局した、など。AsicenUdtv.cs) を、
/// チューナー画面に出す (<see cref="TunerPool.Status"/> の <c>error</c>)
/// </summary>
public static class TunerNotice
{
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (object Owner, string Text)> Notices =
        new(StringComparer.Ordinal);

    public static string? Get(string? device) =>
        device is not null && Notices.TryGetValue(device, out var notice) ? notice.Text : null;

    internal static void Set(string device, object owner, string text) => Notices[device] = (owner, text);

    /// <summary>
    /// <paramref name="owner"/> が出したものだけ消す。設定を変えて開き直すとき、古いチューナーの後始末が
    /// 新しいチューナーの出したものを消さないように (文は同じなので、出した者で見分ける)
    /// </summary>
    internal static void Clear(string device, object owner)
    {
        if (Notices.TryGetValue(device, out var notice) && ReferenceEquals(notice.Owner, owner))
        {
            Notices.TryRemove(new KeyValuePair<string, (object, string)>(device, notice));
        }
    }
}
