using System.Globalization;
using System.Text;

namespace Denpa.Agent;

/*
 * FR30 (富士通 FR ファミリー) の小さなアセンブラ。CECH-ZD1 J のブリッジ (MB86H47A) の中で動かすプログラムを組む (Mb86h47Programs.cs)。
 *
 * 命令の符号化は富士通の公開している FR30 の命令の手引きに従い、命令ごとに binutils の fr30-elf-as の出力と突き合わせた
 * (Fr30Tests.cs の期待値は、その突き合わせで fr30-elf-as が出した語)。使う命令だけを持つ。命令は 16 ビットでビッグエンディアン。
 *
 * 組みながら GNU の書き方の一覧 (Listing) も残すので、プログラム全体を fr30-elf-as に通して突き合わせられる。
 */

/// <summary>FR30 の汎用レジスタ。R13 = AC、R14 = FP、R15 = SP</summary>
public enum Fr30Reg
{
    R0, R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15,
}

/// <summary>条件分岐の条件 (Bcc の下位 4 ビット)</summary>
public enum Fr30Cond
{
    Ra = 0x0, No = 0x1, Eq = 0x2, Ne = 0x3, C = 0x4, Nc = 0x5, N = 0x6, P = 0x7,
    V = 0x8, Nv = 0x9, Lt = 0xA, Ge = 0xB, Le = 0xC, Gt = 0xD, Ls = 0xE, Hi = 0xF,
}

/// <summary>
/// 命令を順に並べて 16 ビットの語にする。ラベルは前にも後ろにも跳べる (最後の <see cref="Words"/> で埋める)。
/// 番地は <see cref="Origin"/> (プログラムを置く所) から数える
/// </summary>
public sealed class Fr30Assembler(uint origin)
{
    private readonly List<ushort> _code = [];
    private readonly Dictionary<string, int> _labels = new(StringComparer.Ordinal);
    private readonly List<(int At, string Label, Func<int, ushort> Encode, string Name)> _fixups = [];
    private readonly StringBuilder _listing = new();
    private int _unique;

    public uint Origin { get; } = origin;

    /// <summary>いまの番地</summary>
    public uint Here => Origin + (uint)(_code.Count * 2);

    /// <summary>GNU の書き方の一覧 (fr30-elf-as に通せる)</summary>
    public string Listing => _listing.ToString();

    /// <summary>同じ部品を何度も組むとき用の、重ならないラベルの名前</summary>
    public string NewLabel(string hint) => $"{hint}_{_unique++}";

    public void Label(string name)
    {
        if (!_labels.TryAdd(name, _code.Count)) throw new InvalidOperationException($"ラベル {name} が2回あります");
        _listing.Append(CultureInfo.InvariantCulture, $"{name}:\n");
    }

    public uint AddressOf(string name) => Origin + (uint)(_labels[name] * 2);

    private void Emit(ushort word, string text)
    {
        _code.Add(word);
        _listing.Append(' ').Append(text).Append('\n');
    }

    private void Emit2(ushort first, ushort second, string text)
    {
        _code.Add(first);
        _code.Add(second);
        _listing.Append(' ').Append(text).Append('\n');
    }

    private static int R(Fr30Reg reg) => (int)reg;

    private static string N(Fr30Reg reg) => $"r{(int)reg}";

    private static string Hex(uint value) => $"0x{value:x}";

    // --- 即値 ---

    /// <summary>LDI:8 #i8, Ri (0〜255)</summary>
    public void Ldi8(uint value, Fr30Reg ri)
    {
        if (value > 0xFF) throw new ArgumentOutOfRangeException(nameof(value));
        Emit((ushort)(0xC000 | (value << 4) | (uint)R(ri)), $"ldi:8 #{Hex(value)}, {N(ri)}");
    }

    /// <summary>LDI:20 #i20, Ri (0〜0xFFFFF)</summary>
    public void Ldi20(uint value, Fr30Reg ri)
    {
        if (value > 0xFFFFF) throw new ArgumentOutOfRangeException(nameof(value));
        Emit2((ushort)(0x9B00 | ((value >> 16) << 4) | (uint)R(ri)), (ushort)value, $"ldi:20 #{Hex(value)}, {N(ri)}");
    }

    /// <summary>いちばん短い LDI で値を入れる</summary>
    public void Ldi(uint value, Fr30Reg ri)
    {
        if (value <= 0xFF) Ldi8(value, ri);
        else if (value <= 0xFFFFF) Ldi20(value, ri);
        else Ldi32(value, ri);
    }

    /// <summary>LDI:32 #i32, Ri (命令の語のあとに値の上位・下位の 16 ビット)</summary>
    public void Ldi32(uint value, Fr30Reg ri)
    {
        _code.Add((ushort)(0x9F80 | R(ri)));
        _code.Add((ushort)(value >> 16));
        _code.Add((ushort)value);
        _listing.Append(CultureInfo.InvariantCulture, $" ldi:32 #{Hex(value)}, {N(ri)}\n");
    }

