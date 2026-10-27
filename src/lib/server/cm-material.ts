import { joinBytes } from "@danything/arib/bytes";

import type { Range } from "../ts/cm-decide";
import { type Look, TONE_FIELDS } from "../ts/cm-look";
import type { Span } from "../ts/logo-detect";

/**
 * **CM 検出の材料の控え** (`cm_materials`)。1回のデコードで取った無音・場面の切れ目・ロゴの点を、数だけ縮めて DB に置く。
 *
 * - CM 検出だけやり直すとき (`encoder.runCmJob`) に、バージョンが合えば読み直さずにここから決める
 * - 決め方 (`cm-decide.ts`) を変えたときに、本番の録画で前と比べる材料にする
 *
 * 形式は docs/cm.md の「材料の控え」
 */

/** 中身の形式のバージョン。形式を変えたら上げる (古いバージョンの行は使わずに読み直す) */
export const MATERIAL_VERSION = 2;

/** 切れ目はこの強さ以上だけ持つ (`cm-decide` の弱い切れ目の下限) */
const CUT_KEEP = 3;
/** ロゴの点の目盛り。0〜2.55 を 1 バイトで */
const SCORE_SCALE = 100;

/** 材料。時刻は決めたときの物差し (`offset` を足すと入れ物の頭からの秒) */
export interface CmMaterial {
  /** 材料の時刻に足すと入れ物の頭からの秒になる (エンコードしたときに頭から捨てた長さなど) */
  offset: number;
  /** 尺 (秒) */
  duration: number;
  /** フレームレート (ロゴの区間をならす窓に使ったもの) */
  fps: number;
  /** 番組表の尺と、番組表どおりなら番組が始まる秒 (同じ物差し) */
  programLength?: number | undefined;
  programStart?: number | undefined;
  silences: Range[];
  /** コマごとの時刻 (秒) */
  times: Float64Array;
  /** コマごとの切れ目の点。`CUT_KEEP` より弱いものは 0 */
  cuts: Float32Array;
  /** ロゴ。使えなかったときは null で、理由が `why` */
  logo: { spans: Span[]; scores: Float32Array } | null;
  why: string;
  /** 縮めたコマから取ったもの (場面のハッシュと 1 秒ごとの絵の調子)。縮めたコマの数がコマの数と合わなかったときは null */
  look: Look | null;
}

/** 頭の JSON。並びの長さはここから決まる */
type Header = Omit<
  CmMaterial,
  "silences" | "times" | "cuts" | "logo" | "look"
> & {
  version: number;
  /** 1コマ目の時刻 (µs) とコマの数 */
  first: number;
  frames: number;
  /** 持っている切れ目の数 */
  cuts: number;
  silences: [number, number][];
  spans: [number, number][] | null;
  /** 場面の数と、絵の調子の秒数 (縮めたコマが無ければ null) */
  look: { shots: number; seconds: number } | null;
};

