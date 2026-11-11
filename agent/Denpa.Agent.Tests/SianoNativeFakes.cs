using System.Buffers.Binary;
using System.Collections.Concurrent;

namespace Denpa.Agent.Tests;

/*
 * Siano RIO 系の機材の偽物。機材の振る舞いは仕様書 (denpa-spec の siano/spec.md) から決めた (カーネルのドライバと siano-userland の出力は使っていない)。
 *
 * FakeSianoUsb は、バルク OUT (EP 0x02) に書かれたメッセージを控え、仕様書 3.5 の応答 (番号 + 1) をバルク IN の転送として返す。
 * 1 回の転送が 1 つのメッセージ。バージョンの応答・統計の応答の中身、応答しない番号、ロックするかは、テストが決める。
 */
internal sealed class FakeSianoUsb : IUsbDevice
{
    private readonly BlockingCollection<byte[]> _in = new(new ConcurrentQueue<byte[]>());
    private readonly Lock _gate = new();

    public string Name => "usb 1-2";

    /// <summary>ディスクリプタの端点。既定は仕様書 2.1 の推定 (IN 0x81・OUT 0x02、どちらもバルクで 512 バイト)</summary>
    public List<UsbPipe> Endpoints { get; set; } = [new(0x81, 2, 512), new(0x02, 2, 512)];

    /// <summary>起きたことの順 (clear 81・in 81 16384x32・out 668・in stop・dispose)</summary>
    public List<string> Log { get; } = [];

    /// <summary>OUT に書かれたメッセージ (ヘッダを含む)</summary>
    public List<byte[]> Sent { get; } = [];

    /// <summary>ストールのクリアを失敗させる</summary>
    public bool ClearHaltFails { get; set; }

    /// <summary>バージョンの応答の位置 4 (動いているモード)</summary>
    public byte Mode { get; set; } = SianoVersion.NoFirmware;

    /// <summary>バージョンの応答の位置 5 (対応モードのビット)</summary>
    public byte Modes { get; set; }

    /// <summary>バージョンの応答の位置 10・11 (ROM のバージョン)</summary>
    public (byte Major, byte Minor) Rom { get; set; } = (8, 0);

    /// <summary>バージョンの応答の中身の長さ</summary>
    public int VersionLength { get; set; } = 48;

    /// <summary>実行の合図 (664) を受けたあとのモード。null なら変えない</summary>
    public byte? ModeAfterRun { get; set; } = SianoVersion.Isdbt;

    /// <summary>応答しない要求の番号</summary>
    public HashSet<ushort> Mute { get; } = [];

    /// <summary>この数の「データの書き込み」に応答したあとは、応答しない (0 以下なら全部に応答する)</summary>
    public int DataWritesAnswered { get; set; }

    /// <summary>統計の応答の「復調のロック」を立てるか</summary>
    public bool Signal { get; set; } = true;

    /// <summary>統計の要求に、要求と違う形式で応答する (新しい形式の要求に古い形式、またはその逆)</summary>
    public bool StatsOtherForm { get; set; }

    /// <summary>統計の応答の SNR と受信電力</summary>
    public (int Snr, int Power) Level { get; set; } = (24, -52);

    /// <summary>「データの書き込み」で受けたアドレスとデータ</summary>
    public List<(uint Address, byte[] Data)> Written { get; } = [];

    private bool _gone;
    private int _dataWrites;

