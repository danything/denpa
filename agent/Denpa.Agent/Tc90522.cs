using System.Globalization;

namespace Denpa.Agent;

/*
 * 東芝 TC90522 (復調器) と、その先の R850・RT710 を組にした受信機。Q3・W3 系 (Tc90522Board) と、受信機が 1 つの機種 (Tc90522Single)。
 *
 * クリーンルームで、仕様書 (denpa-spec の tc90522/spec.md) だけから書いた。参考にした実装のソースは見ていない。
 * コメントの「仕様書 x.y」は tc90522/spec.md の節の番号 (ブリッジの側の it930x/spec.md は「IT930x の仕様書 x.y」と書く) で、表の値と順はその節の表のまま持つ。
 * 仕様書に無くて決めた所は「仕様書に無い」と書いてある。**実機で確かめたのは PX-Q3PE4 (Linux) だけ** (#1578)。
 */

/// <summary>復調器の 1 行の書き込み (レジスタと値。仕様書 3・4・5・11 の表の 1 行)</summary>
internal readonly record struct TcRow(byte Register, byte Value);

/// <summary>
/// TC90522 の 1 つのアドレス (仕様書 2.1)。レジスタの番号は 1 バイトで、バンクの切り替えは無い。**ロックは持たない** (呼ぶ側がバスのロックを持つ)
/// </summary>
internal sealed class Tc90522Link(ICxdBus bus, byte address)
{
    /// <summary>チューナーへの中継のレジスタ (仕様書 2.2)</summary>
    public const byte Relay = 0xFE;

    public byte Address => address;

    /// <summary>レジスタ <paramref name="register"/> から続けて書く (1 回の I2C の書き込み)</summary>
    public void Write(byte register, params ReadOnlySpan<byte> values)
    {
        Span<byte> data = stackalloc byte[1 + values.Length];
        data[0] = register;
        values.CopyTo(data[1..]);
        bus.Write(address, data);
    }

    /// <summary>読む (レジスタの番号の 1 バイトを書いてから、続けて読む)</summary>
    public byte[] Read(byte register, int length)
    {
        bus.Write(address, [register]);
        var data = new byte[length];
        bus.Read(address, data);
        return data;
    }

    /// <summary>表の行を順に書く (1 バイトずつ。どの行も続けて書く)</summary>
    public void Run(ReadOnlySpan<TcRow> rows)
    {
        foreach (var row in rows) Write(row.Register, row.Value);
    }

    /// <summary>このアドレスを通した、チューナーへの通信 (仕様書 2.2)</summary>
    public ITunerPort Tuner(byte tunerAddress) => new Port(bus, address, tunerAddress);

    /// <summary>
    /// チューナーあての通信を、復調器のレジスタ <c>FE</c> に 1 回ごとに包んで送る (仕様書 2.2)。
    /// 読むときは「<c>00</c> を 1 バイト書く」「読む側のアドレスを書く」「復調器から読む」の 3 回で、間にほかの I2C を挟まない (呼ぶ側がバスのロックを持つ)
    /// </summary>
    private sealed class Port(ICxdBus bus, byte demod, byte tuner) : ITunerPort
    {
        public void Write(ReadOnlySpan<byte> data)
        {
            Span<byte> wrapped = stackalloc byte[2 + data.Length];
            wrapped[0] = Relay;
            wrapped[1] = (byte)(tuner << 1);
            data.CopyTo(wrapped[2..]);
            bus.Write(demod, wrapped);
        }

        public byte[] Read(int length)
        {
            bus.Write(demod, [Relay, (byte)(tuner << 1), 0x00]);
            bus.Write(demod, [Relay, (byte)((tuner << 1) | 1)]);
            var data = new byte[length];
            bus.Read(demod, data);
            for (var i = 0; i < data.Length; i++) data[i] = Reverse(data[i]);
            return data;
        }
    }

    /// <summary>1 バイトのビットの並びを逆にする (bit7 と bit0、bit6 と bit1、…。仕様書 6.1)</summary>
    internal static byte Reverse(byte value)
    {
        var result = 0;
        for (var bit = 0; bit < 8; bit++)
        {
            if ((value & (1 << bit)) != 0) result |= 0x80 >> bit;
        }
        return (byte)result;
    }
}

/// <summary>
/// TC90522 の受信機に共通の手順と表 (仕様書 3〜5・8)。バスのロック・待ち・時計を持つ。
/// I2C の並びはバスのロックの中で送る。ロックを確かめる 10 ms おきの待ち (PLL・復調器・TSID) の間は、ロックを持たない。
/// チューナーの周波数を書く並びの中の短い待ち (R850 は 10〜40 ms、RT710 は 10 ms。仕様書 6.5 (5)・7.3 (2)) だけは、
/// 復調器の書き込みからチューナーの最後の書き込みまでを 1 つの並びとして送るために、ロックを持ったまま待つ。
/// その間、同じバスのほかの受信機の I2C は最大 40 ms 遅れるだけで、TS は I2C を通らないので受信は乱れない
/// </summary>
internal abstract class Tc90522Frontend(Lock busLock, Action<int> sleep, Func<long> nowMs) : IIt930xFrontend
{
    /// <summary>確かめる間隔 (ms。仕様書 10)</summary>
    public const int PollMs = 10;

    /// <summary>チューナーの PLL のロックを確かめる回数 (仕様書 10。約 0.5 秒)</summary>
    public const int PllPolls = 50;

    /// <summary>復調器のロックを確かめる回数 (仕様書 10。ISDB-T も ISDB-S も約 3 秒)</summary>
    public const int LockPolls = 300;

    /// <summary>ISDB-T でロックを確かめ始めてから成功を返すまでの最短の回数 (仕様書 4.3。350 ms)</summary>
    public const int SettlePolls = 35;

