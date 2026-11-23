/**
 * **ほかのソフトで録った TS を、元の場所に置いたまま denpa の録画として登録する** (設定の「連携」の「録画ファイルの取り込み」。
 * docs/migrate.md「ほかのソフトで録った録画の取り込み」)。
 *
 * - 読んでよいフォルダは環境変数 `IMPORT_DIRS` の下だけ ({@link resolveFolder})。シンボリックリンクは辿らず、denpa の置き場と重なるフォルダは断る
 * - ファイルは**読むだけ**。写さない・動かさない・書き換えない。行の `imported_ts` にパスを入れ、denpa のどの操作でも消さない (`source.ownsTs`)
 * - EPGStation からの引き継ぎと同じく、下見 (`apply: false`。DB に書かない) → 取り込みの 2 段階。何度実行しても、取り込み済みのファイルは飛ばす
 *   (`imported_ts`)。中断しても、入れ終えたファイルから続く
 * - 番組は TS の中の SDT・EIT[p/f]・TDT/TOT から決める (`ts-import-read.ts`)。読めなければファイルの名前と更新時刻から作る
 * - 入れた録画は、ふだんの録画と同じく字幕の索引とエンコード (設定どおり。待ち行列では denpa が録ったものより後ろ。`encoder.pump`) に乗る
 * - **元のフォルダには何も書かない。** サムネイル・データ放送の変化ログはエンコードしたもの (保存先) の隣にだけ置く。エンコードしない録画には作らない
 *   (`recorder.finish` のように保存先へ移して作ることをしない)。エンコードの作業ファイルは `RAW_DIR/.import/` (`fsx.scratchBase`)
 */

import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
} from "node:path";

import type { EitEvent } from "@danything/arib/eit";
import { and, eq, isNull } from "drizzle-orm";

import { CAPTION_SETTLE, kickCaptionIndex } from "./caption-index";
import { config } from "./config";
import { now, orm } from "./db";
import { enqueue } from "./encoder";
import { emit } from "./events";
import { within } from "./fsx";
import { serviceOf } from "./migrate";
import { recordings } from "./schema";
import { seriesParts } from "./series-heads";
import { settings } from "./settings";
import { parseTitle } from "./title";
import { busy as transferBusy, BUSY_MESSAGE } from "./transfer";
import { readTsFacts, type TsFacts } from "./ts-import-read";

export interface TsImportOptions {
  /** false なら何が入るかを出すだけで DB に書かない */
  apply: boolean;
}

