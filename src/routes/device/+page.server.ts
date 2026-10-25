import { fail } from "@sveltejs/kit";

import {
  approve,
  normalizeUserCode,
  viewCode,
} from "#lib/server/device-auth.js";

/**
 * **テレビのペアリングを済ませる画面** (device-auth.ts)。テレビが出した QR で開く。
 *
 * ここに来られた時点で、いつものログイン方法 (信頼するネットワークか OIDC のログイン) は
 * 通っている (hooks)。それでも**開いただけでは許さない** — コードを出す API は誰でも呼べるので、
 * 人の作ったコードのリンクを開かされただけで、その人の端末にアクセストークンが渡ってしまう。
 * load は端末の名前とコードを見せるだけで、許すのは画面のボタンから送った POST (このアクション) だけ。
 * 外のサイトからの POST は SvelteKit の CSRF の守り (Origin を見る) が、外のサイトの iframe に
 * 入れてボタンを押させるのは `frame-ancestors 'self'` (vite.config.ts) が止める。
 *
 * **アクセストークン (`Authorization: Bearer`) で来た相手には済ませない** (403)。盗まれたアクセストークンで
 * 別のものを作れると、元のものを取り消しても作ったものが生き残る。許すのはブラウザ (信頼するネットワークか OIDC) だけ
 */
export function load({ url, locals }) {
  const raw = url.searchParams.get("code") ?? "";
  const code = normalizeUserCode(raw);
  const viaToken = locals.token !== undefined;
  return {
    code,
    viaToken,
    view: code === null || viaToken ? null : viewCode(code),
  };
}

export const actions = {
  default: async ({ request, locals }) => {
    if (locals.token !== undefined)
      return fail(403, { viaToken: true, view: null });
    const form = await request.formData();
    const code = normalizeUserCode(String(form.get("code") ?? ""));
    const view =
      code === null
        ? null
        : approve(code, locals.user?.subject ?? "trusted-network");
    return { view };
  },
};
