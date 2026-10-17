/**
 * 本番の入口。**adapter-bun の `Bun.serve` に WebSocket を足すためだけにある。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を1本の接続に多重化する作りなので
 * ([docs/stream.md](docs/stream.md) §5.3)、`Request` → `Response` しか扱えない
 * SvelteKit の仕組みでは足りない。
 *
 * ## なぜ入口が要るのか
 *
 * 公式の `@sveltejs/adapter-bun` は `Bun.serve` を自分で呼ぶが、`websocket` を渡す口が無い
 * (`serverOptions` は JSON にして埋め込まれるので関数を持てない)。`platform.server` で
 * Bun の Server には触れても、`websocket` 無しに立てた Server は upgrade できない。
 * SvelteKit の手続き (handler) も静的ファイルの表 (routes) も `build/server/adapter-index.js`
 * に畳み込まれていて、外から import できる形では出てこない。
 *
 * そこで **`Bun.serve` を1回だけ包んでから `build/index.js` を読む。** adapter が渡す
 * 設定 (PORT・HOST・BODY_SIZE_LIMIT などの環境変数を読んだもの) はそのまま使い、
 * `websocket` を足して、`fetch` の前に WebSocket の握手と接続元の決定を挟む。
 * Bun の版の確認も環境変数の読み方も adapter のものがそのまま効く。
 * 頼っているのは「adapter の入口が `Bun.serve` を1回呼ぶ」ことだけ — 呼ばれなければ起動を止める。
 *
 * 以前は adapter-node を内側に置いて HTTP を中継していた (bun の `node:http` は WebSocket の
 * 握手ができないため)。その1ホップと `Accept-Encoding` の食い違いはもう無い。
 *
 * **止まれの合図 (SIGTERM) は adapter のものを使わない。** adapter は受けたその場で listen を
 * 閉じるので、録画が終わるまで居座る間に画面が開けなくなる。アプリ (`runtime.ts` の
 * `takeOverSignals`) が引き取る。adapter が合図を登録するのは `build/index.js` のいちばん最後なので、
 * 読み終えたあとでもう一度アプリに引き取らせる (下の `takeOver`)。
 *
 * **`Host` はそのまま扱う。** SvelteKit の CSRF 判定は自分の origin と `Origin` を比べる。
 * denpa は名前を2つ持っていて自分の origin を1つに固定できない (SvelteKit の `paths.origin`。
 * 組むときに決まる) ので、`Host` と `x-forwarded-proto` から毎回組み立てさせる
 * (名前は charts/denpa/values.yaml の httpRoute.hostnames。無ければ ingress.hosts)。
 */

import { networks, resolveClient, unreadable } from './src/lib/server/address.ts';

/** `src/lib/server/ws.ts` が置く名前 */
const LIVE = '__denpaLive';
/** `src/lib/server/runtime.ts` が置く名前 */
const TAKE_OVER = '__denpaTakeOverSignals';

/*
 * **スキームは常に `x-forwarded-proto` から読む** (選べるオプションにしない)。
 * adapter は読めないと https と決め打つので、http で受ける構成 (前段の無い直結など)
 * で CSRF 判定が食い違って POST が全部 403 になる (前段が無ければ下で入れる)。偽装されても得るものが無い —
 * ブラウザ経由の CSRF ではこのヘッダを付けられないし、直に付けて来る相手が
 * 変えられるのは自分に返る origin の見た目だけ。`TRUSTED_PROXIES` の前段からだけ読む
 * ようにはしない — 守れるものが無いのに、前段を設定し忘れた構成の POST を全部止める。
 *
 * **接続元の住所はこの入口が決める** (TRUSTED_NETWORKS の判定材料。`src/lib/server/address.ts`)。
 * ここで決めた住所を `x-denpa-remote` に**上書きで**入れ (外から同名で付けて来ても消える)、
 * adapter には必ずそれを読ませる。
 *
 * - 直の相手が `TRUSTED_PROXIES` (前段の CIDR のカンマ区切り) の中なら、`X-Forwarded-For` を
 *   右から辿って前段でない最初の住所を接続元にする (nginx の `real_ip_recursive` と同じ)
 * - そうでなければ相手そのもの。`X-Forwarded-For` は誰でも付けられるので読まない
 *
 * 以前は `ADDRESS_HEADER=x-forwarded-for` を渡すと adapter-node が誰から来たヘッダでも
 * 信じていた — :3000 へ直に届く経路があると、ヘッダを付けるだけで信頼ネットワークを
 * 名乗れた。**`ADDRESS_HEADER` はもう読まない** (互換の経路は残さない。docs/auth.md の
 * 「前段の後ろに置くとき」)。設定してあれば起動時に1行だけ知らせる
 */
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
const REMOTE_HEADER = 'x-denpa-remote';
if (process.env.ADDRESS_HEADER && process.env.ADDRESS_HEADER !== REMOTE_HEADER) {
    console.warn(
        `ADDRESS_HEADER=${process.env.ADDRESS_HEADER} はもう読みません。前段 (リバースプロキシ) の後ろにいるなら ` +
            'TRUSTED_PROXIES に前段の住所 (CIDR) を設定してください。設定するまで、前段越しの接続元は前段の住所になります',
    );
}
process.env.ADDRESS_HEADER = REMOTE_HEADER;
const proxies = networks(process.env.TRUSTED_PROXIES ?? '');
// 書き損じは当たらないだけなので、気づけるように知らせる
for (const entry of unreadable(proxies)) {
    console.warn(`TRUSTED_PROXIES の「${entry}」は読めないので無視します`);
}

