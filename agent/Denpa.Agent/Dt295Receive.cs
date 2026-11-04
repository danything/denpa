namespace Denpa.Agent;

/*
 * PIX-DT295 の受信 (TRC。仕様書 9 章) に要る 2 つ。
 *
 * - 受信設定 (12.5): 受信設定の領域に当てる (アドレス、シフト、幅、値) の並び。実機 (PIX-DT295、地上波と BS1) で
 *   「これだけで TS が受けられる」最小の組を、外して確かめて決めた (<see cref="Dt295FieldTable.Default"/>)。
 *   メーカーのデータの写しではなく、機材の挙動から決めた設定の値なので、コードに持つ。
 * - TS の IV (12.7): 機材が TS にかけ直した AES の IV。16 バイト。実機の TS から割り出した値をコードに持つ (<see cref="Dt295Receive.TsIv"/>)。
 */

/// <summary>受信設定の 1 行 (12.5)。部分書き換え (3.2) で当てる</summary>
public readonly record struct Dt295Field(ushort Address, int Shift, int Width, int Value);

/// <summary>受信設定 (12.5)。組むときに形を確かめる</summary>
public sealed class Dt295FieldTable
{
    /// <summary>DMA の入力選択 (0x1002 のビット 8〜9)。最終値で一時停止の状態番号が決まる (9.3)</summary>
    private const ushort InputSelect = 0x1002;

    /// <summary>
    /// PID の選び方 (pix-userland の <c>INIT_S_AUTO_PID_MODE</c>) があるレジスター。ビットは <see cref="AutoPidShift"/>。
    /// 1 なら機材が番組の映像・音声などの PID を選んで流し (衛星は PMT の ES の一覧が空に書き換わる)、
    /// 0 ならルートのレジスター (0x101E 以降) に書いた PID だけが流れる。
    /// 実機で確かめた (BS1): <see cref="Default"/> でこのビットだけ 0 にすると、SI の PID しか流れない
    /// </summary>
    public const ushort AutoPidRegister = 0x101A;

    /// <summary><see cref="AutoPidRegister"/> の中のビットの位置</summary>
    public const int AutoPidShift = 15;

    /// <summary>
    /// 標準の受信設定。公式の StationTV X が機材に当てる 677 行を実機で調べたところ、最終的に値が 0 でないレジスターは 64 個で、
    /// そのうち 59 個は外しても受信できた (地上波 27ch と BS1 で、5 秒の受信を 33 回。同期バイト 100%・連続性カウンターの誤り 0・
    /// 停止して 0x11 に戻る)。残りの 5 個がこれ。BS・CS の ECM のルートや録画に別の設定が要るかは、まだ確かめていない
    /// </summary>
    public static Dt295FieldTable Default { get; } = new(
    [
        new(0x1002, 0, 16, 0x8004),
        new(0x1004, 0, 16, 0x0100),
        new(0x100A, 0, 16, 0x0020),
        new(0x100E, 0, 16, 0xA000),
        new(0x101A, 0, 16, 0xA300),
    ]);

    public IReadOnlyList<Dt295Field> Rows { get; }

    /// <summary>一時停止の状態番号 (9.3 の最後。1 なら 3、0 なら 4)</summary>
    public ushort Pause { get; }

    /// <summary>機材が PID を選ぶ設定か (<see cref="AutoPidRegister"/> のビット <see cref="AutoPidShift"/>)</summary>
    public bool AutoPidMode { get; }

    public Dt295FieldTable(IReadOnlyList<Dt295Field> rows)
    {
        if (rows.Count == 0) throw new InvalidDataException("受信設定が空です");
        ushort input = 0;
        ushort autoPid = 0;
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Address is < 0x1000 or > 0x1AFE || row.Address % 2 != 0) throw new InvalidDataException($"受信設定の {i} 行目: アドレス 0x{row.Address:X4} は 0x1000〜0x1AFE の偶数ではありません");
            ushort applied;
            try
            {
                applied = Dt295Bridge.Field(row.Address == InputSelect ? input : row.Address == AutoPidRegister ? autoPid : (ushort)0, row.Shift, row.Width, row.Value);
            }
            catch (ArgumentOutOfRangeException error)
            {
                throw new InvalidDataException($"受信設定の {i} 行目: {error.Message}");
            }
            if (row.Address == InputSelect) input = applied;
            if (row.Address == AutoPidRegister) autoPid = applied;
        }
        Pause = ((input >> 8) & 0x3) switch
        {
            1 => 3,
            0 => 4,
            var other => throw new InvalidDataException($"受信設定で 0x1002 のビット 8〜9 が {other} になります (0 か 1 のはず。9.3)"),
        };
        AutoPidMode = ((autoPid >> AutoPidShift) & 1) == 1;
        Rows = rows;
    }

    /// <summary>領域を 0 で埋めたあとに、先頭から順に当てる (9.3 の手順 2)</summary>
    public void Apply(Dt295Bridge bridge)
    {
        foreach (var row in Rows) bridge.Modify16(row.Address, row.Shift, row.Width, row.Value);
    }
}

/// <summary>受信に要るもの (受信設定と TS の IV)</summary>
public sealed record Dt295ReceiveData(Dt295FieldTable Fields, byte[] TsIv);

/// <summary>受信に要るもの</summary>
public static class Dt295Receive
{
    /// <summary>TS の IV を確かめる値 (12.7)。仕様書の値 (IV の SHA-256)</summary>
    internal const string TsIvSha256 = "69a206b3bbcd395b81b201f762355fb224c4e9e16439090663b8dfc1f5b03301";

    /// <summary>
    /// TS の IV (12.7)。機材が TS のペイロードをパケットごとに AES-CBC で暗号化するときの、いつも同じ 16 バイト。
    /// 実機 (PIX-DT295) の TS から割り出した: IV を 0 にして復号すると、各パケットの最初の 16 バイトだけが「本当の中身 XOR IV」になって出るので、
    /// PAT (00 00 B0…、番組番号 0 の NIT は PID 0x0010) と映像の PES の先頭 (00 00 01 E0…) の決まった形から引ける。
    /// 地上波 27ch と BS1 のどちらからも同じ値になり、SHA-256 が仕様書の値 (<see cref="TsIvSha256"/>) と一致した
    /// (受信するチャンネルや環境では変わらない。テストで確かめる)
    /// </summary>
    public static readonly byte[] TsIv = Convert.FromHexString("EC8F4B6AD92A36892BDFB618FC255EFC");

    /// <summary>受信に要るもの</summary>
    public static Dt295ReceiveData Ensure() => new(Dt295FieldTable.Default, TsIv);
}
