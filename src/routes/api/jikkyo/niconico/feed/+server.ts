import { json } from "@sveltejs/kit";

import { niconicoLive } from "#lib/server/niconico-live.js";

import { readBody } from "../request.server";

/**
 * **公式の実況のコメントを受ける** (ライブの画面が、実況を流している間続けて呼ぶ。ロングポーリング。docs/api.md)。
 * 本文は `{"channel":"jk1","after":12,"epoch":"…"}` (最初は `channel` だけ)。前回の返事の `seq` と `epoch` を渡す。
 * 新しいコメントが来るか状態が変わるか 20 秒経つまで待ち、
 * `{"epoch":"…","state":"connecting"|"ready"|"unlinked"|"down","since":<ms>|null,"now":<ms>,"seq":13,"comments":[{"at":…,"text":"…","style":{…},"own":true}]}` を返す
 */
export async function POST(event) {
  const body = await readBody(event);
  const after = body["after"];
  const epoch = body["epoch"];
  return json(
    await niconicoLive.feed(
      body.channel,
      typeof after === "number" && Number.isSafeInteger(after) && after >= 0
        ? after
        : null,
      typeof epoch === "string" ? epoch : null,
      event.request.signal,
    ),
  );
}
