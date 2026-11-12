using System.Text;

namespace Denpa.Agent;

/// <summary>
/// 登録用の URL の QR コード (<c>--pair</c> が端末に描く。docs/agent.md「denpa と組む」)。
///
/// <para>
/// **ライブラリを増やさないため、JIS X 0510 (ISO/IEC 18004) を読んで自前で書いた。** 扱うのは 8 ビットバイトのモードと、
/// 誤り訂正のレベル M と、バージョン 1〜10 (213 バイトまで) だけ。URL は長くても 100 字ほどなので足りる。
/// Android のアプリにも同じ作りのもの (android/app/src/main/…/Qr.kt) があり、同じ文字列から同じ模様を作る (テストが同じ期待値を見る)。
/// </para>
/// </summary>
public static partial class Qr
{
    /// <summary>
    /// レベル M のバージョンごとの組み方。誤り訂正のコード語の数 (1 ブロックあたり) と、ブロックごとのデータのコード語の数。
    /// 後ろのブロックほど 1 つ多いことがある (JIS X 0510 の表 9)
    /// </summary>
    private static readonly (int Ec, int[] Blocks)[] Levels =
    [
        (10, [16]),
        (16, [28]),
        (26, [44]),
        (18, [32, 32]),
        (24, [43, 43]),
        (16, [27, 27, 27, 27]),
        (18, [31, 31, 31, 31]),
        (22, [38, 38, 39, 39]),
        (22, [36, 36, 36, 37, 37]),
        (26, [43, 43, 43, 43, 44]),
    ];

