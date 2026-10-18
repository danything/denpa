/**
 * データ放送の双方向 — **送るほう**の中継エンドポイント (`browser.transmitTextDataOverIP`)
 * ([docs/stream.md](../../../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * **応募や投票のためだけのエンドポイントではありません。** 放送のアプリは「繋がって
 * いるか」をここへ一度投げてみて決めることがあり (NHK がそう)、無いと
 * 双方向を入れていても「インターネットに接続されていません」と案内されます。
 *
 * **オフにできます** — 設定画面の「データ放送の双方向」を切ると
 * 403 を返します。
 *
 * 何に繋いでよいかの決め方と、その理由は
 * [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
 */

import { error } from '@sveltejs/kit';
import { postForBml, refusalMessage, requireBmlNetwork } from '#lib/server/bml-network.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url, request }) => {
    requireBmlNetwork();

    const target = url.searchParams.get('url');
    if (target === null || target === '') error(400, 'url がありません');

    const body = new Uint8Array(await request.arrayBuffer());
    /*
     * 形式は決まったものだけ通す (データ放送はフォーム、Hybridcast のアプリは JSON や文字も送る)。
     * ほかはフォームとして送る
     */
    const type = request.headers.get('content-type') ?? '';
    const contentType =
        /^(application\/x-www-form-urlencoded|application\/json|text\/plain)(;\s*charset=[\w-]+)?$/i.test(
            type,
        )
            ? type
            : undefined;

    try {
        const got = await postForBml(target, body, contentType);
        return new Response(got.body as BodyInit, {
            status: got.status,
            headers: {
                'content-type': got.contentType,
                'cache-control': 'no-store',
                /*
                 * **「相手まで行けた」と「こちらで断った」を分ける。**
                 * 相手の 502 をそのまま返すので、符号だけでは見分けが
                 * 付かない。画面側はこれを見て成否を決める
                 */
                'x-bml-relayed': '1',
            },
        });
    } catch (failure) {
        const why = refusalMessage(failure, '送れませんでした');
        console.warn(`[bml] 送信を断りました: ${target} (${why})`);
        error(502, why);
    }
};
