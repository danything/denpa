import { describe, expect, test } from "bun:test";

import { parseRanking, rankOrder } from "./ranking";

/*
 * 「実況」タブの並べ方。局の ID は番号順 (地上波 → BS → CS) に渡す
 */

describe("rankOrder", () => {
  const ids = [1, 2, 3, 4, 5];

  test("勢いの大きい順。同じ勢いは番号順", () => {
    const forces = new Map([
      [1, 3],
      [2, 36],
      [3, 27],
      [4, 36],
      [5, 0],
    ]);
    expect(rankOrder(ids, forces)).toEqual([2, 4, 3, 1, 5]);
  });

  test("放送中のスレッドが無い局 (返事に入っていない) は末尾に番号順で", () => {
    const forces = new Map([
      [4, 10],
      [2, 5],
    ]);
    expect(rankOrder(ids, forces)).toEqual([4, 2, 1, 3, 5]);
  });

  test("読めないときは番号順のまま", () => {
    expect(rankOrder(ids, null)).toEqual(ids);
  });
});

describe("parseRanking", () => {
  test("局の ID → 勢い", () => {
    expect(
      parseRanking({ at: 1, channels: [{ serviceId: 7, force: 36 }] }),
    ).toEqual(new Map([[7, 36]]));
  });

  test("形がずれていれば null", () => {
    expect(parseRanking({ at: 1 })).toBeNull();
    expect(
      parseRanking({ channels: [{ serviceId: "7", force: 1 }] }),
    ).toBeNull();
    expect(parseRanking(null)).toBeNull();
  });
});
