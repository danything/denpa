import { error } from "@sveltejs/kit";

import { parseCaptionLanguage } from "#lib/caption-text.js";
import { liveCaptions } from "#lib/server/live.js";

/**
 * **変換しないライブの字幕をアプリへ流す** (docs/api.md)。`live?codec=raw` を観ているアプリが、
 * 字幕 (文字の配置) を放送の PTS のまま受け取って映像に重ねる (ブラウザで変換せずに観るときと同じもの。stream.md#放送そのままmpeg-2を送る)。
 *
 * いま変換せずに流しているセッションを脇から共有するだけ (`live.ts` の `liveCaptions`)。
 * 共有する相手が無ければ 404 — 映像を開いてからリクエストする。`?language=<1〜8>` で字幕の第何言語かを選ぶ (省けば第1言語)
 */
export function GET({ params, url }) {
  const serviceId = Number(params.serviceId);
  if (!Number.isInteger(serviceId)) error(400, "局IDが不正です");
  const stream = liveCaptions(
    serviceId,
    parseCaptionLanguage(url.searchParams.get("language")),
  );
  if (stream === null) error(404, "その局はいまライブで流していません");
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
