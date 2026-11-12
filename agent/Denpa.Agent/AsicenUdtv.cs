using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Net.Sockets;
using System.Text;

namespace Denpa.Agent;

/*
 * asicen-userland v1.0.0-beta の asicend と通信する UDTV 1.0 のクライアント。**試験的。実機では確かめていない。**
 *
 * 元にしたもの:
 * - dtv-userland-core v1.0.3 の docs/external-contract-1.0.0.md、docs/wire-subset.md、docs/wire-records.md、docs/control-client.md。
 *   ヘッダ、HELLO・ACQUIRE の要求と ACQUIRE の応答、LNB_POWER、型の符号化、手順はここに書いてある
 * - 契約の文書に無い部分 (opcode の数値、ほかのレコードのバイト配置) は、配布物の公式のクライアント (asicen-ts・asicenctl 1.0.0) と
 *   模擬のデーモン (asicend-mock。v1.0.0-beta のソースから組んだだけ) の通信を中継して記録し、そこから起こした。
 *   **上流のソースは読んでいない。** 起こした形式と、欄ごとの確かさは denpa-spec の asicen-udtv/spec.md
 *
 * 決まり:
 * - **意味を確かめていない欄には、公式のクライアントが送っていたバイト列をそのまま送る。** 値を変えて送るのは、
 *   観察で意味を確かめた欄 (受信機の番号・方式・周波数・TSID とスロット・時間切れ) だけ
 * - **バージョンを固定する。** HELLO の応答が UDTV 1.0・asicen-userland 1.0.0 でなければ、何も送らずに断る。
 *   応答の長さや値が観察した形式と違うときも、読み進めずに失敗にする
 * - 上流がバージョンを上げると動かなくなることがある (形式は観察からの推定を含む)
 */

/// <summary>asicend がエラーの応答を返した (番号・操作の名前・エラーの名前つき)</summary>
internal sealed class UdtvError(uint code, string operation, string label, string message) : IOException(message)
{
    public const uint InvalidArgument = 1;
    public const uint Busy = 4;

    /// <summary>
    /// 時間切れ。**観察していない** (模擬は必ず同期する)。契約の文書がエラーを並べる順 (INVALID_ARGUMENT が 1、BUSY が 4、
    /// UNSUPPORTED が 11 は観察と合う) から 6 と推定した。名前 (<see cref="Label"/>) が <c>TIMEOUT</c> のものも同じに扱う
    /// </summary>
    public const uint Timeout = 6;
    public const uint Unsupported = 11;

    public uint Code { get; } = code;

    /// <summary>失敗した操作の名前 (<c>acquire</c>・<c>tune</c>・<c>lnb_power</c>)</summary>
    public string Operation { get; } = operation;

    /// <summary>エラーの名前 (<c>BUSY</c>・<c>UNSUPPORTED</c>・<c>INVALID_ARGUMENT</c>)</summary>
    public string Label { get; } = label;

    public bool TimedOut => Code == Timeout || Label == "TIMEOUT";
}

/// <summary>応答が観察した形式と違う。読み進めずに失敗にする</summary>
internal sealed class UdtvShapeError(string message) : IOException(message);

/// <summary>UDTV 1.0 のフレームと、値の読み書き</summary>
internal static class Udtv
{
    public const ushort Hello = 0x0001;
    public const ushort List = 0x0010;
    public const ushort Status = 0x0011;
    public const ushort Acquire = 0x0020;
    public const ushort Release = 0x0021;
    public const ushort Tune = 0x0022;
    public const ushort Start = 0x0023;
    public const ushort Stop = 0x0024;

    /// <summary>LNB の給電。**形式が契約の文書にある** (wire-records.md。epoch 16 バイト + bool)</summary>
    public const ushort LnbPower = 0x0039;
    public const ushort AttachStream = 0x0040;
    public const ushort TsData = 0x8040;
    public const ushort StreamEnd = 0x80ff;

    public const ushort ResponseFlags = 1;
    public const ushort ErrorFlags = 3;

    public const int HeaderSize = 20;
    public const int EpochSize = 16;

    /// <summary>TS_DATA 以外のペイロードの上限 (wire-subset.md)</summary>
    public const int MaxControlPayload = 65536;

    /// <summary>TS_DATA のペイロードの上限 (wire-subset.md。188 の倍数 1,048,476 + 先頭の 28 バイト)</summary>
    public const int MaxTsPayload = 1_048_504;

    /// <summary>TS_DATA の中身の先頭 (u64 ストリームの番号, u64 連番, u64 観察では常に 0, u32 バイト数)</summary>
    public const int TsPrefixSize = 28;

    /// <summary>固定するバージョン (HELLO の応答の製品名とバージョン)</summary>
    public const string Product = "asicen-userland";
    public const string Version = "1.0.0";

    private static ReadOnlySpan<byte> Magic => "UDTV"u8;

