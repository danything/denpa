/**
 * EPGStation の録画を denpa に引き継ぐ。EDCB からの引き継ぎ (`migrate-edcb.ts`) も、進み具合と
 * 記録はここのもの ({@link status}・{@link record}・{@link track}) を使う。
 *
 * 数百GBのコピーになるので、リクエストの中では終わらない。開始だけ受けて
 * 裏で進め、進捗は {@link status} から読む。入口は設定画面だけ
 * (`/settings/integrations#migrate` の「EPGStation からの引き継ぎ」)。使い方は docs/migrate.md。
 *
 * ファイルは既定でコピーする。元のPVCを消すまで EPGStation 側もそのまま動くので、
 * 取り込みが済んで中身を確認してから消せる。容量が無いときは move を使う。
 *
 * 何度実行しても同じ結果になる。取り込み済みのものは EPGStation 側のIDで判別して飛ばす。
 * ファイルを置き終えてから行を入れるので、途中で止まっても「ファイルの無い行」は残らない ({@link importOne})。
 */
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";

import { SQL } from "bun";
import { and, eq, isNull } from "drizzle-orm";

import { parseSearchFields, SEARCH_FIELDS } from "#lib/search.js";
import { array, number, read } from "#lib/shape.js";

import { toHalfWidth } from "../fold";
import type { Recording } from "../types";
import { config } from "./config";
import { now, orm } from "./db";
import { emit } from "./events";
import { type LibraryNameInput, libraryPath, recordedPath } from "./library";
import { writeThumbnail } from "./metadata";
import { reserve } from "./reservations";
import {
  programs,
  recordedHistory,
  recordings,
  rules,
  services,
} from "./schema";
import { parseTitle } from "./title";

const env = (key: string, fallback: string) => process.env[key] ?? fallback;

/**
 * EPGStation の MariaDB。**繋ぐのは bun 自身** (`Bun.SQL`)。
 *
 * `mysql2` を入れていたが、bun が MySQL を話せるので外した。使っているのは
 * **引数の無い SELECT を3本と、開いて閉じるだけ** — そのために依存を1つ
 * 抱える理由が無い。
 *
 * 読むだけで、書き込みはしない ([migrate.md](../../../docs/migrate.md))。
 */
const connectionConfig = {
  adapter: "mysql" as const,
  hostname: env("EPGSTATION_DB_HOST", "db"),
  port: Number(env("EPGSTATION_DB_PORT", "3306")),
  username: env("EPGSTATION_DB_USER", "root"),
  password: env("EPGSTATION_DB_PASSWORD", "epgstation"),
  database: env("EPGSTATION_DB_NAME", "epgstation"),
  /*
   * **繋がらないときに待たせない。**
   *
   * `Bun.SQL` は**断られても繋ぎ直しに行く**ので、宛先がいないと既定の30秒を
   * 使い切ってから諦める (`mysql2` は ECONNREFUSED をその場で返していた)。
   * 引き継ぎ元は同じクラスタの中にいるものなので、5秒あれば足りる。
   * 待たせたぶんだけ「押したのに何も起きない」時間が延びるだけ
   */
  connectionTimeout: 5,
};

export const source = {
  host: connectionConfig.hostname,
  /** EPGStation のPVCを denpa 側にマウントした場所 */
  recordedDir: env("EPGSTATION_RECORDED_DIR", "/epgstation-recorded"),
};

/** 引き継ぎ元が見えているか。マウントしていなければ設定画面から実行させない */
export function available(): boolean {
  return existsSync(source.recordedDir);
}

export interface MigrateOptions {
  /** false なら何が起きるかを出すだけでファイルもDBも触らない */
  apply: boolean;
  /** コピーではなく移動する。元のPVCに空きが無いとき用 */
  move: boolean;
}

