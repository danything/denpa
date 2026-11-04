using System.Buffers;
using System.Diagnostics;
using System.IO.Pipelines;

namespace Denpa.Agent;

/*
 * PIX-DT295 をチューナーとして持つところ (TunerPool から使う)。**試験的。** 節の番号は DT295 の仕様書のもの (Dt295.cs の冒頭)。
 *
 * - Dt295Board: 1 台ぶんの USB・ASSP・認証セッション。開くときに起動 (エラーの状態なら復帰) と認証とカードの活性化まで済ませ、
 *   30 秒ごとの更新 (5.6) を専用のスレッドで回す。ASSP の制御 (control 転送) は全部 Locked の中で 1 つずつ。
 *   閉じるときは idle イメージを書き戻して未認証のアイドルに戻す (5.7)。
 * - Dt295Stream: TRC で受信する 1 回ぶん (9.2〜9.9)。EP 0x81 を読んで 188 バイトずつ確かめて AES を外し (10.2・10.3)、Pipe に詰める。
 *   暗号化されていない PSI からルートの計画を組み立て (Dt295RouteTracker)、足すだけなら受信中に足し (9.8)、そうでなければ準備し直す (9.10)。
 * - Dt295Tuner: ITuneDevice。ボードは初めての選局で開き、手順の途中で失敗したら次の選局で開き直す。
 */

/// <summary>
/// 届いたバイト列を 188 バイトずつ切り (端数は次の先頭へ。同期バイトは受信を始めて <see cref="ResyncWindow"/> の間だけ探し直す。10.2)、パケットごとに確かめて (10.3) 渡す。
/// **不正なパケットが 1 つでも来たら投げる** (参照実装と同じく受信を止める)。AES のかかったパケット (01) は、鍵と IV があれば外し、
/// 無ければ投げる
/// </summary>
public sealed class Dt295TsFilter(IDt295PacketDecryptor decryptor, byte[]? key = null, byte[]? iv = null)
{
    public const int PacketSize = 188;

    public const string NoIv = "機器が TS に AES をかけていますが、外す値がありません";

    public const string Invalid = "不正なパケットが来ました (同期バイト・TEI・adaptation field。仕様書 10.3)。受信を止めます";

    private readonly byte[] _carry = new byte[PacketSize];
    private int _carried;

    private bool _synced;

    /// <summary>先頭の位置を決めるまで溜めたもの</summary>
    private readonly byte[] _head = new byte[(AlignSpan + 1) * PacketSize];

    private int _headLen;

    /// <summary>渡したパケットの数</summary>
    public long Packets { get; private set; }

    /// <summary>端数を捨て、次の最初の読みでパケットの先頭を探し直す (準備し直したあとは先頭からそろって来る。10.2)</summary>
    public void Reset()
    {
        _carried = 0;
        _headLen = 0;
        _synced = false;
        _window = ResyncWindow;
    }

    /// <summary>最初の読みで、先頭に混じった古い切れ端を飛ばす範囲 (パケット数)。見分けに使う並びの長さでもある</summary>
    private const int AlignSpan = 32;

    /// <summary>
    /// 最初の読みの、パケットの先頭の位置。188 バイトおきに 0x47 が並ぶ最初の位置 (そろわなければ 0)。
    /// 前の受信が途中で終わると、機材の中に残ったデータが次の受信の最初に混じる (パケットの途中の切れ端や、古いパケット)。
    /// 受信を始めて <see cref="ResyncWindow"/> を過ぎたら探し直さない (10.2)
    /// </summary>
    internal static bool Find(ReadOnlySpan<byte> data, out int at)
    {
        for (at = 0; at < AlignSpan * PacketSize && at < data.Length; at++)
        {
            if (data[at] != 0x47) continue;
            var confirmed = 0;
            var aligned = true;
            for (var next = at + PacketSize; next < data.Length && next <= at + AlignSpan * PacketSize; next += PacketSize)
            {
                if (data[next] != 0x47)
                {
                    aligned = false;
                    break;
                }
                confirmed++;
            }
            // 後ろに確かめるものが無いときは、先頭から 1 パケット分が揃っているときだけ認める
            if (aligned && (confirmed > 0 || (at == 0 && data.Length >= PacketSize))) return true;
        }
        at = 0;
        return false;
    }

