using System.Globalization;
using System.Xml.Linq;

namespace Denpa.Agent.Tests;

/*
 * Android のアプリの device_filter.xml (android/app/src/main/res/xml/device_filter.xml)。挿したときにアプリを起動する機材と、
 * アプリが許可を求めて fd をエージェントへ渡す機材を決める表で、手で書いている。
 * 見ること: エージェントが USB を直に持つ機材 (WinUsbTargets。--usb-ids と同じ) と asicen-userland に渡す機材 (AsicenUserland.UsbIds。
 * ファームウェア待ちと、流し込んだあとの ID) を合わせたものと、ちょうど同じ ID が並ぶ / CCID のクラス (11) がある
 */
public class AndroidDeviceFilterTests
{
    private static XDocument Load()
    {
        using var stream = typeof(AndroidDeviceFilterTests).Assembly.GetManifestResourceStream("device_filter.xml")
            ?? throw new InvalidOperationException("device_filter.xml が埋め込まれていません");
        return XDocument.Load(stream);
    }

    // Android の USB の表と同じく、0x で始まれば 16 進、ほかは 10 進
    private static int Number(string text) => text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
        ? int.Parse(text[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture)
        : int.Parse(text, CultureInfo.InvariantCulture);

    [Test]
    public async Task USB_を直に持つ機材と_asicen_userland_に渡す機材とちょうど同じ_ID_が並ぶ()
    {
        var written = Load().Root!.Elements("usb-device")
            .Where(entry => entry.Attribute("vendor-id") is not null)
            .Select(entry => (Number((string)entry.Attribute("vendor-id")!), Number((string)entry.Attribute("product-id")!)))
            .ToList();
        var targets = WinUsbTargets.All().Select(target => (target.Vendor, target.Product))
            .Concat(AsicenUserland.UsbIds.Select(id => (id.Vendor, id.Product)))
            .Distinct().ToList();
        // ファームウェア待ちと、流し込んだあとにつながり直した ID の両方 (どちらでも許可を求める)
        await Assert.That(written).Contains((0x1738, 0x5211));
        await Assert.That(written).Contains((0x0b06, 0x0005));
        await Assert.That(written.Distinct().Count()).IsEqualTo(written.Count);
        await Assert.That(written.Except(targets).ToList()).IsEmpty();
        await Assert.That(targets.Except(written).ToList()).IsEmpty();
    }

    [Test]
    public async Task USB_の_CCID_のカードリーダーはクラスで選ぶ()
    {
        var classes = Load().Root!.Elements("usb-device")
            .Select(entry => (string?)entry.Attribute("class")).OfType<string>().Select(Number).ToList();
        await Assert.That(classes).IsEquivalentTo([0x0B]);
    }
}
