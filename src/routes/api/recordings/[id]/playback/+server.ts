import { error } from "@sveltejs/kit";

import { playbackPlan } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { indoorOf, parseFormats } from "#lib/server/viewing.js";
import { autoPick } from "#lib/ts/playback.js";

/**
 * **この録画を何で観られるか** (取り決めは `ts/playback.ts`、決め方は `server/playback.ts`)。
 * 尺・時刻の物差し・音声・出せるもの。どれを使うかは観る画面が決める。
 * `?playable=` (端末が再生できる形式) を付ければ、サーバが「自動」で選んだものを `auto` に入れる (`autoPick`。テレビのアプリ向け)。
 * 選べなければ (並びが空・知らない値だけのときも) `auto` は null。
 * エンコード済みも元の TS も無ければ 404
 */
export async function GET({ params, url }) {
  const plan = await playbackPlan(recordingOr404(params.id));
  if (plan === null) error(404, "再生できるファイルがありません");
  const playable = url.searchParams.get("playable");
  const formats = playable === null ? undefined : parseFormats(playable);
  const body =
    formats === undefined
      ? plan.info
      : {
          ...plan.info,
          auto:
            formats === null
              ? null
              : autoPick(plan.info, formats, indoorOf(url)),
        };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