    /// <summary>
    /// 受け取ったものを渡す。確かめたパケットを <paramref name="output"/> に書き、書いたものは (AES を外したあとの)
    /// <paramref name="plain"/> にも渡す (PSI を読むため。手動で PID を決めるときは、機材が PSI にも AES をかける)。書いたパケットの数を返す
    /// </summary>
    public int Feed(ReadOnlySpan<byte> data, IBufferWriter<byte> output, Action<ReadOnlySpan<byte>>? plain = null)
    {
        if (!_synced)
        {
            // 先頭の位置が確かめられるまで溜める。最初の読みが短い切れ端だけのとき (古いデータの途中)、それで先頭を決めると
            // 以後ずっとずれて「不正なパケット」で止まる。揃った並びが見つからないまま上限まで溜まったら、先頭から始まるものとして流す
            var take = Math.Min(_head.Length - _headLen, data.Length);
            data[..take].CopyTo(_head.AsSpan(_headLen));
            _headLen += take;
            data = data[take..];
            var found = Find(_head.AsSpan(0, _headLen), out var at);
            if (!found && _headLen < _head.Length) return 0;
            // 揃った並びが見つからなかった。もう探し直さず、崩れたら不正として止める (探し直し続けない)
            if (!found) _window = 0;
            _synced = true;
            byte[] buffered = [.. _head.AsSpan(at, _headLen - at)];
            _headLen = 0;
            // 溜めたぶんと、溜めきれなかった続きを、この順に渡す
            byte[] rest = [.. buffered, .. data];
            return Carry(rest, output, plain);
        }
        return Carry(data, output, plain);
    }

    /// <summary>
    /// 受信を始めてから、並びが崩れたら先頭を探し直してよい量 (バイト)。準備し直したあとの最初の 3〜4 KiB には、機材に残っていた
    /// 前の受信の切れ端が入る (実機の PIX-DT295、地上波 27ch。先頭に 28〜116 バイトのごみ、17〜22 パケットの古い並び、31〜119 バイトの
    /// ごみが続き、オフセット 3072 か 4096 から新しい並びになる)。古い並びで先頭を決めると、その境目で崩れて止まっていた。
    /// これを過ぎてからの崩れは、仕様どおり不正なパケットとして止める (10.3)
    /// </summary>
    private const int ResyncWindow = 64 * 1024;

    /// <summary>探し直してよい残りの量 (バイト)</summary>
    private int _window = ResyncWindow;

    /// <summary>先頭が決まったあとの渡し方。端数は次の呼びにつなぐ。始めのうちに並びが崩れたら、崩れた所から先頭を探し直す</summary>
    private int Carry(ReadOnlySpan<byte> data, IBufferWriter<byte> output, Action<ReadOnlySpan<byte>>? plain)
    {
        var written = 0;
        if (_carried > 0)
        {
            var take = Math.Min(PacketSize - _carried, data.Length);
            data[..take].CopyTo(_carry.AsSpan(_carried));
            _carried += take;
            data = data[take..];
            if (_carried < PacketSize) return 0;
            _carried = 0;
            if (_carry[0] != 0x47 && _window > 0) return written + Resync([.. _carry, .. data], output, plain);
            written += Pass(_carry, output, plain);
        }
        while (data.Length >= PacketSize)
        {
            if (data[0] != 0x47 && _window > 0) return written + Resync(data, output, plain);
            written += Pass(data[..PacketSize], output, plain);
            data = data[PacketSize..];
        }
        data.CopyTo(_carry);
        _carried = data.Length;
        return written;
    }

    /// <summary>並びが崩れた所から、先頭を探し直す (<see cref="ResyncWindow"/> の間だけ)</summary>
    private int Resync(ReadOnlySpan<byte> data, IBufferWriter<byte> output, Action<ReadOnlySpan<byte>>? plain)
    {
        _synced = false;
        _headLen = 0;
        _carried = 0;
        Resyncs++;
        return Feed(data, output, plain);
    }

    private int Pass(ReadOnlySpan<byte> input, IBufferWriter<byte> output, Action<ReadOnlySpan<byte>>? plain)
    {
        if (_window > 0) _window -= PacketSize;
        return One(input, output, plain);
    }

    /// <summary>始めのうちに並びが崩れて、先頭を探し直した回数</summary>
    public int Resyncs { get; private set; }

    private int One(ReadOnlySpan<byte> input, IBufferWriter<byte> output, Action<ReadOnlySpan<byte>>? plain)
    {
        var (kind, _) = Dt295PacketDecryptor.Classify(input);
        if (kind == Dt295PacketResult.Invalid) throw new Dt295Exception(Invalid);
        if (kind == Dt295PacketResult.Decrypted && (key is null || iv is null)) throw new Dt295Exception(NoIv);
        var packet = output.GetSpan(PacketSize)[..PacketSize];
        input.CopyTo(packet);
        if (kind == Dt295PacketResult.Decrypted) decryptor.Decrypt(packet, key!, iv!);
        output.Advance(PacketSize);
        Packets++;
        plain?.Invoke(packet);
        return 1;
    }
}

/// <summary>
/// PIX-DT295 1 台ぶん。開いている間は認証済みのセッションを持ち、30 秒ごとに更新する。**ASSP の制御は <see cref="Locked"/> の中だけ**
/// </summary>
public sealed class Dt295Board : IDisposable
{
    /// <summary>更新の期限を確かめる間隔 (5.6 の「約 1 秒おき」)</summary>
    private static readonly TimeSpan RefreshCheck = TimeSpan.FromSeconds(1);

    private static readonly Lock Registry = new();
    private static readonly List<Dt295Board> Open = [];

