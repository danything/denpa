/**
 * データ放送の双方向 — **送るほう**の中継エンドポイント (`browser.transmitTextDataOverIP`)
 * ([docs/stream.md](../../../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * **応募や投票のためだけのエンドポイントではありません。** 放送のアプリは「繋がって
 * いるか」をここへ一度投げてみて決めることがあり (NHK がそう)、無いと
 * 双方向を入れていても「インターネットに接続されていません」と案内されます。
 *
 * 設定の「受信」の「データ放送」で「双方向 (通信系コンテンツ) を使う」を切ると 403。
 * 何に繋いでよいかは [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
 */

import { error } from "@sveltejs/kit";

import {
  postForBml,
  refusalMessage,
  relayed,
  requireBmlNetwork,
  requireFetch,
} from "#lib/server/bml-network.js";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ url, request }) => {
  requireBmlNetwork();
  requireFetch(request);

  const target = url.searchParams.get("url");
  if (target === null || target === "") error(400, "url がありません");

  const body = new Uint8Array(await request.arrayBuffer());
  /*
   * 形式は決まったものだけ通す (データ放送はフォーム、Hybridcast のアプリは JSON や文字も送る)。
   * ほかはフォームとして送る
   */
  const type = request.headers.get("content-type") ?? "";
  const contentType =
    /^(application\/x-www-form-urlencoded|application\/json|text\/plain)(;\s*charset=[\w-]+)?$/i.test(
      type,
    )
      ? type
      : undefined;

  try {
    return relayed(await postForBml(target, body, contentType));
  } catch (failure) {
    const why = refusalMessage(failure, "送れませんでした");
    console.warn(`[bml] 送信を断りました: ${target} (${why})`);
    error(502, why);
  }
};
