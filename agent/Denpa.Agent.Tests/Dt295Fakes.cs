using System.Buffers.Binary;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/// <summary>眠らない時計。眠った分と、interrupt を待った分だけ進む</summary>
internal sealed class FakeDt295Time : IDt295Time
{
    public long NowMs { get; set; }
    public List<int> Sleeps { get; } = [];

    /// <summary>眠ったあとに呼ぶ (時刻で機材の様子を変えるふり)</summary>
    public Action? OnSleep { get; set; }

    public void Sleep(int ms)
    {
        Sleeps.Add(ms);
        NowMs += ms;
        OnSleep?.Invoke();
    }
}

/// <summary>
/// PIX-DT295 の ASSP の偽物 (仕様書 3 章の振る舞いだけ)。レジスターはバイトの表、0x90074 は 1 を書いたビットが消える。
/// コマンドが来たら完了コードとイベントを立て、I2C とセキュアコマンドは渡された関数に答えさせる
/// </summary>
internal sealed class FakeDt295Usb : IUsbDevice
{
    public readonly Dictionary<uint, byte> Memory = [];
    public List<string> Log { get; } = [];
    public List<byte[]> Bulk { get; } = [];
    public FakeDt295Time Time { get; } = new();

    /// <summary>I2C の相手。(アドレス, 送ったバイト) → 受けるバイト (受けなければ空)</summary>
    public Func<byte, byte[], int, byte[]>? I2cDevice { get; set; }

    /// <summary>セキュアコマンドの相手。要求の 512 バイト → 応答の 512 バイト</summary>
    public Func<byte[], byte[]>? SecureDevice { get; set; }

    /// <summary>完了コードの下位バイト (0x80 にすると失敗)</summary>
    public byte CodeLow { get; set; }

    /// <summary>コマンドのあとの状態 (cmd, sub, val → 状態。null なら変えない)。既定はアイドル設定 (cmd 1) で 0x11、idle の書き戻しの完了 (cmd 4 sub 1) で 0x10</summary>
    public Func<byte, byte, ushort, ushort?> NextState { get; set; } = (command, sub, _) => command switch
    {
        1 => (ushort?)0x0011,
        4 when sub == 1 => (ushort?)0x0010,
        _ => null,
    };

    /// <summary>コマンドが来たときに呼ぶ (カードの状態を変えるふりなど)</summary>
    public Action<byte, byte, ushort>? OnCommand { get; set; }

    public string Name => "fake dt295";

    private byte[] _i2cWrite = [];
    private byte _i2cAddress;

    public ushort Get16(uint address) => (ushort)((Memory.GetValueOrDefault(address) << 8) | Memory.GetValueOrDefault(address + 1));

    public void Set16(uint address, ushort value)
    {
        Memory[address] = (byte)(value >> 8);
        Memory[address + 1] = (byte)value;
    }

    public ushort Events
    {
        get => Get16(Dt295Bridge.EventRegister);
        set => Set16(Dt295Bridge.EventRegister, value);
    }

    public ushort State
    {
        get => Get16(Dt295Bridge.StateRegister);
        set => Set16(Dt295Bridge.StateRegister, value);
    }

    private static uint Address(ushort value, ushort index) => ((uint)(value >> 8) << 16) | index;

    public int ControlIn(byte requestType, byte request, ushort value, ushort index, Span<byte> data, int timeoutMs)
    {
        var address = Address(value, index);
        for (var i = 0; i < data.Length; i++) data[i] = Memory.GetValueOrDefault(address + (uint)i);
        return data.Length;
    }

