import { type Actions, fail } from "@sveltejs/kit";

import { edcbDir, startEdcb } from "#lib/server/migrate-edcb.js";
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
      /** EDCB の設定フォルダ。最後に指定されたものを入力欄に戻す */
      edcbDir: edcbDir() ?? "",
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
  /**
   * EDCB からの引き継ぎ。サーバから見える設定フォルダのパスを受ける。進み具合は EPGStation と同じく SSE で降ってくる
   */
  migrateEdcb: async ({ request }) => {
    const form = await request.formData();
    const result = startEdcb(String(form.get("dir") ?? ""), {
      apply: form.get("apply") === "on",
      move: false,
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
} satisfies Actions;
