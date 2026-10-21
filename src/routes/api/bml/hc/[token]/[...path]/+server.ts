/**
 * http の Hybridcast のアプリの script・画像・CSS を、合言葉の配信元の同じ経路から取って返す
 * ([hc-relay.ts](../../../../../../lib/server/hc-relay.ts))。
 *
 * - **ログインは見ない** (使い捨てのオリジンの iframe からの読み込みには cookie が付かない)。合言葉が許可証
 * - 取り方の決まりは `/api/bml/proxy` と同じ (`fetchForBml`。公開アドレスだけ・10 秒・4MB)。双方向を切ってあれば 403
 * - **返したものを denpa の権限で動かさない。** どれにも `sandbox` の CSP と `nosniff` を付ける — この URL を直に開かれても、
 *   denpa のオリジンの文書にはならない (script・画像・CSS として読まれる分には CSP は効かない)
 */

import { error } from '@sveltejs/kit';
import { fetchForBml, refusalMessage, requireBmlNetwork } from '#lib/server/bml-network.js';
import { originOf, TOKEN } from '#lib/server/hc-relay.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
    requireBmlNetwork();
    const origin = TOKEN.test(params.token) ? originOf(params.token) : null;
    if (origin === null) error(404, '合言葉が切れています。アプリを開き直してください');
    const target = `${origin}/${params.path}${url.search}`;
    try {
        const got = await fetchForBml(target);
        return new Response(got.body as BodyInit, {
            status: got.status,
            headers: {
                'content-type': got.contentType,
                'content-security-policy': 'sandbox',
                'x-content-type-options': 'nosniff',
                // アプリの部品は番組の間に変わらない。読み直しのたびに取りに行かない
                'cache-control': 'private, max-age=300',
            },
        });
    } catch (failure) {
        const why = refusalMessage(failure, '取得できませんでした');
        console.warn(`[bml] Hybridcast の中継を断りました: ${target} (${why})`);
        error(502, why);
    }
};
