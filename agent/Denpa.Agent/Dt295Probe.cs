using System.Diagnostics;
using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 を確かめる入口。**サーバを立てず、機材を 1 回だけ動かして統計だけを出す。** チューナーと同じ手順 (Dt295Board・Dt295Stream) を通る。
///
/// <code>
/// denpa-agent --dt295-probe --no-tune                      # 起動・認証・カードまで (アンテナが無くてよい)
/// denpa-agent --dt295-probe --terrestrial 27 --seconds 10  # 地上波 27ch
/// denpa-agent --dt295-probe --bs 1 --slot 0                # BS1 のスロット 0 (8.6)
/// denpa-agent --dt295-probe --cs 2 --port 1-2 --trace      # ポートを指す。機材への書き込みを 1 行ずつ出す
/// </code>
///
/// <para>
/// 段ごとの記録 (時間つき) は標準エラーに、統計は標準出力に出す。**TS はどこにも書かない。**
/// 受信に要るもの (Dt295Receive) が揃っていなければ、選局までで止めて理由を出す。
/// 終わるときは idle イメージを書き戻して未認証のアイドル (0x10) に戻す (5.7)。終了コードは、うまくいけば 0、どこかで止まれば 1。
/// </para>
/// </summary>
public static class Dt295Probe
{
    public const string Usage =
        "denpa-agent --dt295-probe [--port <USB のポート>] (--terrestrial <13-62> | --bs <1-23> | --cs <2-24> | --no-tune) [--slot <0-7>] [--seconds N] [--trace]";

    private sealed record Options(string? Port, char Kind, int Channel, int Slot, TimeSpan Seconds, bool Trace);

