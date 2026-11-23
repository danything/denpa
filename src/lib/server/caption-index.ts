import { existsSync } from "node:fs";

import type { CaptionPages } from "@danything/arib/caption-text";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { captionWords } from "#lib/caption-words.js";
import { playbackAt, type Ruler, toTsTime } from "#lib/ts/watch.js";
import type { Recording } from "#lib/types.js";

import { captionGrams, captionKey } from "./caption-key";
import { now, orm } from "./db";
import { tsHeadOf } from "./recording";
import { captionSource, extractCaptions } from "./recording-captions";
import {
  activeEncodeJobId,
  CAPTION_FTS,
  captionIndex,
  captionLines,
  encodeJobs,
  recordings,
} from "./schema";

/**
 * **録画の字幕のインデックス** (字幕で探す。`search.searchCaptions`)。録画の字幕を 1 枚ずつ `caption_lines` に、
 * 揃えて 2 字ずつ区切ったもの (`caption-key.ts`) を FTS5 (`caption_fts`) に入れる。
 *
 * **入れる仕事は 1 つだけ。** 録画ごとの結果 (`caption_index`) と録画の行を突き合わせ、足りない録画を新しい順に 1 本ずつ読む
 * (`nextRecording`)。エンコードし終えた録画も、すでにある録画も、同じ仕事が読む。
 * 進み具合は DB にしか無いので、止めても次の起動で続きから。
 *
 * - 読むのは録り終えて 5 分たち、消していない、エンコードを待っていない録画。エンコードを待っている録画を元の TS から読むと、
 *   エンコードが終わってから読み直すことになる
 * - 読むのは列から決まる 1 つのファイル (`expectedFile`。`.mkv` があればそれ、無ければ元の TS)。置き場に無ければ読まずに後で見直す
 *   (`waiting`)。主のエンコード済みが無いときに、ほかのコーデックや元の TS へ移って読むことはしない (`captions.json` は移る)
 * - 4K の局のエンコードしていない録画 (`.mmts`) は読まない。denpa が丸ごと読み (`mmts.mmtsCaptions`)、止める合図も上限も無い。
 *   エンコードすれば隣の `….captions.json` から読む
 * - 1 本終えるたびに、かかった時間と同じだけ (少なくとも 2 秒) 待つ。ffmpeg はいちばん低い優先度で動かす (`lowPriority`)
 * - 字幕の無い録画は `missing` で覚えて読み直さない。時間切れなどで読めなければ `failed` で、6 時間・12 時間・… と間を延ばして
 *   5 回まで読み直す。どちらも、ファイルの列か作り方のバージョンが変わればまた読む
 */

/**
 * 作り方のバージョン。上げると全部消して作り直す (`wipeOldVersion`)。
 * **揃え方 (`caption-key.captionKey` と、それが通す `title.searchable`・`fold.ts`)・区切り方・入れる字幕を変えたら、必ず上げる。**
 * FTS5 は中身を持たず、消すときは入れたときと同じ区切りを渡し直す (`removeLines`)。揃え方が変わったまま上げずにおくと、古い語が消えずに残る
 */
export const CAPTION_INDEX_VERSION = 1;

/** 起動してから始めるまで (起動のときの突き合わせや番組表の取得と重ねない) */
const START_DELAY = 60_000;
/** 1 本読んだあとに少なくとも待つ時間 */
const MIN_GAP = 2_000;
/** 読むものが無いとき、次に見るまで (エンコードし終えたときは `kickCaptionIndex` ですぐ見る) */
const IDLE = 10 * 60_000;
/** 録り終えてから読み始めるまで。録り終えたその場でエンコードを待ち行列に入れるので、その前に元の TS を読まない */
export const CAPTION_SETTLE = 5 * 60_000;
const SETTLE = CAPTION_SETTLE;
/** 読めなかったときに読み直すまで (回ごとに倍にする) と、読み直す回数 */
const RETRY = 6 * 60 * 60_000;
const ATTEMPTS = 5;
/** 置き場に無かったときに見直すまで */
const WAITING_RETRY = 10 * 60_000;
/** 1 本の録画の中の通し番号の幅 (`captionLineId`) */
const PER_RECORDING = 2 ** 24;

