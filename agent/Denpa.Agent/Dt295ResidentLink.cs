/*
 * mAgicVISION (https://github.com/makeding/mAgicVISION、commit 889a435) の usb/window.c (PIX-DT295 の部分) と
 * usb/userland/libusb_boot.c・libusb.c・libusb_control.c の DT295 の経路を移したもの。Copyright (c) 2026 huggy、MIT License
 * (全文は licenses/mAgicVISION.txt)。行番号は元のファイルのもの。
 */

using System.Buffers.Binary;

namespace Denpa.Agent;

/// <summary>
/// resident 方式の PIX-DT295 との制御転送。vendor request 0xBC で 24 ビットのアドレスを読み書きし、0x1000000 以上
/// (resident の RAM と補助の RAM) はウィンドウのレジスターでバンクを切り替えて 0x80000 から見る。resident への要求 64 バイトもここで送る。
/// 1 つのスレッドから使う (TS の読みは別のスレッドでよい。制御転送とは別の端点)
/// </summary>
public sealed class Dt295ResidentLink : IDt295ResidentTransport
{
    private const byte RequestIn = 0xC0;
    private const byte RequestOut = 0x40;

    /// <summary>usb/window.h 16 行の USB_WINDOW_VENDOR_REQUEST</summary>
    public const byte Request = 0xBC;

    /// <summary>読み書きの制御転送の時間切れ (window.c 66・102・154 行)</summary>
    public const int ControlTimeoutMs = 1000;

    /// <summary>要求を渡す制御転送の時間切れ (window.c 242 行)</summary>
    public const int ExchangeTimeoutMs = 20000;

    /// <summary>1 回の制御転送の上限 (window.c 60・147 行)</summary>
    public const int Chunk = 64;

    /// <summary>24 ビットで直に届く範囲の終わり</summary>
    public const uint DirectEnd = 0x1000000;

    /// <summary>読むときのバンクのウィンドウのレジスター (constants.h 196 行の MB86H_DT295_BOOT0_READ_WINDOW)</summary>
    public const uint ReadWindow = 0x000E9EBC;

    /// <summary>書くときのバンクのウィンドウのレジスター (constants.h 197 行)</summary>
    public const uint WriteWindow = 0x000EA3D8;

    /// <summary>要求と応答を置く場所 (constants.h 195 行の MB86H_DT295_BOOT0_STAGING_ADDRESS)</summary>
    public const uint Staging = 0x000C4620;

    /// <summary>補助の RAM (constants.h 198・199 行)。ウィンドウで見てよい範囲の 1 つ</summary>
    public const uint AuxAddress = 0x017A0000;

    public const uint AuxBytes = 0x4000;

    /// <summary>バンクを見る 0x80000 からの 128 KiB (window.c 198・199 行)</summary>
    public const uint AliasBase = 0x80000;

    public const uint BankBytes = 0x20000;

    /// <summary>ウィンドウのレジスターのふだんの値 (window.c 177 行)。使い終わったらこれに戻す</summary>
    private static readonly byte[] NativeWindow = [0x00, 0xF0, 0x00, 0x00];

    private readonly IUsbDevice _usb;
    private readonly Action<string>? _trace;

    /// <param name="trace">あれば、ウィンドウを通した書き込みと要求の制御転送を 1 行ずつ渡す</param>
    public Dt295ResidentLink(IUsbDevice usb, Action<string>? trace = null)
    {
        _usb = usb;
        _trace = trace;
    }

    /// <summary>
    /// 書き込みを 64 バイトずつにする (オフなら 4 バイトずつ)。導入の途中で loader が切り替える
    /// (loader.c 343〜347 行の block_writes。libusb_device.c 247〜255 行の torne_block_writes)
    /// </summary>
    public bool BlockWrites { get; set; }

    /// <summary>出した制御転送の数</summary>
    public long Controls { get; private set; }

    /// <summary>アドレス → (wValue, wIndex)。wValue の上位バイトがビット 16〜23 (window.c 63・64 行)</summary>
    public static (ushort Value, ushort Index) Setup(uint address) => ((ushort)((address >> 8) & 0xFF00), (ushort)address);

    // ---------------------------------------------------------------------
    // 24 ビットの範囲 (window.c 48〜71 行・125〜159 行)
    // ---------------------------------------------------------------------

    /// <summary>24 ビットの範囲を 64 バイトずつ読む (window.c 48〜71 行の usb_native_read24)</summary>
    public void Read24(uint address, Span<byte> data)
    {
        if (data.IsEmpty || address >= DirectEnd || (ulong)data.Length > DirectEnd - address)
        {
            throw new ArgumentOutOfRangeException(nameof(address), $"0x{address:X} から {data.Length} バイトは 24 ビットの範囲の外です");
        }
        for (var at = 0; at < data.Length; at += Chunk)
        {
            var piece = data.Slice(at, Math.Min(Chunk, data.Length - at));
            var current = address + (uint)at;
            var (value, index) = Setup(current);
            Controls++;
            var got = _usb.ControlIn(RequestIn, Request, value, index, piece, ControlTimeoutMs);
            // 受けた長さが足りなければ失敗 (libusb_boot.c 21 行)
            if (got != piece.Length) throw new Dt295ResidentException($"0x{current:X} を読めません ({got}/{piece.Length} バイト)");
        }
    }