    public void ControlOut(byte requestType, byte request, ushort value, ushort index, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Log.Add($"{requestType:X2} {request:X2} {value:X4} {index:X4} {Convert.ToHexString(data)}");
        if (request == 0xBC)
        {
            var address = Address(value, index);
            if (address == Dt295Bridge.EventRegister && data.Length == 2)
            {
                Events &= (ushort)~BinaryPrimitives.ReadUInt16BigEndian(data);
                return;
            }
            for (var i = 0; i < data.Length; i++) Memory[address + (uint)i] = data[i];
            return;
        }
        var (command, sub, val) = (data[0], data[1], (ushort)((data[2] << 8) | data[3]));
        var main = request == 0xB8;
        Set16(main ? Dt295Bridge.MainCode : Dt295Bridge.SubCode, (ushort)((command << 8) | CodeLow));
        if (command == 8 && SecureDevice is not null)
        {
            var mailbox = new byte[512];
            for (var i = 0; i < 512; i++) mailbox[i] = Memory.GetValueOrDefault(Dt295Bridge.Mailbox + (uint)i);
            var response = SecureDevice(mailbox);
            for (var i = 0; i < 512; i++) Memory[Dt295Bridge.Mailbox + (uint)i] = response[i];
        }
        if (command == 9) I2c(sub, val);
        if (NextState(command, sub, val) is { } state) State = state;
        OnCommand?.Invoke(command, sub, val);
        Events |= main ? Dt295Bridge.EventMainDone : Dt295Bridge.EventSubDone;
    }

    private void I2c(byte sub, ushort val)
    {
        var address = (byte)(val >> 8);
        var length = val & 0xFF;
        if (sub is 0 or 2)
        {
            _i2cAddress = address;
            _i2cWrite = [.. Enumerable.Range(0, length).Select(i => Memory.GetValueOrDefault(Dt295Bridge.I2cBuffer + (uint)i))];
        }
        if (sub == 2) return;
        var write = sub is 0 or 3 ? _i2cWrite : [];
        var read = I2cDevice?.Invoke(sub == 1 ? address : _i2cAddress, write, sub is 1 or 3 ? length : 0) ?? [];
        Set16(Dt295Bridge.I2cResult, 0);
        for (var i = 0; i < read.Length; i++) Memory[Dt295Bridge.I2cResult + 2 + (uint)i] = read[i];
        Events |= Dt295Bridge.EventI2c;
    }

    public void BulkWrite(byte endpoint, ReadOnlySpan<byte> data, int timeoutMs)
    {
        Log.Add($"BULK {endpoint:X2} {data.Length}");
        Bulk.Add(data.ToArray());
    }

    public int InterruptRead(byte endpoint, Span<byte> buffer, int timeoutMs)
    {
        Time.NowMs += timeoutMs;
        return 0;
    }

    /// <summary>EP 0x81 から渡すもの (1 つずつ 1 回の読みで渡す)</summary>
    public System.Collections.Concurrent.ConcurrentQueue<byte[]> Ts { get; } = new();

    public IUsbInStream OpenInStream(byte endpoint, int transferSize, int depth) => new InStream(this);

    private sealed class InStream(FakeDt295Usb usb) : IUsbInStream
    {
        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (usb.Ts.TryDequeue(out var chunk))
            {
                chunk.CopyTo(buffer);
                return chunk.Length;
            }
            Thread.Sleep(Math.Min(timeoutMs, 5));
            return 0;
        }

