namespace Denpa.Agent;

/*
 * DiBcom DiB8096 (DiB8000 の ISDB-T 復調器と DiB0090 のチューナーを1つにしたもの)。CECH-ZD1 J の中身。
 *
 * **仕様書 (機材の事実を書き出したもの) だけから書いた。** Linux のドライバも、それを移した実装も見ていない
 * (Linux のドライバは GPL-2.0-only で、denpa には取り込めないため)。節の番号 (「6.2」など) はその仕様書のもの。
 * 仕様書が「参考の実装の振る舞い」と書いた所はそのとおりにし、仕様書に無かった所は「仕様書に無い」と書いた。
 *
 * レジスタの書き方: D[n] は DiB8000 のレジスタ n (10 進)、T[0xNN] は DiB0090 のレジスタ (16 進)。どちらも 16 ビット。
 * 待ちは 0.1ms 単位で数える所が多い (DiB0090 と AGC の状態の機械)。
 */

/// <summary>DiB8096 の待ちと時計。ボードは待つ前に溜めた I2C を流し、待ちの間に流し始めの準備を回す (Zd1j.cs)</summary>
public interface IDibTime
{
    /// <summary>いまの時刻 (ms)。差だけを使う</summary>
    double NowMs { get; }

    /// <summary>眠る。溜めた I2C の書き込みは眠る前に機材に届いている</summary>
    void Sleep(int ms);
}

/// <summary>選局の結果 (仕様書 7.5)</summary>
public enum DibLock
{
    Failed,

    /// <summary>復調器がロックした (データはまだかもしれない)</summary>
    Locked,

    /// <summary>MPEG のロックまで (データが出る)</summary>
    DataLocked,
}

/// <summary>受信の様子 (仕様書 8)</summary>
/// <param name="Locked">ロック (データが出る)</param>
/// <param name="StrengthDbm">信号の強さ。別の DiB8000 の機材で測った表なので目安</param>
/// <param name="CnDb">C/N。ロックしていないか測れなければ null</param>
public sealed record DibSignal(bool Locked, double StrengthDbm, double? CnDb, ushort Status);

/// <summary>DiB8000 + DiB0090 (CECH-ZD1 J の中身)。**同時に1本からだけ呼ぶ** (呼ぶ側が順番にする)</summary>
public sealed class Dib8096
{
    public const byte DemodAddress = 0x12;
    public const byte TunerAddress = 0xC0;

    /// <summary>LED のピン (DiB8000 の GPIO 1。出力 High = 赤、Low か入力 = 緑)</summary>
    public const int LedPin = 1;

    private readonly II2c _i2c;
    private readonly IDibTime _time;
    private readonly Action<string>? _trace;
    private readonly DibMemory? _memory;

    /*
     * 仕様書の外の、選局を縮める工夫 (どれも仕様書に無い。数字の根拠は各定数に):
     * - DiB0090 のキャパシタの較正 (7.3.5。二分探索で約 17 歩・約 165ms) の結果を周波数ごとに覚えて使い回す
     * - 温度の較正 (7.3.3。約 44ms) は直前に測ってから TemperatureReuseMs 以内なら飛ばす
     * - 復調器の探索で、シンボルの数の時間切れに関わらない段は FastPollMs ごとに見る (Floor)
     *
     * 3 つの数字 (60 秒・3ms・許容値 50) は、実機 (CECH-ZD1 J、T27・T21、2026-10-26) で 13 回選局して1回も同期を落とさず、
     * 覚えた値での選局が中央 800ms → 617ms になった値。本番の記録 (選局ごとの1行。LastSummary) でも、2026-10-26〜27 の 17 回で
     * 同期を落とさず、キャパシタを使い回したときの ADC のずれは -39〜0 (許容 +50 に届かない)、温度は 60 秒あまりで ±2 (2532 秒で +14)
     * だった。覚えた値で合わせた選局は 481〜791ms
     */

    /// <summary>
    /// 温度の較正を使い回す長さ (ms)。測った温度は WBD の目標に使うだけで、選局の合間 (数秒〜数分) にチューナーの温度は
    /// ほとんど変わらないとみて 1 分にした (根拠は上)
    /// </summary>
    public const double TemperatureReuseMs = 60_000;

    /// <summary>
    /// 探索で、シンボルの数の時間切れに関わらない段を見る間隔 (ms)。1 回の I2C の読み (bulk の塊の往復) より少し長い間隔 (根拠は上)
    /// </summary>
    public const int FastPollMs = 3;

    /// <summary>
    /// 覚えたキャパシタで ADC を1回読んだとき、覚えたときの差 (dmin) からここまでのずれなら合っているとみる。
    /// 二分探索の最後の1段 (キャパシタ 1 つぶん) の ADC の差より十分小さい値 (根拠は上)
    /// </summary>
    private const int CapacitorTolerance = 50;

    /// <summary>周波数 (DiB0090 に頼んだ kHz) ごとの、較正で決まったキャパシタと、そのときの差 (メモリの上だけ。ボードは開いたまま)</summary>
    private readonly Dictionary<uint, (int Cap, int Dmin)> _capacitors = [];

    private (int Cap, int Dmin) _capKnown;

    private double _temperatureAt = double.NegativeInfinity;

    /// <summary>
    /// 最後の選局の、使い回しと較正の様子 (<c>--tune</c> の内訳に出す)。上の 3 つの数字を実機の値から決めるための記録:
    /// キャパシタの ADC の差、温度の変化と経過秒、3ms で見た段ごとの歩数
    /// </summary>
    private readonly List<string> _notes = [];

    /// <summary>キャパシタの較正をやり直した理由 (なければ「覚えた値なし」)</summary>
    private string _capReason = "";

    /// <summary>3ms で見た段ごとの歩数 (最後の選局)</summary>
    private readonly Dictionary<Step, int> _fastSteps = [];

    private int? _temperatureLast;

    /// <summary>最後の選局の経路 (探索した / 覚えた値で合わせた / 既定で合わせた)</summary>
    public string LastPath => _path;

    private string _path = "";

    /// <summary>DiB8000 のバージョン (D[897]: 0x8000〜0x8002)</summary>
    public ushort Version { get; private set; }

    /// <summary>DiB0090 のバージョンのバイト (T[0x1A] の下位 8 ビット)</summary>
    public byte TunerVersion { get; private set; }

    /// <summary>DiB0090 が P1G か (仕様書 6.8)</summary>
    public bool P1g { get; private set; }

    private bool _sleeping;

    /// <param name="trace">あれば、選局のたびにロックまでの内訳 (段ごとの時間と待ち) を渡す (<c>--tune</c> のとき)</param>
    public Dib8096(II2c i2c, IDibTime time, Action<string>? trace = null, DibMemory? memory = null)
    {
        _i2c = i2c;
        _time = time;
        _trace = trace;
        _memory = memory;
    }

    // ---------------------------------------------------------------------
    // レジスタ (仕様書 5.1)
    // ---------------------------------------------------------------------

    private ushort D(int register)
    {
        Span<byte> value = stackalloc byte[2];
        _i2c.WriteRead(DemodAddress, [(byte)(register >> 8), (byte)register], value);
        return (ushort)((value[0] << 8) | value[1]);
    }

    private void D(int register, int value) =>
        _i2c.Write(DemodAddress, [(byte)(register >> 8), (byte)register, (byte)(value >> 8), (byte)value]);

    /// <summary><c>D[n] ⇐ (keep, set)</c>: 読んで &amp; keep して | set して書く</summary>
    private void Modify(int register, int keep, int set) => _i2c.Modify16(DemodAddress, (ushort)register, (ushort)keep, (ushort)set);

    /// <summary>32 ビットの値。上位が先の番号</summary>
    private uint D32(int register) => ((uint)D(register) << 16) | D(register + 1);

    private void D32(int register, uint value)
    {
        D(register, (int)(value >> 16));
        D(register + 1, (int)(value & 0xFFFF));
    }

    /// <summary>DiB0090 は番号 1 バイト。**ストップを挟むと 0 が返る**ので、必ず繰り返しスタートで読む</summary>
    private ushort T(int register)
    {
        Span<byte> value = stackalloc byte[2];
        _i2c.WriteRead(TunerAddress, [(byte)register], value);
        return (ushort)((value[0] << 8) | value[1]);
    }

    private void T(int register, int value) =>
        _i2c.Write(TunerAddress, [(byte)register, (byte)(value >> 8), (byte)value]);

    /// <summary>
    /// 0.1ms 単位の待ちをミリ秒に直す。参考の実装と同じく <c>floor(10 × (t + 99) / 100)</c> ms に丸め上げる (t = 0 でも 9ms)。
    /// **仕様書の値そのまま (切り上げただけ) では同期しない** (仕様書に「10ms 未満の待ちは同期しないことがある」とあり、実機でも
    /// 1 回目・2 回目とも同期しなかった)
    /// </summary>
    private static int Ms(int tenths) => 10 * (tenths + 99) / 100;

    /// <summary>眠った合計 (ms)。内訳を出すときに使う</summary>
    private double _slept;

    private void Wait(int ms)
    {
        if (ms <= 0) return;
        _time.Sleep(ms);
        _slept += ms;
    }

    // ---------------------------------------------------------------------
    // 初期化 (仕様書 4.7・6)
    // ---------------------------------------------------------------------

    /// <summary>
    /// DiB8000 と DiB0090 を初期化して起こす。ブリッジの GPIO で電源とリセットを済ませたあと (仕様書 4.6) に呼ぶ。
    /// 知らないバージョンの部品なら投げる
    /// </summary>
    public void Initialize()
    {
        // 4.7 アドレスの確定 (復調器は1つなので既定の 0x12 のまま)
        D(1287, 0x0003);
        InitializeDemod();
        // 6.1 DiB0090 への道。開けっぱなしでよい (DiB8000 は自分のアドレスで答え続ける)
        D(1028, 0);
        D(1025, 0xC000);
        InitializeTuner();
        WakeUp();
        CalibrateDc();
        Output(true);
    }

    /// <summary>
    /// DiB0090 の DC オフセットの較正 (7.3.1) を、開くときに済ませる。仕様書では「宿題」として最初の選局の頭で走る
    /// (6.8 の 5) が、周波数に依らない較正で、再び立つことも無いので、選局の経路から外した (選局の始めの条件と同じく、
    /// チューナーを初期化して起こしたあと)。WBD と温度は周波数や選局ごとに立つので、今までどおり選局で走る
    /// </summary>
    private void CalibrateDc()
    {
        _tunerState = TunerStart;
        for (var guard = 0; _dcPending; guard++)
        {
            if (guard > 1000) throw new IOException("DiB0090 の DC の較正が終わりません");
            if (_tunerState == TunerStart) T(0x23, T(0x23) & ~0x4000);
            Wait(Ms(DcStep()));
        }
    }

    /// <summary>D[896] と D[897] を確かめる。D[896] は電源投入直後の1回目が化けることがあるので2回読む</summary>
    private void Identify()
    {
        D(896);
        var id = D(896);
        if (id != 0x01B3) throw new IOException($"DiB8000 が見当たりません (D[896] = 0x{id:X4})");
        var version = D(897);
        if (version is not (0x8000 or 0x8001 or 0x8002))
        {
            throw new IOException($"知らないバージョンの DiB8000 です (D[897] = 0x{version:X4})");
        }
        Version = version;
    }

