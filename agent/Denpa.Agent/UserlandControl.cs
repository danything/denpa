using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// 常駐 (asicend) の制御ソケット 1 本 (px4-userland の SPEC 6 節の portable IPC を、asicen-userland が取り込んだもの)。
/// **カード (UserlandCard.cs) も受信機 (UserlandTuner) もここで通信する。**
///
/// <para>
/// ソケットは <c>&lt;ランタイムディレクトリ&gt;/asicen-userland/&lt;筐体の名前&gt;/control.sock</c> (<see cref="UserlandWire"/>)。
/// 1 本の接続で送れる要求は同時に 1 つだけ (SPEC 6.2)。順番は使う側が守る。
/// 接続を閉じれば、その接続で取ったもの (受信機の lease・カードの handle) は常駐が返す。
/// </para>
/// </summary>
internal sealed class UserlandControl : IDisposable
{
    public const ushort Hello = 0x0001;
    public const ushort Acquire = 0x0020;
    public const ushort Release = 0x0021;
    public const ushort Tune = 0x0022;
    public const ushort StartStream = 0x0023;
    public const ushort StopStream = 0x0024;
    public const ushort Stats = 0x0025;
    public const ushort CardConnect = 0x0031;
    public const ushort CardDisconnect = 0x0033;
    public const ushort CardReset = 0x0034;
    public const ushort CardTransmit = 0x0035;
    public const ushort AttachStream = 0x0040;
    public const ushort TsData = 0x8040;
    public const ushort StreamEnd = 0x80ff;

    /// <summary>HELLO で要求する機能: STATS を使う (SPEC 6.4 の capability bit 2)</summary>
    public const uint StreamStatsCapability = 1 << 2;

    public const ushort ResponseFlag = 1 << 0;
    public const ushort ErrorFlag = 1 << 1;

    public const int HeaderSize = 20;
    public const int MaxPayload = 65536;

    /// <summary>TS_DATA だけはこの長さまで来る (SPEC 6.2)</summary>
    public const int MaxTsPayload = 1_048_596;

    private readonly Socket _socket;
    private readonly TimeSpan _timeout;
    private readonly UserlandWire _wire;
    private uint _requestId;

    /// <summary>いまソケットに設定してある受信の上限 (ms)</summary>
    private int _receiveTimeout;

    /// <summary>HELLO で要求して、常駐が認めた機能 (要求したものと向こうが持つものの積)</summary>
    public uint Capabilities { get; private set; }

    private UserlandControl(Socket socket, TimeSpan timeout, UserlandWire wire)
    {
        _socket = socket;
        _timeout = timeout;
        _wire = wire;
        _receiveTimeout = (int)timeout.TotalMilliseconds;
    }

    /// <summary>筐体ごとのソケットの場所。<paramref name="name"/> は <c>control.sock</c> か <c>stream.sock</c></summary>
    public static string Endpoint(string runtimeDir, string id, string name, UserlandWire? wire = null) =>
        Path.Combine(runtimeDir, (wire ?? UserlandWire.Asicen).Product, id, name);

