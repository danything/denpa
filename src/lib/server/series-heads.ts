/**
 * **学んだシリーズの先頭を持ち、番組名をシリーズ名にする** (`series.ts` の学ぶ・当てるを DB とつなぐ)。
 *
 * - `seriesName` / `seriesParts` は、表 (`series_heads`) の写しをメモリに持って当てる。写しは最初に呼ばれたときに同期で読む
 *   (起動して最初の `epg.settle` より前に録り始めても、前と同じ名前になる)
 * - 学び直す (`relearn`) のは番組表を取得し終えたとき (`epg.settle` が `scheduleRelearn` を呼ぶ)。
 *   `epg.settle` の外で、`LEARN_STEP` 行ごとに `setImmediate` で処理を区切って動かす。**控えも録画も変わっていなければ学ばない**
 * - `runtime.ts` が `enableRelearn` を呼ぶまでは学ばない (単体テストと `DENPA_AUTOSTART=0` は表を読むだけ)
 */
import { and, asc, count, eq, gt, inArray, lt, max, ne } from "drizzle-orm";

import { affected, now, orm } from "./db";
import {
  programs,
  recordedHistory,
  recordings,
  seriesHeads,
  seriesTitles,
  services,
} from "./schema";
import {
  LEARN_STEP,
  learnSteps,
  type SeriesRow,
  splitSeries,
  stationKey,
  strictSeries,
  titleKey,
} from "./series";

const DAY = 24 * 60 * 60_000;
/**
 * 控えを残す日数。90 日は 1 クール (13 週) と少しで、週 1 回の番組が控えに十分な回数残る。
 * 本番の番組表 (321 局) では、控えの行が 1 日に約 1,250 行ずつ増えた (2026 年 11 月の 9 日分)。90 日で 12 万行ほどになる見込み
 */
export const SERIES_KEEP_DAYS = 90;
/** 採らなくなった先頭を残す日数。番組表の 9 日分を超える間は残し、番組表の出入りでまとまりが揺れないようにする */
export const SERIES_HOLD_DAYS = 14;

let heads: Set<string> | null = null;
/** 番組名ごとの切り方 (一覧は表示のたびに全部の行を切るので覚えておく)。先頭が変わったら捨てる */
const splits = new Map<string, { series: string; rest: string }>();
/** 覚える番組名の数の上限。超えたら全部捨てて覚え直す */
const SPLITS_MAX = 20_000;

function useHeads(keys: Iterable<string>): void {
  heads = new Set(keys);
  splits.clear();
}

/** 表の先頭を読み直す (起動時に 1 度。学び直したあとは `relearn` が入れ替える) */
export function reloadHeads(): void {
  useHeads(
    orm()
      .select({ key: seriesHeads.key })
      .from(seriesHeads)
      .all()
      .map(({ key }) => key),
  );
}

/** 単体テストで、DB を読まずに先頭を決める */
export function headsForTest(keys: Iterable<string>): void {
  useHeads(keys);
}

function split(name: string): { series: string; rest: string } {
  if (heads === null) reloadHeads();
  const known = splits.get(name);
  if (known !== undefined) return known;
  if (splits.size >= SPLITS_MAX) splits.clear();
  const result = splitSeries(name, heads!);
  splits.set(name, result);
  return result;
}

/**
 * **番組名をシリーズ名と副題に分ける** (録画のフォルダ名とファイル名の後ろ)。
 * 先頭で切って残ったもの (`ダークサイドミステリー` の後ろの `連続怪死！…`) は副題の前に付ける
 */
export function seriesParts(
  name: string,
  subtitle: string,
): { series: string; subtitle: string } {
  const { series, rest } = split(name);
  return {
    series,
    subtitle: [rest, subtitle].filter((part) => part !== "").join(" "),
  };
}

/** **番組のシリーズ名。** 録画のフォルダ名・「まとめて表示」・「ルールを作る」の下書きはどれもこれで決める */
export function seriesName(name: string): string {
  return split(name).series;
}

let enabled = false;
let scheduled = false;
let running = false;
let again = false;

/** 学び直してよいことにする (`runtime.ts`) */
export function enableRelearn(): void {
  enabled = true;
}

