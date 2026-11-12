namespace Denpa.Agent.Tests;

/*
 * CXD2856ER の地上波の選局を速くする 2 つの手順 (Cxd2856.cs)。偽のバス (Cxd2856Fakes.cs) の上で、書く順番を仕様書と照らす。
 * - プリセット選局 (仕様書 5.8): ロックしたら TMCC の 13 バイトを周波数ごとに覚え、次の選局で選局を終える前に書く。覚えていない周波数では、ほかの周波数で最後にロックした値を書き、
 *   どの値も無ければ既定の値を書く
 * - 覚えた値のファイル (tmcc-presets.json。TmccPresets.cs)
 * - チューナーの手順 8 のあとの 50 ms (仕様書 4.3) を待たずに選局を終え、ロックを待つ間に手順 9〜10 を書く (仕様書 5.4)
 */
public class Cxd2856PresetTests
{
    private const byte Demod = 0x65;

    private static readonly string Tmcc = "A0A1A2A3A4A5A6A7A8A9AAABAC";

    /// <summary>どの値も覚えていないときに書く既定の値 (仕様書 5.8)</summary>
    private const string DefaultTmcc = "3D258B4B3FFF258B4B3FFFFFFC";

    private static (Cxd2856Frontend Frontend, FakeCxdBus Bus, FakeClock Clock, TmccPresets Presets) Make(Action<FakeCxdReceiver>? setup = null, TmccPresets? presets = null)
    {
        var bus = new FakeCxdBus(Demod);
        var demod = bus[Demod];
        // TMCC の 13 バイト (バンク 60 の 32〜3E)
        for (byte at = 0; at < Cxd2856.TmccLength; at++) demod.T[(0x60, (byte)(0x32 + at))] = (byte)(0xA0 + at);
        setup?.Invoke(demod);
        var clock = new FakeClock();
        presets ??= new TmccPresets(null);
        return (new Cxd2856Frontend(bus, new Lock(), Demod, clock.Sleep, () => clock.Now, presets), bus, clock, presets);
    }

    /// <summary>プリセットを有効にした行 (バンク 60 の 59〜5A ← 01 01) を書いたあとか</summary>
    private static bool PresetOn(FakeCxdReceiver demod) => demod.T.GetValueOrDefault(((byte)0x60, (byte)0x59)) == 0x01;

    /// <summary>その周波数で覚えた値 (16 進)。無ければ null</summary>
    private static string? Own(TmccPresets presets, uint khz) =>
        presets.For(khz) is ({ } tmcc, TmccPresetSource.Own) ? Convert.ToHexString(tmcc) : null;

    private static string Temp() => Path.Combine(Directory.CreateTempSubdirectory("tmcc-presets").FullName, "tmcc-presets.json");

    [Test]
    public async Task どの値も無ければ既定の値を書き_ロックしたら次の選局で覚えた_13_バイトを選局を終える前に書く()
    {
        const uint khz = 503143;
        var path = Temp();
        var (frontend, bus, _, presets) = Make(presets: new TmccPresets(path));
        await Assert.That(presets.For(khz).Source).IsEqualTo(TmccPresetSource.Default);
        // 既定の値は覚えた値ではないので、ファイルに書かない
        await Assert.That(File.Exists(path)).IsFalse();
        frontend.Init();
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        var initial = bus.Log.IndexOf($"T 62={DefaultTmcc}");
        await Assert.That(initial).IsGreaterThan(0);
        await Assert.That(bus.Log[initial - 1]).IsEqualTo("T 59=0101");
        await Assert.That(initial).IsLessThan(bus.Log.IndexOf("T FE=01"));
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
        await Assert.That(frontend.TuneLines().Any(line => line.Contains("プリセット 使った (既定の値 3D 25 8B", StringComparison.Ordinal))).IsTrue();
        // TS がロックしたら、値を固めて TMCC を読んで覚える (ファイルにあるのは読んだ値だけ)
        await Assert.That(File.ReadAllText(path)).Contains($"\"{khz}\": \"{Tmcc}\"");
        await Assert.That(File.ReadAllText(path)).DoesNotContain(DefaultTmcc);
        await Assert.That(Own(presets, khz)).IsEqualTo(Tmcc);

        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        var preset = bus.Log.IndexOf($"T 62={Tmcc}");
        await Assert.That(preset).IsGreaterThan(0);
        await Assert.That(bus.Log[preset - 1]).IsEqualTo("T 59=0101");
        await Assert.That(bus.Log[preset - 2]).IsEqualTo("T 00=60");
        await Assert.That(preset).IsLessThan(bus.Log.IndexOf("T FE=01"));
        // 選局し直しは 1 回だけ
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
        await Assert.That(frontend.TuneLines().Any(line => line.Contains("プリセット 使った (A0 A1", StringComparison.Ordinal))).IsTrue();
    }

