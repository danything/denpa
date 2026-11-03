import { describe, expect, test } from "bun:test";

import { autoCodec, readChoice } from "./live-choice";

const all = { rawOk: true, av1: true, hevc: true, h264: true };
const where = { indoor: false, compat: false, chase: false };

/** **「自動」の形式** (`autoCodec`)。家の中は MPEG-2、外は AV1、使えなければ順に次へ */
describe("自動の形式", () => {
  test("家の中は MPEG-2 → AV1 → H.265 → H.264", () => {
    const indoor = { ...where, indoor: true };
    expect(autoCodec({ ...all, ...indoor })).toBe("raw");
    expect(autoCodec({ ...all, ...indoor, rawOk: false })).toBe("av1");
    expect(autoCodec({ ...all, ...indoor, rawOk: false, av1: false })).toBe(
      "hevc",
    );
    expect(
      autoCodec({
        ...all,
        ...indoor,
        rawOk: false,
        av1: false,
        hevc: false,
      }),
    ).toBe("h264");
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

  test("H.265 を出せない (ライブのエンコーダが GPU でない) なら、AV1 の次は H.264", () => {
    expect(autoCodec({ ...all, ...where, av1: false, hevc: false })).toBe(
      "h264",
    );
    expect(
      autoCodec({
        ...all,
        ...where,
        indoor: true,
        rawOk: false,
        av1: false,
        hevc: false,
      }),
    ).toBe("h264");
  });

  test("互換モードは家の中でも外でも AV1 → H.264 → MPEG-2。H.265 は使えても選ばない", () => {
    for (const indoor of [true, false]) {
      const compat = { ...where, indoor, compat: true };
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

  test("追っかけに MPEG-2 と H.265 は無い。家の中でも互換モードでも AV1 → H.264", () => {
    for (const extra of [{ indoor: true }, { compat: true }]) {
      const chase = { ...where, chase: true, ...extra };
      expect(autoCodec({ ...all, ...chase })).toBe("av1");
      expect(autoCodec({ ...all, ...chase, av1: false })).toBe("h264");
      expect(autoCodec({ ...all, ...chase, av1: false, h264: false })).toBe(
        null,
      );
    }
  });
});

describe("覚えていた選択の読み方", () => {
  test("自動・AV1・H.265・H.264・MPEG-2 はそのまま", () => {
    for (const choice of ["auto", "av1", "hevc", "h264", "raw"] as const)
      expect(readChoice(choice, false)).toBe(choice);
  });

  test("知らない値・前の形式 (選択が無い) は自動", () => {
    expect(readChoice(undefined, false)).toBe("auto");
    expect(readChoice("vp9", false)).toBe("auto");
    expect(readChoice(3, false)).toBe("auto");
  });

  test("H.264 と H.265 を出さない設定では、それを選んでいた端末も自動", () => {
    expect(readChoice("h264", true)).toBe("auto");
    expect(readChoice("hevc", true)).toBe("auto");
    expect(readChoice("av1", true)).toBe("av1");
    expect(readChoice("raw", true)).toBe("raw");
  });
});
