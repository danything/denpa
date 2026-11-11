namespace Denpa.Agent;

/*
 * Siano RIO 系の機材から届いた TS のメッセージの中身をつなげて、188 バイトのパケットに揃える。
 *
 * クリーンルームで、仕様書 (denpa-spec の siano/spec.md) だけから書いた。Linux カーネルの Siano のドライバと siano-userland のコードは読んでいない。
 * 仕様書 6.1 は「1 つのメッセージの中身が 188 の倍数とは限らないものとして扱い、余りを次のメッセージの先頭につなげ、0x47 で同期を取る」としている。
 * 同期の取り方の細部 (0x47 が 188 バイトおきに 2 つ続くところで揃える) は仕様書に無く、B25.cs の揃え直しと同じにした。
 */

/// <summary>
/// メッセージの中身を届いた順に受けて、188 バイトのパケットが続く範囲を渡す。パケットの途中で切れた余りは次の中身につなげる。
/// 揃っていない間は、0x47 が 188 バイトおきに 2 つ続くところまで 1 バイトずつ捨てる
/// </summary>
internal sealed class SianoTsAligner
{
    private const int Packet = 188;
    private const byte Sync = 0x47;

    private byte[] _store = new byte[SianoDevice.TransferSize + Packet];
    private int _used;
    private bool _synced;

    /// <summary>揃っていない間に捨てたバイト数</summary>
    public long Skipped { get; private set; }

    /// <summary>揃っていたのに、パケットの先頭が 0x47 でなくなった回数</summary>
    public int Lost { get; private set; }

    /// <summary>渡したパケットの数</summary>
    public long Packets { get; private set; }

    public void Push(ReadOnlySpan<byte> data, Action<ReadOnlySpan<byte>> sink)
    {
        if (_used == 0)
        {
            // 余りが無ければ、届いた中身を写さずにそのまま読む (ふつうはこちら)
            Keep(data[Take(data, sink)..]);
            return;
        }
        if (_used + data.Length > _store.Length) Array.Resize(ref _store, _used + data.Length);
        data.CopyTo(_store.AsSpan(_used));
        var all = _store.AsSpan(0, _used + data.Length);
        var rest = all[Take(all, sink)..];
        rest.CopyTo(_store);
        _used = rest.Length;
    }

    private void Keep(ReadOnlySpan<byte> rest)
    {
        if (rest.Length > _store.Length) Array.Resize(ref _store, rest.Length);
        rest.CopyTo(_store);
        _used = rest.Length;
    }

    /// <summary>渡せるだけ渡して、読み進めたバイト数を返す。残り (揃っていれば 188 バイト未満、揃っていなければ 188 バイト以下) は呼ぶ側が持ち越す</summary>
    private int Take(ReadOnlySpan<byte> data, Action<ReadOnlySpan<byte>> sink)
    {
        var at = 0;
        for (; ; )
        {
            if (_synced)
            {
                var start = at;
                while (data.Length - at >= Packet && data[at] == Sync) at += Packet;
                if (at > start)
                {
                    Packets += (at - start) / Packet;
                    sink(data[start..at]);
                }
                if (data.Length - at < Packet) return at;
                _synced = false;
                Lost++;
            }
            // 最後の 188 バイトの中の 0x47 は、次が届くまで同期バイトか決まらない
            while (data.Length - at > Packet && !(data[at] == Sync && data[at + Packet] == Sync))
            {
                at++;
                Skipped++;
            }
            if (data.Length - at <= Packet) return at;
            _synced = true;
        }
    }
}
