namespace Denpa.Agent.Tests;

/*
 * 偽の IT930x (It930xTests.cs が使う)。振る舞いは ITE の SDK (api/brCmd.c・api/IT9300.c) から決めた。
 * EP 0x02 に来たフレームの長さ・チェックサム・シーケンス番号を検査し、合わなければテストを失敗にする (InvalidOperationException)。
 */

/// <summary>
/// 偽の IT930x。レジスタを辞書で持ち、受けたコマンドを 1 行ずつ <see cref="Log"/> に控える
/// (<c>R 1222 3</c>・<c>W 4976=00</c>・<c>QUERYINFO</c>・<c>SCATTER 48</c>・<c>BOOT</c>・<c>REBOOT</c>)
/// </summary>
internal sealed class FakeIt930x : IUsbDevice
{
    /// <summary>BOOT のあとに QUERYINFO が返すバージョン (この値は偽物で決めたもの。実機の値は確かめていない)</summary>
    public const uint BootVersion = 0x01040000;

    private readonly Queue<byte[]> _replies = new();
    private readonly Queue<byte[]> _late = new();
    private byte _expected;

    public string Name => "fake-it930x";

    public Dictionary<uint, byte> Registers { get; } = [];

    public List<string> Log { get; } = [];

    /// <summary>SCATTER_WRITE で受けたファームウェアのバイト</summary>
    public List<byte> Loaded { get; } = [];

    /// <summary>動いているファームウェアのバージョン (0 なら動いていない)</summary>
    public uint Running { get; set; }

    /// <summary>BOOT しても起動しない</summary>
    public bool BootFails { get; init; }

    /// <summary>REBOOT してもファームウェアが動いたまま</summary>
    public bool RebootKeepsRunning { get; init; }

    /// <summary>REBOOT で USB がつなぎ直される (そのあとの読み書きは <see cref="UsbGoneException"/>)</summary>
    public bool RebootGone { get; init; }

    /// <summary>REBOOT のあと、このコマンドの数だけ応答しない</summary>
    public int SilentAfterReboot { get; init; }

    /// <summary>この数のコマンドに応答しない。<see cref="KeepLate"/> なら、その応答は次の読みで遅れて届く</summary>
    public int Silent { get; set; }

    public bool KeepLate { get; init; }

    /// <summary>次の応答のチェックサムを壊す</summary>
    public bool CorruptNext { get; set; }

    /// <summary>次の応答の状態のバイト</summary>
    public byte StatusNext { get; set; }

    private bool _gone;

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs) =>
        throw new NotSupportedException();

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs) =>
        throw new NotSupportedException();

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth) => throw new NotSupportedException();

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        if (_gone) throw new UsbGoneException("fake-it930x が抜かれました");
        if (endpoint != 0x02) throw new InvalidOperationException($"EP 0x{endpoint:X2} に送った");
        if (data.Length > 63) throw new InvalidOperationException($"フレームが 63 バイトを超えた ({data.Length})");
        if (data[0] != data.Length - 1) throw new InvalidOperationException($"長さのバイトが違う ({data[0]}、フレーム {data.Length} バイト)");
        var checksum = (ushort)((data[^2] << 8) | data[^1]);
        if (Sum(data[1..^2]) != checksum) throw new InvalidOperationException("チェックサムが違う");
        if (data[3] != _expected) throw new InvalidOperationException($"シーケンス番号が違う ({data[3]}、期待は {_expected})");
        _expected++;
        var command = (ushort)((data[1] << 8) | data[2]);
        var payload = data[4..^2];
        var sequence = data[3];
        switch (command)
        {
            case 0x0000:
            {
                var (length, address) = Header(payload);
                Log.Add($"R {address:X4} {length}");
                var values = new byte[length];
                for (var i = 0; i < length; i++) values[i] = Registers.GetValueOrDefault(address + (uint)i);
                Reply(sequence, values);
                break;
            }
            case 0x0001:
            {
                var (length, address) = Header(payload);
                var values = payload[6..];
                if (values.Length != length) throw new InvalidOperationException($"書く長さが違う ({length}、中身 {values.Length} バイト)");
                Log.Add($"W {address:X4}={Convert.ToHexString(values)}");
                for (var i = 0; i < values.Length; i++) Registers[address + (uint)i] = values[i];
                Reply(sequence, []);
                break;
            }
            case 0x0022:
                if (payload is not [1]) throw new InvalidOperationException("QUERYINFO の中身が 1 でない");
                Log.Add("QUERYINFO");
                Reply(sequence, [(byte)(Running >> 24), (byte)(Running >> 16), (byte)(Running >> 8), (byte)Running]);
                break;
            case 0x0023 when Running != 0:
                // 動いている間の 0x0023 は REBOOT (SDK は応答を読まない)
                Log.Add("REBOOT");
                if (!RebootKeepsRunning) Running = 0;
                Loaded.Clear();
                if (RebootGone) _gone = true;
                Silent += SilentAfterReboot;
                break;
            case 0x0023:
                Log.Add("BOOT");
                Running = BootFails ? 0 : BootVersion;
                Reply(sequence, []);
                break;
            case 0x0029:
                Log.Add($"SCATTER {payload.Length}");
                Loaded.AddRange(payload.ToArray());
                Reply(sequence, []);
                break;
            default:
                throw new InvalidOperationException($"知らないコマンド 0x{command:X4}");
        }
    }

    /// <summary>レジスタの読み書きの、長さと番地。番地の長さは 0xFF までなら 1、それより上は 2 (SDK)</summary>
    private static (int Length, uint Address) Header(ReadOnlySpan<byte> payload)
    {
        var address = (uint)((payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5]);
        var expected = address > 0xFF ? 2 : 1;
        if (payload[1] != expected) throw new InvalidOperationException($"番地の長さが違う ({payload[1]}、期待は {expected})");
        return (payload[0], address);
    }

    private void Reply(byte sequence, ReadOnlySpan<byte> data)
    {
        var reply = new byte[5 + data.Length];
        reply[0] = (byte)(reply.Length - 1);
        reply[1] = sequence;
        reply[2] = StatusNext;
        StatusNext = 0;
        data.CopyTo(reply.AsSpan(3));
        var checksum = Sum(reply.AsSpan(1, reply.Length - 3));
        if (CorruptNext) checksum ^= 0x0001;
        CorruptNext = false;
        reply[^2] = (byte)(checksum >> 8);
        reply[^1] = (byte)checksum;
        _replies.Enqueue(reply);
    }

    /// <summary>SDK の式 (BrCmd_addChecksum) を、本体とは別に書いたもの</summary>
    internal static ushort Sum(ReadOnlySpan<byte> body)
    {
        var sum = 0;
        for (var i = 0; i < body.Length; i++) sum += i % 2 == 0 ? body[i] << 8 : body[i];
        return (ushort)~sum;
    }

    public int Read(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        if (_gone) throw new UsbGoneException("fake-it930x が抜かれました");
        if (endpoint != 0x81) throw new InvalidOperationException($"EP 0x{endpoint:X2} から読んだ");
        if (_late.TryDequeue(out var late)) return Copy(late, buffer);
        if (!_replies.TryDequeue(out var reply)) return 0;
        if (Silent > 0)
        {
            Silent--;
            if (KeepLate) _late.Enqueue(reply);
            return 0;
        }
        return Copy(reply, buffer);
    }

    private static int Copy(byte[] reply, Span<byte> buffer)
    {
        reply.CopyTo(buffer);
        return reply.Length;
    }

    public void Dispose()
    {
    }
}
