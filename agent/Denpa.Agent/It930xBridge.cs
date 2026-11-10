using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>ファームウェアを起動した結果</summary>
/// <param name="Before">開いたときに動いていたファームウェアのバージョン (0 なら動いていなかった)</param>
/// <param name="Rebooted">前のファームウェアが動いていたので REBOOT した</param>
/// <param name="Version">起動したファームウェアのバージョン (QUERYINFO の 4 バイト、上位から)</param>
public sealed record It930xBoot(uint Before, bool Rebooted, uint Version)
{
    /// <summary>バージョンを <c>1.4.0.0</c> の形に</summary>
    public static string Format(uint version) => $"{version >> 24}.{(version >> 16) & 0xFF}.{(version >> 8) & 0xFF}.{version & 0xFF}";
}

/// <summary>ブリッジの中に残っている TS のバッファの数 (<c>0xDA98</c>・<c>0xDA99</c>)</summary>
public sealed record It930xPsb(byte Da98, byte Da99)
{
    public bool Empty => (Da98 | Da99) == 0;

    public override string ToString() => $"0xDA98 = {Da98}、0xDA99 = {Da99}";
}

/// <summary>
/// ブリッジの TS のバッファの溢れ (<see cref="It930xBridge.ReadOverflow"/>)。全体 (<c>p_br_reg_sys_buf_overflow</c>) と入力 0〜4 ごと
/// (<c>p_br_reg_ts0_overflow</c>〜<c>p_br_reg_ts4_overflow</c>) の bit 0。
/// PX-MLT5PE の実機では、立つと EP 0x84 から何も届かなくなり、電源を抜くまで下りなかった (2026-11-11。<see cref="It930xBridge.ResetTs"/>)
/// </summary>
public sealed record It930xOverflow(bool System, IReadOnlyList<bool> Inputs)
{
    public bool Any => System || Inputs.Any(input => input);

    /// <summary>溢れた入力の番号</summary>
    public IEnumerable<int> Overflowed => Enumerable.Range(0, Inputs.Count).Where(input => Inputs[input]);

    public override string ToString() =>
        $"全体の溢れ (0xDA39) {(System ? 1 : 0)}、入力ごとの溢れ (0xDA57・0xDA8B〜) {string.Join(" ", Inputs.Select(input => input ? 1 : 0))}";
}

/// <summary>
/// ブリッジの TS の経路の状態 (<see cref="It930xBridge.ReadTsStatus"/>)。値は読んだままのバイトで、何を表すかは brRegister.h の名前からの推定。
/// EP 0x84 の 3 つ (<c>0xDD11</c>〜<c>0xDD13</c>) と <c>0xDD1E</c> は bit 5 が EP 0x84
/// </summary>
public sealed record It930xTsStatus(
    It930xPsb Psb,
    byte PsbEmpty,
    byte SyncByteLocked,
    ushort LostPackets,
    byte SysBufOverflow,
    IReadOnlyList<byte> Overflow,
    IReadOnlyList<byte> Enabled,
    byte Mp2Reset,
    byte Ep4Enable,
    byte Ep4Stall,
    byte Ep4Nak,
    byte Ep4Active,
    byte LinkFixRom)
{
    /// <summary>1 行で (<c>--tune</c> が出す)</summary>
    public string Describe() =>
        $"ブリッジ: 残りのバッファ {Psb} (0xDA07 空 = {PsbEmpty})  入力の開閉 (0xDA4C〜) {string.Join(" ", Enabled)}  "
        + $"入力ごとの溢れ (0xDA57・0xDA8B〜) {string.Join(" ", Overflow)}  全体の溢れ (0xDA39) {SysBufOverflow}  "
        + $"同期バイトのロック (0xDA19) {SyncByteLocked}  落ちたパケット (0xDA21) {LostPackets}  0xDA1D = {Mp2Reset:X2}  "
        + $"EP 0x84 (bit 5): 有効 {Bit5(Ep4Enable)} ストール {Bit5(Ep4Stall)} NAK {Bit5(Ep4Nak)} 動作中 {Bit5(Ep4Active)} (0xDD11 = {Ep4Enable:X2}、0xDD12 = {Ep4Stall:X2}、0xDD13 = {Ep4Nak:X2}、0xDD1E = {Ep4Active:X2})  "
        + $"0xF53A = {LinkFixRom:X2}";

    private static int Bit5(byte value) => (value >> 5) & 1;
}

/// <summary>
/// IT930x (USB ブリッジ) 1 つ。コマンドの送受信、レジスタの読み書き、ファームウェアの読み込みと REBOOT。
///
/// <para>
/// コマンドは EP 0x02 (bulk OUT) に送り、応答は EP 0x81 (bulk IN) から読む (SDK の <c>usb2impl.c</c>)。
/// **コマンドは 1 つずつ通す。** 送ってから応答を読むまでを 1 つの区切りにし、ロックはその間だけ持つ。
/// 長いレジスタの読み書きは区切りごとにロックを取り直すので、ほかのスレッドのコマンドが間に入ってよい。
/// </para>
///
/// <para>
/// ITE の SDK (<c>api/IT9300.c</c>・<c>api/brCmd.c</c>) を元に書いた。コメントの関数名は SDK のもの。
/// TS の経路 (入力 0〜4 と EP 0x84) の設定、次の段の I2C (復調器とチューナー) の読み書き、GPIO もここに持つ
/// </para>
/// </summary>
public sealed class It930xBridge
{
    public const byte CommandOut = 0x02;
    public const byte ReplyIn = 0x81;

    /// <summary>
    /// 応答を受ける入れ物の大きさ。応答は長くて 63 バイトだが、端点の最大パケット長 (USB 2.0 の bulk で 512) より短い読みに
    /// 長い応答が来ると OS がエラーにするので、最大パケット長にそろえる (SDK は 125 バイトで読む)
    /// </summary>
    private const int ReplyBuffer = 512;

