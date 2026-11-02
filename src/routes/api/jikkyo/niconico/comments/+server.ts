import { error, json } from "@sveltejs/kit";

import { readPostStyle } from "#lib/jikkyo/command.js";
import { refusal } from "#lib/jikkyo/post.js";
import { niconicoLive } from "#lib/server/niconico-live.js";

import { readBody } from "../request.server";

/**
 * **公式の実況に書き込む** (ニコニコと連携しているとき。docs/api.md)。
 * 本文は `{"channel":"jk1","text":"…","style":{"color":"white","position":"naka","size":"medium"}}`。
 * いつも匿名 (184)。本文の決まりは NX-Jikkyo に書くときと同じ (`post.ts` の `refusal`。違えば 400)。
 * 返すのは `{"result":"sent"|"unknown"|"not-on-air"|"rejected"|"closed"|"unlinked"|"wait"}`
 */
export async function POST(event) {
  const body = await readBody(event);
  const text = typeof body["text"] === "string" ? body["text"] : "";
  const refused = refusal(text);
  if (refused !== null)
    error(400, refused === "" ? "本文がありません" : refused);
  const style = readPostStyle(JSON.stringify(body["style"] ?? {}));
  return json({
    result: await niconicoLive.post(body.channel, text.trim(), style),
  });
}