/** 字幕の行の ID。録画の ID を上位に入れる (`schema.captionLines`) */
export function captionLineId(recordingId: number, seq: number): number {
  return recordingId * PER_RECORDING + seq;
}

/**
 * 字幕を読むファイル。`.mkv` (エンコード済みの主) があればそれ、無ければ元の TS (置き場に置いた TS も)。どちらも無ければ null。
 * SQL の `EXPECTED` と同じ決め方
 */
function expectedFile(
  recording: Pick<Recording, "library_path" | "ts_path">,
): string | null {
  const library = recording.library_path;
  if (library?.toLowerCase().endsWith(".mkv") === true) return library;
  return recording.ts_path ?? library;
}

/** `expectedFile` を SQL で (`caption_index` と比べるため。列は置き場からの相対のまま比べる) */
const EXPECTED = sql`CASE WHEN ${recordings.library_path} LIKE '%.mkv' THEN ${recordings.library_path} ELSE COALESCE(${recordings.ts_path}, ${recordings.library_path}) END`;

/** 入れる字幕の 1 枚 */
export interface CaptionLine {
  at_ms: number;
  language: number;
  text: string;
}

/**
 * 取り出した字幕を、入れる行にする。
 *
 * - 時刻は元の TS の物差しに直す (`toTsTime`)。エンコード済みから読んだなら、読んだときの捨てた先頭 (`encode_skip`) と残した区間 (`cm_kept`) で
 * - 観る画面で観られない所の字幕 (捨てた先頭・切った CM の中。`playbackAt` が `before`・`cut`) と、番組が始まる前の余白の字幕 (前の番組のもの) は入れない
 * - 文字の無い 1 枚 (消すための 1 枚) と、すぐ前の 1 枚と同じ文字の 1 枚は入れない (同じ言語の中で)
 * - 第 2 言語から後ろも入れる。言語の番号は字幕管理データのもの (`CaptionPages.language.index`。無ければ 1)
 */
export function captionLinesOf(
  recording: Pick<
    Recording,
    "cm_kept" | "encode_skip" | "start_at" | "ts_head" | "record_from"
  >,
  pages: CaptionPages,
  encoded: boolean,
): CaptionLine[] {
  const ruler: Ruler | null = encoded
    ? { kept: recording.cm_kept, skip: recording.encode_skip ?? 0 }
    : null;
  const programAt = recording.start_at - tsHeadOf(recording);
  const lines: CaptionLine[] = [];
  const languages = [
    { index: pages.language?.index ?? 1, pages: pages.pages },
    ...(pages.others ?? []),
  ];
  for (const { index, pages: list } of languages) {
    let last = "";
    for (const { at, page } of list) {
      const text = captionWords(page);
      if (text === last) continue;
      last = text;
      if (captionKey(text).key === "") continue;
      const ts = toTsTime(at, ruler);
      if (typeof playbackAt(ts, ruler) !== "number") continue;
      const atMs = Math.round(ts * 1000);
      if (atMs < programAt) continue;
      lines.push({ at_ms: atMs, language: index, text });
    }
  }
  return lines.sort((a, b) => a.at_ms - b.at_ms || a.language - b.language);
}

type Tx = Parameters<Parameters<ReturnType<typeof orm>["transaction"]>[0]>[0];
type Db = Tx | ReturnType<typeof orm>;

