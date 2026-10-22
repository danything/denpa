import { describe, expect, test } from "bun:test";
import { DecodeBudget, QUEUE_STUCK, STRIKES, WINDOW } from "./budget";

/** 1秒ぶん、決まった重さでデコードしたことにする */
function second(
  budget: DecodeBudget,
  at: number,
  ms: number,
  late = 0,
): boolean {
  for (let i = 0; i < 30; i++) budget.record(ms);
  return budget.tick(at, 33.4, late);
}

describe("DecodeBudget", () => {
  test("間に合っていれば諦めない", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    for (let s = 1; s <= 20; s++)
      expect(second(budget, s * WINDOW, 10)).toBe(false);
    expect(budget.p95).toBe(10);
  });

  test("重いのが3秒続いたら諦める。**1回の重さでは戻さない**", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    const results = [1, 2, 3].map((s) => second(budget, s * WINDOW, 30));
    expect(results).toEqual([false, false, true]);
    expect(STRIKES).toBe(3);
  });

  /** B フレームを飛ばしている間は、デコードする枚数が減るぶん 1 枚に掛けてよい時間を伸ばす (`worker.ts` の `thin`) */
  test("B を飛ばしている間は 1 枚に 2 倍まで掛けてよい", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    const window = (s: number, stretch: number) => {
      for (let i = 0; i < 10; i++) budget.record(40);
      return budget.tick(s * WINDOW, 33.4, 0, 0, 0, stretch);
    };
    // 1 枚 40ms は 1 コマ (33.4ms) の 8 割を超えるが、2 倍までなら間に合っている
    expect([window(1, 2), window(2, 2), window(3, 2), window(4, 2)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([window(5, 1), window(6, 1), window(7, 1)]).toEqual([
      false,
      false,
      true,
    ]);
  });

  /*
   * **デコードの時間がぎりぎり間に合っていても、コマを捨て続けていれば諦める** (同じ端末で 2 本見ていたとき)
   */

  test("出すはずのコマの 15% 以上を捨て続けたら諦める", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0, 0, 0);
    const window = (s: number, dropped: number) => {
      for (let i = 0; i < 10; i++) budget.record(20);
      return budget.tick(s * WINDOW, 33.4, 0, 0, dropped);
    };
    // 1秒 (30 コマ) に 6 枚捨てる (20%)
    expect([window(1, 6), window(2, 12), window(3, 18)]).toEqual([
      false,
      false,
      true,
    ]);
    // 捨てるのが少なければ (1秒に 2 枚) 数えない
    const calm = new DecodeBudget();
    calm.tick(0, 33.4, 0, 0, 0);
    for (const s of [1, 2, 3, 4]) {
      for (let i = 0; i < 10; i++) calm.record(20);
      expect(calm.tick(s * WINDOW, 33.4, 0, 0, s * 2)).toBe(false);
    }
  });

  test("途中で間に合えば数え直す", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    for (const s of [1, 2]) second(budget, s * WINDOW, 30);
    expect(second(budget, 3 * WINDOW, 10)).toBe(false);
    for (const s of [4, 5]) expect(second(budget, s * WINDOW, 30)).toBe(false);
    expect(second(budget, 6 * WINDOW, 30)).toBe(true);
  });

  test("デコードする時間が軽くても、映像が遅れ続けていれば諦める", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    const results = [1, 2, 3, 4, 5].map((s) =>
      second(budget, s * WINDOW, 5, 0.5),
    );
    expect(results.at(-1)).toBe(true);
  });

  test("止めている間 (コマが来ない) は数えない", () => {
    const budget = new DecodeBudget();
    budget.tick(0, 33.4, 0);
    for (let s = 1; s <= 10; s++)
      expect(budget.tick(s * WINDOW, 33.4, 1)).toBe(false);
  });
});

describe("DecodeBudget (WebCodecs の経路)", () => {
  /** 1秒ぶん。`queued` は刻みごとの詰まり */
  function webSecond(
    budget: DecodeBudget,
    at: number,
    ms: number,
    queued: number[],
  ): boolean {
    for (let i = 0; i < 30; i++) budget.record(ms);
    let result = false;
    for (const [i, q] of queued.entries())
      result = budget.tick(
        at - WINDOW + ((i + 1) * WINDOW) / queued.length,
        16.7,
        0,
        q,
      );
    return result;
  }

  test("1コマの時間が長くても (GPU 経由の溜め) 詰まっていなければ諦めない", () => {
    const budget = new DecodeBudget(false);
    budget.tick(0, 16.7, 0, 0);
    for (let s = 1; s <= 10; s++)
      expect(webSecond(budget, s * WINDOW, 60, [2, 0, 1, 2])).toBe(false);
    expect(budget.p95).toBe(60);
  });

  test("窓の間ずっと捌けきらないのが3秒続いたら諦める", () => {
    const budget = new DecodeBudget(false);
    budget.tick(0, 16.7, 0, QUEUE_STUCK);
    const results = [1, 2, 3].map((s) =>
      webSecond(budget, s * WINDOW, 5, [QUEUE_STUCK, QUEUE_STUCK + 2]),
    );
    expect(results).toEqual([false, false, true]);
  });
});
