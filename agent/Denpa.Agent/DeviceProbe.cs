using System.Text;

namespace Denpa.Agent;

/// <summary>
/// 繋いであるチューナーを自分で見つける。**設定を書かなくてよくする。**
///
/// <para>
/// 台数はデバイスの数を数えれば分かるが、**種別 (地上波か衛星か) はどこにも
/// 書かれていない。** sysfs には出ておらず (実機で確認: `dev` `device` `power`
/// `subsystem` `uevent` しか無く、4 つとも同じ PCI デバイスの下にぶら下がる)。
/// ioctl で問い合わせるしかない。
/// </para>
///
/// <para>
/// 数と並びは実機 (PT3 / `earth_pt3` / Ubuntu 24.04) で測った値。
/// </para>
///
/// <code>
/// sizeof dvb_frontend_info = 168   FE_GET_INFO     = 0x80a86f3d
/// sizeof dtv_property      =  76   FE_GET_PROPERTY = 0x80106f53
/// sizeof dtv_properties    =  16   DTV_ENUM_DELSYS = 44
/// u.buffer.data @16   u.buffer.len @48
///
/// adapter0 "Toshiba TC90522 ISDB-S module" delsys=[9]
/// adapter1 "Toshiba TC90522 ISDB-T module" delsys=[8]
/// </code>
/// </summary>
public static class DeviceProbe
{
    // linux/dvb/frontend.h。実機で測った値をそのまま置く
    private const uint FeGetInfo = 0x80a86f3d;
    private const uint DtvEnumDelsys = 44;

    private const int FrontendInfoSize = 168;
    private const int BufferLenAt = 48;
    private const int NameLength = 128;

    /// <summary>
    /// 受けられる方式から、見つけたときに選んでおく denpa の種別に直す。
    ///
    /// <para>
    /// ISDB-S は BS と CS の両方に使う (どちらも同じ復調)。DVB-C (J.83 Annex C・Annex A) は種別にせず、受けられる種別にだけ入れる (<see cref="ReceivableFor"/>)。
    /// ほかの方式は種別にしない
    /// </para>
    /// </summary>
    public static string[] TypesFor(IEnumerable<int> delivery) =>
    [
        .. delivery.SelectMany(system => system switch
        {
            ChannelTable.SysIsdbt => ["GR"],
            ChannelTable.SysIsdbs => ["BS", "CS"],
            _ => Array.Empty<string>(),
        }).Distinct(),
    ];

    /// <summary>
    /// 受けられる方式から、受けられる種別 (<c>GET /denpa/tuners</c> の <c>receivable</c>) に直す。<see cref="TypesFor"/> に、
    /// DVB-C で ISDB-C を選局できる (<see cref="CableSystem"/>) なら <c>CATV</c> を足す。
    ///
    /// <para>
    /// **<c>CATV</c> は見つけたときには選ばない。** <c>it930x:</c> の受信機と同じく、ケーブルテレビの回線を繋いだ人が設定で選ぶ
    /// (選んでおくと、チャンネルスキャンに <c>CATV</c> の 113 チャンネルが足される)。Annex A で ISDB-C を受けられるかは実機で確かめていない
    /// </para>
    /// </summary>
    public static string[] ReceivableFor(IReadOnlyCollection<int> delivery) =>
        [.. TypesFor(delivery), .. CableSystem(delivery) is null ? Array.Empty<string>() : [ChannelTable.Catv]];

    /// <summary>
    /// ISDB-C (64QAM・5.274 Mbaud) を選局するときに DVB の機材へ渡す方式。<c>SYS_DVBC_ANNEX_C</c> があればそれ、
    /// 無く <c>SYS_DVBC_ANNEX_A</c> があればそれ、どちらも無ければ null。
    /// Annex A はロールオフが 0.15 で、ISDB-C (Annex C) の 0.13 と違うので、受けられるかは機材による
    /// </summary>
    public static int? CableSystem(IReadOnlyCollection<int> delivery) =>
        delivery.Contains(ChannelTable.SysDvbcAnnexC) ? ChannelTable.SysDvbcAnnexC
        : delivery.Contains(ChannelTable.SysDvbcAnnexA) ? ChannelTable.SysDvbcAnnexA
        : null;

