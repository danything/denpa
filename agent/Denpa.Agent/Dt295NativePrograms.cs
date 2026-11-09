using static Denpa.Agent.Fr30Reg;

namespace Denpa.Agent;

/*
 * PIX-DT295 の機材の中で動かす FR30 のプログラム。節の番号は
 * 仕様書 (dt295-resident/spec.md) のもの。常駐イメージは入れず、要求ごとに動く小さなプログラムだけを機材に置く。
 * 操作 1 は TS を取り込みのリングから USB の bulk IN へ送り、操作 2 は I2C の転送の並びを順に実行する (<see cref="EmitI2c"/>)。
 * 操作 3・4 はカードの UART に T=1 のブロックを書いて送らせ、受けたバイトを読む (<see cref="EmitCard"/>)。
 * 機材の設定は、ホストが 0xBC のメモリ要求で書く (Dt295NativeBoard.cs・Dt295NativeFrontend.cs)。
 *
 * **ループは主 CPU の boot0 の hook に置く。補助 CPU には置かない。** 理由は 3 つ。
 * 1. ループが触るもの (リングの先頭 0x8138EC00、書き込み位置 0x1902028、読み出し位置 0x190202C、FIFO 0xFDBD84・0xFDBD0C、
 *    保護レジスタ 0xFD814C) は、仕様書 8.2・8.3 がすべて主 CPU から見たアドレスで書いている。補助 CPU から見た SDRAM とリングの
 *    アドレスは仕様書に無い。補助 CPU の USB レジスタは 0x1684000 台で、主 CPU の 0xFD8000 台と同じものとみなすのは「推定」(仕様書 1.2・8 章冒頭)
 * 2. 補助 CPU を使うには、機材のメモリへ圧縮コードを伸長して起動する手順 (仕様書 6 章) が要る。起動後のメールボックスの応答や USB の割り込みの扱いは
 *    「未確認」(仕様書 11.1)。主 CPU に置けば、この手順を再現しなくて済む
 * 3. 主 CPU の hook (仕様書 3.2) は、書き込む場所・入口の条件・戻り先 (状態段 0xEA8C8) まで仕様書にある
 *
 * 欠点: 主 CPU は boot0 が受けた制御転送の処理の中でループを回すので、ループの間は制御転送が機材に通らない (仕様書 1.1 に
 * 「常駐イメージには主ループも割り込み処理も無い」とあるのと同じ場所で動く)。そこで 1 回の要求で送るパケットの数をホストが決め、
 * 数だけ送ったら (または待ち続けて限度に達したら) 状態段へ戻る。ホストは要求と要求の間に制御転送を出せる。
 * リングは 192 KiB で、20 Mbps なら約 80 ms ぶん溜まる。要求の間隔がこれより短ければ取りこぼさない (仕様書に無い。見積もり)。
 *
 * 操作 1 の要求 (制御 OUT。wValue 0x0C7D、wIndex 0x4620 で 0xC4620 へ。仕様書 3.2 と同じ入口。BE32): +0 'DNT1'、+4 操作 (1)、+8 送るパケット数、
 * +12 待つ回数の限度。応答 (制御 IN で 0xC4620 から読む): +4 結果 (0 = 数だけ送った、1 = 待つ回数の限度、2 = 書き込み位置が長さ以上)、
 * +8 送ったパケット数、+12 読み出し位置、+16 揃え位置 k、+20 パケット内位置、+24 最後に読んだ書き込み位置、+28 揃えたか。
 */
public static class Dt295NativePrograms
{
    /// <summary>プログラムを置く所。boot0 の空き RAM (仕様書 1.2 の body の置き場所。上限 0x800)</summary>
    public const uint BodyOrigin = 0xE1000;

    /// <summary>プログラムの後ろに置く作業域 (保存したレジスタと、要求をまたいで持つ状態)。プログラムはこれより前に収める</summary>
    public const uint Frame = 0xE17C0;

    public const int FrameBytes = 0x40;

    /// <summary>作業域の中の位置 (R14 が指す)。+0 は元の R14</summary>
    public const int SavedR8 = 4, SavedR9 = 8, SavedR10 = 12, SavedR11 = 16, SavedR13 = 20;

    /// <summary>要求をまたいで持つ状態。ホストは置いたときに 0 にする (読み出し位置 0・パケット内位置 0・未整列)</summary>
    public const int StateRp = 24, StatePos = 28, StateK = 32, StateAligned = 36;

    private const int Target = 40, IdleLimit = 44;

    /// <summary>I2C の順次実行 (操作 2) が作業域に持つもの。+48 直前の読みの先頭バイト、+52 結果の置き場の先頭、+56 転送の種類、+60 いまの転送の読みの置き場</summary>
    private const int LastRead = 48, ResultStart = 52, Kind = 56, ReadStart = 60;