    /// <summary>ISDB-S の TMCC の TSID が読めるまで・TSID が切り替わるまでに確かめる回数 (仕様書 10。約 1 秒)</summary>
    public const int StreamPolls = 100;

    /// <summary>地上波の起動 (仕様書 3.2 の 1〜12)。受信機が 1 つの機種は先頭の 8 行だけを使う (仕様書 11.1)</summary>
    internal static readonly TcRow[] WakeTerrestrialRows =
    [
        new(0xB0, 0xA0), new(0xB2, 0x3D), new(0xB3, 0x25), new(0xB4, 0x8B), new(0xB5, 0x4B), new(0xB6, 0x3F), new(0xB7, 0xFF), new(0xB8, 0xC0),
        new(0x1F, 0x00), new(0x75, 0x00), new(0x1D, 0xA8), new(0x03, 0x00),
    ];

    /// <summary>衛星の起動 (仕様書 3.2 の 1〜7)</summary>
    internal static readonly TcRow[] WakeSatelliteRows =
    [
        new(0x15, 0x00), new(0x1D, 0x00), new(0x04, 0x02), new(0x1C, 0x80), new(0x1F, 0x22), new(0x13, 0x00), new(0x17, 0x00),
    ];

    /// <summary>地上波のスリープ (仕様書 3.3)</summary>
    internal static readonly TcRow[] SleepTerrestrialRows = [new(0x03, 0xF0)];

    /// <summary>衛星のスリープ (仕様書 3.3。この順)</summary>
    internal static readonly TcRow[] SleepSatelliteRows = [new(0x13, 0x80), new(0x17, 0xFF)];

    /// <summary>地上波の TS の端子を出す・止める (仕様書 3.5)</summary>
    internal static readonly TcRow[] TsOnTerrestrialRows = [new(0x1D, 0x00)];

    internal static readonly TcRow[] TsOffTerrestrialRows = [new(0x1D, 0xA8)];

    /// <summary>衛星の TS の端子を出す・止める (仕様書 3.5)</summary>
    internal static readonly TcRow[] TsOnSatelliteRows = [new(0x1C, 0x00), new(0x1F, 0x00)];

    internal static readonly TcRow[] TsOffSatelliteRows = [new(0x1C, 0x80), new(0x1F, 0x22)];

    /// <summary>ISDB-T の選局の、R850 の前 (仕様書 4.2 の 1〜6)</summary>
    internal static readonly TcRow[] TuneTerrestrialHeadRows =
    [
        new(0x47, 0x30), new(0x25, 0x00), new(0x20, 0x00), new(0x23, 0x4D), new(0x01, 0x50), new(0x76, 0x0C),
    ];

    /// <summary>ISDB-T の選局の、R850 のあと (仕様書 4.2 の 9〜15)</summary>
    internal static readonly TcRow[] TuneTerrestrialTailRows =
    [
        new(0x25, 0x00), new(0x20, 0x00), new(0x23, 0x4C), new(0x01, 0x50), new(0x71, 0x21), new(0x72, 0x25), new(0x75, 0x08),
    ];

    /// <summary>ISDB-S の選局の、RT710 の前 (仕様書 5.2 の 1〜6)。<paramref name="second"/> は「2 つ目」の印 (<c>10</c> の値が違う)</summary>
    internal static TcRow[] TuneSatelliteHeadRows(bool second) =>
    [
        new(0x0A, 0x00), new(0x10, (byte)(second ? 0x30 : 0xB0)), new(0x11, 0x02), new(0x03, 0x01), new(0x8E, 0x06), new(0xA3, 0xF7),
    ];

    /// <summary>ISDB-S の選局の、RT710 のあと (仕様書 5.2 の 9〜12)</summary>
    internal static TcRow[] TuneSatelliteTailRows(bool second) =>
    [
        new(0x0A, 0xFF), new(0x10, (byte)(second ? 0x32 : 0xB2)), new(0x11, 0x00), new(0x03, 0x01),
    ];

    protected Lock BusLock { get; } = busLock;

    protected Action<int> Sleep { get; } = sleep;

    public long LockMs { get; protected set; } = -1;

    public abstract string Chips { get; }

    public abstract bool Tune(ChannelTable.Tuning tuning);

    public abstract void Stream(bool on);

    public abstract TunerSignal? Signal();

    public virtual ushort[]? SatelliteStreams() => null;

    public virtual IReadOnlyList<string> Notes() => [];

    /// <summary>表の行を、バスのロックの中で順に書く</summary>
    protected void Run(Tc90522Link link, ReadOnlySpan<TcRow> rows)
    {
        lock (BusLock) link.Run(rows);
    }

    /// <summary>
    /// チューナーの PLL のロックを待つ (仕様書 4.2 の 8・5.2 の 8)。10 ms おきに 50 回まで。ロックしなければ <see cref="IOException"/>
    /// (電波の有無によらない失敗なので、「同期しませんでした」とは分ける。仕様書に無い)
    /// </summary>
    protected void WaitPll(Func<bool> locked, string chip)
    {
        for (var i = 0; i < PllPolls; i++)
        {
            bool ok;
            lock (BusLock) ok = locked();
            if (ok) return;
            Sleep(PollMs);
        }
        throw new IOException($"{chip} の PLL がロックしませんでした");
    }

    /// <summary>ISDB-T がロックしているか (仕様書 4.3)。<c>80</c> の bit5・bit3 がどちらも 0 で、<c>B0</c> の下位 4 ビットが 8 以上。バスのロックの中で呼ぶ</summary>
    protected static bool TerrestrialLocked(Tc90522Link link) =>
        (link.Read(0x80, 1)[0] & 0x28) == 0 && (link.Read(0xB0, 1)[0] & 0x0F) >= 8;

