using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// 自前方式 (dt295:) のフロントエンド (復調とチューナー) の設定と選局。節の番号は仕様書 (dt295-resident/spec.md) のもの。
/// 常駐方式では常駐イメージが SERVICE のたびに 1 本ずつ進める I2C を、ホストが I2C の転送で順に出す (Dt295NativeI2c)。
///
/// I2C の機器は 2 つ。0x10 = 地上波の復調 (T 復調)、0x11 = 衛星の復調 (S 復調)。チューナーは復調のレジスタ 0xFE を通した中継の先 (仕様書 7.0)。
/// チップの型番とレジスタの意味は仕様書にも無い (11.1)。表の値は仕様書のとおり。
///
/// 仕様書に無くて決めた所:
/// - 仕様書の手順は、常駐イメージの時刻 (ms) で書かれている。ホストの I2C は 1 転送が数 ms かかるので、時刻には合わせず、
///   仕様書が「待つ」と書いた所 (100 ms・20 ms・4 ms・6 ms・10 ms・約 40 ms) だけ待ち、あとは順に出す
/// - 受信の確認は 1 周ごとに 10 ms 空ける (常駐イメージは 1500 回 × 10 ms で 15 秒回しても失敗にしなかった。仕様書 7.2.4)
/// </summary>
public sealed class Dt295NativeFrontend(Dt295NativeI2c i2c, Action<int> sleep, Dt295Timeline? timeline = null)
{
    /// <summary>決めた時間だけ待つ。待ちは <see cref="Dt295Timeline"/> の表に出る</summary>
    /// <summary>
    /// 実験用。名前 (init-t100 など) を指した待ちの時間を差し替える (--dt295-probe の --wait 名前=ms)。試験で短くできると確かめた待ちだけ、
    /// 本体の値を直して、この仕組みは外す。差し替えが無ければ仕様書の値
    /// </summary>
    internal static readonly Dictionary<string, int> WaitOverrides = [];

    private static int Overridden(string key, int ms) => WaitOverrides.TryGetValue(key, out var value) ? value : ms;

    private void Wait(string key, int ms, string reason)
    {
        Flush();
        var actual = Overridden(key, ms);
        timeline.Wait(sleep, actual, actual == ms ? reason : $"{reason}。実験で {ms} ms を {actual} ms に替えた");
    }

    public const int Terrestrial = 0x10, Satellite = 0x11;

    /// <summary>
    /// 受信の確認の周の間の待ち (ms)。仕様書の周期ではなく、ホストが決めた値 (仕様書 7.2.4 の常駐イメージは 10 ms 周期、衛星 7.3.4 は約 7 ms)。
    /// 1 周の読みは 1 回 約 2 ms (I2C の転送 2 回) かかるので、周期は 6 ms ほどになる
    /// </summary>
    public const int TerrestrialPollMs = 4, SatellitePollMs = 3;

    /// <summary>衛星の LNB の局発 (kHz)。TUNE の受信周波数 = IF + これ (仕様書 7.3.1)。選局には IF を使う</summary>
    public const uint SatelliteLocalKhz = 10678000;

    // 書き込みと、読んだ値を使わない読み・変更・書きは、ためておいて Flush で I2C の順次実行にまとめて渡す (Dt295I2cBatch)。
    // 読んだ値をこちらで使う読み (DemodRead) は、ためた分と一緒に実行してその値を返す。待ち (Wait) と段の切れ目の前にも実行する
    private readonly Dt295I2cBatch _batch = new();

    private void Demod(int dev, int reg, params int[] data) => _batch.Write(dev, [(byte)reg, .. data.Select(value => (byte)value)]);

    private void Tuner(int dev, int reg, params int[] data) => _batch.Write(dev, [0xFE, 0xC0, (byte)reg, .. data.Select(value => (byte)value)]);

    /// <summary>ためた転送を実行する。読んだバイトを転送の順につなげて返す</summary>
    private byte[] Flush()
    {
        if (_batch.IsEmpty) return [];
        try
        {
            return i2c.Run(_batch);
        }
        finally
        {
            _batch.Clear();
        }
    }

    private byte[] DemodRead(int dev, int reg, int count)
    {
        _batch.Write(dev, (byte)reg);
        _batch.Read(dev, count);
        return Flush()[^count..];
    }

