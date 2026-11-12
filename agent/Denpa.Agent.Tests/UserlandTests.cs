using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * 同梱の常駐を使う機材に共通する部分 (Userland.cs)。受信機と選局が合っているかの確認、key=value の行、注意書き。
 * 制御ソケットのやり取りは AsicenTests で確かめる。
 */
public class UserlandTests
{
    /// <summary>受信機 0・1 が衛星、2・3 が地上波の筐体</summary>
    private static readonly List<UserlandReceiver> Split =
        [new(0, false, true), new(1, false, true), new(2, true, false), new(3, true, false)];

    /// <summary>どの受信機も地上波と衛星の両方を受けられる筐体</summary>
    private static readonly List<UserlandReceiver> Both = [.. Enumerable.Range(0, 5).Select(index => new UserlandReceiver(index, true, true))];

    /// <summary>同じキーが 2 度ある行は最初の値を採る (<see cref="UserlandReceiver.Fields"/>)。例外にしない</summary>
    [Test]
    public async Task 同じキーが_2_度あれば最初の値()
    {
        var fields = UserlandReceiver.Fields("receiver=3 device=1 system=ISDB-T system=ISDB-S\r");
        await Assert.That(fields["receiver"]).IsEqualTo("3");
        await Assert.That(fields["system"]).IsEqualTo("ISDB-T");
    }

    [Test]
    public async Task 受信機の種別と違う方式は選局しない()
    {
        var error = Assert.Throws<IOException>(() => UserlandReceiver.Check(Split, 2, ChannelTable.Parse("BS15:16625")!));
        await Assert.That(error.Message).Contains("GR 用");
        UserlandReceiver.Check(Split, 0, ChannelTable.Parse("BS15:16625")!);

        // どの受信機も両方受けられる筐体
        UserlandReceiver.Check(Both, 4, ChannelTable.Parse("BS15:16625")!);
        UserlandReceiver.Check(Both, 4, ChannelTable.Parse("T27")!);
    }

    [Test]
    public async Task 無い受信機は選局しない()
    {
        var error = Assert.Throws<IOException>(() => UserlandReceiver.Check(Both, 5, ChannelTable.Parse("T27")!));
        await Assert.That(error.Message).Contains("受信機 5 はありません");
    }

    [Test]
    public async Task 受信機を問い合わせられていなければ_常駐に任せる()
    {
        UserlandReceiver.Check(null, 7, ChannelTable.Parse("BS15:16625")!);
        await Task.CompletedTask;
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

/*
 * asicend は使う受信機がある間だけ動かす (UserlandDaemon.Prepare)。受信機を全部使わない設定にした筐体は止めて
 * USB を手放し、使う設定に戻したら起動し直す。
 * 常駐の代わりに sleep を起動する (止めるのは SIGTERM)
 */
[ExcludeOn(OS.Windows)]
public class UserlandDaemonTests
{
    private sealed class SleepDaemon(string id, string dir) : UserlandDaemon("sleep", id)
    {
        public static SleepDaemon For(string id, string dir) => For(id, () => new SleepDaemon(id, dir));

        public override void Ensure()
        {
            if (Running) return;
            Launch("sleep", _ => ["60"], dir, () => true, () => { }, null, null);
        }
    }

    [Test]
    public async Task 使う受信機が無くなった筐体は止め_戻したら起動し直す()
    {
        await Task.Yield();
        var dir = Directory.CreateTempSubdirectory("daemon").FullName;
        var tag = Guid.NewGuid().ToString("N");
        var a = SleepDaemon.For($"{tag}a", dir);
        var b = SleepDaemon.For($"{tag}b", dir);
        SleepDaemon Daemon(string id) => SleepDaemon.For(id, dir);
        string[] both = [$"{tag}a", $"{tag}b"];
        try
        {
            UserlandDaemon.Prepare(both, Daemon);
            await Assert.That(a.Running && b.Running).IsTrue();

            // b の受信機を全部使わない設定にした
            UserlandDaemon.Prepare([$"{tag}a"], Daemon);
            await Assert.That(a.Running).IsTrue();
            await Assert.That(b.Running).IsFalse();

            // a も使わない設定にした
            UserlandDaemon.Prepare([], Daemon);
            await Assert.That(a.Running).IsFalse();

            // 使う設定に戻した
            UserlandDaemon.Prepare(both, Daemon);
            await Assert.That(a.Running && b.Running).IsTrue();
        }
        finally
        {
            a.Stop();
            b.Stop();
            Directory.Delete(dir, recursive: true);
        }
    }
}
