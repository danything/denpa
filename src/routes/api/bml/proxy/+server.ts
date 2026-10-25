/**
 * データ放送の双方向 (通信系コンテンツ) の中継エンドポイント
 * ([docs/stream.md](../../../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * 放送局のサーバは受信機の専用ネットワークスタックを前提にしていて
 * **CORS を返さない**ので、ブラウザからは直に取れません。ここが代わりに
 * 取ってきます。
 *
 * **オフにできます** — 設定画面の「データ放送の双方向」を切ると
 * 403 を返します。オフの間は
 * 画面側も `isIPConnected` に 0 を返すので、放送のアプリは
 * 「インターネットに接続されていません」と正しく案内します。
 *
 * 何に繋いでよいかの決め方と、その理由は
 * [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
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
