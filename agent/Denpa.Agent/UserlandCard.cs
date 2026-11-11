using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// 常駐 (asicend) の内蔵カードリーダー。**常駐の制御ソケットに直に APDU を送る。**
///
/// <para>
/// カードは常駐が持っていて (T=1 の枠組みも向こう)、制御ソケットの IPC (SPEC 6 節) でやり取りする (UserlandControl.cs)。
/// pcscd も IFD ハンドラも使わない。
/// </para>
///
/// <para>
/// ソケットの置き場は <see cref="UserlandControl"/> と同じ。1 本の接続で送れる要求は同時に 1 つだけで、順番は <see cref="BCas"/> が守る。
/// </para>
/// </summary>
public sealed class UserlandCard : ICardLink
{
    /// <summary>HELLO で要求する機能。bit 1 = CARD。**要求していない型は常駐が断る**</summary>
    private const uint CardCapability = 1 << 1;

    /// <summary>
    /// 1 回のやり取りの上限。常駐は APDU 1 つを 3 秒で打ち切る (SPEC 5.3) ので、
    /// それより長く待ってからやめる
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private readonly UserlandControl _control;
    private readonly string _daemon;
    private ulong _handle;

    public string Name { get; }

    private UserlandCard(string name, UserlandControl control, string daemon)
    {
        Name = name;
        _control = control;
        _daemon = daemon;
    }

    /// <summary>
    /// <paramref name="wire"/> のデーモンが起動している筐体ぶん。**挙げるだけで、繋ぐのは候補を開いたとき。**
    /// 筐体は制御ソケットがあるかで見る (常駐は起動すると筐体ごとに <c>control.sock</c> を作り、止まるときに消す)。
    /// **常駐を起動していない筐体は出てこない** (Asicen.cs)
    /// </summary>
    internal static IReadOnlyList<CardLinkCandidate> Find(
        string runtimeDir, UserlandWire wire, Func<string, bool> valid, Func<string, string> name)
    {
        var root = Path.Combine(runtimeDir, wire.Product);
        if (!Directory.Exists(root)) return [];
        return
        [
            .. Directory.EnumerateDirectories(root)
                .Select(dir => (Id: Path.GetFileName(dir), Socket: UserlandControl.Endpoint(runtimeDir, Path.GetFileName(dir), "control.sock", wire)))
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
    public static UserlandCard Open(string name, string socketPath, UserlandWire? wire = null)
    {
        wire ??= UserlandWire.Asicen;
        var control = UserlandControl.Connect(socketPath, CardCapability, Timeout, wire);
        if ((control.Capabilities & CardCapability) == 0)
        {
            control.Dispose();
            throw new IOException($"{wire.Daemon} がカードに対応していません");
        }
        return new UserlandCard(name, control, wire.Daemon);
    }

    /// <summary>
    /// 1 回目は CARD_CONNECT、2 回目からは CARD_RESET。**どちらも ATR が返る。**
    ///
    /// <para>
    /// 繋ぐのは共有 (share mode 1)。B-CAS は APDU を跨いだ状態を持たないので、
    /// 独占しなくても、割り込まれて問題になることが無い。
    /// </para>
    /// </summary>
    public byte[] Reset()
    {
        if (_handle == 0)
        {
            var answer = _control.Request(UserlandControl.CardConnect, [1]);
            if (answer.Length < 9 || answer.Length != 9 + answer[8])
            {
                throw new IOException($"{_daemon} の CARD_CONNECT の応答が崩れています ({answer.Length} バイト)");
            }
            _handle = BinaryPrimitives.ReadUInt64LittleEndian(answer);
            return answer[9..];
        }

        var atr = _control.Request(UserlandControl.CardReset, UserlandControl.WithId(_handle));
        if (atr.Length < 1 || atr.Length != 1 + atr[0])
        {
            throw new IOException($"{_daemon} の CARD_RESET の応答が崩れています ({atr.Length} バイト)");
        }
        return atr[1..];
    }

    /// <summary>
    /// APDU を 1 つ。**失敗は全部 <see cref="IOException"/>** (UserlandControl.Request)。
    /// 繋ぎ直すかどうかを決めるのは <see cref="BCas"/> で、そちらは IOException だけを見る。
    /// </summary>
    public byte[] Transmit(ReadOnlySpan<byte> apdu)
    {
        if (_handle == 0) throw new IOException("カードに繋いでいません (Reset を先に)");

        var payload = UserlandControl.WithId(_handle, 12 + apdu.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(8), (uint)apdu.Length);
        apdu.CopyTo(payload.AsSpan(12));

        var answer = _control.Request(UserlandControl.CardTransmit, payload);
        if (answer.Length < 4 || answer.Length != 4 + BinaryPrimitives.ReadUInt32LittleEndian(answer))
        {
            throw new IOException($"{_daemon} の CARD_TRANSMIT の応答が崩れています ({answer.Length} バイト)");
        }
        return answer[4..];
    }

    /// <summary>カードを手放してから閉じる。**リセットはしない** (他にカードを使っている接続があるかもしれない)</summary>
    public void Dispose()
    {
        if (_handle != 0 && _control.Connected)
        {
            try
            {
                // handle と disposition (0 = そのまま)
                _control.Request(UserlandControl.CardDisconnect, UserlandControl.WithId(_handle, 9));
            }
            catch (IOException)
            {
                // 閉じれば常駐の側で手放される (SPEC 6.4)。ここで CARD_DISCONNECT を送るのは、手順をそろえるためだけ
            }
            _handle = 0;
        }
        _control.Dispose();
    }
}
