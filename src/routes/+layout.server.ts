import { updateAvailable } from '$lib/server/update';

/**
 * ログインしているかどうか。**OIDC を通って入ったときだけ入る。**
 *
 * 素通し (LAN) で入っている人は `null` のまま。切る控えを持っていないので、
 * ヘッダーのログアウトもそのとき出しません。
 *
 * **名前は画面に出しません** (出しても、できることは変わらないため)。
 * 控えには残してあるので、DB を見れば誰の分か分かります。
 *
 * `update` は新しい版が出ているか (`server/update.ts`)。ヘッダーに出す
 */
export function load({ locals }) {
    return { user: locals.user ?? null, update: updateAvailable() };
}