    /// <summary>操作 2 の操作列と結果の置き場 (SDRAM。常駐イメージを入れていた 0x80380000 台。ホストからは 0x380000 台)。長い操作列だけここに置き、短いものは要求の中に入れる</summary>
    public const uint BatchCpu = 0x80380000, BatchPhysical = 0x380000, BatchResultOffset = 0x2000, BatchLimit = 0x2000;

    /// <summary>操作 2 の要求の中に操作列と結果を置くとき: 結果は +16〜+31、操作列は +32〜+63</summary>
    public const uint InlineResults = Staging + 16, InlineOps = Staging + 32;

    public const int InlineResultBytes = 16, InlineOpBytes = 32;

    /// <summary>操作 2 の結果 (応答の +4)</summary>
    public const uint I2cOk = 0, I2cNack = 1, I2cBusError = 2, I2cTimeout = 3;

    /// <summary>操作 3・4 の結果 (応答の +4)。プログラムは要求の +4 (操作の番号) をこれで書き換える</summary>
    public const uint CardOk = 0;

    /// <summary>操作 3 の要求の中に置くブロックと、操作 4 の応答の中に置く受けたバイトの場所: +16〜+63</summary>
    public const uint InlineCard = Staging + 16;

    public const int InlineCardBytes = 48;

    /// <summary>hook (仕様書 3.2)。元の 8 バイトを、飛び先を body の入口にした 8 バイトに置き換える</summary>
    public const uint Hook = 0xEA6FC;

    /// <summary>元の hook の 8 バイト (仕様書 3.2)。<c>ldi:8 #0x46,r13 / ldub @(r13,r11),r0 / cmp #1,r0 / bne</c></summary>
    public static readonly byte[] OriginalHook = [0xC4, 0x6D, 0x02, 0xB0, 0xA8, 0x10, 0xE3, 0x2B];

    /// <summary>元の分岐の行き先 (仕様書 3.2): wValue 下位が 1 なら 0xEA704、それ以外は 0xEA75A</summary>
    public const uint ContinueMask = 0xEA704, ContinueWrite = 0xEA75A;

    /// <summary>状態段 (仕様書 3.1・3.2)。要求の処理が終わったらここへ飛ぶ</summary>
    public const uint StatusStage = 0xEA8C8;

    /// <summary>boot0 の作業域 W と、要求・応答 64 バイトの場所 (仕様書 3.1)</summary>
    public const uint Work = 0xC461C, Staging = 0xC4620;

    /// <summary>要求の wValue (下位 0x7D が入口の印。上位 0x0C と wIndex 0x4620 で 0xC4620)</summary>
    public const ushort RequestValue = 0x0C7D, RequestIndex = 0x4620;

    /// <summary>要求の先頭 'DNT1'</summary>
    public const uint Magic = 0x444E5431;

    /// <summary>リング (仕様書 8.1.2 の #21・#22 と 8.2。CPU からは 0x80000000 | 物理アドレス)</summary>
    public const uint RingPhysical = 0x0138EC00, RingLength = 0x30000;

    public const uint RingCpu = 0x80000000 | RingPhysical;

    /// <summary>取り込みブロックのレジスタ (仕様書 8.1.2)</summary>
    public const uint RingWrite = 0x1902028, RingRead = 0x190202C;

    /// <summary>USB の TS の端点のレジスタと保護レジスタ (仕様書 8.3)</summary>
    public const uint Fifo = 0xFDBD84, FifoStatus = 0xFDBD0C, Protect = 0xFD814C;

    /// <summary>応答の結果</summary>
    public const uint ResultSent = 0, ResultIdle = 1, ResultBadWrite = 2;

    /// <summary>機材に置くもの</summary>
    /// <param name="Words">body の語 (BodyOrigin から。32 ビットずつ)</param>
    /// <param name="CodeBytes">プログラムの長さ</param>
    /// <param name="HookBytes">hook に書く 8 バイト</param>
    public sealed record Image(uint[] Words, int CodeBytes, byte[] HookBytes, string Listing);

