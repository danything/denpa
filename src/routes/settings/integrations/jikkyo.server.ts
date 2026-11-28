import { type Actions, fail } from "@sveltejs/kit";

import { parseNg } from "#lib/jikkyo/ng.js";
import { tokenRefusal } from "#lib/server/auth.js";
import { jikkyoLive } from "#lib/server/jikkyo-live.js";
import { niconicoLive } from "#lib/server/niconico-live.js";
import { linkState, unlink } from "#lib/server/niconico.js";
import { saveSettings, settings } from "#lib/server/settings.js";

export function load() {
  const { jikkyo, jikkyoNg } = settings();
  /**
   * 実況のコメントを流せるようにするか (世帯の設定。端末ごとのオン・オフは ⚙ が持つ)・NG ワード・
   * ニコニコのアカウントとの連携 (世帯で 1 つ。`server/niconico.ts`)
   */
  return { jikkyo, jikkyoNg, niconico: linkState() };
}

export const actions = {
  saveJikkyo: async ({ request }) => {
    const form = await request.formData();
    const ng = parseNg(String(form.get("jikkyoNg") ?? ""));
    if ("error" in ng) return fail(400, { message: ng.error });
    const jikkyo = form.get("jikkyo") === "on";
    saveSettings({ jikkyo, jikkyoNg: ng.words });
    // オフにしたら hub への購読 (控えも捨てる) と、開いている公式の実況への接続をすぐ閉じる (呼ばれなくなるのを待たない)
    if (!jikkyo) {
      jikkyoLive.closeAll();
      niconicoLive.closeAll();
    }
    return { success: true, saved: true };
  },
  unlinkNiconico: async (event) => {
    const refused = tokenRefusal(event.locals);
    if (refused !== null) return fail(403, { message: refused });
    unlink();
    // 開いている公式の実況への接続も閉じる
    niconicoLive.closeAll();
    return { success: true, niconicoUnlinked: true };
  },
} satisfies Actions;