export interface MigrateStatus extends MigrateOptions {
  state: "idle" | "running" | "done" | "failed";
  /** どこから引き継いでいるか。画面はその節にだけ進み具合を出す */
  from: "epgstation" | "edcb";
  /** 録画の対象の総数。走り出すまでは 0 */
  total: number;
  imported: number;
  skipped: number;
  missing: number;
  /** ルールと手動予約。録画と違ってファイルを触らないので、下見でも件数だけ数える */
  rules: { imported: number; skipped: number };
  reservations: { imported: number; skipped: number };
  /** 録画の履歴 (`importHistory`)。ルールと同じく、下見でも件数だけ数える */
  history: { imported: number; skipped: number };
  /** いま扱っている録画の名前 */
  current: string | null;
  /** 直近の記録。全部残すと際限が無いので後ろから 200 件だけ持つ */
  log: string[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const LOG_LIMIT = 200;

/** まっさらな進み具合。起動時と、走らせ直すたびに (`run`) この形に戻す */
function freshStatus(over: Partial<MigrateStatus> = {}): MigrateStatus {
  return {
    state: "idle",
    from: "epgstation",
    apply: false,
    move: false,
    total: 0,
    imported: 0,
    skipped: 0,
    missing: 0,
    rules: { imported: 0, skipped: 0 },
    reservations: { imported: 0, skipped: 0 },
    history: { imported: 0, skipped: 0 },
    current: null,
    log: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

let status_: MigrateStatus = freshStatus();

/** 件数を数える側 (`migrate-edcb.ts`) が書き込む、いまの進み具合そのもの */
export function counts(): Pick<
  MigrateStatus,
  "rules" | "reservations" | "history"
> {
  return status_;
}

export function status(): MigrateStatus {
  return {
    ...status_,
    log: [...status_.log],
    rules: { ...status_.rules },
    reservations: { ...status_.reservations },
    history: { ...status_.history },
  };
}

export function record(message: string): void {
  status_.log.push(message);
  if (status_.log.length > LOG_LIMIT)
    status_.log.splice(0, status_.log.length - LOG_LIMIT);
}

export interface Row {
  id: number;
  name: string;
  description: string | null;
  startAt: number;
  endAt: number;
  channelId: number | null;
  channelName: string | null;
  serviceId: number | null;
  networkId: number | null;
  filePath: string | null;
  fileType: string | null;
  fileSize: number | null;
}

/**
 * EPGStation が持つパスを、こちらから見えるパスに直す。
 * 相対パスで持っていることも絶対パスのこともあるので両方を見る。
 */
function sourcePath(filePath: string): string | null {
  const candidates = [
    join(source.recordedDir, filePath),
    ...(filePath.startsWith("/") ? [filePath] : []),
    join(source.recordedDir, filePath.split("/").pop() ?? ""),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function fetchRows(): Promise<Row[]> {
  const db = new SQL(connectionConfig);
  try {
    // EPGStation v2 のテーブル構成。エンコード済みがあればそちらを優先して取る
    const rows = (await db.unsafe(
      `SELECT r.id, r.name, r.description, r.startAt, r.endAt,
                    r.channelId, c.name AS channelName, c.serviceId, c.networkId,
                    v.filePath, v.type AS fileType, v.size AS fileSize
             FROM recorded r
             LEFT JOIN channel c ON c.id = r.channelId
             LEFT JOIN video_file v ON v.recordedId = r.id
             WHERE r.isRecording = 0
             ORDER BY r.startAt`,
    )) as Row[];
    // 1つの録画に元のTSとエンコード済みが両方あることがある。エンコード済みを優先
    const best = new Map<number, Row>();
    for (const row of rows) {
      const current = best.get(row.id);
      if (
        current === undefined ||
        (current.fileType !== "encoded" && row.fileType === "encoded")
      ) {
        best.set(row.id, row);
      }
    }
    return [...best.values()];
  } finally {
    await db.close();
  }
}

/**
 * 取り込みの途中のファイル (`.epgstation-<EPGStationのID><拡張子>.migrating`)。
 *
 * **置き場と同じフォルダに書き、写し終えてから最終の名前へ rename する。**
 * 同じファイルシステムの中なので rename は一瞬で済み、最終の名前に
 * 書きかけのものが並ぶことは無い。頭の `.` は、フォルダを辿るプレイヤーに見せないため。
 * 落ちて取り残されたものは次の実行の頭で片付ける ({@link sweepTemporaries})
 */
const TEMPORARY = /^\.epgstation-\d+\..+\.migrating$/;

function temporaryPath(
  dir: string,
  sourceId: number,
  extension: string,
): string {
  return join(dir, `.epgstation-${sourceId}${extension}.migrating`);
}

/**
 * 前の実行が取り残した書きかけを消す。
 *
 * 置き場は元のTSの置き場の直下と、保存先のシリーズのフォルダ (`libraryPath` の形式)。
 * 走るのは一度に1つだけ (`start`) なので、ここで見つかるものは誰も書いていない
 */
export function sweepTemporaries(): number {
  const dirs = [config.rawDir, config.encodedDir];
  try {
    for (const entry of readdirSync(config.encodedDir, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) dirs.push(join(config.encodedDir, entry.name));
    }
  } catch {
    // 保存先がまだ無い。書きかけも無い
  }
  let removed = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!TEMPORARY.test(name)) continue;
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * 元のファイルを書きかけの名前へ置く。
 *
 * **移動でも元はまだ消さない。** 消すのは DB に入れ終えてから (`importOne`)。
 * 先に消すと、途中で落ちたときに元も行も無くなる。同じファイルシステムなら
 * ハードリンクで済ませる (容量を食わない)。PVC をまたぐと張れないので写す。
 *
 * ハードリンクの書きかけは mtime が元のまま (古い) なので、`reconcile` の掃除
 * (書きたてかを mtime で見る) から守られない。ただしリンクを張ってから rename するまでは
 * 同期処理だけで await を挟まないので、同じプロセスの `reconcile` が割り込む余地は無い
 */
function stage(from: string, temporary: string, move: boolean): void {
  if (move) {
    try {
      linkSync(from, temporary);
      return;
    } catch {
      // EXDEV (PVCをまたぐ) など。写せば済む
    }
  }
  copyFileSync(from, temporary);
}

/** 取り込み済みの行。EPGStation 側のIDの符号を反転して program_id に入れてある */
function importedRow(sourceId: number): Recording | undefined {
  return orm()
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.program_id, -sourceId),
        isNull(recordings.reservation_id),
      ),
    )
    .get();
}

/** 行の指すファイルが1つでも実在するか */
function hasFile(recording: Recording): boolean {
  return [recording.ts_path, recording.library_path, recording.alt_path].some(
    (path) => path !== null && existsSync(path),
  );
}

/**
 * 1件を取り込む。結果は imported / skipped (取り込み済み) / missing (ファイルが無い)。
 *
 * **ファイルを置き終えてから行を入れる。** 写す → 最終の名前へ rename → DB、の順で、
 * rename と DB への書き込みを1つのトランザクションに入れる。途中で落ちても、
 * 失敗しても「ファイルの無い行」は残らない:
 *
 * - 写している途中で落ちた・失敗した … 行は無い。書きかけは消す (落ちたなら次の実行の頭で)
 * - rename したあとに DB が失敗した … 置いたファイルを消す。元はまだ残っているので、
 *   次の実行で最初からやり直せる
 *
 * **行はあるのにファイルが無いものは、取り込み済みと見なさない。** 先に行を入れていた
 * 頃の版が途中で止まると、そういう行が残っている。同じ行 (同じ録画ID) のまま置き直す。
 * ただし denpa 側で消したもの (`deleted_at`。外から消えて `reconcile` が倒したものも含む)
 * は戻さない — 消したという判断のほうを尊重する
 */
export async function importOne(
  row: Row,
  options: MigrateOptions,
): Promise<"imported" | "skipped" | "missing"> {
  const existing = importedRow(row.id);
  if (
    existing !== undefined &&
    (existing.deleted_at !== null || hasFile(existing))
  )
    return "skipped";

  if (row.filePath === null) {
    record(`ファイルが無い: ${row.name}`);
    return "missing";
  }
  const from = sourcePath(row.filePath);
  if (from === null) {
    record(`見つからない: ${row.filePath} (${row.name})`);
    return "missing";
  }

  // 番組名は EPGStation が持っていたまま (半角に寄せない。保存先の名前は `sanitizeFileName` が寄せる)
  const name = row.name;
  const verb = existing === undefined ? "取り込む" : "取り込み直す";
  record(`${options.apply ? verb : `${verb}(予定)`}: ${name}`);
  if (!options.apply) return "imported";

  const parsed = parseTitle(name);

  /*
   * 元のTSは保存先ではなく作業領域へ置く。
   *
   * EPGStation の video_file.type は 'ts'(未エンコード) か 'encoded'。
   * 元のTSを保存先に置くと denpa からは「エンコード済み」に見えてしまい、
   * 録り直せず、プレイヤーにも巨大な MPEG-2 が並ぶ。denpa 自身が録ったときと
   * 同じ形式 (元のTSは raw、完成品は encoded) に揃える
   */
  const raw = row.fileType !== "encoded";
  // 拡張子の無い名前で `lastIndexOf('.')` が -1 になると、末尾の1文字を拡張子と読んでしまう
  const extension = extname(from) || (raw ? ".m2ts" : ".mkv");
  const destination = (recording: LibraryNameInput) =>
    raw
      ? recordedPath(recording, extension)
      : libraryPath(recording, extension);

  /*
   * 最終の名前は録画IDから決まる (行を入れるまで分からない) が、置くフォルダは
   * 決まっている (元のTSの置き場の直下か、保存先のシリーズのフォルダ)。
   * そこに書きかけを作るので、あとの rename は同じファイルシステムの中で済む
   */
  const dir = dirname(
    destination(
      existing ?? {
        id: 0,
        series: parsed.series,
        subtitle: parsed.subtitle,
        start_at: Number(row.startAt),
      },
    ),
  );
  mkdirSync(dir, { recursive: true });
  const temporary = temporaryPath(dir, row.id, extension);
  rmSync(temporary, { force: true });

  // rename まで済んだら、その置き場所。DB が失敗したときに消すもの
  let placed: string | null = null;
  let to: string;
  try {
    stage(from, temporary, options.move);
    const size = statSync(temporary).size;

    // 局が分からない行 (networkId / serviceId が NULL) は照合しない。局名だけ写す
    const service =
      row.networkId === null || row.serviceId === null
        ? undefined
        : orm()
            .select({ id: services.id, name: services.name })
            .from(services)
            .where(
              and(
                eq(services.network_id, row.networkId),
                eq(services.service_id, row.serviceId),
              ),
            )
            .get();

    to = orm().transaction((tx) => {
      const at = now();
      // program_id は EPGStation のIDの符号を反転して入れる。
      // denpa の番組IDと衝突せず、二重取り込みの判定にも使える
      const recording =
        existing ??
        tx
          .insert(recordings)
          .values({
            reservation_id: null,
            program_id: -row.id,
            service_id: service?.id ?? 0,
            service_name: service?.name ?? row.channelName ?? "",
            name,
            series: parsed.series,
            subtitle: parsed.subtitle,
            description: row.description ?? "",
            start_at: Number(row.startAt),
            end_at: Number(row.endAt),
            finished_at: at,
            created_at: at,
            updated_at: at,
          })
          .returning()
          .get();
      const target = destination(recording);
      renameSync(temporary, target);
      placed = target;
      // 置き直すときは、行に残っている実体の無いパスも外す
      tx.update(recordings)
        .set({
          ts_path: raw ? target : null,
          library_path: raw ? null : target,
          alt_path: null,
          ts_size: size,
          updated_at: at,
        })
        .where(eq(recordings.id, recording.id))
        .run();
      return target;
    });
  } catch (error) {
    // 行は入っていない (トランザクションごと戻る)。置いたものも書きかけも片付けて、
    // 失敗はこれまでどおり上 (run) へ投げる。元は残っているので次の実行でやり直せる
    rmSync(temporary, { force: true });
    if (placed !== null) rmSync(placed, { force: true });
    throw error;
  }
  /*
   * 移動なら、行が入ってはじめて元を消す。
   *
   * **消せなくても取り込みは失敗にしない。** 行もファイルも揃っていて、次の実行は
   * 取り込み済みとして飛ばす。元の置き場が読み取り専用などで消せないときは、
   * 元が残ったことだけ記録に出す
   */
  if (options.move) {
    try {
      unlinkSync(from);
    } catch (error) {
      record(`取り込んだが元を消せなかった: ${from} (${String(error)})`);
    }
  }

  // サムネイルは保存先に置いたものにだけ付ける。作業領域は画面に出ない
  if (!raw) {
    await writeThumbnail(to, (Number(row.endAt) - Number(row.startAt)) / 1000);
  }
  return "imported";
}

/** 引き継ぎ元での識別子 (`rules.source`) で、もう取り込んだルールか。EDCB の取り込みも使う */
export function ruleImported(source: string): boolean {
  return (
    orm()
      .select({ id: rules.id })
      .from(rules)
      .where(eq(rules.source, source))
      .get() !== undefined
  );
}

/** 同じく、もう取り込んだ録画の履歴か (`recorded_history.source`) */
export function historyImported(source: string): boolean {
  return (
    orm()
      .select({ id: recordedHistory.id })
      .from(recordedHistory)
      .where(eq(recordedHistory.source, source))
      .get() !== undefined
  );
}

interface RuleRow {
  id: number;
  keyword: string | null;
  ignoreKeyword: string | null;
  GR: number;
  BS: number;
  CS: number;
  SKY: number;
  channelIds: string | null;
  genres: string | null;
  isFree: number;
  enable: number;
  isTimeSpecification: number;
  /** キーワードを当てる範囲。EPGStation も同じ3つを持っている */
  name: number;
  description: number;
  extended: number;
  /** 録画済みの重複番組を除く。denpa の「同じ回は最初の放送だけ」に写す */
  avoidDuplicate: number;
  /** 時間帯と曜日 (`[{ start, range, week }]` の JSON)。{@link parseTimes} */
  times: string | null;
}

interface ReserveRow {
  programId: number | null;
  ruleId: number | null;
  startAt: number;
  endAt: number;
  name: string | null;
}

/**
 * EPGStation のチャンネルIDは networkId * 100000 + serviceId — denpa の局の内部ID
 * (`tuner.serviceKey`) と作り方が同じなので、そのまま引ける。知らない局なら undefined
 */
function serviceIdFor(channelId: number): number | undefined {
  return orm()
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, channelId))
    .get()?.id;
}

/**
 * EPGStation のジャンル指定を denpa の書き方に直す。
 *
 * 向こうは `[{ "genre": 7, "subGenre": 0 }]`。subGenre は**あったり無かったり**で、
 * 「アニメ全部」なら大分類だけになる。denpa は文字列で `"7"`(大分類だけ)と
 * `"7-0"`(中分類まで)を持つので、そこへ写す。
 *
 * 数字でないものは捨てる。ここで素通しすると、画面のジャンル欄に
 * 引ける名前の無い値が並ぶことになる。
 */
export function parseGenres(json: string | null): string[] {
  if (json === null || json === "") return [];
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        // 昔の形式で数値の配列になっていることもある
        if (typeof item === "number")
          return Number.isInteger(item) ? String(item) : null;
        if (item === null || typeof item !== "object") return null;
        const { genre, subGenre } = item as {
          genre?: unknown;
          subGenre?: unknown;
        };
        if (typeof genre !== "number" || !Number.isInteger(genre)) return null;
        return typeof subGenre === "number" && Number.isInteger(subGenre)
          ? `${genre}-${subGenre}`
          : String(genre);
      })
      .filter((value): value is string => value !== null);
  } catch {
    return [];
  }
}

