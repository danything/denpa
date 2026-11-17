/**
 * **エージェントの名前** (設定の「受信」の「エージェント」に出す)。元はエージェントの `GET /denpa/about` の `name`
 * (エージェントの `AGENT_NAME`、無ければ機械の名前)。返さない古いエージェントはホスト名のまま
 */

import { and, eq } from "drizzle-orm";

import { AgentTrustError, fetchAgent, refusedAsUnpaired } from "./agent-client";
import type { Agent } from "./agents";
import { orm } from "./db";
import { agents } from "./schema";

/** 名前の長さの上限 (字) */
export const NAME_MAX = 40;

/** エージェントの `GET /denpa/about` から読むもの */
export interface About {
  /** `name`。返さない (古いエージェント・繋がらない) なら null */
  name: string | null;
  /** `version`。返さない・繋がらないなら null */
  version: string | null;
  /**
   * 保存した証明書で繋がらない (`changed`) か、エージェントに組んでいないと断られた (`unpaired`)。
   * ほかの失敗 (繋がらない・断られた) は null。どの失敗でも `name` と `version` は null。
   * 名前だけ使う呼ぶ側 (`adoptName`・`agent-admin.addAgent`) は見ない
   */
  trouble: "changed" | "unpaired" | null;
}

/** エージェントの `/denpa/about` を読む (設定の「エージェント」の行と、名前を付けるとき)。5 秒で打ち切る */
export async function readAbout(agent: Agent): Promise<About> {
  const none = { name: null, version: null };
  try {
    const res = await fetchAgent(agent, "/denpa/about", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (await refusedAsUnpaired(res)) return { ...none, trouble: "unpaired" };
    if (!res.ok) return { ...none, trouble: null };
    const body = (await res.json().catch(() => null)) as {
      name?: unknown;
      version?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    return {
      name: name === "" ? null : name.slice(0, NAME_MAX),
      version: typeof body?.version === "string" ? body.version : null,
      trouble: null,
    };
  } catch (error) {
    return {
      ...none,
      trouble: error instanceof AgentTrustError ? error.kind : null,
    };
  }
}

/**
 * **環境変数から足したエージェントにも、名乗る名前を付ける。** 行の名前がホスト名のまま (画面で変えていない) なら、
 * `/denpa/about` の `name` に書き換える。画面から登録した行は登録したときに付けている (`agent-admin.addAgent`)。
 * 通知の購読が始まるたびに呼ぶ (`runtime.ts`)。書き換えたら true
 */
export async function adoptName(agent: Agent): Promise<boolean> {
  const row = orm()
    .select({ name: agents.name, fromEnv: agents.from_env })
    .from(agents)
    .where(eq(agents.id, agent.id))
    .get();
  if (row?.fromEnv !== true || row.name !== new URL(agent.origin).hostname)
    return false;
  const { name } = await readAbout(agent);
  if (name === null || name === row.name) return false;
  // 訊いている間に画面で名前を変えていたら、そちらを残す
  return (
    orm()
      .update(agents)
      .set({ name })
      .where(and(eq(agents.id, agent.id), eq(agents.name, row.name)))
      .returning({ id: agents.id })
      .all().length > 0
  );
}
