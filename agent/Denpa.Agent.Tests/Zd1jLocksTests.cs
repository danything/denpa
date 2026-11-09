using System.Text.Json.Nodes;

namespace Denpa.Agent.Tests;

/*
 * CECH-ZD1 J の覚えたロックの値のファイル (zd1j-locks.json。Zd1j.cs の Zd1jLocks)
 */
public class Zd1jLocksTests
{
    private static (Dib8096 Dib, DibModel Model) Tuner(DibMemory memory)
    {
        var model = new DibModel();
        var dib = new Dib8096(new FakeI2c(model), new FakeTime(), null, memory);
        dib.Initialize();
        return (dib, model);
    }

    private static string Temp() => Path.Combine(Directory.CreateTempSubdirectory("zd1j-locks").FullName, "zd1j-locks.json");

    [Test]
    public async Task 書いて読み戻すと再起動をまたいで探索を飛ばせる()
    {
        var path = Temp();
        var (dib, _) = Tuner(new Zd1jLocks(path).For("4-12.1"));
        dib.Tune(557_142_857);
        await Assert.That(File.Exists(path)).IsTrue();
        await Assert.That(File.ReadAllText(path)).Contains("\"557142\"");

        // 起こし直した (ファイルから読む)
        var (again, _) = Tuner(new Zd1jLocks(path).For("4-12.1"));
        again.Tune(557_142_857);
        await Assert.That(again.LastPath).IsEqualTo("覚えた値で合わせた");
        // ポートが違えば別のもの
        await Assert.That(new Zd1jLocks(path).For("4-12.2").Channels.Count).IsEqualTo(0);
    }

    [Test]
    public async Task 使わない項目は読むときに無視し_書くときは出さない()
    {
        var path = Temp();
        var (dib, _) = Tuner(new Zd1jLocks(path).For("4-12.1"));
        dib.Tune(557_142_857);
        await Assert.That(File.ReadAllText(path)).DoesNotContain("inversion");

        // 使わない項目 (以前のバージョンが書いた inversion) が入ったファイル
        var json = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        json["boards"]!["4-12.1"]!["557142"]!["inversion"] = 0;
        File.WriteAllText(path, json.ToJsonString());

        var (again, _) = Tuner(new Zd1jLocks(path).For("4-12.1"));
        again.Tune(557_142_857);
        await Assert.That(again.LastPath).IsEqualTo("覚えた値で合わせた");
    }

    [Test]
    public async Task 値が変わったときだけ書く()
    {
        var memory = new Zd1jLocks(Temp()).For("4-12.1");
        var changes = 0;
        memory.Changed += () => changes++;
        var (dib, _) = Tuner(memory);
        dib.Tune(557_142_857);
        // 覚えた値で合わせた選局では書かない
        dib.Tune(557_142_857);
        dib.Tune(557_142_857);
        await Assert.That(changes).IsEqualTo(1);
    }

    [Test]
    public async Task 壊れたファイルや古い形式は捨てる()
    {
        var path = Temp();
        File.WriteAllText(path, "{ not json");
        await Assert.That(new Zd1jLocks(path).For("4-12.1").Channels.Count).IsEqualTo(0);
        File.WriteAllText(path, """{ "version": 0, "boards": {} }""");
        await Assert.That(new Zd1jLocks(path).For("4-12.1").Channels.Count).IsEqualTo(0);
        File.WriteAllText(path, """{ "version": 1, "boards": { "4-12.1": { "557142": { "fft": 9 } } } }""");
        await Assert.That(new Zd1jLocks(path).For("4-12.1").Channels.Count).IsEqualTo(0);
        // 階層の値が null でも、起動を止めずに捨てる
        File.WriteAllText(path, """{ "version": 1, "boards": { "4-12.1": { "557142": { "fft": 1, "guard": 0, "partial": 0, "diff": 0, "layers": [[null, 1, 0, 13], [0, 0, 0, 0], [0, 0, 0, 0]] } } } }""");
        await Assert.That(new Zd1jLocks(path).For("4-12.1").Channels.Count).IsEqualTo(0);
    }

    [Test]
    public async Task 合わなかった値は捨てて書き直す()
    {
        var path = Temp();
        var (dib, model) = Tuner(new Zd1jLocks(path).For("4-12.1"));
        dib.Tune(557_142_857);
        await Assert.That(File.ReadAllText(path)).Contains("\"557142\"");
        model.Signal = false;
        dib.Tune(557_142_857);
        await Assert.That(dib.LastPath).IsEqualTo("覚えた値で合わず探索した");
        await Assert.That(File.ReadAllText(path)).DoesNotContain("\"557142\"");
    }
}
