using System.Buffers.Binary;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// **LAN の denpa に、このエージェントを mDNS (DNS-SD) で知らせる** (docs/agent.md「LAN で見つける」)。
/// denpa は見つけたものを「エージェントを追加」の候補に出し、登録したエージェントのアドレスが変わったら付け替える。
///
/// <para>
/// 知らせるのはサービスの型 <c>_denpa-agent._tcp</c> と <c>AGENT_PORT</c>、TXT の <c>v=1</c>・<c>id</c> (証明書の指紋の先頭 16 字)・<c>name</c> だけ。
/// **合言葉・カード・組んでいるかは入れない。** 指紋は TLS の段で誰にでも見える証明書のものなので、知らせても新しく分かることは無い。
/// 組むには今どおり登録用の URL (合言葉入り) が要る。
/// </para>
///
/// <para>
/// 知らせ方は OS ごと。Mac は <c>DNSServiceRegister</c> (mDNSResponder)、Windows は <c>DnsServiceRegister</c> (Windows 10 1809 から)、
/// Linux は自前の応答 (<see cref="MdnsResponder"/>)。Android は Wi-Fi でマルチキャストを受けるのにアプリの MulticastLock が要るので、アプリが <c>NsdManager</c> で知らせる。
/// 待ち受けをループバックに絞ったとき (<c>AGENT_HOST</c>) は、LAN から繋げないので知らせない
/// </para>
/// </summary>
public static class Mdns
{
    /// <summary>サービスの型</summary>
    public const string ServiceType = "_denpa-agent._tcp";

    /// <summary>TXT の <c>v</c>。中身の決まりを変えたら上げる</summary>
    public const string TxtVersion = "1";

    /// <summary>
    /// 知らせ始める。止めるときは戻り値を <c>Dispose</c> する (Linux はさよならの応答を送る)。知らせられない OS・構成なら null
    /// </summary>
    public static IDisposable? Start(int port, string fingerprint, IPAddress? host)
    {
        if (host is not null && IPAddress.IsLoopback(host)) return null;
        // Android の子プロセス (アプリから USB を受け取っている)。知らせるのはアプリ (NsdManager)
        if (UsbHost.Brokered) return null;
        var name = About.Name;
        var id = fingerprint[..16];
        var instance = InstanceName(name, id);
        var txt = Txt(id, name);
        try
        {
            if (OperatingSystem.IsMacOS()) return MacDnsSd.Register(instance, port, txt);
            if (OperatingSystem.IsWindows()) return WindowsDnsSd.Register(instance, $"{Environment.MachineName}.local", port, id, name);
            return MdnsResponder.Start(new MdnsService(instance, $"{AgentTls.PairHost()}.local", (ushort)port, txt));
        }
        catch (Exception error) when (error is SocketException or NetworkInformationException or DllNotFoundException or EntryPointNotFoundException or InvalidOperationException)
        {
            Log.Write($"LAN に知らせられません (mDNS): {error.Message}。denpa には登録用の URL で登録できます");
            return null;
        }
    }

    /// <summary>
    /// インスタンスの名前 (1 つのラベル)。<c>名前 (指紋の先頭 8 字)</c>。同じ名前のエージェントが並んでもぶつからないよう、指紋を足す。
    /// <c>.</c> と <c>\</c> は <c>-</c> にし (ラベルの区切りにしない)、63 バイトに収まるよう名前を字の切れ目で詰める
    /// </summary>
    public static string InstanceName(string name, string id)
    {
        var suffix = $" ({id[..8]})";
        var clean = name.Replace('.', '-').Replace('\\', '-').Trim();
        var budget = 63 - Encoding.UTF8.GetByteCount(suffix);
        return Truncate(clean, budget) + suffix;
    }

    /// <summary>TXT の中身 (長さ付きの文字列を並べたもの)。<c>name</c> は 1 本 255 バイトに収まるよう詰める</summary>
    public static byte[] Txt(string id, string name)
    {
        var buffer = new List<byte>();
        foreach (var entry in new[] { $"v={TxtVersion}", $"id={id}", $"name={Truncate(name, 250)}" })
        {
            var bytes = Encoding.UTF8.GetBytes(entry);
            buffer.Add((byte)bytes.Length);
            buffer.AddRange(bytes);
        }
        return [.. buffer];
    }