/** 縮める (並びは docs/cm.md の「材料の控え」)。全体を zstd で */
export function encodeMaterial(material: CmMaterial): Uint8Array {
  const { times, cuts, logo, silences, look, ...rest } = material;
  const frames = times.length;
  const micro = (t: number) => Math.round(t * 1e6);
  const kept: number[] = [];
  for (let i = 0; i < cuts.length; i++) if (cuts[i]! >= CUT_KEEP) kept.push(i);
  const header: Header = {
    version: MATERIAL_VERSION,
    ...rest,
    first: frames > 0 ? micro(times[0]!) : 0,
    frames,
    cuts: kept.length,
    silences: silences.map((s) => [+s.start.toFixed(4), +s.end.toFixed(4)]),
    spans: logo === null ? null : logo.spans.map((s) => [s.start, s.end]),
    look:
      look === null
        ? null
        : {
            shots: look.shots.start.length,
            seconds: look.tone.length / TONE_FIELDS,
          },
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const deltas = new Int32Array(Math.max(0, frames - 1));
  for (let i = 1; i < frames; i++)
    deltas[i - 1] = micro(times[i]!) - micro(times[i - 1]!);
  const at = new Uint32Array(kept.length);
  const strength = new Uint16Array(kept.length);
  kept.forEach((frame, k) => {
    at[k] = frame - (k > 0 ? kept[k - 1]! : 0);
    strength[k] = Math.min(65535, Math.round(cuts[frame]! * 10));
  });
  const scores = new Uint8Array(logo === null ? 0 : frames);
  if (logo !== null)
    for (let i = 0; i < frames; i++)
      scores[i] = Math.min(
        255,
        Math.max(0, Math.round((logo.scores[i] ?? 0) * SCORE_SCALE)),
      );
  // 場面の頭はコマ番号の差で (切れ目と同じ)
  const shotStarts = new Uint32Array(look?.shots.start.length ?? 0);
  if (look !== null)
    look.shots.start.forEach((frame, k) => {
      shotStarts[k] = frame - (k > 0 ? look.shots.start[k - 1]! : 0);
    });
  const raw = joinBytes([
    new Uint8Array(Uint32Array.of(head.length).buffer),
    head,
    new Uint8Array(deltas.buffer),
    new Uint8Array(at.buffer),
    new Uint8Array(strength.buffer),
    scores,
    ...(look === null
      ? []
      : [
          new Uint8Array(shotStarts.buffer),
          new Uint8Array(look.shots.hi.slice().buffer),
          new Uint8Array(look.shots.lo.slice().buffer),
          look.shots.contrast,
          look.tone,
        ]),
  ]);
  return Bun.zstdCompressSync(raw, { level: 19 });
}

/** 戻す。壊れている・バージョンが違うものは null */
export function decodeMaterial(bytes: Uint8Array): CmMaterial | null {
  try {
    // 写して頭から並べる (Buffer は大きな置き場の一部を指していることがある)
    const raw = new Uint8Array(Bun.zstdDecompressSync(bytes));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const length = view.getUint32(0, true);
    const {
      version,
      first,
      frames,
      cuts: cutCount,
      silences,
      spans,
      look: sizes,
      ...rest
    } = JSON.parse(
      new TextDecoder().decode(raw.subarray(4, 4 + length)),
    ) as Header;
    if (version !== MATERIAL_VERSION) return null;
    let cursor = 4 + length;
    /** 揃っていない位置から型付きの並びを読む (写してから) */
    const take = (count: number, size: number) => {
      const out = raw.slice(cursor, cursor + count * size);
      if (out.length !== count * size)
        throw new Error("材料が途中で切れています");
      cursor += count * size;
      return out.buffer;
    };
    const deltas = new Int32Array(take(Math.max(0, frames - 1), 4));
    const at = new Uint32Array(take(cutCount, 4));
    const strength = new Uint16Array(take(cutCount, 2));
    const scores = spans === null ? null : new Uint8Array(take(frames, 1));
    let look: Look | null = null;
    if (sizes !== null) {
      const steps = new Uint32Array(take(sizes.shots, 4));
      const hi = new Uint32Array(take(sizes.shots, 4));
      const lo = new Uint32Array(take(sizes.shots, 4));
      const contrast = new Uint8Array(take(sizes.shots, 1));
      const tone = new Uint8Array(take(sizes.seconds * TONE_FIELDS, 1));
      const start = new Uint32Array(sizes.shots);
      steps.forEach((step, k) => {
        start[k] = (k > 0 ? start[k - 1]! : 0) + step;
      });
      look = { shots: { start, hi, lo, contrast }, tone };
    }
    const times = new Float64Array(frames);
    let micro = first;
    for (let i = 0; i < frames; i++) {
      if (i > 0) micro += deltas[i - 1]!;
      times[i] = micro / 1e6;
    }
    const cuts = new Float32Array(frames);
    let frame = 0;
    at.forEach((step, k) => {
      frame += step;
      if (frame < frames) cuts[frame] = strength[k]! / 10;
    });
    return {
      ...rest,
      silences: silences.map(([start, end]) => ({ start, end })),
      times,
      cuts,
      logo:
        spans === null || scores === null
          ? null
          : {
              spans: spans.map(([start, end]) => ({ start, end })),
              scores: Float32Array.from(scores, (s) => s / SCORE_SCALE),
            },
      look,
    };
  } catch {
    return null;
  }
}
