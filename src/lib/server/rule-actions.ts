import { and, eq, inArray, isNotNull, isNull, ne, not, or } from "drizzle-orm";

import { parseId } from "../id";
import { now, orm } from "./db";
import {
  conditionsOf,
  EMPTY_RULE,
  type Fields,
  newSwitches,
  ruleValues,
} from "./rule-form";
import { applyRules } from "./rules";
import { resolveConflicts } from "./scheduler";
import { MANUAL_PRIORITY, reservations, rules as ruleTable } from "./schema";

/**
 * **ルールを足す・直す・止める・消す。** 検索の画面の「ルールとして保存」とルールの一覧の
 * スイッチ・削除が同じものを呼ぶ (画面ごとに書くと、当て直しの範囲や取り消しの始末がズレる)。
 *
 * 断るときは理由の文を返す (`{ error }`)。画面はそれを `fail(400)` で返す
 */

/**
 * ルールを当て直して、チューナーの取り合いを計算し直す。
 *
 * 番組表は取り直さない。番組表は denpa 自身が持っているので、いまの番組表に当てるだけで足りる。
 *
 * @param rule そのルールだけを当てる。**足したときにしか使えない。**
 *   新しいルールは他の予約を外せないので、範囲を絞れる (`rules.applyRules`)
 */
export async function reapply(rule?: number): Promise<void> {
  applyRules(rule === undefined ? {} : { rule });
  await resolveConflicts();
}

/** フォームの `id` (直す・消すルール)。ID として読めなければ null (`parseId`) */
export function idOf(form: FormData): number | null {
  return parseId(form.get("id"));
}

/** 足したルール・直したルール */
interface Saved {
  id: number;
  name: string;
}

/**
 * 書く欄の値でルールを足す。新しいルールは有効で、スイッチは送られてこなければ既定 (`rule-form.newSwitches`)
 */
export async function createRule(
  form: Fields,
): Promise<Saved | { error: string }> {
  const conditions = conditionsOf(form);
  if (conditions.empty) return { error: EMPTY_RULE };
  if (conditions.invalid !== null) return { error: conditions.invalid };
  const at = now();
  const created = orm()
    .insert(ruleTable)
    .values({
      ...ruleValues(conditions, form),
      ...newSwitches(conditions),
      enabled: true,
      created_at: at,
      // 保存した時刻。これより前の取り消し・手動予約の回は、このルールが引き取る (`rules.applyRules` の後勝ち)
      decided_at: at,
    })
    .returning({ id: ruleTable.id, name: ruleTable.name })
    .get()!;
  // 足したルールは他の予約を外せないので、そのルールだけ当てれば足りる
  await reapply(created.id);
  return created;
}

/**
 * 書く欄の値でルールを直す。条件が変わったので、これから録るぶんは組み直す。
 * **条件に入ったものは立ち、外れたものは引っ込む** (`rules.applyRules`)
 */
export async function updateRule(
  id: number,
  form: Fields,
): Promise<Saved | { error: string }> {
  const conditions = conditionsOf(form);
  if (conditions.empty) return { error: EMPTY_RULE };
  if (conditions.invalid !== null) return { error: conditions.invalid };
  const saved = orm()
    .update(ruleTable)
    // 直した時刻。これより前の取り消し・手動予約の回は、このルールが引き取る (後勝ち)
    .set({ ...ruleValues(conditions, form), decided_at: now() })
    .where(eq(ruleTable.id, id))
    .returning({ id: ruleTable.id, name: ruleTable.name })
    .get();
  if (saved === undefined) return { error: "ルールが見つかりません" };
  await reapply();
  return saved;
}

/** 有効と無効を入れ替える。止めたルールの予約は猶予を置かずに引っ込む (`rules.applyRules`) */
export async function toggleRule(id: number): Promise<void> {
  orm()
    .update(ruleTable)
    .set({ enabled: not(ruleTable.enabled) })
    .where(eq(ruleTable.id, id))
    .run();
  await reapply();
}