    /// <summary>
    /// ISDB-T のロックを待つ (仕様書 4.3)。10 ms おきに 300 回まで。350 ms より早くロックしたら、確かめ始めてから 350 ms になるまで待ってから返す
    /// </summary>
    protected bool WaitTerrestrial(Tc90522Link link)
    {
        LockMs = -1;
        var started = nowMs();
        for (var i = 0; i < LockPolls; i++)
        {
            bool locked;
            lock (BusLock) locked = TerrestrialLocked(link);
            if (locked)
            {
                LockMs = nowMs() - started;
                if (i < SettlePolls) Sleep((SettlePolls - i) * PollMs);
                return true;
            }
            Sleep(PollMs);
        }
        return false;
    }

    /// <summary>ISDB-S がロックしているか (仕様書 5.3)。<c>C3</c> の bit4 が 0。バスのロックの中で呼ぶ</summary>
    protected static bool SatelliteLocked(Tc90522Link link) => (link.Read(0xC3, 1)[0] & 0x10) == 0;

    /// <summary>ISDB-S のロックを待つ (仕様書 5.3)。10 ms おきに 300 回まで</summary>
    protected bool WaitSatellite(Tc90522Link link)
    {
        LockMs = -1;
        var started = nowMs();
        for (var i = 0; i < LockPolls; i++)
        {
            bool locked;
            lock (BusLock) locked = SatelliteLocked(link);
            if (locked)
            {
                LockMs = nowMs() - started;
                return true;
            }
            Sleep(PollMs);
        }
        return false;
    }

    /// <summary>
    /// ISDB-S の TS を選ぶ (仕様書 5.4)。ロックのあとに呼ぶ。相対 TS 番号で指定されたときは TMCC から TSID を読む。
    /// TSID を書き、選ばれている TSID が同じになるまで待つ。その TS が無い・切り替わらないときは false (選局表の TSID が古いときに起きるので、同期しなかったものとして扱う。仕様書に無い)
    /// </summary>
    protected bool SelectStream(Tc90522Link link, CxdStream stream)
    {
        ushort tsid;
        if (stream.Tsid is { } given)
        {
            tsid = given;
        }
        else
        {
            tsid = 0;
            for (var i = 0; i < StreamPolls && tsid == 0; i++)
            {
                byte[] read;
                lock (BusLock) read = link.Read((byte)(0xCE + 2 * stream.Relative), 2);
                tsid = (ushort)((read[0] << 8) | read[1]);
                if (tsid == 0) Sleep(PollMs);
            }
            if (tsid == 0) return false;
        }
        lock (BusLock) link.Write(0x8F, (byte)(tsid >> 8), (byte)tsid);
        for (var i = 0; i < StreamPolls; i++)
        {
            byte[] read;
            lock (BusLock) read = link.Read(0xE6, 2);
            if (((read[0] << 8) | read[1]) == tsid) return true;
            Sleep(PollMs);
        }
        return false;
    }

    /// <summary>ISDB-T の受信の状態と C/N (仕様書 8.1)。ロックを確かめてから <c>8B</c> の 3 バイトを読む。式は <see cref="TunerSignal.Tc90522Db"/></summary>
    protected TunerSignal TerrestrialSignal(Tc90522Link link)
    {
        lock (BusLock)
        {
            if (!TerrestrialLocked(link)) return new TunerSignal(false, null, TunerSignal.Db);
            var read = link.Read(0x8B, 3);
            return new TunerSignal(true, TunerSignal.Tc90522Db(false, (uint)((read[0] << 16) | (read[1] << 8) | read[2])), TunerSignal.Db);
        }
    }

    /// <summary>ISDB-S の受信の状態と C/N (仕様書 8.2)。ロックを確かめてから <c>BC</c> の 2 バイトを読む</summary>
    protected TunerSignal SatelliteSignal(Tc90522Link link)
    {
        lock (BusLock)
        {
            if (!SatelliteLocked(link)) return new TunerSignal(false, null, TunerSignal.Db);
            var read = link.Read(0xBC, 2);
            return new TunerSignal(true, TunerSignal.Tc90522Db(true, (uint)((read[0] << 8) | read[1])), TunerSignal.Db);
        }
    }

    /// <summary>
    /// TMCC にある TSID の一覧 (相対 TS 番号 0〜7 の順。0 はその番号の TS が無い。仕様書 5.4)。
    /// 読む前とあとにロックを確かめ、どちらかでロックしていなければ null
    /// </summary>
    protected ushort[]? Streams(Tc90522Link link)
    {
        lock (BusLock)
        {
            if (!SatelliteLocked(link)) return null;
            var read = link.Read(0xCE, 16);
            if (!SatelliteLocked(link)) return null;
            return [.. Enumerable.Range(0, 8).Select(i => (ushort)((read[2 * i] << 8) | read[2 * i + 1]))];
        }
    }

    /// <summary>
    /// ISDB-T の <c>--tune</c> だけに出す値 (仕様書 4.4・8.3)。伝送モード・ガードインターバル・部分受信の有無と、階層ごとの誤り率。
    /// 誤り率は、この基板で値を確かめた記録が無い (仕様書 8.3)
    /// </summary>
    protected List<string> TerrestrialNotes(Tc90522Link link)
    {
        byte mode, partial;
        byte[] errors;
        lock (BusLock)
        {
            if (!TerrestrialLocked(link)) return [];
            mode = link.Read(0xB0, 1)[0];
            partial = link.Read(0xB2, 1)[0];
            errors = link.Read(0x9D, 15);
        }
        string[] guards = ["1/32", "1/16", "1/8", "1/4"];
        var rates = Enumerable.Range(0, 3).Select(layer => Rate(
            (errors[3 * layer] << 16) | (errors[3 * layer + 1] << 8) | errors[3 * layer + 2],
            (errors[9 + 2 * layer] << 8) | errors[9 + 2 * layer + 1]));
        return
        [
            $"TMCC  モード {(mode >> 6) + 1}  ガードインターバル {guards[(mode >> 4) & 3]}  部分受信 {((partial & 1) != 0 ? "あり" : "なし")}",
            $"誤り率 (未確認の値)  A {rates.ElementAt(0)}  B {rates.ElementAt(1)}  C {rates.ElementAt(2)}",
        ];
    }

