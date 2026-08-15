import { config } from './config';
import { enabled as oidcEnabled } from './oidc';

/**
 * 誰を通すか。**入る道は3つ + ファイル専用が1つ。**
 *
 * | 道 | 何者か |
 * | --- | --- |
 * | `TRUSTED_NETWORKS` | 信頼したネットワークから来た人。何も聞かずに通す |
 * | OIDC のログイン | 画面から入る人 (`docs/auth.md`) |
 * | 期限付きの署名リンク (`?token=`) | プレイヤー・ダウンロード。**ファイルの口だけ** |
 * | 使い捨ての札 | ライブ視聴の WebSocket だけ (`tickets.ts`) |
 *
 * **どれも設定していなければ、全部断る** (`configured`)。以前はベーシック認証を
 * 起動時に自動で掛けていたが、廃止した — パスワードを使う場面 (プレイヤー登録・
 * ダウンロードURL) が全部署名リンクに置き換わり、残っていたのは「画面に出して
 * 覚えさせるパスワード」だけだった。全部開けたいなら `TRUSTED_NETWORKS=0.0.0.0/0`
 * (公開の注意は README)。
 *
 * **プレイヤーはリダイレクトを扱えない。** ログイン画面へ飛ばされたところで
 * 何もできず「再生できません」で終わる。だからファイルの口は、ログインではなく
 * **URL そのものが資格になる**署名リンクで開ける。
 */

/** 署名リンクとログインの控えで開けられる口。**ここは OIDC のリダイレクトにしない** */
const FILE_PATHS = [/^\/api\/recordings\/\d+\/file$/];

/**
 * 素通しにする口。
 *
 * - **ログインの入口。** 守ると入れなくなる (ログイン画面へ行くのにログインが要る)
 * - **`/logout`。** ここも素通し (ログアウトするのにログインを要求しない)
 * - **`/api/health`。** Kubernetes の `livenessProbe` が叩く。守ると**Pod が
 *   再起動を繰り返す** (掛ける範囲を選べるのをやめたときに実際に踏んだ —
 *   E2E のスタックが起動待ちで固まった)。出しているのは
 *   「生きているか・局が何件か・録画が何本か」だけ
 * - **`/manifest.webmanifest`。** ブラウザは**資格情報を付けずに**取りに行く
 *   ので (`<link rel="manifest">` に `crossorigin` を書かない限り)、守ると
 *   ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
 *   hooks より手前で返していて、そもそも掛かっていなかった。出しているのは
 *   アプリの名前とアイコンの場所だけ
 */
const OPEN_PATHS = [/^\/login(\/|$)/, /^\/logout$/, /^\/api\/health$/, /^\/manifest\.webmanifest$/];

export function isFilePath(pathname: string): boolean {
    return FILE_PATHS.some((pattern) => pattern.test(pathname));
}

export function isOpenPath(pathname: string): boolean {
    return OPEN_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * 入る道が1つでも設定してあるか。**無ければ全部断る** (fail-closed)。
 *
 * 分からない状態で開けておくより、閉まっていることが起動ログとエラーページから
 * はっきり分かるほうがいい。以前の「起動時にパスワードを自動生成して掛ける」は、
 * 掛かってはいるが**受け取り損ねると誰も入れない**うえ、その状態と区別が付かなかった。
 */
export function configured(): boolean {
    return oidcEnabled() || entries().length > 0;
}

/** 入る道が無いまま上がったときの案内。起動ログに1度だけ出す */
export function warnIfClosed(): void {
    if (configured()) return;
    console.warn(
        '[boot] 入る道が設定されていないため、すべてのアクセスを断ります。\n' +
            '       OIDC (docs/auth.md) か TRUSTED_NETWORKS (CIDR のカンマ区切り) を設定してください。\n' +
            '       すべて開けるなら TRUSTED_NETWORKS=0.0.0.0/0 (公開時の注意は README)',
    );
}

/** 入る道が無い相手への返事。理由が分からない 403 にしない */
export function denied(): Response {
    const text = configured()
        ? 'この口はログインか期限付きのリンクでしか開けません'
        : '入る道が設定されていません。OIDC か TRUSTED_NETWORKS を設定してください (docs/auth.md)';
    return new Response(text, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * ファイルの口を、**ログイン済みの画面に開けるか**。
 *
 * 録画をブラウザで観るようになったので、`<video>` がファイルの口を取りに来る。
 * OIDC で入った人が映像を出そうとした瞬間に断られないように、ログインの控えを
 * ここでも受ける。通る相手が増えるわけではない — 「この denpa に入れる人」のまま
 */
export function sessionMayRead(pathname: string, loggedIn: boolean): boolean {
    return loggedIn && oidcEnabled() && isFilePath(pathname);
}

/**
 * **何も聞かずに通す相手か。** 見るのは住所だけ (`TRUSTED_NETWORKS`、CIDR の
 * カンマ区切り)。
 *
 * **ここに当たると OIDC も掛かりません。** LAN のプレイヤー (テレビの VLC など)
 * に資格情報を入れずにファイルを取らせるのが狙いです。
 *
 * **どの名前で来たかは問いません。** 前段 (Traefik) は名前を届けるだけで、
 * 名前ごとに何かを分けてはいない。ここで名前まで見ると条件が二か所に散り、
 * 片方だけ直して食い違うほうが危ない。
 */
export function trusted(address: string): boolean {
    return entries().some((network) => inNetwork(address, network));
}

function entries(): string[] {
    return config.trustedNetworks
        .split(',')
        .map((raw) => raw.trim())
        .filter((raw) => raw !== '');
}

/**
 * 住所がそのネットワークの中か。IPv4 の CIDR (`10.10.0.0/16`) か、そのままの住所。
 * **IPv6 は書いたとおりに一致したときだけ**通す (前置き長での判定は入れていない)。
 */
export function inNetwork(address: string, entry: string): boolean {
    // ::ffff:10.0.0.1 のような書き方で届くことがある
    const target = address.replace(/^::ffff:/i, '');
    const [network, bits] = entry.split('/');
    const left = toIpv4(target);
    const right = toIpv4(network.replace(/^::ffff:/i, ''));
    if (left === null || right === null) return target === network;

    const length = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(length) || length < 0 || length > 32) return false;
    if (length === 0) return true;
    // >>> で符号なしに戻す。32bit シフトは 0 シフトになるので上で外してある
    const mask = (0xffffffff << (32 - length)) >>> 0;
    return (left & mask) >>> 0 === (right & mask) >>> 0;
}

function toIpv4(value: string): number | null {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        out = ((out << 8) | byte) >>> 0;
    }
    return out;
}

/** OIDC でログインを求める口か */
export function needsLogin(pathname: string): boolean {
    if (!oidcEnabled()) return false;
    if (isOpenPath(pathname)) return false;
    return !isFilePath(pathname);
}