    public static Image Build()
    {
        var asm = new Fr30Assembler(BodyOrigin);

        // --- 入口 (仕様書 3.2 の body と同じ 4 つの条件) ---
        // 使うのは R0 と R12 だけ。元の命令列も R0 を書き換え、hook の飛び方が R12 を書き換えているので、ほかのレジスタを壊さない
        asm.Label("entry");
        Check(asm, 0xC4662, 1, 0x7D);        // wValue 下位 (仕様書 3.1 の W+0x46)
        Check(asm, 0xC4664, 2, 0x40);        // wLength (W+0x48)
        Check(asm, Work, 4, Staging);        // 24 ビットのアドレス = 0xC4620
        Check(asm, Staging, 4, Magic);       // データの先頭
        asm.Bra("trigger");

        // 条件が合わないとき: 置き換えた元の命令列 (ldi:8, ldub, cmp) をそのまま実行して、元の分岐先へ (仕様書 3.2)
        asm.Label("orig");
        asm.Ldi8(0x46, R13);
        asm.LdubAc(R11, R0);
        asm.CmpI(1, R0);
        asm.B(Fr30Cond.Eq, "to_mask");
        asm.Ldi20(ContinueWrite, R12);
        asm.Jmp(R12);
        asm.Label("to_mask");
        asm.Ldi20(ContinueMask, R12);
        asm.Jmp(R12);

        // --- 要求 ---
        asm.Label("trigger");
        asm.PushRp();
        asm.Ldi20(Frame, R12);
        asm.St(R14, R12);                    // 作業域の先頭に元の R14
        asm.Mov(R12, R14);                   // 以後 R14 = 作業域
        asm.StFp(R8, SavedR8);
        asm.StFp(R9, SavedR9);
        asm.StFp(R10, SavedR10);
        asm.StFp(R11, SavedR11);
        asm.StFp(R13, SavedR13);
        // 操作 2 (I2C の順次実行)・3 (カードへ送る)・4 (カードから受ける) は別の経路へ。操作 1 (TS を送る) はそのまま下へ
        asm.Ldi20(Staging + 4, R12);
        asm.Ld(R12, R0);
        asm.CmpI(2, R0);
        asm.Far(Fr30Cond.Eq, "i2c", R12);
        asm.CmpI(3, R0);
        asm.Far(Fr30Cond.Eq, "card_send", R12);
        asm.CmpI(4, R0);
        asm.Far(Fr30Cond.Eq, "card_receive", R12);
        asm.Ldi32(RingCpu, R4);
        asm.Ldi32(RingLength, R5);
        asm.Ldi20(Staging + 8, R12);
        asm.Ld(R12, R6);                     // 送るパケット数
        asm.AddI(4, R12);
        asm.Ld(R12, R7);                     // 待つ回数の限度
        asm.StFp(R6, Target);
        asm.StFp(R7, IdleLimit);
        asm.LdFp(StateRp, R8);
        asm.LdFp(StatePos, R9);
        asm.LdFp(StateK, R10);
        asm.LdFp(StateAligned, R11);

        // --- 主ループ。R4 リング、R5 長さ、R6 残りのパケット数、R7 待った回数、R8 読み出し位置 rp、R9 パケット内位置、R10 揃え位置 k、R11 揃えたか ---
        asm.Label("loop");
        asm.CmpI(0, R6);
        asm.Far(Fr30Cond.Eq, "fin_sent", R12);
        asm.Ldi32(RingWrite, R12);
        asm.Ld(R12, R13);                    // 書き込み位置 wp
        asm.Cmp(R5, R13);
        asm.Far(Fr30Cond.Nc, "fin_bad", R12); // wp ≥ 長さ (仕様書 8.2.2 の 2)
        asm.Mov(R13, R3);
        asm.Sub(R8, R3);
        asm.B(Fr30Cond.Nc, "avail");
        asm.Add(R5, R3);
        asm.Label("avail");                  // R3 = 空き = wp − rp (仕様書 8.2.2 の 3)
        asm.CmpI(0, R11);
        asm.Far(Fr30Cond.Eq, "search", R12);

        // 揃えたあと: 必要量は 572 + k か 764 + k (仕様書 8.2.2 の 6)。大きいほうを常に使う
        asm.Ldi20(764, R0);
        asm.Add(R10, R0);
        asm.Cmp(R0, R3);
        asm.Far(Fr30Cond.C, "idle", R12);
        asm.Ldi32(FifoStatus, R12);
        asm.Ld(R12, R0);
        asm.Ldi8(4, R12);
        asm.And(R12, R0);
        asm.Far(Fr30Cond.Eq, "idle", R12);   // FIFO が空いていない (仕様書 8.3.2)

        // 512 バイト = 128 語を FIFO に書く (仕様書 8.3.2)
        asm.Ldi32(Fifo, R13);
        asm.Mov(R10, R7);
        asm.Ldi8(3, R12);
        asm.And(R12, R7);
        asm.Lsl(3, R7);                      // R7 = 8 × (k mod 4) = 語の境目からのずれ (ビット)
        asm.Mov(R10, R11);
        asm.Lsr(2, R11);
        asm.Lsl(2, R11);                     // R11 = k を 4 の倍数に切り捨てたもの
        asm.Ldi8(128, R3);
        asm.Label("word");
        asm.Mov(R8, R1);
        asm.Add(R11, R1);
        asm.Add(R9, R1);                     // リングの中の位置 = rp + k + パケット内位置
        asm.Cmp(R5, R1);
        asm.B(Fr30Cond.C, "w0");
        asm.Sub(R5, R1);
        asm.Label("w0");
        asm.Add(R4, R1);
        asm.Ld(R1, R0);
        asm.CmpI(0, R7);
        asm.B(Fr30Cond.Eq, "emit");
        // k が 4 の倍数でないときは、隣り合う 2 語をずらして組み合わせる (仕様書 8.3.2)
        asm.AddI(4, R1);
        asm.Mov(R4, R12);
        asm.Add(R5, R12);
        asm.Cmp(R12, R1);
        asm.B(Fr30Cond.C, "w1");
        asm.Sub(R5, R1);
        asm.Label("w1");
        asm.Ld(R1, R2);
        asm.LslR(R7, R0);
        asm.Ldi8(32, R12);
        asm.Sub(R7, R12);
        asm.LsrR(R12, R2);
        asm.Or(R2, R0);
        asm.Label("emit");
        asm.St(R0, R13);
        asm.AddI(4, R9);
        asm.Ldi8(188, R12);
        asm.Cmp(R12, R9);
        asm.B(Fr30Cond.Ne, "next");
        asm.Ldi8(0, R9);                     // 188 バイトで次の記録へ (記録は 192 バイト。後ろの 4 バイトは送らない。仕様書 8.2)
        asm.Ldi8(192, R12);
        asm.Add(R12, R8);
        asm.Cmp(R5, R8);
        asm.B(Fr30Cond.C, "next");
        asm.Sub(R5, R8);
        asm.Label("next");
        asm.Add2(-1, R3);
        asm.B(Fr30Cond.Ne, "word");

        // パケットの確定 (仕様書 8.3.2: 0xFD814C = 8、0xFDBD0C = 4、0xFD814C = 0xF) と読み出し位置の更新
        asm.Ldi32(Protect, R12);
        asm.Ldi8(8, R0);
        asm.St(R0, R12);
        asm.Ldi32(FifoStatus, R12);
        asm.Ldi8(4, R0);
        asm.St(R0, R12);
        asm.Ldi32(Protect, R12);
        asm.Ldi8(0xF, R0);
        asm.St(R0, R12);
        asm.Ldi32(RingRead, R12);
        asm.St(R8, R12);
        asm.Ldi8(1, R11);
        asm.LdFp(IdleLimit, R7);
        asm.Add2(-1, R6);
        asm.Far(Fr30Cond.Ra, "loop", R12);

        // 揃っていないとき: 空きが 0x2FC 以上になったら、rp + k、+192、+384 の 3 バイトが全部 0x47 になる最小の k を探す (仕様書 8.2.2 の 4)
        asm.Label("search");
        asm.Ldi20(0x2FC, R0);
        asm.Cmp(R0, R3);
        asm.Far(Fr30Cond.C, "idle", R12);
        asm.Ldi8(0, R0);
        asm.Ldi8(0x47, R3);
        asm.Label("probe");
        foreach (var offset in new uint[] { 0, 192, 384 })
        {
            var inside = asm.NewLabel("in");
            asm.Mov(R8, R1);
            asm.Add(R0, R1);
            if (offset != 0)
            {
                asm.Ldi(offset, R2);
                asm.Add(R2, R1);
            }
            asm.Cmp(R5, R1);
            asm.B(Fr30Cond.C, inside);
            asm.Sub(R5, R1);
            asm.Label(inside);
            asm.Add(R4, R1);
            asm.Ldub(R1, R2);
            asm.Cmp(R3, R2);
            asm.B(Fr30Cond.Ne, "miss");
        }
        asm.Mov(R0, R10);
        asm.Ldi8(1, R11);
        asm.Ldi8(0, R9);
        asm.Far(Fr30Cond.Ra, "loop", R12);
        asm.Label("miss");
        asm.AddI(1, R0);
        asm.Ldi8(192, R1);
        asm.Cmp(R1, R0);
        asm.B(Fr30Cond.C, "probe");
        // 見つからなければ rp を 192 進めて書き、次の周で探し直す
        asm.Add(R1, R8);
        asm.Cmp(R5, R8);
        asm.B(Fr30Cond.C, "stored");
        asm.Sub(R5, R8);
        asm.Label("stored");
        asm.Ldi32(RingRead, R12);
        asm.St(R8, R12);
        asm.Far(Fr30Cond.Ra, "loop", R12);

        // 進まなかった周: 待つ回数を 1 減らし、尽きたら戻る
        asm.Label("idle");
        asm.Add2(-1, R7);
        asm.Far(Fr30Cond.Ne, "loop", R12);
        asm.Ldi8(ResultIdle, R0);
        asm.Bra("finish");
        asm.Label("fin_sent");
        asm.Ldi8(ResultSent, R0);
        asm.Bra("finish");
        asm.Label("fin_bad");
        asm.Ldi8(ResultBadWrite, R0);

        // --- 戻る。応答を 0xC4620 に書き、レジスタを戻して状態段へ (仕様書 3.2) ---
        asm.Label("finish");
        asm.StFp(R8, StateRp);
        asm.StFp(R9, StatePos);
        asm.StFp(R10, StateK);
        asm.StFp(R11, StateAligned);
        asm.Ldi20(Staging + 4, R12);
        asm.St(R0, R12);
        asm.AddI(4, R12);
        asm.LdFp(Target, R1);
        asm.Sub(R6, R1);
        asm.St(R1, R12);                     // 送ったパケット数
        asm.AddI(4, R12);
        asm.St(R8, R12);
        asm.AddI(4, R12);
        asm.St(R10, R12);
        asm.AddI(4, R12);
        asm.St(R9, R12);
        asm.AddI(4, R12);
        asm.Ldi32(RingWrite, R2);
        asm.Ld(R2, R1);
        asm.St(R1, R12);
        asm.AddI(4, R12);
        asm.St(R11, R12);
        asm.Label("leave");
        asm.LdFp(SavedR8, R8);
        asm.LdFp(SavedR9, R9);
        asm.LdFp(SavedR10, R10);
        asm.LdFp(SavedR11, R11);
        asm.LdFp(SavedR13, R13);
        asm.Ld(R14, R14);
        asm.PopRp();
        asm.Ldi20(StatusStage, R12);
        asm.Jmp(R12);

        EmitI2c(asm);
        EmitCard(asm);

        var words = asm.Words32();
        var bytes = words.Length * 4;
        if (bytes > Frame - BodyOrigin) throw new InvalidOperationException($"機材に置くプログラム ({bytes} バイト) が作業域の前に収まりません");

        var hook = new Fr30Assembler(Hook);
        hook.Ldi20(BodyOrigin, R12);
        hook.Jmp(R12);
        hook.Nop();
        var hookBytes = hook.Words().SelectMany(word => new[] { (byte)(word >> 8), (byte)word }).ToArray();
        return new Image(words, bytes, hookBytes, asm.Listing);
    }

