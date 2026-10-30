import { isAbsolute, join, relative, sep } from "node:path";

import type { Genre } from "@danything/arib/eit";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { Audio } from "../arib";
import type { ChannelType, ReservationState } from "../types";
import type { Range } from "./cm";
import { config } from "./config";

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
 * 真偽を 0/1 で持つ列 (`enabled` / `manual` / `encode` / `has_logo` / `is_free` など)
 * は `{ mode: 'boolean' }` で読み書きする。DB の中は今までどおり 0/1 で、既定値も
 * `sql\`1\`` のまま書く — `default(true)` にすると drizzle-kit が `DEFAULT true` を
 * 出して、中身の変わらないマイグレーション (テーブルの作り直し) が出てしまう。
 * snapshot (drizzle/meta/0000) の既定値もこの書き方 ("1") に手で揃えてある —
 * 数の 1 と `sql\`1\`` は同じ DDL になるのに、snapshot の上では別物と見なされるので
 */

/** 真偽の列。DB の中は 0/1 */
const flag = (name: string) => integer(name, { mode: "boolean" });

/**
 * JSON を文字列で持つ列。読むときにデコードし、書くときに畳む。**読み取り関数は列ごとに書く。**
 *
 * drizzle の `{ mode: 'json' }` は使わない。あれは読めない行で例外を投げるが、
 * ここに入っているのは放送から取得したものや、取り込みの時期によって形式が違うもの
 * (古い行は `''`、EPGStation から来たジャンルは数の並び) で、1行が読めないせいで
 * 一覧ごと出なくなるのは困る。読めない行はその列を「持っていない」ことにして、
 * 残りは見えるようにする。NULL の行は drizzle が読み取り関数を呼ばない (NULL のまま)
 */
function json<T>(name: string, read: (value: unknown) => T) {
  return customType<{ data: T; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (raw) => {
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        // 壊れた行。read が「持っていない」の形に落とす
      }
      return read(value);
    },
  })(name);
}

/**
 * 録画ファイルの場所を持つ列。**DB には置き場からの相対で持ち、読み書きするコードには絶対パスで見せる。**
 *
 * 相対なら、置き場のマウント先をどこへ移しても DB は触らずに済む。読み替えはここだけで済ませ、使う側は今までどおり
 * 絶対パスで扱う (`eq()` や `set()` に渡した値もここを通る)。
 *
 * 置き場の外のもの (Windows で書かれた古い行など) は絶対のまま持ち、そのまま返す。
 * 置き場は呼ばれるたびに config から引く (テストが差し替える)
 */
function mediaPath(name: string, root: () => string) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => {
      const rel = relative(root(), value);
      return isAbsolute(value) &&
        rel !== "" &&
        !rel.startsWith("..") &&
        !isAbsolute(rel)
        ? rel.split(sep).join("/")
        : value;
    },
    fromDriver: (raw) => (isAbsolute(raw) ? raw : join(root(), raw)),
  })(name);
}

/** 並び。並びでなければ空 */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(Number) : [];
const objects =
  <T extends object>() =>
  (value: unknown): T[] =>
    Array.isArray(value) ? (value as T[]) : [];
/** {見出し: 本文}。それ以外の形式なら無し */
const record = (value: unknown): Record<string, string> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;

/**
 * 録画の状態。**列としては持たず、事実から毎回決める** (recordings.state の生成列)
 */
