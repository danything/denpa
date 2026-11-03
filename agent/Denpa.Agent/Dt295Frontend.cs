namespace Denpa.Agent;

/*
 * PIX-DT295 の選局 (仕様書 7・8 章)。復調器と RF チューナーは ASSP の I2C コマンド (3.10) で操作する。
 * 地上波の復調器は 0x20、衛星の復調器は 0x22。RF チューナーはどちらも復調器を中継して <c>0xFE</c> で始まる形で操作する (1.4)。
 * 復調器・チューナーの型番は仕様書に無い (1.4・14 章の 15) ので、ここでも名前を付けない。
 */

/// <summary>衛星のロックと信号の生の値 (8.5)。dB への換算式は仕様書に無い</summary>
public readonly record struct Dt295SatelliteStatus(bool Locked, int StreamId, int Agc, int CnRaw);

/// <summary>地上波・衛星の選局。1 つのスレッドから使う</summary>
public sealed class Dt295Frontend(IDt295Board board, Dt295Material material)
{
    public const byte TerrestrialDemod = 0x20;
    public const byte SatelliteDemod = 0x22;

    /// <summary>選局の前提の状態 (認証済みのアイドル。7.4)</summary>
    private const ushort Authenticated = 0x0011;

    /// <summary>衛星がロックしなかったときの文言</summary>
    public const string NoLock = "衛星がロックしません (3000 ms 待ちました。アンテナを確かめてください)";

    /// <summary>衛星を選んでいる (地上波へ戻すときに先に衛星をスリープさせる。8.7)</summary>
    public bool SatelliteActive { get; private set; }

    // ---------------------------------------------------------------------
    // 周波数 (7.1・8.1)
    // ---------------------------------------------------------------------

    /// <summary>地上波の中心周波数 [Hz] (7.1)。13〜62ch</summary>
    public static long TerrestrialHz(int channel)
    {
        if (channel is < 13 or > 62) throw new ArgumentOutOfRangeException(nameof(channel), $"地上波は 13〜62ch です ({channel})");
        return 473_142_857L + (channel - 13) * 6_000_000L;
    }

    /// <summary>RF チューナーの分周値 N = floor(f × 64 / 1,000,000) (7.1)</summary>
    public static int TerrestrialDivider(long hz)
    {
        if (hz is < 90_000_000 or > 770_000_000) throw new ArgumentOutOfRangeException(nameof(hz), $"地上波の周波数は 90〜770 MHz です ({hz} Hz)");
        return (int)(hz * 64 / 1_000_000);
    }

    /// <summary>BS の IF [Hz] (8.1)。奇数の 1〜23</summary>
    public static long BsIfHz(int channel)
    {
        if (channel is < 1 or > 23 || channel % 2 == 0) throw new ArgumentOutOfRangeException(nameof(channel), $"BS は奇数の 1〜23 です ({channel})");
        return 1_049_480_000L + (channel - 1) / 2 * 38_360_000L;
    }

    /// <summary>CS の IF [Hz] (8.1)。偶数の 2〜24</summary>
    public static long CsIfHz(int channel)
    {
        if (channel is < 2 or > 24 || channel % 2 != 0) throw new ArgumentOutOfRangeException(nameof(channel), $"CS は偶数の 2〜24 です ({channel})");
        return 1_613_000_000L + (channel - 2) / 2 * 40_000_000L;
    }

    /// <summary>衛星の RF チューナーに書く値 (8.4)。f は MHz に四捨五入した kHz、Bytes は SRF 0x00 からの 5 バイト、Band は SRF[0x09]</summary>
    public readonly record struct SatelliteIf(int Khz, byte[] Bytes, byte Band);

