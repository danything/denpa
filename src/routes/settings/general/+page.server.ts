import { fail } from "@sveltejs/kit";

import { logoRecordList } from "#lib/server/logo-record.js";
import {
  COOKIE,
  countOthers,
  destroyOthers,
  find,
} from "#lib/server/session.js";
import { saveSettings, settings } from "#lib/server/settings.js";
import { getTuners } from "#lib/server/tuner.js";

import * as diagnostics from "./diagnostics.server";

/**
 * ライブのチューナーを名指しするための一覧 (開発者向け。`live-tuner.svelte.ts`)。
 * 無効なものは出さない。エージェントに繋がらなければ空
 */
async function liveTuners() {
  try {
    return (await getTuners())
      .filter((tuner) => !tuner.disabled)
      .map((tuner) => ({
        name: tuner.name,
        types: tuner.types,
        pin: tuner.pin,
      }));
  } catch {
    return [];
  }
}

/**
 * その他。この端末だけの設定 (画面で読み書きするのでサーバは何もしない)・ログイン・バージョンと環境・ログ。
 * バージョンと環境・ログ (前の「診断」) の読み込みは `diagnostics.server.ts` が持ち、ここでまとめる。
 *
 * **ログアウトはログインの控え (Cookie) で入っているときだけ出す。** 素通し (LAN) には控えが無く、
 * 切るものも無い。アクセストークン (テレビのアプリ) で画面を開くことは無いが、
 * 開けても控えが無いので同じ扱い
 */
export async function load({ cookies, url }) {
  const session = find(cookies.get(COOKIE));
  return {
    liveTuners: await liveTuners(),
    /** この端末の控えのほかに生きているログインの数。控えで入っていなければ null */
    others: session === null ? null : countOthers(session.id),
    /** ロゴの取得を記録するか (開発者向け。`logo-record.ts`) と、新しいものからの記録 */
    recordLogo: settings().recordLogo,
    logoRecords: logoRecordList(50),
    ...diagnostics.load(url),
  };
}

export const actions = {
  /** **ロゴの取得を記録するか** (開発者向け。`logo-record.ts`)。世帯の設定で、オンの間だけ当たりの中継で待つたびに記録する */
  recordLogo: async ({ request }) => {
    const form = await request.formData();
    saveSettings({ recordLogo: form.get("recordLogo") === "on" });
    return { success: true };
  },
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
