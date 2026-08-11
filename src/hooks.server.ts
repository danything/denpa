import { redirect } from '@sveltejs/kit';
import { authorized, challenge, needsLogin, protects, sessionMayRead, trusted } from '$lib/server/auth';
import { handleDav } from '$lib/server/dav';
import { start } from '$lib/server/runtime';
import { COOKIE, find } from '$lib/server/session';

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

/**
 * 接続元の住所。**読めなければ空文字を返す。**
 *
 * adapter-node は `ADDRESS_HEADER` を渡してあるのにそのヘッダが無いリクエストが
 * 来ると**例外を投げる**。Traefik を通らずに Pod へ直に届くもの (kubelet の
 * ヘルスチェックなど) がそれで、そのまま呼ぶと 500 になる。
 *
 * **読めなかったときは素通しにしない** (空文字はどの CIDR にも当たらない)。
 * 分からないほうを通すと、ヘッダを外すだけで認証を抜けられてしまう
 */
function clientAddress(event: Parameters<typeof handle>[0]['event']): string {
    try {
        return event.getClientAddress();
    } catch {
        return '';
    }
}

export async function handle({ event, resolve }) {
    const { pathname, search } = event.url;

    /*
     * **何も聞かずに通す相手。** 住所が `TRUSTED_NETWORKS` に当たったときだけ。
     * LAN のプレイヤーに資格情報を入れずに使わせるためで、ここに当たると
     * ベーシック認証も OIDC も掛からない
     */
    const open = trusted(clientAddress(event));

    /*
     * **ログインの控えは先に読む。** ファイルの口 (`/api/recordings/<id>/file`) は
     * ベーシック認証で守ってあるが、**録画をブラウザで観るようになったので
     * `<video>` もそこを取りに来る**。OIDC で入った人は資格情報を持っていないので、
     * このままだと映像を出そうとした瞬間に認証ダイアログが立つ (`sessionMayRead`)
     */
    const session = find(event.cookies.get(COOKIE));

    if (
        !open &&
        protects(pathname) &&
        !authorized(event.request.headers.get('authorization')) &&
        !sessionMayRead(pathname, session !== null)
    ) {
        return challenge();
    }

    /*
     * **OIDC でのログイン。** 設定してあるときだけ効く (`auth.needsLogin`)。
     *
     * ここで見るのは Cookie の控えだけ。Entra とのやり取りは `/login` と
     * `/login/callback` に閉じてあり、普段のリクエストで外へ出ることはない。
     */
    if (!open && needsLogin(pathname)) {
        if (session !== null) {
            event.locals.user = { subject: session.subject, name: session.name };
        } else {
            /*
             * **画面の読み込み以外はリダイレクトしない。** fetch やフォーム送信を
             * 302 でログイン画面へ送ると、返ってきた HTML を JSON として読もうとして
             * 意味の分からない失敗になる。401 なら画面側は「切れた」と分かる
             */
            const wantsHtml = event.request.headers.get('accept')?.includes('text/html') === true;
            if (event.request.method !== 'GET' || !wantsHtml) {
                return new Response('login required', { status: 401 });
            }
            redirect(302, `/login?to=${encodeURIComponent(pathname + search)}`);
        }
    }

    // WebDAV の PROPFIND は SvelteKit のルートでは受けられないのでここで捌く
    const dav = handleDav(event.request, event.url);
    if (dav !== null) return dav;

    const response = await resolve(event);

    /*
     * **画面の HTML は毎回聞き直させる。**
     *
     * SvelteKit は SSR した HTML に中身の指紋 (`etag`) だけを付け、
     * 「どれくらい持っていていいか」は何も言わない。言われなかった端末は
     * **自分で決める** — ホーム画面から入れたアプリ (PWA) を開き直したときに、
     * 溜めてあった HTML をそのまま出すことがあり、**録画一覧が前に閉じた
     * ときのまま**になる。
     *
     * `no-cache` は「持っていてよいが、出す前に必ず聞く」。指紋はそのままなので、
     * 変わっていなければ 304 で中身は流れない — **遅くならずに古くならない**。
     *
     * 触るのは画面だけ (`x-sveltekit-page`)。`__data.json` は SvelteKit が
     * 自分で `no-store` を付けているし、`_app/immutable/` は名前に指紋が
     * 入っていて**永く持たせたい**ので、そこへ口を出さない
     */
    if (response.headers.get('x-sveltekit-page') === 'true' && !response.headers.has('cache-control')) {
        response.headers.set('cache-control', 'no-cache');
    }

    return response;
}