    /// <summary>UTF-8 で <paramref name="bytes"/> バイトに収まるところまで (字の途中で切らない)</summary>
    private static string Truncate(string text, int bytes)
    {
        if (Encoding.UTF8.GetByteCount(text) <= bytes) return text;
        var end = 0;
        var used = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            if (used + rune.Utf8SequenceLength > bytes) break;
            used += rune.Utf8SequenceLength;
            end += rune.Utf16SequenceLength;
        }
        return text[..end];
    }
}

/// <summary>Linux の自前の応答が知らせるもの。<paramref name="Target"/> は SRV の宛先 (登録用の URL と同じ名前に <c>.local</c>)</summary>
public sealed record MdnsService(string Instance, string Target, ushort Port, byte[] Txt);

/// <summary>
/// **Linux の自前の mDNS の応答** (RFC 6762 と 6763 のうち、知らせるのに要るところだけ)。
///
/// <list type="bullet">
/// <item>UDP 5353 を <c>SO_REUSEADDR</c> で開き、全部の IPv4 のインターフェースで 224.0.0.251 に入る (avahi と並んで動ける)</item>
/// <item>答えるのは <c>_denpa-agent._tcp.local</c> の PTR、インスタンスの SRV と TXT、<c>_services._dns-sd._udp.local</c> の PTR だけ。
///   **ホストの名前の A は答えない** (avahi が同じ名前を持っていると、食い違った答えで avahi の名前が付け替わる)。denpa は応答の送り元のアドレスを使う</item>
/// <item>起動したときと、インターフェースのアドレスが変わったときに 2 回知らせる (1 秒あけて)。止めるときは TTL 0 で「さよなら」を送る</item>
/// <item>送り元のポートが 5353 でない問い (legacy unicast) には、その相手にだけ ID と問いを付けて返す (TTL は 10 秒まで)</item>
/// </list>
///
/// IPv6 は知らせない (denpa は IPv4 で受ける)。コンテナ (<c>network_mode: host</c> でないもの) では LAN に届かない
/// </summary>
public sealed class MdnsResponder : IDisposable
{
    private const int MdnsPort = 5353;
    private static readonly IPAddress Group = IPAddress.Parse("224.0.0.251");
    private static readonly IPEndPoint GroupEndPoint = new(Group, MdnsPort);
    /// <summary>インターフェースを見直す間 (アドレスの変化の通知が来ない環境のため)</summary>
    private static readonly TimeSpan Rescan = TimeSpan.FromSeconds(30);

    private readonly MdnsService service;
    private readonly Socket socket;
    private readonly CancellationTokenSource stop = new();
    private readonly Lock sendGate = new();
    /// <summary>いま入っているインターフェースの IPv4 アドレス</summary>
    private HashSet<IPAddress> joined = [];
    /// <summary>同じ答えをマルチキャストで 1 秒に 2 回送らない (RFC 6762 6 章)</summary>
    private readonly Dictionary<MdnsAnswer, long> lastMulticast = [];

    private MdnsResponder(MdnsService service, Socket socket)
    {
        this.service = service;
        this.socket = socket;
    }

