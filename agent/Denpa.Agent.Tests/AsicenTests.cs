using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.Sockets;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * asicen-userland の機材 (Asicen.cs / AsicenUdtv.cs)。
 *
 * 機材は無い。機材の見つけ方 (asicend --list-json と asicenctl list の出力の読み方、筐体の名前、起動の引数) と、
 * UDTV 1.0 のやり取りを、記録どおりに応答する偽の asicend で確かめる。
 *
 * **記録** (AsicenRecorded) は、配布物の公式のクライアント (asicen-ts・asicenctl 1.0.0) と模擬のデーモン
 * (asicend-mock。v1.0.0-beta のソースから組んだもの) の間に中継を挟んで取ったバイト列。自分で観察した事実で、
 * 上流のコードの写しではない。epoch (デーモンが起動するたびに変わる 16 バイト) は、複数の記録を 1 つの偽物で使えるように
 * 同じ値に置き換えてある。取り方は denpa-spec の asicen-udtv/spec.md。
 *
 * 上流の模擬のデーモンが手元にあれば (ASICEN_USERLAND_DIR)、それとも通信する (AsicenMockTests)。
 */
internal static class AsicenRecorded
{
    public const string Epoch = "b9603bf13257c4a50f45d358a06307b6";

    public static byte[] Hex(string hex) => Convert.FromHexString(hex.Replace(" ", ""));

    /// <summary>HELLO の応答 (61 バイト)。製品名 asicen-userland、バージョン 1.0.0</summary>
    public static readonly byte[] Hello = Hex(
        "0100 0000 0000000000000000" + Epoch + "0f00 61736963656e2d757365726c616e64 0500 312e302e30 00 00000100 9cff0f00");

    /// <summary>LIST の応答 (177 バイト。模擬の PX-W3U3)</summary>
    public static readonly byte[] List = Hex(
        Epoch
        + "0f0061736963656e2d757365726c616e640500312e302e3000000000000000000000000000000000000201020001000001070050582d573355330200"
        + "030002000100060b0500020000000200000201000200060b05000200000002000002010001040000000201010000000000020200000f000100010101"
        + "0001000000000002000201020000000000020200000f00030001010200010000000000010100000000");

    /// <summary>STATUS の応答 (296 バイト。起動した直後の模擬の PX-W3U3)</summary>
    public static readonly byte[] Status = Hex(
        "0f0061736963656e2d757365726c616e640500312e302e3000"
        + Epoch
        + "0104007465737401000300000000000000c0b1e377f8a2000000000000000000000001000001070050582d5733553302000300010000020102000102"
        + "000100060b0500020000000200000201000200060b05000200000002000002010001040000000201010000000000020200000f000000000000000000"
        + "000000000000000000000000000001000101010001000000000000000000000000000000000000000000000000000000020002010200000000000202"
        + "00000f000000000000000000000000000000000000000000000003000101020001000000000000000000000000000000000000000000000000000000"
        + "010100000000000000010000000000");

    /// <summary>TUNE の要求: <c>asicen-ts --receiver 1 --channel T27</c> (lease 1、時間切れは既定の 10000 ms)</summary>
    public static readonly byte[] TuneT27 = Hex(Epoch + "0100000000000000 01 4953352100000000 00 0000 000000 10270000");

    /// <summary>TUNE の要求: <c>asicen-ts --receiver 0 --channel BS03 --tsid 16433</c> (lease 5)</summary>
    public static readonly byte[] TuneBs03 = Hex(Epoch + "0500000000000000 02 001fd74000000000 01 3140 000000 10270000");

    /// <summary>TUNE の要求: <c>asicen-ts --receiver 2 --channel CS2</c> (lease 6。スロット 0)</summary>
    public static readonly byte[] TuneCs2 = Hex(Epoch + "0600000000000000 02 406d246000000000 02 0000 000000 10270000");

    /// <summary>TUNE の応答: T27 (選局の番号 1)</summary>
    public static readonly byte[] TunedT27 = Hex(Epoch + "0100000000000000 4953352100000000 01 f04f352100000000 010201 800e60a7dba10000 00 00");

    /// <summary>TUNE の応答: BS03 を TSID 16433 で (選局の番号 2)</summary>
    public static readonly byte[] TunedBs03 = Hex(Epoch + "0200000000000000 001fd74000000000 01 001fd74000000000 010201 c0990031dca10000 01 3140 00");

    /// <summary>TUNE の応答: CS4 をスロット 3 で (選局の番号 2)</summary>
    public static readonly byte[] TunedCs4 = Hex(Epoch + "0200000000000000 40c7866200000000 01 40c7866200000000 010201 4005964bdca10000 00 01 0300");

    /// <summary>エラーの応答: 使っている受信機への ACQUIRE (BUSY)</summary>
    public static readonly byte[] Busy = Hex(Epoch + "04000000 0700 61637175697265 0400 42555359 0000000000000000000000");

    /// <summary>エラーの応答: 範囲の外の周波数への TUNE (UNSUPPORTED)</summary>
    public static readonly byte[] Unsupported = Hex(Epoch + "0b000000 0400 74756e65 0b00 554e535550504f52544544 0000000000000000000000");

    /// <summary>エラーの応答: <c>--allow-lnb-power</c> なしの模擬への <c>asicenctl lnb-on</c> (UNSUPPORTED)</summary>
    public static readonly byte[] LnbDenied = Hex(Epoch + "0b000000 0900 6c6e625f706f776572 0b00 554e535550504f52544544 0000000000000000000000");

