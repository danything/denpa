namespace Denpa.Agent.Tests;

/*
 * 自前方式 (dt295:) の設定・選局の順序を、偽の機材 (Dt295Fake) で確かめる。順序と値は仕様書 (dt295-resident/spec.md) の節のもの。
 * 実機のレジスタの読み値は偽物が作ったものなので、受信の確認などの分岐の結果は「偽物がそう返した」というだけ。
 */
public class Dt295NativeTests
{
    private static Dt295Fake Rig(int records = 40)
    {
        var fake = new Dt295Fake();
        var ring = new List<byte>();
        for (var i = 0; i < records; i++)
        {
            var record = new byte[192];
            record[0] = 0x47;
            record[1] = 0x01;
            record[3] = (byte)(0x10 | (i & 0xF));
            for (var j = 4; j < 188; j++) record[j] = (byte)(i + j);
            ring.AddRange(record);
        }
        fake.PutRing(0, ring.ToArray());
        fake.WpOnStart = (uint)ring.Count;
        return fake;
    }

    /// <summary>偽の機材を、エージェントの dt295: と同じ経路 (Dt295NativeDevice・Dt295NativeTuner) で 30 ms だけ受ける</summary>
    private static (int Code, string Output, string Log) Run(Dt295Fake fake, string channel, Action? powerCycle = null)
    {
        var port = $"test-{Guid.NewGuid():N}";
        var options = new Dt295NativeProbe.Options(port, channel, ChannelTable.Parse(channel)!, TimeSpan.FromMilliseconds(30), false);
        var output = new StringWriter();
        var log = new StringWriter();
        var code = Dt295NativeProbe.Execute(() => Dt295NativeDevice.Acquire(port, () => fake, powerCycle, _ => { }, 2000),
            () => Dt295NativeDevice.CloseIfIdle(port), options, output, log);
        return (code, output.ToString(), log.ToString());
    }

    private static int Index(IReadOnlyList<string> lines, string line, int from = 0)
    {
        var at = -1;
        for (var i = from; i < lines.Count && at < 0; i++) if (lines[i] == line) at = i;
        return at;
    }
    [Test]
    public async Task 地上波は_設定_選局_受信の確認_取り込み_受信_後始末の順で進み_TS_が連続して届く()
    {
        var fake = Rig();
        var (code, output, log) = Run(fake, "T25");
        await Assert.That(log).DoesNotContain("止めました");
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(output).Contains("受信の確認: 受かった");

        // I2C の順: T 復調の初期値 (仕様書 7.1.1) → T チューナーの初期化 (7.1.2) → S 復調 (7.1.3) → S チューナー (7.1.4) → 締め (7.1.5) → 選局 (7.2.2)
        var i2c = fake.I2cLog;
        await Assert.That(i2c[0]).IsEqualTo("10 W 0100");
        var firstS = Index(i2c, "11 W 0190");
        var closing = Index(i2c, "10 W 4700");
        var tuneHigh = Index(i2c, "10 W FEC01188");      // T25 = 545143 kHz → N = 34889 = 0x8849。上位 0x88 は初期化の 0x76 と違う
        var tuneN = tuneHigh;
        await Assert.That(firstS).IsGreaterThan(20);
        await Assert.That(closing).IsGreaterThan(firstS);
        await Assert.That(tuneHigh).IsGreaterThan(closing);
        await Assert.That(i2c[tuneHigh - 1]).IsEqualTo("10 W FEC01049");
        // 受信中は 7.2.4 のとおり 0x96、0x80 (2 バイト) を読む
        await Assert.That(i2c.Skip(tuneN).Any(line => line == "10 R 2")).IsTrue();

        // レジスタの順: チップの設定 (6 章) → USB のレジスタ (8.4) → I2C の準備 (6.4) → 取り込みの設定 (8.1.3) → 端点 (8.3.1) → 取り込み開始 → 停止 → hook を戻す
        var stores = fake.Stores;
        int At(uint address, uint? value = null, int from = 0) => stores.FindIndex(from, s => s.Address == address && (value is null || s.Value == value));
        var chip = At(0xF10118);
        var usb = At(0xFDBC04);
        var prepare = At(0xFD8FF8);
        var capture = At(0x1902020);
        var start = At(0x1902010, 0x02000000);
        var stop = At(0x1902010, 0x04000000);
        var unhook = stores.FindLastIndex(s => s.Address == Dt295NativePrograms.Hook);
        await Assert.That(chip).IsGreaterThanOrEqualTo(0);
        await Assert.That(usb).IsGreaterThan(chip);
        await Assert.That(prepare).IsGreaterThan(usb);
        await Assert.That(capture).IsGreaterThan(At(0xFD8FE4));
        await Assert.That(start).IsGreaterThan(capture);
        await Assert.That(stop).IsGreaterThan(start);
        await Assert.That(unhook).IsGreaterThan(stop);
        // hook は自前のものを書いてから、最後に元に戻す
        var hookWrites = stores.Where(s => s.Address == Dt295NativePrograms.Hook).ToList();
        await Assert.That(hookWrites[^1].Value).IsEqualTo(0xC46D02B0u);
        await Assert.That(fake.Get(Dt295NativePrograms.Hook, 4)).IsEqualTo(0xC46D02B0u);
        // チップの設定は元に戻る
        await Assert.That(fake.Get(0xF001F0, 4)).IsEqualTo(0u);
        await Assert.That(fake.Get(0x1600004, 4)).IsEqualTo(0x01000000u);
        // USB コアのレジスタに書くのは、I2C の準備の 4 つ (0xFD8010 |= 0x10、0xFD8014 &= ~0x10、0xFD80B0 |= 1、0xFD80C0 = 0) だけ。
        // 0xFD808C・0xFD8300 台と補助 CPU の端点 (0xFDBD10〜0xFDBD3F) には書かない
        await Assert.That(stores.Where(s => s.Address is (>= 0xFD8000 and <= 0xFD80FF) or (>= 0xFD8300 and <= 0xFD83FF) or (>= 0xFDBD10 and <= 0xFDBD3F))
            .Select(s => s.Address).Distinct()).IsEquivalentTo(new[] { 0xFD8010u, 0xFD8014u, 0xFD80B0u, 0xFD80C0u });
        // INITIALIZE のあとに 0xF10018 = 0x0002 (上半分。実機の常駐イメージの観測)。I2C の準備より前
        var enable = stores.FindIndex(s => s.Address == 0xF10018 && s.Value == 0x00020000);
        await Assert.That(enable).IsGreaterThan(stores.FindIndex(s => s.Address == 0xF10014));
        await Assert.That(enable).IsLessThan(stores.FindIndex(s => s.Address == 0xFD8010));
        // 窓は既定に戻る
        await Assert.That(fake.Get(0xEA3D8, 4)).IsEqualTo(0x00F00000u);
        await Assert.That(fake.Get(0xE9EBC, 4)).IsEqualTo(0x00F00000u);
        // 地上波側は休ませる (仕様書 9 章)
        await Assert.That(i2c[^5..]).IsEquivalentTo(new[] { "10 W 2500", "10 W 234D", "10 W 0390", "10 W FEC01200", "10 W FEC00B00" });

        // TS: 連続性の飛びが無く、同期バイトが全部合っている
        await Assert.That(output).Contains("continuity_counter の飛び: 0 回");
        await Assert.That(output).Contains("(100.00%)");
        await Assert.That(output).Contains("最初の TS:");
        // 受信中の C/N の生の値 (地上波は 0x8B から 3 バイト。dB には直さない)
        await Assert.That(output).Contains("信号 (");
        await Assert.That(output).Contains("地上波 0x8B");
        await Assert.That(output).DoesNotContain("来なかった");
    }

