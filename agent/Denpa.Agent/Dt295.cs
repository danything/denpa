using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;

namespace Denpa.Agent;

/*
 * PIXELA PIX-DT295 (USB 06b8:103b。MB86M01 系の ASSP に地上波・衛星の復調器と B-CAS の差し込み口)。
 * **機材の事実を書き出した仕様書 (DT295 の仕様書) だけから書いた** (参考の実装のソースは見ていない)。節の番号 (「4.2」など) は
 * その仕様書のもの。
 *
 * **試験的。** 設定の device は dt295:<USB のポート>。チューナーとしての持ち方は Dt295Tuner.cs、確かめる入口は Dt295Probe.cs。
 * ここにあるのは 1 台ぶんの操作: 起動 (4)・認証と 30 秒ごとの更新 (5)・エラーからの復帰 (5.8)・カード (6)・受信の準備と停止 (9)。
 * 受信に要るフィールド表と TS の IV は公式パッケージの zip から取れないので、Dt295Receive.cs で別に揃える。
 */

/// <summary>PIX-DT295 の識別と、刺さっているものを探す・開く</summary>
public static class Dt295
{
    public const int Vendor = 0x06B8;
    public const int Product = 0x103B;
    public const string Model = "PIXELA PIX-DT295";

    /// <summary>設定の <c>device</c> の頭 (<c>dt295:4-12.1</c>。シリアルは使わずポートで指す。<see cref="Zd1j"/> と同じ形)</summary>
    public const string Scheme = "dt295:";

    private const string DevUsb = "/dev/bus/usb";

    public static string Device(string port) => $"{Scheme}{port}";

    public static bool Is(string? device) => device?.StartsWith(Scheme, StringComparison.Ordinal) == true;

    /// <summary><c>dt295:4-12.1</c> からポートを取る。形式が違えば null</summary>
    public static string? Parse(string device)
    {
        if (!Is(device)) return null;
        var port = device[Scheme.Length..];
        return UsbSysfs.IsPort(port) ? port : null;
    }

    /// <summary>
    /// 設定に書いたのと同じ形式で。**開かない** (開くと idle イメージの書き込みと認証まで進んでしまう)。
    /// 受けられる種別は地上波・BS・CS (チューナーは 1 つで切り替え。13 章)
    /// </summary>
    public static List<TunerSpec> Detect()
    {
        try
        {
            return [.. Ports(Log.Write).Select(port => new TunerSpec($"{Model} {port}", ["GR", "BS", "CS"], false, Device(port)))];
        }
        catch (Exception error) when (error is IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Write($"{Model} を探せません ({error.Message})");
            return [];
        }
    }

    /// <summary>刺さっているポート。**開かない**。Linux はカーネルのドライバが使っているものを並べない</summary>
    public static List<string> Ports(Action<string>? warn = null) =>
        OperatingSystem.IsLinux() ? Ports(UsbSysfs.Devices, warn) : [.. UsbDevices.List(Vendor, Product).Select(found => found.Port)];

    /// <summary>Linux の sysfs から (場所を渡せるのはテストのため)</summary>
    internal static List<string> Ports(string sysfs, Action<string>? warn)
    {
        var found = new List<string>();
        if (!Directory.Exists(sysfs)) return found;
        var vendor = Vendor.ToString("x4", CultureInfo.InvariantCulture);
        var product = Product.ToString("x4", CultureInfo.InvariantCulture);
        foreach (var dir in Directory.EnumerateFileSystemEntries(sysfs).Order(StringComparer.Ordinal))
        {
            var port = Path.GetFileName(dir);
            if (!UsbSysfs.IsPort(port)) continue;
            if (UsbSysfs.Read(dir, "idVendor") != vendor || UsbSysfs.Read(dir, "idProduct") != product) continue;
            var driver = UsbSysfs.Driver(sysfs, port);
            if (driver is not (null or "usbfs"))
            {
                warn?.Invoke($"{Model} {port} はカーネルのドライバ ({driver}) が使っているので使いません");
                continue;
            }
            found.Add(port);
        }
        return found;
    }

