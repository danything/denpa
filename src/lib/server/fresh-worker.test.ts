import { describe, expect, test } from "bun:test";

import { freshWorker } from "./fresh-worker";

const PATH = "/service-worker.js";

/** adapter-bun 1.0.0 の静的ファイルと同じ形 (`routes-util.js` の `file_route`) */
const adapterShape = () => ({
  GET: () =>
    new Response("worker", { headers: { "content-type": "text/javascript" } }),
});

/** route を包み、`GET` (関数そのものの route ならそれ) を呼んで `Cache-Control` を返す */
async function cacheControl(route: unknown): Promise<string | null> {
  const wrapped = freshWorker({ [PATH]: route })[PATH];
  const handler =
    typeof wrapped === "function"
      ? (wrapped as () => unknown)
      : (wrapped as { GET: () => unknown }).GET;
  return ((await handler()) as Response).headers.get("cache-control");
}

describe("freshWorker", () => {
  test("adapter の形 ({ GET: 関数 }) に付く", async () => {
    expect(await cacheControl(adapterShape())).toBe("no-cache");
  });

  test("304 の応答にも付く", async () => {
    const route = { GET: () => new Response(null, { status: 304 }) };
    expect(await cacheControl(route)).toBe("no-cache");
  });

  test("Promise を返す関数に付く", async () => {
    const route = { GET: async () => new Response("x") };
    expect(await cacheControl(route)).toBe("no-cache");
  });

  test("関数そのものの route に付く", async () => {
    expect(await cacheControl(() => new Response("x"))).toBe("no-cache");
  });

  test("静的な Response に付き、何度呼んでも本体を読める", async () => {
    const routes = freshWorker({ [PATH]: new Response("x") });
    const wrapped = routes[PATH] as unknown as () => Response;
    for (let i = 0; i < 2; i++) {
      const response = wrapped();
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe("x");
    }
  });

  test("メソッドの値が静的な Response でも付く", async () => {
    expect(await cacheControl({ GET: new Response("x") })).toBe("no-cache");
  });

  test("ヘッダを変えられない応答 (Response.redirect) にも付く", async () => {
    const route = { GET: () => Response.redirect("http://localhost/", 302) };
    expect(await cacheControl(route)).toBe("no-cache");
  });

  test("service-worker.js 以外の route には触らない", () => {
    const other = { GET: () => new Response("x") };
    const worker = adapterShape();
    const routes = freshWorker({ "/robots.txt": other, [PATH]: worker });
    expect(routes["/robots.txt"]).toBe(other);
  });

  test("接頭辞の下の service-worker.js も包む", async () => {
    const path = "/denpa/service-worker.js";
    const wrapped = freshWorker({ [path]: adapterShape() })[path];
    const response = wrapped.GET() as Response;
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("routes が無ければそのまま返す", () => {
    expect(freshWorker(undefined)).toBeUndefined();
  });
});
