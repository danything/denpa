/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の core/ts_mux.c・core/ts_framer.c・
 * core/stream_input.c を移したもの。Copyright (c) 2026 huggy、MIT License (全文は licenses/mAgicVISION.txt)。
 */

using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>188 バイトのパケットを 1 つ受け取る</summary>
public delegate void Dt295PacketSink(ReadOnlySpan<byte> packet);

/// <summary>
/// 常駐方式の DT295 が bulk IN (0x81) に出すデータから、188 バイトの TS パケットを取り出す (stream_input.c)。
/// 出し方は 2 通り (受信部の説明の StreamFormat)。
/// <list type="bullet">
/// <item>MUX: 512 バイトのフレーム (先頭 16 バイトに "XZM1"・受信部・番号・長さ、続く 496 バイトに中身)。受信部ごとの番号が 0 から 1 つずつ増える</item>
/// <item>そのまま: TS の記録が続く</item>
/// </list>
/// 記録は 188 バイトか、後ろに 4 バイトが付いた 192 バイト (受信部の説明の RecordSize)。4 バイトは捨てる。
/// 同期バイトの並びが崩れたら、2 つ続けて 0x47 が並ぶ所を探し直して続ける。MUX の形や番号が崩れたら、それ以後は受け取らない
/// </summary>
public sealed class Dt295ResidentTs
{
    public const int FrameBytes = 512;
    public const int FrameHeader = 16;
    public const int FramePayload = 496;

    /// <summary>"XZM1"</summary>
    public const uint MuxMagic = 0x585A4D31;

    private readonly bool _mux;
    private readonly int _source;
    private readonly int _record;
    private readonly byte[] _frame = new byte[FrameBytes];
    private int _frameUsed;
    private readonly uint[] _next = new uint[Dt295ResidentProtocol.SourceCount];
    private readonly byte[] _storage;
    private int _used;
    private bool _synchronized;

    /// <param name="format"><see cref="Dt295ResidentProtocol.FormatMux"/> か <see cref="Dt295ResidentProtocol.FormatRaw"/></param>
    /// <param name="source">受け取る受信部。MUX のフレームがほかの受信部なら崩れたとみる</param>
    /// <param name="recordSize">188 か 192</param>
    public Dt295ResidentTs(uint format, int source, int recordSize)
    {
        if (format is not (Dt295ResidentProtocol.FormatMux or Dt295ResidentProtocol.FormatRaw)) throw new ArgumentOutOfRangeException(nameof(format));
        if (source is < 0 or >= Dt295ResidentProtocol.SourceCount) throw new ArgumentOutOfRangeException(nameof(source));
        if (recordSize is not (188 or 192)) throw new ArgumentOutOfRangeException(nameof(recordSize));
        _mux = format == Dt295ResidentProtocol.FormatMux;
        _source = source;
        _record = recordSize;
        _storage = new byte[recordSize * 2];
    }

    /// <summary>崩れて受け取れなくなった理由。崩れていなければ null</summary>
    public string? Broken { get; private set; }

    /// <summary>同期を探し直した回数</summary>
    public long Desyncs { get; private set; }

    /// <summary>同期を探す間に捨てたバイト数</summary>
    public long Discarded { get; private set; }

    /// <summary>
    /// 届いたデータを渡す。取り出せたパケットを順に <paramref name="sink"/> に渡す。崩れたら false (<see cref="Broken"/> に理由)
    /// </summary>
    public bool Push(ReadOnlySpan<byte> data, Dt295PacketSink sink)
    {
        if (Broken is not null) return false;
        if (!_mux)
        {
            Frame(data, sink);
            return true;
        }
        while (!data.IsEmpty)
        {
            if (_frameUsed == 0 && data.Length >= FrameBytes)
            {
                if (!Consume(data[..FrameBytes], sink)) return false;
                data = data[FrameBytes..];
                continue;
            }
            var take = Math.Min(FrameBytes - _frameUsed, data.Length);
            data[..take].CopyTo(_frame.AsSpan(_frameUsed));
            _frameUsed += take;
            data = data[take..];
            if (_frameUsed != FrameBytes) continue;
            _frameUsed = 0;
            if (!Consume(_frame, sink)) return false;
        }
        return true;
    }

    /// <summary>MUX のフレーム 1 つ (ts_mux.c の consume_frame)</summary>
    private bool Consume(ReadOnlySpan<byte> frame, Dt295PacketSink sink)
    {
        var magic = BinaryPrimitives.ReadUInt32BigEndian(frame);
        var channel = BinaryPrimitives.ReadUInt32BigEndian(frame[4..]);
        var sequence = BinaryPrimitives.ReadUInt32BigEndian(frame[8..]);
        var length = BinaryPrimitives.ReadUInt32BigEndian(frame[12..]);
        if (magic != MuxMagic || channel >= Dt295ResidentProtocol.SourceCount || length is 0 or > FramePayload)
        {
            Broken = $"MUX のフレームの形が違います ({Convert.ToHexString(frame[..FrameHeader])})";
            return false;
        }
        if (sequence != _next[channel])
        {
            Broken = $"MUX のフレームの番号が飛びました (受信部 {channel}、{_next[channel]} のはずが {sequence})";
            return false;
        }
        if (channel != _source)
        {
            Broken = $"選んでいない受信部 {channel} のフレームが届きました";
            return false;
        }
        _next[channel]++;
        Frame(frame.Slice(FrameHeader, (int)length), sink);
        return true;
    }

    /// <summary>記録を並べ、188 バイトずつ渡す (ts_framer.c の mb86H_ts_framer_push)</summary>
    private void Frame(ReadOnlySpan<byte> input, Dt295PacketSink sink)
    {
        foreach (var value in input)
        {
            if (_used == _storage.Length)
            {
                if (!_synchronized) Align();
                Drain(sink);
            }
            _storage[_used++] = value;
            if (!_synchronized) Align();
        }
        Drain(sink);
    }

    private void Drain(Dt295PacketSink sink)
    {
        while (_synchronized && _used >= _record)
        {
            if (_storage[0] != 0x47)
            {
                _synchronized = false;
                Desyncs++;
                Drop(1);
                return;
            }
            sink(_storage.AsSpan(0, 188));
            _storage.AsSpan(_record, _used - _record).CopyTo(_storage);
            _used -= _record;
        }
    }

    /// <summary>2 つ続けて 0x47 が並ぶ所を探す (ts_framer.c の find_alignment)</summary>
    private void Align()
    {
        if (_used < _record * 2) return;
        for (var offset = 0; offset + _record * 2 <= _used; offset++)
        {
            if (_storage[offset] == 0x47 && _storage[offset + _record] == 0x47)
            {
                Drop(offset);
                _synchronized = true;
                return;
            }
        }
        Drop(_used - (_record * 2 - 1));
    }

    private void Drop(int count)
    {
        _storage.AsSpan(count, _used - count).CopyTo(_storage);
        _used -= count;
        Discarded += count;
    }
}
