using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * asicen-userland の機材 (Asicen.cs / AsicenChild.cs / AsicenTuner.cs)。
 *
 * 機材は無い。AsicenTests は機材の見つけ方 (一覧の JSON の読み方、筐体の名前、開く引数) を確かめる。
 * AsicenChildTests は、偽の機材で組んだ子プロセス (agent/asicen/build.sh --mock。ASICEN_CHILD で渡す) を起動し、
 * 選局から TS を受け取って止めるまでと、子プロセスが落ちたときを通す。エンジンと HardwareStreamService は本物で、USB の部分だけが偽物。
 */
public class AsicenTests
{
    /// <summary>テストで置く空のファームウェアの SHA-256 (本物の中身は持たない)</summary>
    private const string EmptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    /// <summary>
    /// 機材をつないだときの一覧の JSON。**観察したものではない。** dtv-userland-core の docs/json-discovery.md の例の形式で組んだ
    /// </summary>
    private static string Discovery(string enclosures, string ungrouped = "", string version = "1.0.0") =>
        $$"""{"schema":{"name":"userland.discovery","major":1,"minor":0},"producer":{"product":"asicen","version":"{{version}}"},"scan":{"complete":true,"issues":[]},"enclosures":[{{enclosures}}],"ungrouped_usb_devices":[{{ungrouped}}]}""";

    /// <summary>配布物の <c>asicend --list-json</c> の出力 (機材をつないでいないとき)</summary>
    private const string Empty =
        """{"schema":{"name":"userland.discovery","major":1,"minor":0},"producer":{"product":"asicen","version":"1.0.0"},"scan":{"complete":true,"issues":[]},"enclosures":[],"ungrouped_usb_devices":[]}""";

    private const string W3u3 =
        """{"id":1,"model":"PX-W3U3","serial":null,"serial_unique":null,"status":"ready","lnb_15v_supported":true,"readers":[{"reader":0,"device":2}],"devices":[{"id":2,"usb":"0b06:0005","serial":null,"bus":1,"address":29,"port":"1-2.1","receivers":[{"receiver":0,"device":2,"local":0,"systems":["ISDB-S"]},{"receiver":1,"device":2,"local":1,"systems":["ISDB-T"]}]},{"id":3,"usb":"0b06:0005","serial":null,"bus":1,"address":30,"port":"1-2.2","receivers":[{"receiver":2,"device":3,"local":0,"systems":["ISDB-S"]},{"receiver":3,"device":3,"local":1,"systems":["ISDB-T"]}]}],"candidates":[]}""";

    private const string S3u =
        """{"id":4,"model":"PX-S3U","serial":null,"serial_unique":null,"status":"ready","lnb_15v_supported":null,"devices":[{"id":5,"usb":"0b06:0001","serial":null,"bus":3,"address":7,"port":"3-1.4","receivers":[{"receiver":0,"device":5,"local":0,"systems":["ISDB-T","ISDB-S"]}]}],"candidates":[]}""";

    private static void Usb(DirectoryInfo root, string port, string vid, string pid)
    {
        var dir = Directory.CreateDirectory(Path.Combine(root.FullName, port)).FullName;
        File.WriteAllText(Path.Combine(dir, "idVendor"), vid + "\n");
        File.WriteAllText(Path.Combine(dir, "idProduct"), pid + "\n");
    }

    [Test]
    public async Task 機材が無いときの一覧は空()
    {
        var warnings = new List<string>();
        await Assert.That(AsicenUserland.ParseDiscovery(Empty, warnings.Add)).IsEmpty();
        await Assert.That(warnings).IsEmpty();
    }

