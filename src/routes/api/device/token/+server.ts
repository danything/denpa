import { json } from '@sveltejs/kit';
import { poll } from '#lib/server/device-auth.js';

/**
 * **許されたか聞きに来る** (device-auth.ts)。許されていれば鍵を1度だけ返す。
 * 答えの形は RFC 8628 に揃えてある (`authorization_pending` なら `interval` 秒おいてまた聞く)
 */
export async function POST({ request }) {
    let deviceCode: unknown;
    try {
        ({ deviceCode } = await request.json());
    } catch {
        return json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (typeof deviceCode !== 'string' || deviceCode === '') {
        return json({ error: 'invalid_grant' }, { status: 400 });
    }
    const result = poll(deviceCode);
    if ('error' in result) return json(result, { status: 400 });
    return json({ token: result.token, tokenType: 'Bearer' });
}
