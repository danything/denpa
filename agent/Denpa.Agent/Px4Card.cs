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
    private ulong _handle;

    public string Name { get; }

    private Px4Card(string name, Px4Control control)
    {
        Name = name;
        _control = control;
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
                .Select(dir => (Id: Path.GetFileName(dir), Socket: Px4Control.Endpoint(runtimeDir, Path.GetFileName(dir), "control.sock")))
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
        var control = Px4Control.Connect(socketPath, CardCapability, Timeout);
        if ((control.Capabilities & CardCapability) == 0)
        {
            control.Dispose();
            throw new IOException("px4d がカードに対応していません");
        }
        return new Px4Card(name, control);
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
                throw new IOException($"px4d の CARD_CONNECT の答えが崩れています ({answer.Length} バイト)");
            }
            _handle = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            return answer[9..];
        }

        var payload = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, _handle);
        var atr = _control.Request(Px4Control.CardReset, payload);
        if (atr.Length < 1 || atr.Length != 1 + atr[0])
        {
            throw new IOException($"px4d の CARD_RESET の答えが崩れています ({atr.Length} バイト)");
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
            throw new IOException($"px4d の CARD_TRANSMIT の答えが崩れています ({answer.Length} バイト)");
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
