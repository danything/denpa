import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * **通知先を足がかりに、別の所を覗かせない** ([webhook.ts](webhook.ts))。
 * 宛先のアドレスは縛らない (LAN の中の通知先がふつうにある) ので、リダイレクトを追わないこと・
 * 相手の本文を返さないこと・ログに URL を出さないことをここで固定する
 */

const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-webhook-")), "denpa.db");

const {
  DISCORD_CONTENT_LIMIT,
  discord,
  discordBody,
  failure,
  hostOf,
  send,
  webhookUrl,
} = await import("./webhook");
const { now, orm } = await import("./db");
const { webhooks } = await import("./schema");

let redirectedHits = 0;
let discordBodies: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/ok") return new Response("ok");
    if (pathname === "/error")
      return new Response("内側のサービスの中身", { status: 500 });
    if (pathname === "/redirect")
      return Response.redirect(`${server.url.origin}/inside`, 307);
    if (pathname.startsWith("/api/webhooks/")) return fakeDiscord(request);
    if (pathname === "/inside") {
      redirectedHits++;
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

function hook(path: string) {
  return orm()
    .insert(webhooks)
    .values({
      url: `${server.url.origin}${path}?token=secret`,
      events: [],
      enabled: true,
      created_at: now(),
    })
    .returning()
    .get();
}

const payload = { event: "recording.finished" as const, text: "テスト" };

describe("送る", () => {
  test("届けば ok", async () => {
    expect(await send(hook("/ok"), payload)).toBe("ok");
  });

  test("失敗はステータスコードだけ残し、相手の本文は返さない", async () => {
    const status = await send(hook("/error"), payload);
    expect(status).toBe("500");
    expect(status).not.toContain("中身");
  });

  test("リダイレクトは追わない", async () => {
    const status = await send(hook("/redirect"), payload);
    expect(status).toContain("307");
    expect(redirectedHits).toBe(0);
  });

  test("ログには URL ではなくホストだけを出す", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await send(hook("/error"), payload);
      const line = String(logged.mock.calls.at(-1)?.[0]);
      expect(line).toContain(server.url.host);
      expect(line).not.toContain("/error");
      expect(line).not.toContain("secret");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("理由とホスト", () => {
  test("例外の文は使わず、決まった言葉とエラーコードだけ", () => {
    const error = Object.assign(
      new Error("failed to fetch https://discord.com/api/webhooks/1/secret"),
      { code: "ECONNREFUSED" },
    );
    expect(failure(error)).toBe("繋がりませんでした (ECONNREFUSED)");
    expect(failure(new Error("https://example.com/secret"))).toBe(
      "繋がりませんでした",
    );
    expect(failure(new DOMException("timeout", "TimeoutError"))).toBe(
      "時間切れです",
    );
  });

  test("ホストだけを取り出す", () => {
    expect(hostOf("https://discord.com/api/webhooks/1/secret")).toBe(
      "discord.com",
    );
    expect(hostOf("http://192.168.1.10:8123/api/webhook/x")).toBe(
      "192.168.1.10:8123",
    );
  });

  test("通知先にできるのは http か https の URL", () => {
    expect(webhookUrl("https://discord.com/api/webhooks/1/x")).toBe(true);
    expect(webhookUrl("http://homeassistant.local:8123/api/webhook/x")).toBe(
      true,
    );
    expect(webhookUrl("http://")).toBe(false);
    expect(webhookUrl("file:///etc/passwd")).toBe(false);
    expect(webhookUrl("not-a-url")).toBe(false);
  });
});

/**
 * 偽の Discord。本物と同じく、`content` (か `embeds` など) が無ければ 400 と
 * `Cannot send an empty message` (50006)、`content` が 2000 字を超えれば 400 (50035) を返す
 */
async function fakeDiscord(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  discordBodies.push(body);
  const reject = (code: number, message: string) =>
    Response.json({ message, code }, { status: 400 });
  const content = body["content"];
  if (
    typeof content !== "string" &&
    !["embeds", "file", "poll", "components"].some((key) => key in body)
  )
    return reject(50006, "Cannot send an empty message");
  if (typeof content === "string" && content.length > 2000)
    return reject(50035, "Invalid Form Body");
  return new Response(null, { status: 204 });
}

/** discord.com 宛ての fetch を偽の Discord へ回す (パスはそのまま) */
async function viaFakeDiscord<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return real(
      url.hostname === "discord.com"
        ? `${server.url.origin}${url.pathname}${url.search}`
        : input,
      init,
    );
  }) as typeof fetch);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

function discordHook(url: string) {
  return orm()
    .insert(webhooks)
    .values({ url, events: [], enabled: true, created_at: now() })
    .returning()
    .get();
}

describe("Discord", () => {
  test("Discord の URL には content で送り、400 で断られない", async () => {
    discordBodies = [];
    const status = await viaFakeDiscord(() =>
      send(discordHook("https://discord.com/api/webhooks/1/secret"), payload),
    );
    expect(status).toBe("ok");
    expect(discordBodies).toEqual([
      { content: "テスト", allowed_mentions: { parse: [] } },
    ]);
  });

  test("偽の Discord は text だけの本文を 400 で断る (以前の送り方)", async () => {
    const res = await fetch(`${server.url.origin}/api/webhooks/1/secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sentAt: 0 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50006);
  });

  test("長い本文は上限に収まるよう切り詰める", async () => {
    discordBodies = [];
    const long = { ...payload, text: `${"録".repeat(2100)}🎬` };
    const status = await viaFakeDiscord(() =>
      send(discordHook("https://discord.com/api/webhooks/1/secret"), long),
    );
    expect(status).toBe("ok");
    const content = String(discordBodies[0]?.["content"]);
    expect(content.length).toBe(DISCORD_CONTENT_LIMIT);
    expect(content.endsWith("…")).toBe(true);
  });

  test("絵文字の途中では切らない", () => {
    const text = `${"a".repeat(DISCORD_CONTENT_LIMIT - 2)}🎬🎬`;
    const { content } = discordBody(text);
    expect(content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(content).toBe(`${"a".repeat(DISCORD_CONTENT_LIMIT - 2)}…`);
  });

  test("Discord の Webhook の URL を見分ける", () => {
    expect(discord("https://discord.com/api/webhooks/1/x")).toBe(true);
    expect(discord("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(discord("https://ptb.discord.com/api/v10/webhooks/1/x")).toBe(true);
    expect(discord("https://discord.com/api/webhooks/1/x?thread_id=2")).toBe(
      true,
    );
    // Slack 互換の口は text を読むので、ほかの通知先と同じ形で送る
    expect(discord("https://discord.com/api/webhooks/1/x/slack")).toBe(false);
    expect(discord("https://hooks.slack.com/services/T0/B0/x")).toBe(false);
    expect(discord("https://discord.com.example.net/api/webhooks/1/x")).toBe(
      false,
    );
    expect(discord("not-a-url")).toBe(false);
  });

  test("Discord 以外には今までどおりの形で送る", async () => {
    let received: Record<string, unknown> = {};
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        received = (await request.json()) as Record<string, unknown>;
        return new Response("ok");
      },
    });
    try {
      const status = await send(
        discordHook(`${other.url.origin}/services/T0/B0/x`),
        payload,
      );
      expect(status).toBe("ok");
      expect(received["text"]).toBe("テスト");
      expect(received["event"]).toBe("recording.finished");
      expect(received).not.toHaveProperty("content");
    } finally {
      other.stop(true);
    }
  });
});