    /// <summary>ISDB-S の <c>--tune</c> だけに出す値 (仕様書 8.3)。高階層・低階層の誤り率。この基板で値を確かめた記録が無い</summary>
    protected List<string> SatelliteNotes(Tc90522Link link)
    {
        byte[] errors;
        lock (BusLock)
        {
            if (!SatelliteLocked(link)) return [];
            errors = link.Read(0xEB, 10);
        }
        var rates = Enumerable.Range(0, 2).Select(layer => Rate(
            (errors[5 * layer] << 16) | (errors[5 * layer + 1] << 8) | errors[5 * layer + 2],
            (errors[5 * layer + 3] << 8) | errors[5 * layer + 4]));
        return [$"誤り率 (未確認の値)  高階層 {rates.ElementAt(0)}  低階層 {rates.ElementAt(1)}"];
    }

    /// <summary>誤り率 = 誤りの数 ÷ (パケットの数 × 204 × 8) (仕様書 8.3)。パケットの数が 0 なら「-」</summary>
    internal static string Rate(int errors, int packets) =>
        packets == 0 ? "-" : (errors / (packets * 204.0 * 8)).ToString("G3", CultureInfo.InvariantCulture);

    /// <summary>R850 について <c>--tune</c> に出す行 (付録 C.1 と比べるため。仕様書 12 の 6)</summary>
    protected static string R850Note(R850 tuner) => tuner.Written is { } plan
        ? $"R850  種類 {tuner.Kind} (00 = 0x{tuner.Id:X2})  水晶の駆動の強さ {tuner.XtalDrive}  M {plan.Divider}  N {plan.N}  S {plan.Fraction:X4}  "
            + $"08〜2F {Convert.ToHexString(plan.Registers)}  2F {plan.Final:X2}"
        : $"R850  種類 {tuner.Kind} (00 = 0x{tuner.Id:X2})  水晶の駆動の強さ {tuner.XtalDrive}";

    /// <summary>RT710 について <c>--tune</c> に出す行。入力のレベルは RT710 だけ (仕様書 8.4。単位は 0.001 dBm と推定されている)</summary>
    protected string Rt710Note(Rt710 tuner, uint khz)
    {
        int? level;
        lock (BusLock) level = tuner.Level(khz);
        return $"{tuner.Name} (03 = 0x{tuner.Id:X2})" + (level is { } value ? $"  入力のレベル {value} (単位は 0.001 dBm と推定)" : "");
    }

    public virtual IReadOnlyList<string> Diagnose() => [];

    /// <summary>読めた値の 1 行。I2C の誤りなら、読めなかった理由の 1 行 (選局に失敗したあとに、分かるところまで出すため)</summary>
    private string Line(string label, Func<string> read)
    {
        try
        {
            lock (BusLock) return $"{label}  {read()}";
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            return $"{label}  読めません ({error.Message})";
        }
    }

    /// <summary>
    /// 地上波の選局のあと、ロックしたかによらずに出す行 (<c>--tune</c> が失敗のあとに出す)。
    /// R850 に書いた値・R850 の PLL の状態 (<c>02</c>)・ロックの判定で読む復調器の <c>80</c> と <c>B0</c> (仕様書 4.3・6.6)
    /// </summary>
    protected List<string> DiagnoseTerrestrial(Tc90522Link link, R850 tuner) =>
    [
        R850Note(tuner),
        Line("R850 の PLL", () => tuner.Status() is var status && (status & 0x40) != 0
            ? $"ロックしている (02 = 0x{status:X2}。bit6 がロック)"
            : $"ロックしていない (02 = 0x{status:X2}。bit6 がロック)"),
        Line($"復調器 0x{link.Address:X2}", () =>
            $"80 = 0x{link.Read(0x80, 1)[0]:X2}  B0 = 0x{link.Read(0xB0, 1)[0]:X2}  (ロックは、80 の bit5 と bit3 が 0 で、B0 の下位 4 ビットが 8 以上)"),
    ];

    /// <summary>
    /// 衛星の選局のあと、ロックしたかによらずに出す行。RT710 か RT720 かと書いた値・PLL の状態 (<c>02</c>)・ロックの判定で読む復調器の <c>C3</c> (仕様書 5.3・7.4)、
    /// TMCC にある TSID の一覧と、選ばれている TSID (仕様書 5.4。ロックを確かめずに、読めた値のまま出す)
    /// </summary>
    protected List<string> DiagnoseSatellite(Tc90522Link link, Rt710 tuner) =>
    [
        $"{tuner.Name} (03 = 0x{tuner.Id:X2})  書いた値 "
            + (tuner.Written is { } written ? string.Join(" ", written.Select(write => $"{write.Register:X2}={Convert.ToHexString(write.Values)}")) : "無し"),
        Line($"{tuner.Name} の PLL", () => tuner.Status() is var status && (status & 0x80) != 0
            ? $"ロックしている (02 = 0x{status:X2}。bit7 がロック)"
            : $"ロックしていない (02 = 0x{status:X2}。bit7 がロック)"),
        Line($"復調器 0x{link.Address:X2}", () => $"C3 = 0x{link.Read(0xC3, 1)[0]:X2}  (ロックは bit4 が 0)"),
        Line("TMCC の TSID", () =>
        {
            var read = link.Read(0xCE, 16);
            var selected = link.Read(0xE6, 2);
            return string.Join(" ", Enumerable.Range(0, 8).Select(i => $"{i}:{(read[2 * i] << 8) | read[2 * i + 1]}"))
                + $"  選ばれている TSID {(selected[0] << 8) | selected[1]}";
        }),
    ];

