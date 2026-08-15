/** スキーマは TS の文字列として持つ。?raw インポートに頼らないので、
 * vite のビルド経由でも bun test の直接実行でも同じように読める。
 */
/**
 * 後から足した列。
 *
 * `CREATE TABLE IF NOT EXISTS` は既存のテーブルに列を足さないので、
 * スキーマに書くだけでは動いているDBには反映されない(実際に本番が500を返した)。
 * 列を足すときは SCHEMA と一緒にここへも書くこと。
 */
export const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
    { table: 'services', column: 'has_logo', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'rules', column: 'service_types', definition: 'TEXT' },
    // 焼き方 (cm_cut/codec/keep_original) はどのテーブルにも持たせない。焼くときに
    // settings を見る (db.dropStoredState が既存DBから落とす)。予約の encode だけ例外
    { table: 'recordings', column: 'cm_ranges', definition: 'TEXT' },
    { table: 'recordings', column: 'acknowledged_at', definition: 'INTEGER' },
    // もう一方のコーデックで焼いたもの (両方を選んだとき)。AV1 が主なら H.264 のほう
    { table: 'recordings', column: 'alt_path', definition: 'TEXT' },
    // 実際に録れた長さ。番組表の尺とは途中で止めた分だけずれる
    { table: 'recordings', column: 'duration_ms', definition: 'INTEGER' },
    // 番組詳細に出すためだけの情報。録画の判断には使わない
    { table: 'programs', column: 'video_type', definition: 'TEXT' },
    { table: 'programs', column: 'video_resolution', definition: 'TEXT' },
    { table: 'programs', column: 'audios', definition: 'TEXT' },
    { table: 'programs', column: 'genre_detail', definition: 'TEXT' },
    // 引き継ぎ元での識別子。二重に取り込まないための印
    { table: 'rules', column: 'source', definition: 'TEXT' },
    /*
     * キーワードを当てる範囲 (name / description / extended のカンマ区切り)。
     *
     * 既定値がスキーマ側 ('name') と違うのはわざと。この列が無かった頃のルールは
     * 「番組名+概要」で当てていたので、そのまま埋めないと黙って当たらなくなる。
     * 新しく作るルールの初期値は番組名だけ (画面側)
     */
    { table: 'rules', column: 'search_fields', definition: "TEXT NOT NULL DEFAULT 'name,description'" },
    // ARIB のサービス種別。1 がデジタルTV
    { table: 'services', column: 'service_type', definition: 'INTEGER NOT NULL DEFAULT 1' },
    /*
     * エンコードのどの段階か。'encode' 以外は ffmpeg が回る前の下ごしらえで、
     * 長いものだと数十分かかる。進み具合が出せないので、代わりに段階を出す
     */
    { table: 'encode_jobs', column: 'phase', definition: "TEXT NOT NULL DEFAULT 'encode'" },
    // 残り時間の見込み(ms)。ffmpeg の speed から出す
    { table: 'encode_jobs', column: 'eta_ms', definition: 'INTEGER' },
    /*
     * 局ロゴの位置 ("x,y,w,h")。CM検出を jls にしているときだけ使う。
     * 空なら logoframe が自分で探す。探せなかった局だけ画面から入れてもらう
     */
    { table: 'services', column: 'logo_area', definition: 'TEXT' },
    // CM検出が何をしたか。一覧には出さず、録画の詳細で見せる
    { table: 'recordings', column: 'cm_note', definition: 'TEXT' },
    /*
     * どこまで観たか (ms)。**続きから観るためだけの目印。**
     *
     * 端末に持たせず DB に置くのは、居間のタブレットで観たものを机の PC で
     * 続けられるようにするため。観終えたら消す (`api/recordings/<id>/resume`)
     */
    { table: 'recordings', column: 'resume_ms', definition: 'INTEGER' },
    /*
     * 番組のジャンル (JSON: lv1 の配列)。番組表から写しておく。
     *
     * 番組詳細のジャンル札に使う (コマ数の判断に使っていた頃の名残だが、番組表の
     * 行は24時間で消えるので、録画に写しがあること自体は今も要る)
     */
    { table: 'recordings', column: 'genre_detail', definition: 'TEXT' },
    /*
     * 焼いたもののコマ数 (30/60)。実測 (fpsDetect) か既定の60。NULL は未エンコード。
     * 番組詳細に「60コマ」の札で出す — 実測がどちらに転んだかは、ここに出さないと
     * サーバのログにしか残らない
     */
    { table: 'recordings', column: 'fps', definition: 'INTEGER' },
    /*
     * 音声の構成 (JSON: audio_component_descriptor の配列)。番組表から写しておく。
     *
     * 焼いたものの音声トラックに**番組表と同じ名前**を入れるのに要る
     * (「主音声」「解説」。`arib.audioTitles`)。ジャンルと同じで、番組表の行は
     * 24時間で消えるので、録り直しのときには写しからしか引けない
     */
    { table: 'recordings', column: 'audios', definition: 'TEXT' },
    /*
     * 録り終えた時刻 / 録り始めた時刻。
     *
     * どちらも「状態の文字列を持つのをやめる」ために足したもの。
     * 中身の入れ直しは列を足すだけでは済まないので {@link dropStoredState} が続きをやる
     */
    { table: 'recordings', column: 'finished_at', definition: 'INTEGER' },
    { table: 'reservations', column: 'started_at', definition: 'INTEGER' },
    // 詳細(拡張形式)。番組詳細の画面に概要と続けて出す
    { table: 'recordings', column: 'extended', definition: 'TEXT' },
];

