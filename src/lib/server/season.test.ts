import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **「denpa の 1 年」の数と、出した年を覚えるところ** (`season.ts`)。DB は一時ファイルへ (ranking.test.ts と同じ)
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-season-"));
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");
config.dataDir = dir;

const { orm } = await import("./db");
const { recordings, settings } = await import("./schema");
const { greetedYear, markGreeted, yearSummary } = await import("./season");
const { saveSettings, settings: readSettings } = await import("./settings");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 日本時間の日時 (unix ms) */
function jst(year: number, month: number, day: number, hour = 12): number {
  return Date.UTC(year, month - 1, day, hour - 9);
}

const HOUR = 3_600_000;
let id = 0;

function record(row: {
  service: string;
  start: number;
  hours?: number;
  duration?: number | null;
  finished?: boolean;
  error?: string;
  deleted?: boolean;
  watched?: number;
}): void {
  const hours = row.hours ?? 1;
  orm()
    .insert(recordings)
    .values({
      id: ++id,
      service_id: 1,
      service_name: row.service,
      name: `番組 ${id}`,
      start_at: row.start,
      end_at: row.start + hours * HOUR,
      duration_ms: row.duration === undefined ? hours * HOUR : row.duration,
      finished_at: row.finished === false ? null : row.start + hours * HOUR,
      error: row.error ?? null,
      deleted_at: row.deleted ? row.start + 10 * HOUR : null,
      watched_at: row.watched ?? null,
      created_at: row.start,
      updated_at: row.start,
    })
    .run();
}

beforeEach(() => {
  orm().delete(recordings).run();
  orm().delete(settings).run();
});

describe("去年の数 (`yearSummary`)", () => {
  test("その年に始まった録画の本数と長さ。いちばん録った局", () => {
    record({ service: "でんぱテレビ", start: jst(2026, 1, 1, 0) + 1 });
    record({ service: "でんぱテレビ", start: jst(2026, 6, 1), hours: 2 });
    record({ service: "BSでんぱ", start: jst(2026, 12, 31, 23), hours: 3 });
    // 日本時間ではもう次の年 (UTC では 2026 年)
    record({ service: "BSでんぱ", start: jst(2027, 1, 1, 0) });
    // 日本時間ではまだ前の年
    record({ service: "BSでんぱ", start: jst(2025, 12, 31, 23) });
    expect(yearSummary(2026)).toEqual({
      year: 2026,
      recorded: 3,
      recordedMs: 6 * HOUR,
      topRecorded: "でんぱテレビ",
      watched: 0,
      topWatched: null,
    });
  });

  test("失敗したもの・録画中のものは数えず、あとで消したものは数える", () => {
    record({ service: "でんぱテレビ", start: jst(2026, 3, 1), error: "失敗" });
    record({
      service: "でんぱテレビ",
      start: jst(2026, 3, 2),
      finished: false,
    });
    record({ service: "BSでんぱ", start: jst(2026, 3, 3), deleted: true });
    const summary = yearSummary(2026);
    expect(summary.recorded).toBe(1);
    expect(summary.topRecorded).toBe("BSでんぱ");
  });

  test("長さを測れていない古い行は番組の尺で数える", () => {
    record({
      service: "でんぱテレビ",
      start: jst(2026, 4, 1),
      hours: 2,
      duration: null,
    });
    expect(yearSummary(2026).recordedMs).toBe(2 * HOUR);
  });

  test("同じ本数なら長いほうの局", () => {
    record({ service: "でんぱテレビ", start: jst(2026, 5, 1), hours: 1 });
    record({ service: "BSでんぱ", start: jst(2026, 5, 2), hours: 2 });
    expect(yearSummary(2026).topRecorded).toBe("BSでんぱ");
  });

  test("観終えた録画は観終えた時刻がその年のもの。いちばん観た局も本数で", () => {
    record({
      service: "でんぱテレビ",
      start: jst(2025, 12, 30),
      watched: jst(2026, 1, 2),
    });
    record({
      service: "BSでんぱ",
      start: jst(2026, 2, 1),
      watched: jst(2026, 2, 2),
    });
    record({
      service: "BSでんぱ",
      start: jst(2026, 2, 3),
      watched: jst(2026, 2, 4),
    });
    record({
      service: "でんぱテレビ",
      start: jst(2026, 12, 30),
      watched: jst(2027, 1, 2),
    });
    const summary = yearSummary(2026);
    expect(summary.watched).toBe(3);
    expect(summary.topWatched).toBe("BSでんぱ");
  });

  test("何も無い年は 0 と null", () => {
    expect(yearSummary(2026)).toEqual({
      year: 2026,
      recorded: 0,
      recordedMs: 0,
      topRecorded: null,
      watched: 0,
      topWatched: null,
    });
  });
});

describe("出した年 (`markGreeted`)", () => {
  test("世帯で 1 回だけ。同じ年の 2 回目は断り、次の年はまた出せる", () => {
    expect(greetedYear()).toBeNull();
    expect(markGreeted(2027)).toBe(true);
    expect(greetedYear()).toBe(2027);
    expect(markGreeted(2027)).toBe(false);
    expect(markGreeted(2028)).toBe(true);
    expect(greetedYear()).toBe(2028);
  });
});

describe("世帯の設定 (`seasonal`)", () => {
  test("既定はオンで、オフにできる", () => {
    expect(readSettings().seasonal).toBe(true);
    saveSettings({ seasonal: false });
    expect(readSettings().seasonal).toBe(false);
    saveSettings({ seasonal: true });
    expect(readSettings().seasonal).toBe(true);
  });
});