    /// <summary>受けられない方式の選局を、何も書かずに断る</summary>
    protected static IOException Refuse(ChannelTable.Tuning tuning, string takes) =>
        new($"この受信機は{takes}だけを受けられます ({tuning.Type} は選局できません)");
}

/// <summary>
/// Q3・W3 系の地上波の受信機 (TC90522 の地上波のアドレス + R850。仕様書 1.2)。開く・閉じるの順は <see cref="Tc90522Board"/> が決める
/// </summary>
internal sealed class Tc90522Terrestrial : Tc90522Frontend, ITc90522Receiver
{
    private readonly Tc90522Link _link;
    private readonly R850 _tuner;
    private bool _tuned;

    /// <summary>開いてから、選局の書き込みを始めたことがある (<see cref="Diagnose"/> が出すものがある)</summary>
    private bool _attempted;

    public Tc90522Terrestrial(ICxdBus bus, Lock busLock, It930xReceiver wiring, Action<int> sleep, Func<long> nowMs) : base(busLock, sleep, nowMs)
    {
        _link = new Tc90522Link(bus, wiring.DemodAddress);
        _tuner = new R850(_link.Tuner(R850.Address), wiring.Loopthrough, sleep);
    }

    public Tc90522Link Link => _link;

    public override string Chips => $"TC90522 0x{_link.Address:X2} + R850 (種類 {_tuner.Kind}、水晶の駆動の強さ {_tuner.XtalDrive})";

    public void InitTuner()
    {
        lock (BusLock) _tuner.Init();
    }

    /// <summary>起動 (仕様書 3.2)。R850 の方式は ISDB-T・6 MHz・IF 4063 kHz に決まっていて、チューナーへは何も書かない</summary>
    public void Wake()
    {
        _tuned = false;
        Run(_link, WakeTerrestrialRows);
    }

    /// <summary>スリープ (仕様書 3.1 の 3・9.3)。復調器だけ。R850 には何も書かない (仕様書 6.7)</summary>
    public void Rest()
    {
        _tuned = false;
        Run(_link, SleepTerrestrialRows);
    }

    public void Forget() => _tuned = _attempted = false;

    /// <summary>ISDB-T を選局し、ロックを待つ (仕様書 4.2)。ロックしなければ false</summary>
    public override bool Tune(ChannelTable.Tuning tuning)
    {
        if (tuning.Satellite || tuning.Cable || tuning.IsdbC) throw Refuse(tuning, "地上波");
        var khz = It930xTuner.Khz(tuning.Frequency);
        if (khz is < R850.MinKhz or > R850.MaxKhz) throw new IOException($"地上波の周波数は {R850.MinKhz}〜{R850.MaxKhz} kHz です ({khz} kHz)");
        _tuned = false;
        _attempted = true;
        lock (BusLock)
        {
            _link.Run(TuneTerrestrialHeadRows);
            _tuner.SetFrequency(khz);
        }
        WaitPll(_tuner.PllLocked, "R850");
        Run(_link, TuneTerrestrialTailRows);
        _tuned = true;
        return WaitTerrestrial(_link);
    }

    /// <summary>TS の端子を出す・止める (仕様書 3.5)</summary>
    public override void Stream(bool on) => Run(_link, on ? TsOnTerrestrialRows : TsOffTerrestrialRows);

    public override TunerSignal? Signal() => _tuned ? TerrestrialSignal(_link) : null;

    public override IReadOnlyList<string> Notes() => _tuned ? [.. TerrestrialNotes(_link), R850Note(_tuner)] : [];

    public override IReadOnlyList<string> Diagnose() => _attempted ? DiagnoseTerrestrial(_link, _tuner) : [];
}

/// <summary>
/// Q3・W3 系の衛星の受信機 (TC90522 の衛星のアドレス + RT710。仕様書 1.2)。開く・閉じるの順は <see cref="Tc90522Board"/> が決める
/// </summary>
internal sealed class Tc90522Satellite : Tc90522Frontend, ITc90522Receiver
{
    private readonly Tc90522Link _link;
    private readonly Rt710 _tuner;
    private readonly bool _second;
    private bool _tuned;

    /// <summary>開いてから、選局の書き込みを始めたことがある (<see cref="Diagnose"/> が出すものがある)</summary>
    private bool _attempted;
    private uint _khz;

    public Tc90522Satellite(ICxdBus bus, Lock busLock, It930xReceiver wiring, Action<int> sleep, Func<long> nowMs) : base(busLock, sleep, nowMs)
    {
        _link = new Tc90522Link(bus, wiring.DemodAddress);
        _tuner = new Rt710(_link.Tuner(Rt710.Address), sleep);
        _second = wiring.Second;
    }

    public Tc90522Link Link => _link;

    public override string Chips => $"TC90522 0x{_link.Address:X2} + {_tuner.Name}";

    public void InitTuner()
    {
        lock (BusLock) _tuner.Init();
    }

    /// <summary>起動 (仕様書 3.2)。RT710 には何も書かない (選局のたびに全部のレジスタを書く)</summary>
    public void Wake()
    {
        _tuned = false;
        Run(_link, WakeSatelliteRows);
    }

