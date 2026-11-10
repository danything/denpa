namespace Denpa.Agent.Tests;

/*
 * 偽の I2C のバス 1 本と、その上の TC90522 のアドレスと、中継の先のチューナー (R850・RT710)。振る舞いは仕様書 (denpa-spec の px4/spec.md) から決めた。
 * - 復調器のレジスタの番号は 1 バイトで、バンクは無い (仕様書 3.1)。書いた値 (Written) と、読むと返る値 (Status) は別に持つ
 *   (初期化で書く B0 と、ロックの判定で読む B0 のように、同じ番号を書く用途と読む用途で使うため)
 * - チューナーは、復調器のレジスタ FE に包んだ通信だけが届く (仕様書 3.2)。読むときは「00 を 1 バイト書く」「読む側のアドレスを書く」「復調器から読む」の順で、
 *   順が違えばテストを失敗にする (InvalidOperationException)。読んだ値は 1 バイトごとにビットの並びを逆にして返す (仕様書 7.1)
 */

/// <summary>
/// 偽のチューナー (R850 か RT710)。レジスタは本当の値で持ち、読むときにビットの並びを逆にして返す。
/// 書いた値 (<see cref="Registers"/>) は読むと返る。<see cref="Status"/> にあるレジスタは、書いた値によらずその値を返す (PLL のロックや種類のように、読む用途が別のレジスタ)
/// </summary>
internal sealed class FakeRafael(string name, byte address, int count)
{
    public string Name { get; } = name;

    public byte Address { get; } = address;

    public byte[] Registers { get; } = new byte[count];

    public Dictionary<int, byte> Status { get; } = [];

    /// <summary>読むたびに呼ぶ (引数は読んだ回数)。テストが読むたびに値を変える</summary>
    public Action<int>? OnRead { get; set; }

    public int Reads { get; private set; }

    /// <summary>この回数だけ、読み出しを I2C の誤りにする</summary>
    public int FailReads { get; set; }

    /// <summary>「00 を 1 バイト書く」を受けた (次の読み出しは 00 から)</summary>
    public bool Pointed { get; set; }

    public byte[] Read(int length)
    {
        Reads++;
        if (FailReads > 0)
        {
            FailReads--;
            throw new It930xException($"{Name} が応答しません (偽物)");
        }
        OnRead?.Invoke(Reads);
        if (length > Registers.Length) throw new InvalidOperationException($"{Name} から {length} バイト読んだ (レジスタは {Registers.Length} 個)");
        return [.. Enumerable.Range(0, length).Select(i => Tc90522Link.Reverse(Status.TryGetValue(i, out var status) ? status : Registers[i]))];
    }

    /// <summary>R850。<c>02</c> は PLL がロック (bit6) で、下位 6 ビットが 62 (水晶の駆動の強さを調べる手順のどの回も当てはまらない → 結果は 3)</summary>
    public static FakeRafael R850() => new("R850", Denpa.Agent.R850.Address, Denpa.Agent.R850.Registers) { Status = { [0x02] = 0x7E } };

    /// <summary>RT710。<c>03</c> の上位 4 ビットが 7 (RT710)、<c>02</c> は PLL がロック (bit7)</summary>
    public static FakeRafael Rt710() => new("RT710", Denpa.Agent.Rt710.Address, Denpa.Agent.Rt710.Registers) { Status = { [0x03] = 0x70, [0x02] = 0x80 } };
}

/// <summary>偽の TC90522 の 1 つのアドレスと、その中継の先のチューナー</summary>
internal sealed class FakeTcDemod(byte address)
{
    public byte Address { get; } = address;

    /// <summary>書かれた値 (最後の値)</summary>
    public Dictionary<byte, byte> Written { get; } = [];

    /// <summary>読むと返る値。無いレジスタは 0</summary>
    public Dictionary<byte, byte> Status { get; } = [];

    /// <summary>レジスタを読むたびに呼ぶ (レジスタと、そのレジスタを読んだ回数)。値を返せばそれを返す</summary>
    public Func<byte, int, byte?>? OnRead { get; set; }

    public Dictionary<byte, int> Reads { get; } = [];

    /// <summary>中継の先のチューナー (アドレスごと)</summary>
    public Dictionary<byte, FakeRafael> Tuners { get; } = [];

    /// <summary>次に読むレジスタ (番号の 1 バイトだけを書いて決める)</summary>
    public byte? Pointer { get; set; }

    /// <summary>「読む側のアドレスを書く」を受けたチューナー (次の読み出しはこのチューナーから)</summary>
    public FakeRafael? Reading { get; set; }

    public byte Read(byte register)
    {
        var count = Reads[register] = Reads.GetValueOrDefault(register) + 1;
        if (OnRead?.Invoke(register, count) is { } value) return value;
        // 選ばれている TSID (E6・E7) は、書かれた 8F・90 を返す (仕様書 6.4)
        if (register is 0xE6 or 0xE7 && !Status.ContainsKey(register)) return Written.GetValueOrDefault((byte)(register - 0xE6 + 0x8F));
        return Status.GetValueOrDefault(register);
    }
}