const RECORDING_STATE = `
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
 * DBに入っているのは `scheduled | conflict | skipped | canceled | missed` だけ。
 * 予約 `r` と、その予約で録れた最新の録画 `rec` を LEFT JOIN した上で使う
 * (一覧と番組表の両方が要るので、式はここにしか置かない)。
 * どちらも `alias()` したものを渡してよい — 列は名指しなので別名がそのまま効く
 */
export function reservationState(
  r: { started_at: AnySQLiteColumn; state: AnySQLiteColumn },
  rec: { state: AnySQLiteColumn },
) {
  return sql<ReservationState>`CASE
            WHEN ${r.started_at} IS NULL THEN ${r.state}
            WHEN ${rec.state} = 'recording' THEN 'recording'
            WHEN ${rec.state} = 'failed' THEN 'failed'
            ELSE 'done'
        END`;
}

/**
 * 録画の直近のエンコード失敗の理由。**いちばん新しいジョブが失敗していたときだけ**
 * (再エンコードして成功したら前の失敗は出さない)
 */
export function lastEncodeError(recordingId: AnySQLiteColumn) {
  return sql<string | null>`(
        SELECT CASE WHEN j2.state = 'failed' THEN j2.error END FROM encode_jobs j2
        WHERE j2.recording_id = ${recordingId}
        ORDER BY j2.id DESC LIMIT 1)`;
}

/** 録画の、動いている (待ち・実行中) エンコード。録画1本につき高々1つ (`encoder.enqueue` が重複を弾く) */
export function activeEncodeJobId(recordingId: AnySQLiteColumn) {
  return sql<
    number | null
  >`(SELECT id FROM encode_jobs WHERE recording_id = ${recordingId}
        AND state IN ('queued','running') ORDER BY id DESC LIMIT 1)`;
}

/** 番組のいちばん新しい録画 (消したものは除く)。番組表と予約の一覧が状態を出すのに使う */
export function latestRecordingId(programId: AnySQLiteColumn) {
  return sql<number>`(SELECT id FROM recordings WHERE program_id = ${programId} AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)`;
}

/** 画面から変えられる設定 (settings.ts)。初期値は config.ts が持ち、ここに行があればそちらが勝つ */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull(),
});

/** 録画の節目を外部に飛ばす先。Discord や Slack の Incoming Webhook を想定している */
export const webhooks = sqliteTable("webhooks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  /** JSON 配列。空配列は「全部」 */
  events: json("events", strings).notNull(),
  enabled: flag("enabled")
    .notNull()
    .default(sql`1`),
  /** 直近の送信結果。設定画面で出す */
  last_status: text("last_status"),
  last_sent_at: integer("last_sent_at"),
  created_at: integer("created_at").notNull(),
});

export const services = sqliteTable("services", {
  /** 局の内部ID (tuner.ts の serviceKey) */
  id: integer("id").primaryKey(),
  service_id: integer("service_id").notNull(),
  network_id: integer("network_id").notNull(),
  name: text("name").notNull(),
  type: text("type").$type<ChannelType>().notNull(),
  /**
   * ARIB のサービス種別 (STD-B10)。1 = デジタルTV、2 = デジタル音声、
   * 192 = データ/ワンセグ、164 = エンジニアリング。録るのは 1 だけ
   */
  service_type: integer("service_type").notNull().default(1),
  /** 物理チャンネル。同一チャンネルの同時録画はチューナーを共有できる */
  channel: text("channel").notNull(),
  remote_control_key: integer("remote_control_key"),
  has_logo: flag("has_logo")
    .notNull()
    .default(sql`0`),
  updated_at: integer("updated_at").notNull(),
});

export const programs = sqliteTable(
  "programs",
  {
    /** 番組ID (tuner.ts の programKey) */
    id: integer("id").primaryKey(),
    service_id: integer("service_id").notNull(),
    network_id: integer("network_id").notNull(),
    event_id: integer("event_id").notNull(),
    start_at: integer("start_at").notNull(),
    end_at: integer("end_at").notNull(),
    name: text("name").notNull().default(""),
    description: text("description").notNull().default(""),
    /** JSON {見出し:本文} */
    extended: json("extended", record),
    /** JSON: lv1 の配列。ルールの判定に使う */
    genres: json("genres", numbers),
    /** JSON: [{lv1, lv2}]。表示用 */
    genre_detail: json("genre_detail", objects<Genre>()),
    is_free: flag("is_free")
      .notNull()
      .default(sql`1`),
    /** ARIB の componentType。2 がデュアルモノ */
    audio_type: integer("audio_type"),
    /** JSON: [{componentType, langs, text?, main?}]。表示用 */
    audios: json("audios", objects<Audio>()),
    /** mpeg2 / h.264 など */
    video_type: text("video_type"),
    /** 1080i / 480i など */
    video_resolution: text("video_resolution"),
    /**
     * **コピー禁止の番組か** (EIT のデジタルコピー制御記述子)。禁止の番組は録らない —
     * 予約は「録画しない」になる (`scheduler.resolveConflicts`)。docs/data.md「コピー禁止の番組」
     */
    copy_never: flag("copy_never")
      .notNull()
      .default(sql`0`),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    index("programs_time").on(t.start_at, t.end_at),
    index("programs_service_time").on(t.service_id, t.start_at),
  ],
);

export const rules = sqliteTable("rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  keyword: text("keyword").notNull().default(""),
  ignore_keyword: text("ignore_keyword").notNull().default(""),
  /**
   * キーワードを当てる範囲。SearchField のカンマ区切り。
   * この列が無かった頃のルールは「番組名+概要」で当てていたので、そのぶんは
   * `name,description` が入っている。新しく作るルールの初期値は番組名だけ (画面側)
   */
  search_fields: text("search_fields").notNull().default("name"),
  /** JSON 配列。NULL は全局 */
  service_ids: json("service_ids", numbers),
  /** JSON 配列 (GR/BS/CS/SKY)。個別の局 (`service_ids`) とのORで効く */
  service_types: json("service_types", strings),
  /** JSON 配列。`"7"` (大分類) か `"7-0"` (中分類まで)。NULL は全ジャンル */
  genres: json("genres", strings),
  /**
   * **番組の始まる時刻**の時間帯。日本時間の 0:00 からの分 (0〜1439)。`time_from` 以上 `time_to` 未満で、
   * `time_from > time_to` は日をまたぐ (23:00〜02:00)。両方 NULL はいつでも (`rule-time.ts`)
   */
  time_from: integer("time_from"),
  time_to: integer("time_to"),
  /** JSON 配列。始まる時刻の曜日 (0 が日曜〜6 が土曜)。日をまたぐ時間帯も始まる日の暦で見る。NULL は毎日 */
  weekdays: json("weekdays", numbers),
  enabled: flag("enabled")
    .notNull()
    .default(sql`1`),
  /**
   * チューナーが足りないとき、どの予約を残すか。大きいほうが残る (conflict.ts)。
   * **エージェントに渡すチューナーの取り合いの優先度 (`config.priority`) とは別物** (docs/agent.md)。
   * ルールは 1、手動予約は 2。比べる相手は予約どうしだけなので小さいところから数える
   */
  priority: integer("priority").notNull().default(1),
  /**
   * **同じ回は最初の放送だけ録る** (`episode.firstAirings`)。局を替えた再放送・
   * 同時放送のうち、いちばん早いもの (同時なら字幕付き → 衛星) だけを予約する。
   * 画面で新しく作るルールは入れた状態で始まる。列を足す前のルールは 0 のまま
   * (今までどおり全部録る。黙って振る舞いを変えない)
   */
  dedupe: flag("dedupe")
    .notNull()
    .default(sql`0`),
  /**
   * **前の回は録らない** (`episode.earlierAirings`)。同じシリーズで、先の回を録った・予約したあとに
   * 流れる前の話数 (1〜3話の一挙放送など) は予約しない。番組名が同じまま1話から数え直すシリーズを
   * 飛ばしてしまうので、新しく作るルールも切った状態で始まる。列を足す前のルールも 0
   */
  skip_earlier: flag("skip_earlier")
    .notNull()
    .default(sql`0`),
  created_at: integer("created_at").notNull(),
  /** 引き継ぎ元での識別子 (例: epgstation:12・edcb:12)。自分で作ったものは NULL */
  source: text("source"),
});

/**
 * **よそで録った番組の控え** (EPGStation に残っている録画のうちルールで録ったものと、EDCB の録画済みの一覧から引き継いだもの。
 * `migrate.ts`・`migrate-edcb.ts`)。
 *
 * 録画の行にはしない — ファイルが無いので、録画の一覧や番組表に出ても開けない。読むのは
 * 「録ったことのある回」(`rules.recordedEpisodes`) だけで、ルールの「同じ回は最初の放送だけ」と
 * 「前の回は録らない」がそれを見る。denpa が自分で録ったものは `recordings` の行が同じ役をする。
 *
 * 入れるのはどちらも番組名・局・終わりの時刻だけ (EDCB の終わりは録画の開始 + 長さ)。
 * 概要が無いので、回はタイトルだけから読む (`episode.episodeOf`)
 */
export const recordedHistory = sqliteTable("recorded_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  service_name: text("service_name").notNull().default(""),
  end_at: integer("end_at").notNull(),
  /** 引き継ぎ元での識別子 (例: epgstation:recorded:12・edcb:recinfo:…)。取り込み直しても重ねない */
  source: text("source").notNull().unique(),
});

/**
 * DB に入る予約の状態。**録り始めてからの状態は持たない** — 録画の行がそれを
 * 知っているので、画面に出す `recording | done | failed` は録画から引く
 * (`types.ts` の ReservationState、上の `reservationState()`)
 */
const RESERVATION_STATES = [
  "scheduled",
  "conflict",
  "skipped",
  "canceled",
  "missed",
] as const;

export const reservations = sqliteTable(
  "reservations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 1番組1予約。複数ルールが同じ番組にマッチしても二重録画にならないようにする */
    program_id: integer("program_id").notNull().unique(),
    rule_id: integer("rule_id"),
    service_id: integer("service_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    start_at: integer("start_at").notNull(),
    end_at: integer("end_at").notNull(),
    priority: integer("priority").notNull().default(2),
    manual: flag("manual")
      .notNull()
      .default(sql`0`),
    /**
     * 「エンコードするか否か」だけは予約した時点で固定する (recorder が読む)。エンコード方法の細目
     * (元のTSを残すか・CMの扱い・コーデック) は持たず、エンコードするときに settings を見る
     */
    encode: flag("encode")
      .notNull()
      .default(sql`1`),
    /**
     * missed = 始まらないまま放送が終わったもの (アプリが止まっていた等)。
     * skipped = **録らないと決めたもの** (コピー禁止の番組。`scheduler.resolveConflicts`)。
     * 理由は `conflict_reason` に入る。放送が終わっても skipped のまま (録り逃しにしない。意図して録らなかったもの)
     */
    state: text("state", { enum: RESERVATION_STATES })
      .notNull()
      .default("scheduled"),
    /** 録り始めた時刻。NULL なら**まだ始めていない**。二重に録り始めないための鍵でもある (scheduler.tick) */
    started_at: integer("started_at"),
    /**
     * **誰が取り消したか。** 人が押した取り消し (`user`) はその放送に二度と
     * ルールを立てない印になる (`rules.ts` の `canceledBroadcasts`)。局が選局
     * できなくなってシステムが片付けたもの (`system`。`epg.clearBelongings`) は
     * 局が戻れば録り直してよいので、印にしない。NULL は列を足す前の行で、
     * 人が押したものとして扱う (余分に録るより、取り消したものを録るほうが困る)
     */
    canceled_by: text("canceled_by", { enum: ["user", "system"] }),
    /** 録れない・録らない理由 (チューナー不足の `conflict`、コピー禁止の `skipped`)。画面にそのまま出す */
    conflict_reason: text("conflict_reason"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    /**
     * **チューナーを使ってよい区間** (前後マージン込み。NULL = 番組どおり丸ごと)。
     * 取り合いが番組の一部でしか起きていないとき、そこだけ譲って残りを録る
     * (`conflict.ts` の「入るところまで録る」)。番組の時刻は動かさない
     */
    record_from: integer("record_from"),
    record_to: integer("record_to"),
  },
  (t) => [index("reservations_state_time").on(t.state, t.start_at)],
);

/**
 * 録画の状態。**列ではなく生成列**で、他の列から毎回決まる (RECORDING_STATE)。
 * `encoding` はここに無い。動いているエンコードは encode_jobs にしか無く、
 * 一覧はそれを見て「エンコード中」を出す (format.encodeLabel)
 */
const RECORDING_STATES = [
  "recording",
  "recorded",
  "available",
  "failed",
  "deleted",
] as const;

export const recordings = sqliteTable(
  "recordings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reservation_id: integer("reservation_id"),
    program_id: integer("program_id"),
    service_id: integer("service_id").notNull(),
    service_name: text("service_name").notNull().default(""),
    name: text("name").notNull(),
    /** 保存先でシリーズとしてまとめる単位 */
    series: text("series").notNull().default(""),
    subtitle: text("subtitle").notNull().default(""),
    description: text("description").notNull().default(""),
    /** 詳細(拡張形式)。JSON {見出し:本文}。番組詳細の画面に概要と続けて出す */
    extended: json("extended", record),
    start_at: integer("start_at").notNull(),
    end_at: integer("end_at").notNull(),
    audio_type: integer("audio_type"),
    /** 元のTS。元のTSの置き場 (`config.rawDir`) からの相対で持つ (`mediaPath`) */
    ts_path: mediaPath("ts_path", () => config.rawDir),
    ts_size: integer("ts_size").notNull().default(0),
    /**
     * エンコードしたもの (再生で主に使う)。両方のコーデックをエンコードしたときは
     * **AV1 のほう** (小さいので既定の再生に向く)
     */
    library_path: mediaPath("library_path", () => config.encodedDir),
    /**
     * もう一方のコーデックでエンコードしたもの。両方を選んだときだけ入る (AV1 が主なら H.264)。
     * 古いテレビのように AV1 をデコードできない相手はこちらを開く
     */
    alt_path: mediaPath("alt_path", () => config.encodedDir),
    /** 録り終えた時刻。NULL なら**まだチューナーを使っている**。「録画中かどうか」を文字列で持たないための、ただ一つの事実 */
    finished_at: integer("finished_at"),
    /**
     * 録画そのものが失敗した理由。消したときは削除の理由も入る。
     * **エンコードの失敗はここに書かない** (encode_jobs.error が持っている)
     */
    error: text("error"),
    /** 検出したCM区間の JSON。UIでの確認用 */
    cm_ranges: json("cm_ranges", objects<Range>()),
    /** 番組表から写したジャンル (JSON: [{lv1, lv2}])。番組詳細のジャンルのラベルに使う */
    genre_detail: json("genre_detail", objects<Genre>()),
    /**
     * 番組表から写した音声の構成 (JSON: `audio_component_descriptor` の配列)。
     * エンコードしたものの音声トラックに**番組表と同じ名前**を入れるのに使う (`arib.audioTitles`)
     */
    audios: json("audios", objects<Audio>()),
    /** 実際に録れた長さ。番組表の尺 (end_at - start_at) は予定でしかない。取れていなければ NULL (古い行) */
    duration_ms: integer("duration_ms"),
    /** エンコードしたもののコマ数 (30/60)。実測 (fpsDetect) か既定の60。未エンコード・fps記録前の古い行は NULL */
    fps: integer("fps"),
    /** 消した時刻 (denpa から、または外から)。行は履歴として残す */
    deleted_at: integer("deleted_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    /**
     * 状態は**持たない**。上の列から決まるものを毎回引き直す生成列。
     * SQLite が書き込みを拒むので、上の列と食い違いようがない。
     *
     * CASE は必ずどれかに落ちるので NOT NULL (DB の定義には書かない。生成列の
     * NOT NULL は schema.test.ts も見ない)
     */
    state: text("state", { enum: RECORDING_STATES })
      .notNull()
      .generatedAlwaysAs(sql.raw(RECORDING_STATE), { mode: "virtual" }),
    /**
     * CM検出が何をしたか。一覧には出さず、録画の詳細で見せる。
     * **ロゴを使えたかどうかもここから読む** (`format.logoUnusable`)
     */
    cm_note: text("cm_note"),
    /**
     * CM を切ってエンコードしたときに**残した区間** (入れ物の頭からの秒)。NULL は切っていない。
     * 切ったものからは CM を戻せないので、CM検出のやり直しはこれを見て断る (再エンコードを促す)
     */
    cm_kept: json("cm_kept", objects<Range>()),
    /**
     * エンコードするときに頭から捨てた長さ (秒。`encoder.inputSkip`)。エンコードしたものの時刻 = 入れ物の頭からの秒 − これ。
     * 元のTSから CM を検出し直してエンコードしたものにチャプターを書くときに引く。NULL はエンコードしていない (取り込んだ録画など)
     */
    encode_skip: real("encode_skip"),
    /**
     * **実際に使えた区間** (前後マージン込み。NULL = 番組どおり丸ごと)。予約から写す。
     * 一覧で「頭が欠けている」と言うのに要る — **番組の時刻 (`start_at`) は
     * 動かさない**ので、そちらとの差が欠けた幅になる
     */
    record_from: integer("record_from"),
    record_to: integer("record_to"),
    /**
     * **元の TS の頭 (再生位置 0 の手前) の放送時刻** (unix ms)。最初の TDT から、そこまでに PCR が進んだぶんを引いて測る
     * (`ts/ts-head.ts`)。録っている間 (`recorder.ts`) と、エンコードのとき (`recorded-bml.ts`。空なら) に書く。
     * 実況のコメントを再生位置に合わせるのに使う。測れていない録画 (TDT を読めない・取り込んだ録画) は NULL で、
     * そのときは予定の時刻 (`record_from ?? start_at − START_MARGIN`) で代わりに合わせる (`server/jikkyo.ts`)
     */
    ts_head: integer("ts_head"),
    /**
     * どこまで観たか (ms)。**続きから観るためだけの目印。** まだ観ていない・観終えたものは NULL。
     * 端末に持たせず DB に置くのは、居間のタブレットで観たものを机の PC で
     * 続けられるようにするため (`api/recordings/<id>/resume`)。**元の TS の物差し** (入れ物の頭から) で覚え、
     * エンコードしたもので観るときに直す (`ts/watch.ts` の `Ruler`。CM を切ったものと追っかけで同じ場面を指すため)
     */
    resume_ms: integer("resume_ms"),
    /**
     * 末尾まで観た時刻。NULL なら**まだ観終えていない** (一覧の「未視聴」の印)。
     * `resume_ms` は観終えると消えるので、未視聴と観終えたものを見分けられない。
     * 書くのは末尾まで来たとき (`api/recordings/<id>/resume`) と、詳細の「視聴済みにする」。
     * 消すのは「未視聴に戻す」だけ (観直して途中で止めても観終えたまま)
     */
    watched_at: integer("watched_at"),
  },
  (t) => [
    index("recordings_state").on(t.state),
    index("recordings_start").on(sql`${t.start_at} DESC`),
    // 番組表は1マスごとに「この番組で録れたものはあるか」を引く。
    // 無いと24時間ぶんのマスの数だけ録画一覧を舐めることになる
    index("recordings_program").on(t.program_id),
    // ルールの「前の回は録らない」は、当たった放送のシリーズ名で期間を切らずに引く (`rules.seriesEpisodes`)
    index("recordings_series").on(t.series),
  ],
);

/** **CM 検出の材料の控え** (録画1本に1行)。中身と使いみちは `cm-material.ts` */
export const cmMaterials = sqliteTable("cm_materials", {
  recording_id: integer("recording_id")
    .primaryKey()
    .references(() => recordings.id, { onDelete: "cascade" }),
  /** 中身の形式のバージョン (`cm-material.MATERIAL_VERSION`) */
  version: integer("version").notNull(),
  /** zstd で縮めたもの */
  data: blob("data", { mode: "buffer" }).notNull(),
  created_at: integer("created_at").notNull(),
});

const ENCODE_STATES = [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
] as const;
/**
 * エンコードの段階。`encode` 以外は ffmpeg が回る前の下ごしらえで、長いものだと
 * 数十分かかる。進み具合が出せない代わりにこれを状態として出す
 */
export const ENCODE_PHASES = ["descramble", "cm", "cut", "encode"] as const;

/**
 * ジョブの種類。`encode` はエンコードする (CM 検出も一緒に行う)、`cm` は**CM 検出だけやり直す**
 * (エンコードしたものにはチャプターを書き直すだけ。`encoder.runCmJob`)。同じ待ち行列に並べ、同時に走る本数も一緒に数える
 */
export const ENCODE_KINDS = ["encode", "cm"] as const;

export const encodeJobs = sqliteTable(
  "encode_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recording_id: integer("recording_id").notNull(),
    kind: text("kind", { enum: ENCODE_KINDS }).notNull().default("encode"),
    state: text("state", { enum: ENCODE_STATES }).notNull().default("queued"),
    phase: text("phase", { enum: ENCODE_PHASES }).notNull().default("encode"),
    percent: real("percent").notNull().default(0),
    /** 残り時間の見込み(ms)。ffmpeg の speed から出す。分からない間は NULL */
    eta_ms: integer("eta_ms"),
    log: text("log").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    created_at: integer("created_at").notNull(),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
  },
  (t) => [
    index("encode_jobs_state").on(t.state, t.id),
    // 録画一覧は1行ごとに「この録画の最新のジョブ」を2回引く (状態と失敗の理由)
    index("encode_jobs_recording").on(t.recording_id, t.id),
  ],
);

/** 切り抜きをどこで撮ったか。ライブ・追っかけ・観る画面 */
export const CLIP_PLACES = ["live", "chase", "watch"] as const;

/**
 * **切り抜き** (観ている1コマを字幕ごと写した静止画。`clips.ts`)。画像は置き場 (`clips.clipsDir`) に AVIF で置き、
 * ここには探すための情報を持つ。世帯で共有し、誰が撮ったかは持たない。
 *
 * 番組の情報は**撮ったときの値を写して持つ** (番組表は流れて消え、録画も消える。切り抜きは残す)
 */
export const clips = sqliteTable(
  "clips",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 撮った時刻 (サーバが受け取った時刻。ms)。並びと日付の絞り込みに使う */
    taken_at: integer("taken_at").notNull(),
    place: text("place", { enum: CLIP_PLACES }).notNull(),
    /** 撮った録画。ライブは同じ番組を録っていればそれ。**録画を消したら NULL** (`files.deleteRecordingFiles`) */
    recording_id: integer("recording_id"),
    /** 局の内部ID (`tuner.serviceKey`) */
    service_id: integer("service_id").notNull(),
    /** 番組。引けなかった (番組表に無い時刻) なら NULL */
    event_id: integer("event_id"),
    program_start_at: integer("program_start_at"),
    program_name: text("program_name").notNull().default(""),
    service_name: text("service_name").notNull().default(""),
    /** 番組の始めからの位置 (ms)。「この場面から観る」の行き先。番組が引けなければ NULL */
    offset_ms: integer("offset_ms"),
    /** 出していた字幕の文字。出していなければ空 */
    captions: text("captions").notNull().default(""),
    /**
     * 探すための文字 (番組名・局名・字幕を `title.searchable` で揃えてつないだもの)。
     * 撮ったときに作るので、探すときは SQL だけで当たる (キーセットのページがそのまま使える)
     */
    search_text: text("search_text").notNull().default(""),
    /** 画像。置き場からの相対 (`2026-10/12.avif`)。一覧用の小さいものは `-small` を足した名前 */
    file: text("file").notNull().default(""),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** 置き場で使っている大きさ (画像と一覧用の合計) */
    bytes: integer("bytes").notNull(),
  },
  (t) => [
    index("clips_taken").on(t.taken_at),
    index("clips_recording").on(t.recording_id),
    index("clips_service").on(t.service_id),
  ],
);

/** OIDC でログインした控え。Cookie に入るのは id だけで、中身はここにしかない */
export const sessions = sqliteTable(
  "sessions",
  {
    /** 推測できない文字列 (32バイト) */
    id: text("id").primaryKey(),
    /** ID トークンの sub。誰であるかはこれだけが決める */
    subject: text("subject").notNull(),
    /**
     * 誰の控えか見て分かるように。**画面には出さないし、通すかどうかも決めない**
     * (名前で決めると改名で入れなくなる。決めるのは sub とグループ)
     */
    name: text("name").notNull().default(""),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  // 切れたものを片付けるときに舐める
  (t) => [index("sessions_expires").on(t.expires_at)],
);

/**
 * **アプリに渡したアクセストークン** (device-auth.ts)。テレビのアプリ (danything/denpa-tv) などが
 * `Authorization: Bearer <アクセストークン>` で入るためのもの。
 *
 * **アクセストークンそのものは持たない。** 持つのは SHA-256 だけで、トークンは渡すときに1度だけ返す。
 * DB が漏れても、ここから入れるトークンは作れない。消さずに `revoked_at` で止める
 * (いつ・誰が許したかを設定画面に残すため)
 */
export const apiTokens = sqliteTable("api_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 端末が名乗った名前 (「居間のテレビ」など)。画面で見分けるためだけ */
  name: text("name").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  created_at: integer("created_at").notNull(),
  /** 最後に使われた時刻。1分に1度しか書かない (毎回書くと映像の Range ごとに書く) */
  last_used_at: integer("last_used_at"),
  revoked_at: integer("revoked_at"),
  /** 許した人。OIDC なら sub、信頼するネットワークから許したなら 'trusted-network' */
  created_by: text("created_by"),
});

/**
 * **ペアリングの途中** (device-auth.ts。OAuth のデバイス認可 (RFC 8628) と同じ方式)。
 *
 * 端末が持つ `device_code` は推測できない秘密で、持つのは SHA-256 だけ。QR に載る
 * `user_code` (ABCD-EFGH) は短いので、10分で切れる。開いた人が入れる人で、コードを見比べて
 * 「ペアリング」を押したら許し、端末が次に聞きに来たときにアクセストークンを作って1度だけ渡し、
 * `consumed_at` を付ける。
 * 断る手順は持たない (家で使う前提。コードは10分で切れ、1度しか使えない)
 */
export const deviceCodes = sqliteTable(
  "device_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    device_code_hash: text("device_code_hash").notNull().unique(),
    user_code: text("user_code").notNull().unique(),
    name: text("name").notNull(),
    /** コードを求めた接続元 (IPv6 は /64 にまとめる)。接続元ごとの上限に使う (`device-auth.ts`) */
    source: text("source").notNull().default(""),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    last_polled_at: integer("last_polled_at"),
    /** 許された時刻と、許した人。**アクセストークンはまだ作らない** (渡すときに作る。生のトークンを DB に置かないため) */
    approved_at: integer("approved_at"),
    approved_by: text("approved_by"),
    /** 渡したアクセストークン */
    approved_token_id: integer("approved_token_id").references(
      (): AnySQLiteColumn => apiTokens.id,
    ),
    consumed_at: integer("consumed_at"),
  },
  // 切れたものを片付けるときに舐める
  (t) => [index("device_codes_expires").on(t.expires_at)],
);
