import { error, json } from "@sveltejs/kit";

import { markGreeted, yearSummary } from "#lib/server/season.js";
import { settings } from "#lib/server/settings.js";

/**
 * **「denpa の 1 年」を出す** (docs/api.md「季節の演出」)。本文の `year` (いまの年) を出したと世帯で覚え、去年の数を返す。
 * **その年にもう出していたら 409** (ほかの端末が先に出した)。演出がオフなら 403。
 * 数は手元の DB から集めるだけで、外には何も送らない
 */
export async function POST({ request }) {
  if (!settings().seasonal) error(403, "季節の演出はオフです");
  const body: unknown = await request.json().catch(() => null);
  const year =
    body !== null && typeof body === "object" && "year" in body
      ? body.year
      : null;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000)
    error(400, "year が読めません");
  if (!markGreeted(year)) error(409, "この年はもう出しました");
  return json(yearSummary(year - 1));
}