    /// <summary>チューナーのレジスタの読み・変更・書き: 新しい値 = (旧 &amp; 残す) | 立てる (仕様書 7.0 のフラグ 0x80)。読みは機材の中で書きに使う</summary>
    private void TunerRmw(int dev, int reg, int keep, int set)
    {
        _batch.Write(dev, 0xFE, 0xC0, 0xFB, (byte)reg);
        _batch.Write(dev, 0xFE, 0xC1);
        _batch.Read(dev, 1);
        _batch.WriteModified(dev, [0xFE, 0xC0, (byte)reg], (byte)keep, (byte)set);
    }

    /// <summary>復調のレジスタの読み・変更・書き (仕様書 7.0 のフラグ 0x01)</summary>
    private void DemodRmw(int dev, int reg, int keep, int set)
    {
        _batch.Write(dev, (byte)reg);
        _batch.Read(dev, 1);
        _batch.WriteModified(dev, [(byte)reg], (byte)keep, (byte)set);
    }

    /// <summary>ためた転送を実行してから、段を切り替える</summary>
    private void Next(Dt295Timeline.Phases phases, string name, string? reason = null)
    {
        Flush();
        phases.Next(name, reason);
    }

    /// <summary>
    /// 復調のレジスタの (番号, 値) の並びを書く。番号が 1 ずつ続くものは 1 転送にまとめる (復調は書いた番号から自動で進む。
    /// 仕様書 7.3.4 の段 2 が 0x8F・0x90 を 1 転送で書く)。仕様書の表は 1 レジスタ 1 転送だが、書く順と値は同じ
    /// </summary>
    private void DemodPairs(int dev, params int[] pairs)
    {
        for (var i = 0; i < pairs.Length;)
        {
            var values = new List<int> { pairs[i + 1] };
            var j = i + 2;
            while (j < pairs.Length && pairs[j] == pairs[j - 2] + 1 && values.Count < 16)
            {
                values.Add(pairs[j + 1]);
                j += 2;
            }
            Demod(dev, pairs[i], [.. values]);
            i = j;
        }
    }

    private void Pairs(Action<int, int> write, params int[] pairs)
    {
        for (var i = 0; i < pairs.Length; i += 2) write(pairs[i], pairs[i + 1]);
    }

    // ---------------------------------------------------------------------
    // 7.1 INITIALIZE の I2C
    // ---------------------------------------------------------------------

