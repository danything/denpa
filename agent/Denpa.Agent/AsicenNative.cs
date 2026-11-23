using System.Runtime.InteropServices;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// asicen-userland を組み込んだ共有ライブラリ (<c>libdenpa_asicen.so</c>。agent/asicen/denpa_asicen.h) を呼ぶ所。**試験的。実機では確かめていない。**
///
/// <para>
/// ライブラリは GPL-2.0-only で、Linux のイメージと Android のアプリにだけ入れる (docs/licenses.md)。ここは関数を呼ぶだけで、
/// 上流の表や値は持たない。読み込みは <see cref="NativeLibrary"/> で、関数は名前で引いて関数ポインタで呼ぶ
/// (Native AOT で通る。IoKitDevice.cs と同じ形)。**読み込めない・ABI が <see cref="Abi"/> でない・上流のバージョンが
/// <see cref="Version"/> でなければ、無いのと同じに扱う** (理由は <see cref="Problem"/>)。
/// </para>
/// </summary>
internal static unsafe class AsicenNative
{
    /// <summary>denpa_asicen.h の DENPA_ASICEN_ABI</summary>
    public const int Abi = 1;

    /// <summary>対応を確かめた上流のバージョン (agent/asicen/build.sh で固定しているもの)</summary>
    public const string Version = "1.0.0";

    /// <summary>ライブラリのファイルの名前 (Android の jniLibs も同じ名前)</summary>
    public const string FileName = "libdenpa_asicen.so";

    /// <summary>denpa_asicen_open の戻り値。ファームウェア待ちの機材に流し込んだだけで、開いていない</summary>
    public const int Loaded = 200;

    public const int IsdbT = 1;
    public const int IsdbS = 2;

    /// <summary>上流の Error の番号のうち、こちらが見分けるもの</summary>
    public const int InvalidArgument = 1;
    public const int Busy = 4;
    public const int Timeout = 6;
    public const int UsbIo = 7;
    public const int Disconnected = 8;
    public const int Unsupported = 11;
    public const int BufferTooSmall = 14;

    /// <summary>読めなかった理由 (読めたら null)</summary>
    public static string? Problem { get; private set; }

    private sealed class Table
    {
        public delegate* unmanaged[Cdecl]<int> AbiOf;
        public delegate* unmanaged[Cdecl]<nint> VersionOf;
        public delegate* unmanaged[Cdecl]<int, nint> ErrorName;
        public delegate* unmanaged[Cdecl]<byte*, nuint, nuint*, int> ListJson;
        public delegate* unmanaged[Cdecl]<nint*, int, nint*, byte*, nuint, int> Open;
        public delegate* unmanaged[Cdecl]<nint, byte*, nuint, int> Model;
        public delegate* unmanaged[Cdecl]<nint, int> Receivers;
        public delegate* unmanaged[Cdecl]<nint, int, int> ReceiverSystems;
        public delegate* unmanaged[Cdecl]<nint, int> Lnb;
        public delegate* unmanaged[Cdecl]<nint, int, int, ulong, ushort, ushort, byte, uint, nint*, int> Tune;
        public delegate* unmanaged[Cdecl]<nint, byte*, nuint, uint, nuint*, int*, int*, int> Read;
        public delegate* unmanaged[Cdecl]<nint, void> Stop;
        public delegate* unmanaged[Cdecl]<nint, void> Close;
        public delegate* unmanaged[Cdecl]<int, nint*, int> OpenMock;
    }

    /// <summary>
    /// ライブラリのパス。<c>ASICEN_USERLAND_DIR</c> (既定 <c>/opt/asicen-userland</c>。Android はアプリの nativeLibraryDir) の
    /// <see cref="FileName"/>。テストは <c>ASICEN_LIBRARY</c> で直に渡す
    /// </summary>
    public static string LibraryPath =>
        Environment.GetEnvironmentVariable("ASICEN_LIBRARY") is { Length: > 0 } path ? path : Path.Combine(AsicenUserland.Dir, FileName);

    private static readonly Lazy<Table?> Functions = new(Load);

