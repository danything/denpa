using System.Net;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Text;
using System.Text.Json.Nodes;
using Denpa.Agent;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Https;

/*
 * チューナーエージェント。**機材に触るのはここだけ。**
 *
 * denpa から触れないものが 3 つある。
 *
 * - B-CASカード … USB のリーダーも IT930x の機材の内蔵リーダーも CECH-ZD1 J・PIX-DT295 の差し込み口も、こちらが直接扱う (CardLinks.cs。
 *   macOS / Windows の USB リーダーだけは OS の PC/SC 越し)
 * - チューナーデバイス … `/dev/dvb/*` と `/dev/bus/usb` が見えているのはこちらだけ
 * - 選局そのもの … デバイスを使って ioctl で選局する (Tuning.cs)。
 *   asicen-userland の機材は同梱のものに USB を扱わせる (Asicen.cs)。IT930x の機材と CECH-ZD1 J と PIX-DT295 と Siano の機材 (PX-S1UD など) は USB を直に持つ (It930x.cs / Zd1j.cs / Dt295.cs / Siano.cs)
 *
 * **番組や局の中身は読まない。** NIT も SDT も EIT も解析せず、TS をそのまま流す (読むのは
 * 復号に要る PAT・PMT・ECM と、契約の更新に要る CAT・EMM だけ。B25.cs)。番組や局を読むのは denpa (`packages/arib`) で、局を選り分けるのも番組表を組み立てるのも、
 * チャンネルスキャンで見つかった局を判断するのもあちらの仕事 (docs/agent.md)。
 */

/*
 * **Windows は出力を UTF-8 に。** 既定はコンソールの文字コード (英語の Windows なら 437) で、ログの日本語が
 * `?` になる (install.ps1 はログをファイルへ足していく)
 */
if (OperatingSystem.IsWindows()) Console.OutputEncoding = Encoding.UTF8;

/*
 * バージョンを出して終わる。chart の先引きの Job (charts/denpa/templates/prepull.yaml) は、
 * イメージを引いたらこれで終わる (土台は distroless でシェルも /bin/true も無い)
 */
if (args is ["--version"])
{
    Console.WriteLine(About.Version);
    return 0;
}
// エージェントが USB を直に持つ機材の USB ID を出して終わる。install.ps1 -WinUsb が読む (WinUsbTargets.cs)
if (args is ["--usb-ids"])
{
    Console.WriteLine(WinUsbTargets.ToJson());
    return 0;
}
// 実機で選局と復号だけ試す入口。サーバは立てない (Probe.cs)
if (args.ElementAtOrDefault(0) == "--tune") return Probe.Run(args);
if (args.ElementAtOrDefault(0) == "--decode-file") return Probe.Decode(args);
if (args.ElementAtOrDefault(0) == "--card") return Probe.Card(args);

// 読めない値は既定に戻さずに止める (打ち間違えたまま別のポートで立たないように。CARD_* と同じ)
var port = 25252;
if (Environment.GetEnvironmentVariable("AGENT_PORT") is { Length: > 0 } portText && !(int.TryParse(portText, out port) && port is > 0 and < 65536))
{
    Log.Write($"AGENT_PORT は 1〜65535 の数で書きます (いまは「{portText}」)");
    return 2;
}
var config = Config.FromEnvironment();

/*
 * denpa と組むときの URL を出して終わる。サーバは立てない (鍵と合言葉が無ければここで作る。AgentTls.cs)。
 * 組んだ相手がいて起動のログに出なくなってからも、これで見られる
 */
if (args is ["--pair"])
{
    // 標準出力には URL だけを出す (スクリプトで読めるように)。鍵を作ったなどのメッセージは標準エラーへ
    var stdout = Console.Out;
    Console.SetOut(Console.Error);
    stdout.WriteLine(AgentTls.Load(config.TlsDir, Environment.GetEnvironmentVariable("AGENT_PAIR_TOKEN")).PairUrl(port));
    return 0;
}
/*
 * 動いているエージェントの /denpa/tuners を自分の証明書で読んで出す (インストーラが結果を確かめる。AgentTls.Status)。
 * 待ち受けを AGENT_HOST で絞っていればそのアドレスへ、そうでなければループバックへ繋ぐ
 */
if (args is ["--status"])
{
    var target = Environment.GetEnvironmentVariable("AGENT_HOST") is { Length: > 0 } bound
        && IPAddress.TryParse(bound, out var address)
        && !address.Equals(IPAddress.Any) && !address.Equals(IPAddress.IPv6Any)
        ? bound
        : "127.0.0.1";
    return await AgentTls.Status(config.TlsDir, target, port);
}
// PIX-DT295 を確かめる。機材を設定して選局し、カードを読むまでの時間と受信の統計を出す (Dt295NativeProbe.cs)
if (args.ElementAtOrDefault(0) == "--dt295-probe") return Dt295NativeProbe.Run(args);
// IT930x の機材 (PX-MLT5・PX-Q3・PX-W3 系など) のブリッジを確かめる。ファームウェアを起動してバージョンと EEPROM の写しを出す。--chips でチップも読む (It930xProbe.cs)
if (args.ElementAtOrDefault(0) == "--it930x-probe") return It930xProbe.Run(args);
// IT930x の機材を、開いて電源を入れ・すぐ電源を切って閉じるのを続けて繰り返す (電源の短いオン/オフを再現する。It930xProbe.cs)
if (args.ElementAtOrDefault(0) == "--it930x-cycle") return It930xProbe.Cycle(args);
/*
 * **対応していない引数ではサーバを立てない。** 立ち上げると tuners.json が無ければ挿さっている機材を自分で見つけて使い始めるので、
 * 打ち間違い (`--help` など) で本番と同じ機材を取り合うことになる
 */