    /// <summary>仕様書 7.1.1 から 7.1.5 までを順に</summary>
    public void Initialize()
    {
        using var phases = new Dt295Timeline.Phases(timeline);
        // 7.1.1 T 復調の初期値 (表の順に 1 レジスタ 1 転送)
        Next(phases, "T 復調の初期値", "7.1.1。1 レジスタ 1 転送");
        DemodPairs(Terrestrial,
            0x01, 0x00, 0x03, 0x90, 0x06, 0x80, 0x1C, 0x20, 0x1D, 0x56, 0x1E, 0x6A, 0x1F, 0x9A, 0x23, 0x4D,
            0x25, 0x00, 0x26, 0x00, 0x32, 0x21, 0x3B, 0x21, 0x3C, 0x3F, 0x70, 0x18, 0x73, 0x45, 0x74, 0x11,
            0x75, 0x02, 0x76, 0x00, 0x77, 0x01, 0x7D, 0xD2, 0xE4, 0xF4, 0xF4, 0x80);

        // 7.1.2 T チューナーの初期化
        Next(phases, "T チューナーの初期化", "7.1.2");
        void T(int reg, params int[] data) => Tuner(Terrestrial, reg, data);
        T(0xFF);                              // リセット指示と推定 (仕様書)
        T(0x00, 0x01);
        T(0x96, 0x00);
        T(0x00, 0x00);
        Pairs((reg, value) => T(reg, value),
            0x14, 0x13, 0x6D, 0x8A, 0x6D, 0x0A, 0xDF, 0x19, 0x45, 0x1B, 0xA9, 0x59, 0xAA, 0x6A, 0xBE, 0x4C, 0xCF, 0x2A, 0xD2, 0xF5,
            0xD0, 0x34, 0x77, 0xE7, 0x78, 0xE3, 0x6F, 0x51, 0x7B, 0x84, 0x7C, 0x9F, 0x56, 0x41, 0xCD, 0x64, 0xC3, 0x2C, 0x9D, 0x61,
            0xF7, 0x52, 0x58, 0x81, 0xB1, 0x30);
        T(0x00, 0x01);
        TunerRmw(Terrestrial, 0x31, 0x2F, 0xD0);
        T(0x00, 0x00);
        T(0x01, 0x89);
        T(0x02, 0x00);
        T(0x6D, 0x0A);
        T(0x0B, 0x01);
        TunerRmw(Terrestrial, 0x04, 0xC0, 0x01);
        T(0x05, 0x1B);
        TunerRmw(Terrestrial, 0x08, 0xF2, 0x05);
        TunerRmw(Terrestrial, 0x09, 0x80, 0x42);
        TunerRmw(Terrestrial, 0x5E, 0xEF, 0x00);
        Pairs((reg, value) => T(reg, value),
            0x0A, 0x00, 0x0C, 0x00, 0x13, 0x04, 0x53, 0xFE, 0x57, 0x91, 0x5A, 0xF9, 0x5B, 0x18, 0x5C, 0xF1, 0x62, 0xC2, 0x6E, 0x01,
            0x6F, 0x51, 0x87, 0x77, 0x88, 0x55, 0x93, 0x22, 0x97, 0x02, 0xBA, 0x30, 0x98, 0xAF, 0x9B, 0x20, 0x9C, 0x1E, 0xA0, 0x18,
            0xA5, 0x09, 0xC2, 0xA9, 0xC5, 0x7C, 0xCD, 0xE8, 0xCE, 0x7F, 0xD5, 0x03, 0xD9, 0x04, 0xEA, 0x0D, 0xDC, 0x1C, 0x6D, 0x0A);
        T(0x03, 0x00);
        T(0x03, 0x01);
        // 03=01 のあとの 100 ms は、T チューナーだけの待ち。別の I2C アドレス (0x11) の S 側の初期化 (7.1.3〜7.1.4) はこの間に行う。
        // 仕様書の時刻順とは違うが、S 側は T 側のレジスタに触らない (仕様書に無い判断)
        WaitDoing("init-t100", 100, "仕様書 7.1.2。03=01 のあと。この間に S 側 7.1.3〜7.1.4 を行う", InitializeSatellite);
        TunerRmw(Terrestrial, 0x0D, 0xFE, 0x00);
        T(0x0F, 0x20);
        T(0x10, 0x49);
        T(0x11, 0x76);                        // 473.143 MHz 相当 (0x7649。仕様書 7.2.3 の式)
        T(0x00, 0x01);
        T(0x31, 0x81);
        T(0x00, 0x00);
        T(0x7C, 0x1F);
        T(0x0B, 0x01);
        T(0x12, 0x01);
        Wait("init-t20", 20, "仕様書 7.1.2。12=01 のあと");
        T(0x12, 0x00);
        T(0x0B, 0x00);

        // 7.1.5 締め
        Next(phases, "締め", "7.1.5");
        Demod(Terrestrial, 0x47, 0x00);
        Demod(Terrestrial, 0x4F, 0x05);
        Demod(Terrestrial, 0x72, 0x00);
        Flush();
    }

    /// <summary>S 側の初期化 (仕様書 7.1.3・7.1.4)。T チューナーの待ちの間に行う</summary>
    private void InitializeSatellite()
    {
        using var phases = new Dt295Timeline.Phases(timeline);
        // 7.1.3 S 復調の初期値
        Next(phases, "S 復調の初期値", "7.1.3");
        DemodPairs(Satellite,
            0x01, 0x90, 0x03, 0x00, 0x04, 0x02, 0x07, 0x33, 0x08, 0x11, 0x10, 0xB0, 0x11, 0x00, 0x13, 0x80, 0x15, 0x00, 0x17, 0x01,
            0x1C, 0x59, 0x1D, 0xAA, 0x1E, 0x20, 0x1F, 0x19, 0x85, 0x7A, 0x87, 0x04, 0x8E, 0x26, 0xA3, 0x91, 0xA5, 0x40);
        Wait("init-s4", 4, "仕様書 7.1.3 の終わり");

        // 7.1.4 S チューナーの初期化
        Next(phases, "S チューナーの初期化", "7.1.4");
        void S(int reg, params int[] data) => Tuner(Satellite, reg, data);
        S(0x2A, 0xB9);
        S(0x06, 0x10, 0x10, 0x00);
        S(0x0A, 0x00);
        S(0x0E, 0x00);
        S(0x2A, 0xB9);
        S(0x29, 0x70);
        S(0x28, 0x3E);
        S(0x2A, 0x19);
        S(0x1C, 0x00);
        S(0x11, 0xC0, 0xA7);
        Wait("init-s6", 6, "仕様書 7.1.4 の終わり");
    }

