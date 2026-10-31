import { describe, expect, test } from "bun:test";

import { CommentStore } from "./comments";
import {
  airClock,
  atBottom,
  BOTTOM_SLACK,
  follows,
  jumped,
  LIST_MAX,
  LIST_SPAN,
  sameRows,
} from "./list";

/*
 * 右の列の「コメントの一覧」
 */

const at = (ms: number, text = `c${ms}`) => ({ at: ms, text });

describe("並べるところ (CommentStore.latest)", () => {
  test("W までに書かれたものの新しいほうから件数ぶん。時刻の順で返す", () => {
    const store = new CommentStore();
    store.add([at(1), at(2), at(3), at(4), at(5)]);
    expect(store.latest(0, 4, 2).map((c) => c.at)).toEqual([3, 4]);
    // W より後に書かれたものはまだ並べない
    expect(store.latest(0, 5, 10).map((c) => c.at)).toEqual([1, 2, 3, 4, 5]);
    expect(store.latest(2, 5, 10).map((c) => c.at)).toEqual([3, 4, 5]);
  });

  test("外すもの (NG ワード) を飛ばして、件数をそろえる", () => {
    const store = new CommentStore();
    store.add([at(1), at(2, "NG"), at(3), at(4, "NG")]);
    const rows = store.latest(0, 10, 2, (c) => c.text !== "NG");
    expect(rows.map((c) => c.at)).toEqual([1, 3]);
  });

  test("窓より古いものは並べない。上限は 200 件", () => {
    const store = new CommentStore();
    const w = LIST_SPAN + 10_000;
    store.add([at(5_000), ...Array.from({ length: 300 }, (_, i) => at(w - i))]);
    const rows = store.latest(w - LIST_SPAN, w, LIST_MAX);
    expect(rows).toHaveLength(LIST_MAX);
    expect(rows.at(-1)!.at).toBe(w);
    expect(
      store.latest(w - LIST_SPAN, w, 1000).some((c) => c.at === 5_000),
    ).toBe(false);
  });

  test("遅れて届いたものも、読み直せば時刻の位置に入る", () => {
    const store = new CommentStore();
    store.add([at(1), at(3)]);
    const before = store.latest(0, 5, 10);
    store.add([at(2)]);
    const after = store.latest(0, 5, 10);
    expect(after.map((c) => c.at)).toEqual([1, 2, 3]);
    expect(sameRows(before, after)).toBe(false);
  });

  test("勢いは W までの区間の数", () => {
    const store = new CommentStore();
    store.add([at(1), at(2), at(3)]);
    expect(store.count(1, 3)).toBe(2);
    expect(store.count(5, 9)).toBe(0);
  });
});

describe("付いていくか", () => {
  test("いちばん下にいて、使っていないときだけ付いていく", () => {
    expect(follows(true, false, 10)).toBe(true);
    expect(follows(true, true, 10)).toBe(false);
    expect(follows(false, false, 10)).toBe(false);
  });

  test("まだ 1 行も無ければ、使っていても付いていく", () => {
    expect(follows(true, true, 0)).toBe(true);
    expect(follows(false, false, 0)).toBe(true);
  });

  test("下の端から BOTTOM_SLACK までは、いちばん下とみなす", () => {
    const box = { scrollHeight: 1000, clientHeight: 200 };
    expect(atBottom({ ...box, scrollTop: 800 })).toBe(true);
    expect(atBottom({ ...box, scrollTop: 800 - BOTTOM_SLACK })).toBe(true);
    expect(atBottom({ ...box, scrollTop: 700 })).toBe(false);
    // 巻くほど無い
    expect(
      atBottom({ scrollHeight: 100, clientHeight: 200, scrollTop: 0 }),
    ).toBe(true);
  });

  test("放送時刻が飛んだ (シーク) ら、いちばん下へ戻す", () => {
    expect(jumped(null, 0)).toBe(false);
    expect(jumped(10_000, 10_250)).toBe(false);
    expect(jumped(10_000, 9_500)).toBe(false);
    expect(jumped(10_000, 5_000)).toBe(true);
    expect(jumped(10_000, 30_000)).toBe(true);
  });
});

describe("行", () => {
  test("件数と両端が同じなら描き直さない", () => {
    const a = at(1);
    const b = at(2);
    expect(sameRows([a, b], [a, b])).toBe(true);
    expect(sameRows([a], [a, b])).toBe(false);
    expect(sameRows([], [])).toBe(true);
  });

  test("時刻は h:mm:ss", () => {
    const ms = new Date(2026, 9, 31, 9, 5, 7).getTime();
    expect(airClock(ms)).toBe("9:05:07");
  });
});