    /// <summary>ヘッダ (magic, major 1, minor 0, opcode, flags, request_id, payload_length。little-endian) を付ける</summary>
    public static byte[] Encode(ushort opcode, uint requestId, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[HeaderSize + payload.Length];
        Magic.CopyTo(frame);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(4), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6), 0);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8), opcode);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(10), 0);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(12), requestId);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(16), (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    public static void SendAll(Socket socket, ReadOnlySpan<byte> bytes)
    {
        try
        {
            while (bytes.Length > 0)
            {
                var sent = socket.Send(bytes);
                if (sent <= 0) throw new IOException("asicend との接続が切れました (送れません)");
                bytes = bytes[sent..];
            }
        }
        catch (SocketException error)
        {
            throw new IOException($"asicend に送れません ({error.Message})", error);
        }
    }

    public static void Receive(Socket socket, Span<byte> into)
    {
        try
        {
            while (into.Length > 0)
            {
                var read = socket.Receive(into);
                if (read <= 0) throw new IOException("asicend との接続が切れました");
                into = into[read..];
            }
        }
        catch (SocketException error)
        {
            throw new IOException(
                error.SocketErrorCode == SocketError.TimedOut ? "asicend から応答がありません (時間切れ)" : $"asicend から受け取れません ({error.Message})", error);
        }
    }

    /// <summary>
    /// ヘッダを読んで確かめる。**magic・バージョン・flags と request_id の組み合わせ・長さの上限** (wire-subset.md)。
    /// 合わなければ中身を読まずに <see cref="UdtvShapeError"/> を送出する
    /// </summary>
    public static (ushort Opcode, ushort Flags, uint RequestId, int Length) ReadHeader(Socket socket, Span<byte> header)
    {
        Receive(socket, header[..HeaderSize]);
        if (!header[..4].SequenceEqual(Magic)) throw new UdtvShapeError("asicend のフレームの先頭が UDTV ではありません (別のバージョンの asicend?)");
        var major = BinaryPrimitives.ReadUInt16LittleEndian(header[4..]);
        var minor = BinaryPrimitives.ReadUInt16LittleEndian(header[6..]);
        if (major != 1 || minor != 0) throw new UdtvShapeError($"asicend のフレームが UDTV {major}.{minor} です (対応しているのは 1.0)");
        var opcode = BinaryPrimitives.ReadUInt16LittleEndian(header[8..]);
        var flags = BinaryPrimitives.ReadUInt16LittleEndian(header[10..]);
        var requestId = BinaryPrimitives.ReadUInt32LittleEndian(header[12..]);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header[16..]);
        var isEvent = (opcode & 0x8000) != 0;
        var valid = isEvent ? flags == 0 && requestId == 0 : flags is ResponseFlags or ErrorFlags && requestId != 0;
        if (!valid) throw new UdtvShapeError($"asicend のフレームが崩れています (opcode 0x{opcode:x4}、flags {flags}、request_id {requestId})");
        if (length > (opcode == TsData ? MaxTsPayload : MaxControlPayload))
        {
            throw new UdtvShapeError($"asicend のフレームが長すぎます (opcode 0x{opcode:x4}、{length} バイト)");
        }
        return (opcode, flags, requestId, (int)length);
    }

    public static (ushort Opcode, ushort Flags, uint RequestId, byte[] Body) ReadFrame(Socket socket)
    {
        Span<byte> header = stackalloc byte[HeaderSize];
        var (opcode, flags, requestId, length) = ReadHeader(socket, header);
        if (length > MaxControlPayload) throw new UdtvShapeError($"asicend のフレームが長すぎます (opcode 0x{opcode:x4}、{length} バイト)");
        var body = new byte[length];
        Receive(socket, body);
        return (opcode, flags, requestId, body);
    }

    /// <summary>
    /// エラーの応答の中身。**観察した形式: epoch, u32 番号, 文字列 (操作), 文字列 (エラーの名前)、そのあとに 0 が 11 バイト。**
    /// 末尾の 11 バイトの意味は分からないので読まない
    /// </summary>
    public static UdtvError Failed(ReadOnlySpan<byte> body)
    {
        try
        {
            var reader = new Reader(body, "エラーの応答");
            reader.Skip(EpochSize);
            var code = reader.U32();
            var operation = reader.Text(64);
            var label = reader.Text(64);
            return new UdtvError(code, operation, label, $"asicend: {Reason(code, label)} ({operation})");
        }
        catch (UdtvShapeError)
        {
            return new UdtvError(uint.MaxValue, "", "", $"asicend がエラーを返しました (中身が読めません: {Convert.ToHexString(body[..Math.Min(body.Length, 64)])})");
        }
    }

    /// <summary>エラーの番号の意味。観察したのは 1・4・11 で、ほかは応答に入っている名前をそのまま出す</summary>
    public static string Reason(uint code, string label) => code switch
    {
        UdtvError.InvalidArgument => "要求の内容が合っていません (INVALID_ARGUMENT)",
        UdtvError.Busy => "他が使っています (BUSY)",
        UdtvError.Unsupported => "この筐体では使えません (UNSUPPORTED)",
        _ => label.Length > 0 ? $"エラー {code} ({label})" : $"エラー {code}",
    };

    /// <summary>応答の中身を先頭から読む。足りなければ <see cref="UdtvShapeError"/></summary>
    public ref struct Reader(ReadOnlySpan<byte> body, string what)
    {
        private readonly ReadOnlySpan<byte> _body = body;
        private readonly string _what = what;
        private int _at;

        public readonly int Left => _body.Length - _at;

        private ReadOnlySpan<byte> Take(int size)
        {
            if (size < 0 || Left < size) throw Broken();
            var taken = _body.Slice(_at, size);
            _at += size;
            return taken;
        }

        public readonly UdtvShapeError Broken() =>
            new($"asicend の{_what}が観察した形式と違います ({_body.Length} バイト: {Convert.ToHexString(_body[..Math.Min(_body.Length, 96)])})");

        public void Skip(int size) => Take(size);

        public byte U8() => Take(1)[0];

        public ushort U16() => BinaryPrimitives.ReadUInt16LittleEndian(Take(2));

        public uint U32() => BinaryPrimitives.ReadUInt32LittleEndian(Take(4));

        public ulong U64() => BinaryPrimitives.ReadUInt64LittleEndian(Take(8));

        public byte[] Bytes(int size) => Take(size).ToArray();

        /// <summary>文字列 (u16 の長さ + UTF-8。wire-records.md の <c>str[N]</c>)</summary>
        public string Text(int max)
        {
            var length = U16();
            if (length > max) throw Broken();
            return Encoding.UTF8.GetString(Take(length));
        }

        /// <summary>存在の印 (wire-records.md の <c>opt</c>。0 か 1)</summary>
        public bool Present()
        {
            var tag = U8();
            if (tag > 1) throw Broken();
            return tag == 1;
        }

        /// <summary>先頭の epoch が <paramref name="epoch"/> と同じか</summary>
        public void Epoch(ReadOnlySpan<byte> epoch)
        {
            if (!Take(EpochSize).SequenceEqual(epoch)) throw Broken();
        }

        public readonly void End()
        {
            if (Left != 0) throw Broken();
        }
    }
}

