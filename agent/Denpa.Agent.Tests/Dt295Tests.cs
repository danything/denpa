using System.Buffers.Binary;
using System.Security.Cryptography;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 (Dt295*.cs)。機材なしで確かめられる所: アドレスの形、コマンド・I2C・セキュアコマンドの形、周波数の式、
 * ルートの計画、AES-CMAC (RFC 4493 の例)、端数付き CBC 復号、認証の流れ。
 * 鍵・表・IV はどれも偽物 (でたらめな値)。メーカーのデータも放送のデータも使わない。
 */
public class Dt295Tests
{
    private static byte[] Hex(string text) => Convert.FromHexString(text);

    // ---------------------------------------------------------------------
    // レジスター (3.1・3.2)
    // ---------------------------------------------------------------------

    [Test]
    public async Task アドレスは_wValue_の上位バイトと_wIndex()
    {
        await Assert.That(Dt295Bridge.Setup(0x82008)).IsEqualTo(((ushort)0x0800, (ushort)0x2008));
        await Assert.That(Dt295Bridge.Setup(0x1000)).IsEqualTo(((ushort)0x0000, (ushort)0x1000));
        await Assert.That(Dt295Bridge.Setup(0xFFFFFF)).IsEqualTo(((ushort)0xFF00, (ushort)0xFFFF));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Bridge.Setup(0x1000000));
    }

    [Test]
    public async Task 長い読み書きは64バイトずつ()
    {
        var usb = new FakeDt295Usb();
        var bridge = new Dt295Bridge(usb, usb.Time);
        bridge.Write(0x83000, new byte[130]);
        await Assert.That(usb.Log).IsEquivalentTo(new[]
        {
            $"40 BC 0800 3000 {new string('0', 128)}",
            $"40 BC 0800 3040 {new string('0', 128)}",
            "40 BC 0800 3080 0000",
        });
        await Assert.That(bridge.Writes).IsEqualTo(3);
        Assert.Throws<ArgumentOutOfRangeException>(() => bridge.Write(0xFFFFF0, new byte[17]));
    }

    [Test]
    public async Task 部分書き換えは範囲だけ置き換える()
    {
        await Assert.That(Dt295Bridge.Field(0xFFFF, 12, 3, 1)).IsEqualTo((ushort)0x9FFF);
        await Assert.That(Dt295Bridge.Field(0x0000, 15, 1, 1)).IsEqualTo((ushort)0x8000);
        await Assert.That(Dt295Bridge.Field(0xABCD, 0, 13, 0x111)).IsEqualTo((ushort)0xA111);
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Bridge.Field(0, 14, 3, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Bridge.Field(0, 0, 2, 4));

        var usb = new FakeDt295Usb();
        usb.Set16(0x80076, 0x1234);
        new Dt295Bridge(usb, usb.Time).Modify16(0x80076, 4, 4, 0xF);
        await Assert.That(usb.Get16(0x80076)).IsEqualTo((ushort)0x12F4);
    }

    // ---------------------------------------------------------------------
    // コマンド (3.8)
    // ---------------------------------------------------------------------

    [Test]
    public async Task コマンドは4バイトで完了ビットを消す()
    {
        var usb = new FakeDt295Usb();
        var bridge = new Dt295Bridge(usb, usb.Time);
        var code = bridge.Command(Dt295Channel.Main, 4, 0x20, 0);
        await Assert.That(code).IsEqualTo((ushort)0x0400);
        await Assert.That(usb.Log[0]).IsEqualTo("40 B8 0000 0000 04200000");
        // 完了ビットを書いて消した
        await Assert.That(usb.Log[1]).IsEqualTo("40 BC 0900 0074 0008");
        await Assert.That(usb.Events).IsEqualTo((ushort)0);

        bridge.Command(Dt295Channel.Sub, 0x0A, 1, 1);
        await Assert.That(usb.Log[2]).IsEqualTo("40 B9 0000 0000 0A010001");
        await Assert.That(Dt295Bridge.CommandBytes(5, 0, 2)).IsEquivalentTo(new byte[] { 5, 0, 0, 2 });
    }

    [Test]
    public async Task 完了ビットが残っていれば送らず_失敗の完了コードは投げる()
    {
        var usb = new FakeDt295Usb { Events = Dt295Bridge.EventMainDone };
        var bridge = new Dt295Bridge(usb, usb.Time);
        Assert.Throws<Dt295Exception>(() => bridge.Command(Dt295Channel.Main, 1, 0, 0));
        await Assert.That(usb.Log).IsEmpty();

        usb.Events = 0;
        usb.CodeLow = 0x81;
        Assert.Throws<Dt295Exception>(() => bridge.Command(Dt295Channel.Main, 1, 0, 0));
        await Assert.That(Dt295Bridge.Succeeded(4, 0x0400)).IsTrue();
        await Assert.That(Dt295Bridge.Succeeded(4, 0x0480)).IsFalse();
        await Assert.That(Dt295Bridge.Succeeded(4, 0x0500)).IsFalse();
    }

    [Test]
    public async Task 状態は通知のビットを消して読み直す()
    {
        var usb = new FakeDt295Usb { State = 0x0011, Events = Dt295Bridge.EventState };
        var bridge = new Dt295Bridge(usb, usb.Time);
        await Assert.That(bridge.State()).IsEqualTo((ushort)0x0011);
        await Assert.That(usb.Log).IsEquivalentTo(new[] { "40 BC 0900 0074 0004" });
        usb.State = 0xFFFF;
        Assert.Throws<Dt295Exception>(() => bridge.State());
    }

    // ---------------------------------------------------------------------
    // I2C (3.10)
    // ---------------------------------------------------------------------

    [Test]
    public async Task I2C_は送り_受けの_sub_と長さを_val_に()
    {
        var usb = new FakeDt295Usb();
        List<string> seen = [];
        usb.I2cDevice = (address, write, read) =>
        {
            seen.Add($"{address:X2} {Convert.ToHexString(write)} {read}");
            return read == 0 ? [] : [0x5A];
        };
        var bridge = new Dt295Bridge(usb, usb.Time);

        // 送って受ける: sub 2 → sub 3
        var one = new byte[1];
        bridge.I2c(0x20, [0x0E], one);
        await Assert.That(one[0]).IsEqualTo((byte)0x5A);
        var commands = usb.Log.Where(line => line.StartsWith("40 B9", StringComparison.Ordinal)).ToList();
        await Assert.That(commands).IsEquivalentTo(new[] { "40 B9 0000 0000 09022001", "40 B9 0000 0000 09032001" });
        // 送るものは 64 バイトに 0 で埋めて 0x800C0 へ
        await Assert.That(usb.Log[0]).IsEqualTo($"40 BC 0800 00C0 0E{new string('0', 126)}");
        // 結果のビットを消した
        await Assert.That(usb.Log[^1]).IsEqualTo("40 BC 0900 0074 0100");

        // 送るだけ: sub 0。受けるだけ: sub 1
        usb.Log.Clear();
        bridge.I2c(0x22, [0xFE, 0xC0, 0x09, 0x58], []);
        bridge.I2c(0x22, [], one);
        commands = [.. usb.Log.Where(line => line.StartsWith("40 B9", StringComparison.Ordinal))];
        await Assert.That(commands).IsEquivalentTo(new[] { "40 B9 0000 0000 09002204", "40 B9 0000 0000 09012201" });
        await Assert.That(seen).IsEquivalentTo(new[] { "20 0E 1", "22 FEC00958 0", "22  1" });
        await Assert.That(Dt295Bridge.I2cValue(0x20, 64)).IsEqualTo((ushort)0x2040);
    }

    // ---------------------------------------------------------------------
    // セキュアコマンド (3.11)
    // ---------------------------------------------------------------------

    [Test]
    public async Task セキュアコマンドの要求の形()
    {
        var request = Dt295Bridge.SecureRequest(0x01020000, [1, 2, 3, 4, 5, 6, 7, 8]);
        await Assert.That(request.Length).IsEqualTo(512);
        await Assert.That(Convert.ToHexString(request.AsSpan(0, 24))).IsEqualTo("010200000000000000000002FFFFFFFF0102030405060708");
        await Assert.That(request.Skip(24).All(value => value == 0)).IsTrue();
        await Assert.That(Dt295Bridge.EncryptsRequest(0x07010600)).IsTrue();
        await Assert.That(Dt295Bridge.DecryptsResponse(0x07010600)).IsTrue();
        await Assert.That(Dt295Bridge.EncryptsRequest(0x02010200)).IsFalse();
        await Assert.That(Dt295Bridge.DecryptsResponse(0x02010200)).IsTrue();
        await Assert.That(Dt295Bridge.EncryptsRequest(0x02020400)).IsTrue();
        await Assert.That(Dt295Bridge.DecryptsResponse(0x02020400)).IsFalse();
        Assert.Throws<ArgumentException>(() => Dt295Bridge.SecureRequest(1, new byte[3]));
        Assert.Throws<ArgumentException>(() => Dt295Bridge.SecureRequest(1, new byte[500]));
    }

    [Test]
    public async Task セキュアコマンドの応答の判定()
    {
        static byte[] Response(uint id, uint status, uint words)
        {
            var response = new byte[512];
            BinaryPrimitives.WriteUInt32BigEndian(response, id);
            BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(4), status);
            BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(8), words);
            response[16] = 0xAB;
            return response;
        }
        var payload = Dt295Bridge.SecureResponse(0x01010000, Response(0x01010000, 0, 9), null, null);
        await Assert.That(payload.Length).IsEqualTo(36);
        await Assert.That(payload[0]).IsEqualTo((byte)0xAB);
        Assert.Throws<Dt295Exception>(() => Dt295Bridge.SecureResponse(0x01010000, Response(0x01020000, 0, 0), null, null));
        var rejected = Assert.Throws<Dt295Exception>(() => Dt295Bridge.SecureResponse(0x01010000, Response(0x01010000, 0x00020019, 0), null, null));
        await Assert.That(rejected.Message).Contains("0x00020019");
        Assert.Throws<Dt295Exception>(() => Dt295Bridge.SecureResponse(0x01010000, Response(0x01010000, 0, 125), null, null));
    }

    // ---------------------------------------------------------------------
    // 暗号 (5.1)
    // ---------------------------------------------------------------------

    [Test]
    public async Task AES_CMAC_は_RFC_4493_の例と同じ()
    {
        var key = Hex("2b7e151628aed2a6abf7158809cf4f3c");
        var message = Hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710");
        await Assert.That(Convert.ToHexStringLower(Dt295Crypto.Cmac(key, []))).IsEqualTo("bb1d6929e95937287fa37d129b756746");
        await Assert.That(Convert.ToHexStringLower(Dt295Crypto.Cmac(key, message.AsSpan(0, 16)))).IsEqualTo("070a16b46b4d4144f79bdd9dd04a287c");
        await Assert.That(Convert.ToHexStringLower(Dt295Crypto.Cmac(key, message.AsSpan(0, 40)))).IsEqualTo("dfa66747de9ae63030ca32611497c827");
        await Assert.That(Convert.ToHexStringLower(Dt295Crypto.Cmac(key, message))).IsEqualTo("51f0bebf7e3b9d92fc49741779363cfe");
    }

    private static readonly byte[] SomeKey = [.. Enumerable.Range(0, 16).Select(i => (byte)(i * 17 + 1))];
    private static readonly byte[] SomeIv = [.. Enumerable.Range(0, 16).Select(i => (byte)(0xF0 - i * 3))];

    /// <summary>端数付き CBC の暗号化 (テスト側で別に組む): 全ブロックは CBC、端数は直前の暗号ブロック (無ければ IV) の AES と XOR</summary>
    private static byte[] EncryptWithResidual(byte[] plain)
    {
        var data = plain.ToArray();
        var whole = data.Length / 16 * 16;
        using var aes = Aes.Create();
        aes.Key = SomeKey;
        if (whole > 0) aes.EncryptCbc(data.AsSpan(0, whole), SomeIv, data.AsSpan(0, whole), PaddingMode.None);
        var previous = whole == 0 ? SomeIv : data[(whole - 16)..whole];
        var stream = aes.EncryptEcb(previous, PaddingMode.None);
        for (var i = whole; i < data.Length; i++) data[i] ^= stream[i - whole];
        return data;
    }

    [Test]
    public async Task 端数付き_CBC_復号は端数を直前の暗号ブロックの暗号化と_XOR()
    {
        foreach (var length in new[] { 184, 176, 16, 7, 0 })
        {
            var plain = Enumerable.Range(0, length).Select(i => (byte)(i * 5 + 9)).ToArray();
            var data = EncryptWithResidual(plain);
            Dt295Crypto.CbcDecryptWithResidual(SomeKey, SomeIv, data);
            await Assert.That(data).IsEquivalentTo(plain);
        }
    }

    [Test]
    public async Task TS_のパケットは_01_だけ復号して_00_に戻す()
    {
        var decryptor = new Dt295PacketDecryptor();
        var plain = new byte[188];
        plain[0] = 0x47;
        plain[1] = 0x01;
        plain[2] = 0x11;
        plain[3] = 0x10;
        for (var i = 4; i < 188; i++) plain[i] = (byte)i;
        var packet = plain.ToArray();
        EncryptWithResidual(plain[4..]).CopyTo(packet, 4);
        packet[3] |= 0x40;
        await Assert.That(decryptor.Decrypt(packet, SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Decrypted);
        await Assert.That(packet).IsEquivalentTo(plain);

        // adaptation field のあとから
        var adapted = plain.ToArray();
        adapted[3] = 0x30;
        adapted[4] = 10;
        var encrypted = adapted.ToArray();
        EncryptWithResidual(adapted[15..]).CopyTo(encrypted, 15);
        encrypted[3] |= 0x40;
        await Assert.That(decryptor.Decrypt(encrypted, SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Decrypted);
        await Assert.That(encrypted).IsEquivalentTo(adapted);

        // そのまま・不正
        var clear = plain.ToArray();
        await Assert.That(decryptor.Decrypt(clear, SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Clear);
        await Assert.That(clear).IsEquivalentTo(plain);
        byte[] Changed(Action<byte[]> change)
        {
            var copy = plain.ToArray();
            change(copy);
            return copy;
        }
        await Assert.That(decryptor.Decrypt(Changed(p => p[0] = 0x48), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => p[1] |= 0x80), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => p[3] = 0x00), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => p[3] = 0x90), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => p[3] = 0xD0), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => { p[3] = 0x60; p[4] = 183; }), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => { p[3] = 0x20; p[4] = 100; }), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
        await Assert.That(decryptor.Decrypt(Changed(p => { p[3] = 0x70; p[4] = 183; }), SomeKey, SomeIv)).IsEqualTo(Dt295PacketResult.Invalid);
    }

    // ---------------------------------------------------------------------
    // 認証 (5.3〜5.6)
    // ---------------------------------------------------------------------

    [Test]
    public async Task 認証の部品()
    {
        await Assert.That(Convert.ToHexString(Dt295Auth.InitialPayload()))
            .IsEqualTo("E0070000060000000E00000078050000010000000300000002000000" + "0C000000");
        await Assert.That(Dt295Auth.InitialPayload()[6]).IsEqualTo((byte)0);
        var s = Enumerable.Range(0, 16).Select(i => (byte)i).ToArray();
        await Assert.That(Convert.ToHexString(Dt295Auth.Reorder(s))).IsEqualTo("0C0D0E0F08090A0B0001020304050607");
        await Assert.That(Dt295Auth.Next(1)).IsEqualTo(2u);
        await Assert.That(Dt295Auth.Next(0xFFFFFFFF)).IsEqualTo(1u);
    }

    [Test]
    public async Task 認証からセッション更新とセッションの終わりまで()
    {
        var material = FakeDt295Material.Create();
        var usb = new FakeDt295Usb { State = Dt295Device.Idle };
        var first = Enumerable.Range(0, 36).Select(i => (byte)(i * 11 + 4)).ToArray();
        byte[] nonce = [0xDE, 0xAD, 0xBE, 0xEF];

        // テスト側で 5.3・5.4 を別に計算しておく
        var initial = Dt295Auth.InitialPayload();
        var select = new byte[32];
        material.AuthPrefix.CopyTo(select);
        select[30] = first[32];
        select[31] = initial[6];
        var n = Dt295Crypto.Cmac(material.Key1, select)[15] & 0x0F;
        var row = material.Rows.AsSpan(32 * n, 32).ToArray();
        var answer = Dt295Crypto.Cmac(material.Key2, [.. first[..32], .. row]).Concat(nonce).ToArray();
        var s = Dt295Crypto.Cmac(material.Key3, [.. answer, .. row, .. material.SessionSuffix]);
        byte[] sessionKey = [.. s[12..16], .. s[8..12], .. s[..8]];
        var challenge = Enumerable.Range(0, 32).Select(i => (byte)(0x80 + i)).ToArray();

        List<string> secure = [];
        usb.SecureDevice = request =>
        {
            var id = BinaryPrimitives.ReadUInt32BigEndian(request);
            var plain = request.ToArray();
            if ((id & 0x400) != 0)
            {
                using var aes = Aes.Create();
                aes.Key = sessionKey;
                aes.DecryptCbc(plain.AsSpan(12, 496), material.SessionIv, plain.AsSpan(12, 496), PaddingMode.None);
            }
            var words = BinaryPrimitives.ReadUInt32BigEndian(plain.AsSpan(8));
            var payload = plain.AsSpan(16, (int)words * 4).ToArray();
            secure.Add($"{id:X8} {Convert.ToHexString(payload)}");
            var response = new byte[512];
            BinaryPrimitives.WriteUInt32BigEndian(response, id);
            byte[] reply = id switch
            {
                Dt295Device.AuthFirst => first,
                Dt295Device.RefreshQuery => challenge,
                _ => [],
            };
            BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(8), (uint)(reply.Length / 4));
            reply.CopyTo(response, 16);
            if ((id & 0x200) != 0)
            {
                using var aes = Aes.Create();
                aes.Key = sessionKey;
                aes.EncryptCbc(response.AsSpan(12, 496), material.SessionIv, response.AsSpan(12, 496), PaddingMode.None);
            }
            return response;
        };

        var device = new Dt295Device(new Dt295Bridge(usb, usb.Time), _ => nonce);
        device.Authenticate(material);
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Authenticated);
        await Assert.That(secure[0]).IsEqualTo($"01010000 {Convert.ToHexString(initial)}");
        await Assert.That(secure[1]).IsEqualTo($"01020000 {Convert.ToHexString(answer)}");
        // アイドル設定 (5.5) のあと cmd 1
        await Assert.That(usb.Log.Count(line => line == "40 B8 0000 0000 01000000")).IsEqualTo(1);

        // 30 秒までは更新しない
        await Assert.That(device.RefreshIfDue()).IsFalse();
        usb.Time.NowMs += Dt295Device.RefreshMs;
        await Assert.That(device.RefreshIfDue()).IsTrue();
        var mac = Dt295Crypto.Cmac(material.Key4, [.. challenge, .. material.RefreshSuffix, 0, 0, 0, 1]);
        await Assert.That(secure[2]).IsEqualTo("02010200 ");
        await Assert.That(secure[3]).IsEqualTo($"02020400 {Convert.ToHexString(mac)}DEADBEEF");
        // 2 回目は計数 2
        usb.Time.NowMs += Dt295Device.RefreshMs;
        device.RefreshIfDue();
        var mac2 = Dt295Crypto.Cmac(material.Key4, [.. challenge, .. material.RefreshSuffix, 0, 0, 0, 2]);
        await Assert.That(secure[5]).IsEqualTo($"02020400 {Convert.ToHexString(mac2)}DEADBEEF");

        // 終わり: cmd 4 sub 0 val 1 → idle イメージ → cmd 4 sub 1 val 0 → 0x10 (偽物は cmd 4 sub 1 で 0x10 になる)
        usb.Log.Clear();
        device.Close(new byte[65536 + 10]);
        await Assert.That(usb.Log.Where(line => line.StartsWith("40 B8", StringComparison.Ordinal) || line.StartsWith("BULK", StringComparison.Ordinal)))
            .IsEquivalentTo(new[] { "40 B8 0000 0000 04000001", "BULK 02 65536", "BULK 02 10", "40 B8 0000 0000 04010000" });
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Idle);
        await Assert.That(device.HasSession).IsFalse();
    }

    // ---------------------------------------------------------------------
    // カード (6)
    // ---------------------------------------------------------------------

    [Test]
    public async Task カードは通知を読み捨てて上位4ビットを状態にする()
    {
        var usb = new FakeDt295Usb { State = Dt295Device.Authenticated, Events = Dt295Bridge.EventCard };
        usb.Set16(0x822AC, 0x3000);
        var device = new Dt295Device(new Dt295Bridge(usb, usb.Time));
        await Assert.That(device.CardState()).IsEqualTo(Dt295CardState.Ready);
        await Assert.That(device.CardNotices).IsEqualTo(1);
        usb.Events = Dt295Bridge.EventCardError;
        Assert.Throws<Dt295Exception>(() => device.CardState());
    }

    [Test]
    public async Task カードの活性化は送り直さず3を待つ()
    {
        var usb = new FakeDt295Usb { State = Dt295Device.Authenticated };
        usb.Set16(0x822AC, 0x1000);
        // cmd 0x0A sub 1 で活性化中 (2) になり、50 ms たつと 3 になるふり
        long activatedAt = -1;
        usb.OnCommand = (command, sub, _) =>
        {
            if (command == 0x0A && sub == 1)
            {
                usb.Set16(0x822AC, 0x2000);
                activatedAt = usb.Time.NowMs;
            }
        };
        usb.Time.OnSleep = () =>
        {
            if (activatedAt >= 0 && usb.Time.NowMs - activatedAt >= 50) usb.Set16(0x822AC, 0x3000);
        };
        var device = new Dt295Device(new Dt295Bridge(usb, usb.Time));
        await Assert.That(device.ActivateCard()).IsEqualTo(Dt295CardState.Ready);
        await Assert.That(usb.Time.Sleeps.Count).IsEqualTo(5);
        await Assert.That(usb.Log.Count(line => line.StartsWith("40 B9", StringComparison.Ordinal))).IsEqualTo(1);

        // 通知を受けたあとの 0 は「カードが無い」
        var empty = new FakeDt295Usb { State = Dt295Device.Authenticated, Events = Dt295Bridge.EventCard };
        var none = new Dt295Device(new Dt295Bridge(empty, empty.Time));
        Assert.Throws<Dt295Exception>(() => none.ActivateCard());
        await Assert.That(empty.Log.Any(line => line.StartsWith("40 B9", StringComparison.Ordinal))).IsFalse();
    }

    // ---------------------------------------------------------------------
    // 起動 (4)
    // ---------------------------------------------------------------------

    [Test]
    public async Task 状態で起動を分ける()
    {
        var running = new FakeDt295Usb { State = Dt295Device.Idle };
        await Assert.That(new Dt295Device(new Dt295Bridge(running, running.Time)).Boot([1, 2, 3])).IsEqualTo(Dt295Boot.Running);
        await Assert.That(running.Log).IsEmpty();

        var busy = new FakeDt295Usb { State = Dt295Device.Authenticated };
        Assert.Throws<Dt295Exception>(() => new Dt295Device(new Dt295Bridge(busy, busy.Time)).Boot([1]));
        await Assert.That(busy.Log).IsEmpty();
        // 0xFFFF は cmd 3 で戻してみる (5.8)。戻らなければ投げる
        var broken = new FakeDt295Usb { State = 0xFFFF };
        Assert.Throws<Dt295Exception>(() => new Dt295Device(new Dt295Bridge(broken, broken.Time)).Boot([1]));
        await Assert.That(broken.Log.Count(line => line.StartsWith("40 B8", StringComparison.Ordinal))).IsEqualTo(1);
        await Assert.That(broken.Bulk).IsEmpty();

        // コールド: 合図が来なければイメージを送らない
        var cold = new FakeDt295Usb();
        Assert.Throws<Dt295Exception>(() => new Dt295Device(new Dt295Bridge(cold, cold.Time)).Boot(new byte[10]));
        await Assert.That(cold.Bulk).IsEmpty();
        // 手順 1〜4 の書き込み: 0x90194 → 0x90198 → 0x90078 を 14 回 → 0x901B4 を 12 回
        var writes = cold.Log.Select(line => line.Split(' ')[2] + line.Split(' ')[3]).ToList();
        await Assert.That(writes[0]).IsEqualTo("09000194");
        await Assert.That(writes[1]).IsEqualTo("09000198");
        await Assert.That(writes.Count(address => address == "09000078")).IsEqualTo(14);
        await Assert.That(writes.Count(address => address == "090001B4")).IsEqualTo(12);
        await Assert.That(cold.Get16(0x90194)).IsEqualTo((ushort)0x1000);
        await Assert.That(cold.Get16(0x90198)).IsEqualTo((ushort)0x0040);
    }

    // ---------------------------------------------------------------------
    // 周波数 (7.1・8.1・8.4)
    // ---------------------------------------------------------------------

    [Test]
    public async Task 地上波の周波数と分周値()
    {
        await Assert.That(Dt295Frontend.TerrestrialHz(13)).IsEqualTo(473_142_857L);
        await Assert.That(Dt295Frontend.TerrestrialHz(27)).IsEqualTo(557_142_857L);
        await Assert.That(Dt295Frontend.TerrestrialHz(62)).IsEqualTo(767_142_857L);
        await Assert.That(Dt295Frontend.TerrestrialDivider(557_142_857)).IsEqualTo(35657);
        await Assert.That(Dt295Frontend.TerrestrialDivider(473_142_857)).IsEqualTo(30281);
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Frontend.TerrestrialHz(12));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Frontend.TerrestrialHz(63));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Frontend.TerrestrialDivider(770_000_001));
    }

    [Test]
    public async Task 衛星の_IF_と書く値()
    {
        await Assert.That(Dt295Frontend.BsIfHz(1)).IsEqualTo(1_049_480_000L);
        await Assert.That(Dt295Frontend.BsIfHz(23)).IsEqualTo(1_471_440_000L);
        await Assert.That(Dt295Frontend.CsIfHz(2)).IsEqualTo(1_613_000_000L);
        await Assert.That(Dt295Frontend.CsIfHz(24)).IsEqualTo(2_053_000_000L);
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Frontend.BsIfHz(2));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Frontend.CsIfHz(3));

        var bs1 = Dt295Frontend.SatelliteIfSettings(1_049_480_000);
        await Assert.That(bs1.Khz).IsEqualTo(1_049_000);
        await Assert.That(Convert.ToHexString(bs1.Bytes)).IsEqualTo("1064000080");
        await Assert.That(bs1.Band).IsEqualTo((byte)0x58);

        var cs2 = Dt295Frontend.SatelliteIfSettings(1_613_000_000);
        await Assert.That(cs2.Khz).IsEqualTo(1_613_000);
        await Assert.That(Convert.ToHexString(cs2.Bytes)).IsEqualTo("0C9A000000");
        await Assert.That(cs2.Band).IsEqualTo((byte)0x44);

        // 四捨五入 (1,100,500 kHz は 1,101 MHz になり、高い側)
        var edge = Dt295Frontend.SatelliteIfSettings(1_100_500_000);
        await Assert.That(edge.Khz).IsEqualTo(1_101_000);
        await Assert.That(edge.Bytes[4]).IsEqualTo((byte)0);
        await Assert.That(Dt295Frontend.SatelliteIfSettings(2_150_000_000).Band).IsEqualTo((byte)0x00);
    }

    [Test]
    public async Task 地上波の選局は分周値を_RF_の_0x10_と_0x11_へ()
    {
        var usb = new FakeDt295Usb { State = Dt295Device.Authenticated };
        List<string> writes = [];
        usb.I2cDevice = (address, write, read) =>
        {
            if (write.Length > 0) writes.Add($"{address:X2}:{Convert.ToHexString(write)}");
            return new byte[read];
        };
        var tuner = new Dt295Frontend(new Dt295Bridge(usb, usb.Time), FakeDt295Material.Create());
        tuner.TuneTerrestrial(27);
        // 初期化の 473 MHz (N = 30281 = 0x7649) と、選んだ 557 MHz (N = 35657 = 0x8B49)
        await Assert.That(writes).Contains("20:FEC01049");
        await Assert.That(writes).Contains("20:FEC01176");
        await Assert.That(writes).Contains("20:FEC0118B");
        // RF の 0xFF は値を送らない
        await Assert.That(writes).Contains("20:FEC0FF");
        // 最後は復調器 [0x1F] ← 0x8A
        await Assert.That(writes[^1]).IsEqualTo("20:1F8A");
        await Assert.That(usb.Time.Sleeps.Sum()).IsEqualTo(20 + 5 + 100 + 20 + 20 + 20 + 100);
    }

    // ---------------------------------------------------------------------
    // ルート (9.4・11)
    // ---------------------------------------------------------------------

    [Test]
    public async Task スロットのレジスターの場所()
    {
        await Assert.That(Dt295Routes.PidRegister(0)).IsEqualTo(0x101Eu);
        await Assert.That(Dt295Routes.PidRegister(3)).IsEqualTo(0x1024u);
        await Assert.That(Dt295Routes.PidRegister(4)).IsNull();
        await Assert.That(Dt295Routes.PidRegister(5)).IsEqualTo(0x1028u);
        await Assert.That(Dt295Routes.PidRegister(39)).IsEqualTo(0x106Cu);
        await Assert.That(Dt295Routes.PidRegister(40)).IsEqualTo(0x106Eu);
        await Assert.That(Dt295Routes.PidRegister(41)).IsEqualTo(0x1070u);
        await Assert.That(Dt295Routes.PidRegister(63)).IsEqualTo(0x109Cu);

        await Assert.That(Dt295Routes.EcmField(0)).IsEqualTo(((uint)0x10A2, 8));
        await Assert.That(Dt295Routes.EcmField(1)).IsEqualTo(((uint)0x10A2, 0));
        await Assert.That(Dt295Routes.EcmField(2)).IsNull();
        await Assert.That(Dt295Routes.EcmField(3)).IsNull();
        await Assert.That(Dt295Routes.EcmField(4)).IsNull();
        await Assert.That(Dt295Routes.EcmField(5)).IsEqualTo(((uint)0x10A6, 0));
        await Assert.That(Dt295Routes.EcmField(6)).IsEqualTo(((uint)0x10A8, 8));
        await Assert.That(Dt295Routes.EcmField(7)).IsEqualTo(((uint)0x10A8, 0));
        await Assert.That(Dt295Routes.EcmField(8)).IsEqualTo(((uint)0x10AA, 8));
        await Assert.That(Dt295Routes.EcmField(63)).IsEqualTo(((uint)0x10E0, 0));
    }

    [Test]
    public async Task 計画は_ECM_を上から_主番組を0から3_残りを5から()
    {
        var main = new Dt295Program(0x0400, PmtPid: 0x1F0, PcrPid: 0x111, VideoPid: 0x111, VideoType: 0x02, AudioPid: 0x112, AudioType: 0x0F);
        int[] pids = [.. Dt295Routes.FixedSi, 0x1F0, 0x111, 0x112, 0x130, 0x0000, 0x1FFF, 0x0010];
        var ecm = new Dictionary<int, int> { [0x111] = 0x901, [0x112] = 0x901, [0x130] = 0x901 };
        var plan = Dt295Routes.Plan(main, pids, ecm);
        var bySlot = plan.ToDictionary(route => route.Slot);

        await Assert.That(bySlot[63]).IsEqualTo(new Dt295Route(63, 0x901, 63));
        await Assert.That(bySlot[0]).IsEqualTo(new Dt295Route(0, 0x111, 63));
        await Assert.That(bySlot[1]).IsEqualTo(new Dt295Route(1, 0x112, 63));
        await Assert.That(bySlot[2]).IsEqualTo(new Dt295Route(2, 0x1F0, 0));
        // PCR は映像と同じ PID なので専用枠に入れない
        await Assert.That(bySlot.ContainsKey(3)).IsFalse();
        await Assert.That(bySlot.ContainsKey(4)).IsFalse();
        // 固定の SI が 5 から、そのあと ES
        await Assert.That(bySlot[5].Pid).IsEqualTo(0x0001);
        await Assert.That(bySlot[15].Pid).IsEqualTo(0x0029);
        await Assert.That(bySlot[16]).IsEqualTo(new Dt295Route(16, 0x130, 63));
        // 同じ PID・0・0x1FFF は登録しない
        await Assert.That(plan.Length).IsEqualTo(4 + 11 + 1);
        await Assert.That(plan.Select(route => route.Pid).Distinct().Count()).IsEqualTo(plan.Length);
    }

    [Test]
    public async Task 複数の_ECM_とスロットの不足は断る()
    {
        Assert.Throws<InvalidOperationException>(() => Dt295Routes.Plan(null, [0x100, 0x101], new Dictionary<int, int> { [0x100] = 0x901, [0x101] = 0x902 }));
        Assert.Throws<InvalidOperationException>(() => Dt295Routes.Plan(null, Enumerable.Range(0x100, 64)));
        await Assert.That(Dt295Routes.Plan(null, Enumerable.Range(0x100, 59)).Length).IsEqualTo(59);
    }

    [Test]
    public async Task ルートをレジスターに書く()
    {
        var usb = new FakeDt295Usb();
        var bridge = new Dt295Bridge(usb, usb.Time);
        var main = new Dt295Program(0x0400, 0x1F0, 0x111, 0x111, 0x02, 0x112, 0x0F);
        var plan = Dt295Routes.Plan(main, [0x0010], new Dictionary<int, int> { [0x111] = 0x901 });
        usb.Set16(0x1028 + 2, 0x8123);
        Dt295Routes.Write(bridge, plan, main);
        await Assert.That(usb.Get16(0x101E)).IsEqualTo((ushort)0x8111);
        await Assert.That(usb.Get16(0x1020)).IsEqualTo((ushort)0x8112);
        await Assert.That(usb.Get16(0x1022)).IsEqualTo((ushort)0x81F0);
        await Assert.That(usb.Get16(0x1024)).IsEqualTo((ushort)0x0000);
        await Assert.That(usb.Get16(0x1028)).IsEqualTo((ushort)0x8010);
        // 計画に無いスロットは無効・PID 0
        await Assert.That(usb.Get16(0x102A)).IsEqualTo((ushort)0x0000);
        await Assert.That(usb.Get16(0x109C)).IsEqualTo((ushort)0x8901);
        // ECM 参照: スロット 0 → 63、スロット 63 は自分
        await Assert.That(usb.Get16(0x10A2) >> 8).IsEqualTo(63);
        await Assert.That(usb.Get16(0x10E0) & 0x7F).IsEqualTo(63);
        await Assert.That(usb.Get16(0x1018)).IsEqualTo((ushort)0x0400);
        await Assert.That(usb.Get16(0x101C)).IsEqualTo((ushort)0x020F);
    }

    // ---------------------------------------------------------------------
    // PSI と TS の統計 (10.2)
    // ---------------------------------------------------------------------

    [Test]
    public async Task PAT_と_PMT_を読んで主番組を選ぶ()
    {
        var reader = new Dt295SectionReader();
        var pat = Dt295Ts.Packet(0, Dt295Ts.Section(0x00, 0x7FE0, [0x00, 0x00, 0xE0, 0x10, 0x04, 0x00, 0xE1, 0xF0]));
        var sections = reader.Push(pat);
        await Assert.That(sections.Count).IsEqualTo(1);
        var entries = Dt295SectionReader.Pat(sections[0])!;
        await Assert.That(entries).IsEquivalentTo(new[] { new Dt295PatEntry(0, 0x10), new Dt295PatEntry(0x400, 0x1F0) });

        byte[] ca = [0x09, 0x04, 0x00, 0x05, 0xE9, 0x01];
        byte[] pmtBody =
        [
            0xE1, 0x11, 0xF0, (byte)ca.Length, .. ca,
            0x02, 0xE1, 0x11, 0xF0, 0x00,
            0x0F, 0xE1, 0x12, 0xF0, 0x00,
            0x06, 0xE1, 0x30, 0xF0, 0x00,
        ];
        var pmtSections = reader.Push(Dt295Ts.Packet(0x1F0, Dt295Ts.Section(0x02, 0x400, pmtBody)));
        var pmt = Dt295SectionReader.Pmt(pmtSections[0])!;
        await Assert.That(pmt.PcrPid).IsEqualTo(0x111);
        await Assert.That(pmt.CaPids).IsEquivalentTo(new[] { 0x901 });
        await Assert.That(pmt.EcmOf[0x111]).IsEqualTo(0x901);
        await Assert.That(pmt.EcmOf[0x130]).IsEqualTo(0x901);
        var main = Dt295SectionReader.MainProgram(0x1F0, pmt)!;
        await Assert.That(main).IsEqualTo(new Dt295Program(0x400, 0x1F0, 0x111, 0x111, 0x02, 0x112, 0x0F));

        // 暗号化されたパケットと CRC の合わないセクションは読まない
        var scrambled = pat.ToArray();
        scrambled[3] |= 0x40;
        await Assert.That(reader.Push(scrambled)).IsEmpty();
        var broken = pat.ToArray();
        broken[10] ^= 1;
        await Assert.That(reader.Push(broken)).IsEmpty();
    }

    [Test]
    public async Task 統計は188バイトずつ切って端数を次につなぐ()
    {
        var stats = new Dt295TsStats();
        var data = new byte[188 * 3];
        for (var i = 0; i < 3; i++)
        {
            data[i * 188] = 0x47;
            data[i * 188 + 1] = 0x01;
            data[i * 188 + 2] = (byte)i;
            data[i * 188 + 3] = (byte)(i << 6 | 0x10);
        }
        data[188 * 2] = 0x00;
        await Assert.That(stats.Push(data.AsSpan(0, 100)).Count).IsEqualTo(0);
        await Assert.That(stats.Push(data.AsSpan(100, 300)).Count).IsEqualTo(2);
        await Assert.That(stats.Push(data.AsSpan(400)).Count).IsEqualTo(0);
        await Assert.That(stats.Bytes).IsEqualTo(188L * 3);
        await Assert.That(stats.Packets).IsEqualTo(3L);
        await Assert.That(stats.Synced).IsEqualTo(2L);
        await Assert.That(stats.Scrambling).IsEquivalentTo(new long[] { 1, 1, 0, 0 });
        await Assert.That(stats.Pids.Keys).IsEquivalentTo(new[] { 0x100, 0x101 });
        var output = new StringWriter();
        stats.Print(output);
        await Assert.That(output.ToString()).Contains("00=1 01=1 10=0 11=0");
    }
}