    // --- 読み書き ---

    public void Ld(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x0400 | (R(rj) << 4) | R(ri)), $"ld @{N(rj)}, {N(ri)}");

    public void Lduh(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x0500 | (R(rj) << 4) | R(ri)), $"lduh @{N(rj)}, {N(ri)}");

    public void Ldub(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x0600 | (R(rj) << 4) | R(ri)), $"ldub @{N(rj)}, {N(ri)}");

    public void St(Fr30Reg ri, Fr30Reg rj) => Emit((ushort)(0x1400 | (R(rj) << 4) | R(ri)), $"st {N(ri)}, @{N(rj)}");

    public void Sth(Fr30Reg ri, Fr30Reg rj) => Emit((ushort)(0x1500 | (R(rj) << 4) | R(ri)), $"sth {N(ri)}, @{N(rj)}");

    public void Stb(Fr30Reg ri, Fr30Reg rj) => Emit((ushort)(0x1600 | (R(rj) << 4) | R(ri)), $"stb {N(ri)}, @{N(rj)}");

    /// <summary>LD @(R13, Rj), Ri (R13 + Rj の番地)</summary>
    public void LdAc(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x0000 | (R(rj) << 4) | R(ri)), $"ld @(r13, {N(rj)}), {N(ri)}");

    /// <summary>ST Ri, @(R13, Rj)</summary>
    public void StAc(Fr30Reg ri, Fr30Reg rj) => Emit((ushort)(0x1000 | (R(rj) << 4) | R(ri)), $"st {N(ri)}, @(r13, {N(rj)})");

    /// <summary>LD @(R14, disp), Ri。disp は 4 の倍数で -512〜508</summary>
    public void LdFp(int disp, Fr30Reg ri) =>
        Emit((ushort)(0x2000 | (Disp(disp, 4, 8) << 4) | R(ri)), $"ld @(r14, {disp}), {N(ri)}");

    /// <summary>ST Ri, @(R14, disp)。disp は 4 の倍数で -512〜508</summary>
    public void StFp(Fr30Reg ri, int disp) =>
        Emit((ushort)(0x3000 | (Disp(disp, 4, 8) << 4) | R(ri)), $"st {N(ri)}, @(r14, {disp})");

    private static int Disp(int disp, int scale, int bits)
    {
        if (disp % scale != 0) throw new ArgumentOutOfRangeException(nameof(disp), $"{disp} は {scale} の倍数ではありません");
        var scaled = disp / scale;
        var limit = 1 << (bits - 1);
        if (scaled < -limit || scaled >= limit) throw new ArgumentOutOfRangeException(nameof(disp));
        return scaled & ((1 << bits) - 1);
    }

    // --- 計算 ---

    public void Mov(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x8B00 | (R(rj) << 4) | R(ri)), $"mov {N(rj)}, {N(ri)}");

    public void Add(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0xA600 | (R(rj) << 4) | R(ri)), $"add {N(rj)}, {N(ri)}");

    /// <summary>ADD #u4, Ri (0〜15)</summary>
    public void AddI(uint value, Fr30Reg ri) => Emit((ushort)(0xA400 | ((int)U4(value) << 4) | R(ri)), $"add #{value}, {N(ri)}");

    /// <summary>ADD2 #-16〜-1, Ri</summary>
    public void Add2(int value, Fr30Reg ri)
    {
        if (value is < -16 or > -1) throw new ArgumentOutOfRangeException(nameof(value));
        Emit((ushort)(0xA500 | ((value & 0xF) << 4) | R(ri)), $"add2 #{value}, {N(ri)}");
    }

    public void Sub(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0xAC00 | (R(rj) << 4) | R(ri)), $"sub {N(rj)}, {N(ri)}");

    public void Cmp(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0xAA00 | (R(rj) << 4) | R(ri)), $"cmp {N(rj)}, {N(ri)}");

    /// <summary>CMP #u4, Ri (0〜15)</summary>
    public void CmpI(uint value, Fr30Reg ri) => Emit((ushort)(0xA800 | ((int)U4(value) << 4) | R(ri)), $"cmp #{value}, {N(ri)}");

    public void And(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x8200 | (R(rj) << 4) | R(ri)), $"and {N(rj)}, {N(ri)}");

    public void Or(Fr30Reg rj, Fr30Reg ri) => Emit((ushort)(0x9200 | (R(rj) << 4) | R(ri)), $"or {N(rj)}, {N(ri)}");

    /// <summary>LSL #0〜31, Ri (16 以上は LSL2)</summary>
    public void Lsl(uint count, Fr30Reg ri) => Shift(0xB4, "lsl", count, ri);

    /// <summary>LSR #0〜31, Ri (16 以上は LSR2)</summary>
    public void Lsr(uint count, Fr30Reg ri) => Shift(0xB0, "lsr", count, ri);

    private void Shift(int op, string name, uint count, Fr30Reg ri)
    {
        if (count > 31) throw new ArgumentOutOfRangeException(nameof(count));
        if (count < 16) Emit((ushort)((op << 8) | ((int)count << 4) | R(ri)), $"{name} #{count}, {N(ri)}");
        else Emit((ushort)(((op + 1) << 8) | ((int)(count - 16) << 4) | R(ri)), $"{name}2 #{count - 16}, {N(ri)}");
    }

    private static uint U4(uint value) => value <= 15 ? value : throw new ArgumentOutOfRangeException(nameof(value));

    // --- 跳ぶ ---

    /// <summary>Bcc label (非遅延)。届くのは -256〜+254 バイト</summary>
    public void B(Fr30Cond cond, string label)
    {
        var name = cond switch
        {
            Fr30Cond.Ra => "bra",
            Fr30Cond.No => "bno",
            _ => "b" + cond.ToString().ToLowerInvariant(),
        };
        _fixups.Add((_code.Count, label, rel =>
        {
            if (rel is < -128 or > 127) throw new InvalidOperationException($"{label} まで遠すぎます ({rel * 2} バイト)");
            return (ushort)(0xE000 | ((int)cond << 8) | (rel & 0xFF));
        }, label));
        Emit(0, $"{name} {label}");
    }

    public void Bra(string label) => B(Fr30Cond.Ra, label);

    /// <summary>CALL label (非遅延)。届くのは -2048〜+2046 バイト。戻り番地は RP に入る</summary>
    public void Call(string label)
    {
        _fixups.Add((_code.Count, label, rel =>
        {
            if (rel is < -1024 or > 1023) throw new InvalidOperationException($"{label} まで遠すぎます ({rel * 2} バイト)");
            return (ushort)(0xD000 | (rel & 0x7FF));
        }, label));
        Emit(0, $"call {label}");
    }

    public void Jmp(Fr30Reg ri) => Emit((ushort)(0x9700 | R(ri)), $"jmp @{N(ri)}");

    /// <summary>LDI:20 #label, Ri (ラベルの番地。0x100000 未満に置くプログラムだけ)</summary>
    public void LdiLabel(string label, Fr30Reg ri)
    {
        _absolutes.Add((_code.Count, label, ri));
        Emit2(0, 0, $"ldi:20 #{label}, {N(ri)}");
    }

    private readonly List<(int At, string Label, Fr30Reg Reg)> _absolutes = [];

    /// <summary>
    /// 遠くへの条件分岐。Bcc は ±256 バイトしか届かないので、逆の条件で飛び越えて <c>LDI:20 #label, scratch</c> と
    /// <c>JMP @scratch</c> にする (scratch は壊れる)
    /// </summary>
    public void Far(Fr30Cond cond, string label, Fr30Reg scratch)
    {
        string? skip = null;
        if (cond != Fr30Cond.Ra)
        {
            skip = NewLabel("far");
            B((Fr30Cond)((int)cond ^ 1), skip);
        }
        LdiLabel(label, scratch);
        Jmp(scratch);
        if (skip is not null) Label(skip);
    }

    public void Ret() => Emit(0x9720, "ret");

    public void Nop() => Emit(0x9FA0, "nop");

    /// <summary>ST RP, @-R15 (戻り番地を積む)</summary>
    public void PushRp() => Emit(0x1781, "st rp, @-r15");

    /// <summary>LD @R15+, RP</summary>
    public void PopRp() => Emit(0x0781, "ld @r15+, rp");

    /// <summary>
    /// 組み上がった 16 ビットの語。分岐の飛び先は PC + 2 + rel × 2 (PC は分岐の命令の番地)
    /// </summary>
    public ushort[] Words()
    {
        var code = _code.ToArray();
        foreach (var (at, label, encode, _) in _fixups)
        {
            if (!_labels.TryGetValue(label, out var target)) throw new InvalidOperationException($"ラベル {label} がありません");
            code[at] = encode(target - (at + 1));
        }
        foreach (var (at, label, reg) in _absolutes)
        {
            if (!_labels.TryGetValue(label, out var target)) throw new InvalidOperationException($"ラベル {label} がありません");
            var address = Origin + (uint)(target * 2);
            if (address > 0xFFFFF) throw new InvalidOperationException($"{label} の番地 0x{address:X} は LDI:20 に入りません");
            code[at] = (ushort)(0x9B00 | ((address >> 16) << 4) | (uint)R(reg));
            code[at + 1] = (ushort)address;
        }
        return code;
    }

    /// <summary>32 ビットの語に詰める (メモリ要求で書く単位)。奇数なら NOP で埋める</summary>
    public uint[] Words32()
    {
        var code = Words();
        var words = new uint[(code.Length + 1) / 2];
        for (var i = 0; i < words.Length; i++)
        {
            var low = 2 * i + 1 < code.Length ? code[2 * i + 1] : (ushort)0x9FA0;
            words[i] = ((uint)code[2 * i] << 16) | low;
        }
        return words;
    }
}
