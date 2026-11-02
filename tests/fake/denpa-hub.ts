import { idTokenFor, sealForDenpa } from "./niconico-seal";

/**
 * 偽の denpa-hub (ニコニコの OAuth の中継)。
 *
 * denpa のニコニコとの連携を通しで試すためだけのもの。使うのは hub の公開の約束 (denpa-hub の docs/niconico.md) だけで、
 * ニコニコそのものの値は何も持たない。
 *
 * - `GET /niconico/authorize`: **人は出てこない。** その場で偽のトークンの応答を denpa の鍵に宛てて封じ、`<return>#result=` へ 303。
 *   `/__control/mode` で `deny` にすると `#error=access_denied` を返す (ニコニコで断った)
 * - `POST /niconico/token`: 更新。更新に使うトークンは毎回替わり、古いものは `invalid_grant`
 */
const PORT = Number(process.env["FAKE_HUB_PORT"] ?? 8100);
/** 偽のニコニコのユーザー ID */
const USER = "12345678";

let mode: "ok" | "deny" = "ok";
let serial = 0;
/** いま使える更新用のトークン */
const refreshTokens = new Set<string>();

function tokens(): Record<string, unknown> {
  serial++;
  const refresh = `fake-refresh-${serial}`;
  refreshTokens.add(refresh);
  return {
    access_token: `fake-access-${serial}`,
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
  async fetch(request) {
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
    if (url.pathname === "/__control/mode" && request.method === "POST") {
      mode = (await request.text()) === "deny" ? "deny" : "ok";
      return json({ mode });
    }
    if (url.pathname === "/__control/state") return json({ mode, serial });
    return new Response("not found", { status: 404 });
  },
});
