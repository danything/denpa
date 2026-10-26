import { redirect } from "@sveltejs/kit";

import { relative } from "#lib/server/paths.js";
import { exportArchive } from "#lib/server/transfer.js";

import { migrating, refuse } from "../guard.server";

/**
 * **書き出す** (フォームの送信)。tar.zst を `Content-Disposition: attachment` で流し、進み具合はブラウザの
 * ダウンロードの表示に任せる。GET にしないのは、先読みで重い処理を走らせないため。
 * 断ったときは設定の画面へ戻し、理由を出す (フォームの送信なので JSON を返すと画面が置き換わる)
 */
export async function POST(event) {
  const refused = refuse(event) ?? migrating();
  let message: string;
  if (refused === null) {
    try {
      const { stream, filename } = await exportArchive();
      return new Response(stream, {
        headers: {
          "content-type": "application/zstd",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  } else {
    if (refused.status === 403) return refused;
    message = ((await refused.json()) as { message: string }).message;
  }
  redirect(
    303,
    `${relative(event.url, "/settings/integrations")}?transfer_error=${encodeURIComponent(message)}#transfer`,
  );
}
