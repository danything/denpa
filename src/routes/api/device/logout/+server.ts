import { json } from '@sveltejs/kit';
import { revokeToken } from '#lib/server/device-auth.js';

/**
 * **アプリが自分の鍵を止める** (アプリの「サーバーから外す」)。止められるのは、
 * いま `Authorization: Bearer` で出している鍵だけ (ほかの端末のものは設定画面から)
 */
export function POST({ locals }) {
    if (locals.token === undefined) return json({ error: 'unauthorized' }, { status: 401 });
    revokeToken(locals.token);
    return new Response(null, { status: 204 });
}
