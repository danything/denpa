using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * ATR の読み方と T=1 のブロックのやり取り。
 *
 * カードは台本 (送るはずのブロックと、それへの返事) で置き換える。送ったものが台本と
 * 違えばその場で落とす。本物のカードで当てるのは Ccid.Describe(reset: true)。
 */
public class T1Tests
{
    private static readonly byte[] BcasAtr = Convert.FromHexString("3BF01200FF9181B17C451F0399");

    private static byte[] I(int ns, bool more, string inf) =>
        T1Protocol.Block((byte)((ns << 6) | (more ? 0x20 : 0)), Convert.FromHexString(inf));

    private static byte[] R(int nr, int error = 0) => T1Protocol.Block((byte)(0x80 | (nr << 4) | error), []);

    private static byte[] S(int type, string inf) => T1Protocol.Block((byte)(0xC0 | type), Convert.FromHexString(inf));

    /// <summary>台本どおりに答えるカード。WTX の倍率も (送ったブロック, 倍率) で控える</summary>
    private sealed class Script(params (byte[] Expect, byte[]? Reply)[] steps)
    {
        private readonly Queue<(byte[] Expect, byte[]? Reply)> _steps = new(steps);
        public List<byte> Wtx { get; } = [];
        public bool Done => _steps.Count == 0;

        public byte[]? Exchange(byte[] sent, byte wtx)
        {
            if (!_steps.TryDequeue(out var step)) throw new InvalidOperationException($"台本より多く送りました: {Convert.ToHexString(sent)}");
            if (!sent.AsSpan().SequenceEqual(step.Expect))
            {
                throw new InvalidOperationException($"送ったもの {Convert.ToHexString(sent)} が台本 {Convert.ToHexString(step.Expect)} と違います");
            }
            Wtx.Add(wtx);
            return step.Reply;
        }
    }

    private static Atr WithIfsc(int ifsc) => Atr.Parse(BcasAtr) with { Ifsc = ifsc };

    [Test]
    public async Task B_CAS_の_ATR_を読む()
    {
        var atr = Atr.Parse(BcasAtr);
        await Assert.That(atr.FiDi).IsEqualTo((byte)0x12);
        await Assert.That(atr.GuardN).IsEqualTo((byte)0xFF);
        await Assert.That(atr.Specific).IsTrue();
        await Assert.That(atr.T1).IsTrue();
        // TD3 が T=1 を示したあとの TA4 / TB4
        await Assert.That(atr.Ifsc).IsEqualTo(0x7C);
        await Assert.That(atr.Bwi).IsEqualTo(4);
        await Assert.That(atr.Cwi).IsEqualTo(5);
        await Assert.That(atr.Crc).IsFalse();
        await Assert.That(atr.Inverse).IsFalse();
    }

    [Test]
    public async Task T0_だけのカードと既定値()
    {
        // TA1 も TD1 も無い。歴史バイト 2 つ、TCK は無い
        var atr = Atr.Parse(Convert.FromHexString("3B021450"));
        await Assert.That(atr.T1).IsFalse();
        await Assert.That(atr.FiDi).IsEqualTo((byte)0x11);
        await Assert.That(atr.Ifsc).IsEqualTo(32);
        await Assert.That(atr.Specific).IsFalse();
    }

    [Test]
    public async Task 壊れた_ATR_は投げる()
    {
        var badTck = (byte[])BcasAtr.Clone();
        badTck[^1] ^= 1;
        await Assert.That(Assert.Throws<IOException>(() => Atr.Parse(badTck)).Message).Contains("TCK");
        await Assert.That(Assert.Throws<IOException>(() => Atr.Parse(BcasAtr.AsSpan(0, 8))).Message).Contains("切れて");
        Assert.Throws<IOException>(() => Atr.Parse(Convert.FromHexString("3A00")));
    }

