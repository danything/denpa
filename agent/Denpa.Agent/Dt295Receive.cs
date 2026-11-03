using System.Security.Cryptography;

namespace Denpa.Agent;

/*
 * PIX-DT295 の受信 (TRC。仕様書 9 章) に要る 2 つ。
 *
 * - 受信設定 (12.5): 受信設定の領域に当てる (アドレス、シフト、幅、値) の並び。実機 (PIX-DT295、地上波と BS1) で
 *   「これだけで TS が受けられる」最小の組を、外して確かめて決めた (<see cref="Dt295FieldTable.Default"/>)。
 *   メーカーのデータの写しではなく、機材の挙動から決めた設定の値なので、コードに持つ。
 * - TS の IV (12.7): 機材が TS にかけ直した AES の IV。16 バイト。コードには持たず、初めて受けるときに TS から割り出して
 *   (<see cref="Dt295IvLearner"/>)、SHA-256 で確かめてから、置き場に写して次からはそれを使う。
 */

/// <summary>受信設定の 1 行 (12.5)。部分書き換え (3.2) で当てる</summary>
public readonly record struct Dt295Field(ushort Address, int Shift, int Width, int Value);

/// <summary>受信設定 (12.5)。組むときに形を確かめる</summary>
public sealed class Dt295FieldTable
{
    /// <summary>DMA の入力選択 (0x1002 のビット 8〜9)。最終値で一時停止の状態番号が決まる (9.3)</summary>
    private const ushort InputSelect = 0x1002;

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

    public Dt295FieldTable(IReadOnlyList<Dt295Field> rows)
    {
        if (rows.Count == 0) throw new InvalidDataException("受信設定が空です");
        ushort input = 0;
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Address is < 0x1000 or > 0x1AFE || row.Address % 2 != 0) throw new InvalidDataException($"受信設定の {i} 行目: アドレス 0x{row.Address:X4} は 0x1000〜0x1AFE の偶数ではありません");
            ushort applied;
            try
            {
                applied = Dt295Bridge.Field(row.Address == InputSelect ? input : (ushort)0, row.Shift, row.Width, row.Value);
            }
            catch (ArgumentOutOfRangeException error)
            {
                throw new InvalidDataException($"受信設定の {i} 行目: {error.Message}");
            }
            if (row.Address == InputSelect) input = applied;
        }
        Pause = ((input >> 8) & 0x3) switch
        {
            1 => 3,
            0 => 4,
            var other => throw new InvalidDataException($"受信設定で 0x1002 のビット 8〜9 が {other} になります (0 か 1 のはず。9.3)"),
        };
        Rows = rows;
    }

    /// <summary>領域を 0 で埋めたあとに、先頭から順に当てる (9.3 の手順 2)</summary>
    public void Apply(Dt295Bridge bridge)
    {
        foreach (var row in Rows) bridge.Modify16(row.Address, row.Shift, row.Width, row.Value);
    }
}

/// <summary>受信に要るもの。<paramref name="TsIv"/> は、まだ割り出していなければ null</summary>
public sealed record Dt295ReceiveData(Dt295FieldTable Fields, byte[]? TsIv);

/// <summary>受信に要るものを、置き場 (tuners.json の隣) から揃える</summary>
public static class Dt295Receive
{
    public const string IvFile = "dt295-ts-iv.bin";

    /// <summary>TS の IV の確かめ (12.7)</summary>
    internal const string TsIvSha256 = "69a206b3bbcd395b81b201f762355fb224c4e9e16439090663b8dfc1f5b03301";

    /// <summary>IV が正しいか</summary>
    internal static bool IsTsIv(ReadOnlySpan<byte> data) =>
        data.Length == 16 && Convert.ToHexStringLower(SHA256.HashData(data)) == TsIvSha256;

    private static readonly Lazy<Dt295ReceiveStore> Default = new(() => new Dt295ReceiveStore(Dt295Firmware.Folder));

    /// <summary>揃えて返す。IV が置き場にまだ無ければ <see cref="Dt295ReceiveData.TsIv"/> は null (受けながら割り出す)</summary>
    public static Dt295ReceiveData Ensure() => Default.Value.Ensure();

    /// <summary>割り出した IV を置き場に写す。書けなくても受信はできる (次も割り出す)</summary>
    public static void Save(byte[] iv) => Default.Value.Save(iv);
}

/// <summary>置き場 1 つ。TS の IV は、置き場の写しがあって、確かめが合うときだけ使う</summary>
internal sealed class Dt295ReceiveStore(string folder, Func<byte[], bool>? isIv = null)
{
    private readonly Func<byte[], bool> _isIv = isIv ?? (iv => Dt295Receive.IsTsIv(iv));

    public Dt295ReceiveData Ensure()
    {
        var path = Path.Combine(folder, Dt295Receive.IvFile);
        byte[]? iv = null;
        if (File.Exists(path))
        {
            var cached = File.ReadAllBytes(path);
            if (_isIv(cached)) iv = cached;
        }
        return new Dt295ReceiveData(Dt295FieldTable.Default, iv);
    }

    public void Save(byte[] iv)
    {
        var path = Path.Combine(folder, Dt295Receive.IvFile);
        try
        {
            Directory.CreateDirectory(folder);
            File.WriteAllBytes(path, iv);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Log.Write($"{path} に写せません ({error.Message})。次も割り出します");
        }
    }
}
