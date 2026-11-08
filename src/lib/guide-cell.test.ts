import { describe, expect, test } from "bun:test";

import { cellRows } from "./guide-cell";

const MINUTE = 60 * 1000;
const SLOT = 5 * MINUTE;
/** 表の先頭 (18:00 のつもり)。表は 24 時間 = 288 マス */
const START = 0;
const SLOTS = 288;
const at = (hour: number, minute = 0) =>
  START + ((hour - 18) * 60 + minute) * MINUTE;
/** いまの時刻 (表の先頭から何マスぶん。表の `--now`) */
const now = (hour: number, minute = 0) => (at(hour, minute) - START) / SLOT;

/** CSS の `--past` と同じ割合で、覆いの下端が来る位置 (表の先頭から何マスぶん) */
function shadeBottom(
  rows: { from: number; to: number },
  current: number,
): number {
  const past = Math.min(
    1,
    Math.max(0, (current - rows.from) / (rows.to - rows.from)),
  );
  return rows.from + past * (rows.to - rows.from);
}

describe("cellRows", () => {
  test("5 分に合わせて、始まりを切り捨て、終わりを切り上げる", () => {
    expect(cellRows(at(19, 2), at(20, 54), START, SLOTS, SLOT)).toEqual({
      from: 12,
      to: 35,
      end: now(20, 54),
    });
  });

  test("終わりが 5 分刻みでない番組も、覆いの境目はいまの位置に来る (#2387)", () => {
    const rows = cellRows(at(19), at(20, 54), START, SLOTS, SLOT);
    expect(shadeBottom(rows, now(20, 42))).toBeCloseTo(now(20, 42), 9);
  });

  test("始まりが 5 分刻みでない番組も、覆いの境目はいまの位置に来る", () => {
    const rows = cellRows(at(18, 59), at(21), START, SLOTS, SLOT);
    expect(shadeBottom(rows, now(19, 1))).toBeCloseTo(now(19, 1), 9);
  });

  test("表の先頭より前に始まる番組は先頭で切り、境目はいまの位置に来る", () => {
    const rows = cellRows(at(17), at(18, 30), START, SLOTS, SLOT);
    expect(rows.from).toBe(0);
    expect(shadeBottom(rows, now(18, 10))).toBeCloseTo(now(18, 10), 9);
  });

  test("表の末尾より後に終わる番組は末尾で切り、終わりは実際の時刻のまま", () => {
    const rows = cellRows(at(17, 30), at(18 + 25), START, SLOTS, SLOT);
    expect(rows.to).toBe(SLOTS);
    expect(rows.end).toBe(SLOTS + 12);
    expect(shadeBottom(rows, now(17 + 24))).toBeCloseTo(now(17 + 24), 9);
  });

  test("長さ 0 の番組も 1 マスの高さに置く", () => {
    expect(cellRows(at(19), at(19), START, SLOTS, SLOT)).toEqual({
      from: 12,
      to: 13,
      end: 12,
    });
  });
});
