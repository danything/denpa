using System.Text.Json.Nodes;

namespace Denpa.Agent.Tests;

/*
 * `denpa-agent --usb-ids`。install.ps1 -WinUsb がこの JSON を読んで、挿さっている機材のドライバを WinUSB に替える。
 * 見ること: エージェントが USB を直に持つ機材が全部入っている / 未確認として断る機材は入らない / install.ps1 が読む形式
 */
public class WinUsbTargetsTests
{
    [Test]
    public async Task USB_を直に持つ機材が全部入っている()
    {
        var ids = WinUsbTargets.All().Select(target => (target.Vendor, target.Product)).ToList();
        await Assert.That(ids).Contains((Zd1j.Vendor, Zd1j.Product));
        await Assert.That(ids).Contains((Dt295.Vendor, Dt295.Product));
        foreach (var model in It930x.Family) await Assert.That(ids).Contains((model.Vendor, model.Product));
        // PX-S1UD などの Siano の機材も、エージェントが USB を直に持つ。資料で扱いが食い違う 187f:0302 は入らない
        foreach (var model in Siano.Models) await Assert.That(ids).Contains((model.Vendor, model.Product));
        await Assert.That(ids).Contains((0x3275, 0x0080));
        await Assert.That(ids).DoesNotContain((0x187F, 0x0302));
        await Assert.That(ids.Distinct().Count()).IsEqualTo(ids.Count);
    }

    [Test]
    public async Task 未確認として断る機材は入らない()
    {
        var ids = WinUsbTargets.All().Select(target => (target.Vendor, target.Product)).ToList();
        foreach (var model in Dt295.Family.Where(model => model.Unconfirmed is not null))
        {
            await Assert.That(ids).DoesNotContain((model.Vendor, model.Product));
        }
    }

    [Test]
    public async Task JSON_は_usb_と_name_の配列()
    {
        var list = JsonNode.Parse(WinUsbTargets.ToJson())!.AsArray();
        await Assert.That(list.Count).IsEqualTo(WinUsbTargets.All().Count);
        var zd1j = list.Single(entry => (string?)entry!["usb"] == "054c:04b2")!;
        await Assert.That((string?)zd1j["name"]).IsEqualTo("Sony CECH-ZD1 J");
        foreach (var entry in list)
        {
            await Assert.That(System.Text.RegularExpressions.Regex.IsMatch((string)entry!["usb"]!, "^[0-9a-f]{4}:[0-9a-f]{4}$")).IsTrue();
        }
    }
}