    /// <summary>
    /// <paramref name="ms"/> の待ちの間に <paramref name="work"/> を行い、残りの時間だけ待つ (仕事が長引いて足りていれば待たない)。
    /// 待ちの間にバスを使う相手が、待っている機器と別のアドレスのときだけ使う
    /// </summary>
    private void WaitDoing(string key, int ms, string reason, Action work)
    {
        ms = Overridden(key, ms);
        using var scope = timeline?.Begin($"待ち {ms} ms (この間に別の仕事)", reason, wait: true);
        var clock = Stopwatch.StartNew();
        work();
        Flush();
        var rest = ms - (int)clock.ElapsedMilliseconds;
        scope?.Note($"仕事 {clock.ElapsedMilliseconds} ms、残りの待ち {Math.Max(0, rest)} ms");
        if (rest > 0) sleep(rest);
    }
    private enum Last
    {
        None,
        Terrestrial,
        Satellite,
    }

    /// <summary>
    /// 最後に選局した側。選局の頭の手順が、前の選局で決まる (仕様書 7.2.2: 0B=01 は前に地上波を選んでいないときだけ。衛星を選んでいたあとは先に S 側を休ませる。
    /// 7.3.2: 衛星の頭の T 側を休ませる表は、T が動いているときだけ要る)。選局が途中で失敗したら <see cref="Last.None"/> に戻して、次は全部入れる
    /// </summary>
    private Last _last = Last.None;

    /// <summary>S 側を休ませる (仕様書 7.2.2 の「衛星を選んでいたあとは、先に S 側を休ませる表 0x803ADB98」。推定)</summary>
    private void RestSatellite()
    {
        Demod(Satellite, 0x1C, 0xAA);
        Demod(Satellite, 0x1F, 0x2A);
        Demod(Satellite, 0x1E, 0x28);
        Demod(Satellite, 0x0A, 0x00);
        Demod(Satellite, 0x03, 0x01);
        Demod(Satellite, 0x17, 0x01);
        Tuner(Satellite, 0x2A, 0xB9);
        Tuner(Satellite, 0x29, 0x70);
        Tuner(Satellite, 0x28, 0x3E);
        Tuner(Satellite, 0x2A, 0x19);
        Tuner(Satellite, 0x1C, 0x00);
        Tuner(Satellite, 0x11, 0xC0, 0xA7);
        Flush();
    }

    /// <summary>T 側を休ませる (仕様書 7.3.2 の t=1、9 章の SHUTDOWN)</summary>
    public void RestTerrestrial()
    {
        Demod(Terrestrial, 0x25, 0x00);
        Demod(Terrestrial, 0x23, 0x4D);
        Demod(Terrestrial, 0x03, 0x90);
        Tuner(Terrestrial, 0x12, 0x00);
        Tuner(Terrestrial, 0x0B, 0x00);
        Flush();
    }

    // ---------------------------------------------------------------------
    // 7.2 地上波の選局
    // ---------------------------------------------------------------------

    /// <summary>
    /// 地上波の周波数 (kHz) からチューナーの周波数レジスタ N = floor(f × 64 / 1000) (仕様書 7.2.3。1/64 MHz 単位)。
    /// reg 0x10 = N の下位、reg 0x11 = N の上位
    /// </summary>
    public static int TerrestrialDivider(uint kHz) => (int)(kHz * 64UL / 1000);