    [Test]
    public async Task 一覧の筐体を読む_USB_機能が_2_つなら内蔵ハブのポートが名前になる()
    {
        var warnings = new List<string>();
        var enclosures = AsicenUserland.ParseDiscovery(Discovery($"{W3u3},{S3u}"), warnings.Add);

        await Assert.That(warnings).IsEmpty();
        await Assert.That(enclosures.Select(enclosure => $"{enclosure.Id} {enclosure.Model} {string.Join(",", enclosure.Ports)}").ToArray())
            .IsEquivalentTo(new[] { "1-2 PX-W3U3 1-2.1,1-2.2", "3-1.4 PX-S3U 3-1.4" });
        // 既存の設定 (asicen:1-2:1) がそのまま使える
        var specs = AsicenUserland.Specs(enclosures);
        await Assert.That(specs.Select(spec => $"{spec.Device} {string.Join("/", spec.Types)}").ToArray()).IsEquivalentTo(new[]
        {
            "asicen:1-2:0 BS/CS", "asicen:1-2:1 GR", "asicen:1-2:2 BS/CS", "asicen:1-2:3 GR", "asicen:3-1.4:0 GR/BS/CS",
        });
        // 給電できるのは PX-W3U2・PX-W3U3・PX-W3U3 V2 だけ
        await Assert.That(enclosures.Select(enclosure => AsicenUserland.PowersLnb(enclosure.Model)).ToArray()).IsEquivalentTo(new[] { true, false });
    }

    [Test]
    public async Task 一覧に受信機が無ければ機種の表の並びを使う()
    {
        const string bare =
            """{"id":1,"model":null,"serial":null,"status":"ready","devices":[{"id":2,"usb":"0b06:0003","port":"2-1"}],"candidates":[]}""";
        var enclosures = AsicenUserland.ParseDiscovery(Discovery(bare), _ => { });

        await Assert.That(enclosures[0].Model).IsEqualTo("PX-S3U2");
        await Assert.That(enclosures[0].Receivers.Select(receiver => string.Join("/", receiver.Types)).ToArray()).IsEquivalentTo(new[] { "BS/CS", "GR" });
    }

    [Test]
    public async Task バージョンが違う一覧は使わずに理由を残す()
    {
        var warnings = new List<string>();
        await Assert.That(AsicenUserland.ParseDiscovery(Discovery(W3u3, version: "1.0.1"), warnings.Add)).IsEmpty();
        await Assert.That(warnings[0]).Contains("asicen 1.0.1");
    }

    [Test]
    public async Task 使えない筐体は理由と_USB_のポートを残す()
    {
        var warnings = new List<string>();
        var enclosures = AsicenUserland.ParseDiscovery(
            Discovery(
                W3u3.Replace("\"ready\"", "\"incomplete\"") + "," + S3u.Replace("PX-S3U", "PX-X9"),
                """{"usb":"0b06:0005","model":"PX-W3U3","port":"4-1","status":"open_failed"},{"usb":"1738:5211","model":null,"port":"4-2","status":"unsupported"}"""),
            warnings.Add);

        await Assert.That(enclosures).IsEmpty();
        await Assert.That(warnings.Count).IsEqualTo(3);
        await Assert.That(warnings[0]).Contains("状態: incomplete").And.Contains("1-2.1 / 1-2.2");
        await Assert.That(warnings[1]).Contains("PX-X9");
        await Assert.That(warnings[2]).Contains("open_failed").And.Contains("4-1");
    }

    [Test]
    public async Task 筐体の名前はポートの形式だけ()
    {
        await Assert.That(AsicenUserland.Parse("asicen:1-2:1")).IsEqualTo(("1-2", 1));
        await Assert.That(AsicenUserland.Parse("asicen:3-1.4:0")).IsEqualTo(("3-1.4", 0));
        await Assert.That(AsicenUserland.Parse("asicen:../x:0")).IsNull();
        await Assert.That(AsicenUserland.Parse("siano:1-2")).IsNull();
        await Assert.That(AsicenUserland.IdOf(["1-2.1", "1-2.2"])).IsEqualTo("1-2");
        await Assert.That(AsicenUserland.IdOf(["1-3"])).IsEqualTo("1-3");
        // 別々のハブの USB 機能は 1 つの筐体にしない
        await Assert.That(AsicenUserland.IdOf(["1-2.1", "1-4.2"])).IsNull();
    }

