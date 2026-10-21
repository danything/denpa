import { inAny, networks, unreadable } from './address';
import { config } from './config';
import { enabled as oidcEnabled } from './oidc';

/**
 * 誰を通すか。**どこでも通る方法が3つと、エンドポイントを限った方法が1つ。**
 *
 * | 方法 | 何者か |
 * | --- | --- |
 * | `TRUSTED_NETWORKS` | 信頼したネットワークから来た人。何も聞かずに通す |
 * | OIDC のログイン | 画面から入る人 (`docs/auth.md`)。ブラウザで観る・端末に保存もこの控え (Cookie) で通る |
 * | アクセストークン (`Bearer denpa_…`) | ペアリングしたアプリ (`device-auth.ts`) |
 * | 使い捨てのチケット | ライブ視聴の WebSocket だけ (`tickets.ts`) |
 *
 * **どれも設定していなければ、全部断る** (`configured`)。以前はベーシック認証を
 * 起動時に自動で掛けていたが、廃止した — 残っていたのは「画面に出して
 * 覚えさせるパスワード」だけだった。全部開けたいなら `TRUSTED_NETWORKS=0.0.0.0/0`
 * (公開の注意は docs/auth.md)。
 */

/**
 * 素通しにするエンドポイント。
 *
 * - **ログインの入口。** 守ると入れなくなる (ログイン画面へ行くのにログインが要る)
 * - **`/logout`。** ここも素通し (ログアウトするのにログインを要求しない)
 * - **`/api/health`。** Kubernetes の `livenessProbe` が呼ぶ。守ると**Pod が
 *   再起動を繰り返す** (掛ける範囲を選べるのをやめたときに実際に踏んだ —
 *   E2E のスタックが起動待ちで固まった)。出しているのは
 *   「生きているか・動いている版と新しい版・局が何件か・録画が何本か」だけ
 * - **`/manifest.webmanifest`。** ブラウザは**資格情報を付けずに**取得する
 *   ので (`<link rel="manifest">` に `crossorigin` を書かない限り)、守ると
 *   ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
 *   hooks より手前で返していて、そもそも掛かっていなかった。出しているのは
 *   アプリの名前とアイコンの場所だけ
 * - **ペアリングコードとアクセストークンの受け取り** (`/api/device/code`・`/api/device/token`)。テレビは
 *   まだ何の資格も持っていない。コードを出すだけでは入れず、許すのは `/device` (ここは守る)。
 *   誰でも呼べるので、有効なコードの数に上限がある (device-auth.ts の `MAX_PENDING`)
 * - **http の Hybridcast のアプリの中継** (`/api/bml/hc/<合言葉>/…`)。アプリは使い捨てのオリジンの iframe にいて、
 *   そこからの読み込みにはログインの cookie が付かない。推測できない合言葉が許可証で、出すのはログインした人にだけ
 *   (`POST /api/bml/hc`。hc-relay.ts)
 */
const OPEN_PATHS = [
    /^\/login(\/|$)/,
    /^\/logout$/,
    /^\/api\/health$/,
    /^\/manifest\.webmanifest$/,
    /^\/api\/device\/(code|token)$/,
    /^\/api\/bml\/hc\/[0-9a-f]{32}\//,
];

export function isOpenPath(pathname: string): boolean {
    return OPEN_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * ログイン方法が1つでも設定してあるか。**無ければ全部断る** (fail-closed)。
 *
 * 分からない状態で開けておくより、閉まっていることが起動ログとエラーページから
 * はっきり分かるほうがいい。以前の「起動時にパスワードを自動生成して掛ける」は、
 * 掛かってはいるが**受け取り損ねると誰も入れない**うえ、その状態と区別が付かなかった。
 */
export function configured(): boolean {
    return oidcEnabled() || networks(config.trustedNetworks).length > 0;
}

/** ログイン方法が無いまま上がったとき (と、TRUSTED_NETWORKS の書き損じ) の案内。起動ログに1度だけ出す */
export function warnIfClosed(): void {
    // 書き損じは当たらないだけなので、気づけるように知らせる
    for (const entry of unreadable(networks(config.trustedNetworks))) {
        console.warn(`[boot] TRUSTED_NETWORKS の「${entry}」は読めないので無視します`);
    }
    if (configured()) return;
    console.warn(
        '[boot] ログイン方法が設定されていないため、すべてのアクセスを断ります。\n' +
            '       OIDC (docs/auth.md) か TRUSTED_NETWORKS (CIDR のカンマ区切り) を設定してください。\n' +
            '       すべて開けるなら TRUSTED_NETWORKS=0.0.0.0/0 (公開時の注意は docs/auth.md)',
    );
}

/** ログイン方法が無い相手への返事。理由が分からない 403 にしない */
export function denied(): Response {
    const text = configured()
        ? 'このページは、信頼したネットワーク (TRUSTED_NETWORKS) の中からでないと開けません'
        : 'ログイン方法が設定されていません。OIDC か TRUSTED_NETWORKS を設定してください (docs/auth.md)';
    return new Response(text, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * **何も聞かずに通す相手か。** 見るのはアドレスだけ (`TRUSTED_NETWORKS`、CIDR の
 * カンマ区切り)。
 *
 * **ここに当たると OIDC も掛かりません。** LAN のテレビのアプリ (denpa-tv)
 * に資格情報を入れずに使わせるのが狙いです。
 *
 * **どの名前で来たかは問いません。** 前段 (リバースプロキシ) は名前を届けるだけで、
 * 名前ごとに何かを分けてはいない。ここで名前まで見ると条件が二か所に散り、
 * 片方だけ直して食い違うほうが危ない。
 */
export function trusted(address: string): boolean {
    return inAny(address, networks(config.trustedNetworks));
}

/**
 * 接続元のアドレス。**読めなければ空文字を返す。**
 *
 * アドレスは入口の server.js が決めて `x-denpa-remote` に入れ、adapter-bun はそれを読む
 * (`ADDRESS_HEADER` は server.js が固定する。前段をどこまで信じるかは `TRUSTED_PROXIES`)。
 * adapter-bun はそのヘッダが無いと**例外を投げる** — server.js が相手のアドレスを
 * 読めなかったときがそれで、そのまま呼ぶと 500 になる。
 *
 * **読めなかったときは素通しにしない** (空文字はどの CIDR にも当たらない)。
 * 分からないほうを通すと、ヘッダを外すだけで認証を抜けられてしまう
 */
export function clientAddress(event: { getClientAddress(): string }): string {
    try {
        return event.getClientAddress();
    } catch {
        return '';
    }
}

/** OIDC でログインを求めるか (素通しのエンドポイントは呼ぶ側 (hooks) が先に振り分ける) */
export function needsLogin(): boolean {
    return oidcEnabled();
}
