/**
 * 折り畳み端末のテーブルトップ (半分に折って机に置いた形) の下の段に敷く「反射」の決め方
 * (`FoldReflection.svelte` のうち、画面に触らない所)。
 *
 * 上の段の映像の光が、光沢のある机に映り込んだように見せる。映すのは**色だけ** — 写した 32x18 (`GLANCE`) の
 * 下の縁を上下に返して折り目の直下に置き、手前 (下) ほど薄く、横へ広げてならす。字や顔の形は残らない。
 * ぼかし (`filter`) は使わず、粗い色の格子 (`UNITS`) を CSS で滑らかに引き伸ばして柔らかく見せる。
 *
 * 単体テストで見るために分けてある (`reflection.test.ts`)
 */

import { falloff, GLANCE } from "./ambient";

/**
 * 反射の強さ。濃さは折り目で `alpha`、下の段の高さの `reach` の所で 0。
 * 色の明るさの上限はアンビエントの光と同じ (`WASH_LUMINANCE` の暗いほう) — 上に直に乗る字 (控えた字も) が 4.5:1 を保つ
 */
export const STRENGTH = { alpha: 0.8, reach: 0.8 } as const;

/** 反射を描く canvas の中の置き場 (画素) */
export interface ReflectionLayout {
  width: number;
  height: number;
  /** 上の段で映像が出ている横の範囲 (左の端と幅)。反射はこの真下が濃く、外へにじむ */
  x: number;
  w: number;
}

/** 反射の canvas の細かさ。下の段の幅を 128 画素として描き、CSS で引き伸ばす (色だけなので粗くてよい) */
const UNITS = 128;

/**
 * 下の段の大きさ `segment` と、上の段で映像が出ている横の範囲 (`video`。下の段の左端から) から、canvas の中の置き場を決める
 */
export function reflectionLayout(
  segment: { width: number; height: number },
  video: { left: number; width: number },
): ReflectionLayout {
  const k = UNITS / Math.max(1, segment.width);
  return {
    width: UNITS,
    height: Math.max(1, Math.round(segment.height * k)),
    x: video.left * k,
    w: Math.max(1, video.width * k),
  };
}

/** 返して映す深さ (写した 32x18 の下から何行ぶん)。折り目から離れるほど、映像の少し上の色になる */
const MIRROR_ROWS = 5;

/**
 * **反射を作る。** 写した1枚 (`frame`、32x18 の RGBA。明るさはもう抑えてあるもの) から、`at` の大きさの RGBA を返す。
 *
 * - 色は下の縁の行を上下に返したもの — 折り目の直下は映像のいちばん下の行、手前へ行くほど上の行
 *   (`MIRROR_ROWS` まで)。光沢のある机に映るのと同じ向き
 * - 手前ほど横に広くならす (重みの幅を深さで広げる)。映像の形は残らず、色の移り変わりだけが残る
 * - 濃さは折り目で `alpha`、`reach` (下の段の高さに対する割合) で 0。映像の横の外へは、深さに応じた幅でにじんで消える
 */
export function reflectionPixels(
  frame: Uint8ClampedArray,
  at: ReflectionLayout,
  strength: { alpha: number; reach: number },
): Uint8ClampedArray<ArrayBuffer> {
  const width = GLANCE.width;
  const height = GLANCE.height;
  const out = new Uint8ClampedArray(at.width * at.height * 4);
  const reachPx = Math.max(1, at.height * strength.reach);
  const sum = [0, 0, 0, 0];
  for (let py = 0; py < at.height; py++) {
    const t = (py + 0.5) / reachPx;
    const depth = falloff(t);
    if (depth <= 0) continue;
    // 返して映す行 (下の縁から上へ)
    const row = Math.max(0, height - 1 - Math.min(1, t) * MIRROR_ROWS);
    const r0 = Math.ceil(row);
    const r1 = Math.max(0, r0 - 1);
    const fr = r0 - row;
    // ならす幅 (写した1マス単位)。折り目で 1、手前で 7
    const spread = 1 + Math.min(1, t) * 6;
    // 映像の横の外へにじむ幅 (canvas の画素)
    const side = at.w * (0.04 + 0.16 * Math.min(1, t));
    for (let px = 0; px < at.width; px++) {
      const cx = px + 0.5;
      const outside = Math.max(at.x - cx, cx - (at.x + at.w), 0);
      const sideFade = outside === 0 ? 1 : falloff(outside / side);
      if (sideFade <= 0) continue;
      const u = Math.min(
        width - 1,
        Math.max(0, ((cx - at.x) / at.w) * width - 0.5),
      );
      sum.fill(0);
      let total = 0;
      for (let x = Math.ceil(u - spread); x <= Math.floor(u + spread); x++) {
        const column = Math.min(width - 1, Math.max(0, x));
        // 三角の重み (箱より境目が出にくい)
        const weight = 1 - Math.abs(x - u) / (spread + 1);
        for (let c = 0; c < 4; c++) {
          const a = frame[(r0 * width + column) * 4 + c]!;
          const b = frame[(r1 * width + column) * 4 + c]!;
          sum[c]! += (a + (b - a) * fr) * weight;
        }
        total += weight;
      }
      const i = (py * at.width + px) * 4;
      out[i] = sum[0]! / total;
      out[i + 1] = sum[1]! / total;
      out[i + 2] = sum[2]! / total;
      out[i + 3] = (sum[3]! / total) * strength.alpha * depth * sideFade;
    }
  }
  return out;
}
