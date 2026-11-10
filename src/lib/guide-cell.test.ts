import { describe, expect, test } from "bun:test";

import { cellRows, placeRows } from "./guide-cell";

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
  test("5 分に合わせて、始まりも終わりも近いほうの 5 分に丸める", () => {
    expect(cellRows(at(19, 3), at(20, 52), START, SLOTS, SLOT)).toEqual({
      from: 13,
      to: 34,
      end: now(20, 52),
    });
  });

  test("前のマスの下端より上からは始めない", () => {
    expect(cellRows(at(19, 1), at(19, 4), START, SLOTS, SLOT, 13)).toEqual({
      from: 13,
      to: 14,
      end: now(19, 4),
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

describe("placeRows", () => {
  const cell = (
    key: string,
    start: [number, number],
    end: [number, number],
    column = 0,
    span = 1,
  ) => ({
    key,
    column,
    span,
    start_at: at(...start),
    end_at: at(...end),
  });
  const place = (cells: ReturnType<typeof cell>[]) =>
    placeRows(cells, START, SLOTS, SLOT);
  const range = (
    rows: Map<string, { from: number; to: number }>,
    key: string,
  ) => {
    const row = rows.get(key)!;
    return [row.from, row.to];
  };

  test("5 分刻みでない時刻で切り替わる 2 つの番組を、同じ行に重ねない (#2488)", () => {
    const rows = place([
      cell("a", [19, 0], [19, 7]),
      cell("b", [19, 7], [19, 10]),
    ]);
    expect(range(rows, "a")).toEqual([12, 13]);
    expect(range(rows, "b")).toEqual([13, 14]);
  });

  test("issue の例 (11:57・20:42 の切り替わり) も重ねない", () => {
    const rows = place([
      cell("a", [19, 54], [19, 57]),
      cell("b", [19, 57], [20, 0]),
      cell("c", [20, 0], [21, 12]),
      cell("d", [21, 12], [21, 15]),
    ]);
    const all = ["a", "b", "c", "d"].map((key) => range(rows, key));
    for (let i = 1; i < all.length; i++)
      expect(all[i]![0]).toBeGreaterThanOrEqual(all[i - 1]![1]!);
  });

  test("5 分より短い番組が続いたら、1 行ずつ下へ送り、次の長い番組で戻る", () => {
    const rows = place([
      cell("a", [19, 0], [19, 1]),
      cell("b", [19, 1], [19, 2]),
      cell("c", [19, 2], [19, 4]),
      cell("d", [19, 4], [20, 0]),
    ]);
    expect(range(rows, "a")).toEqual([12, 13]);
    expect(range(rows, "b")).toEqual([13, 14]);
    expect(range(rows, "c")).toEqual([14, 15]);
    expect(range(rows, "d")).toEqual([15, 24]);
  });

  test("列ごとに数え、横に伸びるマスは、またがる列のうち一番下の下端から始める", () => {
    const rows = place([
      cell("main", [19, 0], [19, 30], 0, 2),
      cell("left", [19, 30], [19, 33], 0),
      cell("right", [19, 30], [19, 45], 1),
      cell("other", [19, 31], [19, 40], 2),
      cell("both", [19, 33], [20, 0], 0, 2),
    ]);
    expect(range(rows, "main")).toEqual([12, 18]);
    expect(range(rows, "left")).toEqual([18, 19]);
    expect(range(rows, "right")).toEqual([18, 21]);
    // 別の列は前の列のマスに押されない
    expect(range(rows, "other")).toEqual([18, 20]);
    expect(range(rows, "both")).toEqual([21, 24]);
  });

  test("並びが時刻の順でなくても、早く始まるマスから置く", () => {
    const rows = place([
      cell("b", [19, 7], [19, 10]),
      cell("a", [19, 0], [19, 7]),
    ]);
    expect(range(rows, "a")).toEqual([12, 13]);
    expect(range(rows, "b")).toEqual([13, 14]);
  });
});