    private static Table? Load()
    {
        // Linux と Android だけ (bionic も OS は Linux と答える)。Windows・macOS の配布物には入れない
        if (!OperatingSystem.IsLinux())
        {
            Problem = "この OS では使えません";
            return null;
        }
        var path = LibraryPath;
        if (!File.Exists(path))
        {
            Problem = $"{path} がありません";
            return null;
        }
        if (!NativeLibrary.TryLoad(path, out var library))
        {
            Problem = $"{path} を読み込めません";
            return null;
        }
        try
        {
            nint Export(string name) => NativeLibrary.GetExport(library, name);
            var table = new Table
            {
                AbiOf = (delegate* unmanaged[Cdecl]<int>)Export("denpa_asicen_abi"),
                VersionOf = (delegate* unmanaged[Cdecl]<nint>)Export("denpa_asicen_version"),
                ErrorName = (delegate* unmanaged[Cdecl]<int, nint>)Export("denpa_asicen_error_name"),
            };
            var abi = table.AbiOf();
            var version = Marshal.PtrToStringUTF8(table.VersionOf());
            if (abi != Abi || version != Version)
            {
                Problem = $"{path} は ABI {abi}・asicen-userland {version} です。対応しているのは ABI {Abi}・asicen-userland {Version} だけです";
                return null;
            }
            table.ListJson = (delegate* unmanaged[Cdecl]<byte*, nuint, nuint*, int>)Export("denpa_asicen_list_json");
            table.Open = (delegate* unmanaged[Cdecl]<nint*, int, nint*, byte*, nuint, int>)Export("denpa_asicen_open");
            table.Model = (delegate* unmanaged[Cdecl]<nint, byte*, nuint, int>)Export("denpa_asicen_model");
            table.Receivers = (delegate* unmanaged[Cdecl]<nint, int>)Export("denpa_asicen_receivers");
            table.ReceiverSystems = (delegate* unmanaged[Cdecl]<nint, int, int>)Export("denpa_asicen_receiver_systems");
            table.Lnb = (delegate* unmanaged[Cdecl]<nint, int>)Export("denpa_asicen_lnb");
            table.Tune = (delegate* unmanaged[Cdecl]<nint, int, int, ulong, ushort, ushort, byte, uint, nint*, int>)Export("denpa_asicen_tune");
            table.Read = (delegate* unmanaged[Cdecl]<nint, byte*, nuint, uint, nuint*, int*, int*, int>)Export("denpa_asicen_read");
            table.Stop = (delegate* unmanaged[Cdecl]<nint, void>)Export("denpa_asicen_stop");
            table.Close = (delegate* unmanaged[Cdecl]<nint, void>)Export("denpa_asicen_close");
            // テスト用に組んだものだけにある
            if (NativeLibrary.TryGetExport(library, "denpa_asicen_open_mock", out var mock))
            {
                table.OpenMock = (delegate* unmanaged[Cdecl]<int, nint*, int>)mock;
            }
            return table;
        }
        catch (EntryPointNotFoundException error)
        {
            Problem = $"{path} に関数がありません ({error.Message})";
            return null;
        }
    }

    private static Table Must => Functions.Value ?? throw new IOException($"asicen-userland を使えません ({Problem})");

    /// <summary>ライブラリが読めたか (読めなければ理由は <see cref="Problem"/>)</summary>
    public static bool Available => Functions.Value is not null;

    /// <summary>上流の Error の名前 (<c>TIMEOUT</c>)</summary>
    public static string ErrorName(int code) => Marshal.PtrToStringUTF8(Must.ErrorName(code)) ?? code.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>asicend --list-json と同じ JSON</summary>
    public static string ListJson()
    {
        var table = Must;
        nuint length = 0;
        var code = table.ListJson(null, 0, &length);
        if (code != BufferTooSmall) throw new AsicenError(code, $"ASICEN の機材を並べられません ({ErrorName(code)})");
        var buffer = new byte[(int)length + 1];
        fixed (byte* output = buffer)
        {
            code = table.ListJson(output, (nuint)buffer.Length, &length);
        }
        if (code != 0) throw new AsicenError(code, $"ASICEN の機材を並べられません ({ErrorName(code)})");
        return Encoding.UTF8.GetString(buffer, 0, (int)length);
    }