    /// <summary>
    /// 繋いで HELLO まで済ませる。**繋がらなければ「常駐に繋がりません」で投げる。**
    /// <paramref name="timeout"/> は 1 回のやり取りを待つ上限 (長く待つものは <see cref="Request"/> に渡す)
    /// </summary>
    public static UserlandControl Connect(string socketPath, uint capabilities, TimeSpan timeout, UserlandWire? wire = null)
    {
        wire ??= UserlandWire.Asicen;
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = (int)timeout.TotalMilliseconds,
            ReceiveTimeout = (int)timeout.TotalMilliseconds,
        };
        var control = new UserlandControl(socket, timeout, wire);
        try
        {
            ConnectWithin(socket, socketPath, timeout, wire);

            // v1.0 だけを送る。**常駐はバージョンを厳密に比べる** (SPEC 6.4) ので幅は持たせない
            var hello = new byte[12];
            BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(2), 0);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(4), 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(6), 0);
            BinaryPrimitives.WriteUInt32LittleEndian(hello.AsSpan(8), capabilities);
            var answer = control.Request(Hello, hello);
            if (answer.Length != 8) throw new IOException($"{wire.Daemon} の HELLO の応答が {answer.Length} バイトです (8 のはず)");
            control.Capabilities = BinaryPrimitives.ReadUInt32LittleEndian(answer.AsSpan(4));
            return control;
        }
        catch (Exception error)
        {
            socket.Dispose();
            throw error as IOException ?? new IOException($"{wire.Daemon} に繋がりません ({socketPath}: {error.Message})", error);
        }
    }

    /// <summary>
    /// 繋ぐ。**上限つきで。** Socket.Connect は待つ上限を持たず、常駐が受け付けなくなって
    /// 待ち行列が埋まると戻らない (選局のロックを握ったまま止まる)。間に合わなければ投げる
    /// (ソケットは呼んだ側が閉じる)
    /// </summary>
    public static void ConnectWithin(Socket socket, string socketPath, TimeSpan timeout, UserlandWire? wire = null)
    {
        var daemon = (wire ?? UserlandWire.Asicen).Daemon;
        var connecting = socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath));
        try
        {
            if (!connecting.Wait(timeout)) throw new IOException($"{daemon} が {timeout.TotalSeconds:F0} 秒以内に受け付けません ({socketPath})");
        }
        catch (AggregateException error) when (error.InnerException is { } inner)
        {
            throw inner is SocketException ? new IOException($"{daemon} に繋がりません ({socketPath}: {inner.Message})", inner) : inner;
        }
    }

    /// <summary>
    /// 1 つ送って応答を 1 つ受ける (SPEC 6.2)。**失敗は全部 <see cref="IOException"/> にする。**
    /// 常駐がエラーを返したときは <see cref="UserlandError"/> (理由の番号つき)、接続が切れた・崩れたときは
    /// ただの IOException。<paramref name="timeout"/> は同期を待つ TUNE のように長く待つときだけ
    /// </summary>
    public byte[] Request(ushort type, ReadOnlySpan<byte> payload, TimeSpan? timeout = null)
    {
        var id = ++_requestId;
        if (id == 0) id = _requestId = 1;

        try
        {
            /*
             * **変わるときだけ設定する。** macOS は相手が閉じたソケットの setsockopt を EINVAL で断り、
             * 本当の理由 (相手が閉じた) が「InvalidArgument」に化ける
             */
            var wait = (int)(timeout ?? _timeout).TotalMilliseconds;
            if (_receiveTimeout != wait) _socket.ReceiveTimeout = _receiveTimeout = wait;
            SendAll(_socket, Encode(type, 0, id, payload, _wire));

            var (answered, flags, answeredId, body) = ReadFrame(_socket, MaxPayload, _wire);
            // イベントは要求していない (HELLO で EVENTS を立てない) ので、来るのは応答だけのはず
            if ((flags & ResponseFlag) == 0 || answered != type || answeredId != id)
            {
                throw new IOException($"{_wire.Daemon} から要求していない応答が来ました (型 0x{answered:x4}、番号 {answeredId})");
            }
            if ((flags & ErrorFlag) != 0) throw Failed(body, _wire);
            return body;
        }
        catch (SocketException error)
        {
            throw new IOException($"{_wire.Daemon} とのやり取りに失敗しました ({error.SocketErrorCode})", error);
        }
    }

    /// <summary>先頭に u64 (lease や handle) を置いた中身。残りは 0</summary>
    public static byte[] WithId(ulong id, int length = 8)
    {
        var payload = new byte[length];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, id);
        return payload;
    }

    /// <summary>フレーム 1 つぶんのバイト列 (20 バイトのヘッダ + 中身)</summary>
    public static byte[] Encode(ushort type, ushort flags, uint requestId, ReadOnlySpan<byte> payload, UserlandWire? wire = null)
    {
        var frame = new byte[HeaderSize + payload.Length];
        (wire ?? UserlandWire.Asicen).Magic.CopyTo(frame, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(4), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6), 0);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8), type);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(10), flags);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(12), requestId);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(16), (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    /// <summary>Send は求めた長さより少なく送って返ることがある。送り切るまで回す</summary>
    public static void SendAll(Socket socket, ReadOnlySpan<byte> bytes)
    {
        for (var sent = 0; sent < bytes.Length;) sent += socket.Send(bytes[sent..]);
    }

    /// <summary>
    /// 1 枚読む。**長さは受ける前に見る** (崩れた長さのまま確保しない)。
    /// ヘッダが崩れている・バージョンが違う・途中で切れた、は IOException
    /// </summary>
    public static (ushort Type, ushort Flags, uint RequestId, byte[] Payload) ReadFrame(
        Socket socket, int maxPayload, UserlandWire? wire = null)
    {
        wire ??= UserlandWire.Asicen;
        Span<byte> header = stackalloc byte[HeaderSize];
        var (type, flags, requestId, length) = ReadHeader(socket, header, maxPayload, wire);
        var body = new byte[length];
        Receive(socket, body, wire);
        return (type, flags, requestId, body);
    }

    /// <summary>
    /// フレームのヘッダ (<see cref="HeaderSize"/> バイト) だけ読んで確かめる。中身 (<c>Length</c> バイト) はまだソケットに残っている。
    /// TS_DATA は中身を呼んだ側のバッファに直に受ける (<see cref="UserlandStream"/>。フレームごとに byte[] を作らない)
    /// </summary>
    public static (ushort Type, ushort Flags, uint RequestId, int Length) ReadHeader(
        Socket socket, Span<byte> header, int maxPayload, UserlandWire wire)
    {
        header = header[..HeaderSize];
        Receive(socket, header, wire);
        if (!header[..4].SequenceEqual(wire.Magic))
        {
            throw new IOException($"{wire.Daemon} の応答のヘッダが {Encoding.ASCII.GetString(wire.Magic)} ではありません");
        }
        var major = BinaryPrimitives.ReadUInt16LittleEndian(header[4..]);
        var minor = BinaryPrimitives.ReadUInt16LittleEndian(header[6..]);
        if (major != 1 || minor != 0) throw new IOException($"{wire.Daemon} の IPC のバージョンが {major}.{minor} です (1.0 のはず)");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header[16..]);
        if (length > maxPayload) throw new IOException($"{wire.Daemon} の応答が長すぎます ({length} バイト)");
        return (
            BinaryPrimitives.ReadUInt16LittleEndian(header[8..]),
            BinaryPrimitives.ReadUInt16LittleEndian(header[10..]),
            BinaryPrimitives.ReadUInt32LittleEndian(header[12..]),
            (int)length);
    }

    /// <summary>
    /// 読み切る。**上限 (ReceiveTimeout) があるときは Poll で待ってから読む。**
    ///
    /// <para>
    /// <see cref="ConnectWithin"/> の ConnectAsync で、.NET はソケットを内部で非ブロッキングにする。
    /// そのあとの同期の Receive は .NET の epoll の待ち受けから通知を受ける作りで、その通知がスレッド
    /// プールに回ると、プールが塞がっている間は**応答が届いていても戻らない** (CI で、28 バイトの応答が
    /// 受信バッファにあるまま 4 秒の上限で TimedOut になった)。Poll は poll(2) を直に呼ぶのでプールに
    /// 依存しない。読めると分かってから読めば Receive は待たずに返る
    /// </para>
    /// </summary>
    internal static void Receive(Socket socket, Span<byte> into, UserlandWire wire)
    {
        var limit = socket.ReceiveTimeout;
        while (into.Length > 0)
        {
            if (limit > 0 && !socket.Poll(TimeSpan.FromMilliseconds(limit), SelectMode.SelectRead))
            {
                throw new SocketException((int)SocketError.TimedOut);
            }
            var got = socket.Receive(into);
            if (got == 0) throw new IOException($"{wire.Daemon} が接続を閉じました");
            into = into[got..];
        }
    }

    /// <summary>
    /// エラーの応答 (SPEC 6.2 / 6.5)。<c>u32 error_code, u16 detail_length, detail</c>。
    /// **理由は画面に出る** ので、番号の名前に日本語を添える
    /// </summary>
    public static UserlandError Failed(byte[] body, UserlandWire? wire = null)
    {
        var daemon = (wire ?? UserlandWire.Asicen).Daemon;
        if (body.Length < 6) return new UserlandError(UserlandError.Unknown, $"{daemon} がエラーを返しました (中身が読めません)");
        var code = BinaryPrimitives.ReadUInt32LittleEndian(body);
        var detailLength = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(4));
        var detail = body.Length >= 6 + detailLength ? Encoding.UTF8.GetString(body, 6, detailLength) : "";
        var reason = Reason(code);
        return new UserlandError(code, detail.Length > 0 ? $"{daemon}: {reason}: {detail}" : $"{daemon}: {reason}");
    }

    /// <summary>エラーの番号の意味 (SPEC 6.5)。STREAM_END の理由にも使う</summary>
    public static string Reason(uint code) => code switch
    {
        1 => "要求の内容が合っていません (INVALID_ARGUMENT)",
        2 => "IPC のバージョンが合いません (VERSION_MISMATCH)",
        3 => "見つかりません (NOT_FOUND)",
        4 => "他が使っています (BUSY)",
        5 => "まだ用意ができていません (NOT_READY)",
        6 => "時間切れ (TIMEOUT)",
        7 => "USB の読み書きに失敗しました (USB_IO)",
        8 => "筐体が抜けました (DISCONNECTED)",
        9 => "やり取りが崩れました (PROTOCOL_ERROR)",
        10 => "ファームウェアを受け付けません (FIRMWARE_REJECTED)",
        11 => "この筐体では使えません (UNSUPPORTED)",
        12 => "カードが挿さっていません (NO_CARD)",
        13 => "カードが抜かれました (CARD_REMOVED)",
        15 => "読むのが追いつかず切られました (SLOW_CONSUMER)",
        255 => "デーモンの中で失敗しました (INTERNAL)",
        _ => $"エラー {code}",
    };

    public void Dispose() => _socket.Dispose();

    public bool Connected => _socket.Connected;
}