/** EPGStation の時間帯と曜日を denpa の列にしたもの ({@link parseTimes}) */
export interface EpgTimes {
  time_from: number | null;
  time_to: number | null;
  weekdays: number[] | null;
}

/**
 * EPGStation の時間帯と曜日 (`rule.times`) を denpa の書き方に直す。
 *
 * 向こうは `[{ "start": 19, "range": 2, "week": 32 }]` の並びで、どれかに当たれば当たる (OR)。
 *
 * - `start` は始まる時刻 (時、0〜23)、`range` はそこからの長さ (時)。番組の始まる時刻の「時」が
 *   `start` 〜 `start + range - 1` (24 で回る) なら当たる。denpa の `start:00` 以上 `(start + range):00` 未満と同じ。
 *   どちらか無ければ時刻では絞らない。24 時間以上も絞らないのと同じ
 * - `week` は曜日のビット (0x01 が日曜〜0x40 が土曜)。番組の始まる日の曜日で見る (denpa と同じ)。
 *   0 の行は向こうも飛ばす
 *
 * denpa のルールは時間帯を1つしか持てない。時刻の同じ行は曜日を足してまとめ、時刻の違う行が
 * 残れば写せないので null を返す (飛ばして記録に残す)。時刻指定のルール (`isTimeSpecification`) の
 * `times` は秒で書かれた別物なので、ここには来ない
 */
