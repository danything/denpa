import { describe, expect, test } from "bun:test";

import {
  avcSliceType,
  nalLengthSize,
  sliceType,
  startable,
} from "./random-access";

/** 長さ 4 バイトの NAL を並べたコマ。NAL は先頭のバイトだけ意味を持たせる */
function frame(...heads: number[][]): Uint8Array {
  const out: number[] = [];
  for (const nal of heads) out.push(0, 0, 0, nal.length, ...nal);
  return Uint8Array.from(out);
}

/** H.264 の NAL の先頭のバイト (nal_ref_idc 3) */
const avc = (type: number): number[] => [0x60 | type, 0x88];
/** H.265 の NAL の先頭の 2 バイト */
const hevc = (type: number): number[] => [type << 1, 0x01, 0xaf];

describe("nalLengthSize", () => {
  test("avcC の 5 バイト目・hvcC の 22 バイト目の下 2 ビットから読む", () => {
    expect(
      nalLengthSize("h264", Uint8Array.from([1, 0x64, 0, 0x2a, 0xff])),
    ).toBe(4);
    const hvcc = new Uint8Array(23);
    hvcc[21] = 0x0f;
    expect(nalLengthSize("hevc", hvcc)).toBe(4);
    hvcc[21] = 0x0d;
    expect(nalLengthSize("hevc", hvcc)).toBe(2);
    expect(nalLengthSize("h264", new Uint8Array(4))).toBeNull();
  });
});

describe("sliceType", () => {
  test("パラメータセットと SEI を飛ばして、最初のスライスの種類を返す", () => {
    expect(
      sliceType("h264", frame(avc(9), avc(7), avc(8), avc(6), avc(5)), 4),
    ).toBe(5);
    expect(
      sliceType(
        "hevc",
        frame(hevc(35), hevc(32), hevc(33), hevc(34), hevc(39), hevc(21)),
        4,
      ),
    ).toBe(21);
  });

  test("スライスが無い・長さが壊れていれば null", () => {
    expect(sliceType("h264", frame(avc(7), avc(8)), 4)).toBeNull();
    expect(
      sliceType("h264", Uint8Array.from([0, 0, 0, 9, 0x65]), 4),
    ).toBeNull();
  });
});

/** H.264 の P のスライス (first_mb_in_slice 0・slice_type 5) */
const avcP = (type: number): number[] => [0x40 | type, 0x9a];

describe("avcSliceType", () => {
  test("first_mb_in_slice の後ろの slice_type を読む", () => {
    // 1 0001000 → first_mb 0・slice_type 7 (I)
    expect(avcSliceType(Uint8Array.from([0x65, 0x88]))).toBe(7);
    // 1 00110 10 → slice_type 5 (P)
    expect(avcSliceType(Uint8Array.from([0x41, 0x9a]))).toBe(5);
    expect(avcSliceType(Uint8Array.from([0x41]))).toBeNull();
  });

  test("エミュレーション防止の 0x03 を飛ばす", () => {
    // first_mb_in_slice が 65535 (先頭に 0 が 16 ビット続く) と、そこに挟まる 0x00 0x00 0x03
    expect(
      avcSliceType(
        Uint8Array.from([0x41, 0x00, 0x00, 0x03, 0x80, 0x00, 0x08, 0x80]),
      ),
    ).toBe(7);
  });
});

describe("startable", () => {
  test("H.264 は IDR と、スライスが全部 I のコマ (open GOP の回復点)", () => {
    expect(startable("h264", 4, frame(avc(6), avc(5)))).toBe(true);
    expect(startable("h264", 4, frame(avc(6), avc(1)))).toBe(true);
  });

  test("H.264 の P のコマ (intra-refresh の回復点) からは始めない", () => {
    expect(startable("h264", 4, frame(avc(6), avcP(1)))).toBe(false);
    // I と P が混ざったコマも始めない
    expect(startable("h264", 4, frame(avc(1), avcP(1)))).toBe(false);
  });

  test("H.265 は IRAP (後ろに RASL が続く CRA も)", () => {
    expect(startable("hevc", 4, frame(hevc(19)))).toBe(true);
    expect(startable("hevc", 4, frame(hevc(20)))).toBe(true);
    expect(startable("hevc", 4, frame(hevc(21)))).toBe(true);
    expect(startable("hevc", 4, frame(hevc(16)))).toBe(true);
    expect(startable("hevc", 4, frame(hevc(1)))).toBe(false);
  });

  test("読めないコマからは始めない", () => {
    expect(startable("h264", 4, new Uint8Array(0))).toBe(false);
  });
});
