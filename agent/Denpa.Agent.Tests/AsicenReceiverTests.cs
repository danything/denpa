namespace Denpa.Agent.Tests;

/*
 * ライブラリに問い合わせた受信機 (Asicen.cs の AsicenReceiver)。受信機と選局が合っているかの確認、注意書き。
 * ライブラリとのやり取りは AsicenNativeTests で確かめる。
 */
public class AsicenReceiverTests
{
    /// <summary>受信機 0・1 が衛星、2・3 が地上波の筐体</summary>
    private static readonly List<AsicenReceiver> Split =
        [new(0, false, true), new(1, false, true), new(2, true, false), new(3, true, false)];

    /// <summary>どの受信機も地上波と衛星の両方を受けられる筐体</summary>
    private static readonly List<AsicenReceiver> Both = [.. Enumerable.Range(0, 5).Select(index => new AsicenReceiver(index, true, true))];

    [Test]
    public async Task 受信機の種別と違う方式は選局しない()
    {
        var error = Assert.Throws<IOException>(() => AsicenReceiver.Check(Split, 2, ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).Contains("GR 用");
        AsicenReceiver.Check(Split, 0, ChannelTable.Parse("BS15:16625")!);

        // どの受信機も両方受けられる筐体
        AsicenReceiver.Check(Both, 4, ChannelTable.Parse("BS15:16625")!);
        AsicenReceiver.Check(Both, 4, ChannelTable.Parse("T27")!);
    }

    [Test]
    public async Task 無い受信機は選局しない()
    {
        var error = Assert.Throws<IOException>(() => AsicenReceiver.Check(Both, 5, ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).Contains("受信機 5 はありません");
    }

    [Test]
    public async Task 注意書きは出したチューナーだけが消す()
    {
        // 設定を変えて開き直すとき、古いチューナーの後始末 (Dispose) が新しいチューナーの出した注意書きを消さない
        const string device = "asicen:9-9:0";
        object old = new(), fresh = new();
        TunerNotice.Set(device, fresh, "0V で選局しています");
        TunerNotice.Clear(device, old);
        await Assert.That(TunerNotice.Get(device)).IsEqualTo("0V で選局しています");
        TunerNotice.Clear(device, fresh);
        await Assert.That(TunerNotice.Get(device)).IsNull();
    }
}