    /// <summary>
    /// 地上波の選局 (仕様書 7.2.2)。範囲はチューナー関数の 90000〜770000 kHz (仕様書 7.2.1)。常駐イメージが受け付ける周波数の集合
    /// (111143〜707143 kHz の 6000 kHz 刻み) は、判定のコードが見つかっていない「未確認」なので、ここでは範囲だけで断る
    /// </summary>
    public void TuneTerrestrial(uint kHz)
    {
        if (kHz is < 90000 or > 770000) throw new Dt295NativeException($"地上波の周波数 {kHz} kHz は 90000〜770000 kHz の外です");
        var divider = TerrestrialDivider(kHz);
        var high = kHz > 699999;               // 帯の切り替えは 1 か所だけ (仕様書 7.2.3)
        void T(int reg, params int[] data) => Tuner(Terrestrial, reg, data);
        using var phases = new Dt295Timeline.Phases(timeline);
        var before = _last;
        _last = Last.None;
        // 衛星を選んでいたあとは、先に S 側を休ませる (仕様書 7.2.2。推定)
        if (before == Last.Satellite)
        {
            Next(phases, "S 側を休ませる", "7.2.2。衛星を選んでいたあと");
            RestSatellite();
        }
        // t=1〜2: 0B=01 は前に地上波を選んでいないときだけ先頭に入る (仕様書 7.2.2)
        Next(phases, "t=1〜2 チューナーを動かす", "7.2.2");
        if (before != Last.Terrestrial) T(0x0B, 0x01);
        T(0x12, 0x01);
        Wait("tune-t20a", 20, "仕様書 7.2.2。t=2 から t=22");
        // t=22
        Next(phases, "t=22 復調の準備", "7.2.2");
        Demod(Terrestrial, 0x03, 0x00);
        Demod(Terrestrial, 0x1D, 0xAA);
        Demod(Terrestrial, 0x1E, 0xAA);
        Demod(Terrestrial, 0x1F, 0xAA);
        Demod(Terrestrial, 0x25, 0x00);
        Demod(Terrestrial, 0x23, 0x4D);
        TunerRmw(Terrestrial, 0x0D, 0xFE, 0x00);
        T(0x0F, 0x20);
        // t=23
        Next(phases, "t=23 周波数の設定", "7.2.2。7.2.3 の式");
        T(0x10, divider & 0xFF);
        T(0x11, divider >> 8);
        T(0x00, 0x01);
        T(0x31, high ? 0x91 : 0x81);
        T(0x00, 0x00);
        T(0x7C, high ? 0x9F : 0x1F);
        T(0x12, 0x00);
        TunerRmw(Terrestrial, 0x6E, 0xFF, 0x80);
        // t=24
        Next(phases, "t=24〜25", "7.2.2");
        TunerRmw(Terrestrial, 0x14, 0xDF, 0x00);
        // t=25
        T(0x12, 0x01);
        Wait("tune-t20b", 20, "仕様書 7.2.2。t=25 から t=45");
        // t=45。TS の出し元は T 復調 (仕様書 8.1.5)
        Next(phases, "t=45 TS の出し元を T 復調に", "7.2.2。8.1.5");
        TunerRmw(Terrestrial, 0x6E, 0x7F, 0x00);
        DemodRmw(Terrestrial, 0x0E, 0x70, 0x01);
        Demod(Terrestrial, 0x0F, 0x10);
        Demod(Terrestrial, 0x4F, 0x05);
        Demod(Terrestrial, 0x01, 0x40);
        // t=46
        Next(phases, "t=46", "7.2.2");
        Demod(Terrestrial, 0x23, 0x4C);
        Wait("tune-t100", 100, "仕様書 7.2.2。t=46 から t=146");
        // t=146
        Next(phases, "t=146 復調の仕上げ", "7.2.2");
        Demod(Terrestrial, 0x1D, 0x02);
        Demod(Terrestrial, 0x1E, 0x2A);
        Demod(Terrestrial, 0x1F, 0x8A);
        Flush();
        _last = Last.Terrestrial;
    }

    /// <summary>
    /// 地上波の受信の確認 (仕様書 7.2.4)。<paramref name="layers"/> は要求する階層 (A = 0x80、B = 0x40、C = 0x20)。受かったら true。
    /// 常駐イメージは 1 回の SERVICE で 1 段ずつ進めるが、ここは 1 周で段 0 から 2 まで続けて読む
    /// </summary>
    public bool WaitTerrestrialLock(TimeSpan timeout, int layers = 0xE0)
    {
        var clock = Stopwatch.StartNew();
        // 周回の数と、周の間の待ちの合計を表に出す
        using var scope = timeline.Step("受信の確認 (地上波)", "7.2.4");
        var polls = 0;
        var waited = 0;
        void Report() => scope?.Note($"{polls} 周、周の間の待ち {waited} ms (1 回 {TerrestrialPollMs} ms)");
        while (true)
        {
            polls++;
            // ロックの印 (0x80 の bit4) が立っていなければ、段 1 も段 2 も成り立たないので、0x96 は読まない (1 周の転送が半分になる)
            var v80 = DemodRead(Terrestrial, 0x80, 2);
            if ((v80[1] & 0x10) != 0)
            {
                var v96 = DemodRead(Terrestrial, 0x96, 1)[0];
                if ((v96 & layers) == layers)
                {
                    Report();
                    return true;
                }
                if ((v80[0] & 0x20) == 0 && (v96 & layers) != 0)
                {
                    // 段 2: TMCC の階層ごとのセグメント数から、実在する階層だけで確かめる
                    var tmcc = DemodRead(Terrestrial, 0xB2, 8);
                    var present = PresentLayers(tmcc);
                    if (present != 0 && (present & layers) != 0 && (v96 & present & layers) == (present & layers))
                    {
                        Report();
                        return true;
                    }
                }
            }
            if (clock.Elapsed > timeout)
            {
                Report();
                return false;
            }
            sleep(TerrestrialPollMs);
            waited += TerrestrialPollMs;
        }
    }

