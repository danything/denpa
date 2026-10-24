import { afterEach, describe, expect, test } from "bun:test";

import { forgetGrants, grant, originOf, TOKEN } from "./hc-relay";

afterEach(() => forgetGrants());

describe("hc-relay", () => {
  test("合言葉は推測できない形で、出した配信元を返す", () => {
    const a = grant("http://hc.example.jp", 0);
    const b = grant("http://hc.example.jp", 0);
    expect(a).toMatch(TOKEN);
    expect(a).not.toBe(b);
    expect(originOf(a, 1)).toBe("http://hc.example.jp");
    expect(originOf("0".repeat(32), 1)).toBeNull();
  });

  test("6 時間で切れる", () => {
    const token = grant("http://hc.example.jp", 0);
    expect(originOf(token, 6 * 60 * 60 * 1000 - 1)).toBe(
      "http://hc.example.jp",
    );
    expect(originOf(token, 6 * 60 * 60 * 1000)).toBeNull();
  });

  test("覚えるのは 64 個まで。古いほうから捨てる", () => {
    const first = grant("http://a.example", 0);
    for (let i = 0; i < 64; i++) grant("http://b.example", 0);
    expect(originOf(first, 1)).toBeNull();
  });
});
