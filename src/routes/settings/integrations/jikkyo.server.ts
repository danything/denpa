import type { Actions } from "@sveltejs/kit";

import { saveSettings, settings } from "#lib/server/settings.js";

export function load() {
  /** 実況のコメントを流せるようにするか (世帯の設定。端末ごとのオン・オフは ⚙ が持つ) */
  return { jikkyo: settings().jikkyo };
}

export const actions = {
  saveJikkyo: async ({ request }) => {
    const form = await request.formData();
    saveSettings({ jikkyo: form.get("jikkyo") === "on" });
    return { success: true, saved: true };
  },
} satisfies Actions;
