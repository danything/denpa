/**
 * EPGStation (v2・v3) の録画・ルール・手動予約を、**HTTP API だけで** denpa に引き継ぐ (読み方は
 * `epgstation-api.ts`)。EDCB からの引き継ぎ (`migrate-edcb.ts`) も、進み具合と記録 ({@link status}・
 * {@link record}・{@link track}) と、ルール・予約・履歴の入れ方 ({@link insertRule}・{@link importReservation}・
 * {@link addHistory}・{@link SlotWindows}) はここのものを使う。
 *
 * 数百GBを取ってくるので、リクエストの中では終わらない。開始だけ受けて裏で進め、進み具合は
 * {@link status} から読む。入口は設定画面だけ (`/settings/integrations#migrate` の「EPGStation からの引き継ぎ」)。
 * 使い方は docs/migrate.md。
 *
 * EPGStation 側のファイルは消さない (取ってくるだけ)。元を消すのは、denpa 側で中身を確かめてから
 * EPGStation 側でしてもらう。
 *
 * 何度実行しても同じ結果になる。取り込み済みのものは EPGStation 側のIDで判別して飛ばす。
 * ファイルを置き終えてから行を入れるので、途中で止まっても「ファイルの無い行」は残らない ({@link importOne})。
 * 止まった取り込みの書きかけは次の実行で続きから取る (`downloadVideo`)。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";

import { and, eq, isNull } from "drizzle-orm";

import { parseSearchFields, SEARCH_FIELDS } from "#lib/search.js";

import { toHalfWidth } from "../fold";
import { size as formatSize } from "../format";
import type { Slot } from "../rule-time";
import type { Recording } from "../types";
import { config } from "./config";
import { now, orm } from "./db";
import { freeBytes } from "./disk";
import {
  downloadVideo,
  EpgstationClient,
  type EpgstationRecorded,
  type EpgstationReserve,
  type EpgstationRule,
  type EpgstationVersion,
  isId,
  isObject,
  parseSource,
} from "./epgstation-api";
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

export interface MigrateOptions {
  /** false なら何が起きるかを出すだけでファイルもDBも触らない */
  apply: boolean;
}

