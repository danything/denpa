import type { Range } from "./cm-decide";
import { hamming, type Look } from "./cm-look";

/**
 * **よその局でも流れた区間を探す** (純粋な計算)。同じ CM は局をまたいで何度も流れるので、録画どうしで
 * 場面のハッシュ (`cm-look.ts`) を照らす。集めておくのは、ほかの録画でロゴの無かった場面だけ (`server/cm-repeat.ts`)。
 *
 * **繰り返すのは CM だけではない** (アニメのオープニング・エンディング、提供スポンサーの毎週の CM、
 * 局の枠の頭の映像)。同じシリーズや同じ局の中の繰り返しは CM とも番組とも言えないので、
 * 照らす相手は**ほかの局の録画だけ**にする (呼ぶ側で絞る)。
 */

/** 照らす場面。秒 */
export interface Shot {
  start: number;
  end: number;
  hi: number;
  lo: number;
}

/** 集めておいた、ほかの録画の場面 */
export interface StoredShot {
  recording: number;
  /** 録画の中の場面の順 (ロゴの出ていた場面も数える。続いているかを見るのに使う) */
  seq: number;
  hi: number;
  lo: number;
  /** 長さ (秒) */
  length: number;
}

/** 同じ場面とみなす、ハッシュの違うビットの数の上限。4 つに分けた 16 ビットのどれかが必ず一致する範囲 */
const HAMMING_MAX = 3;
/** 同じ場面とみなす長さの差 (秒。3 コマほど) */
const LENGTH_TOLERANCE = 0.1;
/** これより短い場面は照らさない (秒)。切れ目が続く所の 1〜2 コマの場面は、ハッシュが似やすい */
const SHOT_MIN = 0.4;
/** これよりコントラストの低い場面は照らさない (黒・白・単色はどの CM でも同じハッシュになる) */
export const FLAT_CONTRAST = 8;

/** 材料の場面を秒に直す。のっぺりした場面と短すぎる場面は除く。並びの順 (`seq`) は除く前のもの */
export function shotsOf(
  look: Look,
  times: ArrayLike<number>,
  duration: number,
): (Shot & { seq: number })[] {
  const { shots } = look;
  const at = (frame: number) =>
    frame < times.length ? times[frame]! : duration;
  const out: (Shot & { seq: number })[] = [];
  for (let k = 0; k < shots.start.length; k++) {
    const start = at(shots.start[k]!);
    const end = k + 1 < shots.start.length ? at(shots.start[k + 1]!) : duration;
    if (end - start < SHOT_MIN || shots.contrast[k]! < FLAT_CONTRAST) continue;
    out.push({ start, end, hi: shots.hi[k]!, lo: shots.lo[k]!, seq: k });
  }
  return out;
}

/** 4 つに分けた 16 ビットを鍵にする (違いが `HAMMING_MAX` 以下なら、どれかが一致する) */
function bands(shot: { hi: number; lo: number }): number[] {
  return [
    (0 << 16) | (shot.hi >>> 16),
    (1 << 16) | (shot.hi & 0xffff),
    (2 << 16) | (shot.lo >>> 16),
    (3 << 16) | (shot.lo & 0xffff),
  ];
}

/**
 * `mine` (並んだ場面) のうち、`others` にも流れていた区間。**2 つ続けて一致したときだけ** 一致とみなす
 * (1 つだけなら、たまたま似た絵のこともある)。続いているかは、相手の録画の場面の順 (`seq`) で見る
 */
export function repeatedRanges(
  mine: (Shot & { seq: number })[],
  others: StoredShot[],
): Range[] {
  if (mine.length < 2 || others.length === 0) return [];
  const index = new Map<number, number[]>();
  others.forEach((shot, k) => {
    for (const key of bands(shot)) {
      const list = index.get(key);
      if (list === undefined) index.set(key, [k]);
      else list.push(k);
    }
  });
  const place = new Map<string, number>();
  others.forEach((shot, k) => place.set(`${shot.recording}:${shot.seq}`, k));

  /** `shot` に一致する相手の場面 (`others` の位置) */
  const matches = (shot: Shot): Set<number> => {
    const found = new Set<number>();
    const length = shot.end - shot.start;
    for (const key of bands(shot))
      for (const k of index.get(key) ?? []) {
        const other = others[k]!;
        if (
          !found.has(k) &&
          Math.abs(other.length - length) <= LENGTH_TOLERANCE &&
          hamming(other, shot) <= HAMMING_MAX
        )
          found.add(k);
      }
    return found;
  };

  const found = mine.map(matches);
  const marked = new Uint8Array(mine.length);
  for (let i = 0; i + 1 < mine.length; i++) {
    // 自分の側も続いた場面どうし (間の場面を除いていない)
    if (mine[i + 1]!.seq !== mine[i]!.seq + 1) continue;
    for (const k of found[i]!) {
      const other = others[k]!;
      const next = place.get(`${other.recording}:${other.seq + 1}`);
      if (next !== undefined && found[i + 1]!.has(next)) {
        marked[i] = 1;
        marked[i + 1] = 1;
        break;
      }
    }
  }
  const out: Range[] = [];
  mine.forEach((shot, i) => {
    if (marked[i] === 0) return;
    const last = out.at(-1);
    if (last !== undefined && shot.start - last.end < 1e-6) last.end = shot.end;
    else out.push({ start: shot.start, end: shot.end });
  });
  return out;
}
