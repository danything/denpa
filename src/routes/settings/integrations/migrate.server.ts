import { type Actions, fail } from "@sveltejs/kit";

import { edcbDir, startEdcb } from "#lib/server/migrate-edcb.js";
import { cancel, epgstationUrl, start, status } from "#lib/server/migrate.js";

export function load() {
  return {
    migrate: {
      status: status(),
      /** EPGStation の URL。最後に入れられたものを入力欄に戻す (メモリにだけ持つ) */
      epgstationUrl: epgstationUrl() ?? "",
      /** EDCB の設定フォルダ。最後に指定されたものを入力欄に戻す */
      edcbDir: edcbDir() ?? "",
    },
  };
}

export const actions = {
  /**
   * EPGStation からの引き継ぎ。先に繋がるかだけ確かめ、数百GBを取ってくるところは裏で進める。
   * 進み具合は SSE で降ってくる。
   */
  migrate: async ({ request }) => {
    const form = await request.formData();
    const result = await start(String(form.get("url") ?? ""), {
      apply: form.get("apply") === "on",
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
  /** EPGStation からの引き継ぎを止める。書きかけは残し、次の実行で続きから取る */
  migrateCancel: async () => {
    if (!cancel())
      return fail(409, { message: "実行中の引き継ぎはありません" });
    return { success: true, migrate: "中断しました" };
  },
  /**
   * EDCB からの引き継ぎ。サーバから見える設定フォルダのパスを受ける。進み具合は EPGStation と同じく SSE で降ってくる
   */
  migrateEdcb: async ({ request }) => {
    const form = await request.formData();
    const result = startEdcb(String(form.get("dir") ?? ""), {
      apply: form.get("apply") === "on",
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
} satisfies Actions;
