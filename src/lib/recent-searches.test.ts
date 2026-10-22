import { describe, expect, test } from "bun:test";
import { parseRecent, pushRecent, RECENT_MAX } from "./recent-searches";

describe("最近の検索", () => {
  test("新しい言葉は先頭。同じ言葉は先頭へ移す", () => {
    expect(pushRecent(["a", "b"], " b ")).toEqual(["b", "a"]);
    expect(pushRecent(["a"], "c")).toEqual(["c", "a"]);
  });

  test("空の言葉は覚えない", () => {
    expect(pushRecent(["a"], "  ")).toEqual(["a"]);
  });

  test("覚えるのは上限まで", () => {
    const many = Array.from({ length: RECENT_MAX }, (_, i) => `w${i}`);
    const next = pushRecent(many, "new");
    expect(next).toHaveLength(RECENT_MAX);
    expect(next[0]).toBe("new");
  });

  test("形の違う控えは空として読む", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("{")).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["a", 1, "", "b"]')).toEqual(["a", "b"]);
  });
});
