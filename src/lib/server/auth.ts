import { config } from './config';
import { enabled as oidcEnabled } from './oidc';

/**
 * 誰を通すか。**どこでも通る道が2つと、口を限った道が2つ。**
 *
 * | 道 | 何者か |
 * | --- | --- |
 * | `TRUSTED_NETWORKS` | 信頼したネットワークから来た人。何も聞かずに通す |
 * | OIDC のログイン | 画面から入る人 (`docs/auth.md`) |
 * | 期限付きのリンク (`?token=`、share.ts) | プレイヤー・ダウンロード。**ファイルの口だけ** |
 * | 使い捨ての札 | ライブ視聴の WebSocket だけ (`tickets.ts`) |
 *
 * **どれも設定していなければ、全部断る** (`configured`)。以前はベーシック認証を
 * 起動時に自動で掛けていたが、廃止した — パスワードを使う場面 (プレイヤー登録・
 * ダウンロードURL) が全部期限付きのリンクに置き換わり、残っていたのは「画面に出して
 * 覚えさせるパスワード」だけだった。全部開けたいなら `TRUSTED_NETWORKS=0.0.0.0/0`
 * (公開の注意は README)。
 *
 * **プレイヤーはリダイレクトを扱えない。** ログイン画面へ飛ばされたところで
 * 何もできず「再生できません」で終わる。だからファイルの口は、ログインではなく
 * **URL そのものが資格になる**期限付きのリンクで開ける。
 */

/**
 * 期限付きのリンクとログインの控えで開けられる口。**ここは OIDC のリダイレクトにしない。**
 * `file` はファイルそのもの、`playlist` はそれを続きの位置から指す XSPF
 * (`playlist/[name]/+server.ts`)。どちらもプレイヤーが取りに来るので同じ扱い。
 * 尻の1段は番組名 (プレイヤーの見出し用、share/+server.ts)。読み捨てるので何が来ても
 * よいが、それより深くは通さない。**形はここ1つ** — share.ts の突き合わせも同じものを使う
 */
const FILE_PATH = /^\/api\/recordings\/(\d+)\/(?:file|playlist)(?:\/[^/]+)?$/;

/** ファイルの口なら、そのパスが指す録画ID。違えば null */
export function fileRecordingId(pathname: string): number | null {
    const m = FILE_PATH.exec(pathname);
    return m === null ? null : Number(m[1]);
}

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
    return fileRecordingId(pathname) !== null;
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
        ? 'このページは、ログインするか期限付きのリンクからでないと開けません'
        : 'ログイン方法が設定されていません。OIDC か TRUSTED_NETWORKS を設定してください (docs/auth.md)';
    return new Response(text, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * ファイルの口を、**ログイン済みの画面に開けるか**。
 *
 * 録画をブラウザで観るようになったので、`<video>` がファイルの口を取りに来る。
 * OIDC で入った人が映像を出そうとした瞬間に断られないように、ログインの控えを
 * ここでも受ける。通る相手が増えるわけではない — 「この denpa に入れる人」のまま
 */
export function sessionMayRead(loggedIn: boolean): boolean {
    // ファイルの口かどうかは呼ぶ側 (hooks) が振り分けてから来る
    return loggedIn && oidcEnabled();
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
export function clientAddress(event: { getClientAddress(): string }): string {
    try {
        return event.getClientAddress();
    } catch {
        return '';
    }
}

/**
 * 家の中 (LAN) の住所か。**私設・ループバック・リンクローカルだけ。**
 *
 * CGNAT (100.64.0.0/10) は入れない — Tailscale などの VPN で**外から**入ってくる
 * 住所で、細い回線の向こうに居ることが多い。
 */
const LAN = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16'];

export function onLan(address: string): boolean {
    const target = address.replace(/^::ffff:/i, '').toLowerCase();
    if (target === '::1') return true;
    // IPv6 の ULA (fc00::/7) とリンクローカル (fe80::/10)
    if (/^f[cd][0-9a-f]{2}:/.test(target) || /^fe[89ab][0-9a-f]:/.test(target)) return true;
    return LAN.some((network) => inNetwork(target, network));
}

/**
 * **焼かずに生の TS を送ってよい相手か** (docs/stream.md §5.5)。信頼したネットワークから
 * 来ていて、**しかも家の中の住所**のときだけ。
 *
 * 1局 15〜17 Mbit/s が中身によらずずっと流れるので、宅外へは出さない。
 * `TRUSTED_NETWORKS` だけで決めないのは、全部開ける書き方 (`0.0.0.0/0`) がありうるため —
 * それは「誰でも通す」であって「家の中に居る」ではない。住所が読めないとき (空) は生にしない
 */
export function mayStreamRaw(address: string): boolean {
    return trusted(address) && onLan(address);
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
    const [network = '', bits] = entry.split('/');
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

/** OIDC でログインを求めるか (素通しの口とファイルの口は呼ぶ側 (hooks) が先に振り分ける) */
export function needsLogin(): boolean {
    return oidcEnabled();
}
