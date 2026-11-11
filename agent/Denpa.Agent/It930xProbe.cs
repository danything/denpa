using System.Diagnostics;
using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// IT930x の機材 (<see cref="It930x.Family"/>) のブリッジを確かめるコマンド。**サーバを立てず、ブリッジを 1 回だけ起動して記録を出す。**
///
/// <code>
/// denpa-agent --it930x-probe
/// denpa-agent --it930x-probe --port 1-2 --trace
/// denpa-agent --it930x-probe --ts 10
/// denpa-agent --it930x-probe --port 1-2 --chips
/// </code>
///
/// <para>
/// 最初に、見つけた機材を USB の ID・ポート・シリアル番号と一緒に並べる (Q3 は、同じ筐体のもう片方の側のポートも出す。TC90522 の仕様書 12 の 1)。
/// そのあとチップのバージョン、ストラップ、EEPROM の設定の写しを読み、ファームウェアを読み込んで起動し、そのバージョンを出す。
/// 読む順は SDK と同じで、EEPROM の写しはファームウェアを読み込む前に読む。<c>--chips</c> を付けなければ、**復調器とチューナーには触らない。**
/// 終わりに REBOOT して、挿した直後と同じ (ファームウェアが動いていない) 状態に戻す。REBOOT で USB がつなぎ直されたかも出す。終了コードは、うまくいけば 0、どこかで止まれば 1
/// </para>
///
/// <para>
/// <c>--chips</c> を付けると、起動したあと受信機の電源を入れ、TC90522 の機種のチップを読んで見分ける (TC90522 の仕様書 12 の 2〜5)。
/// 復調器のアドレスが応答するか、中継の先の R850 の種類と水晶の駆動の強さ、RT710 か RT720 かを出し、終わったら電源を切る。
/// 選局はしない (<c>--tune it930x:…</c> で確かめる)
/// </para>
///
/// <para>
/// <c>--ts &lt;秒&gt;</c> を付けると、起動したあと TS の経路 (入力 0〜4 と EP 0x84) を設定し、入力を開けて EP 0x84 をその秒数だけ読み、
/// 入力ごとのパケットの数と捨てた数を出す。復調器を動かさないので、ふつうはどの数も 0 になる。設定がエラーにならないことと、読みが詰まらないことを確かめる
/// </para>
/// </summary>
public static class It930xProbe
{
    public const string Usage = "denpa-agent --it930x-probe [--port <USB のポート>] [--ts <秒>] [--chips] [--trace]";

    /// <summary><c>--ts</c> の上限 (秒)</summary>
    internal const int MaxTsSeconds = 600;

    /// <summary>EP 0x84 の 1 回の読みの待ち</summary>
    private const int TsReadTimeoutMs = 200;

    // 読むレジスタ (SDK の brRegister.h・brVariable.h)
    /// <summary><c>chip_version_7_0</c>。続く 2 バイトはチップの種類 (下位から。<c>DRV_getFirmwareVersionFromFile</c>)</summary>
    internal const uint ChipVersion = 0x1222;
    internal const uint PrechipVersion = 0x384F;
    /// <summary><c>r_br_io_mux_pwron_test_strap</c> (下位 3 ビット)</summary>
    internal const uint TestStrap = 0xD800;
    /// <summary><c>r_br_io_mux_pwron_mode_strap</c> (下位 3 ビット)</summary>
    internal const uint ModeStrap = 0xD801;
    /// <summary><c>r_br_mp2if_strap_usb20_mode</c> (bit 0)</summary>
    internal const uint Usb20Strap = 0xDA20;
    /// <summary><c>OVA_EEPROM_CFG_VALID</c>。0 なら EEPROM の設定を読めていない (<c>DRV_GetEEPROMConfig</c>)</summary>
    internal const uint EepromValid = 0x4979;
    /// <summary><c>OVA_EEPROM_CFG</c>。EEPROM の設定の写し (256 バイト)</summary>
    internal const uint EepromCopy = 0x4994;
    internal const int EepromLength = 256;

