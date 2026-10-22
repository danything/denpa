import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { compress, encodingFor, MIN_SIZE } from "./compress";

const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "content-type": "application/json", ...headers },
  });
const ask = (encoding: string, method = "GET") =>
  new Request("http://denpa.test/guide/__data.json", {
    method,
    headers: { "accept-encoding": encoding },
  });
const big = JSON.stringify({
  programs: Array.from({ length: 200 }, (_, i) => ({
    id: i,
    name: `番組 ${i}`,
  })),
});

describe("受け取れる縮め方", () => {
  test("br を先に選び、無ければ gzip", () => {
    expect(encodingFor("gzip, deflate, br, zstd")).toBe("br");
    expect(encodingFor("gzip, deflate")).toBe("gzip");
    expect(encodingFor("identity")).toBeNull();
    expect(encodingFor(null)).toBeNull();
  });
  test("q=0 は断り", () => {
    expect(encodingFor("br;q=0, gzip")).toBe("gzip");
    expect(encodingFor("br; q=0.0, gzip;q=0")).toBeNull();
  });
});

describe("縮めて返す", () => {
  test("JSON を br / gzip で縮め、伸ばせば元に戻る", async () => {
    const br = compress(ask("br"), json(big));
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toContain("Accept-Encoding");
    const brBytes = new Uint8Array(await br.arrayBuffer());
    expect(brBytes.length).toBeLessThan(big.length / 3);
    expect(brotliDecompressSync(brBytes).toString()).toBe(big);

    const gz = compress(
      ask("gzip"),
      json(big, { "content-length": String(Buffer.byteLength(big)) }),
    );
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    // 縮めたあとの長さは分からない (流して返す)
    expect(gz.headers.get("content-length")).toBeNull();
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(
      big,
    );
  });

  test("縮めないもの", () => {
    const same = (request: Request, response: Response) =>
      expect(compress(request, response)).toBe(response);
    // 通知 (1 件ずつ届くことが大事)・映像
    same(
      ask("br"),
      new Response(big, { headers: { "content-type": "text/event-stream" } }),
    );
    same(
      ask("br"),
      new Response(big, { headers: { "content-type": "video/mp4" } }),
    );
    // 小さいと分かっているもの
    same(ask("br"), json("{}", { "content-length": String(MIN_SIZE - 1) }));
    // もう縮めてあるもの・縮めるなと言われたもの
    same(ask("br"), json(big, { "content-encoding": "gzip" }));
    same(ask("br"), json(big, { "cache-control": "no-store, no-transform" }));
    // 200 以外・HEAD・受け取れない相手
    same(
      ask("br"),
      new Response(big, {
        status: 206,
        headers: { "content-type": "application/json" },
      }),
    );
    same(ask("br", "HEAD"), json(big));
    same(ask("identity"), json(big));
  });

  /**
   * **流して返す応答は、届いた塊ごとに出す。** SvelteKit は load の promise を後から流す。
   * 縮める側が溜めると、先に出せたはずの頭まで最後まで届かない
   */
  for (const encoding of ["br", "gzip"] as const) {
    test(`流して返す応答は、続きを待たずに頭が届く (${encoding})`, async () => {
      let finish = (): void => {};
      const later = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const head = `${JSON.stringify({ type: "data", nodes: [big] })}\n`;
      const tail = `${JSON.stringify({ type: "chunk", id: 1, data: "あと" })}\n`;
      const source = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          await later;
          controller.enqueue(new TextEncoder().encode(tail));
          controller.close();
        },
      });
      const response = compress(
        ask(encoding),
        new Response(source, {
          headers: { "content-type": "text/sveltekit-data" },
        }),
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      // 終わりまで来ていない流れも、出し切ったところまでは伸ばせる (`finishFlush`)
      const inflate = (bytes: Uint8Array) => {
        if (bytes.length === 0) return "";
        return (
          encoding === "br"
            ? brotliDecompressSync(bytes, {
                finishFlush: constants.BROTLI_OPERATION_FLUSH,
              })
            : gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH })
        ).toString();
      };

      // 続きはまだ流れていないのに、頭は伸ばせるところまで届いている
      const got: Uint8Array[] = [];
      while (inflate(Buffer.concat(got)) !== head) {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        got.push(value as Uint8Array);
      }
      finish();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got.push(value);
      }
      expect(inflate(Buffer.concat(got))).toBe(head + tail);
    });
  }
});
