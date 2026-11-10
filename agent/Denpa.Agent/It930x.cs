using System.Collections.Concurrent;
using System.Globalization;

namespace Denpa.Agent;

/*
 * IT930x の USB ブリッジを積んだ機材を、px4d を使わずにエージェントが直に持つための層 (#1578)。
 *
 * ブリッジ (It930xBridge.cs)、受信機ごとに TS を分ける層 (It930xTs.cs)、機材とチューナー (It930xDevice.cs)、
 * 受信機の後ろのチップ (CXD2856ER と CXD2858ER は Cxd2856.cs・Cxd2858.cs、TC90522 と R850・RT710 は Tc90522.cs・R850.cs・Rt710.cs)、
 * 実機で試す入口 (It930xProbe.cs の --it930x-probe と、Probe.cs の --tune it930x:… と --card it930x:…) がある。
 * **この表の機種 (Family) は、いつもエージェントが持つ。** 自動検出 (Detect) が it930x:<USB のポート>:<受信機> で挙げ、px4d は挙げず、起動もしない (Px4Userland.ParseJson)。
 * 受信機ごとの割り当ては仕様書 (denpa-spec の mlt5/spec.md の 1.2 と、px4/spec.md の 1・2.2・13) から。
 * コメントの「MLT5 の仕様書」は mlt5/spec.md、「px4 の仕様書」は px4/spec.md。
 */

/// <summary>受信機の復調器</summary>
public enum It930xDemod
{
    /// <summary>CXD2856ER。地上波・衛星・J.83B を 1 つで受ける (MLT5 の仕様書)</summary>
    Cxd2856,

    /// <summary>TC90522 の地上波のアドレス (px4 の仕様書 2.2)。地上波だけ</summary>
    Tc90522T,

    /// <summary>TC90522 の衛星のアドレス (px4 の仕様書 2.2)。衛星だけ</summary>
    Tc90522S,

    /// <summary>TC90522 (か TC90532) の地上波と衛星のアドレスを、選局のたびに切り替えて使う受信機 (px4 の仕様書 13.3)</summary>
    Tc90522Switch,

    /// <summary>DTV03A-1TU の復調器 (型番は未確認。TC90522 と同じ読み書きの形で、初期化の値が違う。px4 の仕様書 13.4)</summary>
    Isdbt2071,
}

/// <summary>受信機のチューナー</summary>
public enum It930xTunerChip
{
    /// <summary>CXD2858ER</summary>
    Cxd2858,

    /// <summary>R850 (地上波)</summary>
    R850,

    /// <summary>RT710 か RT720 (衛星)</summary>
    Rt710,

    /// <summary>R850 と RT710 の両方 (地上波と衛星を切り替える受信機)</summary>
    R850Rt710,
}

/// <summary>
/// 受信機 1 つの割り当て (MLT5 の仕様書 1.2、px4 の仕様書 2.2・13)。<paramref name="DemodAddress"/> は復調器のアドレス (7 ビット)。
/// CXD2856ER は T のアドレス (X は T + 2。MLT5 の仕様書 1.1)、TC90522 はその受信機が使うアドレス (切り替える受信機は地上波のアドレス)
/// </summary>
/// <param name="Index">受信機の番号 (設定の <c>it930x:&lt;ポート&gt;:&lt;Index&gt;</c>)。ブリッジの「次の段の I2C」の欄もこの番号で並ぶ (MLT5 の仕様書 1.3、px4 の仕様書 2.3)</param>
/// <param name="TsInput">ブリッジの TS 入力 (0〜4)</param>
/// <param name="I2cBus">ブリッジの I2C のバス</param>
public sealed record It930xReceiver(int Index, int TsInput, byte I2cBus, byte DemodAddress)
{
    public It930xDemod Demod { get; init; } = It930xDemod.Cxd2856;

    public It930xTunerChip Tuner { get; init; } = It930xTunerChip.Cxd2858;

    /// <summary>
    /// ブリッジがこの受信機のパケットの先頭に付ける同期バイト。CXD2856ER の機種は入力の番号で決めた値 (<see cref="It930xBridge.SyncBytes"/>。こちらで決めてよい値。px4 の仕様書 13.1)、
    /// TC90522 の機種は px4 の仕様書 2.2・13.3・13.4 の値
    /// </summary>
    public byte SyncByte { get; init; } = It930xBridge.SyncBytes[TsInput];