    /// <summary>
    /// 24 ビットの範囲を書く (window.c 125〜159 行の torne_native の書く側)。アドレスも長さも 4 の倍数。
    /// <paramref name="block"/> なら 64 バイトずつ、そうでなければ 4 バイトずつ
    /// </summary>
    private void Write24(uint address, ReadOnlySpan<byte> data, bool block)
    {
        if (data.IsEmpty || address >= DirectEnd || (ulong)data.Length > DirectEnd - address || (address & 3) != 0 || (data.Length & 3) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(address), $"0x{address:X} から {data.Length} バイトは書けません (24 ビットの範囲で、アドレスと長さが 4 の倍数)");
        }
        // window.c 135〜142 行は 0xC4600 (XZ・torne の受け渡し場所) への 4 バイトより長い書き込みを並べ替える。
        // DT295 の受け渡し場所は 0xC4620 で、resident の導入と後始末は 0xC4600 に書かないので移していない
        for (var at = 0; at < data.Length;)
        {
            var size = block ? Math.Min(Chunk, data.Length - at) : 4;
            var current = address + (uint)at;
            var (value, index) = Setup(current);
            Controls++;
            _usb.ControlOut(RequestOut, Request, value, index, data.Slice(at, size), ControlTimeoutMs);
            at += size;
        }
    }

    // ---------------------------------------------------------------------
    // ウィンドウ (window.c 172〜226 行の usb_native_window)
    // ---------------------------------------------------------------------

    /// <summary>読む。0x1000000 より下は直に、上はウィンドウを通して (window.c 172〜226 行)</summary>
    public void Read(uint address, Span<byte> data) => Window(address, data, writing: false);

    /// <summary>書く。0x1000000 より下は直に、上はウィンドウを通して。アドレスと長さは 4 の倍数</summary>
    public void Write(uint address, ReadOnlySpan<byte> data)
    {
        var copy = data.ToArray();
        _trace?.Invoke($"書く 0x{address:X8} [{data.Length}]{(BlockWrites ? " (64 バイトずつ)" : "")}");
        Window(address, copy, writing: true);
    }

    private static bool Windowed(uint address, int length) =>
        // resident の RAM か補助の RAM (window.c 186〜194 行。DT295 は ring_bytes が 0 なので TS のリングバッファは無い)
        (address >= Dt295ResidentImage.Base && address < Dt295ResidentImage.End && (ulong)length <= Dt295ResidentImage.End - address)
        || (address >= AuxAddress && address < AuxAddress + AuxBytes && (ulong)length <= AuxAddress + AuxBytes - address);

    private void Window(uint address, Span<byte> data, bool writing)
    {
        if (address < DirectEnd)
        {
            if (writing) Write24(address, data, BlockWrites);
            else Read24(address, data);
            return;
        }
        if (data.IsEmpty || !Windowed(address, data.Length) || (writing && ((address & 3) != 0 || (data.Length & 3) != 0)))
        {
            throw new ArgumentOutOfRangeException(nameof(address), $"0x{address:X8} から {data.Length} バイトはウィンドウで見られる範囲の外です");
        }
        var window = writing ? WriteWindow : ReadWindow;
        Span<byte> check = stackalloc byte[4];
        Span<byte> mapped = stackalloc byte[4];
        for (var cursor = 0; cursor < data.Length;)
        {
            var current = address + (uint)cursor;
            var bank = current & ~(BankBytes - 1);
            var alias = AliasBase + (current & (BankBytes - 1));
            var chunk = (int)Math.Min((uint)(data.Length - cursor), BankBytes - (current & (BankBytes - 1)));
            // DT295 は dispatch_out なので、切り替える前にウィンドウがふだんの値かを確かめる (window.c 206〜210 行)
            Read24(window, check);
            if (!check.SequenceEqual(NativeWindow)) throw new Dt295ResidentException($"ウィンドウのレジスター 0x{window:X} がふだんの値ではありません ({Convert.ToHexString(check)})");
            BinaryPrimitives.WriteUInt32BigEndian(mapped, bank);
            Exception? failure = null;
            try
            {
                Write24(window, mapped, block: false);
                Read24(window, check);
                if (!check.SequenceEqual(mapped)) throw new Dt295ResidentException($"ウィンドウのレジスター 0x{window:X} にバンク 0x{bank:X8} が入りません ({Convert.ToHexString(check)})");
                // 書き込みが 64 バイトずつになるのは、ウィンドウの先の書き込みだけ (window.c 215・216 行)
                if (writing) Write24(alias, data.Slice(cursor, chunk), BlockWrites);
                else Read24(alias, data.Slice(cursor, chunk));
            }
            catch (Exception error) when (error is IOException or ArgumentException)
            {
                failure = error;
            }
            // 失敗してもウィンドウは戻す。失敗した操作は繰り返さない (window.c 217〜222 行)。戻せなかったことを先に投げる
            Write24(window, NativeWindow, block: false);
            Read24(window, check);
            if (!check.SequenceEqual(NativeWindow)) throw new Dt295ResidentException($"ウィンドウのレジスター 0x{window:X} をふだんの値に戻せません ({Convert.ToHexString(check)})");
            if (failure is not null) throw failure;
            cursor += chunk;
        }
    }

    // ---------------------------------------------------------------------
    // 要求 (window.c 228〜247 行の usb_native_exchange。DT295 は dispatch_out)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 要求 64 バイトを制御 OUT (wValue 0x0C7D、wIndex 0x4620) で渡し、0xC4620 から応答 64 バイトを読む (window.c 235〜243 行)。
    /// **失敗しても渡し直さない**
    /// </summary>
    public void Exchange(ReadOnlySpan<byte> request, Span<byte> response)
    {
        if (request.Length != Dt295ResidentProtocol.PacketSize || response.Length != Dt295ResidentProtocol.PacketSize)
        {
            throw new ArgumentException("要求と応答は 64 バイトです");
        }
        var (value, index) = Setup(Staging);
        Controls++;
        _usb.ControlOut(RequestOut, Request, (ushort)(value | 0x7D), index, request, ExchangeTimeoutMs);
        Read24(Staging, response);
    }
}
