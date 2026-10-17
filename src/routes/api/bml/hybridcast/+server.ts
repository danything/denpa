/**
 * Hybridcast のアプリを入れる iframe の中身 ([docs/stream.md](../../../../../docs/stream.md#hybridcast))。
 *
 * **中身は空の入れ物だけ。** 画面 (`HybridcastFrame.svelte`) が中継で取って差し込みを入れた HTML を
 * postMessage で渡してきて、ここが `document.write` で開く。
 *
 * - `sandbox allow-scripts` (CSP)。iframe の sandbox 属性に加えて、ここでも使い捨てのオリジンにする
 *   (この URL を直に開いても denpa のオリジンにならない)。denpa の cookie・localStorage・API の返りには触れない
 * - 放送局の script・画像・CSS は元のサーバから直に読む (`*`)。**繋ぐ (`connect-src`) のは止める** —
 *   fetch・XHR は差し込みが画面へ渡し、画面が中継で取る。中継の決まり (公開アドレスだけ・10 秒・4MB・
 *   何も持たせない) をそのまま通すため
 * - フォームの送信・入れ子の iframe・worker は無し
 *
 * 双方向を切ってあれば 403 (Hybridcast も起動しない)。
 */

import { requireBmlNetwork } from '#lib/server/bml-network.js';
import type { RequestHandler } from './$types';

const CSP = [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
    "style-src * data: blob: 'unsafe-inline'",
    'img-src * data: blob:',
    'font-src * data: blob:',
    'media-src * data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
].join('; ');

/** 画面から HTML を受け取って開く。受け取るのは親 (denpa の画面) からだけ */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
addEventListener('message', function open(event) {
    if (event.source !== parent || !event.data || event.data.hc !== 1 || event.data.type !== 'html') return;
    removeEventListener('message', open);
    document.open();
    document.write(String(event.data.html));
    document.close();
});
parent.postMessage({ hc: 1, type: 'ready' }, '*');
</script></body></html>`;

export const GET: RequestHandler = () => {
    requireBmlNetwork();
    return new Response(PAGE, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': CSP,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
        },
    });
};
