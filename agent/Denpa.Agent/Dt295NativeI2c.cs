using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// PIX-DT295 (dt295:) の I2C。ホストが I2C コントローラのレジスタ (0xFD8FE0〜) を 0xBC のメモリ要求で直に動かす。
/// 節の番号は仕様書 (dt295-resident/spec.md) のもの。仕様書では補助 CPU の処理 (仕様書 6.4)。
/// ふだんは機材の中の順次実行 (<see cref="Run"/> と <see cref="UseSequencer"/>) で同じ手順を実行し、ここの <see cref="Transfer"/> は使えないときに使う。
///
/// コントローラは富士通の I2C (状態・制御・データ) と同じ形 (仕様書 6.4):
/// 状態 0xFD8FE0 の bit7 = バス使用中・bit4 = 最後の ACK が来なかった。制御 0xFD8FE4 の bit7 = バスエラー・bit5 = 再スタート・
/// bit4 = 開始 (1 で START、0 で STOP)・bit3 = 受信時に ACK を返す・bit0 = 1 バイト終わった (0 を書いて次へ)。データ 0xFD8FF0。
///
/// 仕様書に無くて決めた所:
/// - 1 バイト終わるのを、仕様書の割り込み要因 (0xFD8090 と 0xFD80B0 の bit0) ではなく制御の bit0 を読んで待つ (仕様書 6.4 の表に制御の bit0 の意味がある)
/// - 読み書きの制御転送を減らすため、制御レジスタは書いた値を持っておき、待つときに読んだ値を元にして次の値を作る
/// - STOP は制御の bit0・3・4・5 を落とした値を書く (仕様書は bit4 を落とすとだけ書いている)
/// - 仕様書 6.4 の手順 4 のとおり、ACK が来なかったかはアドレスを送った直後だけ確かめる。データの途中では確かめない
/// </summary>
public sealed class Dt295NativeI2c(Dt295NativeLink link, Action<string>? trace = null)
{
    public const uint Status = 0xFD8FE0, Control = 0xFD8FE4, Data = 0xFD8FF0;

    /// <summary>1 転送の書く長さと読む長さの合計の上限 (仕様書 6.4)。補助 CPU の制約だが、同じ値にそろえる</summary>
    public const int MaxBytes = 40;

    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private uint _control = 0x42;
    private bool _checkIdle = true;

    /// <summary>1 バイトを待つ上限</summary>
    private static readonly TimeSpan ByteTimeout = TimeSpan.FromMilliseconds(200);

    /// <summary>準備 (<see cref="Prepare"/>) で書く USB コアのレジスタ。常駐イメージが I2C を動かし始めるとき、これらが変わるのを実機で観測した。呼ぶ側が <see cref="Dt295NativeLink.AllowedCoreWrites"/> に入れておく</summary>
    public static readonly uint[] ClockRegisters = [0xFD8010, 0xFD8014, 0xFD80B0, 0xFD80C0];

    /// <summary>I2C 転送の数</summary>
    public long Transfers { get; private set; }

    /// <summary>
    /// <see cref="Prepare"/> のあと、I2C のレジスタが書いた値で読めたか (制御 0xFD8FE4 が 0x42、0xFD8FF8 が 6、0xFD8FF4 が 0x10。制御の bit0 は除く)。
    /// 実機の常駐イメージが動かした I2C は、0xFD8FE8 が 0xBC (書いた 0x3C に bit7 の状態が付く)、0xFD8FEC が 0x80、0xFD8FFC が 0x30 だった。
    /// ここでは 0xFD8FE8 と、そのほかの読み値は確かめない
    /// </summary>
    public bool Alive { get; private set; }

