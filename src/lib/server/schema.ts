import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ChannelType } from '../types';

/**
 * **テーブルの定義はここにしか無い** (drizzle)。
 *
 * - 行の型はここから導く (`types.ts` の `Recording` など)
 * - DB を作る SQL もここから出す: 変えたら `bun run db:generate` で `drizzle/` に
 *   マイグレーションが出るので、一緒にコミットする。当てるのは起動時 (`db.ts`)
 *
 * 前は SQL の文字列 (`CREATE TABLE IF NOT EXISTS` + 後から足した列の一覧) と
 * TS の interface を別々に書いていた。列を足すときに3箇所を直すことになり、
 * 片方だけ直しても TS は何も言わなかった (`queryOne<Recording>` はキャスト)。
 * 実際に本番が 500 を返したこともある (列を SQL に書いただけで、動いている DB には
 * 足されていなかった)。
 *
 * 真偽を 0/1 で持つ列 (`enabled` / `manual` / `encode` / `has_logo` / `is_free`)
 * は number のまま。`{ mode: 'boolean' }` にすると読み書きの値が変わり、いまの
 * 呼び出し側 (`= 1` で比べている) を全部触ることになる。型を付け終えてからの話
 */

/**
 * 録画の状態。**列としては持たず、事実から毎回決める** (recordings.state の生成列)
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

/** 画面から変えられる設定。環境変数を初期値として、ここにあれば上書きする */
export const settings = sqliteTable('settings', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updated_at: integer('updated_at').notNull(),
});

/**
 * 期限付きの再生リンクの控え (share.ts)。**1録画につき現役は1本。**
 * 期限内にもう一度発行すると、同じトークンのまま期限だけ延びる
 */
export const shareLinks = sqliteTable('share_links', {
    recording_id: integer('recording_id').primaryKey(),
    token: text('token').notNull(),
    expires_at: integer('expires_at').notNull(),
});

/** 録画の節目を外部に飛ばす先。Discord や Slack の Incoming Webhook を想定している */
export const webhooks = sqliteTable('webhooks', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 名前は廃止。既存の行を消さないので列だけ残してある */
    name: text('name').notNull().default(''),
    url: text('url').notNull(),
    /** JSON 配列。空配列は「全部」 */
    events: text('events').notNull(),
    enabled: integer('enabled').notNull().default(1),
    /** 直近の送信結果。設定画面で出す */
    last_status: text('last_status'),
    last_sent_at: integer('last_sent_at'),
    created_at: integer('created_at').notNull(),
});

export const services = sqliteTable('services', {
    /** 局の内部ID (tuner.ts の serviceKey) */
    id: integer('id').primaryKey(),
    service_id: integer('service_id').notNull(),
    network_id: integer('network_id').notNull(),
    name: text('name').notNull(),
    type: text('type').$type<ChannelType>().notNull(),
    /**
     * ARIB のサービス種別 (STD-B10)。1 = デジタルTV、2 = デジタル音声、
     * 192 = データ/ワンセグ、164 = エンジニアリング。録るのは 1 だけ
     */
    service_type: integer('service_type').notNull().default(1),
    /** 物理チャンネル。同一チャンネルの同時録画はチューナーを共有できる */
    channel: text('channel').notNull(),
    remote_control_key: integer('remote_control_key'),
    has_logo: integer('has_logo').notNull().default(0),
    updated_at: integer('updated_at').notNull(),
    /** 局ロゴの位置 ("x,y,w,h")。CM検出 (jls) で自動検出できなかった局だけ手で入れる */
    logo_area: text('logo_area'),
    /**
     * `logo_area` を誰が入れたか。**0 = 人 (または無し) / 1 = こちらが割り出した /
     * 2 = 割り出したが外れた** (外した枠は出し直さない。logo-area.ts)
     */
    logo_area_auto: integer('logo_area_auto').notNull().default(0),
});