    /// <summary>6.2</summary>
    private void InitializeDemod()
    {
        Identify();
        D(1025, 0x0100);
        D(1287, 0x0003);
        D(1025, 0x0100);
        D(1028, 0);
        Power(true);
        Adc(AdcMode.Off);
        foreach (var (register, value) in new[] { (770, 0xFFFF), (771, 0xFFFF), (772, 0xFFFC), (898, 0x000C), (1280, 0x004D), (1281, 0x000C) })
        {
            D(register, value);
        }
        foreach (var (register, value) in new[] { (770, 0), (771, 0), (772, 0), (898, 0x0004), (1280, 0), (1281, 0) })
        {
            D(register, value);
        }
        D(906, 0x2D98);
        // PLL: 前置分周 1・倍率 18 で 216MHz、内部クロック 54,000,000 Hz、IF 0
        D(901, 0x0112);
        D(902, 0x050F);
        D(902, 0x0507);
        D(904, 0x1E80);
        D(23, 0x0337);
        D(24, 0xF980);
        D(27, 0);
        D(28, 0);
        D(26, 0);
        D(922, 0xD257);
        D(898, 0x0004);
        // GPIO を全部入力に。これで LED は緑
        D(1029, 0xFFFF);
        D(1030, 0);
        D(1032, 0xFFFF);
        D(1037, 0);
        Output(false);
        D(40, 0x0755);
        foreach (var (register, value) in Defaults) D(register, value);
        D(903, 0x0031);
        Modify(1285, ~0x0002, 0);
        _timing = TimingFor(18);
        D32(29, _timing);
        Adc(AdcMode.SlowOn);
        D(923, 0);
        D(924, 776);
        D(923, 1);
        D(923, 0);
        Wait(1);
        Adc(AdcMode.SlowOff);
        Modify(285, ~0x0060, 0x0060);
        Power(false);
        D(565);
        Modify(285, ~0x0060, 0x0060);
    }

    /// <summary>6.3 DiB8000 の既定値の表 (書く順)</summary>
    private static readonly (int Register, int Value)[] Defaults =
    [
        (7, 0x0004), (8, 0x0400), (9, 0x0814),
        .. new[] { 0x001B, 0x7740, 0x005B, 0x8D80, 0x01C9, 0xC380, 0x0000, 0x0080, 0x0000, 0x0090, 0x0001, 0xD4C0 }
            .Select((value, at) => (11 + at, value)),
        .. new[] { 7250, 7238, 7264, 7309, 7338, 7382, 7427, 7456, 7500, 7544, 7574 }.Select((value, at) => (80 + at, value)),
        (108, 0), (109, 0), (110, 0), (111, 0),
        (175, 0x0410),
        (179, 8192),
        .. Enumerable.Range(181, 6).Select(register => (register, 0x2800)),
        (193, 0x0666), (194, 0x0000),
        (205, 0x200F), (206, 0x000F),
        (215, 0x023D), (216, 0x00A4), (217, 0x00A4), (218, 0x7FF0), (219, 0x3CCC),
        (230, 0x0000),
        (263, 0x0800),
        (268, 0x0427),
        (270, 0x0001),
        (285, 0x0020),
        (299, 0x0062),
        (338, 0x1461),
    ];

    /// <summary>6.4 電源。すべて (<paramref name="all"/>) か接続部だけ</summary>
    private void Power(bool all)
    {
        var r900 = D(900);
        var r1280 = D(1280);
        D(774, all ? 0x0000 : 0x3FFF);
        D(775, all ? 0x0000 : 0xFFFF);
        D(776, all ? 0x0000 : 0xFFFF);
        D(900, all ? r900 & 0xFFFC : (r900 & 0xFFFC) | 3);
        D(1280, r1280 & 0x00FF);
    }

    private enum AdcMode
    {
        SlowOn,
        SlowOff,
        On,
        Off,
    }

    /// <summary>6.5 ADC</summary>
    private void Adc(AdcMode mode)
    {
        if (mode == AdcMode.Off)
        {
            // 基準電圧は入れたまま (立ち上がりが遅いため)
            D(907, 0x3000);
            D(908, 0x007A);
            return;
        }
        var a = D(907);
        var b = D(908);
        switch (mode)
        {
            case AdcMode.SlowOn:
                b |= 3;
                D(908, b);
                b &= unchecked((ushort)~2);
                D(907, a);
                D(908, b);
                break;
            case AdcMode.SlowOff:
                b |= 3;
                D(907, a);
                D(908, b);
                break;
            default:
                D(907, a & 0x0FFF);
                D(908, b & 0x0003);
                break;
        }
    }

    /// <summary>6.6 TS の出力。パラレル・クロックはデータのある間だけ (この機材の形) か、ハイインピーダンス</summary>
    public void Output(bool parallel)
    {
        var s = (D(299) & 0x0050) | 0x0002 | 0x0020;
        D(299, s);
        D(300, 1792);
        D(1286, parallel ? 0x0400 : 0x0000);
        D(1291, 0x0205);
    }

    /// <summary>6.7 DiB8000 の GPIO を1本、出力にして値を決める。読みかえ書きなので、ほかのピンはそのまま残る</summary>
    private void Gpio(int pin, bool high)
    {
        Modify(1029, ~(1 << pin), 0);
        Modify(1030, ~(1 << pin), high ? 1 << pin : 0);
    }

    /// <summary>前面の LED。赤 (出力 High) か緑 (入力に戻す)</summary>
    public void Led(bool red)
    {
        if (red)
        {
            Gpio(LedPin, true);
        }
        else
        {
            // 入力に戻す。初期化の直後と同じ形 (次に挿したときの色と揃える)
            Modify(1029, 0xFFFF, 1 << LedPin);
        }
        _i2c.Flush();
    }

    // DiB0090 の状態 (仕様書 6.8・7.3)
    private const int TunerStart = 0;
    private const int TunerEnd = 100;

    private int _tunerState;
    private bool _dcPending;
    private bool _wbdPending;
    private bool _tempPending;
    private bool _capPending;
    private bool _tunerTuned;

    /// <summary>6.8 DiB0090 の初期化 (ゲートは開けてある)</summary>
    private void InitializeTuner()
    {
        // ハードのリセット
        Gpio(0, false);
        Wait(10);
        Gpio(5, false);
        Wait(10);
        Gpio(5, true);
        Wait(10);

        T(0x24, 0x0022);
        T(0x1B, 0x00A2);
        T(0x20, 0x3B00);
        T(0x23, 0x0A30);
        T(0x21, T(0x21) | 0x8000);

        var id = T(0x1A) & ~0x0800;
        if (((id >> 8) & 0xF) != 2) throw new IOException($"知らない DiB0090 です (T[0x1A] = 0x{id:X4})");
        if ((id & 3) == 2) throw new IOException($"SoC 向けの DiB0090 は扱いません (T[0x1A] = 0x{id:X4})");
        if (((id >> 5) & 7) is not (1 or 4 or 6 or 7)) throw new IOException($"知らないパッケージの DiB0090 です (T[0x1A] = 0x{id:X4})");
        P1g = (id & 0x1F) switch
        {
            0x0F or 0x07 => true,
            0x03 or 0x01 => false,
            _ => throw new IOException($"扱えないバージョンの DiB0090 です (T[0x1A] = 0x{id:X4})"),
        };
        TunerVersion = (byte)id;

        T(0x1B, ((T(0x1A) >> 5) & 2) != 0 ? 0x00EB : 0x00A2);
        foreach (var (register, value) in TunerDefaults) T(register, value);
        if (P1g)
        {
            T(0x05, 0xABCD);
            T(0x11, 0x00B4);
            T(0x1C, 0xFFFD);
            T(0x40, 0x0108);
        }
        if ((TunerVersion & 0x1F) >= 3) Fuses();
        // 水晶 12MHz
        T(0x14, 2);
        // 較正の宿題。走るのは最初の選局のとき
        _dcPending = _wbdPending = _tempPending = true;
        _tunerState = TunerStart;
    }

    /// <summary>6.9 DiB0090 の既定値の表 (書く順)</summary>
    private static readonly (int Register, int Value)[] TunerDefaults =
    [
        .. new[]
        {
            0x0000, 0x99A0, 0x6008, 0x0000, 0x8BCB, 0x0000, 0x0405, 0x0000, 0x0000, 0x0000, 0xB802, 0x0300, 0x2D12,
            0xBAC0, 0x7C00, 0xDBB9, 0x0954, 0x0743, 0x8000, 0x0001, 0x0040, 0x0100, 0x0000, 0xE910, 0x149E,
        }.Select((value, at) => (0x01 + at, value)),
        (0x1C, 0xFF2D),
        (0x39, 0x0000),
        (0x1E, 0x07FF), (0x1F, 0x0007),
        (0x24, 0x22EB),
        (0x3C, 0x03FF), (0x3D, 0x0111),
    ];

    /// <summary>6.10 ヒューズ (ベースバンドの調整値)</summary>
    private void Fuses()
    {
        int e2 = T(0x26);
        int e4 = T(0x28);
        if (TunerVersion is 0x03 or 0x07 || e2 == 0xFFFF)
        {
            T(0x22, 0x0010);
            var cal = (T(0x22) >> 6) & 0x3FF;
            if (cal < 670 || cal == 1023) cal = 850;
            var n0 = 165 - ((cal * 10) >> 6);
            e2 = e4 = 0x3000 | (34 << 6) | n0;
        }
        if (e2 != e4) e2 &= e4;
        if (e2 == 0xFFFF) return;
        var c = e2 & 0x3F;
        var n = (e2 >> 12) & 0xF;
        var h = (e2 >> 6) & 0x3F;
        c = c is >= 40 or <= 9 ? 32 : c + 14;
        if (h is >= 40 or <= 25) h = 34;
        if (n is >= 8 or <= 0) n = 3;
        T(0x13, h << 10);
        T(0x02, (n << 11) | ((h >> 2) << 6) | c);
    }

    /// <summary>6.8「起こす」の 1 と 2</summary>
    private void WakeUp()
    {
        Power(true);
        Adc(AdcMode.On);
        Adc(AdcMode.SlowOn);
        Gpio(0, false);
        T(0x23, T(0x23) | 0x4000);
        _sleeping = false;
    }

    /// <summary>10 眠らせる (使い終わって閉じる前)。LED のピンには触らない</summary>
    public void Sleep()
    {
        Gpio(0, true);
        Output(false);
        Power(false);
        Adc(AdcMode.SlowOff);
        Adc(AdcMode.Off);
        _i2c.Flush();
        _sleeping = true;
    }

    // ---------------------------------------------------------------------
    // 選局 (仕様書 7)
    // ---------------------------------------------------------------------

    private enum Band
    {
        Cband,
        Vhf,
        Uhf,
    }

    /// <summary>7.1 帯の分け方 (kHz)</summary>
    private static Band BandOf(uint khz) => khz <= 170000 ? Band.Cband : khz <= 250000 ? Band.Vhf : Band.Uhf;

    private uint _khz;
    private Band _band;

    /// <summary>
    /// チャンネルの中心周波数 (Hz) に合わせる (7.1)。ロックしなかったのは失敗ではなく結果
    /// (<see cref="DibLock.Failed"/>)。範囲外と、探索が 5 秒で終わらないときは投げる
    /// </summary>
    public DibLock Tune(uint hz)
    {
        if (hz is < 45_000_000 or > 860_000_000) throw new IOException($"{hz} Hz は受けられません (45〜860MHz)");
        _khz = hz / 1000;
        _band = BandOf(_khz);
        _breakdown.Clear();
        _notes.Clear();
        _fastSteps.Clear();
        _capReason = "覚えた値なし";
        var started = _time.NowMs;
        var slept = _slept;
        Measure("準備 (起こす・ダイバーシティ両方・出力止め)", () =>
        {
            if (_sleeping) WakeUp();
            Diversity(DiversityMode.Both);
            Output(false);
        });
        // 温度は直前に測ってから TemperatureReuseMs 以内なら測り直さない (仕様書に無い)
        if (_time.NowMs - _temperatureAt >= TemperatureReuseMs) _tempPending = true;
        else if (!_tempPending) _notes.Add($"温度: 使い回し (前に測ってから {(_time.NowMs - _temperatureAt) / 1000:F0} 秒)");
        TunerAndPeripherals();
        Measure("ダイバーシティ内部だけ", () => Diversity(DiversityMode.Internal));
        Measure("AGC の立ち上げ (7.4)", StartAgc);
        DibLock result;
        try
        {
            result = Search();
        }
        catch
        {
            if (_capacitors.Remove(_tunerKhz)) _notes.Add("キャパシタ: 探索が投げたので覚えた値を捨てた");
            throw;
        }
        // 合わなかったら、使い回したキャパシタも次は較正し直す
        if (result == DibLock.Failed && _capacitors.Remove(_tunerKhz)) _notes.Add("キャパシタ: ロックしなかったので覚えた値を捨てた");
        LastSummary = Summary(hz, _time.NowMs - started, result);
        if (_fastSteps.Count > 0)
        {
            _notes.Add($"{FastPollMs}ms で見た歩数: {string.Join(" / ", _fastSteps.Select(pair => $"{pair.Key} {pair.Value}"))}");
        }
        Measure("出力をパラレルに", () =>
        {
            Output(true);
            _i2c.Flush();
        });
        if (_trace is not null)
        {
            var parts = string.Join(" / ", _breakdown.Select(part =>
                $"{part.Name} {part.Ms:F0}ms (待ち {part.SleptMs:F0}ms{(part.Steps > 1 ? $"、{part.Steps} 歩" : "")})"));
            _trace($"選局 {hz} Hz → {result} ({_path}){(_notes.Count > 0 ? $" [{string.Join("。", _notes)}]" : "")}: 合計 {_time.NowMs - started:F0}ms (待ち {_slept - slept:F0}ms) | {parts}");
        }
        return result;
    }