if (args.Length > 0)
{
    Console.Error.WriteLine($"対応していない引数です: {string.Join(" ", args)}");
    Console.Error.WriteLine("usage: denpa-agent                     (引数なしでサーバとして立ち上がる)");
    Console.Error.WriteLine("       denpa-agent --version");
    Console.Error.WriteLine("       denpa-agent --pair                (denpa と組むときの URL を出す)");
    Console.Error.WriteLine("       denpa-agent --status              (動いているエージェントの /denpa/tuners を出す)");
    Console.Error.WriteLine("       denpa-agent --usb-ids             (エージェントが USB を直に持つ機材の USB ID を出す)");
    Console.Error.WriteLine($"       {Probe.TuneUsage}");
    Console.Error.WriteLine($"       {Probe.DecodeUsage}");
    Console.Error.WriteLine($"       {Probe.CardUsage}");
    Console.Error.WriteLine($"       {Dt295NativeProbe.Usage}");
    Console.Error.WriteLine($"       {It930xProbe.Usage}");
    Console.Error.WriteLine($"       {It930xProbe.CycleUsage}");
    return 2;
}

/*
 * 待ち受けるアドレス (AGENT_HOST)。既定は全部のインターフェース。組んだ denpa しか通さない (AgentTls.cs) が、
 * 同じ機械の denpa からしか繋がない構成ではループバック (127.0.0.1) に絞る (Mac の install.sh)。
 * 鍵を配るポート (CARD_SHARE_PORT) はこれに従わない (LAN の別の拠点に配るので。CardShareServer.cs)
 */
IPAddress? host = null;
if (Environment.GetEnvironmentVariable("AGENT_HOST") is { Length: > 0 } hostText
    && !IPAddress.TryParse(hostText, out host))
{
    Log.Write($"AGENT_HOST は IP アドレスで書きます (いまは「{hostText}」)");
    return 2;
}
/*
 * 元の TS の置き場。**denpa と同じ変数で決める** (`RAW_DIR`、無ければ `MEDIA_DIR/raw`、どちらも無ければ
 * `/media/raw`)。スクランブルされたまま録れた TS を後から復号する (/denpa/decode) ときに読むので、denpa と
 * 同じ実体を同じ名前で見せる。ここの外のファイルは求められても触らない
 */
// 末尾の `/` は落とす (置き場の中かを `<置き場>/` で始まるかで見るので、`/media/raw/` だとどれも外になる)
var recorded = Path.TrimEndingDirectorySeparator(Path.GetFullPath(
    (Environment.GetEnvironmentVariable("RAW_DIR") is { Length: > 0 } rawDir ? rawDir : null)
    ?? Path.Combine(Environment.GetEnvironmentVariable("MEDIA_DIR") is { Length: > 0 } mediaDir ? mediaDir : "/media", "raw")));

// 自分の鍵と証明書、合言葉、組んだ denpa (tuners.json の隣の tls/。AgentTls.cs)
var tls = AgentTls.Load(config.TlsDir, Environment.GetEnvironmentVariable("AGENT_PAIR_TOKEN"));
/*
 * 合言葉が短いと、組むやり取りを覗いた人が HMAC の値から手元で総当たりできる。インストーラや chart が
 * 作るもの (43 字) なら当たらない。手で短いものを渡されたときだけログに書く
 */
if (tls.Token.Length < 32)
{
    Log.Write($"合言葉 (AGENT_PAIR_TOKEN か {tls.Dir} の pair-token) が短すぎます ({tls.Token.Length} 字)。推測されないよう 32 字以上の乱数にしてください (docs/agent.md)");
}
// CECH-ZD1 J がチャンネルごとに記録したロックの値 (tuners.json の隣。Zd1j.cs)
Zd1jBoard.Locks = new Zd1jLocks(config.Zd1jLocksFile);
// CXD2856ER の地上波のプリセットに使う TMCC (tuners.json の隣。TmccPresets.cs)
Cxd2856Frontend.Presets = new TmccPresets(config.TmccPresetsFile);
// 使わないカードリーダー (tuners.json の隣。CardChoice.cs)。カードを開く前に読む
CardChoice.Load(config.CardsFile);
var events = new Events();
// カードが契約の更新 (EMM) を受け入れたら、denpa に契約を確かめ直させる (Emm.cs)
CardNotice.Shared = new CardNotice(() => events.Emit("card"));
var (tuners, detected) = config.ResolveTuners();

/*
 * 鍵を配る・受け取るのは LAN の中だけ (CardLan.cs)。読めない値なら、範囲を勝手に
 * 決めずに止まる
 */
CardLanPolicy cardLan;
try
{
    cardLan = CardLanPolicy.FromEnvironment();
}
catch (ArgumentException error)
{
    Log.Write(error.Message);
    return 2;
}
if (cardLan.Port == port)
{
    Log.Write($"CARD_SHARE_PORT は AGENT_PORT ({port}) と別のポートにします");
    return 2;
}
var sharing = cardLan.Port is { } sharePort ? new CardShareServer(cardLan, sharePort) : null;

/*
 * CARD_URL は「手元にカードが無い拠点」だけ。指定しなければ自分に挿さって
 * いるカードを読む (CardShare.cs)。
 */
var cardUrl = Environment.GetEnvironmentVariable("CARD_URL");
Keys.Configure(cardUrl, cardLan.Hops);
var tune = new TuneOptions(
    Environment.GetEnvironmentVariable("FAKE_TUNE") is { Length: > 0 } fake ? fake : null);

var pool = new TunerPool(tuners, () => events.Emit("tuners"), tune) { Detected = detected };

/*
 * **asicen-userland の筐体の asicend を起動する。** 顔ぶれ (設定か、自動で見つけたもの) のうち、使う受信機がある筐体ぶん。
 * 使う受信機が無くなった筐体の asicend は止める (UserlandDaemon.Prepare)。
 * 画面からの書き換えと抜き差しで同時に呼ばれても、あとから呼んだほうが最後の設定で揃えるよう 1 つずつ通す
 */
