namespace Denpa.Agent;

/// <summary>試験用。チューナーの手順 8 のあとの 50 ms (CXD2856 の仕様書 4.3)</summary>
internal enum IsdbtTunerWait
{
    /// <summary>仕様書のとおり、50 ms 待ってから手順 9〜10 を書き、選局を終える</summary>
    Spec,

    /// <summary>手順 8 のあとすぐ選局を終え、50 ms たってから手順 9〜10 を書く (<c>tunerwait=0</c>)</summary>
    Deferred,

    /// <summary>50 ms の待ちと手順 9〜10 をどちらも省く (<c>tunerwait=none</c>)</summary>
    None,
}

/// <summary>試験用。TMCC のプリセット</summary>
internal enum IsdbtPresetUse
{
    /// <summary>書かない (今と同じ)</summary>
    Off,

    /// <summary>覚えた 13 バイトを書く (<c>preset=on</c>)</summary>
    On,

    /// <summary>覚えた 13 バイトの、TMCC の最後のビットを反転して書く (<c>preset=bad</c>)</summary>
    Bad,
}

/// <summary>
/// 試験用のビルドだけにある、CXD2856ER の地上波のロックを縮める設定 (環境変数 <c>DENPA_CXD_ISDBT_TRY</c>。カンマ区切り)。
/// <c>tunerwait=0</c>・<c>tunerwait=none</c>・<c>modegi=force</c>・<c>preset=on</c>・<c>preset=bad</c>・<c>settle=0</c>。指定が無ければ今と同じ動き
/// </summary>
internal sealed record IsdbtTry(IsdbtTunerWait TunerWait, bool ForceModeGi, IsdbtPresetUse Preset, bool NoSettle)
{
    public const string Variable = "DENPA_CXD_ISDBT_TRY";

    public static readonly IsdbtTry Default = new(IsdbtTunerWait.Spec, false, IsdbtPresetUse.Off, false);

    /// <summary>プロセスで 1 つの設定 (環境変数から)。読めない指定は標準エラーに出し、指定が無いものとして扱う</summary>
    public static IsdbtTry Current { get; } = FromEnvironment();

    /// <summary>
    /// <c>--tune</c> が立てる。ロックしたあとにモードとガードインターバルと TMCC の 13 バイトを読み、受信機ごとの出力に足す行を作る。
    /// 立てていなければ、選局で読み書きするレジスタは今と同じ
    /// </summary>
    public static bool Observe { get; set; }

    private static IsdbtTry FromEnvironment()
    {
        var text = Environment.GetEnvironmentVariable(Variable);
        if (Parse(text, out var error) is { } parsed) return parsed;
        Console.Error.WriteLine($"{Variable}={text}: {error}。指定が無いものとして扱います");
        return Default;
    }

    /// <summary>カンマ区切りの指定を読む。読めなければ null と理由</summary>
    public static IsdbtTry? Parse(string? text, out string? error)
    {
        error = null;
        var result = Default;
        foreach (var raw in (text ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw)
            {
                case "tunerwait=0":
                    result = result with { TunerWait = IsdbtTunerWait.Deferred };
                    break;
                case "tunerwait=none":
                    result = result with { TunerWait = IsdbtTunerWait.None };
                    break;
                case "modegi=force":
                    result = result with { ForceModeGi = true };
                    break;
                case "preset=on":
                    result = result with { Preset = IsdbtPresetUse.On };
                    break;
                case "preset=bad":
                    result = result with { Preset = IsdbtPresetUse.Bad };
                    break;
                case "settle=0":
                    result = result with { NoSettle = true };
                    break;
                default:
                    error = $"{raw} は分かりません (tunerwait=0・tunerwait=none・modegi=force・preset=on・preset=bad・settle=0)";
                    return null;
            }
        }
        return result;
    }

    /// <summary><c>--tune</c> に出す 1 行</summary>
    public string Describe()
    {
        if (this == Default) return "基準 (指定なし)";
        List<string> parts = [];
        if (TunerWait == IsdbtTunerWait.Deferred) parts.Add("tunerwait=0");
        if (TunerWait == IsdbtTunerWait.None) parts.Add("tunerwait=none");
        if (ForceModeGi) parts.Add("modegi=force");
        if (Preset == IsdbtPresetUse.On) parts.Add("preset=on");
        if (Preset == IsdbtPresetUse.Bad) parts.Add("preset=bad");
        if (NoSettle) parts.Add("settle=0");
        return string.Join(",", parts);
    }

    /// <summary>モードとガードインターバル (バンク <c>60</c> の <c>40</c>。bit3:2 が 0 = モード 1、1 = モード 3、2 = モード 2。bit1:0 が 0 = 1/32、1 = 1/16、2 = 1/8、3 = 1/4)</summary>
    public static string DescribeModeGi(byte value)
    {
        var mode = ((value >> 2) & 0x03) switch
        {
            0 => "1",
            1 => "3",
            2 => "2",
            _ => "?",
        };
        var gi = (value & 0x03) switch
        {
            0 => "1/32",
            1 => "1/16",
            2 => "1/8",
            _ => "1/4",
        };
        return $"モード {mode}  ガードインターバル {gi} (60 の 40 = {value:X2})";
    }

    /// <summary>
    /// <c>preset=bad</c> で書く 13 バイト。最後のバイト (<c>6E</c>) は bit7:2 が TMCC の B116〜B121、bit1:0 が埋め草なので、
    /// TMCC の最後のビット (B121。bit2) を反転する
    /// </summary>
    public static byte[] Spoil(byte[] tmcc)
    {
        var spoiled = (byte[])tmcc.Clone();
        spoiled[^1] ^= 0x04;
        return spoiled;
    }
}