    /// <summary>
    /// 最後の選局の要約の1行。常駐のときも記録に出し (Zd1jTuner)、3 つの数字 (60 秒・3ms・許容値 50) を本番の記録で見直すのに使う。
    /// 形: <c>選局 &lt;Hz&gt; Hz: &lt;経路&gt;、ロックまで &lt;ms&gt;ms、キャパシタ: &lt;…&gt;、温度: &lt;…&gt;、&lt;同期した / 同期しなかった&gt;</c>
    /// </summary>
    public string LastSummary { get; private set; } = "";

    private string Summary(uint hz, double lockMs, DibLock result)
    {
        string Pick(string prefix, string none) => _notes.LastOrDefault(note => note.StartsWith(prefix, StringComparison.Ordinal)) ?? prefix + none;
        var sync = result switch
        {
            DibLock.DataLocked => "同期した",
            DibLock.Locked => "ロックしたがデータはまだ",
            _ => "同期しなかった",
        };
        return $"選局 {hz} Hz: {_path}、ロックまで {lockMs:F0}ms、{Pick("キャパシタ: ", "-")}、{Pick("温度: ", "-")}、{sync}";
    }

    /// <summary>ロックまでの内訳の1つ (段の名前・かかった時間・そのうち眠った時間・歩数)</summary>
    private sealed class Part(string name)
    {
        public string Name { get; } = name;
        public double Ms;
        public double SleptMs;
        public int Steps;
    }

    private readonly List<Part> _breakdown = [];

    /// <summary>内訳に足す。同じ名前なら合わせる</summary>
    private void Account(string name, double ms, double slept)
    {
        var part = _breakdown.Find(item => item.Name == name);
        if (part is null) _breakdown.Add(part = new Part(name));
        part.Ms += ms;
        part.SleptMs += slept;
        part.Steps++;
    }

    private void Measure(string name, Action body)
    {
        var started = _time.NowMs;
        var slept = _slept;
        body();
        Account(name, _time.NowMs - started, _slept - slept);
    }

    /// <summary>7.2 チューナーと周辺の設定</summary>
    private void TunerAndPeripherals()
    {
        Gpio(3, _band != Band.Uhf);
        RunTuner();
        var rest = _time.NowMs;
        var restSlept = _slept;

        // 4 PLL の倍率を選び直す (ADC のクロックの高調波をチャンネルから遠ざける)
        var r = D(1856);
        int ratio;
        if ((r & 0x3F) == 1 && ((r >> 6) & 0x3F) == 18)
        {
            // 参考の実装の振る舞い。このときのタイミングの周波数は、いまの倍率 (18) のもの (仕様書に無い。下の注)
            ratio = 18;
        }
        else
        {
            ratio = PllRatio(_khz);
            D(901, 0x0100 | ratio);
        }
        _timing = TimingFor(ratio);
        D32(29, _timing);

        if (_band != Band.Cband)
        {
            var target = WbdTarget();
            _wbdReference = Math.Min(4095, (target * 8 * 18 / 33 + 1) / 2);
            D(106, _wbdReference.Value);
            AgcToPwm();
        }
        else
        {
            SoftAgc();
            AgcToPwm();
            Adc(AdcMode.On);
            AgcSettings();
        }
        Account(_band == Band.Cband ? "PLL の倍率・ソフトの AGC・PWM に渡す" : "PLL の倍率・WBD の目標・PWM に渡す", _time.NowMs - rest, _slept - restSlept);
    }

    /// <summary>7.2 の 4 の倍率 <c>k</c> (17〜20)</summary>
    internal static int PllRatio(uint khz)
    {
        var x = khz * 256 / 1000;
        var best = 0u;
        var ratio = 20;
        for (var k = 17; k <= 20; k++)
        {
            var f = (uint)(12 * k * 256 / 16);
            var rest = x % f;
            if (rest > f / 2) rest = f - rest;
            if (rest > 717 && rest > best)
            {
                best = rest;
                ratio = k;
            }
        }
        return best == 0 ? 20 : ratio;
    }

    /// <summary>倍率ごとのタイミングの周波数</summary>
    private static uint TimingFor(int ratio) => ratio switch
    {
        17 => 21_387_946,
        18 => 20_199_727,
        19 => 19_136_583,
        _ => 18_179_756,
    };

    private uint _timing;
    private int? _wbdReference;

    // --- DiB0090 の選局 (7.3) -------------------------------------------

    /// <summary>状態が「終わり」になるまで回す。待ちは 0.1ms 単位</summary>
    private void RunTuner()
    {
        _tunerState = TunerStart;
        for (var guard = 0; ; guard++)
        {
            if (guard > 1000) throw new IOException("DiB0090 の選局が終わりません");
            var kind = _dcPending ? "DiB0090 DC の較正" : _wbdPending ? "DiB0090 WBD の較正" : _tempPending ? "DiB0090 温度"
                : _capPending ? "DiB0090 キャパシタ" : "DiB0090 PLL と段 0・段 1";
            var started = _time.NowMs;
            var slept = _slept;
            var wait = TunerStep();
            Wait(Ms(wait));
            Account(kind, _time.NowMs - started, _slept - slept);
            if (_tunerState == TunerEnd) return;
        }
    }

    /// <summary>1歩。待ち (0.1ms) を返す</summary>
    private int TunerStep()
    {
        if (_tunerState == TunerStart && (_dcPending || _wbdPending || _tempPending)) T(0x23, T(0x23) & ~0x4000);
        if (_dcPending) return DcStep();
        if (_wbdPending) return WbdStep();
        if (_tempPending) return TemperatureStep();
        if (_capPending) return P1g ? CapacitorP1gStep() : CapacitorStep();
        return _tunerState switch
        {
            TunerStart => TunerBodyStart(),
            1 => TunerStep0(),
            2 => TunerStep1(),
            _ => throw new IOException($"DiB0090 の状態が崩れています ({_tunerState})"),
        };
    }

    // 7.3.1 DC オフセットの較正
    private static readonly (int Register, int Shift, int Pga, int Before, int P1g, int Iq)[] DcRows =
    [
        (0x06, 5, 1, 0x20D0, 0x2078, 1),
        (0x07, 11, 1, 0x20D0, 0x2078, 0),
        (0x06, 0, 0, 0x3DD0, 0x3D78, 1),
        (0x06, 10, 0, 0x3DD0, 0x3D78, 0),
    ];

    private ushort _bb6;
    private ushort _bb7;
    private sbyte _dcStep;
    private short _dcDiff;
    private short _dcMinDiff;
    private int _dcRow;

    private int DcStep()
    {
        switch (_tunerState)
        {
            case TunerStart:
                _bb6 = 0;
                _bb7 = 0x040D;
                T(0x24, T(0x24) & 0x0FFB);
                var w = T(0x10);
                T(0x10, (w & ~0x07F8) | 0x38 | 0x3);
                T(0x23, T(0x23) & ~0x4000);
                _dcRow = 0;
                DcRowStart();
                return 50;
            case 1:
                DcRowStart();
                return 50;
            case 2:
                DcAdjust();
                _tunerState = 3;
                return 0;
            case 3:
                T(0x1F, 7);
                _tunerState = 4;
                return 100;
            case 4:
                _dcDiff = (short)T(0x1D);
                T(0x1F, 4);
                _tunerState = 5;
                return 100;
            case 5:
                _dcDiff = (short)(_dcDiff - T(0x1D));
                _tunerState = 6;
                return 0;
            case 6:
                DcJudge();
                return 0;
            case 7:
                T(0x07, _bb7 & ~0x0008);
                T(0x1F, 7);
                _dcPending = false;
                _tunerState = TunerStart;
                return 0;
        }
        throw new IOException($"DC の較正の状態が崩れています ({_tunerState})");
    }

    /// <summary>「行の始め」(仕様書の段 0。ここでは状態 1)。次は段 1 (状態 2)</summary>
    private void DcRowStart()
    {
        var row = DcRows[_dcRow];
        T(0x01, P1g ? row.P1g : row.Before);
        T(0x07, _bb7 | (row.Iq << 7));
        _dcStep = 0;
        _dcMinDiff = 1023;
        _tunerState = 2;
    }

    /// <summary>
    /// 「調整値を書く」。**書いた値を bb6 / bb7 に持ち越す** — 仕様書は「v を作ってそのレジスタに書く」までで、
    /// bb6 / bb7 を書き換えるかは書いていない。持ち越さないと 3 行目が 1 行目の結果を、最後の段が 2 行目の結果を
    /// 消すことになるので、持ち越すものとした (実機で確かめる)
    /// </summary>
    private void DcAdjust()
    {
        var row = DcRows[_dcRow];
        var v = row.Register == 0x07 ? _bb7 : _bb6;
        v = (ushort)((v & ~(0x1F << row.Shift)) | ((_dcStep << row.Shift) & 0xFFFF));
        if (row.Register == 0x07) _bb7 = v;
        else _bb6 = v;
        T(row.Register, v);
    }

    private static int Signed5(int u) => u > 15 ? u - 16 : u;

    private void DcJudge()
    {
        var row = DcRows[_dcRow];
        if (_dcStep == 0 && _dcDiff < 0) _dcMinDiff = -1023;
        if (_dcStep == 0 && ((row.Pga == 1 && _dcDiff < 0) || (row.Pga == 0 && _dcDiff > 0))) _dcStep = 0x10;
        if (((_dcDiff ^ _dcMinDiff) & 0x8000) == 0 && Signed5(_dcStep) < 15)
        {
            _dcStep++;
            _dcMinDiff = _dcDiff;
            _tunerState = 2;
            return;
        }
        if (Math.Abs((int)_dcDiff) > Math.Abs((int)_dcMinDiff)) _dcStep--;
        DcAdjust();
        _dcRow++;
        _tunerState = _dcRow == DcRows.Length ? 7 : 1;
    }

    // 7.3.2 WBD の表 (上限 MHz・冷の傾き・冷の基準・熱の傾き・熱の基準・利得)
    private static readonly (int Upper, int ColdSlope, int ColdBase, int HotSlope, int HotBase, int Gain)[] WbdTable =
    [
        (120, 0, 500, 0, 500, 4),
        (170, 0, 450, 0, 450, 4),
        (380, 48, 373, 28, 259, 6),
        (860, 34, 700, 36, 616, 6),
        (65535, 34, 700, 36, 616, 6),
    ];

    private static (int Upper, int ColdSlope, int ColdBase, int HotSlope, int HotBase, int Gain) WbdRow(uint mhz) =>
        WbdTable.First(row => mhz <= row.Upper);

    private static int Gain(int gain) => gain == 0 ? 4 : gain;

    /// <summary>いまの周波数 (kHz。req = 選局の周波数 + ずれ)</summary>
    private uint _tunerKhz;
    private int _wbdGain;
    private ushort _wbdOffset;
    private int _temperature;
    private ushort _wbdMux;

