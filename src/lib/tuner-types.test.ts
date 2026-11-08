import { describe, expect, test } from "bun:test";

import { receives, unreceivable } from "./tuner-types";

describe("機材が受けられる種別", () => {
  test("BS/CS 専用の受信機では GR だけが受けられない", () => {
    expect(unreceivable(["GR"], ["BS", "CS"])).toEqual(["GR"]);
    expect(unreceivable(["GR", "BS"], ["BS", "CS"])).toEqual(["GR"]);
    expect(unreceivable(["BS", "CS"], ["BS", "CS"])).toEqual([]);
    expect(receives(["BS", "CS"], "GR")).toBe(false);
    expect(receives(["BS", "CS"], "CS")).toBe(true);
  });

  test("分からない機材 (null・古いエージェント) はどれも受けられるものとして扱う", () => {
    expect(unreceivable(["GR", "BS", "CS"], null)).toEqual([]);
    expect(unreceivable(["GR"], undefined)).toEqual([]);
    expect(receives(null, "GR")).toBe(true);
  });
});
