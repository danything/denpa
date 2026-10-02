/**
 * データ放送の疎通確認 (`browser.confirmIPNetwork`)。
 *
 * 「相手まで届くか」を訊いてくる放送のための口。借りものは未実装だと `null` を返す。
 * **NHK は呼びに来ない** — あちらは送る口 (`post`) へ一度投げて決める
 * (`bml-network.ts` の `confirmReachable`)。
 *
 * 中継口と同じで**既定では動きません**
 * ([bml-network.ts](../../../../lib/server/bml-network.ts))。
 */

import { error, json } from '@sveltejs/kit';
import { confirmReachable, refusalMessage, requireBmlNetwork } from '#lib/server/bml-network.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
    requireBmlNetwork();

    const to = url.searchParams.get('to');
    if (to === null || to === '') error(400, 'to がありません');
    const wait = Number(url.searchParams.get('wait') ?? 4000);

    try {
        return json(await confirmReachable(to, Number.isFinite(wait) ? wait : 4000));
    } catch (failure) {
        const why = refusalMessage(failure, '確かめられませんでした');
        console.warn(`[bml] 疎通を確かめられません: ${to} (${why})`);
        // **届かないことは失敗ではない。** 放送のアプリはそれを見て出し分ける
        return json({ success: false, ipAddress: null, responseTimeMillis: null });
    }
};
