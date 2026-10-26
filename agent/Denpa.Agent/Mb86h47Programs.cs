using static Denpa.Agent.Fr30Reg;

namespace Denpa.Agent;

/*
 * CECH-ZD1 J のブリッジ (MB86H47A) の中で動かす FR30 のプログラム。仕様書 11 章の振る舞いを、仕様書だけから自分で組んだ
 * (Fr30.cs のアセンブラで。命令の符号化は fr30-elf-as と突き合わせてある)。節の番号はその仕様書のもの。
 *
 * - 主 CPU の SRAM のルーチン (4.2): メモリ要求の番地を 32 ビットに広げる
 * - コア 0 (11.2): SDRAM のリングから EP 0x81 へ 192 バイトの単位を送り出す
 * - コア 1 (5.2・5.4・5.5): I2C のやり取りを代わりに行う。指示は bulk の塊で受ける (下の Core1 の説明)
 *
 * 指示の箱や溜めの形は機材の決まりではなく、こちらで決めたもの (仕様書 5.4・5.5 に「こちらで決めてよい」とある)。
 */
public static class Mb86h47Programs
{
    // ---------------------------------------------------------------------
    // 主 CPU のルーチン (仕様書 4.2)
    // ---------------------------------------------------------------------

    /// <summary>ルーチンを置ける2つのバンク (SRAM。電源投入時の処理は使っていない)</summary>
    public static readonly uint[] Banks = [0xE1000, 0xE1800];

    public const int BankSize = 0x800;

    /// <summary>読む側・書く側の元の処理の続き</summary>
    public const uint ReadContinue = 0xE9AE6;
    public const uint WriteContinue = 0xE9E2E;

    /// <summary>主 CPU のルーチン1つぶん (読む側と書く側を同じバンクに並べる)</summary>
    /// <param name="Words">置く語 (バンクの頭から)</param>
    /// <param name="Read">読む側の入口</param>
    /// <param name="Write">書く側の入口</param>
    public sealed record Routine(uint[] Words, uint Read, uint Write, string Listing);

    /// <summary>
    /// 番地を広げるルーチン。入ったとき R4 = 要求の 24 ビットの番地、要求の状態の塊を指すのは読む側 R8・書く側 R10。
    /// 使ってよいのは R0・R1・R4 だけ (と、飛んでくるのに使った R12)。
    ///
    /// <list type="number">
    /// <item>wValue の下位バイト h (<c>[状態+0x40]</c>) が 0 でなければ、番地 = <c>R4 | (h &lt;&lt; 24)</c> を <c>[状態+0x44]</c> へ。書く側だけ h を 0 に戻す</item>
    /// <item>h が 0 で <c>0x80000 ≤ R4 &lt; 0xA0000</c> なら、<c>(R4 &amp; 0x3FFFF) + 0xF00000</c> を <c>[状態+0x44]</c> へ (元の付け替えと同じ)</item>
    /// <item>どちらでもなければ何もしない。最後に元の処理の続きへ飛ぶ</item>
    /// </list>
    /// </summary>
    public static Routine Addressing(int bank)
    {
        var origin = Banks[bank];
        var asm = new Fr30Assembler(origin);
        asm.Label("read");
        AddressingSide(asm, "r", R8, ReadContinue, clear: false);
        // 書く側の入口を語の頭に揃える (置くのは 32 ビットずつ)
        if ((asm.Here & 2) != 0) asm.Nop();
        asm.Label("write");
        AddressingSide(asm, "w", R10, WriteContinue, clear: true);
        var words = asm.Words32();
        if (words.Length * 4 > BankSize) throw new InvalidOperationException("主 CPU のルーチンがバンクに収まりません");
        return new Routine(words, asm.AddressOf("read"), asm.AddressOf("write"), asm.Listing);
    }

