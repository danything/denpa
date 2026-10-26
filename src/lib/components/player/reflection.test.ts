import { describe, expect, test } from "bun:test";

import { GLANCE } from "./ambient";
import {
  reflectionLayout,
  reflectionPixels,
  storedStrength,
  STRENGTHS,
} from "./reflection";

/** 上半分が赤、下半分が青の 32x18 */
function split(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4);
  for (let y = 0; y < GLANCE.height; y++) {
    for (let x = 0; x < GLANCE.width; x++) {
      const i = (y * GLANCE.width + x) * 4;
      out.set(y < GLANCE.height / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
    }
  }
  return out;
}

describe("reflectionLayout", () => {
  test("下の段の幅を 128 画素にし、映像の横の範囲を同じ縮みで写す", () => {
    const at = reflectionLayout(
      { width: 1104, height: 441 },
      { left: 160, width: 784 },
    );
    expect(at.width).toBe(128);
    expect(at.height).toBe(Math.round((441 * 128) / 1104));
    expect(at.x).toBeCloseTo((160 * 128) / 1104);
    expect(at.w).toBeCloseTo((784 * 128) / 1104);
  });
});

describe("reflectionPixels", () => {
  const at = reflectionLayout(
    { width: 1104, height: 441 },
    { left: 160, width: 784 },
  );
  const alpha = (pixels: Uint8ClampedArray, x: number, y: number) =>
    pixels[(y * at.width + x) * 4 + 3]!;

  test("映すのは下の縁の色 (折り目の直下は映像のいちばん下の色)", () => {
    const pixels = reflectionPixels(split(), at, STRENGTHS.mid);
    const i = 64 * 4;
    expect(pixels[i + 2]).toBeGreaterThan(200);
    expect(pixels[i]).toBeLessThan(20);
  });

  test("手前ほど薄く、届く幅の先は透明", () => {
    const pixels = reflectionPixels(split(), at, STRENGTHS.weak);
    const near = alpha(pixels, 64, 0);
    const mid = alpha(pixels, 64, Math.floor(at.height * 0.3));
    expect(near).toBeGreaterThan(mid);
    expect(alpha(pixels, 64, at.height - 1)).toBe(0);
  });

  test("映像の横の外へは、にじんで消える", () => {
    const pixels = reflectionPixels(split(), at, STRENGTHS.strong);
    const y = 4;
    const inside = alpha(pixels, Math.ceil(at.x) + 1, y);
    const outside = alpha(pixels, Math.floor(at.x) - 3, y);
    expect(outside).toBeLessThan(inside);
    expect(alpha(pixels, 0, y)).toBe(0);
  });
});

test("storedStrength は分からない値をふつうにする", () => {
  expect(storedStrength(null)).toBe("mid");
  expect(storedStrength("strong")).toBe("strong");
  expect(storedStrength("x")).toBe("mid");
});