/// <summary>
/// asicend の制御ソケット 1 本。**繋ぐと HELLO・LIST・STATUS まで済ませる** (公式のクライアントがどの操作の前にも送る並び)。
///
/// <para>
/// ソケットは <c>&lt;ランタイムディレクトリ&gt;/asicen-userland/v1/&lt;instance&gt;/control.sock</c> (external-contract §4.1)。
/// 1 本の接続で送れる要求は同時に 1 つで、request_id は 1 から増やす (§4.3)。
/// 接続を閉じれば、その接続で取った受信機は asicend が返す (§4.6)。
/// </para>
/// </summary>
internal sealed class UdtvControl : IDisposable
{
    private readonly Socket _socket;
    private readonly TimeSpan _timeout;
    private uint _requestId;
    private int _receiveTimeout;

    /// <summary>デーモンが起動するたびに変わる 16 バイト。HELLO の応答で受け取り、ほとんどの要求の先頭に付ける</summary>
    public byte[] Epoch { get; private set; } = [];

    private UdtvControl(Socket socket, TimeSpan timeout)
    {
        _socket = socket;
        _timeout = timeout;
        _receiveTimeout = (int)timeout.TotalMilliseconds;
    }

    public static string Endpoint(string runtimeDir, string instance, string name) =>
        Path.Combine(runtimeDir, Udtv.Product, "v1", instance, name);

    /// <summary>繋ぐ。**上限つきで** (Socket.Connect は待つ上限を持たない)</summary>
    public static void ConnectWithin(Socket socket, string socketPath, TimeSpan timeout)
    {
        var connecting = socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath));
        try
        {
            if (!connecting.Wait(timeout)) throw new IOException($"asicend が {timeout.TotalSeconds:F0} 秒以内に受け付けません ({socketPath})");
        }
        catch (AggregateException error) when (error.InnerException is { } inner)
        {
            throw inner is SocketException ? new IOException($"asicend に繋がりません ({socketPath}: {inner.Message})", inner) : inner;
        }
    }

    /// <summary>繋いで HELLO・LIST・STATUS を済ませる。バージョンが違えば、ここで断る</summary>
    public static UdtvControl Connect(string socketPath, TimeSpan timeout)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = (int)timeout.TotalMilliseconds,
            ReceiveTimeout = (int)timeout.TotalMilliseconds,
        };
        var control = new UdtvControl(socket, timeout);
        try
        {
            ConnectWithin(socket, socketPath, timeout);
            control.Epoch = ParseHello(control.Request(Udtv.Hello, HelloRequest));
            // LIST は epoch だけ、STATUS は epoch に 0 を 9 バイト。公式のクライアントが送るとおり。応答は読まない (epoch だけ確かめる)
            var listed = new Udtv.Reader(control.Request(Udtv.List, control.Epoch), "LIST の応答");
            listed.Epoch(control.Epoch);
            var status = new byte[Udtv.EpochSize + 9];
            control.Epoch.CopyTo(status, 0);
            control.Request(Udtv.Status, status);
            return control;
        }
        catch (Exception error)
        {
            socket.Dispose();
            throw error as IOException ?? new IOException($"asicend に繋がりません ({socketPath}: {error.Message})", error);
        }
    }

    /// <summary>HELLO の要求 (wire-subset.md): 1.0 から 1.0、必須の機能も任意の機能も 0</summary>
    internal static byte[] HelloRequest
    {
        get
        {
            var hello = new byte[24];
            BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(4), 1);
            return hello;
        }
    }

    /// <summary>
    /// HELLO の応答を確かめて epoch を返す。**観察した形式: u16 major, u16 minor, u64 機能, epoch 16 バイト, 文字列 (製品名),
    /// 文字列 (バージョン), 存在の印 [+ 文字列] (コアのバージョン。推定), u32 制御のペイロードの上限, u32 TS の上限。**
    /// UDTV 1.0・asicen-userland 1.0.0 でなければ断る
    /// </summary>
    internal static byte[] ParseHello(ReadOnlySpan<byte> body)
    {
        var reader = new Udtv.Reader(body, "HELLO の応答");
        var major = reader.U16();
        var minor = reader.U16();
        reader.U64();
        var epoch = reader.Bytes(Udtv.EpochSize);
        var product = reader.Text(128);
        var version = reader.Text(128);
        if (reader.Present()) reader.Text(128);
        reader.U32();
        reader.U32();
        reader.End();
        if (major != 1 || minor != 0 || product != Udtv.Product || version != Udtv.Version)
        {
            throw new UdtvShapeError(
                $"asicend が {product} {version} (UDTV {major}.{minor}) です。対応を確かめたのは {Udtv.Product} {Udtv.Version} (UDTV 1.0) だけなので使いません");
        }
        return epoch;
    }

    /// <summary>
    /// 1 つ送って応答を 1 つ受ける。**失敗は全部 <see cref="IOException"/>。** asicend がエラーを返したときは <see cref="UdtvError"/>。
    /// 応答は opcode と request_id が同じものだけを受け付ける (external-contract §4.3)
    /// </summary>
    public byte[] Request(ushort opcode, ReadOnlySpan<byte> payload, TimeSpan? timeout = null)
    {
        var requestId = ++_requestId;
        var wait = (int)(timeout ?? _timeout).TotalMilliseconds;
        if (wait != _receiveTimeout)
        {
            _socket.ReceiveTimeout = wait;
            _receiveTimeout = wait;
        }
        Udtv.SendAll(_socket, Udtv.Encode(opcode, requestId, payload));
        var (answered, flags, answeredId, body) = Udtv.ReadFrame(_socket);
        if (answered != opcode || answeredId != requestId)
        {
            throw new UdtvShapeError($"asicend から別の要求の応答が来ました (opcode 0x{answered:x4}、request_id {answeredId})");
        }
        if (flags == Udtv.ErrorFlags) throw Udtv.Failed(body);
        return body;
    }

    /// <summary>epoch のあとに <paramref name="rest"/> を続けた中身</summary>
    public byte[] WithEpoch(ReadOnlySpan<byte> rest)
    {
        var payload = new byte[Udtv.EpochSize + rest.Length];
        Epoch.CopyTo(payload, 0);
        rest.CopyTo(payload.AsSpan(Udtv.EpochSize));
        return payload;
    }

    /// <summary>
    /// LNB の給電をオン/オフする (LNB_POWER。<c>asicenctl lnb-on</c>・<c>lnb-off</c> と同じやり取り)。
    /// 応答は要求と同じ中身 (epoch と bool) のはず。違えば失敗にする
    /// </summary>
    public static void SetLnbPower(string socketPath, bool enabled, TimeSpan timeout)
    {
        using var control = Connect(socketPath, timeout);
        var payload = control.WithEpoch([(byte)(enabled ? 1 : 0)]);
        var answer = control.Request(Udtv.LnbPower, payload);
        if (!answer.AsSpan().SequenceEqual(payload)) throw new Udtv.Reader(answer, "LNB_POWER の応答").Broken();
    }

    public void Dispose() => _socket.Dispose();
}