    private readonly Lock _gate = new();
    private readonly Thread? _refresher;
    private readonly ManualResetEventSlim _closing = new();
    private readonly string _device;
    private bool _closed;

    /// <summary>活性化を試したときの通知の世代番号 (6.4: 同じ通知に対して 2 回は送らない)</summary>
    private int _triedAt = -1;

    public string Port { get; }
    public IUsbDevice Usb { get; }
    public Dt295Bridge Bridge { get; }
    public Dt295Device Session { get; }
    public Dt295Frontend Frontend { get; }
    public Dt295Vendor Vendor { get; }

    /// <summary>最後に読んだカード状態 (6.1)。読めていなければ null</summary>
    public Dt295CardState? Card { get; private set; }

    /// <summary>カードが使えない理由 (6.3・6.4)。使えていれば null</summary>
    public string? CardProblem { get; private set; }

    /// <summary>機器の状態が分からなくなった (更新の失敗・手順の途中の失敗)。もう選局しない。閉じて開き直す</summary>
    public string? Fault { get; private set; }

    /// <summary>受信している (6.4 のカードの確認は受信していないときだけ)</summary>
    public bool Receiving { get; internal set; }

    /// <summary>冷えた状態から開くのにかかった時間 (ms)</summary>
    public long OpenMs { get; private set; }

    private Dt295Board(string port, IUsbDevice usb, Dt295Vendor vendor, IDt295Time time, bool refresher, Action<string>? trace)
    {
        Port = port;
        _device = Dt295.Device(port);
        Usb = usb;
        Vendor = vendor;
        Bridge = new Dt295Bridge(usb, time, trace);
        Session = new Dt295Device(Bridge);
        Frontend = new Dt295Frontend(Bridge, Dt295Material.From(vendor));
        if (refresher) _refresher = new Thread(Refresh) { IsBackground = true, Name = $"{Dt295.Model} {port} 更新" };
    }

    /// <summary>
    /// 開く: メーカーのデータを用意し (無ければ取ってくる)、USB を開き、起動 (4。エラーの状態なら 5.8 で戻す)・認証 (5.3)・
    /// カードの初期化と活性化 (6.2・6.3)。認証まで進めなければ投げる。カードの失敗は <see cref="CardProblem"/> に残して開く
    /// </summary>
    public static Dt295Board Acquire(string port, Action<string>? trace = null) =>
        Acquire(port, Dt295Firmware.Ensure, () => Dt295.OpenUsb(port), new Dt295SystemTime(), refresher: true, trace);

    internal static Dt295Board Acquire(string port, Func<Dt295Vendor> vendor, Func<IUsbDevice> open, IDt295Time time, bool refresher, Action<string>? trace = null)
    {
        var started = Stopwatch.StartNew();
        var data = vendor();
        var usb = open();
        Dt295Board board;
        try
        {
            board = new Dt295Board(port, usb, data, time, refresher, trace);
            board.Start();
        }
        catch
        {
            usb.Dispose();
            throw;
        }
        board.OpenMs = started.ElapsedMilliseconds;
        lock (Registry) Open.Add(board);
        board._refresher?.Start();
        Log.Write($"[{Dt295.Model} {port}] 開きました ({board.OpenMs}ms、カード状態 {(board.Card is { } card ? (int)card : -1)})");
        return board;
    }

    private void Start()
    {
        lock (_gate)
        {
            try
            {
                if (Session.Boot(Vendor.Idle) == Dt295Boot.Recovered) Log.Write($"[{Dt295.Model} {Port}] エラーの状態から戻しました");
                Session.Authenticate(Dt295Material.From(Vendor));
                Frontend.Forget();
                Card = Session.InitCard();
            }
            catch
            {
                // 認証の途中で落ちても、鍵があれば終わらせておく (約 61 秒でエラーの状態になるのを避ける。5.3 の最後)
                if (Session.HasSession) TryClose();
                throw;
            }
            CheckCard();
        }
    }

    /// <summary>
    /// カードを見る (6.3・6.4)。3 ならそのまま。通知のあとに 0 なら「抜かれた」。挿されている (1、または一度も通知の無い 0) なら、
    /// 同じ通知に対して 1 回だけ活性化する。理由は <see cref="CardProblem"/> と画面に出す。<see cref="Locked"/> の中から、受信していないときに呼ぶ
    /// </summary>
    internal void CheckCard()
    {
        try
        {
            var state = Session.CardState();
            Card = state;
            if (state != Dt295CardState.Ready)
            {
                if (state == Dt295CardState.Initial && Session.CardNotices > 0)
                {
                    SetCardProblem("B-CAS カードが挿さっていません。映像と音声は出ません");
                    return;
                }
                if (_triedAt == Session.CardNotices) return;
                _triedAt = Session.CardNotices;
                Card = Session.ActivateCard();
            }
            CardProblem = null;
            Px4Userland.ClearNotice(_device, this);
        }
        catch (Dt295Exception error)
        {
            SetCardProblem($"B-CAS カードが使えません ({error.Message})。映像と音声は出ません");
        }
    }

