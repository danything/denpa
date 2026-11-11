import { describe, expect, test } from "bun:test";

import { extraTypes, receives, unreceivable } from "./tuner-types";

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

  test("CATV と SKY は receivable にその種別がある機材だけが受けられる", () => {
    expect(receives(["GR", "BS", "CS", "SKY"], "SKY")).toBe(true);
    expect(receives(["GR", "BS", "CS"], "SKY")).toBe(false);
    expect(receives(null, "SKY")).toBe(false);
    expect(receives(undefined, "SKY")).toBe(false);
    expect(receives(["GR", "CATV"], "CATV")).toBe(true);
    expect(receives(["GR", "BS", "CS"], "CATV")).toBe(false);
    expect(receives(null, "CATV")).toBe(false);
    expect(unreceivable(["GR", "SKY", "CATV"], null)).toEqual(["SKY", "CATV"]);
  });
});

describe("受信の設定に足して並べる種別", () => {
  test("CATV と SKY を受けられる機材も選んだチューナーも無ければ足さない", () => {
    expect(extraTypes([])).toEqual([]);
    expect(
      extraTypes([
        { types: ["GR"], receivable: ["GR"] },
        { types: ["BS", "CS"], receivable: null },
        { types: ["GR"] },
      ]),
    ).toEqual([]);
  });

  test("受けられる機材があれば、まだ選んでいなくても足す", () => {
    expect(
      extraTypes([{ types: ["GR"], receivable: ["GR", "BS", "CS", "SKY"] }]),
    ).toEqual(["SKY"]);
    expect(
      extraTypes([{ types: ["GR"], receivable: ["GR", "CATV", "SKY"] }]),
    ).toEqual(["SKY", "CATV"]);
  });

  test("選んだチューナーがあれば、機材が分からなくても足す (保存でその種別が外れないように)", () => {
    expect(extraTypes([{ types: ["SKY"], receivable: null }])).toEqual(["SKY"]);
    expect(extraTypes([{ types: ["CATV"], receivable: null }])).toEqual([
      "CATV",
    ]);
  });
});
