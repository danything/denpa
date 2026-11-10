import { describe, expect, test } from "bun:test";

import { decodableService, origin, shownTypes } from "./types";

describe("種別", () => {
  test("受信の設定に並べる種別は、CATV と SKY を受けられる機材があるときだけ足す", () => {
    expect(shownTypes([])).toEqual(["GR", "BS", "CS"]);
    expect(shownTypes(["SKY"])).toEqual(["GR", "BS", "CS", "SKY"]);
    // 並びはいつも 地上波 → BS → CS → CATV → SKY
    expect(shownTypes(["SKY", "CATV"])).toEqual([
      "GR",
      "BS",
      "CS",
      "CATV",
      "SKY",
    ]);
  });

  test("復号できないのは SKY と、B-CAS 以外の CA_system_id しか無い局", () => {
    expect(decodableService("GR", [])).toBe(true);
    expect(decodableService("SKY", [])).toBe(false);
    // CA 記述子の無い CATV の局 (スクランブルされていない) と、B-CAS の局は復号できる
    expect(decodableService("CATV", [])).toBe(true);
    expect(decodableService("CATV", [0x0005])).toBe(true);
    expect(decodableService("CATV", [0x0005, 0x000a])).toBe(true);
    expect(decodableService("CATV", [0x000a])).toBe(false);
  });

  test("局の元の放送を original_network_id で見分ける", () => {
    expect(origin(4)).toBe("BS");
    expect(origin(6)).toBe("CS");
    expect(origin(7)).toBe("CS");
    expect(origin(0x7880)).toBe("GR");
    expect(origin(32391)).toBe("GR");
    expect(origin(0x7fe8)).toBe("GR");
    // ケーブルテレビの自主放送
    expect(origin(0x7fe9)).toBe("CATV");
    expect(origin(0x787f)).toBe("CATV");
    expect(origin(1)).toBe("CATV");
  });
});
