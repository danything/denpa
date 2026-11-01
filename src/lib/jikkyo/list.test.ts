import { describe, expect, test } from "bun:test";

import { CommentStore } from "./comments";
import { jumped } from "./cursor";
import {
  airClock,
  atNow,
  BOTTOM_SLACK,
  follows,
  LIST_AHEAD,
  LIST_MAX,
  LIST_SPAN,
  moreAhead,
  nearEnd,
  nowTop,
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

describe("この先 (録画だけ)", () => {
  test("W より後に書かれたものの古いほうから件数ぶん。端までで止める", () => {
    const store = new CommentStore();
    store.add([at(1), at(2), at(3), at(4), at(5), at(6)]);
    // W ちょうどのものは、いままでのほうに入る
    expect(store.earliest(2, 6, 2).map((c) => c.at)).toEqual([3, 4]);
    // 端 (追っかけは録れているところ) より後は並べない
    expect(store.earliest(2, 4, 10).map((c) => c.at)).toEqual([3, 4]);
    expect(store.latest(0, 2, 10).map((c) => c.at)).toEqual([1, 2]);
  });

  test("外すもの (NG ワード) を飛ばして、件数をそろえる", () => {
    const store = new CommentStore();
    store.add([at(1, "NG"), at(2), at(3, "NG"), at(4), at(5)]);
    const rows = store.earliest(0, 10, 2, (c) => c.text !== "NG");
    expect(rows.map((c) => c.at)).toEqual([2, 4]);
  });

  test("下の端まで 1 画面を切ったら足す", () => {
    const box = { scrollHeight: 1000, clientHeight: 200 };
    expect(nearEnd({ ...box, scrollTop: 400 })).toBe(false);
    expect(nearEnd({ ...box, scrollTop: 600 })).toBe(true);
    expect(nearEnd({ ...box, scrollTop: 800 })).toBe(true);
  });

  test("足すときは LIST_AHEAD 件ずつ。並べる件数の上限で止め、端まで並べてあれば増やさない", () => {
    expect(moreAhead(LIST_AHEAD, LIST_AHEAD, LIST_MAX)).toBe(LIST_AHEAD * 2);
    expect(moreAhead(LIST_MAX - 10, LIST_MAX - 10, LIST_MAX)).toBe(LIST_MAX);
    expect(moreAhead(LIST_MAX, LIST_MAX, LIST_MAX)).toBe(LIST_MAX);
    // 求めたぶんに届いていない (録画の終わり・録れているところまで並べた)
    expect(moreAhead(LIST_AHEAD, 12, LIST_MAX)).toBe(LIST_AHEAD);
  });
});

describe("付いていくか", () => {
  test("「いま」にいて、使っていないときだけ付いていく", () => {
    expect(follows(true, false, 10)).toBe(true);
    expect(follows(true, true, 10)).toBe(false);
    expect(follows(false, false, 10)).toBe(false);
  });

  test("まだ 1 行も無ければ、使っていても付いていく", () => {
    expect(follows(true, true, 0)).toBe(true);
    expect(follows(false, false, 0)).toBe(true);
  });

  test("この先が無ければ、下の端から BOTTOM_SLACK までは「いま」とみなす", () => {
    const box = { scrollHeight: 1000, clientHeight: 200 };
    const now = nowTop(box, null);
    expect(now).toBe(800);
    expect(atNow(800, now)).toBe(true);
    expect(atNow(800 - BOTTOM_SLACK, now)).toBe(true);
    expect(atNow(700, now)).toBe(false);
    // 巻くほど無い
    expect(
      atNow(0, nowTop({ scrollHeight: 100, clientHeight: 200 }, null)),
    ).toBe(true);
  });

  test("この先があれば、いままでの行の下の端が見えている所の下の端に来る所が「いま」。上へも下へも離れたら外れる", () => {
    // いままでの行が 600px、その下にこの先が 400px
    const box = { scrollHeight: 1000, clientHeight: 200 };
    const now = nowTop(box, 600);
    expect(now).toBe(400);
    expect(atNow(400, now)).toBe(true);
    expect(atNow(400 + BOTTOM_SLACK, now)).toBe(true);
    // 下へ巻いて、この先を読んでいる
    expect(atNow(500, now)).toBe(false);
    // 上へ巻いて、読み返している
    expect(atNow(300, now)).toBe(false);
    // 巻ける幅は超えない
    expect(nowTop(box, 1200)).toBe(800);
    expect(nowTop(box, 100)).toBe(0);
  });

  test("一覧から押して飛んだ直後は、乗っていても、押す前に巻いて離れていても付いていく", () => {
    expect(follows(true, true, 10, true)).toBe(true);
    expect(follows(false, true, 10, true)).toBe(true);
    expect(follows(true, true, 10, false)).toBe(false);
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