/** その録画の行をインデックスから消す。FTS5 は中身を持たないので、入れたもの (`captionGrams`) を渡し直して消す */
function removeLines(db: Db, recordingId: number): void {
  const rows = db
    .select({ id: captionLines.id, text: captionLines.text })
    .from(captionLines)
    .where(eq(captionLines.recording_id, recordingId))
    .all();
  for (const row of rows)
    db.run(
      sql`INSERT INTO ${sql.raw(CAPTION_FTS)}(${sql.raw(CAPTION_FTS)}, rowid, grams) VALUES ('delete', ${row.id}, ${captionGrams(captionKey(row.text).key)})`,
    );
  db.delete(captionLines)
    .where(eq(captionLines.recording_id, recordingId))
    .run();
}

/** 録画の字幕のインデックスを消す (録画を消したとき・再エンコードし終えたとき)。次に読むまで、その録画は字幕で当たらない */
export function dropCaptionIndex(recordingId: number): void {
  orm().transaction((tx) => {
    removeLines(tx, recordingId);
    tx.delete(captionIndex)
      .where(eq(captionIndex.recording_id, recordingId))
      .run();
  });
}

/** 録画の行が無くなった (`pruneHistory` で消した) ものを片付ける。FTS5 の行を先に消す */
export function pruneCaptionIndex(): number {
  const live = orm().select({ id: recordings.id }).from(recordings);
  const orphans = orm()
    .selectDistinct({ id: captionLines.recording_id })
    .from(captionLines)
    .where(notInArray(captionLines.recording_id, live))
    .all()
    .map((row) => row.id);
  for (const id of orphans) dropCaptionIndex(id);
  orm()
    .delete(captionIndex)
    .where(notInArray(captionIndex.recording_id, live))
    .run();
  return orphans.length;
}

/**
 * その録画のエンコード (CM 検出のやり直しも) が待っているか走っているか。**別の問い合わせで引く。**
 * 録画の表だけから選ぶ問い合わせに `activeEncodeJobId` を挟むと、列の名前が表の名前なしで出て、中の `id` が encode_jobs の列になる
 */
function encoding(db: Db, recordingId: number): boolean {
  return (
    db
      .select({ id: encodeJobs.id })
      .from(encodeJobs)
      .where(
        and(
          eq(encodeJobs.recording_id, recordingId),
          inArray(encodeJobs.state, ["queued", "running"]),
        ),
      )
      .get() !== undefined
  );
}

/**
 * 読んだときの録画の行 (書く前に、変わっていないかを確かめ直す)。`encode_job` はその録画のいちばん新しいエンコードのジョブの ID で、
 * 読んでいる間に同じ名前へ再エンコードし終えた (ファイルの列も捨てた先頭も変わらない) のを見分ける
 */
export type Snapshot = Pick<
  Recording,
  "id" | "library_path" | "ts_path" | "encode_skip"
> & { encode_job: number | null };

/** その録画のいちばん新しいエンコードのジョブ (CM 検出のやり直しは数えない。字幕は変わらない) */
function lastEncodeJob(db: Db, recordingId: number): number | null {
  return (
    db
      .select({ id: encodeJobs.id })
      .from(encodeJobs)
      .where(
        and(
          eq(encodeJobs.recording_id, recordingId),
          eq(encodeJobs.kind, "encode"),
        ),
      )
      .orderBy(sql`${encodeJobs.id} DESC`)
      .limit(1)
      .get()?.id ?? null
  );
}

/** 読み始めるときの録画の行 */
export function captionSnapshot(
  recording: Pick<Recording, "id" | "library_path" | "ts_path" | "encode_skip">,
): Snapshot {
  return {
    id: recording.id,
    library_path: recording.library_path,
    ts_path: recording.ts_path,
    encode_skip: recording.encode_skip,
    encode_job: lastEncodeJob(orm(), recording.id),
  };
}

/**
 * 読んだ結果を書く。**書く前に、録画の行が読んだときのままかを確かめ直す** (読んでいる間に消された・エンコードが始まった・
 * ファイルの列や捨てた先頭が変わった)。変わっていれば何も書かずに false
 */
