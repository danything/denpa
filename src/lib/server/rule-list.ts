import {
  and,
  desc,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";

import { now, orm } from "./db";
import { recordings, reservations, rules as ruleTable } from "./schema";

/**
 * **ルールの一覧** (`/rules`)。書く欄は検索の画面に移したので、ここは並べて見比べ、止める・消すだけ。
 *
 * 行ごとに、これから録るもの (予約の数・次の放送・競合) と、録れたもの (録画の数・最後に録れた日) を添える。
 * どれも1本の SQL で数える (ルールが数百あっても行ごとに問い合わせない)
 */

/** 一週間 */
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * まだ録っていない予約 (終わったもの・取り消したもの・録らないと決めたものは数えない)。
 * 下の数えるところは予約を `r`、録画を `v`、局を `s` と呼ぶ (局・予約・ルールはどれも `name` を持つので、別名で引く)
 */
const PENDING = sql.raw(
  `r.state IN ('scheduled', 'conflict') AND r.started_at IS NULL`,
);
/** 外側のルール */
const RULE = sql.raw('"rules"."id"');

export interface RuleRow {
  id: number;
  name: string;
  keyword: string;
  ignore_keyword: string;
  search_fields: string;
  service_ids: number[] | null;
  service_types: string[] | null;
  genres: string[] | null;
  enabled: boolean;
  priority: number;
  dedupe: boolean;
  skip_earlier: boolean;
  /** これから録る予約の数 */
  reservations: number;
  /** そのうちチューナーが足りないもの */
  conflicts: number;
  /** 次の放送 (いちばん近い予約)。無ければ null */
  next: { start_at: number; service_name: string } | null;
  /** このルールで録れた録画 (失敗と消したものは数えない) */
  recordings: number;
  /** 最後に録れた放送の開始。無ければ null。**消したものも入れる** — 録れたかどうかの記録で、持っている数 (上) とは別 */
  last_recorded_at: number | null;
}

export interface RuleSummary {
  /** これから一週間の予約 (ルールも手動も) */
  weekReservations: number;
  /** この一週間に録れた録画。**消したものも入れる** (`RuleRow.last_recorded_at` と同じ) */
  lastWeekRecordings: number;
}

/** 一覧の行。新しいルールが上 (並べ替えは画面で) */
export function listRules(): RuleRow[] {
  const rows = orm()
    .select({
      ...getTableColumns(ruleTable),
      reservations: sql<number>`(SELECT COUNT(*) FROM reservations r
                WHERE r.rule_id = ${RULE} AND ${PENDING})`.mapWith(Number),
      conflicts: sql<number>`(SELECT COUNT(*) FROM reservations r
                WHERE r.rule_id = ${RULE} AND ${PENDING} AND r.state = 'conflict')`.mapWith(
        Number,
      ),
      next_at: sql<number | null>`(SELECT MIN(r.start_at) FROM reservations r
                WHERE r.rule_id = ${RULE} AND ${PENDING})`,
      next_service: sql<
        string | null
      >`(SELECT s.name FROM reservations r JOIN services s ON s.id = r.service_id
                WHERE r.rule_id = ${RULE} AND ${PENDING} ORDER BY r.start_at LIMIT 1)`,
      recordings:
        sql<number>`(SELECT COUNT(*) FROM recordings v JOIN reservations r ON r.id = v.reservation_id
                WHERE r.rule_id = ${RULE} AND v.state != 'failed' AND v.deleted_at IS NULL)`.mapWith(
          Number,
        ),
      last_recorded_at: sql<
        number | null
      >`(SELECT MAX(v.start_at) FROM recordings v
                JOIN reservations r ON r.id = v.reservation_id
                WHERE r.rule_id = ${RULE} AND v.state != 'failed')`,
    })
    .from(ruleTable)
    .orderBy(desc(ruleTable.id))
    .all();
  return rows.map(
    ({
      next_at,
      next_service,
      source: _source,
      created_at: _created,
      ...row
    }) => ({
      ...row,
      next:
        next_at === null
          ? null
          : { start_at: next_at, service_name: next_service ?? "" },
    }),
  );
}

/** 一覧の上に出す数 */
export function ruleSummary(at = now()): RuleSummary {
  const week = orm()
    .select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(reservations)
    .where(
      and(
        inArray(reservations.state, ["scheduled", "conflict"]),
        isNull(reservations.started_at),
        gt(reservations.start_at, at),
        lte(reservations.start_at, at + WEEK),
      ),
    )
    .get();
  const recorded = orm()
    .select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(recordings)
    .where(
      and(
        ne(recordings.state, "failed"),
        gt(recordings.start_at, at - WEEK),
        lte(recordings.start_at, at),
      ),
    )
    .get();
  return {
    weekReservations: week?.n ?? 0,
    lastWeekRecordings: recorded?.n ?? 0,
  };
}