export const programs = sqliteTable(
    'programs',
    {
        /** 番組ID (tuner.ts の programKey) */
        id: integer('id').primaryKey(),
        service_id: integer('service_id').notNull(),
        network_id: integer('network_id').notNull(),
        event_id: integer('event_id').notNull(),
        start_at: integer('start_at').notNull(),
        end_at: integer('end_at').notNull(),
        name: text('name').notNull().default(''),
        description: text('description').notNull().default(''),
        /** JSON {見出し:本文} */
        extended: text('extended'),
        /** JSON: lv1 の配列。ルールの判定に使う */
        genres: text('genres'),
        /** JSON: [{lv1, lv2}]。表示用 */
        genre_detail: text('genre_detail'),
        is_free: integer('is_free').notNull().default(1),
        /** ARIB の componentType。2 がデュアルモノ */
        audio_type: integer('audio_type'),
        /** JSON: [{componentType, langs, text?, main?}]。表示用 */
        audios: text('audios'),
        /** mpeg2 / h.264 など */
        video_type: text('video_type'),
        /** 1080i / 480i など */
        video_resolution: text('video_resolution'),
        updated_at: integer('updated_at').notNull(),
    },
    (t) => [
        index('programs_time').on(t.start_at, t.end_at),
        index('programs_service_time').on(t.service_id, t.start_at),
    ],
);

export const rules = sqliteTable('rules', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    keyword: text('keyword').notNull().default(''),
    ignore_keyword: text('ignore_keyword').notNull().default(''),
    /**
     * キーワードを当てる範囲。SearchField のカンマ区切り。
     * この列が無かった頃のルールは「番組名+概要」で当てていたので、そのぶんは
     * `name,description` が入っている。新しく作るルールの初期値は番組名だけ (画面側)
     */
    search_fields: text('search_fields').notNull().default('name'),
    /** JSON 配列。NULL は全チャンネル対象 */
    service_ids: text('service_ids'),
    /** JSON 配列 (GR/BS/CS)。個別チャンネルとのORで効く */
    service_types: text('service_types'),
    /** JSON 配列 (lv1)。NULL は全ジャンル */
    genres: text('genres'),
    enabled: integer('enabled').notNull().default(1),
    /**
     * チューナーが足りないとき、どの予約を残すか。大きいほうが残る (conflict.ts)。
     * **エージェントに渡す「掴む強さ」とは別物** (docs/agent.md)。
     * ルールは 1、手動予約は 2。比べる相手は予約どうしだけなので小さいところから数える
     */
    priority: integer('priority').notNull().default(1),
    created_at: integer('created_at').notNull(),
    /** 引き継ぎ元での識別子 (例: epgstation:12)。自分で作ったものは NULL */
    source: text('source'),
});

/**
 * DB に入る予約の状態。**録り始めてからの状態は持たない** — 録画の行がそれを
 * 知っているので、画面に出す `recording | done | failed` は録画から引く
 * (`types.ts` の ReservationState、上の RESERVATION_STATE)。
 * 予約側にも書き写していた頃は、録画が失敗しても予約は録画中のまま残っていた
 */
export const RESERVATION_STATES = ['scheduled', 'conflict', 'canceled', 'missed'] as const;

export const reservations = sqliteTable(
    'reservations',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        /** 1番組1予約。複数ルールが同じ番組にマッチしても二重録画にならないようにする */
        program_id: integer('program_id').notNull().unique(),
        rule_id: integer('rule_id'),
        service_id: integer('service_id').notNull(),
        name: text('name').notNull(),
        description: text('description').notNull().default(''),
        start_at: integer('start_at').notNull(),
        end_at: integer('end_at').notNull(),
        priority: integer('priority').notNull().default(2),
        manual: integer('manual').notNull().default(0),
        /**
         * 「焼くか否か」だけは予約した時点で固定する (recorder が読む)。焼き方の細目
         * (生TSを残すか・CMの扱い・コーデック) は持たず、焼くときに settings を見る
         */
        encode: integer('encode').notNull().default(1),
        /** missed = 始まらないまま放送が終わったもの (アプリが止まっていた等) */
        state: text('state', { enum: RESERVATION_STATES }).notNull().default('scheduled'),
        /** 録り始めた時刻。NULL なら**まだ始めていない**。二重に録り始めないための鍵でもある (scheduler.tick) */
        started_at: integer('started_at'),
        conflict_reason: text('conflict_reason'),
        created_at: integer('created_at').notNull(),
        updated_at: integer('updated_at').notNull(),
        /**
         * **チューナーを掴んでよい区間** (前後マージン込み。NULL = 番組どおり丸ごと)。
         * 取り合いが番組の一部でしか起きていないとき、そこだけ譲って残りを録る
         * (`conflict.ts` の「入るところまで録る」)。番組の時刻は動かさない
         */
        record_from: integer('record_from'),
        record_to: integer('record_to'),
    },
    (t) => [index('reservations_state_time').on(t.state, t.start_at)],
);