    /// <summary>レジスタの書き込み 1 回の上限 (フレームの 63 バイトから、長さ・コマンド・シーケンス番号・読み書きの長さ・番地 6 バイト・チェックサムを引いた残り)</summary>
    public const int MaxWrite = It930xFrame.Max - 12;

    /// <summary>レジスタの読み出し 1 回の上限 (応答が 63 バイトに収まる長さ)</summary>
    public const int MaxRead = It930xFrame.Max - It930xFrame.ReplyOverhead;

    /// <summary>
    /// 応答を待つ時間。SDK は 10 秒 (<c>usbbus_timeout</c>)。1 回の応答は数 ms と推定し、1 秒から始める
    /// (実機の記録で決め直す)
    /// </summary>
    internal const int TimeoutMs = 1000;

    /// <summary>
    /// REBOOT のあと、応答が戻るのを待つ間の 1 回の QUERYINFO の時間切れ。SDK は 10 ms ごとに最大 30 回送る (<c>IT9300_reboot</c>)。
    /// ここで 1 回 1 秒待つと最大 30 秒かかるので短くする (値は仕様書に無い。実機の記録で決め直す)
    /// </summary>
    internal const int RebootPollTimeoutMs = 100;

    // ファームウェアに I2C の相手を教える変数 (brVariable.h)。開くときに 0 に戻す (IT9300_initialize)
    public const uint SecondI2cBus = 0x4976;
    public const uint SecondI2cAddress = 0x4BFB;
    public const uint ThirdI2cAddress = 0x4978;
    public const uint FourthI2cAddress = 0x4977;

    /// <summary>
    /// I2C の速さ (<c>p_br_reg_one_cycle_counter_tuner</c>)。ファームウェアを読み込む前に <see cref="I2cSpeed"/> を書く (<c>_IT9300_loadFirmware</c>)
    /// </summary>
    public const uint OneCycleCounterTuner = 0xF103;

    /// <summary>I2C の速さの値 (<c>IT9300User_I2C_SPEED</c>。brUser.h は約 366 kHz と書いている)</summary>
    public const byte I2cSpeed = 0x07;

    /// <summary>TS を受ける端点 (bulk IN。SDK の <c>it930x-devices.c</c> の 1 つ目のアダプタ)</summary>
    public const byte TsIn = 0x84;

    /// <summary>ブリッジの TS の入力の数 (SDK の <c>TsPort</c> の 0〜4)</summary>
    public const int TsInputs = 5;

    /// <summary>
    /// 入力 0〜4 のパケットの先頭に付ける同期バイト。**こちらで決めた値** (SDK のコメントの例の 0x17 から 0x10 ずつ)。
    /// 0x47 は使わない (書き換えていないパケットと見分けられなくなる)
    /// </summary>
    public static readonly IReadOnlyList<byte> SyncBytes = [0x17, 0x27, 0x37, 0x57, 0x67];

    /// <summary>EP 0x84 の 1 回の転送の大きさ (SDK の <c>URB_BUFSIZE</c>。188 × 348 = 65,424 バイト)</summary>
    public const int TsTransferSize = 188 * 348;

    /// <summary>
    /// EP 0x84 に出したままにする読みの数。SDK は 8 (<c>it930x-core.h</c> の <c>BR_URB_COUNT</c>)。
    /// 64 × 65,424 バイトは約 4 MB で、5 つの入力の合計が 200 Mbps でも約 160 ms ぶんを受けておける。
    /// 読みのスレッドが CPU の制限や GC で止まっても、ブリッジのバッファを溢れさせないため。溢れると、電源を抜くまで TS が届かなかった
    /// (<see cref="It930xOverflow"/>)。Linux の usbfs が全部の機材で使える量の既定は 16 MB で、IT930x の機材 3 台と CECH-ZD1 J・PIX-DT295 を足しても収まる。
    /// 16 のときも、PX-MLT5PE の実機で 5 つの受信機がそれぞれ約 30 Mbps を流して足りた (2026-11-10)
    /// </summary>
    public const int TsDepth = 64;

    /// <summary>SDK が EP 0x84 に出したままにする読みの数 (<c>BR_URB_COUNT</c>)。<see cref="TsDepth"/> はこれより少なくしない</summary>
    public const int SdkTsDepth = 8;

    /// <summary>入力を全部閉じてから EP 0x84 をリセットするまでの待ち (ms。SDK の <c>DRV_ResetRxPort</c> の <c>mdelay(10)</c>)</summary>
    public const int InputsOffSettleMs = 10;

    /// <summary>EP 0x84 の最大パケット長 (<c>IT9300User_USB20_MAX_PACKET_SIZE</c>)</summary>
    private const int TsMaxPacket = 512;