/** 番組表が変わった (`epg.settle`)。学び直しを、いまの処理のあとに回す */
export function scheduleRelearn(): void {
  if (!enabled) return;
  if (running) {
    again = true;
    return;
  }
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    running = true;
    relearn()
      .catch((error) =>
        console.warn(`[series] シリーズの先頭を学べませんでした: ${error}`),
      )
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          scheduleRelearn();
        }
      });
  }, 0).unref?.();
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 前に見た番組表の書き換えの時刻。これより後に書き換わった番組だけ控えに足す */
let observedThrough = 0;
/** 前に学んだときの録画と引き継いだ履歴 (変わっていなければ、控えが変わらない限り学ばない) */
let lastInput: string | null = null;
/** 控えが変わったのに、まだ学び終えていない (学ぶ途中で失敗しても、次に学び直す) */
let unlearned = false;

/** 控えの 1 行 (局と名前の組) にまとめたもの */
interface Seen {
  station: string;
  series: string;
  title: string;
  titles: number;
  movieOnly: boolean;
}

function seen(
  into: Map<string, Seen>,
  serviceName: string,
  name: string,
  /** ジャンルが映画だけか。ジャンルを持たない行 (録画・引き継いだ履歴) は null で、印を変えない */
  movieOnly: boolean | null,
): void {
  const station = stationKey(serviceName);
  if (station === null || name.trim() === "") return;
  const series = strictSeries(name);
  const title = titleKey(name);
  const key = `${station}\t${series}`;
  const entry = into.get(key);
  if (entry === undefined)
    into.set(key, {
      station,
      series,
      title,
      titles: 1,
      movieOnly: movieOnly ?? false,
    });
  else {
    if (entry.titles === 1 && entry.title !== title) entry.titles = 2;
    // 映画だけの印は、見た番組がどれも映画だけのときだけ (混ざっていたら外す)
    if (movieOnly !== null) entry.movieOnly &&= movieOnly;
  }
}

