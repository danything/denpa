using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * asicend に問い合わせた受信機 (Asicen.cs の AsicenReceiver)。受信機と選局が合っているかの確認、key=value の行、注意書き。
 * 制御ソケットのやり取りは AsicenTests で確かめる。
 */
public class AsicenReceiverTests
{
    /// <summary>受信機 0・1 が衛星、2・3 が地上波の筐体</summary>
    private static readonly List<AsicenReceiver> Split =
        [new(0, false, true), new(1, false, true), new(2, true, false), new(3, true, false)];

    /// <summary>どの受信機も地上波と衛星の両方を受けられる筐体</summary>
    private static readonly List<AsicenReceiver> Both = [.. Enumerable.Range(0, 5).Select(index => new AsicenReceiver(index, true, true))];

    /// <summary>同じキーが 2 度ある行は最初の値を採る (<see cref="AsicenUserland.Fields"/>)。例外にしない</summary>
    [Test]
    public async Task 同じキーが_2_度あれば最初の値()
    {
        var fields = AsicenUserland.Fields("receiver=3 device=1 system=ISDB-T system=ISDB-S\r");
        await Assert.That(fields["receiver"]).IsEqualTo("3");
        await Assert.That(fields["system"]).IsEqualTo("ISDB-T");
    }

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
    public async Task 受信機を問い合わせられていなければ_asicend_に任せる()
    {
        AsicenReceiver.Check(null, 7, ChannelTable.Parse("BS15:16625")!);
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
 * asicend は使う受信機がある間だけ動かす (AsicenDaemon.Prepare)。受信機を全部使わない設定にした筐体は止めて
 * USB を手放し、使う設定に戻したら起動し直す。
 * asicend の代わりに sleep に替わるスクリプトを、asicenctl の代わりにいつも通るスクリプトを置く (止めるのは SIGTERM)
 */
[ExcludeOn(OS.Windows)]
[System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
public class AsicenDaemonTests
{
    [Test]
    public async Task 使う受信機が無くなった筐体は止め_戻したら起動し直す()
    {
        await Task.Yield();
        // 制御ソケットのパスは短く (108 バイトまで。macOS の一時フォルダは長い)
        var tag = Guid.NewGuid().ToString("N")[..6];
        var dir = Directory.CreateDirectory(Path.Combine("/tmp", $"denpa-{tag}")).FullName;
        foreach (var (name, body) in new[] { ("asicend", "exec sleep 60"), ("asicenctl", "exit 0") })
        {
            var path = Path.Combine(dir, name);
            File.WriteAllText(path, $"#!/bin/sh\n{body}\n");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        var runtime = Path.Combine(dir, "r");
        AsicenDaemon Daemon(string id) => AsicenDaemon.For(id, () => new AsicenDaemon(id, dir, runtime, () => new([])));
        var a = Daemon($"{tag}a");
        var b = Daemon($"{tag}b");
        string[] both = [$"{tag}a", $"{tag}b"];
        try
        {
            AsicenDaemon.Prepare(both, Daemon);
            await Assert.That(a.Running && b.Running).IsTrue();

            // b の受信機を全部使わない設定にした
            AsicenDaemon.Prepare([$"{tag}a"], Daemon);
            await Assert.That(a.Running).IsTrue();
            await Assert.That(b.Running).IsFalse();

            // a も使わない設定にした
            AsicenDaemon.Prepare([], Daemon);
            await Assert.That(a.Running).IsFalse();

            // 使う設定に戻した
            AsicenDaemon.Prepare(both, Daemon);
            await Assert.That(a.Running && b.Running).IsTrue();
        }
        finally
        {
            a.Stop();
            b.Stop();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Test]
    public async Task 同時に起動を待った選局は_先に起動した_asicend_の受信機を消さない()
    {
        await Task.Yield();
        var tag = Guid.NewGuid().ToString("N")[..6];
        var dir = Directory.CreateDirectory(Path.Combine("/tmp", $"denpa-{tag}")).FullName;
        var list = "printf 'model=PX-W3U3\\nreceiver=0 device=1 local=0 system=ISDB-S\\n'";
        foreach (var (name, body) in new[] { ("asicend", "exec sleep 60"), ("asicenctl", list) })
        {
            var path = Path.Combine(dir, name);
            File.WriteAllText(path, $"#!/bin/sh\n{body}\n");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        // 1 回目の select (遅れた選局) は、もう 1 つの選局が起動し終えるまで止める。
        // 遅れた選局は、動いていないのを見て機材を並べている間に、先を越された形になる
        using var started = new ManualResetEventSlim();
        var calls = 0;
        var daemon = new AsicenDaemon($"{tag}c", dir, Path.Combine(dir, "r"), () =>
        {
            if (Interlocked.Increment(ref calls) == 1) started.Wait(TimeSpan.FromSeconds(30));
            return new([]);
        });
        try
        {
            var late = Task.Run(daemon.Ensure);
            while (Volatile.Read(ref calls) == 0) Thread.Yield();
            await Task.Run(daemon.Ensure);
            await Assert.That(daemon.Listed?.Model).IsEqualTo("PX-W3U3");
            started.Set();
            await late;
            await Assert.That(daemon.Running).IsTrue();
            await Assert.That(daemon.Listed?.Model).IsEqualTo("PX-W3U3");
        }
        finally
        {
            daemon.Stop();
            Directory.Delete(dir, recursive: true);
        }
    }
}
