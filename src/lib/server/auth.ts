import { inAny, networks, unreadable } from './address';
import { config } from './config';
import { enabled as oidcEnabled } from './oidc';

/**
 * 誰を通すか。**どこでも通る方法が2つと、エンドポイントを限った方法が2つ。**
 *
 * | 方法 | 何者か |
 * | --- | --- |
 * | `TRUSTED_NETWORKS` | 信頼したネットワークから来た人。何も聞かずに通す |
 * | OIDC のログイン | 画面から入る人 (`docs/auth.md`) |
 * | 期限付きのリンク (`?token=`、share.ts) | 再生リンク・ダウンロード。**ファイルのエンドポイントだけ** |
 * | 使い捨てのチケット | ライブ視聴の WebSocket だけ (`tickets.ts`) |
 *
 * **どれも設定していなければ、全部断る** (`configured`)。以前はベーシック認証を
 * 起動時に自動で掛けていたが、廃止した — パスワードを使う場面 (プレイヤー登録・
 * ダウンロードURL) が全部期限付きのリンクに置き換わり、残っていたのは「画面に出して
 * 覚えさせるパスワード」だけだった。全部開けたいなら `TRUSTED_NETWORKS=0.0.0.0/0`
 * (公開の注意は docs/auth.md)。
 *
 * **プレイヤーはリダイレクトを扱えない。** ログイン画面へ飛ばされたところで
 * 何もできず「再生できません」で終わる。だからファイルのエンドポイントは、ログインではなく
 * **URL そのものが資格になる**期限付きのリンクで開ける。
 */

/**
 * 期限付きのリンクとログインの控えで開けられるエンドポイント (録画のファイル)。**ここは OIDC のリダイレクトにしない。**
 * **形式はここ1つ** — share.ts の突き合わせも同じものを使う
 */
const FILE_PATH = /^\/api\/recordings\/(\d+)\/file$/;

/** ファイルのエンドポイントなら、そのパスが指す録画ID。違えば null */
export function fileRecordingId(pathname: string): number | null {
    const m = FILE_PATH.exec(pathname);
    return m === null ? null : Number(m[1]);
}

/**
 * 素通しにするエンドポイント。
 *
 * - **ログインの入口。** 守ると入れなくなる (ログイン画面へ行くのにログインが要る)
 * - **`/logout`。** ここも素通し (ログアウトするのにログインを要求しない)
 * - **`/api/health`。** Kubernetes の `livenessProbe` が叩く。守ると**Pod が
 *   再起動を繰り返す** (掛ける範囲を選べるのをやめたときに実際に踏んだ —
 *   E2E のスタックが起動待ちで固まった)。出しているのは
 *   「生きているか・動いている版と新しい版・局が何件か・録画が何本か」だけ
 * - **`/manifest.webmanifest`。** ブラウザは**資格情報を付けずに**取りに行く
 *   ので (`<link rel="manifest">` に `crossorigin` を書かない限り)、守ると
 *   ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
 *   hooks より手前で返していて、そもそも掛かっていなかった。出しているのは
 *   アプリの名前とアイコンの場所だけ
 * - **ペアリングコードと鍵の受け取り** (`/api/device/code`・`/api/device/token`)。テレビは
 *   まだ何の資格も持っていない。コードを出すだけでは入れず、許すのは `/device` (ここは守る)。
 *   誰でも叩けるので、有効なコードの数に上限がある (device-auth.ts の `MAX_PENDING`)
 */
const OPEN_PATHS = [
    /^\/login(\/|$)/,
    /^\/logout$/,
    /^\/api\/health$/,
    /^\/manifest\.webmanifest$/,
    /^\/api\/device\/(code|token)$/,
];

export function isFilePath(pathname: string): boolean {
    return fileRecordingId(pathname) !== null;
}

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
        ? 'このページは、ログインするか期限付きのリンクからでないと開けません'
        : 'ログイン方法が設定されていません。OIDC か TRUSTED_NETWORKS を設定してください (docs/auth.md)';
    return new Response(text, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * ファイルのエンドポイントを、**ログイン済みの画面に開けるか**。
 *
 * 録画をブラウザで観るようになったので、`<video>` がファイルのエンドポイントを取りに来る。
 * OIDC で入った人が映像を出そうとした瞬間に断られないように、ログインの控えを
 * ここでも受ける。通る相手が増えるわけではない — 「この denpa に入れる人」のまま
 */
export function sessionMayRead(loggedIn: boolean): boolean {
    // ファイルのエンドポイントかどうかは呼ぶ側 (hooks) が振り分けてから来る
    return loggedIn && oidcEnabled();
}

/**
 * **何も聞かずに通す相手か。** 見るのは住所だけ (`TRUSTED_NETWORKS`、CIDR の
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
 * 接続元の住所。**読めなければ空文字を返す。**
 *
 * 住所は入口の server.js が決めて `x-denpa-remote` に入れ、adapter-node はそれを読む
 * (`ADDRESS_HEADER` は server.js が固定する。前段をどこまで信じるかは `TRUSTED_PROXIES`)。
 * adapter-node はそのヘッダが空だと**例外を投げる** — server.js が相手の住所を
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

/** OIDC でログインを求めるか (素通しのエンドポイントとファイルのエンドポイントは呼ぶ側 (hooks) が先に振り分ける) */
export function needsLogin(): boolean {
    return oidcEnabled();
}