var daemonsGate = new Lock();
// 止めるときに asicend を止めたら立てる。そのあとの抜き差しや設定の書き換えで起動し直さない
var daemonsStopped = false;
void PrepareDaemons()
{
    lock (daemonsGate)
    {
        if (daemonsStopped) return;
        // asicen-userland の筐体の asicend (Asicen.cs)。配布物が無ければ顔ぶれにも出ない。LNB 15V の設定は起動の引数に効くので先に控える
        AsicenUserland.Configure(pool.Tuners);
        UserlandDaemon.Prepare<AsicenDaemon>([.. AsicenUserland.IdsIn(pool.Tuners)], AsicenDaemon.For);
    }
}

/*
 * **挿した機材を、そのまま使えるようにする** (DeviceWatch が抜き差しを受け取ったら呼ぶ)。
 * 定義を書いてあれば、前に探したときに無かった (いま挿された) 機材を、有効なチューナーとして末尾に書き足す
 * (Config.Additions)。抜いた機材は定義から消さない (挿し直したときに名前や「使う」の設定が戻るように)。
 * 定義を書いていなければ、見つけたもので置き換える。
 * 画面からの書き換え (PUT /denpa/tuners) と同じロックで、書き足しと書き換えが混ざらないようにする
 */
var tunersGate = new Lock();
// 前に探したときに挿さっていた機材。起動したときに挿さっていたものは、挿されたとは数えない
HashSet<string?> seen = [];

// 定義を書き、読み直したものに入れ替える。tunersGate の中で呼ぶ
void ApplyTuners(List<TunerSpec> next)
{
    config.SaveTuners(next);
    var (resolved, auto) = config.ResolveTuners();
    pool.Detected = auto;
    pool.Replace(resolved);
}

void Rescan()
{
    lock (tunersGate)
    {
        var found = DeviceProbe.Detect();
        var written = config.LoadTuners();
        var added = Config.Additions(written, found, seen);
        seen = [.. found.Select(tuner => tuner.Device)];
        if (written.Count == 0)
        {
            if (found.Select(tuner => tuner.Device).SequenceEqual(pool.Tuners.Select(tuner => tuner.Device))) return;
            Log.Write($"挿さっている機材が変わりました ({found.Count} 台)");
            pool.Replace(found);
        }
        else
        {
            if (added.Count == 0) return;
            foreach (var tuner in added) Log.Write($"挿した機材を定義に足しました: {tuner.Name} [{string.Join(", ", tuner.Types)}] {tuner.Device}");
            ApplyTuners([.. written, .. added]);
        }
    }
    PrepareDaemons();
}

var builder = WebApplication.CreateSlimBuilder(args);
// 鍵を配るポートだけは待ち受けを自分で作る (IPv4 と IPv6 を分けて TTL を付ける。CardShareServer.cs)
if (sharing is { } server) builder.WebHost.UseSockets(sockets => sockets.CreateBoundListenSocket = server.Bind);
/*
 * **普通のポートは HTTPS だけ。クライアント証明書を必須にする** (出さない相手は TLS の段で落ちる。ブラウザはここで止まる)。
 * TLS の段ではどの証明書も受け、見分けるのは下のチェック (AgentTls.Decide)。鍵を配るポートは平文のまま (CardShareServer.cs)
 */
var https = new HttpsConnectionAdapterOptions
{
    ServerCertificate = tls.Certificate,
    ClientCertificateMode = ClientCertificateMode.RequireCertificate,
    ClientCertificateValidation = (_, _, _) => true,
    SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
};
builder.WebHost.ConfigureKestrel(options =>
{
    // HTTP/1.1 の chunked だけ (h2 は流しっぱなしの接続にフロー制御の窓が増えるだけ。docs/agent.md「通信は HTTPS」)
    void Secure(ListenOptions listen)
    {
        listen.Protocols = HttpProtocols.Http1;
        listen.UseHttps(https);
    }
    if (host is null) options.ListenAnyIP(port, Secure);
    else options.Listen(host, port, Secure);
    sharing?.Listen(options);
    // 選局は何時間も流しっぱなしになる。読む側が遅くても、送る速さの下限を理由に応答を切らない
    options.Limits.MinResponseDataRate = null;
});
builder.Logging.ClearProviders();

/*
 * **録画中に止められたら、録画が終わるまで止まらない** (denpa の `SHUTDOWN_WAIT` と同じ考え)。
 *
 * これが無かった頃は、**Pod を入れ替えるだけで録画が落ちた。** denpa 側は録画が
 * 終わるまで待つのに、TS を流しているこちらが先に消える。実機で 30 分番組を
 * 始まって 10 秒で失っている。Kestrel に任せられない理由は Drain。
 *
 * Kubernetes には `terminationGracePeriodSeconds` を一緒に伸ばしておくこと
 * (足りないと待っている途中で SIGKILL される)。
 */
var shutdownWait = long.TryParse(Environment.GetEnvironmentVariable("SHUTDOWN_WAIT"), out var waitMs)
    ? Math.Max(0, waitMs)
    : 6 * 60 * 60 * 1000;
builder.Services.AddSingleton<IHostLifetime>(services =>
    new Drain(pool, shutdownWait, services.GetRequiredService<IHostApplicationLifetime>()));

var app = builder.Build();

// 鍵を配るポートに来たものは、鍵を配る API だけが受ける (普通の API には回さない)
if (sharing is not null) app.Use(sharing.Serve);

/*
 * **組んだ denpa しか通さない** (AgentTls.cs)。相手の証明書の指紋が clients にあれば通し、
 * 無ければ組む API (POST /denpa/pair) だけ受ける
 */
