/** テスト用の小さな MNG を組む (放送のデータは使わない) */

import { concatBytes } from "@doany/arib/bytes";

import { pngChunk } from "#lib/ts/png.js";

/** 塊 (長さ・名前・中身・CRC) */
export function chunk(name: string, body: number[] | Uint8Array): Uint8Array {
  return pngChunk(name, Uint8Array.from(body));
}

export const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

/** 2x1 のパレットの PNG のコマ (IHDR・IDAT・IEND)。パレットは持たない (色は CLUT) */
export function frame(): Uint8Array[] {
  // 8 ビットのパレット、1 行 = フィルタ 0 + 2 画素。圧縮しない zlib
  const raw = [0, 1, 2];
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const byte of raw) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  })();
  const zlib = [
    0x78,
    0x01,
    1,
    raw.length,
    0,
    ~raw.length & 0xff,
    0xff,
    ...raw,
    ...u32(adler),
  ];
  return [
    chunk("IHDR", [...u32(2), ...u32(1), 8, 3, 0, 0, 0]),
    chunk("IDAT", zlib),
    chunk("IEND", []),
  ];
}

export function mng(parts: Uint8Array[]): Uint8Array {
  const signature = [0x8a, 0x4d, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return concatBytes([Uint8Array.from(signature), ...parts]);
}

export const MHDR = chunk("MHDR", [
  ...u32(64),
  ...u32(32),
  ...u32(100),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0),
]);
export const fram = (mode: number, ticks: number) =>
  chunk("FRAM", [mode, 0, 2, 0, 0, 0, ...u32(ticks)]);
export const defi = (x: number, y: number) =>
  chunk("DEFI", [0, 0, 0, 0, ...u32(x), ...u32(y)]);

/** 2 コマ (間隔 0.5 秒、2 コマ目は消してから描く)・TERM 無し */
export function sampleMng(): Uint8Array {
  return mng([
    MHDR,
    fram(1, 50),
    defi(0, 0),
    ...frame(),
    fram(3, 50),
    ...frame(),
    chunk("MEND", []),
  ]);
}
