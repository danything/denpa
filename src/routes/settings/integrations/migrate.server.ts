import { type Actions, fail } from "@sveltejs/kit";

import {
  available as migrateAvailable,
  source,
  start,
  status,
} from "#lib/server/migrate.js";

export function load() {
  return {
    migrate: {
      available: migrateAvailable(),
      source: source.recordedDir,
      status: status(),
    },
  };
}

export const actions = {
  /**
   * EPGStation からの引き継ぎ。数百GBのコピーになるので開始だけ受けて裏で進める。
   * 進捗は SSE で降ってくる。
   */
  migrate: async ({ request }) => {
    const form = await request.formData();
    const options = {
      apply: form.get("apply") === "on",
      move: form.get("move") === "on",
    };
    const result = start(options);
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
} satisfies Actions;