    [Test]
    public async Task sysfs_からファームウェア待ちの機材を見つけて子プロセスに渡す組にまとめる()
    {
        var root = Directory.CreateTempSubdirectory("sysfs");
        try
        {
            Usb(root, "1-2.1", "0b06", "0005");
            Usb(root, "1-2.2", "1738", "5211");
            Usb(root, "1-5", "1738", "5216");
            Usb(root, "1-3", "3275", "0080");     // PX-S1UD (siano)
            Usb(root, "usb1", "1d6b", "0002");    // ルートハブ

            var found = AsicenUserland.Scan(new SysfsUsbHost(root.FullName));
            await Assert.That(found.Select(function => $"{function.Port} {function.Usb} {function.Loader}").ToArray())
                .IsEquivalentTo(new[] { "1-2.1 0b06:0005 False", "1-2.2 1738:5211 True", "1-5 1738:5216 True" });

            var waiting = AsicenUserland.Waiting(found);
            await Assert.That(waiting.Select(enclosure => $"{enclosure.Id}={string.Join(",", enclosure.Ports)}").ToArray())
                .IsEquivalentTo(new[] { "1-2=1-2.1,1-2.2", "1-5=1-5" });
            await Assert.That(AsicenUserland.Scan(new SysfsUsbHost(Path.Combine(root.FullName, "none")))).IsEmpty();
        }
        finally
        {
            root.Delete(true);
        }
    }

    [Test]
    public async Task 開く引数は_device_と_firmware_で_給電の許可は給電できる機種だけ()
    {
        var firmware = Path.GetTempFileName();
        try
        {
            var w3u3 = new AsicenUserland.Enclosure("1-2", "PX-W3U3", ["1-2.1", "1-2.2"], []);
            var s3u2 = new AsicenUserland.Enclosure("1-3", "PX-S3U2", ["1-3"], []);

            var selected = AsicenEnclosure.Hardware("1-2", firmware, () => [w3u3, s3u2], null, EmptySha256);
            await Assert.That(selected.Args)
                .IsEquivalentTo(new[] { "--device", "usb:1-2.1,1-2.2", "--firmware", firmware, "--allow-lnb-power" });
            await Assert.That(selected.AllowLnb).IsTrue();
            // PX-S3U2 は上流が給電の制御を未解明としているので許可しない
            await Assert.That(AsicenEnclosure.Hardware("1-3", firmware, () => [w3u3, s3u2], null, EmptySha256).Args)
                .IsEquivalentTo(new[] { "--device", "usb:1-3", "--firmware", firmware });

            var gone = Assert.Throws<IOException>(() => AsicenEnclosure.Hardware("9-9", firmware, () => [w3u3], null, EmptySha256));
            await Assert.That(gone!.Message).Contains("見つかりません");
            var missing = Assert.Throws<IOException>(() => AsicenEnclosure.Hardware("1-2", firmware + ".none", () => [w3u3], null, EmptySha256));
            await Assert.That(missing!.Message).Contains("ファームウェアがありません");
            // 置いたファイルが確かめたものと違えば開かない
            File.WriteAllBytes(firmware, [1, 2, 3]);
            var wrong = Assert.Throws<IOException>(() => AsicenEnclosure.Hardware("1-2", firmware, () => [w3u3], null, EmptySha256));
            await Assert.That(wrong!.Message).Contains("確かめたファームウェアと違います");
        }
        finally
        {
            File.Delete(firmware);
        }
    }

    [Test]
    // fcntl は可変長引数で、macOS (arm64) では引数の渡し方が違う。fd を渡すのは Android (Linux) だけ
    [RunOn(OS.Linux)]
    public async Task Android_では_USB_機能の_fd_の複製をポートの順に作り_device_の代わりに_fd_を渡す()
    {
        var firmware = Path.GetTempFileName();
        try
        {
            using var file = File.OpenHandle(firmware);
            var fd = (int)file.DangerousGetHandle();
            var w3u3 = new AsicenUserland.Enclosure("1-2", "PX-W3U3", ["1-2.1", "1-2.2"], []);
            var lent = new List<string>();
            InheritedFds Lend(IReadOnlyList<string> ports)
            {
                lent.AddRange(ports);
                return InheritedFds.Duplicate([.. ports.Select(port => (fd, port))]);
            }

            var selection = AsicenEnclosure.Hardware("1-2", firmware, () => [w3u3], Lend, EmptySha256);
            // 複製を作るのは起動する直前。選んだだけでは作らない
            await Assert.That(lent).IsEmpty();
            await Assert.That(selection.Args).IsEquivalentTo(new[] { "--firmware", firmware, "--allow-lnb-power" });
            using var fds = selection.Lend!();
            await Assert.That(lent).IsEquivalentTo(new[] { "1-2.1", "1-2.2" });
            await Assert.That(fds.Numbers.Count).IsEqualTo(2);
            await Assert.That(fds.Numbers.All(number => number != fd)).IsTrue();
            var (first, second) = (fds.Numbers[0].ToString(), fds.Numbers[1].ToString());
            await Assert.That(AsicenEnclosure.FdOptions(fds.Numbers)).IsEquivalentTo(new[] { "--fd", first, "--fd", second });
        }
        finally
        {
            File.Delete(firmware);
        }
    }