    /// <summary>
    /// TMCC (0xB2 から 8 バイト) から実在する階層のビット (A = 0x80、B = 0x40、C = 0x20) を作る (仕様書 7.2.4 の段 2)。
    /// A = (B4 &gt;&gt; 3) &amp; 0xF、B = ((B5 &lt;&lt; 2) &amp; 0xC) | (B6 &gt;&gt; 6)、C = (B7 &gt;&gt; 1) &amp; 0xF。0xF は階層なし、1〜13 は使う階層で、合計が 13 でなければ無効 (0)
    /// </summary>
    public static int PresentLayers(ReadOnlySpan<byte> tmcc)
    {
        var a = (tmcc[2] >> 3) & 0xF;
        var b = ((tmcc[3] << 2) & 0xC) | (tmcc[4] >> 6);
        var c = (tmcc[5] >> 1) & 0xF;
        var present = 0;
        var total = 0;
        foreach (var (segments, bit) in new[] { (a, 0x80), (b, 0x40), (c, 0x20) })
        {
            if (segments == 0xF) continue;
            if (segments is < 1 or > 13) return 0;
            total += segments;
            present |= bit;
        }
        return total == 13 ? present : 0;
    }

    // ---------------------------------------------------------------------
    // 7.3 衛星の選局
    // ---------------------------------------------------------------------

    /// <summary>衛星チューナーの周波数 (kHz の IF) からレジスタ 00〜04 と 09 (仕様書 7.3.3)</summary>
    public static (byte[] Registers, byte Band) SatelliteDivider(uint ifKhz)
    {
        var m = (int)((ifKhz + 500) / 1000);
        var n = m <= 1100 ? 2 * m : m;
        var reg04 = m <= 1100 ? 0x80 : 0x00;
        var band = m switch
        {
            <= 974 => 0x3C,
            <= 1049 => 0x58,
            <= 1150 => 0x54,
            <= 1250 => 0x70,
            <= 1349 => 0x8C,
            <= 1449 => 0x8A,
            <= 1599 => 0xA7,
            <= 1799 => 0xC4,
            <= 1999 => 0xC2,
            _ => 0xE0,
        };
        return ([(byte)(n >> 7), (byte)((n << 1) & 0xFF), 0x00, 0x00, (byte)reg04], (byte)band);
    }

