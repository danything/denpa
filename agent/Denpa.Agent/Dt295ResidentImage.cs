/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の core/bootstrap.c (SBC2 の読み取り)・
 * core/resident_image.c の検証・core/loader.c の mb86H_loader_parse_target のうち、PIX-DT295 の部分を移したもの。
 * Copyright (c) 2026 huggy、MIT License (全文は licenses/mAgicVISION.txt)。
 */

using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// mAgicVISION のファームウェア (<c>firmware.bin</c>、SBC2 形式) から取り出した PIX-DT295 の分。
/// boot0 に書く body と hook (元の boot0 の写しと、組み替えた値) と、常駐イメージ 256 KiB を持つ。
/// どれもファイルの中を指すだけで、機材には触らない
/// </summary>
public sealed class Dt295ResidentImage
{
    /// <summary>常駐イメージを置く場所 (constants.h の MB86H_RESIDENT_BASE・END)</summary>
    public const uint Base = 0x80380000;

    public const uint End = 0x803C0000;
    public const int Bytes = (int)(End - Base);

    /// <summary>ビルド ID 8 バイト (MB86H_RESIDENT_BUILD_ID)</summary>
    public const uint BuildId = End - 8;

    /// <summary>書き換えない範囲の終わりと、その範囲の合計を 0 にする値の場所</summary>
    public const uint ImmutableEnd = 0x803B0000;

    public const uint ImmutableChecksum = 0x803AFFF8;

    /// <summary>イメージの説明 (magic・ABI・大きさ・場所…) の場所</summary>
    public const uint Meta = 0x803BEFE0;

    /// <summary>コミットの値の場所。書き込みの最初に 0 にし、最後に書く</summary>
    public const uint Commit = 0x803AFFFC;

    public const uint HeaderMagic = 0x585A3352;
    public const uint CommitMagic = 0x52534E31;

    // boot0 の場所 (constants.h の MB86H_DT295_BOOT0_*)
    public const uint Hook = 0x000EA6FC;
    public const int HookBytes = 8;
    public const uint Body = 0x000E1000;
    public const int BodyBytes = 0x800;
    public const uint Code = 0x000E9000;
    public const int CodeBytes = 0x3910;

    private const uint Sbc2Magic = 0x53424332;
    private const int HeaderBytes = 64;
    private const int ProfileBytes = 64;
    private const int ReferenceBytes = 16;
    private const int RelocationBytes = 12;
    private const uint Dt295Target = 3;
    private const uint Reloc20 = 20;
    private const uint Reloc32 = 32;
    private const uint Reloc48 = 48;

    private readonly byte[] _bundle;
    private readonly int _body;
    private readonly int _bodySize;
    private readonly int _relocations;
    private readonly int _relocationCount;
    private readonly int _references;
    private readonly int _referenceCount;
    private readonly int _patches;
    private readonly int _patchCount;
    private readonly int _resident;

    private Dt295ResidentImage(byte[] bundle, int body, int bodySize, int relocations, int relocationCount,
        int references, int referenceCount, int patches, int patchCount, int resident)
    {
        _bundle = bundle;
        _body = body;
        _bodySize = bodySize;
        _relocations = relocations;
        _relocationCount = relocationCount;
        _references = references;
        _referenceCount = referenceCount;
        _patches = patches;
        _patchCount = patchCount;
        _resident = resident;
    }

    /// <summary>常駐イメージ 256 KiB</summary>
    public ReadOnlySpan<byte> Resident => _bundle.AsSpan(_resident, Bytes);

    /// <summary>常駐イメージのビルド ID</summary>
    public ReadOnlySpan<byte> Build => Resident.Slice((int)(BuildId - Base), 8);

    /// <summary>同梱のファームウェアの名前 (実行ファイルに埋め込む。firmware/README.md)</summary>
    public const string FileName = "magicvision-firmware.bin";

    /// <summary>同梱のファームウェアの SHA-256。違うものは使わない</summary>
    public const string Sha256 = "d9f549b29d286c2ff1e7daf4237e2205bb8a5a2affbb98362bce137b8b42a33f";

