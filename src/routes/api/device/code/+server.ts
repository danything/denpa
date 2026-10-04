import { error, json } from '@sveltejs/kit';
import { CODE_TTL_MS, issueCode, POLL_INTERVAL_MS } from '#lib/server/device-auth.js';

/**
 * **ペアリングの札を出す** (device-auth.ts。資格は要らない — テレビはまだ何も持っていない)。
 * URL は denpa の根からの相対。テレビは `verificationUriComplete` を QR にして出す
 */
export async function POST({ request }) {
    let name: unknown;
    try {
        ({ name } = await request.json());
    } catch {
        error(400, 'リクエストの本文を読めませんでした');
    }
    const issued = issueCode(typeof name === 'string' ? name : '');
    if (issued === null) {
        return json({ error: 'too_many_pending' }, { status: 429 });
    }
    return json({
        deviceCode: issued.deviceCode,
        userCode: issued.userCode,
        verificationUri: 'device',
        verificationUriComplete: `device?code=${issued.userCode}`,
        expiresIn: CODE_TTL_MS / 1000,
        interval: POLL_INTERVAL_MS / 1000,
    });
}
