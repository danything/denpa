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
 * 自分の origin を1つに固定できない (SvelteKit の `paths.origin`。組むときに決まる)
 * ため、ここが効く (名前は charts/denpa/values.yaml の ingress.hosts)。
 */

import { networks, resolveClient, unreadable } from './src/lib/server/address.ts';

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
 * 無いと adapter-node が http と決め打ち、前段 (リバースプロキシ) が https を受ける構成
 * で CSRF 判定が食い違って POST が全部 403 になる。偽装されても得るものが無い —
 * ブラウザ経由の CSRF ではこのヘッダを付けられないし、直に付けて来る相手が
 * 変えられるのは自分に返る origin の見た目だけ。`TRUSTED_PROXIES` の前段からだけ読む
 * ようにはしない — 守れるものが無いのに、前段を設定し忘れた構成の POST を全部止める。
 *
 * **接続元の住所はこの中継が決める** (TRUSTED_NETWORKS の判定材料。`src/lib/server/address.ts`)。
 * 内側の adapter-node から見える相手は常にこの中継 (127.0.0.1) なので、ここで決めた住所を
 * `x-denpa-remote` に**上書きで**入れ (外から同名で付けて来ても消える)、adapter-node には
 * 必ずそれを読ませる。
 *
 * - 直の相手が `TRUSTED_PROXIES` (前段の CIDR のカンマ区切り) の中なら、`X-Forwarded-For` を
 *   右から辿って前段でない最初の住所を接続元にする (nginx の `real_ip_recursive` と同じ)
 * - そうでなければ相手そのもの。`X-Forwarded-For` は誰でも付けられるので読まない
 *
 * 以前は `ADDRESS_HEADER=x-forwarded-for` を渡すと adapter-node が誰から来たヘッダでも
 * 信じていた — :3000 へ直に届く経路があると、ヘッダを付けるだけで信頼ネットワークを
 * 名乗れた。**`ADDRESS_HEADER` はもう読まない** (互換の道は残さない。README の
 * 「公開するときの注意」)。設定してあれば起動時に1行だけ知らせる
 */
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
const REMOTE_HEADER = 'x-denpa-remote';
if (process.env.ADDRESS_HEADER && process.env.ADDRESS_HEADER !== REMOTE_HEADER) {
    console.warn(
        `ADDRESS_HEADER=${process.env.ADDRESS_HEADER} はもう読みません。前段 (リバースプロキシ) の後ろに居るなら ` +
            'TRUSTED_PROXIES に前段の住所 (CIDR) を設定してください。設定するまで、前段越しの接続元は前段の住所になります',
    );
}
process.env.ADDRESS_HEADER = REMOTE_HEADER;
const proxies = networks(process.env.TRUSTED_PROXIES ?? '');
// 書き損じは当たらないだけなので、気づけるように知らせる
for (const entry of unreadable(proxies)) {
    console.warn(`TRUSTED_PROXIES の「${entry}」は読めないので無視します`);
}
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
         * (公開しているところは前段のリバースプロキシが居る)。
         */
        const headers = new Headers(request.headers);
        // **消すだけでは効かない。** `fetch` は無ければ自分で付け直すので、
        // 「圧縮しないでくれ」と明示する
        headers.set('accept-encoding', 'identity');
        /*
         * **前段が居なければ、受けた接続のスキームを `x-forwarded-proto` に入れる。**
         * adapter-node はこのヘッダが無いと自分を https と決め打つ。`http://<IP>:3000` に
         * 直に繋ぐと、ブラウザの Origin (http) と食い違って POST が全部 CSRF の 403 になり、
         * ライブの札 (POST) も取れず「繋がりませんでした」になっていた (#437)。
         * 前段が付けてきた値はそのまま使う
         */
        if (!headers.has('x-forwarded-proto')) {
            headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
        }
        // 本当の接続元 (上の説明)
        headers.set(
            REMOTE_HEADER,
            resolveClient(
                server.requestIP(request)?.address ?? '',
                request.headers.get('x-forwarded-for'),
                proxies,
            ),
        );

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
