import { json } from "@sveltejs/kit";

import { tunerList } from "#lib/server/tuner.js";

/**
 * **チューナーごとの受信の状態と C/N だけを返す。** 設定の「チューナー」が、使用中のチューナーがある間 5 秒ごとに読む (`Tuners.svelte`)。
 * 画面ごと読み直すと、カードリーダーの表のためにカードへ INT を通してしまう (`/denpa/card`)。ここはエージェントの一覧だけを取得する。
 * 値はエージェントが使用中のチューナーを 5 秒ごとに読んだもの (docs/tuners.md「信号レベル」)
 */
export async function GET() {
  try {
    // 表と同じ並びの先頭のエージェントのもの (`index` はエージェントごとの番号)
    const { tuners } = await tunerList();
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