export function parseTimes(json: string | null): EpgTimes | null {
  const anytime = { time_from: null, time_to: null, weekdays: null };
  if (json === null || json === "") return anytime;
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return anytime;
  }
  if (!Array.isArray(list)) return anytime;
  /** 時間帯ごとの曜日。鍵は始まりと終わりの分 (時刻で絞らないものは `null:null`) */
  const windows = new Map<
    string,
    { from: number | null; to: number | null; days: Set<number> }
  >();
  for (const item of list as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const { start, range, week } = item as Record<string, unknown>;
    if (typeof week !== "number" || (week & 0x7f) === 0) continue;
    const timed =
      typeof start === "number" &&
      typeof range === "number" &&
      Number.isInteger(start) &&
      Number.isInteger(range) &&
      start >= 0 &&
      start < 24 &&
      range > 0 &&
      range < 24;
    const from = timed ? start * 60 : null;
    const to = timed ? ((start + range) % 24) * 60 : null;
    const key = `${from}:${to}`;
    const entry = windows.get(key) ?? { from, to, days: new Set<number>() };
    for (let day = 0; day < 7; day++)
      if (week & (1 << day)) entry.days.add(day);
    windows.set(key, entry);
  }
  const [slot, ...rest] = windows.values();
  if (slot === undefined) return anytime;
  if (rest.length > 0) return null;
  return {
    time_from: slot.from,
    time_to: slot.to,
    weekdays:
      slot.days.size === 7 ? null : [...slot.days].sort((a, b) => a - b),
  };
}