app.Use(async (HttpContext http, RequestDelegate next) =>
{
    var peer = http.Connection.ClientCertificate is { } client ? AgentTls.FingerprintOf(client) : null;
    switch (tls.Decide(peer, http.Request.Method, http.Request.Path.Value ?? ""))
    {
        case AgentTls.Gate.Pass:
            await next(http);
            return;
        case AgentTls.Gate.Pair:
            /*
             * 本文は AgentTls.PairBodyLimit まで (1 バイト多く読めたら断る)。Kestrel の上限もそこに合わせ、
             * 応答のあとに Kestrel が残りを読み捨てるときも、上限を越えたところで接続を切らせる
             */
            if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size) size.MaxRequestBodySize = AgentTls.PairBodyLimit + 1;
            var (body, tooLarge) = await AgentTls.ReadPairBody(http.Request.Body, http.Request.ContentLength);
            if (tooLarge)
            {
                await Respond.Error(http, $"{AgentTls.PairBodyTooLarge} (上限 {AgentTls.PairBodyLimit} バイト)", 413);
                return;
            }
            var result = tls.Pair(peer, body);
            if (result.Proof is { } proof) await Respond.Write(http, new JsonObject { ["proof"] = proof });
            else await Respond.Error(http, result.Error!, result.Status);
            return;
        default:
            // paired: false は denpa が「組み直せば通る」と見分ける印 (文言は変わりうるので見ない。agent-client.ts)
            await Respond.Write(http, new JsonObject { ["error"] = AgentTls.NotPaired, ["paired"] = false }, 403);
            return;
    }
});

// --- 選局。**エージェントの中心の API** ---------------------------------------
app.MapGet("/denpa/stream", async (HttpContext http) =>
{
    var query = http.Request.Query;
    var type = query["type"].ToString();
    var channel = query["channel"].ToString();
    if (type.Length == 0 || channel.Length == 0)
    {
        await Respond.Error(http, "type と channel が必要です", 400);
        return;
    }
    _ = int.TryParse(query["priority"].ToString(), out var priority);
    var use = query["use"].ToString() is { Length: > 0 } named ? named : "不明";
    // 引き継ぎ。この利用者たちは、もう離れたものとして選ぶ (TunerPool.Open。何度でも書ける)
    var after = query["after"].Where(value => !string.IsNullOrEmpty(value)).Select(value => value!).ToHashSet();
    // デバッグ用の名指し。指定のデバイスのチューナーだけで選局する (TunerPool.Open の pin)
    var pin = query["tuner"].ToString() is { Length: > 0 } pinned ? pinned : null;
    // 観る局 (program_number)。先頭で溜めるのをやめる前に、この局の PMT と ECM の答えだけをそろえる (Sink.Service)。無ければ全部の局を待つ
    int? service = null;
    if (query["service"].ToString() is { Length: > 0 } numbered)
    {
        if (!int.TryParse(numbered, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) || number is < 1 or > 0xFFFF)
        {
            await Respond.Error(http, "service は 1〜65535 の番組番号です", 400);
            return;
        }
        service = number;
    }

    Sink sink;
    try
    {
        sink = pool.Open(type, channel, priority, use, after, pin, service);
    }
    catch (TunerPool.TunerPinException error)
    {
        // 指定のチューナーが無い・無効・その種別を受けられない。ほかへ振り替えないので 400 で理由を返す
        await Respond.Error(http, error.Message, 400);
        return;
    }
    catch (TunerPool.TunerBusyException error)
    {
        // チューナーを確保できなかった。**409 で返す**ので、呼んだ側は待って掛け直せる
        await Respond.Error(http, error.Message, 409);
        return;
    }
    catch (Exception error)
    {
        /*
         * 確保できたが選局できなかった (同期しない・デバイスが開けない…)。
         * **理由を必ず残す。** 空の 500 を返していたせいで、総当たりの
         * スキャンが「選局できません (500)」としか返せず、何が起きているのか
         * 分からなかった (docs/agent.md)
         */
        Log.Write($"{type} {channel} ({use}): {error.Message}");
        await Respond.Error(http, error.Message, 500);
        return;
    }

    // 溜めない。数パケット届いたらそのまま流す (64KB 貯めると 25ms 積み上がる)
    http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

    /*
     * 1 バイトでも送ったか。**送る前に落ちたなら、まだ理由を返せる。**
     *
     * 落ちた回をどれも接続を壊して知らせていた頃は、選局が始まった直後に
     * 落ちると**本文どころか状態行すら送っていない**のに接続だけ切れていて、
     * 呼んだ側には `socket connection was closed unexpectedly` としか届かず、
     * 電波なのか取り損ねなのか設定なのかが分からなかった。
     */
    var sent = false;

    try
    {
        await foreach (var chunk in sink.Reader.ReadAllAsync(http.RequestAborted))
        {
            /*
             * **Content-Type と ISDB-C の TSMF の有効な TS の数は、最初の塊を書く前にヘッダーに入れる** (docs/agent.md「/denpa/stream」)。
             * レスポンスヘッダーは最初に書いたときに送られ、塊が届くのは選局と TSMF の判定が終わってから。
             * 選局の途中で共有に入った利用者は Open から先に戻るので、戻った時点ではまだ値が無いことがある。
             * TSMF から選んだ TS が分割 TLV なら、組み立てた TLV のバイト列を application/x-arib-tlv で流す (Sink.Format)
             */
            if (!sent)
            {
                http.Response.ContentType = sink.ContentType;
                if (sink.TsmfStreams is { } streams)
                    http.Response.Headers[Sink.TsmfStreamsHeader] = streams.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            await http.Response.Body.WriteAsync(chunk, http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);
            sink.Consumed(chunk.Length);
            sent = true;
        }

        /*
         * **チューナーを取り上げられたなら、正常終了として畳まない。**
         *
         * 送っている途中の本文をきれいに閉じると、読む側には「録り終えた」
         * ように届く。実際それで、チューナーを取り上げられた録画が尻切れのまま成功扱いに
         * なっていた (bun で書いていた頃は接続を壊せなかった)。Kestrel は壊せるので壊す
         */
        if (sink.FailedWith is not null)
        {
            Log.Write($"{channel} ({use}): {sink.FailedWith}");
            if (sent) http.Abort();
            /*
             * 送る前に取り上げられたなら **409** (空きが無いのと同じ。呼んだ側は待って掛け直せる)。
             * 500 は選局できなかったときだけにする。denpa は 500 を「受信できない」の記録に数える (reception.ts)
             */
            else await Respond.Error(http, sink.FailedWith, TunerPool.IsPreempted(sink.FailedWith) ? 409 : 500);
        }
    }
    catch (OperationCanceledException)
    {
        // 読む側が去った。普通の終わり方
    }
    finally
    {
        sink.Leave();
    }
});

// --- 通知 (SSE) -----------------------------------------------------------

// 通知が無い間に流すコメントの間隔。denpa の fetch が何も届かない接続を切る 5 分より十分短く
var eventsKeepAlive = TimeSpan.FromSeconds(30);
app.MapGet("/denpa/events", async (HttpContext http) =>
{
    http.Response.ContentType = "text/event-stream";
    http.Response.Headers.CacheControl = "no-cache";
    http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

    var queue = events.Subscribe();
    try
    {
        /*
         * **繋がった時点でヘッダを送り、通知が無い間もコメント行を流す。**
         *
         * 何も書かないうちはヘッダも出ないので、購読した側は最初の通知が
         * 来るまで「応答待ち」のまま。denpa (Bun の fetch) は何も届かない接続を
         * 5 分で切るので、深夜など選局の動きが 5 分止まると、切れる → 繋ぎ直しても
         * 応答が来ない → 「チューナーに繋がりません」と出る、を繰り返していた
         * (実機の Slack で 1 時間おきに鳴った)。SSE のコメント (`:` で始まる行) は
         * 受け手が読み飛ばすものなので、それで接続が続いていることを伝える
         */
        /*
         * **止まるときはこちらから閉じる。** Kestrel は開いている応答が終わるのを 30 秒 (既定の ShutdownTimeout)
         * 待ってから止まり、その間は待ち受けだけ閉じている。denpa は通知を開きっぱなしにするので、録画が無いときの
         * 入れ替えでも古い Pod が 30 秒残り、その間に始まった録画の先頭が欠けていた (実機で約 35 秒。下の Drain)
         */
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted, app.Lifetime.ApplicationStopping);
        var ct = stopping.Token;
        await http.Response.Body.FlushAsync(ct);
        Task<string>? pending = null;
        // 待つ時計は済むまで使い回す (通知のたびに作ると、済んでいない Delay が通知の数だけ残る)
        Task? keepAlive = null;
        while (true)
        {
            pending ??= queue.Reader.ReadAsync(ct).AsTask();
            keepAlive ??= Task.Delay(eventsKeepAlive, ct);
            var heard = await Task.WhenAny(pending, keepAlive) == pending;
            var block = heard ? await pending : ": keep-alive\n\n";
            if (heard) pending = null;
            else keepAlive = null;
            await http.Response.WriteAsync(block, ct);
            await http.Response.Body.FlushAsync(ct);
        }
    }
    catch (OperationCanceledException)
    {
        // 購読者が去った
    }
    finally
    {
        events.Unsubscribe(queue);
    }
});

