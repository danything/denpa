using Denpa.Agent;
using static Denpa.Agent.Fr30Reg;

namespace Denpa.Agent.Tests;

/*
 * FR30 のアセンブラ (Fr30.cs)。期待値の語は、同じ並びを binutils 2.44 の fr30-elf-as で組んで objcopy で取り出したもの
 * (道具の出力。コンテナで fr30-elf を組んで突き合わせた)。アセンブラが出すどの形の命令もここに1つずつ並べてある。
 * 命令の振る舞いは Fr30Machine (Fr30Machine.cs の小さな FR30 の真似) でプログラムを動かして確かめる (Mb86h47ProgramsTests.cs)。
 */
public class Fr30Tests
{
    /// <summary>fr30-elf-as に通した並び (Listing もこれと同じ文字列になる)</summary>
    private const string Forms = """
         ldi:8 #0x40, r0
         ldi:8 #0xff, r15
         ldi:20 #0xe9ae6, r12
         ldi:20 #0x80000, r1
         ldi:32 #0xf00000, r1
         ldi:32 #0xb01c0de5, r1
         ld @r1, r0
         lduh @r1, r0
         ldub @r0, r1
         st r4, @r0
         sth r0, @r1
         stb r1, @r0
         ld @(r14, 124), r0
         st r11, @(r14, 124)
         ld @(r14, -192), r0
         st r8, @(r14, -192)
         ld @(r13, r12), r0
         st r2, @(r13, r12)
         mov r8, r0
         add r8, r0
         add #4, r0
         add2 #-1, r5
         add2 #-8, r0
         sub r2, r0
         cmp r0, r4
         cmp #0, r1
         cmp #10, r9
         and r1, r4
         or r1, r4
         lsl #2, r0
         lsl2 #8, r1
         lsl2 #0, r3
         lsr #4, r1
         lsr2 #15, r0
         lsr2 #2, r1
         jmp @r0
         ret
         nop
         st rp, @-r15
         ld @r15+, rp
        top:
         nop
         beq top
         bne fwd
         bc fwd
         bnc fwd
         bn fwd
         bls fwd
         bra fwd
        fwd:
         call top

        """;

    /// <summary>fr30-elf-as の出した語 (上の並びをそのまま)</summary>
    private const string Expected =
        "c400cfff9bec9ae69b8100009f8100f000009f81b01c0de5041005100601140415101601" +
        "21f031fb2d003d0800c010c28b80a680a440a5f5a580ac20aa04a801a8a982149214" +
        "b420b581b503b041b1f0b121970097209fa0178107819fa0e2fee305e404e503e602ee01e000d7f7";

    [Test]
    public async Task どの形の命令も_fr30_elf_as_と同じ語になる()
    {
        var asm = new Fr30Assembler(0);
        asm.Ldi8(0x40, R0);
        asm.Ldi8(0xFF, R15);
        asm.Ldi20(0xE9AE6, R12);
        asm.Ldi20(0x80000, R1);
        asm.Ldi32(0xF00000, R1);
        asm.Ldi32(0xB01C0DE5, R1);
        asm.Ld(R1, R0);
        asm.Lduh(R1, R0);
        asm.Ldub(R0, R1);
        asm.St(R4, R0);
        asm.Sth(R0, R1);
        asm.Stb(R1, R0);
        asm.LdFp(124, R0);
        asm.StFp(R11, 124);
        asm.LdFp(-192, R0);
        asm.StFp(R8, -192);
        asm.LdAc(R12, R0);
        asm.StAc(R2, R12);
        asm.Mov(R8, R0);
        asm.Add(R8, R0);
        asm.AddI(4, R0);
        asm.Add2(-1, R5);
        asm.Add2(-8, R0);
        asm.Sub(R2, R0);
        asm.Cmp(R0, R4);
        asm.CmpI(0, R1);
        asm.CmpI(10, R9);
        asm.And(R1, R4);
        asm.Or(R1, R4);
        asm.Lsl(2, R0);
        asm.Lsl(24, R1);
        asm.Lsl(16, R3);
        asm.Lsr(4, R1);
        asm.Lsr(31, R0);
        asm.Lsr(18, R1);
        asm.Jmp(R0);
        asm.Ret();
        asm.Nop();
        asm.PushRp();
        asm.PopRp();
        asm.Label("top");
        asm.Nop();
        asm.B(Fr30Cond.Eq, "top");
        asm.B(Fr30Cond.Ne, "fwd");
        asm.B(Fr30Cond.C, "fwd");
        asm.B(Fr30Cond.Nc, "fwd");
        asm.B(Fr30Cond.N, "fwd");
        asm.B(Fr30Cond.Ls, "fwd");
        asm.Bra("fwd");
        asm.Label("fwd");
        asm.Call("top");

        await Assert.That(asm.Listing).IsEqualTo(Forms.Replace("\r\n", "\n"));
        var bytes = asm.Words().SelectMany(word => new[] { (byte)(word >> 8), (byte)word }).ToArray();
        await Assert.That(Convert.ToHexStringLower(bytes)).IsEqualTo(Expected);
    }

    [Test]
    public async Task 遠い分岐は逆の条件で飛び越えて_JMP_にする()
    {
        var asm = new Fr30Assembler(0xA0000);
        asm.Label("start");
        for (var i = 0; i < 200; i++) asm.Nop();
        asm.Far(Fr30Cond.Ne, "start", R12);
        var words = asm.Words();
        // BEQ +3 語 (LDI:20 の 2 語と JMP を飛び越える)、LDI:20 #0xA0000, R12、JMP @R12
        await Assert.That(words[200..]).IsEquivalentTo(new ushort[] { 0xE203, 0x9BAC, 0x0000, 0x970C });
        Assert.Throws<InvalidOperationException>(() =>
        {
            var far = new Fr30Assembler(0);
            far.Label("a");
            for (var i = 0; i < 200; i++) far.Nop();
            far.Bra("a");
            far.Words();
        });
    }

    [Test]
    public async Task 語は_32_ビットに詰めて奇数なら_NOP_で埋める()
    {
        var asm = new Fr30Assembler(0);
        asm.Ret();
        await Assert.That(asm.Words32()).IsEquivalentTo(new uint[] { 0x97209FA0 });
    }
}
