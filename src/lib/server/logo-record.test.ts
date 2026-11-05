import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "./config";

const dir = mkdtempSync(join(tmpdir(), "denpa-logo-record-"));
const original = config.dbPath;
config.dbPath = join(dir, "denpa.db");

const { orm } = await import("./db");
const { logoRecords } = await import("./schema");
const { saveSettings } = await import("./settings");
const {
  LOGO_RECORD_DAYS,
  LOGO_RECORD_KEEP,
  logoRecordCsv,
  logoRecordList,
  recordLogoAttempt,
} = await import("./logo-record");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 12);

const attempt = (startedAt: number, channel = "BS15:16625") => ({
  startedAt,
  channel,
  origin: "wait" as const,
  openedMs: 20 * 60_000,
  outcome: "ranOut",
  received: false,
  found: 0,
  counts: {
    packets: 1000,
    errors: 0,
    pmt: true,
    esPids: 2,
    esPackets: 0,
    dii: 0,
    ddb: 0,
    sdtt: 0,
  },
});

beforeAll(() => orm());
beforeEach(() => {
  orm().delete(logoRecords).run();
  saveSettings({ recordLogo: true });
});
afterAll(() => {
  config.dbPath = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("ロゴの取得の記録", () => {
  test("設定がオフの間は書かない", () => {
    saveSettings({ recordLogo: false });
    recordLogoAttempt(attempt(NOW), NOW);
    expect(logoRecordList()).toEqual([]);
  });

  test("オンなら 1 回ぶんを 1 行で残し、開けなかった回は読んだ数を 0 にする", () => {
    recordLogoAttempt(attempt(NOW - 60_000), NOW);
    recordLogoAttempt({ ...attempt(NOW), counts: null }, NOW);
    const rows = logoRecordList();
    expect(rows.map((r) => r.started_at)).toEqual([NOW, NOW - 60_000]);
    expect(rows[0]!.packets).toBe(0);
    expect(rows[1]!.es_pids).toBe(2);
    expect(rows[1]!.pmt).toBe(true);
  });

  test(`${LOGO_RECORD_DAYS} 日より古い行を消す`, () => {
    recordLogoAttempt(attempt(NOW - (LOGO_RECORD_DAYS + 1) * DAY), NOW);
    recordLogoAttempt(attempt(NOW - DAY), NOW);
    expect(logoRecordList().map((r) => r.started_at)).toEqual([NOW - DAY]);
  });

  test(`新しい順に ${LOGO_RECORD_KEEP} 行を越えたぶんを消す`, () => {
    const db = orm();
    const base = attempt(0);
    db.insert(logoRecords)
      .values(
        Array.from({ length: LOGO_RECORD_KEEP }, (_, i) => ({
          started_at: NOW - (i + 1) * 1000,
          channel: base.channel,
          origin: base.origin,
          opened_ms: 0,
          outcome: "ranOut",
          received: false,
          found: 0,
          packets: 0,
          errors: 0,
          pmt: false,
          es_pids: 0,
          es_packets: 0,
          dii: 0,
          ddb: 0,
          sdtt: 0,
        })),
      )
      .run();
    recordLogoAttempt(attempt(NOW), NOW);
    const rows = logoRecordList();
    expect(rows).toHaveLength(LOGO_RECORD_KEEP);
    expect(rows[0]!.started_at).toBe(NOW);
    expect(rows.at(-1)!.started_at).toBe(NOW - (LOGO_RECORD_KEEP - 1) * 1000);
  });

  test("CSV は見出し付きで古い順に並べる", () => {
    recordLogoAttempt(attempt(NOW - 60_000), NOW);
    recordLogoAttempt(attempt(NOW, "BS15:16626"), NOW);
    const lines = logoRecordCsv(logoRecordList()).trimEnd().split("\n");
    expect(lines[0]).toStartWith("started_at,channel,origin,opened_s,outcome");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("BS15:16625");
    expect(lines[2]).toStartWith(new Date(NOW).toISOString());
    expect(lines[2]).toContain(
      ",BS15:16626,wait,1200,ranOut,0,0,1000,0,1,2,0,0,0,0",
    );
  });
});
