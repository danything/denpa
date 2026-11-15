import { error } from "@sveltejs/kit";

import { parseId } from "#lib/id.js";
import { fetchKonomiTvLogo } from "#lib/server/logo-remote.js";
import { readLogo } from "#lib/server/logo.js";

/**
 * 局ロゴ。denpa が放送波から取得したものを配る (src/lib/server/logo.ts)。
 * まだ取得できていない局は、KonomiTV が公開しているロゴ集から取ったもので
 * 埋める (src/lib/server/logo-remote.ts)。どちらも無ければ 404。
 * 滅多に変わらないので長めにキャッシュさせる。
 */
export async function GET({ params, setHeaders }) {
  const serviceId = parseId(params.serviceId);
  if (serviceId === null) error(400, "局 ID が不正です");

  const logo = readLogo(serviceId) ?? (await fetchKonomiTvLogo(serviceId));
  if (logo === null) error(404, "ロゴがありません");

  setHeaders({
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  });
  return new Response(logo as BodyInit);
}
