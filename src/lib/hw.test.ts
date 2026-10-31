import { describe, expect, test } from "bun:test";

import {
  chooseHw,
  HW_EVERY,
  HW_SOFTWARE,
  type HwAllow,
  hwAllowed,
  hwChoice,
  type HwUsable,
} from "./hw";

/*
 * 設定画面ではコーデックごとにエンコーダを1つ選ぶ (`hwChoice` / `chooseHw`)。
 * 持ち方はデバイス × 方式 × コーデックの `hwAllow` のまま
 */
const A: HwUsable = {
  path: "/dev/dri/renderD128",
  qsv: ["av1", "h264"],
  vaapi: ["av1", "h264"],
  rkmpp: [],
  nvenc: [],
};
/** AV1 をエンコードできない (Arc より前) */
const B: HwUsable = {
  path: "/dev/dri/renderD129",
  qsv: ["h264"],
  vaapi: ["h264"],
  rkmpp: [],
  nvenc: [],
};
/** Rockchip MPP (`/dev/mpp_service`)。H.264 だけ */
const R: HwUsable = {
  path: "/dev/mpp_service",
  qsv: [],
  vaapi: [],
  rkmpp: ["h264"],
  nvenc: [],
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
    // A で使えない方式 (Rockchip MPP) の印は前のまま (書かれていなければ全部よい)
    expect(next[A.path]).toEqual({
      qsv: ["av1", "hevc"],
      vaapi: ["av1", "hevc"],
      rkmpp: ["av1", "hevc", "h264"],
      nvenc: ["av1", "hevc", "h264"],
    });
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
      qsv: ["av1", "hevc", "h264"],
      vaapi: ["av1", "hevc", "h264"],
      rkmpp: ["av1", "hevc", "h264"],
      nvenc: ["av1", "hevc", "h264"],
    });
  });

  test("H.265 のエンコーダを選んでも、ほかのコーデックの印は崩さない。並びは AV1 → H.265 → H.264", () => {
    // A は H.264 だけ GPU、AV1 はソフトウェアにしてある。H.265 を B だけに寄せる
    const allow: HwAllow = {
      [A.path]: { qsv: ["h264"], vaapi: ["h264"], rkmpp: [], nvenc: [] },
    };
    const C: HwUsable = {
      ...A,
      path: "/dev/dri/renderD130",
      qsv: ["hevc"],
      vaapi: ["hevc"],
    };
    const D: HwUsable = {
      ...A,
      qsv: ["av1", "hevc", "h264"],
      vaapi: ["av1", "hevc", "h264"],
    };
    const next = chooseHw(allow, [D, C], "hevc", C.path);
    expect(hwChoice(next, [D, C], "hevc")).toBe(C.path);
    expect(next[D.path]).toEqual(allow[D.path]);
    const back = chooseHw(next, [D, C], "hevc", HW_EVERY);
    expect(back[D.path]).toEqual({
      qsv: ["hevc", "h264"],
      vaapi: ["hevc", "h264"],
      rkmpp: [],
      nvenc: [],
    });
  });

  test("すでに選んであるデバイスは、方式ごとの印を崩さない", () => {
    const allow: HwAllow = {
      [A.path]: { qsv: ["h264"], vaapi: ["av1", "h264"], rkmpp: [], nvenc: [] },
    };
    expect(hwChoice(allow, [A], "av1")).toBe(A.path);
    expect(chooseHw(allow, [A], "av1", A.path)).toEqual(allow);
  });

  test("いま見えていないデバイスの印は前のまま", () => {
    const allow: HwAllow = {
      "/dev/dri/renderD130": { qsv: [], vaapi: ["h264"], rkmpp: [], nvenc: [] },
    };
    expect(
      chooseHw(allow, [A], "h264", HW_SOFTWARE)["/dev/dri/renderD130"],
    ).toEqual({
      qsv: [],
      vaapi: ["h264"],
      rkmpp: [],
      nvenc: [],
    });
  });
});

describe("Rockchip MPP の選択", () => {
  test("H.264 の選択肢にだけ出て、GPU と同じく選べる", () => {
    expect(hwChoice({}, [A, R], "av1")).toBe(A.path);
    expect(hwChoice({}, [A, R], "h264")).toBe(HW_EVERY);
    const next = chooseHw({}, [A, R], "h264", R.path);
    expect(hwChoice(next, [A, R], "h264")).toBe(R.path);
    expect(hwAllowed(next, R.path, "rkmpp", "h264")).toBe(true);
    expect(hwAllowed(next, A.path, "qsv", "h264")).toBe(false);
    // AV1 は A のまま
    expect(hwChoice(next, [A, R], "av1")).toBe(A.path);
  });
});