    /// <summary>
    /// 開く (Linux は usbfs、Windows は WinUSB、macOS は IOKit)。インターフェース 0 を確保する (2.2)。
    /// 構成 1 を選ぶ操作はしない (構成は 1 つだけで、OS が選んだまま使う)
    /// </summary>
    public static IUsbDevice OpenUsb(string port) =>
        OperatingSystem.IsLinux()
            ? UsbFsDevice.Open(UsbSysfs.Devices, DevUsb, port, Vendor, Product)
            : UsbDevices.Open(port, Vendor, Product);
}

/// <summary>カードの状態 (6.1)。値は 0x822AC の 16 ビットの上位 4 ビット</summary>
public enum Dt295CardState
{
    Initial = 0,
    Inserted = 1,
    Activating = 2,
    Ready = 3,
}

/// <summary>認証の計算 (5.3・5.4・5.6)。どれも状態を持たない</summary>
public static class Dt295Auth
{
    /// <summary>認証 1 段目の「初期ペイロード」: LE32 の 8 語 (5.3 の手順 1)</summary>
    public static byte[] InitialPayload()
    {
        uint[] words = [0x7E0, 6, 14, 0x578, 1, 3, 2, 12];
        var payload = new byte[32];
        for (var i = 0; i < words.Length; i++) BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(i * 4), words[i]);
        return payload;
    }

    /// <summary>行番号 n (5.3 の手順 3・4): 鍵 1 で「A_PREFIX ‖ R[32] ‖ 初期ペイロード[6]」の CMAC を取り、最終バイトの下位 4 ビット</summary>
    public static int RowIndex(ReadOnlySpan<byte> key1, ReadOnlySpan<byte> prefix, ReadOnlySpan<byte> first, ReadOnlySpan<byte> initial)
    {
        if (prefix.Length != 30) throw new ArgumentException("A_PREFIX は 30 バイトです", nameof(prefix));
        Span<byte> input = stackalloc byte[32];
        prefix.CopyTo(input);
        input[30] = first[32];
        input[31] = initial[6];
        return Dt295Crypto.Cmac(key1, input)[15] & 0x0F;
    }

    /// <summary>返答の MAC (5.3 の手順 6): 鍵 2 で「R の先頭 32 バイト ‖ ROW」の CMAC</summary>
    public static byte[] ResponseMac(ReadOnlySpan<byte> key2, ReadOnlySpan<byte> first, ReadOnlySpan<byte> row)
    {
        Span<byte> input = stackalloc byte[64];
        first[..32].CopyTo(input);
        row[..32].CopyTo(input[32..]);
        return Dt295Crypto.Cmac(key2, input);
    }

    /// <summary>セッション鍵 (5.4): 鍵 3 で「返答 ‖ ROW ‖ S_SUFFIX」の CMAC を取り、S[12..15] ‖ S[8..11] ‖ S[0..7] に並べ替える</summary>
    public static byte[] SessionKey(ReadOnlySpan<byte> key3, ReadOnlySpan<byte> answer, ReadOnlySpan<byte> row, ReadOnlySpan<byte> suffix)
    {
        if (answer.Length != 20 || row.Length != 32 || suffix.Length != 12) throw new ArgumentException("セッション鍵の入力は 20 + 32 + 12 バイトです");
        Span<byte> input = stackalloc byte[64];
        answer.CopyTo(input);
        row.CopyTo(input[20..]);
        suffix.CopyTo(input[52..]);
        return Reorder(Dt295Crypto.Cmac(key3, input));
    }

    /// <summary>S[12..15] ‖ S[8..11] ‖ S[0..7] (5.4 の手順 3)</summary>
    public static byte[] Reorder(ReadOnlySpan<byte> s)
    {
        var key = new byte[16];
        s[12..16].CopyTo(key);
        s[8..12].CopyTo(key.AsSpan(4));
        s[..8].CopyTo(key.AsSpan(8));
        return key;
    }

    /// <summary>更新の MAC (5.6 の手順 2・3): 鍵 4 で「C の先頭 32 バイト ‖ R_SUFFIX ‖ 更新計数 (BE32)」の CMAC</summary>
    public static byte[] RefreshMac(ReadOnlySpan<byte> key4, ReadOnlySpan<byte> challenge, ReadOnlySpan<byte> suffix, uint counter)
    {
        if (suffix.Length != 28) throw new ArgumentException("R_SUFFIX は 28 バイトです", nameof(suffix));
        Span<byte> input = stackalloc byte[64];
        challenge[..32].CopyTo(input);
        suffix.CopyTo(input[32..]);
        BinaryPrimitives.WriteUInt32BigEndian(input[60..], counter);
        return Dt295Crypto.Cmac(key4, input);
    }

    /// <summary>更新計数の次 (0xFFFFFFFF の次は 1。5.6 の手順 5)</summary>
    public static uint Next(uint counter) => counter == 0xFFFFFFFF ? 1 : counter + 1;

    /// <summary>MAC 16 バイト ‖ 乱数 4 バイト</summary>
    public static byte[] WithNonce(ReadOnlySpan<byte> mac, ReadOnlySpan<byte> nonce)
    {
        var answer = new byte[20];
        mac[..16].CopyTo(answer);
        nonce[..4].CopyTo(answer.AsSpan(16));
        return answer;
    }
}