export function writeCaptionIndex(
  snapshot: Snapshot,
  result:
    | { state: "done"; lines: CaptionLine[] }
    | { state: "failed"; error: string }
    | { state: "waiting"; error: string },
): boolean {
  return orm().transaction((tx) => {
    const current = tx
      .select({
        library_path: recordings.library_path,
        ts_path: recordings.ts_path,
        encode_skip: recordings.encode_skip,
        deleted_at: recordings.deleted_at,
      })
      .from(recordings)
      .where(eq(recordings.id, snapshot.id))
      .get();
    if (
      current === undefined ||
      current.deleted_at !== null ||
      encoding(tx, snapshot.id) ||
      current.library_path !== snapshot.library_path ||
      current.ts_path !== snapshot.ts_path ||
      current.encode_skip !== snapshot.encode_skip ||
      lastEncodeJob(tx, snapshot.id) !== snapshot.encode_job
    )
      return false;
    const before = tx
      .select({ attempts: captionIndex.attempts })
      .from(captionIndex)
      .where(eq(captionIndex.recording_id, snapshot.id))
      .get();
    const at = now();
    const row = {
      recording_id: snapshot.id,
      version: CAPTION_INDEX_VERSION,
      library_path: snapshot.library_path,
      ts_path: snapshot.ts_path,
      encode_skip: snapshot.encode_skip,
      updated_at: at,
    };
    let values: typeof captionIndex.$inferInsert;
    if (result.state === "done") {
      removeLines(tx, snapshot.id);
      result.lines.forEach((line, seq) => {
        const id = captionLineId(snapshot.id, seq);
        tx.insert(captionLines)
          .values({ id, recording_id: snapshot.id, ...line })
          .run();
        tx.run(
          sql`INSERT INTO ${sql.raw(CAPTION_FTS)}(rowid, grams) VALUES (${id}, ${captionGrams(captionKey(line.text).key)})`,
        );
      });
      values = {
        ...row,
        state: result.lines.length === 0 ? "missing" : "done",
        lines: result.lines.length,
        error: null,
        attempts: 0,
        retry_at: null,
      };
    } else if (result.state === "failed") {
      // 前に読めていた行 (前のファイルから作ったもの) は残す。時刻は元の TS の物差しなので、エンコードの前後で変わらない
      const attempts = (before?.attempts ?? 0) + 1;
      values = {
        ...row,
        state: "failed",
        error: result.error,
        attempts,
        retry_at:
          attempts >= ATTEMPTS ? null : at + RETRY * 2 ** (attempts - 1),
      };
    } else {
      values = {
        ...row,
        state: "waiting",
        error: result.error,
        attempts: before?.attempts ?? 0,
        retry_at: at + WAITING_RETRY,
      };
    }
    tx.insert(captionIndex)
      .values(values)
      .onConflictDoUpdate({ target: captionIndex.recording_id, set: values })
      .run();
    /*
     * **ファイルの列は、録画の行の DB の中の形のまま写す** (`needed` が SQL で比べる)。`mediaPath` は置き場の中なら相対に直して書くが、
     * 録画の行には置き場の中を指す絶対パスのまま入っているものがある (古い行・取り込んだ行)。読んだ値から書くと形が違い、
     * 毎回「ファイルが変わった」と読み直して、ほかの録画に進まなくなる。行が読んだときのままかは上で確かめてある
     */
    tx.run(
      sql`UPDATE ${captionIndex} SET library_path = (SELECT library_path FROM ${recordings} WHERE id = ${snapshot.id}), ts_path = (SELECT ts_path FROM ${recordings} WHERE id = ${snapshot.id}) WHERE recording_id = ${snapshot.id}`,
    );
    return true;
  });
}

