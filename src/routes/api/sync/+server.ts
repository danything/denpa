import { json } from "@sveltejs/kit";
import { count } from "drizzle-orm";

import { orm } from "#lib/server/db.js";
import { collectOnce } from "#lib/server/epg-collect.js";
import { sync } from "#lib/server/epg.js";
import { programs } from "#lib/server/schema.js";

/**
 * 番組表を今すぐ取得し直す。定期実行 (EPG_COLLECT_INTERVAL) を待たずに反映したいとき用。
 * E2E でも「番組表が入った状態」を待たずに作るためにここを呼ぶ。
 *
 * **局の取り込みと番組表の取得の両方をやる。** 集めるところから denpa の仕事なので、
 * 押した人が待つのはここ。
 *
 * 返す `programs` は**いま持っている総数**。この回で増えたぶんではない。既に
 * 揃っている局は集め直さないので、増えた数だけを返すと「0 件しか無い」に見える。
 */
export async function POST() {
  /*
   * 取得 (`collectOnce`) が先。取得は始めに局を取り込み直す (`syncServices`) ので、局の入れ替わりもここで入る。
   * `sync` をあとに呼ぶのは、取得した番組まで入れた局の数・予約の結果を返すため (取得で番組が増えなくても当て直す)。
   * エージェントの `channels` 通知 (runtime.ts) は逆の順で、取得を待たずに局の一覧を先に変える
   */
  await collectOnce();
  const result = await sync();
  return json({
    ...result,
    programs: orm().select({ n: count() }).from(programs).get()?.n ?? 0,
  });
}
