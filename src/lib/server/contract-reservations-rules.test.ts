import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { fakeAgentTls, fakeAgentUrl, trustFakeAgent } from "./fake-agent";

// 衛星チューナー 1 台のみの環境を模倣
const tuners = [{ types: ["BS", "CS"] }];
const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: () =>
    Response.json({
      tuners: tuners.map((tuner, index) => ({
        index,
        name: `T${index}`,
        types: tuner.types,
        disabled: false,
        rank: index,
        device: null,
        lnb: null,
        channel: null,
        users: [],
        pid: null,
      })),
    }),
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const testDir = mkdtempSync(join(tmpdir(), "denpa-contracts-res-"));
config.dbPath = join(testDir, "denpa.db");
config.dataDir = testDir;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const { orm } = await import("./db");
const {
  cardContracts,
  programs,
  reservations,
  rules: ruleTable,
  services,
} = await import("./schema");
const { reserve, recordAiring } = await import("./reservations");
const { programsOf } = await import("./guide");
const { applyRules } = await import("./rules");
const { resolveConflicts } = await import("./scheduler");
const { saveSettings } = await import("./settings");

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  orm().delete(reservations).run();
  orm().delete(programs).run();
  orm().delete(services).run();
  orm().delete(cardContracts).run();
  orm().delete(ruleTable).run();
});

describe("契約状態と予約作成 (reservations.ts)", () => {
  test("期限切れ局の有料番組を予約したとき、contract_warning: 'expired' を持つ", async () => {
    const serviceId = 101;
    orm()
      .insert(services)
      .values({
        id: serviceId,
        service_id: 101,
        network_id: 4,
        name: "有料CS局A",
        type: "CS",
        channel: "CS1",
        updated_at: 0,
      })
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: serviceId,
        state: "expired",
        checked_at: Date.now(),
      })
      .run();

    const progId = 1001;
    const nowMs = Date.now();
    orm()
      .insert(programs)
      .values({
        id: progId,
        service_id: serviceId,
        network_id: 4,
        event_id: 1,
        start_at: nowMs + 10_000,
        end_at: nowMs + 70_000,
        name: "有料アニメ 第1話",
        is_free: false,
        updated_at: 0,
      })
      .run();

    const res = await reserve(progId);
    expect(res.contract_warning).toBe("expired");
  });

  test("無料番組なら局が期限切れでも contract_warning は null", async () => {
    const serviceId = 101;
    orm()
      .insert(services)
      .values({
        id: serviceId,
        service_id: 101,
        network_id: 4,
        name: "有料CS局A",
        type: "CS",
        channel: "CS1",
        updated_at: 0,
      })
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: serviceId,
        state: "expired",
        checked_at: Date.now(),
      })
      .run();

    const progId = 1002;
    const nowMs = Date.now();
    orm()
      .insert(programs)
      .values({
        id: progId,
        service_id: serviceId,
        network_id: 4,
        event_id: 2,
        start_at: nowMs + 10_000,
        end_at: nowMs + 70_000,
        name: "無料お試しアニメ 第1話",
        is_free: true,
        updated_at: 0,
      })
      .run();

    const res = await reserve(progId);
    expect(res.contract_warning).toBeFalsy();
  });

  test("recordAiring でも contract_warning が返る", async () => {
    const serviceId = 102;
    orm()
      .insert(services)
      .values({
        id: serviceId,
        service_id: 102,
        network_id: 4,
        name: "未契約CS局B",
        type: "CS",
        channel: "CS2",
        updated_at: 0,
      })
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: serviceId,
        state: "unsubscribed",
        checked_at: Date.now(),
      })
      .run();

    const nowMs = Date.now();
    orm()
      .insert(programs)
      .values({
        id: 1003,
        service_id: serviceId,
        network_id: 4,
        event_id: 3,
        start_at: nowMs - 10_000,
        end_at: nowMs + 50_000,
        name: "放送中未契約番組",
        is_free: false,
        updated_at: 0,
      })
      .run();

    const res = await recordAiring(serviceId, nowMs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.contract_warning).toBe("unsubscribed");
    }
  });
});