/**
 * 字幕を読む録画の条件 (`nextRecording` と `pendingCaptionIndex`)。録り終えて `SETTLE` たち、消していない、エンコードを待っていない、
 * 読むファイルがあって 4K の局の元の録画 (`.mmts`) でない。そのうえで、まだ読んでいないか、読んだときとファイルの列・捨てた先頭・作り方が違うか、
 * 読み直す時刻を過ぎたもの
 */
function needed(at: number) {
  return and(
    isNotNull(recordings.finished_at),
    lte(recordings.finished_at, at - SETTLE),
    isNull(recordings.deleted_at),
    sql`${activeEncodeJobId(recordings.id)} IS NULL`,
    sql`${EXPECTED} IS NOT NULL`,
    sql`${EXPECTED} NOT LIKE '%.mmts'`,
    or(
      isNull(captionIndex.recording_id),
      sql`${captionIndex.version} != ${CAPTION_INDEX_VERSION}`,
      sql`${captionIndex.library_path} IS NOT ${recordings.library_path}`,
      sql`${captionIndex.ts_path} IS NOT ${recordings.ts_path}`,
      sql`${captionIndex.encode_skip} IS NOT ${recordings.encode_skip}`,
      lte(captionIndex.retry_at, at),
    ),
  );
}

/** 次に読む録画 (新しい順)。無ければ undefined */
export function nextRecording(at = now()): Recording | undefined {
  return orm()
    .select({ recording: recordings })
    .from(recordings)
    .leftJoin(captionIndex, eq(captionIndex.recording_id, recordings.id))
    .where(needed(at))
    .orderBy(sql`${recordings.id} DESC`)
    .limit(1)
    .get()?.recording;
}

/** いますぐ読める、まだ字幕のインデックスに入っていない録画の数 (検索の画面の「あと N 本」) */
export function pendingCaptionIndex(at = now()): number {
  return Number(
    orm()
      .select({ n: sql<number>`count(*)` })
      .from(recordings)
      .leftJoin(captionIndex, eq(captionIndex.recording_id, recordings.id))
      .where(needed(at))
      .get()?.n ?? 0,
  );
}

/**
 * 作り方のバージョンが違う行があれば、全部消す (区切り方が変わると、古い行を `'delete'` で消せない)。
 * FTS5 は `'delete-all'` で丸ごと消す
 */
export function wipeOldVersion(): boolean {
  const old = orm()
    .select({ id: captionIndex.recording_id })
    .from(captionIndex)
    .where(sql`${captionIndex.version} != ${CAPTION_INDEX_VERSION}`)
    .limit(1)
    .get();
  if (old === undefined) return false;
  orm().transaction((tx) => {
    tx.run(
      sql`INSERT INTO ${sql.raw(CAPTION_FTS)}(${sql.raw(CAPTION_FTS)}) VALUES ('delete-all')`,
    );
    tx.delete(captionLines).run();
    tx.delete(captionIndex).run();
  });
  return true;
}

/**
 * 1 本の録画の字幕を読んで書く。読んでいる間に録画の行が変わっていれば書かない (`writeCaptionIndex`)。止める合図が来たら何も書かない
 */