/// <summary>起動のしかた (4.1)</summary>
public enum Dt295Boot
{
    /// <summary>idle イメージがもう動いていた (0x10)</summary>
    Running,

    /// <summary>idle イメージを書き込んだ (0x0000 から)</summary>
    Uploaded,

    /// <summary>エラーの状態 (0xFFFF) から戻した (5.8)</summary>
    Recovered,
}

/// <summary>
/// PIX-DT295 の 1 台ぶんの操作 (起動・認証・更新・カード・セッションの終了)。1 つのスレッドから使う。
/// **状態を変えるコマンドは失敗しても送り直さない** (13 章)
/// </summary>
public sealed class Dt295Device
{
    // 状態 (3.6)
    public const ushort Cold = 0x0000;
    public const ushort Idle = 0x0010;
    public const ushort Authenticated = 0x0011;

    /// <summary>セッション更新の間隔 (5.6)</summary>
    public const int RefreshMs = 30000;

    // セキュアコマンドの ID (3.11)
    public const uint AuthFirst = 0x01010000;
    public const uint AuthSecond = 0x01020000;
    public const uint TsKeyRequest = 0x07010600;
    public const uint RefreshQuery = 0x02010200;
    public const uint RefreshAnswer = 0x02020400;

    /// <summary>カード状態と通知データ (6.1)</summary>
    private const uint CardArea = 0x822AC;
    private const int CardNotice = 0x112;

    private readonly Dt295Bridge _bridge;
    private readonly Func<int, byte[]> _random;
    private Dt295Material? _material;
    private byte[]? _sessionKey;
    private byte[]? _sessionIv;
    private byte[]? _tsKey;
    private uint _counter;
    private long _refreshAt;

    /// <summary>カードの通知を受けた回数 (6.1 の「通知の世代番号」)</summary>
    public int CardNotices { get; private set; }

    /// <param name="random">暗号用の乱数 (5.1)。テストは決まった値を返す</param>
    public Dt295Device(Dt295Bridge bridge, Func<int, byte[]>? random = null)
    {
        _bridge = bridge;
        _random = random ?? RandomNumberGenerator.GetBytes;
    }

    public Dt295Bridge Bridge => _bridge;

    /// <summary>セッション鍵を持っている (認証の手順 9 まで進んだ)</summary>
    public bool HasSession => _sessionKey is not null;

    // ---------------------------------------------------------------------
    // 起動 (4)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 状態で分岐して起動する (4.1)。0x10 ならそのまま、0x0000 なら idle イメージを書き込み、0xFFFF なら 1 回だけ戻してみる (5.8)。
    /// 0x11 などは手を出さずに投げる
    /// </summary>
    public Dt295Boot Boot(ReadOnlySpan<byte> idle)
    {
        var state = _bridge.Read16(Dt295Bridge.StateRegister);
        switch (state)
        {
            case Idle:
                return Dt295Boot.Running;
            case Cold:
                UploadIdle(idle);
                return Dt295Boot.Uploaded;
            case Dt295Bridge.ErrorState:
                Recover();
                return Dt295Boot.Recovered;
            default:
                throw new Dt295Exception($"{Dt295.Model} はほかのプロセスが使っているかもしれません (0x82008 = 0x{state:X4})。使っていなければ抜いて挿し直してください");
        }
    }