    /// <summary>衛星の選局 (仕様書 7.3.2)。IF は 950000〜2150000 kHz (仕様書 7.3.1)</summary>
    public void TuneSatellite(uint ifKhz)
    {
        if (ifKhz is < 950000 or > 2150000) throw new Dt295NativeException($"衛星の IF {ifKhz} kHz は 950000〜2150000 kHz の外です");
        var (registers, band) = SatelliteDivider(ifKhz);
        void S(int reg, params int[] data) => Tuner(Satellite, reg, data);
        using var phases = new Dt295Timeline.Phases(timeline);
        var before = _last;
        _last = Last.None;
        // t=1: T 側を休ませる (衛星を選んでいたあとは、T はもう休んでいる)
        Next(phases, "t=1 T 側を休ませる", "7.3.2");
        if (before != Last.Satellite) RestTerrestrial();
        DemodRmw(Satellite, 0x1E, 0xCF, 0x20);
        S(0x11, 0x00, 0xA7);
        S(0x2A, 0xB9);
        // t=2
        Next(phases, "t=2〜3 復調の準備", "7.3.2");
        S(0x1C, 0xC0);
        S(0x29, 0x71);
        Demod(Satellite, 0x17, 0x00);
        Demod(Satellite, 0x1E, 0x20);
        Demod(Satellite, 0x0A, 0xFF);
        Demod(Satellite, 0x03, 0x01);
        Demod(Satellite, 0x1C, 0xAA);
        Demod(Satellite, 0x1F, 0x2A);
        // t=3。TSID の初期値 0x40F1 は TSID 指定の有無によらない
        Demod(Satellite, 0x8F, 0x40);
        Demod(Satellite, 0x90, 0xF1);
        Demod(Satellite, 0x1E, 0x28);
        Demod(Satellite, 0x0A, 0x00);
        Demod(Satellite, 0x03, 0x01);
        S(0x11, 0x00, 0xA7);
        S(0x2A, 0xB9);
        S(0x1C, 0xC0);
        // t=4: 周波数 (reg 00〜04 を 1 転送)、VCO 帯 (reg 09)
        Next(phases, "t=4〜5 周波数と VCO 帯", "7.3.2。7.3.3");
        S(0x29, 0x71);
        _batch.Write(Satellite, [0xFE, 0xC0, 0x00, .. registers]);
        S(0x09, band);
        S(0x37, 0xAC);
        S(0x05, 0x80);
        // t=5
        S(0x2A, 0xBB);
        Wait("tune-s10", 10, "仕様書 7.3.2。t=5 から t=15");
        // t=15。T 復調の 0E/0F = 77 は TS の出し元を衛星にする (仕様書 8.1.5)
        Next(phases, "t=15〜16 TS の出し元を衛星に", "7.3.2。8.1.5");
        Demod(Satellite, 0x1E, 0x20);
        Demod(Satellite, 0x0A, 0xFF);
        Demod(Satellite, 0x03, 0x01);
        Demod(Satellite, 0x03, 0x01);
        Demod(Terrestrial, 0x0E, 0x77);
        Demod(Terrestrial, 0x0F, 0x77);
        DemodRmw(Satellite, 0x07, 0x70, 0x01);
        Demod(Satellite, 0x08, 0x10);
        // t=16: チューナーから 2 バイト読み、reg 0x50 = 0xF0 | (読んだ値の bit0)。
        // どちらのバイトの bit0 かは仕様書に無い (「bit の出どころは推定」)。先頭のバイトの bit0 にする
        _batch.Write(Satellite, 0xFE, 0xC1);
        _batch.Read(Satellite, 2);
        _batch.WriteModified(Satellite, [0xFE, 0xC0, 0x50], 0x01, 0xF0);
        Wait("tune-s40", 40, "仕様書 7.3.2。t=16 から t=56");
        // t=56
        Next(phases, "t=56", "7.3.2");
        Demod(Satellite, 0x1E, 0x20);
        Demod(Satellite, 0x0A, 0xFF);
        Demod(Satellite, 0x03, 0x01);
        Demod(Satellite, 0x03, 0x01);
        Wait("tune-s100", 100, "仕様書 7.3.2。t=56 から t=157");
        // t=157
        Next(phases, "t=157 復調の仕上げ", "7.3.2");
        Demod(Satellite, 0x1C, 0x08);
        Demod(Satellite, 0x1F, 0x08);
        DemodRmw(Satellite, 0xA5, 0xFF, 0x40);
        DemodRmw(Satellite, 0xA3, 0x88, 0x11);
        Flush();
        _last = Last.Satellite;
    }

    /// <summary>
    /// 衛星の受信の確認と TSID の選択 (仕様書 7.3.4)。<paramref name="tsid"/> が null なら表の最初の TSID を選ぶ。
    /// 指定した TSID が表に無ければ <see cref="Dt295NativeException"/> (常駐イメージも選局を失敗にする)。受からなければ false
    /// </summary>
    public bool WaitSatelliteLock(TimeSpan timeout, int? tsid)
    {
        var clock = Stopwatch.StartNew();
        using var scope = timeline.Step("受信の確認と TSID の選択 (衛星)", "7.3.4");
        var polls = 0;
        var waited = 0;
        void Report() => scope?.Note($"{polls} 周、周の間の待ち {waited} ms (1 回 {SatellitePollMs} ms。段 3 の待ちは {SatellitePollMs} ms)");
        while (clock.Elapsed <= timeout)
        {
            polls++;
            // 段 0: 0xC3 の上位 4 ビットが 0 なら同期
            if (DemodRead(Satellite, 0xC3, 1)[0] <= 0x0F && Select(tsid) is { } selected)
            {
                // 段 3: 0xC5 の bit1
                while (clock.Elapsed <= timeout && (DemodRead(Satellite, 0xC5, 1)[0] & 0x02) == 0)
                {
                    sleep(SatellitePollMs);
                    waited += SatellitePollMs;
                }
                // 段 4: 0xE6 の TSID が選んだものと同じなら受かった
                var now = DemodRead(Satellite, 0xE6, 2);
                if (((now[0] << 8) | now[1]) == selected)
                {
                    Report();
                    return true;
                }
            }
            sleep(SatellitePollMs);
            waited += SatellitePollMs;                         // 常駐イメージは約 7 ms 周期で C3 → C5 → E6 をくり返した (仕様書 7.3.4)
        }
        Report();
        return false;
    }