    /// <summary>STOP の応答 (71 バイト。ストリーム 1、選局の番号 1。「後始末がまだ」のエラーつき)</summary>
    public static readonly byte[] Stopped = Hex(
        Epoch + "0100000000000000 0100000000000000 00 01 04000000 0b00 73746f705f73747265616d 0f00 636c65616e75702070656e64696e67 000000");

    /// <summary>STREAM_END (76 バイト。ストリーム 1、選局の番号 1、理由 0、エラーなし、数が 8 つ)</summary>
    public static readonly byte[] Ended = Hex(
        "01000000000000000100000000000000000008000502c0040000000000000000000000000000000601010702007d030000000000000000000000000000"
        + "080101 090101 0a0101 0b0101 0c0101");

    /// <summary>模擬の <c>asicenctl list</c> の出力 (PX-W3U3)</summary>
    public const string ListW3u3 =
        """
        ready=1 usb-functions=2 receivers=4 readers=1
        model=PX-W3U3
        function=1 usb=0b06:0005 present=yes
        function=2 usb=0b06:0005 present=yes
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-T
        receiver=2 device=2 local=0 system=ISDB-S
        receiver=3 device=2 local=1 system=ISDB-T
        """;

    /// <summary>模擬の <c>asicenctl list</c> の出力 (<c>--model s3u</c>)</summary>
    public const string ListS3u =
        """
        ready=1 usb-functions=1 receivers=1 readers=1
        model=PX-S3U
        function=1 usb=0b06:0001 present=yes
        receiver=0 device=1 local=0 system=ISDB-T,ISDB-S
        """;

    /// <summary>模擬の <c>asicenctl list</c> の出力 (<c>--model w3u3-v2</c>。機種の名前に空白がある)</summary>
    public const string ListV2 =
        """
        ready=1 usb-functions=2 receivers=4 readers=1
        model=PX-W3U3 V2
        function=1 usb=0b06:0006 present=yes
        function=2 usb=0b06:0006 present=yes
        receiver=0 device=1 local=0 system=ISDB-S
        receiver=1 device=1 local=1 system=ISDB-T
        receiver=2 device=2 local=0 system=ISDB-S
        receiver=3 device=2 local=1 system=ISDB-T
        """;

    /// <summary>配布物の <c>asicend --list-json</c> の出力 (機材をつないでいないとき)</summary>
    public const string DiscoveryEmpty =
        """{"schema":{"name":"userland.discovery","major":1,"minor":0},"producer":{"product":"asicen","version":"1.0.0"},"scan":{"complete":true,"issues":[]},"enclosures":[],"ungrouped_usb_devices":[]}""";
}

public class AsicenTests
{
    /// <summary>
    /// 機材をつないだときの <c>asicend --list-json</c>。**観察したものではない。** dtv-userland-core の docs/json-discovery.md の例の形式で組んだ
    /// </summary>
    private static string Discovery(string enclosures, string ungrouped = "", string version = "1.0.0") =>
        $$"""{"schema":{"name":"userland.discovery","major":1,"minor":0},"producer":{"product":"asicen","version":"{{version}}"},"scan":{"complete":true,"issues":[]},"enclosures":[{{enclosures}}],"ungrouped_usb_devices":[{{ungrouped}}]}""";

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
    public async Task 機材が無いときの_list_json_は空()
    {
        var warnings = new List<string>();
        await Assert.That(AsicenUserland.ParseDiscovery(AsicenRecorded.DiscoveryEmpty, warnings.Add)).IsEmpty();
        await Assert.That(warnings).IsEmpty();
    }