    [Test]
    public async Task 衛星は_T_側を休ませてから周波数と_VCO_帯を書き_TSID_を選んで受信を確認する()
    {
        var fake = Rig();
        var (code, output, log) = Run(fake, "BS15:16400");
        await Assert.That(log).DoesNotContain("止めました");
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(output).Contains("受信の確認: 受かった");
        // 受信中の C/N の生の値 (衛星は 0xBC から 2 バイト。dB には直さない)
        await Assert.That(output).Contains("衛星 0xBC");
        await Assert.That(output).Contains("dB には直していません");
        var i2c = fake.I2cLog;
        // BS15 の IF = 1318000 kHz → M = 1318 → N = M。reg 00〜04 = 0A 4C 00 00 00、reg 09 = 8C (仕様書 7.3.3)
        var frequency = Index(i2c, "11 W FEC0000A4C000000");
        await Assert.That(frequency).IsGreaterThan(0);
        await Assert.That(Index(i2c, "11 W FEC0098C", frequency)).IsEqualTo(frequency + 1);
        // 選局の始め: T 側を休ませる (7.3.2 の t=1)
        var rest = Index(i2c, "10 W 2500", Index(i2c, "10 W 4700"));
        await Assert.That(rest).IsGreaterThan(0);
        await Assert.That(rest).IsLessThan(frequency);
        // TS の出し元を衛星にする: T 復調の 0E=77、0F=77
        await Assert.That(Index(i2c, "10 W 0E77", frequency)).IsGreaterThan(frequency);
        await Assert.That(Index(i2c, "10 W 0F77", frequency)).IsGreaterThan(frequency);
        // TSID を S 復調 0x8F〜0x90 に書く (7.3.4 の段 2)。16400 = 0x4010
        await Assert.That(Index(i2c, "11 W 8F4010", frequency)).IsGreaterThan(frequency);
    }

    [Test]
    public async Task TSID_が_TMCC_の表に無い衛星の選局は失敗にして_後始末をする()
    {
        var fake = Rig();
        var (code, _, log) = Run(fake, "BS15:16625");
        await Assert.That(code).IsEqualTo(1);
        await Assert.That(log).Contains("TSID 16625");
        // 失敗しても hook を元に戻す
        await Assert.That(fake.Get(Dt295NativePrograms.Hook, 4)).IsEqualTo(0xC46D02B0u);
        await Assert.That(fake.Get(0xEA3D8, 4)).IsEqualTo(0x00F00000u);
    }

