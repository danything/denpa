using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// px4d の制御ソケット1本 (px4-userland SPEC 6 節の portable IPC)。
/// **カード (Px4Card.cs) も受信機 (Px4Tuner) もここで話す。**
///
/// <para>
/// ソケットは <c>&lt;ランタイムディレクトリ&gt;/px4-userland/&lt;筐体の番号&gt;/control.sock</c>。
/// 1本の接続で頼めるのは同時に1つだけ (SPEC 6.2)。順番は使う側が守る。
/// 接続を閉じれば、その接続で借りたもの (受信機の lease・カードの handle) は px4d が返す。
/// </para>
/// </summary>
internal sealed class Px4Control : IDisposable
{
    public const ushort Hello = 0x0001;
    public const ushort Acquire = 0x0020;
    public const ushort Release = 0x0021;
    public const ushort Tune = 0x0022;
    public const ushort StartStream = 0x0023;
    public const ushort StopStream = 0x0024;
    public const ushort CardConnect = 0x0031;
    public const ushort CardDisconnect = 0x0033;
    public const ushort CardReset = 0x0034;
    public const ushort CardTransmit = 0x0035;
    public const ushort AttachStream = 0x0040;
    public const ushort TsData = 0x8040;
    public const ushort StreamEnd = 0x80ff;

    public const ushort ResponseFlag = 1 << 0;
    public const ushort ErrorFlag = 1 << 1;

    public const int HeaderSize = 20;
    public const int MaxPayload = 65536;

    /// <summary>TS_DATA だけはこの長さまで来る (SPEC 6.2)</summary>
    public const int MaxTsPayload = 1_048_596;

    private readonly Socket _socket;
    private readonly TimeSpan _timeout;
    private uint _requestId;

    /// <summary>いまソケットに言ってある受ける上限 (ms)</summary>
    private int _receiveTimeout;

    /// <summary>HELLO で頼んで、px4d が認めた機能 (頼んだものと向こうが持つものの積)</summary>
    public uint Capabilities { get; private set; }

    private Px4Control(Socket socket, TimeSpan timeout)
    {
        _socket = socket;
        _timeout = timeout;
        _receiveTimeout = (int)timeout.TotalMilliseconds;
    }

    /// <summary>筐体ごとのソケットの場所。<paramref name="name"/> は <c>control.sock</c> か <c>stream.sock</c></summary>
    public static string Endpoint(string runtimeDir, string id, string name) =>
        Path.Combine(runtimeDir, "px4-userland", id, name);

