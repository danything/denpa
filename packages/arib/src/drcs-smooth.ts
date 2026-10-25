/**
 * **字幕の外字 (DRCS) の画像を、送る前になめらかにする** ([b24caption.ts](b24caption.ts) が JSON に入れるところで使う)。
 *
 * 放送は置き換え表で字にできない外字を、16〜36 画素の白黒の画像で送ってくる。受け側はそれを字の枠いっぱい
 * (1920x1080 の全画面で 72 画素ほど) に引き伸ばすので、そのまま渡すと 1 点が 4x4 の階段になり、
 * なめらかに引き伸ばしても階段がぼやけて残る (スピーカー 🔊 の外字など)。
 *
 * 以前は libaribcaption の描き手にパッチを当てて同じことをしていた (#554)。描くのを受け側に移したとき (#571〜#586)
 * にその直しが落ちたので、**サーバで1回だけ** やって、濃淡の画像 (`bits: 4`・`depth: 16`) で送る。受け側は
 * もともと `bits` 1・2・4・8 を読み、濃さを字の色の不透明度に掛けて引き伸ばすので変えなくてよい。
 *
 * 1. **水増しを畳む** (`collapseDoubled`)。放送はよく 18x18 の字を縦横 2 倍の 36x36 で送ってくる。
 *    同じ並びが 2 つずつ続く行・列を 1 つにする (失うものは無い)。そうしないと次の段で階段を階段と見られない
 * 2. **Scale2x (EPX) で斜めを丸める** (`scale2x`)。斜めの階段を細かくする。縦横の線はまっすぐのまま残るが、
 *    塗りの出っ張った角は元の1点ぶんほど丸まる (EPX の性質。#554 のパッチも同じで、フォントの字に近い見た目になる)
 * 3. **縮めて濃淡にする** (`boxDown`・`pack4`)。細かくした画像を 4x4 ずつ平均し、縁に中間の濃さを付ける。
 *    縦横の線は元の画素の境目に落ちるので、ぼけずにくっきり残る
 *
 * **置き換え表の MD5 は元の画像から取る** (b24caption.ts)。ここで作った画像は送るためだけのもの。
 */

import type { CaptionDrcs } from "./caption-text.js";

/** 濃さ 0〜255 の画像 (左上から1画素1バイト) */
export interface Grey {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** 送る画像の一辺。これに届くまで倍にする (全画面の字の枠と同じくらい) */
const TARGET = 64;
/** 送る画像の一辺の上限。受け側 (denpa-tv) もこれより大きい画像は読まない */
const MAX = 256;
/** 最後に平均する一辺。Scale2x をこのぶん余計にかけておく (4 なら 2 回) */
const BOX = 4;

/** 放送の詰め方 (左上から1画素 `bits` ビット、上の桁から) を開いて、濃さ 0〜255 にする */
export function decodeGrey(
  width: number,
  height: number,
  depth: number,
  bits: number,
  data: Uint8Array,
): Grey {
  const pixels = new Uint8Array(width * height);
  const mask = (1 << bits) - 1;
  for (let i = 0; i < width * height; i++) {
    const bit = i * bits;
    const value = ((data[bit >> 3] ?? 0) >> (8 - (bit & 7) - bits)) & mask;
    pixels[i] = Math.round((Math.min(value, depth - 1) * 255) / (depth - 1));
  }
  return { width, height, pixels };
}

/**
 * 縦横に水増しされた画像を畳む。偶数の幅で、どの行も (0,1) (2,3)… の列が同じなら列を半分に、
 * 行も同じように見る。畳めなくなるまで繰り返す (4 倍で送ってきても畳める)
 */
export function collapseDoubled(src: Grey): Grey {
  let g = src;
  for (;;) {
    const { width, height, pixels } = g;
    let cols = width % 2 === 0;
    let rows = height % 2 === 0;
    for (let y = 0; y < height && (cols || rows); y++) {
      for (let x = 0; x < width; x++) {
        const p = pixels[y * width + x]!;
        if (cols && x % 2 === 0 && p !== pixels[y * width + x + 1])
          cols = false;
        if (rows && y % 2 === 0 && p !== pixels[(y + 1) * width + x])
          rows = false;
      }
    }
    if (!cols && !rows) return g;
    const w = cols ? width / 2 : width;
    const h = rows ? height / 2 : height;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++)
        out[y * w + x] =
          pixels[(rows ? y * 2 : y) * width + (cols ? x * 2 : x)]!;
    }
    g = { width: w, height: h, pixels: out };
  }
}