    private static void AddressingSide(Fr30Assembler asm, string p, Fr30Reg state, uint next, bool clear)
    {
        asm.Ldi8(0x40, R0);
        asm.Add(state, R0);                // R0 = 状態 + 0x40
        asm.Ldub(R0, R1);                  // R1 = h
        asm.CmpI(0, R1);
        asm.B(Fr30Cond.Eq, $"{p}_low");
        asm.Lsl(24, R1);
        asm.Or(R1, R4);                    // R4 = R4 | (h << 24)
        if (clear)
        {
            asm.Ldi8(0, R1);
            asm.Stb(R1, R0);               // h を 0 に戻す (書く側だけ)
        }
        asm.AddI(4, R0);
        asm.St(R4, R0);                    // [状態 + 0x44] = 番地
        asm.Bra($"{p}_done");
        asm.Label($"{p}_low");
        asm.Ldi20(0x80000, R1);
        asm.Cmp(R1, R4);
        asm.B(Fr30Cond.C, $"{p}_done");    // R4 < 0x80000
        asm.Ldi20(0xA0000, R1);
        asm.Cmp(R1, R4);
        asm.B(Fr30Cond.Nc, $"{p}_done");   // R4 ≥ 0xA0000
        asm.Ldi20(0x3FFFF, R1);
        asm.And(R1, R4);
        asm.Ldi32(0xF00000, R1);
        asm.Add(R1, R4);
        asm.AddI(4, R0);
        asm.St(R4, R0);
        asm.Label($"{p}_done");
        asm.Ldi20(next, R0);
        asm.Jmp(R0);
    }

    // ---------------------------------------------------------------------
    // コア 0 (仕様書 11.2)
    // ---------------------------------------------------------------------

    /// <summary>コアのプログラムを置く所と入口 (コアの中の番地)</summary>
    public const uint CoreOrigin = 0xA0000;