    public static byte[] Message(ushort number, ReadOnlySpan<byte> payload, ushort flags = 0, byte sender = 11, byte receiver = 0)
    {
        var message = new byte[8 + payload.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(message, number);
        message[2] = sender;
        message[3] = receiver;
        BinaryPrimitives.WriteUInt16LittleEndian(message.AsSpan(4), (ushort)message.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(message.AsSpan(6), flags);
        payload.CopyTo(message.AsSpan(8));
        return message;
    }

    /// <summary>機材から 1 回の転送を届ける</summary>
    public void Deliver(byte[] transfer) => _in.Add(transfer);

    public void Deliver(ushort number, ReadOnlySpan<byte> payload = default) => Deliver(Message(number, payload));

    /// <summary>機材を抜く (読みが「抜かれた」で終わる)</summary>
    public void Unplug() => _gone = true;

    public byte[] VersionPayload()
    {
        var payload = new byte[VersionLength];
        if (payload.Length >= 2) BinaryPrimitives.WriteUInt16LittleEndian(payload, 0x2130);
        if (payload.Length > 4) payload[4] = Mode;
        if (payload.Length > 5) payload[5] = Modes;
        if (payload.Length > 11)
        {
            payload[10] = Rom.Major;
            payload[11] = Rom.Minor;
        }
        return payload;
    }

    /// <summary>統計の応答の中身 (仕様書 7.2・7.3)。新しい形式は 288 バイト、古い形式は 216 バイト</summary>
    public static byte[] Stats(bool newForm, bool locked, int snr = 0, int power = 0, uint type = 6)
    {
        var skip = newForm ? 4 : 0;
        var payload = new byte[newForm ? 288 : 216];
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(skip), type);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(skip + 12), locked ? 1u : 0u);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(skip + 20), snr);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(skip + 28), power);
        return payload;
    }

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs) =>
        throw new InvalidOperationException("制御転送は使わない (仕様書 2.1)");

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs) =>
        throw new InvalidOperationException("制御転送は使わない (仕様書 2.1)");

    public int Read(byte endpoint, Span<byte> buffer, int timeoutMs) =>
        throw new InvalidOperationException("IN は出したままの読みで受ける (仕様書 2.3)");

    public IReadOnlyList<UsbPipe> Pipes() => Endpoints;

    public void ClearHalt(byte endpoint)
    {
        lock (_gate) Log.Add($"clear {endpoint:X2}");
        if (ClearHaltFails) throw new IOException("ストールをクリアできません");
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        if (_gone) throw new UsbGoneException($"{Name} が抜かれました");
        var number = BinaryPrimitives.ReadUInt16LittleEndian(data);
        var payload = data[8..].ToArray();
        lock (_gate)
        {
            Log.Add($"out {endpoint:X2} {number} {timeoutMs}ms");
            Sent.Add(data.ToArray());
        }
        if (Mute.Contains(number)) return;
        switch (number)
        {
            case SianoMessage.Version:
                Deliver(SianoMessage.VersionDone, VersionPayload());
                break;
            case SianoMessage.DataWrite:
                lock (_gate) Written.Add((BinaryPrimitives.ReadUInt32LittleEndian(payload), payload[4..]));
                if (DataWritesAnswered > 0 && ++_dataWrites > DataWritesAnswered) return;
                Deliver(SianoMessage.DataWriteDone);
                break;
            case SianoMessage.DataCheck:
                Deliver(SianoMessage.DataCheckDone, new byte[4]);
                break;
            case SianoMessage.Run:
                if (ModeAfterRun is { } mode) Mode = mode;
                Deliver(SianoMessage.RunDone);
                break;
            case SianoMessage.ModeInit:
                Mode = (byte)BinaryPrimitives.ReadUInt32LittleEndian(payload);
                Deliver(SianoMessage.ModeInitDone);
                break;
            case SianoMessage.Tune:
                Deliver(SianoMessage.TuneDone);
                break;
            case SianoMessage.StatsNew or SianoMessage.StatsOld:
                var newForm = (number == SianoMessage.StatsNew) != StatsOtherForm;
                Deliver(newForm ? SianoMessage.StatsNewDone : SianoMessage.StatsOldDone, Stats(newForm, Signal, Level.Snr, Level.Power));
                break;
            // PID を足す (601) には応答しない (仕様書 6.2 の「応答を返さないことがある」)
        }
    }

    /// <summary>番号ごとに、送られたメッセージ</summary>
    public List<byte[]> SentOf(ushort number)
    {
        lock (_gate) return [.. Sent.Where(message => BinaryPrimitives.ReadUInt16LittleEndian(message) == number)];
    }

    /// <summary>送られたメッセージの番号の並び</summary>
    public string Numbers()
    {
        lock (_gate) return string.Join(' ', Sent.Select(message => BinaryPrimitives.ReadUInt16LittleEndian(message)));
    }

    public string[] Events()
    {
        lock (_gate) return [.. Log];
    }

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        lock (_gate) Log.Add($"in {endpoint:X2} {transferSize}x{depth}");
        return new FakeIn(this);
    }

    private sealed class FakeIn(FakeSianoUsb owner) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs) => throw new InvalidOperationException("転送ごとに読む (仕様書 2.3)");

        public int ReadTransfer(Span<byte> buffer, int timeoutMs)
        {
            if (owner._gone) throw new UsbGoneException($"{owner.Name} が抜かれました");
            if (!owner._in.TryTake(out var transfer, timeoutMs)) return 0;
            var take = Math.Min(transfer.Length, buffer.Length);
            transfer.AsSpan(0, take).CopyTo(buffer);
            return take;
        }

        public void Dispose()
        {
            lock (owner._gate) owner.Log.Add("in stop");
        }
    }

    public void Dispose()
    {
        lock (_gate) Log.Add("dispose");
    }
}

