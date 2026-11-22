import { needsPairing } from "#lib/server/auth.js";
import { bearerToken, issueAppCookie } from "#lib/server/device-auth.js";

/**
 * **アプリの WebView に入れる Cookie を出す** (docs/api.md)。テレビのアプリがデータ放送のページ (`/embed/data`) を WebView で開くとき、
 * WebView は `Authorization` を付けられないので、アクセストークンと引き換えにこの Cookie を入れる (device-auth.ts の `issueAppCookie`)。
 *
 * **`Authorization: Bearer` で来たときだけ出す。** Cookie で来た相手 (WebView の中のページ) には出さない。
 * Cookie から Cookie を作れると、アクセストークンを持たないページが自分の資格を延ばし続けられる
 */
export function POST({ request, locals }) {
  if (
    locals.token === undefined ||
    bearerToken(request.headers.get("authorization")) === null
  )
    return needsPairing();
  return Response.json(issueAppCookie(locals.token), {
    headers: { "Cache-Control": "no-store" },
  });
}
