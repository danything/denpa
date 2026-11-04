import { describe, expect, test } from "bun:test";

import { parseRung, rungLabel } from "./rungs";

describe("段", () => {
  test("クエリの文字列も数も段として読み、読めない値は 0 にする", () => {
    expect(parseRung("2")).toBe(2);
    expect(parseRung(3)).toBe(3);
    expect(parseRung("4")).toBe(0);
    expect(parseRung(null)).toBe(0);
    expect(parseRung("1.5")).toBe(0);
  });

  test("名前は高さで出し、段 0 には付けない", () => {
    expect(rungLabel(2)).toBe("540p");
    expect(rungLabel(0)).toBeNull();
  });
});
