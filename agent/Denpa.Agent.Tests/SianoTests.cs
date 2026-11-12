using System.Buffers.Binary;
using System.Diagnostics;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * エージェントが USB を直に持つ Siano の機材 (SianoMessage.cs・SianoFirmware.cs・SianoTs.cs・SianoDevice.cs・Siano.cs)。
 *
 * 本物の機材は無い。仕様書 (denpa-spec の siano/spec.md) の手順を、偽の USB (SianoFakes.cs) の上で確かめる:
 * 送るメッセージのバイト列と順、応答の読み方、時間切れ、中身が転送の途中から始まるメッセージ、TS の余りのつなぎ方、失敗の分岐。
 * 仕様書が「食い違い」「推定」「未確認」としている所は、選んだ側と、もう一方が届いても壊れないことを見る。
 */
public class SianoTests
{
    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes);

    // ---- メッセージの枠 (仕様書 3) ----

    [Test]
    public async Task 送るバイト列は仕様書_3_5_と_5_2_の例のとおり()
    {
        await Assert.That(Hex(SianoMessage.Build(SianoMessage.Version, SianoMessage.FromBoot))).IsEqualTo("9C02000B08000000");
        await Assert.That(Hex(SianoMessage.Build(SianoMessage.ModeInit, SianoMessage.FromBoot, 6))).IsEqualTo("4202000B0C00000006000000");
        await Assert.That(Hex(SianoMessage.Build(SianoMessage.StatsNew, SianoMessage.FromTuner))).IsEqualTo("8D02C90B08000000");
        await Assert.That(Hex(SianoMessage.Build(SianoMessage.AddPid, SianoMessage.FromTuner, 0x2000))).IsEqualTo("5902C90B0C00000000200000");
        // チャンネル 27 (557,142,857 Hz)・帯域の区分 8・水晶 12,000,000 Hz・セグメントの番号 0
        await Assert.That(Hex(SianoMessage.Build(SianoMessage.Tune, SianoMessage.FromTuner, 557_142_857, 8, 12_000_000, 0)))
            .IsEqualTo("0803C90B18000000" + "49533521" + "08000000" + "001BB700" + "00000000");
    }

    [Test]
    public async Task データの書き込みは_u32_のアドレスに続けてデータで_240_バイトまで()
    {
        var message = SianoMessage.BuildDataWrite(0x00400000, [0xAA, 0xBB, 0xCC]);
        await Assert.That(Hex(message)).IsEqualTo("9402000B0F000000" + "00004000" + "AABBCC");
        await Assert.That(SianoMessage.BuildDataWrite(0, new byte[240]).Length).IsEqualTo(252);
        Assert.Throws<ArgumentOutOfRangeException>(() => SianoMessage.BuildDataWrite(0, new byte[241]));
    }

    private static (bool Ok, ushort Number, string Payload) Parse(byte[] transfer, int align = 504)
    {
        var ok = SianoMessage.TryParse(transfer, align, out var number, out _, out var payload, out _);
        return (ok, number, Convert.ToHexString(payload));
    }

    [Test]
    public async Task 受けたメッセージは長さのぶんだけ読み_転送の余りは捨てる()
    {
        await Assert.That(Parse(FakeSianoUsb.Message(669, [1, 2, 3]))).IsEqualTo((true, (ushort)669, "010203"));
        // 転送がヘッダの長さより大きいとき、余りは読まない (仕様書 2.3)
        byte[] padded = [.. FakeSianoUsb.Message(777, [9]), 0xEE, 0xEE, 0xEE];
        await Assert.That(Parse(padded)).IsEqualTo((true, (ushort)777, "09"));
        // 中身の無いメッセージ
        await Assert.That(Parse(FakeSianoUsb.Message(661, []))).IsEqualTo((true, (ushort)661, ""));
    }

    [Test]
    public async Task 壊れたメッセージは捨てる()
    {
        // ヘッダに足りない転送
        await Assert.That(Parse([0x9D, 0x02, 0, 0]).Ok).IsFalse();
        // 長さが 8 より小さい
        var tooShort = FakeSianoUsb.Message(669, []);
        BinaryPrimitives.WriteUInt16LittleEndian(tooShort.AsSpan(4), 7);
        await Assert.That(Parse(tooShort).Ok).IsFalse();
        // 長さが転送のバイト数より大きい
        var tooLong = FakeSianoUsb.Message(669, [1, 2]);
        BinaryPrimitives.WriteUInt16LittleEndian(tooLong.AsSpan(4), 11);
        await Assert.That(Parse(tooLong).Ok).IsFalse();
    }

    [Test]
    public async Task フラグのビット_2_が立っていれば_中身はそろえ幅とフラグの上位で決まる位置から()
    {
        // 仕様書 3.3 の例: そろえ幅 504、フラグ 0x0104、長さ 3,768 → ずれ 505、中身は位置 513 から 3,760 バイト
        var transfer = new byte[4273];
        BinaryPrimitives.WriteUInt16LittleEndian(transfer, 693);
        BinaryPrimitives.WriteUInt16LittleEndian(transfer.AsSpan(4), 3768);
        BinaryPrimitives.WriteUInt16LittleEndian(transfer.AsSpan(6), 0x0104);
        for (var i = 8; i < transfer.Length; i++) transfer[i] = (byte)(i < 513 ? 0xEE : 0x5A);
        var shifted = Parse(transfer, SianoMessage.Align(512));
        await Assert.That(shifted.Ok).IsTrue();
        await Assert.That(shifted.Number).IsEqualTo((ushort)693);
        await Assert.That(shifted.Payload.Length).IsEqualTo(3760 * 2);
        await Assert.That(shifted.Payload.Replace("5A", "")).IsEqualTo("");

        // ずれ + 長さが転送に収まらなければ捨てる
        await Assert.That(Parse(transfer[..4272], 504).Ok).IsFalse();
        // そろえ幅が 0 なら、ビットが立っていても先頭から読む
        var plain = Parse(transfer, 0);
        await Assert.That(plain.Ok).IsTrue();
        await Assert.That(plain.Payload[..2]).IsEqualTo("EE");
        // ビット 2 が立っていなければ、上位のビットがあってもずらさない
        BinaryPrimitives.WriteUInt16LittleEndian(transfer.AsSpan(6), 0x0300);
        await Assert.That(Parse(transfer, 504).Payload[..2]).IsEqualTo("EE");
    }

    [Test]
    public async Task そろえ幅は最大パケット長から_8_を引き_8_以下なら_0()
    {
        await Assert.That(SianoMessage.Align(512)).IsEqualTo(504);
        await Assert.That(SianoMessage.Align(64)).IsEqualTo(56);
        await Assert.That(SianoMessage.Align(8)).IsEqualTo(0);
        await Assert.That(SianoMessage.Align(0)).IsEqualTo(0);
    }

    // ---- バージョンの応答と統計の応答 (仕様書 4.1・7) ----

    [Test]
    public async Task バージョンの応答は位置_4_と_5_と_10_と_11_を読む()
    {
        var payload = new byte[48];
        payload[0] = 0x30;
        payload[1] = 0x21;
        payload[4] = 255;
        payload[5] = 0x40;
        payload[6] = 2;
        payload[7] = 1;
        payload[10] = 8;
        payload[11] = 3;
        var version = SianoVersion.Parse(payload)!;
        await Assert.That(version.Chip).IsEqualTo((ushort)0x2130);
        await Assert.That(version.Mode).IsEqualTo((byte)255);
        await Assert.That(version.Ready).IsFalse();
        await Assert.That(version.SupportsIsdbt).IsTrue();
        await Assert.That(version.Value).IsEqualTo(0x0803);
        await Assert.That(version.NewStats).IsTrue();

        payload[4] = 6;
        payload[5] = 0x20;
        payload[10] = 7;
        payload[11] = 0xFF;
        version = SianoVersion.Parse(payload)!;
        await Assert.That(version.Ready).IsTrue();
        await Assert.That(version.SupportsIsdbt).IsFalse();
        await Assert.That(version.Value).IsEqualTo(0x07FF);
        await Assert.That(version.NewStats).IsFalse();

        // 中身が 12 バイトより短い応答は使わない。ちょうど 12 バイトは読む
        await Assert.That(SianoVersion.Parse(payload.AsSpan(0, 11))).IsNull();
        await Assert.That(SianoVersion.Parse(payload.AsSpan(0, 12))).IsNotNull();
    }

    [Test]
    public async Task 統計の応答は_新しい形式は位置_16_古い形式は位置_12_で復調のロックを読む()
    {
        var fresh = SianoStats.Parse(SianoMessage.StatsNewDone, FakeSianoUsb.Stats(true, true, 23, -48))!;
        await Assert.That(fresh).IsEqualTo(new SianoStats(true, 23, -48, 288));
        var old = SianoStats.Parse(SianoMessage.StatsOldDone, FakeSianoUsb.Stats(false, true, 19, -60))!;
        await Assert.That(old).IsEqualTo(new SianoStats(true, 19, -60, 216));
        await Assert.That(SianoStats.Parse(SianoMessage.StatsNewDone, FakeSianoUsb.Stats(true, false))!.Locked).IsFalse();

        // 位置を値で確かめる: 新しい形式の位置 16 と、古い形式の位置 12 だけを立てる
        var onlyLock = new byte[20];
        onlyLock[16] = 1;
        await Assert.That(SianoStats.Parse(SianoMessage.StatsNewDone, onlyLock)).IsEqualTo(new SianoStats(true, null, null, 20));
        onlyLock = new byte[16];
        onlyLock[12] = 1;
        onlyLock[0] = 6;
        await Assert.That(SianoStats.Parse(SianoMessage.StatsOldDone, onlyLock)).IsEqualTo(new SianoStats(true, null, null, 16));
    }

    [Test]
    public async Task 統計の応答は届いた長さの中にある欄だけを読む()
    {
        var full = FakeSianoUsb.Stats(true, true, 23, -48);
        // 復調のロックの欄まで届いていなければ使わない (新しい形式は 20 バイト、古い形式は 16 バイトから)
        await Assert.That(SianoStats.Parse(SianoMessage.StatsNewDone, full.AsSpan(0, 19))).IsNull();
        await Assert.That(SianoStats.Parse(SianoMessage.StatsOldDone, FakeSianoUsb.Stats(false, true).AsSpan(0, 15))).IsNull();
        // SNR (位置 24) まで・受信電力 (位置 32) まで
        await Assert.That(SianoStats.Parse(SianoMessage.StatsNewDone, full.AsSpan(0, 28))).IsEqualTo(new SianoStats(true, 23, null, 28));
        await Assert.That(SianoStats.Parse(SianoMessage.StatsNewDone, full.AsSpan(0, 36))).IsEqualTo(new SianoStats(true, 23, -48, 36));
    }

    [Test]
    public async Task 古い形式で統計の種類が_0_なら_受信電力を位置_44_から読み_SNR_は無い()
    {
        var payload = FakeSianoUsb.Stats(false, true, 99, 99, type: 0);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(44), -71);
        await Assert.That(SianoStats.Parse(SianoMessage.StatsOldDone, payload)).IsEqualTo(new SianoStats(true, null, -71, 216));
    }

    // ---- ファームウェアのファイル (仕様書 4.2) ----

    [Test]
    public async Task ファームウェアは_240_バイトずつ_358_個で_終わりの_12_バイトは_0()
    {
        var file = SianoFake.FirmwareFile();
        var firmware = SianoFirmware.Parse(file);
        await Assert.That(firmware.Address).IsEqualTo(0x00400000u);
        await Assert.That(firmware.Length).IsEqualTo(85_828u);
        await Assert.That(firmware.Data.Length).IsEqualTo(85_840);
        // 本体はファイルの 12 バイト目からそのまま、そのあとの 12 バイトは 0 (仕様書 12.3 で選んだ側)
        await Assert.That(firmware.Data.AsSpan(0, 85_828).SequenceEqual(file.AsSpan(12))).IsTrue();
        await Assert.That(firmware.Data.AsSpan(85_828).ToArray().All(value => value == 0)).IsTrue();

        var chunks = firmware.Chunks(firmware.Address).ToList();
        await Assert.That(chunks.Count).IsEqualTo(358);
        await Assert.That(firmware.ChunkCount).IsEqualTo(358);
        await Assert.That(chunks.Take(357).All(chunk => chunk.Chunk.Length == 240)).IsTrue();
        await Assert.That(chunks[357].Chunk.Length).IsEqualTo(160);
        // アドレスは先頭のアドレスから、送ったバイト数だけ進む
        await Assert.That(chunks[0].Address).IsEqualTo(0x00400000u);
        await Assert.That(chunks[1].Address).IsEqualTo(0x00400000u + 240);
        await Assert.That(chunks[357].Address).IsEqualTo(0x00400000u + 357 * 240);
    }

    [Test]
    public async Task ファームウェアの本体がファイルより短ければ_残りは_0_で埋める()
    {
        var file = SianoFake.FirmwareFile(size: 1000, length: 500);
        var firmware = SianoFirmware.Parse(file);
        await Assert.That(firmware.Data.Length).IsEqualTo(1000);
        await Assert.That(firmware.Data.AsSpan(0, 500).SequenceEqual(file.AsSpan(12, 500))).IsTrue();
        await Assert.That(firmware.Data.AsSpan(500).ToArray().All(value => value == 0)).IsTrue();
    }

    [Test]
    public async Task ファームウェアのファイルが短い_本体の長さが収まらないときは断る()
    {
        Assert.Throws<InvalidDataException>(() => SianoFirmware.Parse(new byte[11]));
        Assert.Throws<InvalidDataException>(() => SianoFirmware.Parse(SianoFake.FirmwareFile(size: 100, length: 89)));
        // ちょうど収まる長さは読む
        await Assert.That(SianoFirmware.Parse(SianoFake.FirmwareFile(size: 100, length: 88)).Length).IsEqualTo(88u);
        var error = Assert.Throws<IOException>(() => SianoFirmware.Load(Path.Combine(Path.GetTempPath(), $"denpa-no-such-{Guid.NewGuid():N}.inp")));
        await Assert.That(error.Message).Contains("ファームウェアを読めません");
    }

    // ---- TS を 188 バイトに揃える (仕様書 6.1) ----

    private static byte[] Align(SianoTsAligner aligner, params byte[][] messages)
    {
        var output = new MemoryStream();
        foreach (var message in messages) aligner.Push(message, packets => output.Write(packets));
        return output.ToArray();
    }

    [Test]
    public async Task TS_は_188_の倍数で届けばそのまま渡す()
    {
        var aligner = new SianoTsAligner();
        var ts = SianoFake.Packets(40);
        var output = Align(aligner, ts[..(20 * 188)], ts[(20 * 188)..]);
        await Assert.That(output.AsSpan().SequenceEqual(ts)).IsTrue();
        await Assert.That(aligner.Skipped).IsEqualTo(0L);
        await Assert.That(aligner.Packets).IsEqualTo(40L);
    }

    [Test]
    public async Task TS_のメッセージがパケットの途中で切れていれば_余りを次の先頭につなげる()
    {
        var aligner = new SianoTsAligner();
        var ts = SianoFake.Packets(30);
        // 188 の倍数でない切り方 (1,000・3・残り)
        var output = Align(aligner, ts[..1000], ts[1000..1003], ts[1003..]);
        await Assert.That(output.AsSpan().SequenceEqual(ts)).IsTrue();
        await Assert.That(aligner.Skipped).IsEqualTo(0L);
        await Assert.That(aligner.Lost).IsEqualTo(0);
    }

    [Test]
    public async Task TS_の先頭がパケットの途中なら_0x47_が_188_バイトおきに続くところから渡す()
    {
        var aligner = new SianoTsAligner();
        var ts = SianoFake.Packets(10);
        // 先頭に、パケットの途中から始まる 100 バイト (中に 0x47 が 1 つある)
        var junk = new byte[100];
        junk[10] = 0x47;
        var output = Align(aligner, [.. junk, .. ts[..500]], ts[500..]);
        await Assert.That(output.AsSpan().SequenceEqual(ts)).IsTrue();
        await Assert.That(aligner.Skipped).IsEqualTo(100L);
    }

    [Test]
    public async Task TS_の並びが途中で崩れたら_揃え直して続ける()
    {
        var aligner = new SianoTsAligner();
        var before = SianoFake.Packets(5);
        var after = SianoFake.Packets(6, first: 5);
        // 5 パケットのあとに 50 バイト欠けた (パケットの途中から始まる) 並びが続く
        var output = Align(aligner, [.. before, .. after[50..]]);
        await Assert.That(output.AsSpan(0, before.Length).SequenceEqual(before)).IsTrue();
        // 欠けた 1 パケットは捨て、次のパケットから渡す
        await Assert.That(output.AsSpan(before.Length).SequenceEqual(after.AsSpan(188))).IsTrue();
        await Assert.That(aligner.Lost).IsEqualTo(1);
        await Assert.That(aligner.Skipped).IsEqualTo(138L);
    }

    // ---- 開く (仕様書 2.2) ----

    [Test]
    public async Task 開くときは_ストールをクリアして_転送要求を出してから_最初の要求を送る()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        using var device = SianoFake.Started(usb);
        var events = usb.Events();
        await Assert.That(string.Join(" / ", events))
            .IsEqualTo($"clear 81 / clear 02 / in 81 16384x{SianoDevice.Depth} / out 02 668 1000ms");
        await Assert.That(SianoDevice.Depth).IsGreaterThanOrEqualTo(32);
    }

    [Test]
    public async Task IN_の端点はディスクリプタから読み_OUT_は何と書いてあっても_0x02_に送る()
    {
        var usb = new FakeSianoUsb { Mode = 6, Endpoints = [new(0x03, 2, 512), new(0x85, 3, 64), new(0x84, 2, 512)] };
        using var device = SianoFake.Started(usb);
        var events = string.Join(" / ", usb.Events());
        await Assert.That(events).Contains("clear 84 / clear 02");
        await Assert.That(events).Contains("in 84 16384x");
        await Assert.That(events).Contains("out 02 668");
    }

    [Test]
    public async Task バルク_IN_の端点が無ければ_何も送らずに断る()
    {
        var usb = new FakeSianoUsb { Endpoints = [new(0x02, 2, 512), new(0x81, 3, 64)] };
        using var device = SianoFake.Device(usb);
        var error = Assert.Throws<IOException>(() => device.Start());
        await Assert.That(error.Message).Contains("バルク IN");
        await Assert.That(usb.Sent.Count).IsEqualTo(0);
    }

    [Test]
    public async Task ストールをクリアできなくても続ける()
    {
        var usb = new FakeSianoUsb { Mode = 6, ClearHaltFails = true };
        using var device = SianoFake.Started(usb);
        await Assert.That(usb.Numbers()).IsEqualTo("668");
    }

    [Test]
    public async Task 最大パケット長が_8_以下なら_フラグが立っていても中身を先頭から読む()
    {
        var usb = new FakeSianoUsb { Mode = 6, Endpoints = [new(0x81, 2, 8), new(0x02, 2, 8)] };
        // バージョンの応答をフラグ付きで返す (そろえ幅が 0 なので、ずらさずに読めるはず)
        usb.Mute.Add(SianoMessage.Version);
        var device = SianoFake.Device(usb);
        var starting = Task.Run(device.Start);
        await WaitFor(() => usb.SentOf(SianoMessage.Version).Count == 1);
        usb.Deliver(FakeSianoUsb.Message(SianoMessage.VersionDone, usb.VersionPayload(), flags: 0x0104));
        await starting;
        await Assert.That(device.Version!.Mode).IsEqualTo((byte)6);
        device.Dispose();
    }

    private static async Task WaitFor(Func<bool> done, int timeoutMs = 3000)
    {
        var started = Stopwatch.StartNew();
        while (!done())
        {
            if (started.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("条件が満たされません");
            await Task.Delay(5);
        }
    }

    // ---- 起動 (仕様書 4) ----

    [Test]
    public async Task モードが既に_6_なら_バージョンの問い合わせのほかは何も送らない()
    {
        // 対応モードのビットやバージョンの値が何であっても、モードの初期化を送らない (送ると機材が応答しなくなる。仕様書 4.1)
        var usb = new FakeSianoUsb { Mode = 6, Modes = 0x40, Rom = (9, 0) };
        var sleeps = new List<int>();
        using var device = SianoFake.Started(usb, sleeps);
        await Assert.That(usb.Numbers()).IsEqualTo("668");
        await Assert.That(sleeps.Count).IsEqualTo(0);
        // 起動のメッセージは送り手 0・受け手 11
        await Assert.That(Hex(usb.Sent[0])).IsEqualTo("9C02000B08000000");
    }

    [Test]
    public async Task ファームウェアが無ければ_書き込み_検査_実行の合図_400ms_バージョンの読み直しの順()
    {
        var usb = new FakeSianoUsb { Mode = 255, Modes = 0 };
        var sleeps = new List<int>();
        var file = SianoFake.FirmwareFile();
        using var device = SianoFake.Started(usb, sleeps, () => SianoFirmware.Parse(file));

        var numbers = usb.Numbers().Split(' ');
        await Assert.That(numbers.Length).IsEqualTo(1 + 358 + 1 + 1 + 1);
        await Assert.That(numbers[0]).IsEqualTo("668");
        await Assert.That(numbers.Skip(1).Take(358).All(number => number == "660")).IsTrue();
        await Assert.That(string.Join(' ', numbers.Skip(359))).IsEqualTo("662 664 668");

        // 書き込み: アドレスは先頭のアドレスから 240 ずつ進み、つなげるとファイルの本体 + 0 が 12 バイト
        await Assert.That(usb.Written.Count).IsEqualTo(358);
        await Assert.That(usb.Written.Select((write, i) => write.Address == 0x00400000u + (uint)(i * 240)).All(same => same)).IsTrue();
        byte[] all = [.. usb.Written.SelectMany(write => write.Data)];
        await Assert.That(all.Length).IsEqualTo(85_840);
        await Assert.That(all.AsSpan(0, 85_828).SequenceEqual(file.AsSpan(12))).IsTrue();
        await Assert.That(all.AsSpan(85_828).ToArray().All(value => value == 0)).IsTrue();
        // 最後の書き込みは 160 バイト (長さ 12 + 160)
        var last = usb.SentOf(SianoMessage.DataWrite)[357];
        await Assert.That(last.Length).IsEqualTo(172);
        await Assert.That(Hex(last[..8])).IsEqualTo("9402000BAC000000");

        // 検査: アドレス・本体の長さ・0。実行の合図: アドレス・6・0x200・0・4
        await Assert.That(Hex(usb.SentOf(SianoMessage.DataCheck)[0])).IsEqualTo("9602000B14000000" + "00004000" + "444F0100" + "00000000");
        await Assert.That(Hex(usb.SentOf(SianoMessage.Run)[0]))
            .IsEqualTo("9802000B1C000000" + "00004000" + "06000000" + "00020000" + "00000000" + "04000000");
        // 実行の合図のあとに 400 ms 待つ
        await Assert.That(string.Join(',', sleeps)).IsEqualTo("400");
        // 読み直したバージョンの応答でモードが 6 になっていれば、モードの初期化は送らない
        await Assert.That(device.Version!.Ready).IsTrue();
        await Assert.That(usb.SentOf(SianoMessage.ModeInit).Count).IsEqualTo(0);
    }

    [Test]
    public async Task ファームウェアを送ってもモードが_255_のままなら_バージョンの値が_0x0800_以上のときだけ_モードの初期化を_1_回送る()
    {
        var usb = new FakeSianoUsb { Mode = 255, Modes = 0, ModeAfterRun = null, Rom = (8, 0) };
        using (SianoFake.Started(usb))
        {
            var numbers = usb.Numbers().Split(' ');
            await Assert.That(string.Join(' ', numbers.Skip(359))).IsEqualTo("662 664 668 578");
            await Assert.That(Hex(usb.SentOf(SianoMessage.ModeInit)[0])).IsEqualTo("4202000B0C00000006000000");
        }

        // バージョンの値が 0x0800 より小さければ送らない
        usb = new FakeSianoUsb { Mode = 255, Modes = 0, ModeAfterRun = null, Rom = (7, 255) };
        using (SianoFake.Started(usb))
        {
            await Assert.That(usb.SentOf(SianoMessage.ModeInit).Count).IsEqualTo(0);
            await Assert.That(usb.Numbers().EndsWith("662 664 668", StringComparison.Ordinal)).IsTrue();
        }
    }

    [Test]
    public async Task ROM_のままで_ISDB_T_に対応していれば_ファームウェアを送らずにモードの初期化だけ()
    {
        var usb = new FakeSianoUsb { Mode = 255, Modes = 0x40, Rom = (8, 0) };
        using (SianoFake.Started(usb))
        {
            await Assert.That(usb.Numbers()).IsEqualTo("668 578");
        }
        // 別のモードが動いていて ISDB-T に対応しているときも同じ
        usb = new FakeSianoUsb { Mode = 4, Modes = 0x50, Rom = (8, 1) };
        using (SianoFake.Started(usb))
        {
            await Assert.That(usb.Numbers()).IsEqualTo("668 578");
        }
        // バージョンの値が小さければ何も送らない
        usb = new FakeSianoUsb { Mode = 255, Modes = 0x40, Rom = (2, 1) };
        using (SianoFake.Started(usb))
        {
            await Assert.That(usb.Numbers()).IsEqualTo("668");
        }
    }

    [Test]
    public async Task 別のモードのファームウェアが動いていて_ISDB_T_に対応していなければ_挿し直しを求めて断る()
    {
        var usb = new FakeSianoUsb { Mode = 4, Modes = 0x10 };
        using var device = SianoFake.Device(usb);
        var error = Assert.Throws<IOException>(() => device.Start());
        await Assert.That(error.Message).Contains("挿し直してください");
        // 入れ替えの手順 (702・704) もファームウェアも送らない
        await Assert.That(usb.Numbers()).IsEqualTo("668");
    }

    [Test]
    public async Task バージョンの問い合わせに応答が無ければ_時間切れで断り_やり直さない()
    {
        var usb = new FakeSianoUsb();
        usb.Mute.Add(SianoMessage.Version);
        using var device = SianoFake.Device(usb);
        var started = Stopwatch.StartNew();
        var error = Assert.Throws<SianoSilentException>(() => device.Start());
        await Assert.That(error.Message).Contains("バージョンの問い合わせ");
        await Assert.That(started.ElapsedMilliseconds).IsGreaterThanOrEqualTo(SianoFake.Fast.ResponseMs - 20);
        await Assert.That(usb.Numbers()).IsEqualTo("668");
    }

    [Test]
    public async Task バージョンの応答が_12_バイトより短ければ_状態を決めずに断る()
    {
        var usb = new FakeSianoUsb { Mode = 6, VersionLength = 8 };
        using var device = SianoFake.Device(usb);
        var error = Assert.Throws<IOException>(() => device.Start());
        await Assert.That(error.Message).Contains("バージョンの応答が短く");
        await Assert.That(usb.Numbers()).IsEqualTo("668");
    }

    [Test]
    public async Task ファームウェアのファイルが無い_壊れているときは_ファームウェアのメッセージを送らない()
    {
        var usb = new FakeSianoUsb { Mode = 255 };
        using var device = SianoFake.Device(usb, firmware: () => throw new IOException("ファームウェアを読めません: /nowhere"));
        var error = Assert.Throws<IOException>(() => device.Start());
        await Assert.That(error.Message).Contains("ファームウェアを読めません");
        await Assert.That(usb.Numbers()).IsEqualTo("668");
    }

    [Test]
    public async Task ファームウェアの書き込みの途中で応答が無くなったら_その場で止めて挿し直しを求める()
    {
        var usb = new FakeSianoUsb { Mode = 255, DataWritesAnswered = 3 };
        using var device = SianoFake.Device(usb);
        var error = Assert.Throws<SianoSilentException>(() => device.Start());
        await Assert.That(error.Message).Contains("4/358 個目");
        await Assert.That(error.Message).Contains("挿し直してください");
        // 4 個目の応答を待って止まる。検査も実行の合図も送らない
        await Assert.That(usb.Numbers()).IsEqualTo("668 660 660 660 660");
    }

    [Test]
    public async Task 検査や実行の合図に応答が無ければ断る()
    {
        var usb = new FakeSianoUsb { Mode = 255 };
        usb.Mute.Add(SianoMessage.DataCheck);
        using (var device = SianoFake.Device(usb))
        {
            Assert.Throws<SianoSilentException>(() => device.Start());
            await Assert.That(usb.SentOf(SianoMessage.Run).Count).IsEqualTo(0);
        }
        usb = new FakeSianoUsb { Mode = 255 };
        usb.Mute.Add(SianoMessage.Run);
        var sleeps = new List<int>();
        using (var device = SianoFake.Device(usb, sleeps))
        {
            Assert.Throws<SianoSilentException>(() => device.Start());
            await Assert.That(sleeps.Count).IsEqualTo(0);
        }
    }

    [Test]
    public async Task 応答は番号だけで対応を取り_送る前に届いていた同じ番号は数えない()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        using var device = SianoFake.Started(usb);
        // 前の要求の遅れた応答 (777) が先に届いている。次の選局は、自分の応答が届かなければ時間切れになる
        usb.Deliver(SianoMessage.TuneDone);
        await Task.Delay(50);
        usb.Mute.Add(SianoMessage.Tune);
        var error = Assert.Throws<SianoSilentException>(() => device.Tune(473_142_857));
        await Assert.That(error.Message).Contains("選局");
    }

    // ---- 選局 (仕様書 5) ----

    [Test]
    public async Task 選局は_776_を送って_777_を待ち_統計の応答でロックしたら_PID_0x2000_を_1_回だけ足す()
    {
        var usb = new FakeSianoUsb { Mode = 6, Rom = (8, 0) };
        using var device = SianoFake.Started(usb);
        await Assert.That(device.Tune(557_142_857)).IsTrue();
        // 選局 → 統計の要求 (新しい形式) → PID を足す。選局と統計と PID は送り手 201・受け手 11
        await Assert.That(usb.Numbers()).IsEqualTo("668 776 653 601");
        await Assert.That(Hex(usb.SentOf(SianoMessage.Tune)[0])).IsEqualTo("0803C90B18000000" + "49533521" + "08000000" + "001BB700" + "00000000");
        await Assert.That(Hex(usb.SentOf(SianoMessage.StatsNew)[0])).IsEqualTo("8D02C90B08000000");
        await Assert.That(Hex(usb.SentOf(SianoMessage.AddPid)[0])).IsEqualTo("5902C90B0C00000000200000");

        // 選局し直し: 止める・初期化し直すメッセージは挟まず、PID も送り直さない (仕様書 5.4)
        await Assert.That(device.Tune(527_142_857)).IsTrue();
        await Assert.That(usb.Numbers()).IsEqualTo("668 776 653 601 776 653");
        await Assert.That(SianoFake.U32(usb.SentOf(SianoMessage.Tune)[1], 0)).IsEqualTo(527_142_857u);
    }

    [Test]
    public async Task バージョンの値が_0x0800_より小さければ_統計は古い形式で要求する()
    {
        var usb = new FakeSianoUsb { Mode = 6, Rom = (7, 0) };
        using var device = SianoFake.Started(usb);
        await Assert.That(device.Tune(473_142_857)).IsTrue();
        await Assert.That(usb.Numbers()).IsEqualTo("668 776 615 601");
        await Assert.That(Hex(usb.SentOf(SianoMessage.StatsOld)[0])).IsEqualTo("6702C90B08000000");
    }

    [Test]
    public async Task 要求した形式と違う形式の統計の応答が届いても_ロックを読める()
    {
        // 新しい形式で要求して古い形式 (616) が届く
        var usb = new FakeSianoUsb { Mode = 6, Rom = (8, 0), StatsOtherForm = true };
        using (var device = SianoFake.Started(usb))
        {
            await Assert.That(device.Tune(473_142_857)).IsTrue();
            await Assert.That(device.ReadStats()).IsEqualTo(new SianoStats(true, 24, -52, 216));
        }
        // 古い形式で要求して新しい形式 (654) が届く
        usb = new FakeSianoUsb { Mode = 6, Rom = (7, 0), StatsOtherForm = true };
        using (var device = SianoFake.Started(usb))
        {
            await Assert.That(device.Tune(473_142_857)).IsTrue();
            await Assert.That(device.ReadStats()).IsEqualTo(new SianoStats(true, 24, -52, 288));
        }
    }

    [Test]
    public async Task 通知_827_でもロックとして扱い_828_で消す()
    {
        var usb = new FakeSianoUsb { Mode = 6, Signal = false };
        using var device = SianoFake.Started(usb);
        var tuning = Task.Run(() => device.Tune(473_142_857));
        await WaitFor(() => usb.SentOf(SianoMessage.StatsNew).Count >= 2);
        usb.Deliver(SianoMessage.SignalFound);
        await Assert.That(await tuning).IsTrue();

        // 828 が届いたあとの選局は、統計がロックを返さなければ時間切れ
        usb.Deliver(SianoMessage.SignalLost);
        await Assert.That(device.Tune(473_142_857)).IsFalse();
    }

    [Test]
    public async Task ロックしなければ期限で失敗し_開いたまま次の選局を受け付ける()
    {
        var usb = new FakeSianoUsb { Mode = 6, Signal = false };
        var log = new List<string>();
        using var device = SianoFake.Started(usb, log: log);
        var started = Stopwatch.StartNew();
        await Assert.That(device.Tune(473_142_857)).IsFalse();
        var elapsed = started.ElapsedMilliseconds;
        await Assert.That(elapsed).IsGreaterThanOrEqualTo(SianoFake.Fast.LockMs - 20);
        // 統計の要求は間隔を詰めない (期限 400 ms・間隔 20 ms なら、多くても 21 回)
        var requests = usb.SentOf(SianoMessage.StatsNew).Count;
        await Assert.That(requests).IsGreaterThanOrEqualTo(2);
        await Assert.That(requests).IsLessThanOrEqualTo(SianoFake.Fast.LockMs / SianoFake.Fast.StatsEveryMs + 1);
        // ロックしていないので PID は足さない
        await Assert.That(usb.SentOf(SianoMessage.AddPid).Count).IsEqualTo(0);
        await Assert.That(log.Any(line => line.Contains("ロックしませんでした"))).IsTrue();

        // 電波が来れば、同じ開いたままの機材で選局できる。最初のロックなので、ここで PID を足す
        usb.Signal = true;
        await Assert.That(device.Tune(479_142_857)).IsTrue();
        await Assert.That(usb.SentOf(SianoMessage.AddPid).Count).IsEqualTo(1);
        await Assert.That(usb.SentOf(SianoMessage.Version).Count).IsEqualTo(1);
    }

    [Test]
    public async Task 選局の応答_777_が届かなければ断る()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        usb.Mute.Add(SianoMessage.Tune);
        using var device = SianoFake.Started(usb);
        var error = Assert.Throws<SianoSilentException>(() => device.Tune(473_142_857));
        await Assert.That(error.Message).Contains("選局に機材が応答しません");
        // ロック待ちに進んでいない
        await Assert.That(usb.SentOf(SianoMessage.StatsNew).Count).IsEqualTo(0);
    }

    [Test]
    public async Task 受信中の統計は届いた値をそのまま使い_応答が無ければ_null()
    {
        var usb = new FakeSianoUsb { Mode = 6, Level = (21, -63) };
        using var device = SianoFake.Started(usb);
        await Assert.That(device.Tune(473_142_857)).IsTrue();
        await Assert.That(device.ReadStats()).IsEqualTo(new SianoStats(true, 21, -63, 288));
        // 受信中にロックが外れたら、統計の値のとおり「ロックしていない」
        usb.Signal = false;
        await Assert.That(device.ReadStats()!.Locked).IsFalse();
        usb.Mute.Add(SianoMessage.StatsNew);
        await Assert.That(device.ReadStats()).IsNull();
    }

    // ---- TS と、表に無いメッセージ (仕様書 3.5・6) ----

    [Test]
    public async Task TS_は渡す先を決めるまで捨て_決めたあとは中身をそのまま渡す()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        using var device = SianoFake.Started(usb);
        // 選局の前に届いた 693 (前に使ったプログラムが選局したまま閉じたとき) は捨てる
        usb.Deliver(SianoMessage.Ts, SianoFake.Packets(4));
        await WaitFor(() => device.DroppedTs == 4 * 188);

        var received = new MemoryStream();
        device.Attach(ts =>
        {
            lock (received) received.Write(ts);
        }, _ => { });
        var ts = SianoFake.Packets(7);
        usb.Deliver(SianoMessage.Ts, ts[..700]);
        usb.Deliver(SianoMessage.Ts, ts[700..]);
        await WaitFor(() =>
        {
            lock (received) return received.Length == ts.Length;
        });
        await Assert.That(received.ToArray().AsSpan().SequenceEqual(ts)).IsTrue();

        device.Detach();
        usb.Deliver(SianoMessage.Ts, SianoFake.Packets(1));
        await WaitFor(() => device.DroppedTs == 5 * 188);
    }

    [Test]
    public async Task 途中から始まる_TS_のメッセージは_ずれた位置の中身を渡す()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        using var device = SianoFake.Started(usb);
        var received = new MemoryStream();
        device.Attach(ts =>
        {
            lock (received) received.Write(ts);
        }, _ => { });
        // そろえ幅 504 + 2 = 506 バイトずれる。ヘッダは転送の先頭、中身は 506 + 8 バイト目から
        var ts = SianoFake.Packets(3);
        var transfer = new byte[8 + 506 + ts.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(transfer, SianoMessage.Ts);
        BinaryPrimitives.WriteUInt16LittleEndian(transfer.AsSpan(4), (ushort)(8 + ts.Length));
        BinaryPrimitives.WriteUInt16LittleEndian(transfer.AsSpan(6), 0x0204);
        ts.CopyTo(transfer, 8 + 506);
        usb.Deliver(transfer);
        await WaitFor(() =>
        {
            lock (received) return received.Length == ts.Length;
        });
        await Assert.That(received.ToArray().AsSpan().SequenceEqual(ts)).IsTrue();
    }

    [Test]
    public async Task 表に無い番号と壊れたメッセージは捨てて_続けて動く()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        var log = new List<string>();
        using var device = SianoFake.Started(usb, log: log);
        foreach (var number in new ushort[] { 630, 782, 802, 805, 806, 655, 602, 9999 }) usb.Deliver(number, [1, 2, 3, 4]);
        usb.Deliver([0x01, 0x02]);
        var broken = FakeSianoUsb.Message(SianoMessage.TuneDone, []);
        BinaryPrimitives.WriteUInt16LittleEndian(broken.AsSpan(4), 4);
        usb.Deliver(broken);
        await Assert.That(device.Tune(473_142_857)).IsTrue();
        lock (log)
        {
            if (!log.Any(line => line.Contains("扱わないメッセージ 630"))) throw new InvalidOperationException("表に無い番号が記録に出ていない");
            if (!log.Any(line => line.Contains("壊れたメッセージ"))) throw new InvalidOperationException("壊れたメッセージが記録に出ていない");
        }
    }

    [Test]
    public async Task 初めて開いたときは_端点とバージョンの応答と統計の応答と_TS_の長さを記録に出す()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        var log = new List<string>();
        using var device = SianoFake.Started(usb, log: log);
        await Assert.That(device.Tune(473_142_857)).IsTrue();
        usb.Deliver(SianoMessage.Ts, SianoFake.Packets(2));
        await WaitFor(() => device.DroppedTs > 0);
        string[] lines;
        lock (log) lines = [.. log];
        await Assert.That(lines.Any(line => line.Contains("端点: EP 0x81 bulk 512 バイト、EP 0x02 bulk 512 バイト"))).IsTrue();
        await Assert.That(lines.Any(line => line.Contains("バージョンの応答 (開いたとき): 中身 48 バイト 3021000006"))).IsTrue();
        await Assert.That(lines.Any(line => line.Contains("モード 6") && line.Contains("ROM 8.0 (値 0x0800)"))).IsTrue();
        await Assert.That(lines.Any(line => line.Contains("統計の応答 654: 中身 288 バイト"))).IsTrue();
        await Assert.That(lines.Any(line => line.Contains("TS のメッセージ: 中身 376 バイト (188 で割った余り 0)、先頭 0x47"))).IsTrue();
    }

    // ---- 抜かれた・閉じる (仕様書 8・10) ----

    [Test]
    public async Task 読み出しが失敗したら_使えなくなったものとして扱い_待っている要求も終える()
    {
        var usb = new FakeSianoUsb { Mode = 6, Signal = false };
        using var device = SianoFake.Started(usb, timings: SianoFake.Fast with { LockMs = 5_000 });
        string? reason = null;
        device.Attach(_ => { }, why => reason = why);
        var tuning = Task.Run(() => device.Tune(473_142_857));
        await WaitFor(() => usb.SentOf(SianoMessage.StatsNew).Count >= 1);
        usb.Unplug();
        var error = await Assert.ThrowsAsync<IOException>(async () => await tuning);
        await Assert.That(error!.Message).Contains("抜かれました");
        await WaitFor(() => device.Faulted && reason is not null);
        await Assert.That(reason).IsEqualTo("usb 1-2 が抜かれました。挿し直してください");
    }

    [Test]
    public async Task 閉じるときは機材に何も送らず_読み出しを止めてから機材を閉じる()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        var device = SianoFake.Started(usb);
        await Assert.That(device.Tune(473_142_857)).IsTrue();
        var sent = usb.Numbers();
        device.Dispose();
        device.Dispose();
        await Assert.That(usb.Numbers()).IsEqualTo(sent);
        var events = usb.Events();
        await Assert.That(string.Join(" / ", events[^2..])).IsEqualTo("in stop / dispose");
    }

    // ---- チューナー (SianoTuner) ----

    private static readonly ChannelTable.Tuning T27 = new("GR", ChannelTable.SysIsdbt, 557_142_857, ChannelTable.NoStreamId);

    private static byte[] ReadTs(Stream output, int bytes, int timeoutMs = 3000)
    {
        var stream = (DeviceStream)output;
        var buffer = new byte[bytes];
        var got = 0;
        var started = Stopwatch.StartNew();
        while (got < bytes && started.ElapsedMilliseconds < timeoutMs)
        {
            var read = stream.Read(buffer, got, bytes - got, () => started.ElapsedMilliseconds >= timeoutMs);
            if (read <= 0) break;
            got += read;
        }
        return buffer[..got];
    }

    [Test]
    public async Task チューナーは選局のあとの_TS_を_188_バイトに揃えて流し_選局し直す前の_TS_を混ぜない()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        var opened = 0;
        using var tuner = new SianoTuner("PLEX PX-S1UD 1-2", () =>
        {
            opened++;
            return SianoFake.Started(usb, timings: SianoFake.Fast with { LockMs = 3_000 });
        });
        await Assert.That(tuner.Tuned).IsFalse();
        tuner.Tune(T27);
        await Assert.That(tuner.Tuned).IsTrue();
        var ts = SianoFake.Packets(20);
        // パケットの途中で切れたメッセージ 3 つ
        usb.Deliver(SianoMessage.Ts, ts[..1000]);
        usb.Deliver(SianoMessage.Ts, ts[1000..2500]);
        usb.Deliver(SianoMessage.Ts, ts[2500..]);
        await Assert.That(ReadTs(tuner.Output, ts.Length).AsSpan().SequenceEqual(ts)).IsTrue();

        // 選局し直し: 機材は開いたまま。ロックを確かめるまでに届いた TS は新しい出力に出ない
        usb.Signal = false;
        var retune = Task.Run(() => tuner.Tune(T27 with { Frequency = 527_142_857 }));
        await WaitFor(() => usb.SentOf(SianoMessage.Tune).Count == 2);
        usb.Deliver(SianoMessage.Ts, SianoFake.Packets(5, first: 100));
        await Task.Delay(50);
        usb.Signal = true;
        await retune;
        var next = SianoFake.Packets(6, first: 200);
        usb.Deliver(SianoMessage.Ts, next);
        await Assert.That(ReadTs(tuner.Output, next.Length).AsSpan().SequenceEqual(next)).IsTrue();
        await Assert.That(opened).IsEqualTo(1);
        await Assert.That(usb.SentOf(SianoMessage.AddPid).Count).IsEqualTo(1);
    }

    [Test]
    public async Task チューナーの信号の状態は_統計の_SNR_と受信電力から()
    {
        var usb = new FakeSianoUsb { Mode = 6, Level = (22, -57) };
        using var tuner = new SianoTuner("PLEX PX-S1UD 1-2", () => SianoFake.Started(usb));
        await Assert.That(((ITuneDevice)tuner).Signal()).IsNull();
        tuner.Tune(T27);
        await Assert.That(((ITuneDevice)tuner).Signal()).IsEqualTo(new TunerSignal(true, 22, TunerSignal.Db, StrengthDbm: -57));
        usb.Mute.Add(SianoMessage.StatsNew);
        await Assert.That(((ITuneDevice)tuner).Signal()).IsNull();
    }

    [Test]
    public async Task チューナーは_ロックしなければ機材を開いたままにし_応答が無ければ閉じて次に開き直す()
    {
        var usb = new FakeSianoUsb { Mode = 6, Signal = false };
        var opened = 0;
        using var tuner = new SianoTuner("PLEX PX-S1UD 1-2", () =>
        {
            opened++;
            return SianoFake.Started(usb);
        });
        var error = Assert.Throws<IOException>(() => tuner.Tune(T27));
        await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
        await Assert.That(tuner.Tuned).IsFalse();
        await Assert.That(usb.Events().Contains("dispose")).IsFalse();

        // 選局の応答が無い → 閉じる
        usb.Mute.Add(SianoMessage.Tune);
        error = Assert.Throws<IOException>(() => tuner.Tune(T27));
        await Assert.That(error.Message).Contains("選局に機材が応答しません");
        await Assert.That(usb.Events().Contains("dispose")).IsTrue();
        await Assert.That(opened).IsEqualTo(1);

        // 次の選局は開き直して、バージョンの問い合わせからやり直す。開き直したので PID をもう一度足す
        usb.Mute.Clear();
        usb.Signal = true;
        tuner.Tune(T27);
        await Assert.That(opened).IsEqualTo(2);
        await Assert.That(usb.SentOf(SianoMessage.Version).Count).IsEqualTo(2);
        await Assert.That(usb.SentOf(SianoMessage.AddPid).Count).IsEqualTo(1);
        await Assert.That(tuner.Tuned).IsTrue();
    }

    [Test]
    public async Task チューナーは_機材が抜かれたら_TS_を理由つきで終え_次の選局で開き直す()
    {
        var usb = new FakeSianoUsb { Mode = 6 };
        var opened = 0;
        using var tuner = new SianoTuner("PLEX PX-S1UD 1-2", () =>
        {
            opened++;
            return SianoFake.Started(usb);
        });
        tuner.Tune(T27);
        var output = tuner.Output;
        usb.Unplug();
        await WaitFor(() => !tuner.Tuned);
        var error = Assert.Throws<IOException>(() => ReadTs(output, 188));
        await Assert.That(error.Message).Contains("抜かれました");

        // 挿し直された
        var replugged = new FakeSianoUsb { Mode = 255 };
        usb = replugged;
        tuner.Tune(T27);
        await Assert.That(opened).IsEqualTo(2);
        await Assert.That(replugged.SentOf(SianoMessage.DataWrite).Count).IsEqualTo(358);
        await Assert.That(tuner.Tuned).IsTrue();
    }

    [Test]
    public async Task チューナーは衛星を機材を開く前に断る()
    {
        var opened = 0;
        using var tuner = new SianoTuner("PLEX PX-S1UD 1-2", () =>
        {
            opened++;
            throw new IOException("開かないはず");
        });
        var error = Assert.Throws<IOException>(() => tuner.Tune(new ChannelTable.Tuning("BS", ChannelTable.SysIsdbs, 1_049_480, 0x4010)));
        await Assert.That(error.Message).Contains("地上波だけ");
        await Assert.That(opened).IsEqualTo(0);
    }

    [Test]
    public async Task 読む側が詰まっても_TS_を受ける側は待たずに_入りきらないぶんを捨てて数える()
    {
        var stream = new SianoStream("PLEX PX-S1UD 1-2", () => { });
        try
        {
            // 誰も読まないまま 16,384 バイト弱のメッセージを 1,200 個 (約 19 MB)。バッファ 8 MB とキュー 256 個に入りきらない
            var message = SianoFake.Packets(87);
            var started = Stopwatch.StartNew();
            for (var i = 0; i < 1200; i++) stream.Push(message);
            await Assert.That(started.ElapsedMilliseconds).IsLessThan(2000L);
            await Assert.That(stream.Dropped).IsGreaterThan(0L);
            await Assert.That(stream.Dropped % message.Length).IsEqualTo(0L);
        }
        finally
        {
            stream.Stop();
        }
    }

    // ---- 機材の表と自動検出 (仕様書 1.1・1.4) ----

    private static string FakeSysfs(params (string Port, string Vendor, string Product, string? Driver)[] devices)
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-sysfs-{Guid.NewGuid():N}");
        var drivers = Path.Combine(root, "_drivers");
        foreach (var (port, vendor, product, driver) in devices)
        {
            Directory.CreateDirectory(Path.Combine(root, port));
            File.WriteAllText(Path.Combine(root, port, "idVendor"), vendor + "\n");
            File.WriteAllText(Path.Combine(root, port, "idProduct"), product + "\n");
            var iface = Path.Combine(root, $"{port}:1.0");
            Directory.CreateDirectory(iface);
            if (driver is null) continue;
            Directory.CreateDirectory(Path.Combine(drivers, driver));
            Directory.CreateSymbolicLink(Path.Combine(iface, "driver"), Path.Combine(drivers, driver));
        }
        return root;
    }

    [Test]
    public async Task 対象は_3275_0080_と_187f_0600_だけ()
    {
        await Assert.That(Siano.Find(0x3275, 0x0080)!.Name).IsEqualTo("PLEX PX-S1UD");
        await Assert.That(Siano.Find(0x187F, 0x0600)!.Name).IsEqualTo("Siano RIO");
        // 資料で扱いが食い違う ID と、VID が同じで表に無い PID は対象にしない
        await Assert.That(Siano.Find(0x187F, 0x0302)).IsNull();
        await Assert.That(Siano.Find(0x187F, 0x0202)).IsNull();
        await Assert.That(Siano.Find(0x3275, 0x0081)).IsNull();
    }

    [Test]
    [ExcludeOn(OS.Windows)] // sysfs は Linux だけ (Windows のフォルダの名前には : が使えない)
    public async Task 自動検出は_カーネルのドライバが使っている機材を並べない()
    {
        var sysfs = FakeSysfs(
            ("1-2", "3275", "0080", null),
            ("1-3", "3275", "0080", "smsusb"),
            ("2-1.4", "187f", "0600", "usbfs"),
            ("2-2", "187f", "0302", null),
            ("3-1", "0511", "024e", null));
        try
        {
            var warnings = new List<string>();
            var found = Siano.Found(new SysfsUsbHost(sysfs), warnings.Add);
            await Assert.That(string.Join(", ", found.Select(item => $"{item.Port}={item.Model.Name}"))).IsEqualTo("1-2=PLEX PX-S1UD, 2-1.4=Siano RIO");
            await Assert.That(string.Join("\n", warnings)).IsEqualTo("PLEX PX-S1UD 1-3 はカーネルのドライバ (smsusb) が使っているので使いません");

            // 設定の形式は siano:<USB のポート>。種別は地上波だけ
            var specs = Siano.Specs(found);
            await Assert.That(string.Join(", ", specs.Select(spec => $"{spec.Name}|{spec.Device}|{string.Join('+', spec.Types)}")))
                .IsEqualTo("PLEX PX-S1UD 1-2|siano:1-2|GR, Siano RIO 2-1.4|siano:2-1.4|GR");
        }
        finally
        {
            Directory.Delete(sysfs, true);
        }
    }

    [Test]
    public async Task 設定の_device_は_siano_に_USB_のポートを続けた形式()
    {
        // siano-userland を起動していたころの設定 (siano:<USB のポート>) を、そのまま読む
        await Assert.That(Siano.Is("siano:1-2.3")).IsTrue();
        await Assert.That(Siano.Parse("siano:1-2.3")).IsEqualTo("1-2.3");
        await Assert.That(Siano.Device("1-2.3")).IsEqualTo("siano:1-2.3");
        await Assert.That(Siano.Is("zd1j:1-2")).IsFalse();
        await Assert.That(Siano.Is(null)).IsFalse();
        await Assert.That(Siano.Parse("siano:")).IsNull();
        await Assert.That(Siano.Parse("siano:../1-2")).IsNull();
        await Assert.That(Siano.Name("PLEX PX-S1UD", "1-2.3")).IsEqualTo("PLEX PX-S1UD 1-2.3");
    }

    [Test]
    public async Task 同梱のファームウェアは_linux_firmware_の_isdbt_rio_inp_のまま()
    {
        var file = SianoFirmware.Bundled();
        await Assert.That(file.Length).IsEqualTo(85_840);
        await Assert.That(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(file))).IsEqualTo(SianoFirmware.Sha256);
        // 先頭の 3 つの欄だけを読み、ファイルと同じバイト数を 240 バイトずつ送る (仕様書 4.2)
        var firmware = SianoFirmware.Parse(file);
        await Assert.That(firmware.Data.Length).IsEqualTo(85_840);
        await Assert.That(firmware.ChunkCount).IsEqualTo(358);
    }

    // ---- USB の層に足したもの ----

    [Test]
    public async Task 端点の一覧は_最初の構成のインターフェース_0_の代替設定_0_から読む()
    {
        byte[] blob =
        [
            // デバイスディスクリプタ (18 バイト)
            18, 1, 0x00, 0x02, 0xFF, 0, 0, 64, 0x75, 0x32, 0x80, 0x00, 0, 1, 1, 2, 0, 2,
            // 構成 1: インターフェース 0 (代替設定 0) に bulk IN 0x81 と bulk OUT 0x02
            9, 2, 39, 0, 2, 1, 0, 0x80, 250,
            9, 4, 0, 0, 2, 0xFF, 0xFF, 0xFF, 0,
            7, 5, 0x81, 2, 0x00, 0x02, 0,
            7, 5, 0x02, 2, 0x00, 0x02, 0,
            // インターフェース 0 の代替設定 1 と、インターフェース 1 は読まない
            9, 4, 0, 1, 1, 0xFF, 0xFF, 0xFF, 0,
            7, 5, 0x83, 3, 0x40, 0x00, 1,
            9, 4, 1, 0, 1, 0xFF, 0xFF, 0xFF, 0,
            7, 5, 0x84, 2, 0x00, 0x02, 0,
            // 構成 2 は読まない
            9, 2, 25, 0, 1, 2, 0, 0x80, 250,
            9, 4, 0, 0, 1, 0xFF, 0xFF, 0xFF, 0,
            7, 5, 0x86, 2, 0x40, 0x00, 0,
        ];
        var pipes = UsbDescriptors.Pipes(blob, 0);
        await Assert.That(string.Join(", ", pipes.Select(pipe => $"{pipe.Endpoint:X2}/{pipe.Type}/{pipe.MaxPacket}/{pipe.In}/{pipe.Bulk}")))
            .IsEqualTo("81/2/512/True/True, 02/2/512/False/True");
        // 構成ディスクリプタから始まる並び (usbfs の fd の続きを読んだもの) でも同じ
        await Assert.That(string.Join(", ", UsbDescriptors.Pipes(blob.AsSpan(18), 0).Select(pipe => $"{pipe.Endpoint:X2}"))).IsEqualTo("81, 02");
        // デバイスディスクリプタしか読めなかったときは空
        await Assert.That(UsbDescriptors.Pipes(blob.AsSpan(0, 18), 0).Count).IsEqualTo(0);
    }
}