/// <summary>テストで使う組み立て</summary>
internal static class SianoFake
{
    /// <summary>短い待ち (どれも仕様書 11 の値を縮めたもの)</summary>
    public static readonly SianoTimings Fast = new(SendMs: 1_000, ResponseMs: 300, RunSettleMs: 400, LockMs: 400, StatsEveryMs: 20, StatsResponseMs: 200, ReadMs: 10);

    /// <summary>ファームウェアのファイル (仕様書 1.3 と同じ 85,840 バイト。中身は作り物)</summary>
    public static byte[] FirmwareFile(int size = 85_840, uint address = 0x0040_0000, uint? length = null)
    {
        var file = new byte[size];
        for (var i = 12; i < size; i++) file[i] = (byte)(i * 7 + 1);
        BinaryPrimitives.WriteUInt32LittleEndian(file, 0xDEADBEEF);
        BinaryPrimitives.WriteUInt32LittleEndian(file.AsSpan(4), length ?? (uint)(size - 12));
        BinaryPrimitives.WriteUInt32LittleEndian(file.AsSpan(8), address);
        return file;
    }

    /// <summary>偽の USB の上の機材。<paramref name="sleeps"/> に待った時間が入る (実際には待たない)</summary>
    public static SianoDevice Device(FakeSianoUsb usb, List<int>? sleeps = null, Func<SianoFirmware>? firmware = null, SianoTimings? timings = null, List<string>? log = null) =>
        new(usb, "PLEX PX-S1UD 1-2", firmware ?? (() => SianoFirmware.Parse(FirmwareFile())), timings ?? Fast,
            ms => sleeps?.Add(ms), message =>
            {
                if (log is null) return;
                lock (log) log.Add(message);
            });

    /// <summary>開いて起動まで済ませた機材</summary>
    public static SianoDevice Started(FakeSianoUsb usb, List<int>? sleeps = null, Func<SianoFirmware>? firmware = null, SianoTimings? timings = null, List<string>? log = null)
    {
        var device = Device(usb, sleeps, firmware, timings, log);
        device.Start();
        return device;
    }

    /// <summary>連続性カウンタを進めた TS のパケットを <paramref name="count"/> 個</summary>
    public static byte[] Packets(int count, int first = 0)
    {
        var ts = new byte[count * 188];
        for (var i = 0; i < count; i++)
        {
            var at = i * 188;
            ts[at] = 0x47;
            ts[at + 1] = 0x01;
            ts[at + 2] = 0x00;
            ts[at + 3] = (byte)(0x10 | ((first + i) & 0x0F));
            for (var j = 4; j < 188; j++) ts[at + j] = (byte)(first + i);
        }
        return ts;
    }

    public static uint U32(byte[] message, int word) => BinaryPrimitives.ReadUInt32LittleEndian(message.AsSpan(8 + word * 4));
}