    [Test]
    public async Task Android_では受け取った機材の_ID_とポートから筐体を組む()
    {
        var warnings = new List<string>();
        AsicenUserland.Function Runtime(string usb, string port) => new(usb, port, false);
        var found = AsicenUserland.Group(
        [
            Runtime("0b06:0005", "1-2.1"), Runtime("0b06:0005", "1-2.2"),
            Runtime("0b06:0003", "1-3"),
            // 内蔵ハブの片方だけ
            Runtime("0b06:0006", "2-1.1"),
            // ポートの名前を作れないカーネル (名前から作った 001-004) では内蔵ハブが分からない
            Runtime("0b06:0004", "001-004"), Runtime("0b06:0004", "001-005"),
            // ファームウェア待ちは Boot が扱う
            new("1738:5211", "1-4", true),
        ], warnings.Add);

        await Assert.That(found.Select(enclosure => $"{enclosure.Id} {enclosure.Model} {string.Join(",", enclosure.Ports)}").ToArray())
            .IsEquivalentTo(new[] { "1-2 PX-W3U3 1-2.1,1-2.2", "1-3 PX-S3U2 1-3" });
        await Assert.That(string.Join(" ", found[0].Receivers.Select(receiver => string.Join("/", receiver.Types)))).IsEqualTo("BS/CS GR BS/CS GR");
        await Assert.That(found[1].Receivers.Select(receiver => receiver.Index).ToArray()).IsEquivalentTo(new[] { 0, 1 });
        await Assert.That(warnings.Count).IsEqualTo(2);
        await Assert.That(warnings.Any(warning => warning.Contains("PX-W3U3 V2 (USB 2-1.1)"))).IsTrue();
        await Assert.That(warnings.Any(warning => warning.Contains("PX-W3U2 (USB 001-004 / 001-005)"))).IsTrue();
    }

    [Test]
    public async Task 選局の周波数は_Hz_で_衛星は_TSID_か_スロット_0_で選ぶ()
    {
        var t27 = ChannelTable.Parse("T27")!;
        await Assert.That(AsicenTuner.FrequencyHz(t27)).IsEqualTo((ulong)t27.Frequency);
        await Assert.That(AsicenTuner.Selection(t27)).IsEqualTo(((ushort)0xffff, (ushort)0xffff));

        var bs = ChannelTable.Parse("BS15:16625")!;
        await Assert.That(AsicenTuner.FrequencyHz(bs)).IsEqualTo((ulong)bs.Frequency * 1000);
        await Assert.That(AsicenTuner.Selection(bs)).IsEqualTo(((ushort)16625, (ushort)0xffff));

        var cs = ChannelTable.Parse("CS2")!;
        await Assert.That(AsicenTuner.Selection(cs)).IsEqualTo(((ushort)0xffff, (ushort)0));
    }

    [Test]
    public async Task 子プロセスが無ければ何も挙げない()
    {
        if (Environment.GetEnvironmentVariable("ASICEN_CHILD") is not null) return;
        await Assert.That(AsicenUserland.Installed).IsFalse();
        await Assert.That(AsicenChild.Problem).IsNotNull();
        await Assert.That(AsicenUserland.Detect()).IsEmpty();
    }
}

