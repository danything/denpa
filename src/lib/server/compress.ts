/**
 * **画面の HTML とデータ (JSON) を縮めて返す。** 入口の `server.js` が adapter の応答に掛ける。
 *
 * 静的ファイル (`_app/immutable/*`) は組むときに br / gz を作ってある (`precompress`) が、
 * SvelteKit が組み立てる応答 (HTML・`__data.json`・`/api/*` の JSON) は素のまま出ていた。
 * 番組表の `__data.json` は 1 日・1 放送波で 300〜400KB あり、遠い回線ではそのまま待ち時間になる。
 * 前段 (リバースプロキシ) が縮める構成もあるが、直に繋ぐ構成 (`http://<IP>:3000`) もあるので
 * アプリで縮める (前段が縮め直すことは無い。もう `Content-Encoding` が付いている)。
 *
 * **流して返す応答は流れたまま縮める。** SvelteKit は load の promise を後から流す
 * (`__data.json` の 2 行目以降・HTML の末尾の `<script>`)。普通に縮めると、縮める側が
 * ある程度溜まるまで出さないので、流したはずの続きが最後までまとめて届く。
 * 受け取った塊ごとに出し切る (`Z_SYNC_FLUSH` / `BROTLI_OPERATION_FLUSH`)。
 *
 * 縮めないもの:
 *
 * - 縮める意味の無い型 (映像・画像・フォント…) と、`text/event-stream` (通知。1 件ずつ届くことが大事)
 * - 小さいもの (`MIN_SIZE` 未満と分かっているもの)
 * - もう縮めてあるもの (`Content-Encoding` 付き)、`Cache-Control: no-transform`
 * - 200 以外 (部分取得の 206 や、中身の無い 204・304)、HEAD
 *
 * **何も import しない** (`node:zlib` だけ)。`server.js` は SvelteKit のビルドの外にある素の JS で、
 * このファイルを直に読む — 本番のイメージにもこの1枚を置いてある (Dockerfile。`address.ts` と同じ)
 */
import { constants, createBrotliCompress, createGzip } from "node:zlib";

/**
 * 縮める型。文字のもの (JSON・HTML・JS・CSS・SVG…)。`text/event-stream` は入らない。
 * `text/sveltekit-data` は SvelteKit の `__data.json` (1 行に 1 つの JSON。後から流す分も同じ応答に続く)
 */
const COMPRESSIBLE =
  /^(?:text\/(?:html|css|javascript|plain|xml|csv|sveltekit-data)|application\/(?:json|javascript|xml|manifest\+json|ld\+json)|image\/svg\+xml)\s*(?:;|$)/i;

/** これより小さいと分かっている応答は縮めない (縮めても数百バイトしか減らず、頭の分だけ損) */
export const MIN_SIZE = 1024;

type Encoding = "br" | "gzip";

/** 相手が受け取れる縮め方。br を先に選ぶ (同じ速さで gzip より小さい)。`q=0` は断り */
export function encodingFor(accept: string | null): Encoding | null {
  const allowed = new Set<string>();
  for (const part of (accept ?? "").split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q !== undefined && Number(q.slice(2)) === 0) continue;
    allowed.add(name.trim());
  }
  if (allowed.has("br")) return "br";
  if (allowed.has("gzip")) return "gzip";
  return null;
}

/** 縮めて返す応答。縮めないものはそのまま返す (上の「縮めないもの」) */
export function compress(request: Request, response: Response): Response {
  if (
    request.method === "HEAD" ||
    response.status !== 200 ||
    response.body === null
  )
    return response;
  const headers = response.headers;
  if (headers.has("content-encoding")) return response;
  if (/\bno-transform\b/i.test(headers.get("cache-control") ?? ""))
    return response;
  if (!COMPRESSIBLE.test(headers.get("content-type") ?? "")) return response;
  const length = headers.get("content-length");
  if (length !== null && Number(length) < MIN_SIZE) return response;
  const encoding = encodingFor(request.headers.get("accept-encoding"));
  if (encoding === null) return response;

  /*
   * br の段は 4。ここは応答のたびに縮めるので、静的ファイル (組むときに 1 度だけ。最高段) ほど
   * 時間を掛けない。JSON なら 4 でも gzip の既定より小さく、速さは同じくらい
   */
  const zip =
    encoding === "br"
      ? createBrotliCompress({
          flush: constants.BROTLI_OPERATION_FLUSH,
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
        })
      : createGzip({ flush: constants.Z_SYNC_FLUSH });
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      zip.on("data", (chunk: Buffer) =>
        controller.enqueue(new Uint8Array(chunk)),
      );
      zip.on("end", () => controller.close());
      zip.on("error", (error) => controller.error(error));
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            zip.write(value);
          }
          zip.end();
        } catch (error) {
          zip.destroy(error as Error);
        }
      })();
    },
    cancel(reason) {
      void reader.cancel(reason);
      zip.destroy();
    },
  });

  const out = new Headers(headers);
  out.set("content-encoding", encoding);
  out.delete("content-length");
  out.append("vary", "Accept-Encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}
