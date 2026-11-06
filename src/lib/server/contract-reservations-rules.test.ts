import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAgentTls, fakeAgentUrl, trustFakeAgent } from "./fake-agent";

/*
 * 自動予約は、有料の番組を契約中と確かめた局のものだけ録る (contracts.paidAllowed・rules.PaidAllowed)。
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
          pid: null,
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

/** CS の局と、そこで 1 時間後から流れる有料の番組 (「有料ドラマ #1」) */
function paidAiring(serviceId: number): void {
  orm()
    .insert(services)
    .values({
      id: serviceId,
      service_id: serviceId,
      network_id: 4,
      name: `CS${serviceId}`,
      type: "CS",
      channel: `CS${serviceId}`,
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
      name: "有料ドラマ #1",
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
  test("契約中と確かめた局の有料番組だけ録る。未契約・期限切れ・確かめていない局は録らない", () => {
    paidAiring(301);
    paidAiring(302);
    paidAiring(303);
    paidAiring(304);
    contract(301, { code: 0x0800 });
    contract(302, { state: "expired", code: 0 });
    contract(303, { state: "unsubscribed", code: 0 });
    rule();

    applyRules();
    expect(reserved()).toEqual([301]);
  });

  test("確かめていない局も、契約中と確かめたら次に当て直したときに録る", () => {
    paidAiring(311);
    rule();
    expect(applyRules().created).toBe(0);

    contract(311, { code: 0x0800 });
    expect(applyRules().created).toBe(1);
    expect(reserved()).toEqual([311]);
  });
});
