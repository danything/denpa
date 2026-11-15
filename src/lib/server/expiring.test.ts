import { describe, expect, test } from "bun:test";

import { keepNewest, pruneExpired } from "./expiring";

describe("期限の切れたものを捨てる (pruneExpired)", () => {
  test("期限の時刻を過ぎたもの (同じ時刻も) を捨てる", () => {
    const map = new Map([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    pruneExpired(map, (until) => until, 20);
    expect([...map.keys()]).toEqual(["c"]);
  });

  test("`most` を渡せば、1 つ足せるよう `most` 未満になるまで古いものから捨てる", () => {
    const map = new Map([
      ["a", 100],
      ["b", 100],
      ["c", 100],
    ]);
    pruneExpired(map, (until) => until, 0, 2);
    expect([...map.keys()]).toEqual(["c"]);
  });
});

describe("新しいものを覚えて古いものから捨てる (keepNewest)", () => {
  test("`most` を超えたら先に入れたものから捨てる", () => {
    const map = new Map<string, number>();
    for (const [i, key] of ["a", "b", "c"].entries())
      keepNewest(map, key, i, 2);
    expect([...map.entries()]).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("同じ `key` を覚え直したら後ろへ移し、ほかのものは捨てない", () => {
    const map = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    keepNewest(map, "a", 2, 2);
    expect([...map.entries()]).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
  });
});
