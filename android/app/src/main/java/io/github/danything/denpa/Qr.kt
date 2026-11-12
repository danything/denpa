package io.github.danything.denpa

/**
 * 登録用の URL の QR コード (通知の「QR を表示」。docs/install-android.md)。
 *
 * **ライブラリを増やさないため、JIS X 0510 (ISO/IEC 18004) を読んで自前で書いた。** 扱うのは 8 ビットバイトのモードと、
 * 誤り訂正のレベル M と、バージョン 1〜10 (213 バイトまで) だけ。エージェントの `--pair` (agent/Denpa.Agent/Qr.cs) と同じ作りで、
 * 同じ文字列から同じ模様を作る (テストが同じ期待値を見る)。Android の API には触らないので、端末なしでテストできる
 */
internal object Qr {
    /** レベル M のバージョンごとの組み方。誤り訂正のコード語の数 (1 ブロックあたり) と、ブロックごとのデータのコード語の数 */
    private class Level(val ec: Int, val blocks: IntArray)

    private val levels = arrayOf(
        Level(10, intArrayOf(16)),
        Level(16, intArrayOf(28)),
        Level(26, intArrayOf(44)),
        Level(18, intArrayOf(32, 32)),
        Level(24, intArrayOf(43, 43)),
        Level(16, intArrayOf(27, 27, 27, 27)),
        Level(18, intArrayOf(31, 31, 31, 31)),
        Level(22, intArrayOf(38, 38, 39, 39)),
        Level(22, intArrayOf(36, 36, 36, 37, 37)),
        Level(26, intArrayOf(43, 43, 43, 43, 44)),
    )

    /** 位置合わせのパターンの中心 (行と列の両方に使う。バージョン 2 から) */
    private val alignments = arrayOf(
        intArrayOf(), intArrayOf(6, 18), intArrayOf(6, 22), intArrayOf(6, 26), intArrayOf(6, 30), intArrayOf(6, 34),
        intArrayOf(6, 22, 38), intArrayOf(6, 24, 42), intArrayOf(6, 26, 46), intArrayOf(6, 28, 50),
    )

    /**
     * 文字列 (UTF-8) を QR にする。返すのは `[行][列]` で、true が暗いモジュール。周りの余白 (クワイエットゾーン) は含めない。
     * [mask] を渡さなければ、決まりの失点がいちばん少ないマスクを選ぶ (テストは決めて比べる)
     */
    fun encode(text: String, mask: Int? = null): Array<BooleanArray> {
        val data = text.toByteArray(Charsets.UTF_8)
        for (version in 1..levels.size) {
            val capacity = levels[version - 1].blocks.sum()
            // モード (4 ビット) と文字数 (バージョン 1〜9 は 8 ビット、10 からは 16 ビット)
            val header = 4 + if (version < 10) 8 else 16
            if (header + data.size * 8 <= capacity * 8) return build(version, codewords(version, data), mask)
        }
        throw IllegalArgumentException("QR に入れられるのは ${levels.last().blocks.sum() - 3} バイトまでです (いまは ${data.size} バイト)")
    }

    // --- データのコード語 ----------------------------------------------------------

    /** データを詰めて誤り訂正を足し、ブロックをまたいで交互に並べたコード語 */
    private fun codewords(version: Int, data: ByteArray): IntArray {
        val level = levels[version - 1]
        val capacity = level.blocks.sum()
        val bits = BitList()
        bits.add(0b0100, 4)
        bits.add(data.size, if (version < 10) 8 else 16)
        for (b in data) bits.add(b.toInt() and 0xff, 8)
        // 終端は 0 を 4 ビットまで。そのあとバイトの境目まで 0 で埋め、残りは 0xEC と 0x11 を交互に
        bits.add(0, minOf(4, capacity * 8 - bits.size))
        bits.add(0, (8 - bits.size % 8) % 8)
        var pad = 0xEC
        while (bits.size < capacity * 8) {
            bits.add(pad, 8)
            pad = pad xor (0xEC xor 0x11)
        }
        val all = bits.toBytes()

        val dataBlocks = ArrayList<IntArray>()
        val ecBlocks = ArrayList<IntArray>()
        var offset = 0
        for (length in level.blocks) {
            val block = all.copyOfRange(offset, offset + length)
            offset += length
            dataBlocks.add(block)
            ecBlocks.add(reedSolomon(block, level.ec))
        }
        val result = ArrayList<Int>(capacity + level.ec * level.blocks.size)
        for (i in 0 until level.blocks.max()) {
            for (block in dataBlocks) if (i < block.size) result.add(block[i])
        }
        for (i in 0 until level.ec) {
            for (block in ecBlocks) result.add(block[i])
        }
        return result.toIntArray()
    }

