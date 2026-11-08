import { json } from "@sveltejs/kit";

import { sameOrigin } from "#lib/server/auth.js";
import { finishLink } from "#lib/server/niconico.js";

import { refusal, takeFlow, who } from "../flow.server";

/**
 * **連携の結果を受け取って保存する** (戻り先の画面 `../return` がフラグメントから読んで送ってくる)。
 * 本文は `{"result":"<hub が暗号化したもの>"}`。返すのは `{"ok":true}` か `{"message":"…"}` (画面にそのまま出す)。
 *
 * JSON の送信には SvelteKit の Origin の確かめが掛からないので、同じサイトからの呼び出しかを自分で見る
 */
export async function POST(event) {
  const { request, cookies, url } = event;
  const refused = refusal(event);
  if (refused !== null) return json({ message: refused }, { status: 403 });
  if (!sameOrigin(request, url))
    return json({ message: "ほかのサイトからは使えません" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    result?: unknown;
  } | null;
  const flow = takeFlow(cookies);
  if (typeof body?.result !== "string" || body.result === "")
    return json({ message: "連携の結果がありません" }, { status: 400 });
  const done = await finishLink(flow, body.result, who(event));
  return done.ok
    ? json({ ok: true })
    : json({ message: done.message }, { status: 400 });
}