export interface MigrateStatus extends MigrateOptions {
  /** `canceled` は「中断」で止めたとき。書きかけは残っていて、次の実行で続きから取る */
  state: "idle" | "running" | "done" | "failed" | "canceled";
  /** どこから引き継いでいるか。画面はその節にだけ進み具合を出す */
  from: "epgstation" | "edcb";
  /** 録画の対象の総数。走り出すまでは 0 */
  total: number;
  imported: number;
  skipped: number;
  missing: number;
  /** 取れなかった・長さが合わなかった録画。ほかの録画は続ける */
  failed: number;
  /** 取ってくる合計と、取ったぶん (書きかけにあったぶんも含む) */
  bytesDone: number;
  bytesTotal: number;
  /** いま取っているファイルの、取ったぶんと大きさ */
  currentDone: number;
  currentTotal: number;
  /** ルールと手動予約。録画と違ってファイルを触らないので、下見でも件数だけ数える */
  rules: { imported: number; skipped: number };
  reservations: { imported: number; skipped: number };
  /** 録画の履歴 (`addHistory`)。ルールと同じく、下見でも件数だけ数える */
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

/** まっさらな進み具合。起動時と、走らせ直すたびに (`track`) この形に戻す */
function freshStatus(over: Partial<MigrateStatus> = {}): MigrateStatus {
  return {
    state: "idle",
    from: "epgstation",
    apply: false,
    total: 0,
    imported: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
    bytesDone: 0,
    bytesTotal: 0,
    currentDone: 0,
    currentTotal: 0,
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

/** 入れるもの1件を記録に残す。下見なら `(予定)` を付ける */
export function recordPlan(
  options: MigrateOptions,
  label: string,
  name: string,
): void {
  record(`${options.apply ? label : `${label}(予定)`}: ${name}`);
}

/** 最後に知らせた時刻。バイトの進み具合は細かく動くので、知らせるのは1秒に1回まで */
let lastEmit = 0;

function emitThrottled(): void {
  const at = Date.now();
  if (at - lastEmit < 1000) return;
  lastEmit = at;
  emit("migrate");
}

/** 真偽。形がずれて 0/1 で来ても読む (`tolerate` は来たものをそのまま通す) */
const flag = (value: unknown): boolean => value === true || value === 1;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * 取り込みの途中のファイル (`.epgstation-<EPGStationのID><拡張子>.migrating`)。
 *
 * **置き場と同じフォルダに書き、取り終えて確かめてから最終の名前へ rename する。**
 * 同じファイルシステムの中なので rename は一瞬で済み、最終の名前に
 * 書きかけのものが並ぶことは無い。頭の `.` は、フォルダを辿るプレイヤーに見せないため。
 * 止まって残ったものは次の実行で続きから取る。もう対象に無いものだけ片付ける ({@link sweepTemporaries})
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
 * 書きかけのうち、`keep` に無いもの (もう対象に無い・取り込み済みになった) を消す。
 *
 * 置き場は元のTSの置き場の直下と、保存先のシリーズのフォルダ (`libraryPath` の形式)。
 * 走るのは一度に1つだけ (`start`) なので、ここで見つかるものは誰も書いていない
 */
export function sweepTemporaries(
  keep: ReadonlySet<string> = new Set(),
): number {
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
      const path = join(dir, name);
      if (!TEMPORARY.test(name) || keep.has(path)) continue;
      rmSync(path, { force: true });
      removed++;
    }
  }
  return removed;
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
  return [
    recording.ts_path,
    recording.library_path,
    recording.hevc_path,
    recording.alt_path,
  ].some((path) => path !== null && existsSync(path));
}

/**
 * 取り込み済みと見なすか。**行はあるのにファイルが無いものは見なさない** (先に行を入れていた頃の
 * バージョンが途中で止まった跡。同じ行のまま置き直す)。denpa 側で消したもの (`deleted_at`) は戻さない
 */
function alreadyImported(existing: Recording | undefined): boolean {
  return (
    existing !== undefined &&
    (existing.deleted_at !== null || hasFile(existing))
  );
}

/** 取ってくるファイル。エンコード済みがあればそちら、複数あれば最初のもの */
export interface VideoChoice {
  id: number;
  size: number;
  /** 元のTSか (`type` がエンコード済みでない)。元のTSは作業領域へ置く */
  raw: boolean;
  extension: string;
}

export function chooseFile(recorded: EpgstationRecorded): VideoChoice | null {
  const files = list(recorded.videoFiles).filter(
    (file): file is Record<string, unknown> & { id: number; size: number } =>
      isObject(file) && isId(file["id"]) && isId(file["size"]),
  );
  const file =
    files.find((item) => item["type"] === "encoded") ?? files[0] ?? null;
  if (file === null) return null;
  const raw = file["type"] !== "encoded";
  return {
    id: file.id,
    size: file.size,
    raw,
    // 拡張子の無い名前で `lastIndexOf('.')` が -1 になると、末尾の1文字を拡張子と読んでしまう
    extension: extname(text(file["filename"])) || (raw ? ".m2ts" : ".mkv"),
  };
}

/** 置き場所。最終の名前は録画IDから決まる (行を入れるまで分からない) が、置くフォルダは決まっている */
function placement(
  recorded: EpgstationRecorded,
  file: VideoChoice,
  existing: Recording | undefined,
) {
  const parsed = parseTitle(recorded.name);
  /*
   * 元のTSは保存先ではなく作業領域へ置く。
   *
   * EPGStation のファイルの type は 'ts'(未エンコード) か 'encoded'。
   * 元のTSを保存先に置くと denpa からは「エンコード済み」に見えてしまい、
   * 録り直せず、プレイヤーにも巨大な MPEG-2 が並ぶ。denpa 自身が録ったときと
   * 同じ形式 (元のTSは raw、完成品は encoded) に揃える
   */
  const destination = (recording: LibraryNameInput) =>
    file.raw
      ? recordedPath(recording, file.extension)
      : libraryPath(recording, file.extension);
  const dir = dirname(
    destination(
      existing ?? {
        id: 0,
        series: parsed.series,
        subtitle: parsed.subtitle,
        start_at: recorded.startAt,
      },
    ),
  );
  return {
    parsed,
    destination,
    dir,
    temporary: temporaryPath(dir, recorded.id, file.extension),
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** EPGStation の局の名前 (`/channels`)。知らない局の名前を写すのに使う */
type ChannelNames = ReadonlyMap<number, string>;

/** {@link importOne} が要るもの。取るのに使う相手・EPGStation の局の名前・止めるための signal */
interface ImportContext {
  client: EpgstationClient;
  channels: ChannelNames;
  signal: AbortSignal;
}

/**
 * 1件を取り込む。結果は imported / skipped (取り込み済み) / missing (ファイルが無い)。取れなければ投げる。
 *
 * **ファイルを置き終えてから行を入れる。** 取る (`downloadVideo`。続きから・長さを確かめる) →
 * 最終の名前へ rename → DB、の順で、rename と DB への書き込みを1つのトランザクションに入れる。
 * 途中で止まっても、失敗しても「ファイルの無い行」は残らない:
 *
 * - 取っている途中で止まった・中断した … 行は無い。書きかけは残し、次の実行で続きから取る
 * - 長さが合わない … 行は無い。書きかけも消す (`downloadVideo`)
 * - rename したあとに DB が失敗した … 置いたファイルを書きかけの名前へ戻す。次の実行は取り直さずに入れる
 *
 * **行はあるのにファイルが無いものは、取り込み済みと見なさない** ({@link alreadyImported})
 */
async function importOne(
  recorded: EpgstationRecorded,
  options: MigrateOptions,
  context: ImportContext,
): Promise<"imported" | "skipped" | "missing"> {
  const existing = importedRow(recorded.id);
  if (alreadyImported(existing)) return "skipped";

  const file = chooseFile(recorded);
  if (file === null) {
    record(`ファイルが無い: ${recorded.name}`);
    return "missing";
  }

  // 番組名は EPGStation が持っていたまま (半角に寄せない。保存先の名前は `sanitizeFileName` が寄せる)
  const name = recorded.name;
  recordPlan(
    options,
    existing === undefined ? "取り込む" : "取り込み直す",
    name,
  );
  if (!options.apply) return "imported";

  const { parsed, destination, dir, temporary } = placement(
    recorded,
    file,
    existing,
  );
  mkdirSync(dir, { recursive: true });

  status_.currentDone = 0;
  status_.currentTotal = file.size;
  const result = await downloadVideo(
    context.client,
    file.id,
    file.size,
    temporary,
    context.signal,
    (bytes) => {
      status_.currentDone += bytes;
      status_.bytesDone += bytes;
      emitThrottled();
    },
  );
  if (result === "missing") {
    rmSync(temporary, { force: true });
    // 取るはずだった大きさから外す (進み具合が合計に届かないまま終わらないように)
    status_.bytesTotal -= file.size;
    record(`EPGStation にファイルが無い (404): ${name}`);
    return "missing";
  }

  // 局は denpa の局から引く (EPGStation のチャンネルIDは denpa の局IDと作り方が同じ)。知らない局なら名前だけ写す
  const channelId = isId(recorded.channelId) ? recorded.channelId : null;
  const service = channelId === null ? undefined : serviceById(channelId);
  const extended = isObject(recorded.rawExtended)
    ? Object.fromEntries(
        Object.entries(recorded.rawExtended).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

  // rename まで済んだら、その置き場所。DB が失敗したときに書きかけの名前へ戻す
  let placed: string | null = null;
  let to: string;
  try {
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
            program_id: -recorded.id,
            service_id: service?.id ?? 0,
            service_name:
              service?.name ??
              (channelId === null
                ? ""
                : (context.channels.get(channelId) ?? "")),
            name,
            series: parsed.series,
            subtitle: parsed.subtitle,
            description: text(recorded.description),
            extended: Object.keys(extended).length === 0 ? null : extended,
            start_at: recorded.startAt,
            end_at: recorded.endAt,
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
          ts_path: file.raw ? target : null,
          library_path: file.raw ? null : target,
          hevc_path: null,
          alt_path: null,
          ts_size: file.size,
          updated_at: at,
        })
        .where(eq(recordings.id, recording.id))
        .run();
      return target;
    });
  } catch (error) {
    // 行は入っていない (トランザクションごと戻る)。置いたものは書きかけの名前へ戻し、次の実行で取り直さずに入れる
    if (placed !== null) renameSync(placed, temporary);
    throw error;
  }

