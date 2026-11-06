import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { config } = await import("./config");
const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;

const testDir = mkdtempSync(join(tmpdir(), "denpa-scheduler-contracts-"));
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");
config.contractScanInterval = 12 * 60 * 60 * 1000;

const { orm } = await import("./db");
const { cardContracts, programs, services, webhooks } =
  await import("./schema");
const { toMjd } = await import("./contracts");
const { resetContractScanTimeForTest, scanContracts, tick } =
  await import("./scheduler");
const { fakeAgentUrl, ONE_CARD, serveFakeAgent } = await import("./fake-agent");

afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  orm().delete(cardContracts).run();
  orm().delete(programs).run();
  orm().delete(services).run();
  orm().delete(webhooks).run();
  resetContractScanTimeForTest(0);
});

describe("scanContracts: 有料放送契約の定期スキャンと期限切れ検知", () => {
  test("カード未認識時は空配列を返し、例外を投げない", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: false,
          message: "カードリーダーがありません",
          source: "local",
          readers: [],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await scanContracts();
      expect(res.scanned).toEqual([]);
      expect(res.expired).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("新たに期限切れとなった局を検知し、Webhook 通知を発行する", async () => {
    const receivedWebhooks: Record<string, unknown>[] = [];
    const webhookServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        receivedWebhooks.push(
          (await request.json()) as Record<string, unknown>,
        );
        return new Response("ok");
      },
    });

    orm()
      .insert(webhooks)
      .values({
        url: `${webhookServer.url.origin}/webhook`,
        events: ["contract.expired"],
        enabled: true,
        created_at: Date.now(),
      })
      .run();

    const nowMjd = toMjd();
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
      }
      if (url.pathname === "/denpa/card/confirm") {
        const body = (await req.json()) as { date: number };
        // 3 日前まで有効 (0x0800)、そのあとは無効 (0x0000) => 期限切れ
        // (今日まだ観られる局は、1 週間以内に切れても期限切れにしない)
        return Response.json({
          ok: true,
          code: body.date <= nowMjd - 3 ? 0x0800 : 0x0000,
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    // サービスと番組を登録
    orm()
      .insert(services)
      .values({
        id: 101,
        service_id: 101,
        network_id: 4,
        name: "プレミアム映画",
        type: "BS",
        channel: "BS01",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 201,
        service_id: 101,
        network_id: 4,
        event_id: 1,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "深夜シネマ",
        is_free: false,
        contract_verification: "AQIDBAU=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const result = await scanContracts();

      expect(result.scanned).toHaveLength(1);
      expect(result.scanned[0]?.state).toBe("expired");

      // 新たに期限切れとして検知される
      expect(result.expired).toHaveLength(1);
      expect(result.expired[0]?.serviceName).toBe("プレミアム映画");
      expect(result.expired[0]?.state).toBe("expired");

      // Webhook 送信を少し待機
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedWebhooks).toHaveLength(1);
      const wh = receivedWebhooks[0]!;
      expect(wh["event"]).toBe("contract.expired");
      const text = String(wh["text"]);
      expect(text).toContain("0000111122223333");
      expect(text).toContain("プレミアム映画");
      expect(text).toContain("期限切れ");
      expect(text).toContain(
        "視聴・録画を継続するには契約の更新を行ってください。",
      );
      expect(text).not.toContain("次期Kw");
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);

      // --- 2回目のスキャン: 状態が変わっていなければ再通知されない ---
      receivedWebhooks.length = 0;
      const secondResult = await scanContracts();

      expect(secondResult.scanned).toHaveLength(1);
      expect(secondResult.scanned[0]?.state).toBe("expired");
      // 直前も expired だったため、新たに期限切れとは判定されない
      expect(secondResult.expired).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedWebhooks).toHaveLength(0);
    } finally {
      server.stop();
      webhookServer.stop(true);
    }
  });

  test("契約中 (subscribed) の局は expired として検知されず、通知も送られない", async () => {
    const receivedWebhooks: Record<string, unknown>[] = [];
    const webhookServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        receivedWebhooks.push(
          (await request.json()) as Record<string, unknown>,
        );
        return new Response("ok");
      },
    });

    orm()
      .insert(webhooks)
      .values({
        url: `${webhookServer.url.origin}/webhook`,
        events: ["contract.expired"],
        enabled: true,
        created_at: Date.now(),
      })
      .run();

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
      }
      if (url.pathname === "/denpa/card/confirm") {
        // 今日も1週間後も有効
        return Response.json({ ok: true, code: 0x0800 });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 102,
        service_id: 102,
        network_id: 4,
        name: "スポーツ生中継",
        type: "BS",
        channel: "BS02",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 202,
        service_id: 102,
        network_id: 4,
        event_id: 2,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "野球中継",
        is_free: false,
        contract_verification: "AQIDBAU=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const result = await scanContracts();

      expect(result.scanned).toHaveLength(1);
      expect(result.scanned[0]?.state).toBe("subscribed");
      expect(result.expired).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedWebhooks).toHaveLength(0);
    } finally {
      server.stop();
      webhookServer.stop(true);
    }
  });

  test("契約更新で subscribed に戻った後、再度期限切れになった局は再通知される", async () => {
    let confirmCode = 0x0800; // 最初は subscribed
    const nowMjd = toMjd();

    const receivedWebhooks: Record<string, unknown>[] = [];
    const webhookServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        receivedWebhooks.push(
          (await request.json()) as Record<string, unknown>,
        );
        return new Response("ok");
      },
    });

    orm()
      .insert(webhooks)
      .values({
        url: `${webhookServer.url.origin}/webhook`,
        events: ["contract.expired"],
        enabled: true,
        created_at: Date.now(),
      })
      .run();

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
      }
      if (url.pathname === "/denpa/card/confirm") {
        const body = (await req.json()) as { date: number };
        if (confirmCode === 0x0800) {
          return Response.json({ ok: true, code: 0x0800 });
        }
        // 期限切れ: 3 日前まで有効だった
        return Response.json({
          ok: true,
          code: body.date <= nowMjd - 3 ? 0x0800 : 0x0000,
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 103,
        service_id: 103,
        network_id: 4,
        name: "ドキュメンタリー",
        type: "BS",
        channel: "BS03",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 203,
        service_id: 103,
        network_id: 4,
        event_id: 3,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "自然の神秘",
        is_free: false,
        contract_verification: "AQIDBAU=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);

      // 1. 最初は subscribed
      const r1 = await scanContracts();
      expect(r1.scanned[0]?.state).toBe("subscribed");
      expect(r1.expired).toHaveLength(0);

      // 2. 期限切れに変化
      confirmCode = 0x0000;
      const r2 = await scanContracts();
      expect(r2.scanned[0]?.state).toBe("expired");
      expect(r2.expired).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedWebhooks).toHaveLength(1);

      // 3. ユーザーが契約更新して subscribed に復活
      confirmCode = 0x0800;
      const r3 = await scanContracts();
      expect(r3.scanned[0]?.state).toBe("subscribed");
      expect(r3.expired).toHaveLength(0);

      // 4. その後再び期限切れに変化 => 再び検知・通知される
      confirmCode = 0x0000;
      receivedWebhooks.length = 0;
      const r4 = await scanContracts();
      expect(r4.scanned[0]?.state).toBe("expired");
      expect(r4.expired).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedWebhooks).toHaveLength(1);
    } finally {
      server.stop();
      webhookServer.stop(true);
    }
  });
});

describe("scheduler tick での定期実行", () => {
  test("contractScanInterval が経過したとき scanContracts がバックグラウンドで呼ばれる", async () => {
    let cardCalled = false;
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        cardCalled = true;
        return Response.json({
          ok: false,
          message: "テスト用",
          source: "local",
          readers: [],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);

      // lastContractScan = 0 の状態で tick を呼ぶと、間隔経過と判定されて scanContracts が呼ばれる
      resetContractScanTimeForTest(0);
      await tick();

      // 非同期呼び出しの完了を待機
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cardCalled).toBe(true);

      // 次の tick では間隔が経過していないため呼ばれない
      cardCalled = false;
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cardCalled).toBe(false);
    } finally {
      server.stop();
    }
  });
});
