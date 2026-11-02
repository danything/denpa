import type { ServerWebSocket } from "bun";

import { idTokenFor, sealForDenpa } from "./niconico-seal";

/**
 * 偽の denpa-hub (ニコニコの OAuth の中継) と、偽の視聴の WebSocket。
 *
 * denpa のニコニコとの連携と、公式の実況への書き込みを通しで試すためだけのもの。使うのは hub の公開の約束
 * (denpa-hub の docs/niconico.md) と、NX-Jikkyo と同じ形のやり取り (`src/lib/jikkyo/nx.ts`) だけで、ニコニコそのものの値は何も持たない。
 *
 * - `GET /niconico/authorize`: **人は出てこない。** その場で偽のトークンの応答を denpa の鍵に宛てて封じ、`<return>#result=` へ 303。
 *   `/__control/mode` で `deny` にすると `#error=access_denied` を返す (ニコニコで断った)
 * - `POST /niconico/token`: 更新。更新に使うトークンは毎回替わり、古いものは `invalid_grant`
 * - `POST /niconico/live/watch`: 出したアクセストークンなら、この偽物の視聴の WebSocket (`/__watch`) を返す。ほかは 401
 * - 視聴の WebSocket: `startWatching` に `seat` を返し、`postComment` を `posts` に貯めて `postCommentResult` を返す
 */
const PORT = Number(process.env["FAKE_HUB_PORT"] ?? 8100);
/** 偽のニコニコのユーザー ID */
const USER = "12345678";

let mode: "ok" | "deny" = "ok";
let serial = 0;
/** いま使える更新用のトークン */
const refreshTokens = new Set<string>();
/** 出したアクセストークン */
const accessTokens = new Set<string>();
/** 受けた書き込み (`postComment` の `data`) */
const posts: Record<string, unknown>[] = [];
/** 接続先を求められた回数 (局ごと) */
const watched: string[] = [];

function tokens(): Record<string, unknown> {
  serial++;
  const refresh = `fake-refresh-${serial}`;
  const access = `fake-access-${serial}`;
  refreshTokens.add(refresh);
  accessTokens.add(access);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
    id_token: idTokenFor(USER),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/niconico/authorize") {
      const back = url.searchParams.get("return");
      const key = url.searchParams.get("key");
      if (back === null || key === null)
        return new Response("return と key が要ります", { status: 400 });
      // 本物と同じく、組み直した形 (スキーム・ホスト・既定でないポート・パス) だけを使う
      const target = new URL(back);
      const normalized = `${target.origin}${target.pathname}`;
      if (mode === "deny")
        return Response.redirect(`${normalized}#error=access_denied`, 303);
      const sealed = await sealForDenpa(
        key,
        JSON.stringify(tokens()),
        normalized,
      );
      return Response.redirect(`${normalized}#result=${sealed}`, 303);
    }
    if (url.pathname === "/niconico/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const refresh = form.get("refresh_token") ?? "";
      if (form.get("grant_type") !== "refresh_token")
        return json({ error: "unsupported_grant_type" }, 400);
      if (!refreshTokens.delete(refresh))
        return json({ error: "invalid_grant" }, 400);
      return json(tokens());
    }
    if (url.pathname === "/niconico/live/watch" && request.method === "POST") {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer /,
        "",
      );
      if (!accessTokens.has(token))
        return json({ error: "invalid_token" }, 401);
      const form = new URLSearchParams(await request.text());
      const channel = form.get("channel") ?? "";
      if (form.get("user") !== USER)
        return json({ error: "invalid_request" }, 400);
      watched.push(channel);
      return json({
        url: `ws://127.0.0.1:${PORT}/__watch?channel=${channel}`,
      });
    }
    if (url.pathname === "/__watch") {
      if (server.upgrade(request)) return undefined;
      return new Response("upgrade が要ります", { status: 400 });
    }
    if (url.pathname === "/__control/mode" && request.method === "POST") {
      mode = (await request.text()) === "deny" ? "deny" : "ok";
      return json({ mode });
    }
    if (url.pathname === "/__control/state")
      return json({ mode, serial, posts, watched });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws: ServerWebSocket<unknown>, raw) {
      let message: { type?: string; data?: Record<string, unknown> };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.type === "startWatching") {
        ws.send(
          JSON.stringify({
            type: "seat",
            data: {
              keepIntervalSec: 30,
              vposBaseTime: new Date(Date.now() - 3_600_000).toISOString(),
            },
          }),
        );
        return;
      }
      if (message.type === "postComment" && message.data !== undefined) {
        posts.push(message.data);
        ws.send(JSON.stringify({ type: "postCommentResult", data: {} }));
      }
    },
  },
});
