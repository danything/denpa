import { type Actions, fail } from "@sveltejs/kit";

import { tokenRefusal } from "#lib/server/auth.js";
import {
  cancel,
  importRoots,
  lastImportFolder,
  start,
  status,
} from "#lib/server/ts-import.js";

export function load() {
  const roots = importRoots();
  return {
    tsImport: {
      status: status(),
      /** 取り込んでよいフォルダ (`IMPORT_DIRS`)。空なら節は使い方だけを出す */
      roots,
      /** 最後に指したフォルダ。無ければ `IMPORT_DIRS` の最初 (メモリにだけ持つ) */
      folder: lastImportFolder() ?? roots[0] ?? "",
    },
  };
}

/** **どれもアクセストークン (テレビのアプリ) では断る** (403。`tokenRefusal`)。端末に渡した資格でサーバのフォルダを読ませない */
export const actions = {
  /** 録画ファイルの取り込み。フォルダを確かめ、読むところは裏で進める。進み具合は SSE で届く */
  tsImport: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await request.formData();
    const result = await start(String(form.get("folder") ?? ""), {
      apply: form.get("apply") === "on",
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
  /** 取り込みを止める。入れ終えたファイルは残り、次の実行で続きから入る */
  tsImportCancel: async ({ locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    if (!cancel())
      return fail(409, { message: "実行中の取り込みはありません" });
    return { success: true, migrate: "中断しました" };
  },
} satisfies Actions;