    /// <summary>
    /// 筐体を開く。引数は asicend と同じ (<see cref="AsicenEnclosure.Arguments"/>)。開けなければ番号とライブラリのメッセージを添えて <see cref="AsicenError"/>。
    /// ファームウェアを流し込んだだけなら null (<see cref="Loaded"/>)
    /// </summary>
    public static nint? Open(IReadOnlyList<string> args)
    {
        var table = Must;
        var strings = args.Select(arg => Marshal.StringToCoTaskMemUTF8(arg)).ToArray();
        try
        {
            var message = new byte[1024];
            nint enclosure = 0;
            int code;
            fixed (nint* argv = strings)
            fixed (byte* text = message)
            {
                code = table.Open(argv, strings.Length, &enclosure, text, (nuint)message.Length);
            }
            if (code == 0) return enclosure;
            var reason = Encoding.UTF8.GetString(message, 0, Math.Max(0, Array.IndexOf(message, (byte)0)));
            if (code == Loaded)
            {
                Log.Write($"asicen-userland: {reason}");
                return null;
            }
            throw new AsicenError(code, $"{reason} ({ErrorName(code)})");
        }
        finally
        {
            foreach (var arg in strings) Marshal.FreeCoTaskMem(arg);
        }
    }

    /// <summary>偽の機材で開く (テスト用に組んだライブラリだけ)</summary>
    public static nint OpenMock(int receivers)
    {
        var table = Must;
        if (table.OpenMock == null) throw new IOException("このライブラリは偽の機材を持っていません");
        nint enclosure = 0;
        var code = table.OpenMock(receivers, &enclosure);
        return code == 0 ? enclosure : throw new AsicenError(code, $"偽の機材を開けません ({ErrorName(code)})");
    }

    public static string Model(nint enclosure)
    {
        var buffer = new byte[128];
        fixed (byte* output = buffer)
        {
            if (Must.Model(enclosure, output, (nuint)buffer.Length) != 0) return "";
        }
        return Encoding.UTF8.GetString(buffer, 0, Math.Max(0, Array.IndexOf(buffer, (byte)0)));
    }

    public static int Receivers(nint enclosure) => Must.Receivers(enclosure);

    /// <summary>受信機が受けられる方式 (<see cref="IsdbT"/>・<see cref="IsdbS"/> のビット)</summary>
    public static int ReceiverSystems(nint enclosure, int receiver) => Must.ReceiverSystems(enclosure, receiver);

    public static bool Lnb(nint enclosure) => Must.Lnb(enclosure) != 0;

    /// <summary>選局して TS を流し始める。失敗すれば番号を添えて <see cref="AsicenError"/></summary>
    public static nint Tune(nint enclosure, int receiver, int system, ulong frequencyHz, ushort tsid, ushort slot, byte lnbVoltage, uint timeoutMs)
    {
        nint stream = 0;
        var code = Must.Tune(enclosure, receiver, system, frequencyHz, tsid, slot, lnbVoltage, timeoutMs, &stream);
        return code == 0 ? stream : throw new AsicenError(code, ErrorName(code));
    }

    /// <summary>TS を読む。来なければ 0 バイト。終われば理由 (<see cref="Terminal"/>) を添えて Ended</summary>
    public static (int Length, bool Ended, int Terminal) Read(nint stream, Span<byte> output, uint timeoutMs)
    {
        nuint length = 0;
        int ended = 0, terminal = 0;
        int code;
        fixed (byte* buffer = output)
        {
            code = Must.Read(stream, buffer, (nuint)output.Length, timeoutMs, &length, &ended, &terminal);
        }
        if (code != 0) throw new AsicenError(code, $"TS を読めません ({ErrorName(code)})");
        return ((int)length, ended != 0, terminal);
    }

    public static void Stop(nint stream) => Must.Stop(stream);

    public static void Close(nint enclosure) => Must.Close(enclosure);

    /// <summary>TS が終わった理由 (上流の TunerStreamTerminal)</summary>
    public static string Terminal(int terminal) => terminal switch
    {
        1 => "読み出しが追いつきませんでした",
        2 => "USB の読み書きに失敗しました",
        3 => "同期が外れました",
        4 => "機材の内部で失敗しました",
        5 => "止めました",
        6 => "機材が抜けました",
        _ => $"理由 {terminal}",
    };
}

/// <summary>ライブラリが返した失敗 (上流の Error の番号つき)</summary>
internal sealed class AsicenError(int code, string message) : IOException(message)
{
    public int Code { get; } = code;

    /// <summary>機材が抜けた・USB の読み書きに失敗した (筐体を開き直す)</summary>
    public bool Lost => Code is AsicenNative.UsbIo or AsicenNative.Disconnected;
}