    /// <summary>開いて知らせ始める。5353 を開けなければ <see cref="SocketException"/></summary>
    public static MdnsResponder Start(MdnsService service)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 255);
            socket.Bind(new IPEndPoint(IPAddress.Any, MdnsPort));
        }
        catch
        {
            socket.Dispose();
            throw;
        }
        var responder = new MdnsResponder(service, socket);
        responder.Join();
        _ = Task.Run(responder.Receive);
        _ = Task.Run(responder.Watch);
        NetworkChange.NetworkAddressChanged += responder.OnAddressChanged;
        Log.Write($"LAN に知らせます (mDNS: {service.Instance}.{Mdns.ServiceType}.local)");
        return responder;
    }

    public void Dispose()
    {
        if (stop.IsCancellationRequested) return;
        NetworkChange.NetworkAddressChanged -= OnAddressChanged;
        stop.Cancel();
        try
        {
            Multicast(MdnsMessage.Response(service, 0, null, MdnsMessage.Announcement, goodbye: true));
        }
        catch (SocketException)
        {
            // さよならが届かなくても、denpa の控えは TTL で消える
        }
        socket.Dispose();
    }

    private void OnAddressChanged(object? sender, EventArgs e) => _ = Task.Run(() => Refresh());

    /// <summary>インターフェースを見直し、変わっていれば入り直して知らせる</summary>
    private async Task Watch()
    {
        await Announce();
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(Rescan, stop.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            await Refresh();
        }
    }

    private async Task Refresh()
    {
        if (stop.IsCancellationRequested) return;
        if (Join()) await Announce();
    }

    /// <summary>知らせる (2 回。1 秒あける。RFC 6762 8.3)</summary>
    private async Task Announce()
    {
        var message = MdnsMessage.Response(service, 0, null, MdnsMessage.Announcement);
        for (var round = 0; round < 2 && !stop.IsCancellationRequested; round++)
        {
            if (round > 0)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), stop.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
            try
            {
                Multicast(message);
            }
            catch (Exception error) when (error is SocketException or ObjectDisposedException)
            {
                return;
            }
        }
    }

    /// <summary>今の IPv4 のインターフェース。動いていて、マルチキャストを通し、ループバックでないもの</summary>
    private static HashSet<IPAddress> Interfaces()
    {
        HashSet<IPAddress> found = [];
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || !nic.SupportsMulticast) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var address in nic.GetIPProperties().UnicastAddresses)
            {
                if (address.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address.Address)) found.Add(address.Address);
            }
        }
        return found;
    }

    /// <summary>新しく増えたインターフェースで 224.0.0.251 に入る。顔ぶれが変わったら true</summary>
    private bool Join()
    {
        var now = Interfaces();
        lock (sendGate)
        {
            if (now.SetEquals(joined)) return false;
            foreach (var address in now.Except(joined))
            {
                try
                {
                    socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership, new MulticastOption(Group, address));
                }
                catch (SocketException)
                {
                    // 同じインターフェースの 2 つ目のアドレス (もう入っている) か、入れないインターフェース
                }
            }
            joined = now;
            return true;
        }
    }

    /// <summary>入っている全部のインターフェースから 224.0.0.251 に送る (送り元のアドレスがそのインターフェースのものになる)</summary>
    private void Multicast(byte[] message)
    {
        lock (sendGate)
        {
            foreach (var address in joined)
            {
                try
                {
                    socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, address.GetAddressBytes());
                    socket.SendTo(message, GroupEndPoint);
                }
                catch (SocketException)
                {
                    // 消えかけのインターフェース。次の見直しで外れる
                }
            }
        }
    }

    private async Task Receive()
    {
        var buffer = new byte[9000];
        EndPoint any = new IPEndPoint(IPAddress.Any, 0);
        while (!stop.IsCancellationRequested)
        {
            SocketReceiveFromResult got;
            try
            {
                got = await socket.ReceiveFromAsync(buffer, SocketFlags.None, any, stop.Token);
            }
            catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException)
            {
                return;
            }
            catch (SocketException)
            {
                continue;
            }
            if (got.RemoteEndPoint is not IPEndPoint from) continue;
            try
            {
                Answer(buffer.AsSpan(0, got.ReceivedBytes), from);
            }
            catch (Exception error) when (error is SocketException or ObjectDisposedException)
            {
                // 返せなかった。次の問いを待つ
            }
        }
    }

    /// <summary>問いに答える。知らせているものの問いでなければ何もしない</summary>
    private void Answer(ReadOnlySpan<byte> packet, IPEndPoint from)
    {
        if (MdnsMessage.ReadQuery(packet) is not { } query) return;
        var answers = MdnsMessage.Answers(service, query.Questions);
        if (answers.Count == 0) return;
        var legacy = from.Port != MdnsPort;
        if (legacy)
        {
            socket.SendTo(MdnsMessage.Response(service, query.Id, query.Questions, answers), from);
            return;
        }
        var now = Environment.TickCount64;
        lock (sendGate)
        {
            answers = [.. answers.Where(answer => !lastMulticast.TryGetValue(answer, out var at) || now - at >= 1000)];
            foreach (var answer in answers) lastMulticast[answer] = now;
        }
        if (answers.Count > 0) Multicast(MdnsMessage.Response(service, 0, null, answers));
    }
}

