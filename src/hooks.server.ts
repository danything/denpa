// いちばん先に読む。アプリの起動のログからサーバのログの写しを取る (設定の「その他」の「ログ」。`server.js` 自身の行は写らない)
import "#lib/server/log-buffer.js";

import { redirect } from "@sveltejs/kit";

import {
  clientAddress,
  configured,
  denied,
  foreignHost,
  isOpenPath,
  needsLogin,
  needsPairing,
  trusted,
} from "#lib/server/auth.js";
import { bearerToken, verifyToken } from "#lib/server/device-auth.js";
import { relative } from "#lib/server/paths.js";
import { start } from "#lib/server/runtime.js";
import { COOKIE, find } from "#lib/server/session.js";

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

export async function handle({ event, resolve }) {
  const { pathname, search } = event.url;

  /*
   * **アクセストークン** (`Authorization: Bearer denpa_…`、device-auth.ts)。ペアリングで渡したもの。
   * 生きていればログインした人と同じに通す (どこから来ても。家の外の OIDC 越しでも使えるように)。
   *
   * **出されたアクセストークンが駄目なら、ほかの認証方法へ回さずに 401。** 信頼するネットワークの中でも同じ —
   * 取り消されたアクセストークンで黙って通すと、アプリは取り消されたことに気付けず、外へ出た途端に
   * 使えなくなる。401 ならアプリは「ペアリングし直し」と分かる。
   * `denpa_` で始まらない Bearer (前段の SSO などが付けるもの) は見ずに、いつもの認証へ回す
   */
  const bearer = bearerToken(event.request.headers.get("authorization"));
  if (bearer !== null) {
    const owner = verifyToken(bearer);
    if (owner === null) {
      return Response.json(
        { error: "invalid_token" },
        {
          status: 401,
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
        },
      );
    }
    event.locals.user = { subject: `token:${owner.id}`, name: owner.name };
    event.locals.token = owner.id;
    return finish(await resolve(event));
  }

  /*
   * **何も聞かずに通す相手。** アドレスが `TRUSTED_NETWORKS` に当たり、名前も知っているものの
   * ときだけ。LAN のプレイヤーに資格情報を入れずに使わせるためで、ここに当たると
   * OIDC も掛からない。
   *
   * **名前も見るのは DNS リバインディングを防ぐため** (`auth.knownHost`)。知らない名前なら
   * 信頼したネットワークの外と同じに扱う (OIDC があればログインを求め、無ければ断る)
   */
  const address = clientAddress(event);
  const inside = trusted(address);
  const foreign = inside ? foreignHost(event.request.headers, address) : null;
  const open = inside && foreign === null;

  if (!open && !isOpenPath(pathname)) {
    if (needsLogin()) {
      /*
       * **OIDC でのログイン。** 設定してあるときだけ効く (`auth.needsLogin`)。
       *
       * ここで見るのは Cookie の控えだけ。OIDC の発行元とのやり取りは `/login` と
       * `/login/callback` に閉じてあり、普段のリクエストで外へ出ることはない。
       * 録画のファイル (`/api/recordings/<id>/file`) もここで通す — ブラウザで観る
       * `<video>` も端末に保存も、同じ Cookie を付けてリクエストする
       */
      const session = find(event.cookies.get(COOKIE));
      if (session !== null) {
        event.locals.user = { subject: session.subject, name: session.name };
      } else {
        /*
         * **画面の読み込み以外はリダイレクトしない。** fetch やフォーム送信を
         * 302 でログイン画面へ送ると、返ってきた HTML を JSON として読もうとして
         * 意味の分からない失敗になる。401 なら画面側は「切れた」と分かる
         */
        const wantsHtml =
          event.request.headers.get("accept")?.includes("text/html") === true;
        if (
          event.request.method !== "GET" ||
          !wantsHtml ||
          pathname.startsWith("/api/")
        ) {
          return needsPairing();
        }
        redirect(
          302,
          relative(
            event.url,
            `/login?to=${encodeURIComponent(pathname + search)}`,
          ),
        );
      }
    } else if (configured() && pathname.startsWith("/api/")) {
      // 信頼するネットワークの外から、アクセストークンを持たずに来た。アプリはこれで「ペアリングが要る」と分かる
      return needsPairing();
    } else {
      // 入る手段が無い (設定していないか、信頼するネットワークの外の画面か、知らない名前)。言葉で返す (auth.denied)
      return denied(address, foreign);
    }
  }

  /*
   * **ホームの `?q=` は検索の画面へ。** 言葉で探すのはサイト全体の検索 (`/search`) に寄せた。
   * 前に貼ったリンクや履歴から来ても、同じ言葉の結果が出る
   */
  const q = event.url.searchParams.get("q");
  if (pathname === "/" && event.request.method === "GET" && q !== null) {
    redirect(302, relative(event.url, `/search?q=${encodeURIComponent(q)}`));
  }

  return finish(await resolve(event));
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
   * `no-cache` は「持っていてよいが、出す前に必ず聞く」。画面の HTML には
   * CSP の nonce (毎回変わる。vite.config.ts の `csp`) が入るので指紋も毎回変わり、
   * 304 にはならず中身が流れ直す。HTML は小さく、重いもの (`_app/immutable/`) は
   * 下のとおり永く持たせたままなので、遅くはならない。
   *
   * 触るのは画面だけ (`x-sveltekit-page`)。`__data.json` は SvelteKit が
   * 自分で `no-store` を付けているし、`_app/immutable/` は名前に指紋が
   * 入っていて**永く持たせたい**ので、そこへ口を出さない
   */
  if (
    response.headers.get("x-sveltekit-page") === "true" &&
    !response.headers.has("cache-control")
  ) {
    response.headers.set("cache-control", "no-cache");
  }

  return response;
}