    /// <summary>帯域表 (8.4)。f がこの値 [kHz] 未満なら (band, mode)</summary>
    private static readonly (int Below, byte Band, byte Mode)[] Bands =
    [
        (975_000, 0x1C, 1),
        (1_050_000, 0x18, 2),
        (1_150_000, 0x14, 2),
        (1_250_000, 0x10, 3),
        (1_350_000, 0x0C, 4),
        (1_450_000, 0x0A, 4),
        (1_600_000, 0x07, 5),
        (1_800_000, 0x04, 2),
        (2_000_000, 0x02, 1),
        (2_151_000, 0x00, 0),
    ];

    /// <summary>IF の設定値 (8.4。整数演算)</summary>
    public static SatelliteIf SatelliteIfSettings(long ifHz)
    {
        if (ifHz is < 950_000_000 or > 2_150_000_000) throw new ArgumentOutOfRangeException(nameof(ifHz), $"衛星の IF は 950〜2150 MHz です ({ifHz} Hz)");
        var f = (int)((ifHz / 1000 + 500) / 1000 * 1000);
        var low = f <= 1_100_000;
        var div = low ? 4 : 2;
        var n = (div * f / 2 + 500) / 1000;
        byte[] bytes = [(byte)(n >> 7), (byte)(n * 2), 0x00, 0x00, low ? (byte)0x80 : (byte)0x00];
        var (_, band, mode) = Bands.First(entry => f < entry.Below);
        return new SatelliteIf(f, bytes, (byte)((mode << 5) | band));
    }

    // ---------------------------------------------------------------------
    // I2C の形 (7.2・8.2)
    // ---------------------------------------------------------------------

    private void Demod(byte reg, byte value) => board.I2c(TerrestrialDemod, [reg, value], []);

    private byte DemodRead(byte reg)
    {
        Span<byte> one = stackalloc byte[1];
        board.I2c(TerrestrialDemod, [reg], one);
        return one[0];
    }

    /// <summary>地上波 RF の書き込み。0xFF だけは値を送らない 3 バイトの形 (7.2)</summary>
    private void Rf(byte reg, byte value)
    {
        if (reg == 0xFF) board.I2c(TerrestrialDemod, [0xFE, 0xC0, 0xFF], []);
        else board.I2c(TerrestrialDemod, [0xFE, 0xC0, reg, value], []);
    }

    /// <summary>地上波 RF の読み出し: <c>[FE C0 FB reg]</c> を送ってから <c>[FE C1]</c> で 1 バイト (7.2)</summary>
    private byte RfRead(byte reg)
    {
        board.I2c(TerrestrialDemod, [0xFE, 0xC0, 0xFB, reg], []);
        Span<byte> one = stackalloc byte[1];
        board.I2c(TerrestrialDemod, [0xFE, 0xC1], one);
        return one[0];
    }

    /// <summary>RF[r] ← (旧 &amp; keep) | set</summary>
    private void RfModify(byte reg, byte keep, byte set) => Rf(reg, (byte)((RfRead(reg) & keep) | set));

    private void Sat(byte reg, byte value) => board.I2c(SatelliteDemod, [reg, value], []);

    private void SatRead(byte reg, Span<byte> data) => board.I2c(SatelliteDemod, [reg], data);

    private byte SatRead(byte reg)
    {
        Span<byte> one = stackalloc byte[1];
        SatRead(reg, one);
        return one[0];
    }

    private void Srf(byte reg, byte value) => board.I2c(SatelliteDemod, [0xFE, 0xC0, reg, value], []);

    /// <summary>衛星 RF の連続書き込み (最大 13 バイト。8.2)</summary>
    private void SrfMany(byte reg, ReadOnlySpan<byte> data)
    {
        if (data.Length > 13) throw new ArgumentException("衛星 RF の連続書き込みは 13 バイトまでです", nameof(data));
        Span<byte> write = stackalloc byte[3 + data.Length];
        write[0] = 0xFE;
        write[1] = 0xC0;
        write[2] = reg;
        data.CopyTo(write[3..]);
        board.I2c(SatelliteDemod, write, []);
    }

    private void SrfRead(Span<byte> data) => board.I2c(SatelliteDemod, [0xFE, 0xC1], data);