/// <summary>答える記録の種類 (<see cref="MdnsMessage.Answers"/>)</summary>
public enum MdnsAnswer
{
    /// <summary><c>_denpa-agent._tcp.local</c> → インスタンス (SRV と TXT を足す)</summary>
    Browse,
    /// <summary>インスタンスの SRV</summary>
    Srv,
    /// <summary>インスタンスの TXT</summary>
    Txt,
    /// <summary><c>_services._dns-sd._udp.local</c> → <c>_denpa-agent._tcp.local</c></summary>
    Services,
}

/// <summary>mDNS の問い (1 つ)</summary>
public sealed record MdnsQuestion(string[] Name, ushort Type, ushort Class);

/// <summary>読んだ問いのパケット</summary>
public sealed record MdnsQuery(ushort Id, List<MdnsQuestion> Questions);

/// <summary>mDNS のパケットを読み書きする (<see cref="MdnsResponder"/> の中身。試験から呼ぶ)</summary>
public static class MdnsMessage
{
    private const ushort TypePtr = 12;
    private const ushort TypeTxt = 16;
    private const ushort TypeSrv = 33;
    private const ushort TypeAny = 255;
    private const ushort ClassIn = 1;
    private const ushort ClassAny = 255;
    private const ushort CacheFlush = 0x8000;
    /// <summary>ホストの名前に関わる記録 (SRV) の TTL。ほかは 75 分 (RFC 6762 10 章)</summary>
    private const uint HostTtl = 120;
    private const uint OtherTtl = 4500;
    /// <summary>legacy unicast の答えの TTL の上限 (RFC 6762 6.7)</summary>
    private const uint LegacyTtl = 10;

    private static readonly string[] ServiceName = [.. Mdns.ServiceType.Split('.'), "local"];
    private static readonly string[] ServicesName = ["_services", "_dns-sd", "_udp", "local"];

    private static string[] InstanceName(MdnsService service) => [service.Instance, .. ServiceName];