    /// <summary>スリープ (仕様書 3.1 の 3・9.3)。RT710 を待機にして (仕様書 7.5)、続けて復調器をスリープにする</summary>
    public void Rest()
    {
        _tuned = false;
        lock (BusLock)
        {
            _tuner.Standby();
            _link.Run(SleepSatelliteRows);
        }
    }

    public void Forget() => _tuned = _attempted = false;

    /// <summary>
    /// ISDB-S を選局し、ロックを待って TS を選ぶ (仕様書 5.2)。周波数は LNB で変換したあとの kHz (仕様書 5.1)。
    /// ロックしない・TS を選べなければ false
    /// </summary>
    public override bool Tune(ChannelTable.Tuning tuning)
    {
        if (!tuning.Satellite) throw Refuse(tuning, "衛星");
        _tuned = false;
        _attempted = true;
        lock (BusLock)
        {
            _link.Run(TuneSatelliteHeadRows(_second));
            _tuner.SetFrequency(tuning.Frequency);
        }
        WaitPll(_tuner.PllLocked, _tuner.Name);
        Run(_link, TuneSatelliteTailRows(_second));
        _khz = tuning.Frequency;
        _tuned = true;
        return WaitSatellite(_link) && SelectStream(_link, CxdStream.From(tuning.StreamId));
    }

    /// <summary>TS の端子を出す・止める (仕様書 3.5)</summary>
    public override void Stream(bool on) =>
        Run(_link, on ? TsOnSatelliteRows : TsOffSatelliteRows);

    public override TunerSignal? Signal() => _tuned ? SatelliteSignal(_link) : null;

    public override ushort[]? SatelliteStreams() => _tuned ? Streams(_link) : null;

    public override IReadOnlyList<string> Notes() => _tuned ? [.. SatelliteNotes(_link), Rt710Note(_tuner, _khz)] : [];

    public override IReadOnlyList<string> Diagnose() => _attempted ? DiagnoseSatellite(_link, _tuner) : [];
}

/// <summary>Q3・W3 系の受信機に、基板 (<see cref="Tc90522Board"/>) がさせること</summary>
internal interface ITc90522Receiver : IIt930xFrontend
{
    Tc90522Link Link { get; }

    /// <summary>チューナーの初期化 (仕様書 6.3・7.2)</summary>
    void InitTuner();

    /// <summary>起動 (仕様書 3.2)</summary>
    void Wake();

    /// <summary>スリープ (仕様書 3.1 の 3・9.3)</summary>
    void Rest();

    /// <summary>何も書かずに、選局していない状態に戻す (最後の受信機を閉じるとき。仕様書 9.3)</summary>
    void Forget();
}

/// <summary>
/// Q3・W3 系の USB デバイス 1 つ分 (W3 の全体、Q3 の片側) の 4 つの受信機 (仕様書 1・3・9)。
///
/// <para>
/// **開いている受信機が無い状態から開くとき** (仕様書 3.1): 4 つのチューナーを受信機 0 から 3 の順に初期化し、開く受信機のほかの 3 つをスリープにし、
/// 開く受信機を起動して、TS 出力の共通設定 (仕様書 3.4) を書く。2 つ目からは起動だけ (仕様書 3.2)。
/// 電源は機材 (<see cref="It930xDevice"/>) が開いている間入っているので、ここでは操作しない。カードや Q3 のもう片方の側のために電源だけが入っていたときも、
/// 最初の受信機を開くたびに初期化からやり直す (IT930x の仕様書 7.4)。
/// </para>
///
/// <para>
/// **閉じるとき** (仕様書 9.3): ほかに開いている受信機があればスリープにする。最後の受信機は何も書かない (電源を切るか、次に開くときに初期化からやり直す)。
/// </para>
/// </summary>
internal sealed class Tc90522Board : IIt930xBoard
{
    /// <summary>TS 出力の共通設定 (仕様書 3.4)。受信機 0 の衛星のアドレスに書く 2 行</summary>
    internal static readonly TcRow[] CommonSatelliteRows = [new(0x07, 0x31), new(0x08, 0x77)];

    /// <summary>TS 出力の共通設定 (仕様書 3.4)。受信機 2 の地上波のアドレスに書く 2 行</summary>
    internal static readonly TcRow[] CommonTerrestrialRows = [new(0x0E, 0x77), new(0x0F, 0x13)];

    private readonly Lock _gate = new();
    private readonly Lock _busLock;
    private readonly ITc90522Receiver[] _receivers;
    private readonly HashSet<int> _open = [];

    public Tc90522Board(ICxdBus bus, Lock busLock, It930xModel model, Action<int> sleep, Func<long> nowMs)
    {
        _busLock = busLock;
        _receivers =
        [
            .. model.Receivers.OrderBy(receiver => receiver.Index).Select(receiver => receiver.Demod == It930xDemod.Tc90522S
                ? (ITc90522Receiver)new Tc90522Satellite(bus, busLock, receiver, sleep, nowMs)
                : new Tc90522Terrestrial(bus, busLock, receiver, sleep, nowMs)),
        ];
    }

    public IIt930xFrontend Open(int receiver)
    {
        lock (_gate)
        {
            var frontend = _receivers[receiver];
            if (_open.Contains(receiver)) return frontend;
            if (_open.Count == 0)
            {
                // 4 つのチューナーを受信機 0 から 3 の順に初期化する (仕様書 3.1 の 2)
                foreach (var each in _receivers) each.InitTuner();
                // これから開く受信機を除く 3 つをスリープにする (仕様書 3.1 の 3)
                for (var other = 0; other < _receivers.Length; other++)
                {
                    if (other != receiver) _receivers[other].Rest();
                }
                frontend.Wake();
                // TS 出力の共通設定 (仕様書 3.4)。相手がスリープ中でも書く
                lock (_busLock)
                {
                    _receivers[0].Link.Run(CommonSatelliteRows);
                    _receivers[2].Link.Run(CommonTerrestrialRows);
                }
            }
            else
            {
                frontend.Wake();
            }
            _open.Add(receiver);
            return frontend;
        }
    }

