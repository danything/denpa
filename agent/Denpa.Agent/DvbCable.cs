namespace Denpa.Agent;

/// <summary>
/// DVB の機材で ISDB-C を受けている間、dvr から読んだ TS を TSMF の処理に通して流す (<see cref="DvbTuner"/>)。選局のたびに作り直す。
///
/// <para>
/// **TSMF から TS を選ぶのはソフトの仕事。** DVB-C の復調器は搬送波の TS (TSMF のフレームのまま) を dvr に出す。IT930x の受信機と同じく、
/// 受け取った TS から <see cref="TsmfSelector"/> が 1 つを選び、選んだ TS が分割 TLV なら <see cref="SplitTlv"/> が TLV パケットに組み立てる。
/// 188 バイトに揃えて出口に渡すのは <see cref="It930xTsDemux"/> (入力 1 つ、同期バイト 0x47)、出口は <see cref="It930xTsOutput"/> で、IT930x の受信機と同じものを使う。
/// </para>
///
/// <para>
/// 読むのは専用のスレッド 1 本。読む側が詰まって出口が溢れたら、出口が捨てて数える (<see cref="Dropped"/>)。
/// </para>
/// </summary>
internal sealed class DvbCable
{
    /// <summary>dvr から読む (<see cref="DeviceStream.Read(byte[], int, int, Func{bool}?)"/>)。<paramref name="giveUp"/> が true になったら 0 を返して戻る</summary>
    public delegate int Source(byte[] buffer, int offset, int count, Func<bool> giveUp);

    /// <summary>dvr が尽きたときに、読む側に伝える理由</summary>
    public const string Ended = "dvr から TS を読めなくなりました";

    private readonly It930xTsOutput _output;
    private readonly Thread _thread;
    private volatile bool _stopped;

    public DvbCable(Source source, TsmfSelector tsmf, SplitTlv tlv, string name)
    {
        _output = new It930xTsOutput(tsmf, tlv);
        _thread = new Thread(() => Pump(source, name)) { IsBackground = true, Name = $"{name} ISDB-C" };
        _thread.Start();
    }

    /// <summary>TSMF から選んだ TS (分割 TLV なら組み立てた TLV) の読み出し側</summary>
    public DeviceStream Output => _output.Output;

    /// <summary>出口が閉じた (読む側が閉じた・止めた・選んだ TS の形式が変わった・dvr が尽きた)</summary>
    public bool Closed => _output.Closed;

    /// <summary>読む側が詰まって捨てたパケットの数 (TLV に組み立てているときは TLV パケットの数)</summary>
    public long Dropped => _output.Dropped;

    private void Pump(Source source, string name)
    {
        var demux = new It930xTsDemux([0x47]);
        demux.Attach(0, _output);
        var buffer = new byte[188 * 1024];
        try
        {
            while (!_stopped && !_output.Closed)
            {
                var read = source(buffer, 0, buffer.Length, () => _stopped || _output.Closed);
                if (read <= 0) break;
                demux.Push(buffer.AsSpan(0, read));
            }
            // 止めたのでなければ、dvr が尽きた。読む側に理由を伝えて終える
            _output.Complete(_stopped ? null : Ended);
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            Log.Write($"[{name}] dvr から TS を読めなくなりました ({error.Message})");
            _output.Complete($"{Ended} ({error.Message})");
        }
    }

    /// <summary>止める。読んでいる途中の 1 回が戻るのを待ってから出口を閉じる (読む側は、残っているぶんを読み終えると尽きる)</summary>
    public void Stop()
    {
        _stopped = true;
        // dvr の読み出しは 200ms ごとに止める合図を確かめるので、ふつうはすぐ戻る
        _thread.Join(TimeSpan.FromSeconds(2));
        _output.Complete();
    }
}