    private void Sleep(int ms) => board.Time.Sleep(ms);

    private void RequireAuthenticated()
    {
        var state = board.State();
        if (state != Authenticated) throw new Dt295Exception($"選局は状態 0x11 のときだけです (いまは 0x{state:X4})");
    }

    // ---------------------------------------------------------------------
    // 地上波 (7.3・7.4)
    // ---------------------------------------------------------------------

    /// <summary>チューナーの初期化 (7.3)。参照実装は地上波の選局のたびに最初からやり直す</summary>
    public void InitTerrestrial()
    {
        // 1〜3 リセットの GPIO
        board.Modify16(0x90014, 1, 1, 1);
        board.Modify16(0x90018, 1, 1, 0);
        Sleep(20);
        board.Modify16(0x90018, 1, 1, 1);
        Sleep(5);
        // 4〜6
        foreach (var (reg, value) in material.TerrestrialDemod) Demod(reg, value);
        Rf(0xFF, 0);
        foreach (var (reg, value) in material.TerrestrialRfA) Rf(reg, value);
        // 7〜16
        Rf(0x00, 1);
        RfModify(0x31, 0x2F, 0xD0);
        Rf(0x00, 0);
        Rf(0x01, 0x89);
        Rf(0x02, 0);
        Rf(0x6D, 0x0A);
        Rf(0x0B, 1);
        RfModify(0x04, 0xC0, 0x01);
        Rf(0x05, 0x1B);
        RfModify(0x08, 0xF2, 0x05);
        RfModify(0x09, 0x80, 0x42);
        RfModify(0x5E, 0xEF, 0);
        Rf(0x0A, 0);
        // 17・18
        foreach (var (reg, value) in material.TerrestrialRfB) Rf(reg, value);
        Rf(0x6D, 0x0A);
        Rf(0x03, 0);
        Rf(0x03, 1);
        Sleep(100);
        // 19〜22
        SetTerrestrialFrequency(473_142_857);
        Rf(0x0B, 1);
        Rf(0x12, 1);
        Sleep(20);
        Rf(0x12, 0);
        Rf(0x0B, 0);
        Demod(0x25, 0);
        Demod(0x23, 0x4D);
        Demod(0x03, 0x90);
    }

    /// <summary>周波数設定 (7.4 の上の表)</summary>
    private void SetTerrestrialFrequency(long hz)
    {
        var n = TerrestrialDivider(hz);
        var high = hz >= 700_000_000;
        RfModify(0x0D, 0xFE, 0);
        Rf(0x0F, 0x20);
        Rf(0x10, (byte)n);
        Rf(0x11, (byte)(n >> 8));
        Rf(0x00, 1);
        Rf(0x31, high ? (byte)0x91 : (byte)0x81);
        Rf(0x00, 0);
        Rf(0x7C, high ? (byte)0x9F : (byte)0x1F);
    }

    /// <summary>
    /// 地上波を選ぶ (7.3 の初期化 → 7.4 の選局)。衛星を選んでいたら先に衛星をスリープさせる (8.7)。
    /// ロックの判定は仕様書に無い (7.5)
    /// </summary>
    public void TuneTerrestrial(int channel) => TuneTerrestrialHz(TerrestrialHz(channel));

    /// <summary>周波数で地上波を選ぶ (CATV のパススルーもこちら。受け付けるのは 90〜770 MHz。7.1)</summary>
    public void TuneTerrestrialHz(long hz)
    {
        TerrestrialDivider(hz);
        RequireAuthenticated();
        if (SatelliteActive) SleepSatellite();
        InitTerrestrial();
        Rf(0x0B, 1);
        Rf(0x12, 1);
        Sleep(20);
        Demod(0x03, 0);
        Demod(0x1D, 0xAA);
        Demod(0x1E, 0xAA);
        Demod(0x1F, 0xAA);
        Demod(0x25, 0);
        Demod(0x23, 0x4D);
        SetTerrestrialFrequency(hz);
        Rf(0x12, 0);
        RfModify(0x6E, 0xFF, 0x80);
        RfModify(0x14, 0xDF, 0);
        Rf(0x12, 1);
        Sleep(20);
        RfModify(0x6E, 0x7F, 0);
        Demod(0x0E, (byte)((DemodRead(0x0E) & 0x70) | 0x01));
        Demod(0x0F, 0x10);
        Demod(0x01, 0x40);
        Demod(0x23, 0x4C);
        Sleep(100);
        Demod(0x1D, 0x02);
        Demod(0x1E, 0x2A);
        Demod(0x1F, 0x8A);
    }

