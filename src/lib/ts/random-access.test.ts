import { describe, expect, test } from "bun:test";

import { cleanStart, nalLengthSize, sliceType } from "./random-access";

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

describe("cleanStart", () => {
  test("H.264 は IDR だけ。印の付いた IDR でない I (回復点の SEI 付き) からは始めない", () => {
    expect(cleanStart("h264", 4, frame(avc(6), avc(5)), null)).toBe(true);
    expect(cleanStart("h264", 4, frame(avc(6), avc(1)), frame(avc(1)))).toBe(
      false,
    );
  });

  test("H.265 は IDR と、後ろに RASL が続かない CRA", () => {
    expect(cleanStart("hevc", 4, frame(hevc(19)), frame(hevc(8)))).toBe(true);
    expect(cleanStart("hevc", 4, frame(hevc(20)), null)).toBe(true);
    expect(cleanStart("hevc", 4, frame(hevc(21)), frame(hevc(1)))).toBe(true);
    expect(cleanStart("hevc", 4, frame(hevc(21)), frame(hevc(8)))).toBe(false);
    expect(cleanStart("hevc", 4, frame(hevc(1)), frame(hevc(1)))).toBe(false);
  });

  test("読めないコマからは始めない", () => {
    expect(cleanStart("h264", 4, new Uint8Array(0), null)).toBe(false);
  });
});
