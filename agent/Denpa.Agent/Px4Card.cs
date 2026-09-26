using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// px4d の内蔵カードリーダー。**px4d の制御ソケットに直に APDU を投げる。**
///
/// <para>
/// px4-userland のカードは px4d が持っていて (T=1 の枠組みも向こう)、pcscd には
/// IFD ハンドラ越しに見せていた。そのハンドラがしているのと同じやり取り
/// (SPEC 6 節の portable IPC) をこちらでするので、pcscd も IFD も要らない。
/// </para>
///
/// <para>
/// ソケットは <c>&lt;ランタイムディレクトリ&gt;/px4-userland/&lt;筐体の番号&gt;/control.sock</c>。
/// 1本の接続で頼めるのは同時に1つだけで、順番は <see cref="BCas"/> が守る。
/// </para>
/// </summary>
public sealed class Px4Card : ICardLink
{
    /// <summary>HELLO で頼む機能。bit 1 = CARD。**頼んでいない型は px4d が断る**</summary>
    private const uint CardCapability = 1 << 1;

    private const ushort Hello = 0x0001;
    private const ushort CardConnect = 0x0031;
    private const ushort CardDisconnect = 0x0033;
    private const ushort CardReset = 0x0034;
    private const ushort CardTransmit = 0x0035;

    private const ushort ResponseFlag = 1 << 0;
    private const ushort ErrorFlag = 1 << 1;

    private const int HeaderSize = 20;
    private const int MaxPayload = 65536;

    /// <summary>
    /// 1回のやり取りの上限。px4d は APDU 1つを 3 秒で打ち切る (SPEC 5.3) ので、
    /// それより長く待ってから諦める
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private readonly Socket _socket;
    private uint _requestId;
    private ulong _handle;

    public string Name { get; }

    private Px4Card(string name, Socket socket)
    {
        Name = name;
        _socket = socket;
    }

    /// <summary>
    /// px4d が起きている筐体ぶん。**開くまでは何も掴まない。**
    ///
    /// <para>
    /// 筐体は制御ソケットがあるかで見る。px4d は起きると筐体ごとに
    /// <c>control.sock</c> を作り、止まるときに消す (Px4Daemon が起こす先と同じ
    /// ランタイムディレクトリ)。**起こしていない筐体は出てこない**ので、
    /// px4d を起こしてから探す。
    /// </para>
    /// </summary>
    public static IReadOnlyList<CardLinkCandidate> Find() => Find(Px4Userland.RuntimeDir);

    internal static IReadOnlyList<CardLinkCandidate> Find(string runtimeDir)
    {
        var root = Path.Combine(runtimeDir, "px4-userland");
        if (!Directory.Exists(root)) return [];
        return
        [
            .. Directory.EnumerateDirectories(root)
                .Select(dir => (Id: Path.GetFileName(dir), Socket: Path.Combine(dir, "control.sock")))
                .Where(found => found.Id.Length >= 4 && found.Id.All(char.IsAsciiDigit) && File.Exists(found.Socket))
                .OrderBy(found => found.Id, StringComparer.Ordinal)
                .Select(found =>
                {
                    // pcscd に見せていた頃と同じ名前 (画面で見分けがつくように)
                    var name = $"px4-userland {found.Id[^4..]} Internal Card Reader";
                    return new CardLinkCandidate(name, () => Open(name, found.Socket));
                }),
        ];
    }