/**
 * 自動予約ルールを引き継ぐ。
 *
 * EPGStation のルールには denpa に無い項目(正規表現、時刻指定、録画先の指定、
 * 重複を避ける期間、2つ以上の時間帯など)がある。落ちるものは落ちると分かるように記録に残す。
 * 重複を避ける (`avoidDuplicate`) は「同じ回は最初の放送だけ」に写す — 引き継いだ録画の履歴と合わせて、
 * EPGStation で録っていた回をそのまま避ける
 * 時間帯と曜日 (`times`) は denpa の時間帯と曜日に写す ({@link parseTimes})。
 * 時刻指定のルールは番組を探すのではなく時計で録るもので、denpa に対応がないので飛ばす。
 */
async function importRules(
  connection: SQL,
  options: MigrateOptions,
): Promise<void> {
  const rows = (await connection.unsafe(
    `SELECT id, keyword, ignoreKeyword, GR, BS, CS, SKY, channelIds, genres,
                isFree, enable, isTimeSpecification, name, description, extended,
                avoidDuplicate, times
         FROM rule ORDER BY id`,
  )) as RuleRow[];

  for (const row of rows) {
    const source = `epgstation:${row.id}`;
    if (ruleImported(source)) {
      status_.rules.skipped++;
      continue;
    }
    if (row.isTimeSpecification) {
      record(`時刻指定のルールは取り込めません: #${row.id}`);
      status_.rules.skipped++;
      continue;
    }

    const keyword = toHalfWidth(row.keyword ?? "").trim();
    const types = (["GR", "BS", "CS", "SKY"] as const).filter(
      (t) => row[t] === 1,
    );
    const genreIds = parseGenres(row.genres);
    const times = parseTimes(row.times);
    if (times === null) {
      record(`時間帯が2つ以上あるので取り込めません: #${row.id}`);
      status_.rules.skipped++;
      continue;
    }

    let channels: number[] = [];
    if (row.channelIds !== null) {
      try {
        channels = read(
          array(number),
          JSON.parse(row.channelIds),
          "EPGStation の channelIds",
        )
          .map(serviceIdFor)
          .filter((id): id is number => id !== undefined);
      } catch {
        channels = [];
      }
    }

    if (
      keyword === "" &&
      types.length === 0 &&
      genreIds.length === 0 &&
      channels.length === 0
    ) {
      // 条件が空だと全番組にマッチしてしまう。EPGStation 側で他の条件 (正規表現など) だけで
      // 絞っていたものがここに来る。時間帯と曜日は絞り込みなので、それだけのルールもここに来る
      record(`条件が空になるので取り込めません: #${row.id}`);
      status_.rules.skipped++;
      continue;
    }

    const name = keyword !== "" ? keyword : `EPGStation #${row.id}`;
    record(`${options.apply ? "ルール" : "ルール(予定)"}: ${name}`);
    if (!options.apply) {
      status_.rules.imported++;
      continue;
    }

    // エンコード方法は引き継がない。エンコードもCMも全体設定で、エンコードするときに読む
    orm()
      .insert(rules)
      .values({
        name,
        keyword,
        ignore_keyword: toHalfWidth(row.ignoreKeyword ?? "").trim(),
        // 当てる範囲も向こうから引き継ぐ。既定に寄せると黙って当たらなくなる
        search_fields: parseSearchFields(
          SEARCH_FIELDS.filter((field) => row[field] === 1).join(","),
        ).join(","),
        service_ids: channels.length === 0 ? null : channels,
        service_types: types.length === 0 ? null : types,
        genres: genreIds.length === 0 ? null : genreIds,
        ...times,
        enabled: Boolean(row.enable),
        // 重複を避ける期間 (periodToAvoidDuplicate) は写さない。denpa は録画と引き継いだ履歴で見る
        dedupe: Boolean(row.avoidDuplicate),
        priority: 1,
        source,
        created_at: now(),
      })
      .run();
    status_.rules.imported++;
  }
}

