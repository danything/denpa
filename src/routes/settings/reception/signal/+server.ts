import { json } from "@sveltejs/kit";

import { parseId } from "#lib/id.js";
import { listAgents } from "#lib/server/agents.js";
import { tunerList } from "#lib/server/tuner.js";

/**
 * **チューナーごとの受信の状態と C/N だけを返す。** 設定の「チューナー」が、使用中のチューナーがある間 5 秒ごとに、エージェントごとに読む
 * (`?agent=<行の ID>`。`AgentTuners.svelte`)。
 * 画面ごと読み直すと、カードリーダーの表のためにカードへ INT を通してしまう (`/denpa/card`)。ここはエージェントの一覧だけを取得する。
 * 値はエージェントが使用中のチューナーを 5 秒ごとに読んだもの (docs/tuners.md「信号レベル」)
 */
export async function GET({ url }) {
  try {
    const id = parseId(url.searchParams.get("agent"));
    const agent = listAgents().find((a) => a.id === id);
    if (agent === undefined)
      return json(
        { error: "このエージェントはもうありません" },
        { status: 404 },
      );
    // `index` はエージェントごとの番号 (表の行と同じ)
    const { tuners } = await tunerList(agent);
    return json({
      tuners: tuners.map((tuner) => ({
        index: tuner.index,
        signal: tuner.signal,
      })),
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
