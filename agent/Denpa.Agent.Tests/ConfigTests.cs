using TUnit.Assertions.Enums;
using System.IO;
using System.Text.Json.Nodes;
using Denpa.Agent;
using System.Threading.Tasks;

namespace Denpa.Agent.Tests;

/*
 * 取り合いと HTTP の口は `agent/conformance.test.ts` が本物を起こして当てている
 * (bun 版と同じものを通す)。こちらで見るのは、そこからは届きにくいところ —
 * **設定の読み書き**と、チューナー自動検出の値の読み取り。
 */

public class TunerSpecTests
{
    private static Config Fresh()
    {
        var work = Directory.CreateTempSubdirectory();
        return new Config(
            Path.Combine(work.FullName, "tuners.json"), Path.Combine(work.FullName, "channels.json"));
    }

    [Test]
    public async Task 既定では外のコマンドを起こさない()
    {
        // 選局は自分でやる (ioctl)。`recisdb` はもう要らない
        var spec = new TunerSpec("adapter0", ["GR"], false, "/dev/dvb/adapter0/frontend0");

        await Assert.That(spec.Resolve()).IsNull();
    }

    [Test]
    public async Task 直に書いたコマンドが勝つ()
    {
        // 逃げ道。**画面からは触らせない** (ファイルに直に書いたときだけ効く)
        var spec = new TunerSpec("x", ["GR"], false, "/dev/null", null, "myTuner --ch {{channel}}");

        await Assert.That(spec.Resolve()).IsEqualTo("myTuner --ch {{channel}}");
    }

    [Test]
    public async Task 書いて読み直すと同じものになる()
    {
        var config = Fresh();
        config.SaveTuners([
            new TunerSpec("adapter0", ["BS", "CS"], false, "/dev/dvb/adapter0/frontend0", "15v"),
            new TunerSpec("adapter1", ["GR"], true, "/dev/dvb/adapter1/frontend0"),
        ]);

        var read = config.LoadTuners();
        await Assert.That(read.Count).IsEqualTo(2);
        await Assert.That(read[0].Types).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(read[0].Lnb).IsEqualTo("15v");
        await Assert.That(read[0].Device).IsEqualTo("/dev/dvb/adapter0/frontend0");
        await Assert.That(read[1].Disabled).IsTrue();
    }

    [Test]
    public async Task 空を渡すと定義を消す()
    {
        // 「1本も無い」を書き込むより、**無い=自分で探す**のほうが後で困らない
        var config = Fresh();
        config.SaveTuners([new TunerSpec("a", ["GR"], false, "/dev/null")]);
        await Assert.That(File.Exists(config.TunersFile)).IsTrue();

        config.SaveTuners([]);

        await Assert.That(File.Exists(config.TunersFile)).IsFalse();
        await Assert.That(config.LoadTuners()).IsEmpty();
    }

    [Test]
    public async Task 壊れたファイルは空として扱う()
    {
        // 起動できないよりは、画面に「チューナーがありません」と出したほうがいい
        var config = Fresh();
        File.WriteAllText(config.TunersFile, "{ これは JSON ではない");

        await Assert.That(config.LoadTuners()).IsEmpty();
    }

    [Test]
    public async Task 名前の無いものは受け取らない()
    {
        await Assert.That(TunerSpec.FromJson(new JsonObject { ["types"] = new JsonArray() })).IsNull();
    }
}

public class ChannelStoreTests
{
    private static Config Fresh()
    {
        var work = Directory.CreateTempSubdirectory();
        return new Config(
            Path.Combine(work.FullName, "tuners.json"), Path.Combine(work.FullName, "channels.json"));
    }

    private static JsonArray Entries(params (string Type, string Channel)[] items)
    {
        var list = new JsonArray();
        foreach (var (type, channel) in items)
        {
            list.Add((JsonNode)new JsonObject { ["type"] = type, ["channel"] = channel });
        }
        return list;
    }