    /// <summary>
    /// エラーの状態 (0xFFFF) から未認証のアイドル (0x10) に戻す (5.8)。cmd 3 は 1 回だけ。古いエラーの通知がしばらく残るので、
    /// その間の 0x11 と 0xFFFF は待ち続ける。戻ったら認証からやり直す
    /// </summary>
    public void Recover()
    {
        var b = _bridge;
        var state = b.Read16(Dt295Bridge.StateRegister);
        if (state != Dt295Bridge.ErrorState) throw new Dt295Exception($"エラーの状態ではありません (0x{state:X4})");
        Forget();
        if ((b.Events() & Dt295Bridge.EventState) != 0) b.Clear(Dt295Bridge.EventState);
        b.Command(Dt295Channel.Main, 3, 0, 0);
        var deadline = b.Time.NowMs + 5000;
        while (true)
        {
            if ((b.Events() & Dt295Bridge.EventState) != 0) b.Clear(Dt295Bridge.EventState);
            state = b.Read16(Dt295Bridge.StateRegister);
            if (state == Idle) return;
            if (state is not (Authenticated or Dt295Bridge.ErrorState)) throw new Dt295Exception($"エラーの状態から戻せません (0x{state:X4})。抜いて挿し直してください");
            if (b.Time.NowMs >= deadline) throw new Dt295Exception("エラーの状態から 5000 ms で戻りません。抜いて挿し直してください");
            b.Time.Sleep(Dt295Bridge.PollMs);
        }
    }

    /// <summary>4.2 の idle イメージの書き込み</summary>
    private void UploadIdle(ReadOnlySpan<byte> idle)
    {
        var b = _bridge;
        // 1〜4
        b.Modify16(0x90194, 12, 3, 1);
        b.Write16(0x90198, 0x0040);
        for (var bit = 13; bit >= 0; bit--) b.Modify16(0x90078, bit, 1, 0);
        for (var bit = 11; bit >= 0; bit--) b.Modify16(0x901B4, bit, 1, 0);
        // 5. 書き込みを待つ合図
        if (!b.WaitEvent(Dt295Bridge.EventState, 100)) throw new Dt295Exception("idle イメージを受け取る合図 (0x90074 のビット 2) が来ません");
        // 6. 確かめて消す。参照実装はここで部分書き換えを使う (ほかの立っているビットも消えるかもしれない。14 章の 11)。同じ順でする
        if ((b.Events() & Dt295Bridge.EventState) == 0) throw new Dt295Exception("0x90074 のビット 2 が消えました");
        b.Modify16(Dt295Bridge.EventRegister, 2, 1, 1);
        // 7. イメージ
        b.Upload(idle, "idle イメージ");
        // 8・9
        for (var bit = 13; bit >= 0; bit--) b.Modify16(0x90078, bit, 1, bit == 4 ? 0 : 1);
        for (var bit = 11; bit >= 0; bit--) b.Modify16(0x901B4, bit, 1, 1);
        // 10. 起動。1 回だけ。EP0 が再起動するので返らないことがある
        var old = b.Read16(0x90070);
        b.WriteOnce(0x90070, Dt295Bridge.Field(old, 2, 1, 1));
        // 11. 20 ms おきに 3000 ms まで。読みの時間切れは「まだ準備中」
        var deadline = b.Time.NowMs + 3000;
        while (true)
        {
            try
            {
                var events = b.Events();
                var state = b.Read16(Dt295Bridge.StateRegister);
                if ((events & Dt295Bridge.EventState) != 0 && state is Idle or Authenticated)
                {
                    b.Clear(Dt295Bridge.EventState);
                    return;
                }
            }
            catch (IOException error) when (error is not UsbGoneException)
            {
                // EP0 の再起動中
            }
            if (b.Time.NowMs >= deadline) throw new Dt295Exception("idle イメージを書き込んだあと、3000 ms 待っても起動しません");
            b.Time.Sleep(20);
        }
    }