    /// <summary>コア 0 の TS の送り出し。止まらずに回り続ける</summary>
    public static (uint[] Words, string Listing) Core0()
    {
        var asm = new Fr30Assembler(CoreOrigin);
        asm.Label("start");
        // 初め (コア 0 自身のレジスタ)
        Store32(asm, 0x0000, 0x77);
        Store32(asm, 0x0000, 0x00);
        Store32(asm, 0x0004, 0xFFFFFFFF);
        Store32(asm, 0x0030, 0x004041FF);
        Store32(asm, 0x0050, 0x004041FF);
        Store32(asm, 0x0090, 0xFFFFFFFF);
        Store32(asm, 0x00B8, 0xFFFFFFFF);
        Store32(asm, 0x00C8, 0xFFFFFFFF);
        Store32(asm, 0x0010, 0xFFFFFFFF);
        Store32(asm, 0x0020, 0xFFFFFFFF);
        Store32(asm, 0x0040, 0);
        foreach (var dma in new uint[] { 0x1060, 0x1064, 0x1068, 0x106C, 0x10B0, 0x10B4 }) Store32(asm, dma, 0x300);
        // M[0x1068] & 0x300 が 0 になるまで
        asm.Label("dma_wait");
        asm.Ldi(0x1068, R1);
        asm.Ld(R1, R0);
        asm.Ldi(0x300, R2);
        asm.And(R2, R0);
        asm.B(Fr30Cond.Ne, "dma_wait");

        // DMA 2 (リングを読む)
        Store32(asm, 0x1018, 0x00AE4000);
        Store32(asm, 0x1028, 0x00600000);
        asm.Ldi(0xD02038, R1);
        asm.Ld(R1, R2);                    // TS エンジンの書き手の位置
        asm.Ldi(0x1048, R1);
        asm.St(R2, R1);
        asm.Ldi(0x1038, R1);
        asm.St(R2, R1);
        Store32(asm, 0x1000, 0xFFF00000);

        // FIFO の並び (16 ビット)
        (uint, uint)[] fifo =
        [
            (0x10010, 0), (0x10030, 0), (0x10034, 0x800), (0x10038, 0x1000), (0x1003C, 0x1840), (0x10040, 0x1840),
            (0x10080, 0xB8), (0x10084, 0xB8), (0x10088, 0xC0), (0x1008C, 0xB8), (0x100B0, 0x1880), (0x100B4, 0x1900),
        ];
        foreach (var (address, value) in fifo) Store16(asm, address, value);

        // パケット化と出口
        (uint, uint)[] packer =
        [
            (0x2020, 0), (0x2024, 0), (0x202C, 0x03000400), (0x2030, 0x05010101), (0x3008, 0),
            (0x5000, 0x411080C0), (0x5008, 0x10000000), (0x5004, 0x01000000), (0x200C, 0x01000000),
        ];
        foreach (var (address, value) in packer) Store32(asm, address, value);

        // 初めに1回満たす。R8 = 満たし中、R9 = 単位の数
        Fill(asm);
        asm.Ldi8(1, R8);
        asm.Ldi8(0, R9);

        asm.Label("loop");
        // 1. 事象。ビット 29 なら受けた印を返し、満たし中を下ろす
        asm.Ldi(0x0020, R1);
        asm.Ld(R1, R3);                    // R3 = e (4 でも使う)
        asm.Ldi(0x20000000, R2);
        asm.Mov(R3, R0);
        asm.And(R2, R0);
        asm.B(Fr30Cond.Eq, "no_fill_done");
        asm.St(R2, R1);
        asm.Ldi8(0, R8);
        asm.Label("no_fill_done");
        // 2. DMA 2 が読んでよい所 = 書き手の位置まで
        asm.Ldi(0xD02038, R1);
        asm.Ld(R1, R0);
        asm.Ldi(0x1038, R1);
        asm.St(R0, R1);
        // 3. 満たし中でなければ、空きが 0x470 を超えたら満たす
        asm.CmpI(0, R8);
        asm.B(Fr30Cond.Ne, "send_check");
        asm.Ldi(0x10068, R1);
        asm.Lduh(R1, R0);
        asm.Ldi(0x10058, R1);
        asm.Lduh(R1, R2);
        asm.Sub(R2, R0);                   // free = M16[0x10068] - M16[0x10058]
        asm.B(Fr30Cond.Eq, "free_zero");
        asm.B(Fr30Cond.N, "free_negative");
        asm.Bra("free_ready");
        asm.Label("free_zero");
        asm.Ldi(0x840, R0);
        asm.Bra("free_ready");
        asm.Label("free_negative");
        asm.Ldi(0x840, R1);
        asm.Add(R1, R0);
        asm.Label("free_ready");
        asm.Ldi(0x470, R1);
        asm.Cmp(R1, R0);
        asm.B(Fr30Cond.Ls, "send_check"); // free ≤ 0x470 (符号無し)
        Fill(asm);
        asm.Ldi8(1, R8);
        // 4. 送れる単位が無い (ビット 5 が無い) か、パケット化が忙しければ 1 へ
        asm.Label("send_check");
        asm.Ldi8(0x20, R0);
        asm.And(R3, R0);
        asm.Far(Fr30Cond.Eq, "loop", R12);
        asm.Ldi(0x2000, R1);
        asm.Ld(R1, R0);
        asm.Ldi8(7, R2);
        asm.And(R2, R0);
        asm.Far(Fr30Cond.Ne, "loop", R12);
        // 5. 1単位 (192 バイト) 送る
        Store32(asm, 0x0020, 0x8);
        Store32(asm, 0x200C, 0x01000000);
        Store32(asm, 0x2004, 0xBF);
        Store32(asm, 0x2000, 0x0D000041);
        // 6. 10 単位ごとに、TS エンジンの書き手に読んだ位置 (8 バイト手前) を返す
        asm.AddI(1, R9);
        asm.CmpI(10, R9);
        asm.Far(Fr30Cond.Ne, "loop", R12);
        asm.Ldi8(0, R9);
        asm.Ldi(0x1048, R1);
        asm.Ld(R1, R0);
        asm.CmpI(8, R0);
        asm.B(Fr30Cond.Nc, "back_8");      // r ≥ 8
        asm.Ldi(0x600000 - 8, R1);
        asm.Add(R1, R0);
        asm.Bra("report");
        asm.Label("back_8");
        asm.Add2(-8, R0);
        asm.Label("report");
        asm.Ldi(0xD0202C, R1);
        asm.St(R0, R1);
        asm.Far(Fr30Cond.Ra, "loop", R12);
        return (asm.Words32(), asm.Listing);
    }

