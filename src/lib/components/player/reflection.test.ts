import { describe, expect, test } from "bun:test";

import { GLANCE, luminance, toneFrame, WASH_LUMINANCE } from "./ambient";
import { reflectionLayout, reflectionPixels, STRENGTH } from "./reflection";

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

/** 下の段 1104x441 (Galaxy Z Fold 系を開いて横に置いた形)、映像は横 160〜944 */
const at = reflectionLayout(
  { width: 1104, height: 441 },
  { left: 160, width: 784 },
);
const alpha = (pixels: Uint8ClampedArray, x: number, y: number) =>
  pixels[(y * at.width + x) * 4 + 3]!;

describe("reflectionLayout", () => {
  test("下の段の幅を 128 画素にし、映像の横の範囲を同じ縮みで写す", () => {
    expect(at.width).toBe(128);
    expect(at.height).toBe(Math.round((441 * 128) / 1104));
    expect(at.x).toBeCloseTo((160 * 128) / 1104);
    expect(at.w).toBeCloseTo((784 * 128) / 1104);
  });
});

describe("reflectionPixels", () => {
  test("映すのは下の縁の色 (折り目の直下は映像のいちばん下の色)", () => {
    const pixels = reflectionPixels(split(), at, STRENGTH);
    const i = 64 * 4;
    expect(pixels[i + 2]).toBeGreaterThan(200);
    expect(pixels[i]).toBeLessThan(20);
  });

  test("手前ほど薄く、届く幅の先は透明", () => {
    const pixels = reflectionPixels(split(), at, STRENGTH);
    const near = alpha(pixels, 64, 0);
    const mid = alpha(pixels, 64, Math.floor(at.height * 0.3));
    expect(near).toBeGreaterThan(mid);
    expect(alpha(pixels, 64, at.height - 1)).toBe(0);
  });

  test("映像の横の外へは、にじんで消える", () => {
    const pixels = reflectionPixels(split(), at, STRENGTH);
    const y = 4;
    const inside = alpha(pixels, Math.ceil(at.x) + 1, y);
    const outside = alpha(pixels, Math.floor(at.x) - 3, y);
    expect(outside).toBeLessThan(inside);
    expect(alpha(pixels, 0, y)).toBe(0);
  });

  test("白い映像でも、黒い地に重ねた色は控えた字が 4.5:1 を保つ暗さ", () => {
    const frame = new Uint8ClampedArray(GLANCE.width * GLANCE.height * 4).fill(
      255,
    );
    toneFrame(frame, "dark", WASH_LUMINANCE);
    const pixels = reflectionPixels(frame, at, STRENGTH);
    let brightest = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3]! / 255;
      // 黒い地 (`--dp-video`) に重ねた色
      const over = [pixels[i]! * a, pixels[i + 1]! * a, pixels[i + 2]! * a] as [
        number,
        number,
        number,
      ];
      brightest = Math.max(brightest, luminance(over));
    }
    // 暗いテーマの控えた字 (`--dp-muted` #9aa3b5) との比
    const muted = luminance([0x9a, 0xa3, 0xb5]);
    expect((muted + 0.05) / (brightest + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