    // ---------------------------------------------------------------------
    // 衛星 (8.2〜8.7)
    // ---------------------------------------------------------------------

    private void RfSleep()
    {
        Srf(0x2A, 0xB9);
        Srf(0x29, 0x70);
        Srf(0x28, 0x3E);
        Srf(0x2A, 0x19);
        Srf(0x1C, 0x00);
        SrfMany(0x11, [0xC0, 0xA7]);
    }

    private void RfWake()
    {
        SrfMany(0x11, [0x00, 0xA7]);
        Srf(0x2A, 0xB9);
        Srf(0x1C, 0xC0);
        Srf(0x29, 0x71);
    }

    private void Mute(bool on)
    {
        Sat(0x1C, on ? (byte)0xAA : (byte)0x08);
        Sat(0x1F, on ? (byte)0x2A : (byte)0x08);
    }

    /// <summary>衛星の初期化 (8.3)</summary>
    private void InitSatellite()
    {
        if (material.SatelliteMissing) throw new Dt295Exception("衛星復調器の初期化表 (S_DEMOD) がすべて 0 です。素材が欠けています");
        Sat(0x01, 0x90);
        foreach (var (reg, value) in material.SatelliteDemod) Sat(reg, value);
        Sleep(4);
        Srf(0x2A, 0xB9);
        SrfMany(0x06, [0x10, 0x10, 0x00]);
        Srf(0x0A, 0);
        Srf(0x0E, 0);
        RfSleep();
        Sleep(6);
    }

    /// <summary>地上波側のスリープ (8.3)</summary>
    private void SleepTerrestrial()
    {
        Demod(0x25, 0);
        Demod(0x23, 0x4D);
        Demod(0x03, 0x90);
        Rf(0x12, 0);
        Rf(0x0B, 0);
    }

    /// <summary>衛星のスリープ (8.7)</summary>
    public void SleepSatellite()
    {
        Sat(0x1E, 0x28);
        Sat(0x0A, 0);
        Sat(0x03, 1);
        Sat(0x17, 1);
        Sat(0x1E, (byte)((SatRead(0x1E) & 0xCF) | 0x30));
        RfSleep();
        SatelliteActive = false;
    }

    /// <summary>IF の設定 (8.4 の上半分)</summary>
    private void SetIf(long ifHz)
    {
        var settings = SatelliteIfSettings(ifHz);
        SrfMany(0x00, settings.Bytes);
        Srf(0x09, settings.Band);
        Srf(0x37, 0xAC);
        Srf(0x05, 0x80);
        Srf(0x2A, 0xBB);
        Sleep(10);
    }

    /// <summary>ロックと選ばれている TSID などを読む (8.5)</summary>
    public Dt295SatelliteStatus SatelliteStatus()
    {
        var locked = (SatRead(0xC3) & 0x10) == 0;
        Span<byte> two = stackalloc byte[2];
        SatRead(0xE6, two);
        var tsid = (two[0] << 8) | two[1];
        var agc = SatRead(0xBA) & 0x7F;
        SatRead(0xBC, two);
        return new Dt295SatelliteStatus(locked, tsid, agc, (two[0] << 8) | two[1]);
    }

