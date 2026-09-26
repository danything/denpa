using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * MULTI2 の答え合わせ。
 *
 * 答えは libaribb25 に同じ鍵と中身を渡して取った値。**今まで録れていたものが
 * 同じように解けること**が肝心なので、仕様書から起こした値ではなくこちらと比べる。
 * 鍵と中身はでたらめ (固定の種の LCG) で、意味は無い。
 */
public class Multi2Tests
{
    private const string System = "dc0465aa1fad1d5adae5ac1b1e5f1370796cfd10ff19af601d04acb41d022b46";
    private const string Cbc = "78733af2df5faeb7";
    private const string Odd = "0859d1ee3910cb48";
    private const string Even = "95b5cc892911ff06";

    private const string Data =
        "b6622edf3cf935fd4b9428ca097c44b3025e965fb3ea6dacd42d816e69afe0e6874c9c04e7d2365d2c60c9eaf479f686" +
        "a0eb9326e46212d50dcbb377156a6a3a68ba8edb7408469ef3ceb30af8d0dd68bbf85ffa24f2d2fc1887fb5c87bab438" +
        "32a59b1b3d107cf778d67fe26df81191297e9395cb12c557ce5af1d41618d719bc045b7e9965f1a29471c42aac6aa938" +
        "c475c7ad3238021f053b2c991afceb15decf68bae07cbcd61e971b9a0b9dbe9763d392fcafdfa28c";

    /// <summary>偶数の鍵で 184 バイト (1 パケットの中身まるごと) を解いた答え</summary>
    private const string EvenDecrypted =
        "3fd15add3457b22305c9060ec8e1f4074e84cf3bc847432d9c3eed2c6c615fb3232f2de1578a9ef3783d91290d8daff3" +
        "a94ece918be027661804d9a3ec3d39d6716ae39fac832025fa125aa34276b9a778d2e0e185d5e888b19c29e7bca3dc86" +
        "8cf604b60797187cc5fc2dfdc582039eab541510691e932acccefe87add8c4de9a47f0fb07335a206db30f24b1b40b43" +
        "3e7cff77af8f84b67b25e8769b6923c0bb85bb1356417c27c24ad07d45b65e55fa29d50d2390cfd1";

    private const string OddDecrypted =
        "5b45426a46c6080411612d366f2a1904a910b430bf02cf743e61cacb715dc00471b578a1b0e1862674dcaf67c5b3996f" +
        "4c39e5735e3fc83677168ef7a31ef9c6e3686a526472b53a8d72f6a11283a68a6ebf843f3c090dc1343af2924f888613" +
        "cb073b596263b1a9527d5304b48126791d5a209b1562a41a9d78a7f8642c52a3a33b6bd0c35a08a40a2a9e2afa57dab6" +
        "d4697376922eb771fb476aa830057353265277facb2bccea3b131cccdd0a04cdcfec7f383ee6a429";

    private const string EvenEncrypted =
        "a5917922e26fe7a8d1f116c2cc58eb1d5c8b5ff8b94691ea54843b00c66d8118ad98df290977b5d075b282cb8f7033fe" +
        "0416235aea0f143a2f48a04cb5ed3853c9ae82c839f452d70eaf02f37767773ec03f6a6d9a89085d8c20b80d4d08ae5d" +
        "06ff813256feedb79e5ec2a9008b8ef101e0d9025f5526660f338de6e75a7c209f13310160bb04ad27d1347e363a8907" +
        "d9b78a13df5b27a82b3f0d75802c2464dbc64ad477fc8766c7e891b55d900a57fdb2f9489fdc8c99";

    private static Multi2 Cipher()
    {
        var cipher = new Multi2(Convert.FromHexString(System), Convert.FromHexString(Cbc));
        cipher.SetKeys(Convert.FromHexString(Odd), Convert.FromHexString(Even));
        return cipher;
    }

    private static string Decrypt(bool even, int length)
    {
        var data = Convert.FromHexString(Data)[..length];
        Cipher().Decrypt(even, data);
        return Convert.ToHexString(data).ToLowerInvariant();
    }

    [Test]
    public async Task 偶数の鍵で1パケットぶん解ける() =>
        await Assert.That(Decrypt(even: true, 184)).IsEqualTo(EvenDecrypted);

    [Test]
    public async Task 奇数の鍵で1パケットぶん解ける() =>
        await Assert.That(Decrypt(even: false, 184)).IsEqualTo(OddDecrypted);

    /// <summary>
    /// 8 バイトに満たない尻尾は OFB。**尻尾の前までは CBC の答えと同じ**で、
    /// 尻尾だけが違う値になる
    /// </summary>
    [Test]
    public async Task 半端な尻尾はOFBで解く()
    {
        await Assert.That(Decrypt(even: true, 183)).IsEqualTo(EvenDecrypted[..352] + "0d1edd8466823f");
        await Assert.That(Decrypt(even: false, 183)).IsEqualTo(OddDecrypted[..352] + "3f9f4389a742a6");
    }

    /// <summary>丸ごとのブロックが1つも無いと、CBC の初期値を暗号化して XOR するだけ</summary>
    [Test]
    public async Task 短い中身も解ける()
    {
        await Assert.That(Decrypt(even: true, 8)).IsEqualTo(EvenDecrypted[..16]);
        await Assert.That(Decrypt(even: true, 5)).IsEqualTo("0e577d185d");
        await Assert.That(Decrypt(even: false, 5)).IsEqualTo("0c10a3f70e");
    }

    [Test]
    public async Task 掛ける向きも同じ答えになる()
    {
        var data = Convert.FromHexString(Data);
        Cipher().Encrypt(even: true, data);
        await Assert.That(Convert.ToHexString(data).ToLowerInvariant()).IsEqualTo(EvenEncrypted);

        var tail = Convert.FromHexString(Data)[..183];
        Cipher().Encrypt(even: true, tail);
        await Assert.That(Convert.ToHexString(tail).ToLowerInvariant())
            .IsEqualTo(EvenEncrypted[..352] + "5e7511322ca057");
    }

    /// <summary>SIMD で並べる道と1つずつの道の境目 (長さ) を跨いでも、掛けて解けば戻る</summary>
    [Test]
    public async Task どの長さでも掛けて解けば戻る()
    {
        var cipher = Cipher();
        var random = new Random(7);
        for (var length = 1; length <= 600; length++)
        {
            var plain = new byte[length];
            random.NextBytes(plain);
            var data = plain.ToArray();
            cipher.Encrypt(even: length % 2 == 0, data);
            cipher.Decrypt(even: length % 2 == 0, data);
            if (!data.AsSpan().SequenceEqual(plain))
            {
                await Assert.That(length).IsEqualTo(-1);
            }
        }
    }

    [Test]
    public async Task 鍵を捨てたら入っていないことになる()
    {
        var cipher = Cipher();
        await Assert.That(cipher.HasKeys).IsTrue();
        cipher.Clear();
        await Assert.That(cipher.HasKeys).IsFalse();
    }
}
