import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Recording } from "../types";

const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-jikkyo-")), "denpa.db");
const { orm } = await import("./db");
const { services } = await import("./schema");
const { saveSettings } = await import("./settings");
const {
  parseForces,
  RANKING_TTL,
  RankingRelay,
  rankingEntries,
  recordingJikkyo,
} = await import("./jikkyo");

/*
 * 実況のサーバの受け持ち。コメントは通さず、録画の頭の時刻と局の勢いだけを渡す。
 * NX-Jikkyo には繋がない (読む関数を差し替える)。返事は自分で作った偽物
 */

/** NX-Jikkyo の `GET /api/v1/channels` の形 (要るところだけ) */
const channel = (id: string, force: number | null, status = "ACTIVE") => ({
  id,
  name: id,
  threads: [
    { id: 1, status: "PAST", jikkyo_force: null, viewers: null },
    { id: 2, status, jikkyo_force: force, viewers: 90 },
  ],
});

describe("parseForces", () => {
  test("放送中のスレッドの勢いだけを抜く", () => {
    const forces = parseForces([
      channel("jk1", 3),
      channel("jk6", 36),
      channel("jk101", 0, "UPCOMING"),
    ]);
    expect([...forces]).toEqual([
      ["jk1", 3],
      ["jk6", 36],
    ]);
  });

  test("形のずれたチャンネルは飛ばして、1 回だけ言う", () => {
    const warned: string[] = [];
    const forces = parseForces(
      [channel("jk1", 3), { id: 5 }, channel("jk6", null)],
      (message) => warned.push(message),
    );
    expect([...forces]).toEqual([["jk1", 3]]);
    expect(warned).toHaveLength(1);
  });

  test("1 つも読めなければ失敗", () => {
    expect(() => parseForces({ channels: [] })).toThrow();
    expect(() => parseForces([{ id: 5 }])).toThrow();
  });
});

describe("RankingRelay", () => {
  afterEach(() => {
    spyOn(console, "warn").mockRestore();
    spyOn(console, "log").mockRestore();
  });

  test("30 秒は同じものを返し、過ぎたら読み直す。同時に呼ばれても読むのは 1 回", async () => {
    let now = 1_000_000;
    let reads = 0;
    const relay = new RankingRelay(
      async () => {
        reads++;
        return [channel("jk1", reads)];
      },
      () => now,
    );
    const [a, b] = await Promise.all([relay.get(), relay.get()]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
    now += RANKING_TTL - 1;
    expect((await relay.get()).forces.get("jk1")).toBe(1);
    now += 1;
    expect((await relay.get()).forces.get("jk1")).toBe(2);
    expect(reads).toBe(2);
  });

  test("読めなければ投げ、記録には同じ理由を 1 行だけ。戻ったら 1 行", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    let now = 0;
    let fail = true;
    let reads = 0;
    const relay = new RankingRelay(
      async () => {
        reads++;
        if (fail) throw new Error("HTTP 502");
        return [channel("jk1", 3)];
      },
      () => now,
    );
    await expect(relay.get()).rejects.toThrow();
    // 30 秒は読み直さずに同じ失敗を返す
    now += 1;
    await expect(relay.get()).rejects.toThrow();
    expect(reads).toBe(1);
    now += RANKING_TTL;
    await expect(relay.get()).rejects.toThrow();
    expect(reads).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    fail = false;
    now += RANKING_TTL;
    expect((await relay.get()).forces.get("jk1")).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("失敗したら古い勢いを返さない", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    let now = 0;
    let fail = false;
    const relay = new RankingRelay(
      async () => {
        if (fail) throw new Error("timeout");
        return [channel("jk1", 3)];
      },
      () => now,
    );
    await relay.get();
    fail = true;
    now += RANKING_TTL;
    await expect(relay.get()).rejects.toThrow();
    now += 1;
    await expect(relay.get()).rejects.toThrow();
  });
});

describe("rankingEntries", () => {
  test("同じ対応表で局に当てる。系列の地方局・サブチャンネルにも同じ勢い、放送中でない局は載せない", () => {
    const forces = new Map([
      ["jk6", 36],
      ["jk101", 0],
    ]);
    expect(
      rankingEntries(
        [
          { id: 1, type: "GR", service_id: 1048, name: "ＴＢＳ１" },
          { id: 2, type: "GR", service_id: 2064, name: "ＭＢＳ毎日放送" },
          { id: 3, type: "GR", service_id: 1024, name: "ＮＨＫ総合１・東京" },
          { id: 4, type: "BS", service_id: 102, name: "ＮＨＫ　ＢＳ" },
          { id: 5, type: "GR", service_id: 9999, name: "どこかの局" },
        ],
        forces,
      ),
    ).toEqual([
      { serviceId: 1, force: 36 },
      { serviceId: 2, force: 36 },
      { serviceId: 4, force: 0 },
    ]);
  });
});

describe("recordingJikkyo", () => {
  const T = Date.UTC(2026, 9, 28, 12, 0, 0);
  orm()
    .insert(services)
    .values([
      {
        id: 7,
        service_id: 1048,
        network_id: 32739,
        name: "ＴＢＳ１",
        type: "GR",
        channel: "T22",
        updated_at: 0,
      },
      {
        id: 8,
        service_id: 231,
        network_id: 4,
        name: "放送大学テレビ",
        type: "BS",
        channel: "BS11_2",
        updated_at: 0,
      },
    ])
    .run();
  const recording = (patch: Partial<Recording>) =>
    ({
      service_id: 7,
      start_at: T,
      ts_head: null,
      record_from: null,
      ...patch,
    }) as Recording;

  test("世帯の設定がオフなら null", () => {
    saveSettings({ jikkyo: false });
    expect(recordingJikkyo(recording({ ts_head: T - 9_000 }))).toBeNull();
  });

  test("測った頭を使う。無ければ予定の時刻で代わりに合わせる", () => {
    saveSettings({ jikkyo: true });
    expect(recordingJikkyo(recording({ ts_head: T - 9_000 }))).toEqual({
      channel: "jk6",
      head: T - 9_000,
    });
    expect(recordingJikkyo(recording({}))).toEqual({
      channel: "jk6",
      head: T - config.startMargin,
    });
    // 取り合いで頭を譲った録画は、使えた区間の頭
    expect(recordingJikkyo(recording({ record_from: T + 60_000 }))).toEqual({
      channel: "jk6",
      head: T + 60_000,
    });
  });

  test("実況の無い局は null", () => {
    saveSettings({ jikkyo: true });
    expect(recordingJikkyo(recording({ service_id: 8 }))).toBeNull();
  });
});