    private int WbdStep()
    {
        if (_tunerState == TunerStart)
        {
            if (_tunerKhz == 0) _tunerKhz = _khz;
            var gain = Gain(WbdRow(_tunerKhz / 1000).Gain);
            if (gain == _wbdGain)
            {
                _wbdPending = false;
                return 0;
            }
            T(0x10, 0x1B81 | 0x0400 | (gain << 13) | 0x0008);
            T(0x24, 0x02EB);
            _wbdGain = gain;
            _tunerState = 1;
            return 90;
        }
        _wbdOffset = T(0x1D);
        _wbdPending = false;
        _tunerState = TunerStart;
        return 0;
    }

    private ushort _tempW;
    private ushort _tempB;
    private ushort _tempA;

    private int TemperatureStep()
    {
        switch (_tunerState)
        {
            case TunerStart:
                _tempW = T(0x10);
                T(0x10, (_tempW & ~0x07F8) | 0x40);
                _tempB = T(0x13);
                T(0x13, _tempB | 0x0300);
                _tunerState = 1;
                return 15;
            case 1:
                _tempA = T(0x1D);
                T(0x13, (_tempB & ~0x0300) | 0x0200);
                _tunerState = 2;
                return 15;
            case 2:
                var v = T(0x1D);
                _temperature = (((short)((v - _tempA) * 180)) >> 8) + 55;
                _notes.Add(_temperatureLast is { } last
                    ? $"温度: 測った {_temperature} (前回 {last} から {_temperature - last:+0;-0;0}、{(_time.NowMs - _temperatureAt) / 1000:F0} 秒ぶり)"
                    : $"温度: 測った {_temperature} (初めて)");
                _temperatureLast = _temperature;
                _tunerState = 3;
                return 15;
            default:
                T(0x13, _tempB);
                T(0x10, _tempW);
                _tempPending = false;
                _temperatureAt = _time.NowMs;
                _tunerState = TunerStart;
                return 15;
        }
    }

    // 7.3.11 PLL の表 (上限 kHz・VCO の帯・分周の符号・分周・前置分周)
    private static readonly (uint Upper, int VcoBand, int Code, int Divider, int Prediv)[] PllNormal =
    [
        (56000, 0, 9, 48, 6), (70000, 1, 9, 48, 6), (87000, 0, 8, 32, 4), (105000, 1, 8, 32, 4),
        (115000, 0, 7, 24, 6), (140000, 1, 7, 24, 6), (170000, 0, 6, 16, 4), (200000, 1, 6, 16, 4),
        (230000, 0, 5, 12, 6), (280000, 1, 5, 12, 6), (340000, 0, 4, 8, 4), (380000, 1, 4, 8, 4),
        (450000, 0, 3, 6, 6), (580000, 1, 3, 6, 6), (700000, 0, 2, 4, 4), (860000, 1, 2, 4, 4),
    ];

    private static readonly (uint Upper, int VcoBand, int Code, int Divider, int Prediv)[] PllP1g =
    [
        (57000, 0, 11, 48, 6), (70000, 1, 11, 48, 6), (86000, 0, 10, 32, 4), (105000, 1, 10, 32, 4),
        (115000, 0, 9, 24, 6), (140000, 1, 9, 24, 6), (170000, 0, 8, 16, 4), (200000, 1, 8, 16, 4),
        (230000, 0, 7, 12, 6), (280000, 1, 7, 12, 6), (340000, 0, 6, 8, 4), (380000, 1, 6, 8, 4),
        (455000, 0, 5, 6, 6), (580000, 1, 5, 6, 6), (680000, 0, 4, 4, 4), (860000, 1, 4, 4, 4),
    ];

    private const int EnableCband = 0x88E9;
    private const int EnableVhf = 0x44E9;
    private const int EnableUhf = 0x22E9;

    /// <summary>選局の表の1行 (上限 kHz・切替の調整値・LNA の調整・LNA のバイアス・V2I・ミキサー・負荷・有効化)</summary>
    private readonly record struct TuneRow(uint Upper, int Switch, int LnaTune, int LnaBias, int V2i, int Mixer, int Load, int Enable);

