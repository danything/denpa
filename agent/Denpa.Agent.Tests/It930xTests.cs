namespace Denpa.Agent.Tests;

/*
 * IT930x のブリッジ (It930xFrame.cs・It930xBridge.cs・It930xFirmware.cs)、機種の表 (It930x.cs)、実機で試す入口 (It930xProbe.cs)。
 * 偽の USB (It930xFakes.cs) の上で、コマンドの形と順番を ITE の SDK と照らす。期待値に添えた関数名は SDK のもの。
 */
public class It930xTests
{
    private static (It930xBridge Bridge, List<int> Sleeps) Bridge(FakeIt930x usb)
    {
        var sleeps = new List<int>();
        return (new It930xBridge(usb, sleeps.Add), sleeps);
    }

    // ---------------------------------------------------------------------
    // フレーム (BrCmd_addChecksum・BrCmd_removeChecksum)
    // ---------------------------------------------------------------------

    [Test]
    public async Task チェックサムは_2_バイトずつ上位から足して反転する()
    {
        // 0x0022 + 0x0501 = 0x0523 → 反転して 0xFADC (偶数の長さ)
        await Assert.That(It930xFrame.Checksum([0x00, 0x22, 0x05, 0x01])).IsEqualTo((ushort)0xFADC);
        // 0x0023 + 0x0700 (余った 1 バイトは上位に置く) = 0x0723 → 0xF8DC (奇数の長さ)
        await Assert.That(It930xFrame.Checksum([0x00, 0x23, 0x07])).IsEqualTo((ushort)0xF8DC);
        // 0xFFFF + 0xFFFF + 0x0100 = 0x200FE → 桁あふれを捨てて 0x00FE → 0xFF01
        await Assert.That(It930xFrame.Checksum([0xFF, 0xFF, 0xFF, 0xFF, 0x01])).IsEqualTo((ushort)0xFF01);
    }

    [Test]
    public async Task フレームの先頭は全体の長さから_1_を引いた値()
    {
        // QUERYINFO、シーケンス番号 5、中身 1 (IT9300_getFirmwareVersion)
        await Assert.That(It930xFrame.Build(0x0022, 5, [1])).IsEquivalentTo(new byte[] { 0x06, 0x00, 0x22, 0x05, 0x01, 0xFA, 0xDC });
        // BOOT、シーケンス番号 7、中身なし
        await Assert.That(It930xFrame.Build(0x0023, 7, [])).IsEquivalentTo(new byte[] { 0x05, 0x00, 0x23, 0x07, 0xF8, 0xDC });
    }

    [Test]
    public async Task _63_バイトを超えるフレームは作らない()
    {
        await Assert.That(It930xFrame.Build(0x0029, 0, new byte[57]).Length).IsEqualTo(63);
        Assert.Throws<ArgumentOutOfRangeException>(() => It930xFrame.Build(0x0029, 0, new byte[58]));
    }

    private static byte[] Reply(byte status, params byte[] data)
    {
        var reply = new byte[5 + data.Length];
        reply[0] = (byte)(reply.Length - 1);
        reply[1] = 3;
        reply[2] = status;
        data.CopyTo(reply, 3);
        var checksum = FakeIt930x.Sum(reply.AsSpan(1, reply.Length - 3));
        reply[^2] = (byte)(checksum >> 8);
        reply[^1] = (byte)checksum;
        return reply;
    }

    [Test]
    public async Task 応答の長さとチェックサムと状態を確かめる()
    {
        await Assert.That(It930xFrame.Parse(Reply(0, 0x12, 0x34), 2, 0)).IsEquivalentTo(new byte[] { 0x12, 0x34 });
        var shortReply = Assert.Throws<It930xException>(() => It930xFrame.Parse(Reply(0, 0x12), 2, 0));
        await Assert.That(shortReply.Message).Contains("長さ 6 バイト、期待は 7 バイト");
        var broken = Reply(0, 0x12, 0x34);
        broken[^1] ^= 0x01;
        var checksum = Assert.Throws<It930xException>(() => It930xFrame.Parse(broken, 2, 0));
        await Assert.That(checksum.Message).Contains("チェックサム");
        var status = Assert.Throws<It930xException>(() => It930xFrame.Parse(Reply(0x05, 0x12, 0x34), 2, 0x0001));
        await Assert.That(status.Message).Contains("状態 0x05");
    }