    // TS の経路のレジスタ (brRegister.h)。位置と幅は 1 ビットのものだけ添える
    /// <summary><c>p_br_mp2if_ignore_sync_byte</c></summary>
    public const uint IgnoreSyncByte = 0xDA1A;
    /// <summary><c>p_br_reg_dvbt_inten</c> (bit 2)</summary>
    public const uint DvbtInterrupt = 0xF41F;
    /// <summary><c>p_br_reg_mpeg_full_speed</c> (bit 0)</summary>
    public const uint MpegFullSpeed = 0xDA10;
    /// <summary><c>p_br_reg_dvbt_en</c> (bit 0)</summary>
    public const uint DvbtEnable = 0xF41A;
    /// <summary><c>p_br_reg_mp2_sw_rst</c> (bit 0。EP 0x84 のリセット)</summary>
    public const uint Mp2Reset = 0xDA1D;
    /// <summary><c>p_br_reg_ep4_tx_en</c> (bit 5)</summary>
    public const uint Ep4Enable = 0xDD11;
    /// <summary><c>p_br_reg_ep4_tx_nak</c> (bit 5)</summary>
    public const uint Ep4Nak = 0xDD13;
    /// <summary><c>p_br_reg_ep4_tx_len_7_0</c> と続く <c>_15_8</c> (1 回の転送の大きさを 4 バイト単位で)</summary>
    public const uint Ep4Length = 0xDD88;
    /// <summary><c>p_br_reg_ep4_max_pkt</c> (最大パケット長を 4 バイト単位で)</summary>
    public const uint Ep4MaxPacket = 0xDD0C;
    /// <summary><c>p_br_mp2if_mpeg_ser_mode</c> (bit 0)</summary>
    public const uint MpegSerial = 0xDA05;
    /// <summary><c>p_br_mp2if_mpeg_par_mode</c> (bit 0)</summary>
    public const uint MpegParallel = 0xDA06;
    /// <summary><c>p_br_reg_top_host_reverse</c></summary>
    public const uint HostReverse = 0xD920;
    /// <summary>ブリッジの中に残っている TS のバッファの数 (<c>r_br_mp2if_psb_count_7_0</c> と続く <c>_12_8</c>。SDK は <c>DRV_IT930x_Initialize</c> で記録に出す)</summary>
    public const uint PsbCount = 0xDA98;
    /// <summary><c>p_br_reg_ts_in_src</c> + 入力 (入力 0・1 だけ。シリアルは 0、パラレルは 1)</summary>
    public const uint TsInSource = 0xDA58;
    /// <summary><c>p_br_reg_ts0_aggre_mode</c> + 入力 (1 にすると同期バイトを付け替えてまとめる)</summary>
    public const uint TsAggregateMode = 0xDA73;
    /// <summary><c>p_br_reg_ts0_sync_byte</c> + 入力</summary>
    public const uint TsSyncByte = 0xDA78;
    /// <summary><c>p_br_reg_ts0_en</c> + 入力</summary>
    public const uint TsEnable = 0xDA4C;
    /// <summary><c>p_br_reg_ts_fail_ignore</c> (入力ごとに 1 ビット)</summary>
    public const uint TsFailIgnore = 0xDA5A;

    // TS の経路の状態を見るレジスタ (brRegister.h)。SDK が読むのは 0xF53A と 0xDA98・0xDA99 だけ (DRV_IT930x_Initialize が記録に出す)。
    // ほかは --tune の記録に出すためだけに読み、書かない。何を表すかは brRegister.h の名前からの推定
    /// <summary><c>r_br_mp2if_psb_empty</c> (bit 0)</summary>
    public const uint PsbEmpty = 0xDA07;
    /// <summary><c>r_br_mp2if_sync_byte_locked</c> (bit 0)</summary>
    public const uint SyncByteLocked = 0xDA19;
    /// <summary><c>r_br_mp2if_lost_pkt_cnt_l</c> と続く <c>_h</c></summary>
    public const uint LostPackets = 0xDA21;
    /// <summary><c>p_br_reg_sys_buf_overflow</c> (bit 0)</summary>
    public const uint SysBufOverflow = 0xDA39;
    /// <summary><c>p_br_reg_ts0_overflow</c> (bit 0)。入力 1〜4 は <see cref="TsOverflow1"/> から並ぶ</summary>
    public const uint TsOverflow0 = 0xDA57;
    /// <summary><c>p_br_reg_ts1_overflow</c>〜<c>p_br_reg_ts4_overflow</c> (bit 0)</summary>
    public const uint TsOverflow1 = 0xDA8B;
    /// <summary><c>p_br_reg_p_link_fix_rom_en</c>。SDK が開くときに 0xDA98・0xDA99 と一緒に記録に出す (<c>DRV_IT930x_Initialize</c>)</summary>
    public const uint LinkFixRom = 0xF53A;
    /// <summary><c>p_br_reg_ep4_tx_stall</c> (bit 5)</summary>
    public const uint Ep4Stall = 0xDD12;
    /// <summary><c>r_br_reg_ep4_tx_active</c> (bit 5)</summary>
    public const uint Ep4Active = 0xDD1E;

    /// <summary><c>p_br_reg_lnk2ofdm_data_63_56</c>。I2C のバス 2 の速さ (仕様書 1.3 は <c>0xF103</c> と一緒に 0x07 を書く)</summary>
    public const uint Lnk2OfdmData = 0xF6A7;

    // 端子の駆動の強さ (brRegister.h の p_br_reg_top_padmiscdrsr・padmiscdr2・padmiscdr4・padmiscdr8)
    public const uint PadDriveSr = 0xD833;
    public const uint PadDrive2 = 0xD830;
    public const uint PadDrive4 = 0xD831;
    public const uint PadDrive8 = 0xD832;

    /// <summary>
    /// ファームウェアに次の段の I2C の相手を教える欄 (brVariable.h の <c>next_level_*_i2c_address</c>・<c>OVA_NEXT_LEVEL_FIFTH_I2C_ADDR</c>)。
    /// 欄 i に受信機 i の復調器の 8 ビットのアドレスを書く (仕様書 1.3)
    /// </summary>
    public static readonly IReadOnlyList<uint> NextLevelAddress = [0x4975, 0x4974, 0x4973, 0x4972, 0x4964];

    /// <summary>同じ欄のバス (<c>next_level_*_i2c_bus</c>・<c>OVA_NEXT_LEVEL_FIFTH_I2C_BUS</c>)</summary>
    public static readonly IReadOnlyList<uint> NextLevelBus = [0x4971, 0x4970, 0x496F, 0x496E, 0x4963];