    private static readonly Lazy<Dt295ResidentImage> BundledImage = new(() =>
    {
        using var resource = typeof(Dt295ResidentImage).Assembly.GetManifestResourceStream(FileName)
            ?? throw new InvalidDataException($"同梱の {FileName} が実行ファイルにありません");
        using var copy = new MemoryStream();
        resource.CopyTo(copy);
        var bytes = copy.ToArray();
        var hash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
        if (hash != Sha256) throw new InvalidDataException($"同梱の {FileName} の SHA-256 が違います ({hash})");
        return Parse(bytes);
    });

    /// <summary>同梱のファームウェア (初めて使うときに読んで確かめる)</summary>
    public static Dt295ResidentImage Bundled => BundledImage.Value;

    private static uint Word(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);

    private static InvalidDataException Bad(string what) => new($"mAgicVISION のファームウェアが読めません ({what})");

    /// <summary>
    /// SBC2 を読み、DT295 の分を取り出す (bootstrap.c の mb86H_bootstrap_parse と resident_image.c の mb86H_resident_image_validate)。
    /// 範囲・重なり・配置換えの値をすべて確かめ、1 つでも合わなければ投げる
    /// </summary>
    public static Dt295ResidentImage Parse(byte[] bundle)
    {
        var size = (long)bundle.Length;
        ReadOnlySpan<byte> b = bundle;
        if (size < HeaderBytes || Word(b, 0) != Sbc2Magic || Word(b, 4) != 1 || Word(b, 8) != HeaderBytes || Word(b, 12) != size
            || Word(b, 44) != Bytes) throw Bad("SBC2 の先頭");
        for (var index = 12; index < 16; index++)
        {
            if (Word(b, index * 4) != 0) throw Bad("SBC2 の先頭の予約");
        }
        var profiles = Word(b, 16);
        var profileCount = Word(b, 20);
        var body = Word(b, 24);
        var bodySize = Word(b, 28);
        var relocations = Word(b, 32);
        var relocationCount = Word(b, 36);
        var resident = Word(b, 40);
        var residentSize = Word(b, 44);
        if ((profiles & 3) != 0 || profileCount is 0 or > 3 || relocationCount > size / RelocationBytes
            || !InBounds(size, profiles, (long)profileCount * ProfileBytes) || (body & 1) != 0 || (bodySize & 1) != 0 || bodySize == 0
            || !InBounds(size, body, bodySize) || (relocations & 3) != 0 || !InBounds(size, resident, residentSize))
        {
            throw Bad("SBC2 の配置");
        }

        var spans = new List<(long Offset, long Length)>();
        AddSpan(spans, 0, HeaderBytes, size);
        AddSpan(spans, profiles, (long)profileCount * ProfileBytes, size);
        AddSpan(spans, body, bodySize, size);
        AddSpan(spans, relocations, (long)relocationCount * RelocationBytes, size);
        AddSpan(spans, resident, residentSize, size);

        var profile = -1;
        var targets = new List<uint>();
        for (var index = 0; index < profileCount; index++)
        {
            var candidate = (int)profiles + index * ProfileBytes;
            var target = Word(b, candidate);
            if (target is not (1 or 2 or 3) || targets.Contains(target)) throw Bad("機種の一覧");
            targets.Add(target);
            for (var field = 8; field < 16; field++)
            {
                if (Word(b, candidate + field * 4) != 0) throw Bad("機種の一覧の予約");
            }
            var refs = Word(b, candidate + 12);
            var refCount = Word(b, candidate + 16);
            var patches = Word(b, candidate + 20);
            var patchCount = Word(b, candidate + 24);
            if ((refs & 3) != 0 || (patches & 3) != 0 || refCount > size / ReferenceBytes || patchCount > size / ReferenceBytes
                || !InBounds(size, refs, (long)refCount * ReferenceBytes) || !InBounds(size, patches, (long)patchCount * ReferenceBytes))
            {
                throw Bad("機種の一覧の範囲");
            }
            AddSpan(spans, refs, (long)refCount * ReferenceBytes, size);
            AddSpan(spans, patches, (long)patchCount * ReferenceBytes, size);
            if (target == Dt295Target) profile = candidate;
        }
        if (profile < 0 || Word(b, profile + 4) != Body || Word(b, profile + 8) != BodyBytes || bodySize > BodyBytes || Word(b, profile + 28) != 0)
        {
            throw Bad("PIX-DT295 の分が無い");
        }

        for (var index = 0; index < profileCount; index++)
        {
            var candidate = (int)profiles + index * ProfileBytes;
            RecordData(b, Word(b, candidate + 12), Word(b, candidate + 16), spans, size);
            RecordData(b, Word(b, candidate + 20), Word(b, candidate + 24), spans, size);
        }

        var references = (int)Word(b, profile + 12);
        var referenceCount = (int)Word(b, profile + 16);
        var patchStart = (int)Word(b, profile + 20);
        var patchTotal = (int)Word(b, profile + 24);
        Records(b, references, referenceCount, 0, 0, size);
        Records(b, patchStart, patchTotal, Body, BodyBytes, size);
        // DT295 の書き換えは hook の 8 バイトだけで、そこを全部覆う (bootstrap.c の validate_patch_windows)
        for (var index = 0; index < patchTotal; index++)
        {
            var record = patchStart + index * ReferenceBytes;
            var start = Word(b, record);
            var end = (long)start + Word(b, record + 4);
            if (start < Hook || end > Hook + HookBytes) throw Bad("書き換えの範囲");
        }
        for (var offset = 0u; offset < HookBytes; offset++)
        {
            if (!Covers(b, patchStart, patchTotal, Hook + offset)) throw Bad("書き換えが hook を覆わない");
        }
        // 元の boot0 の写しは、コードの範囲を 1 つの記録で持つ
        if (!Single(b, references, referenceCount, Code, CodeBytes)) throw Bad("元の boot0 の写し");

        for (var index = 0; index < relocationCount; index++)
        {
            var record = (int)relocations + index * RelocationBytes;
            var offset = Word(b, record);
            var type = Word(b, record + 4);
            var target = Word(b, record + 8);
            var width = type == Reloc48 ? 6u : 4u;
            if (type is not (Reloc20 or Reloc32 or Reloc48) || target >= bodySize || offset > bodySize || width > bodySize - offset)
            {
                throw Bad("配置換え");
            }
            var operand = b.Slice((int)(body + offset), (int)width);
            var valid = type switch
            {
                Reloc20 => operand[0] == 0x9B && Immediate20(operand) == target,
                Reloc32 => Word(operand, 0) == target,
                _ => operand[0] == 0x9F && (operand[1] & 0xF0) == 0x80 && Word(operand, 2) == target,
            };
            if (!valid) throw Bad("配置換えの値");
            for (var other = 0; other < index; other++)
            {
                var prior = (int)relocations + other * RelocationBytes;
                var priorOffset = Word(b, prior);
                var priorWidth = Word(b, prior + 4) == Reloc48 ? 6u : 4u;
                if (offset < priorOffset + priorWidth && priorOffset < offset + width) throw Bad("配置換えの重なり");
            }
        }

        var image = new Dt295ResidentImage(bundle, (int)body, (int)bodySize, (int)relocations, (int)relocationCount,
            references, referenceCount, patchStart, patchTotal, (int)resident);
        Validate(image.Resident);
        return image;
    }

