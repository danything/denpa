/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit c937107) の include/mb86H/protocol/constants.h・
 * include/mb86H/protocol/device_query.h・core/protocol.c のうち、PIX-DT295 の常駐方式で使うものを移したもの。
 * Copyright (c) 2026 huggy、MIT License (全文は licenses/mAgicVISION.txt)。
 */

using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>常駐方式の PIX-DT295 の失敗。<see cref="Code"/> はファームウェアか手順が返した値 (負の数。無ければ 0)</summary>
public sealed class Dt295ResidentException(string message, int code = 0) : IOException(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// 常駐イメージとやり取りする 64 バイトの要求と応答の形 (constants.h・protocol.c)。どのフィールドも BE32。
/// 要求は magic・sequence・operation・address・argument・budget と 40 バイトのデータ。応答は magic・sequence を要求からそのまま返し、
/// 8 バイト目に結果 (<see cref="Ok"/> など) を置く
/// </summary>
public static class Dt295ResidentProtocol
{
    public const int PacketSize = 64;
    public const int DataSize = 40;
    public const int DataOffset = 24;

    /// <summary>要求と応答の先頭 (constants.h の MB86H_DEBUG_MAGIC。"XZD1")</summary>
    public const uint Magic = 0x585A4431;

    // operation (constants.h の MB86H_DEBUG_*)
    public const uint Ping = 1;
    public const uint ResidentDispatch = 9;
    public const uint ResidentBlock = 10;

    // 応答の結果
    public const uint Ok = 0;
    public const uint Fatal = 3;

    // 常駐イメージのコマンド (MB86H_RESIDENT_COMMAND_*)
    public const uint CommandCapabilities = 0x20;
    public const uint CommandInitialize = 0x21;
    public const uint CommandTune = 0x22;
    public const uint CommandStop = 0x23;
    public const uint CommandService = 0x24;
    public const uint CommandStatus = 0x25;
    public const uint CommandShutdown = 0x26;
    public const uint CommandRecover = 0x2B;
    public const uint CommandCard = 0x2C;
    public const uint CommandDeviceQuery = 0x2F;

    /// <summary>常駐イメージの ABI のバージョン (MB86H_RESIDENT_ABI_VERSION)</summary>
    public const uint AbiVersion = 2;

    /// <summary>CAPABILITIES が返す名前 (MB86H_FIRMWARE_IDENTITY)</summary>
    public const string Identity = "mAgicVISION_1";

    /// <summary>DT295 の受信部の印 (native_profiles の rf_mask。地上波と衛星の 2 つ)</summary>
    public const byte RfMask = 3;

    /// <summary>受信部の数。0 が地上波、1 が衛星 (MB86H_CHANNEL_COUNT)</summary>
    public const int SourceCount = 2;

    public const int SourceTerrestrial = 0;
    public const int SourceSatellite = 1;

    /// <summary>初期化・停止・選局が落ち着くのを待つ上限 (MB86H_INIT_TIMEOUT_MS)</summary>
    public const int SettleTimeoutMs = 15000;

    /// <summary>衛星の周波数に足す値。LNB の IF (kHz) から受信の周波数 (kHz) にする (session.c の mb86H_session_tune)</summary>
    public const uint SatelliteLocalKhz = 10678000;

    // 状態の問い合わせ (DEVICE_QUERY)
    public const byte QueryVersion = 1;
    public const uint PageOverview = 0;
    public const uint PageSource = 1;
    public const uint PageState = 2;

    // 受信部の説明の印 (MB86H_DEVICE_QUERY_*)
    public const byte SourcePresent = 1;
    public const byte SourceStream = 2;
    public const byte SourceAutoTsid = 4;

    // TS の出し方 (MB86H_STREAM_FORMAT_*)
    public const uint FormatMux = 1;
    public const uint FormatRaw = 2;

    // 状態の印 (MB86H_DEVICE_STATE_*)
    public const uint StateStarted = 1;
    public const uint StateInitialized = 2;
    public const uint StateShuttingDown = 4;
    public const uint StateRestorePending = 8;
    public const uint StateOwned = 16;
    public const uint StateReady = 32;
    public const uint StateCapturing = 64;
    public const uint StateStreamReady = 128;
    public const uint StateColdRequired = 256;
    public const uint StateReinitializable = 512;
    public const uint StateMask = 1023;

    // 選局の段階 (MB86H_RESIDENT_PHASE_*)
    public const uint PhaseQuiet = 0;
    public const uint PhaseComplete = 6;
    public const uint PhaseFailed = 8;

    /// <summary>窓のバージョン (MB86H_STREAM_WINDOW_VERSION)。USB では使わない (window_records が 0)</summary>
    public const uint StreamWindowVersion = 1;

    /// <summary>要求を組む (protocol.c の mb86H_debug_packet_pack)。<paramref name="data"/> は 40 バイトか空</summary>
    public static byte[] Pack(uint sequence, uint operation, uint address, uint argument, uint budget, ReadOnlySpan<byte> data)
    {
        if (!data.IsEmpty && data.Length != DataSize) throw new ArgumentException($"要求のデータは {DataSize} バイトです", nameof(data));
        var packet = new byte[PacketSize];
        BinaryPrimitives.WriteUInt32BigEndian(packet, Magic);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8), operation);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(12), address);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(16), argument);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(20), budget);
        data.CopyTo(packet.AsSpan(DataOffset));
        return packet;
    }

    /// <summary>応答がその要求のものか (protocol.c の mb86H_debug_response_matches)</summary>
    public static bool Matches(ReadOnlySpan<byte> response, uint sequence) =>
        Word(response, 0) == Magic && Word(response, 4) == sequence;

    public static uint Word(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);

    public static void Put(Span<byte> bytes, int offset, uint value) => BinaryPrimitives.WriteUInt32BigEndian(bytes[offset..], value);

    /// <summary>応答の結果 (8 バイト目)</summary>
    public static uint Result(ReadOnlySpan<byte> response) => Word(response, 8);

    /// <summary>応答の 20 バイト目の符号付きの値 (失敗の理由)</summary>
    public static int Error(ReadOnlySpan<byte> response) => (int)Word(response, 20);

    /// <summary>問い合わせの応答のデータの <paramref name="word"/> 番目 (device_query.h の mb86H_query_word。データの 4 バイト目から)</summary>
    public static uint QueryWord(ReadOnlySpan<byte> response, int word) => Word(response, DataOffset + 4 + word * 4);
}

/// <summary>常駐イメージ全体の様子 (DEVICE_QUERY の 0 ページ)</summary>
public sealed record Dt295ResidentOverview(uint RfMask, uint StreamMask, uint ResidentAbi, uint WindowVersion);

/// <summary>受信部 1 つの説明 (DEVICE_QUERY の 1 ページ)。周波数は地上波が Hz、衛星が IF の kHz</summary>
public sealed record Dt295ResidentSource(
    uint FrequencyMin, uint FrequencyMax, uint FrequencyStep, uint RecordSize, uint StreamFormat, uint WindowRecords, uint Layers, byte Flags);

/// <summary>受信部 1 つの今の状態 (DEVICE_QUERY の 2 ページ)</summary>
public sealed record Dt295ResidentState(
    uint Generation, int Error, int OwnerError, uint Phase, uint Flags, uint CaptureGeneration, uint WindowSequence, uint Tsid, uint CaptureMask)
{
    public bool Has(uint flag) => (Flags & flag) != 0;
}
