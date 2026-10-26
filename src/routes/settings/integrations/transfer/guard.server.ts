import { json, type RequestEvent } from "@sveltejs/kit";

import { running } from "#lib/server/migrate.js";
import { OffsetMismatch, TransferError } from "#lib/server/transfer.js";

/**
 * 「denpa を別の機械へ移す」のエンドポイントの前に見るもの。断るなら返す応答、通すなら null。
 *
 * - **アクセストークン (テレビのアプリ) では断る** (403)。端末に渡した資格で DB を持ち出したり
 *   入れ替えたりさせない (`/device` と同じ考え方)。ブラウザの人 (信頼したネットワーク・OIDC) は使える
 * - **同じサイトからの呼び出しだけ通す。** フォームの形でない送信 (`PUT` の `application/octet-stream`・JSON) は
 *   SvelteKit の Origin の確かめが掛からないので、`Sec-Fetch-Site` (無ければ `Origin`) を自分で見る
 */
export function refuse(event: RequestEvent): Response | null {
  if (event.locals.token !== undefined)
    return json(
      {
        message: "アクセストークンでは使えません。ブラウザから操作してください",
      },
      { status: 403 },
    );
  const site = event.request.headers.get("sec-fetch-site");
  const same =
    site !== null
      ? site === "same-origin"
      : event.request.headers.get("origin") === event.url.origin;
  if (!same)
    return json({ message: "ほかのサイトからは使えません" }, { status: 403 });
  return null;
}

/** EPGStation・EDCB の引き継ぎが走っている間は、書き出しも取り込みも始めない (1 回に 1 つだけ) */
export function migrating(): Response | null {
  return running()
    ? json(
        {
          message:
            "EPGStation か EDCB からの引き継ぎの途中です。終わってからにしてください",
        },
        { status: 409 },
      )
    : null;
}

/** 断った理由を JSON で返す。送る位置が食い違ったときは今の位置も */
export function failure(error: unknown): Response {
  if (error instanceof OffsetMismatch)
    return json(
      { message: error.message, offset: error.offset },
      { status: error.status },
    );
  if (error instanceof TransferError)
    return json({ message: error.message }, { status: error.status });
  console.error(`[transfer] ${error}`);
  return json(
    { message: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}
