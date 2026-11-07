using static Denpa.Agent.Fr30Reg;

namespace Denpa.Agent.Tests;

/*
 * 自前方式 (dt295:) の FR30 のプログラム (Dt295NativePrograms.cs) を、Fr30Machine で hook から動かして仕様書 (dt295-resident/spec.md) と照らす。
 * 機材の振る舞い (リング・FIFO・確定) は Dt295Fake が仕様書の 8.2・8.3 から決めたもの。
 */
public class Dt295NativeProgramsTests
{
    private const uint Length = Dt295NativePrograms.RingLength;
    private const uint Frame = Dt295NativePrograms.Frame;

    /// <summary>記録 1 つ = 188 バイトの TS + 後ろの 4 バイト (仕様書 8.2)。PID 0x100、continuity_counter は i、ペイロードは i と位置から決める</summary>
    private static byte[] Record(int i)
    {
        var record = new byte[192];
        record[0] = 0x47;
        record[1] = 0x01;
        record[2] = 0x00;
        record[3] = (byte)(0x10 | (i & 0xF));
        for (var j = 4; j < 188; j++) record[j] = (byte)(i * 7 + j * 3 + 1);
        for (var j = 188; j < 192; j++) record[j] = 0xEE;
        return record;
    }

    /// <summary>リングの <paramref name="start"/> から記録を <paramref name="count"/> 個。長さで折り返す。書き込み位置を返す</summary>
    private static uint Fill(Dt295Fake fake, uint start, int count)
    {
        for (var i = 0; i < count; i++)
        {
            var record = Record(i);
            for (var j = 0; j < 192; j++) fake.Bytes[Dt295Fake.RingBase + (uint)((start + (uint)(i * 192) + (uint)j) % Length)] = record[j];
        }
        return (uint)((start + (uint)(count * 192)) % Length);
    }

    private static byte[] Expected(int count) => Enumerable.Range(0, count).SelectMany(i => Record(i).Take(188)).ToArray();

    private static byte[] Output(Dt295Fake fake) => fake.Packets.SelectMany(packet => packet).ToArray();

    private static Dt295Fake Rig()
    {
        var fake = new Dt295Fake();
        fake.PlaceBody(hook: true);
        return fake;
    }

    private static NativeReply Kick(Dt295Fake fake, uint packets, uint idle = 100) =>
        new Dt295NativeLink(fake).Pump(packets, idle, 1000);

    private static void State(Dt295Fake fake, uint rp, uint pos, uint k, bool aligned)
    {
        fake.Put(Frame + Dt295NativePrograms.StateRp, 4, rp);
        fake.Put(Frame + Dt295NativePrograms.StatePos, 4, pos);
        fake.Put(Frame + Dt295NativePrograms.StateK, 4, k);
        fake.Put(Frame + Dt295NativePrograms.StateAligned, 4, aligned ? 1u : 0);
    }

    [Test]
    public async Task hook_は_body_の入口へ飛ぶ_8_バイトで_元の命令列は仕様書のとおり()
    {
        var image = Dt295NativePrograms.Build();
        // LDI:20 #0xE1000,R12 / JMP @R12 / NOP (仕様書 3.2 の例は #0xE14F4。飛び先だけが違う)
        await Assert.That(Convert.ToHexString(image.HookBytes)).IsEqualTo("9BEC1000970C9FA0");
        // 元の 8 バイトの前半 3 語は ldi:8 #0x46,r13 / ldub @(r13,r11),r0 / cmp #1,r0
        var asm = new Fr30Assembler(Dt295NativePrograms.Hook);
        asm.Ldi8(0x46, R13);
        asm.LdubAc(R11, R0);
        asm.CmpI(1, R0);
        var words = asm.Words().SelectMany(word => new[] { (byte)(word >> 8), (byte)word }).ToArray();
        await Assert.That(words).IsEquivalentTo(Dt295NativePrograms.OriginalHook[..6]);
        // BNE +0x2B 語の飛び先は 0xEA75A、手前の落ちる先は 0xEA704 (仕様書 3.2)
        var branch = Dt295NativePrograms.Hook + 6;
        await Assert.That(branch + 2 + 0x2B * 2).IsEqualTo(Dt295NativePrograms.ContinueWrite);
        await Assert.That(branch + 2).IsEqualTo(Dt295NativePrograms.ContinueMask);
        // プログラムは作業域の前に収まる
        await Assert.That(image.CodeBytes).IsLessThanOrEqualTo((int)(Frame - Dt295NativePrograms.BodyOrigin));
    }

