import { describe, expect, test } from "bun:test";

import { irdIdOf } from "./ird";

/** データ放送の `getIRDID(type)` に返す B-CAS カードの番号 (`irdIdOf`) */
describe("getIRDID に返すカードの番号", () => {
  test("種別 5 には、48 ビットの番号を 16 進 12 桁 (大文字) で返す", () => {
    expect(irdIdOf(5, "0000000000000255")).toBe("0000000000FF");
    expect(irdIdOf(5, "0281474976710655")).toBe("FFFFFFFFFFFF");
  });

  test("ほかの種別、番号が無い・形式が違う・48 ビットを超える番号は null", () => {
    expect(irdIdOf(0, "0000000000000255")).toBeNull();
    expect(irdIdOf(5, null)).toBeNull();
    expect(irdIdOf(5, "12-34")).toBeNull();
    expect(irdIdOf(5, "0281474976710656")).toBeNull();
  });
});
