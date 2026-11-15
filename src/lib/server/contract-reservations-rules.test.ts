import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";

/*
 * 自動予約は、有料の番組も契約を問わず録る (`rules.missOf` は契約を見ない)。
 * 衛星のチューナーが 1 台だけのエージェントで、ルールを当てて立った予約を見る
 */
const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: () =>
    Response.json({
      tuners: [
        {
          index: 0,
          name: "T0",
          types: ["BS", "CS"],
          disabled: false,
          rank: 0,
          device: null,
          lnb: null,
          channel: null,
          users: [],
        },
      ],
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
const { applyRules } = await import("./rules");

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

/** CS の局と、そこで 1 時間後から流れる有料の番組 (「有料ドラマ #<局>」。局ごとに別の番組) */
function paidAiring(serviceId: number): void {
  orm()
    .insert(services)
    .values({
      id: serviceId,
      service_id: serviceId,
      network_id: 4,
      name: `CS${serviceId}`,
      type: "CS",
      updated_at: 0,
    })
    .run();
  orm()
    .insert(programs)
    .values({
      id: serviceId * 100,
      service_id: serviceId,
      network_id: 4,
      event_id: 1,
      start_at: Date.now() + 3_600_000,
      end_at: Date.now() + 5_400_000,
      name: `有料ドラマ #${serviceId}`,
      description: "",
      is_free: false,
      updated_at: 0,
    })
    .run();
}

function contract(
  serviceId: number,
  fields: Partial<typeof cardContracts.$inferInsert>,
): void {
  orm()
    .insert(cardContracts)
    .values({
      card_id: "0000111122223333",
      service_id: serviceId,
      state: "subscribed",
      checked_at: Date.now(),
      ...fields,
    })
    .run();
}

function rule(): void {
  orm()
    .insert(ruleTable)
    .values({
      name: "有料ドラマ",
      keyword: "有料ドラマ",
      search_fields: "name",
      priority: 1,
      dedupe: false,
      skip_earlier: false,
      enabled: true,
      created_at: Date.now(),
    })
    .run();
}

const reserved = () =>
  orm()
    .select()
    .from(reservations)
    .all()
    .map((r) => r.service_id)
    .sort((a, b) => a - b);

describe("自動予約と有料放送の契約", () => {
  test("有料の番組は契約を問わず録る。契約中・期限切れ・未契約・確かめていない局のどれも", () => {
    paidAiring(301);
    paidAiring(302);
    paidAiring(303);
    paidAiring(304);
    contract(301, { code: 0x0800 });
    contract(302, { state: "expired", code: 0 });
    contract(303, { state: "unsubscribed", code: 0 });
    rule();

    applyRules();
    expect(reserved()).toEqual([301, 302, 303, 304]);
  });

  test("契約を確かめていない局の有料の番組も、最初の当てはめで録る", () => {
    paidAiring(311);
    rule();
    expect(applyRules().created).toBe(1);
    expect(reserved()).toEqual([311]);
  });
});