    /// <summary>FIFO を満たす: DMA 2 に次の 0x460 バイトを持ってこさせる</summary>
    private static void Fill(Fr30Assembler asm)
    {
        Store32(asm, 0x1078, 0x460);
        Store32(asm, 0x1068, 0x01000000);
    }

    /// <summary>M[address] ← value (R0 と R1 を使う)</summary>
    private static void Store32(Fr30Assembler asm, uint address, uint value)
    {
        asm.Ldi(address, R1);
        asm.Ldi(value, R0);
        asm.St(R0, R1);
    }

    /// <summary>16 ビットで書く (R0 と R1 を使う)</summary>
    private static void Store16(Fr30Assembler asm, uint address, uint value)
    {
        asm.Ldi(address, R1);
        asm.Ldi(value, R0);
        asm.Sth(R0, R1);
    }

    // ---------------------------------------------------------------------
    // コア 1 (仕様書 5.2・5.4・5.5)
    // ---------------------------------------------------------------------

    /*
     * コア 1 の RAM の並び (こちらで決めた形。ホストからは 0x1700000 を足した番地):
     *
     *   0xA0000〜        プログラム
     *   〜0xA37FC        スタック (下へ)
     *   0xA3C00 (箱)     +0x78 bulk の塊を見るか (BulkEnable のときだけ見る)、+0x7C 生きている印 (仕様書 5.4)
     *   0xA3C80〜        コア 1 の作業用
     *   0xA3D00          bulk の答えを組む所 (+0 と +4 が頭、+8 から読んだバイト)
     *
     * 指示は bulk の塊だけで受ける (仕様書 5.5。ほかの形をやめた理由は Mb86h47.cs の頭)。EP 0x02 で 512 バイトの塊を送ると、
     * ブリッジの DMA が 0x82100000 から順に 16 個置く。
     * 塊 = +0 通し番号 (0 でない)、+4 命令の数、+8 から命令、+508 = 通し番号をもう一度 (最後まで届いた印)。
     * 命令: 0x01 アドレス 書く数 読む数 (+ 書くバイトを語に詰めて) / 0x02 アドレス 番号の上位 番号の下位 + 残す 16・立てる 16
     * (2 バイトの番号のレジスタの読みかえ書き)。済ませたら塊の頭と終わりを 0 にし、答えを EP 0x83 で返す:
     * +0 = 0xA5・通し番号の下位 16・誤り、+4 = 済ませた命令の数 16・読んだバイト数 16、+8 から読んだバイト (56 バイトまで)
     *
     * 誤りの番号 (仕様書 5.4 と同じ): 0 = 成功、1 = バスエラー、2 = アドレスに ACK 無し、3 = データに ACK 無し、4 = 固まった。
     * こちらで足したもの: 6 = 知らない命令
     */

    public const uint Core1Box = 0xA3C00;
    public const int BoxBulkEnable = 0x78;
    public const int BoxAlive = 0x7C;

    /// <summary>箱の +0x78 にこの値があるときだけ bulk の塊を見る (DMA を用意して塊の頭を消してから書く)</summary>
    public const uint BulkEnable = 0xB01C0DE5;

