import { error } from "@sveltejs/kit";
import { playbackPlan } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";

/**
 * **この録画を何で観られるか** (取り決めは `ts/playback.ts`、決め方は `server/playback.ts`)。
 * 尺・時刻の物差し・音声・出せるもの。どれを使うかは観る画面が決める。
 * エンコード済みも元の TS も無ければ 404
 */
export async function GET({ params }) {
  const plan = await playbackPlan(recordingOr404(params.id));
  if (plan === null) error(404, "再生できるファイルがありません");
  return Response.json(plan.info, { headers: { "Cache-Control": "no-store" } });
}
