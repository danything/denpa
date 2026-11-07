import { describe, expect, test } from "bun:test";

import { cfAbsoluteTime } from "./awake.js";
import { HOLD_BEFORE, shouldHold, wakeSecond, wakeTaskXml } from "./power.js";

const idle = {
  recording: false,
  encoding: false,
  watching: false,
  next: null,
  now: 1_000_000,
};

describe("shouldHold", () => {
  test("録画・エンコード・ライブ視聴のどれかがあればスリープさせない", () => {
    expect(shouldHold(idle)).toBe(false);
    expect(shouldHold({ ...idle, recording: true })).toBe(true);
    expect(shouldHold({ ...idle, encoding: true })).toBe(true);
    expect(shouldHold({ ...idle, watching: true })).toBe(true);
  });

  test("次の録画が近ければスリープさせない (起こしたあとに眠り直させない)", () => {
    expect(shouldHold({ ...idle, next: idle.now + HOLD_BEFORE - 1 })).toBe(
      true,
    );
    expect(shouldHold({ ...idle, next: idle.now + HOLD_BEFORE })).toBe(false);
  });
});

describe("wakeTaskXml", () => {
  test("起こす時刻を UTC で書き、スリープを解除して実行する", () => {
    const xml = wakeTaskXml(Date.UTC(2026, 10, 7, 11, 58, 30, 123));
    expect(xml).toContain(
      "<StartBoundary>2026-11-07T11:58:30Z</StartBoundary>",
    );
    expect(xml).toContain("<WakeToRun>true</WakeToRun>");
    // SYSTEM で動かす (denpa 本体と同じ)
    expect(xml).toContain("<UserId>S-1-5-18</UserId>");
  });
});

describe("Mac の起こす予約", () => {
  test("時刻は秒にそろえる (取り消すときに置いたときと同じ時刻を渡すため)", () => {
    expect(wakeSecond(Date.UTC(2026, 10, 7, 11, 58, 30, 999))).toBe(
      Date.UTC(2026, 10, 7, 11, 58, 30),
    );
  });

  test("CoreFoundation の時刻は 2001-01-01 (UTC) からの秒", () => {
    expect(cfAbsoluteTime(Date.UTC(2001, 0, 1))).toBe(0);
    expect(cfAbsoluteTime(Date.UTC(2001, 0, 1, 0, 1, 0, 500))).toBe(60.5);
  });
});
