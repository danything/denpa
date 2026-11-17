using System.Diagnostics.CodeAnalysis;

namespace Denpa.Agent;

/// <summary>
/// USB の機材 1 台ぶんの持ち主に共通の部分 (<see cref="Dt295NativeDevice"/>・<see cref="Zd1jBoard"/>)。ポートごとに 1 つだけ持ち、
/// チューナーとカードが取って使う。取った数 (<see cref="_users"/>) と、USB が抜けた印 (<see cref="Fail"/>) を持つ。
/// 開く・返す・閉じるときにどのロックの中で閉じるかは機材ごとに違うので、それぞれの側で書く。
/// ロックの順は <see cref="Registry"/> → 持ち主の <see cref="_gate"/>
/// </summary>
public abstract class PortOwner<TSelf> where TSelf : PortOwner<TSelf>
{
    /// <summary>ポートごとの持ち主 (<see cref="Owners"/>) を触るときのロック。機材の種類ごとに 1 つ</summary>
    private protected static readonly Lock Registry = new();

    private protected static readonly Dictionary<string, TSelf> Owners = [];

    private protected readonly Lock _gate = new();

    /// <summary>取って、まだ返していない数。<see cref="_gate"/> の中で触る (開いた直後に 1 にするときを除く)</summary>
    private protected int _users;

    private bool _faulted;

    /// <summary>USB の抜けのほかに、機材ごとに使えなくなったと分かる印 (制御転送が通らない・ブリッジが応答しない)</summary>
    private protected abstract bool Dead { get; }

    /// <summary>使えなくなった。使っている側が返したらすぐ閉じる</summary>
    public bool Faulted => _faulted || Dead;

    /// <summary>失敗が USB の抜けなら、使えない印を付ける (次に取る側は開き直す)</summary>
    public void Fail(Exception error)
    {
        if (error is UsbGoneException) _faulted = true;
    }

    /// <summary>閉じる。2 回目からは何もしない</summary>
    private protected abstract void Close();

    /// <summary>
    /// <see cref="Registry"/> の中で呼ぶ。<paramref name="port"/> の持ち主が使えるなら、取った数を 1 つ増やして true を返す。
    /// 使えなければ false で、<paramref name="current"/> は使えなくなった持ち主 (無ければ null)。一覧からはまだ外さない
    /// </summary>
    private protected static bool TryReuse(string port, [NotNullWhen(true)] out TSelf? current)
    {
        if (Owners.TryGetValue(port, out current) && !current.Faulted)
        {
            lock (current._gate) current._users++;
            return true;
        }
        return false;
    }

    /// <summary>
    /// 誰も使っていなければ一覧から外して閉じる。<paramref name="closeInRegistry"/> なら閉じ終えるまで <see cref="Registry"/> を持つ
    /// (同じポートを開き直す側が、閉じる前の USB とぶつからないように)
    /// </summary>
    private protected static void CloseIdle(string port, bool closeInRegistry)
    {
        TSelf? owner;
        lock (Registry)
        {
            if (!Owners.TryGetValue(port, out owner)) return;
            lock (owner._gate)
            {
                if (owner._users > 0) return;
            }
            Owners.Remove(port);
            if (closeInRegistry)
            {
                owner.Close();
                return;
            }
        }
        owner.Close();
    }

    /// <summary>全部閉じる (エージェントを止めるとき)。使っている側がいても閉じる</summary>
    public static void CloseAll()
    {
        List<TSelf> owners;
        lock (Registry)
        {
            owners = [.. Owners.Values];
            Owners.Clear();
        }
        foreach (var owner in owners) owner.Close();
    }
}
