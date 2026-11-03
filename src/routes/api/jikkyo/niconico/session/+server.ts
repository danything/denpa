import { json } from "@sveltejs/kit";

import { niconicoLive } from "#lib/server/niconico-live.js";

import { readBody } from "../request.server";

/**
 * **公式の実況への接続を保つ** (書き込みの欄が開いている間、30 秒おきと局を替えたときに呼ぶ。docs/api.md)。
 * 本文は `{"channel":"jk1"}`。繋いでいなければ繋ぎ始め、`{"state":"connecting"|"ready"|"unlinked"|"down"}` を返す
 */
export async function POST(event) {
  const { channel } = await readBody(event);
  return json({ state: niconicoLive.touch(channel) });
}