/// <summary>
/// asicend の受信機 1 つ。**選局のたびに、公式のクライアント (asicen-ts) と同じ並びを最初から送る。**
///
/// <para>
/// 繋ぐ → HELLO → LIST → STATUS → ACQUIRE → TUNE → START → (stream.sock で) ATTACH_STREAM → TS_DATA…。
/// 止めるときは STOP → STREAM_END を待つ → RELEASE → 閉じる。受信機を取ったまま選局し直す並びは公式のクライアントが
/// 送らない (観察できない) ので使わない。そのぶん、局を替えるたびに受信機を返して取り直す。
/// </para>
///
/// <para>
/// 選局が失敗したときは、公式のクライアントと同じく RELEASE を送らずに接続を閉じる (受信機は asicend が返す)。
/// </para>
/// </summary>
internal sealed class AsicenTuner : ITuneDevice
{
    /// <summary>同期を待つ上限 (TUNE の時間切れ)。ほかのチューナーと同じ 5 秒。公式のクライアントは 100〜30000 ms を送る</summary>
    private static readonly TimeSpan TuneTimeout = TimeSpan.FromSeconds(5);

    /// <summary>TUNE 以外の 1 回のやり取りの上限</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(4);

    /// <summary>同期のあと最初の TS が来るまでの猶予。START の応答が返す期限 (観察では 5000 ms) より短く</summary>
    private static readonly TimeSpan FirstTsGrace = TimeSpan.FromSeconds(3);

    /// <summary>STOP のあと STREAM_END を待つ上限</summary>
    private static readonly TimeSpan EndGrace = TimeSpan.FromSeconds(3);

    private readonly string _id;
    private readonly int _receiver;
    private readonly string? _lnb;
    private readonly string _runtimeDir;
    private readonly Func<AsicenUserland.Listed?> _prepare;
    private readonly string _name;
    private readonly string _device;
    private readonly Lock _gate = new();

    private UdtvControl? _control;
    private ulong _lease;
    private ulong _streamId;
    private AsicenStream? _stream;
    private bool _lnbWarned;
    private bool _lnbHeld;

