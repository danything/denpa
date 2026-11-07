using static Denpa.Agent.Fr30Reg;

namespace Denpa.Agent;

/*
 * PIX-DT295 の機材の中で動かす FR30 のプログラム (自前方式)。節の番号は
 * 仕様書 (dt295-resident/spec.md) のもの。常駐ファームウェアは入れず、TS を取り込みのリングから USB の bulk IN へ送る小さなループだけを
 * 機材に置く。チューナーの設定と I2C はホストが 0xBC のメモリ要求で行う (Dt295NativeProbe.cs)。
 *
 * **ループは主 CPU の boot0 の hook に置く。補助 CPU には置かない。** 理由は 3 つ。
 * 1. ループが触るもの (リングの先頭 0x8138EC00、書き込み位置 0x1902028、読み出し位置 0x190202C、FIFO 0xFDBD84・0xFDBD0C、
 *    保護レジスタ 0xFD814C) は、仕様書 8.2・8.3 がすべて主 CPU から見たアドレスで書いている。補助 CPU から見た SDRAM とリングの
 *    アドレスは仕様書に無い。補助 CPU の USB レジスタは 0x1684000 台で、主 CPU の 0xFD8000 台と同じものと見るのは「推定」(仕様書 1.2・8 章冒頭)
 * 2. 補助 CPU を使うには、機材のメモリへ圧縮コードを伸長して起動する手順 (仕様書 6 章) が要る。起動後の郵便受けの応答や USB の割り込みの扱いは
 *    「未確認」(仕様書 11.1)。主 CPU に置けば、この手順を再現しなくて済む
 * 3. 主 CPU の hook (仕様書 3.2) は、書き込む場所・入口の条件・戻り先 (状態段 0xEA8C8) まで仕様書にある
 *
 * 欠点: 主 CPU は boot0 が受けた制御転送の処理の中でループを回すので、ループの間は制御転送が機材に通らない (仕様書 1.1 に
 * 「常駐イメージには主ループも割り込み処理も無い」とあるのと同じ場所で動く)。そこで 1 回の要求で送るパケットの数をホストが決め、
 * 数だけ送ったら (または待ち続けて限度に達したら) 状態段へ戻る。ホストは要求と要求の間に制御転送を出せる。
 * リングは 192 KiB で、20 Mbps なら約 80 ms ぶん溜まる。要求の間隔がこれより短ければ取りこぼさない (仕様書に無い。見積もり)。
 *
 * 要求 (制御 OUT。wValue 0x0C7D、wIndex 0x4620 で 0xC4620 へ。仕様書 3.2 と同じ入口。BE32): +0 'DNT1'、+4 操作 (1)、+8 送るパケット数、
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
        asm.LdFp(SavedR8, R8);
        asm.LdFp(SavedR9, R9);
        asm.LdFp(SavedR10, R10);
        asm.LdFp(SavedR11, R11);
        asm.LdFp(SavedR13, R13);
        asm.Ld(R14, R14);
        asm.PopRp();
        asm.Ldi20(StatusStage, R12);
        asm.Jmp(R12);

        var words = asm.Words32();
        var bytes = words.Length * 4;
        if (bytes > Frame - BodyOrigin) throw new InvalidOperationException($"自前のプログラム ({bytes} バイト) が作業域の前に収まりません");

        var hook = new Fr30Assembler(Hook);
        hook.Ldi20(BodyOrigin, R12);
        hook.Jmp(R12);
        hook.Nop();
        var hookBytes = hook.Words().SelectMany(word => new[] { (byte)(word >> 8), (byte)word }).ToArray();
        return new Image(words, bytes, hookBytes, asm.Listing);
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