  // サムネイルは保存先に置いたものにだけ付ける。作業領域は画面に出ない
  if (!file.raw) {
    await writeThumbnail(to, (recorded.endAt - recorded.startAt) / 1000);
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
function historyImported(source: string): boolean {
  return (
    orm()
      .select({ id: recordedHistory.id })
      .from(recordedHistory)
      .where(eq(recordedHistory.source, source))
      .get() !== undefined
  );
}

/**
 * 局の内部ID (`tuner.serviceKey`) で denpa の局を引く。知らない局なら undefined。
 * EPGStation のチャンネルIDは内部IDと作り方が同じなのでそのまま、EDCB は ONID・SID から作って渡す
 */
export function serviceById(
  id: number,
): { id: number; name: string } | undefined {
  return orm()
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(eq(services.id, id))
    .get();
}

/** 引き継いだルールの値。優先度・`source`・作った時刻は {@link insertRule} が足す */
type RuleValues = Omit<
  typeof rules.$inferInsert,
  "priority" | "source" | "created_at"
>;

/**
 * 引き継いだルールを入れる。**優先度は 1** (引き継ぎ元の優先度は比べる相手が違う)。
 * エンコードの設定は写さない — エンコードもCMも全体設定で、エンコードするときに読む
 */
export function insertRule(values: RuleValues, source: string): void {
  orm()
    .insert(rules)
    .values({ ...values, priority: 1, source, created_at: now() })
    .run();
}

/**
 * 録画の履歴を1件入れる。**`sources` のどれかで取り込み済みなら飛ばす** (入れるときの `source` は先頭)。
 * 局の名前は denpa の局から引き、知らない局なら引き継ぎ元の名前 (`serviceName`) を写す。
 * 下見なら件数だけ数える
 */
export function addHistory(
  entry: {
    sources: readonly [string, ...string[]];
    name: string;
    serviceId: number | null;
    serviceName: string;
    endAt: number;
  },
  options: MigrateOptions,
): void {
  if (entry.sources.some(historyImported)) {
    status_.history.skipped++;
    return;
  }
  status_.history.imported++;
  if (!options.apply) return;
  const service =
    entry.serviceId === null ? undefined : serviceById(entry.serviceId);
  orm()
    .insert(recordedHistory)
    .values({
      name: entry.name,
      service_name: service?.name ?? entry.serviceName,
      end_at: entry.endAt,
      source: entry.sources[0],
    })
    .onConflictDoNothing()
    .run();
}

/**
 * EPGStation のジャンル指定 (`searchOption.genres`) を denpa の書き方に直す。
 *
 * 向こうは `[{ "genre": 7, "subGenre": 0 }]`。subGenre は**あったり無かったり**で、
 * 「アニメ全部」なら大分類だけになる。denpa は文字列で `"7"`(大分類だけ)と
 * `"7-0"`(中分類まで)を持つので、そこへ写す。
 *
 * 数字でないものは捨てる。ここで素通しすると、画面のジャンル欄に
 * 引ける名前の無い値が並ぶことになる。配列でなければ空 (形がずれていても止めない)
 */
export function parseGenres(value: unknown): string[] {
  return list(value)
    .map((item) => {
      // 昔の形式で数値の配列になっていることもある
      if (typeof item === "number")
        return Number.isInteger(item) ? String(item) : null;
      if (!isObject(item)) return null;
      const { genre, subGenre } = item;
      if (!isId(genre)) return null;
      return isId(subGenre) ? `${genre}-${subGenre}` : String(genre);
    })
    .filter((item): item is string => item !== null);
}

/**
 * **時間帯ごとに曜日を集めて、ルールの時間帯と曜日 (`rule-time.Slot`) 1つにまとめる。**
 * EPGStation ({@link parseTimes}) と EDCB (`migrate-edcb.parseDateList`) の時間帯を写すのに使う。
 *
 * denpa のルールは時間帯を1つしか持てない。時刻の同じものは曜日を足してまとめ、
 * 時刻の違うものが残れば写せない ({@link slot} が null)
 */
export class SlotWindows {
  /** キーは始まりと終わりの分 (時刻で絞らないものは `null:null`) */
  private readonly windows = new Map<
    string,
    { from: number | null; to: number | null; days: Set<number> }
  >();

  add(from: number | null, to: number | null, days: Iterable<number>): void {
    const key = `${from}:${to}`;
    const entry = this.windows.get(key) ?? { from, to, days: new Set() };
    for (const day of days) entry.days.add(day);
    this.windows.set(key, entry);
  }

  /** まとめた時間帯と曜日。何も無ければいつでも、時刻の違うものが2つ以上なら null。7日そろえば毎日 */
  slot(): Slot | null {
    const [only, ...rest] = this.windows.values();
    if (only === undefined)
      return { time_from: null, time_to: null, weekdays: null };
    if (rest.length > 0) return null;
    return {
      time_from: only.from,
      time_to: only.to,
      weekdays:
        only.days.size === 7 ? null : [...only.days].sort((a, b) => a - b),
    };
  }
}

/**
 * EPGStation の時間帯と曜日 (`searchOption.times`) を denpa の書き方に直す。
 *
 * 向こうは `[{ "start": 19, "range": 2, "week": 32 }]` の並びで、どれかに当たれば当たる (OR)。
 *
 * - `start` は始まる時刻 (時、0〜23)、`range` はそこからの長さ (時)。番組の始まる時刻の「時」が
 *   `start` 〜 `start + range - 1` (24 で回る) なら当たる。denpa の `start:00` 以上 `(start + range):00` 未満と同じ。
 *   どちらか無ければ時刻では絞らない。24 時間以上も絞らないのと同じ
 * - `week` は曜日のビット (0x01 が日曜〜0x40 が土曜)。番組の始まる日の曜日で見る (denpa と同じ)。
 *   0 の行は向こうも飛ばす
 *
 * 時刻の同じ行は曜日をまとめ、時刻の違う行が残れば写せないので null を返す (飛ばして記録に残す。{@link SlotWindows})。
 * 時刻指定のルール (`isTimeSpecification`) の `times` は秒で書かれた別物なので、ここには来ない
 */
export function parseTimes(value: unknown): Slot | null {
  const windows = new SlotWindows();
  for (const item of list(value)) {
    if (!isObject(item)) continue;
    const { start, range, week } = item;
    if (typeof week !== "number" || (week & 0x7f) === 0) continue;
    const timed =
      isId(start) &&
      isId(range) &&
      start >= 0 &&
      start < 24 &&
      range > 0 &&
      range < 24;
    windows.add(
      timed ? start * 60 : null,
      timed ? ((start + range) % 24) * 60 : null,
      [0, 1, 2, 3, 4, 5, 6].filter((day) => week & (1 << day)),
    );
  }
  return windows.slot();
}

/**
 * ルール1つを denpa のルールに写す。写せなければ `skip` に理由。写したが変わったところは `notes`。
 *
 * EPGStation のルールには denpa に無い条件がある。**写すと当たる番組が変わるものは飛ばす** (EDCB と同じ):
 * 時刻指定・正規表現・番組の長さ・検索期間・2つ以上の時間帯・denpa に無い局だけのもの・BS4K だけのもの。
 * 大文字と小文字の区別・無料放送だけは普通に取り込んでログに残す。v3 の BS4K は denpa に無いので種別から外す。
 *
 * 重複を避ける (`avoidDuplicate`) は「同じ回は最初の放送だけ」に写す — 引き継いだ録画の履歴と合わせて、
 * EPGStation で録っていた回をそのまま避ける。時間帯と曜日 (`times`) は {@link parseTimes}
 */
export function convertRule(
  rule: EpgstationRule,
  serviceOf: (id: number) => number | undefined,
): { skip: string } | { values: RuleValues; notes: string[] } {
  const search: Record<string, unknown> = isObject(rule.searchOption)
    ? rule.searchOption
    : {};
  const reserveOption: Record<string, unknown> = isObject(rule.reserveOption)
    ? rule.reserveOption
    : {};
  const notes: string[] = [];

  if (flag(rule.isTimeSpecification))
    return { skip: "時刻指定のルールは取り込めません" };
  if (
    flag(search["keyRegExp"]) ||
    (flag(search["ignoreKeyRegExp"]) && text(search["ignoreKeyword"]) !== "")
  )
    return { skip: "正規表現のルールは取り込めません" };
  if (
    typeof search["durationMin"] === "number" ||
    typeof search["durationMax"] === "number"
  )
    return { skip: "番組の長さで絞るルールは取り込めません" };
  if (list(search["searchPeriods"]).length > 0)
    return { skip: "検索期間のあるルールは取り込めません" };
  const times = parseTimes(search["times"]);
  if (times === null) return { skip: "時間帯が2つ以上あるので取り込めません" };

  const types = (["GR", "BS", "CS", "SKY"] as const).filter((type) =>
    flag(search[type]),
  );
  if (flag(search["BS4K"])) {
    // 種別を空にすると全種別に当たる。BS4K だけで絞っていたルールは写せない
    if (types.length === 0)
      return {
        skip: "BS4K だけのルールは取り込めません (denpa に BS4K はありません)",
      };
    notes.push("BS4K は denpa に無いので種別から外しました");
  }

  const channelIds = list(search["channelIds"]).filter(isId);
  const channels = channelIds.flatMap((id) => serviceOf(id) ?? []);
  // 局を全部外すと全局に当たってしまう
  if (channelIds.length > 0 && channels.length === 0)
    return { skip: "局が1つも denpa に無いので取り込めません" };
  if (channels.length < channelIds.length)
    notes.push(
      `denpa に無い局を ${channelIds.length - channels.length} 件外しました`,
    );

  const keyword = toHalfWidth(text(search["keyword"])).trim();
  const genres = parseGenres(search["genres"]);
  if (
    keyword === "" &&
    types.length === 0 &&
    genres.length === 0 &&
    channels.length === 0
  ) {
    // 条件が空だと全番組にマッチしてしまう。時間帯と曜日は絞り込みなので、それだけのルールもここに来る
    return { skip: "条件が空になるので取り込めません" };
  }

  if (flag(search["keyCS"]))
    notes.push("大文字と小文字の区別は普通の検索として取り込みました");
  if (flag(search["isFree"]))
    notes.push(
      "無料放送だけの条件は外して取り込みました (有料放送にも当たります)",
    );

  return {
    values: {
      name: keyword !== "" ? keyword : `EPGStation #${rule.id}`,
      keyword,
      ignore_keyword: toHalfWidth(text(search["ignoreKeyword"])).trim(),
      // 当てる範囲も向こうから引き継ぐ。既定に寄せると黙って当たらなくなる
      search_fields: parseSearchFields(
        SEARCH_FIELDS.filter((field) => flag(search[field])).join(","),
      ).join(","),
      service_ids: channels.length === 0 ? null : channels,
      service_types: types.length === 0 ? null : types,
      genres: genres.length === 0 ? null : genres,
      ...times,
      enabled: flag(reserveOption["enable"]),
      // 重複を避ける期間 (periodToAvoidDuplicate) は写さない。denpa は録画と引き継いだ履歴で見る
      dedupe: flag(reserveOption["avoidDuplicate"]),
    },
    notes,
  };
}

/** 自動予約ルールを入れる。取り込み済みは `source` (`epgstation:<ruleId>`) で見分けて飛ばす */
function importRules(list_: EpgstationRule[], options: MigrateOptions): void {
  for (const rule of list_) {
    const source = `epgstation:${rule.id}`;
    if (ruleImported(source)) {
      status_.rules.skipped++;
      continue;
    }
    const converted = convertRule(rule, (id) => serviceById(id)?.id);
    if ("skip" in converted) {
      record(`${converted.skip}: #${rule.id}`);
      status_.rules.skipped++;
      continue;
    }
    const { values, notes } = converted;
    recordPlan(options, "ルール", values.name);
    for (const note of notes) record(`  ${note}: #${rule.id}`);
    status_.rules.imported++;
    if (options.apply) insertRule(values, source);
  }
}

/**
 * 手で入れた予約だけ引き継ぐ。
 *
 * ルール由来の予約 (`ruleId` のあるもの) は、ルールを取り込んだあとに denpa が自分で立て直すので触らない。
 * 除外の印 (`isSkip`) のものも数えない。時刻だけの予約 (`isTimeSpecified`) は番組に結び付かないので飛ばす。
 * EPGStation の programId は denpa の番組ID (`programKey`) と作り方が同じなので、直に照合できる。
 */
async function importReservations(
  list_: EpgstationReserve[],
  options: MigrateOptions,
): Promise<void> {
  const at = now();
  for (const item of list_) {
    if (isId(item.ruleId) || flag(item.isSkip)) continue;
    const name = text(item.name);
    if (flag(item.isTimeSpecified)) {
      record(`時刻だけの予約は取り込めません: ${name}`);
      status_.reservations.skipped++;
      continue;
    }
    if (!isId(item.programId) || item.endAt <= at) {
      status_.reservations.skipped++;
      continue;
    }
    await importReservation(item.programId, name, options);
  }
}

/**
 * 番組 (`programId`) を予約して数える。番組表に無い・予約できないものは記録に残して飛ばす。
 * EDCB の取り込みも使う
 */
export async function importReservation(
  programId: number,
  name: string,
  options: MigrateOptions,
): Promise<void> {
  const program = orm()
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.id, programId))
    .get();
  if (program === undefined) {
    // 番組表を集める前だと出る。集めてからもう一度実行すれば入る
    record(`番組表に無いので取り込めません: ${name || String(programId)}`);
    status_.reservations.skipped++;
    return;
  }
  if (options.apply) {
    try {
      await reserve(program.id);
    } catch (error) {
      record(
        `予約できません: ${name} (${error instanceof Error ? error.message : String(error)})`,
      );
      status_.reservations.skipped++;
      return;
    }
  }
  recordPlan(options, "予約", name);
  status_.reservations.imported++;
}

