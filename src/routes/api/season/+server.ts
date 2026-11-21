import { json } from "@sveltejs/kit";

import { now } from "#lib/server/db.js";
import { greetedYear } from "#lib/server/season.js";

/**
 * **季節の演出に要る、サーバの時計と世帯の状態** (docs/api.md「季節の演出」)。
 * 画面は日付を端末の時計ではなくこの `now` で決める (端末の時計がずれていても、出す日がずれない)。出すかどうか (世帯の設定) は画面の load (`+layout.server.ts` の `seasonal`) が渡す。
 * `greeted` は「denpa の 1 年」のチップを最後に閉じた年 (まだなら null)
 */
export function GET() {
  return json(
    { now: now(), greeted: greetedYear() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
