using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// IT930x の機材 (PX-MLT5U・PX-MLT5PE・DTV02A-5TS-P) のブリッジを確かめるコマンド。**サーバを立てず、ブリッジを 1 回だけ起動して記録を出す。**
///
/// <code>
/// denpa-agent --it930x-probe
/// denpa-agent --it930x-probe --port 1-2 --trace
/// </code>
///
/// <para>
/// チップのバージョン、ストラップ、EEPROM の設定の写しを読み、ファームウェアを読み込んで起動し、そのバージョンを出す。
/// 読む順は SDK と同じで、EEPROM の写しはファームウェアを読み込む前に読む。**復調器とチューナーには触らない。**
/// 終わりに REBOOT して、挿した直後と同じ (ファームウェアが動いていない) 状態に戻す。REBOOT で USB がつなぎ直されたかも出す。終了コードは、うまくいけば 0、どこかで止まれば 1
/// </para>
/// </summary>
public static class It930xProbe
{
    public const string Usage = "denpa-agent --it930x-probe [--port <USB のポート>] [--trace]";

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

    internal sealed record Options(string? Port, bool Trace);

    /// <summary>引数を読む。<c>--port</c> に値が無ければ null (使い方を出して終わる)</summary>
    internal static Options? Parse(string[] args)
    {
        var at = Array.IndexOf(args, "--port");
        if (at < 0) return new Options(null, args.Contains("--trace"));
        var port = args.ElementAtOrDefault(at + 1);
        return port is null || port.StartsWith("--", StringComparison.Ordinal) ? null : new Options(port, args.Contains("--trace"));
    }

    public static int Run(string[] args)
    {
        if (Parse(args) is not { } options)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var found = It930x.Found(message => Console.Error.WriteLine(message));
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
        Console.Out.WriteLine($"{model.Name} (USB {model.Vendor:x4}:{model.Product:x4}、ポート {port})");
        return Execute(() => It930x.OpenUsb(port, model), () => It930xFirmware.Code, Console.Out, Thread.Sleep, trace);
    }

    /// <summary>
    /// 開いて、読んで、ファームウェアを起動する。REBOOT で USB がつなぎ直されたときは、機材が戻るのを待って 1 回だけ開き直す
    /// </summary>
    /// <param name="open">機材を開く。テストは偽の機材を返す</param>
    /// <param name="firmware">確かめたファームウェアを返す (<see cref="It930xFirmware.Code"/>)</param>
    internal static int Execute(Func<IUsbDevice> open, Func<byte[]> firmware, TextWriter output, Action<int> sleep, Action<string>? trace)
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

    /// <summary>機材が戻るのを、100 ms ごとに最大 5 秒待って開く (REBOOT で USB がつなぎ直されたとき)</summary>
    private static IUsbDevice Reopen(Func<IUsbDevice> open, Action<int> sleep)
    {
        for (var i = 0; ; i++)
        {
            sleep(100);
            try
            {
                return open();
            }
            catch (IOException) when (i < 49)
            {
            }
        }
    }
}