    private void SetCardProblem(string problem)
    {
        if (problem != CardProblem) Log.Write($"[{Dt295.Model} {Port}] {problem}");
        CardProblem = problem;
        Px4Userland.SetNotice(_device, this, problem);
    }

    /// <summary>手順の途中で失敗した。機器の状態は分からないので、次の選局で閉じて開き直す (13 章の再送しない方針)</summary>
    internal void MarkFault(string reason)
    {
        lock (_gate)
        {
            if (Fault is not null) return;
            Fault = $"{reason}。次の選局で開き直します";
            Log.Write($"[{Dt295.Model} {Port}] {Fault}");
        }
    }

    /// <summary>ASSP を触る。選局・ルートの書き直し・更新が混ざらないように 1 つずつ</summary>
    public T Locked<T>(Func<T> action)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_closed, this);
            if (Fault is { } fault) throw new IOException(fault);
            return action();
        }
    }

    public void Locked(Action action) => Locked(() =>
    {
        action();
        return true;
    });

    /// <summary>
    /// <see cref="Fault"/> が立っていても通す <see cref="Locked(Action)"/>。受信を止める手順だけに使う。
    /// 手順の途中で失敗した印 (Fault) が立っているからといって止めずにおくと、機材が受信中のまま取り残され、
    /// 次に開くときに「ほかのプロセスが使っているかもしれません」と断られ続ける
    /// </summary>
    public void LockedToStop(Action action)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_closed, this);
            action();
        }
    }

    /// <summary>更新のスレッド。約 1 秒おきに期限を確かめる</summary>
    private void Refresh()
    {
        while (!_closing.Wait(RefreshCheck))
        {
            if (!Tick()) return;
        }
    }

    /// <summary>更新の期限を 1 回確かめ、受信していなければカードも見る (6.4)。続けられなければ false (テストは直に呼ぶ)</summary>
    internal bool Tick()
    {
        lock (_gate)
        {
            if (_closed || Fault is not null) return false;
            try
            {
                Session.RefreshIfDue();
            }
            catch (Exception error) when (error is IOException or InvalidOperationException)
            {
                // 5.6 の手順 6: 送り直さず、セッションは使えないものとして扱う
                Fault = $"{Dt295.Model} のセッションを更新できません ({error.Message})。次の選局で開き直します";
                Log.Write($"[{Dt295.Model} {Port}] {Fault}");
                Px4Userland.SetNotice(_device, this, Fault);
                return false;
            }
            if (Receiving) return true;
            try
            {
                CheckCard();
            }
            catch (IOException error)
            {
                // 抜かれた・制御転送が失敗した。更新のスレッドから投げるとプロセスごと落ちるので、更新の失敗と同じに扱う
                Fault = $"{Dt295.Model} を読めません ({error.Message})。次の選局で開き直します";
                Log.Write($"[{Dt295.Model} {Port}] {Fault}");
                Px4Userland.SetNotice(_device, this, Fault);
                return false;
            }
            return true;
        }
    }

    /// <summary>受信を止めていれば idle イメージを書き戻す (5.7)。失敗は記録だけ (エラーの状態なら次に開くときに 5.8 で戻す)</summary>
    private void TryClose()
    {
        try
        {
            if (Session.HasSession) Session.Close(Vendor.Idle);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            Log.Write($"[{Dt295.Model} {Port}] セッションを終えられませんでした ({error.Message})");
        }
        Session.Forget();
    }

    /// <summary>更新を止め、セッションを終えて (5.7)、USB を閉じる</summary>
    public void Dispose()
    {
        _closing.Set();
        if (_refresher is { IsAlive: true } && Thread.CurrentThread != _refresher) _refresher.Join(TimeSpan.FromSeconds(10));
        lock (_gate)
        {
            if (_closed) return;
            TryClose();
            _closed = true;
            Usb.Dispose();
        }
        Px4Userland.ClearNotice(_device, this);
        lock (Registry) Open.Remove(this);
        Log.Write($"[{Dt295.Model} {Port}] 閉じました");
    }

    /// <summary>全部閉じる (エージェントを止めるとき)。認証済みのまま放っておくと約 61 秒でエラーの状態になるので、必ず書き戻す</summary>
    public static void CloseAll()
    {
        List<Dt295Board> boards;
        lock (Registry) boards = [.. Open];
        foreach (var board in boards) board.Dispose();
    }
}

/// <summary>
/// TRC で受信する 1 回ぶん。EP 0x81 の読みを出しっぱなしにして (10.1)、<see cref="Dt295TsFilter"/> を通して Pipe (8MB) に詰める。
/// 読み出し側は <see cref="DeviceStream"/> (CECH-ZD1 J・px4d と同じ形)
/// </summary>
internal sealed class Dt295Stream
{
    private const byte Endpoint = 0x81;

