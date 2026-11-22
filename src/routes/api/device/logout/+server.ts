import { needsPairing } from "#lib/server/auth.js";
import { bearerToken, revokeToken } from "#lib/server/device-auth.js";

/**
 * **アプリが自分のアクセストークンを無効にする** (アプリの「サーバーから外す」)。止められるのは、
 * いま `Authorization: Bearer` で出しているものだけ (ほかの端末のものは設定画面から)。
 * アプリの WebView の Cookie (`POST /api/device/web`) では止めさせない。WebView の中のページ (データ放送) にアプリを外させない
 */
export function POST({ request, locals }) {
  // アクセストークンが無い (信頼するネットワークから素で来た) ときも、ほかのエンドポイントと同じ 401 (docs/api.md)
  if (
    locals.token === undefined ||
    bearerToken(request.headers.get("authorization")) === null
  )
    return needsPairing();
  revokeToken(locals.token);
  return new Response(null, { status: 204 });
}