    /// <summary><c>OVA_EEPROM_CFG_VALID</c>。0 なら EEPROM の設定を読めていない (仕様書 1.3 は記録に出すだけで続ける)</summary>
    public const uint EepromValid = 0x4979;

    /// <summary>
    /// GENERIC_WRITE で 1 回に書けるバイト数。63 バイトのフレームから、長さ・コマンド・シーケンス番号・チェックサムの 6 バイトと、
    /// 長さ・バス・アドレスの 3 バイトを引いた残り
    /// </summary>
    public const int MaxI2cWrite = It930xFrame.Max - It930xFrame.Overhead - 3;

    /// <summary>GENERIC_READ で 1 回に読めるバイト数 (応答が 63 バイトに収まる長さ)</summary>
    public const int MaxI2cRead = It930xFrame.Max - It930xFrame.ReplyOverhead;

    private readonly IUsbDevice _usb;
    private readonly Action<int> _sleep;
    private readonly Action<string>? _trace;
    private readonly Lock _gate = new();
    private byte _sequence;
    private bool _stale;

    /// <param name="sleep">待つ (ms)。テストは時計を進めるだけにする</param>
    /// <param name="trace">コマンドを 1 行ずつ出す先 (<c>--trace</c>)</param>
    public It930xBridge(IUsbDevice usb, Action<int>? sleep = null, Action<string>? trace = null)
    {
        _usb = usb;
        _sleep = sleep ?? Thread.Sleep;
        _trace = trace;
    }

    public string Name => _usb.Name;

    /// <summary>送ったコマンドの数 (<c>--it930x-probe</c> が出す)</summary>
    public int Commands { get; private set; }

    /// <summary>REBOOT を送ったことがある (そのあとの <see cref="UsbGoneException"/> は、USB がつなぎ直されたものとみなせる)</summary>
    public bool RebootSent { get; private set; }

    /// <summary>
    /// コマンドを 1 つ送り、応答のデータ (<paramref name="replyLength"/> バイト) を返す。
    /// 時間切れ・壊れた応答・ブリッジのエラーは <see cref="It930xException"/>、抜けたら <see cref="UsbGoneException"/>
    /// </summary>
    public byte[] Command(ushort command, ReadOnlySpan<byte> payload, int replyLength, int timeoutMs = TimeoutMs)
    {
        lock (_gate)
        {
            var sequence = Send(command, payload);
            var started = Stopwatch.GetTimestamp();
            Span<byte> buffer = stackalloc byte[ReplyBuffer];
            var got = _usb.Read(ReplyIn, buffer, timeoutMs);
            if (got <= 0)
            {
                // 遅れて届いた応答を、次のコマンドの応答と取り違えないように捨てる (Drain)
                _stale = true;
                _trace?.Invoke($"応答なし 0x{command:X4} #{sequence:X2} ({timeoutMs} ms)");
                throw new It930xException($"IT930x の応答がありません (コマンド 0x{command:X4}、{timeoutMs} ms)");
            }
            var reply = buffer[..got];
            // 位置 1 は送ったシーケンス番号が返ると推定している (SDK は読まない)。実機で確かめるまでは記録に出すだけにする
            _trace?.Invoke($"応答 #{(got > 1 ? reply[1] : 0):X2} {Convert.ToHexString(reply)} ({Stopwatch.GetElapsedTime(started).TotalMilliseconds:F1} ms)");
            try
            {
                return It930xFrame.Parse(reply, replyLength, command);
            }
            catch (It930xException)
            {
                // 壊れた応答のあとも、同じコマンドの応答が遅れて届くことがあるので、次のコマンドの前に捨てる
                _stale = true;
                throw;
            }
        }
    }

    /// <summary>フレームを送るだけ (応答を読まない)。シーケンス番号を返す。ロックの中で呼ぶ</summary>
    private byte Send(ushort command, ReadOnlySpan<byte> payload)
    {
        if (_stale) Drain();
        var sequence = _sequence++;
        var frame = It930xFrame.Build(command, sequence, payload);
        _trace?.Invoke($"送信 0x{command:X4} #{sequence:X2} {Convert.ToHexString(frame)}");
        Commands++;
        _usb.BulkWrite(CommandOut, frame, TimeoutMs);
        return sequence;
    }

    /// <summary>時間切れのあとに遅れて届いた応答を捨てる (最大 8 個)</summary>
    private void Drain()
    {
        Span<byte> buffer = stackalloc byte[ReplyBuffer];
        for (var i = 0; i < 8 && _usb.Read(ReplyIn, buffer, 10) > 0; i++) _trace?.Invoke("遅れて届いた応答を捨てました");
        _stale = false;
    }

    /// <summary>
    /// レジスタを読む (<c>BrCmd_readRegisters</c>)。<see cref="MaxRead"/> バイトずつに分けて読む。
    /// 番地の長さは 0xFF までなら 1、それより上は 2 (<c>IT9300_readRegisters</c>)
    /// </summary>
    public byte[] ReadRegisters(uint address, int length)
    {
        var result = new byte[length];
        for (var at = 0; at < length; at += MaxRead)
        {
            var count = Math.Min(MaxRead, length - at);
            var from = address + (uint)at;
            Command(It930xFrame.RegisterRead, Address(from, count, []), count).CopyTo(result, at);
        }
        return result;
    }

    public byte ReadRegister(uint address) => ReadRegisters(address, 1)[0];

    /// <summary>レジスタに書く (<c>BrCmd_writeRegisters</c>)。<see cref="MaxWrite"/> バイトずつに分けて書く</summary>
    public void WriteRegisters(uint address, ReadOnlySpan<byte> data)
    {
        for (var at = 0; at < data.Length; at += MaxWrite)
        {
            var part = data.Slice(at, Math.Min(MaxWrite, data.Length - at));
            Command(It930xFrame.RegisterWrite, Address(address + (uint)at, part.Length, part), 0);
        }
    }