    [Test]
    public async Task list_json_の筐体を読む_USB_機能が_2_つなら内蔵ハブのポートが名前になる()
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
        // 給電できるのは PX-W3U2・PX-W3U3・PX-W3U3 V2 の衛星の受信機だけ
        await Assert.That(enclosures[0].Receivers.Select(receiver => receiver.Lnb15v).ToArray()).IsEquivalentTo(new bool?[] { true, false, true, false });
        await Assert.That(enclosures[1].Receivers[0].Lnb15v).IsFalse();
    }

    [Test]
    public async Task list_json_に受信機が無ければ機種の表の並びを使う()
    {
        const string bare =
            """{"id":1,"model":null,"serial":null,"status":"ready","devices":[{"id":2,"usb":"0b06:0003","port":"2-1"}],"candidates":[]}""";
        var enclosures = AsicenUserland.ParseDiscovery(Discovery(bare), _ => { });

        await Assert.That(enclosures[0].Model).IsEqualTo("PX-S3U2");
        await Assert.That(enclosures[0].Receivers.Select(receiver => string.Join("/", receiver.Types)).ToArray()).IsEquivalentTo(new[] { "BS/CS", "GR" });
    }

    [Test]
    public async Task バージョンが違う_list_json_は使わずに理由を残す()
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
        await Assert.That(warnings[0]).Contains("status=incomplete").And.Contains("1-2.1 / 1-2.2");
        await Assert.That(warnings[1]).Contains("PX-X9");
        await Assert.That(warnings[2]).Contains("open_failed").And.Contains("4-1");
    }

    [Test]
    public async Task asicenctl_list_から機種と受信機を読む()
    {
        var w3u3 = AsicenUserland.ParseList(AsicenRecorded.ListW3u3, _ => { })!;
        await Assert.That(w3u3.Model).IsEqualTo("PX-W3U3");
        await Assert.That(w3u3.Receivers.Select(receiver => $"{receiver.Index}{string.Join("/", receiver.Types)}").ToArray())
            .IsEquivalentTo(new[] { "0BS/CS", "1GR", "2BS/CS", "3GR" });

        // PX-S3U は受信部 1 つを地上波と衛星で使う
        var s3u = AsicenUserland.ParseList(AsicenRecorded.ListS3u, _ => { })!;
        await Assert.That(s3u.Receivers.Select(receiver => string.Join("/", receiver.Types)).ToArray()).IsEquivalentTo(new[] { "GR/BS/CS" });
        await Assert.That(AsicenUserland.PowersLnb(s3u.Model)).IsFalse();

        var v2 = AsicenUserland.ParseList(AsicenRecorded.ListV2, _ => { })!;
        await Assert.That(v2.Model).IsEqualTo("PX-W3U3 V2");
        await Assert.That(AsicenUserland.PowersLnb(v2.Model)).IsTrue();

        var warnings = new List<string>();
        await Assert.That(AsicenUserland.ParseList(AsicenRecorded.ListW3u3.Replace("PX-W3U3", "PX-X9"), warnings.Add)).IsNull();
        await Assert.That(warnings[0]).Contains("PX-X9");
    }

    [Test]
    public async Task 筐体の名前は_asicend_の_instance_に通る形式だけ()
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
    public async Task sysfs_からファームウェア待ちの機材を見つけて_asicend_に渡す組にまとめる()
    {
        var root = Directory.CreateTempSubdirectory("sysfs");
        try
        {
            Usb(root, "1-2.1", "0b06", "0005");
            Usb(root, "1-2.2", "1738", "5211");
            Usb(root, "1-5", "1738", "5216");
            Usb(root, "1-3", "3275", "0080");     // PX-S1UD (siano)
            Usb(root, "usb1", "1d6b", "0002");    // ルートハブ

            var found = AsicenUserland.Scan(root.FullName);
            await Assert.That(found.Select(function => $"{function.Port} {function.Usb} {function.Loader}").ToArray())
                .IsEquivalentTo(new[] { "1-2.1 0b06:0005 False", "1-2.2 1738:5211 True", "1-5 1738:5216 True" });

            var waiting = AsicenUserland.Waiting(found);
            await Assert.That(waiting.Select(enclosure => $"{enclosure.Id}={string.Join(",", enclosure.Ports)}").ToArray())
                .IsEquivalentTo(new[] { "1-2=1-2.1,1-2.2", "1-5=1-5" });
            await Assert.That(AsicenUserland.Scan(Path.Combine(root.FullName, "none"))).IsEmpty();
        }
        finally
        {
            root.Delete(true);
        }
    }

    [Test]
    public async Task asicend_の引数は_device_と_firmware_で_給電の許可は_15V_の設定と機種が揃ったときだけ()
    {
        var firmware = Path.GetTempFileName();
        try
        {
            var w3u3 = new AsicenUserland.Enclosure("1-2", "PX-W3U3", ["1-2.1", "1-2.2"], []);
            var s3u2 = new AsicenUserland.Enclosure("1-3", "PX-S3U2", ["1-3"], []);

            await Assert.That(AsicenDaemon.Hardware("1-2", firmware, false, () => [w3u3, s3u2]))
                .IsEquivalentTo(new[] { "--device", "usb:1-2.1,1-2.2", "--firmware", firmware });
            await Assert.That(AsicenDaemon.Hardware("1-2", firmware, true, () => [w3u3, s3u2])).Contains("--allow-lnb-power");
            // PX-S3U2 は上流が給電の制御を未解明としているので、設定に 15V があっても許可しない
            await Assert.That(AsicenDaemon.Hardware("1-3", firmware, true, () => [w3u3, s3u2]))
                .IsEquivalentTo(new[] { "--device", "usb:1-3", "--firmware", firmware });

            var gone = Assert.Throws<IOException>(() => AsicenDaemon.Hardware("9-9", firmware, false, () => [w3u3]));
            await Assert.That(gone!.Message).Contains("見つかりません");
            var missing = Assert.Throws<IOException>(() => AsicenDaemon.Hardware("1-2", firmware + ".none", false, () => [w3u3]));
            await Assert.That(missing!.Message).Contains("ファームウェアがありません");
        }
        finally
        {
            File.Delete(firmware);
        }
    }

    [Test]
    public async Task 設定で_LNB_15V_と書いた筐体だけ給電を求める()
    {
        AsicenUserland.Configure(
        [
            new TunerSpec("a", ["BS", "CS"], false, "asicen:7-1:0", "15v"),
            new TunerSpec("b", ["BS", "CS"], true, "asicen:7-2:0", "15v"),
            new TunerSpec("c", ["BS", "CS"], false, "asicen:7-3:0"),
        ]);
        await Assert.That(AsicenUserland.WantsLnb("7-1")).IsTrue();
        await Assert.That(AsicenUserland.WantsLnb("7-2")).IsFalse();
        await Assert.That(AsicenUserland.WantsLnb("7-3")).IsFalse();
        AsicenUserland.Configure([]);
    }

    [Test]
    public async Task 配布物が無ければ何も挙げない()
    {
        if (Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR") is not null) return;
        await Assert.That(AsicenUserland.Installed).IsFalse();
        await Assert.That(AsicenUserland.Detect()).IsEmpty();
        await Assert.That(AsicenUserland.Cards()).IsEmpty();
    }

    [Test]
    public async Task 記録の長さは取ったときのまま()
    {
        int[] lengths =
        [
            AsicenRecorded.Hello.Length, AsicenRecorded.List.Length, AsicenRecorded.Status.Length, AsicenRecorded.TuneT27.Length,
            AsicenRecorded.TunedT27.Length, AsicenRecorded.TunedBs03.Length, AsicenRecorded.Busy.Length, AsicenRecorded.Unsupported.Length,
            AsicenRecorded.LnbDenied.Length, AsicenRecorded.Stopped.Length, AsicenRecorded.Ended.Length,
        ];
        await Assert.That(lengths).IsEquivalentTo(new[] { 61, 177, 296, 43, 54, 56, 46, 50, 55, 71, 76 });
    }

    [Test]
    public async Task TUNE_の要求は公式のクライアントが送ったバイト列と同じ()
    {
        var epoch = AsicenRecorded.Hex(AsicenRecorded.Epoch);

        // 違うのは末尾の時間切れだけ (公式のクライアントの既定は 10000 ms、こちらは 5000 ms)
        static byte[] With5s(byte[] recorded)
        {
            var copy = recorded.ToArray();
            BinaryPrimitives.WriteUInt32LittleEndian(copy.AsSpan(39), 5000);
            return copy;
        }

        var t27 = ChannelTable.Parse("T27")!;
        await Assert.That(AsicenTuner.TuneRequest(epoch, 1, t27, t27.StreamId)).IsEquivalentTo(With5s(AsicenRecorded.TuneT27));
        var bs03 = ChannelTable.Parse("BS03:16433")!;
        await Assert.That(AsicenTuner.TuneRequest(epoch, 5, bs03, bs03.StreamId)).IsEquivalentTo(With5s(AsicenRecorded.TuneBs03));
        var cs2 = ChannelTable.Parse("CS2")!;
        await Assert.That(AsicenTuner.TuneRequest(epoch, 6, cs2, cs2.StreamId)).IsEquivalentTo(With5s(AsicenRecorded.TuneCs2));
    }

    [Test]
    public async Task TUNE_の応答から選局の番号を読み_形式が違えば失敗にする()
    {
        var epoch = AsicenRecorded.Hex(AsicenRecorded.Epoch);
        await Assert.That(AsicenTuner.TuneRevision(AsicenRecorded.TunedT27, epoch, 557142857)).IsEqualTo(1UL);
        await Assert.That(AsicenTuner.TuneRevision(AsicenRecorded.TunedBs03, epoch, 1087840000)).IsEqualTo(2UL);
        await Assert.That(AsicenTuner.TuneRevision(AsicenRecorded.TunedCs4, epoch, 1653000000)).IsEqualTo(2UL);

        // 1 バイト長い・周波数が違う・epoch が違う
        Assert.Throws<UdtvShapeError>(() => AsicenTuner.TuneRevision([.. AsicenRecorded.TunedT27, 0], epoch, 557142857));
        Assert.Throws<UdtvShapeError>(() => AsicenTuner.TuneRevision(AsicenRecorded.TunedT27, epoch, 473142857));
        Assert.Throws<UdtvShapeError>(() => AsicenTuner.TuneRevision(AsicenRecorded.TunedT27, new byte[16], 557142857));
    }

    [Test]
    public async Task HELLO_の応答は_asicen_userland_1_0_0_だけを受け付ける()
    {
        await Assert.That(Convert.ToHexString(UdtvControl.ParseHello(AsicenRecorded.Hello)).ToLowerInvariant()).IsEqualTo(AsicenRecorded.Epoch);

        // バージョンが 1.0.1
        var newer = AsicenRecorded.Hello.ToArray();
        newer[^10] = (byte)'1';
        var refused = Assert.Throws<UdtvShapeError>(() => UdtvControl.ParseHello(newer));
        await Assert.That(refused!.Message).Contains("1.0.1").And.Contains("使いません");
        Assert.Throws<UdtvShapeError>(() => UdtvControl.ParseHello(AsicenRecorded.Hello.AsSpan(0, 60)));
    }

    [Test]
    public async Task エラーの応答から番号と操作と名前を読む()
    {
        var busy = Udtv.Failed(AsicenRecorded.Busy);
        await Assert.That(busy.Code).IsEqualTo(UdtvError.Busy);
        await Assert.That(busy.Operation).IsEqualTo("acquire");
        await Assert.That(busy.Label).IsEqualTo("BUSY");
        await Assert.That(busy.Message).Contains("他が使っています");

        var unsupported = Udtv.Failed(AsicenRecorded.Unsupported);
        await Assert.That(unsupported.Code).IsEqualTo(UdtvError.Unsupported);
        await Assert.That(unsupported.Operation).IsEqualTo("tune");
        await Assert.That(Udtv.Failed([1, 2, 3]).Message).Contains("読めません");
    }

    [Test]
    public async Task STREAM_END_の理由を読む()
    {
        await Assert.That(AsicenStream.Ending(AsicenRecorded.Ended)).IsEqualTo("asicend が TS を止めました");
        await Assert.That(AsicenStream.Ending([1, 2])).Contains("読めません");
    }
}