    /// <summary>bulk の塊を置く所 (512 バイト × 16。仕様書 5.5)</summary>
    public const uint BulkBuffer = 0x82100000;

    public const int BulkSlots = 16;
    public const int BulkChunk = 512;
    public const byte BulkReplyMark = 0xA5;

    /// <summary>bulk の答えに載る読んだバイトの上限 (EP 0x83 は 64 バイト)</summary>
    public const int BulkReplyData = 56;

    /// <summary>I2C で待つ上限 (読みの回数。仕様書 5.2 の参考の値)</summary>
    private const uint I2cSpin = 0x40000;

    private const uint Scratch = Core1Box + 0x80;
    private const uint BulkReply = Core1Box + 0x100;
    private const uint Stack = 0xA3800;

    // 作業用の語 (箱からの差)
    private const int VarModify = 0xA0;
    private const int VarChunk = 0x88;
    private const int VarCommand = 0x8C;
    private const int VarCount = 0x90;
    private const int VarOut = 0x94;
    private const int VarIndex = 0x98;
    private const int VarSequence = 0x9C;

    /// <summary>コア 1 の I2C の代行</summary>
    public static (uint[] Words, string Listing) Core1()
    {
        var asm = new Fr30Assembler(CoreOrigin);
        asm.Label("start");
        asm.Ldi(Stack, R15);
        asm.Ldi(Core1Box, R14);
        // R10 = bulk の塊の番号、R11 = 生きている印
        asm.Ldi8(0, R10);
        asm.Ldi8(0, R11);

        asm.Label("main");
        asm.AddI(1, R11);
        asm.StFp(R11, BoxAlive);

        // --- bulk の塊 ---
        asm.LdFp(BoxBulkEnable, R0);
        asm.Ldi(BulkEnable, R1);
        asm.Cmp(R1, R0);
        asm.Far(Fr30Cond.Ne, "main", R12);
        asm.Mov(R10, R0);
        asm.Lsl(9, R0);
        asm.Ldi(BulkBuffer, R1);
        asm.Add(R1, R0);                   // R0 = 塊
        asm.Ld(R0, R2);                    // 頭の通し番号
        asm.CmpI(0, R2);
        asm.Far(Fr30Cond.Eq, "main", R12);
        asm.Mov(R0, R1);
        asm.Ldi(BulkChunk - 4, R3);
        asm.Add(R3, R1);
        asm.Ld(R1, R3);                    // 終わりの通し番号
        asm.Cmp(R2, R3);
        asm.Far(Fr30Cond.Ne, "main", R12);
        asm.StFp(R0, VarChunk);
        asm.StFp(R2, VarSequence);
        asm.Mov(R0, R1);
        asm.AddI(4, R1);
        asm.Ld(R1, R3);
        asm.StFp(R3, VarCount);
        asm.AddI(4, R1);
        asm.StFp(R1, VarCommand);
        asm.Ldi(BulkReply + 8, R1);
        asm.StFp(R1, VarOut);
        asm.Ldi8(0, R1);
        asm.StFp(R1, VarIndex);

        asm.Label("b_loop");
        asm.LdFp(VarCount, R3);
        asm.LdFp(VarIndex, R1);
        asm.Cmp(R3, R1);
        asm.B(Fr30Cond.C, "b_go");         // 済ませた数 < 命令の数
        asm.Ldi8(0, R0);
        asm.Far(Fr30Cond.Ra, "b_done", R12);
        asm.Label("b_go");
        asm.LdFp(VarCommand, R1);
        asm.Ld(R1, R2);                    // 命令の語
        asm.Mov(R2, R0);
        asm.Lsr(24, R0);
        asm.CmpI(1, R0);
        asm.B(Fr30Cond.Eq, "b_transfer");
        asm.CmpI(2, R0);
        asm.B(Fr30Cond.Eq, "b_modify");
        asm.Ldi8(6, R0);
        asm.Far(Fr30Cond.Ra, "b_done", R12);

        asm.Label("b_transfer");
        asm.Mov(R2, R4);
        asm.Lsl(8, R4);
        asm.Lsr(24, R4);
        asm.Mov(R2, R6);
        asm.Lsl(16, R6);
        asm.Lsr(24, R6);
        asm.Mov(R2, R3);
        asm.Lsl(24, R3);
        asm.Lsr(24, R3);
        asm.Mov(R1, R5);
        asm.AddI(4, R5);                   // 書くバイトは命令の語のあと
        asm.Mov(R6, R0);
        asm.AddI(3, R0);
        asm.Lsr(2, R0);
        asm.Lsl(2, R0);
        asm.AddI(4, R0);
        asm.Add(R0, R1);
        asm.StFp(R1, VarCommand);
        asm.LdFp(VarOut, R7);
        asm.Mov(R7, R0);
        asm.Add(R3, R0);
        asm.StFp(R0, VarOut);
        asm.Call("transfer");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "b_done", R12);
        asm.Bra("b_next");

