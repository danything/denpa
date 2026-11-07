/**
 * 動かすときに決めるもの。
 *
 * **環境変数にするのは、外から差し替える理由があるものだけ。**
 * 相手の場所 (チューナーエージェント・ffmpeg・置き場) と、間隔やマージンのように
 * テストで詰めたいもの。それ以外はここに直に書く。**画面から変えたいものは設定画面** (settings.ts)。
 */

import { dirname, join } from "node:path";

import type { CmMode, VideoCodec } from "../types";

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

const SEC = 1000;
const MIN = 60 * SEC;

const dbPath = str("DENPA_DB", "/data/denpa.db");
/** DB の隣。運用でいちいち 2 つ指す意味が無い */
const dataDir = dirname(dbPath);
/**
 * 録画の置き場の親。元の TS (`raw`) とエンコードしたもの (`encoded`) をこの下に分けて置く。
 * 別のディスクに分けたいときだけ `RAW_DIR` / `ENCODED_DIR` で片方を差し替える。
 * エージェントも同じ変数で元の TS の置き場を決める (掛かったままの TS を後から復号するため)
 */
const mediaDir = str("MEDIA_DIR", "/media");

export const config = {
  /**
   * チューナーエージェントの場所。
   *
   * 選局もスクランブルの復号もチャンネルスキャンも、全部ここが窓口。
   * B-CAS カードのリーダーを使うのも向こう側。
   * 別 PC のチューナーを足すときは、その PC のエージェントを指す。
   * `https://<名前>:<ポート>#pair=<合言葉>` の形 (agent-client.ts)
   */
  agentUrl: str("TUNER_AGENT_URL", "https://tuner-agent:25252"),

  /**
   * チューナーの取り合いでの優先度。**大きいほうが勝つ。**
   *
   * **番号はこちらが全部決める。** 下限も、特別扱いされる値も無い
   * (エージェントは受け取った数の大小しか見ない)。
   *
   * 録画の優先度がいちばん高い。放送は二度と来ないので、ここだけは譲らせない。
   */
  priority: {
    recording: 10,
    /**
     * ライブ視聴。**録画にだけ譲る。**
     *
     * 画面の前で人が待っているので、番組表の取得にもロゴの取得にもスキャンにも譲らせる。
     * 録画からチューナーを取り上げないのは、そちらは**二度と録り直せない**ため。見ている最中に
     * 映像が止まるのは不便だが、録画が尻切れになるのは取り返しがつかない。
     */
    live: 9,
    /**
     * 人が押して待っている番組表の取得。**録画とライブ以外には譲らせる。**
     *
     * 入れたばかりで番組表が空のときに使う。普段の `epg` はスキャンにも
     * 譲るので、置いておくと何時間も埋まらないことがある
     */
    epgNow: 8,
    /** 人が押して待っている。番組表には譲らせるが、録画からは取り上げない (server/scan.ts が渡す) */
    scan: 5,
    /**
     * 衛星のロゴを積んだ中継 (当たり) を開いて、ダウンロードの期間中にカルーセルが流れてくるのを待つときと「いますぐ」。**番組表の取得 (`epg`) とふだんのロゴ (`logo`) にだけ勝つ**
     * (理由は `logo.carouselPriority`。持っていられるのは長くても `logoCarouselWait` まで)
     */
    carousel: 4,
    epg: 3,
    logo: 1,
  },

  dbPath,
  /** DB と並べて置くもの。局ロゴと CM 検出のために覚えたロゴ (`logos/`)、別の機械へ移すときの作業場所 (`transfer/`)、ニコニコとの連携の鍵 (`niconico.key`)、エージェントと組むための鍵と証明書 (`tls/`) */
  dataDir,
  /** 元の TS の置き場。エンコード後は (元の TS を残す設定でなければ) 消える作業領域 */
  rawDir: str("RAW_DIR", join(mediaDir, "raw")),
  /** エンコード済みの置き場。プレイヤーにはここのファイルを配る */
  encodedDir: str("ENCODED_DIR", join(mediaDir, "encoded")),

  ffmpeg: str("FFMPEG", "/usr/local/bin/ffmpeg"),
  /**
   * ブラウザで MPEG-2・AAC・Opus をデコードする WebAssembly の置き場 (変換せずに観るライブと録画・互換モードの音。docs/stream.md#放送そのままmpeg-2を送る)。
   * Dockerfile の `mpeg2wasm` 段が置き、Mac と Windows はインストーラが配布物の中を指す。**アプリの外にあるのは、開発の compose がソースを
   * /app に被せるため** (中に置くと隠れる)。無ければ放送そのままの経路は使えず、画面はエンコードしたものに戻る
   */
  mpeg2Dir: str("MPEG2_DIR", "/opt/denpa/mpeg2"),
  /**
   * データ放送と字幕を描く字 (Denpa Font) の置き場。Dockerfile の `denpa-font` 段が置く (`/api/font/` が配る)。
   * Mac と Windows はインストーラが配布物の中を指す。無ければ 404 を返し、画面は端末の字で描く
   */
  fontDir: str("FONT_DIR", "/usr/share/denpa-font"),
  /** 録ったあとのエンコードを同時に走らせる本数。**ジョブではなく ffmpeg の本数で数える** (コーデックごとに 1 本。`encode-slots.ts`) */
  encodeConcurrency: num("ENCODE_CONCURRENCY", 2),
  /** 先頭が壊れていて初期化に失敗したときに先頭を捨てて再試行する秒数 (enc.js 由来) */
  encodeRetrySeek: 0.2,
  /**
   * 1 つのエンコードを何回まで試すか。**毒ジョブでキューを止めないため。**
   *
   * プロセスごと落とすジョブ (メモリ超過など) は、再起動のたびに running→queued
   * へ戻され、id 順なので毎回先頭に来てキューを塞ぎ続ける。取り出すたびに
   * attempts を数えていて、ここを超えたら諦めて failed にし、後ろを進める。
   * 数えるのはジョブのやり直しだけで、1 回の実行の中の ffmpeg の起こし直し (GPU → ソフトウェア・先頭を捨てる再試行) は数えない
   */
  encodeMaxAttempts: num("ENCODE_MAX_ATTEMPTS", 5),
  ffprobe: str("FFPROBE", "/usr/local/bin/ffprobe"),
  /**
   * GPU のデバイスを探すパターン (最後の段に `*`)。当たったデバイスを全部試して、VA-API が
   * 初期化できたものでエンコードする (server/hwenc.ts)。Pod / コンテナに `/dev/dri` を
   * 渡していなければ 1 つも無いのが普通
   */
  hwDevices: str("HW_DEVICES", "/dev/dri/renderD*"),
  /**
   * Rockchip MPP (RK3588 / RK3588S のハードウェアエンコーダ) のデバイス。在れば h264_rkmpp・hevc_rkmpp を試す
   * (server/hwenc.ts)。BSP カーネルでないと無い。ffmpeg (MPP) は決まった場所を自分で開くので、
   * ここを変えても ffmpeg が開く場所は変わらない。変えるのはテスト (偽のデバイス) だけ
   */
  rkmppDevice: str("RKMPP_DEVICE", "/dev/mpp_service"),
  /**
   * NVIDIA の GPU のデバイスファイル (`nvidia0`・`nvidia1` …) を探すフォルダ。在れば NVENC を試す
   * (server/hwenc.ts)。ffmpeg は GPU をデバイスファイルではなく番号 (`-gpu N`) で受けるので、
   * ここを変えても ffmpeg が使う GPU は変わらない。変えるのはテスト (偽のデバイス) だけ
   */
  nvidiaDir: str("NVIDIA_DIR", "/dev"),
  /** GPU の試しのエンコード 1 本に待つ上限 (ms)。ドライバが固まっても起動が止まらないように */
  hwProbeTimeout: num("HW_PROBE_TIMEOUT", 20000),

  /** 録画エンコードの初期コーデック。設定画面で変えられる */
  encodeCodec: "av1" as VideoCodec,
  /** CM の扱いの初期値。実カットは検出を誤ると本編が消えるのでチャプターのみ */
  cmCutDefault: "chapter" as CmMode,

  /** CM 検出のために覚えた局ロゴ (`own-logo-*.bin`) の置き場。放送波から取得した局ロゴ (PNG) の隣 */
  cmLogoDir: `${dataDir}/logos/cm`,
  /** CM 検出でロゴの区間をならすときの fps。ffprobe で取れなければこれを使う (地上波・BS は 30000/1001) */
  cmFallbackFps: 30000 / 1001,
  /** CM 検出のために別に回す ffmpeg (ロゴを覚える・読み直す・CM 検出だけやり直す) 1 回の上限時間(ms)。エンコードする ffmpeg で一緒に行う読み込みには掛けない */
  cmDetectTimeout: 30 * MIN,
  /**
   * CM を実際に切るとき、境目にキーフレームが無ければ CM 側へ寄せてよい長さ(秒) (`cm-cut.planCut`)。
   * 寄せたぶん CM の端が残るが、本編を削るよりはいい。これでも届かなければ境目を指して再エンコードする
   */
  cmCutMargin: num("CM_CUT_MARGIN", 0.8),

  /**
   * サムネイルを切り出す位置(秒)。冒頭は提供表示や CM のことが多いので少し進める。
   * CM 検出が効いているときは、この秒数を**本編の最初の区間の先頭からの**位置として使う
   */
  thumbnailPosition: 120,
  thumbnailWidth: 480,

  /**
   * データ放送の双方向 (bml-network) で名前を引く DNS。**家の DNS フィルタを迂回する。**
   *
   * 広告ブロッカー (AdGuard/Pi-hole 等) は局の双方向ドメインをブラックホール
   * (0.0.0.0 / ::) に落とすことがある。実測で `view.fujitv.co.jp` と
   * `recv-entry.tbs.co.jp` がそうなり、SSRF 防御が「内側のアドレス」として正しく
   * 断った結果、データ放送が NAP エラーになっていた。放送アプリの通信だけ
   * ここで引く。空にすると OS の DNS をそのまま使う
   */
  bmlDns: str("BML_DNS", "1.1.1.1,8.8.8.8"),

  /**
   * 動いているバージョン (`v1.8.1` の形式)。**リリースのイメージと、Mac・Windows のインストーラが書く起動スクリプトにだけ入る。**
   * イメージはリリースのとき、main で組んだものに 1 層足す (.github/release.Dockerfile)。main (develop) の
   * イメージと手元・テストは `dev` で、そのときは新しいバージョンの通知を出さない (update.ts)
   */
  version: str("DENPA_VERSION", "dev"),
  /** 新しいバージョンを見に行く先。GitHub の API (`releases/latest`)。テストでは偽物を指す */
  githubApi: str(
    "DENPA_GITHUB_API",
    "https://api.github.com/repos/danything/denpa",
  ).replace(/\/+$/, ""),
  /**
   * ニコニコの OAuth を中継する denpa-hub (danything/denpa-hub)。連携の入口、トークンの更新、公式の実況の接続先の受け取りに使う (niconico.ts・niconico-live.ts)。
   * テストでは偽物を指す
   */
  hubUrl: str("DENPA_HUB", "https://dh.doany.io").replace(/\/+$/, ""),
  /** 新しいバージョンを見に行く間隔 (ms)。認証なしの GitHub API は 1 時間に 60 回まで */
  updateCheckInterval: num("UPDATE_CHECK_INTERVAL", 60 * MIN),

  /** 録画の前後マージン(ms)。放送時刻のズレを吸収する */
  startMargin: num("START_MARGIN", 10 * SEC),
  endMargin: num("END_MARGIN", 15 * SEC),

  /**
   * 番組表を集めに行く間隔。**この周期で「集め直すべき局」を選び直す。**
   *
   * チューナーが空いていれば空いているだけ並列に回すので、周期を短くしても
   * 取り合いにはならない
   */
  epgCollectInterval: num("EPG_COLLECT_INTERVAL", 30 * MIN),
  /** 同じチャンネルを集め直すまでの間。番組表は当日ぶんが直前まで書き換わる */
  epgChannelInterval: num("EPG_CHANNEL_INTERVAL", 6 * 60 * MIN),
  /**
   * 集めに行った直後は、どれだけ薄く見えても行き直さない下限。EIT が 1 件も来ない
   * CS の局を 30 分ごとに選び続けないため。**使えなかった回は数えない**
   * (`collectChannel`)。経緯は docs/data.md
   */
  epgChannelRetry: num("EPG_CHANNEL_RETRY", 2 * 60 * MIN),
  /**
   * 1 チャンネルを開いておく上限。
   *
   * EIT は「自分がどこまであるか」をセクションの中で言っているので、普通は
   * 揃った時点で閉じる (`packages/arib/src/eit.ts` の ScheduleProgress)。ここまで待つのは
   * 電波が弱くて欠けが埋まらないときだけ。
   *
   * **5 分では足りない。** 先の日ぶんのセクションは流れてくる間隔が長いので、5 分の間に
   * 一度も回ってこないことがある
   */
  epgChannelTimeout: num("EPG_CHANNEL_TIMEOUT", 10 * MIN),
  /**
   * 衛星の全局ぶんを 1 中継で読むとき (BS の初回と CS。`epg-collect.firstSweeps`・`networkSweeps`)、
   * **新しい局が出てこなくなってからこれだけ待って**閉じる。局ごとに
   * 流れてくる順はばらばらで、見かけた局が揃っただけでは来ていない局を置いていく
   */
  epgSweepSettle: num("EPG_SWEEP_SETTLE", MIN),
  /**
   * 番組表がこの先まで埋まっていない局は、周期を待たずに集め直す。
   *
   * スキャンの直後や初回起動では全部が空なので、ここで先に埋まる
   */
  epgMinCoverage: num("EPG_MIN_COVERAGE", 3 * 24 * 60 * MIN),
  /**
   * 条件から外れた予約を引っ込めなくなる、放送開始までの余裕 (番組表は直前まで
   * 書き換わるので、余分に録るほうが安い)。**ルールごと消された/止められたぶんには
   * 効かない** (`rules.applyRules`)。経緯は docs/data.md
   */
  ruleRetractGrace: num("RULE_RETRACT_GRACE", 60 * MIN),
  /** 局の一覧をエージェントから取り直す間隔。スキャンの結果はここで届く */
  channelSyncInterval: num("CHANNEL_SYNC_INTERVAL", 1 * MIN),
  /**
   * 続けて見かけなかった局の持ち物 (番組表・まだ始めていない予約) を片付けるまでの間。
   * **1 回見かけなかっただけでは片付けない** (欠けた一覧で現役の予約が 44 件消えた。
   * `epg.forgetMissing`、docs/data.md)
   */
  serviceForgetAfter: num("SERVICE_FORGET_AFTER", 30 * MIN),
  /**
   * 止められたとき、録画が終わるまで待つ上限。
   *
   * 0 で待たずに止まる。**Kubernetes の terminationGracePeriodSeconds・
   * docker compose の stop_grace_period・Mac の plist の ExitTimeOut (install.sh) をこれ以上にしておくこと** (runtime.ts)
   */
  shutdownWait: num("SHUTDOWN_WAIT", 6 * 60 * MIN),
  schedulerTick: num("SCHEDULER_TICK", 5 * SEC),
  /** 保存先の実体と DB を突き合わせる間隔。外から消されたものをここで見つける */
  reconcileInterval: num("RECONCILE_INTERVAL", 5 * MIN),
  /**
   * ディスク残量がこれを下回ったら知らせる (バイト)。**録画が全部失敗して初めて
   * 気付く**のを防ぐ。録画 1 本は数百 MB〜数 GB なので、既定は数本ぶんの余裕がある 20GB。
   * 照合と同じ周期で見る (disk.ts)。0 にすると監視しない
   */
  diskLowThreshold: num("DISK_LOW_THRESHOLD", 20 * 1024 * 1024 * 1024),
  /**
   * チューナー(エージェント)に繋がらない状態がこれだけ続いたら知らせる。
   * 一瞬の切れ (デプロイ・つなぎ直し) で鳴らさないための猶予 (agent-events.ts)
   */
  agentDownGrace: num("AGENT_DOWN_GRACE", 3 * MIN),
  /**
   * 局ロゴの定期チェックの間隔。**ほかの選局を共有する** (`logo.sweep`)。自分で開くのは、衛星のロゴが足りない間に
   * 衛星のチューナーが空いているときに、当たりの中継で待つ (分からなければ探す。`logo.awaitCarousel`)。
   * 開いた瞬間の通知 (`tuners`) でも共有するので、これは通知を取りこぼしたときの保険
   */
  logoSweepInterval: 10 * MIN,
  /**
   * 衛星の当たりの中継を開いておく上限。**地上波よりずっと長い。** カルーセルはダウンロードの期間中だけ、20 分以内の間隔で
   * まとまって来る (ARIB TR-B15。実測は docs/logo.md「衛星はダウンロードの期間にだけ流れてくる」)。一度当たれば BS と CS の全局が
   * まとめて手に入り、外れの中継は PAT を見た時点 (1 秒ほど) で切り上げるので、待つのは当たりの 1 中継だけ (`logo.collect`)
   */
  logoCarouselWait: 20 * MIN,
  /** 終了した番組情報を DB に残しておく期間。番組表の遡り表示にしか使わないので短くてよい */
  programRetention: 24 * 60 * MIN,
  /**
   * 履歴を残しておく期間。終わった予約と、消した録画の行が対象。
   *
   * 「録れたか」を後から確かめるためのものなので、2 週間もあれば足りる。
   * 残し続けると一覧が伸びるだけで、探すのがかえって遅くなる。
   */
  historyRetention: 14 * 24 * 60 * MIN,

  /**
   * **OIDC でのログイン。** 3 つ揃ったときだけ有効になる。OIDC も
   * TRUSTED_NETWORKS も無ければ全部のアクセスを断る (auth.configured)。
   *
   * 秘密を含むので**環境変数だけ**から読み、設定画面には出さない。
   * 使い方は docs/auth.md
   */
  oidcIssuer: str("OIDC_ISSUER", "").replace(/\/+$/, ""),
  oidcClientId: str("OIDC_CLIENT_ID", ""),
  oidcClientSecret: str("OIDC_CLIENT_SECRET", ""),
  /**
   * **このグループにいる人だけ入れる。** Entra ID の `groups` クレーム
   * (既定ではグループのオブジェクト ID) か `roles` クレーム (アプリロール) と照合する (`oidc.allowed`)。
   *
   * 空にすると「入れた人は全員通す」。誰が入れるかを Entra 側の
   * アプリ割り当てで決めているなら、そちらで足りる
   */
  oidcGroup: str("OIDC_GROUP", ""),
  /**
   * **何も聞かずに通すネットワーク。** CIDR (IPv4・IPv6。アドレスそのままでも) のカンマ区切り
   * (`10.10.0.0/16`)。当たり、知っている名前 (下の `allowedHosts`) で来れば OIDC も掛からない
   * (どう効くかは `auth.trusted` と `auth.knownHost`)。
   *
   * **前段 (リバースプロキシ) があるなら `TRUSTED_PROXIES` に前段のアドレスを書く。**
   * 書かないと接続元が前段のアドレスになり、ここが誰にも当たらない (前段が同じネットワークに
   * いてここに当たると、前段越しの全員が通る)
   */
  trustedNetworks: str("TRUSTED_NETWORKS", ""),
  /**
   * 前段のアドレス。接続元を決めるのは入口の server.js で、そちらは自分で読む
   * (`address.resolveClient`)。アプリは起動時の警告 (`auth.warnIfProxyHidden`) にだけ使う
   */
  trustedProxies: str("TRUSTED_PROXIES", ""),
  /**
   * **信頼するネットワークから、ログインなしで開いてよい名前** (カンマ区切り)。
   * `.example.com` と書くと、その名前とその下の名前全部。IP の直書き・`localhost`・
   * ドットの無い名前・家の中だけの名前 (`.local` など) と `PWA_NAMES` の名前は書かなくても通る
   * (`auth.knownHost`)。外で引ける名前を LAN の IP に向けて使っているなら、ここに書く
   */
  allowedHosts: str("ALLOWED_HOSTS", ""),
  /**
   * adapter-bun が名前を読むヘッダ (既定は `Host`)。アプリは名前を確かめるときに、
   * `Host` に加えてこちらも見るのに使うだけ
   */
  hostHeader: str("HOST_HEADER", "").toLowerCase(),
  /** ログインしてからの有効期間。切れたらもう一度 OIDC でログインする */
  oidcSessionTtl: num("OIDC_SESSION_TTL", 30 * 24 * 60 * MIN),

  /**
   * **ホーム画面に置いたときの名前を、来た名前ごとに変える。**
   * 書き方は `ホスト名=表示名` のカンマ区切り
   * (`dp.l.doany.io=denpa 宅内`)。載っていない名前で来たら `denpa`。
   *
   * 同じ denpa を 2 つの名前で出していると、両方入れたときに**同じ名前の
   * アイコンが 2 つ並ぶ**。どちらが家の中から繋がるほうか分からない
   * (`manifest.ts`)。
   */
  pwaNames: str("PWA_NAMES", ""),

  /**
   * 0 にすると番組表の取得・スケジューラ・エンコーダなどのバックグラウンド処理を起動しない (単体テスト用)。
   * チューナーを使わないもの (GPU の確認・ライブのエンドポイント・異常終了した録画の回収・新しいバージョンの確認) は回す
   */
  autostart: bool("DENPA_AUTOSTART", true),
};

/** 外のサービス (ニコニコ・NX-Jikkyo・hub) に名乗る User-Agent */
export const userAgent = (): string =>
  `denpa/${config.version} (+https://github.com/danything/denpa)`;
