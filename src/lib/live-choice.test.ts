import { describe, expect, test } from "bun:test";

import { autoCodec, autoOrder, readChoice } from "./live-choice";

const all = { rawOk: true, av1: true, hevc: true, h264: true };
const where = { indoor: false, compat: false };

/** **「自動」の順** (`autoOrder`)。ライブ・追っかけ・録画の観る画面で同じ関数から出す */
describe("自動の順", () => {
  test("その場でエンコードする家の中は MPEG-2 → H.264 → AV1 → H.265 (開くまでの速さ)", () => {
    expect(autoOrder({ indoor: true, compat: false })).toEqual([
      "raw",
      "h264",
      "av1",
      "hevc",
    ]);
  });

  test("外は AV1 → H.265 → H.264 (回線)", () => {
    expect(autoOrder(where)).toEqual(["av1", "hevc", "h264"]);
  });

  test("互換モードは家の中でも外でも AV1 → H.264 → MPEG-2", () => {
    for (const indoor of [true, false])
      expect(autoOrder({ indoor, compat: true })).toEqual([
        "av1",
        "h264",
        "raw",
      ]);
  });

  test("エンコード済み (録画の観る画面) は小さい順 AV1 → H.265 → H.264", () => {
    expect(autoOrder("encoded")).toEqual(["av1", "hevc", "h264"]);
  });
});

/** **ライブと追っかけの「自動」の形式** (`autoCodec`)。`autoOrder` の順で、使えるものの先頭 */
describe("自動の形式", () => {
  test("家の中は MPEG-2、使えなければ H.264 → AV1 → H.265", () => {
    const indoor = { ...where, indoor: true };
    expect(autoCodec({ ...all, ...indoor })).toBe("raw");
    expect(autoCodec({ ...all, ...indoor, rawOk: false })).toBe("h264");
    expect(autoCodec({ ...all, ...indoor, rawOk: false, h264: false })).toBe(
      "av1",
    );
    expect(
      autoCodec({ ...all, ...indoor, rawOk: false, h264: false, av1: false }),
    ).toBe("hevc");
  });

  test("外は AV1 → H.265 → H.264。MPEG-2 は使えても選ばない", () => {
    expect(autoCodec({ ...all, ...where })).toBe("av1");
    expect(autoCodec({ ...all, ...where, av1: false })).toBe("hevc");
    expect(autoCodec({ ...all, ...where, av1: false, hevc: false })).toBe(
      "h264",
    );
    expect(
      autoCodec({ ...all, ...where, av1: false, hevc: false, h264: false }),
    ).toBe(null);
  });

  test("互換モードは AV1 → H.264 → MPEG-2。H.265 は使えても選ばない", () => {
    for (const indoor of [true, false]) {
      const compat = { indoor, compat: true };
      expect(autoCodec({ ...all, ...compat })).toBe("av1");
      expect(autoCodec({ ...all, ...compat, av1: false })).toBe("h264");
      expect(autoCodec({ ...all, ...compat, av1: false, h264: false })).toBe(
        "raw",
      );
      expect(
        autoCodec({
          rawOk: false,
          av1: false,
          hevc: true,
          h264: false,
          ...compat,
        }),
      ).toBe(null);
    }
  });

  test("追っかけは H.265 を外すだけ (家の中なら MPEG-2 → H.264 → AV1)", () => {
    const chase = { ...all, hevc: false, indoor: true, compat: false };
    expect(autoCodec(chase)).toBe("raw");
    expect(autoCodec({ ...chase, rawOk: false })).toBe("h264");
    expect(autoCodec({ ...chase, rawOk: false, h264: false })).toBe("av1");
    expect(autoCodec({ ...chase, rawOk: false, h264: false, av1: false })).toBe(
      null,
    );
  });
});

describe("覚えていた選択の読み方", () => {
  test("自動・AV1・MPEG-2 はそのまま", () => {
    for (const choice of ["auto", "av1", "raw"] as const)
      expect(readChoice(choice)).toBe(choice);
  });

  test("知らない値・前の形式 (選択が無い) は自動", () => {
    expect(readChoice(undefined)).toBe("auto");
    expect(readChoice("vp9")).toBe("auto");
    expect(readChoice(3)).toBe("auto");
  });

  test("メニューに並べない H.264 と H.265 を選んでいた端末も自動", () => {
    expect(readChoice("h264")).toBe("auto");
    expect(readChoice("hevc")).toBe("auto");
  });
});
