import { json } from "@sveltejs/kit";

import { cancel } from "#lib/server/transfer.js";

import { failure, refuse } from "../guard.server";

/** **取消。** 送ったもの・開いたもの・入れ替えを待っているものを消す */
export function POST(event) {
  const refused = refuse(event);
  if (refused !== null) return refused;
  try {
    cancel();
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
