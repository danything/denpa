/**
 * ホーム画面から開けるようにするための最小限のサービスワーカー
 * + オフライン視聴の受け取り係 ([docs/offline.md](../../docs/offline.md))。
 *
 * 録画一覧も番組表も**サーバの今の状態**が要るので、中身はキャッシュしない。
 * 古い一覧を見せるくらいなら、繋がらないと分かるほうがまし。
 * ここで持つのはアプリの殻(JS/CSS/アイコン)と、オフラインの入口 (`/offline`) だけ。
 *
 * オフライン視聴で足すのは **Background Fetch の受け取り**だけ — ブラウザに
 * 預けたダウンロードが終わったら IndexedDB へ移す。配信のキャッシュはしない。
 */

import { version } from "$app/env";
import { assets, immutable } from "$app/manifest";
import { asset, resolve } from "$app/paths";
import { self as worker } from "$app/service-worker";

import {
  type OfflineVideo,
  parseFetchId,
  storeResponse,
  videos,
} from "#lib/offline-db.js";

/*
 * **頭 (前段の接頭辞込み。server/paths.ts) は SvelteKit が自分の置き場から求める。**
 * Service Worker の中の `$app/paths` は `<接頭辞>/service-worker.js` の置き場を
 * base にするので、`resolve` / `asset` がそのまま接頭辞の下を指す
 */

const CACHE = `denpa-${version}`;
/** 殻だけ。ロゴやサムネイルのような「増えるもの」は入れない。パスは base からの相対で来る */
const SHELL = [
  // 組んだ JS/CSS はルートでも static でもないので型の付いた `resolve` に渡せない。頭だけ借りる
  ...immutable.map((file) => `${resolve("")}${file.path}`),
  ...assets
    .filter((file) => !file.path.endsWith("robots.txt"))
    .map((file) => asset(file.path)),
];
/**
 * オフラインの入口。電波の無いところで開いたとき、どの画面への行き先も
 * これで受ける (下の fetch)。**殻と違って HTML なので、バージョンが変わる**。
 * install のたびに取り直す
 */
const OFFLINE_PAGE = resolve("offline");
/**
 * 入口が始まるときに読むデータ (共通の枠の `+layout.server.ts`。ログインの控えなど)。
 * **入口は SSR を切った殻なので、開くたびにこれをサーバへ取りに行く** — 控えていなかった頃は
 * 電波が無いとここで転び、真っ白な画面になっていた。入口と一緒に控え、繋がらないときだけ出す
 */
const OFFLINE_DATA = `${OFFLINE_PAGE}/__data.json`;
/**
 * 音 (と MPEG-2) をデコードする WebAssembly (`routes/api/live/mpeg2`。`raw/worker.ts` が読む)。
 * **入口で保存した録画を canvas に描くとき要る** — iPhone の Safari は保存した Matroska を `<video>` で
 * 読めないので、入口は観る画面の互換モードと同じエンジンで描く (`offline/+page.svelte`)。
 * `/api/` は素通しなので、控えていなかった頃は電波が無いと「音声を再生できません」で止まっていた。
 * 中身はイメージごとに変わる (URL は同じ) ので、入口と同じく install のたびに取り直し、サーバ優先で出す
 */
const DECODER = ["decoder.mjs", "decoder.wasm"].map(
  (file) => `${resolve("")}api/live/mpeg2/${file}`,
);

/**
 * 画面と入口のデータをサーバへ取りに行く。**繋がらないと分かっていれば待たず、返事が来なければ見切る。**
 *
 * iPhone の Safari は機内モードで、取りに行ったものが失敗せずに返事待ちのまま止まることがあり、
 * 入口へ移れずにいつまでも読み込み中になっていた。電波の弱いところで繋がりかけのまま止まるのも同じ。
 * 端末が繋がっていないと言うなら取りに行かず、10秒返事が無ければ繋がらないものとして扱う
 * (ふだんの画面は Celeron でも数秒で返る)。
 *
 * **見切ったら、しばらく (30秒) は取りに行かない。** 開いた画面 → 入口へ移る → 入口のデータ、と
 * 続けて取りに行くので、毎回待つと 10秒 × 3 待たせていた
 */
