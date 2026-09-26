using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// <a href="https://github.com/Khronos31/siano-userland">siano-userland</a> に任せる機材
/// (PLEX PX-S1UD などの Siano RIO 系。地上波だけ)。
///
/// <para>
/// **カーネルが掴んでいる機材には触らない。** PX-S1UD は mainline の <c>smsusb</c> +
/// <c>smsdvb</c> で普通に Linux DVB になり、今までどおりそちらで使える (DvbTuner)。
/// siano-userland はそれと別の道で、ホストに firmware やモジュールが無くても
/// <c>/dev/bus/usb</c> が見えれば動く。ただし <c>siano-ts</c> は
/// <c>libusb_set_auto_detach_kernel_driver</c> を立てていて、**smsusb が掴んでいても
/// 黙って奪っていた。** 作者自身が「動いている smsusb から切り替えるのは安全と判定していない」
/// (unbind の境目でカーネルの異常を観測) と書いていて、0.1.8 からは siano-ts 自身が
/// **カーネルのドライバが掴んでいるデバイスを断る** (終了コード 4)。こちらも自動検出では
/// どのドライバにも繋がっていない機材だけを並べる (掴まれている S1UD は /dev/dvb の側で見つかる)。
/// 使いたい人は smsusb / smsdvb / smsmdtv を blacklist して再起動する (docs/agent.md)。
/// </para>
///
/// <para>
/// **機材はポートで指す** (<c>siano-ts --device 1-2.3</c>、0.1.8 から)。番号 (<c>--device N</c>) は
/// libusb が並べた順で、カーネルが掴んでいる S1UD も入って番号がずれるので使わない。
/// </para>
///
/// <para>
/// 設定の <c>device</c> は <c>siano:&lt;USB のポート&gt;</c> (<c>siano:1-2.3</c>)。
/// S1UD にはシリアルが無いので、挿したポートで見分ける。
/// 刺さっていれば <see cref="Detect"/> が見つけて組み立てるので、普通は書かなくてよい。
/// </para>
/// </summary>
public static class SianoUserland
{
    /// <summary>設定の <c>device</c> の頭。これで始まっていれば siano-userland で掴む</summary>
    public const string Scheme = "siano:";

    /// <summary>
    /// 刺さっている1台。<c>Types</c> は受けられる方式 (siano-ts --list の受信機の行)、
    /// <c>Driver</c> はどれかのインターフェースを掴んでいるドライバ (無ければ null)
    /// </summary>
    public sealed record Stick(string Port, string Model, string[] Types, string? Driver);

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("SIANO_USERLAND_DIR") ?? "/opt/siano-userland";

    /// <summary>USB デバイスが並ぶ sysfs。カーネルが掴んでいるかをここで見る (<see cref="Driver"/>)</summary>
    private const string Sysfs = "/sys/bus/usb/devices";

    /// <summary>ISDB-T のファームウェア。**同梱してある** (配布アーカイブに入っている。Dockerfile)</summary>
    public static string Firmware =>
        Environment.GetEnvironmentVariable("SIANO_FIRMWARE") ?? Path.Combine(Dir, "firmware", "isdbt_rio.inp");

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>siano:1-2.3</c> からポートを取る。形が違えば null</summary>
    public static string? Parse(string device)
    {
        if (!Is(device)) return null;
        var port = device[Scheme.Length..];
        return IsPort(port) ? port : null;
    }

    /// <summary>sysfs の USB デバイスの名前 (<c>1-2</c>、<c>1-2.3.1</c>)。インターフェース (<c>1-2:1.0</c>) やルートハブは違う</summary>
    private static bool IsPort(string name)
    {
        var dash = name.IndexOf('-');
        if (dash <= 0 || dash == name.Length - 1) return false;
        return name[..dash].All(char.IsAsciiDigit)
            && name[(dash + 1)..].Split('.').All(part => part.Length > 0 && part.All(char.IsAsciiDigit));
    }

    /// <summary>画面に出す名前</summary>
    public static string Name(string model, string port) => $"{model} {port}";