    /// <summary>
    /// 1 本の読みの大きさと本数。参照実装 (10.1) は 65,536 バイトを 8 本だが、受信を始めた直後は PSI だけが約 180 kbps で流れ、
    /// 65,536 バイトが埋まるまで 3 秒ほどかかり、映像が出るまでが長くなる (pix-userland の issue 77 も同じ)。
    /// 実機 (BS1、番組 152、各 4 回) で映像の最初のパケットまでを測ると、65,536 バイトが 5.3〜5.9 秒、32,768 が 2.9〜3.7 秒、16,384 が 2.3〜2.9 秒、
    /// 8,192 が 1.8〜2.0 秒、4,096 が 1.7〜1.9 秒だった。CPU 時間 (20 秒) は 3.8 秒、4.2 秒、4.7 秒、5.2 秒、6.3 秒と増える。
    /// 8,192 バイトは、短縮がほぼ頭打ちになる手前で CPU が少ない。待機中に溜められる量 (512 KiB) は変えない
    /// USB 2.0 の bulk の最大パケットは 512 バイトで、読みの大きさはその倍数でなければならない (WinUSB の RAW_IO が断る)。
    /// Windows と Mac で 64 本の読みが動くかは、実機で確かめていない (Linux だけ)
    /// </summary>
    private const int TransferSize = 8192;

    private const int Depth = 64;

    /// <summary>1 回の <c>Read</c> で受け取る上限。読みが小さくなっても、1 回の呼び出しでまとめて受け取る</summary>
    private const int ReadChunk = 65536;

    private const int ReadTimeoutMs = 100;

    /// <summary>停止の間に読み捨てる 1 回の待ち (9.9)</summary>
    private const int DrainMs = 10;

    /// <summary>データがまったく来ないまま待つ上限 (10.1 の「10 秒」)</summary>
    internal static readonly TimeSpan Silence = TimeSpan.FromSeconds(10);

    /// <summary>受信開始から PSI がそろうまで待つ上限 (11.2 の手順 5)。過ぎたら、そろったぶんで準備し直す</summary>
    internal static readonly TimeSpan Settle = TimeSpan.FromSeconds(30);

    public const string NoData = "TS が来ません (10 秒)。電波が来ていないかもしれません (この機材は地上波のロックを判定できません。仕様書 7.5)";

    private readonly Pipe _pipe = Px4Stream.NewBuffer();
    private readonly IUsbInStream _in;
    private readonly Dt295Board _board;
    private readonly Dt295ReceiveData _data;
    private readonly Dt295RouteTracker _routes;
    private readonly string _name;
    private readonly Action _stalled;
    private readonly TimeSpan _silence;
    private readonly TimeSpan _settle;

    /// <summary>機材に流させる番組の番組番号 (0 なら指定なし)。主番組が決まらないとき (衛星) だけ 0x1018 に書く</summary>
    private readonly int _program;
    private readonly Thread _pump;
    private readonly ManualResetEventSlim _first = new();
    private readonly byte[] _scratch = new byte[TransferSize * Depth];
    private Dt295TsFilter _filter = new(new Dt295PacketDecryptor());
    private Dt295Route[] _written = [];
    private Dt295Program? _writtenMain;
    private bool _settled;

    /// <summary>機材が受信中のルートの追加を断った。この受信では追加を試さず、PSI がそろってから準備し直しで足す</summary>
    private bool _additionsRefused;

    /// <summary>最後にログへ出した、ルートの計画を作り直せなかった理由 (同じものを繰り返し出さない)</summary>
    private string? _problem;
    private volatile bool _stopping;
    private volatile bool _ended;
    private volatile string? _reason;

    public DeviceStream Output { get; }

    public bool Ended => _ended;

    /// <summary>止めたとき、読み出しのスレッドが 3 秒以内に終わったか (終わっていなければ、ルートの計画をまだ書き換えているかもしれない)</summary>
    internal bool PumpStopped { get; private set; }

    /// <summary>この受信のルートの計画。止めるときに写しを取る</summary>
    internal Dt295RouteTracker Routes => _routes;

    /// <summary>流し終わった理由 (無ければ null)</summary>
    public string? Reason => _reason;

    /// <summary>準備し直した回数 (9.10)</summary>
    public int Reprepared { get; private set; }

    private Dt295Stream(IUsbInStream input, Dt295Board board, Dt295ReceiveData data, Dt295RouteTracker routes, string name, Action stalled, TimeSpan silence, TimeSpan settle, int program)
    {
        _program = program;
        _in = input;
        _board = board;
        _data = data;
        _routes = routes;
        _name = name;
        _stalled = stalled;
        _silence = silence;
        _settle = settle;
        Output = new DeviceStream(_pipe.Reader, () => _reason);
        _pump = new Thread(Pump) { IsBackground = true, Name = $"{name} TS" };
    }

