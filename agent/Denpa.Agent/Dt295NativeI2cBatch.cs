namespace Denpa.Agent;

/// <summary>
/// I2C の転送を順に並べたもの。機材の中の順次実行 (Dt295NativePrograms の操作 2) に 1 回の要求で渡すか、できなければホストが 1 つずつ実行する
/// (<see cref="Dt295NativeI2c.Run"/>)。どちらでも手順と結果は同じ。
///
/// <para>
/// 転送は 3 種類。<see cref="Write"/> は書くだけ、<see cref="Read"/> は読むだけ、<see cref="WriteModified"/> は書く最後の 1 バイトを
/// 「直前の読み出しの先頭バイト &amp; keep | set」にする (リード・モディファイ・ライトの書き側)。読み出しの結果は、読んだバイトを転送の順に全部つなげて返る。
/// 相手のアドレスは復調の 2 つ (0x10 地上波、0x11 衛星。仕様書 7.0) だけ
/// </para>
/// </summary>
public sealed class Dt295I2cBatch
{
    public sealed record Op(int Address, byte[] Write, int Read, bool Modified, byte Keep, byte Set)
    {
        /// <summary>機材に渡す形での大きさ: 4 バイトのヘッダ、書くバイト、種類 1 なら keep と set</summary>
        public int EncodedLength => 4 + Write.Length + (Modified ? 2 : 0);
    }

    private readonly List<Op> _ops = [];

    public IReadOnlyList<Op> Ops => _ops;

    public bool IsEmpty => _ops.Count == 0;

    private static void CheckAddress(int address)
    {
        if (address is not (Dt295NativeFrontend.Terrestrial or Dt295NativeFrontend.Satellite))
        {
            throw new ArgumentOutOfRangeException(nameof(address), $"I2C のアドレス 0x{address:X2} は復調の 0x10・0x11 ではありません");
        }
    }

    public void Write(int address, params byte[] bytes)
    {
        CheckAddress(address);
        if (bytes.Length is 0 or > Dt295NativeI2c.MaxBytes) throw new ArgumentOutOfRangeException(nameof(bytes));
        _ops.Add(new Op(address, bytes, 0, false, 0, 0));
    }

    public void Read(int address, int count)
    {
        CheckAddress(address);
        if (count is < 1 or > Dt295NativeI2c.MaxBytes) throw new ArgumentOutOfRangeException(nameof(count));
        _ops.Add(new Op(address, [], count, false, 0, 0));
    }

    /// <summary><paramref name="prefix"/> のあとに ((直前の読み出しの先頭バイト &amp; keep) | set) を 1 バイト足して書く</summary>
    public void WriteModified(int address, byte[] prefix, byte keep, byte set)
    {
        CheckAddress(address);
        if (prefix.Length + 1 > Dt295NativeI2c.MaxBytes) throw new ArgumentOutOfRangeException(nameof(prefix));
        _ops.Add(new Op(address, prefix, 0, true, keep, set));
    }

    public void Clear() => _ops.Clear();

    /// <summary>
    /// 機材に渡す形にする。転送ごとに [アドレス][書く数][読む数][種類] と書くバイト、種類 1 は書く数に足す 1 バイトを数え、
    /// 書くバイトのあとに keep・set を付ける
    /// </summary>
    public static byte[] Encode(IEnumerable<Op> ops)
    {
        var bytes = new List<byte>();
        foreach (var op in ops)
        {
            bytes.Add((byte)op.Address);
            bytes.Add((byte)(op.Write.Length + (op.Modified ? 1 : 0)));
            bytes.Add((byte)op.Read);
            bytes.Add(op.Modified ? (byte)1 : (byte)0);
            bytes.AddRange(op.Write);
            if (op.Modified)
            {
                bytes.Add(op.Keep);
                bytes.Add(op.Set);
            }
        }
        return [.. bytes];
    }

    /// <summary>
    /// 機材に 1 回で渡せる大きさ (<paramref name="opLimit"/> バイト・<paramref name="resultLimit"/> バイトの結果) ごとに分ける。
    /// 読み出しの結果を使う書き (種類 1) は、その読み出しと同じ塊に入れる。種類 1 が続くと、1 つの塊が上限を 1 転送ぶん (最大 45 バイト) 超えることがある
    /// (最大は種類 1 で、4 バイトのヘッダ・書く 39 バイト・keep と set の 2 バイト。39 は 1 転送の上限 <see cref="Dt295NativeI2c.MaxBytes"/> (40) から、
    /// 読んだ値で作って足す最後の 1 バイトを引いたもの (<see cref="WriteModified"/>)。機材に渡せる大きさ <c>BatchLimit</c> は上限よりずっと大きい)。いまの並びでは起きない
    /// </summary>
    public IEnumerable<IReadOnlyList<Op>> Split(int opLimit, int resultLimit)
    {
        var chunk = new List<Op>();
        var size = 0;
        var results = 0;
        foreach (var op in _ops)
        {
            var full = chunk.Count > 0 && (size + op.EncodedLength > opLimit || results + op.Read > resultLimit);
            if (full && !op.Modified)
            {
                yield return chunk;
                chunk = [];
                size = 0;
                results = 0;
            }
            chunk.Add(op);
            size += op.EncodedLength;
            results += op.Read;
        }
        if (chunk.Count > 0) yield return chunk;
    }
}
