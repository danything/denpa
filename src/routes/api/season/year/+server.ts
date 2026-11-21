import { error, json } from "@sveltejs/kit";

import { yearSummary } from "#lib/server/season.js";
import { settings } from "#lib/server/settings.js";

/**
 * **「denpa の 1 年」の数** (docs/api.md「季節の演出」)。`?year=2026` の年の録画の数を返す。
 * 手元の DB から集めるだけで、外には何も送らない。演出がオフなら 403
 */
export function GET({ url }) {
  if (!settings().seasonal) error(403, "季節の演出はオフです");
  const year = Number(url.searchParams.get("year"));
  if (!Number.isInteger(year) || year < 2000) error(400, "year が読めません");
  return json(yearSummary(year), {
    headers: { "Cache-Control": "no-store" },
  });
}