    /// <summary>受けられる種別 (<c>GET /denpa/tuners</c> の <c>receivable</c>)。受けられない種別の選局は、機材に触る前に断る (<see cref="It930xTuner"/>)</summary>
    public IReadOnlyList<string> Types { get; init; } = It930x.Types;

    /// <summary>衛星の「2 つ目」の印 (px4 の仕様書 2.2・6.2。AGC の <c>10</c> の値が変わる)</summary>
    public bool Second { get; init; }

    /// <summary>R850 のループスルー (px4 の仕様書 2.2・7.2)</summary>
    public bool Loopthrough { get; init; }

    /// <summary>切り替える受信機の、衛星のアドレス (px4 の仕様書 13.3 の S)。ほかは 0</summary>
    public byte SatelliteAddress { get; init; }

    /// <summary>切り替える受信機で、TS の設定を書く衛星のアドレス (px4 の仕様書 13.3 の S0)。ほかは 0</summary>
    public byte SatelliteTsAddress { get; init; }

    /// <summary>自動で見つけたときに最初に選ぶ種別。<c>SKY</c> は受けられても最初からは選ばない (<see cref="It930x.DetectedTypes"/>)</summary>
    public string[] DetectedTypes => [.. Types.Where(type => type != ChannelTable.Sky)];

    /// <summary>種別を受けられるか (<c>GR</c>・<c>BS</c>・<c>CS</c>・<c>SKY</c>)</summary>
    public bool Takes(string type) => Types.Contains(type);

    /// <summary>
    /// その選局を受けられるか。ISDB-C (種別は <c>CATV</c>。<c>--tune</c> だけで選局する) は、受けられる種別には入れておらず、CXD2856ER の受信機だけが受けられる (MLT5 の仕様書 7A)。
    /// ほかは種別で決める
    /// </summary>
    public bool Takes(ChannelTable.Tuning tuning) => tuning.IsdbC ? Demod == It930xDemod.Cxd2856 : Takes(tuning.Type);
}

/// <summary>
/// IT930x を積んだ機材 1 機種。受信機ごとの割り当ては MLT5 の仕様書 1.2 と、px4 の仕様書 2.2・13 の表
/// </summary>
public sealed record It930xModel(int Vendor, int Product, string Name, IReadOnlyList<It930xReceiver> Receivers)
{
    /// <summary>
    /// LNB に給電できるか (ブリッジの GPIOH11。15 V だけ。MLT5 の仕様書 9、px4 の仕様書 10)。
    /// 受信機が 1 つの機種 (px4 の仕様書 13.3・13.4) は給電の操作が無いので false (15 V の指定は断る)
    /// </summary>
    public bool Lnb { get; init; } = true;

    /// <summary>内蔵カードリーダーがあるか (px4 の仕様書 1.4)。PX-MLT8PE の 3 受信機の側だけ無い</summary>
    public bool Card { get; init; } = true;

    /// <summary>2 つの USB デバイスで 1 つの筐体になる機種 (Q3。px4 の仕様書 1.5)</summary>
    public bool Paired { get; init; }

    /// <summary>
    /// 受信機の基板の電源の GPIOH (0 で入る)。7 の機種は機材を開いている間 (受信機かカードを使っている間) 入れておく (MLT5 の仕様書 1.5、px4 の仕様書 2.5)。
    /// 3 の機種は受信機を開いている間だけ入れ、カードのためには入れない (px4 の仕様書 13.3)
    /// </summary>
    public int PowerPin { get; init; } = 7;

    /// <summary>電源を入れてからリセットを解くまでの待ち (ms)。GPIOH7 の機種は 80、GPIOH3 の機種は 100 (px4 の仕様書 12)</summary>
    public int PowerWaitMs => PowerPin == 7 ? 80 : 100;

    /// <summary>機材を開いている間、電源を入れておく機種か</summary>
    public bool PowerWhileOpen => PowerPin == 7;

    /// <summary>復調器の種類 (機種の中ではどの受信機も同じ系統)</summary>
    public It930xDemod Demod => Receivers[0].Demod;

