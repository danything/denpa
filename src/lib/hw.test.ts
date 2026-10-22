import { describe, expect, test } from "bun:test";
import {
  chooseHw,
  HW_EVERY,
  HW_SOFTWARE,
  type HwAllow,
  type HwUsable,
  hwAllowed,
  hwChoice,
} from "./hw";

/*
 * 設定画面ではコーデックごとにエンコーダを1つ選ぶ (`hwChoice` / `chooseHw`)。
 * 持ち方はデバイス × 方式 × コーデックの `hwAllow` のまま
 */
const A: HwUsable = {
  path: "/dev/dri/renderD128",
  qsv: ["av1", "h264"],
  vaapi: ["av1", "h264"],
};
/** AV1 をエンコードできない (Arc より前) */
const B: HwUsable = {
  path: "/dev/dri/renderD129",
  qsv: ["h264"],
  vaapi: ["h264"],
};

describe("エンコーダの選択", () => {
  test("何も設定していなければ、使えるデバイスを全部使う", () => {
    expect(hwChoice({}, [A], "av1")).toBe(A.path);
    expect(hwChoice({}, [A, B], "av1")).toBe(A.path);
    expect(hwChoice({}, [A, B], "h264")).toBe(HW_EVERY);
    expect(hwChoice({}, [], "h264")).toBe(HW_SOFTWARE);
  });

  test("ソフトウェアを選ぶと、そのコーデックの印だけ外れる", () => {
    const next = chooseHw({}, [A, B], "h264", HW_SOFTWARE);
    expect(hwChoice(next, [A, B], "h264")).toBe(HW_SOFTWARE);
    expect(hwChoice(next, [A, B], "av1")).toBe(A.path);
    expect(next[A.path]).toEqual({ qsv: ["av1"], vaapi: ["av1"] });
  });

  test("デバイスを選ぶと、ほかのデバイスの印が外れる", () => {
    const next = chooseHw({}, [A, B], "h264", B.path);
    expect(hwChoice(next, [A, B], "h264")).toBe(B.path);
    expect(hwAllowed(next, A.path, "qsv", "h264")).toBe(false);
    expect(hwAllowed(next, A.path, "qsv", "av1")).toBe(true);
  });

  test("ソフトウェアから戻すと、使える方式すべてに印が付く", () => {
    const off = chooseHw({}, [A], "av1", HW_SOFTWARE);
    const next = chooseHw(off, [A], "av1", A.path);
    expect(next[A.path]).toEqual({
      qsv: ["av1", "h264"],
      vaapi: ["av1", "h264"],
    });
  });

  test("すでに選んであるデバイスは、方式ごとの印を崩さない", () => {
    const allow: HwAllow = {
      [A.path]: { qsv: ["h264"], vaapi: ["av1", "h264"] },
    };
    expect(hwChoice(allow, [A], "av1")).toBe(A.path);
    expect(chooseHw(allow, [A], "av1", A.path)).toEqual(allow);
  });

  test("いま見えていないデバイスの印は前のまま", () => {
    const allow: HwAllow = {
      "/dev/dri/renderD130": { qsv: [], vaapi: ["h264"] },
    };
    expect(
      chooseHw(allow, [A], "h264", HW_SOFTWARE)["/dev/dri/renderD130"],
    ).toEqual({
      qsv: [],
      vaapi: ["h264"],
    });
  });
});