    [Test]
    public async Task 覚えていない周波数では_ほかの周波数で最後にロックしたときの値を書き_ロックしたらその周波数の値として覚える()
    {
        const string older = "00000000000000000000000001", newer = "00000000000000000000000002";
        var (frontend, bus, _, presets) = Make();
        presets.Locked(503143, Convert.FromHexString(newer));
        presets.Locked(509143, Convert.FromHexString(older));
        // 503143 で最後にロックした
        presets.Locked(503143, Convert.FromHexString(newer));
        await Assert.That(frontend.TuneIsdbt(515143)).IsTrue();
        var preset = bus.Log.IndexOf($"T 62={newer}");
        await Assert.That(preset).IsGreaterThan(0);
        await Assert.That(bus.Log[preset - 1]).IsEqualTo("T 59=0101");
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
        await Assert.That(frontend.TuneLines().Any(line => line.Contains("プリセット 使った (ほかのチャンネルの値 00 00", StringComparison.Ordinal))).IsTrue();
        await Assert.That(Own(presets, 515143)).IsEqualTo(Tmcc);
    }

    [Test]
    public async Task 代わりの値でロックしなければ外して選局し直し_その周波数では次から代わりの値を使わない()
    {
        const uint khz = 515143;
        // 放送の無いチャンネル。プリセットがあっても無くても「信号が無い」
        var (frontend, bus, _, presets) = Make(demod => demod.Status = _ => 0x10);
        presets.Locked(503143, Convert.FromHexString(Tmcc));
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        await Assert.That(bus.Log).Contains($"T 62={Tmcc}");
        await Assert.That(bus.Log.LastIndexOf("T 59=0000")).IsGreaterThan(bus.Log.IndexOf($"T 62={Tmcc}"));
        await Assert.That(frontend.TuneLines().Any(line => line.StartsWith("ほかのチャンネルの値のプリセットでロックしなかったため", StringComparison.Ordinal))).IsTrue();
        // ほかの周波数の値は消さない
        await Assert.That(Own(presets, 503143)).IsEqualTo(Tmcc);

        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log).DoesNotContain("T 59=0101");
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
        // ほかの周波数では、まだ代わりの値を使う
        await Assert.That(presets.For(521143).Source).IsEqualTo(TmccPresetSource.Other);
    }

    [Test]
    public async Task 既定の値でロックしなければ外して選局し直し_その周波数では次から既定の値を使わない()
    {
        const uint khz = 515143;
        var path = Temp();
        // 放送の無いチャンネル。プリセットがあっても無くても「信号が無い」
        var (frontend, bus, _, presets) = Make(demod => demod.Status = _ => 0x10, new TmccPresets(path));
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        await Assert.That(bus.Log).Contains($"T 62={DefaultTmcc}");
        await Assert.That(bus.Log.LastIndexOf("T 59=0000")).IsGreaterThan(bus.Log.IndexOf($"T 62={DefaultTmcc}"));
        await Assert.That(frontend.TuneLines().Any(line => line.StartsWith("既定の値のプリセットでロックしなかったため", StringComparison.Ordinal))).IsTrue();
        await Assert.That(File.Exists(path)).IsFalse();

        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log).DoesNotContain("T 59=0101");
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
        // ほかの周波数では、まだ既定の値を使う
        await Assert.That(presets.For(521143).Source).IsEqualTo(TmccPresetSource.Default);
        // ほかの周波数でロックしても、この周波数ではその値も使わない
        presets.Locked(503143, Convert.FromHexString(Tmcc));
        await Assert.That(presets.For(khz).Tmcc).IsNull();
    }

    [Test]
    public async Task 書いたファイルを作り直したエージェントが読み_覚えた値をプリセットにする()
    {
        const uint khz = 503143;
        var path = Temp();
        var (frontend, _, _, _) = Make(presets: new TmccPresets(path));
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        await Assert.That(File.ReadAllText(path)).Contains($"\"{khz}\": \"{Tmcc}\"");

        // 再起動した (ファイルから読む)
        var (again, bus, _, presets) = Make(presets: new TmccPresets(path));
        await Assert.That(Own(presets, khz)).IsEqualTo(Tmcc);
        await Assert.That(again.TuneIsdbt(khz)).IsTrue();
        await Assert.That(bus.Log).Contains($"T 62={Tmcc}");

        // 覚えていない周波数は、読んだ値を代わりに使い、ロックしたらその周波数の値としてファイルに書く
        bus.Log.Clear();
        await Assert.That(again.TuneIsdbt(509143)).IsTrue();
        await Assert.That(again.TuneLines().Any(line => line.Contains("プリセット 使った (ほかのチャンネルの値 A0", StringComparison.Ordinal))).IsTrue();
        await Assert.That(Own(new TmccPresets(path), 509143)).IsEqualTo(Tmcc);
    }

    [Test]
    public async Task ファイルの後ろほど新しく_読み直しても最後にロックした値を代わりに使う()
    {
        var path = Temp();
        var presets = new TmccPresets(path);
        presets.Locked(509143, Convert.FromHexString("00000000000000000000000001"));
        presets.Locked(503143, Convert.FromHexString("00000000000000000000000002"));
        presets.Locked(509143, Convert.FromHexString("00000000000000000000000003"));
        await Assert.That(Convert.ToHexString(new TmccPresets(path).For(515143).Tmcc!)).IsEqualTo("00000000000000000000000003");
    }

    [Test]
    public async Task 値が新しくなったときだけファイルに書く()
    {
        var path = Temp();
        var presets = new TmccPresets(path);
        presets.Locked(503143, Convert.FromHexString(Tmcc));
        File.Delete(path);
        presets.Locked(503143, Convert.FromHexString(Tmcc));
        await Assert.That(File.Exists(path)).IsFalse();
        presets.Locked(509143, Convert.FromHexString(Tmcc));
        await Assert.That(File.Exists(path)).IsTrue();
    }

    [Test]
    [Arguments("{")]
    [Arguments("[]")]
    [Arguments("{\"version\": 2, \"tmcc\": {}}")]
    [Arguments("{\"version\": 1, \"tmcc\": {\"503143\": \"A0A1\"}}")]
    [Arguments("{\"version\": 1, \"tmcc\": {\"503143\": \"ZZ\"}}")]
    [Arguments("{\"version\": 1, \"tmcc\": {\"T21\": \"A0A1A2A3A4A5A6A7A8A9AAABAC\"}}")]
    [Arguments("{\"version\": 1, \"tmcc\": {\"503143\": 1}}")]
    [Arguments("{\"version\": 1, \"tmcc\": {\"503143\": \"A0A1A2A3A4A5A6A7A8A9AAABAC\", \"503143\": \"A0A1A2A3A4A5A6A7A8A9AAABAC\"}}")]
    public async Task 壊れたファイルは無視して空から始める(string body)
    {
        var path = Temp();
        File.WriteAllText(path, body);
        var (frontend, bus, _, presets) = Make(presets: new TmccPresets(path));
        await Assert.That(presets.For(503143).Source).IsEqualTo(TmccPresetSource.Default);
        await Assert.That(frontend.TuneIsdbt(503143)).IsTrue();
        await Assert.That(bus.Log).Contains($"T 62={DefaultTmcc}");
        // ロックしたら書き直す
        await Assert.That(Own(new TmccPresets(path), 503143)).IsEqualTo(Tmcc);
    }

    [Test]
    public async Task プリセットでロックしなければ外して_1_回選局し直す()
    {
        const uint khz = 509143;
        // プリセットを有効にしている間は「信号が無い」(bit4)、外せばロックする
        var (frontend, bus, _, presets) = Make(demod =>
        {
            demod.Status = _ => PresetOn(demod) ? (byte)0x10 : (byte)0x03;
        });
        presets.Locked(khz, Convert.FromHexString("00000000000000000000000004"));
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        var spoiled = bus.Log.IndexOf("T 62=00000000000000000000000004");
        var second = bus.Log.LastIndexOf("T FE=01");
        // 2 回目の選局は、選局を終える前にプリセットを外す
        await Assert.That(bus.Log.LastIndexOf("T 59=0000")).IsGreaterThan(spoiled);
        await Assert.That(bus.Log.LastIndexOf("T 59=0000")).IsLessThan(second);
        // 2 回目でロックしたので、読んだ TMCC を覚え直す
        await Assert.That(Own(presets, khz)).IsEqualTo(Tmcc);
        await Assert.That(frontend.TuneLines()).Contains("プリセットを使った選局がロックしなかったため、プリセットを外して選局し直しました");
    }

    [Test]
    public async Task プリセットを外してもロックしなければ覚えた値を消す()
    {
        const uint khz = 515143;
        var (frontend, bus, _, presets) = Make(demod => demod.Status = _ => 0x10);
        presets.Locked(khz, Convert.FromHexString(Tmcc));
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        // 覚えた値が無くなったので、次の選局は代わりの値 (ここでは既定の値) を使う
        await Assert.That(presets.For(khz).Source).IsEqualTo(TmccPresetSource.Default);
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        // それも合わなかったので、その次はプリセットを使わず、選局し直しもしない
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsFalse();
        await Assert.That(bus.Log).Contains("T 59=0000");
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(1);
    }

    [Test]
    public async Task 手順_8_のあとすぐ選局を終え_50_ms_たってからロックを確かめる読み出しの間に_88_と_87_を書く()
    {
        // 100 ms でロックする
        var (frontend, bus, clock, _) = Make(demod => demod.Status = read => read > 10 ? (byte)0x03 : (byte)0x00);
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        var step8 = bus.Log.FindIndex(line => line.StartsWith("U 68=", StringComparison.Ordinal));
        var finish = bus.Log.IndexOf("T FE=01");
        var tail = bus.Log.IndexOf("U 88=00");
        await Assert.That(bus.Log[step8 + 1]).IsEqualTo("X 08=00");
        await Assert.That(finish).IsGreaterThan(step8);
        await Assert.That(tail).IsGreaterThan(finish);
        await Assert.That(bus.Log.Skip(tail - 1).Take(4)).IsEquivalentTo(new[] { "X 08=01", "U 88=00", "U 87=C0", "X 08=00" });
        // 選局の書き込みの中に 50 ms の待ちは無い。読み出しは 0・10・20・30・40 ms の 5 回、50 ms で手順 9〜10、続けて読む
        await Assert.That(bus.Log.Take(tail).Count(line => line == "T 10?")).IsEqualTo(5);
        await Assert.That(bus.Log[tail + 3]).IsEqualTo("T 00=60");
        await Assert.That(bus.Log[tail + 4]).IsEqualTo("T 10?");
        await Assert.That(clock.Sleeps.Take(10).All(ms => ms == Cxd2856Frontend.LockPollMs)).IsTrue();
        await Assert.That(bus.Log.Count(line => line == "U 88=00")).IsEqualTo(1);
        await Assert.That(frontend.LockMs).IsEqualTo(100);
    }

    [Test]
    public async Task ロックが_50_ms_より早ければ_50_ms_まで待ってから_88_と_87_を書き_350_ms_まで待ち足す()
    {
        // 20 ms でロックする
        var (frontend, bus, clock, _) = Make(demod => demod.Status = read => read > 2 ? (byte)0x03 : (byte)0x00);
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        await Assert.That(frontend.LockMs).IsEqualTo(20);
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { 10, 10, 30, 300 });
        await Assert.That(bus.Log.TakeLast(4)).IsEquivalentTo(new[] { "X 08=01", "U 88=00", "U 87=C0", "X 08=00" });
    }

    [Test]
    public async Task 選局の経過とモードとガードインターバルを出す()
    {
        var (frontend, bus, _, _) = Make(demod => demod.T[(0x60, 0x40)] = 0x06);
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        bus.Log.Clear();
        var notes = frontend.IsdbtNotes();
        // 値を固めて読む (仕様書 2.3)
        await Assert.That(bus.Log).IsEquivalentTo(new[] { "T 01=01", "T 00=60", "T 40?", "T 01=00" });
        await Assert.That(notes[^1]).IsEqualTo("モード 3  ガードインターバル 1/8 (60 の 40 = 06)");
        await Assert.That(notes).Contains("TMCC の 13 バイト (60 の 32〜3E) A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC");
    }
}
