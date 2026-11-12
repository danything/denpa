import {
  and,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { COPY_NEVER_REASON } from "../format";
import type { Reservation } from "../types";
import { shareKey } from "./agent-channels";
import { config } from "./config";
import { assign, type Busy, type Capacity, capacityOf } from "./conflict";
import { checkContracts } from "./contracts";
import { affected, now, orm } from "./db";
import { emit } from "./events";
import {
  activeRecordingIds,
  failStrayRecordings,
  recordingUntil,
  startRecording,
  stopRecording,
} from "./recorder";
import { plannedStartSql } from "./recording";
import {
  HELD_STATES,
  programs,
  recordings,
  reservations,
  services,
  TO_RECORD_STATES,
} from "./schema";
import { isDraining } from "./shutdown";
import {
  type AgentTuner,
  getTuners,
  recordingHolds,
  recordingOf,
  recordingUse,
  type StreamUse,
} from "./tuner";

interface Candidate extends Reservation {
  type: string;
  channel: string;
  /** 番組表でコピー禁止と言われているか。番組表から消えていれば false */
  copy_never: boolean;
}

/**
 * チューナーの様子。**予約の割り振り (`assign`) とルールの下見 (`rule-preview.ts`) が同じものを読む。**
 *
 * - `capacity`: 動いているチューナーを、エージェントが選ぶ順 (`rank`) に組にしたもの (`Capacity`)
 * - `busy`: 録画中の予約が、いまどのチューナーにいて、いつ離すか (tuner.ts の `recordingHolds`)
 *
 * エージェントに繋がらないときは空 (「制限なし」) を返し、予約を勝手に conflict にしない (実際に
 * 録画が始まるときにあちらが弾くので、予約表を壊すより実行時に失敗させるほうが害が小さい)。
 */
export async function tunerState(): Promise<{
  capacity: Capacity;
  busy: Busy[];
}> {
  let tuners: AgentTuner[];
  try {
    tuners = await getTuners();
  } catch {
    return { capacity: [], busy: [] };
  }
  const capacity = capacityOf(tuners);
  if (capacity.length === 0) return { capacity, busy: [] };
  const ids = tuners.flatMap((t) =>
    t.users.flatMap((u) => recordingOf(u.use) ?? []),
  );
  const until = new Map(
    ids.length === 0
      ? []
      : orm()
          .select({
            id: recordings.id,
            end_at: recordings.end_at,
            record_to: recordings.record_to,
          })
          .from(recordings)
          .where(inArray(recordings.id, ids))
          .all()
          .map((rec) => [rec.id, recordingUntil(rec)] as const),
  );
  return { capacity, busy: recordingHolds(tuners, (id) => until.get(id)) };
}

export async function resolveConflicts(): Promise<{
  accepted: number;
  rejected: number;
}> {
  const { capacity, busy } = await tunerState();
  const all: Candidate[] = orm()
    .select({
      ...getTableColumns(reservations),
      type: services.type,
      channel: shareKey(),
      copy_never: sql<boolean>`COALESCE(${programs.copy_never}, 0) = 1`.mapWith(
        Boolean,
      ),
    })
    .from(reservations)
    .innerJoin(services, eq(services.id, reservations.service_id))
    .leftJoin(programs, eq(programs.id, reservations.program_id))
    .where(
      and(
        inArray(reservations.state, HELD_STATES),
        // 録り始めたものは数え直さない。使うチューナーはもう決まっている
        isNull(reservations.started_at),
        gt(reservations.end_at, now()),
      ),
    )
    .orderBy(reservations.start_at)
    .all();
  /*
   * **コピー禁止の番組はチューナーの割り振りに入れない。** 録画しないのでチューナーを取り合わない。
   * 番組表が書き換わって禁止でなくなったものは、ここで割り振りに戻る
   */
  const skipped = all.filter((c) => c.copy_never);
  const candidates = all.filter((c) => !c.copy_never);

  // 前後のマージンぶんチューナーを使う時間は延びる。予約表と実行時のズレを無くすため
  // 同じ物差しで数える
  const { accepted, rejected } = assign(
    candidates,
    capacity,
    {
      start: config.startMargin,
      end: config.endMargin,
    },
    busy,
  );

  const at = now();
  orm().transaction((tx) => {
    for (const s of skipped) {
      tx.update(reservations)
        .set({
          state: "skipped",
          conflict_reason: COPY_NEVER_REASON,
          updated_at: at,
        })
        .where(
          and(
            eq(reservations.id, s.id),
            inArray(reservations.state, TO_RECORD_STATES),
          ),
        )
        .run();
    }
    for (const a of accepted) {
      tx.update(reservations)
        .set({ state: "scheduled", conflict_reason: null, updated_at: at })
        .where(
          and(
            eq(reservations.id, a.reservation.id),
            inArray(reservations.state, ["conflict", "skipped"]),
          ),
        )
        .run();
      /*
       * **譲ったぶんを覚える。マージンだけ譲ったものも。** 譲っていなければ NULL に戻す。
       * 前の回で削られていても、相手が消えれば丸ごと録れるようになる。
       *
       * マージンだけのときに NULL にしていた頃は、隣り合う番組で前が終了マージンまで使い続け、
       * 後ろが開始マージンから使おうとしていた。割り振りの通りに離さないと、後ろは別のチューナーに
       * 入る (兼用のチューナーを塞いで、その後の衛星が録れない) か、空き待ちで冒頭が欠ける。
       * 「欠けます」のラベルはマージンだけなら出ない (`format.clipNote` は番組の時刻と比べる)
       */
      const from =
        a.from === a.reservation.start_at - config.startMargin ? null : a.from;
      const to = a.to === a.reservation.end_at + config.endMargin ? null : a.to;
      tx.update(reservations)
        .set({ record_from: from, record_to: to, updated_at: at })
        .where(
          and(
            eq(reservations.id, a.reservation.id),
            or(
              sql`${reservations.record_from} IS NOT ${from}`,
              sql`${reservations.record_to} IS NOT ${to}`,
            ),
          ),
        )
        .run();
    }
    for (const r of rejected) {
      tx.update(reservations)
        .set({ state: "conflict", conflict_reason: r.reason, updated_at: at })
        .where(
          and(
            eq(reservations.id, r.reservation.id),
            inArray(reservations.state, ["scheduled", "skipped"]),
          ),
        )
        .run();
    }
  });
  emit("reservations");

  return { accepted: accepted.length, rejected: rejected.length };
}

/** 有料放送の契約を確かめ直す間隔。契約の切り替わりは日の単位なので、1 日 2 回で足りる */
const CONTRACT_SCAN_MS = 12 * 3_600_000;
let lastContractScan = 0;

/**
 * 走らせる処理を 1 本ずつにする。走っている間に呼ばれたら、終わったあとに 1 回だけ走らせ直す
 * (何回呼ばれても 1 回にまとめる)。返す Promise は、走らせ直した分まで終わったら済む。`run` は投げないこと
 */
export function oneAtATime(
  run: () => Promise<void>,
): (() => Promise<void>) & { readonly running: boolean } {
  let current: Promise<void> | null = null;
  let again = false;
  const call = (): Promise<void> => {
    if (current !== null) {
      again = true;
      return current;
    }
    current = (async () => {
      do {
        again = false;
        await run();
      } while (again);
    })().finally(() => {
      current = null;
    });
    return current;
  };
  return Object.defineProperty(call, "running", {
    get: () => current !== null,
  }) as (() => Promise<void>) & { readonly running: boolean };
}

/**
 * 有料放送の契約を確かめ直す。12 時間ごとの `tick` と、カードが契約の更新 (EMM) を受け入れたという
 * エージェントの通知 (`card`。runtime.ts) から呼ぶ。走っている間に呼ばれたら、終わったあとに 1 回だけ確かめ直す。
 * カードが無ければ断られて、記録に 1 行出る
 */
export const recheckContracts = oneAtATime(async () => {
  lastContractScan = now();
  try {
    await checkContracts();
  } catch (error) {
    console.warn(`[contracts] 契約を確かめ直せませんでした: ${error}`);
  }
});

/**
 * `schedulerTick` (既定 5 秒) ごとに呼ばれる本体。開始時刻に達した予約を録画に移し、終了時刻を過ぎた録画を止める。
 * 録画の終わり方 (完了・失敗) は recorder.ts が書く。
 */
export async function tick(): Promise<void> {
  const at = now();

  // 有料放送の契約を確かめ直す (12 時間ごと)。自動予約は契約中と確かめた局しか録らないので、確かめ直さないと
  // 契約を足しても切れても予約に効かない
  if (!recheckContracts.running && at - lastContractScan >= CONTRACT_SCAN_MS) {
    void recheckContracts();
  }

  // 止めるほうを先にやる。次の番組が始まるときに前の録画がまだチューナーを
  // 使っていると、台数が足りない環境で後続が丸ごと録れない
  /** この定期チェックで止めた録画の利用者。始める録画に引き継ぎとして渡す (下) */
  const stopped: StreamUse[] = [];
  for (const id of activeRecordingIds()) {
    const rec = orm()
      .select({ end_at: recordings.end_at, record_to: recordings.record_to })
      .from(recordings)
      .where(eq(recordings.id, id))
      .get();
    if (rec === undefined) continue;
    // 終わりを譲っているならそこで離す (`record_to`)。次の録画がそこから使う
    if (at < recordingUntil(rec)) continue;
    stopRecording(id);
    stopped.push(recordingUse(id));
  }

  // 持ち主のいない「録画中」を畳む。起動時の回収だけでは畳めない場合がある (`failStrayRecordings`)
  if (failStrayRecordings(at) > 0) {
    emit("recordings");
    emit("reservations");
  }

  // 始まらないまま終わってしまった予約を片付ける。
  // アプリが止まっていた間に放送が終わったものがここに残り続けていた。
  // **録らないと決めたもの (コピー禁止の `skipped`) は移さない。** 意図して録らなかったものが
  // 失敗 (録り逃し) に見えないよう、「録画しない」のまま理由ごと残す
  const expired = affected(
    orm()
      .update(reservations)
      .set({ state: "missed", updated_at: at })
      .where(
        and(
          inArray(reservations.state, TO_RECORD_STATES),
          isNull(reservations.started_at),
          lte(reservations.end_at, at),
        ),
      ),
  );
  if (expired > 0) emit("reservations");

  /*
   * **止まる途中 (録画の終わりを待っている間) でも始める。**
   *
   * 始めないでいた頃は、**待っている間に始まる録画の冒頭が丸ごと欠けて**
   * いた。待つのは「いま動いている録画が終わるまで」なので、欠ける幅は
   * 最長で番組 1 本ぶんになる。実機では 00:00 の番組が 29 秒、19:54 の番組が
   * **9 分 42 秒**欠けた (どちらも、その時刻にちょうど入れ替えが始まっていた)。
   *
   * 始めれば待つ時間はそのぶん延びるが、**Pod はどのみち残っている**ので
   * 新しく待たせるものは無い。延びすぎないための上限は既にあり、
   * `SHUTDOWN_WAIT` (6 時間) を過ぎれば `runtime.ts` が止める。そこで
   * 切れた録画は追記で開いてあるので、次の Pod が続きから録る。
   *
   * **譲ったぶんがあれば、そちらを見る** (`record_from`)。チューナーの取り合いで
   * 冒頭を譲った予約は、番組の始まりに開始してもチューナーを使えない。相手がまだ使っている
   */
  const due = orm()
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.state, "scheduled"),
        isNull(reservations.started_at),
        lte(plannedStartSql(), at),
        gt(
          sql`COALESCE(${reservations.record_to}, ${reservations.end_at})`,
          at,
        ),
      ),
    )
    .all();
  // 5 秒ごとには出力しない。**始めるものがあるときだけ**
  if (due.length > 0 && isDraining()) {
    console.log(
      `[録画] 止まる途中ですが、冒頭が欠けないように ${due.length} 件の録画を開始します`,
    );
  }

  for (const reservation of due) {
    /*
     * 録り始めた時刻を先に立ててから開始する。tick が重なっても二重に開始しない。
     * 状態の文字列を 'recording' に進めていた頃と同じ鍵の掛け方だが、
     * こちらは録画の行と食い違いようがない (録り始めたかどうかは事実ひとつ)
     */
    const claimed = orm()
      .update(reservations)
      .set({ started_at: at, updated_at: at })
      .where(
        and(
          eq(reservations.id, reservation.id),
          isNull(reservations.started_at),
          eq(reservations.state, "scheduled"),
        ),
      )
      .returning({ id: reservations.id })
      .get();
    if (claimed === undefined) continue;
    /*
     * **止めた録画を引き継ぎとして渡す** (`after`)。止めたことがエージェントに届くのは
     * 非同期なので、届く前に次の選局が着くと、前のチューナーがまだ塞がって見えて次の順位のチューナーに
     * 入っていた (割り振りと違うチューナーに入り、後の録画が録れない)。渡しておけば、エージェントは
     * 止めた録画をもう離れたものとして選ぶ。割り振り (`conflict.ts`) も、離すのと使うのが
     * 同じ時刻なら離すほうを先に数えているので、それと同じになる。
     *
     * どれとどれを組にするかは決めない。どのチューナーに入るかはエージェントが順位で選ぶので、
     * 止めたものを全部渡せば足りる (選ばれなかったチューナーの利用者には触らない約束)
     */
    await startRecording(reservation, stopped);
  }
}
