import { describe, expect, test } from "bun:test";

import { ListHold, parseRanking, rankOrder, slides } from "./ranking";

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

  test("形式がずれていれば null", () => {
    expect(parseRanking({ at: 1 })).toBeNull();
    expect(
      parseRanking({ channels: [{ serviceId: "7", force: 1 }] }),
    ).toBeNull();
    expect(parseRanking(null)).toBeNull();
  });
});

describe("ListHold", () => {
  /** 待つ長さ。試験では短く */
  const SETTLE = 20;
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  test("理由が全部外れてから待って並べ直す。外れる前は並べ直さない", async () => {
    let released = 0;
    const hold = new ListHold(() => released++, SETTLE);
    expect(hold.held).toBe(false);
    hold.set("pointer", true);
    hold.set("focus", true);
    hold.set("pointer", false);
    await wait(SETTLE * 2);
    // フォーカスがまだある
    expect(released).toBe(0);
    expect(hold.held).toBe(true);
    hold.set("focus", false);
    // 離した瞬間には替えない
    expect(released).toBe(0);
    expect(hold.held).toBe(true);
    await wait(SETTLE * 2);
    expect(released).toBe(1);
    expect(hold.held).toBe(false);
  });

  test("待っている間にまた乗ったら並べ直さない", async () => {
    let released = 0;
    const hold = new ListHold(() => released++, SETTLE);
    hold.set("touch", true);
    hold.set("touch", false);
    hold.set("touch", true);
    await wait(SETTLE * 2);
    expect(released).toBe(0);
    hold.set("touch", false);
    await wait(SETTLE * 2);
    expect(released).toBe(1);
  });

  test("立っていない理由を外しても並べ直さない", async () => {
    let released = 0;
    const hold = new ListHold(() => released++, SETTLE);
    hold.set("focus", false);
    await wait(SETTLE * 2);
    expect(released).toBe(0);
  });

  test("巻いたら、止まってから待つ。閉じたら待つのをやめ、理由も忘れる", async () => {
    let released = 0;
    const hold = new ListHold(() => released++, SETTLE);
    hold.poke();
    expect(hold.held).toBe(true);
    await wait(SETTLE * 2);
    expect(released).toBe(1);
    hold.poke();
    hold.set("pointer", true);
    hold.clear();
    expect(hold.held).toBe(false);
    await wait(SETTLE * 2);
    expect(released).toBe(1);
  });
});

describe("slides", () => {
  test("動いた行だけ、前の場所との差 (前 − 後)", () => {
    const before = new Map([
      [1, 0],
      [2, 48],
      [3, 96],
    ]);
    const after = new Map([
      [3, 0],
      [1, 48],
      [2, 96],
      [4, 144],
    ]);
    expect(slides(before, after)).toEqual(
      new Map([
        [3, 96],
        [1, -48],
        [2, -48],
      ]),
    );
  });
});
