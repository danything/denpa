import { type Actions, fail } from "@sveltejs/kit";

import { parseNg } from "#lib/jikkyo/ng.js";
import { linkState, unlink } from "#lib/server/niconico.js";
import { saveSettings, settings } from "#lib/server/settings.js";

import { refusal } from "./niconico/flow.server";

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
    saveSettings({ jikkyo: form.get("jikkyo") === "on", jikkyoNg: ng.words });
    return { success: true, saved: true };
  },
  unlinkNiconico: async (event) => {
    const refused = refusal(event);
    if (refused !== null) return fail(403, { message: refused });
    unlink();
    return { success: true, niconicoUnlinked: true };
  },
} satisfies Actions;