describe("番組表での契約警告 (guide.ts)", () => {
  test("programsOf が有料・期限切れ番組に contract_warning: 'expired' を付与する", () => {
    const serviceId = 201;
    orm()
      .insert(services)
      .values({
        id: serviceId,
        service_id: 201,
        network_id: 4,
        name: "BS有料局",
        type: "BS",
        channel: "BS1",
        updated_at: 0,
      })
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: serviceId,
        state: "expired",
        checked_at: Date.now(),
      })
      .run();

    const nowMs = Date.now();
    orm()
      .insert(programs)
      .values([
        {
          id: 2001,
          service_id: serviceId,
          network_id: 4,
          event_id: 1,
          start_at: nowMs + 1000,
          end_at: nowMs + 3600_000,
          name: "有料番組",
          is_free: false,
          updated_at: 0,
        },
        {
          id: 2002,
          service_id: serviceId,
          network_id: 4,
          event_id: 2,
          start_at: nowMs + 3600_000,
          end_at: nowMs + 7200_000,
          name: "無料番組",
          is_free: true,
          updated_at: 0,
        },
      ])
      .run();

    const list = programsOf("BS", nowMs, nowMs + 8000_000);
    const paid = list.find((p) => p.id === 2001);
    const free = list.find((p) => p.id === 2002);

    expect(paid?.contract_warning).toBe("expired");
    expect(free?.contract_warning).toBeNull();
  });
});

