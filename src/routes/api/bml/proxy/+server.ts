/**
 * データ放送の双方向 (通信系コンテンツ) の中継エンドポイント
 * ([docs/stream.md](../../../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * 設定の「受信」の「データ放送」で「双方向 (通信系コンテンツ) を使う」を切ると 403。
 * なぜ中継するのか・何に繋いでよいかは [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
 */

import { error } from "@sveltejs/kit";

import {
  fetchForBml,
  refusalMessage,
  relayed,
  requireBmlNetwork,
  requireFetch,
} from "#lib/server/bml-network.js";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, request }) => {
  requireBmlNetwork();
  requireFetch(request);

  const target = url.searchParams.get("url");
  if (target === null || target === "") error(400, "url がありません");

  try {
    return relayed(await fetchForBml(target));
  } catch (failure) {
    const why = refusalMessage(failure, "取得できませんでした");
    // **何に繋ごうとして断ったかを残す。** 切り分けのときにここがいちばん効く
    console.warn(`[bml] 中継を断りました: ${target} (${why})`);
    // 断りは 502 (相手ではなく、こちらが取得できなかった)
    error(502, why);
  }
};