    public void WriteRegister(uint address, byte value) => WriteRegisters(address, [value]);

    /// <summary>
    /// レジスタの <paramref name="position"/> から <paramref name="length"/> ビットだけを書き換える (<c>IT9300_writeRegisterBits</c>)。
    /// 8 ビットなら書くだけ、それ以外は読んでから書く。読んでから書くまでの間に、ほかのスレッドのコマンドを入れない
    /// </summary>
    public void WriteRegisterBits(uint address, int position, int length, byte value)
    {
        if (length == 8)
        {
            WriteRegister(address, value);
            return;
        }
        lock (_gate)
        {
            var mask = ((1 << length) - 1) << position;
            var current = ReadRegister(address);
            WriteRegister(address, (byte)((current & ~mask) | ((value << position) & mask)));
        }
    }

    /// <summary>
    /// ブリッジの中に残っている TS のバッファの数 (<see cref="PsbCount"/> と次の番地。SDK と同じく 0xDA99 から読む)。
    /// 2 つの値が何を数えているかは SDK に書いていない (SDK はどちらかが 0 でなければ捨てるだけ)
    /// </summary>
    public It930xPsb ReadPsb()
    {
        var da99 = ReadRegister(PsbCount + 1);
        return new It930xPsb(ReadRegister(PsbCount), da99);
    }

    /// <summary>
    /// TS の経路を設定する。入力 0〜4 のパケットの先頭を <see cref="SyncBytes"/> に付け替えて 1 本にまとめ、EP 0x84 から出す。
    /// 入力はまだ開けない (<see cref="EnableTsInputs"/>)。
    ///
    /// <para>
    /// 最初に入力 0〜4 を閉じる (<c>IT9300_disableTsPort</c>)。前のプロセスが入力を開けたまま終わっていても、閉じた状態から設定する。
    /// そのあとの順は SDK と同じで、<c>IT9300_initialize</c> の TS の部分 (同期バイトを無視しない → <c>IT9300_setOutTsType</c> →
    /// <c>IT9300_configOutput</c>)、残っている TS を捨てる (<c>init_work_queue</c> の「Clean PSB buffer」)、<c>DRV_IT930x_Initialize</c> の入力ごとの設定
    /// (<c>IT9300_setInTsType</c>・<c>IT9300_setSyncByteMode</c>)。
    /// <c>IT9300_initialize</c> のうち端子の駆動の強さと次の段の I2C の相手は <see cref="ConfigureReceivers"/>、GPIO は <see cref="GpioSetup"/>
    /// </para>
    /// </summary>
    /// <param name="parallel">入力 0〜4 がパラレルか (<c>IT9300_setInTsType</c>。設定するのは入力 0・1 だけ)。SDK の既定はどれもシリアル</param>
    /// <returns>ブリッジの中に残っていた TS のバッファの数 (捨てる前と後)</returns>
    public (It930xPsb Before, It930xPsb After) ConfigureTs(IReadOnlyList<bool> parallel)
    {
        if (parallel.Count != TsInputs) throw new ArgumentException($"入力は {TsInputs} つです ({parallel.Count})", nameof(parallel));
        for (var port = 0; port < TsInputs; port++) WriteRegister(TsEnable + (uint)port, 0);
        WriteRegister(IgnoreSyncByte, 0);

        // IT9300_setOutTsType (出力は USB。シリアル・パラレルの出力ではないので、その 2 つはここでは触らない)
        WriteRegisterBits(DvbtInterrupt, 2, 1, 1);
        WriteRegisterBits(MpegFullSpeed, 0, 1, 0);
        WriteRegisterBits(DvbtEnable, 0, 1, 1);

        ConfigureOutput();

        // 前に開いたときの TS がブリッジに残っていれば捨てる (SDK の init_work_queue は 0xDA05 に 1 を書き、そのあと IT9300_configOutput が 0 に戻す)
        var before = ReadPsb();
        if (!before.Empty)
        {
            WriteRegister(MpegSerial, 1);
            WriteRegister(MpegSerial, 0);
        }
        var after = ReadPsb();

        for (var port = 0; port < 2; port++) WriteRegister(TsInSource + (uint)port, (byte)(parallel[port] ? 1 : 0));
        for (var port = 0; port < TsInputs; port++)
        {
            WriteRegister(TsAggregateMode + (uint)port, 1);
            WriteRegister(TsSyncByte + (uint)port, SyncBytes[port]);
        }
        return (before, after);
    }

    /// <summary>
    /// <c>IT9300_configOutput</c>: EP 0x84 をリセット → 止める → NAK を外す → 有効 → 1 回の転送の大きさ → 最大パケット長 → シリアル・パラレルの出力を止める →
    /// リセットを外す → <c>p_br_reg_top_host_reverse</c>。EP 0x84 を止めるので、EP 0x84 の読みを出している間は呼ばない
    /// (実機で、出している読みが続けて失敗した。2026-11-11)
    /// </summary>
    private void ConfigureOutput()
    {
        WriteRegisterBits(Mp2Reset, 0, 1, 1);
        WriteRegisterBits(Ep4Enable, 5, 1, 0);
        WriteRegisterBits(Ep4Nak, 5, 1, 0);
        WriteRegisterBits(Ep4Enable, 5, 1, 1);
        const int words = TsTransferSize / 4;
        WriteRegisters(Ep4Length, [words & 0xFF, words >> 8]);
        WriteRegister(Ep4MaxPacket, TsMaxPacket / 4);
        WriteRegisterBits(MpegSerial, 0, 1, 0);
        WriteRegisterBits(MpegParallel, 0, 1, 0);
        WriteRegisterBits(Mp2Reset, 0, 1, 0);
        WriteRegister(HostReverse, 0);
    }