    /// <summary>
    /// 受信を始める: 読みを出してから、準備 (9.2〜9.6) と受信開始 (9.7)。選局は済ませておく。
    /// 途中で失敗したら止める手順 (9.9) を通して投げる
    /// </summary>
    public static Dt295Stream Start(Dt295Board board, Dt295ReceiveData data, Dt295RouteTracker routes, string name, Action stalled, TimeSpan silence, TimeSpan? settle = null, int program = 0)
    {
        var input = board.Usb.OpenInStream(Endpoint, TransferSize, Depth);
        var stream = new Dt295Stream(input, board, data, routes, name, stalled, silence, settle ?? Settle, program);
        try
        {
            board.Locked(() =>
            {
                board.Receiving = true;
                stream.Prepare(routes.Plan, routes.Main);
            });
        }
        catch
        {
            stream.StopReception();
            input.Dispose();
            board.Receiving = false;
            throw;
        }
        stream._pump.Start();
        return stream;
    }

    /// <summary>準備して受信を始める (9.2〜9.7。2 回目からは 9.10)。Locked の中から</summary>
    private void Prepare(Dt295Route[] plan, Dt295Program? main)
    {
        var session = _board.Session;
        var key = session.PrepareReception(_board.Vendor.Trc, _data.Fields, plan, main, _program);
        _filter = new Dt295TsFilter(new Dt295PacketDecryptor(), key, _data.TsIv);
        session.StartReception();
        _written = plan;
        _writtenMain = main;
    }

    /// <summary>最初のパケットか、終わり (理由つき) を待つ。来たら true</summary>
    public bool WaitFirst(TimeSpan most) => _first.Wait(most) && !_ended;

