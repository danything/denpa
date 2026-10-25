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

const { failure, hostOf, send, webhookUrl } = await import("./webhook");
const { now, orm } = await import("./db");
const { webhooks } = await import("./schema");

let redirectedHits = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/ok") return new Response("ok");
    if (pathname === "/error")
      return new Response("内側のサービスの中身", { status: 500 });
    if (pathname === "/redirect")
      return Response.redirect(`${server.url.origin}/inside`, 307);
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