        public void Dispose()
        {
        }
    }

    /// <summary>TS 鍵の要求 (9.1) に返す 16 バイト (でたらめ)</summary>
    public static readonly byte[] TsKey = [.. Enumerable.Range(0, 16).Select(i => (byte)(0xA0 + i))];

    /// <summary>TS 鍵を要求された回数</summary>
    public int TsKeyRequests { get; private set; }

    /// <summary>セッションの更新を断る (ステータスを 0 以外にする)</summary>
    public bool RefuseRefresh { get; set; }

    /// <summary>
    /// 未認証のアイドル (0x10) で、認証と更新に答える偽物。セッション鍵は返答から 5.4 のとおりに作る
    /// (ここは Dt295Auth を使う。計算そのものは Dt295Tests が別に確かめている)。カードは 3 (使える)
    /// </summary>
    public static FakeDt295Usb Authenticating(Dt295Material material)
    {
        var usb = new FakeDt295Usb { State = Dt295Device.Idle };
        usb.Set16(0x822AC, 0x3000);
        var first = Enumerable.Range(0, 36).Select(i => (byte)(i * 11 + 4)).ToArray();
        var challenge = Enumerable.Range(0, 32).Select(i => (byte)(0x80 + i)).ToArray();
        byte[]? sessionKey = null;
        usb.SecureDevice = request =>
        {
            var id = BinaryPrimitives.ReadUInt32BigEndian(request);
            var plain = request.ToArray();
            if ((id & 0x400) != 0)
            {
                using var aes = System.Security.Cryptography.Aes.Create();
                aes.Key = sessionKey!;
                aes.DecryptCbc(plain.AsSpan(12, 496), material.SessionIv, plain.AsSpan(12, 496), System.Security.Cryptography.PaddingMode.None);
            }
            if (id == Dt295Device.AuthSecond)
            {
                var answer = plain.AsSpan(16, 20).ToArray();
                var n = Dt295Auth.RowIndex(material.Key1, material.AuthPrefix, first, Dt295Auth.InitialPayload());
                sessionKey = Dt295Auth.SessionKey(material.Key3, answer, material.Rows.AsSpan(32 * n, 32), material.SessionSuffix);
            }
            var response = new byte[512];
            BinaryPrimitives.WriteUInt32BigEndian(response, id);
            if (id == Dt295Device.TsKeyRequest) usb.TsKeyRequests++;
            if (id == Dt295Device.RefreshAnswer && usb.RefuseRefresh) BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(4), 0x00020019);
            byte[] reply = id switch
            {
                Dt295Device.AuthFirst => first,
                Dt295Device.RefreshQuery => challenge,
                Dt295Device.TsKeyRequest => TsKey,
                _ => [],
            };
            BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(8), (uint)(reply.Length / 4));
            reply.CopyTo(response, 16);
            if ((id & 0x200) != 0)
            {
                using var aes = System.Security.Cryptography.Aes.Create();
                aes.Key = sessionKey!;
                aes.EncryptCbc(response.AsSpan(12, 496), material.SessionIv, response.AsSpan(12, 496), System.Security.Cryptography.PaddingMode.None);
            }
            return response;
        };
        return usb;
    }

    /// <summary>
    /// <see cref="Authenticating"/> に、受信の状態の移り変わり (9.6・9.7・9.9) とエラーからの復帰 (5.8) を足したもの。
    /// I2C は何を聞かれても 0 を返す (衛星は未ロックにならない)
    /// </summary>
    public static FakeDt295Usb Receiving(Dt295Material material)
    {
        var usb = Authenticating(material);
        usb.I2cDevice = (_, _, read) => new byte[read];
        usb.NextState = (command, sub, value) => command switch
        {
            1 => (ushort?)0x0011,
            3 => 0x0010,
            4 when sub == 1 => 0x0010,
            4 when sub == 0x20 => 0x0001,
            5 when sub == 0 => value,
            _ => null,
        };
        return usb;
    }

    /// <summary>主コマンド (0xB8) を送った順に、4 バイトを 16 進で</summary>
    public List<string> MainCommands() =>
        [.. Log.Where(line => line.StartsWith("40 B8", StringComparison.Ordinal)).Select(line => line[^8..])];

    public void Dispose()
    {
    }
}

/// <summary>素材の偽物。範囲の並びは公式と同じで、中身はでたらめ (表は 255 以下の行)</summary>
internal static class FakeDt295Material
{
    public static byte[] Bytes()
    {
        var ranges = Dt295Firmware.Pixela.Ranges;
        var material = new byte[ranges.Sum(range => range.Length)];
        var at = 0;
        foreach (var range in ranges)
        {
            var piece = material.AsSpan(at, range.Length);
            if (range.Name is "T_DEMOD" or "S_DEMOD" or "T_RF_A" or "T_RF_B")
            {
                for (var row = 0; row < range.Length / 8; row++)
                {
                    BinaryPrimitives.WriteUInt32LittleEndian(piece[(row * 8)..], (uint)(0x40 + row));
                    BinaryPrimitives.WriteUInt32LittleEndian(piece[(row * 8 + 4)..], (uint)(row * 3 & 0xFF));
                }
            }
            else
            {
                for (var i = 0; i < piece.Length; i++) piece[i] = (byte)(range.Name.Length * 31 + i * 7);
            }
            at += range.Length;
        }
        return material;
    }

