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

    /// <summary>控えに 1 行足す (EP 0x84 の読みのスレッドからも呼ばれる)</summary>
    public void Note(string line)
    {
        lock (Log) Log.Add(line);
        OnNote?.Invoke(line);
    }

    /// <summary>控えに 1 行足すたびに呼ぶ (テストが割り込みの機会を作る)</summary>
    public Action<string>? OnNote { get; set; }

    /// <summary>挿し直した機材として、シーケンス番号の期待を 0 に戻す (同じ偽物を開き直すテスト)</summary>
    public void ResetSequence() => _expected = 0;

    /// <summary>
    /// GENERIC_WRITE・GENERIC_READ を渡す先 (バスごと。アドレスは 7 ビットに戻して渡す)。無いバスに来たらテストを失敗にする。
    /// 控えには <c>I2C W 3 65 0010</c>・<c>I2C R 3 65 1</c> の形で残す
    /// </summary>
    public Dictionary<byte, ICxdBus> I2c { get; } = [];

    // カードの番地 (SDK の brRegister.h・brVariable.h)
    public const uint UartRxLength = 0x496B;
    public const uint UartRealSend = 0x4965;
    public const uint CardResetOutput = 0xD8E3;
    public const uint CardDetectInput = 0xD8C6;

    /// <summary>GPIOH14 のリセットを解いたときに偽のカードが返す ATR。null ならカードは応答しない</summary>
    public byte[]? CardAtr { get; set; }

    /// <summary>まとめて送られたブロックに、偽のカードが返すバイト (null なら何も返さない)</summary>
    public Func<byte[], byte[]?>? CardResponder { get; set; }

    /// <summary>カードから受けて、まだ UART_READ で読まれていないバイト</summary>
    public Queue<byte> UartRx { get; } = new();

    /// <summary>カードに渡したブロック (OVA_UART_REALSEND のあとの UART_WRITE までをまとめたもの)。S(IFS) の要求は <see cref="UartIfs"/> に分ける</summary>
    public List<byte[]> UartBlocks { get; } = [];

    /// <summary>カードに渡した S(IFS) の要求の値 (こちらが受けられる情報欄の長さ)</summary>
    public List<byte> UartIfs { get; } = [];

    /// <summary>偽のカードが S(IFS) の要求に、同じ値の S(IFS) の応答を返すか。false なら何も返さない</summary>
    public bool CardAnswersIfs { get; set; } = true;

    /// <summary>
    /// カードの応答が届く速さ。0 ならすぐに全部届く。1 以上なら、受けた数 (OVA_UART_RX_LENGTH) を読むたびにこのバイト数ずつ届き、
    /// 届き終わる前の UART_READ はテストを失敗にする (実機では、届いている途中に読むとバイトが落ちた)
    /// </summary>
    public int UartArrival { get; set; }

    /// <summary>カードが送って、まだブリッジに届いていないバイト</summary>
    private readonly Queue<byte> _uartArriving = new();

    private readonly List<byte> _uartPending = [];

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

    /// <summary>遅れて届く応答を置く (次の読みで返る)</summary>
    public void Late(byte[] reply) => _late.Enqueue(reply);

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs) =>
        throw new NotSupportedException();

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs) =>
        throw new NotSupportedException();

    /// <summary>EP 0x84 の読みが返すバイト列 (1 つが 1 回の読み)。尽きたら時間切れ (0) を返す</summary>
    public Queue<byte[]> Ts { get; } = new();

    /// <summary>
    /// <see cref="Ts"/> が尽きているときに、EP 0x84 の読みが返すバイト列を作る (流れ続ける TS の代わり。読むスレッドから呼ぶ)。null を返したら時間切れ
    /// </summary>
    public Func<byte[]?>? TsSource
    {
        get => _tsSource;
        set => _tsSource = value;
    }

    private volatile Func<byte[]?>? _tsSource;

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth)
    {
        if (endpoint != 0x84) throw new InvalidOperationException($"EP 0x{endpoint:X2} の読みを出した");
        Note($"TS {transferSize} {depth}");
        return new FakeTsIn(this);
    }

    /// <summary>EP 0x84 の出しっぱなしの読み。閉じたら <see cref="Log"/> に控える</summary>
    private sealed class FakeTsIn(FakeIt930x owner) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (!owner.Ts.TryDequeue(out var chunk))
            {
                chunk = owner.TsSource?.Invoke();
                // 流れ続ける TS でも、ほかのスレッドが動けるように待つ
                Thread.Sleep(1);
                if (chunk is null) return 0;
            }
            chunk.CopyTo(buffer);
            return chunk.Length;
        }

        public void Dispose() => owner.Note("TS 閉じる");
    }

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
                Note($"R {address:X4} {length}");
                var values = new byte[length];
                for (var i = 0; i < length; i++) values[i] = Registers.GetValueOrDefault(address + (uint)i);
                // 受けたバイトの数 (OVA_UART_RX_LENGTH) は、偽のカードの受けの列から
                if (address == UartRxLength && length == 1)
                {
                    for (var i = 0; i < UartArrival && _uartArriving.Count > 0; i++) UartRx.Enqueue(_uartArriving.Dequeue());
                    values[0] = (byte)Math.Min(255, UartRx.Count);
                }
                Reply(sequence, values);
                break;
            }
            case 0x0001:
            {
                var (length, address) = Header(payload);
                var values = payload[6..];
                if (values.Length != length) throw new InvalidOperationException($"書く長さが違う ({length}、中身 {values.Length} バイト)");
                Note($"W {address:X4}={Convert.ToHexString(values)}");
                var resetBefore = Registers.GetValueOrDefault(CardResetOutput);
                for (var i = 0; i < values.Length; i++) Registers[address + (uint)i] = values[i];
                // GPIOH14 を 0 から 1 に戻すとリセットが解け、カードがあれば ATR を返す (IT9300_bcasResetCard)
                if (address == CardResetOutput && resetBefore == 0 && values[0] == 1 && CardAtr is { } atr && Registers.GetValueOrDefault(CardDetectInput) == 0)
                {
                    UartRx.Clear();
                    foreach (var b in atr) UartRx.Enqueue(b);
                }
                Reply(sequence, []);
                break;
            }
            case 0x0037:
                Note($"UART MODE {payload[0]}");
                Reply(sequence, []);
                break;
            case 0x0035:
                Note($"UART BAUD {payload[0]}");
                Reply(sequence, []);
                break;
            case 0x0034:
            {
                if (payload[0] != payload.Length - 1) throw new InvalidOperationException($"UART_WRITE の長さが違う ({payload[0]}、中身 {payload.Length - 1} バイト)");
                if (payload[0] is 0 or > 48) throw new InvalidOperationException($"UART_WRITE が 1〜48 バイトでない ({payload[0]})");
                Note($"UART W {payload[0]}");
                _uartPending.AddRange(payload[1..].ToArray());
                // 最後の区切りの前に OVA_UART_REALSEND に 1 が書いてあれば、溜めたぶんをまとめてカードに渡す (偽物で決めた振る舞い)
                if (Registers.GetValueOrDefault(UartRealSend) == 1)
                {
                    Registers[UartRealSend] = 0;
                    var block = _uartPending.ToArray();
                    _uartPending.Clear();
                    byte[]? answer;
                    if (block is [_, 0xC1, 1, var ifs, _])
                    {
                        // S(IFS) の要求には、同じ値の S(IFS) の応答 (PCB 0xE1) を返す
                        UartIfs.Add(ifs);
                        answer = CardAnswersIfs ? T1Protocol.Block(0xE1, [ifs]) : null;
                    }
                    else
                    {
                        UartBlocks.Add(block);
                        answer = CardResponder?.Invoke(block);
                    }
                    foreach (var b in answer ?? []) (UartArrival > 0 ? _uartArriving : UartRx).Enqueue(b);
                }
                Reply(sequence, []);
                break;
            }
            case 0x0033:
            {
                if (payload.Length != 1) throw new InvalidOperationException($"UART_READ の中身が 1 バイトでない ({payload.Length})");
                var length = payload[0];
                if (length is 0 or > 32) throw new InvalidOperationException($"UART_READ が 1〜32 バイトでない ({length})");
                if (_uartArriving.Count > 0) throw new InvalidOperationException($"カードの応答が届き終わる前に UART_READ で読んだ (残り {_uartArriving.Count} バイト)");
                if (length > UartRx.Count) throw new InvalidOperationException($"受けた数 ({UartRx.Count}) より多く読んだ ({length})");
                Note($"UART R {length}");
                var bytes = new byte[length];
                for (var i = 0; i < length; i++) bytes[i] = UartRx.Dequeue();
                Reply(sequence, bytes);
                break;
            }
            case 0x0022:
                if (payload is not [1]) throw new InvalidOperationException("QUERYINFO の中身が 1 でない");
                Note("QUERYINFO");
                Reply(sequence, [(byte)(Running >> 24), (byte)(Running >> 16), (byte)(Running >> 8), (byte)Running]);
                break;
            case 0x0023 when Running != 0:
                // 動いている間の 0x0023 は REBOOT (SDK は応答を読まない)
                Note("REBOOT");
                if (!RebootKeepsRunning) Running = 0;
                Loaded.Clear();
                if (RebootGone) _gone = true;
                Silent += SilentAfterReboot;
                break;
            case 0x0023:
                Note("BOOT");
                Running = BootFails ? 0 : BootVersion;
                Reply(sequence, []);
                break;
            case 0x0029:
                Note($"SCATTER {payload.Length}");
                Loaded.AddRange(payload.ToArray());
                Reply(sequence, []);
                break;
            case 0x002B:
            {
                var (length, bus, address) = (payload[0], payload[1], payload[2]);
                var bytes = payload[3..].ToArray();
                if (bytes.Length != length) throw new InvalidOperationException($"I2C の書く長さが違う ({length}、中身 {bytes.Length} バイト)");
                if ((address & 1) != 0) throw new InvalidOperationException($"I2C のアドレスが 8 ビットの書き込みの形でない (0x{address:X2})");
                Note($"I2C W {bus} {address >> 1:X2} {Convert.ToHexString(bytes)}");
                if (!I2c.TryGetValue(bus, out var target)) throw new InvalidOperationException($"I2C のバス {bus} に何もつながっていない");
                target.Write((byte)(address >> 1), bytes);
                Reply(sequence, []);
                break;
            }
            case 0x002A:
            {
                if (payload.Length != 3) throw new InvalidOperationException($"GENERIC_READ の中身が 3 バイトでない ({payload.Length})");
                var (length, bus, address) = (payload[0], payload[1], payload[2]);
                Note($"I2C R {bus} {address >> 1:X2} {length}");
                if (!I2c.TryGetValue(bus, out var target)) throw new InvalidOperationException($"I2C のバス {bus} に何もつながっていない");
                var bytes = new byte[length];
                target.Read((byte)(address >> 1), bytes);
                Reply(sequence, bytes);
                break;
            }
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
