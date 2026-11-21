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
 * - `/ranking/*`: 番組ランキング (denpa-hub の docs/ranking.md)。トークンを出し、送られた本文を `votes` に貯める。
 *   `/__control/ranking` で `off` にすると、本物の hub がランキングを受け付けていないときと同じく 404 を返す。
 *   `GET /ranking` は、そのトークンが送った放送のうち、これからのものをそのまま順位にし (どれも 10 票。始まりの早い順)、
 *   その下に受信できない局の番組 (`AWAY`) を足して返す。本物の 5 つのトークンの決まりは持たない
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
/** 番組ランキング。`off` は hub がランキングを受け付けていないとき (404) */
let ranking: "ok" | "off" = "ok";
/** 出したランキングのトークン (消したら外す) */
const rankingTokens = new Set<string>();
/** 受けたランキングの送信 (`POST /ranking/votes` の本文) と、消したトークンの数 */
const votes: unknown[] = [];
let revoked = 0;
let rankingSerial = 0;

interface FakeVote {
  network_id: number;
  service_id: number;
  event_id: number;
  start_at: string;
  duration: number;
  name: string;
  service_name: string;
}
/** トークンごとに、いま票を入れている放送 (`add` で足し、`remove` で外す) */
const ballots = new Map<string, Map<string, FakeVote>>();
/** 順位の下に足す、受信できない局の番組の数。先頭の 5 件と「もっと見る」を試せるだけ置く */
const AWAY = 6;

function rankingOf(token: string, limit: number): Record<string, unknown> {
  const mine = [...(ballots.get(token)?.values() ?? [])]
    .filter((vote) => Date.parse(vote.start_at) > Date.now())
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
    .map((vote) => ({
      votes: 10,
      name: vote.name,
      airings: [
        {
          network_id: vote.network_id,
          service_id: vote.service_id,
          event_id: vote.event_id,
          start_at: vote.start_at,
          end_at: new Date(
            Date.parse(vote.start_at) + vote.duration * 1000,
          ).toISOString(),
          service_name: vote.service_name,
          region: null,
        },
      ],
    }));
  const away = Array.from({ length: AWAY }, (_, i) => ({
    votes: 5,
    name: `よその局の番組 ${i + 1}`,
    airings: [
      {
        // 偽エージェントに無い BS の局 (`tests/fake/services.ts`)
        network_id: 4,
        service_id: 900 + i,
        event_id: 1 + i,
        start_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(),
        end_at: new Date(Date.now() + (i + 1.5) * 3_600_000).toISOString(),
        service_name: `BSよその局${i + 1}`,
        region: null,
      },
    ],
  }));
  return {
    v: 1,
    generated_at: new Date().toISOString(),
    entries: [...mine, ...away].slice(0, limit).map((entry, i) => ({
      rank: i + 1,
      genres: [],
      affiliation: null,
      ...entry,
    })),
  };
}

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
    if (url.pathname.startsWith("/ranking")) {
      if (ranking === "off") return json({ error: "not_found" }, 404);
      const bearer = (request.headers.get("authorization") ?? "").replace(
        /^Bearer /,
        "",
      );
      if (url.pathname === "/ranking/tokens" && request.method === "POST") {
        const token = `fake-ranking-${++rankingSerial}`.padEnd(43, "x");
        rankingTokens.add(token);
        return json({ token }, 201);
      }
      if (!rankingTokens.has(bearer))
        return json({ error: "invalid_token" }, 401);
      if (url.pathname === "/ranking/votes" && request.method === "POST") {
        const body = (await request.json()) as {
          add?: FakeVote[];
          remove?: FakeVote[];
        };
        votes.push(body);
        const mine = ballots.get(bearer) ?? new Map<string, FakeVote>();
        ballots.set(bearer, mine);
        const key = (v: FakeVote) =>
          `${v.network_id}:${v.service_id}:${v.event_id}`;
        for (const vote of body.add ?? []) mine.set(key(vote), vote);
        for (const vote of body.remove ?? []) mine.delete(key(vote));
        return json({ accepted: 0, rejected: 0 });
      }
      if (url.pathname === "/ranking" && request.method === "GET")
        return json(
          rankingOf(bearer, Number(url.searchParams.get("limit") ?? 50)),
        );
      if (
        url.pathname === "/ranking/tokens/self" &&
        request.method === "DELETE"
      ) {
        rankingTokens.delete(bearer);
        ballots.delete(bearer);
        revoked++;
        return new Response(null, { status: 204 });
      }
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/__control/ranking" && request.method === "POST") {
      ranking = (await request.text()) === "off" ? "off" : "ok";
      return json({ ranking });
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
      return json({
        mode,
        serial,
        posts,
        watched,
        ranking: { tokens: rankingTokens.size, votes, revoked },
      });
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