    /// <summary>
    /// TS のバッファの溢れを読む (<see cref="SysBufOverflow"/>・<see cref="TsOverflow0"/>・<see cref="TsOverflow1"/>〜)。読むだけで書かない。
    /// SDK はこの 6 つを読まない
    /// </summary>
    public It930xOverflow ReadOverflow()
    {
        var system = ReadRegister(SysBufOverflow);
        byte[] inputs = [ReadRegister(TsOverflow0), .. ReadRegisters(TsOverflow1, TsInputs - 1)];
        return new It930xOverflow((system & 1) != 0, [.. inputs.Select(value => (value & 1) != 0)]);
    }

    /// <summary>
    /// TS の経路をリセットし直し、そのあとの溢れを返す。SDK に溢れを下ろす手順は無いので、SDK が TS の経路をリセットする手順を開くときと同じ順で通す。
    /// 入力を全部閉じて EP 0x84 をリセット (<c>DRV_ResetRxPort</c> の閉じる側) → 残っている TS を捨てる (<c>init_work_queue</c> の「Clean PSB buffer」で 0xDA05 に 1) →
    /// <c>IT9300_configOutput</c> (0xDA05 を 0 に戻す)。入力は開けない (呼ぶ側が開ける)。EP 0x84 の読みを出す前に呼ぶ (<see cref="ConfigureOutput"/>)。
    /// </summary>
    /// <remarks>
    /// PX-MLT5PE の実機で溢れが立ったまま (全体と入力 2) のときは、これでも、ファームウェアの REBOOT と読み込み直し、受信機の電源の入れ直し (GPIOH7)、
    /// 溢れの 6 つに 0 や 1 を書く、EP 0x84 だけのリセット (<c>p_br_reg_ep4_tx_rst</c>)、<c>p_br_mp2if_psb_en</c> の入れ直しでも下りなかった (2026-11-11)。
    /// <c>p_br_reg_ofsm_suspend</c> (0xD806) を立てると、機材が USB から外れて戻らなかったので使わない
    /// </remarks>
    public It930xOverflow ResetTs()
    {
        DisableTsInputs();
        WriteRegister(MpegSerial, 1);
        ConfigureOutput();
        return ReadOverflow();
    }

    /// <summary>
    /// 入力 0〜4 を全部開ける (SDK の <c>IT930x_probe</c> の「Enable TsPort」: <c>IT9300_enableTsPort</c> を入力ごと → <c>IT9300_setIgnoreFail</c>)。
    /// 開けるのは機材を開いたときの 1 回で、受信機ごとには開け閉めしない。SDK も、受信を始める・止めるときは EP 0x84 の読みだけを出し入れし、入力には触らない。
    /// 5 つの入力は 1 つの経路にまとまるので、ほかの入力が流している間に 1 つだけ開け閉めしない
    /// </summary>
    public void EnableTsInputs()
    {
        for (var port = 0; port < TsInputs; port++) WriteRegister(TsEnable + (uint)port, 1);
        // 誤りのあるパケットも通す (SDK も通している。TEI の付いたパケットを受信機ごとに数えるため)
        WriteRegister(TsFailIgnore, 0x1F);
    }

    /// <summary>
    /// 入力 0〜4 を全部閉じ、<see cref="InputsOffSettleMs"/> 待ってから EP 0x84 をリセットする (SDK の <c>DRV_ResetRxPort</c> の閉じる側。
    /// <c>p_br_reg_mp2_sw_rst</c> に 1 を書いてから 0 を書く)。機材を閉じるときと、TS が届かないときにブリッジのバッファを捨てるときに使う
    /// </summary>
    public void DisableTsInputs()
    {
        for (var port = 0; port < TsInputs; port++) WriteRegister(TsEnable + (uint)port, 0);
        _sleep(InputsOffSettleMs);
        WriteRegister(Mp2Reset, 1);
        WriteRegister(Mp2Reset, 0);
    }

    /// <summary>
    /// TS の経路の状態を読む (<c>--tune</c> の記録に出す)。読むだけで書かない。SDK が読むのは 0xF53A と 0xDA98・0xDA99 だけで、
    /// ほかの値が何を表すかは brRegister.h の名前からの推定
    /// </summary>
    public It930xTsStatus ReadTsStatus()
    {
        var psb = ReadPsb();
        var enabled = ReadRegisters(TsEnable, TsInputs);
        var lost = ReadRegisters(LostPackets, 2);
        byte[] overflow = [ReadRegister(TsOverflow0), .. ReadRegisters(TsOverflow1, TsInputs - 1)];
        var endpoint = ReadRegisters(Ep4Enable, 3);
        return new It930xTsStatus(
            psb,
            ReadRegister(PsbEmpty),
            ReadRegister(SyncByteLocked),
            (ushort)(lost[0] | (lost[1] << 8)),
            ReadRegister(SysBufOverflow),
            overflow,
            enabled,
            ReadRegister(Mp2Reset),
            endpoint[0],
            endpoint[1],
            endpoint[2],
            ReadRegister(Ep4Active),
            ReadRegister(LinkFixRom));
    }

