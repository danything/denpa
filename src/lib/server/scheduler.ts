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
import { config } from "./config";
import { assign, type Busy, type Capacity, capacityOf } from "./conflict";
import { checkContracts, type ContractRow, getActiveCardId } from "./contracts";
import { affected, now, orm } from "./db";
import { emit } from "./events";
import {
  activeRecordingIds,
  failStrayRecordings,
  recordingUntil,
  startRecording,
  stopRecording,
} from "./recorder";
import {
  cardContracts,
  contractNotifications,
  HELD_STATES,
  programs,
  recordings,
  reservations,
  services,
  TO_RECORD_STATES,
} from "./schema";
import { cardStatus } from "./scramble";
import { isDraining } from "./shutdown";
import {
  type AgentTuner,
  getTuners,
  recordingHolds,
  recordingOf,
  recordingUse,
  type StreamUse,
} from "./tuner";
import { notifyContractExpired, notifyContractExpiring } from "./webhook";

interface Candidate extends Reservation {
  type: string;
  channel: string;
  /** 番組表でコピー禁止と言われているか。番組表から消えていれば false */
  copy_never: boolean;
  contract_warning: "expired" | "unsubscribed" | null;
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
      channel: services.channel,
      copy_never: sql<boolean>`COALESCE(${programs.copy_never}, 0) = 1`.mapWith(
        Boolean,
      ),
      contract_warning: sql<"expired" | "unsubscribed" | null>`(
        SELECT CASE
          WHEN p.is_free = 1 THEN NULL
          WHEN cc.state = 'expired' THEN 'expired'
          WHEN cc.state = 'unsubscribed' THEN 'unsubscribed'
          ELSE NULL
        END
        FROM ${cardContracts} cc
        LEFT JOIN ${programs} p ON p.id = ${reservations.program_id}
        WHERE cc.service_id = ${reservations.service_id}
        ORDER BY CASE cc.state WHEN 'subscribed' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END
        LIMIT 1
      )`,
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

let lastContractScan = 0;
let scanningContracts = false;

/** テスト用: 最後に契約確認スキャンを実行した時刻をリセットする */
export function resetContractScanTimeForTest(time = 0): void {
  lastContractScan = time;
}

/**
 * 定期契約確認スキャンを実行すべきか判定する。
 * - contractScanInterval が 0 の場合は無効。
 * - 初回 (lastScan === 0) または interval 以上経過したとき。
 * - 深夜 (JST 03:00) を跨いだとき。
 */
export function shouldScanContracts(
  at: number,
  lastScan: number,
  interval: number,
): boolean {
  if (interval <= 0) return false;
  if (lastScan === 0) return true;
  if (at - lastScan >= interval) return true;

  // JST 03:00 (UTC+9 の 03:00 = UTC の前日 18:00) を跨いだかを日番号で判定
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const TARGET_HOUR_MS = 3 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const prevDay = Math.floor(
    (lastScan + JST_OFFSET_MS - TARGET_HOUR_MS) / DAY_MS,
  );
  const currentDay = Math.floor((at + JST_OFFSET_MS - TARGET_HOUR_MS) / DAY_MS);
  return currentDay > prevDay;
}

/**
 * 有料放送局の契約状態を確認し、直前のスキャン結果と比較して
 * 新たに「期限切れ (state === 'expired')」または「7日以内の期限切れ予告 (contract.expiring)」を
 * 検知して Webhook 通知を送る。
 */
export async function scanContracts(): Promise<{
  scanned: ContractRow[];
  expired: ContractRow[];
  expiring: ContractRow[];
}> {
  if (scanningContracts) {
    return { scanned: [], expired: [], expiring: [] };
  }
  scanningContracts = true;
  try {
    const card = await cardStatus();
    const cardId = getActiveCardId(card);
    if (!card.ok || !cardId) {
      return { scanned: [], expired: [], expiring: [] };
    }

    const previousRows = orm()
      .select({
        serviceId: cardContracts.service_id,
        state: cardContracts.state,
      })
      .from(cardContracts)
      .where(eq(cardContracts.card_id, cardId))
      .all();

    const previousStateMap = new Map(
      previousRows.map((r) => [r.serviceId, r.state]),
    );

    const currentContracts = await checkContracts();

    const newlyExpired: ContractRow[] = [];
    const newlyExpiring: ContractRow[] = [];
    const nowMs = now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // 既に通知済みの期限切れ予告 (contract.expiring) を取得
    const notifiedExpiringRows = orm()
      .select({
        serviceId: contractNotifications.service_id,
        validUntil: contractNotifications.valid_until,
      })
      .from(contractNotifications)
      .where(
        and(
          eq(contractNotifications.card_id, cardId),
          eq(contractNotifications.event, "contract.expiring"),
        ),
      )
      .all();

    const notifiedExpiringSet = new Set(
      notifiedExpiringRows.map((r) => `${r.serviceId}:${r.validUntil}`),
    );

    for (const contract of currentContracts) {
      if (contract.state === "expired") {
        const prevState = previousStateMap.get(contract.serviceId);
        if (prevState !== "expired") {
          newlyExpired.push(contract);
        }
      } else if (
        contract.state === "subscribed" &&
        contract.validUntil !== null &&
        contract.validUntil > nowMs &&
        contract.validUntil <= nowMs + SEVEN_DAYS_MS
      ) {
        // 7日以内に切れる有料契約
        const key = `${contract.serviceId}:${contract.validUntil}`;
        if (!notifiedExpiringSet.has(key)) {
          newlyExpiring.push(contract);
        }
      }
    }

    for (const contract of newlyExpired) {
      notifyContractExpired({
        cardId: contract.cardId,
        serviceId: contract.serviceId,
        serviceName: contract.serviceName,
        validUntil: contract.validUntil,
      });
    }

    for (const contract of newlyExpiring) {
      if (contract.validUntil !== null) {
        notifyContractExpiring({
          cardId: contract.cardId,
          serviceId: contract.serviceId,
          serviceName: contract.serviceName,
          validUntil: contract.validUntil,
        });
        orm()
          .insert(contractNotifications)
          .values({
            card_id: contract.cardId,
            service_id: contract.serviceId,
            event: "contract.expiring",
            valid_until: contract.validUntil,
            notified_at: nowMs,
          })
          .run();
      }
    }

    return {
      scanned: currentContracts,
      expired: newlyExpired,
      expiring: newlyExpiring,
    };
  } finally {
    scanningContracts = false;
  }
}

/**
 * `schedulerTick` (既定 5 秒) ごとに呼ばれる本体。開始時刻に達した予約を録画に移し、終了時刻を過ぎた録画を止める。
 * 録画の終わり方 (完了・失敗) は recorder.ts が書く。
 */
export async function tick(): Promise<void> {
  const at = now();

  // 定期的な有料放送契約確認スキャン (深夜 JST 03:00、または既定12時間間隔)
  if (shouldScanContracts(at, lastContractScan, config.contractScanInterval)) {
    lastContractScan = at;
    void scanContracts().catch((error: unknown) => {
      console.warn(`[contracts] 定期契約確認スキャンに失敗しました: ${error}`);
    });
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
        lte(
          sql`COALESCE(${reservations.record_from}, ${reservations.start_at} - ${config.startMargin})`,
          at,
        ),
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