    // ---------------------------------------------------------------------
    // 認証とセッション (5)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 認証する (5.3)。前提は状態 0x10。最後にアイドル設定 (5.5) をして 0x11 になれば終わり。**失敗しても送り直さない。**
    /// 手順 9 より後で失敗しても、セッション鍵は終了処理のために残す
    /// </summary>
    public void Authenticate(Dt295Material material)
    {
        var state = _bridge.State();
        if (state != Idle) throw new Dt295Exception($"認証は状態 0x10 のときだけです (いまは 0x{state:X4})");
        _material = material;
        var initial = Dt295Auth.InitialPayload();
        var first = _bridge.Secure(AuthFirst, initial, null, null);
        if (first.Length < 36) throw new Dt295Exception($"認証 1 段目の応答が短すぎます ({first.Length} バイト)");
        var n = Dt295Auth.RowIndex(material.Key1, material.AuthPrefix, first, initial);
        var row = material.Rows.AsSpan(32 * n, 32).ToArray();
        var mac = Dt295Auth.ResponseMac(material.Key2, first, row);
        var answer = Dt295Auth.WithNonce(mac, _random(4));
        _bridge.Secure(AuthSecond, answer, null, null);
        _sessionKey = Dt295Auth.SessionKey(material.Key3, answer, row, material.SessionSuffix);
        _sessionIv = material.SessionIv.ToArray();
        _counter = 1;
        _refreshAt = _bridge.Time.NowMs + RefreshMs;
        IdleSettings();
    }

    /// <summary>アイドル設定 (5.5)。0x11 になるまで待つ</summary>
    public void IdleSettings()
    {
        var b = _bridge;
        b.Modify16(0x80074, 8, 2, 1);
        b.Modify16(0x80074, 0, 7, 0);
        b.Modify16(0x80076, 12, 4, 1);
        b.Modify16(0x80076, 8, 4, 1);
        b.Modify16(0x80076, 4, 4, 1);
        b.Modify16(0x80078, 8, 8, 0);
        b.Modify16(0x80078, 0, 8, 0);
        b.Command(Dt295Channel.Main, 1, 0, 0);
        b.WaitState(Authenticated, 5000);
    }

    /// <summary>次の更新までの残り (ms)。負なら期限を過ぎている</summary>
    public long RefreshDueInMs => _refreshAt - _bridge.Time.NowMs;

    /// <summary>期限を過ぎていれば更新する (5.6。参照実装は約 1 秒おきに確かめる)。更新したら true</summary>
    public bool RefreshIfDue()
    {
        if (!HasSession || RefreshDueInMs > 0) return false;
        Refresh();
        return true;
    }

    /// <summary>
    /// セッションを更新する (5.6)。**失敗したら送り直さず、セッションは使えないものとして扱う** (鍵は終了処理のために残す)
    /// </summary>
    public void Refresh()
    {
        if (_sessionKey is null || _sessionIv is null) throw new InvalidOperationException("認証していません");
        var material = _material ?? throw new InvalidOperationException("素材がありません");
        var challenge = _bridge.Secure(RefreshQuery, [], _sessionKey, _sessionIv);
        if (challenge.Length < 32) throw new Dt295Exception($"更新の問い合わせの応答が短すぎます ({challenge.Length} バイト)");
        var mac = Dt295Auth.RefreshMac(material.Key4, challenge, material.RefreshSuffix, _counter);
        _bridge.Secure(RefreshAnswer, Dt295Auth.WithNonce(mac, _random(4)), _sessionKey, _sessionIv);
        _counter = Dt295Auth.Next(_counter);
        _refreshAt = _bridge.Time.NowMs + RefreshMs;
    }

