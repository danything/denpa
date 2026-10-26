import { json } from "@sveltejs/kit";

import { apply, restartSoon } from "#lib/server/transfer.js";

import { failure, refuse } from "../guard.server";

/**
 * **取り込む。** 置き場に無い録画があれば、`force` (画面の 2 回押し) が無い限り断る。
 * 置いたらプロセスを終え、起き直した起動の最初で入れ替わる
 */
export async function POST(event) {
  const refused = refuse(event);
  if (refused !== null) return refused;
  try {
    const body = (await event.request.json().catch(() => ({}))) as {
      force?: unknown;
    };
    const result = apply(body.force === true);
    restartSoon();
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