    /// <summary>
    /// 操作 2: I2C の転送を、ホストが渡した操作列のとおりに順に実行し、読んだバイトを結果の置き場に並べる。ホストが 1 バイトずつ制御転送で動かす
    /// (Dt295NativeI2c の Transfer) のと同じ手順を、機材の中で実行する (制御転送 1 回が約 60 µs で、1 バイトに 3 回要る)。
    /// 要求: +4 操作 2、+8 操作列のアドレス (CPU)、+12 結果の置き場のアドレス (CPU)、+16 転送の数。
    /// 操作列は転送ごとに [アドレス 7 ビット][書く数][読む数][種類] と書くバイト。種類 1 は、書く数のうち最後の 1 バイトを
    /// 「直前の読みの先頭バイト &amp; keep | set」にして、書くバイトのあとに keep・set の 2 バイトが付く。
    /// 応答: +4 結果 (I2cOk・I2cNack・I2cBusError・I2cTimeout)、+8 止まった転送の番号 (全部済めば転送の数)、+12 読んだバイト数。
    /// 失敗したら STOP を出して戻る。待つ回数の限度は 1 バイトにつき 0x20000 回の読み
    /// </summary>
    private static void EmitI2c(Fr30Assembler asm)
    {
        asm.Label("i2c");
        asm.Ldi20(Staging + 8, R12);
        asm.Ld(R12, R13);                    // R13 = 操作列 (これを基底に、バイトの位置 R4 で読む)
        asm.AddI(4, R12);
        asm.Ld(R12, R6);
        asm.Sub(R13, R6);                    // R6 = 結果の置き場 − 操作列。R13 + R6 が次に書く結果のアドレス
        asm.StFp(R6, ResultStart);
        asm.AddI(4, R12);
        asm.Ld(R12, R5);                     // R5 = 残りの転送の数
        asm.StFp(R5, IdleLimit);             // 最初の数 (止まった番号 = 最初の数 − 残り)
        asm.Ldi8(0, R4);
        asm.Ldi8(0, R0);
        asm.StFp(R0, LastRead);
        asm.Ldi32(0xFD8FE0, R7);             // 状態
        asm.Ldi32(0xFD8FE4, R8);             // 制御
        asm.Ldi32(0xFD8FF0, R9);             // データ

        asm.Label("t_loop");
        asm.CmpI(0, R5);
        asm.Far(Fr30Cond.Eq, "i2c_done", R12);
        // バスが空くまで待つ (状態の bit7)。直前の STOP のすぐあとに次の START を出さない。ホストは制御転送の間隔 (約 60 µs) でこの間が空いている
        asm.Ldi32(0x20000, R12);
        asm.Label("idle_wait");
        asm.Ld(R7, R0);
        asm.Ldi8(0x80, R11);
        asm.And(R11, R0);
        asm.B(Fr30Cond.Eq, "idle_ok");
        asm.Add2(-1, R12);
        asm.B(Fr30Cond.Ne, "idle_wait");
        asm.Ldi8((uint)I2cTimeout, R0);
        asm.Far(Fr30Cond.Ra, "i2c_fail", R12);
        asm.Label("idle_ok");
        asm.LdubAc(R4, R1);
        asm.AddI(1, R4);
        asm.LdubAc(R4, R2);
        asm.AddI(1, R4);
        asm.LdubAc(R4, R3);
        asm.AddI(1, R4);
        asm.LdubAc(R4, R0);
        asm.AddI(1, R4);
        asm.StFp(R0, Kind);
        asm.Lsl(1, R1);                      // R1 = アドレス << 1
        asm.StFp(R2, Target);                // 書く数 (再スタートを入れるかの判定)
        // 開始: データ = (アドレス << 1) | (書かないなら 1)、制御 = 0x42 | 0x10
        asm.Mov(R1, R0);
        asm.CmpI(0, R2);
        asm.B(Fr30Cond.Ne, "a1");
        asm.AddI(1, R0);
        asm.Label("a1");
        asm.St(R0, R9);
        asm.Ldi8(0x52, R0);
        asm.St(R0, R8);
        asm.Call("wait_byte");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "i2c_fail", R12);
        asm.Ld(R7, R0);                      // アドレスの直後に ACK が来なかったら失敗 (状態の bit4)
        asm.Ldi8(0x10, R11);
        asm.And(R11, R0);
        asm.Far(Fr30Cond.Ne, "i2c_nack", R12);

