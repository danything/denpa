import { isOpenPath } from "#lib/server/auth.js";
import { channelAlert } from "#lib/server/channel-alert.js";
import { updateAvailable } from "#lib/server/update.js";

/**
 * ログインしているかどうか。**OIDC かアクセストークンで入ったときに入る。**
 *
 * 素通し (LAN) で入っている人は `null` のまま。切る控えを持っていないので、
 * 設定の「その他」のログアウトもそのとき出しません。
 *
 * **名前は画面に出しません** (出しても、できることは変わらないため)。
 * 控えには残してあるので、DB を見れば誰の分か分かります。
 *
 * `update` は新しいバージョンが出ているか (`server/update.ts`)。ヘッダーに出す。
 *
 * `channelAlert` はチャンネルのお知らせ (`server/channel-alert.ts`)。ヘッダーの印と、スマホの形の設定の入口の印に出す
 * (`+layout.svelte` の `ChannelAlert`)。**画面を移るたびに読み直す** (`url.pathname` を読むので、この load が動き直す)。
 * ログインの前に開ける画面 (`auth.isOpenPath`) には渡さない
 */
export function load({ locals, url }) {
  return {
    user: locals.user ?? null,
    update: updateAvailable(),
    channelAlert: isOpenPath(url.pathname) ? null : channelAlert(),
  };
}