/**
 * **録画の履歴を入れる。** API には消した録画の履歴 (`recorded_history`) を返すエンドポイントが無いので、
 * いま残っている録画のうち**ルールで録ったもの** (`ruleId` のあるもの) を、ファイルを取れたかに関係なく
 * 「録ったことのある回」の控え (`schema.recordedHistory`) に入れる。ルールの「同じ回は最初の放送だけ」と
 * 「前の回は録らない」が見て、EPGStation で録った回を録り直さない。
 *
 * 取り込み済みは `source` (`epgstation:recorded:<録画ID>`) で見分けて飛ばす。前のバージョン (DB から読んでいた頃)
 * が入れた `epgstation:<履歴ID>` はそのまま残る
 */
function importRecordedHistory(
  list_: EpgstationRecorded[],
  channels: ChannelNames,
  options: MigrateOptions,
): void {
  for (const item of list_) {
    if (!isId(item.ruleId)) continue;
    const channelId = isId(item.channelId) ? item.channelId : null;
    addHistory(
      {
        sources: [`epgstation:recorded:${item.id}`],
        name: text(item.name),
        serviceId: channelId,
        serviceName: channelId === null ? "" : (channels.get(channelId) ?? ""),
        endAt: item.endAt,
      },
      options,
    );
  }
}

