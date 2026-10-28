import { error, json } from "@sveltejs/kit";

import { orm } from "#lib/server/db.js";
import { currentServices } from "#lib/server/epg.js";
import { rankingEntries, RankingRelay } from "#lib/server/jikkyo.js";
import { services } from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";

/** プロセスに 1 つ。持っておくのは 30 秒だけ (`RANKING_TTL`) */
const relay = new RankingRelay();

/**
 * **局の勢い** (ライブの局の一覧の「実況」タブ。docs/api.md)。
 * NX-Jikkyo の勢い (直近 60 秒のコメント数) を、今の受信設定にある局に当てて返す。
 * 放送中のスレッドがある局だけで、並べ替えはしない。
 * 世帯の設定 (連携の「実況」) がオフなら 403、NX-Jikkyo から読めなければ 503
 */
export async function GET() {
  if (!settings().jikkyo) error(403, "実況はオフです");
  let ranking: Awaited<ReturnType<RankingRelay["get"]>>;
  try {
    ranking = await relay.get();
  } catch {
    error(503, "いまは勢いを読めません");
  }
  const stations = orm()
    .select({
      id: services.id,
      type: services.type,
      service_id: services.service_id,
      name: services.name,
    })
    .from(services)
    .where(currentServices())
    .all();
  return json({
    at: ranking.at,
    channels: rankingEntries(stations, ranking.forces),
  });
}
