import { fail } from '@sveltejs/kit';
import { COOKIE, countOthers, destroyOthers, find } from '#lib/server/session.js';

/**
 * 一般。いまはログインまわりだけ (ログアウトと、ほかの端末からもログアウト)。
 *
 * **ログインの控え (Cookie) で入っているときだけ出す。** 素通し (LAN) には控えが無く、
 * 切るものも無い。アクセストークン (テレビのアプリ) で画面を開くことは無いが、
 * 開けても控えが無いので同じ扱い
 */
export function load({ cookies }) {
    const session = find(cookies.get(COOKIE));
    return {
        /** この端末の控えのほかに生きているログインの数。控えで入っていなければ null */
        others: session === null ? null : countOthers(session.id),
    };
}

export const actions = {
    /**
     * **この端末のほかのログインを全部終わらせる。** なくした端末・手放した端末を止めるため。
     * 送るのは POST だけ (フォームの送信。SvelteKit が Origin を見て、よそのサイトからの送信を断る)
     */
    logoutOthers: async ({ cookies }) => {
        const session = find(cookies.get(COOKIE));
        if (session === null)
            return fail(400, { message: 'ログインしていないので、終わらせるログインがありません' });
        return { success: true, loggedOut: destroyOthers(session.id) };
    },
};