    public void Close(int receiver)
    {
        lock (_gate)
        {
            if (!_open.Remove(receiver)) return;
            if (_open.Count > 0) _receivers[receiver].Rest();
            else _receivers[receiver].Forget();
        }
    }
}

/// <summary>
/// 受信機が 1 つの機種 (ISDB2056・ISDB2056N・PX-M1UR・PX-S1UR と DTV03A-1TU。仕様書 11.1・11.2)。
/// ISDB2056 系は、地上波と衛星を選局のたびに切り替える (PX-S1UR は地上波だけ)。DTV03A-1TU は地上波だけで、復調器の初期化と選局の値が違う。
/// **受信機を開くたびに電源を入れ、閉じるたびに切る** (カードのためには入れない)。LNB の給電の操作は無い
/// </summary>
internal sealed class Tc90522Single : Tc90522Frontend, IIt930xBoard
{
    /// <summary>DTV03A-1TU を開くときに復調器へ書く 17 行 (仕様書 11.2)</summary>
    internal static readonly TcRow[] OpenIsdbt2071Rows =
    [
        new(0x04, 0x00), new(0x10, 0x00), new(0x11, 0x2D), new(0x12, 0x02), new(0x13, 0x62), new(0x14, 0x60), new(0x15, 0x00), new(0x16, 0x00),
        new(0x1D, 0x05), new(0x1E, 0x15), new(0x1F, 0x40), new(0x30, 0x20), new(0x31, 0x0B), new(0x32, 0x8F), new(0x34, 0x0F), new(0x38, 0x01),
        new(0x39, 0x1C),
    ];

    /// <summary>DTV03A-1TU の選局の、R850 の前 (仕様書 11.2 の 1〜7)</summary>
    internal static readonly TcRow[] TuneIsdbt2071HeadRows =
    [
        new(0x47, 0x30), new(0x25, 0x00), new(0x20, 0x00), new(0x23, 0x4D), new(0x01, 0x50),
        new(0x76, 0x03), new(0x77, 0x01), new(0x3B, 0x10), new(0x3C, 0x10), new(0x3D, 0x24),
    ];

    /// <summary>AGC を止める・動かす 4 行 (仕様書 11.1 の地上波の 2・11、11.2 の 2・9)</summary>
    internal static readonly TcRow[] AgcStopRows = [new(0x25, 0x00), new(0x20, 0x00), new(0x23, 0x4D), new(0x01, 0x50)];

    internal static readonly TcRow[] AgcRunRows = [new(0x25, 0x00), new(0x20, 0x00), new(0x23, 0x4C), new(0x01, 0x50)];

    /// <summary>選局のあと、ロックを待つ前の待ち (ms。仕様書 10・11.1・11.2)</summary>
    public const int AfterTuneMs = 100;

    private enum Mode
    {
        None,
        Terrestrial,
        Satellite,
    }

    private readonly Lock _gate = new();
    private readonly It930xReceiver _wiring;
    private readonly Action<bool> _power;
    private readonly Tc90522Link _t;
    private readonly Tc90522Link? _s;
    private readonly Tc90522Link? _s0;
    private readonly R850 _r850;
    private readonly Rt710? _rt710;
    private bool _open;
    private Mode _mode = Mode.None;

    /// <summary>開いてから最後に選局の書き込みを始めた方式 (<see cref="Diagnose"/> が、失敗したあとにどちらの側を読むかを決める)</summary>
    private Mode _attempt = Mode.None;
    private uint _khz;

    /// <param name="power">受信機の基板の電源を入れる・切る (<see cref="It930xDevice.Power"/>)</param>
    public Tc90522Single(ICxdBus bus, Lock busLock, It930xReceiver wiring, Action<bool> power, Action<int> sleep, Func<long> nowMs) : base(busLock, sleep, nowMs)
    {
        _wiring = wiring;
        _power = power;
        _t = new Tc90522Link(bus, wiring.DemodAddress);
        _r850 = new R850(_t.Tuner(R850.Address), wiring.Loopthrough, sleep);
        if (wiring.Demod != It930xDemod.Tc90522Switch) return;
        _s = new Tc90522Link(bus, wiring.SatelliteAddress);
        _s0 = new Tc90522Link(bus, wiring.SatelliteTsAddress);
        if (wiring.Tuner == It930xTunerChip.R850Rt710) _rt710 = new Rt710(_s.Tuner(Rt710.Address), sleep);
    }

    private bool Isdbt2071 => _wiring.Demod == It930xDemod.Isdbt2071;

    public override string Chips =>
        $"{(Isdbt2071 ? "復調器" : "TC90522")} 0x{_t.Address:X2} + R850 (種類 {_r850.Kind}、水晶の駆動の強さ {_r850.XtalDrive})" + (_rt710 is { } rt710 ? $" + {rt710.Name}" : "");