    [Test]
    public async Task 入口の条件が合わない要求は元の分岐先へ戻り_壊すレジスタは_R0_R12_R13_だけ()
    {
        foreach (var (low, expectedPc, expectedR0) in new (byte, uint, uint)[] { (1, Dt295NativePrograms.ContinueMask, 1), (0, Dt295NativePrograms.ContinueWrite, 0), (5, Dt295NativePrograms.ContinueWrite, 5) })
        {
            var fake = Rig();
            fake.CpuSetup = _ => { };
            var link = new Dt295NativeLink(fake);
            // wValue 下位 1 はマスク付き、0 は普通の書き込み、5 は ldub の値が 1 でないので普通の書き込みの側
            fake.Put(0x300000, 4, 0);
            fake.ControlOut(0x40, 0xBC, (ushort)(0x3000 | low), 0, low == 1 ? new byte[8] : new byte[4], 1000);
            var cpu = fake.Cpu!;
            await Assert.That(cpu.Pc).IsEqualTo(expectedPc);
            await Assert.That(cpu.R[13]).IsEqualTo(0x46u);
            await Assert.That(cpu.R[0]).IsEqualTo(expectedR0);
            for (var i = 1; i < 16; i++)
            {
                if (i is 12 or 13) continue;
                await Assert.That(cpu.R[i]).IsEqualTo(i == 11 ? Dt295NativePrograms.Work : i == 15 ? 0xC8000u : 0x11110000u * (uint)i);
            }
            _ = link;
        }
    }

    [Test]
    public async Task 入口の印が合っても_先頭が_DNT1_でなければ元の分岐先へ戻る()
    {
        var fake = Rig();
        var request = new byte[64];
        request[0] = (byte)'X';
        fake.ControlOut(0x40, 0xBC, Dt295NativePrograms.RequestValue, Dt295NativePrograms.RequestIndex, request, 1000);
        await Assert.That(fake.Cpu!.Pc).IsEqualTo(Dt295NativePrograms.ContinueWrite);
    }

    [Test]
    public async Task リングの_40_記録を揃えて送り_188_バイトの_TS_だけが隙間なく出る()
    {
        var fake = Rig();
        fake.Wp = Fill(fake, 0, 40);
        var reply = Kick(fake, 512);
        // 仕様書 8.2.2 のエミュレータの記録: 40 記録 (7680 バイト) で 512 バイトのパケットが 14 個。残りが必要量を下回ったところで止まる
        await Assert.That(reply.Sent).IsEqualTo(14u);
        await Assert.That(reply.Result).IsEqualTo(Dt295NativePrograms.ResultIdle);
        await Assert.That(reply.Aligned).IsEqualTo(1u);
        await Assert.That(reply.Alignment).IsEqualTo(0u);
        var expected = Expected(40);
        await Assert.That(Output(fake)).IsEquivalentTo(expected[..(14 * 512)]);
        // 14 × 512 = 7168 バイト = 38 記録 + 24 バイト。読み出し位置は 192 の倍数で進む
        await Assert.That(reply.ReadPosition).IsEqualTo(38u * 192);
        await Assert.That(reply.PacketPosition).IsEqualTo(24u);
        await Assert.That(fake.Get(0x190202C, 4)).IsEqualTo(38u * 192);
    }

    [Test]
    public async Task パケットごとに_保護レジスタ_8_確定_4_戻し_0xF_の順で書き_読み出し位置を更新する()
    {
        var fake = Rig();
        fake.Wp = Fill(fake, 0, 40);
        Kick(fake, 512);
        var stores = fake.Stores.Where(s => s.Address is 0xFD814C or 0xFDBD0C or 0x190202C).ToList();
        // FIFO への書き込み (0xFDBD84) はここに入れない。パケット 14 個ぶんの (8, 4, 0xF, 読み出し位置)
        await Assert.That(stores.Count(s => s.Address == 0xFDBD0C)).IsEqualTo(14);
        var first = stores.FindIndex(s => s.Address == 0xFD814C && s.Value == 8);
        await Assert.That(stores[first + 1]).IsEqualTo((0xFDBD0Cu, 4u));
        await Assert.That(stores[first + 2]).IsEqualTo((0xFD814Cu, 0xFu));
        await Assert.That(stores[first + 3].Address).IsEqualTo(0x190202Cu);
        // 1 つめのパケットの読み出し位置: 512 バイトは 2 記録 + 136 バイトなので 3 記録目の途中。192 × 2 = 384
        await Assert.That(stores[first + 3].Value).IsEqualTo(384u);
    }