/// <summary>
/// 偽の機材で組んだ子プロセス (<c>agent/asicen/build.sh --mock</c>) を起動して通す。**ASICEN_CHILD に組んだものがあるときだけ**
/// (CI の agent-asicen-mock・agent-windows・agent-macos、または手元のコンテナ)。偽の TS は CC を進めた null パケット。**偽の機材は実機ではない。**
/// </summary>
[Timeout(120_000)]
public class AsicenChildTests
{
    /// <summary>指してあるのに読めなければ失敗にする (CI で気づかないまま飛ばさない)</summary>
    private static bool Ready()
    {
        if (Environment.GetEnvironmentVariable("ASICEN_CHILD") is null)
        {
            Skip.Test("ASICEN_CHILD が指されていません");
            return false;
        }
        if (!AsicenChild.Available) throw new InvalidOperationException(AsicenChild.Problem);
        return true;
    }

    private static AsicenEnclosure Mock(string id, int receivers = 4) =>
        new(id, () => new([]), _ => AsicenChild.OpenMock($"asicen {id}", receivers));

    private static async Task Stream(AsicenTuner tuner, string channel, CancellationToken cancel)
    {
        tuner.Tune(ChannelTable.Parse(channel)!);
        var packets = new byte[188 * 32];
        await Task.Run(() => tuner.Output.ReadExactly(packets), cancel).WaitAsync(TimeSpan.FromSeconds(10), cancel);
        for (var at = 0; at < packets.Length; at += 188) await Assert.That(packets[at]).IsEqualTo((byte)0x47);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(tuner.Signal()!.Locked).IsTrue();
    }

    [Test]
    public async Task 起動してプロトコルと上流のバージョンを確かめる()
    {
        if (!Ready()) return;
        await Assert.That(AsicenUserland.Installed).IsTrue();
        await Assert.That(AsicenChild.ErrorName(AsicenChild.Timeout)).IsEqualTo("TIMEOUT");
    }

    [Test]
    public async Task 機材が無ければ並べた一覧は空()
    {
        if (!Ready()) return;
        await Assert.That(AsicenUserland.ParseDiscovery(AsicenChild.ListJson(), _ => { })).IsEmpty();
    }

    [Test]
    public async Task 開いて受信機を問い合わせ_選局して_TS_を受け取り_選局し直す(CancellationToken cancel)
    {
        if (!Ready()) return;
        var enclosure = Mock("8-1");
        try
        {
            enclosure.Open();
            await Assert.That(enclosure.Listed!.Model).IsEqualTo("mock");
            await Assert.That(string.Join(" ", enclosure.Listed.Receivers.Select(receiver => string.Join("/", receiver.Types)))).IsEqualTo("BS/CS GR BS/CS GR");
            await Assert.That(enclosure.Listed.Lnb).IsTrue();

            using var terrestrial = new AsicenTuner(enclosure, 1, null);
            using var satellite = new AsicenTuner(enclosure, 0, "15v");
            await Stream(terrestrial, "T27", cancel);
            // 同じ受信機で選局し直す (流れを止めて受信機を返し、取り直す)
            await Stream(terrestrial, "T28", cancel);
            // 衛星は TSID で、LNB 15V を載せて。2 つの受信機を同時に流す
            await Stream(satellite, "BS15:16625", cancel);
            await Stream(satellite, "CS2", cancel);
            await Assert.That(terrestrial.Tuned).IsTrue();
            await Assert.That(TunerNotice.Get("asicen:8-1:0")).IsNull();
        }
        finally
        {
            enclosure.Close();
        }
    }

    [Test]
    public async Task 受信機と方式が合わなければ子プロセスに渡す前に断る()
    {
        if (!Ready()) return;
        var enclosure = Mock("8-2");
        try
        {
            using var tuner = new AsicenTuner(enclosure, 1, null);
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(error!.Message).Contains("GR 用");
            using var missing = new AsicenTuner(enclosure, 7, null);
            var gone = Assert.Throws<IOException>(() => missing.Tune(ChannelTable.Parse("T27")!));
            await Assert.That(gone!.Message).Contains("受信機 7 はありません");
            await Assert.That(tuner.Tuned).IsFalse();
        }
        finally
        {
            enclosure.Close();
        }
    }

