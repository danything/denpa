import type { Cookies, RequestEvent } from "@sveltejs/kit";

import { FLOW_TTL } from "#lib/server/niconico.js";

/** 連携の途中を指す Cookie。始めたブラウザと戻ってきたブラウザが同じかを見る (中身は乱数で、鍵はサーバのメモリにある) */
const FLOW_COOKIE = "denpa_niconico";
/** Cookie を送る範囲。連携の画面の下だけ */
const FLOW_PATH = "/settings/integrations/niconico";

export function setFlow(cookies: Cookies, url: URL, flow: string): void {
  cookies.set(FLOW_COOKIE, flow, {
    path: FLOW_PATH,
    httpOnly: true,
    // hub から戻り先へは、よそのサイトからの画面の移動 (GET) で来る。Strict では Cookie が付かない
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: FLOW_TTL / 1000,
  });
}

/** 連携の途中を取り出して Cookie を消す (成否にかかわらず 1 回だけ使う) */
export function takeFlow(cookies: Cookies): string | undefined {
  const flow = cookies.get(FLOW_COOKIE);
  cookies.delete(FLOW_COOKIE, { path: FLOW_PATH });
  return flow;
}

/** 連携した人。OIDC なら sub、信頼するネットワークからなら 'trusted-network' (`apiTokens.created_by` と同じ) */
export function who(event: RequestEvent): string {
  return event.locals.user?.subject ?? "trusted-network";
}