    /// <summary>
    /// 準備 (仕様書 6.4。値は 6.4 と、実機の常駐イメージの観測による): 0xFD8010 |= 0x10、0xFD8014 &= ~0x10、0xFD80B0 |= 1、0xFD80C0 = 0、
    /// 0xFD8FF8 = 6、0xFD8FF4 = 0x10、0xFD8FE8 = 0x3C、0xFD8FE4 = 0x42。読み戻しは確かめず、記録に出す。<see cref="Alive"/> を決める。
    /// 元の値を返すので、終わったら <see cref="Restore"/> で戻す
    /// </summary>
    public IReadOnlyList<(uint Address, uint Value)> Prepare()
    {
        _saved.Clear();
        // 実機の 0xFD8010 は 4 で、0x10 をそのまま書くと USB の制御が止まった (bit2 が要る)。足して書く。
        // 0xFD80C0 は実機で 3 から 0 になった (常駐イメージ)。仕様書 6.4 の「1 → 0」の終わりと同じ
        Set(0xFD8010, link.Read32(0xFD8010) | 0x10);
        // 0xFD8014 は bit4 だけを落とす (読み・落とす・書き)。実機の常駐イメージは 0x0F3F001B を 0x0F3F000B にした。
        // bit4 は I2C のブロックのリセットで、0xFD8010 の bit4 がそのクロックと見立てる (推定。仕様書に無い)。
        // 0x08080000 を足す書き込みはしない (書くと USB の制御がすべて時間切れになった)
        Set(0xFD8014, link.Read32(0xFD8014) & ~0x10u);
        Set(0xFD80B0, link.Read32(0xFD80B0) | 1);
        Set(0xFD80C0, 0);
        // 書いた値が読めないことがある (主 CPU からは、クロックを入れる前に 0xFD8FF8 に 6 を書いても 0 が読めた)。失敗にはせず、
        // 続く I2C の転送が通るかを Alive で確かめる
        Set(0xFD8FF8, 6);
        Set(0xFD8FF4, 0x10);
        Set(0xFD8FE8, 0x3C);
        Set(0xFD8FE4, 0x42);
        _control = 0x42;
        Alive = (link.Read32(Control) & ~1u) == 0x42 && link.Read32(0xFD8FF8) == 6 && link.Read32(0xFD8FF4) == 0x10;
        trace?.Invoke($"I2C の準備のあと: 制御 0x{link.Read32(Control):X}、0xFD8FE8 = 0x{link.Read32(0xFD8FE8):X}、{(Alive ? "書いた値で読めました" : "書いた値で読めません")}");
        return [.. _saved];
    }

    /// <summary>準備の前の値に戻す (仕様書 6.4 の「終わったら元の値に戻す」)。逆の順に書く</summary>
    public void Restore(IReadOnlyList<(uint Address, uint Value)> saved)
    {
        foreach (var (address, value) in saved.Reverse()) link.Write32(address, value);
    }

    private readonly List<(uint Address, uint Value)> _saved = [];

    /// <summary>書く直前に元の値を読んで控える (クロックを入れる前の読み値を戻す値にしない)</summary>
    private void Save(uint address)
    {
        if (_saved.All(item => item.Address != address)) _saved.Add((address, link.Read32(address)));
    }

    private void Set(uint address, uint value)
    {
        Save(address);
        link.Write32(address, value);
        // 読み戻すのは記録を出すときだけ (使わない読みは制御転送の無駄)。比べるビットが仕様書に無いので、読み戻しでは失敗にしない
        if (trace is null) return;
        var before = _saved.First(item => item.Address == address).Value;
        trace($"I2C の準備 0x{address:X}: 0x{value:X} を書いて 0x{link.Read32(address):X} が読めた (書く前 0x{before:X})");
    }

    /// <summary>I2C の異常からの戻し (仕様書 6.4 の初期化)</summary>
    public void Reset()
    {
        link.Write32(Control, 0x40);
        link.Write32(0xFD8FE8, 0x3C);
        link.Write32(Control, 0x42);
        _control = 0x42;
        _checkIdle = true;
    }

    /// <summary>書く n バイト、続けて読む m バイトを 1 転送で (仕様書 6.4 の 1 転送)。復調は書く側と読む側を別の転送にする (仕様書 7.0)</summary>
    public byte[] Transfer(int address, ReadOnlySpan<byte> write, int read)
    {
        if (write.Length + read > MaxBytes) throw new ArgumentOutOfRangeException(nameof(write), "1 転送の上限を超えています");
        Transfers++;
        trace?.Invoke($"I2C {address:X2} W {Convert.ToHexString(write)}{(read > 0 ? $" R {read}" : "")}");
        // 1. 使用中なら少し待つ (仕様書は失敗にするとだけ書く)。直前の転送を STOP で終えていれば、次の制御転送が出るまでに
        //    STOP は済んでいる (制御転送 1 回は約 60 µs で、I2C の STOP は数 µs) ので読まない。最初と、失敗・バスエラーのあとだけ読む
        if (_checkIdle) WaitIdle();
        _checkIdle = false;
        // 2. アドレスと開始
        link.Write32(Data, (uint)((address << 1) | (write.IsEmpty ? 1 : 0)));
        _control |= 0x10;
        link.Write32(Control, _control);
        uint control;
        try
        {
            control = WaitByte();
        }
        catch (Dt295NativeException)
        {
            // アドレスのバイトが終わらなかった。STOP を出し、次の転送はバスが空くのを待ってから始める
            Stop(_control);
            _checkIdle = true;
            throw;
        }
        // 4. アドレスの直後に ACK が来なかったら失敗
        CheckAck(address);
        var result = new byte[read];
        try
        {
            // 5. 書き
            foreach (var value in write)
            {
                link.Write32(Data, value);
                link.Write32(Control, control & ~1u);
                control = WaitByte();
            }
            // 6. 続けて読むなら再スタート
            if (!write.IsEmpty && read > 0)
            {
                link.Write32(Data, (uint)((address << 1) | 1));
                link.Write32(Control, (control & ~1u) | 0x20);
                control = WaitByte();
                CheckAck(address);
            }
            // 7. 読み。残りが 1 なら ACK を返さない
            for (var i = 0; i < read; i++)
            {
                var next = control & ~1u;
                link.Write32(Control, i == read - 1 ? next & ~0x08u : next | 0x08u);
                control = WaitByte();
                result[i] = (byte)link.Read32(Data);
            }
        }
        catch (Dt295NativeException)
        {
            Stop(control);
            _checkIdle = true;
            throw;
        }
        // 8. STOP
        Stop(control);
        return result;
    }

