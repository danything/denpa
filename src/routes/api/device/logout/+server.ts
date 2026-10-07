import { json } from '@sveltejs/kit';
import { revokeToken } from '#lib/server/device-auth.js';

/**
 * **アプリが自分の鍵を止める** (アプリの「サーバーから外す」)。止められるのは、
 * いま `Authorization: Bearer` で出している鍵だけ (ほかの端末のものは設定画面から)
 */
export function POST({ locals }) {
    // 鍵が無い (信頼するネットワークから素で来た) ときも、ほかの口と同じ 401 (docs/api.md)
    if (locals.token === undefined) {
        return json(
            { error: 'unauthorized' },
            { status: 401, headers: { 'www-authenticate': 'Bearer realm="denpa"' } },
        );
    }
    revokeToken(locals.token);
    return new Response(null, { status: 204 });
}