// --- チューナーとチャンネル -----------------------------------------------
JsonObject TunerList() => new() { ["tuners"] = pool.Status(), ["detected"] = pool.Detected };
app.MapGet("/denpa/tuners", (HttpContext http) => Respond.Write(http, TunerList()));

/*
 * 機材の定義を書き換える。**画面から。**
 *
 * 受け取るのはデバイスと種別と LNB だけで、選局コマンドは受け取らない (TunerSpec)。
 * 空を渡すと定義そのものを消す = **自動検出に戻す**。
 */
app.MapPut("/denpa/tuners", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (body?["tuners"] is not JsonArray list)
    {
        await Respond.Error(http, "tuners が必要です", 400);
        return;
    }

    List<TunerSpec?> next;
    try
    {
        next = [.. list.Select(TunerSpec.FromJson)];
    }
    catch (FormatException error)
    {
        await Respond.Error(http, error.Message, 400);
        return;
    }

    if (next.Contains(null))
    {
        await Respond.Error(http, "name の無いチューナーがあります", 400);
        return;
    }

    // 入れ替えは選局と読み出しが止まるのを待つ (十数秒かかることがある) ので、要求のスレッドを塞がない
    await Task.Run(() =>
    {
        lock (tunersGate) ApplyTuners([.. next.OfType<TunerSpec>()]);
    });
    // 新しく書かれた筐体があれば asicend を起動する。数秒かかるので応答は待たせない
    _ = Task.Run(PrepareDaemons);
    await Respond.Write(http, TunerList());
});

app.MapGet("/denpa/channels", (HttpContext http) => Respond.Write(http, config.LoadChannels()));

/*
 * スキャンの結果を預かる。**書いてくるのは denpa** (Config.cs)。
 */
app.MapPut("/denpa/channels", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (body?["channels"] is not JsonArray found || body["scanned"] is not JsonArray scanned
        || scanned.Count == 0)
    {
        await Respond.Error(http, "channels と scanned が必要です", 400);
        return;
    }
    // 1 件も無いまま上書きすると、今まで録れていた局まで消える
    // null の項目は保存のときに落ちるので数えない
    if (!found.OfType<JsonObject>().Any())
    {
        await Respond.Error(http, "チャンネルが 1 件もありません", 400);
        return;
    }

    // 文字列でない値は、読むところ (ここと Config.SaveChannels) で例外になり 500 になるので先に断る
    if (!scanned.All(node => Respond.IsText(node))
        || !found.All(entry => entry is null || (entry is JsonObject item && Respond.IsText(item["type"]) && Respond.IsText(item["channel"]))))
    {
        await Respond.Error(http, "scanned と、channels の type・channel は文字列で書きます", 400);
        return;
    }
    var types = scanned.Select(node => node?.GetValue<string>() ?? "").ToHashSet();
    var merged = config.SaveChannels(found, types);
    Log.Write($"チャンネルを保存しました: {found.OfType<JsonObject>().Count()} 件 ({string.Join(", ", types)})");
    /*
     * 局が入れ替わった。denpa は**これを合図に取り込み直す。**
     * こちらは何も再起動しない (録画中のものも切れない)
     */
    events.Emit("channels");
    await Respond.Write(http, merged);
});