    /// <summary>
    /// 刺さっている機材。**カーネルが掴んでいるものも挙げる** (<c>Driver</c> で分かる)。
    ///
    /// <para>
    /// 機材は <c>siano-ts --list</c> に聞く (siano-userland 0.1.7 から)。USB ID の表は持たず、
    /// ポートと受けられる方式も siano-ts が libusb で見たものを使う。デバイスを開かないので、
    /// 別の siano-ts が掴んでいても聞ける。
    /// </para>
    ///
    /// <para>
    /// **カーネルが掴んでいるかだけは sysfs で見る** (インターフェースの <c>driver</c> のリンク)。
    /// <c>--list</c> はそこを教えてくれず、並べると同じ機材が DVB と siano の2本になる。
    /// 選局のときは siano-ts 自身が断るので (0.1.8。終了コード 4)、ここは並べ方のためだけ。
    /// </para>
    /// </summary>
    public static List<Stick> Sticks()
    {
        var program = Path.Combine(Dir, "siano-ts");
        if (!File.Exists(program)) return [];
        var (code, output) = Shell.Run(program, ["--list"], TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();
        if (code != 0)
        {
            Log.Write($"siano-userland の機材を挙げられません (siano-ts --list exit {code}: {output})");
            return [];
        }
        return ParseList(output, port => Driver(Sysfs, port), Log.Write);
    }

    /// <summary>
    /// <c>siano-ts --list</c> の出力を読む。**使えるのは <c>status=ready</c> の機材だけ。**
    ///
    /// <para>
    /// <c>model=… usb=… bus=… address=… port=… status=ready receivers=N</c> の行のあとに、
    /// <c>px4ctl list</c> と同じ形の受信機の行が N 行続く (px4d --list に揃えてある)。
    /// 対応外の機材は <c>rejected …</c> の行で来るので、理由を <paramref name="warn"/> で残す。
    /// ポートが分からない (<c>port=-</c>) 機材は見分けられないので使わない。
    /// </para>
    /// </summary>
    public static List<Stick> ParseList(string output, Func<string, string?> driver, Action<string> warn)
    {
        var found = new List<Stick>();
        Dictionary<string, string>? current = null;
        var receivers = new System.Text.StringBuilder();

        void Flush()
        {
            if (current is null) return;
            var model = current.GetValueOrDefault("model") ?? "Siano";
            var port = current.GetValueOrDefault("port") ?? "-";
            if (current.GetValueOrDefault("status") != "ready")
            {
                warn($"{model} {port} は使えません (siano-ts --list: status={current.GetValueOrDefault("status")})");
            }
            else if (!IsPort(port))
            {
                warn($"{model} の USB のポートが分からないので使いません (port={port})");
            }
            else
            {
                var types = Px4Receiver.ParseList(receivers.ToString(), warn)
                    .SelectMany(receiver => receiver.Types)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                found.Add(new Stick(port, model, types, driver(port)));
            }
            current = null;
            receivers.Clear();
        }

        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("model=", StringComparison.Ordinal))
            {
                Flush();
                current = Px4Userland.Fields(line);
            }
            else if (line.StartsWith("receiver=", StringComparison.Ordinal))
            {
                if (current is not null) receivers.AppendLine(line);
            }
            else if (line.StartsWith("rejected ", StringComparison.Ordinal))
            {
                Flush();
                var fields = Px4Userland.Fields(line["rejected ".Length..]);
                warn($"{fields.GetValueOrDefault("model")} ({fields.GetValueOrDefault("usb")}, port={fields.GetValueOrDefault("port")}) は使えません: {fields.GetValueOrDefault("status")}");
            }
        }
        Flush();
        return found;
    }

    /// <summary>どれかのインターフェースを掴んでいるドライバの名前。誰も掴んでいなければ null</summary>
    internal static string? Driver(string sysfs, string port)
    {
        // sysfs が無い (Linux でない) ならカーネルのドライバも無い
        if (!Directory.Exists(sysfs)) return null;
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs, $"{port}:*").Order(StringComparer.Ordinal))
        {
            var driver = Path.Combine(entry, "driver");
            if (!Directory.Exists(driver)) continue;
            var target = new DirectoryInfo(driver).LinkTarget;
            return Path.GetFileName((target ?? driver).TrimEnd('/'));
        }
        return null;
    }

    /// <summary>
    /// siano-ts に渡せる機材を、設定に書いたのと同じ形で。
    ///
    /// <para>
    /// **ドライバに繋がっているものは挙げない。** smsusb が掴んでいれば
    /// <c>/dev/dvb</c> に出ているので、DVB の側で見つかる (DeviceProbe)。
    /// </para>
    /// </summary>
    public static List<TunerSpec> Detect() => Specs(Sticks());

    /// <summary>機材の一覧から、設定の形に組み立てる (ドライバに繋がっているもの・受けられる方式が無いものは除く)</summary>
    public static List<TunerSpec> Specs(IEnumerable<Stick> sticks)
    {
        var found = new List<TunerSpec>();
        foreach (var stick in sticks)
        {
            if (stick.Driver is not null || stick.Types.Length == 0) continue;
            found.Add(new TunerSpec(Name(stick.Model, stick.Port), stick.Types, false, Device(stick.Port)));
        }
        return found;
    }

    /// <summary>
    /// siano-ts の終了コードに、どうすればいいかを添える (0.1.8 で体系化された)。
    /// 分からないコードは何も足さない
    /// </summary>
    public static string Hint(int code) => code switch
    {
        3 => " — そのポートに Siano の機材が見当たりません (抜けたか、挿し替えた?)",
        4 => " — カーネルのドライバ (smsusb) か別のプロセスが掴んでいます。/dev/dvb に出ていればそちらで使えます。"
            + "siano-userland で使うなら smsusb / smsdvb / smsmdtv を blacklist して再起動してください",
        10 => " — ファームウェアが無いか壊れています",
        _ => "",
    };
}

