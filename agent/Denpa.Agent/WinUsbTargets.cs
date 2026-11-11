using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// エージェントが USB を直に持つ機材の USB ID と名前 (<c>denpa-agent --usb-ids</c>)。Windows ではドライバが WinUSB でないと開けないので、
/// install.ps1 の <c>-WinUsb</c> がこれを読み、挿さっている機材のドライバを WinUSB に替える (docs/install-windows.md)。
/// ID は各機材の表 (<see cref="Zd1j"/>・<see cref="Dt295.Family"/>・<see cref="It930x.Family"/>・<see cref="Siano.Models"/>) から作り、ここにも install.ps1 にも書かない。
/// </summary>
public static class WinUsbTargets
{
    /// <summary>未確認として断る機材 (<see cref="Dt295Model.Unconfirmed"/>) は入れない。ドライバを替えても使えない</summary>
    public static IReadOnlyList<(int Vendor, int Product, string Name)> All() =>
    [
        (Zd1j.Vendor, Zd1j.Product, Zd1j.Model),
        .. Dt295.Family.Where(model => model.Unconfirmed is null).Select(model => (model.Vendor, model.Product, model.Name)),
        .. It930x.Family.Select(model => (model.Vendor, model.Product, model.Name)),
        .. Siano.Models.Select(model => (model.Vendor, model.Product, model.Name)),
    ];

    /// <summary><c>[{"usb":"054c:04b2","name":"Sony CECH-ZD1 J"}, …]</c>。<c>usb</c> は小文字の 16 進 4 桁を <c>:</c> でつないだもの</summary>
    public static string ToJson() =>
        new JsonArray([.. All().Select(target => (JsonNode)new JsonObject
        {
            ["usb"] = $"{target.Vendor:x4}:{target.Product:x4}",
            ["name"] = target.Name,
        })]).ToJsonString(Json.Compact);
}