    private static readonly TuneRow[] TuneNormal =
    [
        new(170000, 4, 1, 15, 0x280, 0x2912, 0xB94E, EnableCband),
        new(184000, 1, 1, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(227000, 1, 3, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(380000, 1, 7, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(520000, 2, 0, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(550000, 2, 2, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(650000, 2, 3, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(750000, 2, 5, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(850000, 2, 6, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(900000, 2, 7, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
    ];

    private static readonly TuneRow[] TuneP1g =
    [
        new(170000, 4, 1, 0x820F, 0x300, 0x2D22, 0x82CB, EnableCband),
        new(184000, 1, 1, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(227000, 1, 3, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(380000, 1, 7, 15, 0x300, 0x4D12, 0xB94E, EnableVhf),
        new(510000, 2, 0, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(540000, 2, 1, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(600000, 2, 3, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(630000, 2, 4, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(680000, 2, 5, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(720000, 2, 6, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
        new(900000, 2, 7, 15, 0x300, 0x1D12, 0xB9CE, EnableUhf),
    ];

    /// <summary>VHF を CBAND で受ける表 (パッケージ 4・7 のときだけ)</summary>
    private static readonly TuneRow[] VhfAsCbandNormal =
    [
        new(184000, 4, 1, 15, 0x280, 0x2912, 0xB94E, EnableCband),
        new(227000, 4, 3, 15, 0x280, 0x2912, 0xB94E, EnableCband),
        new(380000, 4, 7, 15, 0x280, 0x2912, 0xB94E, EnableCband),
        .. TuneNormal[4..],
    ];

    private static readonly TuneRow[] VhfAsCbandP1g =
    [
        new(184000, 4, 3, 0x4187, 0x2C0, 0x2D22, 0x81CB, EnableCband),
        new(227000, 4, 3, 0x4187, 0x2C0, 0x2D22, 0x81CB, EnableCband),
        new(380000, 4, 3, 0x4187, 0x2C0, 0x2D22, 0x81CB, EnableCband),
        .. TuneNormal[4..],
    ];

    private uint _lastReq;
    private TuneRow _tuneRow;
    private int _rest;

    /// <summary>DiB0090 が決めた帯 (VHF を CBAND で受けるときは CBAND)</summary>
    private Band _tunerBand;

    /// <summary>7.3.4 本体の「始め」(周波数を決めて PLL を書く)</summary>
    private int TunerBodyStart()
    {
        var band = BandOf(_khz);
        var req = (uint)(_khz + (band == Band.Uhf ? -63 : -143));
        if (req != _lastReq)
        {
            _tunerTuned = false;
            var pll = P1g ? PllP1g : PllNormal;
            var tune = P1g ? TuneP1g : TuneNormal;
            var package = (TunerVersion >> 5) & 7;
            if (package is 4 or 7 && band is Band.Cband or Band.Vhf)
            {
                band = Band.Cband;
                tune = P1g ? VhfAsCbandP1g : VhfAsCbandNormal;
            }
            _tunerBand = band;
            _tuneRow = tune.First(row => req <= row.Upper);
            var p = pll.First(row => req <= row.Upper);
            T(0x0B, 0xB800 | _tuneRow.Switch);

            var vco = (uint)p.Divider * req * 2;
            const uint fref = 12000 / 6;
            var divided = vco / (uint)p.Prediv;
            var fb = divided / fref;
            var rest = (int)(divided - fb * fref);
            if (rest < 100) rest = 0;
            else if (rest < 200) rest = 200;
            else if (rest > fref - 100)
            {
                rest = 0;
                fb++;
            }
            else if (rest > fref - 200) rest = (int)fref - 200;
            rest = (int)(rest * 6528 / (fref / 10));
            _rest = rest;

            int lo5 = rest == 0 ? (p.VcoBand == 1 ? 0x049F : 0x041F) : (p.VcoBand == 1 ? 0x049E : 0x041D);
            if (P1g) lo5 = 0x042C;
            lo5 |= (p.Code << 11) | (p.VcoBand << 7);
            var lo6 = P1g || rest == 0 ? 0xFFF8 : 0xFF28;
            int den;
            if (rest > 0)
            {
                lo6 |= 0x0006;
                den = 255;
            }
            else
            {
                den = 1;
            }
            T(0x15, (int)fb);
            T(0x16, (den << 8) | 6);
            T(0x17, rest);
            T(0x19, lo5);
            T(0x1C, lo6);
            var e = (_tuneRow.Enable & 0xFF9F) | 0x2;
            T(0x24, e | 0x0004 | 0x0002);
            _lastReq = req;
        }
        _tunerKhz = req;
        _capPending = true;
        return 20;
    }

    private int _capStep;
    private int _cap;
    private int _capBest;
    private int _capDmin;

    /// <summary>7.3.5 キャパシタの調整 (P1G。ハードが自分で探す)</summary>
    private int CapacitorP1gStep()
    {
        switch (_tunerState)
        {
            case TunerStart:
                T(0x10, 0x02B1);
                T(0x1E, 0x0032);
                _tunerState = 11;
                return 0;
            case 11:
                T(0x40, 0x01FF);
                T(0x40);
                _tunerState = 12;
                return 50;
            case 12:
                T(0x40, 0x018C);
                T(0x40);
                _cap = T(0x18) & 0x7F;
                _tunerState = 13;
                return 0;
            default:
                _capPending = false;
                _tunerState = 1;
                return 0;
        }
    }

    /// <summary>7.3.5 キャパシタの調整 (P1G より前。二分探索)</summary>
    private int CapacitorStep()
    {
        switch (_tunerState)
        {
            case TunerStart:
                T(0x10, 0x02B1);
                T(0x1E, 0x0032);
                if (_capacitors.TryGetValue(_tunerKhz, out _capKnown))
                {
                    // 覚えた値を置いて ADC を1回だけ見る (仕様書に無い。合わなければ下の二分探索から)
                    _cap = _capBest = _capKnown.Cap;
                    T(0x18, 0xE900 | (_cap & 0xFF));
                    _tunerState = 15;
                    return 25;
                }
                if (!_tunerTuned)
                {
                    _capStep = 64;
                    _cap = 64;
                    _capBest = 64;
                }
                else
                {
                    _capStep = 4;
                    _cap = _capBest = T(0x18) & 0x7F;
                }
                _capDmin = 3000;
                _tunerState = 11;
                return 0;
            case 11:
                _capStep /= 2;
                T(0x18, 0xE900 | (_cap & 0xFF));
                _tunerState = 12;
                return 0;
            case 12:
                var adc = T(0x1D);
                var target = _rest == 0 ? 200 : 400;
                int d, direction;
                if (adc >= target)
                {
                    d = adc - target;
                    direction = -1;
                }
                else
                {
                    d = target - adc;
                    direction = 1;
                }
                if (d < _capDmin)
                {
                    _capDmin = d;
                    _capBest = _cap;
                }
                _cap += direction * _capStep;
                _tunerState = _capStep >= 1 ? 11 : 14;
                return 25;
            case 14:
                T(0x18, 0xE900 | (_capBest & 0xFF));
                _capacitors[_tunerKhz] = (_capBest, _capDmin);
                _notes.Add($"キャパシタ: 較正した ({_capReason}) キャパシタ {_capBest}、ADC の差 {_capDmin}");
                _tunerState = 13;
                return 0;
            case 15:
            {
                var seen = T(0x1D);
                var goal = _rest == 0 ? 200 : 400;
                var gap = Math.Abs(seen - goal);
                if (gap <= _capKnown.Dmin + CapacitorTolerance)
                {
                    _notes.Add($"キャパシタ: 使い回し {_capKnown.Cap} (ADC の差 {gap}、覚えたとき {_capKnown.Dmin}、ずれ {gap - _capKnown.Dmin})");
                    _capPending = false;
                    _tunerState = 1;
                    return 0;
                }
                // 合わない。忘れて二分探索から
                _capReason = $"覚えた値 {_capKnown.Cap} で ADC の差 {gap} が覚えたとき {_capKnown.Dmin} + {CapacitorTolerance} を超えた";
                _capacitors.Remove(_tunerKhz);
                _capStep = 64;
                _cap = _capBest = 64;
                _capDmin = 3000;
                _tunerState = 11;
                return 0;
            }
            default:
                _capPending = false;
                _tunerState = 1;
                return 0;
        }
    }

    private int _ltDefault = 0x7C00;
    private int _bb1;

    /// <summary>7.3.6 本体の段 0 (状態 1)</summary>
    private int TunerStep0()
    {
        var row = WbdRow(_tunerKhz / 1000);
        T(0x1E, 0x07FF);
        var gain = Gain(row.Gain);
        _wbdMux = (ushort)((gain << 13) | (3 << 11) | 0x0781 | 0x0002);
        T(0x10, _wbdMux);
        if (_tuneRow.Enable == EnableCband && P1g)
        {
            T(0x09, _tuneRow.LnaBias);
            T(0x0B, 0xB800 | (_tuneRow.LnaTune << 6) | _tuneRow.Switch);
        }
        else
        {
            T(0x09, (_tuneRow.LnaTune << 5) | _tuneRow.LnaBias);
        }
        T(0x0C, _tuneRow.V2i);
        T(0x0D, _tuneRow.Mixer);
        T(0x0E, _tuneRow.Load);
        _tunerState = 2;
        return 10;
    }

    /// <summary>7.3.6 本体の段 1 (状態 2)</summary>
    private int TunerStep1()
    {
        _ltDefault = 0x7C00;
        _bb1 = (_bb1 & ~0xC000) | (2 << 14);
        T(0x01, _bb1);
        T(0x03, 0x6008);
        T(0x04, 0x0001);
        T(0x02, 0x2A16);
        T(0x05, 0xABCD);
        _tunerTuned = true;
        _wbdPending = true;
        // 温度を測り直すかは次の選局の始めに決める (Tune)
        _tempPending = false;
        _tunerState = TunerEnd;
        return 10;
    }

    /// <summary>7.3.7 WBD の値の換算 (dB の 10 倍)</summary>
    private int WbdToDb(int value)
    {
        var w = value & 0x3FF;
        w = w < _wbdOffset ? 0 : w - _wbdOffset;
        var sum = 0;
        foreach (var (width, slope) in new[] { (66, 120), (600, 170), (170, 250) })
        {
            var r = Math.Min(w, width);
            sum += r * slope / width;
            w -= r;
        }
        return -640 + sum;
    }

    /// <summary>
    /// 7.3.8 WBD の目標。<c>熱 基準 - (熱 傾き × fMHz) &gt;&gt; 6</c> は「傾き × fMHz を 6 ビット右へ送ってから引く」と読んだ
    /// (先に引いてから送ると、ほとんどの周波数で負になって意味をなさない)
    /// </summary>
    private int WbdTarget()
    {
        var mhz = _khz / 1000;
        var row = WbdRow(mhz);
        var temperature = Math.Clamp(_temperature, 0, 128);
        _wbdMux = (ushort)((_wbdMux & 0x1FFF) | (Gain(row.Gain) << 13));
        T(0x10, _wbdMux);
        var hot = (int)(short)(ushort)(row.HotBase - ((row.HotSlope * mhz) >> 6));
        var cold = (int)(short)(ushort)(row.ColdBase - ((row.ColdSlope * mhz) >> 6));
        cold += ((hot - cold) * temperature) >> 7;
        return (ushort)(_wbdOffset + cold);
    }

    // 7.3.11 ランプの表
    private static readonly int[] RampRfCband = [314, 33, 1023, 0x22E7, 0x03FF, 0x3DD5, 0x02E6, 0x24EA, 0x01D4, 0x2400, 0x00E9];
    private static readonly int[] RampRfVhf = [398, 24, 954, 0x1C00, 0x0122, 0x42BB, 0x03BA, 0x4644, 0x02BB, 0x1D22, 0x0244];
    private static readonly int[] RampRfUhf = RampRfVhf;
    private static readonly int[] RampRf7090pCband = [280, 18, 504, 0x756C, 0x01F8, 0xF0E4, 0x016C, 0x886D, 0x00E4, 0x9400, 0x006D];
    private static readonly int[] RampBbNormal = [500, 8, 400, 0x0400, 0x00A8, 0x04A8, 0x0190];
    private static readonly int[] RampBbSoc = [550, 0x0208, 440, 0x0800, 0x00D0, 0x08D0, 0x01B8];

    // 7.3.9 ソフトの AGC (CBAND のときだけ)
    private int[] _rfRamp = RampRfUhf;
    private int[] _bbRamp = RampBbNormal;
    private int _agcLimit;
    private int _agcGain;
    private int _agcSteps;
    private int _agcState;
    private int _wbdGoal;
    private readonly int[] _gainRegisters = [-1, -1, -1, -1];

    /// <summary>7.3.9 を「終わり」まで回す。待ちはミリ秒。周りの GPIO 6 (外付けのアッテネーター) も</summary>
    private void SoftAgc()
    {
        var wait = SoftAgcStart();
        bool? attenuator = null;
        for (var guard = 0; ; guard++)
        {
            if (guard > 500) throw new IOException("DiB0090 のソフトの AGC が終わりません");
            if (_agcState == 0 && attenuator != true)
            {
                Gpio(6, true);
                attenuator = true;
            }
            else if (_agcState == 1 && (short)_agcLimit < 2000 && attenuator != false)
            {
                Gpio(6, false);
                attenuator = false;
            }
            if (_agcState == TunerEnd) return;
            Wait(wait);
            wait = SoftAgcStep();
        }
    }

    private int SoftAgcStart()
    {
        T(0x04, 0);
        var band = _tunerBand;
        if (!P1g && band == Band.Vhf)
        {
            _rfRamp = RampRfVhf;
            _bbRamp = RampBbNormal;
        }
        else if (!P1g && band == Band.Cband)
        {
            _rfRamp = RampRfCband;
            _bbRamp = RampBbNormal;
        }
        else if (P1g && band is Band.Cband or Band.Vhf)
        {
            _rfRamp = RampRf7090pCband;
            _bbRamp = RampBbSoc;
        }
        else
        {
            _rfRamp = RampRfUhf;
            _bbRamp = RampBbNormal;
        }
        _bb1 = _bbRamp[0] > 500 ? _bb1 | 0x2000 : _bb1 & ~0x2000;
        T(0x32, 0);
        T(0x39, 0);
        // この機材の設定では VHF・CBAND の足しは 0 (UHF なら 250)
        _wbdGoal = WbdToDb(_wbdOffset + (band is Band.Vhf or Band.Cband ? 0 : 250));
        _agcLimit = _rfRamp[0] << 6;
        _agcGain = ((_rfRamp[0] + _bbRamp[0]) / 2) << 5;
        _agcState = 0;
        Array.Fill(_gainRegisters, -1);
        ApplyGain(0, 0, true);
        return 10;
    }

    /// <summary>
    /// 段 0 以降の1歩。**段 1 の歩数 (stepCount) は段 1 を1回回るごとに 1 増やす** — 仕様書は
    /// 「5 を超えたら」とだけ書き、増やす所を書いていない (増えなければ終わらないので、こう読んだ)
    /// </summary>
    private int SoftAgcStep()
    {
        var samples = _agcState == 0 ? 5 : 1;
        var sum = 0;
        for (var i = 0; i < samples; i++) sum += WbdToDb(T(0x1D));
        var wbdError = _wbdGoal - sum / samples;
        var adcError = 0;
        if (_agcState == 0)
        {
            if (wbdError < 0 && _agcLimit > 0 && !P1g)
            {
                if (_tunerBand == Band.Cband && ((_ltDefault >> 10) & 7) != 0)
                {
                    var half = ((_ltDefault >> 10) & 7) / 2;
                    _ltDefault &= half << 10;
                }
            }
            else
            {
                _agcSteps = 0;
                _agcState = 1;
            }
        }
        else
        {
            var p = AdcPower();
            p = (int)(((long)p * 355774 + (1 << 20)) >> 21);
            adcError = -220 - p;
            _agcSteps++;
            if (_agcSteps > 5 || Math.Abs(adcError) < 50)
            {
                T(0x02, 0x99A0);
                T(0x04, 0x0001);
                _agcState = TunerEnd;
                return 0;
            }
        }
        ApplyGain(adcError, wbdError, _agcState <= 1);
        return 10;
    }

    /// <summary>利得を適用 (誤差 <paramref name="ge"/>、上限の誤差 <paramref name="te"/>)</summary>
    private void ApplyGain(int ge, int te, bool immediate)
    {
        te = Math.Clamp(te, -511, 511);
        if (immediate)
        {
            te <<= 6;
            ge <<= 5;
        }
        var rfMax = _rfRamp[0] << 6;
        _agcLimit = te >= rfMax - _agcLimit ? rfMax : _agcLimit + te;
        if (_agcLimit < 0) _agcLimit = 0;
        var top = ((_agcLimit >> 6) + _bbRamp[0]) << 5;
        _agcGain = ge >= top - _agcGain ? top : _agcGain + ge;
        if (_agcGain < 0) _agcGain = 0;

        var g = _agcGain >> 5;
        int rf, bb;
        if (g > _agcLimit >> 6)
        {
            rf = _agcLimit >> 6;
            bb = Math.Min(g - rf, _bbRamp[0]);
        }
        else
        {
            rf = g;
            bb = 0;
        }

        Span<int> amplifiers = stackalloc int[7];
        for (var k = 0; k < 7; k++)
        {
            var table = k < 5 ? _rfRamp : _bbRamp;
            var x = k < 5 ? rf : bb;
            var i = 1 + 3 * (k < 5 ? k : k - 5);
            int At(int index) => index < table.Length ? table[index] : 0;
            int a = At(i), b = At(i + 1), c = At(i + 2);
            amplifiers[k] = a == 0 || x < b - a ? 0 : x >= b ? c : (x - (b - a)) * c / a;
        }
        int[] values =
        [
            amplifiers[0] | (amplifiers[1] << 7),
            amplifiers[2] | (amplifiers[3] << 7),
            amplifiers[4] | _ltDefault,
            (amplifiers[5] << 3) | (amplifiers[6] << 8) | _bb1 | ((bb % 10) * 100 / 125),
        ];
        int[] registers = [0x08, 0x0A, 0x0F, 0x01];
        for (var k = 0; k < 4; k++)
        {
            var value = values[k] & 0xFFFF;
            if (!immediate && _gainRegisters[k] == value) continue;
            T(registers[k], value);
            _gainRegisters[k] = value;
        }
    }

    /// <summary>7.3.12 DiB8000 で測る ADC の電力 (dB の 256 分の 1)</summary>
    private int AdcPower()
    {
        var v = (int)D32(384);
        if (v <= 0) v = 1;  // 仕様書に無い (0 以下のときの扱い)。いちばん小さい値として扱う
        var e = 31 - int.LeadingZeroCount(v);
        var m = (long)v * 1000 / (1L << e);
        var i = Math.Min((int)(((m - 1000) / 100) & 0xFF), 10);
        int[] table = [908, 7003, 7090, 7170, 7244, 7313, 7377, 7438, 7495, 7549, 7600];
        var p = table[i] + 693 * (e - 20) - 6908;
        return p * 256 / 1000;
    }

    /// <summary>7.3.10 DiB0090 の AGC を PWM に渡す</summary>
    private void AgcToPwm()
    {
        var rf = _tunerBand switch
        {
            Band.Cband => RampRfCband,
            Band.Vhf => RampRfVhf,
            _ => RampRfUhf,
        };
        T(0x2A, 0xFFFF);
        for (var i = 0; i < 6; i++) T(0x2C + i, rf[3 + i]);
        T(0x3E, rf[9]);
        T(0x3F, rf[10]);
        var bb = RampBbNormal;
        _bb1 = bb[0] > 500 ? _bb1 | 0x2000 : _bb1 & ~0x2000;
        T(0x33, 0xFFFF);
        for (var i = 0; i < 4; i++) T(0x35 + i, bb[3 + i]);
        var mux = rf[0] == 0 || (_tunerBand == Band.Cband && (TunerVersion & 0x1F) <= 3) ? 0 : 1;
        T(0x32, (mux << 12) | (mux << 11));
        T(0x04, 0x0001);
        T(0x39, 0x0400);
    }

    // --- DiB8000 の AGC (7.4) ----------------------------------------------

    private Band? _agcBand;

    /// <summary>7.4 AGC の立ち上げ</summary>
    private void StartAgc()
    {
        Adc(AdcMode.On);
        AgcSettings();
        Wait(Ms(70));
        T(0x04, 0);
        D(770, 0x0A00);
        D(770, 0);
        Wait(Ms(50));
        Wait(Ms(70));
        T(0x04, 1);
        T(0x04, 1);
    }

    /// <summary>7.4.1 AGC の設定 (CBAND 用と、それ以外の帯用)。前回と同じ帯なら何もしない</summary>
    private void AgcSettings()
    {
        var cband = _band == Band.Cband;
        var kind = cband ? Band.Cband : Band.Uhf;
        if (_agcBand == kind) return;
        D(76, 0x286A);
        D(77, 787);
        D(78, 10);
        D(101, 118);
        D(102, (28 << 5) | 26);
        D(103, (31 << 6) | 51);
        D(106, _wbdReference ?? 3530);
        D(107, 5 << 9);
        D(108, cband ? 0 : 65535);
        D(109, 0);
        D(110, 65535);
        D(111, 0);
        D(112, (0 << 8) | 32);
        D(113, (143 << 8) | 144);
        D(114, (114 << 8) | 227);
        D(115, (116 << 8) | 117);
        D(75, 114);
        Modify(923, 0xFFE3, (0 << 4) | (1 << 2));
        _agcBand = kind;
    }

    // --- 復調器の探索とロック (7.5) ------------------------------------

    private enum Fft
    {
        Auto,
        K2,
        K4,
        K8,
    }

    private enum Modulation
    {
        Auto,
        Dqpsk,
        Qpsk,
        Qam16,
        Qam64,
    }

    /// <summary>階層。<c>Fec</c> は 1/2 = 1、2/3 = 2、3/4 = 3、5/6 = 5、7/8 = 7、自動 = 0</summary>
    private struct Layer
    {
        public Modulation Modulation;
        public int Fec;
        public int Interleave;
        public int Segments;
    }

    private Fft _fft;

    /// <summary>ガードの番号 (1/32 = 0、1/16 = 1、1/8 = 2、1/4 = 3)。自動は -1</summary>
    private int _guard;

    private int _inversion;
    private int _partial;
    private readonly Layer[] _layers = new Layer[3];

    /// <summary>差動のセグメントのマスク。**前回の値を持ち越す** (参考の実装の振る舞い)</summary>
    private int _diff;

    private bool _differential;
    private Fft _foundFft;

    /// <summary>探索の入り方</summary>
    private enum Entry
    {
        /// <summary>FFT から探す (仕様書の形)</summary>
        Full,

        /// <summary>FFT は 8K と決めて、ガードだけ探す (仕様書の「ガードを探す」から入る)</summary>
        Guard,

        /// <summary>前にロックしたときの値で、探索せずに段 3 から合わせる (仕様書に無い経路)</summary>
        Known,
    }

    private Entry _entry;

    /// <summary>段 3 で共通設定に渡した値 (ロックしたら覚える)</summary>
    private Snapshot? _programmed;

    /// <summary>ロックしたときのチャンネルの値</summary>
    internal sealed record Snapshot(int Fft, int Guard, int Inversion, int Partial, int Diff, (int Modulation, int Fec, int Interleave, int Segments)[] Layers);

    private Snapshot Capture() => new(
        (int)_fft, _guard, _inversion, _partial, _diff,
        [.. _layers.Select(layer => ((int)layer.Modulation, layer.Fec, layer.Interleave, layer.Segments))]);

    private void Restore(Snapshot snapshot)
    {
        _fft = (Fft)snapshot.Fft;
        _guard = snapshot.Guard;
        _inversion = snapshot.Inversion;
        _partial = snapshot.Partial;
        _diff = snapshot.Diff;
        for (var i = 0; i < 3; i++)
        {
            var (modulation, fec, interleave, segments) = snapshot.Layers[i];
            _layers[i] = new Layer { Modulation = (Modulation)modulation, Fec = fec, Interleave = interleave, Segments = segments };
        }
    }

    private enum SearchKind
    {
        FindFft,
        FindGuard,
        Done,
    }

    private enum Step
    {
        Start,
        SearchStart,
        Step1,
        Step2,
        Step3,
        Step4,
        Step5,
        Step6,
        Step7,
        Step8,
        Step9,
        Step10,
        Stop,
    }

    private enum DemodState
    {
        Tuning,
        FftSuccess,
        Failed,
        Locked,
        DataLocked,
    }

    private SearchKind _search;
    private DemodState _demodState;
    private double _deadline;
    private int _longest;

    /// <summary>1 シンボルの長さ (ms)。6MHz では計算上いつも 0.1ms (参考の実装の振る舞い)</summary>
    private const double Symbol = 0.1;

    /// <summary>探索の上限 (参考の実装。機材は 2 秒前後で終わる)</summary>
    private const double SearchLimitMs = 5000;

    /// <summary>
    /// 7.5 の状態の機械を回す。**1歩の間は最低 10ms 空ける** (仕様書 7.5 の「参考の実装の振る舞い」。シンボル数の時間切れは
    /// この間隔を前提にした長さで、詰めると同期の判定の前に時間切れになる)
    /// </summary>
    private DibLock Search()
    {
        _fft = Fft.Auto;
        _guard = -1;
        _inversion = 0;
        _partial = 0;
        for (var i = 0; i < 3; i++) _layers[i] = new Layer { Modulation = Modulation.Auto, Fec = 0, Interleave = 0, Segments = 0 };
        _demodState = DemodState.Tuning;
        _programmed = null;
        Snapshot? known = null;
        if (_memory is not null) _memory.Channels.TryGetValue(_khz, out known);
        // 入り方は 覚えた値 → 既定 (8K) でガードだけ探す → FFT から探す の順で固定 (合わなければ次へ)
        if (known is not null)
        {
            Restore(known);
            _entry = Entry.Known;
            _path = "覚えた値で合わせた";
        }
        else if (Version >= 0x8002)
        {
            _foundFft = Fft.K8;
            _entry = Entry.Guard;
            _path = "既定 (8K) でガードだけ探した";
        }
        else
        {
            _entry = Entry.Full;
            _path = "探索した";
        }

        var started = _time.NowMs;
        var step = Step.Start;
        var readBack = false;
        for (; ; )
        {
            var stepStarted = _time.NowMs;
            var stepSlept = _slept;
            var name = step switch
            {
                Step.Step1 => $"探索 Step1 ({(_search == SearchKind.FindFft ? "FFT" : "ガード")} の探索の終わり (D[1284]) 待ち)",
                Step.Step10 => "探索 Step10 (いずれかの階層の MPEG のロック待ち)",
                _ => $"探索 {step}",
            };
            var (next, wait) = DemodStep(step);
            step = next;
            if (_demodState == DemodState.FftSuccess && !readBack)
            {
                ReadBack();
                readBack = true;
            }
            if (step == Step.Stop) Account(name, _time.NowMs - stepStarted, _slept - stepSlept);
            if (step == Step.Stop && _demodState == DemodState.Failed && _entry != Entry.Full)
            {
                // 覚えた値・既定で合わなかった。探索からやり直す
                if (_entry == Entry.Known) _memory?.Forget(_khz);
                _path = _entry == Entry.Known ? "覚えた値で合わず探索した" : "既定 (8K) で合わず探索した";
                _entry = Entry.Full;
                _fft = Fft.Auto;
                _guard = -1;
                _partial = 0;
                for (var i = 0; i < 3; i++) _layers[i] = default;
                _demodState = DemodState.Tuning;
                readBack = false;
                started = _time.NowMs;
                step = Step.Start;
                continue;
            }
            if (step == Step.Stop && _demodState is DemodState.Failed or DemodState.Locked or DemodState.DataLocked) break;
            if (step == Step.Stop) throw new IOException("DiB8000 の探索が途中で止まりました");
            if (_time.NowMs - started > SearchLimitMs) throw new IOException("DiB8000 の探索が 5 秒で終わりませんでした");
            var floor = Floor(step);
            if (floor == FastPollMs) _fastSteps[step] = _fastSteps.GetValueOrDefault(step) + 1;
            Wait(Math.Max(floor, (int)Math.Ceiling(wait * Symbol)));
            Account(name, _time.NowMs - stepStarted, _slept - stepSlept);
        }
        // ロックしたら、段 3 で書いた値を覚えておく (次からは探索せずに同じ値で合わせる)。7.5.6 の読み戻しは TMCC の同期が
        // 揃っていないと何も読まず、実機ではロックしたあとでも揃わないことがあったので、読み戻しに頼らない
        if (_memory is not null && _entry != Entry.Known && _programmed is not null && _demodState is DemodState.Locked or DemodState.DataLocked)
        {
            _memory.Remember(_khz, _programmed);
        }
        return _demodState switch
        {
            DemodState.DataLocked => DibLock.DataLocked,
            DemodState.Locked => DibLock.Locked,
            _ => DibLock.Failed,
        };
    }

    /// <summary>
    /// 次の段を回すまでの最低の間 (ms)。仕様書 (参考の実装) はどの段も最低 10ms。
    /// シンボルの数の時間切れに関わらない段は <see cref="FastPollMs"/> に詰める (仕様書に無い)。段ごとの根拠:
    /// <list type="bullet">
    /// <item>開始・探索の始め・段 2・段 3・段 9: 書いて次へ進むだけで、待って見るものが無い。間を空けても機材の進みは変わらない
    /// (段 3 のあとの間は、段 4 を下の 10ms 側に入れたので詰めない)</item>
    /// <item>段 1: 探索の終わりの割り込み (D[1284]) を見るだけ。時間切れは外側の 5 秒だけで、早く見ても読みが増えるだけ</item>
    /// <item>段 10: 時間切れは実時間 (200ms × 数) なので、見る間隔を詰めても時間切れの長さは変わらない</item>
    /// <item>段 5・段 7 (と、そこから入る段 6・段 8) は 10ms のまま: 時間切れがシンボルの数 (2 × L・20 × n シンボル、6MHz で数 ms) で、
    /// 10ms ごとに見る前提の長さになっている。詰めると機材が同期を判定する前に時間切れになる。段 8 の前の 14 シンボルの待ちも同じ</item>
    /// <item>段 4 も 10ms のまま: 段 3 でチャンネルの共通設定を書いてから復調器をやり直すまでの間で、機材がその設定を取り込むのに
    /// 要る時間が仕様書から分からない。段 4 は段 5 の時間切れ (シンボルの数) を立てる所でもある</item>
    /// </list>
    /// </summary>
    private int Floor(Step next) =>
        next is not (Step.Step4 or Step.Step5 or Step.Step6 or Step.Step7 or Step.Step8) ? FastPollMs : 10;

    /// <summary>1歩。次の段と待ち (0.1ms)</summary>
    private (Step Next, int Wait) DemodStep(Step step)
    {
        switch (step)
        {
            case Step.Start:
                D(565);
                Modify(771, 0xFFFF, 0x0002);
                Modify(285, 0x0060, 0);
                DdsOffset();
                D32(29, _timing);
                switch (_entry)
                {
                    case Entry.Known:
                        _search = SearchKind.Done;
                        return (Step.Step3, 0);
                    case Entry.Guard:
                        _search = SearchKind.FindGuard;
                        return (Step.SearchStart, 0);
                    default:
                        _search = SearchKind.FindFft;
                        return (Step.SearchStart, 0);
                }

            case Step.SearchStart:
                StartSearch();
                return (Step.Step1, 15);

            case Step.Step1:
            {
                var q = D(1284);
                if (_search == SearchKind.FindFft && Version >= 0x8002)
                {
                    return (q & 1) != 0 ? (Step.Step2, 0) : (Step.Step1, 0);
                }
                if ((q & 1) != 0)
                {
                    _demodState = DemodState.Failed;
                    return (Step.Stop, 0);
                }
                if ((q & 2) != 0)
                {
                    _demodState = DemodState.FftSuccess;
                    if (_search == SearchKind.FindGuard) return (Step.Step2, 0);
                    _search = SearchKind.Done;
                    return (Step.Step3, 0);
                }
                return (Step.Step1, 0);
            }

            case Step.Step2:
                if (_search == SearchKind.FindFft)
                {
                    var c2 = D32(594);
                    var c1 = D32(596);
                    var c0 = D32(598);
                    _foundFft = c0 >= c1 && c0 >= c2 ? Fft.K2 : c1 >= c2 ? Fft.K4 : Fft.K8;
                    _search = SearchKind.FindGuard;
                    return (Step.SearchStart, 10);
                }
                if (_search == SearchKind.FindGuard)
                {
                    D(570);
                    return (Step.Step3, 0);
                }
                _demodState = DemodState.Failed;
                return (Step.Stop, 0);

            case Step.Step3:
                _programmed = Capture();
                LoopValues(first: true);
                // 「探索ではない」ときの順番は仕様書に無い。チャンネルの値が全部分かっているときの順番 (0) にした
                ChannelSetup(0, searching: false);
                return (Step.Step4, 0);

            case Step.Step4:
            {
                D(770, 0x4000);
                D(770, 0);
                SyncWait();
                Diversity(DiversityMode.Internal);
                var l = (D(180) >> 6) & 0x3F;
                _deadline = _time.NowMs + 2 * l * Symbol;
                return (Step.Step5, 0);
            }

            case Step.Step5:
            {
                var k = D(568);
                if ((k & 0x1800) != 0)
                {
                    _timing = D32(435);
                    D32(29, _timing);
                    if (!_differential)
                    {
                        _deadline = _time.NowMs + 20 * ((D(188) >> 5) & 0x1F) * Symbol;
                        return (Step.Step7, 0);
                    }
                    return (Step.Step8, 0);
                }
                return _time.NowMs > _deadline ? (Step.Step6, 0) : (Step.Step5, 0);
            }

            case Step.Step6:
                Modify(771, 0xFFFD, 0);
                LoopValues(first: false);
                _demodState = DemodState.Failed;
                return (Step.Stop, 0);

            case Step.Step7:
            {
                var k = D(568);
                if ((k & 0x0400) != 0) return (Step.Step8, 14);
                return _time.NowMs > _deadline ? (Step.Step6, 0) : (Step.Step7, 0);
            }

            case Step.Step8:
                Modify(771, 0xFFFD, 0);
                LoopValues(first: false);
                _demodState = DemodState.Locked;
                return (Step.Step9, 0);

            case Step.Step9:
            {
                if (((D(1291) >> 9) & 1) == 0) return (Step.Stop, 0);
                var value = 0;
                _longest = 0;
                for (var i = 0; i < 3; i++)
                {
                    if (_layers[i].Interleave >= value && _layers[i].Segments > 0)
                    {
                        // 参考の実装の振る舞い (値は階層 A のインターリーブ)
                        value = _layers[0].Interleave;
                        _longest = i;
                    }
                }
                var count = value switch
                {
                    0 => 2,
                    3 => 8,
                    _ => 2 * value,
                };
                _deadline = _time.NowMs + 200 * count;
                return (Step.Step10, 0);
            }

            case Step.Step10:
            {
                var k = D(568);
                // 仕様書の段 10 は「最長の階層」のビットだけを待ち、時間切れのときに 0x00E0 (どれかの階層) で判定する。
                // 最長の階層は参考の実装の振る舞いで 1 セグメントの階層 A になりがちで、そのインターリーブが深いぶん待つ
                // (実機で 600ms)。時間切れのときの判定 (と 8.1 の「データが出る」) と同じく、どれかの階層が揃えば先へ進む
                if ((k & (1 << (7 - _longest))) != 0 || (k & 0x00E0) != 0)
                {
                    _demodState = DemodState.DataLocked;
                    return (Step.Stop, 0);
                }
                if (_time.NowMs > _deadline)
                {
                    _demodState = (k & 0x00E0) != 0 ? DemodState.DataLocked : DemodState.Failed;
                    return (Step.Stop, 0);
                }
                return (Step.Step10, 0);
            }
        }
        return (Step.Stop, 0);
    }

    /// <summary>7.5.1「待ちを書く (a, b, c)」。最後の値を返す</summary>
    private uint SearchWaits(uint a, uint b, uint c)
    {
        const uint clock = 54000;
        D32(11, clock * a);
        D32(13, clock * b);
        D32(15, clock * c);
        return clock * c;
    }

    /// <summary>7.5.1 探索の始め方</summary>
    private void StartSearch()
    {
        if (Version >= 0x8002 && _search == SearchKind.FindFft)
        {
            D(37, 0x0065);
            D(116, 0);
            Modify(0, 0x1FFF, 0x8000);
            Modify(1, 0xFFFC, 0);
            D(6, 0);
            D(7, 0);
            D(8, 0);
            Modify(10, 0x0200, 0x0100);
            var w = SearchWaits(20, 20, 20);
            D(17, 0);
            D(18, 200);
            D(19, 0);
            D(20, 400);
            D(21, (int)(w >> 16));
            D(22, (int)(w & 0xFFFF));
            Modify(32, 0xF0FF, 0x0900);
            D(355, 2);
            D(356, 0);
            D(357, 0x0111);
            Modify(770, 0xDFFF, 0x2000);
            Modify(770, 0xDFFF, 0);
            Modify(0, 0x07FF, 0x2000);
            return;
        }

        if (Version >= 0x8002)
        {
            _fft = _foundFft;
            _guard = 2;
            _inversion = 0;
            _layers[0] = new Layer { Modulation = Modulation.Qam64, Fec = 2, Interleave = 0, Segments = 13 };
            ChannelSetup(16, searching: true);
            D(6, 0x0004);
            D(7, 0x0008);
            D(8, 0x1000);
            SearchWaits(50, 200, 1000);
            D(355, 3);
            D(356, 0);
            D(357, 0x000F);
        }
        else
        {
            _inversion = 0;
            _layers[0] = new Layer { Modulation = Modulation.Qam64, Fec = 2, Interleave = 0, Segments = 13 };
            int seq;
            if (_guard < 0 && _fft == Fft.Auto)
            {
                _fft = Fft.K8;
                _guard = 2;
                seq = 7;
                Modify(0, 0x9FFF, 0x2000);
            }
            else if (_guard < 0)
            {
                _guard = 2;
                seq = 3;
            }
            else if (_fft == Fft.Auto)
            {
                _fft = Fft.K8;
                seq = 2;
                Modify(0, 0x9FFF, 0x2000);
            }
            else
            {
                seq = 0;
            }
            ChannelSetup(seq, searching: true);
            D(6, 0x0004);
            D(7, 0x0008);
            D(8, 0x1000);
            SearchWaits(50, 100, 1000);
        }
        var v = D(0);
        D(0, v | 0x8000);
        D(1284);
        D(0, v);
    }

    private static readonly int[] SegmentOrder = [6, 5, 7, 4, 8, 3, 9, 2, 10, 1, 11, 0, 12];

    private static readonly int[] Coefficients3 =
        [81, 80, 78, 74, 68, 61, 54, 45, 37, 28, 19, 11, 4, 1022, 1017, 1013, 1010, 1008, 1008, 1008, 1008, 1010, 1014, 1017];

    private static readonly int[] Coefficients1 =
        [249, 226, 164, 82, 5, 981, 970, 988, 1018, 20, 31, 26, 8, 1012, 1000, 1018, 1012, 8, 15, 14, 9, 3, 1017, 1003];

    private static readonly int[] Coefficients13 =
        [396, 305, 105, -51, -77, -12, 41, 31, -11, -30, -11, 14, 15, -2, -13, -7, 5, 8, 1, -6, -7, -3, 0, 1];

    private int Mode => _fft switch
    {
        Fft.K2 => 1,
        Fft.K4 => 2,
        _ => 3,
    };

    /// <summary>7.5.2 チャンネルの共通設定</summary>
    private void ChannelSetup(int seq, bool searching)
    {
        const int seg = 0x1FFF;
        if (searching) _partial = 1;
        D(10, seq << 4);
        var mode = Mode;
        D(1, (D(1) & 0xFFFC) | (_guard & 3));
        Modify(274, 0xFFCF, (_partial & 1) << 5);

        if (_partial != 0)
        {
            _diff = (_layers[0].Modulation == Modulation.Dqpsk ? 1 : 0) << SegmentOrder[0];
            var n = 0;
            for (var i = 1; i < 3; i++) n += _layers[i].Modulation == Modulation.Dqpsk ? _layers[i].Segments : 0;
            for (var i = 0; i < n && i + 1 < 13; i++) _diff |= 1 << SegmentOrder[i + 1];
        }
        else
        {
            var n = 0;
            for (var i = 0; i < 3; i++) n += _layers[i].Modulation == Modulation.Dqpsk ? _layers[i].Segments : 0;
            for (var i = 0; i < n && i < 13; i++) _diff |= 1 << SegmentOrder[i];
        }
        if (_diff != 0) Modify(268, 0xF9FF, 0x0200);
        else D(268, 0x0427);

        var densest = Modulation.Dqpsk;
        for (var i = 0; i < 3; i++)
        {
            var layer = _layers[i];
            var modulation = layer.Modulation switch
            {
                Modulation.Dqpsk => 0,
                Modulation.Qpsk => 1,
                Modulation.Qam16 => 2,
                _ => 3,
            };
            var fec = layer.Fec switch
            {
                1 => 1,
                2 => 2,
                3 => 3,
                5 => 5,
                _ => 7,
            };
            var ti = layer.Interleave == 0 ? 0 : 32 - int.LeadingZeroCount(layer.Interleave);
            if (ti > 3) ti = 0;
            D(2 + i, (modulation << 10) | ((layer.Segments & 0xF) << 6) | (fec << 3) | ti);
            if (layer.Segments > 0)
            {
                if (densest is Modulation.Dqpsk or Modulation.Qpsk && layer.Modulation is Modulation.Qam16 or Modulation.Qam64) densest = layer.Modulation;
                else if (densest == Modulation.Qam16 && layer.Modulation == Modulation.Qam64) densest = Modulation.Qam64;
            }
        }
        D(0, (mode << 13) | _diff);
        _differential = _diff != 0;

        int a;
        int[] fe;
        switch (densest)
        {
            case Modulation.Qam64:
                a = 7;
                fe = [0x0148, 0xFFF0, 0x00A4, 0xFFF8];
                break;
            case Modulation.Qam16:
                a = 7;
                fe = [0x023D, 0xFFDF, 0x00A4, 0xFFF0];
                break;
            default:
                a = 0;
                fe = [0x099A, 0xFFAE, 0x0333, 0xFFF8];
                break;
        }
        for (var i = 0; i < 4; i++) D(215 + i, fe[i]);
        D(116, a);
        int[] loop = [7250, 7238, 7264, 7309, 7338, 7382, 7427, 7456, 7500, 7544];
        for (var i = 0; i < loop.Length; i++) D(80 + i, a != 0 ? loop[i] : loop[i] - 355);

        WriteCoefficients(_partial != 0 ? Coefficients3 : Coefficients1);

        D(180, 0x0409);
        D(187, 0x4102);
        for (var register = 181; register <= 186; register++) D(register, 0x2800);
        D(338, 0x1461);
        D(340, 0x0206);
        D(341, 0x0027);
        D(228, 0);
        D(265, 31);
        D(205, 0x200F);
        D(266, (~seg | _diff | 0x0040) & 0xFFFF);
        // 13 セグメント用で上書きする (参考の実装の振る舞い)
        WriteCoefficients(Coefficients13);

        D(352, _diff);
        D(353, seg);
        D(351, 0x00D5);
        Modify(1, 0x0003, 0x0FFF << 2);

        var enabled = seg & ~_diff;
        int left = 0, right = 0;
        for (var i = 0; i < 13; i++)
        {
            if (((_diff >> i) & 1) != 0) continue;
            if (i == 0 || ((enabled >> (i - 1)) & 1) == 0) left += 1 << i;
            if (i == 12 || ((enabled >> (i + 1)) & 1) == 0) right += 1 << i;
        }
        D(222, left);
        D(223, right);
        var x = (~seg | _diff) & 0xFFFF;
        D(189, x);
        D(192, x);
        D(225, x);
        D(288, searching ? 0x1FFF : x & 0x1FFF);
        D(211, seg & ~_diff);
        D(287, (~seg | 0x1000) & 0xFFFF);
        D(178, 32);
        var p = 0;
        for (var i = 0; i < 3; i++) p += ((_layers[i].Modulation == Modulation.Dqpsk ? 4 : 0) + 1) * _layers[i].Segments;
        p *= 128;
        D(290, p);
        D(291, p);
        D(292, p);
        D(250, 3285);
    }

    private void WriteCoefficients(int[] values)
    {
        for (var i = 0; i < values.Length; i++) D(117 + i, values[i] & 0xFFFF);
    }

    /// <summary>7.5.3 ループの値</summary>
    private void LoopValues(bool first)
    {
        var m = Mode;
        if (first)
        {
            D(32, ((9 - m) << 12) | 0x0600 | 0x80);
            D(37, (3 << 5) | (8 - m));
        }
        else
        {
            D(32, ((11 - m) << 12) | 0x0600 | 0x80);
            D(37, ((5 + m) << 5) | (10 - m));
        }
    }

    /// <summary>7.5.4 DDS のずれ (チューナーの固定のずれを打ち消す)</summary>
    private void DdsOffset()
    {
        var offset = (int)_tunerKhz - (int)_khz;
        var unit = 67108864 / 54000;
        if (offset < 0) unit = -unit;
        var magnitude = Math.Abs(offset);
        var dds = unchecked((uint)magnitude * (uint)unit);
        if (magnitude > 27000) return;
        D(26, 0);
        D(27, (int)((dds >> 16) & 0x1FF));
        D(28, (int)(dds & 0xFFFF));
    }

    /// <summary>7.5.5 同期の待ち</summary>
    private void SyncWait()
    {
        var unit = _fft switch
        {
            Fft.K8 => 256,
            Fft.K4 => 128,
            _ => 64,
        };
        var w = unit * (1 << (_guard & 3)) * 3 / 2 + 48;
        Modify(273, 0x000F, w << 4);
    }

    /// <summary>7.5.6 見つけた値を読み戻す。TMCC の同期が無ければ何もしない (早すぎる読みはロックを妨げる)</summary>
    private void ReadBack() => ReadParameters();

    /// <summary>7.5.6 の読み戻し。TMCC の同期があって読めたら true</summary>
    private bool ReadParameters()
    {
        if ((D(568) & 0x001E) != 0x001E) return false;
        D(508);
        var v = D(570);
        _inversion = (v >> 6) & 1;
        _fft = ((v >> 4) & 3) switch
        {
            1 => Fft.K2,
            2 => Fft.K4,
            _ => Fft.K8,
        };
        _guard = v & 3;
        _partial = D(505) & 1;
        for (var i = 0; i < 3; i++)
        {
            var interleave = D(499 + i) & 3;
            _layers[i] = new Layer
            {
                Segments = D(493 + i) & 0xF,
                Interleave = interleave == 3 ? 4 : interleave,
                Fec = (D(481 + i) & 7) switch
                {
                    1 => 1,
                    2 => 2,
                    3 => 3,
                    5 => 5,
                    _ => 7,
                },
                Modulation = (D(487 + i) & 3) switch
                {
                    0 => Modulation.Dqpsk,
                    1 => Modulation.Qpsk,
                    2 => Modulation.Qam16,
                    _ => Modulation.Qam64,
                },
            };
        }
        return true;
    }

    private enum DiversityMode
    {
        Internal,
        Both,
        External,
    }

    /// <summary>7.5.7 ダイバーシティの入力。バージョン 0x8002 は D[903] のビット 3 を 30ms 落とす (選局ごとに3回)</summary>
    private void Diversity(DiversityMode mode)
    {
        var sw = D(273) & 0xFFF0;
        if (!_differential)
        {
            D(272, 0x0200);
            D(273, sw | 0x0006);
        }
        else
        {
            D(272, 0);
            D(273, sw);
        }
        var (r270, r271) = mode switch
        {
            DiversityMode.Internal => (1, 0),
            DiversityMode.Both => (6, 6),
            _ => (0, 1),
        };
        D(270, r270);
        D(271, r271);
        if (Version == 0x8002)
        {
            var t = D(903);
            D(903, t & ~0x0008);
            Wait(30);
            D(903, t | 0x0008);
        }
    }

    // ---------------------------------------------------------------------
    // ロック・強さ・C/N (仕様書 8)
    // ---------------------------------------------------------------------

    /// <summary>8.1 のロック (ビット 12 と、ビット 5〜7 のどれか)</summary>
    public static bool IsLocked(ushort status) => (status & 0x1000) != 0 && (status & 0x00E0) != 0;

    /// <summary>D[568] (8.1)</summary>
    public ushort Status() => D(568);

    public DibSignal Signal()
    {
        var status = D(568);
        var strength = Strength(65535 - D(390));
        double? cn = null;
        if (IsLocked(status)) cn = CarrierToNoise(D(542), D(543));
        return new DibSignal(IsLocked(status), strength, cn, status);
    }

    private static readonly (uint S, uint Y)[] StrengthTable =
    [
        (55953, 108500), (55394, 108000), (53834, 107000), (52863, 106000), (52239, 105000), (52012, 104000),
        (51803, 103000), (51566, 102000), (51356, 101000), (51112, 100000), (50869, 99000), (50600, 98000),
        (50363, 97000), (50117, 96000), (49889, 95000), (49680, 94000), (49493, 93000), (49302, 92000),
        (48929, 91000), (48416, 90000), (48035, 89000), (47593, 88000), (47282, 87000), (46953, 86000),
        (46698, 85000), (45617, 84000), (44773, 83000), (43845, 82000), (43020, 81000), (42010, 80000), (0, 0),
    ];

    /// <summary>8.2 信号の強さ (dBm。目安)</summary>
    internal static double Strength(int s)
    {
        ulong y;
        if (s >= StrengthTable[0].S)
        {
            y = StrengthTable[0].Y;
        }
        else
        {
            y = StrengthTable[^1].Y;
            for (var i = 1; i < StrengthTable.Length; i++)
            {
                if (s < StrengthTable[i].S) continue;
                var (si, yi) = StrengthTable[i];
                var (sp, yp) = StrengthTable[i - 1];
                y = yi + ((ulong)s - si) * (yp - yi) / (sp - si);
                break;
            }
        }
        return ((double)y - 131000) / 1000;
    }

    /// <summary>8.3 C/N (dB)。測れなければ null</summary>
    internal static double? CarrierToNoise(ushort a, ushort b)
    {
        static uint Value(ushort raw)
        {
            var mantissa = (uint)((raw >> 6) & 0xFF);
            var exponent = raw & 0x3F;
            if (exponent >= 32) exponent -= 64;
            return mantissa << ((exponent + 16) & 31);
        }
        var n = Value(a);
        var s = Value(b);
        if (n == 0) return null;
        var t = unchecked((s / n) << 16);
        var snr = unchecked(t + ((s << 16) - n * t) / n);
        var whole = snr >> 16;
        return whole == 0 ? 0 : 10 * Math.Log10(whole);
    }
}

/// <summary>
/// チャンネル (周波数) ごとに、前にロックしたときの値 (FFT・ガード・階層)。**ボードを閉じても残す** (エージェントが動いている間)。
/// 日本の地上波はモードとガードがほぼ決まっていて、次からは探索せずに合わせられる
/// </summary>
public sealed class DibMemory
{
    internal readonly Dictionary<uint, Dib8096.Snapshot> Channels = [];

    /// <summary>覚えた値が変わった (増えた・変わった・捨てた)。ファイルに書くのはこれを受けたときだけ</summary>
    public event Action? Changed;

    internal void Remember(uint khz, Dib8096.Snapshot snapshot)
    {
        lock (Channels)
        {
            if (Channels.TryGetValue(khz, out var held) && Same(held, snapshot)) return;
            Channels[khz] = snapshot;
        }
        Changed?.Invoke();
    }

    internal void Forget(uint khz)
    {
        lock (Channels)
        {
            if (!Channels.Remove(khz)) return;
        }
        Changed?.Invoke();
    }

    private static bool Same(Dib8096.Snapshot a, Dib8096.Snapshot b) =>
        a.Fft == b.Fft && a.Guard == b.Guard && a.Inversion == b.Inversion && a.Partial == b.Partial && a.Diff == b.Diff
        && a.Layers.SequenceEqual(b.Layers);

    /// <summary>ファイルに書く形: <c>{ "&lt;kHz&gt;": { fft, guard, inversion, partial, diff, layers: [[変調, 符号化率, インターリーブ, セグメント数] × 3] } }</c></summary>
    public System.Text.Json.Nodes.JsonObject ToJson()
    {
        var json = new System.Text.Json.Nodes.JsonObject();
        lock (Channels)
        {
            foreach (var (khz, s) in Channels.OrderBy(pair => pair.Key))
            {
                var layers = new System.Text.Json.Nodes.JsonArray();
                foreach (var (modulation, fec, interleave, segments) in s.Layers)
                {
                    layers.Add((System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonArray(modulation, fec, interleave, segments));
                }
                json[khz.ToString(System.Globalization.CultureInfo.InvariantCulture)] = new System.Text.Json.Nodes.JsonObject
                {
                    ["fft"] = s.Fft, ["guard"] = s.Guard, ["inversion"] = s.Inversion, ["partial"] = s.Partial, ["diff"] = s.Diff, ["layers"] = layers,
                };
            }
        }
        return json;
    }

    /// <summary>ファイルの中身から。**どれか1つでも形が違えば投げる** (呼ぶ側が全部捨てて探索から)</summary>
    public static DibMemory FromJson(System.Text.Json.Nodes.JsonObject json)
    {
        var memory = new DibMemory();
        foreach (var (key, node) in json)
        {
            if (!uint.TryParse(key, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var khz) || node is not System.Text.Json.Nodes.JsonObject value)
            {
                throw new FormatException($"周波数「{key}」が読めません");
            }
            int Int(string name, int min, int max)
            {
                var number = value[name]?.GetValue<int>() ?? throw new FormatException($"{key} の {name} がありません");
                return number >= min && number <= max ? number : throw new FormatException($"{key} の {name} ({number}) が範囲の外です");
            }
            if (value["layers"] is not System.Text.Json.Nodes.JsonArray { Count: 3 } layers) throw new FormatException($"{key} の layers が 3 つではありません");
            var parsed = layers.Select(layer => layer is System.Text.Json.Nodes.JsonArray { Count: 4 } item
                ? (item[0]!.GetValue<int>(), item[1]!.GetValue<int>(), item[2]!.GetValue<int>(), item[3]!.GetValue<int>())
                : throw new FormatException($"{key} の階層が 4 つの数ではありません")).ToArray();
            if (parsed.Any(layer => layer.Item1 is < 0 or > 4 || layer.Item2 is < 0 or > 7 || layer.Item3 is < 0 or > 4 || layer.Item4 is < 0 or > 13))
            {
                throw new FormatException($"{key} の階層の値が範囲の外です");
            }
            memory.Channels[khz] = new Dib8096.Snapshot(
                Int("fft", 0, 3), Int("guard", -1, 3), Int("inversion", 0, 1), Int("partial", 0, 1), Int("diff", 0, 0x1FFF), parsed);
        }
        return memory;
    }
}