    /// <param name="prepare">選局の前に呼ぶ。asicend を起動して、機種と受信機を返す (分からなければ null)。テストは何もしない</param>
    public AsicenTuner(string id, int receiver, string? lnb, string runtimeDir, Func<AsicenUserland.Listed?> prepare)
    {
        _id = id;
        _receiver = receiver;
        _lnb = lnb;
        _runtimeDir = runtimeDir;
        _prepare = prepare;
        _device = AsicenUserland.Device(id, receiver);
        _name = $"asicen-{id} #{receiver}";
    }

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _control is not null && _stream is { Ended: false };
        }
    }

    /// <summary>同期しているかだけ。**C/N は取れない** (どの応答に入っているかを観察で確かめられなかった)</summary>
    public TunerSignal? Signal() =>
        Volatile.Read(ref _control) is not null && Volatile.Read(ref _stream) is { Ended: false } ? new TunerSignal(true, null, TunerSignal.Db, AtTune: true) : null;

    /// <summary>
    /// TUNE の中身。**観察した形式: epoch, u64 lease, u8 方式 (1 = ISDB-T、2 = ISDB-S), u64 周波数 (Hz),
    /// u8 選び方 (0 = 自動、1 = TSID、2 = スロット), u16 その値, 0 を 3 バイト, u32 時間切れ (ms)。**
    ///
    /// <para>
    /// **0 の 3 バイトは意味が分からないので、公式のクライアントが送る 0 のまま。** LNB の指定がここにあるとしても触らない
    /// (給電は LNB_POWER だけで操作する)。周波数は Hz。選局表は地上波が Hz、衛星が中間周波数の kHz なので、衛星は 1000 倍する。
    /// 衛星は名前に TSID があれば TSID で、無ければ (NIT を読むための選局と CS) スロット 0 で選ぶ。
    /// </para>
    /// </summary>
    public static byte[] TuneRequest(ReadOnlySpan<byte> epoch, ulong lease, ChannelTable.Tuning tuning, uint streamId)
    {
        var payload = new byte[43];
        epoch.CopyTo(payload);
        BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(16), lease);
        payload[24] = (byte)(tuning.Satellite ? 2 : 1);
        BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(25), tuning.Satellite ? (ulong)tuning.Frequency * 1000 : tuning.Frequency);
        if (tuning.Satellite)
        {
            var byId = streamId != ChannelTable.NoStreamId;
            payload[33] = (byte)(byId ? 1 : 2);
            BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(34), byId ? (ushort)streamId : (ushort)0);
        }
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(39), (uint)TuneTimeout.TotalMilliseconds);
        return payload;
    }

    /// <summary>
    /// TUNE の応答から選局の番号 (START に渡す) を取り出す。**観察した形式: epoch, u64 選局の番号, u64 周波数 (要求と同じ),
    /// 存在の印 [+ u64 実際に設定した周波数], 3 バイト (観察では 01 02 01), u64 時刻, 存在の印 [+ u16 TSID], 存在の印 [+ u16 スロット]。**
    /// 途中の 3 バイトと時刻は意味を確かめていないので読むだけ。長さが合わなければ失敗にする
    /// </summary>
    public static ulong TuneRevision(ReadOnlySpan<byte> answer, ReadOnlySpan<byte> epoch, ulong frequencyHz)
    {
        var reader = new Udtv.Reader(answer, "TUNE の応答");
        reader.Epoch(epoch);
        var revision = reader.U64();
        if (revision == 0 || reader.U64() != frequencyHz) throw reader.Broken();
        if (reader.Present()) reader.U64();
        reader.Skip(3);
        reader.U64();
        if (reader.Present()) reader.U16();
        if (reader.Present()) reader.U16();
        reader.End();
        return revision;
    }

    public void Tune(ChannelTable.Tuning tuning)
    {
        lock (_gate)
        {
            var listed = _prepare();
            UserlandReceiver.Check(listed?.Receivers, _receiver, tuning);
            Finish();
            Power(listed, tuning);
            try
            {
                Run(tuning);
            }
            catch (IOException)
            {
                Abandon();
                throw;
            }
        }
    }

    /// <summary>
    /// LNB の給電。**設定に 15V と書いてあり、上流が給電に対応としている機種 (PX-W3U2・PX-W3U3・PX-W3U3 V2) の衛星の選局のときだけ。**
    /// 既定は給電しない。PX-S3U・PX-S3U2 は上流が給電の制御を未解明としているので、給電せずに選局し、その理由を記録と画面に出す。
    /// 機種が分からないとき (asicend に問い合わせられなかった) も給電しない
    /// </summary>
    private void Power(AsicenUserland.Listed? listed, ChannelTable.Tuning tuning)
    {
        if (_lnb != "15v" || !tuning.Satellite) return;
        if (listed is null || !AsicenUserland.PowersLnb(listed.Model))
        {
            var notice = listed is null
                ? "機種が分からないので、LNB に給電せずに選局しています (設定の LNB 15V は効きません)"
                : $"{listed.Model} は LNB の給電を操作できないので、給電せずに選局しています (設定の LNB 15V は効きません。アンテナへの給電はほかの機器から)";
            TunerNotice.Set(_device, this, notice);
            if (!_lnbWarned) Log.Write($"[{_name}] {notice}");
            _lnbWarned = true;
            return;
        }
        AsicenLnb.Hold(_id, this, _runtimeDir);
        _lnbHeld = true;
    }

    private void Run(ChannelTable.Tuning tuning)
    {
        var control = UdtvControl.Connect(UdtvControl.Endpoint(_runtimeDir, _id, "control.sock"), RequestTimeout);
        _control = control;

        // ACQUIRE: epoch と u16 の受信機の番号 → epoch と u64 の lease (wire-subset.md)
        var receiver = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(receiver, (ushort)_receiver);
        byte[] acquired;
        try
        {
            acquired = control.Request(Udtv.Acquire, control.WithEpoch(receiver));
        }
        catch (UdtvError error)
        {
            throw new UdtvError(error.Code, error.Operation, error.Label, $"受信機 {_receiver} を取れません ({error.Message})");
        }
        var lease = new Udtv.Reader(acquired, "ACQUIRE の応答");
        lease.Epoch(control.Epoch);
        _lease = lease.U64();
        lease.End();
        if (_lease == 0) throw lease.Broken();

        var request = TuneRequest(control.Epoch, _lease, tuning, tuning.StreamId);
        var frequencyHz = BinaryPrimitives.ReadUInt64LittleEndian(request.AsSpan(25));
        byte[] tuned;
        try
        {
            // asicend は時間切れで同期をやめて応答する。それより少し長く待つ
            tuned = control.Request(Udtv.Tune, request, TuneTimeout + TimeSpan.FromSeconds(2));
        }
        catch (UdtvError error) when (error.TimedOut)
        {
            throw new UdtvError(error.Code, error.Operation, error.Label, ITuneDevice.SyncFailed);
        }
        var revision = TuneRevision(tuned, control.Epoch, frequencyHz);

        // START: epoch, u64 lease, u64 選局の番号 → epoch, u64 ストリームの番号, 16 バイトのトークン, u32 ATTACH の期限 (ms)
        var start = new byte[16];
        BinaryPrimitives.WriteUInt64LittleEndian(start, _lease);
        BinaryPrimitives.WriteUInt64LittleEndian(start.AsSpan(8), revision);
        var started = new Udtv.Reader(control.Request(Udtv.Start, control.WithEpoch(start)), "START の応答");
        started.Epoch(control.Epoch);
        _streamId = started.U64();
        var token = started.Bytes(16);
        started.U32();
        started.End();
        if (_streamId == 0) throw started.Broken();

        _stream = AsicenStream.Attach(
            UdtvControl.Endpoint(_runtimeDir, _id, "stream.sock"), control.Epoch, _lease, _streamId, token, _name, FirstTsGrace);
        Log.Write($"[{_name}] 受信機を取って選局しました");
    }

    /// <summary>
    /// 流していれば止めて、受信機を返して閉じる。**STOP → STREAM_END を待つ → RELEASE の順** (公式のクライアントと同じ)。
    /// 途中で失敗しても、接続を閉じれば asicend が受信機を返す
    /// </summary>
    private void Finish()
    {
        var control = _control;
        var stream = _stream;
        _control = null;
        _stream = null;
        if (control is null)
        {
            stream?.Stop();
            return;
        }
        try
        {
            if (stream is not null)
            {
                // STOP: epoch, u64 lease, u64 ストリームの番号。応答は「後始末がまだ」のエラーを含むことがある (観察では毎回) ので、epoch だけ確かめる
                var stop = new byte[16];
                BinaryPrimitives.WriteUInt64LittleEndian(stop, _lease);
                BinaryPrimitives.WriteUInt64LittleEndian(stop.AsSpan(8), _streamId);
                stream.Drain();
                new Udtv.Reader(control.Request(Udtv.Stop, control.WithEpoch(stop)), "STOP の応答").Epoch(control.Epoch);
                stream.WaitEnd(EndGrace);
            }
            stream?.Stop();
            stream = null;
            // RELEASE: epoch, u64 lease → epoch, u64 lease, bool 返した, bool 止まった, 存在の印 (エラー)
            var lease = new byte[8];
            BinaryPrimitives.WriteUInt64LittleEndian(lease, _lease);
            var released = new Udtv.Reader(control.Request(Udtv.Release, control.WithEpoch(lease)), "RELEASE の応答");
            released.Epoch(control.Epoch);
            if (released.U64() != _lease || released.U8() != 1 || released.U8() != 1)
            {
                Log.Write($"[{_name}] asicend が受信機を返し終えていません (接続を閉じて任せます)");
            }
        }
        catch (IOException error)
        {
            Log.Write($"[{_name}] 受信機を返す途中で失敗しました。接続を閉じて asicend に任せます ({error.Message})");
        }
        finally
        {
            stream?.Stop();
            control.Dispose();
        }
    }

    /// <summary>選局が失敗したとき。**何も送らずに閉じる** (公式のクライアントと同じ)</summary>
    private void Abandon()
    {
        var stream = _stream;
        _stream = null;
        stream?.Stop();
        var control = _control;
        _control = null;
        control?.Dispose();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            Finish();
            if (_lnbHeld)
            {
                _lnbHeld = false;
                AsicenLnb.Drop(_id, this, _runtimeDir);
            }
        }
        TunerNotice.Clear(_device, this);
    }
}

