/**
 * データ放送の双方向 — **送るほう**の中継口 (`browser.transmitTextDataOverIP`)
 * ([docs/stream.md](../../../../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
 *
 * **応募や投票のためだけの口ではありません。** 放送のアプリは「繋がって
 * いるか」をここへ一度投げてみて決めることがあり (NHK がそう)、無いと
 * 双方向を入れていても「インターネットに接続されていません」と案内されます。
 *
 * **既定では動きません** — 設定画面の「データ放送の双方向」を入れるまで
 * 403 を返します。
 *
 * 何に繋いでよいかの決め方と、その理由は
 * [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
 */

import { error } from '@sveltejs/kit';
import { postForBml, refusalMessage, requireBmlNetwork } from '$lib/server/bml-network';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url, request }) => {
    requireBmlNetwork();

    const target = url.searchParams.get('url');
    if (target === null || target === '') error(400, 'url がありません');

    const body = new Uint8Array(await request.arrayBuffer());

    try {
        const got = await postForBml(target, body);
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