    /// <summary>開く (仕様書 11.1・11.2 の「受信機を開く」)。電源を入れ、チューナーを初期化して、復調器を止めた状態にする。失敗したら電源を切る</summary>
    public IIt930xFrontend Open(int receiver)
    {
        lock (_gate)
        {
            if (_open) return this;
            _mode = _attempt = Mode.None;
            _power(true);
            try
            {
                lock (BusLock)
                {
                    _r850.Init();
                    if (Isdbt2071)
                    {
                        _t.Run(OpenIsdbt2071Rows);
                        _t.Run([new(0x1D, 0xA8), new(0x03, 0x00)]);
                    }
                    else
                    {
                        _rt710?.Init();
                        _t.Run(WakeTerrestrialRows.AsSpan(0, 8));
                        // TS の端子を止めて、地上波の側をスリープにする
                        _t.Run([new(0x1D, 0xA8), new(0x03, 0xF0)]);
                        // 衛星の側。PX-S1UR でも書く (相手は 0x11。仕様書 11.1)
                        _s!.Run([new(0x15, 0x00), new(0x1D, 0x00), new(0x1C, 0x80), new(0x1F, 0x22), new(0x13, 0x80), new(0x17, 0xFF)]);
                    }
                }
            }
            catch
            {
                try
                {
                    _power(false);
                }
                catch (IOException)
                {
                    // 元の失敗を返す
                }
                throw;
            }
            _open = true;
            return this;
        }
    }

    /// <summary>閉じる (仕様書 11.1)。電源を切る。スリープの書き込みはしない</summary>
    public void Close(int receiver)
    {
        lock (_gate)
        {
            if (!_open) return;
            _open = false;
            _mode = _attempt = Mode.None;
            _power(false);
        }
    }

    public override bool Tune(ChannelTable.Tuning tuning)
    {
        if (tuning.Cable || tuning.IsdbC) throw Refuse(tuning, _rt710 is null ? "地上波" : "地上波と衛星");
        if (tuning.Satellite) return _rt710 is { } rt710 ? TuneSatellite(tuning, rt710) : throw Refuse(tuning, "地上波");
        var khz = It930xTuner.Khz(tuning.Frequency);
        if (khz is < R850.MinKhz or > R850.MaxKhz) throw new IOException($"地上波の周波数は {R850.MinKhz}〜{R850.MaxKhz} kHz です ({khz} kHz)");
        _mode = Mode.None;
        _attempt = Mode.Terrestrial;
        lock (BusLock)
        {
            if (Isdbt2071)
            {
                _t.Run(TuneIsdbt2071HeadRows);
            }
            else
            {
                // 仕様書 11.1 の地上波の選局の 1〜9
                _t.Run([new(0x47, 0x30)]);
                _t.Run(AgcStopRows);
                _s!.Run(SleepSatelliteRows);
                _t.Run([new(0x0E, 0x77), new(0x0F, 0x10), new(0x71, 0x20), new(0x03, 0x00), new(0x76, 0x0C), new(0x1F, 0x30)]);
            }
            _r850.SetFrequency(khz);
        }
        WaitPll(_r850.PllLocked, "R850");
        lock (BusLock)
        {
            _t.Run(AgcRunRows);
            if (!Isdbt2071) _t.Run([new(0x71, 0x01), new(0x72, 0x25), new(0x75, 0x00)]);
        }
        _mode = Mode.Terrestrial;
        Sleep(AfterTuneMs);
        return WaitTerrestrial(_t);
    }

    /// <summary>衛星の選局 (仕様書 11.1)。ISDB2056N (「2 つ目」の印が有る) は <c>10</c> と <c>08</c> の値が違う</summary>
    private bool TuneSatellite(ChannelTable.Tuning tuning, Rt710 rt710)
    {
        var second = _wiring.Second;
        _mode = Mode.None;
        _attempt = Mode.Satellite;
        lock (BusLock)
        {
            _s!.Run([new(0x0A, 0x00), new(0x10, (byte)(second ? 0x30 : 0xB0)), new(0x11, 0x02), new(0x03, 0x01)]);
            _t.Run([new(0x0E, 0x11), new(0x0F, 0x70), new(0x03, 0xF0)]);
            _s0!.Run([new(0x07, 0x77), new(0x08, (byte)(second ? 0x37 : 0x10))]);
            _s.Run([new(0x13, 0x00), new(0x17, 0x00), new(0x04, 0x02), new(0x8E, 0x02)]);
            _t.Run([new(0x1F, 0x20)]);
            rt710.SetFrequency(tuning.Frequency);
        }
        WaitPll(rt710.PllLocked, rt710.Name);
        Run(_s, TuneSatelliteTailRows(second));
        _khz = tuning.Frequency;
        _mode = Mode.Satellite;
        return WaitSatellite(_s) && SelectStream(_s, CxdStream.From(tuning.StreamId));
    }

    /// <summary>いま選局している方式の TS の端子を出す・止める (仕様書 11.1・11.2。値は 3.5 と同じ)</summary>
    public override void Stream(bool on)
    {
        switch (_mode)
        {
            case Mode.Terrestrial:
                Run(_t, on ? TsOnTerrestrialRows : TsOffTerrestrialRows);
                break;
            case Mode.Satellite:
                Run(_s!, on ? TsOnSatelliteRows : TsOffSatelliteRows);
                break;
        }
    }

    public override TunerSignal? Signal() => _mode switch
    {
        Mode.Terrestrial => TerrestrialSignal(_t),
        Mode.Satellite => SatelliteSignal(_s!),
        _ => null,
    };

    public override ushort[]? SatelliteStreams() => _mode == Mode.Satellite ? Streams(_s!) : null;

    public override IReadOnlyList<string> Diagnose() => _attempt switch
    {
        Mode.Terrestrial => DiagnoseTerrestrial(_t, _r850),
        Mode.Satellite => DiagnoseSatellite(_s!, _rt710!),
        _ => [],
    };

    public override IReadOnlyList<string> Notes() => _mode switch
    {
        // DTV03A-1TU の TMCC と誤り率のレジスタは仕様書に無いので読まない
        Mode.Terrestrial => Isdbt2071 ? [R850Note(_r850)] : [.. TerrestrialNotes(_t), R850Note(_r850)],
        Mode.Satellite => [.. SatelliteNotes(_s!), Rt710Note(_rt710!, _khz)],
        _ => [],
    };
}