/// <summary>
/// 筐体ごとの LNB の給電。**給電が要るチューナーが 1 つでもある間オンにし、無くなったらオフにする。**
///
/// <para>
/// 操作は LNB_POWER だけ (<see cref="UdtvControl.SetLnbPower"/>)。asicend は起動したときと止まるときに給電をオフにする (上流 README)。
/// asicend が <c>--allow-lnb-power</c> なしで起動していると UNSUPPORTED で断られる。
/// </para>
/// </summary>
internal static class AsicenLnb
{
    private static readonly Lock Gate = new();
    private static readonly Dictionary<string, HashSet<object>> Holders = new(StringComparer.Ordinal);
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(4);

    /// <summary>給電を要求する。最初の 1 つのときにオンにする。**オンにできなければ例外を送出する** (給電できないまま選局しても同期しない)</summary>
    public static void Hold(string id, object holder, string runtimeDir)
    {
        lock (Gate)
        {
            if (!Holders.TryGetValue(id, out var holders)) Holders[id] = holders = [];
            if (holders.Count == 0)
            {
                try
                {
                    UdtvControl.SetLnbPower(UdtvControl.Endpoint(runtimeDir, id, "control.sock"), true, Timeout);
                }
                catch (UdtvError error) when (error.Code == UdtvError.Unsupported)
                {
                    throw new IOException($"asicend が LNB の給電を断りました ({error.Message})。asicend が給電を許可しない引数で起動しています。設定を保存し直すと、給電を許可して起動し直します", error);
                }
                Log.Write($"[asicend {id}] LNB の給電をオンにしました");
            }
            holders.Add(holder);
        }
    }