    [Test]
    public async Task 常駐方式の_hook_が入った機材には何も書かずに断る()
    {
        var fake = Rig();
        // 仕様書 3.2 の常駐方式の hook
        byte[] resident = [0x9B, 0xEC, 0x14, 0xF4, 0x97, 0x0C, 0x9F, 0xA0];
        for (var i = 0; i < 8; i++) fake.Bytes[Dt295NativePrograms.Hook + (uint)i] = resident[i];
        var (code, _, log) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(1);
        await Assert.That(log).Contains("挿し直して");
        // 窓を既定にする書き込み以外、機材のメモリは書き換えない
        await Assert.That(fake.Stores.All(s => s.Address is 0xEA3D8 or 0xE9EBC)).IsTrue();
    }

    [Test]
    public async Task 起動直後でない機材は断る()
    {
        var fake = Rig();
        fake.Put(0xF02008, 4, 0x00010000);    // 0x82008 は窓の既定で 0xF02008 (仕様書 3.1)
        var (code, _, log) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(1);
        await Assert.That(log).Contains("起動直後");
    }

    [Test]
    public async Task 地上波の周波数レジスタと衛星の_VCO_帯は仕様書の表のとおり()
    {
        // 7.2.3
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(111143)).IsEqualTo(0x1BC9);
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(165143)).IsEqualTo(0x2949);
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(255143)).IsEqualTo(0x3FC9);
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(473143)).IsEqualTo(0x7649);
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(557143)).IsEqualTo(0x8B49);
        await Assert.That(Dt295NativeFrontend.TerrestrialDivider(707143)).IsEqualTo(0xB0C9);
        // 7.3.3 のエミュレータで確かめた例
        foreach (var (khz, registers, band) in new (uint, string, byte)[]
        {
            (950000, "0ED8000080", 0x3C), (1049480, "1064000080", 0x58), (1101000, "089A000000", 0x54),
            (1613000, "0C9A000000", 0xC4), (2150000, "10CC000000", 0xE0),
        })
        {
            var (actual, actualBand) = Dt295NativeFrontend.SatelliteDivider(khz);
            await Assert.That(Convert.ToHexString(actual)).IsEqualTo(registers);
            await Assert.That(actualBand).IsEqualTo(band);
        }
    }

    [Test]
    public async Task TMCC_の階層ごとのセグメント数から実在する階層を出す()
    {
        // A = 13 セグメントだけ (B・C は 0xF = なし): B4 >> 3 = 13、B5 の上位 = 0xF の下位、B6 >> 6、B7 >> 1 = 0xF
        byte[] only = [0, 0, 13 << 3, 0x03, 0xC0, 0x1E, 0, 0];
        await Assert.That(Dt295NativeFrontend.PresentLayers(only)).IsEqualTo(0x80);
        // 合計が 13 でなければ無効
        byte[] wrong = [0, 0, 12 << 3, 0x03, 0xC0, 0x1E, 0, 0];
        await Assert.That(Dt295NativeFrontend.PresentLayers(wrong)).IsEqualTo(0);
        // A = 1、B = 12、C = なし
        byte[] two = [0, 0, 1 << 3, 0x03, 0x00, 0x1E, 0, 0];
        await Assert.That(Dt295NativeFrontend.PresentLayers(two)).IsEqualTo(0xC0);
    }

    [Test]
    public async Task I2C_は_ACK_が来ないアドレスを失敗にして_バスを止める()
    {
        var fake = new Dt295Fake();
        var link = new Dt295NativeLink(fake);
        var i2c = new Dt295NativeI2c(link);
        Assert.Throws<Dt295NativeException>(() => i2c.Write(0x20, 0x00));
        // 失敗のあとも続けて使える
        i2c.Write(0x10, 0x01, 0x23);
        await Assert.That(fake.Terrestrial.Regs[0x01]).IsEqualTo((byte)0x23);
        i2c.Write(0x10, 0x01);
        await Assert.That(i2c.Read(0x10, 1)[0]).IsEqualTo((byte)0x23);
        await Assert.That(i2c.Transfers).IsEqualTo(4L);
    }

    [Test]
    public async Task USB_コアの割り込み_クロックのレジスタは許可しないと書けない()
    {
        var fake = new Dt295Fake();
        var link = new Dt295NativeLink(fake);
        Assert.Throws<Dt295NativeException>(() => link.Write32(0xFD8010, 0x08080000));
        Assert.Throws<Dt295NativeException>(() => link.MaskWrite(0xFD8300, 1, 1));
        // 範囲の書き込みも同じ。書けない語が途中にあれば、前の語も書かない
        Assert.Throws<Dt295NativeException>(() => link.WriteBytes(0xFD7FFC, new byte[8]));
        Assert.Throws<Dt295NativeException>(() => link.WriteBytes(0xFEA000, new byte[4]));
        await Assert.That(fake.Stores.Count).IsEqualTo(0);
        link.AllowedCoreWrites.Add(0xFD8010);
        link.Write32(0xFD8010, 0x10);
        await Assert.That(fake.Get(0xFD8010, 4)).IsEqualTo(0x10u);
    }

    [Test]
    public async Task I2C_の準備はクロックと割り込みを足して書き_書いた値で読めれば_Alive()
    {
        var fake = new Dt295Fake();
        fake.Put(0xFD8010, 4, 4);
        fake.Put(0xFD80C0, 4, 3);
        var link = new Dt295NativeLink(fake);
        // 許可が無ければ書けない (ガード)
        Assert.Throws<Dt295NativeException>(() => new Dt295NativeI2c(link).Prepare());
        foreach (var register in Dt295NativeI2c.ClockRegisters) link.AllowedCoreWrites.Add(register);
        var bus = new Dt295NativeI2c(link);
        bus.Prepare();
        await Assert.That(fake.Stores.Where(s => s.Address is 0xFD8010 or 0xFD8014 or 0xFD80B0 or 0xFD80C0).Select(s => (s.Address, s.Value)))
            .IsEquivalentTo(new[] { (0xFD8010u, 0x14u), (0xFD8014u, 0u), (0xFD80B0u, 1u), (0xFD80C0u, 0u) });
        await Assert.That(bus.Alive).IsTrue();
    }

    [Test]
    public async Task f10080_から_f10098_の_7_語は_INITIALIZE_の前に_32_ビットで_0x00010000_を書き_読まずに_終わりに_0_に戻す()
    {
        var fake = Rig();
        var (code, _, _) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(0);
        uint[] words = [0xF10080, 0xF10084, 0xF10088, 0xF1008C, 0xF10090, 0xF10094, 0xF10098];
        foreach (var address in words)
        {
            var values = fake.Stores.Where(s => s.Address == address).Select(s => s.Value).ToList();
            await Assert.That(values).IsEquivalentTo(new[] { 0x00010000u, 0u });
        }
        // 0xF10080〜0xF100FF は一度も読まない (書く前の値も、書いたあとの読み戻しも)
        await Assert.That(fake.ReadsF10080).IsEqualTo(0);
        // 0xF10118 (INITIALIZE の最初の書き込み) より前
        await Assert.That(fake.Stores.FindIndex(s => s.Address == 0xF10098 && s.Value == 0x00010000)).IsLessThan(fake.Stores.FindIndex(s => s.Address == 0xF10118));
    }

    [Test]
    public async Task f10114_のビット_21_は_I2C_の準備の直前に足して書き_読み戻しを記録に出し_終わりに戻す()
    {
        var fake = Rig();
        fake.Put(0xF10114, 4, 0x80000000);
        var (code, _, _) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(fake.Stores.Where(s => s.Address == 0xF10114).Select(s => s.Value)).IsEquivalentTo(new[] { 0x80200000u, 0x80000000u });
        // I2C の準備 (0xFD8FF8 の書き込み) より前
        await Assert.That(fake.Stores.FindIndex(s => s.Address == 0xF10114)).IsLessThan(fake.Stores.FindIndex(s => s.Address == 0xFD8FF8));
    }

    [Test]
    public async Task 取り込みの開始と停止は_0x1902010_に_0x02000000_と_0x04000000_を書き_0x1900020_を_0x22000200_にして終わりに戻す()
    {
        var fake = Rig();
        fake.Put(0x1900020, 4, 0x02000200);
        var (code, _, log) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(0);
        var starts = fake.Stores.Where(s => s.Address == 0x1902010).Select(s => s.Value).ToList();
        await Assert.That(starts).IsEquivalentTo(new[] { 0x02000000u, 0x04000000u });
        await Assert.That(fake.Stores.Where(s => s.Address == 0x1900020).Select(s => s.Value)).IsEquivalentTo(new[] { 0x22000200u, 0x02000200u });
    }

    [Test]
    public async Task f1001c_は_INITIALIZE_で_0x50800000_を落とし_F10018_と一緒に_0x00020000_を立て_終わりに戻す()
    {
        var fake = Rig();
        fake.Put(0xF1001C, 4, 0x7FFD0000);
        var (code, _, log) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(fake.Stores.Where(s => s.Address == 0xF1001C).Select(s => s.Value))
            .IsEquivalentTo(new[] { 0x2F7D0000u, 0x2F7F0000u, 0x7FFD0000u });
        // 0xF1001C の 2 回目は 0xF10018 と同じ段階 (0xF10018 = 0x00020000 の書き込みのあと)
        var stores = fake.Stores;
        await Assert.That(stores.FindIndex(s => s.Address == 0xF1001C && s.Value == 0x2F7F0000)).IsGreaterThan(stores.FindIndex(s => s.Address == 0xF10018 && s.Value == 0x00020000));
    }

    [Test]
    public async Task I2C_の準備は_0xFD8014_の_bit4_だけを落とし_0x08080000_を足さない()
    {
        var fake = new Dt295Fake();
        fake.Put(0xFD8014, 4, 0x0F3F001B);
        var link = new Dt295NativeLink(fake);
        foreach (var register in Dt295NativeI2c.ClockRegisters) link.AllowedCoreWrites.Add(register);
        var bus = new Dt295NativeI2c(link);
        var saved = bus.Prepare();
        await Assert.That(fake.Stores.Where(s => s.Address == 0xFD8014).Select(s => s.Value)).IsEquivalentTo(new[] { 0x0F3F000Bu });
        // 戻すと元の値 (bit4 が立った値) に戻る
        bus.Restore(saved);
        await Assert.That(fake.Get(0xFD8014, 4)).IsEqualTo(0x0F3F001Bu);
    }

    [Test]
    public async Task I2C_のレジスタが書いた値で読めなければ_Alive_にならない()
    {
        var fake = new Dt295Fake { I2cDead = true };
        var link = new Dt295NativeLink(fake);
        foreach (var register in Dt295NativeI2c.ClockRegisters) link.AllowedCoreWrites.Add(register);
        var bus = new Dt295NativeI2c(link);
        bus.Prepare();
        await Assert.That(bus.Alive).IsFalse();
    }

    [Test]
    public async Task 窓を通すアクセスは_バンクを動かして読み書きし_戻すと既定に戻る()
    {
        var fake = new Dt295Fake();
        fake.Put(0x1900404, 4, 0xABCD0123);
        var link = new Dt295NativeLink(fake);
        await Assert.That(link.Read32(0x1900404)).IsEqualTo(0xABCD0123u);
        // 読む側の窓だけ動く
        await Assert.That(fake.Get(0xE9EBC, 4)).IsEqualTo(0x01900000u);
        await Assert.That(fake.Get(0xEA3D8, 4)).IsEqualTo(0x00F00000u);
        link.Write32(0x1900408, 5);
        await Assert.That(fake.Get(0x1900408, 4)).IsEqualTo(5u);
        link.Write16(0x1901002, 0x0607);
        await Assert.That(fake.Get(0x1901000, 4)).IsEqualTo(0x00000607u);
        link.RestoreWindows();
        await Assert.That(fake.Get(0xE9EBC, 4)).IsEqualTo(0x00F00000u);
        await Assert.That(fake.Get(0xEA3D8, 4)).IsEqualTo(0x00F00000u);
    }

    [Test]
    public async Task 閉じたあとの機材は起動直後の状態に戻り_続けて開き直せる()
    {
        var fake = Rig();
        var first = Run(fake, "T25");
        await Assert.That(first.Code).IsEqualTo(0);
        // 後始末で hook は元のまま、状態も 0 (実機の再実行と同じ)
        await Assert.That(fake.Get(Dt295NativePrograms.Hook, 4)).IsEqualTo(0xC46D02B0u);
        // 続けて開き直せる (電源の入れ直しなし)。取り込みのリングは偽物が使い切ったので、TS は流さず、開いて閉じるだけ
        var port = $"test-{Guid.NewGuid():N}";
        var again = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000);
        await Assert.That(again.Faulted).IsFalse();
        again.Release();
        Dt295NativeDevice.CloseIfIdle(port);
        await Assert.That(fake.Get(Dt295NativePrograms.Hook, 4)).IsEqualTo(0xC46D02B0u);
    }

    [Test]
    public async Task 自前の_hook_が残った機材は_Linux_ではポートの電源を入れ直してから開き_ほかの_OS_では挿し直しを求めて断る()
    {
        var fake = Rig();
        // 前の実行が途中で止まった状態: 自前の body と hook が残っている
        fake.PlaceBody(hook: true);

        var refused = Run(fake, "T25");
        await Assert.That(refused.Code).IsEqualTo(1);
        await Assert.That(refused.Log).Contains("挿し直してください");
        await Assert.That(fake.Stores.All(s => s.Address is 0xEA3D8 or 0xE9EBC)).IsTrue();

        var cycled = 0;
        var accepted = Run(fake, "T25", () =>
        {
            cycled++;
            for (var i = 0; i < 8; i++) fake.Bytes[Dt295NativePrograms.Hook + (uint)i] = Dt295NativePrograms.OriginalHook[i];
        });
        await Assert.That(cycled).IsEqualTo(1);
        await Assert.That(accepted.Code).IsEqualTo(0);
    }

    [Test]
    public async Task 主_CPU_から動かした_I2C_が読めない機材は_何も続けずに設定を戻して断る()
    {
        var fake = Rig();
        fake.I2cDead = true;
        fake.Put(0xFD8010, 4, 4);
        var (code, _, log) = Run(fake, "T25");
        await Assert.That(code).IsEqualTo(1);
        await Assert.That(log).Contains("I2C のレジスタが書いた値で読めません");
        // 書いた設定は戻る
        await Assert.That(fake.Get(0xFD8010, 4)).IsEqualTo(4u);
        await Assert.That(fake.Get(Dt295NativePrograms.Hook, 4)).IsEqualTo(0xC46D02B0u);
    }

    [Test]
    public async Task 復調の初期値は番号が続くレジスタを_1_転送にまとめ_値と順は表のとおり()
    {
        var fake = Rig();
        Run(fake, "T25");
        var i2c = fake.I2cLog;
        // T 復調 (7.1.1): 0x1C〜0x1F、0x25〜0x26、0x3B〜0x3C、0x73〜0x77 は続く番号
        await Assert.That(i2c).Contains("10 W 1C20566A9A");
        await Assert.That(i2c).Contains("10 W 250000");
        await Assert.That(i2c).Contains("10 W 3B213F");
        await Assert.That(i2c).Contains("10 W 734511020001");
        await Assert.That(i2c).DoesNotContain("10 W 7445");
        // S 復調 (7.1.3): 0x03〜0x04、0x07〜0x08、0x10〜0x11、0x1C〜0x1F
        await Assert.That(i2c).Contains("11 W 030002");
        await Assert.That(i2c).Contains("11 W 073311");
        await Assert.That(i2c).Contains("11 W 10B000");
        await Assert.That(i2c).Contains("11 W 1C59AA2019");    }

    [Test]
    public async Task S_側の初期化は_T_チューナーの_100_ms_の待ちの間に入る()
    {
        var fake = Rig();
        Run(fake, "T25");
        var i2c = fake.I2cLog;
        var afterWait = Index(i2c, "10 W FEC00301");          // T チューナーの 03=01。ここから 100 ms の待ち
        var firstS = Index(i2c, "11 W 0190");                  // S 復調の最初の書き込み
        var lastS = Index(i2c, "11 W FEC011C0A7");             // S チューナーの最後の書き込み
        var resumed = Index(i2c, "10 W FEC00D", afterWait);    // 待ちのあとの T チューナーの 0x0D の読み・変更・書き
        await Assert.That(afterWait).IsGreaterThan(0);
        await Assert.That(firstS).IsGreaterThan(afterWait);
        await Assert.That(lastS).IsGreaterThan(firstS);
        await Assert.That(resumed == -1 || resumed > lastS).IsTrue();
    }

    [Test]
    public async Task 時間の内訳は設定_各待ち_選局_ロック待ち_取り込み_最初の_TS_を制御転送と_I2C_の数つきで出す()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var timeline = new Dt295Timeline();
        var options = new Dt295NativeProbe.Options(port, "T25", ChannelTable.Parse("T25")!, TimeSpan.FromMilliseconds(30), false);
        var output = new StringWriter();
        var code = Dt295NativeProbe.Execute(() => Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000, timeline),
            () => Dt295NativeDevice.CloseIfIdle(port), options, output, new StringWriter(), timeline);
        await Assert.That(code).IsEqualTo(0);
        var text = output.ToString();
        await Assert.That(text).Contains("時間の内訳");
        // チップの設定の段、I2C の段、各待ち (理由つき)、選局、受信の確認の周回、取り込み、最初の TS
        foreach (var expected in new[]
        {
            "手順 1〜3", "手順 10〜12", "T 復調の初期値", "T チューナーの初期化", "S 復調の初期値", "待ち 100 ms (この間に別の仕事) (仕様書 7.1.2", "待ち 4 ms (仕様書 7.1.3",
            "t=23 周波数の設定", "待ち 100 ms (仕様書 7.2.2。t=46", "受信の確認 (地上波)", "取り込みの設定", "取り込みの開始", "最初の TS を待つ", "固定の待ち:",
        })
        {
            await Assert.That(text).Contains(expected);
        }
        // カードは選局と並べて準備し、開き始めてからの時間を出す (偽の機材にカードは無いので、済んでいない)
        await Assert.That(text).Contains("カード: 準備完了まで");
        // 受信の確認は周回と待ちの合計を補足に出す
        await Assert.That(text).Contains("周、周の間の待ち");
        // 待ちの合計は、7.1 の 130 ms と 7.2.2 の 140 ms を含む
        var waits = text.Split('\n').First(line => line.StartsWith("固定の待ち:", StringComparison.Ordinal));
        await Assert.That(waits).Contains("合計");
        // 受信の平均は、最初の読みから最後の読みまでの秒数で割る (読みが 1 回だけなら求められないと出す)
        await Assert.That(text).Contains("受信の平均:");
    }

    [Test]
    public async Task 止めたあとに残った読み手はスレッドから例外を出さずに終わり_Output_を取り直すと例外になる()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var tuner = new Dt295NativeTuner("test", () => Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000), () => Dt295NativeDevice.CloseIfIdle(port));
        var tuning = ChannelTable.Parse("T25")!;
        tuner.Tune(tuning, tuning.StreamId);
        // 本番の読み手 (TunerPool.Read) と同じく、Output は 1 回だけ取って DeviceStream として読み続ける
        var ring = (DeviceStream)tuner.Output;
        var reader = Task.Run(() =>
        {
            var buffer = new byte[188 * 64];
            try
            {
                while (ring.Read(buffer, 0, buffer.Length, () => false) > 0)
                {
                }
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                // TunerPool.Read も catch して記録するだけ
            }
        });

        tuner.Dispose();

        await Assert.That(await Task.WhenAny(reader, Task.Delay(TimeSpan.FromSeconds(10)))).IsSameReferenceAs(reader);
        await reader;
        Assert.Throws<InvalidOperationException>(() => _ = tuner.Output);
    }

    [Test]
    public async Task カードが読み書きしている間だけ_TS_の要求を小さくする()
    {
        var fake = Rig();
        var link = new Dt295NativeLink(fake);
        await Assert.That(link.CardBusy).IsFalse();
        link.EnterCard();
        await Assert.That(link.CardBusy).IsTrue();
        link.LeaveCard();
        await Assert.That(link.CardBusy).IsFalse();
        var (small, large) = (Dt295NativeStream.CardKickPackets, Dt295NativeStream.KickPackets);
        await Assert.That(small < large).IsTrue();

        // カードの送受信の間だけ立ち、終わったら戻る
        var atr = Convert.FromHexString("3BF01200FF9181B17C451F0399");
        fake.CardAtr = atr;
        fake.CardResponder = block => (block[1] & 0xC0) == 0xC0 ? T1Protocol.Block((byte)(block[1] | 0x20), block[3..^1]) : T1Protocol.Block(0x00, [0x90, 0x00]);
        using var card = new Dt295NativeCard("DT295 カード", () => link, delay: _ => { });
        card.Reset();
        await Assert.That(link.CardBusy).IsFalse();
        card.Transmit([0x90, 0x32, 0x00, 0x00, 0x00]);
        await Assert.That(link.CardBusy).IsFalse();
    }

    [Test]
    public async Task 制御転送が通らなくなった機材は_後始末の書き込みを省いて閉じ_次に取るときは開き直す()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var device = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000);
        fake.Wedged = true;
        Assert.Throws<IOException>(() => device.Link.Read32(0xFD8010));
        await Assert.That(device.Faulted).IsTrue();
        var stores = fake.Stores.Count;
        device.Release();
        // 閉じるときは書き込みを 1 つも試みない
        await Assert.That(fake.Stores.Count).IsEqualTo(stores);
        // ポートの電源を入れ直した (新しい機材と同じ起動直後の状態に戻った)
        var again = Dt295NativeDevice.Acquire(port, () => Rig(), null, _ => { }, 2000);
        await Assert.That(again).IsNotSameReferenceAs(device);
        again.Release();
        Dt295NativeDevice.CloseIfIdle(port);
    }

    [Test]
    public async Task 同じ種別の選局し直しは頭の手順を省き_種別が替わるときは前の側を休ませる()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var device = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000);
        List<string> Tune(Action action)
        {
            var from = fake.I2cLog.Count;
            action();
            return fake.I2cLog.Skip(from).ToList();
        }
        var terrestrial = (Action)(() => device.Frontend.TuneTerrestrial(545143));
        var satellite = (Action)(() => device.Frontend.TuneSatellite(1318000));

        // 開いたあとの最初の地上波: 0B=01 (チューナーを動かす) が先頭に入る
        var first = Tune(terrestrial);
        await Assert.That(first).Contains("10 W FEC00B01");
        // 続けて地上波: 0B=01 は前に地上波を選んでいるので入らない。12=01 と 20 ms の待ちは入る
        var again = Tune(terrestrial);
        await Assert.That(again).DoesNotContain("10 W FEC00B01");
        await Assert.That(again).Contains("10 W FEC01201");
        await Assert.That(again.Count).IsLessThan(first.Count);

        // 衛星へ: 先に T 側を休ませ (復調 25=00・23=4D・03=90)、TS の出し元を衛星にする (T 復調 0E=77・0F=77)
        var toSatellite = Tune(satellite);
        await Assert.That(toSatellite).Contains("10 W 2500");
        await Assert.That(toSatellite).Contains("10 W 0E77");
        // 続けて衛星: T 側はもう休んでいるので休ませる表は入らない
        var satelliteAgain = Tune(satellite);
        await Assert.That(satelliteAgain).DoesNotContain("10 W 2500");
        await Assert.That(satelliteAgain).Contains("10 W 0E77");

        // 地上波へ戻る: 先に S 側を休ませる表 (S 復調 1C=AA ほか。仕様書 7.2.2。推定) が入り、0B=01 も入る
        var back = Tune(terrestrial);
        await Assert.That(back).Contains("11 W 1CAA");
        await Assert.That(back).Contains("11 W 1728".Replace("1728", "1701"));
        await Assert.That(back).Contains("10 W FEC00B01");

        device.Release();
        Dt295NativeDevice.CloseIfIdle(port);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ロックの試験は_くり返した回数と成功の割合と時間を出し_全部成功なら_0_を返す(bool reopen)
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var options = new Dt295NativeProbe.Options(port, "T25", ChannelTable.Parse("T25")!, TimeSpan.FromSeconds(1), false, LockTest: 3, Reopen: reopen);
        var output = new StringWriter();

        var code = Dt295NativeProbe.LockTest(options, timeline => Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000, timeline),
            () => Dt295NativeDevice.CloseIfIdle(port), () => Dt295NativeDevice.CloseIfIdle(port), output);

        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains($"機材を開き直す: {(reopen ? "はい" : "いいえ")}");
        await Assert.That(text).Contains("結果: 成功 3/3 (100.0%)");
        await Assert.That(text).Contains("受信の確認 最小");
    }

    [Test]
    public async Task 復調のレジスタの経過は_ロックの印が立つまでと立ってからの標本を読み_書き込みをしない()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var options = new Dt295NativeProbe.Options(port, "T25", ChannelTable.Parse("T25")!, TimeSpan.FromSeconds(1), false, DemodTrace: true);
        var output = new StringWriter();
        var storesBefore = 0;

        var code = Dt295NativeProbe.DemodTrace(options, timeline =>
        {
            var device = Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000, timeline);
            storesBefore = fake.Stores.Count;
            return device;
        }, () => Dt295NativeDevice.CloseIfIdle(port), output);

        var text = output.ToString();
        await Assert.That(code).IsEqualTo(0);
        await Assert.That(text).Contains("T 復調のレジスタの経過: T25");
        await Assert.That(text).Contains("ロックの印 (0x81 の bit4)");
        // 選局のあと標本を読むだけで、USB のレジスタには書かない
        await Assert.That(fake.Stores.Skip(storesBefore).Any(s => s.Address is >= 0xFD8000 and <= 0xFD80FF)).IsFalse();
    }

    [Test]
    public async Task 同じチャンネルをもう一度選局すると_受信が続いていれば周波数を書き直さず_取り込みは始め直して_TS_が届く()
    {
        var fake = Rig();
        var port = $"test-{Guid.NewGuid():N}";
        var tuner = new Dt295NativeTuner("test", () => Dt295NativeDevice.Acquire(port, () => fake, null, _ => { }, 2000), () => Dt295NativeDevice.CloseIfIdle(port));
        var t25 = ChannelTable.Parse("T25")!;
        var t26 = ChannelTable.Parse("T26")!;
        int Writes() => fake.I2cLog.Count(line => line.StartsWith("10 W FEC011"));
        try
        {
            tuner.Tune(t25, t25.StreamId);
            var first = Writes();
            await Assert.That(first).IsGreaterThan(0);
            var starts = fake.Stores.Count(s => s.Address == 0x1902010 && s.Value == 0x02000000);

            tuner.Tune(t25, t25.StreamId);
            await Assert.That(Writes()).IsEqualTo(first);
            await Assert.That(fake.Stores.Count(s => s.Address == 0x1902010 && s.Value == 0x02000000)).IsEqualTo(starts + 1);
            var ring = (DeviceStream)tuner.Output;
            var buffer = new byte[188 * 8];
            var got = 0;
            var giveUp = System.Diagnostics.Stopwatch.StartNew();
            while (got < buffer.Length)
            {
                var n = ring.Read(buffer, got, buffer.Length - got, () => giveUp.Elapsed > TimeSpan.FromSeconds(10));
                if (n <= 0) break;
                got += n;
            }
            await Assert.That(got).IsEqualTo(buffer.Length);
            await Assert.That(buffer[0]).IsEqualTo((byte)0x47);

            // 別のチャンネルでは周波数を書く
            tuner.Tune(t26, t26.StreamId);
            await Assert.That(Writes()).IsGreaterThan(first);

            // 別の手段で復調の周波数が替わっていたら (診断の離れる選局など)、同じチャンネルでも選局し直す
            tuner.Tune(t25, t25.StreamId);
            var settled = Writes();
            tuner.Device!.Frontend.TuneTerrestrial((uint)((t26.Frequency + 500UL) / 1000));
            var away = Writes();
            await Assert.That(away).IsGreaterThan(settled);
            tuner.Tune(t25, t25.StreamId);
            await Assert.That(Writes()).IsGreaterThan(away);
        }
        finally
        {
            tuner.Dispose();
        }
    }

    [Test]
    public async Task 同期が続く範囲をまとめて渡し_端数は次に持ち越し_同期のずれは捨てる()
    {
        byte[] Packets(int count, byte tag) => Enumerable.Range(0, count).SelectMany(i => new byte[188].Select((_, at) => at == 0 ? (byte)0x47 : tag)).ToArray();
        var framer = new NativeTsFramer();
        var runs = new List<byte[]>();
        // 3 パケットと 100 バイトの端数。まとめて 1 つ
        var data = Packets(3, 1).Concat(new byte[100].Select((_, at) => at == 0 ? (byte)0x47 : (byte)2)).ToArray();
        framer.PushRuns(data, run => runs.Add(run.ToArray()));
        await Assert.That(runs.Count).IsEqualTo(1);
        await Assert.That(runs[0].Length).IsEqualTo(188 * 3);
        // 続きで端数が 1 パケットになる (持ち越しがあるときは 1 パケットずつ)
        framer.PushRuns(new byte[88].Select(_ => (byte)2).Concat(Packets(1, 3)).ToArray(), run => runs.Add(run.ToArray()));
        await Assert.That(runs.Sum(r => r.Length)).IsEqualTo(188 * 5);
        await Assert.That(runs[1][0]).IsEqualTo((byte)0x47);
        // 同期のずれは 1 バイトずつ捨て、そのあとの範囲を 1 つで渡す
        runs.Clear();
        framer.PushRuns(new byte[] { 0, 0, 0 }.Concat(Packets(2, 4)).ToArray(), run => runs.Add(run.ToArray()));
        await Assert.That(runs.Count).IsEqualTo(1);
        await Assert.That(runs[0].Length).IsEqualTo(188 * 2);
        await Assert.That(framer.Discarded).IsEqualTo(3L);
    }
}