export async function indexRecording(
  recording: Recording,
  signal?: AbortSignal,
  snapshot: Snapshot = captionSnapshot(recording),
): Promise<void> {
  const expected = expectedFile(recording);
  if (expected === null || !existsSync(expected)) {
    writeCaptionIndex(snapshot, {
      state: "waiting",
      error: "置き場にファイルがありません",
    });
    return;
  }
  const source = await captionSource(recording);
  // 読むはずのファイルと違うものを読もうとしたら (主のエンコード済みが無く、ほかへ移った) 読まない
  const same =
    source.kind !== "none" &&
    (source.path === expected ||
      (source.kind === "sidecar" && expected === recording.library_path));
  // 置き場に無いのとは違い、すぐには変わらないので、読めなかったときと同じく間を延ばして見直す
  if (source.kind === "none" || source.kind === "mmts" || !same) {
    writeCaptionIndex(snapshot, {
      state: "failed",
      error: "読むはずのファイルから字幕を読めません",
    });
    return;
  }
  const result = await extractCaptions(source, { signal, lowPriority: true });
  if (signal?.aborted === true) return;
  if (result.kind === "failed") {
    writeCaptionIndex(snapshot, { state: "failed", error: result.reason });
    return;
  }
  writeCaptionIndex(snapshot, {
    state: "done",
    lines:
      result.kind === "missing"
        ? []
        : captionLinesOf(recording, result.pages, source.encoded),
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** `timer` が動く時刻 */
let dueAt = Infinity;
/** 読んでいる間に `kickCaptionIndex` で頼まれた時刻 (読み終えたあとに使う) */
let kickedAt = Infinity;
let busy = false;
let stopped = true;
let abort = new AbortController();
/** 始める時刻 (`START_DELAY`)。それより前は `kickCaptionIndex` でも始めない */
let startsAt = 0;

/** その時刻に次を見る。もっと早く見る予定があれば、そちらのまま */
function schedule(at: number): void {
  if (timer !== null) {
    if (dueAt <= at) return;
    clearTimeout(timer);
  }
  dueAt = at;
  timer = setTimeout(() => void step(), Math.max(0, at - Date.now()));
  timer.unref?.();
}

async function step(): Promise<void> {
  timer = null;
  dueAt = Infinity;
  if (busy || stopped) return;
  busy = true;
  let wait = IDLE;
  try {
    if (wipeOldVersion())
      console.log(
        "[caption-index] 作り方が変わったので、字幕のインデックスを作り直します",
      );
    const recording = nextRecording();
    if (recording !== undefined) {
      const started = Date.now();
      // 読み始めたときの行。例外で終わったときも、これと比べて書く (読んでいる間に変わっていれば書かない)
      const snapshot = captionSnapshot(recording);
      try {
        await indexRecording(recording, abort.signal, snapshot);
      } catch (error) {
        // 例外で終わった録画も失敗として覚える (覚えないと、次の回も同じ録画を選び、ほかの録画を読めなくなる)
        // ここでも書けない (DB に書けない) ときは外の catch で記録に残すだけにする。DB に書けないなら、ほかの録画も書けない
        console.error(`[caption-index] 録画 ${recording.id}: ${error}`);
        writeCaptionIndex(snapshot, {
          state: "failed",
          error: String(error),
        });
      }
      wait = Math.max(MIN_GAP, Date.now() - started);
    }
  } catch (error) {
    console.error(`[caption-index] ${error}`);
  } finally {
    busy = false;
    if (!stopped) {
      schedule(Math.min(Date.now() + wait, Math.max(kickedAt, Date.now())));
      kickedAt = Infinity;
    }
  }
}

/** 後から埋める仕事を始める (`runtime.start`) */
export function startCaptionIndex(): void {
  if (!stopped) return;
  stopped = false;
  abort = new AbortController();
  startsAt = Date.now() + START_DELAY;
  kickedAt = Infinity;
  schedule(startsAt);
}

/**
 * 読むものが増えたので、`delay` ms 後に次を見る (読むものが無くて `IDLE` の間待っていても)。
 * エンコードし終えた・失敗したときはすぐ、録り終えた・取り込んだときは読めるようになる `CAPTION_SETTLE` 後。
 * 起動から `START_DELAY` の間は、その時刻まで待つ
 */
export function kickCaptionIndex(delay = 0): void {
  if (stopped) return;
  const at = Math.max(startsAt, Date.now() + delay);
  if (busy) kickedAt = Math.min(kickedAt, at);
  else schedule(at);
}

/** 止める (`runtime.stop`)。読んでいる ffmpeg も止める。書きかけは 1 つのトランザクションなので残らない */
export function stopCaptionIndex(): void {
  stopped = true;
  abort.abort();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  dueAt = Infinity;
  kickedAt = Infinity;
}