    /// <summary>
    /// 繋いで HELLO まで済ませる。**繋がらなければ「px4d に繋がりません」で投げる。**
    /// <paramref name="timeout"/> は1回のやり取りを待つ上限 (長く待つものは <see cref="Request"/> に言う)
    /// </summary>
    public static Px4Control Connect(string socketPath, uint capabilities, TimeSpan timeout)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = (int)timeout.TotalMilliseconds,
            ReceiveTimeout = (int)timeout.TotalMilliseconds,
        };
        var control = new Px4Control(socket, timeout);
        try
        {
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));

            // v1.0 だけを言う。**px4d は版を厳密に比べる** (SPEC 6.4) ので幅は持たせない
            var hello = new byte[12];
            BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(2), 0);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(4), 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(6), 0);
            BinaryPrimitives.WriteUInt32LittleEndian(hello.AsSpan(8), capabilities);
            var answer = control.Request(Hello, hello);
            if (answer.Length != 8) throw new IOException($"px4d の HELLO の答えが {answer.Length} バイトです (8 のはず)");
            control.Capabilities = BinaryPrimitives.ReadUInt32LittleEndian(answer.AsSpan(4));
            return control;
        }
        catch (Exception error)
        {
            socket.Dispose();
            throw error as IOException ?? new IOException($"px4d に繋がりません ({socketPath}: {error.Message})", error);
        }
    }

    /// <summary>
    /// 1つ送って答えを1つ受ける (SPEC 6.2)。**失敗は全部 <see cref="IOException"/> にする。**
    /// px4d がエラーで答えたときは <see cref="Px4Error"/> (理由の番号つき)、接続が切れた・崩れたときは
    /// ただの IOException。<paramref name="timeout"/> は同期を待つ TUNE のように長く待つときだけ
    /// </summary>
    public byte[] Request(ushort type, ReadOnlySpan<byte> payload, TimeSpan? timeout = null)
    {
        var id = ++_requestId;
        if (id == 0) id = _requestId = 1;

        try
        {
            /*
             * **変わるときだけ言う。** macOS は相手が閉じたソケットの setsockopt を EINVAL で断り、
             * 本当の理由 (相手が閉じた) が「InvalidArgument」に化ける
             */
            var wait = (int)(timeout ?? _timeout).TotalMilliseconds;
            if (_receiveTimeout != wait) _socket.ReceiveTimeout = _receiveTimeout = wait;
            SendAll(_socket, Encode(type, 0, id, payload));

            var (answered, flags, answeredId, body) = ReadFrame(_socket, MaxPayload);
            // イベントは頼んでいない (HELLO で EVENTS を立てない) ので、来るのは答えだけのはず
            if ((flags & ResponseFlag) == 0 || answered != type || answeredId != id)
            {
                throw new IOException($"px4d から頼んでいない答えが来ました (型 0x{answered:x4}、番号 {answeredId})");
            }
            if ((flags & ErrorFlag) != 0) throw Failed(body);
            return body;
        }
        catch (SocketException error)
        {
            throw new IOException($"px4d とのやり取りに失敗しました ({error.SocketErrorCode})", error);
        }
    }

    /// <summary>1枚ぶんのバイト列 (20 バイトの頭 + 中身)</summary>
    public static byte[] Encode(ushort type, ushort flags, uint requestId, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[HeaderSize + payload.Length];
        "PX4U"u8.CopyTo(frame);
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
    /// 1枚読む。**長さは受ける前に見る** (崩れた長さのまま確保しない)。
    /// 頭が崩れている・版が違う・途中で切れた、は IOException
    /// </summary>
    public static (ushort Type, ushort Flags, uint RequestId, byte[] Payload) ReadFrame(Socket socket, int maxPayload)
    {
        var header = new byte[HeaderSize];
        Receive(socket, header);
        if (!header.AsSpan(0, 4).SequenceEqual("PX4U"u8)) throw new IOException("px4d の答えの頭が PX4U ではありません");
        var major = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(4));
        var minor = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(6));
        if (major != 1 || minor != 0) throw new IOException($"px4d の IPC の版が {major}.{minor} です (1.0 のはず)");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(16));
        if (length > maxPayload) throw new IOException($"px4d の答えが長すぎます ({length} バイト)");
        var body = new byte[length];
        Receive(socket, body);
        return (
            BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8)),
            BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(10)),
            BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12)),
            body);
    }

    private static void Receive(Socket socket, Span<byte> into)
    {
        while (into.Length > 0)
        {
            var got = socket.Receive(into);
            if (got == 0) throw new IOException("px4d が接続を閉じました");
            into = into[got..];
        }
    }

    /// <summary>
    /// エラーの答え (SPEC 6.2 / 6.5)。<c>u32 error_code, u16 detail_length, detail</c>。
    /// **理由は画面に出る** ので、番号の名前に日本語を添える
    /// </summary>
    public static Px4Error Failed(byte[] body)
    {
        if (body.Length < 6) return new Px4Error(Px4Error.Unknown, "px4d がエラーを返しました (中身が読めません)");
        var code = BinaryPrimitives.ReadUInt32LittleEndian(body);
        var detailLength = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(4));
        var detail = body.Length >= 6 + detailLength ? Encoding.UTF8.GetString(body, 6, detailLength) : "";
        var reason = Reason(code);
        return new Px4Error(code, detail.Length > 0 ? $"px4d: {reason}: {detail}" : $"px4d: {reason}");
    }

    /// <summary>エラーの番号の意味 (SPEC 6.5)。STREAM_END の理由にも使う</summary>
    public static string Reason(uint code) => code switch
    {
        1 => "頼み方が合っていません (INVALID_ARGUMENT)",
        2 => "IPC の版が合いません (VERSION_MISMATCH)",
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
        255 => "px4d の中で失敗しました (INTERNAL)",
        _ => $"エラー {code}",
    };

    public void Dispose() => _socket.Dispose();

    public bool Connected => _socket.Connected;
}

/// <summary>px4d がエラーで答えた (SPEC 6.5)。**分岐は番号で** (文言は診断用)</summary>
internal sealed class Px4Error(uint code, string message) : IOException(message)
{
    public const uint InvalidArgument = 1;
    public const uint NotFound = 3;
    public const uint Busy = 4;
    public const uint NotReady = 5;
    public const uint Timeout = 6;
    public const uint Unknown = uint.MaxValue;

    public uint Code { get; } = code;
}
