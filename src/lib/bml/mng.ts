/**
 * MNG (`image/X-arib-mng`) をコマの PNG に分ける。**MNG を読める画像 API はブラウザに無い**ので、
 * コマごとに PNG を組み直し ([png.ts](png.ts) の applyClut で CLUT の色を入れる)、動かすのは描く側
 * ([render.ts](render.ts))。
 *
 * 放送の MNG は MNG の一部だけを使う (STD-B24 第二編 8.2.4・付属2 4.8.5.3)。読むのは:
 *
 * - MHDR: 大きさと 1 秒の刻みの数
 * - FRAM: 重ね方 (1・2 は前のコマに重ねる、3・4 は消してから描く) と、コマの間隔 (刻み)
 * - DEFI: コマを置く場所
 * - IHDR〜IEND: コマの PNG (パレットは持たない。色は文書の CLUT)
 * - TERM: くり返しの回数 (0x7fffffff は限り無し)
 */

import { ascii, concatBytes } from "@doany/arib/bytes";

import { PNG_SIGNATURE } from "#lib/ts/png.js";

interface MngFrame {
  /** CLUT を入れる前の PNG */
  png: Uint8Array<ArrayBuffer>;
  /** 次のコマまでの間 (ミリ秒) */
  delay: number;
  x: number;
  y: number;
  /** 前のコマの上に重ねるか (false なら消してから描く。FRAM の重ね方 3・4) */
  keep: boolean;
}

interface Mng {
  width: number;
  height: number;
  frames: MngFrame[];
  /** くり返しの回数 (TERM が無ければ 1。限り無しは Infinity) */
  iterations: number;
}

const MNG_SIGNATURE = [0x8a, 0x4d, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** コマの間隔の下限 (ミリ秒)。間隔 0 のコマばかりでも、描き直しで回り続けない */
const MIN_DELAY = 20;

/** MNG を読む。MNG でない・コマが 1 つも無ければ null */
export function parseMng(data: Uint8Array): Mng | null {
  if (data.length < 8 || MNG_SIGNATURE.some((byte, i) => data[i] !== byte))
    return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0;
  let height = 0;
  let ticks = 0;
  let iterations = 1;
  let mode = 1;
  let delay = 1;
  let nextDelay: number | null = null;
  let x = 0;
  let y = 0;
  const frames: MngFrame[] = [];
  let png: Uint8Array[] | null = null;
  let at = 8;
  while (at + 12 <= data.length) {
    const length = view.getUint32(at);
    const name = ascii(data, at + 4, 4);
    const body = at + 8;
    const end = body + length + 4;
    if (end > data.length) break;
    const whole = data.subarray(at, end);
    switch (name) {
      case "MHDR":
        if (length >= 12) {
          width = view.getUint32(body);
          height = view.getUint32(body + 4);
          ticks = view.getUint32(body + 8);
        }
        break;
      case "FRAM":
        // 重ね方 (0 は変えない)・名前 (0 で終わる。放送は空)・間隔を変えるか・…・間隔
        if (length >= 1 && data[body] !== 0) mode = data[body]!;
        if (length >= 2) {
          let field = body + 1;
          while (field < body + length && data[field] !== 0) field++;
          // 名前の終わりの 0 の次から: 間隔を変えるか・時間切れ・切り取り・同期 (各 1)・間隔 (4)
          const change = data[field + 1];
          if (field + 9 > body + length) break;
          const value = view.getUint32(field + 5);
          if (change === 2) delay = value;
          else if (change === 1) nextDelay = value;
        }
        break;
      case "DEFI":
        // 場所を省いた DEFI は 0, 0 (MNG の既定)
        x = length >= 12 ? view.getInt32(body + 4) : 0;
        y = length >= 12 ? view.getInt32(body + 8) : 0;
        break;
      case "TERM":
        // くり返すのは終わり方が 3 (最初から) のときだけ。ほかは 1 回
        if (length >= 10 && data[body] === 3) {
          const max = view.getUint32(body + 6);
          iterations =
            max === 0x7fffffff ? Number.POSITIVE_INFINITY : Math.max(1, max);
        }
        break;
      case "IHDR":
        png = [PNG_SIGNATURE, whole];
        break;
      case "IEND":
        if (png !== null) {
          png.push(whole);
          const tick = nextDelay ?? delay;
          nextDelay = null;
          frames.push({
            png: concatBytes(png),
            delay: Math.max(
              MIN_DELAY,
              (tick * 1000) / (ticks > 0 ? ticks : 1000),
            ),
            x,
            y,
            keep: mode !== 3 && mode !== 4,
          });
          png = null;
        }
        break;
      default:
        // コマの中の塊 (IDAT・gAMA など) はそのまま。パレットは CLUT で入れ直す
        if (png !== null && name !== "PLTE" && name !== "tRNS") png.push(whole);
    }
    at = end;
  }
  if (frames.length === 0) return null;
  return { width, height, frames, iterations };
}

/** `index` のコマを出すときに重なって見えるコマ (前に重ねるコマの間は遡る。消してから描くコマで止まる) */
export function visibleFrames<T extends { keep: boolean }>(
  frames: readonly T[],
  index: number,
): T[] {
  let start = index;
  while (start > 0 && frames[start]!.keep) start--;
  return frames.slice(start, index + 1);
}