/// <summary>
/// 通信するデーモン。フレームのヘッダ (magic) とソケットの置き場を決める。
///
/// <para>
/// asicen-userland は px4-userland の portable IPC をそのまま取り込み、ヘッダの magic を <c>ASCN</c>、置き場を
/// <c>&lt;ランタイム&gt;/asicen-userland/&lt;instance&gt;/</c> に変えている (上流の docs/cli-adaptation.md と
/// userland/include/asicen/product_profile.h)。混線させないために分けてあるので、取り違えると
/// 最初のフレームのヘッダで断られる。
/// </para>
/// </summary>
public sealed record UserlandWire(byte[] Magic, string Product, string Daemon)
{
    public static readonly UserlandWire Asicen = new("ASCN"u8.ToArray(), "asicen-userland", "asicend");
}

/// <summary>常駐がエラーを返した (SPEC 6.5)。**分岐は番号で** (文言は診断用)</summary>
internal sealed class UserlandError(uint code, string message) : IOException(message)
{
    public const uint InvalidArgument = 1;
    public const uint NotFound = 3;
    public const uint Busy = 4;
    public const uint NotReady = 5;
    public const uint Timeout = 6;
    public const uint UsbIo = 7;
    public const uint Disconnected = 8;
    public const uint SlowConsumer = 15;
    public const uint Unknown = uint.MaxValue;

