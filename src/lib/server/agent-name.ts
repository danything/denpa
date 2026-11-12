/**
 * **エージェントの名前** (設定の「受信」の「エージェント」に出す)。元はエージェントの `GET /denpa/about` の `name`
 * (エージェントの `AGENT_NAME`、無ければ機械の名前)。返さない古いエージェントはホスト名のまま
 */

import { fetchAgent } from "./agent-client";
import type { Agent } from "./agents";

/** 名前の長さの上限 (字) */
export const NAME_MAX = 40;

/** エージェントの `/denpa/about` の `name`。返さない (古いエージェント・繋がらない) なら null */
export async function aboutName(agent: Agent): Promise<string | null> {
  try {
    const res = await fetchAgent(agent, "/denpa/about", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      name?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    return name === "" ? null : name.slice(0, NAME_MAX);
  } catch {
    return null;
  }
}