    /// <summary>要求を取り下げる。最後の 1 つのときにオフにする。失敗しても例外にしない (asicend が止まるときにオフになる)</summary>
    public static void Drop(string id, object holder, string runtimeDir)
    {
        lock (Gate)
        {
            if (!Holders.TryGetValue(id, out var holders) || !holders.Remove(holder) || holders.Count > 0) return;
            try
            {
                UdtvControl.SetLnbPower(UdtvControl.Endpoint(runtimeDir, id, "control.sock"), false, Timeout);
                Log.Write($"[asicend {id}] LNB の給電をオフにしました");
            }
            catch (IOException error)
            {
                Log.Write($"[asicend {id}] LNB の給電をオフにできませんでした (asicend が止まるときにオフになります): {error.Message}");
            }
        }
    }

    /// <summary>asicend が止まった。給電は asicend が切っているので、次の選局でオンにし直すように、要求を消す</summary>
    public static void Forget(string id)
    {
        lock (Gate) Holders.Remove(id);
    }
}

/// <summary>
/// asicend から TS を受け取る 1 回ぶん (START 1 回につき 1 つ)。
///
/// <para>
/// <c>stream.sock</c> に繋いで ATTACH_STREAM を送ると、asicend が TS_DATA のフレームを送り続け、STOP のあとに STREAM_END が来る。
/// 中身はソケットから <see cref="Pipe"/> のメモリへ直に受ける (CECH-ZD1 J の <c>Zd1jStream</c> と同じく Pipelines)。
/// </para>
/// </summary>
internal sealed class AsicenStream
{
    /// <summary>TS がこれだけ来なければ終わる</summary>
    private static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(5);

    private readonly Socket _socket;
    private readonly string _name;
    private readonly ulong _streamId;
    private readonly ManualResetEventSlim _first = new();
    private readonly ManualResetEventSlim _end = new();
    private readonly Pipe _pipe = TsBuffer.New();

    private Thread? _pump;
    private volatile bool _stopped;

    /// <summary>STOP を送る前に立てる。以降の TS は渡さずに捨て、STREAM_END まで読む</summary>
    private volatile bool _draining;
    private volatile bool _ended;
    private volatile string? _reason;
    private volatile bool _delivered;
    private ulong _sequence;

    public DeviceStream Output { get; }

    public bool Ended => _ended;

    private AsicenStream(Socket socket, string name, ulong streamId)
    {
        _socket = socket;
        _name = name;
        _streamId = streamId;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
    }