/** 番組表で書き換わった番組を控えに足す。控えの中身 (行・回の種類・映画の印) が変わったら true */
async function observe(at: number): Promise<boolean> {
  const rows = orm()
    .select({
      name: programs.name,
      genres: programs.genres,
      updated_at: programs.updated_at,
      service_name: services.name,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(gt(programs.updated_at, observedThrough))
    .orderBy(asc(programs.id))
    .all();
  const batch = new Map<string, Seen>();
  // 書き終えてから進める。途中で失敗したら、次は同じ番組から読み直す
  let through = observedThrough;
  for (const row of rows) {
    const genres = row.genres ?? [];
    seen(
      batch,
      row.service_name,
      row.name,
      genres.length > 0 && genres.every((genre) => genre === 6),
    );
    through = Math.max(through, row.updated_at);
  }
  let changed = false;
  const entries = [...batch.values()];
  for (let i = 0; i < entries.length; i += LEARN_STEP) {
    orm().transaction((tx) => {
      for (const entry of entries.slice(i, i + LEARN_STEP)) {
        const same = and(
          eq(seriesTitles.station, entry.station),
          eq(seriesTitles.series, entry.series),
        );
        const inserted = affected(
          tx
            .insert(seriesTitles)
            .values({
              station: entry.station,
              series: entry.series,
              title: entry.title,
              titles: entry.titles,
              movie_only: entry.movieOnly,
              last_seen: at,
            })
            .onConflictDoNothing(),
        );
        if (inserted > 0) {
          changed = true;
          continue;
        }
        const more = affected(
          tx
            .update(seriesTitles)
            .set({ titles: 2 })
            .where(
              and(
                same,
                eq(seriesTitles.titles, 1),
                entry.titles === 2
                  ? undefined
                  : ne(seriesTitles.title, entry.title),
              ),
            ),
        );
        // 映画だけの印は外すだけ (一度でもほかのジャンルで流れたら、映画だけの番組ではない)。行ったり来たりして毎回学び直さない
        const movie = entry.movieOnly
          ? 0
          : affected(
              tx
                .update(seriesTitles)
                .set({ movie_only: false })
                .where(and(same, eq(seriesTitles.movie_only, true))),
            );
        if (more + movie > 0) changed = true;
        tx.update(seriesTitles).set({ last_seen: at }).where(same).run();
      }
    });
    await pause();
  }
  observedThrough = through;
  return changed;
}

/**
 * 録画と引き継いだ履歴の目印。行が増えた・消えたら変わる。`updated_at` は観た位置を書くたびに変わるので見ない
 * (録っている間に p/f で名前が変わったぶんは、次に控えか行が変わったときに学ぶ)
 */
function inputMark(): string {
  const rec = orm()
    .select({ n: count(), id: max(recordings.id) })
    .from(recordings)
    .get();
  const history = orm()
    .select({ n: count(), id: max(recordedHistory.id) })
    .from(recordedHistory)
    .get();
  return JSON.stringify([rec, history]);
}

/**
 * **控えに番組表を足し、シリーズの先頭を学び直す。** 古い控えはここで消す (`SERIES_KEEP_DAYS`)。
 * 控えも録画も変わっていなければ学ばない (学んだら true)
 */
export async function relearn(): Promise<boolean> {
  const at = now();
  const started = performance.now();
  let changed = await observe(at);
  const pruned = affected(
    orm()
      .delete(seriesTitles)
      .where(lt(seriesTitles.last_seen, at - SERIES_KEEP_DAYS * DAY)),
  );
  if (pruned > 0) changed = true;
  const mark = inputMark();
  // 覚えるのは学び終えてから。途中で失敗したら、入力が変わらなくても次に学び直す
  if (changed) unlearned = true;
  if (!unlearned && mark === lastInput) return false;

  // 読む順を決めておく (学ぶ結果は順に依らないが、同じ控えからは同じ並びで学ぶ)
  const merged = new Map<string, Seen>();
  for (const row of orm()
    .select()
    .from(seriesTitles)
    .orderBy(asc(seriesTitles.station), asc(seriesTitles.series))
    .all()) {
    merged.set(`${row.station}\t${row.series}`, {
      station: row.station,
      series: row.series,
      title: row.title,
      titles: row.titles,
      movieOnly: row.movie_only,
    });
  }
  await pause();
  for (const row of orm()
    .select({ name: recordings.name, service_name: recordings.service_name })
    .from(recordings)
    .where(ne(recordings.state, "failed"))
    .orderBy(asc(recordings.id))
    .all())
    seen(merged, row.service_name, row.name, null);
  for (const row of orm()
    .select({
      name: recordedHistory.name,
      service_name: recordedHistory.service_name,
    })
    .from(recordedHistory)
    .orderBy(asc(recordedHistory.id))
    .all())
    seen(merged, row.service_name, row.name, null);
  await pause();

  const rows: SeriesRow[] = [...merged.values()].map(
    ({ station, series, titles, movieOnly }) => ({
      station,
      series,
      titles,
      movieOnly,
    }),
  );
  const steps = learnSteps(rows);
  let step = steps.next();
  while (step.done !== true) {
    await pause();
    step = steps.next();
  }
  const learned = step.value;

  const kept = orm().transaction((tx) => {
    for (const key of learned.heads)
      tx.insert(seriesHeads)
        .values({ key, last_adopted: at })
        .onConflictDoUpdate({
          target: seriesHeads.key,
          set: { last_adopted: at },
        })
        .run();
    const dropped = tx
      .select()
      .from(seriesHeads)
      .all()
      .filter(
        ({ key, last_adopted }) =>
          !learned.heads.has(key) &&
          (learned.frames.has(key) ||
            last_adopted < at - SERIES_HOLD_DAYS * DAY),
      )
      .map(({ key }) => key);
    for (let i = 0; i < dropped.length; i += 500)
      tx.delete(seriesHeads)
        .where(inArray(seriesHeads.key, dropped.slice(i, i + 500)))
        .run();
    return tx
      .select({ key: seriesHeads.key })
      .from(seriesHeads)
      .all()
      .map(({ key }) => key);
  });
  lastInput = mark;
  unlearned = false;
  useHeads(kept);
  console.log(
    `[series] シリーズの先頭を学びました: ${kept.length} (控え ${rows.length} 行・${Math.round(performance.now() - started)} ms)`,
  );
  return true;
}

/** 単体テストで、前に学んだ印を忘れさせる */
export function forgetForTest(): void {
  observedThrough = 0;
  lastInput = null;
  unlearned = false;
  heads = null;
  splits.clear();
}
