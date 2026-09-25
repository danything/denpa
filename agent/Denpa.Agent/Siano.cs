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
/// 黙って奪う。** 作者自身が「動いている smsusb から切り替えるのは安全と判定していない」
/// (unbind の境目でカーネルの異常を観測) と書いているので、こちらは
/// **どのドライバにも繋がっていない機材だけ**を siano-ts に渡す。
/// 使いたい人は smsusb / smsdvb / smsmdtv を blacklist して再起動する (docs/agent.md)。
/// </para>
///
/// <para>
/// **USB のノードは自分で開いて <c>--fd</c> で渡す。** <c>siano-ts --device N</c> は
/// libusb が並べた順の N 番目で、その並びにはカーネルが掴んでいる S1UD も入る。
/// 2台刺さっていると番号がずれて、DVB で使っている方を奪いかねない。
/// sysfs で見分けた1台の <c>/dev/bus/usb/BBB/DDD</c> をシェルに fd 3 で開かせ、
/// そのまま siano-ts に exec させる (.NET から fd を子に渡す口が無いため)。
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

    public sealed record Model(string Vendor, string Product, string Name);

    /// <summary>
    /// siano-ts が ISDB-T の RIO として扱う機種 (siano-userland の README)。
    /// 実機で確かめてあるのは PX-S1UD だけで、残り2つはあちらでも未検証
    /// </summary>
    public static readonly Model[] Models =
    [
        new("3275", "0080", "PX-S1UD"),
        new("187f", "0600", "Siano RIO"),
        new("187f", "0302", "Siano RIO"),
    ];

    /// <summary>刺さっている1台。<c>Driver</c> はどれかのインターフェースを掴んでいるドライバ (無ければ null)</summary>
    public sealed record Stick(string Port, string Model, int Bus, int Address, string? Driver)
    {
        public string Node => $"/dev/bus/usb/{Bus:D3}/{Address:D3}";
    }

    /// <summary>配布アーカイブを展開した場所 (Dockerfile)</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("SIANO_USERLAND_DIR") ?? "/opt/siano-userland";

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
    /// sysfs を読む。<c>idVendor</c> / <c>idProduct</c> / <c>busnum</c> / <c>devnum</c> と、
    /// インターフェース (<c>&lt;port&gt;:1.0</c> …) の <c>driver</c> のリンク先。
    /// </para>
    /// </summary>
    public static List<Stick> Sticks(string sysfs = "/sys/bus/usb/devices")
    {
        var found = new List<Stick>();
        if (!Directory.Exists(sysfs)) return found;
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(entry);
            if (!IsPort(port)) continue;
            var vendor = Attribute(entry, "idVendor");
            var product = Attribute(entry, "idProduct");
            if (Models.FirstOrDefault(m => m.Vendor == vendor && m.Product == product) is not { } model) continue;
            if (!int.TryParse(Attribute(entry, "busnum"), out var bus)
                || !int.TryParse(Attribute(entry, "devnum"), out var address))
            {
                Log.Write($"{model.Name} {port} の USB の番号が読めません");
                continue;
            }
            found.Add(new Stick(port, model.Name, bus, address, Driver(sysfs, port)));
        }
        return found;
    }

    /// <summary>どれかのインターフェースを掴んでいるドライバの名前。誰も掴んでいなければ null</summary>
    private static string? Driver(string sysfs, string port)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(sysfs, $"{port}:*").Order(StringComparer.Ordinal))
        {
            var driver = Path.Combine(entry, "driver");
            if (!Directory.Exists(driver)) continue;
            var target = new DirectoryInfo(driver).LinkTarget;
            return Path.GetFileName((target ?? driver).TrimEnd('/'));
        }
        return null;
    }

    private static string? Attribute(string directory, string name)
    {
        try
        {
            var path = Path.Combine(directory, name);
            return File.Exists(path) ? File.ReadAllText(path).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// siano-ts に渡せる機材を、設定に書いたのと同じ形で。
    ///
    /// <para>
    /// **ドライバに繋がっているものは挙げない。** smsusb が掴んでいれば
    /// <c>/dev/dvb</c> に出ているので、DVB の側で見つかる (DeviceProbe)。
    /// </para>
    /// </summary>
    public static List<TunerSpec> Detect(string sysfs = "/sys/bus/usb/devices")
    {
        var found = new List<TunerSpec>();
        foreach (var stick in Sticks(sysfs))
        {
            if (stick.Driver is not null) continue;
            found.Add(new TunerSpec(Name(stick.Model, stick.Port), ["GR"], false, Device(stick.Port)));
        }
        return found;
    }

    /// <summary>
    /// 選局の直前に、そのポートの機材を確かめる。**どのドライバにも繋がっていなければ返す。**
    /// 抜けている・別の機材に挿し替わった・カーネルが掴んでいる、は理由を添えて投げる
    /// </summary>
    public static Stick Claimable(string port, string sysfs = "/sys/bus/usb/devices")
    {
        var stick = Sticks(sysfs).FirstOrDefault(s => s.Port == port)
            ?? throw new IOException($"USB のポート {port} に Siano の機材が見当たりません (抜けたか、挿し替えた?)");
        if (stick.Driver is not null)
        {
            throw new IOException(
                $"{stick.Model} {port} はカーネルのドライバ ({stick.Driver}) が掴んでいるので、siano-userland では開きません。"
                + " /dev/dvb に出ていればそちらで使えます。siano-userland で使うなら smsusb を blacklist して再起動してください");
        }
        return stick;
    }
}

/// <summary>
/// siano-userland の機材1台。<c>siano-ts</c> を起こして標準出力を読む (ChildTs)。
///
/// <para>
/// **選局のたびに siano-ts を起こし直す。** 1回1チャンネルの作りで、掴んだまま
/// 変える口が無い。ファームウェアは同じモードで動いていれば入れ直さないので、
/// 2回目からは流し込みを待たない。常駐するデーモンは無く、USB を持っているのは
/// 走っている siano-ts だけ。
/// </para>
///
/// <para>
/// **誰も読まなくても siano-ts は死なない。** pipe が埋まると siano-ts の中の
/// 溜めが溢れて捨てるだけで、選局は生きている (DVB の環が溢れたときと同じ)。
/// </para>
/// </summary>
public sealed class SianoTuner : ITuneDevice
{
    /// <summary>
    /// 同期を待つ上限。siano-ts 自身が 10 秒待つ (<c>LOCK_TIMEOUT_MS</c>) ので、
    /// それより少し長く。初回はファームウェアの流し込みもここに入る
    /// </summary>
    private static readonly TimeSpan SyncTimeout = TimeSpan.FromSeconds(15);

    private readonly string _port;
    private readonly string _sysfs;
    private readonly Lock _gate = new();
    private readonly ChildTs _ts;

    public SianoTuner(string port, string sysfs = "/sys/bus/usb/devices")
    {
        _port = port;
        _sysfs = sysfs;
        _ts = new ChildTs($"siano {port}", "siano-ts");
    }

    public Stream Output => _ts.Output;

    public bool Tuned
    {
        get
        {
            lock (_gate)
            {
                return _ts.Alive;
            }
        }
    }

    /// <summary>
    /// 起こすもの。**シェルに USB のノードを fd 3 で開かせ、siano-ts に exec させる。**
    ///
    /// <para>
    /// 値は全部 <c>$1</c> 以降の引数で渡し、シェルの文には埋め込まない。
    /// 周波数は選局表の Hz のまま <c>--freq</c> で (地上波の表は Hz)。
    /// PID は絞らない (全部。B25 と記録は TS 全体を要る)。
    /// </para>
    /// </summary>
    public static ProcessStartInfo StartInfo(string node, ChannelTable.Tuning tuning, string dir, string firmware)
    {
        if (tuning.Satellite) throw new IOException($"Siano の機材は地上波だけです ({tuning.Type} は受けられません)");
        var start = new ProcessStartInfo("/bin/sh");
        foreach (var arg in new[]
        {
            "-c", "node=$1; shift; exec \"$0\" --fd 3 \"$@\" 3<>\"$node\"",
            Path.Combine(dir, "siano-ts"),
            node,
            "--freq", tuning.Frequency.ToString(),
            "--firmware", firmware,
        })
        {
            start.ArgumentList.Add(arg);
        }
        return start;
    }

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            // 前の siano-ts が USB を手放してから確かめる (走っている間は自分が掴んでいる)
            _ts.Drop();
            var program = Path.Combine(SianoUserland.Dir, "siano-ts");
            if (!File.Exists(program)) throw new IOException($"siano-userland が入っていません: {program}");
            if (!File.Exists(SianoUserland.Firmware))
            {
                throw new IOException($"ファームウェアがありません: {SianoUserland.Firmware}");
            }
            var stick = SianoUserland.Claimable(_port, _sysfs);
            _ts.Start(StartInfo(stick.Node, tuning, SianoUserland.Dir, SianoUserland.Firmware), SyncTimeout);
        }
    }

    public void Dispose()
    {
        lock (_gate) _ts.Drop();
    }
}