    /// <summary>
    /// LNB の給電の短絡の検出の GPIOH (入力。1 で正常、0 で短絡)。Q3・W3 系だけ (px4 の仕様書 2.5・10。PLEX の公開ドライバーだけにある情報で、実機で確かめた記録は無い)。
    /// 選局には使わず、<c>--tune</c> の出力にだけ出す
    /// </summary>
    public int? LnbSensePin => Demod is It930xDemod.Tc90522T or It930xDemod.Tc90522S ? 10 : null;

    /// <summary>入力 0〜4 の同期バイト。使わない入力は 0</summary>
    public byte[] SyncBytes
    {
        get
        {
            var bytes = new byte[It930xBridge.TsInputs];
            foreach (var receiver in Receivers) bytes[receiver.TsInput] = receiver.SyncByte;
            return bytes;
        }
    }
}

/// <summary>IT930x を積んだ機材の識別と、挿さっているものを探す・開く。設定の <c>device</c> の形と、自動検出</summary>
public static class It930x
{
    /// <summary>
    /// CXD2856ER の受信機が受けられる種別。ISDB-T・ISDB-S・J.83B を受けられる (MLT5 の仕様書 1.2)。
    /// 機種が分からない <c>it930x:</c> の受信機にも、これを返す (<see cref="Receivable"/>)。<c>SKY</c> (スカパー！プレミアムサービス光) を受けられるのは、いまは CXD2856ER の機種だけ
    /// </summary>
    public static readonly IReadOnlyList<string> Types = ["GR", "BS", "CS", ChannelTable.Sky];

    /// <summary>地上波だけの受信機</summary>
    private static readonly IReadOnlyList<string> Terrestrial = ["GR"];

    /// <summary>衛星だけの受信機</summary>
    private static readonly IReadOnlyList<string> Satellite = ["BS", "CS"];

    /// <summary>地上波と衛星を切り替える受信機 (J.83B は受けられない)</summary>
    private static readonly IReadOnlyList<string> Both = ["GR", "BS", "CS"];

    /// <summary>PX-MLT5PE・DTV02A-5TS-P の割り当て (MLT5 の仕様書 1.2)。T のアドレスとバスは 3 機種で同じで、TS 入力は受信機の番号と同じ</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt5pe =
    [
        new(0, 0, 3, 0x65),
        new(1, 1, 1, 0x6C),
        new(2, 2, 1, 0x64),
        new(3, 3, 3, 0x6C),
        new(4, 4, 3, 0x64),
    ];

    /// <summary>PX-MLT5U の割り当て (MLT5 の仕様書 1.2)。TS 入力の番号だけが PX-MLT5PE と違う</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt5u =
    [
        new(0, 4, 3, 0x65),
        new(1, 3, 1, 0x6C),
        new(2, 1, 1, 0x64),
        new(3, 2, 3, 0x6C),
        new(4, 0, 3, 0x64),
    ];

    /// <summary>
    /// Q3・W3 系の USB デバイス 1 つ分 (W3 の全体、Q3 の片側) の割り当て (px4 の仕様書 2.2)。受信機 0・1 が衛星 (RT710)、2・3 が地上波 (R850)。
    /// 復調器 TC90522 の 4 つのアドレスがバス 2 にあり、TS 入力は 1〜4。同期バイトは仕様書の値で、受信機 3 は 0x47
    /// </summary>
    private static readonly IReadOnlyList<It930xReceiver> W3 =
    [
        new(0, 1, 2, 0x11) { Demod = It930xDemod.Tc90522S, Tuner = It930xTunerChip.Rt710, SyncByte = 0x17, Types = Satellite },
        new(1, 2, 2, 0x13) { Demod = It930xDemod.Tc90522S, Tuner = It930xTunerChip.Rt710, SyncByte = 0x27, Types = Satellite, Second = true },
        new(2, 3, 2, 0x10) { Demod = It930xDemod.Tc90522T, Tuner = It930xTunerChip.R850, SyncByte = 0x37, Types = Terrestrial, Loopthrough = true },
        new(3, 4, 2, 0x12) { Demod = It930xDemod.Tc90522T, Tuner = It930xTunerChip.R850, SyncByte = 0x47, Types = Terrestrial },
    ];