    /// <summary>
    /// 常駐イメージの説明・コミットの値・書き換えない範囲の合計を確かめる (resident_image.c の mb86H_resident_image_validate)
    /// </summary>
    public static void Validate(ReadOnlySpan<byte> image)
    {
        if (image.Length != Bytes) throw Bad("常駐イメージの大きさ");
        var meta = image[(int)(Meta - Base)..];
        if (Word(meta, 0) != HeaderMagic || Word(meta, 4) != Dt295ResidentProtocol.AbiVersion || Word(meta, 8) != Bytes || Word(meta, 12) != Base
            || Word(meta, 16) != ImmutableEnd || Word(meta, 20) != ImmutableChecksum || Word(image, (int)(Commit - Base)) != CommitMagic)
        {
            throw Bad("常駐イメージの説明");
        }
        var sum = 0u;
        for (var offset = 0; offset < (int)(ImmutableEnd - Base); offset += 4)
        {
            unchecked
            {
                sum += Word(image, offset);
            }
        }
        if (sum != 0) throw Bad("常駐イメージの合計");
    }

    /// <summary>
    /// 元の boot0 の写しのうち、<paramref name="address"/> から <paramref name="length"/> バイトを 1 つの記録が持っていればそれを返す
    /// (bootstrap.c の find_reference)。無ければ空
    /// </summary>
    public ReadOnlySpan<byte> Original(uint address, int length)
    {
        var end = (long)address + length;
        for (var index = 0; index < _referenceCount; index++)
        {
            var record = _references + index * ReferenceBytes;
            var start = Word(_bundle, record);
            var stop = (long)start + Word(_bundle, record + 4);
            if (address >= start && end <= stop) return _bundle.AsSpan((int)(Word(_bundle, record + 8) + (address - start)), length);
        }
        return [];
    }

