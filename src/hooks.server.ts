import { redirect } from '@sveltejs/kit';
import {
    clientAddress,
    configured,
    denied,
    isFilePath,
    isOpenPath,
    needsLogin,
    sessionMayRead,
    trusted,
} from '#lib/server/auth.js';
import { bearerToken, verifyToken } from '#lib/server/device-auth.js';
import { relative } from '#lib/server/paths.js';
import { start } from '#lib/server/runtime.js';
import { COOKIE, find } from '#lib/server/session.js';
import { shareTokenAllows } from '#lib/server/share.js';

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

export async function handle({ event, resolve }) {
    const { pathname, search } = event.url;

    /*
     * **アプリの鍵** (`Authorization: Bearer denpa_…`、device-auth.ts)。ペアリングで渡したもの。
     * 生きていればログインした人と同じに通す (どこから来ても。家の外の OIDC 越しでも使えるように)。
     *
     * **出された鍵が駄目なら、ほかの道へ回さずに 401。** 信頼するネットワークの中でも同じ —
     * 取り消された鍵で黙って通すと、アプリは取り消されたことに気付けず、外へ出た途端に
     * 使えなくなる。401 ならアプリは「ペアリングし直し」と分かる。
     * `denpa_` で始まらない Bearer (前段の SSO などが付けるもの) は見ずに、いつもの道へ回す
     */
    const bearer = bearerToken(event.request.headers.get('authorization'));
    if (bearer !== null) {
        const owner = verifyToken(bearer);
        if (owner === null) {
            return Response.json(
                { error: 'invalid_token' },
                { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } },
            );
        }
        event.locals.user = { subject: `token:${owner.id}`, name: owner.name };
        event.locals.token = owner.id;
        return finish(await resolve(event));
    }

    /*
     * **何も聞かずに通す相手。** 住所が `TRUSTED_NETWORKS` に当たったときだけ。
     * LAN のプレイヤーに資格情報を入れずに使わせるためで、ここに当たると
     * OIDC も掛からない
     */
    const open = trusted(clientAddress(event));

    /*
     * **ログインの控えは先に読む。** 録画をブラウザで観るようになったので、
     * `<video>` がファイルの口 (`/api/recordings/<id>/file`) を取りに来る。
     * OIDC で入った人をそこで断らないため (`sessionMayRead`)
     */
    const session = find(event.cookies.get(COOKIE));

    if (!open && !isOpenPath(pathname)) {
        if (isFilePath(pathname)) {
            /*
             * **ファイルの口はログインの控えか、期限付きのリンク** (share.ts)。
             * プレイヤーはリダイレクトを扱えないので、URL そのものが資格になる
             * リンクで開ける。ベーシック認証は廃止した — パスワードを使う場面が
             * 全部期限付きのリンクに置き換わったため
             */
            if (!sessionMayRead(session !== null) && !shareTokenAllows(pathname, event.url.searchParams)) {
                return denied();
            }
        } else if (needsLogin()) {
            /*
             * **OIDC でのログイン。** 設定してあるときだけ効く (`auth.needsLogin`)。
             *
             * ここで見るのは Cookie の控えだけ。Entra とのやり取りは `/login` と
             * `/login/callback` に閉じてあり、普段のリクエストで外へ出ることはない。
             */
            if (session !== null) {
                event.locals.user = { subject: session.subject, name: session.name };
            } else {
                /*
                 * **画面の読み込み以外はリダイレクトしない。** fetch やフォーム送信を
                 * 302 でログイン画面へ送ると、返ってきた HTML を JSON として読もうとして
                 * 意味の分からない失敗になる。401 なら画面側は「切れた」と分かる
                 */
                const wantsHtml = event.request.headers.get('accept')?.includes('text/html') === true;
                if (event.request.method !== 'GET' || !wantsHtml || pathname.startsWith('/api/')) {
                    return needsPairing();
                }
                redirect(302, relative(event.url, `/login?to=${encodeURIComponent(pathname + search)}`));
            }
        } else if (configured() && pathname.startsWith('/api/')) {
            // 信頼するネットワークの外から、鍵を持たずに来た。アプリはこれで「ペアリングが要る」と分かる
            return needsPairing();
        } else {
            // 入る道が無い (設定していないか、信頼するネットワークの外の画面)。言葉で返す (auth.denied)
            return denied();
        }
    }

    return finish(await resolve(event));
}

/**
 * 資格の無い API の呼び出しへの答え。**いつも同じ形の 401 JSON** (docs/api.md)。
 * テレビのアプリは鍵を持たずにまず API を叩き、これが返ればペアリングに進む
 * (信頼するネットワークの中なら通るので、ペアリングは要らない)。HTML のログイン画面へ
 * 回すと、アプリは JSON として読もうとして意味の分からない失敗になる
 */
function needsPairing(): Response {
    return Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: { 'www-authenticate': 'Bearer realm="denpa"' } },
    );
}

function finish(response: Response): Response {
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