    /// <summary>PX-MLT8PE の 5 受信機の側の割り当て (px4 の仕様書 13.1)。チップと手順は MLT5 系と同じ</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt8pe5 =
    [
        new(0, 0, 1, 0x65),
        new(1, 1, 1, 0x64),
        new(2, 2, 1, 0x6C),
        new(3, 3, 3, 0x6C),
        new(4, 4, 3, 0x64),
    ];

    /// <summary>PX-MLT8PE の 3 受信機の側の割り当て (px4 の仕様書 13.1)。TS 入力 1・2 は使わない</summary>
    private static readonly IReadOnlyList<It930xReceiver> Mlt8pe3 =
    [
        new(0, 0, 3, 0x65),
        new(1, 3, 3, 0x6C),
        new(2, 4, 3, 0x64),
    ];

    /// <summary>DTV02A-4TS-P の割り当て (px4 の仕様書 13.2)。PX-MLT5PE の受信機 3 が無い形で、TS 入力 3 は使わない</summary>
    private static readonly IReadOnlyList<It930xReceiver> Dtv02a4ts =
    [
        new(0, 0, 3, 0x65),
        new(1, 1, 1, 0x6C),
        new(2, 2, 1, 0x64),
        new(3, 4, 3, 0x64),
    ];

    /// <summary>受信機が 1 つで、地上波と衛星を切り替える機種の割り当て (px4 の仕様書 13.3)。<paramref name="satellite"/> は衛星のアドレス</summary>
    private static IReadOnlyList<It930xReceiver> Single(byte satellite, bool second = false) =>
    [
        new(0, 0, 3, 0x10)
        {
            Demod = It930xDemod.Tc90522Switch, Tuner = It930xTunerChip.R850Rt710, SyncByte = 0x47, Types = Both,
            SatelliteAddress = satellite, SatelliteTsAddress = 0x11, Second = second,
        },
    ];

    /// <summary>
    /// いま扱う機種。px4_drv と px4-userland が扱う USB の ID の全部 (MLT5 の仕様書 1.1、px4 の仕様書 1.1)。
    ///
    /// <list type="bullet">
    /// <item>MLT5 系 (CXD2856ER + CXD2858ER): PX-MLT5PE は、USB の ID と受信機 0〜4 の割り当てを実機で確かめた (5 台とも選局できた)。
    /// PX-MLT5U と DTV02A-5TS-P は実機で確かめていない。DTV02A-5TS-P は PX-MLT5PE と同じ割り当てとして扱う (MLT5 の仕様書 1.2 も未確認としている)</item>
    /// <item>Q3・W3 系 (TC90522 + R850 + RT710): どの機種も、このドライバーでは実機で確かめていない (#1578)</item>
    /// <item>PX-MLT8PE・DTV02A-4TS-P (MLT5 系と同じチップで、割り当てだけが違う): 実機で確かめていない</item>
    /// <item>受信機が 1 つの機種 (ISDB2056・ISDB2056N・PX-M1UR・PX-S1UR・DTV03A-1TU): 実機で確かめていない。
    /// 電源は GPIOH3 で、LNB には給電できない (px4 の仕様書 13.3・13.4)</item>
    /// </list>
    /// </summary>
    public static readonly IReadOnlyList<It930xModel> Family =
    [
        new(0x0511, 0x084E, "PLEX PX-MLT5U", Mlt5u),
        new(0x0511, 0x024E, "PLEX PX-MLT5PE", Mlt5pe),
        new(0x0511, 0x924E, "e-Better DTV02A-5TS-P", Mlt5pe),
        new(0x0511, 0x083F, "PLEX PX-W3U4", W3),
        new(0x0511, 0x023F, "PLEX PX-W3PE4", W3),
        new(0x0511, 0x073F, "PLEX PX-W3PE5", W3),
        new(0x0511, 0x084A, "PLEX PX-Q3U4", W3) { Paired = true },
        new(0x0511, 0x024A, "PLEX PX-Q3PE4", W3) { Paired = true },
        new(0x0511, 0x074A, "PLEX PX-Q3PE5", W3) { Paired = true },
        new(0x0511, 0x0253, "PLEX PX-MLT8PE", Mlt8pe5),
        // 3 受信機の側。カードリーダーは 5 受信機の側だけ (px4 の仕様書 1.4)。2 つの USB デバイスは組にしない (組にする手順が公開の資料に無い。px4 の仕様書 13.1)
        new(0x0511, 0x0252, "PLEX PX-MLT8PE", Mlt8pe3) { Card = false },
        new(0x0511, 0x0254, "e-Better DTV02A-4TS-P", Dtv02a4ts),
        new(0x0511, 0x004B, "Digibest ISDB2056", Single(0x11)) { PowerPin = 3, Lnb = false },
        // ISDB2056N は衛星のアドレスが 0x13 で、「2 つ目」の印が有る (px4 の仕様書 13.3)
        new(0x0511, 0x084B, "Digibest ISDB2056N", Single(0x13, second: true)) { PowerPin = 3, Lnb = false },
        new(0x0511, 0x0854, "PLEX PX-M1UR", Single(0x11)) { PowerPin = 3, Lnb = false },
        // PX-S1UR は地上波だけ (RT710 が無い)。衛星のアドレス 0x11 には初期化の書き込みだけをする (px4 の仕様書 13.3)
        new(0x0511, 0x0855, "PLEX PX-S1UR",
        [
            new(0, 0, 3, 0x10)
            {
                Demod = It930xDemod.Tc90522Switch, Tuner = It930xTunerChip.R850, SyncByte = 0x47, Types = Terrestrial,
                SatelliteAddress = 0x11, SatelliteTsAddress = 0x11,
            },
        ]) { PowerPin = 3, Lnb = false },
        new(0x0511, 0x0052, "e-Better DTV03A-1TU",
        [
            new(0, 4, 3, 0x18) { Demod = It930xDemod.Isdbt2071, Tuner = It930xTunerChip.R850, SyncByte = 0x47, Types = Terrestrial },
        ]) { PowerPin = 3, Lnb = false },
    ];