    /// <summary>
    /// TS 鍵 (9.1)。**認証セッションごとに 1 回だけ要求し**、2 回目からは持っているものを返す
    /// (もう一度要求すると断られる。9.10)
    /// </summary>
    public byte[] TsKey()
    {
        if (_tsKey is not null) return _tsKey;
        if (_sessionKey is null || _sessionIv is null) throw new InvalidOperationException("認証していません");
        byte[] arguments = [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0];
        var key = _bridge.Secure(TsKeyRequest, arguments, _sessionKey, _sessionIv);
        if (key.Length != 16) throw new Dt295Exception($"TS 鍵の応答が 16 バイトではありません ({key.Length} バイト)");
        _tsKey = key;
        return key;
    }

    /// <summary>
    /// セッションを終える (5.7)。idle イメージを書き戻して未認証のアイドル (0x10) に戻し、鍵を消す。
    /// 前提は受信を止めていて状態 0x11
    /// </summary>
    public void Close(ReadOnlySpan<byte> idle)
    {
        var state = _bridge.State();
        if (state != Authenticated) throw new Dt295Exception($"セッションを終えられるのは状態 0x11 のときだけです (いまは 0x{state:X4})");
        _bridge.Command(Dt295Channel.Main, 4, 0, 1);
        _bridge.Upload(idle, "idle イメージ (書き戻し)");
        _bridge.Command(Dt295Channel.Main, 4, 1, 0);
        _bridge.WaitState(Idle, 5000);
        Forget();
    }

    /// <summary>手元の鍵を消す</summary>
    public void Forget()
    {
        if (_sessionKey is not null) CryptographicOperations.ZeroMemory(_sessionKey);
        if (_sessionIv is not null) CryptographicOperations.ZeroMemory(_sessionIv);
        if (_tsKey is not null) CryptographicOperations.ZeroMemory(_tsKey);
        _sessionKey = null;
        _sessionIv = null;
        _tsKey = null;
    }

    // ---------------------------------------------------------------------
    // TRC での受信 (9 章)
    // ---------------------------------------------------------------------

    /// <summary>
    /// 受信の準備 (9.2〜9.6。2 回目からは 9.10): TS 鍵 → TRC イメージ → 領域のクリア → フィールド表 → ルートと番組情報 → 取得開始 (状態 1)。
    /// 前提は状態 0x11 で選局済み。TRC は毎回書く (書かずに始めると 0x0480 で失敗する。9.10)。TS 鍵を返す
    /// </summary>
    public byte[] PrepareReception(ReadOnlySpan<byte> trc, Dt295FieldTable fields, IReadOnlyList<Dt295Route> plan, Dt295Program? main)
    {
        var key = TsKey();
        UploadTrc(trc);
        ClearSettings();
        fields.Apply(_bridge);
        Dt295Routes.Write(_bridge, plan, main);
        var pause = PauseState();
        if (pause != fields.Pause) throw new Dt295Exception($"一時停止の状態番号が読み戻しで {pause} です (フィールド表からは {fields.Pause})");
        StartAcquisition();
        return key;
    }

    /// <summary>受信設定の領域 (9.3 の手順 1)。この順に 0 で埋める</summary>
    public static readonly (uint Address, int Length)[] SettingsAreas = [(0x1000, 0x500), (0x1500, 0x500), (0x1A00, 0x100)];

    /// <summary>
    /// その状態になるまで 10 ms おきに待つ (3.7)。待っている間も約 1 秒おきにセッションの更新の期限を確かめる
    /// (取得開始・受信開始の待ちは 30 秒あり、更新の間隔と同じ長さになる。5.6)
    /// </summary>
    public void WaitState(ushort wanted, int timeoutMs, Action? idle = null)
    {
        var deadline = _bridge.Time.NowMs + timeoutMs;
        var check = _bridge.Time.NowMs + 1000;
        while (true)
        {
            var state = _bridge.State();
            if (state == wanted) return;
            if (_bridge.Time.NowMs >= deadline) throw new Dt295Exception($"状態 0x{wanted:X2} になりません (いまは 0x{state:X4}、{timeoutMs} ms 待ちました)");
            if (_bridge.Time.NowMs >= check)
            {
                check += 1000;
                RefreshIfDue();
            }
            if (idle is null) _bridge.Time.Sleep(Dt295Bridge.PollMs);
            else idle();
        }
    }

