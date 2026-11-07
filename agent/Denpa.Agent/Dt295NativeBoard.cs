using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 自前方式 (dt295:) の基板の設定: チップのクロック・端子、USB の端点、TS の取り込みブロック。節の番号は仕様書 (dt295-resident/spec.md) のもの。
/// 常駐方式では常駐イメージと補助 CPU がやる設定を、ホストが 0xBC のメモリ要求 (<see cref="Dt295NativeLink"/>) で順に書く。
///
/// 補助 CPU の起動 (仕様書 6 章の「補助 CPU の起動」) は再現しない。補助 CPU がやる仕事のうち、USB のレジスタの設定 (仕様書 8.4) と
/// I2C の準備 (仕様書 6.4) はホストが書く。補助 CPU の RAM と 0x1700000 のブロックには触らない。
/// 16 ビットのレジスタ (仕様書が「16 ビット」と書いたもの) の読み書きは <see cref="Dt295NativeLink.Read16"/> と <see cref="Dt295NativeLink.Write16"/>。
/// 仕様書が 16 ビットと明記していない 0xF10014・0xF10018・0xF10118・0xF1011C は、値が 16 ビットに収まる (0xFFFF・0xD082 など) ことから 16 ビットとした。仕様書に無い
/// </summary>
public sealed class Dt295NativeBoard(Dt295NativeLink link, Action<string>? log = null, Dt295Timeline? timeline = null)
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    /// <summary>INITIALIZE (仕様書 6 章の 0x80397100) の前の値。<see cref="Restore"/> で戻す</summary>
    public sealed class Saved
    {
        public ushort? R10118, R1011C, R00F10004, R00F10018, R00F10014, RF1001C;
        public uint? R1600000, R1600004, R1600404, R00F001F0;
    }

    // ---------------------------------------------------------------------
    // 起動直後の確認と外部メモリー (仕様書 3.1・3.3)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 機材が起動直後の状態か (仕様書 3.1: 0x82008 の 2 バイトが 0、hook が元のまま)。
    /// 違えば <see cref="Dt295NativeWarmException"/> (途中で止まった自前の hook が残っている、ほかのファームウェアが動いたなど)。
    /// 正常に閉じた自前方式は hook を戻すので、続けて開き直せる (実機で確かめた)
    /// </summary>
    public void Preflight()
    {
        var state = link.Read16(Dt295NativeLink.StateRegister);
        var hook = link.ReadBytes(Dt295NativePrograms.Hook, 8);
        if (!hook.AsSpan().SequenceEqual(Dt295NativePrograms.OriginalHook))
        {
            var ours = hook.AsSpan().SequenceEqual(Dt295NativePrograms.Build().HookBytes);
            throw new Dt295NativeWarmException(ours
                ? "前の実行の自前の hook が残っています"
                : $"boot0 の hook が元の値ではありません ({Convert.ToHexString(hook)})");
        }
        if (state != 0) throw new Dt295NativeWarmException($"機材が起動直後の状態ではありません (状態 0x{state:X4})");
    }

    /// <summary>
    /// 0xFD0090 (16 ビット) の手順 (仕様書 3.3 の 0xE1000)。外部メモリーの有効化と「推定」されている。
    /// bit1 を立て、bit4 が 0 になるまで読み、bit1 を落として bit0 を立てる。仕様書は最大 100000 回読むと書く。
    /// ホストの読みは 1 回が制御転送 1 回なので、回数でなく 2 秒を上限にする (仕様書に無い)。
    /// 仕様書の「= 0x0000」は初期値の記録と読み、書き込みにはしない
    /// </summary>
    public void EnableExternalMemory()
    {
        const uint Register = 0xFD0090;
        var value = link.Read16(Register);
        link.Write16(Register, (ushort)(value | 0x0002));
        var until = _clock.Elapsed + TimeSpan.FromSeconds(2);
        var polls = 1;
        while ((link.Read16(Register) & 0x0010) != 0)
        {
            polls++;
            if (_clock.Elapsed > until) throw new Dt295NativeException("0xFD0090 の bit4 が 2 秒たっても落ちません");
        }
        timeline?.Begin($"0xFD0090 の bit4 が落ちるまでの読み {polls} 回", "仕様書 3.3").Dispose();
        link.Write16(Register, (ushort)(link.Read16(Register) & ~0x0002));
        link.Write16(Register, (ushort)(link.Read16(Register) | 0x0001));
    }

    // ---------------------------------------------------------------------
    // 自前の body の導入 (仕様書 3.2)
    // ---------------------------------------------------------------------

    /// <summary>
    /// body と作業域を書いて読み戻し、最後に hook を書く (仕様書 3.2。hook を書いた時点から、入口の条件が合う要求は body に入る)。
    /// 作業域は 0 にする (読み出し位置 0・未整列)
    /// </summary>
    public void InstallBody(Dt295NativePrograms.Image image)
    {
        var body = image.Words.SelectMany(word => new[] { (byte)(word >> 24), (byte)(word >> 16), (byte)(word >> 8), (byte)word }).ToArray();
        link.WriteBytes(Dt295NativePrograms.BodyOrigin, body);
        link.WriteBytes(Dt295NativePrograms.Frame, new byte[Dt295NativePrograms.FrameBytes]);
        if (!link.ReadBytes(Dt295NativePrograms.BodyOrigin, body.Length).AsSpan().SequenceEqual(body)) throw new Dt295NativeException("書いた body が読み戻しと違います");
        link.WriteBytes(Dt295NativePrograms.Hook, image.HookBytes);
        if (!link.ReadBytes(Dt295NativePrograms.Hook, 8).AsSpan().SequenceEqual(image.HookBytes)) throw new Dt295NativeException("書いた hook が読み戻しと違います");
    }

    /// <summary>hook を元に戻す</summary>
    public void RemoveHook() => link.WriteBytes(Dt295NativePrograms.Hook, Dt295NativePrograms.OriginalHook);

    // ---------------------------------------------------------------------
    // INITIALIZE (仕様書 6 章の 0x80397100)
    // ---------------------------------------------------------------------

    /// <summary>
    /// チップのクロック・端子の設定。仕様書 6 章の手順 1〜12 を順に。各書き込みは読み戻して確かめる。
    /// どれかが合わなければ、保存した値を逆の順に戻して <see cref="Dt295NativeException"/>
    /// 値を読む順も仕様書のとおり。0x1600000 のブロックは 0xF10118・0xF1011C を書く (手順 2・3) まで止まっていて 0 しか読めないので、
    /// 手順 4 の前に読まない。0xF001F0・0xF10004・0xF10018・0xF10014 は手順 7 で読む
    /// </summary>
    public Saved Initialize()
    {
        var saved = new Saved();
        using var phases = new Dt295Timeline.Phases(timeline);
        try
        {
            // 1〜3
            phases.Next("手順 1〜3 (0xF10118・0xF1011C)", "仕様書 6 章。書いて読み戻す");
            saved.R10118 = link.Read16(0xF10118);
            saved.R1011C = link.Read16(0xF1011C);
            Check16(0xF10118, 0xFFFF);
            Check16(0xF1011C, (ushort)((saved.R1011C.Value & 0xFA1F) | 0x0580));
            // 4: 0x1600000・0x1600004 の値が想定どおりでなければ断る (仕様書は -2600)
            phases.Next("手順 4〜5 (0x1600000 のブロックを読む・0x1600404)", "仕様書 6 章");
            saved.R1600000 = link.Read32(0x1600000);
            saved.R1600004 = link.Read32(0x1600004);
            saved.R1600404 = link.Read32(0x1600404);
            if (saved.R1600000 != 0x000200FF || saved.R1600004 != 0x01000000)
            {
                throw new Dt295NativeException($"0x1600000 = 0x{saved.R1600000:X8}、0x1600004 = 0x{saved.R1600004:X8} が想定 (0x000200FF・0x01000000) と違います");
            }
            // 5
            Check32(0x1600404, saved.R1600404.Value | 0x00040000);
            // 6: 副ブロックを止めておく
            phases.Next("手順 6 (副ブロックを止める)", "仕様書 6 章");
            link.Write32(0x1600004, 0xFFFFFFFF);
            link.Write32(0x1600000, 0xFFFFFFFF);
            link.Write32(0x1600004, 0x00800000);
            if (link.Read32(0x1600004) != 0x00800000 || (link.Read32(0x1600000) & 0x20000) == 0)
            {
                throw new Dt295NativeException("0x1600000 のブロックを止められません (0x1600004 が 0x00800000 でないか、0x1600000 の bit17 が 0)");
            }
            // 7
            phases.Next("手順 7〜9 (0xF001F0 の 4 回の書き)", "仕様書 6 章。書くたびに読み戻す");
            saved.R00F001F0 = link.Read32(0xF001F0);
            saved.R00F10004 = link.Read16(0xF10004);
            saved.R00F10018 = link.Read16(0xF10018);
            saved.R00F10014 = link.Read16(0xF10014);
            var sF001F0 = saved.R00F001F0.Value;
            // 8: 値 A・B・C を決める。bit14 が 1 の枝 (A = bit12、B = bit10、C = bit11) は、ビットの数え方が仕様書の
            // 観測と合わない (下の bit9 と同じ)。実機の 0xF001F0 は設定の前に 0 (bit14 = 0) だったので、1 の枝は試さずに止める
            if ((sF001F0 & 0x4000) != 0)
            {
                throw new Dt295NativeException($"0xF001F0 = 0x{sF001F0:X8} の bit14 が 1 です。仕様書の観測は bit14 = 0 の枝だけで、1 の枝のビットの数え方が不明なので試しません");
            }
            // 0xF10004 は 16 ビットで、4 の倍数のアドレスでは上半分。実機の読み値 0x8A010000 は 0x8A01 → (0x8A01 >> 10) & 3 = 2 = DT295
            var strap = (saved.R00F10004.Value >> 10) & 3;
            bool a = strap != 0, b = strap == 1, c = strap == 2;
            // 9: bit28 = A、bit27 = C、bit26 = B、続けて「bit9」。仕様書の観測 (0x10000000 → 0x18000000 → 0x1A000000) で最後に立つのは
            // 0x02000000 (bit25) で、bit9 (0x200) ではない。観測のほうに合わせて 0x02000000 を立てる (仕様書の文と観測が合わない所)
            var value = sF001F0;
            value = SetBit(value, 28, a);
            Check32(0xF001F0, value);
            value = SetBit(value, 27, c);
            Check32(0xF001F0, value);
            value = SetBit(value, 26, b);
            Check32(0xF001F0, value);
            value = SetBit(value, 25, true);
            Check32(0xF001F0, value);
            // 10〜12
            phases.Next("手順 10〜12 (0xF10014・0xF10018)", "仕様書 6 章。書くたびに読み戻す");
            var r14 = saved.R00F10014.Value;
            var r18 = saved.R00F10018.Value;
            if (a)
            {
                r14 = (ushort)(r14 & 0xFF9F);
                Check16(0xF10014, r14);
                r18 = (ushort)(r18 & ~0x80);
                Check16(0xF10018, r18);
                r14 = (ushort)(r14 | 0x80);
                Check16(0xF10014, r14);
            }
            r14 = (ushort)(r14 & ~0x200);
            Check16(0xF10014, r14);
            r14 = (ushort)(r14 | 0xD000);
            Check16(0xF10014, r14);
            // 12: 0xF10014 |= 2 と 0xF10018 &= ~2 を続けて書いて、両方を確かめる
            r14 = (ushort)(r14 | 2);
            r18 = (ushort)(r18 & ~2);
            link.Write16(0xF10014, r14);
            link.Write16(0xF10018, r18);
            if (link.Read16(0xF10014) != r14 || link.Read16(0xF10018) != r18) throw new Dt295NativeException("0xF10014・0xF10018 の最後の書き込みが読み戻しと違います");
            log?.Invoke($"チップの設定: 0xF001F0 = 0x{value:X8}、0xF10014 = 0x{r14:X4}、0xF10018 = 0x{r18:X4}");
            phases.Next("0xF1001C", "仕様書に無い。実機の観測");
            // 0xF1001C (16 ビット。上半分): 仕様書に記述が無い。実機の常駐イメージは INITIALIZE で 0x7FFD0000 から 0x2F7D0000 にした
            // (0x50800000 を落とした)。I2C のブロックを動かすクロックかリセットのゲートと見立てた試し (推定)。読み戻しは記録に出すだけ
            saved.RF1001C = link.Read16(0xF1001C);
            link.Write16(0xF1001C, (ushort)(saved.RF1001C.Value & ~0x5080));
            log?.Invoke($"0xF1001C: 0x{saved.RF1001C.Value:X4}0000 の 0x50800000 を落として 0x{link.Read32(0xF1001C):X8} が読めました");
            return saved;
        }
        catch (Dt295NativeException)
        {
            Restore(saved);
            throw;
        }
    }

    /// <summary>0xF10080〜0xF10098 の 7 語 (4 バイトずつ)</summary>
    private static readonly uint[] WordsF10080 = [0xF10080, 0xF10084, 0xF10088, 0xF1008C, 0xF10090, 0xF10094, 0xF10098];

    /// <summary>
    /// 0xF10080〜0xF10098 の 7 語に 0x00010000 を書く (32 ビットの書き込み。上半分が 0x0001、下半分が 0)。
    /// 仕様書に無い。実機の常駐イメージが、イメージを書き込む間 (BLOCK。INITIALIZE の前) に同じ値にしたのを観測した
    /// (--dt295-probe --watch-regs と --snap)。INITIALIZE の前に呼ぶ。
    /// **この語は読まない。** 実機で 0xF10080〜0xF100FF を読むと、常駐イメージが時間切れ (-2603) になった (主 CPU と補助 CPU の
    /// 受け渡しの旗のように、読むと状態が動くらしい)。書く前の値も、書いたあとの読み戻しもしない。元の値は 0 とみなして戻す。
    /// 書き込み自体が操作かもしれないので、この書き込みが正しいかは決まっていない (観測の値に合わせただけ)
    /// </summary>
    public void SetUpF10080()
    {
        foreach (var address in WordsF10080) link.Write32(address, 0x00010000);
        log?.Invoke("0xF10080〜0xF10098 に 0x00010000 を書きました (この語は読むと常駐イメージが壊れるので、読み戻しません)");
    }

    /// <summary><see cref="SetUpF10080"/> の語を 0 に戻す (冷えた機材の値。読んで確かめない)</summary>
    public void RestoreF10080()
    {
        foreach (var address in WordsF10080) link.Write32(address, 0);
    }

    /// <summary>
    /// 0xF10114 のビット 21 (0x00200000) を足す (読み・足す・書き)。仕様書に 0xF10114 の記述は無い。実機の常駐イメージが I2C のブロックを動かす
    /// SERVICE で 0x80000000 から 0x80200000 にした (回す写し)。I2C の準備の直前に呼ぶ。読み戻しは記録に出し、失敗にはしない。
    /// 元の値を返すので、終わりに <see cref="RestoreF10114"/> で戻す
    /// </summary>
    public uint SetUpF10114()
    {
        var before = link.Read32(0xF10114);
        link.Write32(0xF10114, before | 0x00200000);
        log?.Invoke($"0xF10114: 0x{before:X8} に 0x00200000 を足して書き、0x{link.Read32(0xF10114):X8} が読めました");
        return before;
    }

    public void RestoreF10114(uint before) => link.Write32(0xF10114, before);

    /// <summary>
    /// INITIALIZE のあとの 0xF10018 = 0x0002 (16 ビット。仕様書 6 章「続く SERVICE で 0xF10018 = 0x0002」)。実機の常駐イメージも、INITIALIZE のあとの
    /// SERVICE で 0xF10018 を 0 から 0x00020000 (上半分が 0x0002) にした。INITIALIZE の手順 12 は 0xF10018 の bit1 を落とすので、その後に立てる。
    /// 終わりの <see cref="Restore"/> が、保存した値に戻す
    /// </summary>
    public void EnableAfterInitialize()
    {
        link.Write16(0xF10018, 0x0002);
        log?.Invoke($"0xF10018 = 0x0002 を書いて 0x{link.Read32(0xF10018):X8} が読めました");
        // 実機の常駐イメージは、同じ SERVICE で 0xF1001C も 0x2F7D0000 から 0x2F7F0000 (0x00020000 を立てる) にした。仕様書に無い (推定)
        link.Write16(0xF1001C, (ushort)(link.Read16(0xF1001C) | 0x0002));
        log?.Invoke($"0xF1001C |= 0x00020000 を書いて 0x{link.Read32(0xF1001C):X8} が読めました");
    }

    private static uint SetBit(uint value, int bit, bool on) => on ? value | (1u << bit) : value & ~(1u << bit);

    /// <summary>保存した値を書き戻す (仕様書 6 章の 0x80396F90 と同じ順: 0xF10018 → 0xF10014 → 0xF001F0 → 0x1600004・0x1600000 → 0x1600404 → 0xF1011C → 0xF10118)</summary>
    public void Restore(Saved saved)
    {
        // 読めていなかった値(手順がそこまで進まなかったもの)は書かない
        // 0xF1001C は仕様書の戻しの順に無い。最後に書いたものなので最初に戻す (実機の常駐イメージも SHUTDOWN で冷えた値に戻した)
        if (saved.RF1001C is { } r1c0) link.Write16(0xF1001C, r1c0);
        if (saved.R00F10018 is { } r18) link.Write16(0xF10018, r18);
        if (saved.R00F10014 is { } r14) link.Write16(0xF10014, r14);
        if (saved.R00F001F0 is { } f1f0) link.Write32(0xF001F0, f1f0);
        if (saved.R1600004 is { } r4) link.Write32(0x1600004, r4);
        if (saved.R1600000 is { } r0) link.Write32(0x1600000, r0);
        if (saved.R1600404 is { } r404) link.Write32(0x1600404, r404);
        if (saved.R1011C is { } r1c) link.Write16(0xF1011C, r1c);
        if (saved.R10118 is { } r118) link.Write16(0xF10118, r118);
    }

    private void Check16(uint address, ushort value)
    {
        link.Write16(address, value);
        var back = link.Read16(address);
        if (back != value) throw new Dt295NativeException($"0x{address:X} に 0x{value:X4} を書いたが 0x{back:X4} が読めた");
    }

    private void Check32(uint address, uint value)
    {
        link.Write32(address, value);
        var back = link.Read32(address);
        if (back != value) throw new Dt295NativeException($"0x{address:X} に 0x{value:X8} を書いたが 0x{back:X8} が読めた");
    }

    // ---------------------------------------------------------------------
    // USB のレジスタ (仕様書 8.4。常駐方式では補助 CPU の起動の中でやる設定)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 仕様書 8.4 の 1〜7 を順に。保護レジスタ 0xFD814C に対象の組の番号 (1・2・6・8) を書いてから対象を書き、終わったら 0xF に戻す。
    /// 元の値を読んで保存してから書き、読み戻しが合わなければ保存した値を戻して失敗する。
    /// 補助 CPU の割り込み・端点の設定は書かない (本体のコメント)
    /// </summary>
    public void SetUpUsb()
    {
        // 読み戻しの比べ方: 仕様書に無い (比べるビットが書かれていない。実機で 0xFDBD14 の 0x1004 は 0 を書いても残った)。
        // 書く前の値と書いた値で違うビット (変えようとしたビット) が、読み戻しで 1 つも変わっていなければ失敗。
        // 一部だけ変わった (読み取り専用らしいビットが残った) ときは通し、読み戻しの全体を記録に出す
        void Verify(uint address, uint before, uint value)
        {
            var back = link.Read32(address);
            if (back == value) return;
            var tried = before ^ value;
            if (tried != 0 && ((back ^ before) & tried) == 0)
            {
                throw new Dt295NativeException($"0x{address:X} に 0x{value:X} を書いたが読み戻しが 0x{back:X} で、変えようとしたビットが変わっていません (書く前 0x{before:X})");
            }
            log?.Invoke($"0x{address:X}: 0x{value:X} を書いて 0x{back:X} が読めた (書く前 0x{before:X}。違うビットは変えようとしなかったか、変わらなかった)");
        }
        var saved = new List<(uint Address, uint Value)>();
        uint Original(uint address)
        {
            var value = link.Read32(address);
            if (saved.All(item => item.Address != address)) saved.Add((address, value));
            return value;
        }
        void Put(uint group, uint address, uint value, bool verify = true)
        {
            var before = Original(address);
            link.Write32(Dt295NativePrograms.Protect, group);
            link.Write32(address, value);
            link.Write32(Dt295NativePrograms.Protect, 0xF);
            if (verify) Verify(address, before, value);
        }

        try
        {
            // 主 CPU の自前方式に要るものだけを書く。bulk IN の端点 (0xFDBD08・0C・84) の設定と有効化 (0xFDBC04・0xFDBC14)。
            // 仕様書 8.4 の 2 と 6・7 の 0xFDBC14 がそれ (0xFDBC14 の 0x84 は、8.3.1 の開始が bit1 と bit17 を落とす元の値)。
            Put(1, 0xFDBC04, 0x85000000);                              // 8.4 の 2
            Put(8, 0xFDBC14, 0x04);                                    // 8.4 の 6
            Put(2, 0xFDBC14, 0x04);
            Put(8, 0xFDBC14, 0x84);                                    // 8.4 の 7
            Put(2, 0xFDBC14, 0x84);
            // 書かないもの (仕様書に無い判断。実機で 0xFD8010 = 0x08080000 を書いたあと、制御転送がすべて時間切れになった):
            // - 割り込み・クロックの設定: 0xFD808C (8.4 の 1)、0xFD8300・0xFD8320・0xFD8010・0xFD8014 (8.4 の 5)。
            //   仕様書は補助 CPU が起動のときに USB と I2C の割り込みを受け持つための設定として書いている。
            //   自前方式は、TS を主 CPU の hook の中で送り (割り込みを使わない)、I2C を制御の bit0 を読んで待つので要らない
            // - 補助 CPU の端点 0xFDBD10・14・18・1C・38 (8.4 の 3・6・7) と 0xFDBC0C (8.4 の 4。読んで同じ値を書くだけ)。
            //   TS の端点は主 CPU が 0xFDBD08 の組を 8.3.1 で自分で設定する。
            //   これで EP 0x81 から TS が出なければ、最初に疑うのはここ (0xFDBD10・0xFDBD38 のバッファアドレス 0x00FF6000 など)
        }
        catch (Dt295NativeException)
        {
            link.Write32(Dt295NativePrograms.Protect, 0xF);
            foreach (var (address, value) in saved.AsEnumerable().Reverse()) link.Write32(address, value);
            throw;
        }
    }

    // ---------------------------------------------------------------------
    // TS の端点 (仕様書 8.3.1。端点の組 0xFDBD08・0xFDBD0C・0xFDBD84 = 0x81 と推定)
    // ---------------------------------------------------------------------

    /// <summary>端点の元の値。<see cref="StopEndpoint"/> で戻す</summary>
    public sealed record EndpointSaved(uint R14, uint R08);

    public EndpointSaved StartEndpoint()
    {
        // 1: 保護レジスタは 0xF のはず
        var protect = link.Read32(Dt295NativePrograms.Protect);
        if (protect != 0xF) throw new Dt295NativeException($"0xFD814C = 0x{protect:X} が 0xF ではありません");
        var saved14 = link.Read32(0xFDBC14);
        var saved08 = link.Read32(0xFDBD08);
        // 2: リセットと推定
        Guarded(8, 0xFDBD08, 1);
        // 3: バッファアドレスと推定。読んで同じ値を書く (どの保護の値の下かは仕様書に無い。6 の下で続けて書く)
        link.Write32(Dt295NativePrograms.Protect, 6);
        link.Write32(0xFDBD08, 0x00FF6000);
        var buffer = link.Read32(0xFDBD08);
        link.Write32(0xFDBD08, buffer);
        link.Write32(Dt295NativePrograms.Protect, 0xF);
        // 4: 0xFDBC14 から bit1 と bit17 を落とす。同じ値を 2 と 8 の両方で書く
        var enable = saved14 & 0xFFFDFFFD;
        Guarded(2, 0xFDBC14, enable);
        Guarded(8, 0xFDBC14, enable);
        log?.Invoke($"端点: 0xFDBC14 = 0x{saved14:X} → 0x{link.Read32(0xFDBC14):X}、0xFDBD08 = 0x{link.Read32(0xFDBD08):X}");
        return new EndpointSaved(saved14, saved08);
    }

    /// <summary>端点を止める (仕様書 8.3.1 の「停止」を番号 0 の組だけ)</summary>
    public void StopEndpoint(EndpointSaved saved)
    {
        Guarded(8, 0xFDBD08, 1);
        Guarded(6, 0xFDBD08, saved.R08);
        Guarded(2, 0xFDBC14, saved.R14);
        Guarded(8, 0xFDBC14, saved.R14);
    }

    private void Guarded(uint group, uint address, uint value)
    {
        link.Write32(Dt295NativePrograms.Protect, group);
        link.Write32(address, value);
        link.Write32(Dt295NativePrograms.Protect, 0xF);
    }

    // ---------------------------------------------------------------------
    // TS の取り込み (仕様書 8.1)
    // ---------------------------------------------------------------------

    /// <summary>レジスタ表 (仕様書 8.1.2 の 28 項目。アドレス、値、幅)。#0 と #1 は保存と戻しだけで、設定では書かない</summary>
    private static readonly (uint Address, uint Value, int Width)[] CaptureTable =
    [
        (0x1900000, 0, 4), (0x1900004, 0, 4), (0x1901040, 0, 4), (0x1901064, 0, 4), (0x19010A0, 0, 4), (0x19010A4, 0, 4), (0x19010A8, 0, 4),
        (0x1901000, 0x0600, 2), (0x1901020, 0x02000000, 4), (0x1901004, 0x04000000, 4), (0x1901002, 0x0000, 2),
        (0x1901044, 0x00BC0000, 4), (0x1901048, 0x47000000, 4), (0x190104C, 0x00FFFFFF, 4), (0x1901050, 0, 4), (0x1901060, 0, 4),
        (0x1901080, 0x01000000, 4), (0x1901088, 0, 4), (0x190108C, 0xFFFFFFFF, 4), (0x1901084, 0, 4), (0x1901090, 0x01000000, 4),
        (0x1902020, Dt295NativePrograms.RingPhysical, 4), (0x1902024, Dt295NativePrograms.RingLength, 4), (0x1902028, 0, 4),
        (0x190202C, 0, 4), (0x1902030, 0, 4), (0x1902000, 0x03020300, 4), (0xF12788, 0, 2),
    ];

    /// <summary>0x1902010 に書く開始・停止の値 (実機の観測。仕様書 8.1.4 の 0x200・0x400 は書いても 0 と読めて TS が出ない)</summary>
    private const uint CaptureStartCommand = 0x02000000, CaptureStopCommand = 0x04000000;

    /// <summary>
    /// 機材のプログラムが要求をまたいで持つ状態 (読み出し位置・パケット内位置・揃え位置・揃えたか。Dt295NativePrograms の作業域) を 0 に戻す。
    /// 取り込みを設定し直すと書き込み位置・読み出し位置が 0 に戻るので、前の選局の状態を持ち越すと、リングの古い中身を先に送ってしまう。
    /// 取り込みを始める前 (要求を出す前) に呼ぶ
    /// </summary>
    public void ResetPumpState() => link.WriteBytes(Dt295NativePrograms.Frame + Dt295NativePrograms.StateRp, new byte[16]);

    /// <summary>取り込みの元の値</summary>
    public sealed record CaptureSaved(uint[] Table, uint R1900404, uint R1900020 = 0);

    private uint ReadWidth(uint address, int width) => width == 2 ? link.Read16(address) : link.Read32(address);

    private void WriteWidth(uint address, uint value, int width)
    {
        if (width == 2) link.Write16(address, (ushort)value);
        else link.Write32(address, value);
    }

    /// <summary>取り込みの設定 (仕様書 8.1.3)。書いて読み戻して比べる。違えば元に戻して失敗</summary>
    public CaptureSaved ConfigureCapture()
    {
        if (link.Read32(0x1902010) != 0) throw new Dt295NativeException("0x1902010 が 0 ではありません (取り込みが動いている)");
        var r404 = link.Read32(0x1900404);
        link.Write32(0x1900404, r404 | 0x40000);
        var original = CaptureTable.Select(item => ReadWidth(item.Address, item.Width)).ToArray();
        var saved = new CaptureSaved(original, r404, link.Read32(0x1900020));
        try
        {
            link.Write32(0x1900004, 0x001F11FF);
            link.Write32(0x1900000, 0x3002FFFF);
            link.Write32(0x1900000, 0x00020000);
            link.Write32(0x1900004, 0x00001100);
            // 0x1900020: 仕様書の表に無い。実機の常駐イメージは、取り込みを始めるときに 0 から 0x22000200 にした (自前方式は 0x02000200 のままで bit29 が無かった)
            link.Write32(0x1900020, 0x22000200);
            log?.Invoke($"0x1900020 = 0x22000200 を書いて 0x{link.Read32(0x1900020):X8} が読めました");
            for (var i = 2; i < CaptureTable.Length; i++)
            {
                var (address, value, width) = CaptureTable[i];
                WriteWidth(address, value, width);
                var back = ReadWidth(address, width);
                // 変えようとしたビットが 1 つも変わらなければ失敗。一部だけなら通す (SetUpUsb の読み戻しと同じ。仕様書に比べるビットが無い)
                var tried = original[i] ^ value;
                if (back != value && tried != 0 && ((back ^ original[i]) & tried) == 0)
                {
                    throw new Dt295NativeException($"取り込みの表 #{i} (0x{address:X}) に 0x{value:X} を書いたが 0x{back:X} が読めた (書く前 0x{original[i]:X})");
                }
                if (back != value) log?.Invoke($"取り込みの表 #{i} (0x{address:X}): 0x{value:X} を書いて 0x{back:X} が読めた");
            }
            link.Write16(0x1901000, 0x0607);
            link.Write32(0x1901040, 0);
            link.Write32(0x1901020, 0);
            link.Write32(0x1901040, 0x03000000);
            link.Write32(0x19010A4, 0x13170400);
            return saved;
        }
        catch (Dt295NativeException)
        {
            RestoreCapture(saved);
            throw;
        }
    }

    /// <summary>
    /// 取り込みを始める。**0x1902010 に書く値は 0x02000000 (既定)。** 仕様書 8.1.4 は 0x00000200 と書くが、それを書いても
    /// 0x1902010 は 0 のままでリングに何も書かれなかった (実機)。実機の常駐イメージが取り込みを始めたとき、0x1902010 は 0x02000000 になった。
    /// 仕様書 8.1.4 の 0x200 と、5.1 の STOP の 0x04000000 は、バイトの並びが違う書き方 (5.1 と表の値と同じ並びの 0x02000000 を使う)。
    /// リングの先頭・長さ・読み出し位置を読んで確かめる (仕様書 8.2.1: 長さが 0x2FF 以下か、読み出し位置が長さ以上なら断る)
    /// </summary>
    public void StartCapture()
    {
        var start = link.Read32(0x1902020);
        var length = link.Read32(0x1902024);
        var rp = link.Read32(0x190202C);
        if (start != Dt295NativePrograms.RingPhysical || length != Dt295NativePrograms.RingLength || rp >= length)
        {
            throw new Dt295NativeException($"リングの設定が想定と違います (先頭 0x{start:X}、長さ 0x{length:X}、読み出し位置 0x{rp:X})");
        }
        link.Write32(0x1902010, CaptureStartCommand);
        log?.Invoke($"0x1902010 = 0x{CaptureStartCommand:X8} を書いて 0x{link.Read32(0x1902010):X8} が読めました");
    }

    /// <summary>
    /// 取り込みを止める (仕様書 8.1.4・5.1。0x1901040 = 0、0x1901020 = 0x02000000、0x1902010 = 0x04000000 を書き、0x1902010 が 0 に戻るまで読む)。
    /// 開始の値と同じ並びの 0x04000000 (仕様書 5.1 の STOP。8.1.4 は 0x400 と書く)。0 に戻らなくても失敗にはしない (記録に出す)
    /// </summary>
    public void StopCapture()
    {
        link.Write32(0x1901040, 0);
        link.Write32(0x1901020, 0x02000000);
        link.Write32(0x1902010, CaptureStopCommand);
        var until = _clock.Elapsed + TimeSpan.FromSeconds(1);
        while (link.Read32(0x1902010) != 0)
        {
            if (_clock.Elapsed > until)
            {
                log?.Invoke("0x1902010 が 1 秒たっても 0 に戻りません");
                return;
            }
        }
    }

    /// <summary>取り込みの設定を戻す (仕様書 8.1.4 の「戻し」: #27 から #2 の逆順、#1、#0、最後に 0x1900404)</summary>
    public void RestoreCapture(CaptureSaved saved)
    {
        for (var i = CaptureTable.Length - 1; i >= 0; i--)
        {
            var (address, _, width) = CaptureTable[i];
            WriteWidth(address, saved.Table[i], width);
        }
        link.Write32(0x1900404, saved.R1900404);
        link.Write32(0x1900020, saved.R1900020);
    }
}
