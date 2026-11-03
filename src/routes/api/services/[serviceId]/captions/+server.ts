import { parseCaptionLanguage } from "@danything/arib/caption-text";
import { error } from "@sveltejs/kit";

import { askedTrack } from "#lib/arib.js";
import { liveCaptions } from "#lib/server/live.js";

/**
 * **ライブの字幕と時計をアプリへ流す** (docs/api.md)。`live` を観ているアプリが、字幕 (文字の配置) と時計 (`clock`) を
 * 映像と同じ物差しの時刻のまま受け取る。字幕は映像に重ね、時計は映しているコマの放送時刻を出すのに使う (実況のコメントを合わせる)。
 *
 * - `?codec=` は映像に渡したものと同じ。省けば `raw` (変換しない TS。時刻は放送の PTS)。`h264` / `av1` は変換したライブ
 *   (時刻は fMP4 の時刻)。ほかの値は 400
 * - `?audio=` も、変換したライブなら映像に渡したものと同じものを渡す (同じ音声のセッションを共有するため)。`raw` では効かない
 * - `?language=<1〜8>` で字幕の第何言語かを選ぶ (省けば第 1 言語)
 *
 * いま流しているセッションを脇から共有するだけ (`live.ts` の `liveCaptions`)。
 * 共有する相手が無ければ 404。映像を開いてからリクエストする
 */
export function GET({ params, url }) {
  const serviceId = Number(params.serviceId);
  if (!Number.isInteger(serviceId)) error(400, "局 ID が不正です");
  const form = url.searchParams.get("codec") ?? "raw";
  if (form !== "raw" && form !== "h264" && form !== "av1")
    error(400, "codec は raw・h264・av1 のどれかです");
  const stream = liveCaptions(
    serviceId,
    parseCaptionLanguage(url.searchParams.get("language")),
    form,
    askedTrack(url.searchParams.get("audio")),
  );
  if (stream === null) error(404, "その局はいまライブで流していません");
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