/** 置き場ごとの要る量。同じファイルシステムなら1つにまとめる (`dev`) */
interface Need {
  /** 載っている置き場 (同じファイルシステムなら2つ) */
  dirs: string[];
  /** 空きを訊く先。置き場がまだ無ければ (下見)、在るところまで上ったフォルダ */
  probe: string;
  bytes: number;
}

/** 在るところまで上る。下見ではフォルダを作らないので、まだ無い置き場はその上の空きで見る */
function existingAncestor(dir: string): string {
  let current = dir;
  while (!existsSync(current) && dirname(current) !== current)
    current = dirname(current);
  return current;
}

function needsByFilesystem(pending: { raw: boolean; bytes: number }[]): Need[] {
  const byDevice = new Map<string, Need>();
  for (const [dir, raw] of [
    [config.rawDir, true],
    [config.encodedDir, false],
  ] as const) {
    const bytes = pending
      .filter((item) => item.raw === raw)
      .reduce((sum, item) => sum + item.bytes, 0);
    const probe = existingAncestor(dir);
    let key = probe;
    try {
      key = String(statSync(probe).dev);
    } catch {
      // 読めない。置き場ごとに分けて見る
    }
    const entry = byDevice.get(key) ?? { dirs: [], probe, bytes: 0 };
    entry.dirs.push(dir);
    entry.bytes += bytes;
    byDevice.set(key, entry);
  }
  return [...byDevice.values()].filter((entry) => entry.bytes > 0);
}

