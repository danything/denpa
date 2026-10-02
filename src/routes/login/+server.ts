import { redirect } from '@sveltejs/kit';
import { enabled, redirectUri, safeReturn, start } from '#lib/server/oidc.js';
import { publicBase } from '#lib/server/paths.js';
import { PENDING_COOKIE, PENDING_TTL } from '#lib/server/session.js';

/**
 * ログインを始める。Entra へ送るだけで、こちらでは何も決めない。
 *
 * 途中で使うもの (state / nonce / PKCE の合言葉 / 戻る先) は Cookie に預ける。
 * DBに置いてもいいが、**捨て忘れが残らない**ぶんこちらが素直 — 期限を切っておけば、
 * 途中でやめたぶんはブラウザが黙って消す。
 */
export async function GET({ url, cookies, request }) {
    // 設定していないのにここへ来た。入口が無いことを隠さない
    if (!enabled()) return new Response('OIDC が設定されていません', { status: 404 });

    const { url: authorize, pending } = await start(
        redirectUri(publicBase(url, request.headers)),
        safeReturn(url.searchParams.get('to')),
    );
    cookies.set(PENDING_COOKIE, JSON.stringify(pending), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: url.protocol === 'https:',
        maxAge: PENDING_TTL,
    });
    // 行き先は IdP (よその origin)。SvelteKit 3 からは外へ送ると明示しないと止められる。
    // 宛先は利用者の入力ではなく、IdP の discovery から組み立てたもの
    redirect(302, authorize, { external: true });
}
