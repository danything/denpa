import { describe, expect, test } from "bun:test";

import { jikkyoChannel, TERRESTRIAL } from "./channels";

/*
 * 局と実況のチャンネルの対応表。地上波は局の名前 (放送のとおり全角混じり)、BS・CS は局の番号で引く
 */

const gr = (name: string) => jikkyoChannel({ type: "GR", service_id: 1, name });

describe("jikkyoChannel", () => {
  test("関東の局は、放送の名前 (全角・空白入り) のままで当たる", () => {
    expect(gr("ＮＨＫ総合１・東京")).toBe("jk1");
    expect(gr("ＮＨＫＥテレ１東京")).toBe("jk2");
    expect(gr("日テレ１")).toBe("jk4");
    expect(gr("テレビ朝日")).toBe("jk5");
    expect(gr("ＴＢＳ１")).toBe("jk6");
    expect(gr("テレビ東京１")).toBe("jk7");
    expect(gr("フジテレビ")).toBe("jk8");
    expect(gr("ＴＯＫＹＯ　ＭＸ１")).toBe("jk9");
    expect(gr("テレ玉")).toBe("jk10");
    expect(gr("ｔｖｋ")).toBe("jk11");
    expect(gr("チバテレ")).toBe("jk12");
  });

  test("系列の地方局はキー局のチャンネルに当たる", () => {
    expect(gr("ＭＢＳ毎日放送")).toBe("jk6");
    expect(gr("ＡＢＣテレビ")).toBe("jk5");
    expect(gr("関西テレビ")).toBe("jk8");
    expect(gr("読売テレビ")).toBe("jk4");
    expect(gr("テレビ大阪")).toBe("jk7");
    expect(gr("メ～テレ")).toBe("jk5");
    expect(gr("ＮＨＫ総合・大阪")).toBe("jk1");
    expect(gr("サンテレビ")).toBe("jk13");
    expect(gr("ＫＢＳ京都")).toBe("jk14");
  });

  test("長い名前から当てる (「朝日放送」を含む別の局名でも、その局の名前で当たる)", () => {
    expect(gr("青森朝日放送")).toBe("jk5");
    // 「九州放送」(TVQ) は「九州朝日放送」の中に無い
    expect(gr("九州朝日放送")).toBe("jk5");
    expect(gr("ＴＶＱ九州放送")).toBe("jk7");
    expect(gr("北海道文化放送")).toBe("jk8");
    expect(gr("北海道放送")).toBe("jk6");
  });

  test("表に無い局はコメントなし", () => {
    expect(gr("奈良テレビ")).toBeNull();
    expect(gr("放送大学")).toBeNull();
  });

  test("BS・CS は局の番号で引く。サブチャンネルも同じチャンネル", () => {
    const bs = (service_id: number) =>
      jikkyoChannel({ type: "BS", service_id, name: "" });
    expect(bs(101)).toBe("jk101");
    expect(bs(102)).toBe("jk101");
    expect(bs(142)).toBe("jk141");
    expect(bs(211)).toBe("jk211");
    expect(bs(231)).toBeNull();
    expect(jikkyoChannel({ type: "CS", service_id: 333, name: "" })).toBe(
      "jk333",
    );
    // 地上波の名前でも、BS の局は番号でしか引かない
    expect(jikkyoChannel({ type: "BS", service_id: 999, name: "ＴＢＳ" })).toBe(
      null,
    );
  });

  test("表の名前はどれも、そのチャンネルに当たる (別の系列の名前に食われない)", () => {
    for (const [channel, names] of Object.entries(TERRESTRIAL))
      for (const name of names) expect(gr(name), name).toBe(channel);
  });

  test("表に同じ名前が 2 度出てこない", () => {
    const all = Object.values(TERRESTRIAL).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