describe("自動録画ルールの局優先度とチューナー競合解決 (rules.ts & scheduler.ts)", () => {
  test("同一番組が期限切れ局と契約中局で放送される場合、契約中局を優先して予約する", () => {
    const expiredService = 301;
    const subscribedService = 302;
    const nowMs = Date.now();

    orm()
      .insert(services)
      .values([
        {
          id: expiredService,
          service_id: 301,
          network_id: 4,
          name: "期限切れCS",
          type: "CS",
          channel: "CS1",
          updated_at: 0,
        },
        {
          id: subscribedService,
          service_id: 302,
          network_id: 4,
          name: "契約中BS",
          type: "BS",
          channel: "BS2",
          updated_at: 0,
        },
      ])
      .run();

    orm()
      .insert(cardContracts)
      .values([
        {
          card_id: "0000111122223333",
          service_id: expiredService,
          state: "expired",
          checked_at: nowMs,
        },
        {
          card_id: "0000111122223333",
          service_id: subscribedService,
          state: "subscribed",
          checked_at: nowMs,
        },
      ])
      .run();

    // 期限切れ局のほうが 30 分早く始まる
    orm()
      .insert(programs)
      .values([
        {
          id: 3001,
          service_id: expiredService,
          network_id: 4,
          event_id: 1,
          start_at: nowMs + 3600_000,
          end_at: nowMs + 5400_000,
          name: "深夜アニメ #1 「始まり」",
          description: "アニメの第1話です",
          is_free: false,
          updated_at: 0,
        },
        {
          id: 3002,
          service_id: subscribedService,
          network_id: 4,
          event_id: 2,
          start_at: nowMs + 5400_000,
          end_at: nowMs + 7200_000,
          name: "深夜アニメ #1 「始まり」",
          description: "アニメの第1話です",
          is_free: false,
          updated_at: 0,
        },
      ])
      .run();

    saveSettings({ freeOnly: false });

    // dedupe=true のルールを作成
    orm()
      .insert(ruleTable)
      .values({
        name: "深夜アニメ録画",
        keyword: "深夜アニメ",
        search_fields: "name",
        priority: 1,
        dedupe: true,
        skip_earlier: false,
        enabled: true,
        created_at: nowMs,
      })
      .run();

    const sync = applyRules();
    expect(sync.created).toBe(1);

    // 作成された予約が契約中の 3002 であることを確認
    const resList = orm().select().from(reservations).all();
    expect(resList).toHaveLength(1);
    expect(resList[0]?.program_id).toBe(3002);
    expect(resList[0]?.service_id).toBe(subscribedService);
  });

  test("同一番組が期限切れ局と無料局で放送される場合、無料局を優先して予約する", () => {
    const expiredService = 311;
    const freeService = 312;
    const nowMs = Date.now();

    orm()
      .insert(services)
      .values([
        {
          id: expiredService,
          service_id: 311,
          network_id: 4,
          name: "期限切れCS",
          type: "CS",
          channel: "CS1",
          updated_at: 0,
        },
        {
          id: freeService,
          service_id: 312,
          network_id: 4,
          name: "無料BS局",
          type: "BS",
          channel: "BS11",
          updated_at: 0,
        },
      ])
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: expiredService,
        state: "expired",
        checked_at: nowMs,
      })
      .run();

    // 期限切れ局のほうが早く始まる
    orm()
      .insert(programs)
      .values([
        {
          id: 3101,
          service_id: expiredService,
          network_id: 4,
          event_id: 1,
          start_at: nowMs + 1000_000,
          end_at: nowMs + 2000_000,
          name: "新作アニメ #1",
          description: "新作アニメ",
          is_free: false,
          updated_at: 0,
        },
        {
          id: 3102,
          service_id: freeService,
          network_id: 4,
          event_id: 2,
          start_at: nowMs + 2000_000,
          end_at: nowMs + 3000_000,
          name: "新作アニメ #1",
          description: "新作アニメ",
          is_free: true,
          updated_at: 0,
        },
      ])
      .run();

    saveSettings({ freeOnly: false });

    orm()
      .insert(ruleTable)
      .values({
        name: "新作アニメ録画",
        keyword: "新作アニメ",
        search_fields: "name",
        priority: 1,
        dedupe: true,
        skip_earlier: false,
        enabled: true,
        created_at: nowMs,
      })
      .run();

    const sync = applyRules();
    expect(sync.created).toBe(1);

    const resList = orm().select().from(reservations).all();
    expect(resList).toHaveLength(1);
    expect(resList[0]?.program_id).toBe(3102);
    expect(resList[0]?.service_id).toBe(freeService);
  });

  test("チューナー不足時に契約中/無料局を優先し、期限切れ局を競合 (conflict) に落とす", async () => {
    const expiredService = 401;
    const freeService = 402;
    const nowMs = Date.now();

    orm()
      .insert(services)
      .values([
        {
          id: expiredService,
          service_id: 401,
          network_id: 4,
          name: "期限切れ有料局",
          type: "CS",
          channel: "CS1",
          updated_at: 0,
        },
        {
          id: freeService,
          service_id: 402,
          network_id: 4,
          name: "無料BS局",
          type: "BS",
          channel: "BS2",
          updated_at: 0,
        },
      ])
      .run();

    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: expiredService,
        state: "expired",
        checked_at: nowMs,
      })
      .run();

    // 同一時間帯に重なる2つの番組
    orm()
      .insert(programs)
      .values([
        {
          id: 4001,
          service_id: expiredService,
          network_id: 4,
          event_id: 1,
          start_at: nowMs + 1000,
          end_at: nowMs + 3600_000,
          name: "期限切れ番組",
          is_free: false,
          updated_at: 0,
        },
        {
          id: 4002,
          service_id: freeService,
          network_id: 4,
          event_id: 2,
          start_at: nowMs + 1000,
          end_at: nowMs + 3600_000,
          name: "無料番組",
          is_free: true,
          updated_at: 0,
        },
      ])
      .run();

    // 2件とも予約を作成 (同じ優先度 1)
    orm()
      .insert(reservations)
      .values([
        {
          program_id: 4001,
          service_id: expiredService,
          name: "期限切れ番組",
          start_at: nowMs + 1000,
          end_at: nowMs + 3600_000,
          priority: 1,
          manual: false,
          state: "scheduled",
          created_at: nowMs,
          updated_at: nowMs,
        },
        {
          program_id: 4002,
          service_id: freeService,
          name: "無料番組",
          start_at: nowMs + 1000,
          end_at: nowMs + 3600_000,
          priority: 1,
          manual: false,
          state: "scheduled",
          created_at: nowMs,
          updated_at: nowMs,
        },
      ])
      .run();

    // チューナーは 1 台なので 1 件競合になる
    const { accepted, rejected } = await resolveConflicts();
    expect(accepted).toBe(1);
    expect(rejected).toBe(1);

    const resFree = orm()
      .select()
      .from(reservations)
      .where(eq(reservations.program_id, 4002))
      .get()!;
    const resExpired = orm()
      .select()
      .from(reservations)
      .where(eq(reservations.program_id, 4001))
      .get()!;

    expect(resFree.state).toBe("scheduled");
    expect(resExpired.state).toBe("conflict");
  });
});
