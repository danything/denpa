import { error, json } from "@sveltejs/kit";

import { settings } from "#lib/server/settings.js";

/**
 * **世帯の NG ワード** (設定の「連携」の「実況」。docs/api.md)。テレビのアプリが、流すコメントから外すのに読む
 * (ブラウザは画面の load で受け取っている)。語の並びは保存したまま。比べ方 (全角・半角などをそろえる) は受け側の `ng.ts` と同じにする。
 * 世帯の設定がオフなら 403 (`/api/jikkyo/ranking` と同じ)
 */
export function GET() {
  const { jikkyo, jikkyoNg } = settings();
  if (!jikkyo) error(403, "実況はオフです");
  return json(
    { words: jikkyoNg },
    { headers: { "Cache-Control": "no-store" } },
  );
}
