using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// px4d の内蔵カードリーダー。**px4d の制御ソケットに直に APDU を投げる。**
///
/// <para>
/// px4-userland のカードは px4d が持っていて (T=1 の枠組みも向こう)、同梱の IFD ハンドラと
/// 同じやり取り (SPEC 6 節の portable IPC) をこちらでする (Px4Control.cs)。pcscd も IFD ハンドラも使わない。
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

    /// <summary>
    /// 1回のやり取りの上限。px4d は APDU 1つを 3 秒で打ち切る (SPEC 5.3) ので、
    /// それより長く待ってから諦める
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private readonly Px4Control _control;
    private readonly string _daemon;
    private ulong _handle;

    public string Name { get; }

    private Px4Card(string name, Px4Control control, string daemon)
    {
        Name = name;
        _control = control;
        _daemon = daemon;
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

    internal static IReadOnlyList<CardLinkCandidate> Find(string runtimeDir) => Find(
        runtimeDir, Px4Wire.Px4, id => id.Length >= 4 && Px4Userland.ValidId(id),
        // pcscd に見せていた頃と同じ名前 (画面で見分けがつくように)
        id => $"px4-userland {Px4Userland.Label(id)} Internal Card Reader");

    /// <summary>
    /// <paramref name="wire"/> のデーモンが起きている筐体ぶん。asicen-userland の asicend も
    /// 内蔵カードを同じ IPC で出すので、置き場と名前だけ変えて使う (Asicen.cs)
    /// </summary>
    internal static IReadOnlyList<CardLinkCandidate> Find(
        string runtimeDir, Px4Wire wire, Func<string, bool> valid, Func<string, string> name)
    {
        var root = Path.Combine(runtimeDir, wire.Product);
        if (!Directory.Exists(root)) return [];
        return
        [
            .. Directory.EnumerateDirectories(root)
                .Select(dir => (Id: Path.GetFileName(dir), Socket: Px4Control.Endpoint(runtimeDir, Path.GetFileName(dir), "control.sock", wire)))
                .Where(found => valid(found.Id) && File.Exists(found.Socket))
                .OrderBy(found => found.Id, StringComparer.Ordinal)
                .Select(found =>
                {
                    var label = name(found.Id);
                    return new CardLinkCandidate(label, () => Open(label, found.Socket, wire));
                }),
        ];
    }

    /// <summary>ソケットに繋いで HELLO まで済ませる。**カードにはまだ触らない** (<see cref="Reset"/>)</summary>
    public static Px4Card Open(string name, string socketPath, Px4Wire? wire = null)
    {
        wire ??= Px4Wire.Px4;
        var control = Px4Control.Connect(socketPath, CardCapability, Timeout, wire);
        if ((control.Capabilities & CardCapability) == 0)
        {
            control.Dispose();
            throw new IOException($"{wire.Daemon} がカードに対応していません");
        }
        return new Px4Card(name, control, wire.Daemon);
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
            var answer = _control.Request(Px4Control.CardConnect, [1]);
            if (answer.Length < 9 || answer.Length != 9 + answer[8])
            {
                throw new IOException($"{_daemon} の CARD_CONNECT の答えが崩れています ({answer.Length} バイト)");
            }
            _handle = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            return answer[9..];
        }

        var payload = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
        var atr = _control.Request(Px4Control.CardReset, payload);
        if (atr.Length < 1 || atr.Length != 1 + atr[0])
        {
            throw new IOException($"{_daemon} の CARD_RESET の答えが崩れています ({atr.Length} バイト)");
        }
        return atr[1..];
    }

    /// <summary>
    /// APDU を1つ。**失敗は全部 <see cref="IOException"/>** (Px4Control.Request) —
    /// 繋ぎ直すかどうかを決めるのは <see cref="BCas"/> で、そちらは IOException だけを見る。
    /// </summary>
    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_handle == 0) throw new IOException("カードに繋いでいません (Reset を先に)");

        var payload = new byte[12 + apdu.Length];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(8), (uint)apdu.Length);
        apdu.CopyTo(payload.AsSpan(12));

        var answer = _control.Request(Px4Control.CardTransmit, payload);
        if (answer.Length < 4 || answer.Length != 4 + BinaryPrimitives.ReadUInt32LittleEndian(answer))
        {
            throw new IOException($"{_daemon} の CARD_TRANSMIT の答えが崩れています ({answer.Length} バイト)");
        }
        return answer[4..];
    }

    /// <summary>カードを手放してから閉じる。**リセットはしない** (他の使い手が居るかもしれない)</summary>
    public void Dispose()
    {
        if (_handle != 0 && _control.Connected)
        {
            try
            {
                var payload = new byte[9];
                BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
                _control.Request(Px4Control.CardDisconnect, payload);
            }
            catch (IOException)
            {
                // 閉じれば px4d の側で手放される (SPEC 6.4)。ここで言うのは行儀の問題だけ
            }
            _handle = 0;
        }
        _control.Dispose();
    }
}