/// <summary>
/// 偽の I2C のバス 1 本。読み書きを 1 行ずつ <see cref="Log"/> に控える。
/// 復調器は <c>10 47=30</c> (書き込み)・<c>10 80?</c> (1 バイトの読み)・<c>11 CE?16</c> (16 バイトの読み)、
/// チューナーは <c>10 R850 08=CAC0…</c> (書き込み)・<c>10 R850 ?3</c> (00 から 3 バイトの読み) の形。先頭は中継に使った復調器のアドレス
/// </summary>
internal sealed class FakeTcBus : ICxdBus
{
    private readonly Dictionary<byte, FakeTcDemod> _demods = [];
    private readonly Lock _gate = new();

    public FakeTcBus(params byte[] addresses)
    {
        foreach (var address in addresses) _demods[address] = new FakeTcDemod(address);
    }

    public List<string> Log { get; } = [];

    public FakeTcDemod this[byte address] => _demods[address];

    /// <summary>
    /// Q3・W3 系の USB デバイス 1 つ分 (仕様書 2.2)。衛星のアドレス 0x11・0x13 の先に RT710、地上波のアドレス 0x10・0x12 の先に R850。
    /// どの受信機もロックしている状態 (地上波は 80 = 00・B0 = 88、衛星は C3 = 00)
    /// </summary>
    public static FakeTcBus W3()
    {
        var bus = new FakeTcBus(0x10, 0x11, 0x12, 0x13);
        foreach (var address in new byte[] { 0x11, 0x13 }) bus[address].Tuners[Rt710.Address] = FakeRafael.Rt710();
        foreach (var address in new byte[] { 0x10, 0x12 })
        {
            bus[address].Tuners[R850.Address] = FakeRafael.R850();
            bus[address].Status[0xB0] = 0x88;
        }
        return bus;
    }

    public void Write(byte address, ReadOnlySpan<byte> data)
    {
        lock (_gate)
        {
            if (!_demods.TryGetValue(address, out var demod)) throw new InvalidOperationException($"I2C のアドレス 0x{address:X2} には何もつながっていない");
            if (data.Length == 0) throw new InvalidOperationException("中身の無い書き込み");
            if (data[0] == Tc90522Link.Relay)
            {
                if (data.Length < 2) throw new InvalidOperationException("中継に、チューナーのアドレスが無い");
                if (!demod.Tuners.TryGetValue((byte)(data[1] >> 1), out var tuner))
                {
                    throw new InvalidOperationException($"0x{address:X2} の中継の先に、アドレス 0x{data[1] >> 1:X2} のチューナーは無い");
                }
                if ((data[1] & 1) != 0)
                {
                    if (data.Length != 2) throw new InvalidOperationException("読む側のアドレスのあとに、余分なバイトがある");
                    if (!tuner.Pointed) throw new InvalidOperationException($"{tuner.Name} に 00 を書かずに読もうとした");
                    tuner.Pointed = false;
                    demod.Reading = tuner;
                    return;
                }
                var payload = data[2..];
                if (payload.Length == 0) throw new InvalidOperationException("チューナーあての中身が無い");
                if (payload is [0x00])
                {
                    tuner.Pointed = true;
                    return;
                }
                Log.Add($"{address:X2} {tuner.Name} {payload[0]:X2}={Convert.ToHexString(payload[1..])}");
                payload[1..].CopyTo(tuner.Registers.AsSpan(payload[0]));
                return;
            }
            demod.Reading = null;
            if (data.Length == 1)
            {
                demod.Pointer = data[0];
                return;
            }
            Log.Add($"{address:X2} {data[0]:X2}={Convert.ToHexString(data[1..])}");
            for (var i = 1; i < data.Length; i++) demod.Written[(byte)(data[0] + i - 1)] = data[i];
        }
    }

    public void Read(byte address, Span<byte> data)
    {
        lock (_gate)
        {
            if (!_demods.TryGetValue(address, out var demod)) throw new InvalidOperationException($"I2C のアドレス 0x{address:X2} には何もつながっていない");
            if (demod.Reading is { } tuner)
            {
                demod.Reading = null;
                Log.Add($"{address:X2} {tuner.Name} ?{data.Length}");
                tuner.Read(data.Length).CopyTo(data);
                return;
            }
            if (demod.Pointer is not { } register) throw new InvalidOperationException($"0x{address:X2} の読むレジスタを書かずに読んだ");
            demod.Pointer = null;
            Log.Add($"{address:X2} {register:X2}?{(data.Length == 1 ? "" : data.Length)}");
            for (var i = 0; i < data.Length; i++) data[i] = demod.Read((byte)(register + i));
        }
    }
}