/**
 * **空きを先に確かめる。** まだ入っていないファイルの合計 (書きかけのぶんを引く) と、置き場の空きを比べる。
 * ディスクの見張り (`disk.ts`) の残す量 (`DISK_LOW_THRESHOLD`) も足す — 取り込みで埋めて録画が書けなく
 * なるのを防ぐ。足りなければ取り込みでは投げ (録画には入らない。ルール・予約は入ったまま)、下見では記録に残す
 */
function checkSpace(
  pending: { raw: boolean; bytes: number }[],
  options: MigrateOptions,
): void {
  for (const need of needsByFilesystem(pending)) {
    const where = need.dirs.join("・");
    const free = freeBytes(need.probe);
    if (free === null) {
      record(`空きを読めません: ${where} (取り込む ${formatSize(need.bytes)})`);
      continue;
    }
    const keep = Math.max(0, config.diskLowThreshold);
    record(
      `置き場 ${where}: 取り込む ${formatSize(need.bytes)} / 空き ${formatSize(free)} (残す量 ${formatSize(keep)})`,
    );
    if (need.bytes + keep <= free) continue;
    const message = `空きが足りません: ${where} (取り込む ${formatSize(need.bytes)} + 残す量 ${formatSize(keep)} / 空き ${formatSize(free)})`;
    if (options.apply) throw new Error(message);
    record(`${message}。このまま取り込むと、録画の前で止まります`);
  }
}