    /** GF(256) (原始多項式 x^8+x^4+x^3+x^2+1) のリード・ソロモン符号の、誤り訂正のコード語 */
    private fun reedSolomon(data: IntArray, count: Int): IntArray {
        // 生成多項式 (x - α^0)(x - α^1)…(x - α^(count-1)) の係数。最高次の 1 は持たない
        val generator = IntArray(count)
        generator[count - 1] = 1
        var root = 1
        for (i in 0 until count) {
            for (j in 0 until count) {
                generator[j] = multiply(generator[j], root)
                if (j + 1 < count) generator[j] = generator[j] xor generator[j + 1]
            }
            root = multiply(root, 2)
        }
        val remainder = IntArray(count)
        for (b in data) {
            val factor = b xor remainder[0]
            System.arraycopy(remainder, 1, remainder, 0, count - 1)
            remainder[count - 1] = 0
            for (j in 0 until count) remainder[j] = remainder[j] xor multiply(generator[j], factor)
        }
        return remainder
    }

    private fun multiply(x: Int, y: Int): Int {
        var product = 0
        for (i in 7 downTo 0) {
            product = (product shl 1) xor ((product ushr 7) * 0x11D)
            product = product xor (((y ushr i) and 1) * x)
        }
        return product
    }

    // --- 模様 ----------------------------------------------------------------

    private fun build(version: Int, codewords: IntArray, mask: Int?): Array<BooleanArray> {
        val size = version * 4 + 17
        val modules = Array(size) { BooleanArray(size) }
        // 機能パターン (データを置かない所)
        val fixedAt = Array(size) { BooleanArray(size) }
        fun set(row: Int, column: Int, dark: Boolean) {
            modules[row][column] = dark
            fixedAt[row][column] = true
        }

        // タイミングパターン
        for (i in 0 until size) {
            set(6, i, i % 2 == 0)
            set(i, 6, i % 2 == 0)
        }
        // 位置検出パターンと、その周りの明るい区切り
        for ((top, left) in listOf(0 to 0, 0 to size - 7, size - 7 to 0)) {
            for (dy in -1..7) {
                for (dx in -1..7) {
                    val row = top + dy
                    val column = left + dx
                    if (row < 0 || column < 0 || row >= size || column >= size) continue
                    val ring = maxOf(Math.abs(dy - 3), Math.abs(dx - 3))
                    set(row, column, ring != 2 && ring != 4)
                }
            }
        }
        // 位置合わせパターン (位置検出パターンと重なる 3 隅には置かない)
        val centers = alignments[version - 1]
        val last = centers.size - 1
        for (a in 0..last) {
            for (b in 0..last) {
                if ((a == 0 && b == 0) || (a == 0 && b == last) || (a == last && b == 0)) continue
                for (dy in -2..2) {
                    for (dx in -2..2) set(centers[a] + dy, centers[b] + dx, maxOf(Math.abs(dy), Math.abs(dx)) != 1)
                }
            }
        }
        // 形式情報の場所を先に取っておく (中身はマスクを決めてから書く)。左下の 1 つは常に暗い
        writeFormat(modules, fixedAt, 0)
        // 型番情報 (バージョン 7 から)
        if (version >= 7) {
            val bits = (version shl 12) or bch(version, 0x1F25, 12)
            for (i in 0 until 18) {
                val dark = ((bits ushr i) and 1) == 1
                val a = size - 11 + i % 3
                val b = i / 3
                set(b, a, dark)
                set(a, b, dark)
            }
        }

        // データを右下から 2 列ずつ、上下に折り返して置く (6 列目のタイミングパターンは飛ばす)
        var index = 0
        var right = size - 1
        while (right >= 1) {
            if (right == 6) right = 5
            val upward = ((right + 1) and 2) == 0
            for (step in 0 until size) {
                val row = if (upward) size - 1 - step else step
                for (j in 0..1) {
                    val column = right - j
                    if (fixedAt[row][column]) continue
                    if (index < codewords.size * 8) {
                        modules[row][column] = ((codewords[index ushr 3] ushr (7 - (index and 7))) and 1) == 1
                    }
                    index++
                }
            }
            right -= 2
        }

        val chosen = mask ?: (0..7).minBy { m ->
            val trial = Array(size) { modules[it].copyOf() }
            applyMask(trial, fixedAt, m)
            writeFormat(trial, fixedAt, m)
            penalty(trial)
        }
        applyMask(modules, fixedAt, chosen)
        writeFormat(modules, fixedAt, chosen)
        return modules
    }

