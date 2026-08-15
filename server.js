/**
 * 本番の入口。**WebSocket を受けるためだけに前に立つ。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を1本の接続に多重化する作りなので
 * ([docs/stream.md](docs/stream.md) §5.3)、`Request` → `Response` しか扱えない
 * SvelteKit の口では足りない。
 *
 * ## なぜ間に挟まるのか
 *
 * **bun の `node:http` は WebSocket の握手ができない。** `upgrade` は上がるのに、
 * 渡される socket に書いても相手に1バイトも届かない (`write()` は true を返し、
 * コールバックも成功と言う)。adapter-node はその上に居るので、そのままでは通らない。
 *
 * `svelte-adapter-bun` に替える手も試したが、**今の SvelteKit では動かない** —
 * kit の生成物を正規表現で書き換えて `websocket` フックを挿し込む作りで、
 * `get_hooks` が別チャンクへ出るようになったため当たらなくなっている
 * (実測。`To enable websocket support, set the "websocket" object` で 500)。
 *
 * ## 取るのは WebSocket だけ
 *
 * それ以外は内側の adapter-node へそのまま流す。**録画の配信 (Range 要求) も
 * 認証も SSE も、Pod 入れ替え時に録画が終わるまで居座る仕掛けも、あちらに
 * 乗っている**ので、触らないのがいちばん安い。中継は同じマシンの中の1ホップで、
 * 1人で使うものなので実質ただ (Range・SSE・POST とも通ることは実測済み)。
 *
 * **`Host` はそのまま渡す。** 書き換わると SvelteKit の CSRF 判定が自分の
 * origin と食い違い、フォーム送信が全部弾かれる。denpa は名前を2つ持っていて
 * `ORIGIN` で固定できないため、ここが効く (charts/denpa/templates/denpa.yaml)。
 */

/** `src/lib/server/ws.ts` が置く名前 */
const LIVE = '__denpaLive';

const publicPort = Number(process.env.PORT ?? 3000);
const publicHost = process.env.HOST ?? '0.0.0.0';

/**
 * 内側の adapter-node が待つところ。**127.0.0.1 だけ**に開くので、
 * 外から見える口は増えない。
 */
const innerPort = Number(process.env.DENPA_INNER_PORT ?? publicPort + 1);

// 内側へ渡す前に書き換える。adapter-node は読み込みの時点で環境変数を見る
process.env.PORT = String(innerPort);
process.env.HOST = '127.0.0.1';
/*
 * **https の目印は常に `x-forwarded-proto` から読む** (選べるオプションにしない)。
 * 無いと adapter-node が http と決め打ち、前段が https を受ける構成 (Traefik 等)
 * で CSRF 判定が食い違って POST が全部 403 になる。偽装されても得るものが無い —
 * ブラウザ経由の CSRF ではこのヘッダを付けられないし、直に付けて来る相手が
 * 変えられるのは自分に返る origin の見た目だけ。
 * 接続元の住所 (`ADDRESS_HEADER`) は逆で、**信頼できる前段が居るときだけ**
 * 明示的に設定する — TRUSTED_NETWORKS の判定材料なので、既定で信じると
 * ヘッダを付けるだけで信頼ネットワークを名乗れてしまう
 */
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
await import('./build/index.js');
// こちらが公開する側なので、元に戻しておく (アプリが自分の口を見るとき用)
process.env.PORT = String(publicPort);
process.env.HOST = publicHost;

const inner = `http://127.0.0.1:${innerPort}`;

const upgrading = (request) =>
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    request.headers.get('connection')?.toLowerCase().includes('upgrade') === true;

/** アプリが置いたもの。**毎回引き直す** — 読み込みが遅れることがある */
const live = () => globalThis[LIVE];

Bun.serve({
    port: publicPort,
    hostname: publicHost,
    // 映像を流し続けるので、無反応で切られては困る
    idleTimeout: 0,
    fetch(request, server) {
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
         * **ヘッダはそのまま渡す。** `Host` も `Authorization` も `Range` も
         * `X-Forwarded-*` も、内側が見るものは全部あちらの流儀で解釈させる。
         *
         * **`Accept-Encoding` だけは外す。** ここの `fetch` は中継の途中で
         * 圧縮を勝手に展開するのに、`Content-Encoding: br` はそのまま透過する。
         * ブラウザは展開済みのものをもう一度 brotli として解こうとして失敗し、
         * **JS が1つも動かない** — 画面は SSR のぶんだけ出るのに、押しても
         * 何も起きない出方をする (E2E が50件落ちた)。
         *
         * 外しておけば内側は生で返すので、食い違いが起きない。無駄に
         * 圧縮して展開し直す往復も消える。**線の上での圧縮は前段に任せる**
         * (公開しているところは Traefik が居る)。
         */
        const headers = new Headers(request.headers);
        // **消すだけでは効かない。** `fetch` は無ければ自分で付け直すので、
        // 「圧縮しないでくれ」と明示する
        headers.set('accept-encoding', 'identity');

        return fetch(`${inner}${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual',
        });
    },
    websocket: {
        // **死んだ客を畳むための ping/pong を効かせる** (2026-08-14 フリーズの主因)。
        //
        // ライブ視聴の後片付けは `onclose → leave() → ffmpeg kill` に頼っている
        // (`live.ts`)。ところが上の serve 直下 `idleTimeout: 0` を WebSocket も
        // 継ぐと、Bun の自動 ping が止まり、**正常な close を送らずに消えた客**
        // (モバイルのスリープ・Wi-Fi 断・タブの強制終了・クラッシュ) の close が
        // TCP が諦めるまで (既定で十数分〜永久に) 来ない。その間そのセッションの
        // ffmpeg は残り続け、ライブを繰り返すうちに ffmpeg が積み上がって
        // ノードの 46GB + swap を食い潰し、フリーズに至っていた。
        //
        // 映像はサーバ→客の一方向なので、この値は「客からの pong が途切れて
        // よい上限」。ブラウザは ping に自動で pong を返すため、**生きている客は
        // 映像が流れているだけで切れない**。返さなくなった客だけを畳む。
        // serve 直下は 0 のまま — HTTP 中継 (録画のダウンロードや SSE) は別勘定。
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
    },
});

console.log(`Listening on http://${publicHost}:${publicPort} (内側 ${inner})`);