/**
 * Scale2x (EPX)。縦横 2 倍にしながら、斜めに接する点どうしの間を埋めて階段を細かくする。
 * 画像の外は縁で折り返した内側と同じと見る。縁に接した塗りは角が欠けず (隣の字とつながる線が切れない)、
 * 縁へ抜ける斜めの線にも余計な点が付かない
 */
export function scale2x(src: Grey): Grey {
  const { width, height, pixels } = src;
  const w = width * 2;
  const out = new Uint8Array(w * height * 2);
  const at = (x: number, y: number) => {
    const cx =
      x < 0 ? Math.min(1, width - 1) : x >= width ? Math.max(0, width - 2) : x;
    const cy =
      y < 0
        ? Math.min(1, height - 1)
        : y >= height
          ? Math.max(0, height - 2)
          : y;
    return pixels[cy * width + cx]!;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x]!;
      const a = at(x, y - 1); // 上
      const b = at(x + 1, y); // 右
      const c = at(x - 1, y); // 左
      const d = at(x, y + 1); // 下
      const top = y * 2 * w + x * 2;
      out[top] = c === a && c !== d && a !== b ? a : p;
      out[top + 1] = a === b && a !== c && b !== d ? b : p;
      out[top + w] = d === c && d !== b && c !== a ? c : p;
      out[top + w + 1] = b === d && b !== a && d !== c ? d : p;
    }
  }
  return { width: w, height: height * 2, pixels: out };
}

/** `n`x`n` ずつ平均して 1/n に縮める (幅・高さは n の倍数であること) */
export function boxDown(src: Grey, n: number): Grey {
  const w = src.width / n;
  const h = src.height / n;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < n; dy++) {
        const row = (y * n + dy) * src.width + x * n;
        for (let dx = 0; dx < n; dx++) sum += src.pixels[row + dx]!;
      }
      out[y * w + x] = Math.round(sum / (n * n));
    }
  }
  return { width: w, height: h, pixels: out };
}

/**
 * 外字の画像を、送る濃淡の画像にする。畳んだ画像の一辺が `TARGET` に届くまで 2 倍ずつ (一辺 `MAX` まで) 大きくする。
 * 畳んだ 18x18 なら 72x72、36x36 (水増しなし) なら 72x72
 */
export function smoothDrcs(
  width: number,
  height: number,
  depth: number,
  bits: number,
  data: Uint8Array,
): CaptionDrcs {
  if (width <= 0 || height <= 0 || depth < 2 || ![1, 2, 4, 8].includes(bits)) {
    // 読めない画像はそのまま渡す (受け側も読まない)
    return {
      w: width,
      h: height,
      depth,
      bits,
      data: Buffer.from(data).toString("base64"),
    };
  }
  let g = collapseDoubled(decodeGrey(width, height, depth, bits, data));
  const side = Math.max(g.width, g.height);
  let scale = 1;
  while (side * scale < TARGET && side * scale * 2 <= MAX) scale *= 2;
  for (let s = 1; s < scale * BOX; s *= 2) g = scale2x(g);
  g = boxDown(g, BOX);
  return {
    w: g.width,
    h: g.height,
    depth: 16,
    bits: 4,
    data: Buffer.from(pack4(g)).toString("base64"),
  };
}

/**
 * 濃さを 16 階調にして1画素4ビットで詰める (左の画素が上の桁)。4x4 の平均は白黒の画像からだと 17 階調しか
 * 出ないので、8 ビットで送っても見た目は変わらず倍の大きさになるだけ (外字の画像は字幕の1枚ごとに付く)
 */
export function pack4(g: Grey): Uint8Array {
  const out = new Uint8Array(Math.ceil(g.pixels.length / 2));
  g.pixels.forEach((v, i) => {
    out[i >> 1]! |= Math.round((v * 15) / 255) << (i & 1 ? 0 : 4);
  });
  return out;
}
