using System.Buffers.Binary;

namespace Denpa.Agent.Tests;

/*
 * 組み込みソフト B-CAS (SoftCasCard と C2pc)。
 *
 * ECM の既知応答ベクトルは、元の実装 (SoftCAS の C ソース。softcas-x64 に置いてある) を
 * そのまま走らせて作った。移植した暗号の出力が一バイトでも違えば落ちる。
 * テストの ECM に入っている鍵は決めた値 (0011223344556677 / 8899aabbccddeeff)。
 */
public class SoftCasTests
{
    /// <summary>テストの ECM に埋めた鍵 (奇数・偶数を並べたもの)</summary>
    private const string Decoded = "00112233445566778899aabbccddeeff";

    private static byte[] Transmit(byte instruction, ReadOnlySpan<byte> payload = default)
    {
        var apdu = new byte[payload.Length + 5];
        apdu[1] = instruction;
        apdu[4] = (byte)payload.Length;
        payload.CopyTo(apdu.AsSpan(5));
        return new SoftCasCard("test").Transmit(apdu);
    }

    private static int Code(byte[] response) => BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(4));

    /// <summary><see cref="Convert.ToHexString"/> は大文字で返すので、小さい文字の定数と比べるために落とす</summary>
    private static string Hex(ReadOnlySpan<byte> bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    [Test]
    [Arguments("000102e8cf9ee2badab13687dfbf90266626b963ff68faf814f26983749b")] // NHK 01/02 (階層 0x00)
    [Arguments("00020c64a9183319895034991c8d85188507be761c9a89166bf43146ab81")] // WOWOW 02/0c (運用中の鍵)
    [Arguments("00170b8c347bc64fdfa2448d9c9bf30ef6f6c2c7aa117df3839c9abb77c2")] // スカパー！ 17/0b (BS10 プレミアムもここ)
    [Arguments("400101d29f743f4652cf4716df4b92f08bb25df81a5a9d3031ae7e037844")] // NHK 01/01 (階層 0x40 の 512bit 鍵スケジュール)
    [Arguments("40020da103e7517c8011a5fba71aadd0f9bb2753cdc3f963b51bf5c0f79c")] // WOWOW 02/0d (次期運用予定)
    public async Task ECMは元の実装と同じ鍵に復号される(string ecm)
    {
        var response = Transmit(0x34, Convert.FromHexString(ecm));
        await Assert.That(Code(response)).IsEqualTo(0x0200);
        await Assert.That(Hex(response[6..22])).IsEqualTo(Decoded);
    }

    [Test]
    public async Task MACが壊れているECMは鍵を返さずに断る()
    {
        // 上の NHK のベクトルの末尾を書き換えたもの (MAC が合わない)
        var response = Transmit(0x34, Convert.FromHexString("000102e8cf9ee2badab13687dfbf90266626b963ff68faf814f2698374c1"));
        await Assert.That(Code(response)).IsEqualTo(0x0401);
        await Assert.That(Hex(response[6..22])).IsEqualTo(new string('0', 32));
    }

    [Test]
    public async Task 知らない事業体は断る()
    {
        var response = Transmit(0x34, Convert.FromHexString("000402" + new string('0', 54)));
        await Assert.That(Code(response)).IsEqualTo(0x0401);
    }

    [Test]
    public async Task INTとIDIはカードの定数として読める()
    {
        var init = BCas.Read(new SoftCasCard("test"));
        await Assert.That(init.CaSystemId).IsEqualTo(0x0005);
        await Assert.That(Hex(init.SystemKey))
            .IsEqualTo("363104664b17ea5c32df9cf5c4c36c1bec993921689d4bb7b74e40840d2e7d98");
        await Assert.That(Hex(init.InitCbc)).IsEqualTo("fe27199919690911");
        await Assert.That(init.Ids).IsEquivalentTo([0x0006FCA80876L]);
    }

    [Test]
    public async Task EMMは受け入れ契約確認は有効で返す()
    {
        await Assert.That(Code(Transmit(0x36))).IsEqualTo(0x2100);
        await Assert.That(Code(Transmit(0x3C))).IsEqualTo(0x0800);
    }

    [Test]
    public async Task 知らないコマンドは2012年版と同じa1feで返す()
    {
        await Assert.That(Code(Transmit(0x38))).IsEqualTo(0xA1FE);
    }

    [Test]
    public async Task CARD_SOFTを書いていない間は候補に入らない()
    {
        try
        {
            Environment.SetEnvironmentVariable("CARD_SOFT", null);
            await Assert.That(SoftCas.Enabled).IsFalse();
            await Assert.That(SoftCas.Cards()).Count().IsEqualTo(0);

            Environment.SetEnvironmentVariable("CARD_SOFT", "1");
            await Assert.That(SoftCas.Enabled).IsTrue();
            var cards = SoftCas.Cards();
            await Assert.That(cards).Count().IsEqualTo(1);
            await Assert.That(cards[0].Name).IsEqualTo(SoftCas.LinkName);
        }
        finally
        {
            Environment.SetEnvironmentVariable("CARD_SOFT", null);
        }
    }
}