/**
 * 手で入れた予約だけ引き継ぐ。
 *
 * ルール由来の予約は、ルールを取り込んだあとに denpa が自分で立て直すので触らない。
 * EPGStation の programId は denpa の番組ID (`programKey`) と作り方が同じなので、直に照合できる。
 */
async function importReservations(
  connection: SQL,
  options: MigrateOptions,
): Promise<void> {
  const rows = (await connection.unsafe(
    `SELECT programId, ruleId, startAt, endAt, name
         FROM reserve WHERE ruleId IS NULL AND isSkip = 0 ORDER BY startAt`,
  )) as ReserveRow[];

  const at = now();
  for (const row of rows) {
    if (row.programId === null || row.endAt <= at) {
      status_.reservations.skipped++;
      continue;
    }
    const program = orm()
      .select({ id: programs.id })
      .from(programs)
      .where(eq(programs.id, row.programId))
      .get();
    if (program === undefined) {
      // 番組表を取り込む前だと出る。EPG を取り直してからもう一度実行すれば入る
      record(
        `番組表に無いので取り込めません: ${row.name ?? String(row.programId)}`,
      );
      status_.reservations.skipped++;
      continue;
    }

    record(`${options.apply ? "予約" : "予約(予定)"}: ${row.name ?? ""}`);
    if (options.apply) await reserve(program.id);
    status_.reservations.imported++;
  }
}

