using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * B-CAS のコマンド (BCas.cs)。
 *
 * 本物のカードは無い。カードが返す応答の形を作って線に置き、
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

    /// <summary>IDI の応答。番号1つ (メーカー識別・版・48 ビットの番号・チェックコード)</summary>
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

    /// <summary>頼まれた APDU の頭 (CLA INS) で答えを決める線</summary>
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
    public async Task 開くとINTとIDIを読む()
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

    /// <summary>
    /// **画面の番号が前と変わらないこと。** libaribb25 は 10 バイトのうち 3〜8 バイト目を
    /// 48 ビットの符号なしで読み、それを 10 進 16 桁で見せていた
    /// </summary>
    [Test]
    public async Task カードの番号はlibaribb25と同じ読み方()
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
    public async Task ECMを送って鍵を貰う()
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
    public async Task 契約が無くても投げずに返り値で返す()
    {
        var link = new FakeLink("reader", _ => EcmResponse(0xa102));
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0xa102);
    }

    [Test]
    public async Task 短い応答は同じ線で2回まで送り直す()
    {
        var calls = 0;
        var link = new FakeLink("reader", _ => ++calls < 3 ? [0x90, 0x00] : EcmResponse());
        using var card = BCas.Open(() => [Candidate(link)]);

        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0x0200);
        await Assert.That(EcmsSent(link)).IsEqualTo(3);
        await Assert.That(link.Resets).IsEqualTo(1);  // 繋ぎ直してはいない
    }

    [Test]
    public async Task INTに答えないリーダーは飛ばす()
    {
        var empty = new FakeLink("empty") { Int = () => throw new IOException("カードが刺さっていません") };
        var acas = new FakeLink("other") { Int = () => IntResponse(0xa101) };
        var good = new FakeLink("good");
        using var card = BCas.Open(() => [Candidate(empty), Candidate(acas), Candidate(good)]);

        await Assert.That(card.Name).IsEqualTo("good");
        await Assert.That(empty.Disposed).IsTrue();
        await Assert.That(acas.Disposed).IsTrue();
        await Assert.That(good.Disposed).IsFalse();
    }

    [Test]
    public async Task どれも駄目なら理由を並べて投げる()
    {
        var empty = new FakeLink("empty") { Int = () => throw new IOException("カードが刺さっていません") };
        var error = Assert.Throws<IOException>(() => BCas.Open(() => [Candidate(empty)]));
        await Assert.That(error.Message).Contains("empty: カードが刺さっていません");

        var none = Assert.Throws<IOException>(() => BCas.Open(() => []));
        await Assert.That(none.Message).Contains("カードリーダーが見つかりません");
    }

    [Test]
    public async Task 線が切れたら探し直してINTからやり直す()
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
    public async Task 繋ぎ直しても駄目なら投げて次の呼び出しでまた探す()
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

        // しばらくは探し直さずに同じ理由で断る (全部の流れが順番にリーダーを開き直さない)
        var soon = Assert.Throws<IOException>(() => card.Ecm(SampleEcm));
        await Assert.That(soon.Message).Contains("カードリーダーが見つかりません");
        await Assert.That(finds).IsEqualTo(2);

        // 挿し直した。間を置いた次の ECM は読める
        clock.Now += BCas.RetryAfter;
        await Assert.That(card.Ecm(SampleEcm).Code).IsEqualTo(0x0200);
        await Assert.That(card.Name).IsEqualTo("back");
    }

    [Test]
    public async Task 同じECMは3秒のあいだカードに聞かない()
    {
        var clock = new FakeClock();
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)], clock);

        card.Ecm(SampleEcm);
        clock.Now += TimeSpan.FromSeconds(2);
        var cached = card.Ecm(SampleEcm);
        await Assert.That(EcmsSent(link)).IsEqualTo(1);
        await Assert.That(cached.Code).IsEqualTo(0x0200);

        card.Ecm([.. SampleEcm[..^1], 0xff]);  // 違う ECM は聞く
        await Assert.That(EcmsSent(link)).IsEqualTo(2);

        clock.Now += TimeSpan.FromSeconds(2);
        card.Ecm(SampleEcm);  // 古くなったら聞き直す
        await Assert.That(EcmsSent(link)).IsEqualTo(3);
    }

    [Test]
    public async Task 同時に呼ばれてもカードには順番に触る()
    {
        var link = new FakeLink("reader");
        // 時計は止めておく。混んだ CI で 64 本が 3 秒を跨ぐと、覚えた答えが切れて数が合わなくなる
        using var card = BCas.Open(() => [Candidate(link)], new FakeClock());

        var ecms = Enumerable.Range(0, 32).Select(n => new byte[] { 0x80, (byte)n, 0x01, 0x02 }).ToArray();
        await Task.WhenAll(Enumerable.Range(0, 64).Select(n => Task.Run(() => card.Ecm(ecms[n % ecms.Length]))));

        await Assert.That(link.Overlapped).IsEqualTo(0);
        // 同じ ECM を同時に頼まれても、カードに聞くのは1回ずつ
        await Assert.That(EcmsSent(link)).IsEqualTo(ecms.Length);
    }

    [Test]
    public async Task 長すぎるECMは送らない()
    {
        var link = new FakeLink("reader");
        using var card = BCas.Open(() => [Candidate(link)]);

        Assert.Throws<IOException>(() => card.Ecm(new byte[256]));
        Assert.Throws<IOException>(() => card.Ecm([]));
        await Assert.That(EcmsSent(link)).IsEqualTo(0);
    }
}