    // ---------------------------------------------------------------------
    // コマンドとレジスタ (BrCmd_readRegisters・BrCmd_writeRegisters)
    // ---------------------------------------------------------------------

    [Test]
    public async Task シーケンス番号は_0xFF_の次は_0()
    {
        // 偽物がシーケンス番号を 0 から 1 ずつ数えて確かめる
        var usb = new FakeIt930x();
        var (bridge, _) = Bridge(usb);
        for (var i = 0; i < 300; i++) bridge.ReadRegister(0x1222);
        await Assert.That(bridge.Commands).IsEqualTo(300);
    }

    [Test]
    public async Task 長い書き込みは_51_バイトずつ_読み出しは_58_バイトずつに分ける()
    {
        var usb = new FakeIt930x();
        var (bridge, _) = Bridge(usb);
        var data = Enumerable.Range(0, 120).Select(i => (byte)i).ToArray();
        bridge.WriteRegisters(0x4994, data);
        await Assert.That(usb.Log).IsEquivalentTo(new[]
        {
            $"W 4994={Convert.ToHexString(data, 0, 51)}",
            $"W 49C7={Convert.ToHexString(data, 51, 51)}",
            $"W 49FA={Convert.ToHexString(data, 102, 18)}",
        });
        usb.Log.Clear();
        await Assert.That(bridge.ReadRegisters(0x4994, 120)).IsEquivalentTo(data);
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "R 4994 58", "R 49CE 58", "R 4A08 4" });
    }

    [Test]
    public async Task 番地が_0xFF_までなら番地の長さは_1()
    {
        // 偽物が番地の長さを確かめる (IT9300_readRegisters)
        var usb = new FakeIt930x();
        var (bridge, _) = Bridge(usb);
        usb.Registers[0x00FF] = 0xAB;
        usb.Registers[0x0100] = 0xCD;
        await Assert.That(bridge.ReadRegister(0x00FF)).IsEqualTo((byte)0xAB);
        await Assert.That(bridge.ReadRegister(0x0100)).IsEqualTo((byte)0xCD);
    }

    [Test]
    public async Task 応答が壊れていればそのコマンドを失敗にする()
    {
        var usb = new FakeIt930x { CorruptNext = true };
        var (bridge, _) = Bridge(usb);
        Assert.Throws<It930xException>(() => bridge.ReadRegister(0x1222));
        usb.StatusNext = 0x02;
        var status = Assert.Throws<It930xException>(() => bridge.WriteRegister(0xF103, 7));
        await Assert.That(status.Message).Contains("状態 0x02");
        // 次のコマンドは通る
        await Assert.That(bridge.ReadRegister(0x1222)).IsEqualTo((byte)0);
    }

    [Test]
    public async Task 時間切れのあとに遅れて届いた応答は捨てる()
    {
        var usb = new FakeIt930x { Silent = 1, KeepLate = true, Running = 0x01020304 };
        var (bridge, _) = Bridge(usb);
        var timeout = Assert.Throws<It930xException>(() => bridge.Version());
        await Assert.That(timeout.Message).Contains("応答がありません");
        // 遅れて届いた QUERYINFO の応答を、レジスタの読み出しの応答と取り違えない
        usb.Registers[0x1222] = 0x5A;
        await Assert.That(bridge.ReadRegister(0x1222)).IsEqualTo((byte)0x5A);
    }

    [Test]
    public async Task 壊れた応答のあとも遅れて届いた応答を捨てる()
    {
        // 1 つ目の応答を壊し、その応答が遅れてもう 1 つ届いた形にする
        var usb = new FakeIt930x { CorruptNext = true };
        var (bridge, _) = Bridge(usb);
        Assert.Throws<It930xException>(() => bridge.ReadRegister(0x1222));
        usb.Late(new byte[] { 0x05, 0x00, 0x00, 0xAA, 0x00, 0x00 });
        usb.Registers[0x1222] = 0x5A;
        await Assert.That(bridge.ReadRegister(0x1222)).IsEqualTo((byte)0x5A);
    }

    [Test]
    public async Task probe_の_port_に値が無ければ使い方を出す()
    {
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--port"])).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--port", "--trace"])).IsNull();
        await Assert.That(It930xProbe.Parse(["--it930x-probe", "--port", "1-2", "--trace"]))
            .IsEqualTo(new It930xProbe.Options("1-2", true, null));
        await Assert.That(It930xProbe.Parse(["--it930x-probe"])).IsEqualTo(new It930xProbe.Options(null, false, null));
    }

    // ---------------------------------------------------------------------
    // ファームウェア (_IT9300_loadFirmware・IT9300_initialize・IT9300_reboot)
    // ---------------------------------------------------------------------

    [Test]
    public async Task 区切りの表は_46_個で合計は同梱のファームウェアと同じ_2169_バイト()
    {
        await Assert.That(It930xFirmware.Segments.Count).IsEqualTo(46);
        await Assert.That(It930xFirmware.Segments.Count(length => length == 48)).IsEqualTo(44);
        await Assert.That(It930xFirmware.Segments.Sum()).IsEqualTo(2169);
        await Assert.That(It930xFirmware.Code.Length).IsEqualTo(2169);
    }

    [Test]
    public async Task 同梱のものと違うファームウェアは使わない()
    {
        var changed = (byte[])It930xFirmware.Code.Clone();
        changed[100] ^= 0xFF;
        var sha = Assert.Throws<InvalidDataException>(() => It930xFirmware.Check(changed));
        await Assert.That(sha.Message).Contains("SHA-256");
        // SHA-256 が合っても、長さが区切りと合わなければ使わない (受理する SHA-256 を差し替えて確かめる)
        var shorter = It930xFirmware.Code[..2000];
        var segments = Assert.Throws<InvalidDataException>(() => It930xFirmware.Check(shorter, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(shorter))));
        await Assert.That(segments.Message).Contains("区切りが合いません");
    }

    private static readonly string[] Prepare =
    [
        "W 4976=00", "W 4BFB=00", "W 4978=00", "W 4977=00", "W F103=07",
    ];

    [Test]
    public async Task 動いていなければ_SCATTER_WRITE_を_46_回送って_BOOT_し_20_ms_待ってから確かめる()
    {
        var usb = new FakeIt930x();
        var (bridge, sleeps) = Bridge(usb);
        var boot = bridge.Start(It930xFirmware.Code);
        await Assert.That(boot).IsEqualTo(new It930xBoot(0, false, FakeIt930x.BootVersion));
        var expected = new List<string> { "QUERYINFO" };
        expected.AddRange(Prepare);
        expected.AddRange(It930xFirmware.Segments.Select(length => $"SCATTER {length}"));
        expected.Add("BOOT");
        expected.Add("QUERYINFO");
        await Assert.That(usb.Log).IsEquivalentTo(expected);
        // 区切りの中身は、ファームウェアを先頭から区切りどおりに並べたもの
        await Assert.That(usb.Loaded.ToArray()).IsEquivalentTo(It930xFirmware.Code);
        await Assert.That(sleeps).IsEquivalentTo(new[] { 20 });
        await Assert.That(It930xBoot.Format(boot.Version)).IsEqualTo("1.4.0.0");
    }

    [Test]
    public async Task 前のファームウェアが動いていれば_REBOOT_して_0_に戻ったのを確かめてから読み込む()
    {
        var usb = new FakeIt930x { Running = FakeIt930x.BootVersion };
        var (bridge, sleeps) = Bridge(usb);
        var boot = bridge.Start(It930xFirmware.Code);
        await Assert.That(boot).IsEqualTo(new It930xBoot(FakeIt930x.BootVersion, true, FakeIt930x.BootVersion));
        await Assert.That(usb.Log.Take(4)).IsEquivalentTo(new[] { "QUERYINFO", "REBOOT", "QUERYINFO", "W 4976=00" });
        await Assert.That(sleeps).IsEquivalentTo(new[] { 10, 20 });
    }

    [Test]
    public async Task REBOOT_のあと応答が戻るまで_10_ms_ごとに待つ()
    {
        var usb = new FakeIt930x { Running = FakeIt930x.BootVersion, SilentAfterReboot = 2 };
        var (bridge, sleeps) = Bridge(usb);
        bridge.Reboot();
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "REBOOT", "QUERYINFO", "QUERYINFO", "QUERYINFO" });
        await Assert.That(sleeps).IsEquivalentTo(new[] { 10, 10, 10 });
    }

    [Test]
    public async Task REBOOT_のあと_30_回応答しなければ失敗()
    {
        var usb = new FakeIt930x { Running = FakeIt930x.BootVersion, SilentAfterReboot = 30 };
        var (bridge, _) = Bridge(usb);
        var error = Assert.Throws<It930xException>(bridge.Reboot);
        await Assert.That(error.Message).Contains("REBOOT のあと応答しません");
        await Assert.That(usb.Log.Count(line => line == "QUERYINFO")).IsEqualTo(30);
    }

    [Test]
    public async Task REBOOT_のあともバージョンが_0_でなければ失敗()
    {
        var usb = new FakeIt930x { Running = FakeIt930x.BootVersion, RebootKeepsRunning = true };
        var (bridge, _) = Bridge(usb);
        var error = Assert.Throws<It930xException>(() => bridge.Start(It930xFirmware.Code));
        await Assert.That(error.Message).Contains("REBOOT のあとも、ファームウェアが動いています");
        await Assert.That(usb.Log).DoesNotContain("BOOT");
    }

    [Test]
    public async Task BOOT_のあとのバージョンが_0_なら失敗()
    {
        var usb = new FakeIt930x { BootFails = true };
        var (bridge, _) = Bridge(usb);
        var error = Assert.Throws<It930xException>(() => bridge.Start(It930xFirmware.Code));
        await Assert.That(error.Message).Contains("起動しませんでした");
    }

    // ---------------------------------------------------------------------
    // 機種の表と探し方
    // ---------------------------------------------------------------------

    [Test]
    public async Task MLT5_系の_3_機種を_USB_の_ID_で見分ける()
    {
        await Assert.That(It930x.Find(0x0511, 0x084E)?.Name).IsEqualTo("PLEX PX-MLT5U");
        await Assert.That(It930x.Find(0x0511, 0x024E)?.Name).IsEqualTo("PLEX PX-MLT5PE");
        await Assert.That(It930x.Find(0x0511, 0x924E)?.Name).IsEqualTo("e-Better DTV02A-5TS-P");
        // PX-MLT8UT (0511:0051) は扱わない (IT930x の仕様書 1.1 の範囲の外)
        await Assert.That(It930x.Find(0x0511, 0x0051)).IsNull();
    }

    [Test]
    public async Task sysfs_から_MLT5_系だけを並べる()
    {
        // sysfs は Linux だけ (インターフェースの名前の「:」は Windows のファイル名に使えない)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("it930xsysfs");
        try
        {
            void Usb(string name, string vendor, string product)
            {
                var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
                File.WriteAllText(Path.Combine(at, "idVendor"), vendor + "\n");
                File.WriteAllText(Path.Combine(at, "idProduct"), product + "\n");
            }
            Usb("1-2", "0511", "084e");
            Usb("1-3", "0511", "0051");
            Usb("1-4", "0511", "924e");
            Usb("1-2:1.0", "0511", "084e");
            var found = It930x.Found(new SysfsUsbHost(dir.FullName), null);
            await Assert.That(found.Select(item => $"{item.Port} {item.Model.Name}"))
                .IsEquivalentTo(new[] { "1-2 PLEX PX-MLT5U", "1-4 e-Better DTV02A-5TS-P" });
        }
        finally
        {
            dir.Delete(true);
        }
    }

    // ---------------------------------------------------------------------
    // --it930x-probe
    // ---------------------------------------------------------------------

    [Test]
    public async Task probe_はチップと_EEPROM_の写しを読んでからファームウェアを起動する()
    {
        var usb = new FakeIt930x();
        usb.Registers[It930xProbe.ChipVersion] = 0x02;
        usb.Registers[It930xProbe.ChipVersion + 1] = 0x06;
        usb.Registers[It930xProbe.ChipVersion + 2] = 0x93;
        usb.Registers[It930xProbe.EepromValid] = 0x01;
        usb.Registers[It930xProbe.EepromCopy + 0x54] = 0x51;
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => usb, () => It930xFirmware.Code, output, _ => { }, null);
        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains("chip_version 0x02、種類 0x9306");
        await Assert.That(text).Contains("有効の印 0x01");
        await Assert.That(text).Contains("  +50: 00000000510000000000000000000000");
        await Assert.That(text).Contains("起動し 1.4.0.0 (0x01040000)");
        // EEPROM の写しは、ファームウェアを読み込む前に読む (SDK と同じ順)
        await Assert.That(usb.Log.IndexOf("R 4994 58")).IsLessThan(usb.Log.IndexOf("SCATTER 48"));
        // 復調器とチューナーには触らない (I2C の中継のコマンドを送らない。偽物は知らないコマンドで失敗する)
        await Assert.That(usb.Log.Count(line => line.StartsWith("W ", StringComparison.Ordinal))).IsEqualTo(Prepare.Length);
    }

    [Test]
    public async Task REBOOT_のあとの読み書きがふつうの失敗でも_つなぎ直されたものとして開き直す()
    {
        // PX-Q3PE4 は REBOOT で USB から外れ、その間の QUERYINFO は EPROTO (抜けではない IOException) になった
        var first = new FakeIt930x { Running = FakeIt930x.BootVersion, RebootGone = true, GoneAsProtocolError = true };
        var second = new FakeIt930x();
        var opened = 0;
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => ++opened == 1 ? first : second, () => It930xFirmware.Code, output, _ => { }, null);
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(opened).IsEqualTo(2);
        await Assert.That(output.ToString()).Contains("REBOOT のあと USB がつなぎ直されました");
    }

    [Test]
    public async Task probe_は_REBOOT_で_USB_がつなぎ直されたら_1_回だけ開き直す()
    {
        var first = new FakeIt930x { Running = FakeIt930x.BootVersion, RebootGone = true };
        var second = new FakeIt930x();
        var opened = 0;
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => ++opened == 1 ? first : second, () => It930xFirmware.Code, output, _ => { }, null);
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(opened).IsEqualTo(2);
        await Assert.That(output.ToString()).Contains("REBOOT のあと USB がつなぎ直されました");
        // 終わりに REBOOT して、ファームウェアが動いていない状態に戻す
        await Assert.That(second.Log.TakeLast(4)).IsEquivalentTo(new[] { "BOOT", "QUERYINFO", "REBOOT", "QUERYINFO" });
        await Assert.That(second.Running).IsEqualTo(0u);
        await Assert.That(output.ToString()).Contains("USB はつなぎ直されませんでした");
    }

    [Test]
    public async Task probe_は止まった理由を出して_1_で終わる()
    {
        var usb = new FakeIt930x { BootFails = true };
        var output = new StringWriter();
        var code = It930xProbe.Execute(() => usb, () => It930xFirmware.Code, output, _ => { }, null);
        await Assert.That(code).IsEqualTo(1);
        await Assert.That(output.ToString()).Contains("止まりました: IT930x のファームウェアが起動しませんでした");
    }
}
