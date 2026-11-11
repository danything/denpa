namespace Denpa.Agent;

/// <summary><see cref="SplitTlv.Push"/> が組み立てた TLV パケットを受け取る (ヘッダーの 4 バイトを含む 1 つ分)</summary>
public delegate void TlvEmit(ReadOnlySpan<byte> packet);

/// <summary>
/// ケーブルの TSMF で分割 TLV として送られる TS (4K の局) の 188 バイトの単位から、TLV パケット (ARIB STD-B32 第 3 部) の並びを組み立て直す。
/// 中身の形式は変えない。TLV パケットを 1 バイトも変えずに並べるだけ。
///
/// <para>
/// 単位は 3 バイトのヘッダーと TLV のバイト列でできている (PX-MLT5PE と J:COM の QC26 の録りで確かめた。ケーブルの運用仕様は読んでいない)。
/// ヘッダーは <c>47 00 2D</c> か <c>47 40 2D</c> で、2 バイト目の <c>0x40</c> が立っている単位 (開始の単位) は 4 バイト目が pointer。
/// pointer の後ろの 184 バイトのうち、先頭から pointer の値までが前の TLV パケットの続きで、そこから新しい TLV パケットが始まる。
/// <c>0x40</c> の無い単位は、4 バイト目からの 185 バイトがそのまま前の続き。ヘッダーの各ビットの名前は確かめていないので、
/// <c>0x40</c> のほかは見ず、<c>00 2D</c>・<c>40 2D</c> でないヘッダーは数えるだけにする (<see cref="OtherHeaders"/>)。
/// </para>
///
/// <para>
/// 単位に連続性の番号は無い。欠けは TSMF のフレームの欠けでしか分からないので、<see cref="TsmfSelector"/> がフレームを捨てたら (<see cref="TsmfSelector.Gaps"/>)
/// 呼ぶ側が <see cref="Break"/> を呼ぶ。組み立て中の TLV パケットを捨て、次の開始の単位の pointer から組み立て直す。
/// TLV パケットの先頭が <c>0x7F</c> でない・種類が知らない値・pointer が単位からはみ出る・開始の単位が来たのに組み立て中のパケットが終わっていない、
/// のどれかのときも同じく捨てて合わせ直す。そろったパケットだけを出力する。
/// </para>
///
/// <para>
/// <see cref="Push"/> と <see cref="Break"/> は 1 つのスレッドから呼ぶ。数はほかのスレッドから読んでよい (<c>--tune</c> が出す)。
/// </para>
/// </summary>
public sealed class SplitTlv
{
    public const int UnitSize = 188;

    /// <summary>単位のヘッダーの長さ (<c>47 00 2D</c>)</summary>
    public const int HeaderSize = 3;

    /// <summary>開始の印 (単位の 2 バイト目)</summary>
    public const byte StartFlag = 0x40;

    /// <summary>TLV パケットの先頭のバイト (ARIB STD-B32 第 3 部。上位 2 ビットが <c>01</c>、残りは予約で 1)</summary>
    public const byte Sync = 0x7F;

    /// <summary>TLV パケットのヘッダー (先頭・種類・長さ 2 バイト)</summary>
    public const int TlvHeaderSize = 4;

    /// <summary>TLV パケットの種類の名前。ここに無い値は壊れたパケットとして合わせ直す</summary>
    public static readonly IReadOnlyDictionary<byte, string> Types = new Dictionary<byte, string>
    {
        [0x01] = "IPv4",
        [0x02] = "IPv6",
        [0x03] = "ヘッダー圧縮した IP",
        [0xFE] = "伝送制御信号",
        [0xFF] = "ヌル",
    };

    private readonly byte[] _packet = new byte[TlvHeaderSize + ushort.MaxValue];
    private readonly long[] _byType = new long[256];
    /// <summary>組み立て中のパケットの、そろったバイト数</summary>
    private int _have;
    /// <summary>組み立て中のパケットの長さ (ヘッダーを含む)。ヘッダーがそろうまでは 0</summary>
    private int _need;
    /// <summary>開始の単位を受けて、TLV パケットの先頭の位置が分かっている</summary>
    private bool _synced;
    private long _units, _starts, _packets, _droppedBytes, _resyncs, _breaks, _otherHeaders;

    /// <summary>受けた単位の数</summary>
    public long Units => Volatile.Read(ref _units);

    /// <summary>開始の印 (<c>0x40</c>) のある単位の数</summary>
    public long Starts => Volatile.Read(ref _starts);

    /// <summary>出力した TLV パケットの数</summary>
    public long Packets => Volatile.Read(ref _packets);