        // 書き
        asm.Label("w_loop");
        asm.CmpI(0, R2);
        asm.Far(Fr30Cond.Eq, "w_done", R12);
        asm.CmpI(1, R2);
        asm.B(Fr30Cond.Ne, "w_lit");
        asm.LdFp(Kind, R0);
        asm.CmpI(1, R0);
        asm.B(Fr30Cond.Ne, "w_lit");
        // 種類 1 の最後の 1 バイト: (直前の読み & keep) | set
        asm.LdubAc(R4, R0);
        asm.AddI(1, R4);
        asm.LdubAc(R4, R11);
        asm.AddI(1, R4);
        asm.LdFp(LastRead, R12);
        asm.And(R12, R0);
        asm.Or(R11, R0);
        asm.Bra("w_put");
        asm.Label("w_lit");
        asm.LdubAc(R4, R0);
        asm.AddI(1, R4);
        asm.Label("w_put");
        asm.St(R0, R9);
        asm.Lsr(1, R10);
        asm.Lsl(1, R10);                     // 制御の bit0 を落とす
        asm.St(R10, R8);
        asm.Call("wait_byte");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "i2c_fail", R12);
        asm.Add2(-1, R2);
        asm.Far(Fr30Cond.Ra, "w_loop", R12);

        asm.Label("w_done");
        // 続けて読むなら再スタート: データ = (アドレス << 1) | 1、制御 = (制御 & ~1) | 0x20
        asm.LdFp(Target, R0);
        asm.CmpI(0, R0);
        asm.B(Fr30Cond.Eq, "r_start");
        asm.CmpI(0, R3);
        asm.B(Fr30Cond.Eq, "r_start");
        asm.Mov(R1, R0);
        asm.AddI(1, R0);
        asm.St(R0, R9);
        asm.Lsr(1, R10);
        asm.Lsl(1, R10);
        asm.Ldi8(0x20, R11);
        asm.Or(R11, R10);
        asm.St(R10, R8);
        asm.Call("wait_byte");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "i2c_fail", R12);
        asm.Ld(R7, R0);
        asm.Ldi8(0x10, R11);
        asm.And(R11, R0);
        asm.Far(Fr30Cond.Ne, "i2c_nack", R12);

        // 読み。残りが 1 なら ACK を返さない (制御の bit3 を落とす)
        asm.Label("r_start");
        asm.StFp(R6, ReadStart);
        asm.CmpI(0, R3);
        asm.Far(Fr30Cond.Eq, "t_stop", R12);
        asm.Label("r_loop");
        asm.Lsr(1, R10);
        asm.Lsl(1, R10);
        asm.Ldi8(8, R11);
        asm.Or(R11, R10);
        asm.CmpI(1, R3);
        asm.B(Fr30Cond.Ne, "r_ack");
        asm.Sub(R11, R10);
        asm.Label("r_ack");
        asm.St(R10, R8);
        asm.Call("wait_byte");
        asm.CmpI(0, R0);
        asm.Far(Fr30Cond.Ne, "i2c_fail", R12);
        asm.Ld(R9, R0);
        asm.StbAc(R0, R6);
        asm.AddI(1, R6);
        asm.Add2(-1, R3);
        asm.Far(Fr30Cond.Ne, "r_loop", R12);
        asm.LdFp(ReadStart, R0);             // この転送で読んだ先頭のバイトを、次の種類 1 の書きに使う
        asm.LdubAc(R0, R0);
        asm.StFp(R0, LastRead);

        // STOP: 制御の bit0・3・4・5 を落とす
        asm.Label("t_stop");
        asm.Ldi8(0x39, R11);
        asm.Or(R11, R10);
        asm.Sub(R11, R10);
        asm.St(R10, R8);
        asm.Add2(-1, R5);
        asm.Far(Fr30Cond.Ra, "t_loop", R12);

        // 失敗: R0 = 結果 (1〜3)。STOP を出して戻る
        asm.Label("i2c_nack");
        asm.Ldi8((uint)I2cNack, R0);
        asm.Label("i2c_fail");
        asm.Ldi8(0x39, R11);
        asm.Or(R11, R10);
        asm.Sub(R11, R10);
        asm.St(R10, R8);
        asm.Bra("i2c_end");
        asm.Label("i2c_done");
        asm.Ldi8((uint)I2cOk, R0);

        // 応答: +4 結果、+8 止まった番号、+12 読んだバイト数
        asm.Label("i2c_end");
        asm.Ldi20(Staging + 4, R12);
        asm.St(R0, R12);
        asm.LdFp(IdleLimit, R1);
        asm.Sub(R5, R1);
        asm.AddI(4, R12);
        asm.St(R1, R12);
        asm.LdFp(ResultStart, R1);
        asm.Mov(R6, R2);
        asm.Sub(R1, R2);
        asm.AddI(4, R12);
        asm.St(R2, R12);
        asm.Far(Fr30Cond.Ra, "leave", R12);

        // 制御の bit0 (1 バイト終わった) が立つまで読む。R0 = 0 (済んだ)・2 (バスエラー、bit7)・3 (時間切れ)。済んだときの制御の値は R10
        asm.Label("wait_byte");
        // 先に、制御の bit0 が 0 になっているのを少しの間 (64 回の読みまで) 確かめる。書いた値が効いて、前の転送の「終わった」の印が消えたことの確認で、
        // 確かめずに bit0 が立つのを待つと、書いた直後の古い bit0 を「終わった」と読み違えるおそれがある。0 が読めなくても (書いた直後にもう終わった)
        // 先へ進む。0 の間に「終わった」の印が立つのを待つのは、次の wb_loop
        asm.Ldi8(64, R12);
        asm.Label("wb_clear");
        asm.Ld(R8, R10);
        asm.Mov(R10, R0);
        asm.Ldi8(1, R11);
        asm.And(R11, R0);
        asm.B(Fr30Cond.Eq, "wb_start");
        asm.Add2(-1, R12);
        asm.B(Fr30Cond.Ne, "wb_clear");
        asm.Label("wb_start");
        asm.Ldi32(0x20000, R12);
        asm.Label("wb_loop");
        asm.Ld(R8, R10);
        asm.Mov(R10, R0);
        asm.Ldi8(0x80, R11);
        asm.And(R11, R0);
        asm.B(Fr30Cond.Ne, "wb_bus");
        asm.Mov(R10, R0);
        asm.Ldi8(1, R11);
        asm.And(R11, R0);
        asm.B(Fr30Cond.Ne, "wb_ok");
        asm.Add2(-1, R12);
        asm.B(Fr30Cond.Ne, "wb_loop");
        asm.Ldi8((uint)I2cTimeout, R0);
        asm.Ret();
        asm.Label("wb_bus");
        asm.Ldi8((uint)I2cBusError, R0);
        asm.Ret();
        asm.Label("wb_ok");
        asm.Ldi8(0, R0);
        asm.Ret();
    }

    /// <summary>
    /// 操作 3・4: カードの UART (0xFEA000〜。<see cref="CardUart"/> と同じレジスタ) で T=1 のブロックを送り、受けたバイトを読む。
    /// ホストが 1 バイトごとに制御転送で書き読みする (<see cref="CardUart.Send"/>・<see cref="CardUart.Read"/>) のと同じ手順を機材の中で実行し、
    /// ECM 1 回で百数十回あった制御転送を数回にする。
    /// **カードの応答は機材の中で待たない。** 待つ間は TS の要求 (操作 1) が通らず、取り込みのリング (192 KiB) が溢れるため。
    /// 応答を待つのはホストで、操作 4 を繰り返し呼んで受けたバイトを読み出す。
    /// <list type="bullet">
    /// <item>操作 3 の要求: +8 ブロックのアドレス (CPU)、+12 長さ。<see cref="CardUart.Send"/> と同じ順に、受けの LRC = 0、送りの LRC = 0、
    ///   各バイトを送りのレジスタへ、状態 = 0x3FF、制御 = 0x200 (256 バイト以上は 0x280)、開始 = 1 と書いて戻る。
    ///   長さ 0 なら UART に触れずに戻る (開くときの確認に使う)。応答: +4 結果 (<see cref="CardOk"/>)、+8 送りのレジスタに書いたバイト数</item>
    /// <item>操作 4 の要求: +8 読む数の上限。受けた数 (0xFEA014 の上位 16 ビット)・上限・<see cref="InlineCardBytes"/> のいちばん小さい数だけ
    ///   受けのレジスタを読み、応答の +16 から並べる。上限 0 なら受けのレジスタを読まない。応答: +4 結果 (<see cref="CardOk"/>)、+8 読んだバイト数</item>
    /// </list>
    /// </summary>
    private static void EmitCard(Fr30Assembler asm)
    {
        asm.Label("card_send");
        asm.Ldi20(Staging + 8, R12);
        asm.Ld(R12, R13);                    // R13 = ブロック (これを基底に、バイトの位置 R4 で読む)
        asm.AddI(4, R12);
        asm.Ld(R12, R5);                     // R5 = 長さ
        asm.Ldi8(0, R4);                     // R4 = 書いたバイト数
        asm.CmpI(0, R5);
        asm.B(Fr30Cond.Eq, "card_reply");
        asm.Ldi8(0, R0);
        asm.Ldi32(CardUart.RxLrc, R12);
        asm.St(R0, R12);
        asm.Ldi32(CardUart.TxLrc, R12);
        asm.St(R0, R12);
        asm.Ldi32(CardUart.Tx, R7);
        asm.Label("cs_byte");
        asm.LdubAc(R4, R0);
        asm.St(R0, R7);
        asm.AddI(1, R4);
        asm.Cmp(R5, R4);
        asm.B(Fr30Cond.Ne, "cs_byte");
        asm.Ldi32(CardUart.Status, R12);
        asm.Ldi(0x3FF, R0);
        asm.St(R0, R12);
        asm.Ldi(0x200, R0);
        asm.Ldi(0x100, R1);
        asm.Cmp(R1, R5);
        asm.B(Fr30Cond.C, "cs_control");     // 256 バイト未満は 0x200
        asm.Ldi(0x280, R0);
        asm.Label("cs_control");
        asm.Ldi32(CardUart.Control, R12);
        asm.St(R0, R12);
        asm.Ldi8(1, R0);
        asm.Ldi32(CardUart.Start, R12);
        asm.St(R0, R12);
        asm.Bra("card_reply");

        asm.Label("card_receive");
        asm.Ldi20(Staging + 8, R12);
        asm.Ld(R12, R5);                     // R5 = 読む数の上限
        asm.Ldi8((uint)InlineCardBytes, R1);
        asm.Cmp(R1, R5);
        asm.B(Fr30Cond.C, "cr_limit");
        asm.Mov(R1, R5);                     // 応答に入る数まで
        asm.Label("cr_limit");
        asm.Ldi32(CardUart.Count, R12);
        asm.Ld(R12, R0);
        asm.Lsr(16, R0);                     // R0 = 受けて読まれていないバイトの数
        asm.Cmp(R5, R0);
        asm.B(Fr30Cond.Nc, "cr_count");
        asm.Mov(R0, R5);
        asm.Label("cr_count");
        asm.Ldi20(InlineCard, R13);          // R13 = 応答の +16 (これを基底に、バイトの位置 R4 で書く)
        asm.Ldi32(CardUart.Rx, R7);
        asm.Ldi8(0, R4);                     // R4 = 読んだバイト数
        asm.Label("cr_byte");
        asm.Cmp(R5, R4);
        asm.B(Fr30Cond.Eq, "card_reply");
        asm.Ld(R7, R0);
        asm.StbAc(R0, R4);
        asm.AddI(1, R4);
        asm.Bra("cr_byte");

        // 応答: +4 結果、+8 書いた・読んだバイト数
        asm.Label("card_reply");
        asm.Ldi8(CardOk, R0);
        asm.Ldi20(Staging + 4, R12);
        asm.St(R0, R12);
        asm.AddI(4, R12);
        asm.St(R4, R12);
        asm.Far(Fr30Cond.Ra, "leave", R12);
    }

    /// <summary>[address] を size バイトで読み、expected と違えば "orig" へ。R0 と R12 だけを使う</summary>
    private static void Check(Fr30Assembler asm, uint address, int size, uint expected)
    {
        asm.Ldi20(address, R12);
        switch (size)
        {
            case 1: asm.Ldub(R12, R0); break;
            case 2: asm.Lduh(R12, R0); break;
            default: asm.Ld(R12, R0); break;
        }
        asm.Ldi(expected, R12);
        asm.Cmp(R12, R0);
        asm.B(Fr30Cond.Ne, "orig");
    }
}