    /// <summary>TSID の候補表 (8.6): S[0xCE] から 16 バイト、2 バイト BE ずつ 8 個。0 と 0xFFFF は空き</summary>
    public int[] StreamIdSlots()
    {
        Span<byte> table = stackalloc byte[16];
        SatRead(0xCE, table);
        var slots = new int[8];
        for (var i = 0; i < 8; i++) slots[i] = (table[i * 2] << 8) | table[i * 2 + 1];
        return slots;
    }

    private void SelectStreamId(int tsid)
    {
        Sat(0x8F, (byte)(tsid >> 8));
        Sat(0x90, (byte)tsid);
    }

    /// <summary>100 ms おきに最大 3000 ms、条件がそろうまで待つ (8.4 の手順 15・8.6)</summary>
    private bool WaitLock(Func<Dt295SatelliteStatus, bool> done)
    {
        var deadline = board.Time.NowMs + 3000;
        while (true)
        {
            if (done(SatelliteStatus())) return true;
            if (board.Time.NowMs >= deadline) return false;
            Sleep(100);
        }
    }

    /// <summary>
    /// 衛星を選ぶ (8.3 → 8.4)。<paramref name="tsid"/> があればその TSID を選び (8.4 の手順 5・14・15)、無ければスロット番号 (0〜7) で選ぶ (8.6)。選んだ TSID を返す。
    /// 順序は「地上波チューナーの初期化 → 衛星の初期化 → 地上波側のスリープ → 衛星の選局」
    /// </summary>
    public int TuneSatellite(long ifHz, int slot, int? tsid = null)
    {
        if (slot is < 0 or > 7) throw new ArgumentOutOfRangeException(nameof(slot), "スロットは 0〜7 です");
        SatelliteIfSettings(ifHz);
        RequireAuthenticated();
        InitTerrestrial();
        InitSatellite();
        SleepTerrestrial();
        SatelliteActive = true;
        // 1〜4
        Sat(0x1E, (byte)((SatRead(0x1E) & 0xCF) | 0x20));
        RfWake();
        Sat(0x17, 0);
        Sat(0x1E, 0x20);
        Sat(0x0A, 0xFF);
        Sat(0x03, 1);
        Mute(true);
        // 5 TSID を指定するときは、いったん TSID 0 を選ぶ
        if (tsid is not null) SelectStreamId(0);
        // 6〜8
        Sat(0x1E, 0x28);
        Sat(0x0A, 0);
        Sat(0x03, 1);
        SetIf(ifHz);
        board.I2c(TerrestrialDemod, [0x0E, 0x77], []);
        board.I2c(TerrestrialDemod, [0x0F, 0x77], []);
        // 9・10
        Sat(0x07, (byte)((SatRead(0x07) & 0x70) | 0x01));
        Sat(0x08, 0x10);
        Span<byte> two = stackalloc byte[2];
        SrfRead(two);
        Srf(0x50, (two[1] & 0x60) == 0x60 ? (byte)0xF1 : (byte)0xF0);
        Sleep(40);
        // 11〜13
        Sat(0x1E, 0x20);
        Sat(0x0A, 0xFF);
        Sat(0x03, 1);
        Sat(0x03, 1);
        Sleep(100);
        Mute(false);
        Sat(0xA5, (byte)(SatRead(0xA5) | 0x40));
        Sat(0xA3, (byte)((SatRead(0xA3) & 0x88) | 0x11));
        int wanted;
        if (tsid is { } given)
        {
            // 14・15 指定の TSID
            wanted = given;
        }
        else
        {
            // 8.6 スロットで選ぶ
            if (!WaitLock(status => status.Locked)) throw new Dt295Exception(NoLock);
            wanted = StreamIdSlots()[slot];
            if (wanted is 0 or 0xFFFF) throw new Dt295Exception($"スロット {slot} に TSID がありません");
        }
        SelectStreamId(wanted);
        if (!WaitLock(status => status.Locked && status.StreamId == wanted))
        {
            throw new Dt295Exception(SatelliteStatus().Locked ? $"TSID 0x{wanted:X4} に切り替わりません (3000 ms)" : NoLock);
        }
        return wanted;
    }
}