/// <summary>
/// siano-userland の機材1台。**<c>siano-ts --control</c> を1つ起こしたまま、標準入力で選局し直す。**
///
/// <para>
/// 起こすのは最初の選局のときだけで、以降は <c>tune &lt;Hz&gt;</c> を1行書く。
/// siano-ts は選局して同期したら stderr に <c>tuned &lt;Hz&gt;</c>、駄目なら
/// <c>control: tune failed: …</c> を書き、どちらでも生き続ける。USB を掴み直さないので、
/// 番組表の総当たりのようにチャンネルを次々変えるときに速い。TS は選局を跨いで同じ
/// 標準出力に流れ続けるので、読み口 (<see cref="DeviceStream"/>) も1つを使い回す
/// (DVB と同じ)。常駐するデーモンは無く、USB を持っているのは走っている siano-ts だけ。
/// </para>
///
/// <para>
/// **選局し直す間は、標準出力を読んで捨てる。** siano-ts は1本の輪で「TS を書く →
/// 標準入力を見る」を回していて、書く先の pipe が埋まると書くところで止まり、
/// 標準入力を読みに来ない。誰も読んでいない間 (前の読み手が降りてから次の選局まで) に
/// pipe は埋まるので、読まずに <c>tune</c> を書くと進まない。読んで捨てれば、
/// 前のチャンネルの残りも一緒に消える — siano-ts は同期を待つ間 (<c>tuned</c> の前) は
/// 何も書かないので、<c>tuned</c> が来た時点で残っていた前の TS は読み尽くしてある。
/// </para>
///
/// <para>
/// **誰も読まなくても siano-ts は死なない。** 書くところで待つだけで、中の溜めが
/// 溢れたぶんは捨てる。選局は生きている (DVB の環が溢れたときと同じ)。
/// </para>
/// </summary>
public sealed class SianoTuner : ITuneDevice
{
    /// <summary>
    /// 選局を待つ上限。siano-ts 自身が同期を 10 秒待つ (<c>LOCK_TIMEOUT_MS</c>) ので、
    /// それより少し長く。最初の選局はファームウェアの流し込みもここに入る
    /// </summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(15);

    private readonly string _name;
    private readonly Func<ProcessStartInfo> _start;
    private readonly TimeSpan _tuneTimeout;
    private readonly Lock _gate = new();
    private Child? _child;
    private DeviceStream? _stream;

    /// <summary>siano-ts 1つぶん。stderr の行は <see cref="Lines"/> にも流す (選局の答えを待つため)</summary>
    private sealed class Child(Process process) : TsChild("siano-ts", process)
    {
        public System.Threading.Channels.Channel<string> Lines { get; } =
            System.Threading.Channels.Channel.CreateUnbounded<string>();
    }

    public SianoTuner(string port)
        : this($"siano {port}", () =>
        {
            var program = Path.Combine(SianoUserland.Dir, "siano-ts");
            if (!File.Exists(program)) throw new IOException($"siano-userland が入っていません: {program}");
            if (!File.Exists(SianoUserland.Firmware))
            {
                throw new IOException($"ファームウェアがありません: {SianoUserland.Firmware}");
            }
            // 抜けた・カーネルが掴んでいる、は siano-ts が終了コードで答える (Hint)
            return StartInfo(port, SianoUserland.Dir, SianoUserland.Firmware);
        })
    {
    }