/**
 * ルールを消す。
 *
 * **取り消しの記録は消さずに、手動予約の取り消しにする。** 消すと、その取り消しより前に保存したほかのルールが
 * 次の当て直しでその放送に予約を立て、人が取り消した回が録れてしまう (`rules.applyRules` の後勝ち)。
 * ルールを指したまま残すと、後から `scheduled` に戻したときに**消したはずのルールの予約が
 * 「ルール: (削除済み)」として一覧に並ぶ** (実機で 45 件) ので、手動予約の取り消しとして残す
 * (「戻す」で手動予約として録れる)。システムの取り消し (局が選局できなくなった) は、ルールが人の決定から
 * 引き取ったもの (`claimed_from`) だけを引き取る前の形に戻し、ほかは消す (局が戻っても持ち主がいない)。
 *
 * まだ立っている予約はここでは触らない。**他のルールが引き取れるかどうかを見てから決める。**
 * 消したのが「アニメ」でも、「無職転生」が残っていればその予約は残す
 * (`rules.applyRules` が付け替える)。人の決定から引き取った予約は、引き取り手が無ければ元の形に戻る
 *
 * @returns 引き取り手が無くて録らなくなった予約の数 (消えたものと、取り消しに戻ったもの。猶予は効かない = 人が押した結果なので)
 */
export async function deleteRule(id: number): Promise<number> {
  const canceled = and(
    eq(reservations.rule_id, id),
    isNull(reservations.started_at),
    eq(reservations.state, "canceled"),
  );
  // 手動予約の取り消しにする。優先度も手動予約の既定にする
  const released = {
    manual: true,
    rule_id: null,
    claimed_from: null,
    priority: MANUAL_PRIORITY,
  };
  const bySystem = eq(reservations.canceled_by, "system");
  // 人の取り消し (列を足す前の NULL も人として扱う)
  orm()
    .update(reservations)
    .set(released)
    .where(
      and(
        canceled,
        or(
          isNull(reservations.canceled_by),
          ne(reservations.canceled_by, "system"),
        ),
      ),
    )
    .run();
  // システムの取り消しのうち、引き取る前が人の取り消しだったもの → 人の取り消し
  orm()
    .update(reservations)
    .set({ ...released, canceled_by: "user" })
    .where(and(canceled, bySystem, eq(reservations.claimed_from, "canceled")))
    .run();
  // 引き取る前が手動予約だったもの → システムの取り消しのままの手動予約 (局が戻れば `epg.restoreReturned` が戻す)
  orm()
    .update(reservations)
    .set(released)
    .where(and(canceled, bySystem, eq(reservations.claimed_from, "manual")))
    .run();
  orm().delete(reservations).where(canceled).run();
  // 録画中・録画済みのぶんは履歴として残すので、ルールとの紐付けだけ外す
  orm()
    .update(reservations)
    .set({ rule_id: null })
    .where(
      and(eq(reservations.rule_id, id), isNotNull(reservations.started_at)),
    )
    .run();
  // 数えるのはこのルールの予約だけ。`reapply` の答えには、同じ回で条件から外れたほかのルールの予約も入る
  const pending = orm()
    .select({ id: reservations.id })
    .from(reservations)
    .where(and(eq(reservations.rule_id, id), isNull(reservations.started_at)))
    .all()
    .map((row) => row.id);
  orm().delete(ruleTable).where(eq(ruleTable.id, id)).run();
  await reapply();
  const left =
    pending.length === 0
      ? 0
      : orm()
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              inArray(reservations.id, pending),
              ne(reservations.state, "canceled"),
            ),
          )
          .all().length;
  const dropped = pending.length - left;
  // 代わりに予約するルールを探したあとも消したルールを指している行 (録り逃し・番組表から消えた放送) は、紐付けを外して「(削除済み)」にする
  orm()
    .update(reservations)
    .set({ rule_id: null })
    .where(eq(reservations.rule_id, id))
    .run();
  return dropped;
}
