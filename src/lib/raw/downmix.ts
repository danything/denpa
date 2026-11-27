/**
 * **3ch 以上の音を 2ch に下げる** (放送のまま・互換モードの音。`engine.ts` の `play`)。
 *
 * 係数はエンコードする経路の ffmpeg (`-ac 2`) と同じにする。前の左右はそのまま、中央は 1/√2 で左右へ、
 * 後ろ (横) の左右は 1/√2 で同じ側へ、後ろの中央は 1/2 で左右へ足し、LFE は捨てる。**正規化しない。**
 * 正規化すると 5.1ch の番組だけ 7.7 dB 小さくなり、ステレオの CM との境目で急に大きさが変わる。
 * 足して 1 を超えたぶんは、後ろのリミッタ (`#lib/sound.ts` の `Outlet`) が抑える。
 * 係数は FFmpeg 9.0.2 の `-ac 2` で、並びごとに 1 本ずつ鳴らして測った。float の音では ffmpeg も正規化しない
 *
 * 前の左右だけを鳴らすと、映画の台詞 (5.1ch ではほぼ中央にある) が消える
 */

/** FFmpeg の `AV_CH_*` のビット */
const FL = 0x1;
const FR = 0x2;
const FC = 0x4;
const LFE = 0x8;
const BL = 0x10;
const BR = 0x20;
const BC = 0x100;
const SL = 0x200;
const SR = 0x400;

const HALF_POWER = Math.SQRT1_2;

/** チャンネルごとの左・右への係数。ここに無いもの (LFE と、放送に無い並び) は鳴らさない */
const GAINS = new Map<number, readonly [number, number]>([
  [FL, [1, 0]],
  [FR, [0, 1]],
  [FC, [HALF_POWER, HALF_POWER]],
  [BL, [HALF_POWER, 0]],
  [BR, [0, HALF_POWER]],
  [SL, [HALF_POWER, 0]],
  [SR, [0, HALF_POWER]],
  [BC, [0.5, 0.5]],
]);

/**
 * 並びが分からない (`layout` が 0 か本数と合わない) ときの、本数ごとの並び。
 * AAC の channel_configuration 3〜6 (ARIB の 3/0・3/1・3/2・3/2+LFE) を FFmpeg のデコーダが出す並び。
 * 2/1・2/2 は PCE で来るので、デコーダが並びを付ける
 */
const BY_COUNT = new Map<number, number>([
  [3, FL | FR | FC],
  [4, FL | FR | FC | BC],
  [5, FL | FR | FC | BL | BR],
  [6, FL | FR | FC | LFE | BL | BR],
]);

/** 立っているビットを下から順に (面の並びと同じ順) */
function channelsOf(layout: number): number[] {
  const bits: number[] = [];
  for (let bit = 1; bit !== 0 && bit <= layout; bit <<= 1)
    if ((layout & bit) !== 0) bits.push(bit);
  return bits;
}

/**
 * 面 (FFmpeg の並び) を左右 2 本にする。`layout` は `AV_CH_*` の和 (`wasm/decoder.c` の `audio_push`)。
 * 1 本なら両耳へ同じもの、2 本ならそのまま (新しく作らない)
 */
export function downmix(
  planes: readonly Float32Array[],
  layout: number,
): [Float32Array, Float32Array] {
  const first = planes[0]!;
  if (planes.length === 1) return [first, first];
  if (planes.length === 2) return [first, planes[1]!];
  let channels = channelsOf(layout);
  if (channels.length !== planes.length)
    channels = channelsOf(BY_COUNT.get(planes.length) ?? FL | FR);
  const gains = channels.map((channel) => GAINS.get(channel) ?? [0, 0]);
  const frames = first.length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  // チャンネルごとに面を 1 回ずつなめる (標本ごとに関数を作らない。メインスレッドで 1 秒に 5 万標本)
  for (let i = 0; i < gains.length; i++) {
    const [toLeft, toRight] = gains[i]!;
    if (toLeft === 0 && toRight === 0) continue;
    const plane = planes[i]!;
    for (let n = 0; n < frames; n++) {
      const sample = plane[n]!;
      left[n] = left[n]! + toLeft * sample;
      right[n] = right[n]! + toRight * sample;
    }
  }
  return [left, right];
}