    /// <summary>9.2 の手順 2〜4: cmd 4 (sub 0, val 0) → TRC イメージ → 状態 0x11 のままか。前提は状態 0x11</summary>
    public void UploadTrc(ReadOnlySpan<byte> trc)
    {
        RequireAuthenticated("TRC イメージの書き込み");
        _bridge.Command(Dt295Channel.Main, 4, 0, 0);
        _bridge.Upload(trc, "TRC イメージ");
        var state = _bridge.State();
        if (state != Authenticated) throw new Dt295Exception($"TRC イメージを書き込んだあと、状態が 0x11 ではありません (0x{state:X4})");
    }

    /// <summary>9.3 の手順 1: 受信設定の領域を 0 で埋める (64 バイトずつ)</summary>
    public void ClearSettings()
    {
        foreach (var (address, length) in SettingsAreas) _bridge.Write(address, new byte[length]);
    }

    /// <summary>一時停止の状態番号 (9.3 の最後): 0x1002 のビット 8〜9 が 1 なら 3、0 なら 4。それ以外は不正</summary>
    public ushort PauseState()
    {
        var input = (_bridge.Read16(0x1002) >> 8) & 0x3;
        return input switch
        {
            1 => 3,
            0 => 4,
            _ => throw new Dt295Exception($"0x1002 のビット 8〜9 が {input} です (0 か 1 のはず。9.3)"),
        };
    }

    /// <summary>9.6 取得開始: 0x82028 に 0 → cmd 4 (sub 0x20) → 状態 1 (30000 ms)</summary>
    public void StartAcquisition()
    {
        _bridge.Write16(0x82028, 0);
        _bridge.Command(Dt295Channel.Main, 4, 0x20, 0);
        WaitState(1, 30000);
    }

    /// <summary>9.7 受信開始: 前提は状態 1。cmd 5 (sub 0, val 2) を 1 回だけ → 状態 2 (30000 ms)</summary>
    public void StartReception()
    {
        var state = _bridge.State();
        if (state != 1) throw new Dt295Exception($"受信開始は状態 1 のときだけです (いまは 0x{state:X4})");
        _bridge.Command(Dt295Channel.Main, 5, 0, 2);
        WaitState(2, 30000);
    }

