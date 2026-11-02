/**
 * **選局できなくなった局を指すルールを、人が選んだ局に付け替える。**
 *
 * ルールは局の ID (ネットワーク ID とサービス ID) で局を指すので、チャンネルの名前や TS が変わっても外れない
 * (`lineup-follow.ts`)。外れるのはサービス ID が変わったとき (局の統合・終了と、別の局の開始。2023-12 の NHK BS、
 * 2027-04 の BS釣りビジョンから BS12 の新しいチャンネル)。そのときは古い局がいまの局の一覧から消え、ルールは空振りする。
 *
 * **自動では付け替えない。** 間違えて付け替えると、別の局の番組を録る。候補を出して人が選ぶ。
 * 候補は同じ種別のいまの局 (テレビ) で、古い局と同じチャンネル (TS) の局、同じ名前の局の順に並べる
 */
import { eq } from "drizzle-orm";

import { toHalfWidth } from "../fold";
import { orm } from "./db";
import { currentServices } from "./epg";
import { applyRules } from "./rules";
import { resolveConflicts } from "./scheduler";
import { rules as ruleTable, services } from "./schema";

/** 候補として並べる数の上限 */
const CANDIDATES = 5;

/** 選局できなくなった局を指すルールの 1 件 */
export interface Orphan {
  ruleId: number;
  ruleName: string;
  /** いまの局の一覧に無い局 (`services.id`) */
  serviceId: number;
  serviceName: string;
  /** 付け替える候補 (`services.id` と局名)。無ければ空 */
  candidates: { id: number; name: string }[];
}

/** 選局できなくなった局を指しているルールと、付け替える候補 */
export function orphanedRules(): Orphan[] {
  const all = orm()
    .select({
      id: services.id,
      name: services.name,
      type: services.type,
      channel: services.channel,
      service_type: services.service_type,
    })
    .from(services)
    .all();
  const byId = new Map(all.map((service) => [service.id, service]));
  const current = new Set(
    orm()
      .select({ id: services.id })
      .from(services)
      .where(currentServices())
      .all()
      .map((row) => row.id),
  );
  const live = all.filter(
    (service) => current.has(service.id) && service.service_type === 1,
  );

  const orphans: Orphan[] = [];
  for (const rule of orm().select().from(ruleTable).all()) {
    const ids = rule.service_ids ?? [];
    for (const id of ids) {
      if (current.has(id)) continue;
      const gone = byId.get(id);
      // 局の行が無い (映像の無い局として消した) ものは、名前も候補も出せない
      if (gone === undefined) continue;
      const name = toHalfWidth(gone.name);
      const rank = (service: (typeof live)[number]) =>
        service.channel === gone.channel
          ? 0
          : toHalfWidth(service.name) === name
            ? 1
            : 2;
      const candidates = live
        .filter(
          (service) =>
            service.type === gone.type &&
            !ids.includes(service.id) &&
            rank(service) < 2,
        )
        .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
        .slice(0, CANDIDATES)
        .map((service) => ({ id: service.id, name: service.name }));
      orphans.push({
        ruleId: rule.id,
        ruleName: rule.name,
        serviceId: id,
        serviceName: gone.name,
        candidates,
      });
    }
  }
  return orphans;
}

/**
 * ルールの局を付け替える。**付け替え先は、そのルールの候補に出ているものだけ** (画面の外から別の局を入れさせない)。
 * 付け替えたらそのルールを当て直す。付け替えられなければ理由の文を返す
 */
export async function remapRule(
  ruleId: number,
  from: number,
  to: number,
): Promise<string | null> {
  const orphan = orphanedRules().find(
    (o) => o.ruleId === ruleId && o.serviceId === from,
  );
  if (orphan === undefined)
    return "このルールは、選局できなくなった局を指していません";
  if (!orphan.candidates.some((candidate) => candidate.id === to))
    return "付け替える局が候補にありません";
  const rule = orm()
    .select({ service_ids: ruleTable.service_ids })
    .from(ruleTable)
    .where(eq(ruleTable.id, ruleId))
    .get();
  const ids = (rule?.service_ids ?? []).map((id) => (id === from ? to : id));
  orm()
    .update(ruleTable)
    .set({ service_ids: [...new Set(ids)] })
    .where(eq(ruleTable.id, ruleId))
    .run();
  applyRules({ rule: ruleId });
  await resolveConflicts();
  return null;
}