    private static Options? Parse(string[] args)
    {
        string? Value(string name)
        {
            var at = Array.IndexOf(args, name);
            return at >= 0 ? args.ElementAtOrDefault(at + 1) : null;
        }
        static int? Number(string? text) =>
            int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : null;

        var kinds = new List<(char Kind, int Channel)>();
        foreach (var (name, kind) in new[] { ("--terrestrial", 'T'), ("--bs", 'B'), ("--cs", 'C') })
        {
            if (!args.Contains(name)) continue;
            if (Number(Value(name)) is not { } channel) return null;
            kinds.Add((kind, channel));
        }
        if (args.Contains("--no-tune")) kinds.Add(('N', 0));
        if (kinds.Count != 1) return null;
        var slot = args.Contains("--slot") ? Number(Value("--slot")) : 0;
        var seconds = args.Contains("--seconds") ? Number(Value("--seconds")) : 5;
        if (slot is not (>= 0 and <= 7) || seconds is not > 0) return null;
        var (k, c) = kinds[0];
        try
        {
            // 範囲はここで確かめる (機材を開く前に断る)
            _ = k switch
            {
                'T' => Dt295Frontend.TerrestrialHz(c),
                'B' => Dt295Frontend.BsIfHz(c),
                'C' => Dt295Frontend.CsIfHz(c),
                _ => 0,
            };
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
        return new Options(Value("--port"), k, c, slot.Value, TimeSpan.FromSeconds(seconds.Value), args.Contains("--trace"));
    }

    public static int Run(string[] args)
    {
        if (Parse(args) is not { } options)
        {
            Console.Error.WriteLine($"usage: {Usage}");
            return 2;
        }
        var clock = Stopwatch.StartNew();
        var last = 0L;
        void Step(string message)
        {
            var now = clock.ElapsedMilliseconds;
            Console.Error.WriteLine($"[{now,6} ms +{now - last,5}] {message}");
            last = now;
        }

        var ports = Dt295.Ports(message => Console.Error.WriteLine(message));
        var port = options.Port ?? (ports.Count == 1 ? ports[0] : null);
        if (port is null)
        {
            Console.Error.WriteLine(ports.Count == 0
                ? $"{Dt295.Model} が見当たりません"
                : $"{Dt295.Model} が {ports.Count} 台あります。--port で指してください ({string.Join(", ", ports)})");
            return 1;
        }

        Dt295Board board;
        try
        {
            board = Dt295Board.Acquire(port, options.Trace ? line => Console.Error.WriteLine($"    {line}") : null);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or DllNotFoundException or EntryPointNotFoundException or PlatformNotSupportedException)
        {
            Console.Error.WriteLine($"{Dt295.Model} {port} を開けません: {error.Message}");
            return 1;
        }
        Step($"{Dt295.Model} {port} を開きました (起動・認証まで。カード状態 {(board.Card is { } card ? (int)card : -1)}{(board.CardProblem is { } problem ? $"。{problem}" : "")})");

        var stats = new Dt295TsStats();
        var failed = false;
        try
        {
            if (options.Kind != 'N')
            {
                board.Locked(() => Tune(options, board.Frontend, Step));
                Receive(options, board, stats, Step);
            }
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or InvalidDataException)
        {
            Step($"止めました: {error.Message}");
            failed = true;
        }
        finally
        {
            var bridge = board.Bridge;
            board.Dispose();
            Step($"閉じました (機材への書き込み {bridge.Writes} 回 / 読み {bridge.Reads} 回)");
        }

        if (options.Kind != 'N') stats.Print(Console.Out);
        return failed ? 1 : 0;
    }

    private static void Tune(Options options, Dt295Frontend tuner, Action<string> step)
    {
        switch (options.Kind)
        {
            case 'T':
                tuner.TuneTerrestrial(options.Channel);
                step($"地上波 {options.Channel}ch を選びました ({Dt295Frontend.TerrestrialHz(options.Channel)} Hz。ロックの判定は仕様書に無い)");
                break;
            default:
                var ifHz = options.Kind == 'B' ? Dt295Frontend.BsIfHz(options.Channel) : Dt295Frontend.CsIfHz(options.Channel);
                var name = $"{(options.Kind == 'B' ? "BS" : "CS")}{options.Channel}";
                var tsid = tuner.TuneSatellite(ifHz, options.Slot);
                var status = tuner.SatelliteStatus();
                step($"{name} のスロット {options.Slot} を選びました (IF {ifHz} Hz、TSID 0x{tsid:X4}、ロック {(status.Locked ? "あり" : "なし")}、AGC {status.Agc}、C/N の生の値 {status.CnRaw})");
                break;
        }
    }

    /// <summary>受信に要るものが揃っていれば、チューナーと同じ手順で決めた秒数だけ受けて数える (9 章)</summary>
    private static void Receive(Options options, Dt295Board board, Dt295TsStats stats, Action<string> step)
    {
        Dt295ReceiveData data;
        try
        {
            data = Dt295Receive.Ensure();
        }
        catch (IOException error)
        {
            step($"受信はしません: {error.Message}");
            return;
        }
        var routes = new Dt295RouteTracker(needCat: options.Kind == 'T');
        var stream = Dt295Stream.Start(board, data, routes, $"{Dt295.Model} {board.Port}", () => { }, Dt295Stream.Silence);
        step("受信を始めました (9.2〜9.7)");
        try
        {
            var buffer = new byte[188 * 1024];
            var reading = Stopwatch.StartNew();
            var first = true;
            while (reading.Elapsed < options.Seconds)
            {
                var task = stream.Output.ReadAsync(buffer).AsTask();
                if (!task.Wait(options.Seconds - reading.Elapsed)) break;
                var got = task.Result;
                if (got == 0) break;
                if (first)
                {
                    step($"最初のデータ ({got} バイト)");
                    first = false;
                }
                stats.Push(buffer.AsSpan(0, got));
            }
            stats.PatParsed = routes.PatSeen;
            stats.PmtPid = routes.FirstPmtPid;
            stats.PmtParsed = routes.FirstPmtPid is { } pmt && routes.PmtSeen(pmt);
            if (stream.Reason is { } reason) step($"受信が止まりました: {reason}");
            step($"準備し直した回数 {stream.Reprepared}");
        }
        finally
        {
            stream.Stop();
            step("受信を止めました (9.9)");
        }
    }
}

/// <summary>パケット 1 つ (188 バイトの写し) と、その PID</summary>
public readonly record struct Dt295Packet(ReadOnlyMemory<byte> Data, int Pid)
{
    public ReadOnlySpan<byte> Span => Data.Span;
}

/// <summary>
/// TS の統計。受け取ったバイト列を 188 バイトずつ切り、端数は次の先頭につなぐ (10.2。同期バイトは探し直さない)。
/// 同期バイトの割合・transport_scrambling_control ごとの数・PID ごとの数を数える。中身は持たない
/// </summary>
public sealed class Dt295TsStats
{
    public const int PacketSize = 188;