/** EPGStation の `recorded_history` の1行。`channelId` と `endAt` は bigint なので、文字で来ることがある */
export interface HistoryRow {
  id: number;
  name: string;
  channelId: number | string | null;
  channelName: string | null;
  endAt: number | string;
}

/**
 * **録画の履歴を引き継ぐ** (EPGStation の `recorded_history`)。
 *
 * EPGStation は録画を消しても、ルールで録った番組の名前・局・終わりの時刻をここに残している
 * (既定で 90 日。向こうの設定の `recordedHistoryRetentionPeriodDays`)。これを「録ったことのある回」の
 * 控え (`schema.recordedHistory`) に入れると、ルールの「同じ回は最初の放送だけ」と「前の回は録らない」が見て、
 * EPGStation で録った回を録り直さない。録画の行にはしない (ファイルが無い)。
 *
 * 表が無ければ (古い版など) 記録に残して先へ進む。録画とルールの引き継ぎは止めない。
 * 繋がらないときはここで投げる (ルールと同じく、走らせ直してもらう)
 */
async function importHistory(
  connection: SQL,
  options: MigrateOptions,
): Promise<void> {
  const tables = (await connection.unsafe(
    `SHOW TABLES LIKE 'recorded_history'`,
  )) as unknown[];
  if (tables.length === 0) {
    record("録画の履歴 (recorded_history) が無いので飛ばします");
    return;
  }
  const rows = (await connection.unsafe(
    `SELECT h.id, h.name, h.channelId, c.name AS channelName, h.endAt
         FROM recorded_history h
         LEFT JOIN channel c ON c.id = h.channelId
         ORDER BY h.id`,
  )) as HistoryRow[];
  importHistoryRows(rows, options);
}

/**
 * 読んだ履歴を控えに入れる。**取り込み済みは EPGStation 側のIDで判別して飛ばす** (`source`。ルールと同じ)。
 * 局の名前は denpa の局から引き (`serviceIdFor` と同じく、チャンネルIDがそのまま局の内部ID)、
 * 知らない局なら EPGStation の名前を写す
 */
