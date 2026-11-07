import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { config } = await import("./config");
const realData = config.dataDir;
const realDb = config.dbPath;

const testDir = mkdtempSync(join(tmpdir(), "denpa-scan-test-"));
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");

const { orm } = await import("./db");
const { cardContracts, services } = await import("./schema");
const { buildScanQueue, getJstDateString, isWithinScanWindow } =
  await import("./contract-scan");

afterAll(() => {
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(testDir, { recursive: true, force: true });
});

describe("定期スキャンの時間・キュー判定 (contract-scan)", () => {
  test("isWithinScanWindow: JST 時間帯の範囲判定", () => {
    // 2026-11-07 03:30 JST = 2026-11-06 18:30 UTC
    const dateAt330 = new Date("2026-11-06T18:30:00Z").getTime();
    // 2026-11-07 02:30 JST = 2026-11-06 17:30 UTC
    const dateAt230 = new Date("2026-11-06T17:30:00Z").getTime();
    // 2026-11-07 06:30 JST = 2026-11-06 21:30 UTC
    const dateAt630 = new Date("2026-11-06T21:30:00Z").getTime();

    expect(isWithinScanWindow(dateAt330, "03:00", "06:00")).toBe(true);
    expect(isWithinScanWindow(dateAt230, "03:00", "06:00")).toBe(false);
    expect(isWithinScanWindow(dateAt630, "03:00", "06:00")).toBe(false);

    // 日をまたぐケース (23:00 〜 04:00)
    // 2026-11-06 23:30 JST = 14:30 UTC
    const dateAt2330 = new Date("2026-11-06T14:30:00Z").getTime();
    // 2026-11-07 05:00 JST = 20:00 UTC
    const dateAt0500 = new Date("2026-11-06T20:00:00Z").getTime();
    expect(isWithinScanWindow(dateAt2330, "23:00", "04:00")).toBe(true);
    expect(isWithinScanWindow(dateAt330, "23:00", "04:00")).toBe(true);
    expect(isWithinScanWindow(dateAt0500, "23:00", "04:00")).toBe(false);
  });

  test("getJstDateString: JST 日付の取得", () => {
    // 2026-11-06 16:00 UTC = 2026-11-07 01:00 JST
    const t = new Date("2026-11-06T16:00:00Z").getTime();
    expect(getJstDateString(t)).toBe("2026-11-07");
  });

  test("buildScanQueue: 契約意志リストによるフィルタとチャンネル別集約", () => {
    const cardId = "test-scan-card";
    const now = Date.now();

    // サービス登録
    orm()
      .insert(services)
      .values({
        id: 700101,
        service_id: 101,
        network_id: 7,
        name: "CS局A",
        type: "CS",
        channel: "CS02",
        updated_at: now,
      })
      .run();
    orm()
      .insert(services)
      .values({
        id: 700102,
        service_id: 102,
        network_id: 7,
        name: "CS局B",
        type: "CS",
        channel: "CS02",
        updated_at: now,
      })
      .run();
    orm()
      .insert(services)
      .values({
        id: 700201,
        service_id: 201,
        network_id: 7,
        name: "CS局C",
        type: "CS",
        channel: "CS04",
        updated_at: now,
      })
      .run();

    // 未確認行
    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: 700101,
        state: "unknown",
        code: null,
        decode_ok: null,
        checked_at: now,
      })
      .run();
    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: 700102,
        state: "unknown",
        code: null,
        decode_ok: null,
        checked_at: now,
      })
      .run();
    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: 700201,
        state: "unknown",
        code: null,
        decode_ok: null,
        checked_at: now,
      })
      .run();

    // 1. 契約意志リストが null (全有料局対象)
    const queueAll = buildScanQueue(cardId, null, now);
    expect(queueAll.length).toBe(2); // CS02 (2局) と CS04 (1局)
    const cs02 = queueAll.find((q) => q.channel === "CS02");
    expect(cs02?.serviceIds).toEqual([700101, 700102]);

    // 2. 契約意志リストで 700101 のみ指定
    const queueFiltered = buildScanQueue(cardId, [700101], now);
    expect(queueFiltered.length).toBe(1);
    expect(queueFiltered[0]?.channel).toBe("CS02");
    expect(queueFiltered[0]?.serviceIds).toEqual([700101]);
  });
});
