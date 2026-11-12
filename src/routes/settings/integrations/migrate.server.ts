import { type Actions, fail } from "@sveltejs/kit";

import { tokenRefusal } from "#lib/server/auth.js";
import { edcbTarget, startEdcb } from "#lib/server/migrate-edcb.js";
import { cancel, epgstationUrl, start, status } from "#lib/server/migrate.js";
import { busy as transferBusy, BUSY_MESSAGE } from "#lib/server/transfer.js";

export function load() {
  return {
    migrate: {
      status: status(),
      /** EPGStation の URL。最後に入れられたものを入力欄に戻す (メモリにだけ持つ) */
      epgstationUrl: epgstationUrl() ?? "",
      /** EpgTimerSrv の宛先。最後に入れられたものを入力欄に戻す (メモリにだけ持つ) */
      edcbTarget: edcbTarget() ?? "",
    },
  };
}

/** **どれもアクセストークン (テレビのアプリ) では断る** (403。`tokenRefusal`)。端末に渡した資格で DB の中身を入れ替えさせない */
export const actions = {
  /**
   * EPGStation からの引き継ぎ。先に繋がるかだけ確かめ、数百 GB を取ってくるところは裏で進める。
   * 進み具合は SSE で届く。
   */
  migrate: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    // denpa の書き出し・取り込みと同時には走らせない (1 回に 1 つだけ。transfer.ts)
    if (transferBusy()) return fail(409, { message: BUSY_MESSAGE });
    const form = await request.formData();
    const result = await start(String(form.get("url") ?? ""), {
      apply: form.get("apply") === "on",
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
  /** EPGStation からの引き継ぎを止める。書きかけは残し、次の実行で続きから取る */
  migrateCancel: async ({ locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    if (!cancel())
      return fail(409, { message: "実行中の引き継ぎはありません" });
    return { success: true, migrate: "中断しました" };
  },
  /**
   * EDCB からの引き継ぎ。先に EpgTimerSrv から一覧を読み、繋がらなければその場で理由を返す。進み具合は EPGStation と同じく SSE で届く
   */
  migrateEdcb: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    if (transferBusy()) return fail(409, { message: BUSY_MESSAGE });
    const form = await request.formData();
    const result = await startEdcb(String(form.get("target") ?? ""), {
      apply: form.get("apply") === "on",
    });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, migrate: result.message };
  },
} satisfies Actions;