    /// <summary>問いのパケットを読む。答え (QR が立っている) や読めないものは null</summary>
    public static MdnsQuery? ReadQuery(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 12) return null;
        var id = BinaryPrimitives.ReadUInt16BigEndian(packet);
        var flags = BinaryPrimitives.ReadUInt16BigEndian(packet[2..]);
        if ((flags & 0x8000) != 0) return null;
        var count = BinaryPrimitives.ReadUInt16BigEndian(packet[4..]);
        var offset = 12;
        List<MdnsQuestion> questions = [];
        for (var index = 0; index < count; index++)
        {
            if (ReadName(packet, ref offset) is not { } name || offset + 4 > packet.Length) return null;
            var type = BinaryPrimitives.ReadUInt16BigEndian(packet[offset..]);
            var klass = BinaryPrimitives.ReadUInt16BigEndian(packet[(offset + 2)..]);
            offset += 4;
            questions.Add(new MdnsQuestion(name, type, klass));
        }
        return new MdnsQuery(id, questions);
    }

    /// <summary>問いのうち、知らせているものへの答え</summary>
    public static List<MdnsAnswer> Answers(MdnsService service, IEnumerable<MdnsQuestion> questions)
    {
        List<MdnsAnswer> answers = [];
        var instance = InstanceName(service);
        foreach (var question in questions)
        {
            if ((question.Class & 0x7fff) is not (ClassIn or ClassAny)) continue;
            var any = question.Type == TypeAny;
            if (SameName(question.Name, ServiceName) && (any || question.Type == TypePtr)) answers.Add(MdnsAnswer.Browse);
            else if (SameName(question.Name, ServicesName) && (any || question.Type == TypePtr)) answers.Add(MdnsAnswer.Services);
            else if (SameName(question.Name, instance))
            {
                if (any || question.Type == TypeSrv) answers.Add(MdnsAnswer.Srv);
                if (any || question.Type == TypeTxt) answers.Add(MdnsAnswer.Txt);
            }
        }
        return [.. answers.Distinct()];
    }

    /// <summary>起動したとき・アドレスが変わったときに知らせる記録 (PTR と、追加の欄の SRV・TXT)</summary>
    public static List<MdnsAnswer> Announcement => [MdnsAnswer.Browse];

    /// <summary>
    /// 答えのパケット。<paramref name="questions"/> を渡すのは legacy unicast (送り元が 5353 でない問い) の答えだけで、
    /// そのときは ID と問いを付け、TTL を 10 秒までにし、キャッシュを捨てる印を付けない。
    /// <see cref="MdnsAnswer.Browse"/> には SRV と TXT を追加の欄に足す。<paramref name="goodbye"/> なら TTL を 0 にする (止めるとき)
    /// </summary>
    public static byte[] Response(MdnsService service, ushort id, List<MdnsQuestion>? questions, List<MdnsAnswer> answers, bool goodbye = false)
    {
        var legacy = questions is not null;
        var writer = new Writer();
        List<MdnsAnswer> additional = answers.Contains(MdnsAnswer.Browse)
            ? [.. new[] { MdnsAnswer.Srv, MdnsAnswer.Txt }.Where(extra => !answers.Contains(extra))]
            : [];
        writer.U16(id);
        writer.U16(0x8400);
        writer.U16((ushort)(questions?.Count ?? 0));
        writer.U16((ushort)answers.Count);
        writer.U16(0);
        writer.U16((ushort)additional.Count);
        foreach (var question in questions ?? [])
        {
            writer.Name(question.Name);
            writer.U16(question.Type);
            writer.U16(question.Class);
        }
        foreach (var answer in answers.Concat(additional)) Record(writer, service, answer, legacy, goodbye);
        return writer.ToArray();
    }

    private static void Record(Writer writer, MdnsService service, MdnsAnswer answer, bool legacy, bool goodbye)
    {
        uint Ttl(uint ttl) => goodbye ? 0 : legacy ? Math.Min(ttl, LegacyTtl) : ttl;
        var unique = legacy ? (ushort)0 : CacheFlush;
        var instance = InstanceName(service);
        switch (answer)
        {
            case MdnsAnswer.Browse:
                writer.Name(ServiceName);
                writer.U16(TypePtr);
                writer.U16(ClassIn);
                writer.U32(Ttl(OtherTtl));
                writer.Data(inner => inner.Name(instance));
                break;
            case MdnsAnswer.Services:
                writer.Name(ServicesName);
                writer.U16(TypePtr);
                writer.U16(ClassIn);
                writer.U32(Ttl(OtherTtl));
                writer.Data(inner => inner.Name(ServiceName));
                break;
            case MdnsAnswer.Srv:
                writer.Name(instance);
                writer.U16(TypeSrv);
                writer.U16((ushort)(ClassIn | unique));
                writer.U32(Ttl(HostTtl));
                writer.Data(inner =>
                {
                    inner.U16(0);
                    inner.U16(0);
                    inner.U16(service.Port);
                    inner.Name(service.Target.TrimEnd('.').Split('.'));
                });
                break;
            case MdnsAnswer.Txt:
                writer.Name(instance);
                writer.U16(TypeTxt);
                writer.U16((ushort)(ClassIn | unique));
                writer.U32(Ttl(OtherTtl));
                writer.Data(inner => inner.Bytes(service.Txt));
                break;
        }
    }

    private static bool SameName(string[] a, string[] b) =>
        a.Length == b.Length && a.Zip(b).All(pair => string.Equals(pair.First, pair.Second, StringComparison.OrdinalIgnoreCase));

    /// <summary>名前を読む (圧縮を辿る。輪になっていたら null)</summary>
    public static string[]? ReadName(ReadOnlySpan<byte> packet, ref int offset)
    {
        List<string> labels = [];
        var at = offset;
        var jumped = false;
        for (var hops = 0; hops < 128; hops++)
        {
            if (at >= packet.Length) return null;
            var length = packet[at];
            if (length == 0)
            {
                if (!jumped) offset = at + 1;
                return [.. labels];
            }
            if ((length & 0xc0) == 0xc0)
            {
                if (at + 1 >= packet.Length) return null;
                if (!jumped) offset = at + 2;
                jumped = true;
                at = ((length & 0x3f) << 8) | packet[at + 1];
                continue;
            }
            if ((length & 0xc0) != 0 || at + 1 + length > packet.Length) return null;
            labels.Add(Encoding.UTF8.GetString(packet.Slice(at + 1, length)));
            at += 1 + length;
        }
        return null;
    }

    /// <summary>DNS のパケットを書く (圧縮はしない)</summary>
    private sealed class Writer
    {
        private readonly List<byte> bytes = [];

        public void U16(ushort value)
        {
            bytes.Add((byte)(value >> 8));
            bytes.Add((byte)value);
        }

        public void U32(uint value)
        {
            U16((ushort)(value >> 16));
            U16((ushort)value);
        }

        public void Bytes(byte[] value) => bytes.AddRange(value);

        public void Name(string[] labels)
        {
            foreach (var label in labels)
            {
                var encoded = Encoding.UTF8.GetBytes(label);
                bytes.Add((byte)Math.Min(encoded.Length, 63));
                bytes.AddRange(encoded.Take(63));
            }
            bytes.Add(0);
        }

        /// <summary>RDATA。長さを先に書く</summary>
        public void Data(Action<Writer> write)
        {
            var inner = new Writer();
            write(inner);
            U16((ushort)inner.bytes.Count);
            bytes.AddRange(inner.bytes);
        }

        public byte[] ToArray() => [.. bytes];
    }
}

