namespace Denpa.Agent.Tests;

/*
 * B-CAS のコマンド (BCas.cs)。
 *
 * 本物のカードは無い。カードが返す応答の形式を作って接続に置き、
 * **libaribb25 と同じ値が出るか**と、切れたときの繋ぎ直しを確かめる。
 */
public class BCasTests
{
    private static readonly byte[] SystemKey = [.. Enumerable.Range(0x10, 32).Select(b => (byte)b)];
    private static readonly byte[] InitCbc = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7];

    /// <summary>INT の応答。返り値 0x2100、CA_system_id 5。中身 57 バイトに SW 90 00</summary>
    private static byte[] IntResponse(int code = 0x2100)
    {
        var response = new byte[59];
        response[1] = 0x39;
        response[4] = (byte)(code >> 8);
        response[5] = (byte)code;
        response[7] = 0x05;
        byte[] id = [0x00, 0x01, 0x23, 0x45, 0x67, 0x89];
        id.CopyTo(response, 8);
        SystemKey.CopyTo(response, 16);
        InitCbc.CopyTo(response, 48);
        response[57] = 0x90;
        return response;
    }

    /// <summary>IDI の応答。番号ごとに (メーカー識別・バージョン・48 ビットの番号・チェックコード)</summary>
    private static byte[] IdiResponse(params byte[][] ids)
    {
        var response = new byte[7 + ids.Length * 10 + 2];
        response[4] = 0x21;
        response[6] = (byte)ids.Length;
        for (var at = 0; at < ids.Length; at++)
        {
            response[7 + at * 10] = 0x54;  // メーカー識別 'T'
            response[8 + at * 10] = 0x03;
            ids[at].CopyTo(response, 9 + at * 10);
            response[15 + at * 10] = 0xbe;
            response[16 + at * 10] = 0xef;
        }
        response[^2] = 0x90;
        return response;
    }

    private static readonly byte[] CardNumber = [0x00, 0x01, 0x23, 0x45, 0x67, 0x89];

    /// <summary>ECM の応答。鍵は奇数 11…、偶数 22…</summary>
    private static byte[] EcmResponse(int code = 0x0200)
    {
        var response = new byte[25];
        response[1] = 0x15;
        response[4] = (byte)(code >> 8);
        response[5] = (byte)code;
        for (var at = 0; at < 8; at++)
        {
            response[6 + at] = 0x11;
            response[14 + at] = 0x22;
        }
        response[23] = 0x90;
        return response;
    }

    private static readonly byte[] SampleEcm = [.. Enumerable.Range(0, 0x94).Select(b => (byte)(b * 7))];

    /// <summary>契約確認の応答。返り値 0x0800 (ティア有効など)</summary>
    private static byte[] ConfirmResponse(int code = 0x0800)
    {
        var response = new byte[8];
        response[1] = 0x04;
        response[4] = (byte)(code >> 8);
        response[5] = (byte)code;
        response[6] = 0x90;
        response[7] = 0x00;
        return response;
    }

    /// <summary>送られてきた APDU の先頭 (CLA INS) で応答を決める接続</summary>
    private sealed class FakeLink(string name, Func<byte[], byte[]>? ecm = null) : ICardLink
    {
        private int _busy;

        public string Name { get; } = name;
        public List<byte[]> Sent { get; } = [];
        public int Resets { get; private set; }
        public bool Disposed { get; private set; }
        public int Overlapped { get; private set; }
        public Func<byte[]> Int { get; set; } = () => IntResponse();
        public Func<byte[]> Idi { get; set; } = () => IdiResponse(CardNumber);
        public Func<byte[], byte[]>? Confirm { get; set; }
        public Func<byte[], byte[]>? Emm { get; set; }

        public byte[] Reset()
        {
            if (Disposed) throw new ObjectDisposedException(Name);
            Resets++;
            return [0x3b, 0xf0, 0x12, 0x00, 0xff, 0x91, 0x81, 0xb1, 0x7c, 0x45, 0x1f, 0x03, 0x99];
        }

        public byte[] Transmit(ReadOnlySpan<byte> apdu)
        {
            if (Disposed) throw new ObjectDisposedException(Name);
            if (Interlocked.Exchange(ref _busy, 1) == 1) Overlapped++;
            try
            {
                var sent = apdu.ToArray();
                lock (Sent) Sent.Add(sent);
                Thread.Sleep(1);
                return sent[1] switch
                {
                    0x30 => Int(),
                    0x32 => Idi(),
                    0x34 => (ecm ?? (_ => EcmResponse()))(sent),
                    0x3c => (Confirm ?? (_ => ConfirmResponse()))(sent),
                    0x36 => (Emm ?? (_ => ConfirmResponse(0x2100)))(sent),
                    _ => [0x6d, 0x00],
                };
            }
            finally
            {
                Volatile.Write(ref _busy, 0);
            }
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 9, 26, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static CardLinkCandidate Candidate(ICardLink link) => new(link.Name, () => link);

    private static int EcmsSent(FakeLink link) => link.Sent.Count(apdu => apdu[1] == 0x34);

    [Test]
    public async Task 開くと_INT_と_IDI_を読む()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);
        var init = card.Init();

        await Assert.That(link.Resets).IsEqualTo(1);
        await Assert.That(link.Sent[0]).IsEquivalentTo(new byte[] { 0x90, 0x30, 0x00, 0x00, 0x00 });
        await Assert.That(link.Sent[1]).IsEquivalentTo(new byte[] { 0x90, 0x32, 0x00, 0x00, 0x00 });
        await Assert.That(init.SystemKey).IsEquivalentTo(SystemKey);
        await Assert.That(init.InitCbc).IsEquivalentTo(InitCbc);
        await Assert.That(init.CaSystemId).IsEqualTo(5);
        await Assert.That(card.Name).IsEqualTo("reader");
    }

    [Test]
    public async Task 契約確認コマンドを通す()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        byte[] verification = [0x01, 0x02, 0x03, 0x04];
        var code = card.Confirm(verification, 60000);

        await Assert.That(code).IsEqualTo(0x0800);
        var apdu = link.Sent.Last();
        await Assert.That(apdu[0]).IsEqualTo(0x90);
        await Assert.That(apdu[1]).IsEqualTo(0x3C);
        await Assert.That(apdu[2]).IsEqualTo(0x00);
        await Assert.That(apdu[3]).IsEqualTo(0x00);
        await Assert.That(apdu[4]).IsEqualTo(6); // 4 + 2
        await Assert.That((apdu[5] << 8) | apdu[6]).IsEqualTo(60000);
        await Assert.That(apdu.AsSpan(7, 4).ToArray()).IsEquivalentTo(verification);
        await Assert.That(apdu[^1]).IsEqualTo(0x00);
    }

    [Test]
    public async Task 契約確認データの長さが異常なら送らずに断る()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        // 0 バイト
        var errEmpty = Assert.Throws<IOException>(() => card.Confirm([], 60000));
        await Assert.That(errEmpty?.Message).Contains("契約確認データの長さがおかしいです (0 バイト)");

        // 254 バイト (上限 253 バイト超え)
        var errTooLong = Assert.Throws<IOException>(() => card.Confirm(new byte[254], 60000));
        await Assert.That(errTooLong?.Message).Contains("契約確認データの長さがおかしいです (254 バイト)");

        // カードには送られていないこと
        await Assert.That(link.Sent.Any(apdu => apdu[1] == 0x3C)).IsFalse();
    }

    [Test]
    public async Task 契約確認で短い応答は_2_回まで送り直す()
    {
        var link = new FakeLink("reader");
        var attempts = 0;
        link.Confirm = _ =>
        {
            attempts++;
            return attempts < 3 ? [0x90, 0x00] : ConfirmResponse(0x0800);
        };

        using var card = BCas.Open(() => [Candidate(link)]);
        var code = card.Confirm([0x01], 60000);

        await Assert.That(code).IsEqualTo(0x0800);
        await Assert.That(attempts).IsEqualTo(3);

        // 3 回とも短かったら CardRefusedException で断る
        attempts = 0;
        link.Confirm = _ =>
        {
            attempts++;
            return [0x90, 0x00];
        };
        var error = Assert.Throws<CardRefusedException>(() => card.Confirm([0x01], 60000));
        await Assert.That(error?.Message).Contains("カードが契約確認に応答しません (応答 2 バイト)");
        await Assert.That(attempts).IsEqualTo(3);
    }

    [Test]
    public async Task CardWire_Confirm_のパックとアンパック()
    {
        var packed = CardWire.Pack(0x0800);
        await Assert.That(packed.Length).IsEqualTo(2);
        await Assert.That(CardWire.ReadCode(packed, "契約確認")).IsEqualTo(0x0800);

        var err = Assert.Throws<IOException>(() => CardWire.ReadCode([0x08], "契約確認"));
        await Assert.That(err?.Message).Contains("契約確認の応答が短すぎます");
    }

    /// <summary>
    /// **画面の番号が前と変わらないこと。** libaribb25 は 10 バイトのうち 3〜8 バイト目を
    /// 48 ビットの符号なしで読み、それを 10 進 16 桁で見せていた
    /// </summary>
    [Test]
    public async Task カードの番号は_libaribb25_と同じ読み方()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);
        var ids = card.Init().Ids;

        await Assert.That(ids.Length).IsEqualTo(1);
        await Assert.That(ids[0]).IsEqualTo(0x000123456789L);
        await Assert.That(ids[0].ToString("D16")).IsEqualTo("0000004886718345");
    }

    [Test]
    public async Task 番号が幾つあっても全部読み最上位ビットが立っていても負にならない()
    {
        var link = new FakeLink("reader") { Idi = () => IdiResponse([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], CardNumber) };
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Init().Ids).IsEquivalentTo(new[] { 0xffffffffffffL, 0x000123456789L });
    }

    /// <summary>APDU は <c>90 34 00 00 Lc ECM 00</c>。鍵は応答の 7 バイト目から奇数・偶数の順</summary>
    [Test]
    public async Task ECM_を送って鍵を受け取る()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);
        var answer = card.Ecm(SampleEcm);

        var apdu = link.Sent[^1];
        await Assert.That(apdu.Length).IsEqualTo(SampleEcm.Length + 6);
        await Assert.That(apdu[..5]).IsEquivalentTo(new byte[] { 0x90, 0x34, 0x00, 0x00, (byte)SampleEcm.Length });
        await Assert.That(apdu[5..^1]).IsEquivalentTo(SampleEcm);
        await Assert.That(apdu[^1]).IsEqualTo((byte)0x00);

        await Assert.That(answer.Odd).IsEquivalentTo(Enumerable.Repeat((byte)0x11, 8));
        await Assert.That(answer.Even).IsEquivalentTo(Enumerable.Repeat((byte)0x22, 8));
        await Assert.That(answer.Code).IsEqualTo(0x0200);
    }

    [Test]
    public async Task 契約が無くても例外にせず返り値で返す()
    {
        var link = new FakeLink("reader", _ => EcmResponse(0xa102));
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0xa102);
    }

    [Test]
    public async Task 短い応答は同じ接続で_2_回まで送り直す()
    {
        var calls = 0;
        var link = new FakeLink("reader", _ => ++calls < 3 ? [0x90, 0x00] : EcmResponse());
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0x0200);
        await Assert.That(EcmsSent(link)).IsEqualTo(3);
        await Assert.That(link.Resets).IsEqualTo(1);  // 繋ぎ直してはいない
    }

    [Test]
    public async Task INT_に応答しないリーダーは飛ばす()
    {
        var empty = new FakeLink("empty") { Int = () => throw new IOException("カードが挿さっていません") };
        var acas = new FakeLink("other") { Int = () => IntResponse(0xa101) };
        var good = new FakeLink("good");
        using var card = BCas.Open(() => [Candidate(empty), Candidate(acas), Candidate(good)]);

        await Assert.That(card.Name).IsEqualTo("good");
        await Assert.That(empty.Disposed).IsTrue();
        await Assert.That(acas.Disposed).IsTrue();
        await Assert.That(good.Disposed).IsFalse();
    }

    [Test]
    public async Task どれも駄目なら理由を並べた例外にする()
    {
        var empty = new FakeLink("empty") { Int = () => throw new IOException("カードが挿さっていません") };
        var error = Assert.Throws<IOException>(() => BCas.Open(() => [Candidate(empty)]));
        await Assert.That(error.Message).Contains("empty: カードが挿さっていません");

        var none = Assert.Throws<IOException>(() => BCas.Open(() => []));
        await Assert.That(none.Message).Contains("カードリーダーが見つかりません");
    }

    [Test]
    public async Task 接続が切れたら探し直して_INT_からやり直す()
    {
        var first = new FakeLink("first", _ => throw new IOException("USB が外れました"));
        var second = new FakeLink("second");
        var finds = 0;
        using var card = BCas.Open(() => ++finds == 1 ? [Candidate(first)] : [Candidate(second)]);

        var answer = card.Ecm(SampleEcm);

        await Assert.That(answer.Code).IsEqualTo(0x0200);
        await Assert.That(finds).IsEqualTo(2);
        await Assert.That(first.Disposed).IsTrue();
        await Assert.That(second.Sent.Select(apdu => apdu[1])).IsEquivalentTo(new byte[] { 0x30, 0x32, 0x34 });
        await Assert.That(card.Name).IsEqualTo("second");
    }

    [Test]
    public async Task 繋ぎ直しても駄目なら例外にして次の呼び出しでまた探す()
    {
        var broken = new FakeLink("broken", _ => throw new IOException("USB が外れました"));
        var finds = 0;
        var clock = new FakeClock();
        using var card = BCas.Open(() =>
        {
            finds++;
            return finds == 2 ? [] : [Candidate(finds == 1 ? broken : new FakeLink("back"))];
        }, clock);

        var error = Assert.Throws<IOException>(() => card.Ecm(SampleEcm));
        await Assert.That(error.Message).Contains("カードとやり取りできません");
        await Assert.That(error.Message).Contains("カードリーダーが見つかりません");
        await Assert.That(card.Name).IsEqualTo("");

        // しばらくは探し直さずに同じ理由で断る (全部のストリームが順番にリーダーを開き直さない)
        var soon = Assert.Throws<IOException>(() => card.Ecm(SampleEcm));
        await Assert.That(soon.Message).Contains("カードリーダーが見つかりません");
        await Assert.That(finds).IsEqualTo(2);

        // 挿し直した。間を置いた次の ECM は読める
        clock.Now += BCas.RetryAfter;
        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0x0200);
        await Assert.That(card.Name).IsEqualTo("back");
    }

    [Test]
    public async Task 同じ_ECM_は_3_秒のあいだカードに問い合わせない()
    {
        var clock = new FakeClock();
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)], clock);

        card.Ecm(SampleEcm);
        clock.Now += TimeSpan.FromSeconds(2);
        var cached = card.Ecm(SampleEcm);
        await Assert.That(EcmsSent(link)).IsEqualTo(1);
        await Assert.That(cached.Code).IsEqualTo(0x0200);

        card.Ecm([.. SampleEcm[..^1], 0xff]);  // 違う ECM は問い合わせる
        await Assert.That(EcmsSent(link)).IsEqualTo(2);

        clock.Now += TimeSpan.FromSeconds(2);
        card.Ecm(SampleEcm);  // 古くなったら問い合わせ直す
        await Assert.That(EcmsSent(link)).IsEqualTo(3);
    }

    [Test]
    public async Task 同時に呼ばれてもカードには順番に触る()
    {
        var link = new FakeLink("reader");
        // 時計は止めておく。混んだ CI で 64 本が 3 秒を跨ぐと、キャッシュした応答が切れて数が合わなくなる
        using var card = BCas.Open(() => [Candidate(link)], new FakeClock());

        var ecms = Enumerable.Range(0, 32).Select(n => new byte[] { 0x80, (byte)n, 0x01, 0x02 }).ToArray();
        await Task.WhenAll(Enumerable.Range(0, 64).Select(n => Task.Run(() => card.Ecm(ecms[n % ecms.Length]))));

        await Assert.That(link.Overlapped).IsEqualTo(0);
        // 同じ ECM の要求が同時に来ても、カードに問い合わせるのは 1 回ずつ
        await Assert.That(EcmsSent(link)).IsEqualTo(ecms.Length);
    }

    /// <summary>キャッシュした応答を返したら、そのことを示す (選局の内訳の記録。鍵は同じ)</summary>
    [Test]
    public async Task キャッシュした応答はそのことを示す()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)], new FakeClock());

        var first = card.Ecm(SampleEcm);
        var again = card.Ecm(SampleEcm);

        await Assert.That(first.Cached).IsFalse();
        await Assert.That(again.Cached).IsTrue();
        await Assert.That(again.Odd).IsEquivalentTo(first.Odd);
        await Assert.That(EcmsSent(link)).IsEqualTo(1);
    }

    [Test]
    public async Task 長すぎる_ECM_は送らない()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        Assert.Throws<IOException>(() => card.Ecm(new byte[256]));
        Assert.Throws<IOException>(() => card.Ecm([]));
        await Assert.That(EcmsSent(link)).IsEqualTo(0);
    }

    /// <summary>起動したときに開いておけば、最初の選局はカードを開かずにカードの定数を受け取れる (LocalCard.Warm)</summary>
    [Test]
    public async Task 起動したときに開いたカードを最初の選局で使う()
    {
        var link = new FakeLink("reader");
        var opened = 0;
        var local = new LocalCard(open: () =>
        {
            opened++;
            return BCas.Open(() => [Candidate(link)]);
        });

        local.Warm();
        await Assert.That(opened).IsEqualTo(1);
        await Assert.That(local.Name).IsEqualTo("reader");

        var sent = link.Sent.Count;
        await Assert.That(local.Init().CaSystemId).IsEqualTo(5);
        local.Warm();
        await Assert.That(opened).IsEqualTo(1);
        await Assert.That(link.Sent.Count).IsEqualTo(sent);
    }

    /// <summary>
    /// **起動したときに開けなくても、最初の選局は探し直す。** 起動の直後に開けなかっただけで、
    /// <see cref="BCas.RetryAfter"/> のあいだ断り続けない
    /// </summary>
    [Test]
    public async Task 起動したときに開けなくても最初の選局で探し直す()
    {
        var link = new FakeLink("reader");
        var ready = false;
        var opened = 0;
        var local = new LocalCard(open: () =>
        {
            opened++;
            return ready ? BCas.Open(() => [Candidate(link)]) : throw new IOException("カードリーダーが見つかりません");
        });

        local.Warm();
        await Assert.That(local.Name).IsEqualTo("");

        ready = true;
        await Assert.That(local.Init().CaSystemId).IsEqualTo(5);
        await Assert.That(opened).IsEqualTo(2);
    }

    /*
     * EMM 受信 (90 36)。契約の更新を渡す
     */
    private static readonly byte[] SamplePayload = [0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0x12, .. Enumerable.Range(0, 0x12).Select(b => (byte)b)];

    [Test]
    public async Task EMM_は_90_36_で送り_返り値は_5_から_6_バイト目で読む()
    {
        var link = new FakeLink("reader") { Emm = _ => ConfirmResponse(0xA107) };
        using var card = BCas.Open(() => [Candidate(link)]);

        var code = card.Emm(SamplePayload);

        await Assert.That(code).IsEqualTo(0xA107);
        var apdu = link.Sent.Last();
        await Assert.That(apdu[..5]).IsEquivalentTo(new byte[] { 0x90, 0x36, 0x00, 0x00, (byte)SamplePayload.Length });
        await Assert.That(apdu[5..^1]).IsEquivalentTo(SamplePayload);
        await Assert.That(apdu[^1]).IsEqualTo((byte)0x00);
        await Assert.That(apdu.Length).IsEqualTo(SamplePayload.Length + 6);
    }

    [Test]
    public async Task EMM_の短い応答は_2_回まで送り直す()
    {
        var link = new FakeLink("reader");
        var attempts = 0;
        link.Emm = _ => ++attempts < 3 ? [0x90, 0x00] : ConfirmResponse(0x2100);
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Emm(SamplePayload)).IsEqualTo(0x2100);
        await Assert.That(attempts).IsEqualTo(3);

        // 3 回とも短ければ、繋ぎ直さずに断る
        attempts = 0;
        link.Emm = _ =>
        {
            attempts++;
            return [0x90, 0x00];
        };
        Assert.Throws<CardRefusedException>(() => card.Emm(SamplePayload));
        await Assert.That(attempts).IsEqualTo(3);
        await Assert.That(link.Resets).IsEqualTo(1);
    }

    [Test]
    [Arguments(12)]
    [Arguments(256)]
    public async Task 長さのおかしい_EMM_は送らない(int length)
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        Assert.Throws<IOException>(() => card.Emm(new byte[length]));
        await Assert.That(link.Sent.Count(apdu => apdu[1] == 0x36)).IsEqualTo(0);
    }

    [Test]
    public async Task EMM_を受け入れたらキャッシュした_ECM_の応答を捨てる()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        card.Ecm(SampleEcm);
        card.Ecm(SampleEcm);
        await Assert.That(EcmsSent(link)).IsEqualTo(1);

        // 受け入れなかったときはキャッシュを残す
        link.Emm = _ => ConfirmResponse(0xA102);
        card.Emm(SamplePayload);
        card.Ecm(SampleEcm);
        await Assert.That(EcmsSent(link)).IsEqualTo(1);

        link.Emm = _ => ConfirmResponse(0x2100);
        card.Emm(SamplePayload);
        card.Ecm(SampleEcm);
        await Assert.That(EcmsSent(link)).IsEqualTo(2);
    }
}