    [Test]
    public async Task 送ったあとのレジスタ_スタック_RP_は呼ぶ前と同じ()
    {
        var fake = Rig();
        fake.Wp = Fill(fake, 0, 40);
        Kick(fake, 512);
        var cpu = fake.Cpu!;
        await Assert.That(cpu.Pc).IsEqualTo(Dt295NativePrograms.StatusStage);
        foreach (var i in new[] { 8, 9, 10, 11, 13, 14 })
        {
            await Assert.That(cpu.R[i]).IsEqualTo(i == 11 ? Dt295NativePrograms.Work : 0x11110000u * (uint)i);
        }
        await Assert.That(cpu.R[15]).IsEqualTo(0xC8000u);
        await Assert.That(cpu.Rp).IsEqualTo(0xE9999u);
    }

    [Test]
    [Arguments(100u)]
    [Arguments(101u)]
    [Arguments(103u)]
    [Arguments(0u)]
    public async Task 先頭に壊れた並びがあっても_0x47_が_192_バイト間隔で_3_つ続く位置に揃え_4_の倍数でない_k_も語をずらして送る(uint k)
    {
        var fake = Rig();
        // 先頭 k バイトは 0x47 を含まないごみ
        for (var i = 0; i < k; i++) fake.Bytes[Dt295Fake.RingBase + (uint)i] = 0x55;
        fake.Wp = Fill(fake, k, 40);
        var reply = Kick(fake, 512);
        await Assert.That(reply.Alignment).IsEqualTo(k);
        await Assert.That(reply.Aligned).IsEqualTo(1u);
        await Assert.That(reply.Sent).IsGreaterThanOrEqualTo(12u);
        var expected = Expected(40);
        await Assert.That(Output(fake)).IsEquivalentTo(expected[..((int)reply.Sent * 512)]);
    }

    [Test]
    [Arguments(0u)]
    [Arguments(2u)]
    [Arguments(60u)]
    public async Task リングの終わりをまたいでも_続けて送る(uint k)
    {
        var fake = Rig();
        // 読み出し位置を終わりの 3 記録手前に置き、揃え済みにする
        var start = Length - 3 * 192;
        State(fake, start, 0, k, aligned: true);
        fake.Put(0x190202C, 4, start);
        fake.Wp = Fill(fake, start + k, 30);
        var reply = Kick(fake, 512);
        await Assert.That(reply.Sent).IsGreaterThanOrEqualTo(9u);
        var expected = Expected(30);
        await Assert.That(Output(fake)).IsEquivalentTo(expected[..((int)reply.Sent * 512)]);
        // 読み出し位置は長さで折り返している
        await Assert.That(reply.ReadPosition).IsLessThan(Length);
    }

    [Test]
    public async Task 要求のパケット数で戻り_次の要求がパケット内の位置から続ける()
    {
        var fake = Rig();
        fake.Wp = Fill(fake, 0, 40);
        var first = Kick(fake, 3);
        await Assert.That(first.Result).IsEqualTo(Dt295NativePrograms.ResultSent);
        await Assert.That(first.Sent).IsEqualTo(3u);
        await Assert.That(fake.Packets.Count).IsEqualTo(3);
        // 3 パケット = 1536 バイト = 8 記録 + 32 バイト
        await Assert.That(first.PacketPosition).IsEqualTo(32u);
        var second = Kick(fake, 512);
        await Assert.That(second.Sent).IsEqualTo(11u);
        await Assert.That(Output(fake)).IsEquivalentTo(Expected(40)[..(14 * 512)]);
    }

    [Test]
    public async Task リングが進まないときは待つ回数で戻り_FIFO_が空かないときも送らない()
    {
        var fake = Rig();
        var empty = Kick(fake, 512, idle: 7);
        await Assert.That(empty.Result).IsEqualTo(Dt295NativePrograms.ResultIdle);
        await Assert.That(empty.Sent).IsEqualTo(0u);

        fake.Wp = Fill(fake, 0, 40);
        fake.FifoReady = false;
        var busy = Kick(fake, 512, idle: 7);
        await Assert.That(busy.Result).IsEqualTo(Dt295NativePrograms.ResultIdle);
        await Assert.That(busy.Sent).IsEqualTo(0u);
        await Assert.That(fake.Stores.Any(s => s.Address == 0xFDBD84)).IsFalse();
    }