/// <summary>
/// **Mac は mDNSResponder に任せる** (<c>DNSServiceRegister</c>)。ホストの名前は Mac の Bonjour の名前 (<c>LocalHostName.local</c>) のままで、
/// 登録用の URL の名前 (<see cref="AgentTls.PairHost"/>) と同じになる。名前がぶつかれば mDNSResponder が付け替える。
/// 返事 (callback) は受け取らない (渡さなくても登録はされ、<c>DNSServiceRefDeallocate</c> で取り下げる)
/// </summary>
internal sealed partial class MacDnsSd : IDisposable
{
    private const string LibSystem = "/usr/lib/libSystem.B.dylib";
    private nint handle;

    [LibraryImport(LibSystem, StringMarshalling = StringMarshalling.Utf8)]
    private static unsafe partial int DNSServiceRegister(nint* sdRef, uint flags, uint interfaceIndex, string name, string regtype,
        string? domain, string? host, ushort port, ushort txtLen, byte* txtRecord, nint callBack, nint context);

    [LibraryImport(LibSystem)]
    private static partial void DNSServiceRefDeallocate(nint sdRef);

    private MacDnsSd(nint handle) => this.handle = handle;

    public static unsafe MacDnsSd Register(string instance, int port, byte[] txt)
    {
        nint handle = 0;
        int error;
        fixed (byte* record = txt)
        {
            // ポートはネットワークの並び (ビッグエンディアン)
            error = DNSServiceRegister(&handle, 0, 0, instance, Mdns.ServiceType, null, null,
                (ushort)IPAddress.HostToNetworkOrder((short)port), (ushort)txt.Length, record, 0, 0);
        }
        if (error != 0) throw new InvalidOperationException($"DNSServiceRegister が {error} を返しました");
        Log.Write($"LAN に知らせます (mDNS: {instance}.{Mdns.ServiceType}.local)");
        return new MacDnsSd(handle);
    }

    public void Dispose()
    {
        var current = Interlocked.Exchange(ref handle, 0);
        if (current != 0) DNSServiceRefDeallocate(current);
    }
}

/// <summary>
/// **Windows は OS の mDNS に任せる** (<c>DnsServiceRegister</c>。Windows 10 1809 から)。ホストの名前は <c>COMPUTERNAME.local</c> で、
/// Windows が自分で答える名前と同じ。アドレスは渡さず、Windows に任せる。登録の結果は返事 (callback) で受け、失敗ならログに書く
/// </summary>
internal sealed unsafe partial class WindowsDnsSd : IDisposable
{
    private const string DnsApi = "dnsapi.dll";
    /// <summary>DNS_QUERY_REQUEST_VERSION1</summary>
    private const uint RequestVersion = 1;
    /// <summary>DNS_REQUEST_PENDING。登録を受け付けた (結果は返事で来る)</summary>
    private const uint Pending = 9506;

