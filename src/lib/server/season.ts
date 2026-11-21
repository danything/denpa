/**
 * **季節の演出の、サーバが持つところ** (docs/screens.md「季節の演出」)。
 *
 * - 演出を出すか (`seasonal`) は世帯の設定 (`settings.ts`。既定はオン)
 * - 「denpa の 1 年」のチップを閉じた年は世帯で 1 つ覚える (設定の表の `greetedYear`)。端末ごとではないので、家族の 1 人が閉じたらほかの端末にも出ない
 * - 去年の数は手元の DB (録画の行) から集めるだけで、外には何も送らない
 */
import { and, desc, gte, isNotNull, lt, ne, sql } from "drizzle-orm";

import { newYearOf, type YearSummary } from "../season";
import { orm } from "./db";
import { recordings } from "./schema";
import { store, stored } from "./settings";

const GREETED_KEY = "greetedYear";

/** 「denpa の 1 年」のチップを最後に閉じた年。まだなら null */
export function greetedYear(): number | null {
  const value = Number(stored(GREETED_KEY));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * `year` 年の「denpa の 1 年」のチップを閉じたと覚える。**もう閉じていたら false**。
 * 読んでから書くまでの間に別の呼び出しは入らない (DB の呼び出しは同期で、1 つのプロセスが順に流す)
 */
export function markGreeted(year: number): boolean {
  if (greetedYear() === year) return false;
  store(GREETED_KEY, String(year));
  return true;
}

/**
 * `year` 年 (日本時間の 1 月 1 日 0:00 から次の年の 1 月 1 日 0:00 まで) に始まった録画の数。
 *
 * - 本数と長さは、失敗したもの (`failed`) と録画中のものを入れない。あとで消したものは入れる (録ったことは変わらない)
 * - 長さは実際に録れた長さ (`duration_ms`)。測れていない古い行は番組の尺
 * - いちばん録った局は本数で選ぶ。同じ本数なら長いほう、それも同じなら名前の順
 * - 観終えた録画は、観終えた時刻 (`watched_at`) がその年のもの。いちばん観た局も同じ本数で選ぶ
 */
export function yearSummary(year: number): YearSummary {
  const from = newYearOf(year);
  const to = newYearOf(year + 1);
  const length = sql<number>`coalesce(${recordings.duration_ms}, ${recordings.end_at} - ${recordings.start_at})`;
  const recordedIn = and(
    gte(recordings.start_at, from),
    lt(recordings.start_at, to),
    isNotNull(recordings.finished_at),
    ne(recordings.state, "failed"),
  );
  const total = orm()
    .select({
      count: sql<number>`count(*)`,
      ms: sql<number>`coalesce(sum(max(${length}, 0)), 0)`,
    })
    .from(recordings)
    .where(recordedIn)
    .get();
  const topRecorded = orm()
    .select({ name: recordings.service_name })
    .from(recordings)
    .where(and(recordedIn, ne(recordings.service_name, "")))
    .groupBy(recordings.service_name)
    .orderBy(
      desc(sql`count(*)`),
      desc(sql`sum(max(${length}, 0))`),
      recordings.service_name,
    )
    .limit(1)
    .get();
  const watchedIn = and(
    gte(recordings.watched_at, from),
    lt(recordings.watched_at, to),
  );
  const watched = orm()
    .select({ count: sql<number>`count(*)` })
    .from(recordings)
    .where(watchedIn)
    .get();
  const topWatched = orm()
    .select({ name: recordings.service_name })
    .from(recordings)
    .where(and(watchedIn, ne(recordings.service_name, "")))
    .groupBy(recordings.service_name)
    .orderBy(desc(sql`count(*)`), recordings.service_name)
    .limit(1)
    .get();
  return {
    year,
    recorded: total?.count ?? 0,
    recordedMs: total?.ms ?? 0,
    topRecorded: topRecorded?.name ?? null,
    watched: watched?.count ?? 0,
    topWatched: topWatched?.name ?? null,
  };
}
