import { error } from "@sveltejs/kit";

import { markGreeted } from "#lib/server/season.js";

/**
 * **「denpa の 1 年」のチップを閉じた** (docs/api.md「季節の演出」)。本文の `year` (いまの年) を世帯で覚え、その年の 1 月 7 日まで
 * どの端末にもチップを出さない (`GET /api/season` の `greeted`)。もう閉じていても 204
 */
export async function POST({ request }) {
  const body: unknown = await request.json().catch(() => null);
  const year =
    body !== null && typeof body === "object" && "year" in body
      ? body.year
      : null;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000)
    error(400, "year が読めません");
  markGreeted(year);
  return new Response(null, { status: 204 });
}