    /// <summary>
    /// 次の段の I2C の設定 (<c>IT9300_initialize</c> の後半。仕様書 1.3)。I2C の速さ、端子の駆動の強さ、受信機ごとの I2C の相手。
    /// 終わりに <c>OVA_EEPROM_CFG_VALID</c> を読んで返す
    /// </summary>
    /// <param name="receivers">受信機ごとの I2C のバスと復調器の T のアドレス (7 ビット)。ブリッジの欄は受信機の番号で並ぶ (仕様書 1.3)</param>
    public byte ConfigureReceivers(IReadOnlyList<It930xReceiver> receivers)
    {
        if (receivers.Any(receiver => receiver.Index < 0 || receiver.Index >= NextLevelAddress.Count))
        {
            throw new ArgumentException($"受信機の番号は 0〜{NextLevelAddress.Count - 1} です", nameof(receivers));
        }
        // I2C の速さ (仕様書 1.3。IT9300_initialize と _IT9300_loadFirmware の値と同じ)
        WriteRegister(Lnk2OfdmData, I2cSpeed);
        WriteRegister(OneCycleCounterTuner, I2cSpeed);
        // 端子の駆動の強さ (IT9300_initialize がどの基板でも書く値。仕様書に無い)
        WriteRegister(PadDriveSr, 1);
        WriteRegister(PadDrive2, 0);
        WriteRegister(PadDrive4, 1);
        WriteRegister(PadDrive8, 0);
        foreach (var receiver in receivers.OrderBy(receiver => receiver.Index))
        {
            WriteRegister(NextLevelAddress[receiver.Index], (byte)(receiver.DemodAddress << 1));
            WriteRegister(NextLevelBus[receiver.Index], receiver.I2cBus);
        }
        return ReadRegister(EepromValid);
    }

    /// <summary>
    /// 次の段の I2C に書く (<c>IT9300_writeGenericRegisters</c>)。<paramref name="address"/> は 7 ビットで、ブリッジには 1 ビット左にずらして渡す (仕様書 1.3)。
    /// 1 回の I2C の書き込みで、<see cref="MaxI2cWrite"/> バイトまで
    /// </summary>
    public void I2cWrite(byte bus, byte address, ReadOnlySpan<byte> data)
    {
        if (data.Length is 0 or > MaxI2cWrite) throw new ArgumentOutOfRangeException(nameof(data), $"I2C の書き込みは 1〜{MaxI2cWrite} バイトです ({data.Length})");
        var payload = new byte[3 + data.Length];
        payload[0] = (byte)data.Length;
        payload[1] = bus;
        payload[2] = (byte)(address << 1);
        data.CopyTo(payload.AsSpan(3));
        Command(It930xFrame.GenericWrite, payload, 0);
    }

    /// <summary>次の段の I2C から読む (<c>IT9300_readGenericRegisters</c>)。<see cref="MaxI2cRead"/> バイトまで</summary>
    public byte[] I2cRead(byte bus, byte address, int length)
    {
        if (length is <= 0 or > MaxI2cRead) throw new ArgumentOutOfRangeException(nameof(length), $"I2C の読み出しは 1〜{MaxI2cRead} バイトです ({length})");
        return Command(It930xFrame.GenericRead, [(byte)length, bus, (byte)(address << 1)], length);
    }

    /// <summary>
    /// GPIOH の値のレジスタ (<c>p_br_reg_top_gpiohN_o</c>)。出力にする (<c>_en</c>) は + 1、機能を有効にする (<c>_on</c>) は + 2 (brRegister.h。仕様書 1.5 の番地と同じ)。
    /// 入力の値 (<c>r_br_reg_top_gpiohN_i</c>) は - 1。いま使う 5 つだけ (GPIOH6・GPIOH14 はカード。<c>IT9300_bcasDetectCard</c>・<c>IT9300_bcasResetCard</c>)
    /// </summary>
    public static uint GpioOutput(int pin) => pin switch
    {
        2 => 0xD8B7,
        6 => 0xD8C7,
        7 => 0xD8C3,
        11 => 0xD8D3,
        14 => 0xD8E3,
        _ => throw new ArgumentOutOfRangeException(nameof(pin), $"GPIOH{pin} は扱っていません"),
    };

    /// <summary>GPIOH の入力の値のレジスタ (<c>r_br_reg_top_gpiohN_i</c>)</summary>
    public static uint GpioInput(int pin) => GpioOutput(pin) - 1;

    /// <summary>GPIOH を出力にして有効にし、値を書く (仕様書 1.5 の「出力・有効にして」。SDK の IT9300_initialize と同じ順)</summary>
    public void GpioSetup(int pin, bool value)
    {
        var output = GpioOutput(pin);
        WriteRegister(output + 1, 1);
        WriteRegister(output + 2, 1);
        WriteRegister(output, (byte)(value ? 1 : 0));
    }

    /// <summary>出力にしてある GPIOH の値を書く</summary>
    public void Gpio(int pin, bool value) => WriteRegister(GpioOutput(pin), (byte)(value ? 1 : 0));

    /// <summary>
    /// GPIOH を入力にして値を読む (<c>IT9300_bcasDetectCard</c> と同じ順: 機能を有効にし、出力をやめ、入力の値を読む)
    /// </summary>
    public bool GpioRead(int pin)
    {
        var output = GpioOutput(pin);
        WriteRegister(output + 2, 1);
        WriteRegister(output + 1, 0);
        return ReadRegister(GpioInput(pin)) != 0;
    }

    /// <summary>出力にしてある GPIOH の出力をやめる (<c>p_br_reg_top_gpiohN_en</c> に 0)</summary>
    public void GpioRelease(int pin) => WriteRegister(GpioOutput(pin) + 1, 0);

    /// <summary>UART_WRITE で 1 回に渡せるバイト数 (<c>IT9300_bcasSendData</c> が 48 バイトずつに分ける)</summary>
    public const int MaxUartWrite = 48;

    /// <summary>UART_READ で 1 回に読むバイト数の上限 (<c>IT9300_bcasGetData</c> が 32 バイトずつ読む)</summary>
    public const int MaxUartRead = 32;

    /// <summary>UART をカードとのやり取りに使う (<c>IT9300_bcasInit</c>。<c>UART_SET_MODE</c> に 1)</summary>
    public void UartCardMode() => Command(It930xFrame.UartSetMode, [1], 0);