    /// <summary>DNS_SERVICE_REGISTER_REQUEST</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct RegisterRequest
    {
        public uint Version;
        public uint InterfaceIndex;
        public nint ServiceInstance;
        public nint Completion;
        public nint Context;
        public nint Credentials;
        public int UnicastEnabled;
    }

    [LibraryImport(DnsApi, StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint DnsServiceConstructInstance(string serviceName, string hostName, nint ip4, nint ip6,
        ushort port, ushort priority, ushort weight, uint propertiesCount, nint* keys, nint* values);

    [LibraryImport(DnsApi)]
    private static partial uint DnsServiceRegister(RegisterRequest* request, nint cancel);

    [LibraryImport(DnsApi)]
    private static partial uint DnsServiceDeRegister(RegisterRequest* request, nint cancel);

    [LibraryImport(DnsApi)]
    private static partial void DnsServiceFreeInstance(nint instance);

    /// <summary>登録と取り下げのあいだ持ち続ける要求 (OS が非同期に読む)</summary>
    private RegisterRequest* request;

    private WindowsDnsSd(RegisterRequest* request) => this.request = request;

    public static WindowsDnsSd Register(string instance, string host, int port, string id, string name)
    {
        string[] keys = ["v", "id", "name"];
        string[] values = [Mdns.TxtVersion, id, name];
        var keyPointers = stackalloc nint[keys.Length];
        var valuePointers = stackalloc nint[values.Length];
        for (var index = 0; index < keys.Length; index++)
        {
            keyPointers[index] = Marshal.StringToHGlobalUni(keys[index]);
            valuePointers[index] = Marshal.StringToHGlobalUni(values[index]);
        }
        nint service;
        try
        {
            service = DnsServiceConstructInstance($"{instance}.{Mdns.ServiceType}.local", host, 0, 0, (ushort)port, 0, 0,
                (uint)keys.Length, keyPointers, valuePointers);
        }
        finally
        {
            for (var index = 0; index < keys.Length; index++)
            {
                Marshal.FreeHGlobal(keyPointers[index]);
                Marshal.FreeHGlobal(valuePointers[index]);
            }
        }
        if (service == 0) throw new InvalidOperationException("DnsServiceConstructInstance が失敗しました");
        var request = (RegisterRequest*)NativeMemory.AllocZeroed((nuint)sizeof(RegisterRequest));
        request->Version = RequestVersion;
        request->ServiceInstance = service;
        request->Completion = (nint)(delegate* unmanaged[Stdcall]<uint, nint, nint, void>)&Completed;
        var result = DnsServiceRegister(request, 0);
        if (result != Pending)
        {
            DnsServiceFreeInstance(service);
            NativeMemory.Free(request);
            throw new InvalidOperationException($"DnsServiceRegister が {result} を返しました");
        }
        Log.Write($"LAN に知らせます (mDNS: {instance}.{Mdns.ServiceType}.local)");
        return new WindowsDnsSd(request);
    }

    /// <summary>
    /// 登録・取り下げの結果。返ってきたインスタンスは放さない (要求に入れたものと同じかが文書から読み取れず、同じなら取り下げで使えなくなる。
    /// 登録と取り下げの 1 度ずつなので、写しでも残るのは小さな 2 つだけ)
    /// </summary>
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    private static void Completed(uint status, nint context, nint instance)
    {
        if (status != 0) Log.Write($"LAN に知らせられませんでした (DnsServiceRegister: {status})。denpa には登録用の URL で登録できます");
    }

    public void Dispose()
    {
        var current = request;
        if (current == null) return;
        request = null;
        DnsServiceDeRegister(current, 0);
        // 要求とインスタンスは、取り下げの返事が来るまで OS が読むので放さない (止めるときに 1 度だけ)
    }
}