/// <summary>
/// 偽の asicend。**記録 (<see cref="AsicenRecorded"/>) のとおりに応答する。** 番号 (lease・選局の番号・ストリームの番号) と
/// 周波数だけ、要求に合わせて入れ替える
/// </summary>
internal sealed class FakeAsicend : IDisposable
{
    private readonly Socket _control;
    private readonly Socket _stream;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<ulong, ManualResetEventSlim> _stops = new();
    private ulong _lease;
    private ulong _streamId;

    public DirectoryInfo Runtime { get; } = Directory.CreateTempSubdirectory("asicen");

    /// <summary>受け取った要求 (opcode と中身) を順に</summary>
    public ConcurrentQueue<(ushort Opcode, byte[] Payload)> Requests { get; } = new();

    /// <summary>HELLO の応答。バージョン違いを試すときに入れ替える</summary>
    public byte[] Hello { get; set; } = AsicenRecorded.Hello;

    /// <summary>ACQUIRE を BUSY で断る</summary>
    public bool Busy { get; set; }

    /// <summary>TUNE を UNSUPPORTED で断る</summary>
    public bool Untunable { get; set; }

    /// <summary>LNB_POWER を UNSUPPORTED で断る (<c>--allow-lnb-power</c> なしで起動した asicend)</summary>
    public bool LnbDenied { get; set; }

