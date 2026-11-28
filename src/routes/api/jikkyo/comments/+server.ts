import { error, json } from "@sveltejs/kit";

import { readPostStyle } from "#lib/jikkyo/command.js";
import type { PostResult } from "#lib/jikkyo/post.js";
import { refusal } from "#lib/jikkyo/post.js";
import {
  AUTHOR_COOKIE,
  authorId,
  hubFetch,
  hubToken,
  newAuthorKey,
} from "#lib/server/jikkyo-hub.js";

import { readBody } from "../niconico/request.server";

/** 書いた人の鍵の Cookie の長さ (秒。ブラウザの上限の 400 日) */
const AUTHOR_COOKIE_AGE = 400 * 24 * 60 * 60;

/**
 * **実況に書き込む** (denpa-hub の独自コメント。hub が NX-Jikkyo にも書く。docs/api.md)。
 * 本文は `{"channel":"jk1","text":"…","style":{"color":"white","position":"naka","size":"medium"}}`。いつも匿名 (184)。
 * 本文の決まりは `post.ts` の `refusal` (違えば 400)。返すのは `{"result":"sent","id":"…"}` か `{"result":"rejected"|"wait"|"closed"|"unknown"}`。
 *
 * 書いた人の ID は、ログインの subject (OIDC・アクセストークン) から、無ければ端末の Cookie (`denpa_jikkyo`) から作る (`jikkyo-hub.ts`)
 */
export async function POST(event) {
  const body = await readBody(event);
  const text = typeof body["text"] === "string" ? body["text"] : "";
  const refused = refusal(text);
  if (refused !== null)
    error(400, refused === "" ? "本文がありません" : refused);
  const style = readPostStyle(JSON.stringify(body["style"] ?? {}));

  let key = event.locals.user?.subject;
  if (key === undefined) {
    key = event.cookies.get(AUTHOR_COOKIE);
    if (key === undefined || key === "") {
      key = newAuthorKey();
      event.cookies.set(AUTHOR_COOKIE, key, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: event.url.protocol === "https:",
        maxAge: AUTHOR_COOKIE_AGE,
      });
    }
  }

  let res: Response;
  try {
    const token = await hubToken();
    res = await hubFetch(`/jikkyo/channels/${body.channel}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        author: authorId(token, key),
        text: text.trim(),
        color: style.color,
        position: style.position,
        size: style.size,
      }),
    });
  } catch {
    return json({ result: "unknown" satisfies PostResult });
  }
  const reply = (await res.json().catch(() => null)) as {
    id?: unknown;
    error?: unknown;
  } | null;
  if (res.ok && typeof reply?.id === "string")
    return json({ result: "sent" satisfies PostResult, id: reply.id });
  const result: PostResult =
    reply?.error === "wait"
      ? "wait"
      : reply?.error === "rejected" || reply?.error === "blocked"
        ? "rejected"
        : reply?.error === "unknown_channel"
          ? "closed"
          : "unknown";
  return json({ result });
}