    /** 形式情報 (誤り訂正のレベルとマスク) を 2 か所に書く。レベル M は 00。BCH(15,5) を付けて 101010000010010 と XOR する */
    private fun writeFormat(modules: Array<BooleanArray>, fixedAt: Array<BooleanArray>, mask: Int) {
        val size = modules.size
        val bits = ((mask shl 10) or bch(mask, 0x537, 10)) xor 0x5412
        fun set(row: Int, column: Int, i: Int) {
            modules[row][column] = ((bits ushr i) and 1) == 1
            fixedAt[row][column] = true
        }

        // 左上の位置検出パターンの周り
        for (i in 0..5) set(i, 8, i)
        set(7, 8, 6)
        set(8, 8, 7)
        set(8, 7, 8)
        for (i in 9 until 15) set(8, 14 - i, i)
        // 右上と左下
        for (i in 0 until 8) set(8, size - 1 - i, i)
        for (i in 8 until 15) set(size - 15 + i, 8, i)
        modules[size - 8][8] = true
        fixedAt[size - 8][8] = true
    }

    /** [value] を [length] ビットずらし、[generator] で割った余り */
    private fun bch(value: Int, generator: Int, length: Int): Int {
        var remainder = value shl length
        val top = 31 - Integer.numberOfLeadingZeros(generator)
        for (bit in 31 - Integer.numberOfLeadingZeros(remainder) downTo top) {
            if (((remainder ushr bit) and 1) == 1) remainder = remainder xor (generator shl (bit - top))
        }
        return remainder
    }

    private fun applyMask(modules: Array<BooleanArray>, fixedAt: Array<BooleanArray>, mask: Int) {
        val size = modules.size
        for (row in 0 until size) {
            for (column in 0 until size) {
                if (fixedAt[row][column]) continue
                val flip = when (mask) {
                    0 -> (row + column) % 2 == 0
                    1 -> row % 2 == 0
                    2 -> column % 3 == 0
                    3 -> (row + column) % 3 == 0
                    4 -> (row / 2 + column / 3) % 2 == 0
                    5 -> row * column % 2 + row * column % 3 == 0
                    6 -> (row * column % 2 + row * column % 3) % 2 == 0
                    else -> ((row + column) % 2 + row * column % 3) % 2 == 0
                }
                if (flip) modules[row][column] = !modules[row][column]
            }
        }
    }

    /** マスクを選ぶための失点 (JIS X 0510 の 4 つの決まり。似た模様と、明暗の偏り) */
    private fun penalty(modules: Array<BooleanArray>): Int {
        val size = modules.size
        var score = 0
        var dark = 0
        for (a in 0 until size) {
            // 行 (横) と列 (縦) で同じ色の続き
            for (vertical in 0..1) {
                fun at(i: Int) = if (vertical == 0) modules[a][i] else modules[i][a]
                var run = 1
                for (i in 1..size) {
                    if (i < size && at(i) == at(i - 1)) {
                        run++
                        continue
                    }
                    if (run >= 5) score += run - 2
                    run = 1
                }
                // 位置検出パターンに似た 1:1:3:1:1 の並びの片側に、明るい 4 つ
                for (i in 0..size - 11) {
                    val core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)
                    val light = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10)
                    val coreLater = at(i + 4) && !at(i + 5) && at(i + 6) && at(i + 7) && at(i + 8) && !at(i + 9) && at(i + 10)
                    val lightBefore = !at(i) && !at(i + 1) && !at(i + 2) && !at(i + 3)
                    if (core && light) score += 40
                    if (coreLater && lightBefore) score += 40
                }
            }
            for (b in 0 until size) {
                if (modules[a][b]) dark++
                if (a + 1 < size && b + 1 < size) {
                    val c = modules[a][b]
                    if (modules[a][b + 1] == c && modules[a + 1][b] == c && modules[a + 1][b + 1] == c) score += 3
                }
            }
        }
        // 暗い割合が 50% から 5% ずれるごとに 10
        val percent = dark * 100 / (size * size)
        score += Math.abs(percent - 50) / 5 * 10
        return score
    }

    /** ビットを上の桁から足していく入れ物 */
    private class BitList {
        private val bits = ArrayList<Boolean>()
        val size get() = bits.size

        fun add(value: Int, length: Int) {
            for (i in length - 1 downTo 0) bits.add(((value ushr i) and 1) == 1)
        }

        fun toBytes(): IntArray {
            val bytes = IntArray(bits.size / 8)
            for (i in bits.indices) if (bits[i]) bytes[i ushr 3] = bytes[i ushr 3] or (0x80 ushr (i and 7))
            return bytes
        }
    }
}