    /// <summary>
    /// 受信の状態と、復調の C/N の生の値。**dB には直していない。**
    /// 仕様書に C/N のレジスタは無い。復調は TC90522 系と推定されている (仕様書 11.1) ので、その系統で C/N を持つレジスタを読む
    /// (地上波は 0x8B から 3 バイト、衛星は 0xBC から 2 バイト。実機で確かめるまで、候補)。値の向き (大きいほど良いか悪いか) も未確認で、
    /// dB への換算式は仕様書に無いので付けない。受信の状態は <see cref="WaitTerrestrialLock"/>・<see cref="WaitSatelliteLock"/> の段と同じレジスタ
    /// (地上波は 0x80 の bit4、衛星は 0xC3 の上位 4 ビットが 0)。読むだけで、書かない
    /// </summary>
    public Dt295Signal Signal(bool satellite)
    {
        if (satellite)
        {
            var locked = DemodRead(Satellite, 0xC3, 1)[0] <= 0x0F;
            var cn = DemodRead(Satellite, 0xBC, 2);
            return new Dt295Signal(satellite, locked, (uint)((cn[0] << 8) | cn[1]), 2);
        }
        var status = DemodRead(Terrestrial, 0x80, 2);
        var raw = DemodRead(Terrestrial, 0x8B, 3);
        return new Dt295Signal(satellite, (status[1] & 0x10) != 0, (uint)((raw[0] << 16) | (raw[1] << 8) | raw[2]), 3);
    }

    /// <summary>
    /// 復調のレジスタ 0x00〜0xFF の読み値 (診断用。読むだけ)。C/N のレジスタの候補が違っていたとき、アンテナの信号を変えながら 2 回取って、
    /// 動くレジスタを探すのに使う
    /// </summary>
    public byte[] DumpDemod(bool satellite)
    {
        var dump = new byte[256];
        for (var at = 0; at < 256; at += 32) DemodRead(satellite ? Satellite : Terrestrial, at, 32).CopyTo(dump, at);
        return dump;
    }

    /// <summary>段 1・2: TMCC の TSID 表 (0xCE から 16 バイト) から選び、S 復調 0x8F〜0x90 に書く。表が全部 0 なら null</summary>
    private int? Select(int? wanted)
    {
        var table = DemodRead(Satellite, 0xCE, 16);
        var entries = Enumerable.Range(0, 8).Select(i => (table[2 * i] << 8) | table[2 * i + 1]).ToArray();
        if (entries.All(entry => entry == 0)) return null;
        // 「表の最初の TSID」: 空き (0xFFFF) でない最初の項目とする。仕様書は空きの扱いを書いていない
        var selected = wanted is { } want
            ? entries.Contains(want) ? want : throw new Dt295NativeException($"TSID {want} が TMCC の表にありません ({string.Join(", ", entries.Where(e => e != 0xFFFF).Select(e => e.ToString()))})")
            : entries.FirstOrDefault(entry => entry != 0xFFFF, -1);
        if (selected < 0) return null;
        // 指定なしのときは 00 00 を書く (仕様書 7.3.4 の段 2)
        var value = wanted is null ? 0 : selected;
        Demod(Satellite, 0x8F, value >> 8, value & 0xFF);
        return selected;
    }
}

/// <summary>復調の受信の状態と C/N の生の値 (<see cref="Dt295NativeFrontend.Signal"/>)。<paramref name="CnRaw"/> は dB に直していない</summary>
public sealed record Dt295Signal(bool Satellite, bool Locked, uint CnRaw, int CnBytes);
