import { orm } from "#lib/server/db.js";
import { shownServices } from "#lib/server/epg.js";
import { services } from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";

/**
 * データ放送のページに渡す受信機の設定と、選局できる局の一覧。
 *
 * 郵便番号・都道府県・双方向 (`bmlNetwork`) はライブと観る画面と同じものをエンジンに渡す。
 * 局の一覧は、文書が別の局へ選局したい (epgTune) ときに、その場で答えるのに使う (エンジンは選局できたかをすぐに訊く。
 * アプリに訊いて答えを待てない)。ライブの一覧と同じく、取り残しの局と隠した局は入れない (`shownServices`)
 */
export function load() {
  const { postalCode, prefecture, bmlNetwork } = settings();
  return {
    postalCode,
    prefecture,
    bmlNetwork,
    services: orm()
      .select({
        id: services.id,
        name: services.name,
        networkId: services.network_id,
        serviceId: services.service_id,
      })
      .from(services)
      .where(shownServices())
      .all(),
  };
}