    /// <summary>
    /// 名前からの当てずっぽう。**ioctl が方式を返さなかったときだけ。**
    ///
    /// <para>
    /// 実機の名前は "Toshiba TC90522 ISDB-S module"。方式が名前に入っている
    /// ドライバは多いが、入っていないものもあるので当てにはしない。
    /// </para>
    /// </summary>
    public static string[] TypesFromName(string name)
    {
        var upper = name.ToUpperInvariant();
        if (upper.Contains("ISDB-T") || upper.Contains("ISDBT")) return ["GR"];
        if (upper.Contains("ISDB-S") || upper.Contains("ISDBS")) return ["BS", "CS"];
        return [];
    }

    /// <summary>`dvb_frontend_info.name` は先頭 128 バイト、NUL で終わる</summary>
    public static string ParseName(ReadOnlySpan<byte> info)
    {
        var end = info[..NameLength].IndexOf((byte)0);
        return Encoding.UTF8.GetString(info[..(end < 0 ? NameLength : end)]);
    }

    /// <summary>`dtv_property.u.buffer` から方式の並びを取り出す</summary>
    public static int[] ParseDelivery(ReadOnlySpan<byte> property)
    {
        var length = (int)BitConverter.ToUInt32(property[BufferLenAt..]);
        if (length is <= 0 or > 32) return [];
        return [.. property.Slice(DvbTuner.PropertyDataAt, length).ToArray().Select(value => (int)value)];
    }

    /// <summary>開いたフロントエンドに、受けられる方式を <c>DTV_ENUM_DELSYS</c> で問い合わせる。答えなければ空 (<see cref="DvbTuner"/> も使う)</summary>
    internal static unsafe int[] Delivery(int fd)
    {
        // struct dtv_properties { u32 num; struct dtv_property *props; } に、DTV_ENUM_DELSYS を 1 つ
        var property = new byte[DvbTuner.PropertySize];
        BitConverter.TryWriteBytes(property, DtvEnumDelsys);
        var header = new byte[16];
        BitConverter.TryWriteBytes(header, 1u);
        fixed (byte* props = property)
        fixed (byte* headerAt = header)
        {
            BitConverter.TryWriteBytes(header.AsSpan(8), (long)props);
            return Sys.Ioctl(fd, DvbTuner.FeGetProperty, (nint)headerAt) >= 0 ? ParseDelivery(property) : [];
        }
    }

    /// <summary>見つけたときに選んでおく種別と、受けられる種別</summary>
    private static unsafe (string[] Types, string[] Receivable) Ask(string device)
    {
        var fd = Sys.Open(device, Sys.ReadOnly | Sys.NonBlocking | Sys.CloseOnExec);
        if (fd < 0) return ([], []);
        try
        {
            var delivery = Delivery(fd);
            if (ReceivableFor(delivery) is { Length: > 0 } receivable) return (TypesFor(delivery), receivable);

            // 方式を返さないドライバもある。名前から推定する
            var info = new byte[FrontendInfoSize];
            fixed (byte* infoAt = info)
            {
                if (Sys.Ioctl(fd, FeGetInfo, (nint)infoAt) < 0) return ([], []);
            }
            var types = TypesFromName(ParseName(info));
            return (types, types);
        }
        finally
        {
            Sys.Close(fd);
        }
    }

    /// <summary>
    /// 見つけた DVB のフロントエンドを、設定に書いたのと同じ形式にする。受けられる種別が無ければ null。
    /// **ケーブル (<c>CATV</c>) しか受けられないものは、<c>CATV</c> を選んで「使う」をオフにして並べる。**
    /// <see cref="ReceivableFor"/> と同じく、使うかはケーブルテレビの回線を繋いだ人が設定で決める (種別は空にできないので <c>CATV</c> を選んでおく)
    /// </summary>
    internal static TunerSpec? Frontend(string name, string device, string[] types, string[] receivable) =>
        types.Length > 0 ? new TunerSpec(name, types, false, device)
        : receivable.Contains(ChannelTable.Catv) ? new TunerSpec(name, [ChannelTable.Catv], true, device)
        : null;

