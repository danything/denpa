import { json } from "@sveltejs/kit";

import { viewingOptions } from "#lib/server/viewing.js";

/**
 * **観るときの決まり** (docs/api.md)。テレビのアプリが、ライブの「自動」の形式とコーデックのメニューを決めるのに読む
 * (ブラウザは画面の load で受け取っている)。家の中かは、リクエストのホスト名で決める (`viewing.viewingOptions`)
 */
export function GET({ url }) {
  return json(viewingOptions(url), {
    headers: { "Cache-Control": "no-store" },
  });
}
