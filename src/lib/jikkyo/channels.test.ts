import { describe, expect, test } from "bun:test";

import { jikkyoChannel } from "./channels";
import { TERRESTRIAL } from "./terrestrial";

/*
 * 局と実況のチャンネルの対応表。どれも局の番号 (service_id) で引く
 */

const gr = (service_id: number) =>
  jikkyoChannel({ type: "GR", service_id, network_id: 0x7fe0 });

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

  test("サブチャンネルは当てない (たいてい本チャンネルと別の番組)", () => {
    // NHK 総合 2・東京、E テレ 3 東京、TOKYO MX2
    expect(gr(1025)).toBeNull();
    expect(gr(1034)).toBeNull();
    expect(gr(23610)).toBeNull();
  });

  test("表に無い局はコメントなし", () => {
    // 奈良テレビ (独立局。NX-Jikkyo にチャンネルが無い)
    expect(gr(0xb030)).toBeNull();
    expect(gr(1)).toBeNull();
  });

  test("BS・CS は局の番号で引く。サブチャンネルは当てない", () => {
    const bs = (service_id: number) =>
      jikkyoChannel({ type: "BS", service_id, network_id: 4 });
    expect(bs(101)).toBe("jk101");
    expect(bs(102)).toBeNull();
    expect(bs(142)).toBeNull();
    expect(bs(211)).toBe("jk211");
    expect(bs(231)).toBeNull();
    expect(jikkyoChannel({ type: "CS", service_id: 333, network_id: 7 })).toBe(
      "jk333",
    );
    // 地上波の番号でも、BS の局は BS の表でしか引かない
    expect(
      jikkyoChannel({ type: "BS", service_id: 1024, network_id: 4 }),
    ).toBeNull();
  });

  test("ケーブルの再送信は元の放送の表で引き、自主放送は当てない", () => {
    const catv = (service_id: number, network_id: number) =>
      jikkyoChannel({ type: "CATV", service_id, network_id });
    // BSよしもと (BS の再送信)、TBS (地上波の再送信)、ショップチャンネル (CS の再送信)
    expect(catv(265, 4)).toBe("jk265");
    expect(catv(1048, 0x7fe0)).toBe("jk6");
    expect(catv(333, 7)).toBe("jk333");
    // ケーブルの自主放送 (ネットワークの番号が放送のどれでもない)
    expect(catv(101, 0x0031)).toBeNull();
  });

  test("地上波の表は NX-Jikkyo の地上波のチャンネル (jk1〜14、jk3 は無い) だけを指す", () => {
    for (const jk of TERRESTRIAL.values()) {
      expect(jk >= 1 && jk <= 14 && jk !== 3, String(jk)).toBe(true);
    }
  });
});
