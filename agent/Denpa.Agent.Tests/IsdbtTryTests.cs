namespace Denpa.Agent.Tests;

/// <summary>試験用のビルドの、CXD2856ER の地上波のロックを縮める設定 (IsdbtTry.cs)</summary>
public class IsdbtTryTests
{
    private const byte Demod = 0x65;

    private static (Cxd2856Frontend Frontend, FakeCxdBus Bus, FakeClock Clock) Make(IsdbtTry plan, Action<FakeCxdReceiver>? setup = null)
    {
        var bus = new FakeCxdBus(Demod);
        setup?.Invoke(bus[Demod]);
        var clock = new FakeClock();
        return (new Cxd2856Frontend(bus, new Lock(), Demod, clock.Sleep, () => clock.Now) { Try = plan }, bus, clock);
    }

    [Test]
    public async Task 指定を読む()
    {
        await Assert.That(IsdbtTry.Parse(null, out _)).IsEqualTo(IsdbtTry.Default);
        await Assert.That(IsdbtTry.Parse("tunerwait=0,modegi=force,preset=on,settle=0", out _))
            .IsEqualTo(new IsdbtTry(IsdbtTunerWait.Deferred, true, IsdbtPresetUse.On, true));
        await Assert.That(IsdbtTry.Parse("preset=maybe", out var error)).IsNull();
        await Assert.That(error).IsNotNull();
    }

    [Test]
    public async Task modegi_force_は起動で_D3_に_16_を書く()
    {
        var (frontend, bus, _) = Make(IsdbtTry.Default with { ForceModeGi = true });
        frontend.Init();
        bus.Log.Clear();
        frontend.TuneIsdbt(557143);
        await Assert.That(bus.Log).Contains("T D3=16");
        await Assert.That(bus.Log).DoesNotContain("T D3=06");
    }

    [Test]
    public async Task tunerwait_0_は手順_8_のあとすぐ選局を終え_50_ms_たってから_88_と_87_を書く()
    {
        var (frontend, bus, clock) = Make(IsdbtTry.Default with { TunerWait = IsdbtTunerWait.Deferred }, demod => demod.Status = read => read > 10 ? (byte)0x03 : (byte)0x00);
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        var step8 = bus.Log.FindIndex(line => line.StartsWith("U 68="));
        var finish = bus.Log.IndexOf("T FE=01");
        var tail = bus.Log.IndexOf("U 88=00");
        await Assert.That(finish).IsGreaterThan(step8);
        await Assert.That(tail).IsGreaterThan(finish);
        await Assert.That(bus.Log[tail + 1]).IsEqualTo("U 87=C0");
        // 50 ms の待ちは選局の書き込みの中に無い (最初の待ちはロックを確かめる 10 ms)
        await Assert.That(clock.Sleeps[0]).IsEqualTo(Cxd2856Frontend.LockPollMs);
    }

    [Test]
    public async Task tunerwait_none_は_88_と_87_を書かない()
    {
        var (frontend, bus, clock) = Make(IsdbtTry.Default with { TunerWait = IsdbtTunerWait.None });
        frontend.Init();
        bus.Log.Clear();
        clock.Sleeps.Clear();
        await Assert.That(frontend.TuneIsdbt(557143)).IsTrue();
        await Assert.That(bus.Log).DoesNotContain("U 88=00");
        await Assert.That(clock.Sleeps).IsEquivalentTo(new[] { Cxd2856Frontend.IsdbtSettleMs });
    }

    [Test]
    public async Task preset_on_は_2_回目の選局で覚えた_13_バイトを選局を終える前に書く()
    {
        const uint khz = 503143;
        var (frontend, bus, _) = Make(IsdbtTry.Default with { Preset = IsdbtPresetUse.On, NoSettle = true }, demod =>
        {
            for (byte at = 0; at < 13; at++) demod.T[(0x60, (byte)(0x32 + at))] = (byte)(0xA0 + at);
        });
        frontend.Init();
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        // 覚えていない周波数では外す
        await Assert.That(bus.Log.IndexOf("T 59=0000")).IsLessThan(bus.Log.IndexOf("T FE=01"));
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        var preset = bus.Log.IndexOf("T 62=A0A1A2A3A4A5A6A7A8A9AAABAC");
        await Assert.That(bus.Log.IndexOf("T 59=0101")).IsEqualTo(preset - 1);
        await Assert.That(preset).IsLessThan(bus.Log.IndexOf("T FE=01"));
    }

    [Test]
    public async Task preset_で失敗したら外して_1_回選局し直す()
    {
        const uint khz = 509143;
        var failing = false;
        var (frontend, bus, _) = Make(IsdbtTry.Default with { Preset = IsdbtPresetUse.Bad }, demod =>
            demod.Status = _ => failing && demod.T.GetValueOrDefault(((byte)0x60, (byte)0x59)) == 0x01 ? (byte)0x10 : (byte)0x03);
        frontend.Init();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        failing = true;
        bus.Log.Clear();
        await Assert.That(frontend.TuneIsdbt(khz)).IsTrue();
        // 1 回目は B121 を反転した 13 バイト (偽物のレジスタは 0 なので最後のバイトが 04)、2 回目は外す
        await Assert.That(bus.Log).Contains("T 62=00000000000000000000000004");
        await Assert.That(bus.Log.Count(line => line == "T FE=01")).IsEqualTo(2);
        await Assert.That(bus.Log.LastIndexOf("T 59=0000")).IsGreaterThan(bus.Log.IndexOf("T 62=00000000000000000000000004"));
    }
}
