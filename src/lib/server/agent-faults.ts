import { desc, lt, notInArray } from "drizzle-orm";

import { orm } from "./db";
import { agentFaults } from "./schema";

/**
 * **エージェントが知らせた機材の異常を残す** (`/denpa/events` の `fault`。docs/tuner-it930x.md「TS のバッファの溢れ」)。
 *
 * IT930x のブリッジの TS のバッファが溢れると、電源を抜くまで TS が届かない。溢れた瞬間に何を選局していたかが原因を追う手がかりだが、
 * エージェントの記録はメモリと標準出力だけで、エージェントを入れ替えると消える (2026-11-15 の PX-MLT8PE は、溢れた時刻のログが読めなかった)。
 * エージェントはその行と直前の記録を送ってくるので、DB に置く。エージェントは denpa が繋ぎ直すたびに直近のものを送り直すので、同じ行は重ねない
 */

/** 残す行の上限。新しい順にこれを越えたぶんを消す */
export const AGENT_FAULT_KEEP = 500;

/** 残す日数。これより古い行を消す */
export const AGENT_FAULT_DAYS = 180;

/** 送られてくる形 (`{"at":ミリ秒,"text":"…","context":[{"at":ミリ秒,"text":"…"}]}`。agent の `Events.FaultData`) */
interface Fault {
  at: number;
  text: string;
  context: { at: number; text: string }[];
}

/** 形を確かめて読む。違えば理由を返す */
function parse(data: unknown): Fault | string {
  if (typeof data !== "object" || data === null) return "中身がありません";
  const { at, text, context } = data as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at))
    return "at が数ではありません";
  if (typeof text !== "string" || text === "") return "text がありません";
  // 前の記録は手がかりなので、形が違えば捨てて行だけ残す
  const lines = Array.isArray(context)
    ? context.filter(
        (line): line is { at: number; text: string } =>
          typeof line === "object" &&
          line !== null &&
          typeof (line as { at?: unknown }).at === "number" &&
          typeof (line as { text?: unknown }).text === "string",
      )
    : [];
  return {
    at,
    text,
    context: lines.map((line) => ({ at: line.at, text: line.text })),
  };
}

/**
 * 1 行残す。初めての行なら true (同じ行が前に残っていれば false)。
 * 形が違えば記録に出して残さない (エージェントとバージョンがずれているかもしれない)。書けなくても (ディスクが満杯など) 通知の受け取りは止めない
 */
export function recordAgentFault(
  agentId: number,
  agentName: string,
  data: unknown,
  now = Date.now(),
): boolean {
  const fault = parse(data);
  if (typeof fault === "string") {
    console.warn(
      `[agent] ${agentName} の機材の異常の通知の形式が違います (${fault})。エージェントとバージョンがずれているかもしれません`,
    );
    return false;
  }
  // 繋ぎ直すたびに送り直される古い行は、入れてすぐ消すことになるので入れない
  if (fault.at < now - AGENT_FAULT_DAYS * 86_400_000) return false;
  try {
    const inserted = orm()
      .insert(agentFaults)
      .values({
        agent_id: agentId,
        at: fault.at,
        text: fault.text,
        context: JSON.stringify(fault.context),
      })
      .onConflictDoNothing()
      .returning({ id: agentFaults.id })
      .all();
    if (inserted.length === 0) return false;
    console.warn(
      `[agent] ${agentName} が機材の異常を知らせました: ${fault.text}`,
    );
    pruneAgentFaults(now);
    return true;
  } catch (error) {
    console.warn(
      `[agent] ${agentName} の機材の異常を DB に残せませんでした: ${String(error)}`,
    );
    return false;
  }
}

/** 古い行と、上限を越えた行を消す */
function pruneAgentFaults(now: number): void {
  const db = orm();
  db.delete(agentFaults)
    .where(lt(agentFaults.at, now - AGENT_FAULT_DAYS * 86_400_000))
    .run();
  const keep = db
    .select({ id: agentFaults.id })
    .from(agentFaults)
    .orderBy(desc(agentFaults.at), desc(agentFaults.id))
    .limit(AGENT_FAULT_KEEP)
    .all()
    .map((row) => row.id);
  if (keep.length < AGENT_FAULT_KEEP) return;
  db.delete(agentFaults).where(notInArray(agentFaults.id, keep)).run();
}