    private void Pump()
    {
        var raw = new byte[ReadChunk];
        var writer = _pipe.Writer;
        var quiet = Stopwatch.StartNew();
        var since = Stopwatch.StartNew();
        var changed = false;
        try
        {
            while (!_stopping)
            {
                var got = _in.Read(raw, ReadTimeoutMs);
                if (got == 0)
                {
                    if (quiet.Elapsed >= _silence)
                    {
                        End(NoData);
                        return;
                    }
                    continue;
                }
                quiet.Restart();
                if (_filter.Feed(raw.AsSpan(0, got), writer, packet => changed |= _routes.Push(packet)) == 0) continue;
                ReportProblem();
                if (changed || (!_settled && since.Elapsed >= _settle))
                {
                    changed = false;
                    Follow(since.Elapsed >= _settle);
                }
                _first.Set();
                if (!Flush(writer)) return;
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
        {
            if (error is Dt295Exception) _board.MarkFault(error.Message);
            End(error is UsbGoneException ? $"{error.Message}。挿し直してください" : error.Message);
        }
        finally
        {
            _ended = true;
            _first.Set();
            writer.Complete();
        }
    }

    /// <summary>
    /// ルートの計画を作り直せない理由 (複数の ECM・スロット不足。11.5) が変わったら、ログに出す。
    /// 計画は前のままになり、新しい PID が流れないので、ログに出さないと原因が分からない
    /// </summary>
    private void ReportProblem()
    {
        var problem = _routes.Problem;
        if (problem == _problem) return;
        _problem = problem;
        if (problem is not null) Log.Write($"[{_name}] ルートの計画を作り直せません ({problem})。前の計画のまま受信します");
    }

    /// <summary>
    /// 計画を機材に合わせる (11.2・11.3)。空きスロットへの ECM でない PID の追加だけなら受信中に足す (9.8)。
    /// それ以外 (主番組のスロット 0〜3・ECM・付け替え) は、PSI がそろってから (または待ちの上限を過ぎてから) 1 回だけ準備し直す (9.10)
    /// </summary>
    private void Follow(bool late)
    {
        var plan = _routes.Plan;
        var main = _routes.Main;
        if (plan.SequenceEqual(_written) && main == _writtenMain)
        {
            _settled |= _routes.Settled || late;
            return;
        }
        var additions = _additionsRefused ? [] : plan.Except(_written)
            .Where(route => route.EcmSlot == 0 && route.Slot > Dt295Routes.PatSlot
                && !_written.Any(written => written.Slot == route.Slot || written.Pid == route.Pid))
            .ToList();
        var rest = _written.Except(plan).Any() || plan.Except(_written).Except(additions).Any() || main != _writtenMain;
        if (rest && (_routes.Settled || late))
        {
            Reprepare(plan, main);
            _settled = true;
            Log.Write($"[{_name}] 準備し直しました ({plan.Length} スロット{(main is null ? "" : $"、主番組 {main.Number}")}{(late ? "。PSI が待ちの上限までにそろいませんでした" : "")})");
            return;
        }
        if (additions.Count == 0) return;
        try
        {
            _board.Locked(() =>
            {
                foreach (var route in additions) _board.Session.ChangeRoute(route);
            });
        }
        catch (Dt295Exception error) when (error.Completion == RouteChangeRefused)
        {
            // 機材が受信中の追加を断った (完了コード 0x0580。2 回目以降の追加でよく起きる)。同じコマンドは送り直さず (13 章)、
            // 受信を止めて全部のルートで準備し直す (9.10)。ここで例外にすると、機材の受信が止まらないまま取り残される。
            // この受信では、追加をもう試さない (断られるたびに準備し直すと、何度も止めることになる)
            _additionsRefused = true;
            Reprepare(plan, main);
            Log.Write($"[{_name}] 機材が受信中のルートの追加を断ったため、準備し直しました ({plan.Length} スロット{(main is null ? "" : $"、主番組 {main.Number}")})");
            return;
        }
        _written = rest ? [.. _written, .. additions] : plan;
        Log.Write($"[{_name}] 受信中にルートを足しました ({additions.Count} 本)");
    }

    /// <summary>受信中にルートを足すコマンド (cmd 5 sub 1) を機材が断ったときの完了コード</summary>
    private const ushort RouteChangeRefused = 0x0580;

    /// <summary>受信を止めて、計画の全部のルートで準備し直す (9.10)</summary>
    private void Reprepare(Dt295Route[] plan, Dt295Program? main)
    {
        _board.Locked(() =>
        {
            _board.Session.StopReception(Pause, Drain);
            FlushStale();
            Prepare(plan, main);
        });
        Reprepared++;
    }

    /// <summary>
    /// 止めたあとに EP 0x81 に残っている古いデータを読み捨てる (最大 300 ms)。残したまま準備し直すと、次の受信の最初の読みが
    /// 古いデータの途中から始まり、パケットの先頭を取り違えて「不正なパケット」で止まることがある
    /// </summary>
    private void FlushStale()
    {
        var waited = Stopwatch.StartNew();
        while (waited.ElapsedMilliseconds < 300 && _in.Read(_scratch, DrainMs) > 0)
        {
        }
    }

    private ushort Pause => _data.Fields.Pause;

    /// <summary>停止の間、EP 0x81 を読み捨てる (9.9)</summary>
    private void Drain() => _in.Read(_scratch, DrainMs);

    /// <summary>書いたぶんを渡す。溜めが空かないまま <see cref="TunerPool.Linger"/> 経ったら、読む側がいないとみて終わる (Zd1jStream と同じ)</summary>
    private bool Flush(PipeWriter writer)
    {
        var flushing = writer.FlushAsync();
        if (flushing.IsCompleted) return !flushing.Result.IsCompleted;
        var waiting = flushing.AsTask();
        var stalled = Stopwatch.StartNew();
        while (!waiting.Wait(50))
        {
            if (_stopping)
            {
                writer.CancelPendingFlush();
                return false;
            }
            if (stalled.Elapsed >= TunerPool.Linger)
            {
                writer.CancelPendingFlush();
                _ended = true;
                _stalled();
                return false;
            }
        }
        return !waiting.Result.IsCompleted;
    }

    private void End(string reason)
    {
        if (_stopping) return;
        _reason = reason;
        Log.Write($"[{_name}] {reason}");
    }

    /// <summary>機材の受信を止める (9.9 の手順 1〜5)。失敗したら機器の状態は分からないとして印を付ける</summary>
    private void StopReception()
    {
        try
        {
            _board.LockedToStop(() => _board.Session.StopReception(Pause, Drain));
        }
        catch (Exception error) when (error is Dt295Exception or InvalidOperationException)
        {
            _board.MarkFault($"受信を止められません ({error.Message})");
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // 閉じた・もう印が付いている
        }
    }

    /// <summary>止める。読み出しのスレッドを止めてから、読み捨てながら機材の受信を止め (9.9)、最後に EP 0x81 の読みを止める (手順 6)</summary>
    public void Stop()
    {
        _stopping = true;
        var stopped = Stopwatch.StartNew();
        Output.Stop();
        PumpStopped = _pump.Join(TimeSpan.FromSeconds(3));
        StopReception();
        _board.Receiving = false;
        _in.Dispose();
        Output.WaitReaders(ChildTs.ReaderDrain - stopped.Elapsed);
        Output.Dispose();
        _ended = true;
    }
}

/// <summary>
/// PIX-DT295 のチューナー (地上波・BS・CS。チューナーは 1 つ)。**試験的。** ボードは初めての選局で開き、捨てられるまで開いたまま
/// (認証済みのセッションを 30 秒ごとに更新し続ける)
/// </summary>
public sealed class Dt295Tuner : ITuneDevice
{
    /// <summary>
    /// 選局から最初の TS を待つ上限と、流している間にデータが途切れてよい上限 (10.1 の「10 秒データが来なければ異常」)。
    /// 地上波はこれがロックの判定の代わり (7.5)
    /// </summary>
    private readonly TimeSpan _silence;

    private readonly TimeSpan? _settle;
    private readonly string _name;
    private readonly string _device;
    private readonly Func<Dt295ReceiveData> _receive;
    private readonly Func<Dt295Board> _open;
    private readonly Lock _gate = new();
    private Dt295Board? _board;
    private Dt295Stream? _stream;

    /// <summary>
    /// チャンネルごとの、前回の PAT・PMT・CAT の写し (エージェントが動いている間だけ持つ)。同じチャンネルを選び直すと、最初の準備から
    /// 全部のルートを書き、PMT が届くのを待たずに映像と音声が流れる。届く PSI と見比べて、違えば写しを捨てる
    /// </summary>
    private readonly Dictionary<string, Dt295RouteSnapshot> _routeCache = [];

    /// <summary>いまの受信の写しのキー (周波数・TSID・番組番号)</summary>
    private string? _streamKey;

    public Dt295Tuner(string port) : this($"{Dt295.Model} {port}", Dt295.Device(port), Dt295Receive.Ensure, () => Dt295Board.Acquire(port))
    {
    }

    internal Dt295Tuner(string name, string device, Func<Dt295ReceiveData> receive, Func<Dt295Board> open, TimeSpan? silence = null, TimeSpan? settle = null)
    {
        _silence = silence ?? Dt295Stream.Silence;
        _settle = settle;
        _name = name;
        _device = device;
        _receive = receive;
        _open = open;
    }

    public Stream Output => _stream?.Output ?? throw new InvalidOperationException($"{_name} はまだ選局していません");

    public bool Tuned
    {
        get
        {
            lock (_gate) return _stream is { Ended: false };
        }
    }

    internal Dt295Stream? Stream => _stream;

    internal Dt295Board? Board => _board;

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        lock (_gate)
        {
            StopStream();
            var data = _receive();
            Dt295Board board;
            try
            {
                if (_board is { Fault: not null } broken)
                {
                    broken.Dispose();
                    _board = null;
                }
                board = _board ??= _open();
                Px4Userland.ClearNotice(_device, this);
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException)
            {
                // メーカーのデータが無い、開けない、認証できない。空いているときも画面に出す
                Px4Userland.SetNotice(_device, this, error.Message);
                throw new IOException(error.Message, error);
            }

            // 衛星は、機材に PID を選ばせない (自動だと PMT の ES の一覧が空に書き換わる)。PSI から決めたルートで、指定された番組だけを取る
            if (tuning.Satellite) data = data with { Fields = data.Fields.WithAutoPidMode(false) };
            // ServiceId は 1〜65535 か null (ChannelTable が 0 を断る)。null なら全番組を追う
            var routes = new Dt295RouteTracker(needCat: !tuning.Satellite, service: tuning.Satellite ? tuning.ServiceId : null, satellite: tuning.Satellite);
            var key = $"{(tuning.Satellite ? "S" : "T")}{tuning.Frequency}:{streamId}:{(tuning.Satellite ? tuning.ServiceId : null)}";
            if (_routeCache.TryGetValue(key, out var cached)) routes.Seed(cached);
            _streamKey = key;
            try
            {
                board.Locked(() =>
                {
                    board.CheckCard();
                    if (tuning.Satellite)
                    {
                        int? tsid = streamId == ChannelTable.NoStreamId ? null : (int)streamId;
                        // TSID を指していなければ、その中継器の先頭の TS (スロット 0)
                        board.Frontend.TuneSatellite(tuning.Frequency * 1000L, 0, tsid);
                    }
                    else
                    {
                        board.Frontend.TuneTerrestrialHz(tuning.Frequency);
                    }
                });
                _stream = Dt295Stream.Start(board, data, routes, _name, () => Task.Run(Stall), _silence, _settle, tuning.Satellite ? tuning.ServiceId ?? 0 : 0);
            }
            catch (Dt295Exception error) when (error.Message == Dt295Frontend.NoLock)
            {
                throw new IOException(ITuneDevice.SyncFailed, error);
            }
            catch (ArgumentOutOfRangeException error)
            {
                throw new IOException($"{_name} では選べない周波数です ({error.Message})", error);
            }
            catch (Dt295Exception error)
            {
                board.MarkFault(error.Message);
                throw new IOException(error.Message, error);
            }

            if (!_stream.WaitFirst(_silence))
            {
                var reason = _stream.Reason ?? Dt295Stream.NoData;
                StopStream();
                throw new IOException(reason);
            }
        }
    }

    private void Stall()
    {
        lock (_gate)
        {
            if (_stream is { Ended: true }) StopStream();
        }
    }

    private void StopStream()
    {
        var stream = _stream;
        _stream = null;
        var key = _streamKey;
        _streamKey = null;
        stream?.Stop();
        // 読み出しのスレッドが終わってから (ルートの計画は読み出しのスレッドが書き換える)、PAT と全部の PMT がそろっていれば写しを取る。
        // 次に同じチャンネルを選ぶとき、最初の準備に使う。見比べていない写しや、計画を作れなかった状態は取らない (前の写しを残す)
        if (stream is { PumpStopped: true } && key is not null && stream.Routes.Snapshot() is { } snapshot) _routeCache[key] = snapshot;
    }

    /// <summary>捨てる (定義が変わった・止める)。セッションを終えて閉じる</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            StopStream();
            _board?.Dispose();
            _board = null;
        }
        Px4Userland.ClearNotice(_device, this);
    }
}
