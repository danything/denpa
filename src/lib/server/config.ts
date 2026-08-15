/**
 * 動かすときに決めるもの。
 *
 * **環境変数にするのは、外から差し替える理由があるものだけ。**
 * 相手の居場所 (チューナーエージェント・ffmpeg・置き場) と、間隔やマージンのように
 * テストで詰めたいもの。それ以外はここに直に書く。
 *
 * 昔は検出のしきい値もサムネイルの大きさも環境変数にしていたが、
 * 誰も触らないのに「触れる」ぶん、既定値がどこで決まっているのか
 * 追いにくくなるだけだった。**画面から変えたいものは設定画面** (settings.ts)。
 */

import type { CmMode, VideoCodec } from '../types';

function str(key: string, fallback: string): string {
    const v = process.env[key];
    return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    return v === '1' || v.toLowerCase() === 'true';
}

const SEC = 1000;
const MIN = 60 * SEC;

export const config = {
    /**
     * チューナーエージェントの居場所。
     *
     * 選局もスクランブル解除もチャンネルスキャンも、全部ここが窓口。
     * B-CASカードは pcscd 経由でしか読めず、その pcscd は向こう側にしか無い。
     * 別PCのチューナーを足すときは、そのPCのエージェントを指す
     */
    agentUrl: str('TUNER_AGENT_URL', 'http://tuner-agent:25252').replace(/\/+$/, ''),

    /**
     * チューナーの取り合いの強さ。**大きいほうが勝つ。**
     *
     * **番号はこちらが全部決める。** 下限も、特別扱いされる値も無い
     * (エージェントは受け取った数の大小しか見ない)。
     *
     * 録画がいちばん強い。放送は二度と来ないので、ここだけは譲らせない。
     */
    priority: {
        recording: 10,
        /**
         * ライブ視聴。**録画にだけ譲る。**
         *
         * 画面の前で人が待っているので、番組表集めもロゴ集めもスキャンも蹴る。
         * 録画を蹴らないのは、そちらは**二度と録り直せない**ため — 見ている最中に
         * 映像が止まるのは不便だが、録画が尻切れになるのは取り返しがつかない。
         */
        live: 9,
        /**
         * 人が押して待っている番組表集め。**録画以外は全部蹴る。**
         *
         * 入れたばかりで番組表が空のときに使う。普段の `epg` はスキャンにも
         * 譲るので、置いておくと何時間も埋まらないことがある
         */
        epgNow: 8,
        /** 人が押して待っている。番組表には譲らせるが、録画は蹴らない (agent/scan.ts と揃える) */
        scan: 5,
        epg: 3,
        logo: 1,
    },

    dbPath: str('DENPA_DB', '/app/data/denpa.db'),
    /** DBと並べて置くもの。局ロゴと、jls が作るロゴデータ */
    dataDir: '',
    /** 生TSの置き場。エンコード後は(keep_original でなければ)消える作業領域 */
    recordedDir: str('RECORDED_DIR', '/app/recorded'),
    /** エンコード済みの置き場。プレイヤーにはここのファイルを配る */
    libraryDir: str('LIBRARY_DIR', '/library'),

    ffmpeg: str('FFMPEG', '/usr/local/bin/ffmpeg'),
    encodeConcurrency: num('ENCODE_CONCURRENCY', 1),
    /** 先頭が壊れていて初期化に失敗したときに頭を捨てて再試行する秒数 (enc.js 由来) */
    encodeRetrySeek: 0.2,
    /**
     * 1つのエンコードを何回まで試すか。**毒ジョブでキューを止めないため。**
     *
     * プロセスごと落とすジョブ (メモリ超過など) は、再起動のたびに running→queued
     * へ戻され、同時実行1・id順だと毎回先頭に来て永久にキューを塞ぐ。掴むたびに
     * attempts を数えていて、ここを超えたら諦めて failed にし、後ろを進める
     */
    encodeMaxAttempts: num('ENCODE_MAX_ATTEMPTS', 5),
    ffprobe: str('FFPROBE', '/usr/local/bin/ffprobe'),
    /**
     * GPU の口を探す形 (最後の段に `*`)。当たった口を全部試して、QSV / VA-API が
     * 初期化できたもので焼く (server/hwenc.ts)。Pod / コンテナに `/dev/dri` を
     * 渡していなければ1つも無いのが普通
     */
    hwDevices: str('HW_DEVICES', '/dev/dri/renderD*'),
    /** GPU の試し焼き1本に待つ上限 (ms)。ドライバが固まっても起動が止まらないように */
    hwProbeTimeout: num('HW_PROBE_TIMEOUT', 20000),

    /** 録画エンコードの初期コーデック。設定画面で変えられる */
    encodeCodec: 'av1' as VideoCodec,
    /** CMの扱いの初期値。実カットは事故ると本編が消えるのでチャプターのみ */
    cmCutDefault: 'chapter' as CmMode,

    /**
     * CM検出のロゴを覚えに行く間隔。**録画より先に覚えておくため** (logo-learn.ts)。
     *
     * 覚えるのは局ごとに1回きりなので、頻繁に見回る意味はない。空いている
     * チューナーがあるときだけ動く
     */
    logoLearnInterval: 30 * MIN,

    /** chapter_exe / logoframe / join_logo_scp の置き場。イメージに入っている */
    jlsBin: '/opt/jls/bin',
    /** join_logo_scp の判定規則。join_logo_scp_trial に付いてくるもの */
    jlsRule: '/opt/jls/JL/JL_標準.txt',
    /** logoframe が作るロゴデータ (.lgd) の置き場。データ置き場の下 */
    jlsLogoDir: '',
    /** ロゴを覚えるときに見るコマ数。増やすほど綺麗に出るが、その分だけ読む */
    jlsLogoSamples: 600,
    /**
     * 「ずっと同じ縁がある」と認める強さ。**logoframe の既定のまま。**
     *
     * 一度 60 まで上げたが、**実機の TOKYO MX が覚えられなくなった**。上げると
     * 探し当てる場所は正しくなる (`1244,62,136,44` = ロゴのある所) のに、
     * そこから作る推定が「有効な画素が少なすぎる」と弾かれる。MX のロゴは
     * 細い白文字なので、強い縁を要求すると画素が残らない。
     *
     * 既定 (40) で覚えたものを実際に見ると「TOKYO MX 1」がちゃんと写っていて、
     * 最後まで通すとCM判定も 20% と妥当だった。締める理由が無い
     */
    jlsLogoEdgeThreshold: 40,
    /**
     * 覚えているロゴの合致率がこれ(%)を下回ったら覚え直す。**既定のまま。**
     *
     * 「雑音を覚えたまま作り直されない」を心配して 50 にしていたが、実機で
     * 中身を出してみると雑音ではなかった (こちらが `.lgd` の幅と高さを逆に
     * 読んでいて、絵が転置されていただけ)。上げると、ロゴが出ない場面の多い
     * 番組で無用な作り直しを招く
     */
    jlsLogoMatch: 10,
    /**
     * join_logo_scp が番組の構成を推測するとき、**ロゴをどれだけ当てにするか**
     * (JL の `logo_level`。1:使わない 〜 8:最優先)。設定画面で変えられる。
     *
     * 付いてくる規則の既定のまま。実機では、logoframe が 79.74% の合致率で
     * 正しく5区間を出しているのに join_logo_scp が何も返さない録画があり、
     * 上げるとそこが拾える (ロゴを覚え違えている局では逆に下げる)
     */
    jlsLogoLevel: num('JLS_LOGO_LEVEL', 6),
    /** jls が返す Trim はフレーム番号なので、秒に直すためのfps。ffprobeで取れなければこれを使う */
    cmJlsFallbackFps: 30000 / 1001,
    /** 検出に掛ける上限時間(ms)。超えたら諦めてCM無しとして扱う */
    cmDetectTimeout: 30 * MIN,
    /** 無音とみなす音量。地上波のCM境界は -50dB 程度まで落ちる */
    cmSilenceNoise: '-50dB',
    /** 無音とみなす最短の長さ(秒)。短くしすぎると曲間や間(ま)を拾う */
    cmSilenceDuration: 0.4,
    /** 「15秒の倍数」判定の許容誤差(秒) */
    cmTolerance: 0.6,
    /** CMブロックとして採用する最短の長さ(秒)。単発15秒は本編のコーナーと紛らわしい */
    cmMinBlock: 30,
    /**
     * CMを実際に切るとき、残す区間の頭を戻しておく長さ(秒)。
     *
     * 切り出しはキーフレーム単位なので、指定どおりの位置から始めると本編の頭が
     * 1 GOP ぶん (地上波の MPEG-2 で 0.5 秒ほど) 削れる。地上波の GOP より
     * 長く取ってある。戻したぶん CM の尻が残るが、本編を削るよりはいい
     */
    cmCutMargin: num('CM_CUT_MARGIN', 0.8),

    /**
     * サムネイルを切り出す位置(秒)。頭は提供表示やCMのことが多いので少し進める。
     * CM検出が効いているときは、この秒数を**本編の最初の区間の頭からの**位置として使う
     */
    thumbnailPosition: 120,
    thumbnailWidth: 480,

    /**
     * データ放送の双方向 (bml-network) で名前を引く DNS。**家の DNS フィルタを迂回する。**
     *
     * 広告ブロッカー (AdGuard/Pi-hole 等) は局の双方向ドメインをブラックホール
     * (0.0.0.0 / ::) に落とすことがある — 実測で `view.fujitv.co.jp` と
     * `recv-entry.tbs.co.jp` がそうなり、SSRF 防御が「内側の住所」として正しく
     * 断った結果、データ放送が NAP エラーになっていた。放送アプリの通信だけ
     * ここで引く。空にすると OS の DNS をそのまま使う
     */
    bmlDns: str('BML_DNS', '1.1.1.1,8.8.8.8'),

    /**
     * 30コマとみなす生存率の上限 (encoder.pickSmooth)。
     *
     * 60p に起こして重複コマを落としたとき、これ以下しか残らなければ
     * 「同じ絵が並ぶ素材 (アニメ・フィルム)」= 30コマで出す。実録画の実測は
     * アニメ 21〜55% / 生放送 71% だった (docs/encode.md の表)。5窓の中央値で見る (encoder.FPS_POINTS)。**迷ったら 60 に
     * 倒れる**よう、間より低めに引いてある
     */
    fpsSurvive: num('FPS_SURVIVE', 0.45),

    /** 録画の前後マージン(ms)。放送時刻のズレを吸収する */
    startMargin: num('START_MARGIN', 10 * SEC),
    endMargin: num('END_MARGIN', 15 * SEC),

    /**
     * 放送の延長に追従する。
     *
     * 録画中のTSには EIT[p/f] (いま流れている番組) が乗っている。そこの終了時刻が
     * 後ろへ動いたら録画も延ばす。野球が延びればその分だけ録り続ける。
     *
     * 0 にすると番組表の時刻で開いて閉じる、前のやり方に戻る。
     */
    followOnair: true,

    /**
     * 番組表を集めに行く間隔。**この周期で「集め直すべき局」を選び直す。**
     *
     * チューナーが空いていれば空いているだけ並列に回すので、周期を短くしても
     * 取り合いにはならない
     */
    epgCollectInterval: num('EPG_COLLECT_INTERVAL', 30 * MIN),
    /** 同じチャンネルを集め直すまでの間。番組表は当日ぶんが直前まで書き換わる */
    epgChannelInterval: num('EPG_CHANNEL_INTERVAL', 6 * 60 * MIN),
    /**
     * 集めに行った直後は、どれだけ薄く見えても行き直さない下限。
     *
     * **番組表が埋まらない局のため。** 実機の CS には、開いても EIT が1件も
     * 来ないチャンネルが 4 つ (22局) ある。「薄いから行く」だけで選んでいた頃は
     * そこが 30 分ごとの周回で毎回選ばれ、1本ぶんの上限 (`epgChannelTimeout`)
     * まで開きっぱなしになっていた。空のまま帰ってきた局を少し休ませる。
     *
     * **掴めなかった回は数えない** (`collectChannel`)。録画に譲って開けなかった
     * だけの局まで休ませると、そのぶん番組表が古くなる
     */
    epgChannelRetry: num('EPG_CHANNEL_RETRY', 2 * 60 * MIN),
    /**
     * 1チャンネルを開いておく上限。
     *
     * EIT は「自分がどこまであるか」をセクションの中で言っているので、普通は
     * 揃った時点で閉じる (`ts/eit.ts` の ScheduleProgress)。ここまで待つのは
     * 電波が弱くて欠けが埋まらないときだけ。
     *
     * **5分では足りていなかった。** 揃ったと分かる仕組みが壊れていた頃は
     * どのチャンネルもここまで開きっぱなしで、しかも**先の日ほど題名が
     * 埋まらなかった** (実機の TBS1 は当日 20/21 に対し3〜5日後が 0/29・0/37・0/18)。
     * 先の日ぶんのセクションは流れてくる間隔が長いので、5分の間に一度も
     * 回ってこないことがある。揃えば早く閉じるようになったぶん、ここは伸ばす
     */
    epgChannelTimeout: num('EPG_CHANNEL_TIMEOUT', 10 * MIN),
    /**
     * 番組表がこの先まで埋まっていない局は、周期を待たずに集め直す。
     *
     * スキャンの直後や初回起動では全部が空なので、ここで先に埋まる
     */
    epgMinCoverage: num('EPG_MIN_COVERAGE', 3 * 24 * 60 * MIN),
    /**
     * 条件から外れた予約を引っ込めなくなる、放送開始までの余裕。
     *
     * 番組表は**放送直前まで書き換わる** (「[新]」が付く、サブタイトルが入る、
     * 誤字が直る)。その拍子にルールの条件から外れることがあり、そこで消すと
     * 録り逃す。余分に録るほうが手違いで消すより安いので、ここから内側は残す。
     *
     * **ルールごと消された/止められたぶんには効かない** (`rules.applyRules`)。
     * そちらは人が押した結果なので、直前でも引っ込める
     */
    ruleRetractGrace: num('RULE_RETRACT_GRACE', 60 * MIN),
    /** 局の一覧をエージェントから取り直す間隔。スキャンの結果はここで届く */
    channelSyncInterval: num('CHANNEL_SYNC_INTERVAL', 1 * MIN),
    /**
     * 続けて見かけなかった局の持ち物 (番組表・まだ始めていない予約) を片付けるまでの間。
     *
     * **1回見かけなかっただけでは片付けない。** エージェントから欠けた一覧が
     * 返ることがあり、実機ではそれで**現役の局の予約が44件まとめて取り消された**。
     * 一覧は1分ごとに取り直すので、ここまで見かけないなら本当に居ない
     * (`epg.forgetMissing`)
     */
    serviceForgetAfter: num('SERVICE_FORGET_AFTER', 30 * MIN),
    /**
     * 止められたとき、録画が終わるまで待つ上限。
     *
     * 0 で待たずに止まる。**Kubernetes の terminationGracePeriodSeconds と
     * docker compose の stop_grace_period をこれ以上にしておくこと** (runtime.ts)
     */
    shutdownWait: num('SHUTDOWN_WAIT', 6 * 60 * MIN),
    schedulerTick: num('SCHEDULER_TICK', 5 * SEC),
    /** 保存先の実体とDBを突き合わせる間隔。外から消されたものをここで拾う */
    reconcileInterval: num('RECONCILE_INTERVAL', 5 * MIN),
    /**
     * ディスク残量がこれを下回ったら知らせる (バイト)。**録画が全部失敗して初めて
     * 気付く**のを防ぐ。録画1本は数百MB〜数GBなので、既定は 20GB — 数本ぶんの余裕。
     * 照合と同じ周期で見る (disk.ts)。0 にすると監視しない
     */
    diskLowThreshold: num('DISK_LOW_THRESHOLD', 20 * 1024 * 1024 * 1024),
    /**
     * チューナー(エージェント)に繋がらない状態がこれだけ続いたら知らせる。
     * 一瞬の切れ (デプロイ・つなぎ直し) で鳴らさないための猶予 (agent-events.ts)
     */
    agentDownGrace: num('AGENT_DOWN_GRACE', 3 * MIN),
    /**
     * 局ロゴを取りに行く間隔。放送波に流れてくるのを待つので、急いでも取れない。
     * ただし1回に開けるのは数チャンネルなので、間隔が長いと BS/CS が埋まらない
     */
    logoSweepInterval: 10 * MIN,
    /** 終了した番組情報をDBに残しておく期間。番組表の遡り表示にしか使わないので短くてよい */
    programRetention: 24 * 60 * MIN,
    /**
     * 履歴を残しておく期間。終わった予約と、消した録画の行が対象。
     *
     * 「録れたか」を後から確かめるためのものなので、2週間もあれば足りる。
     * 残し続けると一覧が伸びるだけで、探すのがかえって遅くなる。
     */
    historyRetention: 14 * 24 * 60 * MIN,

    /**
     * **OIDC でのログイン。** 3つ揃ったときだけ有効になり、揃っていなければ
     * 全部のアクセスを断る (auth.configured)。
     *
     * 秘密を含むので**環境変数だけ**から読み、設定画面には出さない。
     * 使い方は docs/auth.md
     */
    oidcIssuer: str('OIDC_ISSUER', '').replace(/\/+$/, ''),
    oidcClientId: str('OIDC_CLIENT_ID', ''),
    oidcClientSecret: str('OIDC_CLIENT_SECRET', ''),
    /**
     * **このグループに居る人だけ入れる。** Entra ID の `groups` クレームに
     * 入っているもの (既定ではグループのオブジェクトID) と照合する。
     *
     * 空にすると「入れた人は全員通す」。誰が入れるかを Entra 側の
     * アプリ割り当てで決めているなら、そちらで足りる
     */
    oidcGroup: str('OIDC_GROUP', ''),
    /**
     * **何も聞かずに通すネットワーク。** CIDR (か住所そのまま) のカンマ区切り
     * (`10.10.0.0/16`)。当たると OIDC も掛からない
     * (どう効くかは `auth.trusted`)。
     *
     * **前段 (Traefik など) が居るなら `ADDRESS_HEADER=x-forwarded-for` を一緒に渡す。**
     * 渡さないと接続元が前段の住所になり、ここが誰にも当たらない。逆に、denpa へ
     * 直に届く経路があると住所を詐称できる。前段が居なければ何も要らない
     * (server.js の中継が本当の接続元を内側へ伝える)
     */
    trustedNetworks: str('TRUSTED_NETWORKS', ''),
    /** ログインしてからの有効期間。切れたらもう一度 Entra へ行く */
    oidcSessionTtl: num('OIDC_SESSION_TTL', 30 * 24 * 60 * MIN),

    /**
     * **ホーム画面に置いたときの名前を、来た名前ごとに変える。**
     * 書き方は `ホスト名=表示名` のカンマ区切り
     * (`dp.l.doany.io=denpa 宅内`)。載っていない名前で来たら `denpa`。
     *
     * 同じ denpa を2つの名前で出していると、両方入れたときに**同じ名前の
     * アイコンが2つ並ぶ**。どちらが家の中から繋がるほうか分からない
     * (`manifest.ts`)。
     */
    pwaNames: str('PWA_NAMES', ''),

    /** 0 にすると EPG 取得・スケジューラ・エンコーダを起動しない (単体テスト用) */
    autostart: bool('DENPA_AUTOSTART', true),
};

/** 指定が無ければDBの隣。運用でいちいち2つ指す意味が無い */
if (config.dataDir === '') config.dataDir = config.dbPath.replace(/\/[^/]*$/, '') || '.';
/** 局ロゴと同じ扱い。放送波から拾った PNG の隣に、jls 用の .lgd を置く */
if (config.jlsLogoDir === '') config.jlsLogoDir = `${config.dataDir}/logos/jls`;
