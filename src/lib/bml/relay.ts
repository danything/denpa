/**
 * **データ放送と Hybridcast の通信を、denpa の中継で送る** (`/api/bml/proxy` と `/api/bml/post`。
 * [docs/stream.md](../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * 中継は相手の返した符号をそのまま返すので、符号だけではこちらで断った 502 と相手の 502 を見分けられない。
 * 相手まで行けたかは `x-bml-relayed` で決める (`server/bml-network.ts` の `relayed`)
 */

import { resolve } from "$app/paths";

/** 送るもの。無ければ GET */
export interface RelayPost {
  contentType: string | null;
  body: BodyInit;
}

/** 中継の返り。`relayed` が false なら中継が断った (403/502) */
export interface Relayed {
  relayed: boolean;
  response: Response;
}

/** `url` を中継で取得する (`post` があれば POST で送る) */
export async function fetchRelayed(
  url: string,
  post?: RelayPost,
): Promise<Relayed> {
  const query = `url=${encodeURIComponent(url)}`;
  const response =
    post === undefined
      ? await fetch(resolve(`api/bml/proxy?${query}`))
      : await fetch(resolve(`api/bml/post?${query}`), {
          method: "POST",
          headers:
            post.contentType === null
              ? {}
              : { "content-type": post.contentType },
          body: post.body,
        });
  return {
    relayed: response.headers.get("x-bml-relayed") === "1",
    response,
  };
}
