/**
 * http の Hybridcast のアプリの script・画像・CSS を、合言葉の配信元の同じ経路から取って返す
 * ([hc-relay.ts](../../../../../../lib/server/hc-relay.ts) の `relayAsset`)。
 *
 * - **ログインは見ない** (使い捨てのオリジンの iframe からの読み込みには cookie が付かない)。合言葉が許可証
 * - 取り方の決まりは `/api/bml/proxy` と同じ (`fetchForBml`。公開アドレスだけ・10 秒・4MB)。双方向を切ってあれば 403
 */

import { requireBmlNetwork } from '#lib/server/bml-network.js';
import { relayAsset } from '#lib/server/hc-relay.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url }) => {
    requireBmlNetwork();
    return relayAsset(params.token, params.path, url.search);
};
