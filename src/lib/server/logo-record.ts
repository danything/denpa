import { desc, lt, notInArray } from "drizzle-orm";

import type { CarouselCounts } from "../ts/logo-dsmcc";
import { orm } from "./db";
import { logoRecords } from "./schema";
import { settings } from "./settings";

/**
 * **ロゴを取得した記録** (docs/logo.md「ロゴの取得を記録する」)。デバッグ用で、設定の `recordLogo` がオンの間だけ書く。
 *
 * 衛星のロゴは全受信機共通データとして、ダウンロードの期間の間だけ流れる。期間がいつ来るかは前もって分からないので、
 * 当たりの中継で待つたびに、いつ・どれだけ開いて・何が来たかを残し、期間の間隔と長さを実測で知る。
 * ログの 1 行 (`logo.waitedMessage`) と同じ中身だが、ログはサーバを入れ替えると消えるので DB に置く
 */

/** 残す行の上限。新しい順にこれを越えたぶんを消す */
export const LOGO_RECORD_KEEP = 2_000;

/** 残す日数。これより古い行を消す */
export const LOGO_RECORD_DAYS = 60;

type LogoRecord = typeof logoRecords.$inferSelect;

/** 1 回ぶん。開けなかった回 (`counts` が null) は読んだ数を 0 で残す */
interface LogoAttempt {
  startedAt: number;
  channel: string;
  origin: "wait" | "now";
  openedMs: number;
  outcome: string;
  received: boolean;
  found: number;
  counts: Readonly<CarouselCounts> | null;
}

/** 設定がオンなら 1 行足し、上限を越えたぶんを消す。オフなら何もしない */
export function recordLogoAttempt(
  attempt: LogoAttempt,
  now = Date.now(),
): void {
  if (!settings().recordLogo) return;
  // デバッグ用の記録なので、書けなくても (ディスクが満杯・DB のロックなど) ロゴの取得は止めない
  try {
    write(attempt, now);
  } catch (error) {
    console.warn(`[logo] ロゴの取得の記録を書けませんでした: ${String(error)}`);
  }
}

function write(attempt: LogoAttempt, now: number): void {
  const c = attempt.counts;
  const db = orm();
  db.insert(logoRecords)
    .values({
      started_at: attempt.startedAt,
      channel: attempt.channel,
      origin: attempt.origin,
      opened_ms: attempt.openedMs,
      outcome: attempt.outcome,
      received: attempt.received,
      found: attempt.found,
      packets: c?.packets ?? 0,
      errors: c?.errors ?? 0,
      pmt: c?.pmt ?? false,
      es_pids: c?.esPids ?? 0,
      es_packets: c?.esPackets ?? 0,
      dii: c?.dii ?? 0,
      ddb: c?.ddb ?? 0,
      sdtt: c?.sdtt ?? 0,
    })
    .run();
  pruneLogoRecords(now);
}

/** 古い行と、上限を越えた行を消す */
function pruneLogoRecords(now: number): void {
  const db = orm();
  db.delete(logoRecords)
    .where(lt(logoRecords.started_at, now - LOGO_RECORD_DAYS * 86_400_000))
    .run();
  const kept = db
    .select({ id: logoRecords.id })
    .from(logoRecords)
    .orderBy(desc(logoRecords.started_at), desc(logoRecords.id))
    .limit(LOGO_RECORD_KEEP)
    .all()
    .map((row) => row.id);
  if (kept.length < LOGO_RECORD_KEEP) return;
  db.delete(logoRecords).where(notInArray(logoRecords.id, kept)).run();
}

/** 新しい順に `limit` 行まで */
export function logoRecordList(limit = LOGO_RECORD_KEEP): LogoRecord[] {
  return orm()
    .select()
    .from(logoRecords)
    .orderBy(desc(logoRecords.started_at), desc(logoRecords.id))
    .limit(limit)
    .all();
}

/** CSV の列 (見出しと値の取り出し)。時刻は ISO 8601 (UTC) */
const COLUMNS: [string, (r: LogoRecord) => string | number][] = [
  ["started_at", (r) => new Date(r.started_at).toISOString()],
  ["channel", (r) => r.channel],
  ["origin", (r) => r.origin],
  ["opened_s", (r) => Math.round(r.opened_ms / 1000)],
  ["outcome", (r) => r.outcome],
  ["received", (r) => (r.received ? 1 : 0)],
  ["found", (r) => r.found],
  ["packets", (r) => r.packets],
  ["errors", (r) => r.errors],
  ["pmt", (r) => (r.pmt ? 1 : 0)],
  ["es_pids", (r) => r.es_pids],
  ["es_packets", (r) => r.es_packets],
  ["dii", (r) => r.dii],
  ["ddb", (r) => r.ddb],
  ["sdtt", (r) => r.sdtt],
];

/** 記録を CSV にする (見出し付き、古い順)。値に `,` や引用符は入らない (中継の名前・終わり方は英数字と `:`) */
export function logoRecordCsv(rows: readonly LogoRecord[]): string {
  const lines = [COLUMNS.map(([name]) => name).join(",")];
  for (const row of [...rows].reverse())
    lines.push(COLUMNS.map(([, get]) => String(get(row))).join(","));
  return `${lines.join("\n")}\n`;
}