    /// <summary>出力せずに捨てたバイトの数 (最初の開始の単位より前、合わせ直すまでの間、組み立て中に捨てたパケット)</summary>
    public long DroppedBytes => Volatile.Read(ref _droppedBytes);

    /// <summary>中身の食い違い (先頭・種類・pointer) で合わせ直した回数</summary>
    public long Resyncs => Volatile.Read(ref _resyncs);

    /// <summary>TSMF のフレームの欠けで合わせ直した回数 (<see cref="Break"/>)</summary>
    public long Breaks => Volatile.Read(ref _breaks);

    /// <summary>ヘッダーが <c>47 00 2D</c>・<c>47 40 2D</c> でなかった単位の数 (読み方は変えずに数えるだけ)</summary>
    public long OtherHeaders => Volatile.Read(ref _otherHeaders);

    /// <summary>出力した TLV パケットの、種類ごとの数 (出力したものがある種類だけ)</summary>
    public IReadOnlyList<(byte Type, long Count)> ByType =>
        [.. Enumerable.Range(0, 256).Select(type => ((byte)type, Volatile.Read(ref _byType[type]))).Where(pair => pair.Item2 > 0)];

    /// <summary>単位を 1 つ (188 バイト) 渡す。そろった TLV パケットを <paramref name="emit"/> に渡す</summary>
    public void Push(ReadOnlySpan<byte> unit, TlvEmit emit)
    {
        if (unit.Length != UnitSize) throw new ArgumentException($"分割 TLV の単位は {UnitSize} バイトです ({unit.Length})", nameof(unit));
        _units++;
        if ((unit[1] & ~StartFlag) != 0x00 || unit[2] != 0x2D) _otherHeaders++;
        if ((unit[1] & StartFlag) == 0)
        {
            var rest = unit[HeaderSize..];
            if (_synced) Append(rest, emit);
            else _droppedBytes += rest.Length;
            return;
        }

        _starts++;
        var pointer = unit[HeaderSize];
        var body = unit[(HeaderSize + 1)..];
        if (pointer >= body.Length)
        {
            // pointer が単位の外を指している。この単位では始められない (合わせ直した回数に数えるのは、合っていたときだけ)
            if (_synced) Lose(body.Length);
            else _droppedBytes += body.Length;
            return;
        }
        if (_synced)
        {
            Append(body[..pointer], emit);
            // pointer の位置で前のパケットが終わっていない。食い違ったので、前のパケットを捨てて pointer から始め直す
            if (_synced && (_have > 0 || _need > 0)) Lose(0);
        }
        else
        {
            _droppedBytes += pointer;
        }
        if (!_synced)
        {
            _synced = true;
            _have = 0;
            _need = 0;
        }
        Append(body[pointer..], emit);
    }

    /// <summary>
    /// 単位が欠けた (TSMF のフレームを捨てた)。組み立て中の TLV パケットを捨て、次の開始の単位まで何も出力しない。
    /// まだ合わせていない (最初の開始の単位の前・合わせ直している間) なら何もしない
    /// </summary>
    public void Break()
    {
        if (!_synced) return;
        _breaks++;
        _droppedBytes += _have;
        _have = 0;
        _need = 0;
        _synced = false;
    }

    /// <summary>食い違った。組み立て中のパケットと、<paramref name="more"/> バイトを捨てて、次の開始の単位まで待つ</summary>
    private void Lose(int more)
    {
        _resyncs++;
        _droppedBytes += _have + more;
        _have = 0;
        _need = 0;
        _synced = false;
    }

    /// <summary>TLV のバイト列を組み立て中のパケットの後ろに足す。そろったら出力する</summary>
    private void Append(ReadOnlySpan<byte> data, TlvEmit emit)
    {
        while (data.Length > 0)
        {
            if (_need == 0)
            {
                // ヘッダー (4 バイト) をそろえる
                var take = Math.Min(TlvHeaderSize - _have, data.Length);
                data[..take].CopyTo(_packet.AsSpan(_have));
                _have += take;
                data = data[take..];
                if (_packet[0] != Sync || (_have > 1 && !Types.ContainsKey(_packet[1])))
                {
                    Lose(data.Length);
                    return;
                }
                if (_have < TlvHeaderSize) return;
                _need = TlvHeaderSize + ((_packet[2] << 8) | _packet[3]);
            }
            var copy = Math.Min(_need - _have, data.Length);
            data[..copy].CopyTo(_packet.AsSpan(_have));
            _have += copy;
            data = data[copy..];
            if (_have < _need) return;
            _byType[_packet[1]]++;
            _packets++;
            emit(_packet.AsSpan(0, _need));
            _have = 0;
            _need = 0;
        }
    }
}
