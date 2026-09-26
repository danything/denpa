using System.Diagnostics;
using TUnit.Assertions.Enums;
using TUnit.Core.Enums;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * siano-userland の機材 (PX-S1UD など) を掴むところ。
 *
 * 本物の機材は無い。ここで確かめるのは**機材に触らない部分**だけ —
 * siano-ts --list と sysfs の読み方 (とくに「カーネルが掴んでいるものは渡さない」)、device 文字列の形、
 * siano-ts の起こし方。実機で当てるのは `denpa-agent --tune siano:<ポート> T27` (Probe.cs)。
 */
public class SianoTests
{
    /// <summary>
    /// 偽の sysfs。ドライバが掴んでいる機材だけ、インターフェース <c>&lt;port&gt;:1.0/driver</c> を
    /// ドライバの場所へのリンクにする (カーネルが掴んでいるかは sysfs で見る)
    /// </summary>
    private static string FakeSysfs(params (string Port, string? Driver)[] devices)
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-sysfs-{Guid.NewGuid():N}");
        var drivers = Path.Combine(root, "_drivers");
        foreach (var (port, driver) in devices)
        {
            Directory.CreateDirectory(Path.Combine(root, port));
            var iface = Path.Combine(root, $"{port}:1.0");
            Directory.CreateDirectory(iface);
            if (driver is null) continue;
            Directory.CreateDirectory(Path.Combine(drivers, driver));
            Directory.CreateSymbolicLink(Path.Combine(iface, "driver"), Path.Combine(drivers, driver));
        }
        return root;
    }

    /// <summary>siano-userland 0.1.7 の <c>siano-ts --list</c> の形</summary>
    private const string List = """
        model=PX-S1UD usb=3275:0080 bus=1 address=4 port=1-2 status=ready receivers=1
        receiver=0 device=1 local=0 system=ISDB-T
        model=PX-S1UD usb=3275:0080 bus=1 address=5 port=1-3 status=ready receivers=1
        receiver=0 device=1 local=0 system=ISDB-T
        model=Siano-Rio usb=187f:0600 bus=2 address=9 port=2-1.4 status=ready receivers=1
        receiver=0 device=1 local=0 system=ISDB-T
        model=Siano-Rio usb=187f:0600 bus=3 address=2 port=- status=ready receivers=1
        receiver=0 device=1 local=0 system=ISDB-T
        rejected model=Siano-Nova-B usb=187f:0201 bus=1 address=6 port=1-4 status=unsupported
        """;

    // smsusb が掴んでいるのは 1-3 だけ
    private static List<SianoUserland.Stick> Sticks(List<string>? warned = null) =>
        SianoUserland.ParseList(List, port => port == "1-3" ? "smsusb" : null, message => warned?.Add(message));

    [Test]
    public async Task siano_ts_list_から機材を読む()
    {
        var warned = new List<string>();
        var sticks = Sticks(warned);
        await Assert.That(sticks.Select(s => s.Port)).IsEquivalentTo(["1-2", "1-3", "2-1.4"], CollectionOrdering.Matching);
        await Assert.That(sticks[2].Model).IsEqualTo("Siano-Rio");
        await Assert.That(sticks[0].Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(sticks[1].Driver).IsEqualTo("smsusb");
        // ポートの分からない機材と対応外の機材は、理由を残して使わない
        await Assert.That(warned.Count).IsEqualTo(2);
        await Assert.That(warned[0]).Contains("port=-");
        await Assert.That(warned[1]).Contains("unsupported");
    }

    [Test]
    public async Task ドライバに繋がっていない機材だけ挙げる()
    {
        await Assert.That(SianoUserland.Specs(Sticks())).IsEquivalentTo(
            [
                // smsusb が掴んでいる 1-3 は /dev/dvb で見つかる。こちらでは挙げない
                new TunerSpec("PX-S1UD 1-2", ["GR"], false, "siano:1-2"),
                new TunerSpec("Siano-Rio 2-1.4", ["GR"], false, "siano:2-1.4"),
            ],
            CollectionOrdering.Matching);
    }

    [Test]
    public async Task siano_ts_の終了コードに手当てを添える()
    {
        // 0.1.8 の終了コード。カーネルが掴んでいる・抜けた、は siano-ts が答える
        await Assert.That(SianoUserland.Hint(3)).Contains("見当たりません");
        await Assert.That(SianoUserland.Hint(10)).Contains("ファームウェア");
        // Windows は開けなければ (WinUSB でなければ) 1 か 4 で落ちる
        if (OperatingSystem.IsWindows())
        {
            await Assert.That(SianoUserland.Hint(4)).Contains("WinUSB");
            await Assert.That(SianoUserland.Hint(1)).Contains("WinUSB");
        }
        else
        {
            await Assert.That(SianoUserland.Hint(4)).Contains("smsusb");
            await Assert.That(SianoUserland.Hint(1)).IsEqualTo("");
        }
    }

    [Test]
    // Linux の置き場の形 (sysfs の名前の「:」、/dev のパス) を見るもの。Windows では作れない
    [ExcludeOn(OS.Windows)]
    public async Task 掴んでいるドライバは_sysfs_のインターフェースで見る()
    {
        var sysfs = FakeSysfs(("1-2", null), ("1-3", "smsusb"));
        try
        {
            await Assert.That(SianoUserland.Driver(sysfs, "1-2")).IsNull();
            await Assert.That(SianoUserland.Driver(sysfs, "1-3")).IsEqualTo("smsusb");
            // sysfs が無い (Linux でない) なら、掴んでいるドライバも無い
            await Assert.That(SianoUserland.Driver("/nonexistent/sysfs", "1-2")).IsNull();
        }
        finally
        {
            Directory.Delete(sysfs, recursive: true);
        }
    }

    [Test]
    public async Task 何も刺さっていなければ空()
    {
        await Assert.That(SianoUserland.ParseList("", _ => null, _ => { })).IsEmpty();
    }

    [Test]
    public async Task device_の形()
    {
        await Assert.That(SianoUserland.Parse("siano:1-2")).IsEqualTo("1-2");
        await Assert.That(SianoUserland.Parse("siano:3-1.4.2")).IsEqualTo("3-1.4.2");
        // インターフェースやルートハブ、シェルに渡りそうなものは受け取らない
        await Assert.That(SianoUserland.Parse("siano:1-2:1.0")).IsNull();
        await Assert.That(SianoUserland.Parse("siano:usb1")).IsNull();
        await Assert.That(SianoUserland.Parse("siano:1-2;reboot")).IsNull();
        await Assert.That(SianoUserland.Parse("px4:00001205000960:2")).IsNull();
        await Assert.That(TunerPool.OpenDevice("siano:1-2", null)).IsTypeOf<SianoTuner>();
    }

    [Test]
    public async Task siano_ts_はポートで指して_control_で起こす()
    {
        var start = SianoTuner.StartInfo("1-2.3", "/opt/siano-userland", "/fw/isdbt_rio.inp");
        await Assert.That(start.FileName).IsEqualTo(SianoUserland.Executable("/opt/siano-userland"));
        await Assert.That(start.ArgumentList.ToArray()).IsEquivalentTo(
            ["--device", "1-2.3", "--control", "--firmware", "/fw/isdbt_rio.inp"],
            CollectionOrdering.Matching);
    }

    [Test]
    public async Task 選局は標準入力に_Hz_で頼む()
    {
        // 地上波の表は Hz のまま渡す (27ch は 557.142857 MHz)
        await Assert.That(SianoTuner.TuneCommand(ChannelTable.Parse("T27")!)).IsEqualTo("tune 557142857");
    }

    [Test]
    public async Task 衛星は受けない()
    {
        var error = Assert.Throws<IOException>(() => SianoTuner.TuneCommand(ChannelTable.Parse("BS15_0")!));
        await Assert.That(error.Message).Contains("地上波だけ");
    }

    /// <summary>
    /// 偽の siano-ts --control。起きたらまず前の選局の残りに見立てて **pipe より多く** 書き、
    /// それから標準入力を読む (本物も「書く → 標準入力を見る」の1本の輪)。
    /// <c>tune 1</c> は同期しない。<c>tune 2</c> は前の選局の答え (別の周波数の <c>tuned</c>) を
    /// 先に吐く。<c>tune 3</c> は答えない。それ以外は少し待ってから (本物の同期待ち)
    /// <c>tuned</c> を返し、次のコマンドが来るまで <c>NEW&lt;Hz&gt;</c> を書き続ける
    /// (本物の TS も流れ続ける。<c>tuned</c> のあと読み捨てが止まるまでの分は食われるので、
    /// 書く量に限りがあると、込み合ったときに全部食われて届かない)
    /// </summary>
    private const string FakeSianoTs = """
        dd if=/dev/zero bs=1048576 count=20 2>/dev/null
        writer=
        stop() { if [ -n "$writer" ]; then kill "$writer" 2>/dev/null; wait "$writer" 2>/dev/null; writer=; fi; }
        emit() { (while :; do echo "NEW$1"; done) & writer=$!; }
        while IFS= read -r line; do
          case "$line" in
            "tune 1") stop
                      echo "ISDB-T tune response received but no demod lock" >&2
                      echo "control: tune failed: Connection timed out" >&2 ;;
            "tune 2") stop; echo "tuned 473142857" >&2; sleep 0.1; echo "tuned 2" >&2; emit 2 ;;
            "tune 3") stop; sleep 30 ;;
            tune\ *) stop; sleep 0.3; echo "tuned ${line#tune }" >&2; emit "${line#tune }" ;;
            quit) stop; exit 0 ;;
          esac
        done
        """;

    private static SianoTuner Fake() => new("siano fake", () => new ProcessStartInfo("/bin/sh")
    {
        ArgumentList = { "-c", FakeSianoTs },
    });

    /// <summary>
    /// 選局のあと最初に届いた <c>NEW…</c> の行。読み捨てが行の途中で止まるので、
    /// 頭の欠けた1行目は飛ばす。**前の選局の残り (0 の詰め物) が混じっていれば落とす**
    /// </summary>
    private static string ReadLine(Stream stream)
    {
        for (var tries = 0; tries < 3; tries++)
        {
            var line = new List<byte>();
            var one = new byte[1];
            while (stream.Read(one, 0, 1) == 1 && one[0] != (byte)'\n') line.Add(one[0]);
            if (line.Contains(0)) throw new InvalidOperationException("前の選局の残りが混じっています");
            var text = System.Text.Encoding.ASCII.GetString(line.ToArray());
            if (text.StartsWith("NEW", StringComparison.Ordinal)) return text;
        }
        throw new InvalidOperationException("NEW の行が届きません");
    }

    [Test]
    public async Task 起こしたまま選局し直し_前の残りは読まない()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = Fake();

        // 起きた直後の 20MB を読んで捨てないと tune を読みに来ない (詰まらずに返ること)
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW557142857");

        // 同じ子のまま選局し直す。読み口も同じもの
        var output = tuner.Output;
        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Output).IsSameReferenceAs(output);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }

    /// <summary>
    /// **Windows の詰め物** (空行を書き続ける) を入れても、選局し直せて止められる。
    /// Windows の pipe の振る舞いまでは見られないが、空行が選局の答えを乱さないことはここで見る。
    /// **ほかと並べない** — 偽物は TS と関係なく空行を読み続けるので CPU を1つ食い、
    /// 並んだテストの待ち (1 秒で切るもの) を押し出す (CI で1度落ちた)
    /// </summary>
    [Test]
    [NotInParallel]
    public async Task 空行を詰め続けても選局し直せる()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = new SianoTuner(
            "siano fake", () => new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", FakeSianoTs } }, keepFed: true);
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW557142857");
        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }

    [Test]
    public async Task 同期しなければ理由を添えて投げ_子は生かしておく()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = Fake();
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);

        var error = Assert.Throws<IOException>(
            () => tuner.Tune(ChannelTable.Parse("T27")! with { Frequency = 1 }, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("no demod lock");
        // 次の選局で使い回す
        await Assert.That(tuner.Tuned).IsTrue();
        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }

    [Test]
    public async Task 子が死んでいれば起こし直す()
    {
        if (!OperatingSystem.IsLinux()) return;
        // 1回目の子は、1行読まれたところで (印のファイルができたら) 終わる。USB が抜けた、に見立てる。
        // 時間で終わらせると、遅い機械では読む前に終わってしまう
        var die = Path.Combine(Path.GetTempPath(), $"denpa-siano-die-{Guid.NewGuid():N}");
        var starts = 0;
        using var tuner = new SianoTuner("siano fake", () =>
        {
            starts++;
            var script = starts == 1
                ? FakeSianoTs.Replace(
                    "emit \"${line#tune }\" ;;",
                    "emit \"${line#tune }\"; while [ ! -e \"$DIE\" ]; do sleep 0.05; done; stop; exit 7 ;;")
                : FakeSianoTs;
            return new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", script }, Environment = { ["DIE"] = die } };
        });
        try
        {
            tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
            await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW557142857");
            File.WriteAllText(die, "");
            for (var i = 0; i < 50 && tuner.Tuned; i++) await Task.Delay(100);
            await Assert.That(tuner.Tuned).IsFalse();

            tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
            await Assert.That(starts).IsEqualTo(2);
            await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
        }
        finally
        {
            File.Delete(die);
        }
    }

    [Test]
    public async Task 別の周波数の_tuned_は答えにしない()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var tuner = Fake();
        tuner.Tune(ChannelTable.Parse("T27")! with { Frequency = 2 }, ChannelTable.NoStreamId);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW2");
    }

    [Test]
    public async Task 答えが来なければ子を捨てて_次は起こし直す()
    {
        if (!OperatingSystem.IsLinux()) return;
        var starts = 0;
        using var tuner = new SianoTuner(
            "siano fake",
            () =>
            {
                starts++;
                return new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", FakeSianoTs } };
            },
            TimeSpan.FromSeconds(1));

        var error = Assert.Throws<IOException>(
            () => tuner.Tune(ChannelTable.Parse("T27")! with { Frequency = 3 }, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("同期しませんでした");
        // 遅れて来る答えが次の選局に紛れないよう、子はもう居ない
        await Assert.That(tuner.Tuned).IsFalse();

        tuner.Tune(ChannelTable.Parse("T13")!, ChannelTable.NoStreamId);
        await Assert.That(starts).IsEqualTo(2);
        await Assert.That(ReadLine(tuner.Output)).IsEqualTo("NEW473142857");
    }
}
