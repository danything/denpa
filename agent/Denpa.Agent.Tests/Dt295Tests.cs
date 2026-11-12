namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 の名前と検出 (Dt295.cs)。機材の設定・選局・カードは Dt295NativeTests.cs・Dt295NativeCardTests.cs。
 */
public class Dt295Tests
{
    // ---------------------------------------------------------------------
    // 名前と検出
    // ---------------------------------------------------------------------

    [Test]
    public async Task 設定の_device_は_dt295_とポート()
    {
        await Assert.That(Dt295.Device("4-12.1")).IsEqualTo("dt295:4-12.1");
        await Assert.That(Dt295.Parse("dt295:4-12.1")).IsEqualTo("4-12.1");
        await Assert.That(Dt295.Parse("dt295:abc")).IsNull();
        await Assert.That(Dt295.Parse("zd1j:4-12.1")).IsNull();
        await Assert.That(Dt295.Is("dt295:1-2")).IsTrue();
        await Assert.That(Dt295.Is(null)).IsFalse();
    }

    private static void Usb(DirectoryInfo dir, string name, string vendor, string product)
    {
        var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
        File.WriteAllText(Path.Combine(at, "idVendor"), vendor + "\n");
        File.WriteAllText(Path.Combine(at, "idProduct"), product + "\n");
    }

    [Test]
    public async Task sysfs_から_06b8_103b_だけを並べる()
    {
        // sysfs は Linux だけ (インターフェースの名前の「:」は Windows のファイル名に使えない)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("dt295sysfs");
        try
        {
            Usb(dir, "1-2", "06b8", "103b");
            Usb(dir, "1-3", "054c", "04b2");
            Usb(dir, "1-2:1.0", "06b8", "103b");
            Usb(dir, "2-1.4", "06b8", "103b");
            await Assert.That(Dt295.Ports(new SysfsUsbHost(dir.FullName), null)).IsEquivalentTo(new[] { "1-2", "2-1.4" });
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    [Arguments(0x06B8, 0x103B, "PIXELA PIX-DT295", true)]
    [Arguments(0x06B8, 0x103C, "PIXELA PIX-DT295 W", false)]
    [Arguments(0x06B8, 0x1038, "PIXELA PIX-DT420", false)]
    [Arguments(0x06B8, 0x1039, "PIXELA PIX-DT410", false)]
    [Arguments(0x04C5, 0x202F, "PIX-DTxxx (SPI モード)", false)]
    public async Task 公式_INF_の_ID_を見分けて_DT295_だけを使う(int vendor, int product, string name, bool supported)
    {
        var model = Dt295.Find(vendor, product);
        await Assert.That(model).IsNotNull();
        await Assert.That(model!.Name).IsEqualTo(name);
        await Assert.That(model.Supported).IsEqualTo(supported);
    }

    [Test]
    public async Task 未確認の機材は_USB_に触らずに断る()
    {
        var opened = 0;
        IUsbDevice Open(Dt295Model model)
        {
            opened++;
            return new Dt295Fake();
        }
        foreach (var model in Dt295.Family.Where(model => !model.Supported))
        {
            var error = Assert.Throws<IOException>(() => Dt295.OpenUsb("3-1", _ => model, Open));
            await Assert.That(error.Message).Contains(model.Name);
            await Assert.That(error.Message).Contains("未確認");
        }
        Assert.Throws<IOException>(() => Dt295.OpenUsb("3-1", _ => null, Open));
        await Assert.That(opened).IsEqualTo(0);
    }

    [Test]
    public async Task sysfs_から同じドライバーの機材を見分けて並べる()
    {
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("dt295family");
        try
        {
            Usb(dir, "1-1", "06b8", "103b");
            Usb(dir, "1-2", "06b8", "103c");
            Usb(dir, "1-3", "06b8", "1038");
            Usb(dir, "1-6", "06b8", "103a");
            await Assert.That(Dt295.Identify(new SysfsUsbHost(dir.FullName), "1-3")?.Name).IsEqualTo("PIXELA PIX-DT420");
            await Assert.That(Dt295.Identify(new SysfsUsbHost(dir.FullName), "1-6")).IsNull();
            List<string> warnings = [];
            await Assert.That(Dt295.Ports(new SysfsUsbHost(dir.FullName), warnings.Add)).IsEquivalentTo(new[] { "1-1" });
            await Assert.That(warnings.Count).IsEqualTo(2);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task dt295_の_device_は開かずに_Dt295NativeTuner_にする()
    {
        using var tuner = TunerPool.OpenDevice("dt295:1-2", null);
        await Assert.That(tuner).IsTypeOf<Dt295NativeTuner>();
        await Assert.That(tuner.Tuned).IsFalse();
        Assert.Throws<IOException>(() => TunerPool.OpenDevice("dt295:bad", null));
    }

    [Test]
    public async Task card_は_PIX_DT295_が無くても_1_行出し_どんな失敗も行にする()
    {
        var none = new StringWriter();
        Dt295.DescribeCards([], none);
        await Assert.That(none.ToString().Trim()).IsEqualTo("PIXELA PIX-DT295: 見つかりません");

        var output = new StringWriter();
        Dt295.DescribeCards(
        [
            new CardLinkCandidate("PIXELA PIX-DT295 9-15 Card Reader", () => throw new DllNotFoundException("IOKit を読み込めません")),
            new CardLinkCandidate("PIXELA PIX-DT295 9-16 Card Reader", () => throw new IOException("usb 9-16 を開けません")),
        ], output);
        var lines = output.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        await Assert.That(lines.Length).IsEqualTo(2);
        await Assert.That(lines[0]).StartsWith("内蔵 PIXELA PIX-DT295 9-15 Card Reader: DllNotFoundException: IOKit を読み込めません (");
        await Assert.That(lines[1]).StartsWith("内蔵 PIXELA PIX-DT295 9-16 Card Reader: usb 9-16 を開けません (");
    }
}