/**
 * 録画の状態。**列ではなく生成列**で、他の列から毎回決まる (RECORDING_STATE)。
 * `encoding` はここに無い。動いているエンコードは encode_jobs にしか無く、
 * 一覧はそれを見て「エンコード中」を出す (format.encodeLabel)
 */
export const RECORDING_STATES = ['recording', 'recorded', 'available', 'failed', 'deleted'] as const;

export const recordings = sqliteTable(
    'recordings',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        reservation_id: integer('reservation_id'),
        program_id: integer('program_id'),
        service_id: integer('service_id').notNull(),
        service_name: text('service_name').notNull().default(''),
        name: text('name').notNull(),
        /** 保存先でシリーズとしてまとめる単位 */
        series: text('series').notNull().default(''),
        subtitle: text('subtitle').notNull().default(''),
        description: text('description').notNull().default(''),
        /** 詳細(拡張形式)。JSON {見出し:本文}。番組詳細の画面に概要と続けて出す */
        extended: text('extended'),
        start_at: integer('start_at').notNull(),
        end_at: integer('end_at').notNull(),
        audio_type: integer('audio_type'),
        ts_path: text('ts_path'),
        ts_size: integer('ts_size').notNull().default(0),
        /**
         * 焼いたもの (再生・ダウンロードで主に使う)。両方のコーデックを焼いたときは
         * **AV1 のほう** (小さいので既定の再生に向く)
         */
        library_path: text('library_path'),
        /**
         * もう一方のコーデックで焼いたもの。両方を選んだときだけ入る (AV1 が主なら H.264)。
         * 古いテレビのように AV1 を解けない相手はこちらを開く
         */
        alt_path: text('alt_path'),
        /** 録り終えた時刻。NULL なら**まだチューナーを掴んでいる**。「録画中かどうか」を文字列で持たないための、ただ一つの事実 */
        finished_at: integer('finished_at'),
        /**
         * 録画そのものが失敗した理由。消したときは削除の理由も入る。
         * **エンコードの失敗はここに書かない** (encode_jobs.error が持っている)
         */
        error: text('error'),
        /** 検出したCM区間の JSON。UIでの確認用 */
        cm_ranges: text('cm_ranges'),
        /** 番組表から写したジャンル (JSON: [{lv1, lv2}])。番組詳細のジャンル札に使う */
        genre_detail: text('genre_detail'),
        /**
         * 番組表から写した音声の構成 (JSON: `audio_component_descriptor` の配列)。
         * 焼いたものの音声トラックに**番組表と同じ名前**を入れるのに使う (`arib.audioTitles`)
         */
        audios: text('audios'),
        /** 実際に録れた長さ。番組表の尺 (end_at - start_at) は予定でしかない。取れていなければ NULL (古い行) */
        duration_ms: integer('duration_ms'),
        /** 焼いたもののコマ数 (30/60)。実測 (fpsDetect) か既定の60。未エンコード・fps記録前の古い行は NULL */
        fps: integer('fps'),
        /** 消した時刻 (denpa から、または外から)。行は履歴として残す */
        deleted_at: integer('deleted_at'),
        /** 失敗をユーザーが確認した時刻。以降ダッシュボードの通知に出さない */
        acknowledged_at: integer('acknowledged_at'),
        created_at: integer('created_at').notNull(),
        updated_at: integer('updated_at').notNull(),
        /**
         * 状態は**持たない**。上の列から決まるものを毎回引き直す生成列。
         *
         * 文字列で別に持っていた頃は、同じことを二重に書くことになっていた
         * (エンコードが始まれば 'encoding'、終われば library_path と一緒に 'available')。
         * 書き忘れれば食い違うし、実際にエンコードの失敗が録画そのものの失敗として
         * 'failed' に化けて、中身のある生TSを持ったまま再生もできなくなっていた。
         * 生成列にしておくと SQLite が書き込みを拒むので、食い違いようがない。
         *
         * CASE は必ずどれかに落ちるので NOT NULL (DB の定義には書かない。生成列の
         * NOT NULL は schema.test.ts も見ない)
         */
        state: text('state', { enum: RECORDING_STATES })
            .notNull()
            .generatedAlwaysAs(sql.raw(RECORDING_STATE), { mode: 'virtual' }),
        /**
         * CM検出が何をしたか。一覧には出さず、録画の詳細で見せる。
         * **ロゴを使えたかどうかもここから読む** (`format.logoUnusable`)。別の列で
         * 持っていた頃は、後から条件を広げても既に録ってある分には効かなかった
         */
        cm_note: text('cm_note'),
        /**
         * **実際に掴めた区間** (前後マージン込み。NULL = 番組どおり丸ごと)。予約から写す。
         * 一覧で「頭が欠けている」と言うのに要る — **番組の時刻 (`start_at`) は
         * 動かさない**ので、そちらとの差が欠けた幅になる
         */
        record_from: integer('record_from'),
        record_to: integer('record_to'),
        /**
         * どこまで観たか (ms)。**続きから観るためだけの目印。** まだ観ていない・観終えたものは NULL。
         * 端末に持たせず DB に置くのは、居間のタブレットで観たものを机の PC で
         * 続けられるようにするため (`api/recordings/<id>/resume`)
         */
        resume_ms: integer('resume_ms'),
    },
    (t) => [
        index('recordings_state').on(t.state),
        index('recordings_start').on(sql`${t.start_at} DESC`),
        // 番組表は1マスごとに「この番組で録れたものはあるか」を引く。
        // 無いと24時間ぶんのマスの数だけ録画一覧を舐めることになる
        index('recordings_program').on(t.program_id),
    ],
);