export function importHistoryRows(
  rows: HistoryRow[],
  options: MigrateOptions,
): void {
  for (const row of rows) {
    const source = `epgstation:${row.id}`;
    if (historyImported(source)) {
      status_.history.skipped++;
      continue;
    }
    if (!options.apply) {
      status_.history.imported++;
      continue;
    }
    const service =
      row.channelId === null
        ? undefined
        : orm()
            .select({ name: services.name })
            .from(services)
            .where(eq(services.id, Number(row.channelId)))
            .get();
    orm()
      .insert(recordedHistory)
      .values({
        name: row.name,
        service_name: service?.name ?? row.channelName ?? "",
        end_at: Number(row.endAt),
        source,
      })
      .onConflictDoNothing()
      .run();
    status_.history.imported++;
  }
}

/** 走っているか。走っている間は、どちらの引き継ぎも始めさせない (同じ進み具合を使うため) */
export function running(): boolean {
  return status_.state === "running";
}

/**
 * 引き継ぎを1回走らせる。進み具合をまっさらに戻して `body` を回し、終わりと失敗を進み具合に書く。
 * 失敗は投げずに `failed` と理由で残す (画面からは待たずに呼ぶので、受け取る相手がいない)
 */
export async function track(
  from: MigrateStatus["from"],
  options: MigrateOptions,
  body: () => Promise<void>,
): Promise<void> {
  status_ = freshStatus({
    state: "running",
    from,
    apply: options.apply,
    move: options.move,
    startedAt: Date.now(),
  });
  emit("migrate");
  try {
    await body();
    status_.current = null;
    status_.state = "done";
  } catch (error) {
    status_.state = "failed";
    status_.error = String(error);
    record(`失敗: ${status_.error}`);
  }
  status_.finishedAt = Date.now();
  emit("migrate");
}

/** 録画の履歴・ルール・予約の件数を1行で記録に残す */
export function recordCounts(): void {
  record(
    `録画の履歴 取り込み ${status_.history.imported} 件 / 取り込み済み ${status_.history.skipped} 件、` +
      `ルール 取り込み ${status_.rules.imported} 件 / 対象外 ${status_.rules.skipped} 件、` +
      `予約 取り込み ${status_.reservations.imported} 件 / 対象外 ${status_.reservations.skipped} 件`,
  );
  emit("migrate");
}

/**
 * 取り込みを走らせる。進捗は {@link status} に入る。
 * 画面からは待たずに呼ぶ (`start`)
 */
function run(options: MigrateOptions): Promise<void> {
  return track("epgstation", options, async () => {
    // ルールと手動予約を先に入れる。録画のコピーは時間がかかるので、
    // 先にこちらを済ませておけば途中で止めても予約は動き出す。
    // 録画の履歴はルールより前に入れる — ルールが当たり出したときに、もう録った回を予約しないように
    const connection = new SQL(connectionConfig);
    try {
      await importHistory(connection, options);
      await importRules(connection, options);
      await importReservations(connection, options);
    } finally {
      await connection.close();
    }
    recordCounts();

    if (options.apply) {
      const swept = sweepTemporaries();
      if (swept > 0) record(`前の実行の書きかけを片付けました: ${swept} 件`);
    }

    const rows = await fetchRows();
    status_.total = rows.length;
    record(`対象 ${rows.length} 件`);
    emit("migrate");

    for (const row of rows) {
      status_.current = row.name;
      const result = await importOne(row, options);
      status_[result]++;
      emit("migrate");
    }
  });
}

/**
 * 設定画面から呼ぶ入口。走り出したことだけ返し、終わるのは待たない。
 * 二重に走ると同じファイルを2つのコピーが触るので、走っている間は断る。
 */
export function start(options: MigrateOptions): {
  started: boolean;
  message: string;
} {
  if (running()) {
    return { started: false, message: "すでに実行中です" };
  }
  if (!available()) {
    return {
      started: false,
      message: `引き継ぎ元 ${source.recordedDir} が見つかりません。EPGStation のPVCをマウントしてください`,
    };
  }
  void run(options);
  return {
    started: true,
    message: options.apply ? "取り込みを開始しました" : "下見を開始しました",
  };
}