    /// <summary>UART の速さ (<c>IT9300_bcasSetBaudrate</c>)。カードで使えるのは 9600 (番号 0) と 19200 (番号 1) だけ</summary>
    public void UartBaudrate(int baud)
    {
        byte code = baud switch
        {
            9600 => 0,
            19200 => 1,
            _ => throw new ArgumentOutOfRangeException(nameof(baud), $"カードの UART の速さは 9600 と 19200 だけです ({baud})"),
        };
        Command(It930xFrame.UartSetBaudrate, [code], 0);
    }

    /// <summary>UART に送るバイトを渡す (<c>Command_UART_WRITE</c>)。1 回に <see cref="MaxUartWrite"/> バイトまで</summary>
    public void UartWrite(ReadOnlySpan<byte> data)
    {
        if (data.Length is 0 or > MaxUartWrite) throw new ArgumentOutOfRangeException(nameof(data), $"UART に渡すのは 1〜{MaxUartWrite} バイトです ({data.Length})");
        var payload = new byte[1 + data.Length];
        payload[0] = (byte)data.Length;
        data.CopyTo(payload.AsSpan(1));
        Command(It930xFrame.UartWrite, payload, 0);
    }

    /// <summary>UART で受けたバイトを読む (<c>Command_UART_READ</c>)。1 回に <see cref="MaxUartRead"/> バイトまで</summary>
    public byte[] UartRead(int length)
    {
        if (length is <= 0 or > MaxUartRead) throw new ArgumentOutOfRangeException(nameof(length), $"UART から読むのは 1〜{MaxUartRead} バイトです ({length})");
        return Command(It930xFrame.UartRead, [(byte)length], length);
    }

    /// <summary>読み書きのコマンドの中身: 長さ、番地の長さ、番地 4 バイト (上位から)、書くバイト</summary>
    private static byte[] Address(uint address, int length, ReadOnlySpan<byte> data)
    {
        var payload = new byte[6 + data.Length];
        payload[0] = (byte)length;
        payload[1] = (byte)(address > 0xFF ? 2 : 1);
        payload[2] = (byte)(address >> 24);
        payload[3] = (byte)(address >> 16);
        payload[4] = (byte)(address >> 8);
        payload[5] = (byte)address;
        data.CopyTo(payload.AsSpan(6));
        return payload;
    }

    /// <summary>動いているファームウェアのバージョン (<c>QUERYINFO</c>)。0 なら動いていない</summary>
    public uint Version(int timeoutMs = TimeoutMs)
    {
        var reply = Command(It930xFrame.QueryInfo, [1], 4, timeoutMs);
        return (uint)((reply[0] << 24) | (reply[1] << 16) | (reply[2] << 8) | reply[3]);
    }

    /// <summary>
    /// ファームウェアを起動する。前のファームウェアが動いていれば REBOOT してから読み込む
    /// (SDK の <c>IT9300_initialize</c> の前半と <c>_IT9300_loadFirmware</c>)。
    /// 起動しなければ <see cref="It930xException"/>。REBOOT で USB がつなぎ直されたときは <see cref="UsbGoneException"/> のまま呼ぶ側に返す (呼ぶ側が開き直す)
    /// </summary>
    /// <param name="code">ファームウェア (<see cref="It930xFirmware.Code"/>)</param>
    public It930xBoot Start(byte[] code)
    {
        var before = Version();
        var rebooted = false;
        if (before != 0)
        {
            Reboot();
            rebooted = true;
        }
        // ファームウェアに残っている I2C の相手を消す (IT9300_initialize)
        WriteRegister(SecondI2cBus, 0);
        WriteRegister(SecondI2cAddress, 0);
        WriteRegister(ThirdI2cAddress, 0);
        WriteRegister(FourthI2cAddress, 0);
        WriteRegister(OneCycleCounterTuner, I2cSpeed);
        foreach (var segment in It930xFirmware.Split(code)) Command(It930xFrame.ScatterWrite, segment.Span, 0);
        Command(It930xFrame.Boot, [], 0);
        _sleep(20);
        var version = Version();
        if (version == 0) throw new It930xException("IT930x のファームウェアが起動しませんでした (BOOT のあとのバージョンが 0)");
        return new It930xBoot(before, rebooted, version);
    }

    /// <summary>
    /// 動いているファームウェアを止める (<c>IT9300_reboot</c>)。REBOOT を送り、10 ms 待ってから、応答が戻るまで QUERYINFO を
    /// 10 ms ごとに最大 30 回送る。戻ったあとのバージョンが 0 でなければ <see cref="It930xException"/>
    /// </summary>
    /// <remarks>
    /// SDK のこの関数は、待ったあとに必ず失敗を返す形になっている (比べる変数に 1 を入れたまま比べている)。
    /// 意図は「REBOOT のあとはバージョンが 0 に戻る」と推定し、それを確かめる。REBOOT で USB がつなぎ直されるかは実機で確かめていない
    /// </remarks>
    public void Reboot()
    {
        lock (_gate) Send(It930xFrame.Boot, []);
        RebootSent = true;
        _sleep(10);
        uint? version = null;
        It930xException? last = null;
        for (var i = 0; i < 30 && version is null; i++)
        {
            try
            {
                version = Version(RebootPollTimeoutMs);
            }
            catch (It930xException error)
            {
                last = error;
                _sleep(10);
            }
        }
        if (version is null) throw new It930xException($"IT930x が REBOOT のあと応答しません ({last?.Message})");
        if (version != 0) throw new It930xException($"IT930x の REBOOT のあとも、ファームウェアが動いています (バージョン {It930xBoot.Format(version.Value)})");
    }
}