    /// <summary>起こし方と待ちの上限を差し替える (テスト。偽の siano-ts を起こす)</summary>
    internal SianoTuner(string name, Func<ProcessStartInfo> start, TimeSpan? tuneTimeout = null)
    {
        _name = name;
        _start = start;
        _tuneTimeout = tuneTimeout ?? TuneTimeout;
    }

    public Stream Output => _stream ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    /// <summary>siano-ts が生きていれば、最後に合わせたチャンネルのまま流れている</summary>
    public bool Tuned
    {
        get
        {
            lock (_gate)
            {
                return _stream is not null && _child is { Process.HasExited: false };
            }
        }
    }

    /// <summary>
    /// 起こすもの。**機材は USB のポートで指す** (<c>--device 1-2.3</c>)。
    ///
    /// <para>
    /// 選局は起こしたあとに標準入力で頼むので、ここでは周波数を渡さない。
    /// PID は絞らない (全部。B25 と記録は TS 全体を要る)。
    /// </para>
    /// </summary>
    public static ProcessStartInfo StartInfo(string port, string dir, string firmware)
    {
        var start = new ProcessStartInfo(Path.Combine(dir, "siano-ts"));
        foreach (var arg in new[] { "--device", port, "--control", "--firmware", firmware })
        {
            start.ArgumentList.Add(arg);
        }
        return start;
    }