/*
 * 1 つの種別のチャンネルを全部消す (`?type=CATV`)。**呼ぶのは denpa の設定の画面だけ。**
 * 種別は問わない。チューナーが挿さったまま回線だけが無くなった (引っ越してケーブルが無くなったなど) 種別は、スキャンし直しても消えないため。
 * PUT は 1 件も無い結果を断る (スキャンで何も見つからなかったときに消さない) ので、消すのはこちらに分ける
 */
app.MapDelete("/denpa/channels", async (HttpContext http) =>
{
    var type = http.Request.Query["type"].ToString();
    if (type.Length == 0)
    {
        await Respond.Error(http, "type が必要です", 400);
        return;
    }
    var merged = config.SaveChannels([], [type]);
    Log.Write($"チャンネルを消しました ({type})");
    events.Emit("channels");
    await Respond.Write(http, merged);
});

// --- カードとスクランブルの復号 -------------------------------------------
/*
 * 鍵を配る API (/denpa/card/init・/denpa/card/ecm・/denpa/card/emm と、バイト列で受ける /denpa/card/confirm) は、
 * このポートには無い (CardShareServer.cs)。ここの /denpa/card/confirm は自分の denpa が JSON で呼ぶもの
 */
app.MapGet("/denpa/card", async (HttpContext http) =>
{
    var status = await Task.Run(() => Card.Status(pool.Descrambling));
    await Respond.Write(http, status);
});

/*
 * 使わないカードリーダーを入れ替える。**画面のカードリーダーの表のスイッチから。**
 * 受け取るのは使わないリーダーの名前の一覧 (disabled)。画面は挿さっているリーダーしか並べないので、
 * **挿さっていないリーダーの「使わない」は残す** (抜いて挿し直したら勝手に使い始めない)。
 * 使っている最中のリーダーなら手放して次のリーダーで繋ぎ直し、
 * PIX-DT295・CECH-ZD1 J の差し込み口なら、チューナーも使っていなければ USB を閉じる
 */
app.MapPut("/denpa/card/readers", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (body?["disabled"] is not JsonArray list || !list.All(node => Respond.IsText(node)))
    {
        await Respond.Error(http, "disabled は文字列の配列で書きます", 400);
        return;
    }
    var present = await Task.Run(CardLinks.All);
    CardChoice.Save(list.Select(node => node!.GetValue<string>()), present.Select(candidate => candidate.Name).ToHashSet());
    var disabled = CardChoice.Disabled;
    await Task.Run(() =>
    {
        Keys.Local.Release(disabled);
        // チューナーとして使っている機材は開いたまま (チューナーが閉じるときに閉じる)
        // CECH-ZD1 J が設定に 1 台だけなら、チューナーは挿し替えた先のポートを開いている (TunerPool.Acquire と同じく Zd1j.Follow で求める)
        var follow = pool.Tuners.Count(spec => Zd1j.Is(spec.Device)) == 1;
        var used = pool.Tuners.Where(spec => !spec.Disabled && spec.Device is not null)
            .Select(spec => follow && Zd1j.Parse(spec.Device!) is { } configured ? $"{Zd1j.Scheme}{Zd1j.Follow(configured)}" : spec.Device!)
            .ToHashSet();
        foreach (var candidate in present.Where(candidate => disabled.Contains(candidate.Name)))
        {
            if (candidate.Device is not { } device || used.Contains(device)) continue;
            if (Dt295.Parse(device) is { } dt295) Dt295NativeDevice.CloseIfIdle(dt295);
            else if (Zd1j.Parse(device) is { } zd1j) Zd1jBoard.CloseIfIdle(zd1j);
        }
    });
    await Respond.Write(http, new JsonObject { ["disabled"] = Json.Strings(disabled.Order(StringComparer.Ordinal)) });
});

/*
 * 有料放送の契約をカードに問い合わせる (契約確認。0x90 0x3C)。EIT の CA 契約情報記述子 (0xCB) にある verification (Base64) と、
 * 問い合わせる日 (date。MJD) を渡すと、カードの返り値 (0x0800 なら月額の契約あり など) を返す。選局は要らない (denpa の contracts.ts)
 */
app.MapPost("/denpa/card/confirm", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    byte[]? verification = null;
    try
    {
        if (body?["verification"] is { } node && Respond.IsText(node)) verification = Convert.FromBase64String(node.GetValue<string>());
    }
    catch (FormatException)
    {
    }
    var date = body?["date"] is JsonValue value && value.TryGetValue<int>(out var mjd) ? mjd : -1;
    if (verification is not { Length: >= 1 and <= CardWire.MaxVerification } || date is < 0 or > 65535)
    {
        await Respond.Error(http, "verification (Base64 で 1〜253 バイト) と date (MJD) が必要です", 400);
        return;
    }
    try
    {
        var code = await Task.Run(() => Keys.Source.Confirm(verification, (ushort)date));
        await Respond.Write(http, new JsonObject { ["ok"] = true, ["code"] = code });
    }
    catch (Exception error) when (error is IOException or InvalidOperationException or CardRefusedException)
    {
        await Respond.Error(http, error.Message, 500);
    }
});

