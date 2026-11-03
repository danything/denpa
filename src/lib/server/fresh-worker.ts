/**
 * `service-worker.js` の応答に `Cache-Control: no-cache` を付ける。
 *
 * adapter-bun は名前に指紋の無い静的ファイルに `Cache-Control` を付けない。前段 (Cloudflare など) が
 * `.js` として持ち続けると、組み直しても古いサービスワーカーを配り続け、端末は「新しいものは無い」と
 * 判断する。静的ファイルは adapter が `Bun.serve` の `routes` で渡す (`fetch` を通らない) ので、
 * `/service-worker.js` の route だけを包む (`server.js`)。
 *
 * adapter が渡す route の形は、関数・`Response`・メソッドごとのオブジェクト (値は関数か `Response`)。
 * adapter-bun 1.0.0 の静的ファイルは `{ GET: 関数 }` だが、どの形でも `no-cache` が付くようにする。
 * ほかのファイルの route には触らない。
 */

type Handler = (...args: never[]) => unknown;

const HEADER = "cache-control";
const VALUE = "no-cache";

/** `no-cache` を付けた応答。ヘッダを変えられない応答 (`Response.redirect` など) は作り直す */
function noCache(response: Response): Response {
  try {
    response.headers.set(HEADER, VALUE);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(HEADER, VALUE);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** 関数の戻り値 (応答、または応答の Promise) に付ける */
function wrapHandler(handler: Handler): Handler {
  return (...args) => {
    const result = handler(...args);
    if (result instanceof Promise)
      return result.then((r) => (r instanceof Response ? noCache(r) : r));
    return result instanceof Response ? noCache(result) : result;
  };
}

/** 静的な `Response` は、呼ばれるたびに複製して付ける (本体は1回しか読めない) */
function wrapResponse(response: Response): Handler {
  return () => noCache(response.clone());
}

function wrapValue(value: unknown): unknown {
  if (typeof value === "function") return wrapHandler(value as Handler);
  if (value instanceof Response) return wrapResponse(value);
  return value;
}

function wrapRoute(route: unknown): unknown {
  if (typeof route === "function" || route instanceof Response)
    return wrapValue(route);
  if (typeof route !== "object" || route === null) return route;
  return Object.fromEntries(
    Object.entries(route).map(([method, value]) => [method, wrapValue(value)]),
  );
}

/** adapter の `routes` のうち、`service-worker.js` のものだけを包んで返す */
export function freshWorker<
  T extends Record<string, unknown> | null | undefined,
>(routes: T): T {
  if (routes === undefined || routes === null) return routes;
  return Object.fromEntries(
    Object.entries(routes).map(([path, route]) => [
      path,
      path.endsWith("/service-worker.js") ? wrapRoute(route) : route,
    ]),
  ) as T;
}