    /// <summary>選局を頼む1行。周波数は選局表の Hz のまま (地上波の表は Hz)</summary>
    public static string TuneCommand(ChannelTable.Tuning tuning)
    {
        if (tuning.Satellite) throw new IOException($"Siano の機材は地上波だけです ({tuning.Type} は受けられません)");
        return $"tune {tuning.Frequency}";
    }

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        var command = TuneCommand(tuning);
        lock (_gate)
        {
            if (_child is not { Process.HasExited: false } || _stream is null)
            {
                Drop();
                Start();
            }
            Retune(_child!, _stream!, command);
        }
    }

    private void Start()
    {
        var start = _start();
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.UseShellExecute = false;

        var process = Process.Start(start) ?? throw new IOException("siano-ts を起こせません");
        var child = new Child(process);
        _ = Task.Run(async () =>
        {
            using var reader = process.StandardError;
            while (await reader.ReadLineAsync() is { } line)
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                child.Stderr = trimmed;
                child.Lines.Writer.TryWrite(trimmed);
            }
            child.Lines.Writer.TryComplete();
        });

        var handle = ChildTs.StdoutHandle(process);
        ChildTs.WidenPipe((int)handle.DangerousGetHandle(), _name);
        _child = child;
        _stream = new DeviceStream(handle, child.EndReason);
        _ = process.WaitForExitAsync().ContinueWith(_ =>
        {
            if (child.Dropped) return;
            // USB が抜けたのもここに来る。次の選局で起こし直す (Tuned が false になる)
            Log.Write($"[{_name}] {Why(child, process.ExitCode)}");
        }, TaskScheduler.Default);
    }

    /// <summary>
    /// <c>tune</c> を書いて答えを待つ。**待つ間は標準出力を読んで捨てる** (上の説明)。
    /// 駄目なら理由を添えて投げる。siano-ts は生かしたまま (次の選局で使い回す)
    /// </summary>
    private void Retune(Child child, DeviceStream stream, string command)
    {
        // 前の選局の答えが残っていれば捨てる
        while (child.Lines.Reader.TryRead(out _))
        {
        }

        var answered = 0;
        var drain = Task.Run(() =>
        {
            var buffer = new byte[64 * 1024];
            try
            {
                while (Volatile.Read(ref answered) == 0)
                {
                    if (stream.Read(buffer, 0, buffer.Length, () => Volatile.Read(ref answered) != 0) <= 0) break;
                }
            }
            catch (IOException)
            {
                // 子が終わった。理由は下で stderr から拾う
            }
        });

        string? failure = null;
        // 答えを信じられなくなった。子を捨てて、次の選局で起こし直す
        var uncertain = false;
        try
        {
            child.Process.StandardInput.WriteLine(command);
            child.Process.StandardInput.Flush();
            (failure, uncertain) = Await(child, command, _tuneTimeout);
        }
        catch (IOException)
        {
            // 標準入力に書けない = 子が終わっている
            failure = child.Process.WaitForExit(TimeSpan.FromSeconds(2))
                ? Why(child, child.Process.ExitCode)
                : "siano-ts に選局を頼めません";
        }
        finally
        {
            Volatile.Write(ref answered, 1);
            /*
             * **読み捨てが降りきるまで返さない。** 降りないまま返すと、次の読み手と
             * 同じ fd を取り合う。Read は 200ms ごとに起きて印を見るので普通は
             * すぐ降りるが、降りなければ子ごと捨てる (Drop が読み口を止めて閉じる)
             */
            if (!drain.Wait(TimeSpan.FromSeconds(2)))
            {
                failure ??= "siano-ts の標準出力を読み捨てるところが止まりません";
                uncertain = true;
            }
        }
        if (uncertain) Drop();
        if (failure is not null) throw new IOException(failure);
    }

    /// <summary>終わった理由に、終了コードから分かる手当てを添える (<see cref="SianoUserland.Hint"/>)</summary>
    private static string Why(TsChild child, int code) => child.Exited(code) + SianoUserland.Hint(code);

    /// <summary>
    /// 答えを待つ。<c>tuned &lt;頼んだ Hz&gt;</c> なら成功 (null)、駄目なら理由。
    ///
    /// <para>
    /// **待ちきれなかったら、その子の答えはもう信じない** (<c>Uncertain</c>)。siano-ts は
    /// まだ前の選局を続けていて、その答え (<c>tuned</c> / <c>tune failed</c>) が次の選局の
    /// 答えに紛れ込むため。<c>tuned</c> は頼んだ周波数と突き合わせるが、<c>tune failed</c> には
    /// 周波数が付かないので、子ごと捨てて起こし直すしかない。答えでない行 (警告など) は飛ばす
    /// </para>
    /// </summary>
    private static (string? Failure, bool Uncertain) Await(Child child, string command, TimeSpan limit)
    {
        var expected = $"tuned {command["tune ".Length..]}";
        using var timeout = new CancellationTokenSource(limit);
        var before = "";
        try
        {
            for (; ; )
            {
                var line = child.Lines.Reader.ReadAsync(timeout.Token).AsTask().GetAwaiter().GetResult();
                if (line == expected) return (null, false);
                if (line.StartsWith("control: tune failed", StringComparison.Ordinal) || line == "control: invalid")
                {
                    // 直前の行のほうが分かりやすい (no demod lock など)
                    return (before.Length == 0 ? line : $"{before} ({line})", false);
                }
                before = line;
            }
        }
        catch (OperationCanceledException)
        {
            return ("同期しませんでした (電波が来ていないか、その周波数に放送がありません)", true);
        }
        catch (System.Threading.Channels.ChannelClosedException)
        {
            child.Process.WaitForExit(TimeSpan.FromSeconds(2));
            return (Why(child, child.Process.HasExited ? child.Process.ExitCode : -1), true);
        }
    }

    /// <summary>
    /// siano-ts を止める。<c>quit</c> を頼み、聞かなければ SIGTERM、それでも残れば SIGKILL。
    /// 書くところで止まっていると <c>quit</c> は読まれないので、待ちは短く。
    /// 読み手が降りきってから fd を閉じる (<see cref="ChildTs.ReaderDrain"/>)
    /// </summary>
    private void Drop()
    {
        var child = _child;
        var stream = _stream;
        _child = null;
        _stream = null;
        if (child is null) return;

        child.Dropped = true;
        stream?.Stop();
        var stopped = Stopwatch.StartNew();
        var process = child.Process;
        try
        {
            process.StandardInput.WriteLine("quit");
            process.StandardInput.Flush();
        }
        catch (IOException)
        {
            // もう居ない
        }
        if (!process.WaitForExit(TimeSpan.FromMilliseconds(500)))
        {
            Interop.Terminate(process.Id);
            if (!process.WaitForExit(TimeSpan.FromSeconds(2))) process.Kill();
        }
        var rest = ChildTs.ReaderDrain - stopped.Elapsed;
        if (stream is not null && rest > TimeSpan.Zero) Thread.Sleep(rest);
        stream?.Dispose();
        // 同期読みにした標準出力は Process.Dispose が閉じない (ChildTs.Drop と同じ)
        process.StandardOutput.Dispose();
        try
        {
            process.StandardInput.Dispose();
        }
        catch (IOException)
        {
            // 子がもう居ないと、書き残した quit を吐き出すところで投げる
        }
        process.Dispose();
    }

    public void Dispose()
    {
        lock (_gate) Drop();
    }
}