app.MapPost("/denpa/decode", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (!Respond.IsText(body?["input"]) || !Respond.IsText(body?["output"]))
    {
        await Respond.Error(http, "input と output は文字列で書きます", 400);
        return;
    }
    // 数 GB を復号するので、要求のスレッドを塞がないよう別のスレッドで復号する (/denpa/card と同じ)
    var input = body?["input"]?.GetValue<string>();
    var output = body?["output"]?.GetValue<string>();
    var result = await Task.Run(() => Scramble.Decode(recorded, input, output));
    await Respond.Write(http, result, result["ok"]!.GetValue<bool>() ? 200 : 500);
});

/*
 * 元の TS の置き場が denpa と同じに見えているか (RawProbe.cs)。denpa が置き場の .denpa/ の下に書いた乱数のファイルの
 * SHA-256 を返す。エージェントが何台もあるとき、denpa が後から復号させる先を選ぶのに使う
 */
app.MapPost("/denpa/raw/probe", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    var path = body?["path"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    var (status, result) = await Task.Run(() => RawProbe.Hash(recorded, path));
    await Respond.Write(http, result, status);
});

// 組んだ denpa の登録を消す (denpa の設定でエージェントを削除したとき。AgentTls.Unpair)。ここへ来るのは組んだ相手だけ
app.MapDelete(AgentTls.PairPath, (HttpContext http) =>
{
    tls.Unpair(http.Connection.ClientCertificate is { } client ? AgentTls.FingerprintOf(client) : null);
    http.Response.StatusCode = 204;
    return Task.CompletedTask;
});

// --- 診断 -----------------------------------------------------------------
// 直近のログ。設定の「その他」の「ログ」が読む (Json.cs の Log)
app.MapGet("/denpa/logs", (HttpContext http) => Respond.Write(http, Log.Recent.ToJson()));
// エージェント自身のバージョン・OS・arch と、macOS なら CCID ドライバ (About.cs)。macOS では `defaults` を起動するので背景で
app.MapGet("/denpa/about", async (HttpContext http) => await Respond.Write(http, await Task.Run(About.ToJson)));

app.MapFallback((HttpContext http) =>
    Respond.Write(http, new JsonObject { ["ok"] = false, ["error"] = "not found" }, 404));

/*
 * **asicend は背景で起動する。** ready までファームウェアの流し込みで
 * 数秒、駄目な筐体なら 30 秒待つので、ここで待つと HTTP の API (= PT3 など他の
 * チューナーの提供) まで遅れる。筐体が無ければ何もしない。
 *
 * **手元のカードは起動したときに開いておく** (LocalCard.Warm)。最初の選局がカードを開くのを待たない。
 * 鍵を受け取る拠点 (CARD_URL) で配りもしないなら、手元のカードは使わない
 */
if (cardUrl is not { Length: > 0 } || sharing is not null) _ = Task.Run(Keys.Local.Warm);
_ = Task.Run(() =>
{
    AsicenUserland.LogVersion();
    PrepareDaemons();
});

/*
 * 機材の抜き差しを受け取ったら、定義に足す (Rescan。DeviceWatch.cs)。偽の選局で動かす適合テストでは受け取らない。
 * 先にいま挿さっている機材を控えてから受け取り始める (起動したときに挿さっていたものを、挿されたと数えない)
 */
DeviceWatch? watch = null;
if (tune.FakeTune is null)
{
    _ = Task.Run(() =>
    {
        lock (tunersGate) seen = [.. DeviceProbe.Detect().Select(tuner => tuner.Device)];
        Interlocked.Exchange(ref watch, new DeviceWatch(UsbHost.Current, Rescan));
        // 受け取り始める前に止まり始めていたら、ここで手放す
        if (app.Lifetime.ApplicationStopping.IsCancellationRequested) Interlocked.Exchange(ref watch, null)?.Dispose();
    });
}
// 止まり始めたら、抜き差しを受け取るのをやめる (選局を離したあとに Rescan が機材を開き直さないように)
app.Lifetime.ApplicationStopping.Register(() => Interlocked.Exchange(ref watch, null)?.Dispose());

/*
 * **選局を離すのは `ApplicationStopping` で。** これが来るのは `Drain` が録画を待ち終えてからなので、録画は切らない
 * (止まれの合図のその場で来ていた頃は、録画中のチューナーまで離していた。上の 30 分番組はこれ)。
 * ここで離さないと、番組表やライブの選局が残っている間 Kestrel が 30 秒待ち、そのぶん入れ替えの隙間が伸びる。
 * 離された選局は接続を壊して終わる (録り終えたようには見せない。/denpa/stream)
 */
app.Lifetime.ApplicationStopping.Register(pool.CloseAll);
/*
 * 機材を畳むのは、応答を流し終えてから (`ApplicationStopped` は Kestrel が止まったあとに来る)。
 * 止まり際に滑り込んだ選局もここで離す
 */
app.Lifetime.ApplicationStopped.Register(() =>
{
    pool.CloseAll();
    // CECH-ZD1 J はスリープさせて LED を緑に戻してから閉じる (カードのために開いていても)
    Zd1jBoard.CloseAll();
    // PIX-DT295 は書いた設定を戻してから閉じる (カードのために開いていても)
    Dt295NativeDevice.CloseAll();
    // IT930x の機材は受信機をスリープにし、電源を切ってから閉じる
    It930xDevice.CloseAll();
    // 利用者を全部離してから asicend を止める。SIGTERM で LNB を 0V に戻して終わる
    lock (daemonsGate) daemonsStopped = true;
    UserlandDaemon.StopAll();
});

Log.Write($"listening on https://{(host is null ? $"*:{port}" : new IPEndPoint(host, port).ToString())} (tuners: {config.TunersFile} / channels: {config.ChannelsFile})");
Log.Write($"証明書 {tls.Fingerprint[..16]}… / 組んだ denpa {tls.Clients.Count} 台 ({tls.Dir})");
/*
 * **組む URL は、組んだ相手がまだいないときだけ出す。** 標準出力にだけ書き、/denpa/logs には残さない
 * (あちらは組んだ denpa が読み、不具合報告に入る。合言葉を載せない)
 */
