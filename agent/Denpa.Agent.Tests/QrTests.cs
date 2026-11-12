namespace Denpa.Agent.Tests;

/*
 * 登録用の URL の QR (`--pair` が端末に描く)。期待値は python-qrcode (マスクを 3 に決め、誤り訂正のレベル M・8 ビットバイトのモード) が
 * 同じ文字列から作った模様で、zbarimg で読めることも確かめてある。Android のアプリ (android/app/src/test/…/QrTest.kt) も同じ期待値を見る
 */
public class QrTests
{
    private const string Url = "https://tuner.local:25252#pair=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    /// <summary>バージョン 5 (37 × 37)。1 行が 1 行の模様で、1 が暗いモジュール</summary>
    private static readonly string[] Expected =
    [
        "1111111011000001000001000101101111111",
        "1000001010110001010001011100101000001",
        "1011101000100001001100100110101011101",
        "1011101011101010100000000111001011101",
        "1011101001000101100000000011101011101",
        "1000001001111010111110101100101000001",
        "1111111010101010101010101010101111111",
        "0000000010001000000010111000100000000",
        "1011011100010011001100000111101001011",
        "1000000010101101001011000001101101010",
        "0001101110010010110111011110100111000",
        "1000100110001000101010000110100101100",
        "1001101111011011000100100111011111011",
        "1101100100000110110000100011101111010",
        "0011011001100000000110100100100010110",
        "0110010001010011000001111010111110011",
        "1101111111001000010010110001000011110",
        "0111100000100010001100101100000000111",
        "1100101010001010001011000001111100011",
        "0101010100001101111010010000000011010",
        "1010101101001111101101001010110110101",
        "0000010100000011111011011000000001001",
        "1010001100110110101000011010010100000",
        "1010000001111010110110001111110011110",
        "1011111101001111100101101011011000101",
        "0111010000101100010000011110110110011",
        "0100001101101110000110101110011001110",
        "1011110110101111000001101001000000000",
        "0001101011010110011001111110111110011",
        "0000000010111000000000110111100010100",
        "1111111011110011101001001000101010111",
        "1000001010110010011110100001100010000",
        "1011101000000110100100000110111111000",
        "1011101010111111100010000100011011001",
        "1011101010101101010000011111011011000",
        "1000001001101011001100000100100111100",
        "1111111011001000000010100100011011011",
    ];

    private static string[] Rows(bool[,] modules)
    {
        var size = modules.GetLength(0);
        return [.. Enumerable.Range(0, size).Select(row => string.Concat(Enumerable.Range(0, size).Select(column => modules[row, column] ? '1' : '0')))];
    }

    [Test]
    public async Task 決めたマスクで_ほかの実装と同じ模様になる()
    {
        await Assert.That(string.Join('\n', Rows(Qr.Encode(Url, mask: 3)))).IsEqualTo(string.Join('\n', Expected));
    }

    [Test]
    public async Task マスクを選んでも_機能パターンは同じ所にある()
    {
        var modules = Qr.Encode(Url);
        var rows = Rows(modules);
        await Assert.That(rows.Length).IsEqualTo(37);
        // 位置検出パターン (左上・右上・左下の 7 × 7) とタイミングパターン (6 行目) は、マスクに関わらず同じ
        for (var row = 0; row < 7; row++)
        {
            await Assert.That(rows[row][..7]).IsEqualTo(Expected[row][..7]);
            await Assert.That(rows[row][30..]).IsEqualTo(Expected[row][30..]);
            await Assert.That(rows[30 + row][..7]).IsEqualTo(Expected[30 + row][..7]);
        }
        await Assert.That(rows[6]).IsEqualTo(Expected[6]);
    }

    [Test]
    public async Task 長さに合わせてバージョンを上げ_213_バイトを超えたら断る()
    {
        await Assert.That(Qr.Encode("x").GetLength(0)).IsEqualTo(21);
        // バージョン 9 (53) までは文字数が 8 ビット、10 (57) からは 16 ビット
        await Assert.That(Qr.Encode(new string('x', 180)).GetLength(0)).IsEqualTo(53);
        await Assert.That(Qr.Encode(new string('x', 181)).GetLength(0)).IsEqualTo(57);
        await Assert.That(Qr.Encode(new string('x', 213)).GetLength(0)).IsEqualTo(57);
        await Assert.That(() => Qr.Encode(new string('x', 214))).Throws<ArgumentException>();
    }

    [Test]
    public async Task 端末には上下_2_つずつを_1_字で描き_色を行ごとに戻す()
    {
        var text = Qr.Terminal(Qr.Encode(Url, mask: 3));
        var lines = text.TrimEnd('\n').Split('\n');
        // 37 + 余白 4 × 2 = 45 行の模様を 2 行ずつ
        await Assert.That(lines.Length).IsEqualTo(23);
        foreach (var line in lines)
        {
            await Assert.That(line).StartsWith("\e[40;97m");
            await Assert.That(line).EndsWith("\e[0m");
            await Assert.That(line.Length).IsEqualTo("\e[40;97m".Length + 45 + "\e[0m".Length);
        }
        // 余白は明るい (白の全角ではなく、上下とも明るいブロック)。5 行目 (模様の 0・1 行目) の左端の 4 字も余白
        await Assert.That(lines[0][8..53]).IsEqualTo(new string('█', 45));
        await Assert.That(lines[2][8..12]).IsEqualTo("████");
    }
}
