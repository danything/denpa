/**
 * http の Hybridcast のアプリを中継する合言葉を出す ([hc-relay.ts](../../../../lib/server/hc-relay.ts))。
 * **ここはログインした人だけ** (いつもの守り)。https のアプリには要らないので出さない (`root: null`)
 */

import { error, json } from '@sveltejs/kit';
import { requireBmlNetwork } from '#lib/server/bml-network.js';
import { grant } from '#lib/server/hc-relay.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
    requireBmlNetwork();
    const body: unknown = await request.json().catch(() => null);
    const raw = body !== null && typeof body === 'object' ? (body as { url?: unknown }).url : undefined;
    let target: URL;
    try {
        target = new URL(String(raw));
    } catch {
        error(400, 'url が読めません');
    }
    if (target.protocol === 'https:') return json({ root: null });
    if (target.protocol !== 'http:') error(400, 'http か https の URL だけです');
    return json({ root: `api/bml/hc/${grant(target.origin)}/` });
};
