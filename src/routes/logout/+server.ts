import { redirect } from "@sveltejs/kit";

import { relative } from "#lib/server/paths.js";
import { COOKIE, destroy } from "#lib/server/session.js";

/**
 * ログアウト。**こちらの控えを消すだけ**で、Entra 側からは出さない。
 *
 * `end_session_endpoint` へ送ると、同じ Entra で入っている他のものまで
 * 巻き添えで切れる。「denpa から出たい」と「Microsoft から出たい」は別の話。
 *
 * 出たあとに `/` へ戻すと、SSO が効いている間は黙って入り直してしまい、
 * 出られたのかどうか画面から分からない。行き先は出たことを伝える画面 (`/login/out`) にする。
 *
 * **POST だけ。** GET でも出られると、よそのページに `<img src=".../logout">` を置くだけで
 * 勝手にログアウトさせられる。POST なら SvelteKit がよそからの送信を断る
 */
export function POST({ url, cookies }) {
  destroy(cookies.get(COOKIE));
  cookies.delete(COOKIE, { path: "/" });
  redirect(303, relative(url, "/login/out"));
}