    [Test]
    public async Task 書き込み位置が長さ以上なら_結果_2_で止まる()
    {
        var fake = Rig();
        fake.Wp = Length;
        var reply = Kick(fake, 512);
        await Assert.That(reply.Result).IsEqualTo(Dt295NativePrograms.ResultBadWrite);
        await Assert.That(reply.Sent).IsEqualTo(0u);
        await Assert.That(reply.WritePosition).IsEqualTo(Length);
    }

    /// <summary>fr30-elf-as (binutils 2.44) で Listing を組み、fr30-elf-ld で 0xE1000 に置いた出力 (道具の出力)。語が奇数個のとき末尾の 9fa0 は、32 ビットずつにそろえる nop</summary>
    private const string BodyHex =
        "9bcc466206c0c7dcaac0e3169bcc466405c0c40caac0e3109bcc461c04c09bcc4620aac0e3099bcc462004c09f8c444e5431" +
        "aac0e301e00ac46d02b0a810e2039beca75a970c9beca704970c17819bec17c014ce8bce30183029303a304b305d9bcc4624" +
        "04c0a820e3039bec1248970c9f848138ec009f85000300009bcc462804c6a44c04c730a630b720682079208a209ba806e303" +
        "9bec11fc970c9f8c0190202804cdaa5de4039bec1200970c8bd3ac83e501a653a80be3039bec1172970c9b0002fca6a0aa03" +
        "e5039bec11ee970c9f8c00fdbd0c04c0c04c82c0e3039bec11ee970c9f8d00fdbd848ba7c03c82c7b4378babb02bb42bc803" +
        "8b81a6b1a691aa51e401ac51a6410410a807e20ca4418b4ca65caac1e401ac510412b670c20cac7cb2c2922014d0a449cbcc" +
        "aac9e306c009cc0ca6c8aa58e401ac58a5f3e3dd9f8c00fd814cc08014c09f8c00fdbd0cc04014c09f8c00fd814cc0f014c0" +
        "9f8c0190202c14c8c01b20b7a5f69bec1092970c9b0002fcaa03e5039bec11ee970cc000c4738b81a601aa51e401ac51a641" +
        "0612aa32e31d8b81a601cc02a621aa51e401ac51a6410612aa32e3128b81a6019b020180a621aa51e401ac51a6410612aa32" +
        "e3068b0ac01bc0099bec1092970ca410cc01aa10e4d6a618aa58e401ac589f8c0190202c14c89bec1092970ca5f7e2039bec" +
        "1092970cc010e003c000e001c02030683079308a309b9bcc462414c0a44c20a1ac6114c1a44c14c8a44c14caa44c14c9a44c" +
        "9f8201902028042114c1a44c14cb20182029203a204b205d04ee07819beca8c8970c9bcc462804cda44c04c6acd630d6a44c" +
        "04c530b5c004c00030c09f8700fd8fe09f8800fd8fe49f8900fd8ff0a805e3039bec13a8970c9f8c000200000470c80b82b0" +
        "e206a5fce3fac0309bec139e970c0241a4140242a4140243a4140240a41430e0b41130a28b10a802e301a4101490c5201480" +
        "d085a800e2039bec139e970c0470c10b82b0e2039bec139c970ca802e3039bec131a970ca812e30b20e0a810e3080240a414" +
        "024ba41420cc82c092b0e0020240a4141490b01ab41a148ad060a800e2039bec139e970ca5f29bec12d6970c20a0a800e217" +
        "a803e2158b10a4101490b01ab41ac20b92ba148ad049a800e2039bec139e970c0470c10b82b0e2039bec139c970c30f6a803" +
        "e3039bec138c970cb01ab41ac08b92baa813e301acba148ad02ea800e2039bec139e970c04901260a416a5f3e2039bec135a" +
        "970c20f0020030c0c39b92baacba148aa5f59bec1274970cc010c39b92baacba148ae001c0009bcc462414c020b1ac51a44c" +
        "14c120d18b62ac12a44c14c29bec1234970cc40c048a8ba0c01b82b0e202a5fce3f99f8c00020000048a8ba0c80b82b0e308" +
        "8ba0c01b82b0e306a5fce3f5c0309720c0209720c0009720";

    [Test]
    public async Task body_は_fr30_elf_as_の出力と同じ語になる()
    {
        var image = Dt295NativePrograms.Build();
        var bytes = image.Words.SelectMany(word => new[] { (byte)(word >> 24), (byte)(word >> 16), (byte)(word >> 8), (byte)word }).ToArray();
        await Assert.That(Convert.ToHexStringLower(bytes)).IsEqualTo(BodyHex);
    }
}
