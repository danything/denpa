/**
 * DRCS (外字)。`browser.loadDRCS("x.drc")` で読む字の画像 (STD-B24 付属3 4.6)。
 *
 * 運用は 4 階調・非圧縮・全角の正方形 (16/20/24/30/36) だけ。1 字を CSS の mask にして、
 * **色は字の色** (currentColor) で塗る。TTF は作らない。中間の 2 階調は透明度で近づける
 * (規格では grayscale-color-index の色だが、縁のなめらかさとして見えればよい)。
 *
 * 字は 87・88 区 (中では私用領域。[euc.ts](euc.ts) の `isDrcs`) に入る。
 */

import { PUA_ADDITIONAL } from "./euc";

export interface Glyph {
  /** 1 丸ゴシック・2 角ゴシック・3 太丸ゴシック */
  fontId: number;
  width: number;
  height: number;
  /** 1 画素 1 バイトの濃さ (0〜255) */
  alpha: Uint8Array;
}

/** DRCS のファイルを読む。[中の字 (私用領域), 字の画像] の並び。字数 0 のファイルは空 */
export function parseDrcs(data: Uint8Array): [number, Glyph][] {
  const out: [number, Glyph][] = [];
  let at = 0;
  const count = data[at++] ?? 0;
  for (let i = 0; i < count && at + 3 <= data.length; i++) {
    const ku = data[at++]! - 0x20;
    const ten = data[at++]! - 0x20;
    const fonts = data[at++]!;
    const unit = PUA_ADDITIONAL + (ku - 85) * 94 + (ten - 1);
    for (let j = 0; j < fonts && at < data.length; j++) {
      const head = data[at++]!;
      const fontId = head >> 4;
      const mode = head & 0x0f;
      // ジオメトリックは運用されない。読めないので残りを諦める
      if (mode > 1) return out;
      const levels = (data[at++] ?? 0) + 2;
      const width = data[at++] ?? 0;
      const height = data[at++] ?? 0;
      const bits = Math.ceil(Math.log2(levels));
      const alpha = new Uint8Array(width * height);
      let position = at * 8;
      for (let p = 0; p < width * height; p++) {
        let value = 0;
        for (let b = 0; b < bits; b++, position++) {
          value =
            (value << 1) |
            (((data[position >> 3] ?? 0) >> (7 - (position & 7))) & 1);
        }
        alpha[p] = Math.round((value * 255) / (levels - 1));
      }
      at = (position + 7) >> 3;
      if (ku >= 85 && ku <= 94 && ten >= 1 && ten <= 94)
        out.push([unit, { fontId, width, height, alpha }]);
    }
  }
  return out;
}

/** 字体の名前を DRCS の fontId に */
export function fontIdOf(family: string): number {
  if (family.includes("角ゴシック")) return 2;
  if (family.includes("太丸ゴシック")) return 3;
  return 1;
}
