import { type Actions, fail } from "@sveltejs/kit";

import { parseNg } from "#lib/jikkyo/ng.js";
import { saveSettings, settings } from "#lib/server/settings.js";

export function load() {
  const { jikkyo, jikkyoNg } = settings();
  /** 実況のコメントを流せるようにするか (世帯の設定。端末ごとのオン・オフは ⚙ が持つ) と NG ワード */
  return { jikkyo, jikkyoNg };
}

export const actions = {
  saveJikkyo: async ({ request }) => {
    const form = await request.formData();
    const ng = parseNg(String(form.get("jikkyoNg") ?? ""));
    if ("error" in ng) return fail(400, { message: ng.error });
    saveSettings({ jikkyo: form.get("jikkyo") === "on", jikkyoNg: ng.words });
    return { success: true, saved: true };
  },
} satisfies Actions;