    /// <summary>機材をまとめて呼ぶ名前 (見つからないときの文言)</summary>
    public const string Model = "IT930x の機材 (PX-MLT5・PX-MLT8・PX-Q3・PX-W3 系など)";

    /// <summary>USB の ID から。扱う機種でなければ null</summary>
    public static It930xModel? Find(int vendor, int product) =>
        Family.FirstOrDefault(model => model.Vendor == vendor && model.Product == product);

    /// <summary>設定の <c>device</c> の接頭辞 (<c>it930x:4-12.1:0</c>。USB のポートと受信機の番号)</summary>
    public const string Scheme = "it930x:";

    public static string Device(string port, int receiver) => $"{Scheme}{port}:{receiver}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary>
    /// <c>it930x:4-12.1:0</c> からポートと受信機の番号を取る。形式が違うか、受信機の番号が 0〜4 でなければ null。
    /// その機種に無い番号 (受信機が 4 つの機種の 4 など) は、機材を開くときに断る (<see cref="It930xDevice.Frontend"/>)
    /// </summary>
    public static (string Port, int Receiver)? Parse(string? device)
    {
        if (!Is(device)) return null;
        var rest = device![Scheme.Length..];
        var colon = rest.LastIndexOf(':');
        if (colon <= 0) return null;
        var port = rest[..colon];
        if (!UsbSysfs.IsPort(port)) return null;
        if (!int.TryParse(rest[(colon + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var receiver) || receiver is < 0 or > 4) return null;
        return (port, receiver);
    }

    /// <summary>
    /// <c>px4d --list-json</c> の筐体が、この表の機種か。**この表の機種は px4d に持たせない** (<see cref="Px4Userland.ParseJson"/>)。
    /// USB の ID (<c>0511:024e</c>) で見分ける。ID が読めなかったときだけ、機種の名前 (<c>PX-MLT5PE</c>。メーカーを除いた部分と同じか) で見分ける
    /// </summary>
    public static It930xModel? Listed(string? usb, string? model)
    {
        if (usb?.Split(':') is [var vendor, var product] && Hex(vendor) is { } vid && Hex(product) is { } pid) return Find(vid, pid);
        return model is { Length: > 0 } ? Family.FirstOrDefault(known => known.Name[(known.Name.LastIndexOf(' ') + 1)..].Equals(model, StringComparison.OrdinalIgnoreCase)) : null;
    }

    /// <summary>画面に出す受信機の名前 (<c>PLEX PX-MLT5PE 4-12.1 #0</c>)</summary>
    public static string Name(It930xModel model, string port, int receiver) => $"{model.Name} {port} #{receiver}";

    /// <summary>
    /// 挿さっている機材の受信機を、設定に書いたのと同じ形式で。並べるだけで開かない (開くとファームウェアを起動して電源を入れる)。
    /// 受信機ごとに、受けられる種別のうち最初に選ぶもの (<see cref="It930xReceiver.DetectedTypes"/>) を付ける。
    /// Q3 は 2 つの USB デバイスを続けて並べ、シリアル番号の末尾が 1 の側を先にする (px4 の仕様書 1.5)
    /// </summary>
    public static List<TunerSpec> Detect() => Specs(Found(Log.Write), Serial);

    /// <summary>
    /// 自動で見つけた CXD2856ER の受信機に付ける種別。<c>SKY</c> は受けられる種別 (<see cref="Types"/>) には入るが、最初からは選ばない
    /// (光の回線でしか受けられず、選ぶとチャンネルスキャンに H01〜H105 が足される。J.83B は実機で確かめていない)
    /// </summary>
    public static readonly IReadOnlyList<string> DetectedTypes = ["GR", "BS", "CS"];

    /// <summary>挿さっている機材から設定の形式に組み立てる (渡せるのはテストのため)</summary>
    /// <param name="serial">ポートから USB のシリアル番号 (Q3 の 2 つの側を並べるため)。無ければ見つけた順のまま</param>
    internal static List<TunerSpec> Specs(IEnumerable<(string Port, It930xModel Model)> found, Func<string, string?>? serial = null) =>
    [
        .. Ordered(found, serial).SelectMany(item => item.Model.Receivers.Select(receiver =>
            new TunerSpec(Name(item.Model, item.Port, receiver.Index), receiver.DetectedTypes, false, Device(item.Port, receiver.Index)))),
    ];

    /// <summary>
    /// Q3 の 2 つの側を続けて並べる (末尾が 1 の側が先)。ほかは見つけた順のまま。
    /// 筐体は、先に見つかった側の位置に置く
    /// </summary>
    private static List<(string Port, It930xModel Model)> Ordered(IEnumerable<(string Port, It930xModel Model)> found, Func<string, string?>? serial)
    {
        var items = found.Select((item, index) => (item, index, Side: item.Model.Paired ? Side(serial?.Invoke(item.Port)) : null)).ToList();
        int First((string Port, It930xModel Model) item, int index, (string Enclosure, int Side)? side) => side is { } known
            ? items.Where(other => other.item.Model == item.Model && other.Side?.Enclosure == known.Enclosure).Min(other => other.index)
            : index;
        return [.. items.OrderBy(entry => First(entry.item, entry.index, entry.Side)).ThenBy(entry => entry.Side?.Side ?? 0).ThenBy(entry => entry.index).Select(entry => entry.item)];
    }

    /// <summary>
    /// 設定の <c>it930x:</c> の受信機が受けられる種別 (<c>GET /denpa/tuners</c> の <c>receivable</c>)。
    /// 機種は、最後に探したときの控え (<see cref="Found(Action{string}?)"/>) か、Linux なら sysfs から。
    /// 機種が分からない (抜いてある) ときは、どの機種かを決められないので <see cref="Types"/> の全部を返す。
    /// 機種は分かっていて、その機種に無い受信機の番号なら空。<c>it930x:</c> の形式でなければ null
    /// </summary>
    public static string[]? Receivable(string? device) => Receivable(
        device, port => Known.TryGetValue(port, out var known) ? known : OperatingSystem.IsLinux() ? Identify(UsbSysfs.Devices, port) : null);

    /// <summary>ポートから機種を調べる方法を渡す (テストのため)</summary>
    internal static string[]? Receivable(string? device, Func<string, It930xModel?> identify)
    {
        if (Parse(device) is not { } parsed) return null;
        if (identify(parsed.Port) is not { } model) return [.. Types];
        return model.Receivers.FirstOrDefault(receiver => receiver.Index == parsed.Receiver) is { } wiring ? [.. wiring.Types] : [];
    }

    /// <summary>最後に探したときの、ポートごとの機種 (<see cref="Receivable"/> が読む)</summary>
    private static readonly ConcurrentDictionary<string, It930xModel> Known = new(StringComparer.Ordinal);

    /// <summary><c>--card it930x:4-12.1</c> (内蔵のカードリーダー。受信機の番号は付けない) からポートを取る。形式が違えば null</summary>
    public static string? CardPort(string? device) =>
        Is(device) && device![Scheme.Length..] is var port && UsbSysfs.IsPort(port) ? port : null;

    /// <summary>内蔵のカードリーダー。挿さっている機材のぶん。**開くまでは何も開かない**</summary>
    public static IReadOnlyList<CardLinkCandidate> Cards() => Cards(Found(), Serial);

    /// <summary>
    /// 挿さっている機材から (渡せるのはテストのため)。カードリーダーの無い機種 (PX-MLT8PE の 3 受信機の側) は挙げない。
    /// Q3 は、シリアル番号の末尾が 1 の側だけを挙げる (px4 の仕様書 1.4。PX-Q3PE4・PX-Q3PE5 でも末尾 1 の側につながっているかは未確認。
    /// 末尾 2 の側やシリアル番号を読めない側は、<c>--card it930x:&lt;ポート&gt;</c> で名指しすれば試せる)
    /// </summary>
    internal static IReadOnlyList<CardLinkCandidate> Cards(IEnumerable<(string Port, It930xModel Model)> found, Func<string, string?>? serial = null) =>
    [
        .. found.Where(item => item.Model.Card && (!item.Model.Paired || Side(serial?.Invoke(item.Port))?.Side == 1))
            .Select(item => Card(item.Port, item.Model)),
    ];

    /// <summary>
    /// そのポートの受信機の TS を復号するときに使う、内蔵のカードリーダーのポート (<c>--tune … --decode</c>)。
    /// Q3 の末尾が 2 の側は、同じ筐体の末尾が 1 の側 (px4 の仕様書 1.4)。もう片方の側が見つからないときと、ほかの機種は、そのポート
    /// </summary>
    public static string CardHost(string port) => Side(Serial(port))?.Side == 2 && Partner(port) is { } other ? other : port;

    /// <summary>カードリーダーの名前 (<c>PLEX PX-MLT5PE 4-12.1 Card Reader</c>。画面の「使う」の設定もこの名前で持つ)</summary>
    public static string CardName(string port, It930xModel model) => $"{model.Name} {port} Card Reader";

    /// <summary>そのポートの内蔵のカードリーダー。**開くまでは何も開かない**</summary>
    public static CardLinkCandidate Card(string port, It930xModel model)
    {
        var name = CardName(port, model);
        return new CardLinkCandidate(name, () => new It930xCard(name, port));
    }

    /// <summary>
    /// 挿さっているポートと機種。**開かない。** Linux はカーネルのドライバが使っているものを並べない。
    /// 探せなければ (USB の一覧を読めない・ライブラリが無い) <paramref name="warn"/> に出して空
    /// </summary>
    public static List<(string Port, It930xModel Model)> Found(Action<string>? warn = null)
    {
        try
        {
            List<(string Port, It930xModel Model)> found;
            if (OperatingSystem.IsLinux())
            {
                found = Found(UsbSysfs.Devices, warn);
            }
            else
            {
                found = [];
                foreach (var model in Family)
                {
                    foreach (var location in UsbDevices.List(model.Vendor, model.Product))
                    {
                        found.Add((location.Port, model));
                        Paths[location.Port] = location.Path;
                    }
                }
            }
            foreach (var (port, model) in found) Known[port] = model;
            return found;
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            warn?.Invoke($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>Windows・macOS で最後に探したときの、ポートごとの OS の名前 (<see cref="UsbLocation.Path"/>)。Windows のシリアル番号はここから取る</summary>
    private static readonly ConcurrentDictionary<string, string> Paths = new(StringComparer.Ordinal);

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<(string Port, It930xModel Model)> Found(string sysfs, Action<string>? warn) =>
        UsbDevices.Scan(sysfs, dir => Identify(sysfs, Path.GetFileName(dir)), model => model.Name, warn);

    /// <summary>sysfs のそのポートの機種。扱う機種でなければ null</summary>
    internal static It930xModel? Identify(string sysfs, string port)
    {
        var dir = Path.Combine(sysfs, port);
        return Hex(UsbSysfs.Read(dir, "idVendor")) is { } vendor && Hex(UsbSysfs.Read(dir, "idProduct")) is { } product ? Find(vendor, product) : null;
    }

    /// <summary>そのポートの機種 (Linux は sysfs、Windows・macOS は OS に問い合わせる)。**開かない**</summary>
    public static It930xModel? Identify(string port) =>
        OperatingSystem.IsLinux() ? Identify(UsbSysfs.Devices, port) : Found().FirstOrDefault(item => item.Port == port).Model;

    /// <summary>
    /// そのポートの機材の USB のシリアル番号。**開かない。** 読めなければ null。
    /// Linux は sysfs の <c>serial</c>。Windows はデバイスのパス (<c>\\?\usb#vid_0511&amp;pid_024a#&lt;シリアル番号&gt;#{…}</c>) の 3 つ目の区切り
    /// (シリアル番号の無い機材は、ここに <c>&amp;</c> を含む OS が作った名前が入る)。Windows の読み方は実機で確かめていない。macOS は読まない
    /// </summary>
    public static string? Serial(string port)
    {
        if (OperatingSystem.IsLinux()) return SysfsSerial(UsbSysfs.Devices, port);
        if (!OperatingSystem.IsWindows()) return null;
        if (!Paths.ContainsKey(port)) Found();
        return Paths.TryGetValue(port, out var path) ? WindowsSerial(path) : null;
    }

    /// <summary>sysfs の <c>serial</c> (場所を渡せるのはテストのため)</summary>
    internal static string? SysfsSerial(string sysfs, string port) =>
        UsbSysfs.Read(Path.Combine(sysfs, port), "serial") is { Length: > 0 } serial ? serial : null;

    /// <summary>Windows のデバイスのパスからシリアル番号。無ければ null</summary>
    internal static string? WindowsSerial(string path) =>
        path.Split('#') is [_, _, var serial, ..] && serial.Length > 0 && !serial.Contains('&') ? serial : null;

    /// <summary>
    /// Q3 のシリアル番号を、筐体の番号 (先頭の 14 桁) と側 (末尾の 1 桁。1 か 2) に分ける (px4 の仕様書 1.5)。
    /// 10 進の数字 15 桁でないか、末尾が 1 でも 2 でもなければ null
    /// </summary>
    internal static (string Enclosure, int Side)? Side(string? serial) =>
        serial is { Length: 15 } && serial.All(char.IsAsciiDigit) && serial[14] is '1' or '2' ? (serial[..14], serial[14] - '0') : null;

    /// <summary>
    /// Q3 の、同じ筐体のもう片方の側のポート (px4 の仕様書 1.5)。Q3 でない・自分のシリアル番号が読めない・相手が見つからないときは null。
    /// 同じ筐体の番号で同じ側の USB デバイスが 2 つ以上見えたら、どれも選ばない
    /// </summary>
    public static string? Partner(string port) =>
        Found() is var found && found.FirstOrDefault(item => item.Port == port).Model is { } model ? Partner(port, model, found, Serial) : null;

    /// <summary>挿さっている機材とシリアル番号の読み方を渡す (テストのため)</summary>
    internal static string? Partner(string port, It930xModel model, IEnumerable<(string Port, It930xModel Model)> found, Func<string, string?> serial)
    {
        if (!model.Paired || Side(serial(port)) is not { } own) return null;
        var others = found
            .Where(item => item.Port != port && item.Model == model && Side(serial(item.Port)) is { } other && other.Enclosure == own.Enclosure && other.Side != own.Side)
            .Select(item => item.Port)
            .ToList();
        return others.Count == 1 ? others[0] : null;
    }

    private static int? Hex(string? text) =>
        int.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value) ? value : null;

    /// <summary>
    /// 開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)。インターフェース 0 を確保する。
    /// ほかのソフトが使っていれば、OS の理由のまま失敗する
    /// </summary>
    public static IUsbDevice OpenUsb(string port, It930xModel model) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, UsbSysfs.DevUsb, port, model.Vendor, model.Product, selectAlternate: false)
            : UsbDevices.Open(port, model.Vendor, model.Product);
}
