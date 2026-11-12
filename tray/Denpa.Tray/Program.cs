// denpa-tray: denpa の様子を Windows の通知領域に出す。install.ps1 が HKLM の Run に載せ、誰がサインインしても起動する。
//
// 10 秒ごとに同じ PC の denpa の http://127.0.0.1:3000/api/health を呼ぶ (ポートは install.ps1 の $WebPort と同じ)。
// 答えればアプリのアイコン、答えなければ注意のアイコンにする。出すのは動いているか・録画とエンコードの本数・新しいバージョンがあるか。
// メニューは、denpa を開く・新しいバージョンへの更新 (あるときだけ)・終了。アイコンのダブルクリックでも開く。
//
// 更新は勝手に始めない。新しいバージョンが出たら通知を 1 回出し、人がメニューから選んだら install.ps1 を管理者の
// PowerShell で流す (UAC を通す)。録画中・エンコード中なら先に確かめる (Words.AskBeforeUpdate)。
// install.ps1 は録画の終わりを待ってから、このアプリごと入れ替えて起こし直す。
//
// **エージェントだけ入れたとき** (install.ps1 -AgentOnly) は、引数 `--agent-only <TUNERS_FILE>` で起こされる。
// denpa はこの PC にいないので、10 秒ごとにエージェント (127.0.0.1:25252) へ TLS で繋ぎ、証明書が返るかだけを見る
// (組んでいないので API は呼べない)。メニューは、応答するかの 1 行・登録用の URL を表示…・終了。
// 「登録用の URL を表示…」は、管理者の PowerShell (UAC を通す) で denpa-agent --pair を流し、URL と QR を出す (Pairing.Script)。
//
// WinForms は Native AOT に対応していないので、Shell_NotifyIcon と隠しウィンドウを Win32 で直に呼ぶ
// (作りは danything/mado の tray/ と同じ)。

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Denpa.Tray;

internal static unsafe partial class Program
{
    const string Url = "http://localhost:3000";
    const uint WmTrayIcon = 0x8000 + 1; // WM_APP + 1。アイコンの上のマウス
    const uint WmHealth = 0x8000 + 2; // WM_APP + 2。バックグラウンドで取得した様子を出す
    const uint WmUpdate = 0x8000 + 3; // WM_APP + 3。更新の前に取得し直した様子で確かめる
    const int MenuOpen = 1, MenuUpdate = 2, MenuPair = 3, MenuExit = 9;

    static nint hwnd, appIcon, warnIcon;
    static uint taskbarCreated;

    /// <summary>最後に取得した様子。答えなければ null。バックグラウンドのスレッドが書き、WmHealth で画面のスレッドに知らせる</summary>
    static volatile Health? health;
    static volatile bool fetching;
    /// <summary>通知を出したバージョン。同じバージョンでは 1 回だけ出す</summary>
    static string? noticed;
    /// <summary>更新の前に取得し直した様子。バックグラウンドのスレッドが書き、WmUpdate で画面のスレッドに渡す。取得している間は updating</summary>
    static volatile Health? asked;
    static bool updating;

    /// <summary>エージェントだけ入れたときに、エージェントの TUNERS_FILE (無ければ空)。denpa の様子の代わりにエージェントの応答を見る。null なら denpa を見る</summary>
    static string? agentOnly;
    /// <summary>エージェントが最後に応答したか (agentOnly のとき)。バックグラウンドのスレッドが書く</summary>
    static volatile bool agentUp;

