import { type Actions, fail } from "@sveltejs/kit";

import { tokenRefusal } from "#lib/server/auth.js";
import { join, leave, rankingState } from "#lib/server/ranking.js";

export function load() {
  /** 番組ランキングに参加しているか (世帯の設定。`server/ranking.ts`) と、最後に送った時刻 */
  return { ranking: rankingState() };
}

export const actions = {
  /**
   * スイッチを変えた。オンなら hub からトークンを受け取ってすぐ送る (受け取れなければ断り、画面はオフに戻る)。
   * オフなら送った票を取り消してからトークンを消す (hub に届かなくても手元は消す)。
   * 予約と視聴を外へ送ることへの同意なので、アクセストークン (テレビのアプリ) では変えられない
   */
  saveRanking: async (event) => {
    const refused = tokenRefusal(event.locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await event.request.formData();
    if (form.get("ranking") === "on") {
      const result = await join();
      if (!result.ok) return fail(502, { message: result.message });
      return { success: true, saved: true };
    }
    const { reached } = await leave();
    return {
      success: true,
      saved: true,
      rankingLeft: reached ? "ok" : "unreached",
    };
  },
} satisfies Actions;
