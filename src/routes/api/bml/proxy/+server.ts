/**
 * データ放送の双方向 (通信系コンテンツ) の中継口
 * ([docs/stream.md](../../../../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
 *
 * 放送局のサーバは受信機の専用ネットワークスタックを前提にしていて
 * **CORS を返さない**ので、ブラウザからは直に取れません。ここが代わりに
 * 取ってきます。
 *
 * **既定では動きません** — 設定画面の「データ放送の双方向」を入れるまで
 * 403 を返します。黙って外へ出ていく口を作らないためで、切っている間は
 * 画面側も `isIPConnected` に 0 を返すので、放送のアプリは
 * 「インターネットに接続されていません」と正しく案内します。
 *
 * 何に繋いでよいかの決め方と、その理由は
 * [bml-network.ts](../../../../lib/server/bml-network.ts) にあります。
 */

import { error } from '@sveltejs/kit';
import { fetchForBml, refusalMessage, requireBmlNetwork } from '$lib/server/bml-network';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
    requireBmlNetwork();

    const target = url.searchParams.get('url');
    if (target === null || target === '') error(400, 'url がありません');

    try {
        const got = await fetchForBml(target);
        /*
         * **相手の返した符号をそのまま返す。** 放送のアプリは 404 や 503 を
         * 見て出し分けることがあるので、こちらで 200 に均すと判断を奪う
         */
        return new Response(got.body as BodyInit, {
            status: got.status,
            headers: {
                'content-type': got.contentType,
                // **溜めさせない。** 放送の通信は「いまの値」を取りに来るもの
                'cache-control': 'no-store',
            },
        });
    } catch (failure) {
        const why = refusalMessage(failure, '取りに行けませんでした');
        // **何に繋ごうとして断ったかを残す。** 切り分けのときにここがいちばん効く
        console.warn(`[bml] 中継を断りました: ${target} (${why})`);
        // 断りは 502 (相手ではなく、こちらが取りに行けなかった)
        error(502, why);
    }
};