const NETWORK_WAIT = 10_000;
const GIVE_UP_FOR = 30_000;
let unreachableUntil = 0;
function fromNetwork(request: Request): Promise<Response> {
  if (!worker.navigator.onLine || Date.now() < unreachableUntil)
    return Promise.reject(new Error("繋がっていません"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unreachableUntil = Date.now() + GIVE_UP_FOR;
      reject(new Error("返事がありません"));
    }, NETWORK_WAIT);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      // 入口は無くても殻は使える。デプロイした直後などで取れなくても諦める
      await cache.add(OFFLINE_PAGE).catch(() => {});
      await cache.add(OFFLINE_DATA).catch(() => {});
      // 組んでいない denpa もある (無ければ 404)。入口で描けないだけなので諦める
      await Promise.all(DECODER.map((url) => cache.add(url).catch(() => {})));
    }),
  );
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  // バージョンが変われば古い殻は用済み
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // デコーダはサーバ優先、繋がらなければ控え (`DECODER`)
  if (DECODER.includes(url.pathname)) {
    event.respondWith(
      fromNetwork(request).catch(
        async () =>
          (await caches.match(url.pathname, { ignoreVary: true })) ??
          Response.error(),
      ),
    );
    return;
  }
  /*
   * ほかの API は素通しする。録画の配信は数十GB、通知は繋ぎっぱなしの SSE で、
   * どちらもキャッシュに載せると壊れる
   */
  if (url.pathname.startsWith(`${resolve("")}api/`)) return;

  /*
   * 画面への移動は**サーバ優先、繋がらなければオフラインの入口**。
   * 一覧や番組表を古いまま見せない方針はそのままに、電波の無いところでは
   * 真っ白なエラーではなく、落としてある録画の一覧に落ちる
   */
  if (request.mode === "navigate") {
    event.respondWith(
      fromNetwork(request).catch(async () => {
        const page = await caches.match(OFFLINE_PAGE);
        if (page === undefined) return Response.error();
        /*
         * **入口へ移す** (その場で入口の HTML を返さない)。殻は開いた URL の画面として
         * 始まるので、`/` のまま返すと一覧の画面を組もうとしてデータを取りに行き、転んでいた
         */
        if (url.pathname !== OFFLINE_PAGE)
          return Response.redirect(new URL(OFFLINE_PAGE, location.origin));
        return page;
      }),
    );
    return;
  }

  // 入口のデータはサーバ優先 (ログインの控えが変わる)。繋がらなければ控え
  if (url.pathname === OFFLINE_DATA) {
    event.respondWith(
      fromNetwork(request).catch(
        async () =>
          (await caches.match(OFFLINE_DATA, { ignoreSearch: true })) ??
          Response.error(),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      // 殻はキャッシュから。それ以外は毎回サーバに聞く
      return hit ?? fetch(request);
    }),
  );
});

/* ---------- オフライン視聴: Background Fetch の受け取り ---------- */

/** 画面へ「変わったよ」と伝える。開いていなければ何も起きない (次に開いたとき読む) */
async function tellClients(message: unknown): Promise<void> {
  for (const client of await worker.clients.matchAll())
    client.postMessage(message);
}

/**
 * 通知の宛先の控え。**画面側の控えが無い (先に消された) か、別の試み
 * (やり直したあとに届いた前回の残骸) なら null** — やり直しの控えを
 * 前回の残骸の通知が上書きしないように、印を照合する
 */
async function heldFor(
  event: BackgroundFetchEvent,
): Promise<OfflineVideo | null> {
  const parsed = parseFetchId(event.registration.id);
  if (parsed === null) return null;
  const held = await videos.get(parsed.id);
  if (held === undefined || (held.attempt ?? "") !== parsed.attempt)
    return null;
  return held;
}

/** 失敗として残す (あとでやり直せる) */
async function markFailed(held: OfflineVideo): Promise<void> {
  held.state = "failed";
  await videos.put(held);
  await tellClients({ type: "offline-failed", id: held.id });
}

/**
 * ブラウザが運び終えた。**結果を IndexedDB へ移して初めて「保存済み」になる。**
 * 動画以外の付き添いは無い録画もある (404)。取れたぶんだけ持つ
 */
worker.addEventListener("backgroundfetchsuccess", (event) => {
  event.waitUntil(
    (async () => {
      const held = await heldFor(event);
      if (held === null) return;

      for (const record of await event.registration.matchAll()) {
        // 1つ読めなくても他は仕舞う。動画さえあれば観られる (下の確認)
        try {
          const response = await record.responseReady.catch(() => null);
          if (response === null || !response.ok) continue;
          await storeResponse(held, record.request.url, response);
        } catch {
          // その1つを諦める
        }
      }

      // 肝心の動画が無いなら保存とは言えない
      if (held.video === undefined) return markFailed(held);
      held.state = "ready";
      held.downloadedAt = Date.now();
      await videos.put(held);
      await event.updateUI?.({ title: `保存しました: ${held.name}` });
      await tellClients({ type: "offline-saved", id: held.id });
    })(),
  );
});

/**
 * 失敗と取り消しは同じ扱い — 途中まで運んだものは使えない。
 * **控えは消さずに「失敗」として残す。** ネットが遅くて途中で切れたとき、
 * 消してしまうと開き直したときに何も残らず「無かったことになった」ように
 * 見えていた。残った行から、そのままやり直せる
 */
function drop(event: BackgroundFetchEvent): void {
  event.waitUntil(
    heldFor(event).then((held) =>
      held === null ? undefined : markFailed(held),
    ),
  );
}
worker.addEventListener("backgroundfetchfail", drop);
worker.addEventListener("backgroundfetchabort", drop);

/** ブラウザのダウンロード表示を押したら、保存済みの一覧を開く */
worker.addEventListener("backgroundfetchclick", (event) => {
  event.waitUntil(worker.clients.openWindow(OFFLINE_PAGE));
});