export interface TsImportStatus extends TsImportOptions {
  /** `canceled` は「中断」で止めたとき。次の実行は入れ終えたファイルを飛ばして続く */
  state: "idle" | "running" | "done" | "failed" | "canceled";
  /** 見つけた TS の数 */
  total: number;
  imported: number;
  /** もう取り込んだファイル */
  skipped: number;
  /** 同じ番組の録画がもう denpa にあるもの */
  overlap: number;
  /** 取り込まないもの (TS として読めない・スクランブル・書き込み中かもしれない) */
  unreadable: number;
  /** 読んでいる途中で失敗したもの。ほかのファイルは続ける */
  failed: number;
  /** いま読んでいるファイル (指したフォルダからの相対) */
  current: string | null;
  /** 直近の記録。後ろから 200 件 */
  log: string[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const LOG_LIMIT = 200;
/**
 * 1 回で見るファイルの上限。間違えて大きな木を指したときに終わらないのを防ぐ。超えたら止めて、もっと下のフォルダを指してもらう
 */
export const FILE_LIMIT = 20_000;
/** 更新時刻がこれより新しいファイルは、ほかのソフトがまだ書いているかもしれないので飛ばす (次の実行で入る) */
export const SETTLE_MS = 10 * 60_000;
/** 取り込む拡張子。エンコード済み (mp4・mkv) と 4K の局の録画 (`.mmts`) は入れない */
const TS_FILE = /\.(?:ts|m2ts)$/i;

function freshStatus(over: Partial<TsImportStatus> = {}): TsImportStatus {
  return {
    state: "idle",
    apply: false,
    total: 0,
    imported: 0,
    skipped: 0,
    overlap: 0,
    unreadable: 0,
    failed: 0,
    current: null,
    log: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

let status_ = freshStatus();
let controller: AbortController | null = null;
/** 最後に指したフォルダ。入力欄に戻す (メモリにだけ持つ) */
let lastFolder: string | null = null;

export function status(): TsImportStatus {
  return { ...status_, log: [...status_.log] };
}

export function lastImportFolder(): string | null {
  return lastFolder;
}

function record(message: string): void {
  status_.log.push(message);
  if (status_.log.length > LOG_LIMIT)
    status_.log.splice(0, status_.log.length - LOG_LIMIT);
}

/** 最後に知らせた時刻。1 本ごとに動くので、知らせるのは 1 秒に 1 回まで */
let lastEmit = 0;
function emitThrottled(): void {
  const at = Date.now();
  if (at - lastEmit < 1000) return;
  lastEmit = at;
  emit("import");
}

/** `IMPORT_DIRS` を並びに直す。空の要素は捨てる */
export function importRoots(): string[] {
  return config.importDirs
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
}

/** 有るなら実体のパス、無ければ書いたまま (まだ作られていない置き場と比べるため) */
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * **画面で指したフォルダを確かめて、実体のパスにする。** 使えなければ理由を返す。
 *
 * - `IMPORT_DIRS` のどれかの下 (同じも可) だけ。比べるのはどちらも `realpath` (リンクやジャンクションで外へ出られないように)
 * - denpa の置き場 (`RAW_DIR`・`ENCODED_DIR`) と DB の置き場に重なるものは断る (どちらかがどちらかを含む)。
 *   denpa のファイルを「ユーザーのファイル」として登録すると、消さない決まりと置き場の片付けがぶつかる
 */
export async function resolveFolder(
  input: string,
): Promise<{ ok: true; folder: string } | { ok: false; message: string }> {
  const roots = importRoots();
  if (roots.length === 0)
    return {
      ok: false,
      message:
        "取り込めるフォルダがありません。サーバの環境変数 IMPORT_DIRS に取り込むフォルダを書いてください",
    };
  const trimmed = input.trim();
  if (trimmed === "")
    return { ok: false, message: "取り込むフォルダを入れてください" };
  if (!isAbsolute(trimmed))
    return {
      ok: false,
      message: "フォルダはサーバから見た絶対パスで入れてください",
    };
  let folder: string;
  try {
    folder = await realpath(trimmed);
    if (!(await stat(folder)).isDirectory())
      return { ok: false, message: `フォルダではありません: ${trimmed}` };
  } catch {
    return {
      ok: false,
      message: `サーバからフォルダが見えません: ${trimmed}`,
    };
  }
  const allowed = await Promise.all(roots.map(real));
  if (!allowed.some((root) => within(root, folder)))
    return {
      ok: false,
      message: `IMPORT_DIRS の外のフォルダは取り込めません (${roots.join(", ")})`,
    };
  for (const store of [config.rawDir, config.encodedDir, config.dataDir]) {
    const place = await real(store);
    if (within(place, folder) || within(folder, place))
      return {
        ok: false,
        message: `denpa の置き場 (${store}) と重なるフォルダは取り込めません`,
      };
  }
  return { ok: true, folder };
}

/**
 * フォルダの下の TS を集める (名前の順)。**シンボリックリンクとジャンクションは辿らない**。名前が `.` で始まるものも見ない。
 * 上限 ({@link FILE_LIMIT}) を超えたら null
 */
async function collect(folder: string): Promise<string[] | null> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      record(
        `フォルダを読めません: ${relative(folder, dir) || "."} (${String(error)})`,
      );
      return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(target))) return false;
      } else if (entry.isFile() && TS_FILE.test(entry.name)) {
        found.push(target);
        if (found.length > FILE_LIMIT) return false;
      }
    }
    return true;
  };
  return (await walk(folder)) ? found : null;
}

