import { describe, expect, test } from "bun:test";

import { parseId } from "./id";

/** 行の ID の読み方 (画面のアクションと API で同じ)。`Number()` だけでは空が 0、指数や 16 進も数になっていた */
describe("行の ID を読む (parseId)", () => {
  test("10 進の整数だけを読む。負の数も (取り込んだ録画の番組 ID)", () => {
    expect(parseId("12")).toBe(12);
    expect(parseId("0")).toBe(0);
    expect(parseId("-34")).toBe(-34);
    expect(parseId("3239123608")).toBe(3239123608);
  });

  test("空・小数・指数・16 進・空白付き・桁あふれ・文字列でないものは null", () => {
    for (const value of [
      "",
      "1.5",
      "1e3",
      "0x10",
      " 1",
      "1 ",
      "abc",
      "9007199254740993",
      null,
      undefined,
      12,
    ])
      expect(parseId(value)).toBeNull();
  });
});