    /// <summary>
    /// 繋いで ATTACH_STREAM を送り、最初の TS が来るまで待つ。
    /// **観察した形式: 要求は epoch, u64 lease, u64 ストリームの番号, 16 バイトのトークン (request_id は 1)。応答は epoch, u64 ストリームの番号。**
    /// </summary>
    public static AsicenStream Attach(
        string socketPath, byte[] epoch, ulong lease, ulong streamId, byte[] token, string name, TimeSpan firstTs)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = 4000,
            ReceiveTimeout = 4000,
        };
        var stream = new AsicenStream(socket, name, streamId);
        try
        {
            UdtvControl.ConnectWithin(socket, socketPath, TimeSpan.FromSeconds(4));
            var payload = new byte[48];
            epoch.CopyTo(payload, 0);
            BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(16), lease);
            BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(24), streamId);
            token.CopyTo(payload, 32);
            Udtv.SendAll(socket, Udtv.Encode(Udtv.AttachStream, 1, payload));
            var (opcode, flags, requestId, body) = Udtv.ReadFrame(socket);
            if (opcode != Udtv.AttachStream || requestId != 1)
            {
                throw new UdtvShapeError($"asicend から ATTACH_STREAM の応答ではないものが来ました (opcode 0x{opcode:x4})");
            }
            if (flags == Udtv.ErrorFlags) throw Udtv.Failed(body);
            var attached = new Udtv.Reader(body, "ATTACH_STREAM の応答");
            attached.Epoch(epoch);
            if (attached.U64() != streamId) throw attached.Broken();
            attached.End();
            socket.ReceiveTimeout = (int)SilenceLimit.TotalMilliseconds;
            stream._pump = new Thread(stream.Pump) { IsBackground = true, Name = $"{name} TS" };
            stream._pump.Start();
        }
        catch (Exception error) when (error is IOException or SocketException)
        {
            socket.Dispose();
            throw new IOException($"asicend から TS を受け取れません ({error.Message})", error);
        }

        if (!stream._first.Wait(firstTs))
        {
            stream.Stop();
            throw new IOException($"同期したのに TS が {firstTs.TotalSeconds:F0} 秒来ません");
        }
        if (!stream._delivered)
        {
            var reason = stream._reason ?? "asicend との TS の接続が切れました";
            stream.Stop();
            throw new IOException(reason);
        }
        return stream;
    }

    private void Pump()
    {
        var writer = _pipe.Writer;
        Span<byte> header = stackalloc byte[Udtv.HeaderSize];
        Span<byte> prefix = stackalloc byte[Udtv.TsPrefixSize];
        var discard = new byte[64 * 1024];
        try
        {
            var heard = Stopwatch.StartNew();
            while (!_stopped)
            {
                if (!_socket.Poll(TimeSpan.FromMilliseconds(200), SelectMode.SelectRead))
                {
                    if (heard.Elapsed < SilenceLimit) continue;
                    End($"asicend から TS が {SilenceLimit.TotalSeconds:F0} 秒来ません");
                    return;
                }
                var (opcode, _, _, length) = Udtv.ReadHeader(_socket, header);
                if (opcode != Udtv.TsData)
                {
                    if (length > Udtv.MaxControlPayload)
                    {
                        End($"asicend のフレームが長すぎます (opcode 0x{opcode:x4}、{length} バイト)");
                        return;
                    }
                    var body = new byte[length];
                    Udtv.Receive(_socket, body);
                    End(opcode == Udtv.StreamEnd ? Ending(body) : $"asicend から想定していないフレームが来ました (opcode 0x{opcode:x4})");
                    return;
                }
                if (length < Udtv.TsPrefixSize)
                {
                    End($"asicend の TS_DATA が短すぎます ({length} バイト)");
                    return;
                }
                // u64 ストリームの番号, u64 連番, u64 (観察では常に 0。意味は確かめていない), u32 バイト数, TS
                Udtv.Receive(_socket, prefix);
                var streamId = BinaryPrimitives.ReadUInt64LittleEndian(prefix);
                var sequence = BinaryPrimitives.ReadUInt64LittleEndian(prefix[8..]);
                var unknown = BinaryPrimitives.ReadUInt64LittleEndian(prefix[16..]);
                var count = BinaryPrimitives.ReadUInt32LittleEndian(prefix[24..]);
                if (streamId != _streamId || count != length - Udtv.TsPrefixSize || count % 188 != 0)
                {
                    End($"asicend の TS_DATA が崩れています (ストリーム {streamId}、{count} バイト)");
                    return;
                }
                if (unknown != 0)
                {
                    End($"asicend の TS_DATA に観察していない値があります (3 つ目の欄が {unknown})。TS を捨てた数かもしれません");
                    return;
                }
                if (sequence != _sequence)
                {
                    End($"asicend の TS_DATA の番号が飛びました ({_sequence} のはずが {sequence})");
                    return;
                }
                _sequence++;
                var size = (int)count;
                if (_draining)
                {
                    for (var left = size; left > 0;)
                    {
                        var part = Math.Min(left, discard.Length);
                        Udtv.Receive(_socket, discard.AsSpan(0, part));
                        left -= part;
                    }
                    continue;
                }
                Udtv.Receive(_socket, writer.GetMemory(size).Span[..size]);
                writer.Advance(size);
                if (!Flush(writer))
                {
                    if (_draining && !_stopped) continue;
                    return;
                }
                _delivered = true;
                _first.Set();
                heard.Restart();
            }
        }
        catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException)
        {
            End($"asicend との TS の接続が切れました ({error.Message})");
        }
        finally
        {
            _ended = true;
            _socket.Dispose();
            writer.Complete();
            _first.Set();
            _end.Set();
        }
    }

    /// <summary>
    /// STREAM_END の理由。**観察した形式: u64 ストリームの番号, u64 選局の番号, u8 理由, 存在の印 [+ エラー], 数の並び。**
    /// 観察したのは止めたときの「理由 0・エラーなし」だけ。エラーがあれば番号と名前を出す。数の並びは読まない
    /// </summary>
    internal static string Ending(ReadOnlySpan<byte> body)
    {
        try
        {
            var reader = new Udtv.Reader(body, "STREAM_END");
            reader.U64();
            reader.U64();
            var reason = reader.U8();
            if (!reader.Present()) return reason == 0 ? "asicend が TS を止めました" : $"asicend が TS を止めました (理由 {reason})";
            var code = reader.U32();
            var operation = reader.Text(64);
            var label = reader.Text(256);
            return $"asicend が TS を止めました ({Udtv.Reason(code, label)}、{operation})";
        }
        catch (UdtvShapeError)
        {
            return "asicend が TS を止めました (STREAM_END の理由が読めません)";
        }
    }

    /// <summary>読み出し側がいないまま <see cref="Zd1jTuner.StallLimit"/> 経ったら、TS のストリームを閉じる (USB を直に持つ機材から受ける TS と同じ上限)</summary>
    private bool Flush(PipeWriter writer) => TsBuffer.Flush(writer, () => _stopped || _draining, Zd1jTuner.StallLimit,
        () => End($"読み出し側がいないまま {Zd1jTuner.StallLimit.TotalSeconds:F0} 秒経ったので TS のストリームを閉じました"),
        () => End("TS を渡せません (読み出し側が閉じました)"));

    private void End(string reason)
    {
        if (_stopped || _draining) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>STOP を送る前に呼ぶ。以降の TS は捨てて、STREAM_END まで読み進める</summary>
    public void Drain() => _draining = true;

    /// <summary>STREAM_END (か切断) まで待つ</summary>
    public bool WaitEnd(TimeSpan limit) => _ended || _end.Wait(limit);

    /// <summary>止める</summary>
    public void Stop()
    {
        _stopped = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        try
        {
            _socket.Shutdown(SocketShutdown.Both);
        }
        catch (Exception error) when (error is SocketException or ObjectDisposedException)
        {
            // 繋がっていない・もう閉じた
        }
        if (_pump is { } pump && !pump.Join(TimeSpan.FromSeconds(1)))
        {
            _socket.Dispose();
            pump.Join(TimeSpan.FromSeconds(1));
        }
        _socket.Dispose();
        if (_pump is not { IsAlive: true })
        {
            _first.Dispose();
            _end.Dispose();
        }
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}