    /// <summary>ソケットに繋いで HELLO まで済ませる。**カードにはまだ触らない** (<see cref="Reset"/>)</summary>
    public static Px4Card Open(string name, string socketPath)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        {
            SendTimeout = (int)Timeout.TotalMilliseconds,
            ReceiveTimeout = (int)Timeout.TotalMilliseconds,
        };
        var card = new Px4Card(name, socket);
        try
        {
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));

            // v1.0 だけを言う。**px4d は版を厳密に比べる** (SPEC 6.4) ので幅は持たせない
            var hello = new byte[12];
            BinaryPrimitives.WriteUInt16LittleEndian(hello, 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(2), 0);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(4), 1);
            BinaryPrimitives.WriteUInt16LittleEndian(hello.AsSpan(6), 0);
            BinaryPrimitives.WriteUInt32LittleEndian(hello.AsSpan(8), CardCapability);
            var answer = card.Request(Hello, hello);
            if (answer.Length != 8) throw new IOException($"px4d の HELLO の答えが {answer.Length} バイトです (8 のはず)");
            if ((BinaryPrimitives.ReadUInt32LittleEndian(answer.AsSpan(4)) & CardCapability) == 0)
            {
                throw new IOException("px4d がカードを扱いません");
            }
            return card;
        }
        catch (Exception error)
        {
            socket.Dispose();
            throw error as IOException ?? new IOException($"px4d に繋がりません ({socketPath}: {error.Message})", error);
        }
    }

    /// <summary>
    /// 1回目は CARD_CONNECT、2回目からは CARD_RESET。**どちらも ATR が返る。**
    ///
    /// <para>
    /// 繋ぐのは共有 (share mode 1)。B-CAS は APDU を跨いだ状態を持たないので、
    /// 独占しなくても割り込まれて困ることが無い。
    /// </para>
    /// </summary>
    public byte[] Reset()
    {
        if (_handle == 0)
        {
            var answer = Request(CardConnect, [1]);
            if (answer.Length < 9 || answer.Length != 9 + answer[8])
            {
                throw new IOException($"px4d の CARD_CONNECT の答えが崩れています ({answer.Length} バイト)");
            }
            _handle = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            return answer[9..];
        }

        var payload = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
        var atr = Request(CardReset, payload);
        if (atr.Length < 1 || atr.Length != 1 + atr[0])
        {
            throw new IOException($"px4d の CARD_RESET の答えが崩れています ({atr.Length} バイト)");
        }
        return atr[1..];
    }

    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_handle == 0) throw new IOException("カードに繋いでいません (Reset を先に)");

        var payload = new byte[12 + apdu.Length];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(8), (uint)apdu.Length);
        apdu.CopyTo(payload.AsSpan(12));

        var answer = Request(CardTransmit, payload);
        if (answer.Length < 4 || answer.Length != 4 + BinaryPrimitives.ReadUInt32LittleEndian(answer))
        {
            throw new IOException($"px4d の CARD_TRANSMIT の答えが崩れています ({answer.Length} バイト)");
        }
        return answer[4..];
    }

    /// <summary>
    /// 1つ送って答えを1つ受ける (SPEC 6.2)。**失敗は全部 <see cref="IOException"/> にする** —
    /// 繋ぎ直すかどうかを決めるのは <see cref="BCas"/> で、そちらは IOException だけを見る。
    /// </summary>
    private byte[] Request(ushort type, ReadOnlySpan<byte> payload)
    {
        var id = ++_requestId;
        if (id == 0) id = _requestId = 1;

        var frame = new byte[HeaderSize + payload.Length];
        "PX4U"u8.CopyTo(frame);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(4), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6), 0);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8), type);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(10), 0);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(12), id);
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(16), (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));

        try
        {
            _socket.Send(frame);

            var header = new byte[HeaderSize];
            Receive(header);
            if (!header.AsSpan(0, 4).SequenceEqual("PX4U"u8)) throw new IOException("px4d の答えの頭が PX4U ではありません");
            var major = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(4));
            var minor = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(6));
            if (major != 1 || minor != 0) throw new IOException($"px4d の IPC の版が {major}.{minor} です (1.0 のはず)");
            var answered = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8));
            var flags = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(10));
            var answeredId = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12));
            var length = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(16));
            // 長さは受ける前に見る。**崩れた長さのまま確保しない**
            if (length > MaxPayload) throw new IOException($"px4d の答えが長すぎます ({length} バイト)");
            var body = new byte[length];
            Receive(body);

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

    private void Receive(Span<byte> into)
    {
        while (into.Length > 0)
        {
            var got = _socket.Receive(into);
            if (got == 0) throw new IOException("px4d が接続を閉じました");
            into = into[got..];
        }
    }

    /// <summary>エラーの答え (SPEC 6.2 / 6.5)。<c>u32 error_code, u16 detail_length, detail</c></summary>
    private static IOException Failed(byte[] body)
    {
        if (body.Length < 6) return new IOException("px4d がエラーを返しました (中身が読めません)");
        var code = BinaryPrimitives.ReadUInt32LittleEndian(body);
        var detailLength = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(4));
        var detail = body.Length >= 6 + detailLength ? Encoding.UTF8.GetString(body, 6, detailLength) : "";
        var reason = code switch
        {
            3 => "見つかりません (NOT_FOUND)",
            4 => "他が使っています (BUSY)",
            5 => "まだ用意ができていません (NOT_READY)",
            6 => "時間切れ (TIMEOUT)",
            7 => "USB の読み書きに失敗しました (USB_IO)",
            8 => "筐体が抜けました (DISCONNECTED)",
            11 => "この筐体では使えません (UNSUPPORTED)",
            12 => "カードが刺さっていません (NO_CARD)",
            13 => "カードが抜かれました (CARD_REMOVED)",
            _ => $"エラー {code}",
        };
        return new IOException(detail.Length > 0 ? $"px4d: {reason}: {detail}" : $"px4d: {reason}");
    }

    /// <summary>カードを手放してから閉じる。**リセットはしない** (他の使い手が居るかもしれない)</summary>
    public void Dispose()
    {
        if (_handle != 0 && _socket.Connected)
        {
            try
            {
                var payload = new byte[9];
                BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
                Request(CardDisconnect, payload);
            }
            catch (IOException)
            {
                // 閉じれば px4d の側で手放される (SPEC 6.4)。ここで言うのは行儀の問題だけ
            }
            _handle = 0;
        }
        _socket.Dispose();
    }
}