if (tls.Clients.Count == 0) Console.WriteLine($"[agent] denpa と組むときの URL: {tls.PairUrl(port)}");
if (sharing is not null)
{
    var limit = cardLan.MaxRoundTrip is { } max ? $"{max.TotalMilliseconds}ms まで" : "見ない";
    Log.Write($"鍵を :{sharing.Port} で配ります (相手: {string.Join(", ", cardLan.Networks)} / TTL {cardLan.Hops} / 往復時間: {limit})");
}
if (cardUrl is { Length: > 0 }) Log.Write($"鍵を {cardUrl} から受け取ります (TTL {cardLan.Hops})");
Log.Write($"チューナー {pool.Tuners.Count} 台 / チャンネル {config.LoadChannels().Count} 件");
await app.RunAsync();
return 0;

/// <summary>HTTP に JSON を書く / 読む。中身の作りは <see cref="Json"/></summary>
internal static class Respond
{
    public static async Task Write(HttpContext http, JsonNode? body, int status = 200)
    {
        http.Response.StatusCode = status;
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsync(body?.ToJsonString(Json.Compact) ?? "null");
    }

    public static Task Error(HttpContext http, string message, int status) =>
        Write(http, new JsonObject { ["error"] = message }, status);

    /// <summary>無いか文字列か (<c>GetValue&lt;string&gt;</c> で読んでも例外にならない)</summary>
    public static bool IsText(JsonNode? node) => node is null || (node is JsonValue value && value.TryGetValue<string>(out _));

    public static async Task<JsonNode?> Read(HttpContext http)
    {
        try
        {
            using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
            return JsonNode.Parse(await reader.ReadToEndAsync());
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// 止まれの合図を受けてから、**録画が終わるまで待つ**もの。
///
/// <para>
/// **合図をこちらで受け取る。** 既定の受け取り役 (ConsoleLifetime) に任せると、
/// その場でホストが畳みに入り、**Kestrel が開いている応答への書き込みを止める**
/// (実測: 合図の直後からバイトが 1 つも進まなくなる)。止めるかどうかを決める前に
/// 止まってしまうので、受け取り役ごと差し替える。
/// </para>
///
/// <para>
/// 待つのは録画だけ (<see cref="TunerPool.Recording"/>)。待ち終えたら
/// <c>StopApplication</c> を呼んで、いつもどおり畳ませる。**待っている間に 2 回目の合図が来たら、待たずに畳む**
/// (docs/agent.md「止められたら録画が終わるまで待つ」)。
/// </para>
///
/// <para>
/// **待っている間も、新しい選局は断らない** (denpa の scheduler.ts の「止められている最中でも始める」と同じ考え)。
/// <c>Recreate</c> なので新しい Pod はこちらが終わるまで立たず、断ってもその間に始まる録画の先頭が欠けるだけ。
/// 来た録画は録り終えるまで待つ (待ちは伸びるが <c>SHUTDOWN_WAIT</c> が歯止め)。ライブや番組表は受けるが
/// 待たず、録画が終われば一緒に切れる。**録画が無ければすぐ畳む。** 待っても入れ替えの隙間が伸びるだけ。
/// </para>
/// </summary>
internal sealed class Drain(TunerPool pool, long waitMs, IHostApplicationLifetime lifetime)
    : IHostLifetime, IDisposable
{
    private readonly List<PosixSignalRegistration> _signals = [];
    private int _stopping;

    /// <summary>待ち終えた (録画が終わった・上限を過ぎた・2 回目の合図が来た) ら済む</summary>
    private readonly TaskCompletionSource _waiting = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task WaitForStartAsync(CancellationToken token)
    {
        foreach (var signal in new[] { PosixSignal.SIGTERM, PosixSignal.SIGINT, PosixSignal.SIGQUIT })
        {
            _signals.Add(PosixSignalRegistration.Create(signal, Handle));
        }
        return Task.CompletedTask;
    }

    private void Handle(PosixSignalContext context)
    {
        // 既定ではその場で終了する。それを止め、畳むのはこちらから指示する
        context.Cancel = true;
        if (Interlocked.Exchange(ref _stopping, 1) == 0)
        {
            _ = Task.Run(WaitThenStop);
            return;
        }
        /*
         * **2 回目の合図で待つのをやめる。** 待っている間は 1 回目と同じく合図を受け流すので、これが無いと
         * 手で動かしているときの Ctrl+C も SIGTERM も効かず、SHUTDOWN_WAIT (既定 6 時間) まで止まらなかった。
         * 録画のストリームは切れる (denpa はエージェントがまた動いてから終了時刻まで録り続ける)
         */
        // 録画を待っていたときだけ記録に出す (待たずに畳んでいる途中の合図では出さない)
        if (_waiting.TrySetResult() && _holding) Log.Write("止まれの合図をもう一度受けたので、録画を待たずに畳みます");
    }

    /// <summary>録画が終わるのを待っている間だけ true</summary>
    private volatile bool _holding;

    private async Task WaitThenStop()
    {
        if (waitMs > 0 && pool.Recording)
        {
            _holding = true;
            Log.Write($"止まれの合図。録画が終わるまで待ちます (上限 {waitMs / 1000} 秒。もう一度合図を送ると待たずに畳みます)");
            var until = DateTime.UtcNow.AddMilliseconds(waitMs);
            while (pool.Recording && DateTime.UtcNow < until && !_waiting.Task.IsCompleted)
            {
                await Task.WhenAny(_waiting.Task, Task.Delay(1000));
            }
            if (!_waiting.Task.IsCompleted) Log.Write(pool.Recording ? "待つ上限を過ぎたので畳みます" : "録画が終わったので畳みます");
        }
        _waiting.TrySetResult();
        lifetime.StopApplication();
    }

    public Task StopAsync(CancellationToken token) => Task.CompletedTask;

    public void Dispose()
    {
        foreach (var registration in _signals) registration.Dispose();
    }
}
