/**
 * データ放送の疎通確認 (`browser.confirmIPNetwork`)。
 *
 * 「相手まで届くか」を確かめる放送のためのエンドポイント。
 * **NHK の放送はこのエンドポイントを呼ばない。** あちらは送るエンドポイント (`post`) へ一度送って決める
 * (`bml-network.ts` の `postForBml`)。
 *
 * 中継のエンドポイントと同じく、**設定で双方向を切ってあれば 403**
 * ([bml-network.ts](../../../../lib/server/bml-network.ts))。
 */

import { error, json } from "@sveltejs/kit";

import {
  confirmReachable,
  refusalMessage,
  requireBmlNetwork,
} from "#lib/server/bml-network.js";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  requireBmlNetwork();

  const to = url.searchParams.get("to");
  if (to === null || to === "") error(400, "to がありません");
  const wait = Number(url.searchParams.get("wait") ?? 4000);

  try {
    return json(
      await confirmReachable(to, Number.isFinite(wait) ? wait : 4000),
    );
  } catch (failure) {
    const why = refusalMessage(failure, "確認できませんでした");
    console.warn(`[bml] 疎通を確かめられません: ${to} (${why})`);
    // **届かないことは失敗ではない。** 放送のアプリはそれを見て出し分ける
    return json({ success: false, ipAddress: null, responseTimeMillis: null });
  }
};