/** 読んだ結果のキャッシュ。パス・大きさ・更新時刻が同じなら読み直さない (下見のあとの取り込みで同じファイルを読まない) */
const factsCache = new Map<
  string,
  { size: number; mtime: number; facts: TsFacts | null }
>();

async function factsOf(
  path: string,
  size: number,
  mtime: number,
): Promise<TsFacts | null> {
  const cached = factsCache.get(path);
  if (cached !== undefined && cached.size === size && cached.mtime === mtime)
    return cached.facts;
  const facts = await readTsFacts(path, size);
  // 別のフォルダを何度も指しても溜め続けない (1 回の実行で見る数を超えたら空ける)
  if (factsCache.size >= FILE_LIMIT) factsCache.clear();
  factsCache.set(path, { size, mtime, facts });
  return facts;
}

/**
 * **録れている区間といちばん長く重なる番組。** 先頭のいまは前の番組 (録り始めのマージン) のことが多いので、
 * いまと次、末尾のいまと次から重なりで選ぶ。区間が読めなければ、最初に読めた番組
 */
export function pickEvent(
  events: EitEvent[],
  from: number | null,
  to: number | null,
): EitEvent | null {
  const timed = events.filter(
    (event): event is EitEvent & { startAt: number } => event.startAt !== null,
  );
  if (from === null || to === null) return timed[0] ?? null;
  let best: EitEvent | null = null;
  // 区間に触れているだけ (重なり 0) の番組も選べるようにする。時刻を 1 回しか読めなかった短いファイルは、区間が点になる
  let bestOverlap = -1;
  for (const event of timed) {
    const end = event.startAt + (event.duration ?? 0);
    const overlap = Math.min(end, to) - Math.max(event.startAt, from);
    if (overlap > bestOverlap) {
      best = event;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** 入れる録画の行。`ts_path`・`imported_ts`・作った時刻は {@link importFile} が足す */
export type ImportValues = Omit<
  typeof recordings.$inferInsert,
  "ts_path" | "imported_ts" | "created_at" | "updated_at" | "finished_at"
>;

/**
 * **TS から録画の行を組む。** 番組が読めなければファイル名 (拡張子なし) と時刻だけで作る。
 * 時刻が読めなければ、終わり = ファイルの更新時刻、始まり = 終わり − PCR で測った長さ
 */
export function planRecording(
  facts: TsFacts,
  name: string,
  mtime: number,
): { values: ImportValues; timed: boolean } {
  const event = pickEvent(facts.events, facts.headAt, facts.tailAt);
  const service =
    facts.networkId === null
      ? undefined
      : serviceOf(facts.networkId, facts.program);
  const span =
    facts.headAt !== null &&
    facts.tailAt !== null &&
    facts.tailAt > facts.headAt
      ? facts.tailAt - facts.headAt
      : facts.pcrSpan === null
        ? null
        : Math.round(facts.pcrSpan * 1000);
  const fallbackEnd = facts.tailAt ?? mtime;
  const fallbackStart = facts.headAt ?? fallbackEnd - (span ?? 0);
  const title = event?.name || name;
  const parsed = seriesParts(title, parseTitle(title).subtitle);
  const startAt = event?.startAt ?? fallbackStart;
  const endAt =
    event?.startAt != null && event.duration !== null
      ? event.startAt + event.duration
      : Math.max(startAt, fallbackEnd);
  const extended =
    event === null || Object.keys(event.extended).length === 0
      ? null
      : event.extended;
  return {
    timed: event !== null,
    values: {
      reservation_id: null,
      // 番組表のマスと結び付ける (`tuner.programKey` = 局の内部 ID × 100000 + event_id)。局が denpa に無ければ結ばない
      program_id:
        service !== undefined && event !== null
          ? service.id * 100000 + event.eventId
          : null,
      service_id: service?.id ?? 0,
      service_name: service?.name ?? facts.serviceName,
      name: title,
      series: parsed.series,
      subtitle: parsed.subtitle,
      description: event?.description ?? "",
      extended,
      start_at: startAt,
      end_at: endAt,
      audio_type: event?.audios[0]?.componentType ?? null,
      genre_detail:
        event === null || event.genres.length === 0 ? null : event.genres,
      audios:
        event === null || event.audios.length === 0
          ? null
          : event.audios.map((a) => ({
              componentType: a.componentType,
              ...(a.componentTag === undefined
                ? {}
                : { componentTag: a.componentTag }),
              langs: a.langs,
              ...(a.text === undefined ? {} : { text: a.text }),
              ...(a.main === undefined ? {} : { main: a.main }),
            })),
      series_episode: event?.series?.episode ?? null,
      series_last_episode: event?.series?.lastEpisode ?? null,
      series_repeat: event?.series?.repeatLabel ?? null,
      duration_ms: span,
      // 実況のコメントを再生位置に合わせる (`recordings.ts_head`)
      ts_head: facts.headAt,
    },
  };
}

/** 同じファイルをもう取り込んだか (消したものも。`imported_ts` は削除しても残る) */
function alreadyImported(path: string): boolean {
  return (
    orm()
      .select({ id: recordings.id })
      .from(recordings)
      .where(eq(recordings.imported_ts, path))
      .get() !== undefined
  );
}

/** 重なりを見る鍵。局 (denpa の局が無ければ局名) と番組の開始 */
function overlapKey(values: ImportValues): string {
  return values.service_id !== 0
    ? `id:${values.service_id}:${values.start_at}`
    : `name:${values.service_name}:${values.start_at}`;
}

/**
 * **同じ番組の録画がもう denpa にあるか** (消していないもの)。denpa で録ったもの・EPGStation から引き継いだもの・先に取り込んだものと重ねない。
 * 局 (denpa の局が無ければ局名) と番組の開始で見る
 */
function overlaps(values: ImportValues): boolean {
  return (
    orm()
      .select({ id: recordings.id })
      .from(recordings)
      .where(
        and(
          isNull(recordings.deleted_at),
          eq(recordings.start_at, values.start_at),
          values.service_id !== 0
            ? eq(recordings.service_id, values.service_id)
            : and(
                eq(recordings.service_id, 0),
                eq(recordings.service_name, values.service_name ?? ""),
              ),
        ),
      )
      .get() !== undefined
  );
}

type Outcome = "imported" | "skipped" | "overlap" | "unreadable";

/** 1 本ぶん。下見なら DB に書かない。`planned` は同じ実行で先に入れる (入れる予定にした) 番組の鍵 */
async function importFile(
  path: string,
  folder: string,
  options: TsImportOptions,
  planned: Set<string>,
): Promise<Outcome> {
  const shown = relative(folder, path);
  const file = await realpath(path);
  // 辿らないはずのリンクが途中に挟まっていても、指したフォルダの外は読まない
  if (!within(folder, file)) {
    record(`指したフォルダの外を指しているので飛ばします: ${shown}`);
    return "unreadable";
  }
  if (alreadyImported(file)) return "skipped";
  const info = await stat(file);
  if (Date.now() - info.mtimeMs < SETTLE_MS) {
    record(
      `書き込み中かもしれないので飛ばします (次の実行で入ります): ${shown}`,
    );
    return "unreadable";
  }
  const facts = await factsOf(file, info.size, info.mtimeMs);
  if (facts === null) {
    record(`TS として読めません: ${shown}`);
    return "unreadable";
  }
  if (facts.scrambled) {
    record(`スクランブルが掛かっているので取り込めません: ${shown}`);
    return "unreadable";
  }
  const { values, timed } = planRecording(
    facts,
    basename(file, extname(file)),
    Math.round(info.mtimeMs),
  );
  // 時刻をファイルから決めたもの (番組が読めなかった) は、同じ番組かを言えないので重なりを見ない
  if (timed) {
    const key = overlapKey(values);
    if (planned.has(key) || overlaps(values)) {
      record(`同じ番組の録画があります: ${shown} (${values.name})`);
      return "overlap";
    }
    planned.add(key);
  }
  if (!timed)
    record(`番組を読めないので、ファイルの名前と時刻で入れます: ${shown}`);
  record(
    `${options.apply ? "取り込む" : "取り込む(予定)"}: ${shown} → ${values.name}`,
  );
  if (!options.apply) return "imported";

  const at = now();
  const { id } = orm()
    .insert(recordings)
    .values({
      ...values,
      ts_path: file,
      imported_ts: file,
      ts_size: info.size,
      finished_at: at,
      // 何年分もが「未視聴」に並ばないように、視聴済みで入れる (EPGStation の引き継ぎと同じ。`migrate.importOne`)
      watched_at: at,
      created_at: at,
      updated_at: at,
    })
    .returning({ id: recordings.id })
    .get()!;
  // ふだんの録画と同じく、エンコードする設定ならエンコードする (CM 検出も)。映像の無い録画は TS のまま (`recorder.finish` と同じ)
  if (facts.video && settings().encode) enqueue(id);
  return "imported";
}

async function run(
  folder: string,
  options: TsImportOptions,
  signal: AbortSignal,
): Promise<void> {
  status_ = freshStatus({
    state: "running",
    apply: options.apply,
    startedAt: Date.now(),
  });
  emit("import");
  try {
    const files = await collect(folder);
    if (files === null) {
      status_.state = "failed";
      status_.error = `TS が ${FILE_LIMIT.toLocaleString()} 本を超えています。もっと下のフォルダを指して、分けて実行してください`;
      return;
    }
    status_.total = files.length;
    record(`TS が ${files.length} 本見つかりました`);
    const planned = new Set<string>();
    for (const path of files) {
      if (signal.aborted) {
        status_.state = "canceled";
        return;
      }
      // 別の機械へ移す書き出し・取り込みが始まったら止める (取り込みは DB を丸ごと入れ替えるので、ここで入れた行が残らない)
      if (transferBusy()) {
        status_.state = "failed";
        status_.error = BUSY_MESSAGE;
        return;
      }
      status_.current = relative(folder, path);
      emitThrottled();
      try {
        status_[await importFile(path, folder, options, planned)]++;
      } catch (error) {
        status_.failed++;
        record(`失敗しました: ${relative(folder, path)} (${String(error)})`);
      }
    }
    status_.state = "done";
  } catch (error) {
    status_.state = "failed";
    status_.error = String(error);
  } finally {
    status_.current = null;
    status_.finishedAt = Date.now();
    controller = null;
    if (options.apply && status_.imported > 0) {
      // 字幕の索引は録り終えた録画と同じく少し置いてから (`caption-index.ts`)
      kickCaptionIndex(CAPTION_SETTLE);
      emit("recordings");
    }
    emit("import");
  }
}

/**
 * 設定画面から呼ぶ入口。フォルダを確かめ、使えなければその場で理由を返す。走り出したら終わるのは待たない。
 * 走っている間と、denpa を別の機械へ移す書き出し・取り込みの間は断る
 */
export async function start(
  input: string,
  options: TsImportOptions,
): Promise<{ started: boolean; message: string }> {
  if (controller !== null)
    return { started: false, message: "すでに実行中です" };
  if (transferBusy()) return { started: false, message: BUSY_MESSAGE };
  lastFolder = input.trim();
  const resolved = await resolveFolder(input);
  if (!resolved.ok) return { started: false, message: resolved.message };
  if (controller !== null)
    return { started: false, message: "すでに実行中です" };
  controller = new AbortController();
  void run(resolved.folder, options, controller.signal);
  return {
    started: true,
    message: options.apply ? "取り込みを開始しました" : "下見を開始しました",
  };
}

/** 「中断」。いま読んでいるファイルを終えたところで止める */
export function cancel(): boolean {
  if (controller === null) return false;
  controller.abort();
  return true;
}

/** 走っているか (テストが終わるのを待つ) */
export function running(): boolean {
  return controller !== null;
}