    /// <summary>位置合わせのパターンの中心 (行と列の両方に使う。バージョン 2 から)</summary>
    private static readonly int[][] Alignments =
    [
        [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    ];

    /// <summary>
    /// 文字列 (UTF-8) を QR にする。返すのは <c>[行, 列]</c> で、true が暗いモジュール。周りの余白 (クワイエットゾーン) は含めない。
    /// <paramref name="mask"/> を渡さなければ、決まりの失点がいちばん少ないマスクを選ぶ (テストは決めて比べる)
    /// </summary>
    public static bool[,] Encode(string text, int? mask = null)
    {
        var data = Encoding.UTF8.GetBytes(text);
        for (var version = 1; version <= Levels.Length; version++)
        {
            var capacity = Levels[version - 1].Blocks.Sum();
            // モード (4 ビット) と文字数 (バージョン 1〜9 は 8 ビット、10 からは 16 ビット)
            var header = 4 + (version < 10 ? 8 : 16);
            if (header + data.Length * 8 <= capacity * 8) return Build(version, Codewords(version, data), mask);
        }
        throw new ArgumentException($"QR に入れられるのは {Levels[^1].Blocks.Sum() - 3} バイトまでです (いまは {data.Length} バイト)", nameof(text));
    }

    /// <summary>
    /// 端末に描く文字列。1 文字で上下 2 つのモジュールを描く (上半分・下半分のブロックの字)。
    /// 端末の背景が暗くても明るくても読めるよう、色を黒地に白と決めて描き、行の終わりで元に戻す
    /// </summary>
    public static string Terminal(bool[,] modules, int quiet = 4)
    {
        var size = modules.GetLength(0);
        // 余白の中は明るい。範囲の外を明るいとして読む
        bool Light(int row, int column) =>
            row < 0 || column < 0 || row >= size || column >= size || !modules[row, column];
        var text = new StringBuilder();
        for (var row = -quiet; row < size + quiet; row += 2)
        {
            text.Append("\e[40;97m");
            for (var column = -quiet; column < size + quiet; column++)
            {
                var top = Light(row, column);
                var bottom = row + 1 < size + quiet && Light(row + 1, column);
                text.Append((top, bottom) switch
                {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    _ => ' ',
                });
            }
            text.Append("\e[0m\n");
        }
        return text.ToString();
    }

    /// <summary>
    /// Windows のコンソールで色の指定 (<see cref="Terminal"/> の ESC [) を効かせる。ほかの OS では何もしない。
    /// 標準出力がコンソールでなければ何もしない
    /// </summary>
    public static void EnableTerminalColors()
    {
        if (!OperatingSystem.IsWindows()) return;
        var handle = GetStdHandle(-11 /* STD_OUTPUT_HANDLE */);
        if (GetConsoleMode(handle, out var mode) != 0) SetConsoleMode(handle, mode | 0x4 /* ENABLE_VIRTUAL_TERMINAL_PROCESSING */);
    }

    [System.Runtime.InteropServices.LibraryImport("kernel32.dll")]
    private static partial nint GetStdHandle(int handle);

    [System.Runtime.InteropServices.LibraryImport("kernel32.dll")]
    private static partial int GetConsoleMode(nint handle, out uint mode);

    [System.Runtime.InteropServices.LibraryImport("kernel32.dll")]
    private static partial int SetConsoleMode(nint handle, uint mode);

    // --- データのコード語 ----------------------------------------------------------

    /// <summary>データを詰めて誤り訂正を足し、ブロックをまたいで交互に並べたコード語</summary>
    private static byte[] Codewords(int version, byte[] data)
    {
        var (ec, blocks) = Levels[version - 1];
        var capacity = blocks.Sum();
        var bits = new BitList();
        bits.Add(0b0100, 4);
        bits.Add(data.Length, version < 10 ? 8 : 16);
        foreach (var b in data) bits.Add(b, 8);
        // 終端は 0 を 4 ビットまで。そのあとバイトの境目まで 0 で埋め、残りは 0xEC と 0x11 を交互に
        bits.Add(0, Math.Min(4, capacity * 8 - bits.Count));
        bits.Add(0, (8 - bits.Count % 8) % 8);
        for (var pad = 0xEC; bits.Count < capacity * 8; pad ^= 0xEC ^ 0x11) bits.Add(pad, 8);
        var all = bits.ToBytes();

        var dataBlocks = new List<byte[]>();
        var ecBlocks = new List<byte[]>();
        var offset = 0;
        foreach (var length in blocks)
        {
            var block = all.AsSpan(offset, length).ToArray();
            offset += length;
            dataBlocks.Add(block);
            ecBlocks.Add(ReedSolomon(block, ec));
        }
        var result = new List<byte>(capacity + ec * blocks.Length);
        for (var i = 0; i < blocks.Max(); i++)
        {
            foreach (var block in dataBlocks)
            {
                if (i < block.Length) result.Add(block[i]);
            }
        }
        for (var i = 0; i < ec; i++)
        {
            foreach (var block in ecBlocks) result.Add(block[i]);
        }
        return [.. result];
    }

    /// <summary>GF(256) (原始多項式 x^8+x^4+x^3+x^2+1) のリード・ソロモン符号の、誤り訂正のコード語</summary>
    private static byte[] ReedSolomon(byte[] data, int count)
    {
        // 生成多項式 (x - α^0)(x - α^1)…(x - α^(count-1)) の係数。最高次の 1 は持たない
        var generator = new byte[count];
        generator[count - 1] = 1;
        byte root = 1;
        for (var i = 0; i < count; i++)
        {
            for (var j = 0; j < count; j++)
            {
                generator[j] = Multiply(generator[j], root);
                if (j + 1 < count) generator[j] ^= generator[j + 1];
            }
            root = Multiply(root, 2);
        }
        var remainder = new byte[count];
        foreach (var b in data)
        {
            var factor = (byte)(b ^ remainder[0]);
            Array.Copy(remainder, 1, remainder, 0, count - 1);
            remainder[count - 1] = 0;
            for (var j = 0; j < count; j++) remainder[j] ^= Multiply(generator[j], factor);
        }
        return remainder;
    }

    private static byte Multiply(byte x, byte y)
    {
        var product = 0;
        for (var i = 7; i >= 0; i--)
        {
            product = (product << 1) ^ ((product >> 7) * 0x11D);
            product ^= ((y >> i) & 1) * x;
        }
        return (byte)product;
    }

    // --- 模様 ----------------------------------------------------------------

    private static bool[,] Build(int version, byte[] codewords, int? mask)
    {
        var size = version * 4 + 17;
        var modules = new bool[size, size];
        // 機能パターン (データを置かない所)
        var fixedAt = new bool[size, size];
        void Set(int row, int column, bool dark)
        {
            modules[row, column] = dark;
            fixedAt[row, column] = true;
        }

        // タイミングパターン
        for (var i = 0; i < size; i++)
        {
            Set(6, i, i % 2 == 0);
            Set(i, 6, i % 2 == 0);
        }
        // 位置検出パターンと、その周りの明るい区切り
        foreach (var (top, left) in new[] { (0, 0), (0, size - 7), (size - 7, 0) })
        {
            for (var dy = -1; dy <= 7; dy++)
            {
                for (var dx = -1; dx <= 7; dx++)
                {
                    int row = top + dy, column = left + dx;
                    if (row < 0 || column < 0 || row >= size || column >= size) continue;
                    var ring = Math.Max(Math.Abs(dy - 3), Math.Abs(dx - 3));
                    Set(row, column, ring is not (2 or 4));
                }
            }
        }
        // 位置合わせパターン (位置検出パターンと重なる 3 隅には置かない)
        var centers = Alignments[version - 1];
        var last = centers.Length - 1;
        for (var a = 0; a <= last; a++)
        {
            for (var b = 0; b <= last; b++)
            {
                if ((a, b) == (0, 0) || (a, b) == (0, last) || (a, b) == (last, 0)) continue;
                int row = centers[a], column = centers[b];
                for (var dy = -2; dy <= 2; dy++)
                {
                    for (var dx = -2; dx <= 2; dx++) Set(row + dy, column + dx, Math.Max(Math.Abs(dy), Math.Abs(dx)) != 1);
                }
            }
        }
        // 形式情報の場所を先に取っておく (中身はマスクを決めてから書く)。左下の 1 つは常に暗い
        WriteFormat(modules, fixedAt, 0);
        // 型番情報 (バージョン 7 から)
        if (version >= 7)
        {
            var bits = version << 12 | Bch(version, 0x1F25, 12);
            for (var i = 0; i < 18; i++)
            {
                var dark = (bits >> i & 1) == 1;
                int a = size - 11 + i % 3, b = i / 3;
                Set(b, a, dark);
                Set(a, b, dark);
            }
        }

        // データを右下から 2 列ずつ、上下に折り返して置く (6 列目のタイミングパターンは飛ばす)
        var index = 0;
        for (var right = size - 1; right >= 1; right -= 2)
        {
            if (right == 6) right = 5;
            var upward = (right + 1 & 2) == 0;
            for (var step = 0; step < size; step++)
            {
                var row = upward ? size - 1 - step : step;
                for (var j = 0; j < 2; j++)
                {
                    var column = right - j;
                    if (fixedAt[row, column]) continue;
                    if (index < codewords.Length * 8)
                    {
                        modules[row, column] = (codewords[index >> 3] >> (7 - (index & 7)) & 1) == 1;
                    }
                    index++;
                }
            }
        }

        var chosen = mask ?? Enumerable.Range(0, 8).MinBy(m =>
        {
            var trial = (bool[,])modules.Clone();
            ApplyMask(trial, fixedAt, m);
            WriteFormat(trial, fixedAt, m);
            return Penalty(trial);
        });
        ApplyMask(modules, fixedAt, chosen);
        WriteFormat(modules, fixedAt, chosen);
        return modules;
    }

    /// <summary>
    /// 形式情報 (誤り訂正のレベルとマスク) を 2 か所に書く。レベル M は 00。
    /// BCH(15,5) を付けて 101010000010010 と XOR する
    /// </summary>
    private static void WriteFormat(bool[,] modules, bool[,] fixedAt, int mask)
    {
        var size = modules.GetLength(0);
        var bits = (mask << 10 | Bch(mask, 0x537, 10)) ^ 0x5412;
        void Set(int row, int column, int i)
        {
            modules[row, column] = (bits >> i & 1) == 1;
            fixedAt[row, column] = true;
        }

        // 左上の位置検出パターンの周り
        for (var i = 0; i <= 5; i++) Set(i, 8, i);
        Set(7, 8, 6);
        Set(8, 8, 7);
        Set(8, 7, 8);
        for (var i = 9; i < 15; i++) Set(8, 14 - i, i);
        // 右上と左下
        for (var i = 0; i < 8; i++) Set(8, size - 1 - i, i);
        for (var i = 8; i < 15; i++) Set(size - 15 + i, 8, i);
        modules[size - 8, 8] = true;
        fixedAt[size - 8, 8] = true;
    }

    /// <summary><paramref name="value"/> を <paramref name="length"/> ビットずらし、<paramref name="generator"/> で割った余り</summary>
    private static int Bch(int value, int generator, int length)
    {
        var remainder = value << length;
        var top = 31 - int.LeadingZeroCount(generator);
        for (var bit = 31 - int.LeadingZeroCount(remainder); bit >= top; bit--)
        {
            if ((remainder >> bit & 1) == 1) remainder ^= generator << (bit - top);
        }
        return remainder;
    }

    private static void ApplyMask(bool[,] modules, bool[,] fixedAt, int mask)
    {
        var size = modules.GetLength(0);
        for (var row = 0; row < size; row++)
        {
            for (var column = 0; column < size; column++)
            {
                if (fixedAt[row, column]) continue;
                var flip = mask switch
                {
                    0 => (row + column) % 2 == 0,
                    1 => row % 2 == 0,
                    2 => column % 3 == 0,
                    3 => (row + column) % 3 == 0,
                    4 => (row / 2 + column / 3) % 2 == 0,
                    5 => row * column % 2 + row * column % 3 == 0,
                    6 => (row * column % 2 + row * column % 3) % 2 == 0,
                    _ => ((row + column) % 2 + row * column % 3) % 2 == 0,
                };
                if (flip) modules[row, column] = !modules[row, column];
            }
        }
    }

    /// <summary>マスクを選ぶための失点 (JIS X 0510 の 4 つの決まり。似た模様と、明暗の偏り)</summary>
    private static int Penalty(bool[,] modules)
    {
        var size = modules.GetLength(0);
        var score = 0;
        var dark = 0;
        for (var a = 0; a < size; a++)
        {
            // 行 (横) と列 (縦) で同じ色の続き
            for (var vertical = 0; vertical < 2; vertical++)
            {
                bool At(int i) => vertical == 0 ? modules[a, i] : modules[i, a];
                var run = 1;
                for (var i = 1; i <= size; i++)
                {
                    if (i < size && At(i) == At(i - 1))
                    {
                        run++;
                        continue;
                    }
                    if (run >= 5) score += run - 2;
                    run = 1;
                }
                // 位置検出パターンに似た 1:1:3:1:1 の並びの片側に、明るい 4 つ
                for (var i = 0; i + 11 <= size; i++)
                {
                    var core = At(i + 0) && !At(i + 1) && At(i + 2) && At(i + 3) && At(i + 4) && !At(i + 5) && At(i + 6);
                    var light = !At(i + 7) && !At(i + 8) && !At(i + 9) && !At(i + 10);
                    var coreLater = At(i + 4) && !At(i + 5) && At(i + 6) && At(i + 7) && At(i + 8) && !At(i + 9) && At(i + 10);
                    var lightBefore = !At(i + 0) && !At(i + 1) && !At(i + 2) && !At(i + 3);
                    if (core && light) score += 40;
                    if (coreLater && lightBefore) score += 40;
                }
            }
            for (var b = 0; b < size; b++)
            {
                if (modules[a, b]) dark++;
                if (a + 1 < size && b + 1 < size)
                {
                    var c = modules[a, b];
                    if (modules[a, b + 1] == c && modules[a + 1, b] == c && modules[a + 1, b + 1] == c) score += 3;
                }
            }
        }
        // 暗い割合が 50% から 5% ずれるごとに 10
        var percent = dark * 100 / (size * size);
        score += Math.Abs(percent - 50) / 5 * 10;
        return score;
    }

    /// <summary>ビットを上の桁から足していく入れ物</summary>
    private sealed class BitList
    {
        private readonly List<bool> bits = [];

        public int Count => bits.Count;

        public void Add(int value, int length)
        {
            for (var i = length - 1; i >= 0; i--) bits.Add((value >> i & 1) == 1);
        }

        public byte[] ToBytes()
        {
            var bytes = new byte[bits.Count / 8];
            for (var i = 0; i < bits.Count; i++)
            {
                if (bits[i]) bytes[i >> 3] |= (byte)(0x80 >> (i & 7));
            }
            return bytes;
        }
    }
}
