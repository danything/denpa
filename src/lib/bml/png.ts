/**
 * PNG を組み直す。**ブラウザの画像 API にそのまま渡すため。**
 *
 * - 放送の PNG はパレット (PLTE) を持たず、色は文書の CLUT で決まる (STD-B24 付属3)。
 *   CLUT から PLTE と tRNS を作って差し込む
 * - DRCS (外字) の画像を、字の色で塗るための mask にする。圧縮しない zlib (stored) で
 *   PNG を組むので、canvas も圧縮の API も要らない
 */

import { ascii, concatBytes } from "#lib/ts/bytes.js";
import { PNG_SIGNATURE, pngChunk } from "#lib/ts/png.js";

import type { Rgba } from "./clut";

/** 放送の PNG に CLUT の PLTE・tRNS を入れる。大きさも返す。パレットの PNG でなければそのまま */
export function applyClut(
  png: Uint8Array,
  clut: readonly Rgba[],
): { data: Uint8Array<ArrayBuffer>; width: number; height: number } | null {
  if (png.length < 33) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  // 色の数はビット深度まで (多すぎる tRNS を捨てるデコーダがある)
  const colors = clut.slice(0, 2 ** Math.min(8, png[24] ?? 8));
  const plte = new Uint8Array(colors.length * 3);
  const trns = new Uint8Array(colors.length);
  colors.forEach(([r, g, b, a], i) => {
    plte.set([r, g, b], i * 3);
    trns[i] = a;
  });
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  let placed = false;
  let at = 8;
  while (at + 12 <= png.length) {
    const length = view.getUint32(at);
    const name = ascii(png, at + 4, 4);
    const end = at + 12 + length;
    if (end > png.length) return null;
    // パレット (色の型 3) 以外は運用されない。来たら手を入れない
    if (name === "IHDR" && png[at + 8 + 9] !== 3)
      return { data: concatBytes([png]), width, height };
    // PLTE・tRNS は最初の IDAT の前に (gAMA などの後ろでよい。PNG の塊の順)
    if (name === "IDAT" && !placed) {
      parts.push(pngChunk("PLTE", plte), pngChunk("tRNS", trns));
      placed = true;
    }
    if (name !== "PLTE" && name !== "tRNS") parts.push(png.subarray(at, end));
    at = end;
  }
  return { data: concatBytes(parts), width, height };
}

/** 濃さ (0〜255) の並びを、白の上の透明度の PNG にする (mask に使う) */
export function alphaPng(
  width: number,
  height: number,
  alpha: Uint8Array,
): Uint8Array<ArrayBuffer> {
  // 1 行 = フィルタ 1 バイト + (灰 1・透明度 1) × 幅
  const raw = new Uint8Array(height * (1 + width * 2));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 2);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 2] = 0xff;
      raw[row + 2 + x * 2] = alpha[y * width + x] ?? 0;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // 8 ビット
  ihdr[9] = 4; // 灰 + 透明度
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** 圧縮しない zlib (stored のブロックを並べるだけ) */
function storedZlib(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at < data.length || at === 0; at += 0xffff) {
    const piece = data.subarray(at, at + 0xffff);
    const last = at + 0xffff >= data.length;
    const head = Uint8Array.of(
      last ? 1 : 0,
      piece.length & 0xff,
      piece.length >> 8,
      ~piece.length & 0xff,
      (~piece.length >> 8) & 0xff,
    );
    blocks.push(head, piece);
    if (last) break;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  blocks.push(adler);
  return concatBytes(blocks);
}
