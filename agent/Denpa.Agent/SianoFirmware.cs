using System.Buffers.Binary;

namespace Denpa.Agent;

/*
 * Siano RIO 系の機材に送るファームウェアのファイル (isdbt_rio.inp) を、送る単位に区切る。
 *
 * クリーンルームで、仕様書 (denpa-spec の siano/spec.md) だけから書いた。Linux カーネルの Siano のドライバと siano-userland のコードは読んでいない。
 * ファイルの中身は解析しない。読むのは仕様書 4.2 にある先頭 12 バイトの 3 つの欄だけで、本体は配られているバイト列のまま機材に送る。
 * ファイルは linux-firmware に入っているものを無改変で同梱している (firmware/README.md)。
 */

/// <summary>
/// ファームウェアのファイルを区切ったもの (仕様書 4.2)。ファイルの先頭は u32 の検査の値 (送らない)・u32 の本体の長さ・u32 の先頭のアドレスで、12 バイト目から本体
/// </summary>
/// <param name="Address">先頭のアドレス。書き込みのアドレスの始まりで、データの検査と実行の合図にも入れる</param>
/// <param name="Length">本体の長さ。データの検査に入れる</param>
/// <param name="Data">
/// 機材に送るデータの全体。ファイルと同じバイト数で、本体のあとを 0 で埋めたもの
/// (仕様書 4.2・12.3。資料の食い違いのうち、送る中身が毎回同じになるほうを選んでいる)
/// </param>
internal sealed record SianoFirmware(uint Address, uint Length, byte[] Data)
{
    /// <summary>ファイルの先頭にある 3 つの欄の長さ</summary>
    public const int HeaderSize = 12;

    public const string FileName = "isdbt_rio.inp";

    /// <summary>
    /// 同梱しているファームウェアの SHA-256 (linux-firmware の <c>isdbt_rio.inp</c>、85,840 バイト。firmware/README.md)。
    /// テストが埋め込んだファイルと突き合わせる
    /// </summary>
    internal const string Sha256 = "054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818";

    /// <summary>
    /// 機材に送るファームウェア。**エージェントに同梱している** (firmware/isdbt_rio.inp を実行ファイルに埋め込む。Siano の許諾で無改変なら再配布できる)。
    /// 環境変数 <c>SIANO_FIRMWARE</c> でファイルを指定すると、同梱のものの代わりにそのファイルを読む (SHA-256 は確かめない)
    /// </summary>
    public static SianoFirmware Default()
    {
        var configured = Environment.GetEnvironmentVariable("SIANO_FIRMWARE");
        if (!string.IsNullOrEmpty(configured)) return Load(configured);
        try
        {
            return Parse(Bundled());
        }
        catch (InvalidDataException error)
        {
            throw new IOException($"{error.Message}: 同梱の {FileName}", error);
        }
    }

    /// <summary>実行ファイルに埋め込んだファームウェア (Denpa.Agent.csproj の LogicalName)</summary>
    internal static byte[] Bundled()
    {
        using var stream = typeof(SianoFirmware).Assembly.GetManifestResourceStream(FileName)
            ?? throw new IOException($"同梱の {FileName} が実行ファイルに入っていません");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>ファイルが 12 バイトより短い・本体の長さがファイルに収まらないときは投げる (機材に何も送らずに失敗にする。仕様書 4.2・10)</summary>
    public static SianoFirmware Parse(ReadOnlySpan<byte> file)
    {
        if (file.Length < HeaderSize) throw new InvalidDataException($"ファームウェアのファイルが {file.Length} バイトで、短すぎます");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(file[4..]);
        var address = BinaryPrimitives.ReadUInt32LittleEndian(file[8..]);
        if (length > (uint)(file.Length - HeaderSize))
        {
            throw new InvalidDataException($"ファームウェアのファイルが壊れています (本体の長さ {length} バイトが、ファイルの {file.Length} バイトに収まりません)");
        }
        var data = new byte[file.Length];
        file.Slice(HeaderSize, (int)length).CopyTo(data);
        return new SianoFirmware(address, length, data);
    }

    /// <summary>ファイルを読んで区切る。無い・読めない・形式が違うときは、手当てを添えた <see cref="IOException"/></summary>
    public static SianoFirmware Load(string path)
    {
        byte[] file;
        try
        {
            file = File.ReadAllBytes(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new IOException($"ファームウェアを読めません: {path} ({error.Message})", error);
        }
        try
        {
            return Parse(file);
        }
        catch (InvalidDataException error)
        {
            throw new IOException($"{error.Message}: {path}", error);
        }
    }

    /// <summary>
    /// 「データの書き込み」1 つぶんずつ (仕様書 4.2 の手順 1)。データを先頭から 240 バイトずつに区切り、アドレスは <paramref name="start"/> から、
    /// 送ったバイト数だけ進める
    /// </summary>
    public IEnumerable<(uint Address, ReadOnlyMemory<byte> Chunk)> Chunks(uint start)
    {
        for (var at = 0; at < Data.Length; at += SianoMessage.DataWriteMax)
        {
            var take = Math.Min(SianoMessage.DataWriteMax, Data.Length - at);
            yield return (start + (uint)at, Data.AsMemory(at, take));
        }
    }

    /// <summary>送るメッセージの数</summary>
    public int ChunkCount => (Data.Length + SianoMessage.DataWriteMax - 1) / SianoMessage.DataWriteMax;
}
