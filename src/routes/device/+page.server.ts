import { approve, normalizeUserCode, viewCode } from '#lib/server/device-auth.js';

/**
 * **テレビのペアリングを済ませる画面** (device-auth.ts)。テレビが出した QR で開く。
 *
 * ここに来られた時点で、いつもの入り方 (信頼するネットワークか OIDC のログイン) は
 * 通っている (hooks)。だから**許すかどうかは聞かずに済ませる**。ただ、GET のまま
 * 許すと、ブラウザの先読みやリンクの下見で黙って済んでしまう。画面は開いたら
 * すぐ自分で送るフォーム (POST。CSRF の守りが効く) にし、許すのはそちらでやる
 */
export function load({ url }) {
    const raw = url.searchParams.get('code') ?? '';
    const code = normalizeUserCode(raw);
    return { code, view: code === null ? null : viewCode(code) };
}

export const actions = {
    default: async ({ request, locals }) => {
        const form = await request.formData();
        const code = normalizeUserCode(String(form.get('code') ?? ''));
        const view = code === null ? null : approve(code, locals.user?.subject ?? 'trusted-network');
        return { view };
    },
};