    /// <summary>9.8 受信中のルート変更の 6 バイト: <c>(スロット &lt;&lt; 8) | ECM参照スロット</c>、<c>(有効 &lt;&lt; 15) | PID</c>、<c>PID</c> (BE16)</summary>
    public static byte[] RouteChangeBytes(int slot, int ecmSlot, int pid, bool valid)
    {
        if (slot is < 0 or >= Dt295Routes.Slots || slot == Dt295Routes.PatSlot) throw new ArgumentOutOfRangeException(nameof(slot), "スロット 4 (PAT) は指定できません (9.8)");
        var words = new[] { (ushort)((slot << 8) | ecmSlot), (ushort)((valid ? 0x8000 : 0) | pid), (ushort)pid };
        var bytes = new byte[6];
        for (var i = 0; i < 3; i++) BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(i * 2), words[i]);
        return bytes;
    }

    /// <summary>9.8: 受信中 (状態 2) にスロットを足す。参照実装が確かめたのは空きスロットへの ECM でない PID の追加だけ</summary>
    public void ChangeRoute(Dt295Route route)
    {
        _bridge.Write(0x81000, RouteChangeBytes(route.Slot, route.EcmSlot, route.Pid, true));
        _bridge.Command(Dt295Channel.Main, 5, 1, 0);
    }

    /// <summary>
    /// 9.9 の手順 1〜5: 受信中なら一時停止 (<paramref name="pause"/>) → 設定済み (1) → アイドル設定で 0x11。
    /// <paramref name="drain"/> は待つ間に EP 0x81 を読み捨てる (呼ぶ側が持っている読み)。
    /// EP 0x81 の読みを止めるのは、これが戻ってから (手順 6)
    /// </summary>
    public void StopReception(ushort pause, Action drain)
    {
        var state = _bridge.State();
        if (state is not (1 or 2 or 3 or 4 or Authenticated)) throw new Dt295Exception($"知らない状態なので止められません (0x{state:X4}。9.9)");
        if (state == 2)
        {
            _bridge.Command(Dt295Channel.Main, 5, 0, pause);
            var deadline = _bridge.Time.NowMs + 5000;
            while (true)
            {
                state = _bridge.State();
                if (state == pause) break;
                if (state != 2) throw new Dt295Exception($"一時停止の途中で状態が 0x{state:X4} になりました (9.9)");
                if (_bridge.Time.NowMs >= deadline) throw new Dt295Exception($"一時停止 (状態 {pause}) になりません (5000 ms)");
                drain();
            }
        }
        if (state is 3 or 4)
        {
            _bridge.Command(Dt295Channel.Main, 5, 0, 1);
            WaitState(1, 5000, drain);
            state = 1;
        }
        if (state == 1) IdleSettings();
    }

    // ---------------------------------------------------------------------
    // カード (6)
    // ---------------------------------------------------------------------

    /// <summary>
    /// カード状態を読む (6.1)。カードの通知が来ていれば通知データを読んで (中身は使わない) 消し、世代番号を進めて読み直す。
    /// エラーのビットが立っていれば投げる
    /// </summary>
    public Dt295CardState CardState()
    {
        Span<byte> notice = stackalloc byte[CardNotice];
        for (var i = 0; i < 32; i++)
        {
            var events = _bridge.Events();
            if ((events & Dt295Bridge.EventCardError) != 0) throw new Dt295Exception("カードのエラー (0x90074 のビット 10) が立っています");
            if ((events & Dt295Bridge.EventCard) != 0)
            {
                _bridge.Read(CardArea, notice);
                _bridge.Clear(Dt295Bridge.EventCard);
                CardNotices++;
                continue;
            }
            return (Dt295CardState)(_bridge.Read16(CardArea) >> 12);
        }
        throw new Dt295Exception("カードの通知が 32 回続きました");
    }

    /// <summary>カードの初期化 (6.2)。前提は状態 0x11</summary>
    public Dt295CardState InitCard()
    {
        RequireAuthenticated("カードの初期化");
        _bridge.Command(Dt295Channel.Sub, 0x0A, 0, 1);
        return CardState();
    }

    /// <summary>
    /// カードの活性化 (6.3)。3 になれば終わり。1 か「0 でまだ通知なし」でなければ断る。**送り直さない**
    /// </summary>
    public Dt295CardState ActivateCard(int timeoutMs = 2000)
    {
        if (timeoutMs is < 1 or > 5000) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
        RequireAuthenticated("カードの活性化");
        var state = CardState();
        if (state == Dt295CardState.Ready) return state;
        if (!Waitable(state)) throw new Dt295Exception($"カードが用意できていません (カード状態 {(int)state})");
        _bridge.Command(Dt295Channel.Sub, 0x0A, 1, 1);
        var deadline = _bridge.Time.NowMs + timeoutMs;
        while (true)
        {
            RequireAuthenticated("カードの活性化");
            state = CardState();
            if (state == Dt295CardState.Ready) return state;
            if (!Waitable(state) && state != Dt295CardState.Activating) throw new Dt295Exception($"カードを活性化できません (カード状態 {(int)state})");
            if (_bridge.Time.NowMs >= deadline) throw new Dt295Exception($"カードが {timeoutMs} ms で活性化しません (カード状態 {(int)state})");
            _bridge.Time.Sleep(Dt295Bridge.PollMs);
        }
    }

    /// <summary>
    /// 待ってよいカード状態: 1、または 0 でまだ一度も通知を受けていない (6.1・6.3)。
    /// 通知のあとの 0 は「カードが無い・抜かれた」
    /// </summary>
    private bool Waitable(Dt295CardState state) =>
        state == Dt295CardState.Inserted || (state == Dt295CardState.Initial && CardNotices == 0);

    private void RequireAuthenticated(string what)
    {
        var state = _bridge.State();
        if (state != Authenticated) throw new Dt295Exception($"{what}は状態 0x11 のときだけです (いまは 0x{state:X4})");
    }
}