export const ENCODE_STATES = ['queued', 'running', 'done', 'failed', 'canceled'] as const;
/**
 * エンコードの段階。`encode` 以外は ffmpeg が回る前の下ごしらえで、長いものだと
 * 数十分かかる。進み具合が出せない代わりにこれを状態として出す
 */
export const ENCODE_PHASES = ['descramble', 'cm', 'cut', 'encode'] as const;

export const encodeJobs = sqliteTable(
    'encode_jobs',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        recording_id: integer('recording_id').notNull(),
        state: text('state', { enum: ENCODE_STATES }).notNull().default('queued'),
        phase: text('phase', { enum: ENCODE_PHASES }).notNull().default('encode'),
        percent: real('percent').notNull().default(0),
        /** 残り時間の見込み(ms)。ffmpeg の speed から出す。分からない間は NULL */
        eta_ms: integer('eta_ms'),
        log: text('log').notNull().default(''),
        attempts: integer('attempts').notNull().default(0),
        error: text('error'),
        created_at: integer('created_at').notNull(),
        started_at: integer('started_at'),
        finished_at: integer('finished_at'),
    },
    (t) => [
        index('encode_jobs_state').on(t.state, t.id),
        // 録画一覧は1行ごとに「この録画の最新のジョブ」を2回引く (状態と失敗の理由)
        index('encode_jobs_recording').on(t.recording_id, t.id),
    ],
);

/** OIDC でログインした控え。Cookie に入るのは id だけで、中身はここにしかない */
export const sessions = sqliteTable(
    'sessions',
    {
        /** 推測できない文字列 (32バイト) */
        id: text('id').primaryKey(),
        /** ID トークンの sub。誰であるかはこれだけが決める */
        subject: text('subject').notNull(),
        /**
         * 誰の控えか見て分かるように。**画面には出さないし、通すかどうかも決めない**
         * (名前で決めると改名で入れなくなる。決めるのは sub とグループ)
         */
        name: text('name').notNull().default(''),
        created_at: integer('created_at').notNull(),
        expires_at: integer('expires_at').notNull(),
    },
    // 切れたものを片付けるときに舐める
    (t) => [index('sessions_expires').on(t.expires_at)],
);