const upgrading = (request) =>
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    request.headers.get('connection')?.toLowerCase().includes('upgrade') === true;

/** アプリが置いたもの。**毎回引き直す** — 読み込みが遅れることがある */
const live = () => globalThis[LIVE];

const websocket = {
    // **死んだ客を畳むための ping/pong を効かせる** (2026-08-14 フリーズの主因)。
    //
    // ライブ視聴の後片付けは `onclose → leave() → ffmpeg kill` に頼っている
    // (`live.ts`)。ところが serve 直下の `idleTimeout: 0` (vite.config.ts) を WebSocket も
    // 継ぐと、Bun の自動 ping が止まり、**正常な close を送らずに消えた客**
    // (モバイルのスリープ・Wi-Fi 断・タブの強制終了・クラッシュ) の close が
    // TCP が諦めるまで (既定で十数分〜永久に) 来ない。その間そのセッションの
    // ffmpeg は残り続け、ライブを繰り返すうちに ffmpeg が積み上がって
    // ノードの 46GB + swap を食い潰し、フリーズに至っていた。
    //
    // 映像はサーバ→客の一方向なので、この値は「客からの pong が途切れて
    // よい上限」。ブラウザは ping に自動で pong を返すため、**生きている客は
    // 映像が流れているだけで切れない**。返さなくなった客だけを畳む。
    // serve 直下は 0 のまま — 録画のファイルや SSE は別勘定。
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
        live()?.websocket.open(ws);
    },
    message(ws, message) {
        live()?.websocket.message(ws, message);
    },
    close(ws, code, reason) {
        live()?.websocket.close(ws, code, reason);
    },
};

/** adapter の `fetch` の前に挟む */
const front = (handler) => (request, server) => {
    const url = new URL(request.url);

    if (upgrading(request) && live()?.handles(url) === true) {
        /*
         * **断るのは握手の前。** ここなら普通の HTTP として理由を返せる。
         * 握手したあとに切ると、ブラウザには「繋がらない」としか映らない
         */
        if (!live().accept(url)) return new Response('ticket required', { status: 403 });
        const data = { url, connection: null };
        if (server.upgrade(request, { data })) return undefined;
        return new Response('upgrade failed', { status: 400 });
    }

    /*
     * **前段が無ければ、受けた接続のスキームを `x-forwarded-proto` に入れる。**
     * adapter はこのヘッダが無いと自分を https と決め打つ。`http://<IP>:3000` に
     * 直に繋ぐと、ブラウザの Origin (http) と食い違って POST が全部 CSRF の 403 になり、
     * ライブのチケット (POST) も取れず「繋がりませんでした」になっていた (#437)。
     * 前段が付けてきた値はそのまま使う
     */
    if (!request.headers.has('x-forwarded-proto')) {
        request.headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
    }
    // 本当の接続元 (上の説明)
    request.headers.set(
        REMOTE_HEADER,
        resolveClient(
            server.requestIP(request)?.address ?? '',
            request.headers.get('x-forwarded-for'),
            proxies,
        ),
    );
    return handler(request, server);
};

const serve = Bun.serve;
let served = false;
Bun.serve = (options) => {
    Bun.serve = serve;
    served = true;
    return serve({ ...options, fetch: front(options.fetch), websocket });
};
try {
    await import('./build/index.js');
} finally {
    Bun.serve = serve;
}
if (!served)
    throw new Error(
        'build/index.js が Bun.serve を呼びませんでした。adapter-bun の作りが変わっていないか確かめてください',
    );

/*
 * **止まれの合図をアプリにもう一度引き取らせる。** adapter は読み込みのいちばん最後で
 * 自分の後始末を登録する。それが残ると SIGTERM で listen が閉じ、録画が終わるまで居座る間に
 * 画面が開けなくなる (上の説明)。
 *
 * **adapter の作りが変わっても気付けるようにする。** ここは adapter の中の形に頼っているので、
 * 外れたら黙って居座りが壊れる。引き取り口が無い・引き取ったあとも合図に2人以上ついている、は
 * 起動を止める (E2E も本番と同じくこの入口で起こすので、CI で落ちる)。数が想定 (アプリの2件 +
 * adapter の2件) と違うだけなら知らせる。adapter があとから登録する作りに変わったときのために、
 * 少し置いてもう一度見て、ついていたら引き取り直して知らせる
 */
const SIGNALS = ['SIGTERM', 'SIGINT'];
const takeOver = globalThis[TAKE_OVER];
if (typeof takeOver !== 'function') {
    throw new Error('アプリが止まれの合図の引き取り口を置いていません (src/lib/server/runtime.ts)');
}
const taken = takeOver();
const extra = () => SIGNALS.filter((signal) => process.listenerCount(signal) !== 1);
if (extra().length > 0) {
    throw new Error(
        `止まれの合図を引き取れません (${extra().join('・')})。adapter-bun の作りが変わっていないか確かめてください`,
    );
}
if (taken !== 4) {
    console.warn(
        `[boot] 止まれの合図の数が想定 (4 件) と違います (${taken} 件)。adapter-bun の作りが変わっていないか確かめてください`,
    );
}
setTimeout(() => {
    const late = extra();
    if (late.length === 0) return;
    takeOver();
    console.warn(
        `[boot] 起動のあとで止まれの合図に後始末が足されていました (${late.join('・')})。引き取り直しました。adapter-bun の作りが変わっていないか確かめてください`,
    );
}, 1000).unref();