    /// <summary>
    /// 導入したあとの boot0 の <paramref name="address"/> から <paramref name="output"/> の長さ (bootstrap.c の mb86H_bootstrap_read)。
    /// 元の写しの上に、body を置いて配置換えを当て、hook の書き換えを重ねる。写しにも body にも無いところが混じれば投げる
    /// </summary>
    public void Installed(uint address, Span<byte> output)
    {
        var end = address + (uint)output.Length;
        for (var index = 0; index < output.Length; index++)
        {
            var here = address + (uint)index;
            var source = Original(here, 1);
            if (!source.IsEmpty) output[index] = source[0];
            else if (here >= Body && here < Body + BodyBytes) output[index] = 0;
            else throw new ArgumentOutOfRangeException(nameof(address), $"0x{here:X} は boot0 の写しにありません");
        }
        for (var index = 0; index < _bodySize; index++)
        {
            var here = Body + (uint)index;
            if (here >= address && here < end) output[(int)(here - address)] = _bundle[_body + index];
        }
        for (var index = 0; index < _relocationCount; index++) Relocate(address, output, _relocations + index * RelocationBytes);
        for (var index = 0; index < _patchCount; index++)
        {
            var record = _patches + index * ReferenceBytes;
            var start = Word(_bundle, record);
            var stop = start + Word(_bundle, record + 4);
            var first = Math.Max(start, address);
            var last = Math.Min(stop, end);
            if (first < last)
            {
                _bundle.AsSpan((int)(Word(_bundle, record + 8) + first - start), (int)(last - first)).CopyTo(output[(int)(first - address)..]);
            }
        }
    }

    /// <summary>導入したあとの boot0 を配列で</summary>
    public byte[] Installed(uint address, int length)
    {
        var bytes = new byte[length];
        Installed(address, bytes);
        return bytes;
    }

    private void Relocate(uint address, Span<byte> output, int record)
    {
        var offset = Word(_bundle, record);
        var type = Word(_bundle, record + 4);
        var target = Word(_bundle, record + 8);
        var relocated = Body + target;
        var at = Body + offset;
        var width = type == Reloc48 ? 6u : 4u;
        var end = at + width;
        if (end <= address || at >= address + (uint)output.Length) return;
        Span<byte> bytes = stackalloc byte[6];
        _bundle.AsSpan((int)(_body + offset), (int)width).CopyTo(bytes);
        if (type == Reloc20)
        {
            if (relocated > 0xFFFFF) throw Bad("配置換えの値が 20 ビットに入らない");
            bytes[1] = (byte)((bytes[1] & 15u) | ((relocated >> 16) << 4));
            bytes[2] = (byte)(relocated >> 8);
            bytes[3] = (byte)relocated;
        }
        else if (type == Reloc32)
        {
            BinaryPrimitives.WriteUInt32BigEndian(bytes, relocated);
        }
        else
        {
            BinaryPrimitives.WriteUInt32BigEndian(bytes[2..], relocated);
        }
        var first = Math.Max(at, address);
        var last = Math.Min(end, address + (uint)output.Length);
        bytes.Slice((int)(first - at), (int)(last - first)).CopyTo(output[(int)(first - address)..]);
    }

