import { type Actions, fail } from '@sveltejs/kit';
import { liveTokens, revokeToken } from '#lib/server/device-auth.js';

export function load() {
    /** ペアリングしたテレビ (アクセストークン。device-auth.ts) */
    return { devices: liveTokens() };
}

export const actions = {
    /** テレビのアクセストークンを無効にする。テレビは次に API を呼んだときに 401 を受けて、ペアリングし直しになる */
    revokeDevice: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isInteger(id)) return fail(400, { message: 'IDが不正です' });
        revokeToken(id);
        return { success: true };
    },
} satisfies Actions;