    [Test]
    public async Task 流している間に筐体を閉じても_TS_は流れ続け_止めたときに後片付けを終える(CancellationToken cancel)
    {
        if (!Ready()) return;
        var enclosure = Mock("8-3");
        var tuner = new AsicenTuner(enclosure, 3, null);
        await Stream(tuner, "T27", cancel);
        enclosure.Close();
        await Assert.That(enclosure.Opened).IsFalse();
        var packet = new byte[188];
        await Task.Run(() => tuner.Output.ReadExactly(packet), cancel).WaitAsync(TimeSpan.FromSeconds(10), cancel);
        await Assert.That(packet[0]).IsEqualTo((byte)0x47);
        tuner.Dispose();
        await Assert.That(tuner.Tuned).IsFalse();

        // 次の選局で開き直す
        using var again = new AsicenTuner(enclosure, 3, null);
        await Stream(again, "T27", cancel);
        await Assert.That(enclosure.Opened).IsTrue();
        again.Dispose();
        enclosure.Close();
    }

    [Test]
    public async Task 使う受信機が無くなった筐体は閉じ_戻したら開き直す()
    {
        if (!Ready()) return;
        var tag = Guid.NewGuid().ToString("N")[..4];
        AsicenEnclosure Enclosure(string id) => AsicenEnclosure.For(id, () => Mock(id));
        string[] both = [$"9-{tag}1", $"9-{tag}2"];
        var a = Enclosure(both[0]);
        var b = Enclosure(both[1]);
        try
        {
            AsicenEnclosure.Prepare(both, Enclosure);
            await Assert.That(a.Opened && b.Opened).IsTrue();

            AsicenEnclosure.Prepare([both[0]], Enclosure);
            await Assert.That(a.Opened).IsTrue();
            await Assert.That(b.Opened).IsFalse();

            AsicenEnclosure.Prepare([], Enclosure);
            await Assert.That(a.Opened).IsFalse();

            AsicenEnclosure.Prepare(both, Enclosure);
            await Assert.That(a.Opened && b.Opened).IsTrue();
        }
        finally
        {
            a.Close();
            b.Close();
        }
    }

    [Test]
    public async Task 抜けた印のある筐体は次に要ったときに開き直す(CancellationToken cancel)
    {
        if (!Ready()) return;
        var opened = 0;
        var enclosure = new AsicenEnclosure("8-4", () => new([]), _ =>
        {
            Interlocked.Increment(ref opened);
            return AsicenChild.OpenMock("asicen 8-4", 1);
        });
        try
        {
            using var tuner = new AsicenTuner(enclosure, 0, null);
            await Stream(tuner, "T27", cancel);
            enclosure.MarkLost();
            await Stream(tuner, "BS15:16625", cancel);
            await Assert.That(opened).IsEqualTo(2);
        }
        finally
        {
            enclosure.Close();
        }
    }

    [Test]
    public async Task 子プロセスが落ちたら_TS_が終わり_次の選局で起動し直す(CancellationToken cancel)
    {
        if (!Ready()) return;
        AsicenChild? last = null;
        var opened = 0;
        var enclosure = new AsicenEnclosure("8-5", () => new([]), _ =>
        {
            Interlocked.Increment(ref opened);
            return last = AsicenChild.OpenMock("asicen 8-5", 1);
        });
        try
        {
            using var tuner = new AsicenTuner(enclosure, 0, null);
            await Stream(tuner, "T27", cancel);
            last!.Kill();
            // 読み出し側には終わりが届く (エージェントは落ちない)
            var buffer = new byte[188 * 1024];
            await Task.Run(() =>
            {
                try
                {
                    while (tuner.Output.Read(buffer) > 0)
                    {
                    }
                }
                catch (IOException)
                {
                }
            }, cancel).WaitAsync(TimeSpan.FromSeconds(15), cancel);
            await Assert.That(tuner.Tuned).IsFalse();
            await Assert.That(enclosure.Opened).IsFalse();
            await Stream(tuner, "T28", cancel);
            await Assert.That(opened).IsEqualTo(2);
        }
        finally
        {
            enclosure.Close();
        }
    }
}