    private static uint Immediate20(ReadOnlySpan<byte> operand) => ((uint)(operand[1] >> 4) << 16) | ((uint)operand[2] << 8) | operand[3];

    private static bool InBounds(long total, long offset, long length) => offset <= total && length <= total - offset;

    private static void AddSpan(List<(long Offset, long Length)> spans, long offset, long length, long total)
    {
        if (!InBounds(total, offset, length)) throw Bad("範囲の外");
        if (spans.Any(span => offset < span.Offset + span.Length && span.Offset < offset + length)) throw Bad("範囲の重なり");
        spans.Add((offset, length));
    }

    /// <summary>写しと書き換えの記録が指すデータが、ほかの範囲や互いと重ならない (bootstrap.c の validate_record_data)</summary>
    private static void RecordData(ReadOnlySpan<byte> b, uint records, uint count, List<(long Offset, long Length)> spans, long size)
    {
        var seen = new List<(long Offset, long Length)>();
        for (var index = 0; index < count; index++)
        {
            var record = (int)records + index * ReferenceBytes;
            long offset = Word(b, record + 8);
            long bytes = Word(b, record + 4);
            if (!InBounds(size, offset, bytes)) throw Bad("記録のデータの範囲");
            if (spans.Any(span => offset < span.Offset + span.Length && span.Offset < offset + bytes)) throw Bad("記録のデータの重なり");
            if (seen.Any(span => offset < span.Offset + span.Length && span.Offset < offset + bytes)) throw Bad("記録のデータの重なり");
            seen.Add((offset, bytes));
        }
    }

    /// <summary>記録の並び (bootstrap.c の validate_records)。長さが 0 でなく、末尾の予約が 0 で、禁じた範囲や互いと重ならない</summary>
    private static void Records(ReadOnlySpan<byte> b, int records, int count, uint forbidden, uint forbiddenSize, long size)
    {
        const int width = ReferenceBytes;
        if ((records & 3) != 0 || count > size / width || !InBounds(size, records, (long)count * width)) throw Bad("記録の並び");
        for (var index = 0; index < count; index++)
        {
            var record = records + index * width;
            long address = Word(b, record);
            long bytes = Word(b, record + 4);
            if (bytes == 0 || Word(b, record + width - 4) != 0) throw Bad("記録の値");
            if (address + bytes > uint.MaxValue) throw Bad("記録の範囲");
            if (forbiddenSize != 0 && address < forbidden + forbiddenSize && forbidden < address + bytes) throw Bad("記録が body に重なる");
            if (!InBounds(size, Word(b, record + 8), bytes)) throw Bad("記録のデータの範囲");
            for (var other = 0; other < index; other++)
            {
                var prior = records + other * width;
                long priorAddress = Word(b, prior);
                long priorBytes = Word(b, prior + 4);
                if (address < priorAddress + priorBytes && priorAddress < address + bytes) throw Bad("記録の重なり");
            }
        }
    }

    private static bool Covers(ReadOnlySpan<byte> b, int records, int count, uint address)
    {
        for (var index = 0; index < count; index++)
        {
            var record = records + index * ReferenceBytes;
            var start = Word(b, record);
            if (address >= start && address < (long)start + Word(b, record + 4)) return true;
        }
        return false;
    }

    private static bool Single(ReadOnlySpan<byte> b, int records, int count, uint address, int length)
    {
        for (var index = 0; index < count; index++)
        {
            var record = records + index * ReferenceBytes;
            var start = Word(b, record);
            if (address >= start && (long)address + length <= (long)start + Word(b, record + 4)) return true;
        }
        return false;
    }
}