    public uint Code { get; } = code;
}

/// <summary>
/// 常駐が数えている TS の数 (SPEC 6.4 の STATS・STOP_STREAM・STREAM_END の final counters)。
/// <c>u64 packets, bytes, sync_errors, tei_packets, continuity_errors, queue_drops, usb_errors, empty_intervals</c>。
///
/// <para>
/// **画面で途切れたときに、受信機の側で落ちていたのかを見分けるため** (#1210)。届き方の揺れなら
/// ここは増えず、取りこぼし (電波・USB・溢れ) なら増える。<c>empty_intervals</c> は正常なときも増える
/// 診断値 (SPEC) なので見ない。
/// </para>
/// </summary>
internal readonly record struct UserlandCounters(
    ulong Packets, ulong Bytes, ulong SyncErrors, ulong TeiPackets, ulong ContinuityErrors, ulong QueueDrops, ulong UsbErrors)
{
    /// <summary>中身の長さ (u64 × 8)</summary>
    public const int Size = 64;

    /// <summary>読む。短ければ null (バージョンの違うデーモン。止めずに見送る)</summary>
    public static UserlandCounters? Parse(ReadOnlySpan<byte> body)
    {
        if (body.Length < Size) return null;
        Span<ulong> values = stackalloc ulong[7];
        for (var i = 0; i < values.Length; i++) values[i] = BinaryPrimitives.ReadUInt64LittleEndian(body[(i * 8)..]);
        return new UserlandCounters(values[0], values[1], values[2], values[3], values[4], values[5], values[6]);
    }

    /// <summary>
    /// 前回から増えた誤りを 1 行にする。**増えていなければ null** (記録を埋めない)。
    /// <paramref name="before"/> が null なら 0 から数える。数え直された (前より減った) ものは今の値をそのまま増えた分とみなす
    /// </summary>
    public static string? Describe(UserlandCounters? before, UserlandCounters now)
    {
        var was = before ?? default;
        static ulong Grew(ulong from, ulong to) => to >= from ? to - from : to;
        var parts = new (string Label, ulong Was, ulong Now)[]
        {
            ("キュー溢れ", was.QueueDrops, now.QueueDrops),
            ("連続性エラー", was.ContinuityErrors, now.ContinuityErrors),
            ("同期エラー", was.SyncErrors, now.SyncErrors),
            ("TEI", was.TeiPackets, now.TeiPackets),
            ("USB エラー", was.UsbErrors, now.UsbErrors),
        }
            .Where(part => Grew(part.Was, part.Now) > 0)
            .Select(part => $"{part.Label} +{Grew(part.Was, part.Now)} (計 {part.Now})")
            .ToArray();
        return parts.Length == 0 ? null : string.Join("、", parts);
    }
}