    public static Dt295Material Create() => new(Bytes(), Dt295Firmware.Pixela.Ranges);

    /// <summary>素材の偽物を持つ、メーカーのデータの偽物 (idle イメージもでたらめ)</summary>
    public static Dt295Vendor Vendor() => new(new byte[1000], new byte[70000], Bytes());
}

/// <summary>合成の TS (放送のデータではない)</summary>
internal static class Dt295Ts
{
    /// <summary>セクションをパケットに詰める (CRC を付ける)</summary>
    public static byte[] Packet(int pid, byte[] body)
    {
        var crc = Descrambler.Crc32(body);
        byte[] section = [.. body, (byte)(crc >> 24), (byte)(crc >> 16), (byte)(crc >> 8), (byte)crc];
        var packet = Enumerable.Repeat((byte)0xFF, 188).ToArray();
        packet[0] = 0x47;
        packet[1] = (byte)(0x40 | (pid >> 8));
        packet[2] = (byte)pid;
        packet[3] = 0x10;
        packet[4] = 0;
        section.CopyTo(packet, 5);
        return packet;
    }

    public static byte[] Section(byte table, int id, byte[] rest)
    {
        var length = 5 + rest.Length + 4;
        return [table, (byte)(0xB0 | (length >> 8)), (byte)length, (byte)(id >> 8), (byte)id, 0xC1, 0, 0, .. rest];
    }

    /// <summary>中身がでたらめのペイロードだけのパケット。<paramref name="scrambling"/> は transport_scrambling_control</summary>
    public static byte[] Payload(int pid, int scrambling = 0)
    {
        var packet = Enumerable.Range(0, 188).Select(i => (byte)(i * 3)).ToArray();
        packet[0] = 0x47;
        packet[1] = (byte)(pid >> 8);
        packet[2] = (byte)pid;
        packet[3] = (byte)((scrambling << 6) | 0x10);
        return packet;
    }

    /// <summary>EMM 0x030 を載せた CAT</summary>
    public static byte[] Cat() => Packet(1, Section(0x01, 0xFFFF, [0x09, 0x04, 0x00, 0x05, 0xE0, 0x30]));

    /// <summary>機器がかけるのと同じ形で AES をかけたパケット (鍵と IV はでたらめ。10.3)</summary>
    public static byte[] Encrypted(byte[] plain, byte[] key, byte[] iv)
    {
        var packet = plain.ToArray();
        using var aes = System.Security.Cryptography.Aes.Create();
        aes.Key = key;
        aes.EncryptCbc(packet.AsSpan(4, 176), iv, packet.AsSpan(4, 176), System.Security.Cryptography.PaddingMode.None);
        var stream = aes.EncryptEcb(packet.AsSpan(4 + 160, 16), System.Security.Cryptography.PaddingMode.None);
        for (var i = 0; i < 8; i++) packet[180 + i] ^= stream[i];
        packet[3] |= 0x40;
        return packet;
    }

    /// <summary>番組 0x400 (PMT 0x1F0、映像 0x111 は PCR も兼ねる、音声 0x112) の PAT と PMT</summary>
    public static byte[] PatPmt(byte[]? ca = null)
    {
        ca ??= [];
        var pat = Packet(0, Section(0x00, 0x7FE0, [0x00, 0x00, 0xE0, 0x10, 0x04, 0x00, 0xE1, 0xF0]));
        byte[] body = [0xE1, 0x11, 0xF0, (byte)ca.Length, .. ca, 0x02, 0xE1, 0x11, 0xF0, 0x00, 0x0F, 0xE1, 0x12, 0xF0, 0x00];
        return [.. pat, .. Packet(0x1F0, Section(0x02, 0x400, body))];
    }
}