    /// <summary>
    /// 見つかった機材を、設定に書いたのと同じ形式にして返す。
    ///
    /// <para>
    /// 分かるのは**デバイスと受けられる方式**だけ。LNB を足したい・1 台だけ
    /// 止めたい、は人にしか決められないので、そこは画面から書いてもらう
    /// (書いてあればそちらを使う)。
    /// </para>
    /// </summary>
    public static List<TunerSpec> Detect()
    {
        var found = new List<TunerSpec>();
        var cable = new List<string>();
        foreach (var adapter in Directories("/dev/dvb", "adapter*"))
        {
            foreach (var frontend in Files(adapter, "frontend*"))
            {
                var (types, receivable) = Ask(frontend);
                if (Frontend(Path.GetFileName(adapter), frontend, types, receivable) is not { } spec) continue;
                found.Add(spec);
                if (receivable.Contains(ChannelTable.Catv)) cable.Add(frontend);
            }
        }

        /*
         * Siano の機材 (PX-S1UD など) は、**どのドライバにも繋がっていないものだけ。**
         * smsusb が使っていれば上の /dev/dvb で見つかっている (Siano.cs)
         */
        found.AddRange(Siano.Detect());

        /*
         * asicen-userland の機材 (PX-W3U3 など。試験的)。配布物が無ければ何もしない (Asicen.cs)。
         * ファームウェア待ちのものには、ここで流し込んでから並べる
         */
        found.AddRange(AsicenUserland.Detect());

        /*
         * Sony CECH-ZD1 J は並べるだけで開かない (開くとブリッジの起動もしてしまう)。並べ方は OS ごとで、IUsbHost に任せる (Zd1j.cs)
         */
        found.AddRange(Zd1j.Detect());

        /*
         * PIXELA PIX-DT295 も並べるだけで開かない (開くと機材に設定を書く。Dt295.cs)
         */
        found.AddRange(Dt295.Detect());

        /*
         * IT930x の機材 (PX-MLT5・PX-Q3・PX-W3 系など) も並べるだけで開かない (開くとファームウェアを起動して電源を入れる) (It930x.cs)
         */
        found.AddRange(It930x.Detect());

        Remember(found, cable);
        return found;
    }

    /// <summary>最後に見つけた機材 (デバイス → 受けられる種別)。<see cref="Receivable"/> が読む</summary>
    private static volatile IReadOnlyDictionary<string, string[]> _found = new Dictionary<string, string[]>(StringComparer.Ordinal);

    /// <summary>
    /// 見つけた機材を控える。同じデバイスが 2 度出たら最初のもの。
    /// <paramref name="cable"/> は、ケーブル (<c>CATV</c>) も受けられる DVB のフロントエンド (見つけたときの種別には入れていない。<see cref="ReceivableFor"/>)
    /// </summary>
    internal static void Remember(IEnumerable<TunerSpec> found, IEnumerable<string>? cable = null)
    {
        var withCable = (cable ?? []).ToHashSet(StringComparer.Ordinal);
        _found = found
            .Where(spec => spec.Device is not null)
            .GroupBy(spec => spec.Device!, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => withCable.Contains(group.Key) ? group.First().Types.Append(ChannelTable.Catv).Distinct().ToArray() : group.First().Types,
                StringComparer.Ordinal);
    }

    /// <summary>
    /// 機材が受けられる種別。**最後に <see cref="Detect"/> したときに見つけた機材と、設定の <c>it930x:</c> の受信機だけ**で、ほかは null (分からない)。
    /// DVB のフロントエンドは、DVB-C で ISDB-C を選局できれば <c>CATV</c> も入る (<see cref="ReceivableFor"/>)。
    /// <c>it930x:</c> の受信機は、機種の表から受信機ごとの種別を返す (<see cref="It930x.Receivable"/>。抜いてあって機種が分からなければ、地上波・衛星・ISDB-C・J.83B の全部)。
    ///
    /// <para>
    /// <c>GET /denpa/tuners</c> の <c>receivable</c> に入れ、denpa はこれに無い種別を設定で選ばせず、保存でも断る。
    /// 定義の <c>types</c> は画面から書き換えられるので、BS/CS 専用の受信機に GR を入れて保存でき、
    /// その台に割り振られた地上波の選局が受信機の確認 (<see cref="UserlandReceiver.Check"/>) で全部断られていた (#2386)
    /// </para>
    /// </summary>
    public static string[]? Receivable(string? device) =>
        It930x.Receivable(device) is { } own ? own
        : device is not null && _found.TryGetValue(device, out var types) ? types : null;

    private static IEnumerable<string> Directories(string root, string pattern)
    {
        if (!Directory.Exists(root)) return [];
        return Directory.EnumerateDirectories(root, pattern).Order(StringComparer.Ordinal);
    }

    private static IEnumerable<string> Files(string root, string pattern)
    {
        if (!Directory.Exists(root)) return [];
        return Directory.EnumerateFiles(root, pattern).Order(StringComparer.Ordinal);
    }
}
