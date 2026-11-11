/**
 * WebSocket に繋ぐための使い捨てのチケット。
 *
 * **ブラウザは WebSocket のハンドシェイクに `Authorization` を付けない。** OIDC で
 * 画面に入れていても、そこから張る WebSocket は素通しで届いてしまう。
 * チューナーを使う API をそのまま開けておくわけにはいかない。
 *
 * そこで、**認証を通った画面だけが取れるチケット**を 1 枚配り、それを URL に付けて
 * 繋いでもらう。配るのはライブのページを組むとき (`routes/live/+page.server.ts` の `load`) と
 * `/api/live/ticket` で、どちらも普通の HTTP なので、OIDC も信頼するネットワークも**そのまま効く**。
 *
 * **1 回使ったら消す。** URL は履歴にもログにも残るので、残しておくと見た人が
 * 繋げてしまう。
 */

import { TICKET_LIFETIME } from "#lib/live.js";

const issued = new Map<string, number>();

/** 期限切れを片付ける。**配るときと使うときに掃く** (別に走らせるほどの量ではない) */
function sweep(at: number): void {
  for (const [token, until] of issued) {
    if (until <= at) issued.delete(token);
  }
}

/** 1 枚配る */
export function issue(at: number = Date.now()): string {
  sweep(at);
  const token = crypto.randomUUID();
  issued.set(token, at + TICKET_LIFETIME);
  return token;
}

/** 使う。**使えるのは 1 回だけ** */
export function redeem(token: string | null, at: number = Date.now()): boolean {
  if (token === null) return false;
  sweep(at);
  return issued.delete(token);
}
