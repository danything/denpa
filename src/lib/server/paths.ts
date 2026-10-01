/**
 * **接頭辞の下でも動く URL。** denpa は自分がどの接頭辞の下に居るかを知らない。
 *
 * 前段 (Home Assistant の Ingress・k8s の Ingress で `/denpa` を剥がすもの) は接頭辞を
 * 剥がしてから渡してくるので、こちらに見えるのは `/guide` でも、ブラウザは
 * `/api/hassio_ingress/<token>/guide` に居る。接頭辞を設定させない (Ingress の
 * 接頭辞はトークン入りで毎回変わる)。代わりに:
 *
 * - 画面の中は `base` (`$app/paths`) を頭に付ける。SvelteKit はこれをブラウザの居る
 *   URL から求めるので、接頭辞がそのまま入る (paths.relative。既定)
 * - 転送 (redirect) は**いまの URL からの相対**にする。ブラウザが接頭辞込みで解く
 * - 外 (VLC・OIDC) に渡す絶対 URL だけは接頭辞を知る必要があるので、前段が付ける
 *   `X-Forwarded-Prefix` か `X-Ingress-Path` (Home Assistant) を頭に付ける
 */

/**
 * `to` (`/` 始まり) へ、いまの URL (`from`) からの相対で行く。`/a/b` から `/login` なら
 * `../login`。前段が剥がした接頭辞は、ブラウザが自分の居る URL から補う
 */
export function relative(from: URL, to: string): string {
    const depth = from.pathname.split('/').length - 2;
    return (depth > 0 ? '../'.repeat(depth) : './') + to.slice(1);
}

/** 外に渡す絶対 URL の頭。`https://example.com/denpa` のように、末尾の `/` は付けない */
export function publicBase(url: URL, headers: Headers): string {
    const prefix = (headers.get('x-forwarded-prefix') ?? headers.get('x-ingress-path') ?? '').replace(
        /\/+$/,
        '',
    );
    return url.origin + (/^\/(?!\/)/.test(prefix) ? prefix : '');
}