        asm.Label("b_modify");
        asm.Mov(R2, R4);
        asm.Lsl(8, R4);
        asm.Lsr(24, R4);                   // アドレス
        asm.Mov(R2, R0);
        asm.Lsl(16, R0);
        asm.StFp(R0, (int)(Scratch - Core1Box));      // [番号上位, 番号下位]
        asm.Mov(R1, R0);
        asm.AddI(4, R0);
        asm.Ld(R0, R2);
        asm.StFp(R2, VarModify);           // 残す 16・立てる 16
        asm.AddI(8, R1);
        asm.StFp(R1, VarCommand);
        asm.Ldi(Scratch, R5);
        asm.Ldi8(2, R6);
        asm.Ldi(Scratch + 4, R7);
        asm.Ldi8(2, R3);
        asm.Call("transfer");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "b_done", R12);
        asm.Ldi(Scratch + 4, R0);
        asm.Lduh(R0, R1);                  // 読んだ値
        asm.LdFp(VarModify, R2);
        asm.Mov(R2, R3);
        asm.Lsr(16, R3);
        asm.And(R3, R1);
        asm.Lsl(16, R2);
        asm.Lsr(16, R2);
        asm.Or(R2, R1);
        asm.LdFp((int)(Scratch - Core1Box), R0);
        asm.Or(R1, R0);
        asm.StFp(R0, (int)(Scratch - Core1Box));
        asm.Ldi(Scratch, R5);
        asm.Ldi8(4, R6);
        asm.Ldi8(0, R3);
        asm.Call("transfer");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "b_done", R12);

        asm.Label("b_next");
        asm.LdFp(VarIndex, R1);
        asm.AddI(1, R1);
        asm.StFp(R1, VarIndex);
        asm.Far(Fr30Cond.Ra, "b_loop", R12);

        asm.Label("b_done");
        // R0 = 誤り。塊の頭と終わりを消す (次の周回で古い塊を新しいものと見ないように)
        asm.LdFp(VarChunk, R1);
        asm.Ldi8(0, R2);
        asm.St(R2, R1);
        asm.Ldi(BulkChunk - 4, R3);
        asm.Add(R3, R1);
        asm.St(R2, R1);
        // 答えの頭
        asm.LdFp(VarSequence, R2);
        asm.Lsl(16, R2);
        asm.Lsr(8, R2);
        asm.Or(R0, R2);
        asm.Ldi((uint)BulkReplyMark << 24, R1);
        asm.Or(R1, R2);
        asm.LdFp(VarIndex, R3);
        asm.Lsl(16, R3);
        asm.LdFp(VarOut, R5);
        asm.Ldi(BulkReply + 8, R1);
        asm.Sub(R1, R5);                   // 読んだバイト数
        asm.Or(R5, R3);
        asm.Ldi(0xFDBD8C, R6);             // EP 0x83 の FIFO
        asm.St(R2, R6);
        asm.St(R3, R6);
        asm.AddI(3, R5);
        asm.Lsr(2, R5);
        asm.CmpI(0, R5);
        asm.B(Fr30Cond.Eq, "b_send");
        asm.Label("b_push");
        asm.Ld(R1, R2);
        asm.St(R2, R6);
        asm.AddI(4, R1);
        asm.Add2(-1, R5);
        asm.B(Fr30Cond.Ne, "b_push");
        asm.Label("b_send");
        asm.Ldi(0xFDBD1C, R6);
        asm.Ldi8(4, R2);
        asm.St(R2, R6);
        asm.AddI(1, R10);
        asm.Ldi8(BulkSlots - 1, R1);
        asm.And(R1, R10);
        asm.Far(Fr30Cond.Ra, "main", R12);

        I2cRoutines(asm);
        return (asm.Words32(), asm.Listing);
    }

    /*
     * I2C のやり取り (仕様書 5.2)。
     *
     * transfer: 入り R4 = アドレス、R5 = 書くバイト、R6 = 書く数、R7 = 読んだバイトを置く所、R3 = 読む数。出 R0 = 誤り。
     *           R0〜R3・R5〜R7・R12・R13 を壊す (R4 は残す)
     * send:     R1 = バイト、R2 = 制御。出 R0 = 0 成功 / 1 バスエラー / 4 固まった / 5 ACK 無し。R1・R12 を壊す
     * idle:     使用中 (状態の bit7) が落ちるまで待つ。出 R0 = 0 / 4
     * R13 = I2C マスターの頭 (0xFD8FE0)。+0 状態、+4 制御、+0x10 データ
     */
    private static void I2cRoutines(Fr30Assembler asm)
    {
        asm.Label("transfer");
        asm.PushRp();
        asm.Ldi(0xFD8FE0, R13);
        asm.CmpI(0, R6);
        asm.B(Fr30Cond.Eq, "t_read_only");
        asm.Call("idle");
        asm.CmpI(0, R0);
        asm.B(Fr30Cond.Ne, "t_fail");
        asm.Mov(R4, R1);
        asm.Ldi8(0xFE, R12);
        asm.And(R12, R1);
        asm.Ldi8(0x50, R2);
        asm.Call("send");
        Nack(asm, 2);
        asm.Label("t_write");
        asm.Ldub(R5, R1);
        asm.AddI(1, R5);
        asm.Ldi8(0x50, R2);
        asm.Call("send");
        Nack(asm, 3);
        asm.Add2(-1, R6);
        asm.B(Fr30Cond.Ne, "t_write");
        asm.CmpI(0, R3);
        asm.B(Fr30Cond.Eq, "t_stop");
        asm.Mov(R4, R1);
        asm.Ldi8(1, R12);
        asm.Or(R12, R1);
        asm.Ldi8(0x70, R2);                // 繰り返しスタート
        asm.Call("send");
        Nack(asm, 2);
        asm.Bra("t_read");

        asm.Label("t_read_only");
        asm.CmpI(0, R3);
        asm.B(Fr30Cond.Eq, "t_stop");
        asm.Call("idle");
        asm.CmpI(0, R0);
        asm.B(Fr30Cond.Ne, "t_fail");
        asm.Mov(R4, R1);
        asm.Ldi8(1, R12);
        asm.Or(R12, R1);
        asm.Ldi8(0x50, R2);
        asm.Call("send");
        Nack(asm, 2);

        asm.Label("t_read");
        asm.Ldi8(0x58, R2);                // ACK を返す
        asm.CmpI(1, R3);
        asm.B(Fr30Cond.Ne, "t_read_go");
        asm.Ldi8(0x50, R2);                // 最後の1バイトは返さない
        asm.Label("t_read_go");
        asm.Ldi8(4, R12);
        asm.StAc(R2, R12);
        WaitByte(asm, "t_fail");
        asm.Ldi8(0x10, R12);
        asm.LdAc(R12, R0);
        asm.Stb(R0, R7);
        asm.AddI(1, R7);
        asm.Add2(-1, R3);
        asm.B(Fr30Cond.Ne, "t_read");

        asm.Label("t_stop");
        asm.Ldi8(0x40, R2);
        asm.Ldi8(4, R12);
        asm.StAc(R2, R12);              // ストップ
        asm.Call("idle");
        asm.PopRp();
        asm.Ret();

        asm.Label("t_fail");
        asm.Mov(R0, R6);
        asm.Ldi8(0x40, R2);
        asm.Ldi8(4, R12);
        asm.StAc(R2, R12);              // バスを止めてから失敗を返す
        asm.Mov(R6, R0);
        asm.PopRp();
        asm.Ret();

        asm.Label("send");
        asm.Ldi8(0x10, R12);
        asm.StAc(R1, R12);              // データ
        asm.Ldi8(4, R12);
        asm.StAc(R2, R12);              // 制御
        WaitByte(asm, "send_end");
        asm.Ld(R13, R0);
        asm.Ldi8(0x10, R12);
        asm.And(R12, R0);                  // 状態の bit4 = ACK が無い
        asm.B(Fr30Cond.Eq, "send_end");
        asm.Ldi8(5, R0);
        asm.Label("send_end");
        asm.Ret();

        asm.Label("idle");
        asm.Ldi(I2cSpin, R1);
        asm.Label("idle_loop");
        asm.Ld(R13, R0);
        asm.Ldi8(0x80, R12);
        asm.And(R0, R12);
        asm.B(Fr30Cond.Eq, "idle_ok");
        asm.Add2(-1, R1);
        asm.B(Fr30Cond.Ne, "idle_loop");
        asm.Ldi8(4, R0);
        asm.Ret();
        asm.Label("idle_ok");
        asm.Ldi8(0, R0);
        asm.Ret();
    }

    /// <summary>send の答えが ACK 無し (5) なら <paramref name="code"/> にして、どれかの誤りなら t_fail へ</summary>
    private static void Nack(Fr30Assembler asm, uint code)
    {
        var ok = asm.NewLabel("ack");
        asm.CmpI(0, R0);
        asm.B(Fr30Cond.Eq, ok);
        asm.CmpI(5, R0);
        asm.B(Fr30Cond.Ne, "t_fail");
        asm.Ldi8(code, R0);
        asm.Bra("t_fail");
        asm.Label(ok);
    }

    /// <summary>
    /// 1バイト終わるのを待つ: 制御の bit7 ならバスエラー (R0 = 1)、bit0 なら終わり (R0 = 0)。
    /// 上限まで読んでも終わらなければ固まった (R0 = 4)。誤りなら <paramref name="fail"/> へ。R0・R1・R12 を壊す
    /// </summary>
    private static void WaitByte(Fr30Assembler asm, string fail)
    {
        var loop = asm.NewLabel("byte");
        var done = asm.NewLabel("byte_done");
        var error = asm.NewLabel("byte_error");
        asm.Ldi(I2cSpin, R1);
        asm.Label(loop);
        asm.Ldi8(4, R12);
        asm.LdAc(R12, R0);
        asm.Ldi8(0x80, R12);
        asm.And(R0, R12);
        asm.B(Fr30Cond.Ne, error);
        asm.Ldi8(1, R12);
        asm.And(R0, R12);
        asm.B(Fr30Cond.Ne, done);
        asm.Add2(-1, R1);
        asm.B(Fr30Cond.Ne, loop);
        asm.Ldi8(4, R0);
        asm.Bra(fail);
        asm.Label(error);
        asm.Ldi8(1, R0);
        asm.Bra(fail);
        asm.Label(done);
        asm.Ldi8(0, R0);
    }
}
