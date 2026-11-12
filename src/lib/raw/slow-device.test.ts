import { describe, expect, test } from "bun:test";

import { SLOW_KEEP, slowAt } from "./slow-device";

describe("MPEG-2 を打ち切った端末の記憶", () => {
  const at = Date.UTC(2026, 10, 12);

  test("覚えていなければ効かない", () => {
    expect(slowAt(null, at)).toBe(false);
  });

  test("打ち切ってから 30 日のあいだ効く", () => {
    expect(SLOW_KEEP).toBe(30 * 24 * 60 * 60 * 1000);
    expect(slowAt(String(at), at)).toBe(true);
    expect(slowAt(String(at), at + SLOW_KEEP - 1)).toBe(true);
    expect(slowAt(String(at), at + SLOW_KEEP)).toBe(false);
  });

  test("読めない値と、先の時刻は効かない", () => {
    expect(slowAt("", at)).toBe(false);
    expect(slowAt("abc", at)).toBe(false);
    expect(slowAt("-1", at)).toBe(false);
    expect(slowAt(String(at + 1), at)).toBe(false);
  });
});
