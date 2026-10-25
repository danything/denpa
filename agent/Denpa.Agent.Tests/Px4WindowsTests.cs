using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * px4-userland を Windows でも使うところ (Px4.cs)。
 *
 * 大半は OS を見ない部分 (ランタイムルートの決まり・px4d が使っている筐体の扱い・終了コードの手当て) で、
 * どこでも流す。Windows でしか意味の無いもの (実際のフォルダの ACL・標準入力で止める) は Windows だけ。
 * 本物の px4d.exe は install.ps1 の通し (CI の agent-windows-install) で引数を受けるところまで見る
 */
[NotInParallel]
[Timeout(120_000)]
public class Px4WindowsTests
{
    private const string Me = "S-1-5-21-1-2-3-1001";
    private const uint FullControl = 0x1F01FF;
    private const uint ReadExecute = 0x1200A9;

    [Test]
    public async Task ランタイムルートは本人のもので_本人とSYSTEMとAdministratorsしか書けない()
    {
        // install.ps1 が作る形 (保護された DACL。本人・SYSTEM・Administrators にフル)
        await Assert.That(Px4Userland.AclProblem(Me, Me,
            [(Me, true, FullControl), ("S-1-5-18", true, FullControl), ("S-1-5-32-544", true, FullControl)])).IsNull();
        // LOCALAPPDATA を引き継いだ形 (CREATOR OWNER も信頼できる)
        await Assert.That(Px4Userland.AclProblem(Me, Me, [(Me, true, FullControl), ("S-1-3-0", true, 0x10000000)])).IsNull();
        // ほかの人も読めるだけならよい
        await Assert.That(Px4Userland.AclProblem(Me, Me, [(Me, true, FullControl), ("S-1-5-11", true, ReadExecute)])).IsNull();
    }

    [Test]
    public async Task ランタイムルートが決まりに合わなければ理由を言う()
    {
        // 持ち主が Administrators (管理者として作った)
        await Assert.That(Px4Userland.AclProblem(Me, "S-1-5-32-544", [(Me, true, FullControl)])).Contains("持ち主");
        // C:\ の直下に普通に作ると Authenticated Users が書ける (変更)
        await Assert.That(Px4Userland.AclProblem(Me, Me, [(Me, true, FullControl), ("S-1-5-11", true, 0x1301BF)]))
            .Contains("S-1-5-11");
        await Assert.That(Px4Userland.AclProblem(Me, Me, [(Me, true, FullControl), ("S-1-1-0", false, FullControl)]))
            .Contains("拒否");
        await Assert.That(Px4Userland.AclProblem(Me, Me, [(Me, true, ReadExecute)])).Contains("本人が書けません");
    }

    [Test]
    public async Task ソケットのパスが長すぎれば起こす前に言う()
    {
        var shortRoot = OperatingSystem.IsWindows() ? @"C:\denpa-run" : "/run/px4-userland";
        if (!OperatingSystem.IsWindows())
        {
            await Assert.That(Px4Userland.RuntimeProblem(shortRoot, "00001205000960")).IsNull();
        }
        // 日本語のユーザー名は1文字3バイト。ユーザーのフォルダの下だとすぐ溢れる
        var longRoot = Path.Combine(OperatingSystem.IsWindows() ? @"C:\Users" : "/home",
            "とても長い日本語のユーザー名です", "AppData", "Local", "denpa-agent", "run");
        await Assert.That(Px4Userland.RuntimeProblem(longRoot, "000000000000001_5-1.4.1")).Contains("長すぎます");
    }

    /// <summary>Windows の一覧は、px4d が使っている筐体を open_failed で出す (px4-userland の実機記録)</summary>
    private const string ClaimedList = """
        {"enclosures":[],"ungrouped_usb_devices":[{"model":"PX-Q3U4","usb":"0511:084a","status":"open_failed","bus":5,"address":7,"port":"5-1.2.1"},{"model":"PX-Q3U4","usb":"0511:084a","status":"open_failed","bus":5,"address":8,"port":"5-1.2.2"}]}
        """;

    [Test]
    public async Task px4dが使っている筐体は一覧に出なくても顔ぶれに残り_理由も残さない()
    {
        var owned = new Px4Userland.Enclosure("00001205000960", "PX-Q3U4", [new Px4Receiver(0, false, true, true)])
        {
            Places = ["5-1.2.1", "5-1.2.2"],
        };
        var warned = new List<string>();
        var found = Px4Userland.ParseJson(ClaimedList, warned.Add, [owned]);
        await Assert.That(found.Select(enclosure => enclosure.Id)).IsEquivalentTo(["00001205000960"]);
        await Assert.That(warned).IsEmpty();

        // px4d が動いていなければ、今までどおり理由を残す
        var alone = new List<string>();
        await Assert.That(Px4Userland.ParseJson(ClaimedList, alone.Add)).IsEmpty();
        await Assert.That(alone.Count).IsEqualTo(2);
        await Assert.That(alone[0]).Contains("open_failed");
    }

