namespace Denpa.Agent.Tests;

/*
 * 偽の I2C のバス 1 本と、その上の復調器 (CXD2856ER) とチューナー (CXD2858ER)。振る舞いは仕様書 (denpa-spec の mlt5/spec.md) から決めた。
 * - 復調器は T と X (T + 2) の 2 つのアドレスを持ち、T はレジスタ 00 でバンクを切り替える (仕様書 1.1)
 * - チューナーは 0x60 で、復調器の X の 08 に 01 を書いて中継を開けている間だけ届く (仕様書 1.4)。
 *   中継が 1 つも開いていない・2 つ以上開いているのに 0x60 に来たら、テストを失敗にする (InvalidOperationException)
 */

/// <summary>偽の復調器 1 つと、その中継の先のチューナー</summary>
internal sealed class FakeCxdReceiver(byte address)
{
    public byte Address { get; } = address;

    /// <summary>識別のレジスタ (T の FD) の値</summary>
    public byte ChipId { get; set; } = 0x90;

    /// <summary>チューナーの CPU の状態 (チューナーの 1A)。0 でなければ初期化の失敗</summary>
    public byte TunerCpu { get; set; }

    /// <summary>VCO の電流の元の値 (チューナーの 19)</summary>
    public byte Vco { get; set; } = 0xA5;

    /// <summary>ISDB-T のロックの状態 (T のバンク 60 の 10)。読むたびに呼ぶ (引数は読んだ回数)</summary>
    public Func<int, byte> Status { get; set; } = _ => 0x03;

    public int StatusReads { get; private set; }

    /// <summary>T のレジスタ (バンク、番地)</summary>
    public Dictionary<(byte Bank, byte Register), byte> T { get; } = [];

    public Dictionary<byte, byte> X { get; } = [];

    public Dictionary<byte, byte> Tuner { get; } = [];

    public byte Bank { get; set; }

    public bool RelayOpen => X.GetValueOrDefault((byte)0x08) == 0x01;

    public byte ReadT(byte register)
    {
        if (register == 0xFD) return ChipId;
        if (Bank == 0x60 && register == 0x10) return Status(++StatusReads);
        return T.GetValueOrDefault((Bank, register));
    }

    public byte ReadTuner(byte register) => register switch
    {
        0x1A => TunerCpu,
        0x19 => Vco,
        _ => Tuner.GetValueOrDefault(register),
    };
}

/// <summary>
/// 偽の I2C のバス 1 本。読み書きを 1 行ずつ <see cref="Log"/> に控える。
/// 書き込みは <c>T 00=60</c>・<c>X 08=01</c>・<c>U 5E=150000</c> (続けて書いたバイトは並べる)、読みは <c>T C4?</c> の形。
/// 受信機が 2 つ以上あるときは、先頭に復調器の T のアドレスを付ける (<c>64 T 00=60</c>)
/// </summary>
internal sealed class FakeCxdBus : ICxdBus
{
    private readonly Dictionary<byte, FakeCxdReceiver> _byT = [];
    private readonly Dictionary<byte, FakeCxdReceiver> _byX = [];
    private readonly Dictionary<byte, byte> _pending = [];
    private readonly Lock _gate = new();

    public FakeCxdBus(params byte[] demods)
    {
        foreach (var address in demods)
        {
            var receiver = new FakeCxdReceiver(address);
            _byT[address] = receiver;
            _byX[(byte)(address + 2)] = receiver;
        }
    }

    public List<string> Log { get; } = [];

    /// <summary>書き込みのたびに呼ぶ (テストが割り込みの機会を作る)</summary>
    public Action? OnWrite { get; set; }

    public FakeCxdReceiver this[byte address] => _byT[address];

    private string Prefix(FakeCxdReceiver receiver) => _byT.Count > 1 ? $"{receiver.Address:X2} " : "";

    /// <summary>中継の先のチューナー。開いている中継がちょうど 1 つでなければテストを失敗にする</summary>
    private FakeCxdReceiver Relayed()
    {
        var open = _byT.Values.Where(receiver => receiver.RelayOpen).ToList();
        if (open.Count == 0) throw new InvalidOperationException("中継が開いていないのにチューナーに届いた");
        if (open.Count > 1) throw new InvalidOperationException($"同じバスで中継が {open.Count} つ開いている ({string.Join(", ", open.Select(r => $"0x{r.Address:X2}"))})");
        return open[0];
    }

    public void Write(byte address, ReadOnlySpan<byte> data)
    {
        lock (_gate)
        {
            if (data.Length == 0) throw new InvalidOperationException("中身の無い書き込み");
            var register = data[0];
            var values = data[1..].ToArray();
            if (values.Length == 0)
            {
                // 読む番地を決めるだけ (仕様書 1.3)
                _pending[address] = register;
            }
            else if (_byT.TryGetValue(address, out var t))
            {
                Log.Add($"{Prefix(t)}T {register:X2}={Convert.ToHexString(values)}");
                if (register == 0x00 && values.Length == 1) t.Bank = values[0];
                for (var i = 0; i < values.Length; i++) t.T[(t.Bank, (byte)(register + i))] = values[i];
            }
            else if (_byX.TryGetValue(address, out var x))
            {
                Log.Add($"{Prefix(x)}X {register:X2}={Convert.ToHexString(values)}");
                for (var i = 0; i < values.Length; i++) x.X[(byte)(register + i)] = values[i];
            }
            else if (address == Cxd2858.Address)
            {
                var u = Relayed();
                Log.Add($"{Prefix(u)}U {register:X2}={Convert.ToHexString(values)}");
                for (var i = 0; i < values.Length; i++) u.Tuner[(byte)(register + i)] = values[i];
            }
            else
            {
                throw new InvalidOperationException($"I2C のアドレス 0x{address:X2} には何もつながっていない");
            }
        }
        OnWrite?.Invoke();
    }

    public void Read(byte address, Span<byte> data)
    {
        lock (_gate)
        {
            if (!_pending.Remove(address, out var register)) throw new InvalidOperationException($"0x{address:X2} の読む番地を書かずに読んだ");
            if (_byT.TryGetValue(address, out var t))
            {
                Log.Add($"{Prefix(t)}T {register:X2}?");
                for (var i = 0; i < data.Length; i++) data[i] = t.ReadT((byte)(register + i));
            }
            else if (_byX.TryGetValue(address, out var x))
            {
                Log.Add($"{Prefix(x)}X {register:X2}?");
                for (var i = 0; i < data.Length; i++) data[i] = x.X.GetValueOrDefault((byte)(register + i));
            }
            else if (address == Cxd2858.Address)
            {
                var u = Relayed();
                Log.Add($"{Prefix(u)}U {register:X2}?");
                for (var i = 0; i < data.Length; i++) data[i] = u.ReadTuner((byte)(register + i));
            }
            else
            {
                throw new InvalidOperationException($"I2C のアドレス 0x{address:X2} には何もつながっていない");
            }
        }
    }
}

/// <summary>テストの時計。待つと進むだけ</summary>
internal sealed class FakeClock
{
    public long Now { get; private set; }

    public List<int> Sleeps { get; } = [];

    public void Sleep(int ms)
    {
        Sleeps.Add(ms);
        Now += ms;
    }
}