    [Test]
    public async Task 一往復で番号が進む()
    {
        var script = new Script(
            (I(0, false, "90320000"), I(0, false, "019000")),
            (I(1, false, "90340000"), I(1, false, "029000")));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("90320000")))).IsEqualTo("019000");
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("90340000")))).IsEqualTo("029000");
        await Assert.That(script.Done).IsTrue();
    }

    [Test]
    public async Task 送る側の連結()
    {
        // IFSC 4 で 10 バイト → 4 / 4 / 2。カードは R(次の番号) で続きを求める
        var script = new Script(
            (I(0, true, "00010203"), R(1)),
            (I(1, true, "04050607"), R(0)),
            (I(0, false, "0809"), I(0, false, "9000")));
        var t1 = new T1Protocol(WithIfsc(4), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("00010203040506070809")))).IsEqualTo("9000");
        await Assert.That(script.Done).IsTrue();
    }

    [Test]
    public async Task 受ける側の連結()
    {
        var script = new Script(
            (I(0, false, "90340000"), I(0, true, "AABB")),
            (R(1), I(1, true, "CCDD")),
            (R(0), I(0, false, "9000")));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("90340000")))).IsEqualTo("AABBCCDD9000");
        await Assert.That(script.Done).IsTrue();
    }

    [Test]
    public async Task 黙った_化けたときは_R_ブロックで頼み直す()
    {
        var garbled = I(0, false, "9000");
        garbled[^1] ^= 0xFF;
        var script = new Script(
            // カードが黙った (ICC_MUTE) → R(0, その他の誤り)。カードは I を受けていなかったので R(0) で再送を求める
            (I(0, false, "0102"), null),
            (R(0, 2), R(0)),
            (I(0, false, "0102"), garbled),
            // LRC が合わない → R(0, EDC 誤り)。カードは応答を送り直す
            (R(0, 1), I(0, false, "9000")));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("0102")))).IsEqualTo("9000");
        await Assert.That(script.Done).IsTrue();
    }

    [Test]
    public async Task 化け続けたら諦める()
    {
        var script = new Script(
            (I(0, false, "01"), null),
            (R(0, 2), null),
            (R(0, 2), null),
            (R(0, 2), null));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        Assert.Throws<IOException>(() => t1.Transmit([0x01]));
        await Assert.That(script.Done).IsTrue();
    }

    [Test]
    public async Task WTX_に答えて次の待ちを延ばす()
    {
        var script = new Script(
            (I(0, false, "01"), S(0x03, "05")),
            (S(0x23, "05"), I(0, false, "9000")));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit([0x01]))).IsEqualTo("9000");
        // 倍率は WTX の答えを送るときに XfrBlock の bBWI に載せる
        await Assert.That(script.Wtx).IsEquivalentTo([(byte)0, (byte)5]);
    }

    [Test]
    public async Task カードからの_IFS_要求で送る長さが変わる()
    {
        var script = new Script(
            (I(0, true, "0001"), S(0x01, "04")),
            // 答えを返すと、カードは受け取った印に R(1) を返す。続きは新しい IFSC で切る
            (S(0x21, "04"), R(1)),
            (I(1, false, "020304"), I(0, false, "9000")));
        var t1 = new T1Protocol(WithIfsc(2), script.Exchange);
        await Assert.That(Convert.ToHexString(t1.Transmit(Convert.FromHexString("0001020304")))).IsEqualTo("9000");
        await Assert.That(t1.Ifsc).IsEqualTo(4);
    }

    [Test]
    public async Task IFSD_を上げる()
    {
        var script = new Script(
            (S(0x01, "FE"), S(0x21, "FE")),
            // 上げたので 100 バイトの I ブロックも受ける (32 のままなら化けた扱い)
            (I(0, false, "01"), I(0, false, new string('A', 196) + "9000")));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        t1.NegotiateIfsd(254);
        await Assert.That(t1.Ifsd).IsEqualTo(254);
        await Assert.That(t1.Transmit([0x01]).Length).IsEqualTo(100);
    }

    [Test]
    public async Task IFS_に答えないカードは既定のまま()
    {
        var script = new Script(
            (S(0x01, "FE"), null),
            (S(0x01, "FE"), null),
            (S(0x01, "FE"), null),
            (S(0x01, "FE"), null));
        var t1 = new T1Protocol(WithIfsc(0x7C), script.Exchange);
        t1.NegotiateIfsd(254);
        await Assert.That(t1.Ifsd).IsEqualTo(32);
    }

    [Test]
    public async Task CRC_のカードは断る()
    {
        Assert.Throws<IOException>(() => new T1Protocol(Atr.Parse(BcasAtr) with { Crc = true }, (_, _) => null));
        await Assert.That(T1Protocol.Lrc([0x00, 0x40, 0x01, 0x90])).IsEqualTo((byte)0xD1);
    }
}