    private readonly byte[] _carry = new byte[PacketSize];
    private int _carried;

    public long Bytes { get; private set; }
    public long Packets { get; private set; }
    public long Synced { get; private set; }
    public long[] Scrambling { get; } = new long[4];
    public SortedDictionary<int, long> Pids { get; } = [];

    /// <summary>transport_scrambling_control = 01 (機器の AES) のパケットの、PID ごとの数</summary>
    public SortedDictionary<int, long> Encrypted { get; } = [];
    public bool PatParsed { get; set; }
    public bool PmtParsed { get; set; }
    public int? PmtPid { get; set; }

    /// <summary>受け取ったものを渡す。同期バイトが 0x47 のパケットだけを返す (PSI を読むため)</summary>
    public List<Dt295Packet> Push(ReadOnlySpan<byte> data)
    {
        Bytes += data.Length;
        var packets = new List<Dt295Packet>();
        if (_carried > 0)
        {
            var take = Math.Min(PacketSize - _carried, data.Length);
            data[..take].CopyTo(_carry.AsSpan(_carried));
            _carried += take;
            data = data[take..];
            if (_carried < PacketSize) return packets;
            Count(_carry, packets);
            _carried = 0;
        }
        while (data.Length >= PacketSize)
        {
            Count(data[..PacketSize], packets);
            data = data[PacketSize..];
        }
        data.CopyTo(_carry);
        _carried = data.Length;
        return packets;
    }

    private void Count(ReadOnlySpan<byte> packet, List<Dt295Packet> packets)
    {
        Packets++;
        if (packet[0] != 0x47) return;
        Synced++;
        Scrambling[packet[3] >> 6]++;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if (packet[3] >> 6 == 1) Encrypted[pid] = Encrypted.GetValueOrDefault(pid) + 1;
        Pids[pid] = Pids.GetValueOrDefault(pid) + 1;
        packets.Add(new Dt295Packet(packet.ToArray(), pid));
    }

    public void Print(TextWriter output)
    {
        output.WriteLine($"bytes: {Bytes}");
        output.WriteLine($"packets: {Packets} (188 バイトずつ)  sync 0x47: {Synced} ({(Packets == 0 ? 0 : 100.0 * Synced / Packets):F2}%)");
        output.WriteLine($"transport_scrambling_control: 00={Scrambling[0]} 01={Scrambling[1]} 10={Scrambling[2]} 11={Scrambling[3]}");
        output.WriteLine($"PID: {Pids.Count} 種類");
        foreach (var (pid, count) in Pids) output.WriteLine($"  0x{pid:X4}: {count}");
        output.WriteLine($"transport_scrambling_control = 01 の PID: {Encrypted.Count} 種類");
        foreach (var (pid, count) in Encrypted) output.WriteLine($"  0x{pid:X4}: {count}");
        output.WriteLine($"PAT: {(Pids.ContainsKey(0) ? "来た" : "来ない")}{(PatParsed ? " (読めた)" : "")}");
        output.WriteLine(PmtPid is { } pmt
            ? $"PMT (0x{pmt:X4}): {(Pids.ContainsKey(pmt) ? "来た" : "来ない")}{(PmtParsed ? " (読めた)" : "")}"
            : "PMT: PAT が読めないので分かりません");
    }
}