    [STAThread]
    static int Main(string[] args)
    {
        if (args is ["--agent-only", ..]) agentOnly = args.ElementAtOrDefault(1) ?? "";
        // サインインし直したときや install.ps1 が起こしたときに、二重に出さない
        CreateMutexW(0, 0, "Local\\denpa-tray");
        if (Marshal.GetLastPInvokeError() == 183 /* ERROR_ALREADY_EXISTS */) return 0;

        var instance = GetModuleHandleW(null);
        // ApplicationIcon で exe に埋め込んだアイコン (リソースの ID は 32512)。無ければ Windows の標準のもの
        appIcon = LoadImageW(instance, 32512, 1 /* IMAGE_ICON */, GetSystemMetrics(49 /* SM_CXSMICON */), GetSystemMetrics(50), 0);
        if (appIcon == 0) appIcon = LoadIconW(0, 32512 /* IDI_APPLICATION */);
        warnIcon = LoadIconW(0, 32515 /* IDI_WARNING */);

        fixed (char* cls = "denpa-tray")
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = &WndProc,
                hInstance = instance,
                lpszClassName = cls,
            };
            if (RegisterClassExW(&wc) == 0) return 1;
            hwnd = CreateWindowExW(0, cls, cls, 0, 0, 0, 0, 0, 0, 0, instance, 0);
        }
        if (hwnd == 0) return 1;
        taskbarCreated = RegisterWindowMessageW("TaskbarCreated");

        AddIcon();
        Fetch();
        SetTimer(hwnd, 1, 10_000, 0);

        MSG msg;
        while (GetMessageW(&msg, 0, 0, 0) > 0)
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        return 0;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static nint WndProc(nint h, uint msg, nint w, nint l)
    {
        try
        {
            switch (msg)
            {
                case WmTrayIcon:
                    switch ((uint)(l & 0xffff))
                    {
                        case 0x0203: // WM_LBUTTONDBLCLK
                            Open();
                            break;
                        case 0x0205: // WM_RBUTTONUP
                        case 0x007B: // WM_CONTEXTMENU
                            ShowMenu();
                            break;
                    }
                    return 0;
                case WmHealth:
                    Apply();
                    return 0;
                case WmUpdate:
                    updating = false;
                    ConfirmAndUpdate(asked!);
                    return 0;
                case 0x0113: // WM_TIMER
                    Fetch();
                    return 0;
                case 0x0011: // WM_QUERYENDSESSION。サインアウトで来る。閉じてよいと答える
                    return 1;
                case 0x0016: // WM_ENDSESSION。w が 0 なら、サインアウトは取り消された
                    if (w != 0) Quit();
                    return 0;
                case 0x0010: // WM_CLOSE
                    Quit();
                    return 0;
                case 0x0002: // WM_DESTROY
                    PostQuitMessage(0);
                    return 0;
            }
            // エクスプローラーが落ちて起き直したら、アイコンを出し直す
            if (msg == taskbarCreated && taskbarCreated != 0) AddIcon();
        }
        catch
        {
            // 例外はネイティブの呼び出し元に返さない (返すとプロセスごと落ちる)
        }
        return DefWindowProcW(h, msg, w, l);
    }

    static void Fetch()
    {
        if (fetching) return;
        fetching = true;
        if (agentOnly is not null)
        {
            // Net.AgentAnswers は例外を出さない
            _ = Net.AgentAnswers().ContinueWith(t =>
            {
                agentUp = t.Result;
                fetching = false;
                PostMessageW(hwnd, WmHealth, 0, 0);
            }, TaskScheduler.Default);
            return;
        }
        // Net.Get は例外を出さない。答えなければ null
        _ = Net.Get().ContinueWith(t =>
        {
            health = t.Result;
            fetching = false;
            PostMessageW(hwnd, WmHealth, 0, 0);
        }, TaskScheduler.Default);
    }

    /// <summary>取得した様子をアイコンと説明に出す。新しいバージョンが出ていれば、そのバージョンでは 1 回だけ通知する</summary>
    static void Apply()
    {
        if (agentOnly is not null)
        {
            Modify(agentUp ? appIcon : warnIcon, AgentWords.Summary(agentUp));
            return;
        }
        var now = health;
        Modify(now is null ? warnIcon : appIcon, Words.Tip(now));
        if (now?.Latest is { } latest && latest != noticed)
        {
            noticed = latest;
            var (title, text) = Words.UpdateNotice(latest);
            Balloon(title, text);
        }
    }

    static void ShowMenu()
    {
        if (agentOnly is not null)
        {
            ShowAgentMenu();
            return;
        }
        var now = health;
        var menu = CreatePopupMenu();
        AppendMenuW(menu, 1 /* MF_GRAYED */, 0, Words.Summary(now));
        AppendMenuW(menu, 0x800 /* MF_SEPARATOR */, 0, null);
        AppendMenuW(menu, now is null ? 1u : 0, MenuOpen, "denpa を開く");
        if (now?.Latest is { } latest) AppendMenuW(menu, 0, MenuUpdate, Words.UpdateItem(latest));
        AppendMenuW(menu, 0x800, 0, null);
        AppendMenuW(menu, 0, MenuExit, "終了");
        switch (Track(menu))
        {
            case MenuOpen: Open(); break;
            case MenuUpdate: Update(now!); break;
            case MenuExit: Quit(); break;
        }
    }

    /// <summary>エージェントだけ入れたときのメニュー。応答するかの 1 行・登録用の URL を表示…・終了</summary>
    static void ShowAgentMenu()
    {
        var menu = CreatePopupMenu();
        AppendMenuW(menu, 1 /* MF_GRAYED */, 0, AgentWords.Summary(agentUp));
        AppendMenuW(menu, 0x800 /* MF_SEPARATOR */, 0, null);
        AppendMenuW(menu, 0, MenuPair, AgentWords.PairItem);
        AppendMenuW(menu, 0x800, 0, null);
        AppendMenuW(menu, 0, MenuExit, "終了");
        switch (Track(menu))
        {
            case MenuPair: ShowPairUrl(); break;
            case MenuExit: Quit(); break;
        }
    }

    /// <summary>メニューを出し、選ばれた項目を返す (選ばなければ 0)</summary>
    static int Track(nint menu)
    {
        POINT p;
        GetCursorPos(&p);
        // 前に出しておかないと、メニューの外をクリックしても閉じない
        SetForegroundWindow(hwnd);
        var cmd = TrackPopupMenu(menu, 0x100 /* TPM_RETURNCMD */ | 0x80 /* TPM_NONOTIFY */ | 0x2 /* TPM_RIGHTBUTTON */, p.X, p.Y, 0, hwnd, 0);
        PostMessageW(hwnd, 0, 0, 0);
        DestroyMenu(menu);
        return cmd;
    }

    /// <summary>
    /// 登録用の URL と QR を、管理者の PowerShell で denpa-agent --pair を流して出す (同じ bin にある denpa-agent.exe)。
    /// UAC で断られたら何もしない (ShellExecute がエラーを返すだけ)
    /// </summary>
    static void ShowPairUrl()
    {
        var agent = Path.Combine(AppContext.BaseDirectory, "denpa-agent.exe");
        ShellExecuteW(hwnd, "runas", "powershell.exe", Installer.Arguments(Pairing.Script(agent, agentOnly)), null, 1);
    }

    static void Open() => ShellExecuteW(0, "open", Url, null, null, 1 /* SW_SHOWNORMAL */);

    /// <summary>
    /// 更新する。確かめる前に様子を取得し直す (メニューを開いている間に録画やエンコードが始まることがある。
    /// 答えなければ、メニューを開いたときの様子で確かめる)。取得はバックグラウンドで、その間も画面のスレッドは止めない。
    /// 取得し終えたら WmUpdate で ConfirmAndUpdate に渡す
    /// </summary>
    static void Update(Health opened)
    {
        if (updating) return;
        updating = true;
        // Net.Get は例外を出さない
        _ = Net.Get().ContinueWith(t =>
        {
            asked = t.Result ?? opened;
            PostMessageW(hwnd, WmUpdate, 0, 0);
        }, TaskScheduler.Default);
    }

    /// <summary>
    /// 録画中・エンコード中なら先に確かめ、選ばれたら install.ps1 を管理者の PowerShell で流す。
    /// UAC で断られたら何もしない (ShellExecute がエラーを返すだけ)
    /// </summary>
    static void ConfirmAndUpdate(Health now)
    {
        if (Words.AskBeforeUpdate(now) is { } question &&
            MessageBoxW(hwnd, question, "denpa の更新", 0x1 /* MB_OKCANCEL */ | 0x20 /* MB_ICONQUESTION */ | 0x10000 /* MB_SETFOREGROUND */) != 1 /* IDOK */)
        {
            return;
        }
        ShellExecuteW(hwnd, "runas", "powershell.exe", Installer.Arguments(Installer.Script), null, 1);
    }

    static NOTIFYICONDATAW Data(uint flags) =>
        new() { cbSize = (uint)sizeof(NOTIFYICONDATAW), hWnd = hwnd, uID = 1, uFlags = flags };

    static void AddIcon()
    {
        var d = Data(0x1 /* NIF_MESSAGE */ | 0x2 /* NIF_ICON */ | 0x4 /* NIF_TIP */);
        d.uCallbackMessage = WmTrayIcon;
        if (agentOnly is not null)
        {
            d.hIcon = agentUp ? appIcon : warnIcon;
            Copy(AgentWords.Summary(agentUp), d.szTip, 128);
        }
        else
        {
            d.hIcon = health is null ? warnIcon : appIcon;
            Copy(Words.Tip(health), d.szTip, 128);
        }
        Shell_NotifyIconW(0 /* NIM_ADD */, &d);
    }

    static void Modify(nint icon, string tip)
    {
        var d = Data(0x2 | 0x4);
        d.hIcon = icon;
        Copy(tip, d.szTip, 128);
        Shell_NotifyIconW(1 /* NIM_MODIFY */, &d);
    }

    static void Balloon(string title, string text)
    {
        var d = Data(0x10 /* NIF_INFO */);
        Copy(text, d.szInfo, 256);
        Copy(title, d.szInfoTitle, 64);
        d.dwInfoFlags = 1 /* NIIF_INFO */;
        Shell_NotifyIconW(1, &d);
    }

    static void Quit()
    {
        var d = Data(0);
        Shell_NotifyIconW(2 /* NIM_DELETE */, &d);
        DestroyWindow(hwnd);
    }

    static void Copy(string s, char* dst, int size)
    {
        var n = Math.Min(s.Length, size - 1);
        for (var i = 0; i < n; i++) dst[i] = s[i];
        dst[n] = '\0';
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam, lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public delegate* unmanaged[Stdcall]<nint, uint, nint, nint, nint> lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        public char* lpszMenuName, lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public nint hWnd;
        public uint uID, uFlags, uCallbackMessage;
        public nint hIcon;
        public fixed char szTip[128];
        public uint dwState, dwStateMask;
        public fixed char szInfo[256];
        public uint uVersion;
        public fixed char szInfoTitle[64];
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial nint CreateMutexW(nint attributes, int initialOwner, string name);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandleW(string? name);

    [LibraryImport("user32.dll")]
    private static partial nint LoadImageW(nint instance, nint name, uint type, int cx, int cy, uint load);

    [LibraryImport("user32.dll")]
    private static partial nint LoadIconW(nint instance, nint name);

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);

    [LibraryImport("user32.dll")]
    private static partial ushort RegisterClassExW(WNDCLASSEXW* wc);

    [LibraryImport("user32.dll")]
    private static partial nint CreateWindowExW(uint exStyle, char* className, char* windowName, uint style,
        int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial uint RegisterWindowMessageW(string name);

    [LibraryImport("user32.dll")]
    private static partial nint DefWindowProcW(nint hwnd, uint msg, nint w, nint l);

    [LibraryImport("user32.dll")]
    private static partial int GetMessageW(MSG* msg, nint hwnd, uint min, uint max);

    [LibraryImport("user32.dll")]
    private static partial int TranslateMessage(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial nint DispatchMessageW(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial void PostQuitMessage(int code);

    [LibraryImport("user32.dll")]
    private static partial int PostMessageW(nint hwnd, uint msg, nint w, nint l);

    [LibraryImport("user32.dll")]
    private static partial int DestroyWindow(nint hwnd);

    [LibraryImport("user32.dll")]
    private static partial nint SetTimer(nint hwnd, nint id, uint ms, nint proc);

    [LibraryImport("user32.dll")]
    private static partial nint CreatePopupMenu();

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int AppendMenuW(nint menu, uint flags, nint id, string? text);

    [LibraryImport("user32.dll")]
    private static partial int TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint hwnd, nint rect);

    [LibraryImport("user32.dll")]
    private static partial int DestroyMenu(nint menu);

    [LibraryImport("user32.dll")]
    private static partial int GetCursorPos(POINT* p);

    [LibraryImport("user32.dll")]
    private static partial int SetForegroundWindow(nint hwnd);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBoxW(nint hwnd, string text, string caption, uint type);

    [LibraryImport("shell32.dll")]
    private static partial int Shell_NotifyIconW(uint message, NOTIFYICONDATAW* data);

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint ShellExecuteW(nint hwnd, string? verb, string file, string? parameters, string? dir, int show);
}

/// <summary>denpa との話。await は unsafe の文脈では書けないので、Program とは分ける</summary>
internal static class Net
{
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(3) };

    /// <summary>
    /// エージェントが応答するか。TLS で繋ぎ、エージェントの証明書が返れば応答したとみなす。エージェントはクライアント証明書を求めるので、
    /// 証明書を持たないこちらとの握手はそのあと断られるが、それは見ない (組んでいないので API は呼べない)
    /// </summary>
    public static async Task<bool> AgentAnswers()
    {
        var answered = false;
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            using var tcp = new System.Net.Sockets.TcpClient();
            await tcp.ConnectAsync("127.0.0.1", Pairing.Port, cancel.Token);
            await using var tls = new System.Net.Security.SslStream(tcp.GetStream());
            await tls.AuthenticateAsClientAsync(new System.Net.Security.SslClientAuthenticationOptions
            {
                TargetHost = "denpa-agent",
                RemoteCertificateValidationCallback = (_, certificate, _, _) =>
                {
                    answered = certificate is not null;
                    return true;
                },
            }, cancel.Token);
        }
        catch
        {
            // 繋がらない・握手を断られた。証明書が返っていたかで決める
        }
        return answered;
    }

    public static async Task<Health?> Get()
    {
        try
        {
            return Health.Parse(await http.GetStringAsync("http://127.0.0.1:3000/api/health"));
        }
        catch
        {
            return null;
        }
    }
}
