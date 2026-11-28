import { json } from "@sveltejs/kit";

import { jikkyoLive } from "#lib/server/jikkyo-live.js";

import { readBody } from "../niconico/request.server";

/**
 * **ライブの実況のコメント** (denpa-hub から局ごとに 1 本で受けたもの。docs/api.md)。
 * 本文は `{"channel":"jk1","after":<前に受けた番号>,"epoch":"<前に受けた印>"}`。初めて (`after` が無い・`epoch` が違う) ならすぐ直近 15 分を返し、
 * そうでなければ続きが来るか 20 秒たつまで返事を待つ (`server/jikkyo-live.ts`)。世帯の設定がオフなら 403
 */
export async function POST(event) {
  const body = await readBody(event);
  const after = body["after"];
  const epoch = body["epoch"];
  return json(
    await jikkyoLive.feed(
      body.channel,
      typeof after === "number" && Number.isSafeInteger(after) && after >= 0
        ? after
        : null,
      typeof epoch === "string" ? epoch : null,
      event.request.signal,
    ),
  );
}