    /// <param name="Ts">TS の経路を確かめるときに EP 0x84 を読む長さ (<c>--ts</c>)。null なら確かめない</param>
    /// <param name="Chips">受信機の電源を入れて、TC90522 の機種のチップを読んで見分ける (<c>--chips</c>)</param>
    internal sealed record Options(string? Port, bool Trace, TimeSpan? Ts, bool Chips = false);

    /// <summary>引数を読む。<c>--port</c> に値が無い・<c>--ts</c> が 1〜<see cref="MaxTsSeconds"/> の整数でなければ null (使い方を出して終わる)</summary>
    internal static Options? Parse(string[] args)
    {
        string? port = null;
        var at = Array.IndexOf(args, "--port");
        if (at >= 0)
        {
            port = args.ElementAtOrDefault(at + 1);
            if (port is null || port.StartsWith("--", StringComparison.Ordinal)) return null;
        }
        TimeSpan? ts = null;
        at = Array.IndexOf(args, "--ts");
        if (at >= 0)
        {
            if (!int.TryParse(args.ElementAtOrDefault(at + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
                || seconds is < 1 or > MaxTsSeconds)
            {
                return null;
            }
            ts = TimeSpan.FromSeconds(seconds);
        }
        return new Options(port, args.Contains("--trace"), ts, args.Contains("--chips"));
    }

    /// <summary>
    /// 見つけた機材を 1 行ずつ出す (TC90522 の仕様書 12 の 1)。USB の ID・ポート・シリアル番号と、Q3 は側と、同じ筐体のもう片方の側のポート
    /// </summary>
    internal static void List(IReadOnlyList<(string Port, It930xModel Model)> found, Func<string, string?> serial, TextWriter output)
    {
        foreach (var (port, model) in found)
        {
            var number = serial(port);
            var line = $"{model.Name} (USB {model.Vendor:x4}:{model.Product:x4}、ポート {port}、受信機 {model.Receivers.Count} つ、シリアル番号 {number ?? "読めません"})";
            if (model.Paired)
            {
                line += It930x.Side(number) is { } side
                    ? $"  側 {side.Side}、もう片方の側 {It930x.Partner(port, model, found, serial) ?? "見つかりません"}"
                    : "  シリアル番号が 15 桁の数字で末尾が 1 か 2 の形でないので、もう片方の側と組にできません";
            }
            output.WriteLine(line);
        }
    }

    public static int Run(string[] args)
    {
        if (Parse(args) is not { } options)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var found = It930x.Found(message => Console.Error.WriteLine(message));
        List(found, It930x.Serial, Console.Out);
        var candidates = options.Port is { } wanted ? found.Where(item => item.Port == wanted).ToList() : found;
        if (candidates.Count != 1)
        {
            Console.Error.WriteLine(candidates.Count == 0
                ? options.Port is null ? $"{It930x.Model} が見当たりません" : $"USB のポート {options.Port} に {It930x.Model} が見当たりません"
                : $"{It930x.Model} が {candidates.Count} 台あります。--port で指してください ({string.Join(", ", candidates.Select(item => item.Port))})");
            return 1;
        }
        var (port, model) = candidates[0];
        // --trace: コマンドを 1 行ずつ、標準エラー出力に出す (送ったフレーム・応答・時間)
        Action<string>? trace = options.Trace ? message => Console.Error.WriteLine($"  {message}") : null;
        Console.Out.WriteLine($"--- {model.Name} (USB {model.Vendor:x4}:{model.Product:x4}、ポート {port})");
        return Execute(() => It930x.OpenUsb(port, model), () => It930xFirmware.Code, Console.Out, Thread.Sleep, trace, options.Ts, options.Chips ? model : null);
    }

    /// <summary>
    /// 開いて、読んで、ファームウェアを起動する。REBOOT で USB がつなぎ直されたときは、機材が戻るのを待って 1 回だけ開き直す
    /// </summary>
    /// <param name="open">機材を開く。テストは偽の機材を返す</param>
    /// <param name="firmware">確かめたファームウェアを返す (<see cref="It930xFirmware.Code"/>)</param>
    /// <param name="ts">TS の経路を確かめるときに EP 0x84 を読む長さ (<c>--ts</c>)。null なら確かめない</param>
    /// <param name="chips">受信機の電源を入れてチップを読む機種 (<c>--chips</c>)。null なら読まない</param>
    internal static int Execute(
        Func<IUsbDevice> open, Func<byte[]> firmware, TextWriter output, Action<int> sleep, Action<string>? trace, TimeSpan? ts = null, It930xModel? chips = null)
    {
        byte[] code;
        try
        {
            code = firmware();
        }
        catch (Exception error) when (error is IOException or InvalidDataException)
        {
            output.WriteLine($"ファームウェアを用意できません: {error.Message}");
            return 1;
        }
        var clock = Stopwatch.StartNew();
        IUsbDevice? usb = null;
        try
        {
            usb = open();
            output.WriteLine($"開きました: {usb.Name} ({clock.ElapsedMilliseconds} ms)");
            var bridge = new It930xBridge(usb, sleep, trace);
            Describe(bridge, output);
            var commands = 0;
            It930xBoot boot;
            var started = clock.ElapsedMilliseconds;
            try
            {
                boot = bridge.Start(code);
            }
            catch (UsbGoneException) when (bridge.RebootSent)
            {
                commands += bridge.Commands;
                usb.Dispose();
                usb = null;
                output.WriteLine("REBOOT のあと USB がつなぎ直されました。機材が戻るのを待って開き直します");
                usb = Reopen(open, sleep);
                bridge = new It930xBridge(usb, sleep, trace);
                started = clock.ElapsedMilliseconds;
                boot = bridge.Start(code);
            }
            var before = boot.Before == 0 ? "動いていない" : It930xBoot.Format(boot.Before);
            output.WriteLine($"ファームウェア: 開いたとき {before}{(boot.Rebooted ? " (REBOOT した)" : "")}、"
                + $"{It930xFirmware.Segments.Count} 区切りを読み込んで起動し {It930xBoot.Format(boot.Version)} (0x{boot.Version:X8})、{clock.ElapsedMilliseconds - started} ms");
            if (ts is { } length) CheckTs(bridge, usb, length, output);
            if (chips is not null) CheckChips(bridge, chips, output, sleep);
            // 終わりに REBOOT して、挿した直後と同じ (ファームウェアが動いていない) 状態に戻す。USB がつなぎ直されるかも、ここで分かる
            started = clock.ElapsedMilliseconds;
            try
            {
                bridge.Reboot();
                output.WriteLine($"REBOOT: バージョンが 0 に戻りました。USB はつなぎ直されませんでした ({clock.ElapsedMilliseconds - started} ms)");
            }
            catch (UsbGoneException)
            {
                output.WriteLine($"REBOOT: USB がつなぎ直されました ({clock.ElapsedMilliseconds - started} ms)");
            }
            commands += bridge.Commands;
            output.WriteLine($"コマンド: {commands} 回、全体 {clock.ElapsedMilliseconds} ms");
            return 0;
        }
        catch (Exception error) when (error is IOException or PlatformNotSupportedException)
        {
            output.WriteLine($"止まりました: {UsbDevices.Reason(error)} ({clock.ElapsedMilliseconds} ms)");
            return 1;
        }
        finally
        {
            usb?.Dispose();
        }
    }

    /// <summary>チップのバージョン・ストラップ・EEPROM の写し。読むだけ (SDK がファームウェアを読み込む前に読むものと同じ)</summary>
    private static void Describe(It930xBridge bridge, TextWriter output)
    {
        var chip = bridge.ReadRegisters(ChipVersion, 3);
        output.WriteLine($"チップ: chip_version 0x{chip[0]:X2}、種類 0x{(chip[2] << 8) | chip[1]:X4}、prechip_version 0x{bridge.ReadRegister(PrechipVersion):X2}");
        output.WriteLine($"ストラップ: test 0x{bridge.ReadRegister(TestStrap) & 0x07:X} (0x{TestStrap:X4})、mode 0x{bridge.ReadRegister(ModeStrap) & 0x07:X} (0x{ModeStrap:X4})、"
            + $"USB 2.0 {bridge.ReadRegister(Usb20Strap) & 0x01} (0x{Usb20Strap:X4})");
        output.WriteLine($"EEPROM の設定: 有効の印 0x{bridge.ReadRegister(EepromValid):X2} (0x{EepromValid:X4})。写し (0x{EepromCopy:X4} から {EepromLength} バイト)");
        var copy = bridge.ReadRegisters(EepromCopy, EepromLength);
        for (var at = 0; at < copy.Length; at += 16)
        {
            output.WriteLine($"  +{at:X2}: {Convert.ToHexString(copy.AsSpan(at, 16))}");
        }
    }

    /// <summary>
    /// TS の経路を設定し、入力 0〜4 を開けて EP 0x84 を <paramref name="length"/> だけ読み、入力ごとのパケットの数と捨てた数を出す。
    /// 終わったら入力を全部閉じて EP 0x84 をリセットし、ブリッジの TS の経路の状態を出す。入力の形はどれもシリアルにする (It930xDevice と同じ。PX-MLT5PE はこの形で TS を受けられた)
    /// </summary>
    private static void CheckTs(It930xBridge bridge, IUsbDevice usb, TimeSpan length, TextWriter output)
    {
        var clock = Stopwatch.StartNew();
        var commands = bridge.Commands;
        var (before, after) = bridge.ConfigureTs(new bool[It930xBridge.TsInputs]);
        output.WriteLine($"TS の経路: 設定しました ({bridge.Commands - commands} コマンド、{clock.ElapsedMilliseconds} ms)。"
            + $"ブリッジに残っていたバッファ {before}{(before.Empty ? "" : $"、捨てたあと {after}")}");
        var demux = new It930xTsDemux(It930xBridge.SyncBytes);
        var buffer = new byte[It930xBridge.TsTransferSize];
        long bytes = 0;
        var reads = 0;
        var started = clock.Elapsed;
        using (var input = usb.OpenInStream(It930xBridge.TsIn, It930xBridge.TsTransferSize, It930xBridge.TsDepth))
        {
            try
            {
                bridge.EnableTsInputs();
                started = clock.Elapsed;
                while (clock.Elapsed - started < length)
                {
                    var got = input.Read(buffer, TsReadTimeoutMs);
                    if (got == 0) continue;
                    reads++;
                    bytes += got;
                    demux.Push(buffer.AsSpan(0, got));
                }
            }
            finally
            {
                // 読みを止める前に、入力を全部閉じて EP 0x84 をリセットする (SDK の DRV_ResetRxPort。It930xDevice が閉じるときと同じ)
                try
                {
                    bridge.DisableTsInputs();
                }
                catch (It930xException error)
                {
                    output.WriteLine($"入力を閉じられませんでした: {error.Message}");
                }
            }
        }
        output.WriteLine(bridge.ReadTsStatus().Describe());
        var seconds = (clock.Elapsed - started).TotalSeconds;
        output.WriteLine($"TS: EP 0x{It930xBridge.TsIn:X2} を {seconds:F1} 秒読み、{reads} 回で {bytes} バイト ({bytes * 8 / Math.Max(seconds, 0.001) / 1e6:F2} Mbps)");
        output.WriteLine("入力ごとのパケット: " + string.Join("、", Enumerable.Range(0, It930xBridge.TsInputs)
            .Select(port => $"{port} (0x{It930xBridge.SyncBytes[port]:X2}) {demux.Packets[port]}")));
        output.WriteLine($"捨てた: 揃っていない間に飛ばした {demux.Skipped} バイト、知らない同期バイトのパケット {demux.Unknown} 個、揃いが外れた {demux.Lost} 回");
        output.WriteLine($"ブリッジに残っているバッファ: {bridge.ReadPsb()}");
    }

    /// <summary>
    /// 受信機の電源を入れて、TC90522 の機種のチップを読んで見分ける (TC90522 の仕様書 12 の 2〜5)。終わったら電源を切る。
    /// 読めなかったチップは理由を出して次へ進む (どこまで通ったかを 1 回で見るため)。USB が抜けたときだけ止まる
    /// </summary>
    internal static void CheckChips(It930xBridge bridge, It930xModel model, TextWriter output, Action<int> sleep)
    {
        if (model.Demod == It930xDemod.Cxd2856)
        {
            output.WriteLine("チップ: CXD2856ER の機種は --chips で読むものがありません (--tune it930x:<ポート>:<受信機> で確かめます)");
            return;
        }
        var valid = bridge.ConfigureReceivers(model.Receivers);
        output.WriteLine($"次の段の I2C: 設定しました。ファームウェアを読み込んだあとの EEPROM の有効の印 0x{valid:X2} (0x{EepromValid:X4}。0 なら設定を読めていない)");
        // 開いたときの GPIO と、電源を入れる手順 (IT930x の仕様書 7.2・7.3。It930xDevice と同じ)
        bridge.GpioSetup(model.PowerPin, true);
        bridge.GpioSetup(2, false);
        if (model.Lnb) bridge.GpioSetup(11, false);
        sleep(20);
        bridge.Gpio(model.PowerPin, false);
        sleep(model.PowerWaitMs);
        bridge.Gpio(2, true);
        sleep(20);
        output.WriteLine($"電源: 入れました (GPIOH{model.PowerPin} ← 0、{model.PowerWaitMs} ms、GPIOH2 ← 1、20 ms)");
        try
        {
            foreach (var receiver in model.Receivers)
            {
                var bus = new It930xI2cBus(bridge, receiver.I2cBus);
                var link = new Tc90522Link(bus, receiver.DemodAddress);
                var label = $"受信機 {receiver.Index} (バス {receiver.I2cBus})";
                if (receiver.Demod == It930xDemod.Tc90522S)
                {
                    Answer(output, $"{label} 衛星 0x{link.Address:X2}", () => $"C3 = 0x{link.Read(0xC3, 1)[0]:X2}");
                    CheckRt710(output, label, new Rt710(link.Tuner(Rt710.Address), sleep));
                    continue;
                }
                Answer(output, $"{label} 地上波 0x{link.Address:X2}", () => $"80 = 0x{link.Read(0x80, 1)[0]:X2}、B0 = 0x{link.Read(0xB0, 1)[0]:X2}");
                CheckR850(output, label, new R850(link.Tuner(R850.Address), receiver.Loopthrough, sleep));
                if (receiver.Demod != It930xDemod.Tc90522Switch) continue;
                var satellite = new Tc90522Link(bus, receiver.SatelliteAddress);
                Answer(output, $"{label} 衛星 0x{satellite.Address:X2}", () => $"C3 = 0x{satellite.Read(0xC3, 1)[0]:X2}");
                if (receiver.Tuner == It930xTunerChip.R850Rt710) CheckRt710(output, label, new Rt710(satellite.Tuner(Rt710.Address), sleep));
            }
        }
        finally
        {
            try
            {
                bridge.Gpio(2, false);
                bridge.Gpio(model.PowerPin, true);
                output.WriteLine("電源: 切りました");
            }
            catch (IOException error)
            {
                output.WriteLine($"電源: 切れませんでした ({UsbDevices.Reason(error)})");
            }
        }
    }

    /// <summary>復調器のアドレスが応答するか (TC90522 の仕様書 12 の 3)。読めた値か、読めなかった理由を出す</summary>
    private static void Answer(TextWriter output, string label, Func<string> read)
    {
        try
        {
            output.WriteLine($"{label}: 応答あり ({read()})");
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            output.WriteLine($"{label}: 応答なし ({error.Message})");
        }
    }

    /// <summary>
    /// 中継の先の R850 を初期化の手順で読む (TC90522 の仕様書 6.3、12 の 4・5)。種類・水晶の駆動の強さと、読んだ <c>08</c>〜<c>2F</c>、書き戻したあとに読み直した値を出す
    /// </summary>
    private static void CheckR850(TextWriter output, string label, R850 tuner)
    {
        try
        {
            tuner.Init();
            var saved = tuner.Saved!;
            var after = tuner.ReadAll()[R850.FirstWritable..];
            output.WriteLine($"{label} R850: 00 = 0x{tuner.Id:X2} (ビットの並びを直した値) → 種類 {tuner.Kind}、水晶の駆動の強さ {tuner.XtalDrive}");
            output.WriteLine($"  電源を入れたあとの 08〜2F: {Convert.ToHexString(saved)}");
            output.WriteLine($"  書き戻したあとの 08〜2F:   {Convert.ToHexString(after)} ({(saved.AsSpan().SequenceEqual(after) ? "同じ" : "違う")})");
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            output.WriteLine($"{label} R850: 読めません ({error.Message})");
        }
    }

    /// <summary>中継の先の RT710 の種類を読む (TC90522 の仕様書 7.2、12 の 4)</summary>
    private static void CheckRt710(TextWriter output, string label, Rt710 tuner)
    {
        try
        {
            tuner.Init();
            output.WriteLine($"{label} RT710: 03 = 0x{tuner.Id:X2} (ビットの並びを直した値) → {tuner.Name}");
        }
        catch (IOException error) when (error is not UsbGoneException)
        {
            output.WriteLine($"{label} RT710: 読めません ({error.Message})");
        }
    }

    /// <summary>
    /// 機材が戻るのを待って開く (REBOOT で USB がつなぎ直されたとき)。外れきる前の機材を開かないよう、先に 500 ms 待ってから、100 ms ごとに最大 10 秒。
    /// PX-Q3PE4 は、つなぎ直しが続く 2 回の開き直しより長くかかった (2026-11-11 の実機の記録。5 秒では足りないと推定する)
    /// </summary>
    internal static IUsbDevice Reopen(Func<IUsbDevice> open, Action<int> sleep)
    {
        sleep(500);
        for (var i = 0; ; i++)
        {
            sleep(100);
            try
            {
                return open();
            }
            catch (IOException) when (i < 99)
            {
            }
        }
    }

    public const string CycleUsage = "denpa-agent --it930x-cycle <USB のポート> <回数> [--no-wait]";

    /// <summary><c>--it930x-cycle</c> の回数の上限</summary>
    internal const int MaxCycles = 100;

    /// <summary>
    /// <c>--it930x-cycle &lt;USB のポート&gt; &lt;回数&gt; [--no-wait]</c>: 機材を開いて電源を入れ、すぐ電源を切って閉じるのを、続けて決めた回数だけ繰り返す。
    /// 常駐のエージェントは最後の利用者が返しても 30 秒は閉じないが (<see cref="It930xDevice.IdleGrace"/>)、ここでは待たずに閉じる。
    /// 本番で続けて 13 回入り切りしたあと、全受信機の TS が電源を抜くまで止まったので、その入り切りを再現するための入口。
    /// <c>--no-wait</c> を付けると、電源を切ったあとの 100 ms (IT930x の仕様書 7.2) も待たない (待ちを入れる前の動き)。受信機の初期化と選局はしない。
    /// 終えたあと TS が出るかは、続けて <c>--tune</c> で確かめる
    /// </summary>
    public static int Cycle(string[] args)
    {
        var port = args.ElementAtOrDefault(1);
        if (port is null || port.StartsWith("--", StringComparison.Ordinal)
            || !int.TryParse(args.ElementAtOrDefault(2), NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count is < 1 or > MaxCycles)
        {
            Console.Error.WriteLine($"usage: {CycleUsage} (回数は 1〜{MaxCycles})");
            return 2;
        }
        var noWait = args.Contains("--no-wait");
        Console.WriteLine($"{port} を {count} 回、開いて電源を入れ、すぐ電源を切って閉じます ({(noWait ? "電源を切ったあとは待たない" : $"電源を切ったあと {It930xDevice.PowerOffSettleMs} ms 待つ")})");
        try
        {
            for (var round = 1; round <= count; round++)
            {
                var started = Stopwatch.StartNew();
                var device = It930xDevice.Acquire(port);
                var opened = started.ElapsedMilliseconds;
                if (noWait) device.PowerOffWaitMs = 0;
                device.Release();
                It930xDevice.CloseIfIdle(port, TimeSpan.Zero);
                Console.WriteLine($"{round} 回目: 開いて電源を入れるまで {opened} ms (うちファームウェアから電源まで {device.OpenMs} ms)、電源を切って閉じるまで {started.ElapsedMilliseconds - opened} ms");
            }
            return 0;
        }
        catch (IOException error)
        {
            Console.Error.WriteLine($"{port}: {UsbDevices.Reason(error)}");
            return 1;
        }
        finally
        {
            It930xDevice.CloseAll();
        }
    }
}
