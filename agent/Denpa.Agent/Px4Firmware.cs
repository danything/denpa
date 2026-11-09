using System.Security.Cryptography;

namespace Denpa.Agent;

/// <summary>
/// IT930x のファームウェア。**エージェントに同梱している** (firmware/it930x-firmware.bin を実行ファイルに埋め込む)。
///
/// <para>
/// 本体には入っておらず、挿すたびにホストから RAM へ流し込むもの。px4-userland は受理するバージョンを SHA-256 で
/// 1 つに固定していて (SPEC 4.5)、違うものを渡すと <c>FIRMWARE_REJECTED</c> で起動しない。
/// 中身は ITE Tech. の IT930x の Linux ドライバに入っているデータをそのまま書き出したもので、ITE Tech. から
/// 無改変での再配布の許諾を得ている (firmware/README.md、docs/licenses.md)。
/// </para>
///
/// <para>
/// px4d にはファイルのパスで渡すので、埋め込んだものを設定の置き場 (tuners.json の隣) に書き出して渡す。
/// <c>PX4_FIRMWARE</c> が指定されていれば、そちらを使う。どちらも SHA-256 を確かめ、違えば px4d を起動しない
/// </para>
/// </summary>
public static class Px4Firmware
{
    public const string FileName = "it930x-firmware.bin";

    /// <summary>受理するファームウェアの SHA-256 (ITE の Linux ドライバの V1_3_0_0。px4-userland が固定しているものと同じ)</summary>
    internal const string Sha256 = "5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484";

    /// <summary>埋め込んだリソースの名前 (Denpa.Agent.csproj の LogicalName)</summary>
    internal const string ResourceName = FileName;

    private static readonly Lazy<Px4FirmwareStore> Default = new(() => new Px4FirmwareStore(
        Environment.GetEnvironmentVariable("PX4_FIRMWARE"), Bundled, Config.FromEnvironment().Px4FirmwareFile));

    /// <summary>ファームウェアのパス。使えなければ理由を添えて投げる (<see cref="Px4FirmwareStore.Ensure"/>)</summary>
    public static string Ensure() => Default.Value.Ensure();

    /// <summary>使えなかった理由 (使えているか、まだ試していなければ null)。チューナー画面の <c>error</c> に出す</summary>
    public static string? Problem => Default.IsValueCreated ? Default.Value.Problem : null;

    /// <summary>実行ファイルに埋め込んだファームウェア</summary>
    internal static byte[] Bundled()
    {
        using var stream = typeof(Px4Firmware).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new IOException($"同梱の {FileName} が実行ファイルに入っていません");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}

/// <summary>
/// ファームウェアの置き場。<c>configured</c> (<c>PX4_FIRMWARE</c>) が指定されていればそれ、無ければ同梱のものを
/// <c>target</c> に書き出して使う。**どちらも SHA-256 を確かめる** (違うものを px4d に渡すと FIRMWARE_REJECTED になる)
/// </summary>
/// <param name="configured">指定された置き場 (<c>PX4_FIRMWARE</c>)。空なら同梱のものを使う</param>
/// <param name="bundled">同梱のファームウェアを返す。テストは偽のものを返す</param>
/// <param name="target">同梱のものを書き出す場所</param>
/// <param name="sha256">受理する SHA-256</param>
internal sealed class Px4FirmwareStore(string? configured, Func<byte[]> bundled, string target, string sha256 = Px4Firmware.Sha256)
{
    private readonly Lock _gate = new();

    public string? Problem { get; private set; }

    /// <summary>ファームウェアのパス。使えなければ理由を添えて <see cref="IOException"/></summary>
    public string Ensure()
    {
        lock (_gate)
        {
            try
            {
                var path = string.IsNullOrEmpty(configured) ? WriteBundled() : CheckConfigured(configured);
                Problem = null;
                return path;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                Problem = $"IT930x のファームウェアを用意できません ({error.Message})";
                throw new IOException(Problem, error);
            }
        }
    }

    private string CheckConfigured(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"PX4_FIRMWARE の {path} がありません", path);
        if (!Matches(File.ReadAllBytes(path))) throw new InvalidDataException($"PX4_FIRMWARE の {path} の SHA-256 が違います");
        return path;
    }

    /// <summary>同梱のものを <c>target</c> に書き出す。もう同じものがあれば書かない</summary>
    private string WriteBundled()
    {
        if (File.Exists(target) && Matches(File.ReadAllBytes(target))) return target;
        var firmware = bundled();
        if (!Matches(firmware)) throw new InvalidDataException($"同梱の {Px4Firmware.FileName} の SHA-256 が違います");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(target))!);
        // 書きかけを読ませない (px4d に途中までのものを渡すと FIRMWARE_REJECTED になる)
        var working = $"{target}.writing";
        File.WriteAllBytes(working, firmware);
        File.Move(working, target, overwrite: true);
        Log.Write($"同梱の IT930x のファームウェアを書き出しました ({target})");
        return target;
    }

    private bool Matches(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data)) == sha256;
}