    /// <summary>
    /// true なら <see cref="Run"/> は機材の中で転送を順に実行させる (<see cref="Dt295NativeLink.RunI2c"/>)。機材を開くとき、使えると確かめたら立てる。
    /// false ならホストが 1 つずつ <see cref="Transfer"/> で実行する
    /// </summary>
    public bool UseSequencer { get; set; }

    /// <summary>機材に 1 回で渡す操作列の大きさの上限 (バイト)。150 転送ほど (約 0.1 秒) で、制御転送の時間切れ (1 秒) に余裕がある</summary>
    private const int ChunkBytes = 0x800;

    /// <summary>
    /// 転送の並びを順に実行し、読んだバイトを転送の順につなげて返す。<see cref="UseSequencer"/> なら機材の中で実行させ、
    /// そうでなければホストが 1 つずつ実行する。失敗の例外はどちらも同じ (ACK が来ない・バスエラー・1 バイトが終わらない)
    /// </summary>
    public byte[] Run(Dt295I2cBatch batch)
    {
        if (batch.IsEmpty) return [];
        var results = new List<byte>();
        if (!UseSequencer)
        {
            // 種類 1 (読み・変更・書き) の書く値は、直前に読んだ転送の先頭バイトから作る
            byte lastRead = 0;
            foreach (var op in batch.Ops)
            {
                var write = op.Modified ? [.. op.Write, (byte)((lastRead & op.Keep) | op.Set)] : op.Write;
                var data = Transfer(op.Address, write, op.Read);
                if (op.Read == 0) continue;
                results.AddRange(data);
                lastRead = data[0];
            }
            return [.. results];
        }
        foreach (var chunk in batch.Split(ChunkBytes, ChunkBytes))
        {
            var reply = link.RunI2c(Dt295I2cBatch.Encode(chunk), chunk.Count, chunk.Sum(op => op.Read));
            Transfers += reply.Code == Dt295NativePrograms.I2cOk ? chunk.Count : reply.Index;
            results.AddRange(reply.Read);
            if (reply.Code == Dt295NativePrograms.I2cOk) continue;
            // 機材のプログラムは失敗したら STOP を出して戻る。ホストの状態は STOP のあとにそろえる
            _control = 0x42;
            _checkIdle = true;
            var failed = reply.Index < chunk.Count ? chunk[(int)reply.Index] : chunk[^1];
            switch (reply.Code)
            {
                case Dt295NativePrograms.I2cNack:
                    throw new Dt295NativeException($"I2C のアドレス 0x{failed.Address:X2} から ACK が来ません");
                case Dt295NativePrograms.I2cBusError:
                    Reset();
                    throw new Dt295NativeException("I2C のバスエラーです");
                default:
                    throw new Dt295NativeException("I2C の 1 バイトが時間内に終わりません");
            }
        }
        _control = 0x42;
        _checkIdle = true;
        return [.. results];
    }

    private void Stop(uint control)
    {
        _control = control & ~0x39u;
        link.Write32(Control, _control);
    }

    private void CheckAck(int address)
    {
        if ((link.Read32(Status) & 0x10) == 0) return;
        Stop(_control);
        _checkIdle = true;
        throw new Dt295NativeException($"I2C のアドレス 0x{address:X2} から ACK が来ません");
    }

    private void WaitIdle()
    {
        var until = _clock.Elapsed + TimeSpan.FromMilliseconds(100);
        while ((link.Read32(Status) & 0x80) != 0)
        {
            if (_clock.Elapsed > until) throw new Dt295NativeException("I2C のバスが使用中のままです");
        }
    }

    /// <summary>制御の bit0 が立つまで読む。bit7 (バスエラー) なら失敗。待ったあとの制御の値を返す</summary>
    private uint WaitByte()
    {
        var until = _clock.Elapsed + ByteTimeout;
        while (true)
        {
            var control = link.Read32(Control);
            if ((control & 0x80) != 0)
            {
                Reset();
                throw new Dt295NativeException("I2C のバスエラーです");
            }
            if ((control & 1) != 0) return control;
            if (_clock.Elapsed > until) throw new Dt295NativeException("I2C の 1 バイトが時間内に終わりません");
        }
    }
}
