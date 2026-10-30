import { describe, expect, test } from "bun:test";

import { jikkyoChannel } from "./channels";
import { TERRESTRIAL } from "./terrestrial";

/*
 * 局と実況のチャンネルの対応表。どれも局の番号 (service_id) で引く
 */

const gr = (service_id: number) => jikkyoChannel({ type: "GR", service_id });

describe("jikkyoChannel", () => {
  test("関東の局", () => {
    expect(gr(1024)).toBe("jk1");
    expect(gr(1032)).toBe("jk2");
    expect(gr(1040)).toBe("jk4");
    expect(gr(1048)).toBe("jk6");
    expect(gr(1056)).toBe("jk8");
    expect(gr(23608)).toBe("jk9");
  });

  test("系列の地方局と、NX-Jikkyo にチャンネルのある独立局", () => {
    // MBS 毎日放送 → TBS 系
    expect(gr(2064)).toBe("jk6");
    expect(gr(41008)).toBe("jk7");
    expect(gr(43056)).toBe("jk13");
    expect(gr(42032)).toBe("jk14");
  });

  test("サブチャンネルは本チャンネルに当たる (1 つ前・2 つ前の番号)", () => {
    // NHK 総合 2・東京、E テレ 3 東京
    expect(gr(1025)).toBe("jk1");
    expect(gr(1034)).toBe("jk2");
    // TOKYO MX2 は表に載っている
    expect(gr(23610)).toBe("jk9");
  });

  test("表に無い局はコメントなし", () => {
    // 奈良テレビ (独立局。NX-Jikkyo にチャンネルが無い)
    expect(gr(0xb030)).toBeNull();
    expect(gr(1)).toBeNull();
  });

  test("BS・CS は局の番号で引く。サブチャンネルも同じチャンネル", () => {
    const bs = (service_id: number) =>
      jikkyoChannel({ type: "BS", service_id });
    expect(bs(101)).toBe("jk101");
    expect(bs(102)).toBe("jk101");
    expect(bs(142)).toBe("jk141");
    expect(bs(211)).toBe("jk211");
    expect(bs(231)).toBeNull();
    expect(jikkyoChannel({ type: "CS", service_id: 333 })).toBe("jk333");
    // 地上波の番号でも、BS の局は BS の表でしか引かない
    expect(jikkyoChannel({ type: "BS", service_id: 1024 })).toBeNull();
  });

  test("地上波の表は NX-Jikkyo の地上波のチャンネル (jk1〜14、jk3 は無い) だけを指す", () => {
    for (const jk of TERRESTRIAL.values()) {
      expect(jk >= 1 && jk <= 14 && jk !== 3, String(jk)).toBe(true);
    }
  });
});
