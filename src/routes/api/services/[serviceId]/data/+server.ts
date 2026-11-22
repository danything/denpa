import { error } from "@sveltejs/kit";

import { askedTrack } from "#lib/arib.js";
import { parseId } from "#lib/id.js";
import { parseRung } from "#lib/rungs.js";
import { liveData, sideForm } from "#lib/server/live.js";

/**
 * **ライブのデータ放送をアプリへ流す** (docs/api.md)。`live` を観ているアプリが、ブラウザのライブと同じデータ放送 (0x30) を受け取り、
 * 描く側 (`/embed/data`) へそのまま渡す。繋いでいる間が受信の意思で、オン/オフの指示は無い。
 *
 * - `?codec=`・`?audio=`・`?rung=` は字幕 (`../captions`) と同じ。映像に渡したものと同じものを渡す (同じセッションを共有するため)
 *
 * いま流しているセッションを脇から共有するだけ (`live.ts` の `liveData`)。
 * 共有する相手が無ければ 404。映像を開いてからリクエストする
 */
export function GET({ params, url }) {
  const serviceId = parseId(params.serviceId);
  if (serviceId === null) error(400, "局 ID が不正です");
  const form = sideForm(url.searchParams.get("codec"));
  if (form === null) error(400, "codec は raw・h264・av1・hevc のどれかです");
  const stream = liveData(
    serviceId,
    form,
    askedTrack(url.searchParams.get("audio")),
    parseRung(url.searchParams.get("rung")),
  );
  if (stream === null) error(404, "その局はいまライブで流していません");
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