    public ushort[] Opcodes => [.. Requests.Select(request => request.Opcode)];

    public FakeAsicend(string id)
    {
        var dir = Directory.CreateDirectory(Path.Combine(Runtime.FullName, "asicen-userland", "v1", id)).FullName;
        _control = Listen(Path.Combine(dir, "control.sock"), ServeControl);
        _stream = Listen(Path.Combine(dir, "stream.sock"), ServeStream);
    }

    private Socket Listen(string path, Action<Socket> serve)
    {
        var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(path));
        listener.Listen(8);
        _ = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                Socket client;
                try
                {
                    client = await listener.AcceptAsync(_stop.Token);
                }
                catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException)
                {
                    return;
                }
                _ = Task.Run(() =>
                {
                    try
                    {
                        using (client) serve(client);
                    }
                    catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
                    {
                        // クライアントが閉じた
                    }
                });
            }
        });
        return listener;
    }

    private static (ushort Opcode, uint Id, byte[] Payload) Read(Socket client)
    {
        var header = new byte[Udtv.HeaderSize];
        Udtv.Receive(client, header);
        var payload = new byte[BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(16))];
        Udtv.Receive(client, payload);
        return (BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8)), BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12)), payload);
    }

    private static void Send(Socket client, ushort opcode, ushort flags, uint id, ReadOnlySpan<byte> payload)
    {
        var frame = Udtv.Encode(opcode, id, payload);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(10), flags);
        Udtv.SendAll(client, frame);
    }

    /// <summary>記録の中の u64 を入れ替える</summary>
    private static byte[] Patch(byte[] recorded, params (int At, ulong Value)[] values)
    {
        var copy = recorded.ToArray();
        foreach (var (at, value) in values) BinaryPrimitives.WriteUInt64LittleEndian(copy.AsSpan(at), value);
        return copy;
    }

    private void ServeControl(Socket client)
    {
        ulong revision = 0;
        while (true)
        {
            var (opcode, id, payload) = Read(client);
            Requests.Enqueue((opcode, payload));
            void Ok(ReadOnlySpan<byte> body) => Send(client, opcode, Udtv.ResponseFlags, id, body);
            void Fail(byte[] body) => Send(client, opcode, Udtv.ErrorFlags, id, body);
            switch (opcode)
            {
                case Udtv.Hello:
                    Ok(Hello);
                    break;
                case Udtv.List:
                    Ok(AsicenRecorded.List);
                    break;
                case Udtv.Status:
                    Ok(AsicenRecorded.Status);
                    break;
                case Udtv.Acquire when Busy:
                    Fail(AsicenRecorded.Busy);
                    break;
                case Udtv.Acquire:
                    Ok([.. payload.AsSpan(0, 16), .. BitConverter.GetBytes(Interlocked.Increment(ref _lease))]);
                    break;
                case Udtv.Tune when Untunable:
                    Fail(AsicenRecorded.Unsupported);
                    break;
                case Udtv.Tune:
                    // 地上波の応答の記録に、要求の周波数を入れる
                    var frequency = BinaryPrimitives.ReadUInt64LittleEndian(payload.AsSpan(25));
                    Ok(Patch(AsicenRecorded.TunedT27, (16, ++revision), (24, frequency), (33, frequency)));
                    break;
                case Udtv.Start:
                    var started = Interlocked.Increment(ref _streamId);
                    _stops[started] = new ManualResetEventSlim();
                    Ok([.. payload.AsSpan(0, 16), .. BitConverter.GetBytes(started), .. new byte[16], .. BitConverter.GetBytes(5000u)]);
                    break;
                case Udtv.Stop:
                    var stopped = BinaryPrimitives.ReadUInt64LittleEndian(payload.AsSpan(24));
                    Ok(Patch(AsicenRecorded.Stopped, (16, stopped)));
                    if (_stops.TryGetValue(stopped, out var signal)) signal.Set();
                    break;
                case Udtv.Release:
                    Ok([.. payload, 1, 1, 0]);
                    break;
                case Udtv.LnbPower when LnbDenied:
                    Fail(AsicenRecorded.LnbDenied);
                    break;
                case Udtv.LnbPower:
                    Ok(payload);
                    break;
                default:
                    Fail(AsicenRecorded.Unsupported);
                    break;
            }
        }
    }

    /// <summary>ATTACH_STREAM に応答して、STOP が来るまで TS_DATA を送り、STREAM_END で終える。TS の 5 バイト目からストリームの番号を入れる</summary>
    private void ServeStream(Socket client)
    {
        var (opcode, id, payload) = Read(client);
        Requests.Enqueue((opcode, payload));
        var streamId = BinaryPrimitives.ReadUInt64LittleEndian(payload.AsSpan(24));
        Send(client, opcode, Udtv.ResponseFlags, id, [.. payload.AsSpan(0, 16), .. BitConverter.GetBytes(streamId)]);
        var stop = _stops[streamId];
        var frame = new byte[Udtv.TsPrefixSize + 188 * 4];
        BinaryPrimitives.WriteUInt64LittleEndian(frame, streamId);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(24), 188 * 4);
        for (var packet = 0; packet < 4; packet++)
        {
            var at = Udtv.TsPrefixSize + packet * 188;
            frame[at] = 0x47;
            frame[at + 1] = 0x1f;
            frame[at + 2] = 0xff;
            frame[at + 3] = 0x10;
            frame[at + 4] = (byte)streamId;
        }
        for (ulong sequence = 0; !stop.IsSet && !_stop.IsCancellationRequested; sequence++)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(frame.AsSpan(8), sequence);
            var header = Udtv.Encode(Udtv.TsData, 0, frame);
            Udtv.SendAll(client, header);
            stop.Wait(10);
        }
        Udtv.SendAll(client, Udtv.Encode(Udtv.StreamEnd, 0, Patch(AsicenRecorded.Ended, (0, streamId))));
    }

    public void Dispose()
    {
        _stop.Cancel();
        _control.Dispose();
        _stream.Dispose();
        try
        {
            Runtime.Delete(true);
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>偽の asicend (記録どおりに応答する) と通信する</summary>
[ExcludeOn(OS.Windows)]
[Timeout(60_000)]
public class AsicenTunerTests
{
    private static readonly ChannelTable.Tuning T27 = ChannelTable.Parse("T27")!;
    private static readonly ChannelTable.Tuning Bs15 = ChannelTable.Parse("BS15:16625")!;

    private static AsicenTuner Open(FakeAsicend asicend, string id, int receiver, string? lnb, string list = AsicenRecorded.ListW3u3) =>
        new(id, receiver, lnb, asicend.Runtime.FullName, () => AsicenUserland.ParseList(list, _ => { }));

    /// <summary>TS の先頭のパケットを読み、偽物が入れたストリームの番号を返す</summary>
    private static async Task<byte> ReadStream(Stream output, CancellationToken cancel)
    {
        var packet = new byte[188];
        await Task.Run(() => output.ReadExactly(packet), cancel).WaitAsync(TimeSpan.FromSeconds(10), cancel);
        if (packet[0] != 0x47) throw new InvalidDataException("TS の先頭が 0x47 ではありません");
        return packet[4];
    }

    [Test]
    public async Task 公式のクライアントと同じ並びで選局し_TS_を受け取り_止めて返す(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-1");
        var tuner = Open(asicend, "5-1", 1, null);

        tuner.Tune(T27);
        await Assert.That(await ReadStream(tuner.Output, cancel)).IsEqualTo((byte)1);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(tuner.Signal()!.Locked).IsTrue();

        // 選局し直すと、止めて返してから、繋ぎ直して最初からやり直す
        tuner.Tune(ChannelTable.Parse("T21")!);
        await Assert.That(await ReadStream(tuner.Output, cancel)).IsEqualTo((byte)2);
        tuner.Dispose();
        await Assert.That(tuner.Tuned).IsFalse();

        ushort[] once = [Udtv.Hello, Udtv.List, Udtv.Status, Udtv.Acquire, Udtv.Tune, Udtv.Start, Udtv.AttachStream, Udtv.Stop, Udtv.Release];
        await Assert.That(asicend.Opcodes).IsEquivalentTo([.. once, .. once]);

        // 中身も記録と同じ: ACQUIRE は epoch と受信機の番号、TUNE は記録の時間切れだけ違うもの
        var requests = asicend.Requests.ToArray();
        await Assert.That(Convert.ToHexString(requests[3].Payload).ToLowerInvariant()).IsEqualTo(AsicenRecorded.Epoch + "0100");
        var tune = AsicenRecorded.TuneT27.ToArray();
        BinaryPrimitives.WriteUInt32LittleEndian(tune.AsSpan(39), 5000);
        await Assert.That(requests[4].Payload).IsEquivalentTo(tune);
        await Assert.That(requests[2].Payload).IsEquivalentTo(AsicenRecorded.Hex(AsicenRecorded.Epoch + "000000000000000000"));
    }

    [Test]
    public async Task 受信機が使われていれば理由を添えて失敗し_何も残さない(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-2") { Busy = true };
        using var tuner = Open(asicend, "5-2", 1, null);

        var error = Assert.Throws<UdtvError>(() => tuner.Tune(T27));
        await Assert.That(error!.Message).Contains("受信機 1 を取れません").And.Contains("BUSY");
        await Assert.That(tuner.Tuned).IsFalse();
        // 失敗したあとは RELEASE を送らずに閉じる (公式のクライアントと同じ)
        await Assert.That(asicend.Opcodes).IsEquivalentTo(new[] { Udtv.Hello, Udtv.List, Udtv.Status, Udtv.Acquire });
    }

    [Test]
    public async Task 選局を断られたら接続を閉じ_次の選局は最初からやり直す(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-3") { Untunable = true };
        using var tuner = Open(asicend, "5-3", 1, null);

        var error = Assert.Throws<UdtvError>(() => tuner.Tune(T27));
        await Assert.That(error!.Code).IsEqualTo(UdtvError.Unsupported);

        asicend.Untunable = false;
        tuner.Tune(T27);
        await Assert.That(await ReadStream(tuner.Output, cancel)).IsEqualTo((byte)1);
    }

    [Test]
    public async Task バージョンが違う_asicend_には_HELLO_のあと何も送らない(CancellationToken cancel)
    {
        await Task.Yield();
        var newer = AsicenRecorded.Hello.ToArray();
        newer[^10] = (byte)'1';
        using var asicend = new FakeAsicend("5-4") { Hello = newer };
        using var tuner = Open(asicend, "5-4", 1, null);

        var error = Assert.Throws<UdtvShapeError>(() => tuner.Tune(T27));
        await Assert.That(error!.Message).Contains("1.0.1");
        await Assert.That(asicend.Opcodes).IsEquivalentTo(new[] { Udtv.Hello });
    }

    [Test]
    public async Task 地上波の受信機に衛星はリクエストしない(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-5");
        using var tuner = Open(asicend, "5-5", 1, null);

        var error = Assert.Throws<IOException>(() => tuner.Tune(Bs15));
        await Assert.That(error!.Message).Contains("GR 用");
        await Assert.That(asicend.Opcodes).IsEmpty();
    }

    [Test]
    public async Task LNB_15V_の設定があり給電できる機種なら_衛星の選局の前に給電し_閉じるときに切る(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-6");
        var tuner = Open(asicend, "5-6", 0, "15v");

        tuner.Tune(Bs15);
        await ReadStream(tuner.Output, cancel);
        tuner.Dispose();

        // LNB_POWER は asicenctl lnb-on と同じく、別の接続で HELLO・LIST・STATUS のあとに送る。中身は epoch と 1 バイト
        var lnb = asicend.Requests.Where(request => request.Opcode == Udtv.LnbPower).Select(request => Convert.ToHexString(request.Payload).ToLowerInvariant()).ToArray();
        await Assert.That(lnb).IsEquivalentTo(new[] { AsicenRecorded.Epoch + "01", AsicenRecorded.Epoch + "00" });
        await Assert.That(asicend.Opcodes.Take(4).ToArray()).IsEquivalentTo(new[] { Udtv.Hello, Udtv.List, Udtv.Status, Udtv.LnbPower });
        // TUNE の中身は給電しないときと同じ (LNB の欄には触らない)
        var tune = asicend.Requests.First(request => request.Opcode == Udtv.Tune).Payload;
        await Assert.That(tune.AsSpan(36, 3).ToArray()).IsEquivalentTo(new byte[] { 0, 0, 0 });
    }

    [Test]
    public async Task LNB_15V_の設定が無ければ給電しない(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-7");
        using var tuner = Open(asicend, "5-7", 0, null);

        tuner.Tune(Bs15);
        await ReadStream(tuner.Output, cancel);
        await Assert.That(asicend.Opcodes).DoesNotContain(Udtv.LnbPower);
    }

    [Test]
    public async Task 給電を操作できない機種は_15V_と書いてあっても給電せずに選局して画面に理由を出す(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-8");
        var tuner = Open(asicend, "5-8", 0, "15v", AsicenRecorded.ListS3u);

        tuner.Tune(Bs15);
        await ReadStream(tuner.Output, cancel);
        await Assert.That(asicend.Opcodes).DoesNotContain(Udtv.LnbPower);
        await Assert.That(TunerNotice.Get("asicen:5-8:0")).Contains("PX-S3U").And.Contains("15V");
        tuner.Dispose();
        await Assert.That(TunerNotice.Get("asicen:5-8:0")).IsNull();
    }

    [Test]
    public async Task 給電を許可せずに起動した_asicend_に断られたら選局を失敗にする(CancellationToken cancel)
    {
        await Task.Yield();
        using var asicend = new FakeAsicend("5-9") { LnbDenied = true };
        using var tuner = Open(asicend, "5-9", 0, "15v");

        var error = Assert.Throws<IOException>(() => tuner.Tune(Bs15));
        await Assert.That(error!.Message).Contains("LNB の給電を断りました");
        await Assert.That(asicend.Opcodes).DoesNotContain(Udtv.Acquire);
    }
}

/// <summary>
/// 上流の模擬のデーモン (<c>asicend-mock</c>) と通信する。**ASICEN_USERLAND_DIR に組んだものがあるときだけ**
/// (CI の asicen-userland のビルド、または手元のコンテナ)。模擬は配布物に入っていないので、ソースから組む。
/// 模擬の TS は空パケットで、カードには対応していない。**模擬は実機ではない。**
/// </summary>
[ExcludeOn(OS.Windows)]
[Timeout(120_000)]
public class AsicenMockTests
{
    /// <summary>組んだ asicen-userland の場所。**指してあるのに asicend-mock が無ければ失敗にする** (CI で気づかないまま飛ばさない)</summary>
    private static string? Built => Environment.GetEnvironmentVariable("ASICEN_USERLAND_DIR");

    private static async Task Stream(AsicenTuner tuner, string channel, CancellationToken cancel)
    {
        tuner.Tune(ChannelTable.Parse(channel)!);
        var packet = new byte[188];
        await Task.Run(() => tuner.Output.ReadExactly(packet), cancel).WaitAsync(TimeSpan.FromSeconds(10), cancel);
        await Assert.That(packet[0]).IsEqualTo((byte)0x47);
        await Assert.That(tuner.Tuned).IsTrue();
    }

    [Test]
    [Arguments("w3u3", "PX-W3U3", "BS/CS GR BS/CS GR")]
    [Arguments("w3u2", "PX-W3U2", "BS/CS GR BS/CS GR")]
    [Arguments("w3u3-v2", "PX-W3U3 V2", "BS/CS GR BS/CS GR")]
    [Arguments("s3u2", "PX-S3U2", "BS/CS GR")]
    [Arguments("s3u", "PX-S3U", "GR/BS/CS")]
    public async Task 模擬の_asicend_を起動して_機種と受信機を問い合わせ_選局して_TS_を受け取り_選局し直す(
        string mock, string model, string receivers, CancellationToken cancel)
    {
        await Task.Yield();
        if (Built is not { } dir)
        {
            Skip.Test("ASICEN_USERLAND_DIR が指されていません");
            return;
        }
        // Unix ソケットのパスは短く (108 バイトまで)
        var runtime = Directory.CreateTempSubdirectory("asicen");
        var id = $"6-{mock.Length}{mock[^1] % 7}";
        var powers = AsicenUserland.PowersLnb(model);
        var daemon = new AsicenDaemon(id, dir, runtime.FullName, () => ["--model", mock, .. powers ? ["--allow-lnb-power"] : Array.Empty<string>()], "asicend-mock");
        try
        {
            daemon.Ensure();
            await Assert.That(daemon.Listed!.Model).IsEqualTo(model);
            await Assert.That(string.Join(" ", daemon.Listed.Receivers.Select(receiver => string.Join("/", receiver.Types)))).IsEqualTo(receivers);

            // 地上波: PX-S3U は受信機 0、ほかは受信機 1
            var terrestrial = daemon.Listed.Receivers.First(receiver => receiver.Terrestrial).Index;
            using (var tuner = new AsicenTuner(id, terrestrial, null, runtime.FullName, () => daemon.Listed))
            {
                await Stream(tuner, "T27", cancel);
                await Stream(tuner, "T21", cancel);
            }

            // 衛星: 15V の設定つき。給電できる機種は LNB_POWER が通り、できない機種は給電せずに選局する
            using (var tuner = new AsicenTuner(id, 0, "15v", runtime.FullName, () => daemon.Listed))
            {
                await Stream(tuner, "BS15:16625", cancel);
                await Stream(tuner, "CS2", cancel);
                var (_, status) = Shell.Run(AsicenUserland.Bin(dir, "asicenctl"), ["--runtime-dir", runtime.FullName, "--instance", id, "status"], TimeSpan.FromSeconds(5));
                await Assert.That(status).Contains($"\"lnb_15v_enabled\":{(powers ? "true" : "false")}");
                await Assert.That(status).Contains("\"selection\":{\"kind\":\"slot\",\"value\":0}");
            }
            if (powers)
            {
                var (_, after) = Shell.Run(AsicenUserland.Bin(dir, "asicenctl"), ["--runtime-dir", runtime.FullName, "--instance", id, "status"], TimeSpan.FromSeconds(5));
                await Assert.That(after).Contains("\"lnb_15v_enabled\":false");
                // 閉じたあとは受信機が返っている
                await Assert.That(after).DoesNotContain("\"leased\":true");
            }
        }
        finally
        {
            daemon.Stop();
            runtime.Delete(true);
        }
    }

    [Test]
    public async Task 給電を許可せずに起動した模擬には_LNB_の給電を断られる(CancellationToken cancel)
    {
        await Task.Yield();
        if (Built is not { } dir)
        {
            Skip.Test("ASICEN_USERLAND_DIR が指されていません");
            return;
        }
        var runtime = Directory.CreateTempSubdirectory("asicen");
        var daemon = new AsicenDaemon("6-99", dir, runtime.FullName, () => [], "asicend-mock");
        try
        {
            daemon.Ensure();
            using var tuner = new AsicenTuner("6-99", 0, "15v", runtime.FullName, () => daemon.Listed);
            var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS15:16625")!));
            await Assert.That(error!.Message).Contains("LNB の給電を断りました");

            // 同じ受信機を 2 つの接続で取ると、あとのほうが BUSY で断られる
            using var first = new AsicenTuner("6-99", 1, null, runtime.FullName, () => daemon.Listed);
            await Task.Run(() => first.Tune(ChannelTable.Parse("T27")!), cancel);
            using var second = new AsicenTuner("6-99", 1, null, runtime.FullName, () => daemon.Listed);
            var busy = Assert.Throws<UdtvError>(() => second.Tune(ChannelTable.Parse("T21")!));
            await Assert.That(busy!.Code).IsEqualTo(UdtvError.Busy);
        }
        finally
        {
            daemon.Stop();
            runtime.Delete(true);
        }
    }
}