/**
 * 録画の状態。**列としては持たず、事実から毎回決める。**
 *
 * CREATE TABLE の生成列と、既にあるDBを移し替えるとき (db.dropStoredState) の
 * 両方から使う。二か所に書くと必ず食い違うので、式はここにしか置かない。
 */
export const RECORDING_STATE = `
        CASE
            WHEN deleted_at IS NOT NULL THEN 'deleted'
            WHEN error IS NOT NULL THEN 'failed'
            WHEN finished_at IS NULL THEN 'recording'
            WHEN library_path IS NOT NULL THEN 'available'
            ELSE 'recorded'
        END`;

/**
 * 画面に出す予約の状態。**録り始めてからは録画の行が決める。**
 *
 * DBに入っているのは `scheduled | conflict | canceled | missed` だけ。
 * 予約 `r` と、その予約で録れた最新の録画 `rec` を LEFT JOIN した上で使う
 * (一覧と番組表の両方が要るので、式はここにしか置かない)。
 */
export const RESERVATION_STATE = `
        CASE
            WHEN r.started_at IS NULL THEN r.state
            WHEN rec.state = 'recording' THEN 'recording'
            WHEN rec.state = 'failed' THEN 'failed'
            ELSE 'done'
        END`;

export const SCHEMA = `
-- 全て CREATE ... IF NOT EXISTS で書き、起動のたびに流す。
-- 列を足すときは末尾に ALTER TABLE ... ADD COLUMN を追記していく方針
-- (単一ノード・単一プロセスの個人用途なのでマイグレーションツールは持たない)。

-- 画面から変えられる設定。環境変数を初期値として、ここにあれば上書きする。
-- いまは使っていないが、画面から変えたい設定が出たときのために残してある。
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 期限付きの再生リンクの控え (share.ts)。**1録画につき現役は1本。**
-- 期限内にもう一度発行すると、同じトークンのまま期限だけ延びる —
-- テレビの履歴に残ったURLが、使い続けているかぎり生き続ける
CREATE TABLE IF NOT EXISTS share_links (
    recording_id INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

-- 録画の節目を外部に飛ばす先。Discord や Slack の Incoming Webhook を想定している
CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 名前は廃止。1人で使うものに名札を付けても URL を見れば分かる。
    -- 既存の行を消さないので列だけ残してある
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    events TEXT NOT NULL,          -- JSON 配列。空配列は「全部」
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,              -- 直近の送信結果。設定画面で出す
    last_sent_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY,           -- 局の内部ID (tuner.ts の serviceKey)
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,               -- GR / BS / CS
    -- ARIB のサービス種別 (STD-B10)。1 = デジタルTV、2 = デジタル音声、
    -- 192 = データ/ワンセグ、164 = エンジニアリング。録るのは 1 だけ
    service_type INTEGER NOT NULL DEFAULT 1,
    channel TEXT NOT NULL,            -- 物理チャンネル。同一チャンネルの同時録画はチューナーを共有できる
    remote_control_key INTEGER,
    has_logo INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY,           -- 番組ID (tuner.ts の programKey)
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    extended TEXT,                    -- JSON
    genres TEXT,                      -- JSON: lv1 の配列。ルールの判定に使う
    genre_detail TEXT,                -- JSON: [{lv1, lv2}]。表示用
    is_free INTEGER NOT NULL DEFAULT 1,
    audio_type INTEGER,               -- ARIB の componentType。2 がデュアルモノ
    audios TEXT,                      -- JSON: [{componentType, langs, text?, main?}]。表示用
    video_type TEXT,                  -- mpeg2 / h.264 など
    video_resolution TEXT,            -- 1080i / 480i など
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS programs_time ON programs (start_at, end_at);
CREATE INDEX IF NOT EXISTS programs_service_time ON programs (service_id, start_at);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL DEFAULT '',
    ignore_keyword TEXT NOT NULL DEFAULT '',
    -- キーワードを当てる範囲。name / description / extended のカンマ区切り
    search_fields TEXT NOT NULL DEFAULT 'name',
    service_ids TEXT,                 -- JSON 配列。NULL は全チャンネル対象
    service_types TEXT,               -- JSON 配列 (GR/BS/CS)。個別チャンネルとのORで効く
    genres TEXT,                      -- JSON 配列 (lv1)。NULL は全ジャンル
    enabled INTEGER NOT NULL DEFAULT 1,
    -- チューナーが足りないとき、どの予約を残すか。大きいほうが残る (conflict.ts)。
    -- **エージェントに渡す「掴む強さ」とは別物** (docs/agent.md)。
    -- ルールは 1、手動予約は 2。前は 2/3 から始めていたが、
    -- 比べる相手は予約どうしだけなので小さいところから数える
    priority INTEGER NOT NULL DEFAULT 1,
    -- **焼き方の細目 (生TSを残すか・CMの扱い・コーデック) は持たない。** 全体設定
    -- (settings) を焼くときに読む — 2箇所にあると片方だけ古くなって画面が嘘をつく。
    -- 予約が写しで固定するのは「焼くか否か」(encode) だけで、予約した時点で決まる
    -- (後から設定を変えても、積んである録画の焼く/焼かないは変えない)
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 1番組1予約。複数ルールが同じ番組にマッチしても二重録画にならないようにする
    program_id INTEGER NOT NULL UNIQUE,
    rule_id INTEGER,
    service_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 2,
    manual INTEGER NOT NULL DEFAULT 0,
    -- 「焼くか否か」だけは予約した時点で固定する (recorder が読む)。焼き方の細目
    -- (生TSを残すか・CMの扱い・コーデック) は持たず、焼くときに settings を見る
    encode INTEGER NOT NULL DEFAULT 1,
    /*
     * scheduled | conflict | canceled | missed
     * missed = 始まらないまま放送が終わったもの(アプリが止まっていた等)。
     *
     * **録り始めてからの状態は持たない。** 録画の行がそれを知っているので、
     * ここに 'recording' / 'done' / 'failed' を書き写すと二重管理になる
     * (実際、録画が失敗しても予約側が 'recording' のまま残ることがあった)
     */
    state TEXT NOT NULL DEFAULT 'scheduled',
    -- 録り始めた時刻。NULL なら**まだ始めていない**。
    -- 二重に録り始めないための鍵でもある (scheduler.tick)
    started_at INTEGER,
    conflict_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_state_time ON reservations (state, start_at);

CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER,
    program_id INTEGER,
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    series TEXT NOT NULL DEFAULT '',   -- 保存先でシリーズとしてまとめる単位
    subtitle TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    -- 詳細(拡張形式)。番組表から写し、番組詳細の画面に概要と続けて出す
    extended TEXT,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    audio_type INTEGER,
    ts_path TEXT,
    ts_size INTEGER NOT NULL DEFAULT 0,
    library_path TEXT,
    -- もう一方のコーデックで焼いたもの (両方を選んだとき)
    alt_path TEXT,
    -- 録り終えた時刻。NULL なら**まだチューナーを掴んでいる**。
    -- 「録画中かどうか」を文字列で持たないための、ただ一つの事実
    finished_at INTEGER,
    -- 録画そのものが失敗した理由。消したときは削除の理由も入る。
    -- **エンコードの失敗はここに書かない** (encode_jobs.error が持っている)
    error TEXT,
    cm_ranges TEXT,   -- 検出したCM区間の JSON。UIでの確認用
    -- JSON: [{lv1, lv2}]。番組詳細のジャンル札に使う
    genre_detail TEXT,
    -- JSON: [{componentType, langs, text?, main?}]。焼いたものの音声トラックに
    -- 番組表と同じ名前を入れるのに使う (arib.audioTitles)
    audios TEXT,
    -- 実際に録れた長さ。番組表の尺 (end_at - start_at) は予定でしかなく、
    -- 途中で止めたときやCMを切ったときは実物と合わない
    duration_ms INTEGER,
    -- 焼いたもののコマ数 (30/60)。実測 (fpsDetect) か既定の60。NULL は未エンコード
    fps INTEGER,
    -- 消した時刻(denpa から、または外から)。行は履歴として残す
    deleted_at INTEGER,
    -- 失敗をユーザーが確認した時刻。以降ダッシュボードの通知に出さない
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    /*
     * 状態は**持たない**。上の列から決まるものを毎回引き直す。
     *
     * 文字列で別に持っていた頃は、同じことを二重に書くことになっていた
     * (エンコードが始まれば 'encoding'、終われば library_path と一緒に 'available')。
     * 書き忘れれば食い違うし、実際にエンコードの失敗が録画そのものの失敗として
     * 'failed' に化けて、中身のある生TSを持ったまま再生もできなくなっていた。
     *
     * 生成列にしておくと SQLite が書き込みを拒むので、食い違いようがない。
     * 'encoding' はここに無い。動いているエンコードは encode_jobs にしか無く、
     * 一覧はそちらを見て「エンコード中」を出す (format.encodeLabel)
     */
    state TEXT GENERATED ALWAYS AS (${RECORDING_STATE}
    ) VIRTUAL
);
CREATE INDEX IF NOT EXISTS recordings_state ON recordings (state);
CREATE INDEX IF NOT EXISTS recordings_start ON recordings (start_at DESC);
-- 番組表は1マスごとに「この番組で録れたものはあるか」を引く。
-- 無いと24時間ぶんのマスの数だけ録画一覧を舐めることになる
CREATE INDEX IF NOT EXISTS recordings_program ON recordings (program_id);

CREATE TABLE IF NOT EXISTS encode_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL,
    -- queued | running | done | failed | canceled
    state TEXT NOT NULL DEFAULT 'queued',
    -- descramble | cm | cut | encode。running の間、いまどの段階かを表す
    phase TEXT NOT NULL DEFAULT 'encode',
    percent REAL NOT NULL DEFAULT 0,
    eta_ms INTEGER,
    log TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS encode_jobs_state ON encode_jobs (state, id);
-- 録画一覧は1行ごとに「この録画の最新のジョブ」を2回引く (状態と失敗の理由)
CREATE INDEX IF NOT EXISTS encode_jobs_recording ON encode_jobs (recording_id, id);

-- OIDC でログインした控え。Cookie に入るのは id だけで、中身はここにしかない
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,              -- 推測できない文字列 (32バイト)
    subject TEXT NOT NULL,            -- ID トークンの sub。誰であるかはこれだけが決める
    -- 誰の控えか見て分かるように。**画面には出さないし、通すかどうかも決めない**
    -- (名前で決めると改名で入れなくなる。決めるのは sub とグループ)
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
-- 切れたものを片付けるときに舐める
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- テレビの VLC へはサーバではなく端末が直接飛ばす形にしたので (vlc.ts)、
-- サーバがペアリングの控えを持っていた短命のテーブルは片付ける
DROP TABLE IF EXISTS vlc_sessions;
`;