    [Test]
    public async Task 同じ番号の筐体の片方のpx4dが動いていれば_もう片方もUSBポートで見分ける()
    {
        // PX-M1UR (5-1.4.1) の px4d が動いていて開けない。一覧には PX-S1UR (5-1.4.2) だけが「一意」で出る
        const string list = """
            {"enclosures":[{"serial":"000000000000001","model":"PX-S1UR","usb":"0511:0855","status":"ready","serial_unique":true,"devices":[{"device":1,"bus":5,"address":11,"port":"5-1.4.2"}],"candidates":[],"receivers":[{"receiver":0,"device":1,"local":0,"system":"ISDB-T","lnb_15v_supported":false}]}],"ungrouped_usb_devices":[{"model":"PX-M1UR","usb":"0511:0854","status":"open_failed","bus":5,"address":10,"port":"5-1.4.1"}]}
            """;
        var m1ur = new Px4Userland.Enclosure(
            "000000000000001_5-1.4.1", "PX-M1UR", [new Px4Receiver(0, true, true, false)], "000000000000001", ["5-1.4.1"])
        {
            Places = ["5-1.4.1"],
        };
        var warned = new List<string>();
        var found = Px4Userland.ParseJson(list, warned.Add, [m1ur]);

        var s1ur = found.Single(enclosure => enclosure.Model == "PX-S1UR");
        await Assert.That(s1ur.Id).IsEqualTo("000000000000001_5-1.4.2");
        await Assert.That(s1ur.UsbPaths).IsEquivalentTo(["5-1.4.2"]);
        await Assert.That(found.Select(enclosure => enclosure.Id))
            .IsEquivalentTo(["000000000000001_5-1.4.2", "000000000000001_5-1.4.1"]);
        await Assert.That(warned).IsEmpty();
    }

    [Test]
    public async Task px4dの終了コードに手当てを添える()
    {
        await Assert.That(Px4Userland.Hint(10)).Contains("ファームウェア");
        await Assert.That(Px4Userland.Hint(4)).Contains("ほかに動いています");
        await Assert.That(Px4Userland.Hint(0)).IsEmpty();
        if (OperatingSystem.IsWindows()) await Assert.That(Px4Userland.Hint(3)).Contains("WinUSB");
    }

    [Test]
    public async Task Windowsでもpx4の機材を開く()
    {
        // 開くだけでは何もしない (px4d に触るのは最初の選局)
        using var tuner = TunerPool.OpenDevice("px4:00001205000960:2", null);
        await Assert.That(tuner).IsTypeOf<Px4Tuner>();
        if (OperatingSystem.IsWindows())
        {
            var error = Assert.Throws<IOException>(() => TunerPool.OpenDevice("/dev/dvb/adapter0/frontend0", null));
            await Assert.That(error.Message).Contains("px4:");
        }
    }

    [Test]
    public async Task 実際のフォルダの持ち主と権限を見る()
    {
        if (!OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("rt");
        try
        {
            await Assert.That(Px4Userland.RuntimeProblem(Path.Combine(dir.FullName, "none"), "1")).Contains("ありません");
            Protect(dir, everyoneWrites: false);
            await Assert.That(Px4Userland.RuntimeProblem(dir.FullName, "1")).IsNull();
            Protect(dir, everyoneWrites: true);
            await Assert.That(Px4Userland.RuntimeProblem(dir.FullName, "1")).Contains("S-1-1-0");
        }
        finally
        {
            dir.Delete(true);
        }
    }

    /// <summary>install.ps1 と同じ形にする (持ち主は本人、保護された DACL で本人・SYSTEM・Administrators)</summary>
    [SupportedOSPlatform("windows")]
    private static void Protect(DirectoryInfo dir, bool everyoneWrites)
    {
        var me = WindowsIdentity.GetCurrent().User!;
        var security = new DirectorySecurity();
        security.SetOwner(me);
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[] { me, new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544") })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        }
        if (everyoneWrites)
        {
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier("S-1-1-0"), FileSystemRights.Modify, inherit, PropagationFlags.None, AccessControlType.Allow));
        }
        dir.SetAccessControl(security);
    }

    /// <summary>
    /// 標準入力で止める常駐 (Windows の px4d の <c>--exit-on-stdin-eof</c>) のふり。PowerShell で、起きたら印を置き、
    /// 標準入力が尽きたら (閉じられたら) 後片付けの印を置いて終わる
    /// </summary>
    private sealed class StdinDaemon(string dir) : UserlandDaemon("fake", "stdin")
    {
        public string Ready { get; } = Path.Combine(dir, "ready");
        public string Cleaned { get; } = Path.Combine(dir, "cleaned");

        public override void Ensure() => Launch(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command",
                $"New-Item -ItemType File '{Ready}' | Out-Null; [Console]::In.ReadToEnd() | Out-Null; New-Item -ItemType File '{Cleaned}' | Out-Null"],
            dir, () => File.Exists(Ready), () => { }, stopByStdin: true);
    }

    [Test]
    public async Task 標準入力を閉じると常駐は後片付けをして終わる_あとから起こした子にも邪魔されない(CancellationToken cancel)
    {
        await Task.Yield();
        if (!OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("stdin");
        Process? other = null;
        var daemon = new StdinDaemon(dir.FullName);
        try
        {
            daemon.Ensure();
            await Assert.That(daemon.Running).IsTrue();

            // 常駐を起こしたあとに別の子を起こす。標準入力の書く側がこちらに漏れていれば、閉じても EOF が届かない
            other = Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 30"])
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
            });

            var since = Stopwatch.StartNew();
            daemon.Stop();
            // Kill (10 秒待ってから) ではなく、自分で後片付けして終わった
            await Assert.That(File.Exists(daemon.Cleaned)).IsTrue();
            await Assert.That(since.Elapsed).IsLessThan(TimeSpan.FromSeconds(8));
            await Assert.That(daemon.Running).IsFalse();
        }
        finally
        {
            daemon.Stop();
            other?.Kill();
            other?.Dispose();
            dir.Delete(true);
        }
    }
}
