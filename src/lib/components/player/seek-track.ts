/**
 * シークバー (`SeekBar.svelte`) の溝の区切り。DOM を触らない。
 *
 * 溝は**チャプターの切れ目で区切った部分の並び**にする (CM の端と、それ以外の切れ目)。
 * 部分ごとに要素を置き、すき間 (2px) で区切る。CM の部分は色で分ける (`SeekBar` の色)。
 *
 * 位置はただの比 (0〜1)。入力欄のつまみは幅 1px にして見えなくしてあるので、
 * 押した位置と値は溝の端から端までまっすぐ対応する (つまみの往復ぶんを引かなくてよい)
 */

/** 溝の1部分。`from`・`to` は比 (0〜1)、`cm` は CM の部分か */
export type TrackPart = { from: number; to: number; cm: boolean };

/** 比を 4 桁で丸める (1時間で 0.4 秒。溝の 1px より細かい) */
function round(ratio: number): number {
  return Math.round(ratio * 10000) / 10000;
}

/**
 * CM の区間と切れ目から、溝の部分の並びを作る。
 *
 * 区間は重ならず、並んでいること (`cmSpans` の出すもの)。幅の無いバー (尺がまだ分からない・
 * 戻れる範囲が無い) は区切らず1本にする。バーの外の区間・切れ目は捨てる
 */
export function trackParts(
  spans: { start: number; end: number }[],
  marks: number[],
  min: number,
  max: number,
): TrackPart[] {
  const span = max - min;
  if (!(span > 0)) return [{ from: 0, to: 1, cm: false }];
  const ratio = (at: number) =>
    round(Math.min(1, Math.max(0, (at - min) / span)));

  const cms = spans
    .filter((s) => s.end > s.start && s.end > min && s.start < max)
    .map((s) => ({ from: ratio(s.start), to: ratio(s.end) }))
    .filter((s) => s.to > s.from);
  const cuts = new Set<number>([0, 1]);
  for (const s of cms) {
    cuts.add(s.from);
    cuts.add(s.to);
  }
  for (const at of marks) {
    if (at > min && at < max) cuts.add(ratio(at));
  }
  const sorted = [...cuts].sort((a, b) => a - b);

  const parts: TrackPart[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1] as number;
    const to = sorted[i] as number;
    const middle = (from + to) / 2;
    parts.push({
      from,
      to,
      cm: cms.some((s) => s.from <= middle && middle < s.to),
    });
  }
  return parts;
}

/** 部分の中で観たぶんの比 (0〜1)。`at` はバー全体での比 */
export function playedIn(part: TrackPart, at: number): number {
  if (!(at > part.from)) return 0;
  if (at >= part.to) return 1;
  return round((at - part.from) / (part.to - part.from));
}
