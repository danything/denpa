import { describe, expect, test } from "bun:test";

import { decodable, shownTypes } from "./types";

describe("種別", () => {
  test("受信の設定に並べる種別は、SKY を受けられる機材があるときだけスカパー！プレミアムを足す", () => {
    expect(shownTypes(false)).toEqual(["GR", "BS", "CS"]);
    expect(shownTypes(true)).toEqual(["GR", "BS", "CS", "SKY"]);
  });

  test("復号できないのは SKY だけ", () => {
    expect(["GR", "BS", "CS", "SKY"].filter(decodable)).toEqual([
      "GR",
      "BS",
      "CS",
    ]);
  });
});
