import { fail } from "@sveltejs/kit";

import { config } from "#lib/server/config.js";
import {
  COOKIE,
  countOthers,
  destroyOthers,
  find,
} from "#lib/server/session.js";

/**
 * その他。この端末だけの設定 (画面で読み書きするのでサーバは何もしない)・ログイン・バージョン。
 *
 * **ログアウトはログインの控え (Cookie) で入っているときだけ出す。** 素通し (LAN) には控えが無く、
 * 切るものも無い。アクセストークン (テレビのアプリ) で画面を開くことは無いが、
 * 開けても控えが無いので同じ扱い
 */
export function load({ cookies }) {
  const session = find(cookies.get(COOKIE));
  return {
    /** この端末の控えのほかに生きているログインの数。控えで入っていなければ null */
    others: session === null ? null : countOthers(session.id),
    /**
     * 動いている版 (`DENPA_VERSION`)。リリースのイメージにだけ入っていて、main のイメージと手元は `dev`。
     * 新しい版が出ているかはヘッダーと同じもの (レイアウトの `update`) を見る
     */
    version: config.version,
  };
}

export const actions = {
  /**
   * **この端末のほかのログインを全部終わらせる。** なくした端末・手放した端末を止めるため。
   * 送るのは POST だけ (フォームの送信。SvelteKit が Origin を見て、よそのサイトからの送信を断る)
   */
  logoutOthers: async ({ cookies }) => {
    const session = find(cookies.get(COOKIE));
    if (session === null)
      return fail(400, {
        message: "ログインしていないので、終わらせるログインがありません",
      });
    return { success: true, loggedOut: destroyOthers(session.id) };
  },
};
