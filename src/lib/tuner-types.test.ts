import { describe, expect, test } from "bun:test";

import { receives, showsSky, unreceivable } from "./tuner-types";

describe("機材が受けられる種別", () => {
  test("BS/CS 専用の受信機では GR だけが受けられない", () => {
    expect(unreceivable(["GR"], ["BS", "CS"])).toEqual(["GR"]);
    expect(unreceivable(["GR", "BS"], ["BS", "CS"])).toEqual(["GR"]);
    expect(unreceivable(["BS", "CS"], ["BS", "CS"])).toEqual([]);
    expect(receives(["BS", "CS"], "GR")).toBe(false);
    expect(receives(["BS", "CS"], "CS")).toBe(true);
  });

  test("分からない機材 (null・古いエージェント) は地上波・BS・CS を受けられるものとして扱う", () => {
    expect(unreceivable(["GR", "BS", "CS"], null)).toEqual([]);
    expect(unreceivable(["GR"], undefined)).toEqual([]);
    expect(receives(null, "GR")).toBe(true);
  });

  test("SKY は receivable に SKY がある機材だけが受けられる", () => {
    expect(receives(["GR", "BS", "CS", "SKY"], "SKY")).toBe(true);
    expect(receives(["GR", "BS", "CS"], "SKY")).toBe(false);
    expect(receives(null, "SKY")).toBe(false);
    expect(receives(undefined, "SKY")).toBe(false);
    expect(unreceivable(["GR", "SKY"], null)).toEqual(["SKY"]);
  });
});

describe("受信の設定に SKY を並べるか", () => {
  test("SKY を受けられる機材も SKY を選んだチューナーも無ければ並べない", () => {
    expect(showsSky([])).toBe(false);
    expect(
      showsSky([
        { types: ["GR"], receivable: ["GR"] },
        { types: ["BS", "CS"], receivable: null },
        { types: ["GR"] },
      ]),
    ).toBe(false);
  });

  test("SKY を受けられる機材があれば、まだ選んでいなくても並べる", () => {
    expect(
      showsSky([{ types: ["GR"], receivable: ["GR", "BS", "CS", "SKY"] }]),
    ).toBe(true);
  });

  test("SKY を選んだチューナーがあれば、機材が分からなくても並べる (保存で SKY が外れないように)", () => {
    expect(showsSky([{ types: ["SKY"], receivable: null }])).toBe(true);
  });
});