    [Test]
    public async Task 探した種別だけ差し替える()
    {
        // 地上波だけ探したときに全部を置き換えると BS と CS が設定から消える
        // (実際に消して、BS の予約が録れなくなった)
        var config = Fresh();
        config.SaveChannels(Entries(("GR", "T16"), ("BS", "BS11_0")), ["GR", "BS"]);

        var merged = config.SaveChannels(Entries(("GR", "T21")), ["GR"]);

        await Assert.That(merged.Select(entry => entry!["channel"]!.GetValue<string>())).IsEquivalentTo(["T21", "BS11_0"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 種別ごとにまとめて並べる()
    {
        var config = Fresh();
        var merged = config.SaveChannels(
            Entries(("CS", "CS02"), ("BS", "BS11_0"), ("GR", "T21"), ("GR", "T16"), ("BS", "BS03_0")),
            ["GR", "BS", "CS"]);

        await Assert.That(merged.Select(entry => entry!["channel"]!.GetValue<string>())).IsEquivalentTo(["T16", "T21", "BS03_0", "BS11_0", "CS02"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 局名は逃がさずそのまま書く()
    {
        /*
         * `channels.json` は人が開いて確かめるもの。既定の符号化器は非ASCIIを
         * 全部逃がすので、局名が1つも読めなくなる。
         *
         * **全角空白 (U+3000) だけは逃げたままになる。** .NET のどの符号化器も
         * ASCII でない空白は必ず逃がす作りで、`JSON.stringify` と揃わない。
         * JSON としては同じものなので、ここは合わせにいかない
         */
        var config = Fresh();
        var entry = new JsonObject { ["type"] = "GR", ["channel"] = "T16", ["name"] = "ＴＯＫＹＯ　ＭＸ" };
        config.SaveChannels([entry], ["GR"]);

        var written = File.ReadAllText(config.ChannelsFile);
        await Assert.That(written).Contains("ＴＯＫＹＯ");
        await Assert.That(written).Contains("ＭＸ");
    }

    [Test]
    public async Task まだ1度も預かっていなければ空()
    {
        await Assert.That(Fresh().LoadChannels()).IsEmpty();
    }
}

public class RenderTests
{
    [Test]
    public async Task 選局コマンドのテンプレートを埋める()
    {
        await Assert.That(TunerPool.Render("recisdb tune --device /dev/dvb/adapter0/frontend0 -c {{{channel}}} -", "T27", "GR")).IsEqualTo("recisdb tune --device /dev/dvb/adapter0/frontend0 -c T27 -");
    }

    [Test]
    public async Task 種別と長さも埋める()
    {
        await Assert.That(TunerPool.Render("x {{channel_type}} {{{duration}}}", "T27", "GR")).IsEqualTo("x GR -");
    }

    [Test]
    public async Task 知らない差し込みは空にする()
    {
        await Assert.That(TunerPool.Render("a {{{extra_args}}} b", "T27", "GR")).IsEqualTo("a  b");
    }
}

/*
 * チューナーの自動検出。
 *
 * ioctl そのものは実機でしか試せないので、ここで見るのは**返ってきた値の
 * 読み取り**。数と並びは実機の PT3 で測ってあり (DeviceProbe の頭のコメント)、
 * ここに置いてあるのはそのとき出た値そのもの。
 */
public class DeviceProbeTests
{
    [Test]
    public async Task 地上波と衛星を方式から分ける()
    {
        // 実機の PT3。adapter0/2 が ISDB-S(9)、adapter1/3 が ISDB-T(8)
        await Assert.That(DeviceProbe.TypesFor([8])).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.TypesFor([9])).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        // 1本でどちらも受けられるものもある
        await Assert.That(DeviceProbe.TypesFor([8, 9])).IsEquivalentTo(["GR", "BS", "CS"], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 知らない方式は種別にしない()
    {
        // DVB-T や ATSC が出てきても、日本の放送には使わない
        await Assert.That(DeviceProbe.TypesFor([3, 11])).IsEmpty();
    }

    [Test]
    public async Task frontend_info_から名前を読む()
    {
        var info = new byte[168];
        System.Text.Encoding.UTF8.GetBytes("Toshiba TC90522 ISDB-S module").CopyTo(info, 0);

        await Assert.That(DeviceProbe.ParseName(info)).IsEqualTo("Toshiba TC90522 ISDB-S module");
    }

    [Test]
    public async Task 方式を答えないドライバは名前で当てる()
    {
        await Assert.That(DeviceProbe.TypesFromName("Toshiba TC90522 ISDB-S module")).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.TypesFromName("Toshiba TC90522 ISDB-T module")).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        // 名前に方式が入っていないものは当てにいかない (黙って間違えるより出さない)
        await Assert.That(DeviceProbe.TypesFromName("Some Generic Frontend")).IsEmpty();
    }

    [Test]
    public async Task dtv_property_から方式の並びを取り出す()
    {
        var property = new byte[76];
        BitConverter.TryWriteBytes(property.AsSpan(48), 2u);  // u.buffer.len
        property[16] = 8;                                     // u.buffer.data[0] = ISDB-T
        property[17] = 9;                                     // u.buffer.data[1] = ISDB-S

        await Assert.That(DeviceProbe.ParseDelivery(property)).IsEquivalentTo([8, 9], CollectionOrdering.Matching);
    }

    [Test]
    public async Task 何も入っていなければ空()
    {
        await Assert.That(DeviceProbe.ParseDelivery(new byte[76])).IsEmpty();
    }

    [Test]
    public async Task chardev_は名前の決まりで分ける()
    {
        // px4_drv は方式を聞ける口を持たない。番号の決まりがそのまま種別
        await Assert.That(DeviceProbe.TypesForChardev("px4video0")).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.TypesForChardev("px4video2")).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.TypesForChardev("pxmlt5video0")).IsEquivalentTo(["GR", "BS", "CS"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.TypesForChardev("sda")).IsEmpty();
    }
}