/**
 * 録画を取り込む。**先に全部の一覧を集めてから** 1件ずつ取る (同時に1本。EPGStation のディスクと
 * denpa の書き込みを取り合わないため)。1件の失敗では止めず、次の録画へ進む
 */
async function importRecordings(
  list_: EpgstationRecorded[],
  options: MigrateOptions,
  context: ImportContext,
): Promise<void> {
  const entries = list_.filter((item) => {
    if (!flag(item.isRecording) && !flag(item.isEncoding)) return true;
    record(
      `録画中かエンコード中なので飛ばします (次の実行で入ります): ${item.name}`,
    );
    return false;
  });
  status_.total = entries.length;

  // まだ入っていないもの。書きかけがあれば、そのぶんは取らなくてよい
  const pending: {
    raw: boolean;
    size: number;
    bytes: number;
    temporary: string;
  }[] = [];
  for (const item of entries) {
    const existing = importedRow(item.id);
    if (alreadyImported(existing)) continue;
    const file = chooseFile(item);
    if (file === null) continue;
    const { temporary } = placement(item, file, existing);
    const partial = Math.min(fileSize(temporary), file.size);
    pending.push({
      raw: file.raw,
      size: file.size,
      bytes: file.size - partial,
      temporary,
    });
  }
  status_.bytesTotal = pending.reduce((sum, item) => sum + item.size, 0);
  const partial = pending.reduce(
    (sum, item) => sum + item.size - item.bytes,
    0,
  );
  record(
    `対象 ${entries.length} 件 (取り込む ${pending.length} 件・${formatSize(status_.bytesTotal)}${partial > 0 ? `。うち書きかけ ${formatSize(partial)}` : ""})`,
  );
  emit("migrate");

  if (options.apply) {
    mkdirSync(config.rawDir, { recursive: true });
    mkdirSync(config.encodedDir, { recursive: true });
  }
  checkSpace(pending, options);

  if (options.apply) {
    const swept = sweepTemporaries(
      new Set(pending.map((item) => item.temporary)),
    );
    if (swept > 0) record(`もう対象に無い書きかけを片付けました: ${swept} 件`);
  }

  for (const item of entries) {
    status_.current = item.name;
    emit("migrate");
    try {
      const result = await importOne(item, options, context);
      status_[result]++;
    } catch (error) {
      if (context.signal.aborted) throw error;
      status_.failed++;
      record(
        `取り込めませんでした: ${item.name} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    status_.currentDone = 0;
    status_.currentTotal = 0;
    emit("migrate");
  }
  record(
    `録画 新規 ${status_.imported} 件 / 取り込み済み ${status_.skipped} 件 / ファイル無し ${status_.missing} 件 / 失敗 ${status_.failed} 件`,
  );
}

/** 走っているか。走っている間は、どちらの引き継ぎも始めさせない (同じ進み具合を使うため) */
export function running(): boolean {
  return status_.state === "running";
}

/**
 * 引き継ぎを1回走らせる。進み具合をまっさらに戻して `body` を回し、終わりと失敗を進み具合に書く。
 * 失敗は投げずに `failed` と理由で残す (画面からは待たずに呼ぶので、受け取る相手がいない)。
 * `signal` で止めたものは `canceled`
 */
export async function track(
  from: MigrateStatus["from"],
  options: MigrateOptions,
  body: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  status_ = freshStatus({
    state: "running",
    from,
    apply: options.apply,
    startedAt: Date.now(),
  });
  emit("migrate");
  try {
    await body();
    status_.current = null;
    status_.state = "done";
  } catch (error) {
    if (signal?.aborted) {
      status_.state = "canceled";
      record("中断しました。書きかけは残してあり、次の実行で続きから取ります");
    } else {
      status_.state = "failed";
      status_.error = error instanceof Error ? error.message : String(error);
      record(`失敗: ${status_.error}`);
    }
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
 * 取り込みを走らせる。進み具合は {@link status} に入る。画面からは待たずに呼ぶ ({@link start})。
 * テストからは終わるまで待てる
 */
export function runEpgstation(
  client: EpgstationClient,
  version: EpgstationVersion,
  options: MigrateOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  return track(
    "epgstation",
    options,
    async () => {
      record(`EPGStation ${version.text} (${client.source.base})`);
      if (version.major === null)
        record(
          `EPGStation のバージョン (${version.text || "読めません"}) が v2・v3 のどちらでもありません。v3 として続けます`,
        );
      // 先に全部の一覧を集める。録画は古い順
      const channels = new Map(
        (await client.channels(signal)).map((channel) => [
          channel.id,
          channel.name,
        ]),
      );
      const recorded = await client.recorded(signal);
      const ruleList = await client.rules(signal);
      const reserveList = await client.reserves(signal);

      // ルールと手動予約を先に入れる。録画を取ってくるのは時間がかかるので、
      // 先にこちらを済ませておけば途中で止めても予約は動き出す。
      // 録画の履歴はルールより前に入れる — ルールが当たり出したときに、もう録った回を予約しないように
      importRecordedHistory(recorded, channels, options);
      importRules(ruleList, options);
      await importReservations(reserveList, options);
      recordCounts();

      await importRecordings(recorded, options, { client, channels, signal });
    },
    signal,
  );
}

/** 最後に入れられた URL。画面の入力欄に戻す (メモリにだけ持つ。設定には書かない) */
let lastUrl: string | null = null;

export function epgstationUrl(): string | null {
  return lastUrl;
}

/** 走っている取り込みを止めるもの ({@link cancel}) */
let controller: AbortController | null = null;
/** `/version` を訊いている間。二重に押されても1つしか走らせない */
let starting = false;

/** 形が違ったとき・欠けた1件を飛ばしたときの出し先。サーバのログと引き継ぎの記録の両方 */
function warn(message: string): void {
  console.warn(message);
  record(message);
}

/**
 * 設定画面から呼ぶ入口。**先に `/version` を訊いて、繋がらなければその場で理由を返す**
 * (裏で走らせてから失敗にしない)。繋がれば走り出したことだけ返し、終わるのは待たない。
 * どちらかの引き継ぎが走っている間は断る (進み具合を1つしか持たないため)
 */
export async function start(
  input: string,
  options: MigrateOptions,
): Promise<{ started: boolean; message: string }> {
  if (running() || starting)
    return { started: false, message: "すでに実行中です" };
  const trimmed = input.trim();
  if (trimmed === "")
    return { started: false, message: "EPGStation の URL を入れてください" };
  lastUrl = trimmed;
  let source;
  try {
    source = parseSource(trimmed);
  } catch (error) {
    return { started: false, message: (error as Error).message };
  }
  starting = true;
  try {
    const client = new EpgstationClient(source, warn, warn);
    let version;
    try {
      version = await client.version();
    } catch (error) {
      return {
        started: false,
        message: `EPGStation (${source.base}) に繋がりません: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (version === "v1")
      return {
        started: false,
        message:
          "EPGStation v1 には対応していません。v2 か v3 にしてから実行してください",
      };
    controller = new AbortController();
    void runEpgstation(client, version, options, controller.signal);
    return {
      started: true,
      message: options.apply ? "取り込みを開始しました" : "下見を開始しました",
    };
  } finally {
    starting = false;
  }
}

/** 「中断」。走っている EPGStation の取り込みを止める。書きかけは残し、次の実行で続きから取る */
export function cancel(): boolean {
  if (!running() || status_.from !== "epgstation" || controller === null)
    return false;
  controller.abort(new Error("中断しました"));
  return true;
}
