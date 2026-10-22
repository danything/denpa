import { and, eq, isNotNull, isNull, not } from "drizzle-orm";
import { now, orm } from "./db";
import { conditionsOf, EMPTY_RULE, type Fields, ruleValues } from "./rule-form";
import { applyRules } from "./rules";
import { resolveConflicts } from "./scheduler";
import { reservations, rules as ruleTable } from "./schema";

/**
 * **ルールを足す・直す・止める・消す。** 検索の画面の「ルールとして保存」とルールの一覧の
 * スイッチ・削除が同じものを呼ぶ (画面ごとに書くと、当て直しの範囲や取り消しの始末がズレる)。
 *
 * 断るときは理由の文を返す (`{ error }`)。画面はそれを `fail(400)` で返す
 */

/**
 * ルールを当て直して、チューナーの取り合いを計算し直す。
 *
 * 番組表は取り直さない。押す動機はたいてい「新しい番組に当ててほしい」だが、
 * 番組表を持っているのは denpa 自身なので、取り直す理由がない。当てるだけ。
 *
 * @param rule そのルールだけを当てる。**足したときにしか使えない** —
 *   新しいルールは他の予約を外すことができないので、範囲を絞れる (`rules.applyRules`)
 * @returns どのルールにも当たらなくなって消した予約の数
 */
async function reapply(rule?: number): Promise<number> {
  const { dropped } = applyRules(rule === undefined ? {} : { rule });
  await resolveConflicts();
  return dropped;
}

/** 足したルール・直したルール */
export interface Saved {
  id: number;
  name: string;
}

/** 書く欄の値でルールを足す。新しいルールは有効で、「同じ回は最初の放送だけ」は入れて始める */
export async function createRule(
  form: Fields,
): Promise<Saved | { error: string }> {
  const conditions = conditionsOf(form);
  if (conditions.empty) return { error: EMPTY_RULE };
  const created = orm()
    .insert(ruleTable)
    .values({
      ...ruleValues(conditions, form),
      dedupe: conditions.dedupe ?? true,
      enabled: true,
      created_at: now(),
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
  const saved = orm()
    .update(ruleTable)
    .set(ruleValues(conditions, form))
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
 * **取り消しの記録だけ先に消す。** ルールごと無くなるので、「このルールには作り直させない」という
 * 目印を残す意味がない。残していた頃は、後から `scheduled` に戻ったときに**消したはずの
 * ルールの予約が「ルール: (削除済み)」として一覧に並んでいた** (実機で 45 件)。
 *
 * まだ立っている予約はここでは触らない。**他のルールが引き取れるかどうかを見てから決める** —
 * 消したのが「アニメ」でも、「無職転生」が残っていればその予約は生き続けるべき
 * (`rules.applyRules` が付け替える)
 *
 * @returns 引き取り手が無くて消えた予約の数 (猶予は効かない = 人が押した結果なので)
 */
export async function deleteRule(id: number): Promise<number> {
  orm()
    .delete(reservations)
    .where(
      and(
        eq(reservations.rule_id, id),
        isNull(reservations.started_at),
        eq(reservations.state, "canceled"),
      ),
    )
    .run();
  // 録画中・録画済みのぶんは履歴として残すので、ルールとの紐付けだけ外す
  orm()
    .update(reservations)
    .set({ rule_id: null })
    .where(
      and(eq(reservations.rule_id, id), isNotNull(reservations.started_at)),
    )
    .run();
  orm().delete(ruleTable).where(eq(ruleTable.id, id)).run();
  return reapply();
}
