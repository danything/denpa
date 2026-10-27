/**
 * **縮めたコマから取る、CM 検出の手がかり** (純粋な計算)。1回のデコードで、コマ全体を 32×18 に縮めたもの
 * (YUV420) を受け取り (`server/cm-scan.ts`)、2つにまとめる。
 *
 * - **場面のハッシュ** — 切れ目から切れ目までの場面ごとに、真ん中のコマの 64 ビットの差分ハッシュ。
 *   よその局でも流れた CM を見つけるのに使う (`cm-repeat.ts`)
 * - **1 秒ごとの絵の調子** — 明るさ・色 (U・V)・コントラストの平均。ロゴの無い秒が前後の番組に
 *   似ているかを見るのに使う (`cm-decide.ts`)
 *
 * 縮めたコマそのものは持たない (数だけ)。
 */

/** 縮めたコマの大きさ */
export const LOOK_WIDTH = 32;
export const LOOK_HEIGHT = 18;
/** 1コマのバイト数 (YUV420: 明るさ 32×18 と、色 16×9 が 2 つ) */
export const LOOK_SIZE =
  LOOK_WIDTH * LOOK_HEIGHT + 2 * (LOOK_WIDTH / 2) * (LOOK_HEIGHT / 2);

/** 1 秒ごとの絵の調子の数 (明るさ・U・V・コントラスト) */
export const TONE_FIELDS = 4;

/** これより強い切れ目で場面を分ける (`cm-decide` の切れ目の下限と同じ) */
const SHOT_CUT = 8;

/** 1コマから取ったもの */
export interface FrameLook {
  /** 差分ハッシュの上と下の 32 ビット */
  hi: number;
  lo: number;
  /** 明るさ・U・V の平均 (0〜255) */
  y: number;
  u: number;
  v: number;
  /** 明るさの標準偏差 (0〜255)。小さければ、のっぺりしたコマ (黒・白・単色) */
  contrast: number;
}

/** 場面。`start` はコマ番号 */
export interface Shots {
  start: Uint32Array;
  hi: Uint32Array;
  lo: Uint32Array;
  /** 真ん中のコマのコントラスト。のっぺりした場面はハッシュが当てにならない */
  contrast: Uint8Array;
}

/** 縮めたコマからまとめたもの (材料の控えに入る) */
export interface Look {
  shots: Shots;
  /** 1 秒ごとの絵の調子。`TONE_FIELDS` バイトずつ (秒 k は `k * TONE_FIELDS` から) */
  tone: Uint8Array;
}

function mean(data: Uint8Array, from: number, length: number): number {
  let sum = 0;
  for (let i = from; i < from + length; i++) sum += data[i]!;
  return sum / length;
}

/**
 * 1コマを読む。**差分ハッシュ**は、明るさを 9×8 のマスの平均にして、横に隣り合うマスのどちらが明るいかを 64 ビットに並べたもの。
 * 局が違っても同じ CM は同じ原版なので、縮めればほぼ同じビットになる
 */
export function frameLook(frame: Uint8Array): FrameLook {
  const w = LOOK_WIDTH;
  const h = LOOK_HEIGHT;
  const cells = new Float64Array(9 * 8);
  for (let r = 0; r < 8; r++) {
    const y0 = Math.floor((r * h) / 8);
    const y1 = Math.floor(((r + 1) * h) / 8);
    for (let c = 0; c < 9; c++) {
      const x0 = Math.floor((c * w) / 9);
      const x1 = Math.floor(((c + 1) * w) / 9);
      let sum = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) sum += frame[y * w + x]!;
      cells[r * 9 + c] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  let hi = 0;
  let lo = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const bit = cells[r * 9 + c]! < cells[r * 9 + c + 1]! ? 1 : 0;
      const k = r * 8 + c;
      if (k < 32) hi = (hi | (bit << (31 - k))) >>> 0;
      else lo = (lo | (bit << (63 - k))) >>> 0;
    }
  const luma = w * h;
  const y = mean(frame, 0, luma);
  let spread = 0;
  for (let i = 0; i < luma; i++) spread += (frame[i]! - y) ** 2;
  const chroma = (w / 2) * (h / 2);
  return {
    hi,
    lo,
    y,
    u: mean(frame, luma, chroma),
    v: mean(frame, luma + chroma, chroma),
    contrast: Math.sqrt(spread / luma),
  };
}

/** 2つのハッシュの違うビットの数 */
export function hamming(
  a: { hi: number; lo: number },
  b: { hi: number; lo: number },
): number {
  const bits = (x: number) => {
    let n = x >>> 0;
    let count = 0;
    while (n !== 0) {
      n &= n - 1;
      count++;
    }
    return count;
  };
  return bits(a.hi ^ b.hi) + bits(a.lo ^ b.lo);
}

const byte = (x: number) => Math.min(255, Math.max(0, Math.round(x)));

/**
 * コマごとに読んだものを、場面と 1 秒ごとの調子にまとめる。`times` はコマの時刻 (秒)、`cuts` は `scdet` の点
 * (どちらも `looks` と同じ並び)。場面は `SHOT_CUT` 以上の切れ目で分ける
 */
export function summarize(
  looks: FrameLook[],
  times: ArrayLike<number>,
  cuts: ArrayLike<number>,
  duration: number,
): Look {
  const n = looks.length;
  const starts: number[] = [];
  for (let i = 0; i < n; i++)
    if (i === 0 || cuts[i]! >= SHOT_CUT) starts.push(i);
  const count = starts.length;
  const shots: Shots = {
    start: Uint32Array.from(starts),
    hi: new Uint32Array(count),
    lo: new Uint32Array(count),
    contrast: new Uint8Array(count),
  };
  starts.forEach((start, k) => {
    const end = k + 1 < count ? starts[k + 1]! : n;
    const middle = looks[(start + end - 1) >> 1]!;
    shots.hi[k] = middle.hi;
    shots.lo[k] = middle.lo;
    shots.contrast[k] = byte(middle.contrast);
  });

  const seconds = Math.max(0, Math.ceil(duration));
  const sums = new Float64Array(seconds * TONE_FIELDS);
  const counts = new Uint32Array(seconds);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(times[i]!);
    if (k < 0 || k >= seconds) continue;
    const look = looks[i]!;
    [look.y, look.u, look.v, look.contrast].forEach((value, f) => {
      sums[k * TONE_FIELDS + f] = sums[k * TONE_FIELDS + f]! + value;
    });
    counts[k] = counts[k]! + 1;
  }
  const tone = new Uint8Array(seconds * TONE_FIELDS);
  for (let k = 0; k < seconds; k++)
    for (let f = 0; f < TONE_FIELDS; f++)
      tone[k * TONE_FIELDS + f] =
        counts[k]! > 0
          ? byte(sums[k * TONE_FIELDS + f]! / counts[k]!)
          : // コマの無い秒 (録画の頭の音声だけの所など) は前の秒のまま
            k > 0
            ? tone[(k - 1) * TONE_FIELDS + f]!
            : 0;
  return { shots, tone };
}
