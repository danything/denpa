/**
 * CM の境目を決める (純粋な計算)。材料は `server/cm-scan.ts` が1回の復号で取ったもの。
 *
 * 秒はどれも ffmpeg の時刻 (入れ物の頭を 0)。
 */

export interface Range {
  start: number;
  end: number;
}

export interface CmInput {
  /** 尺 (秒) */
  duration: number;
  /** 無音 (秒) */
  silences: Range[];
  /** コマごとの時刻 (秒) と場面の変わり方 (`scdet`)。無ければ無音の真ん中を境目にする */
  times?: ArrayLike<number>;
  cuts?: ArrayLike<number>;
  /** ロゴの出ている区間 (秒)。無ければ CM の尺 (15 秒の倍数) だけで決める */
  logo?: Range[] | null;
  /** コマごとのロゴの点 (`times` と同じ並び)。境目の候補のうちロゴが替わった所を選ぶのに使う */
  logoScores?: ArrayLike<number>;
  /** 番組の尺 (番組表。秒)。録画の頭と尻に入った前後の番組を見分けるのに使う */
  programLength?: number;
  /** 番組表どおりなら番組が始まる秒 (録画の前のマージン)。番組の置き場所が決めきれないときの目安 */
  programStart?: number;
}

/** 境目の候補。無音1つにつき、その中の切れ目 (無ければ真ん中) */
export interface Boundary {
  /** 無音 */
  silence: Range;
  /** 切れ目 (新しい場面の1コマ目の秒)。強い順 */
  cuts: number[];
  /** 切れ目が無かった (無音の真ん中を置いた) */
  still: boolean;
  /** 弱い切れ目 (明るい映像どうしの切り替わり) */
  weak: number[];
}

/** 境目として見る無音の最短 (秒)。ロゴがあれば短い無音も使う (CM の継ぎ目でも 0.35 秒のことがある) */
const SILENCE_MIN = 0.2;
/**
 * ロゴを使わないときの無音の最短 (秒)。本編の「間」を境目にしないよう長めに取る。
 * 実機 16 本で 0.4 秒にすると余分 67・抜け 42、0.8 秒で余分 37・抜け 32 (境目 123 のうち)
 */
const SILENCE_MIN_ALONE = 0.8;
/** 無音の前後どれだけまで切れ目を探すか (秒)。切れ目は無音の少し外に来ることがある */
const REACH = 0.2;
/** これより弱い切れ目は切れ目と見ない */
const CUT_MIN = 8;
/** 弱い切れ目の下限。明るい映像どうしの切り替わりはこのくらい */
const CUT_WEAK = 3;
/** 「15秒の倍数」とみなす誤差 (秒) */
const CM_TOLERANCE = 0.6;

/** 最初に `at` 以上になる位置 */
function lowerBound(values: ArrayLike<number>, at: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 無音ごとに、その中 (と少し外) の切れ目を探す。CM の継ぎ目は必ず無音と切れ目が重なる。
 * 切れ目が無ければ (黒から黒など) 無音の真ん中
 */
export function boundaries(input: CmInput, shortest = SILENCE_MIN): Boundary[] {
  const { times, cuts, duration } = input;
  const out: Boundary[] = [];
  for (const silence of input.silences) {
    if (silence.end - silence.start < shortest) continue;
    const found: { at: number; cut: number }[] = [];
    const weak: number[] = [];
    if (times !== undefined && cuts !== undefined) {
      for (
        let i = lowerBound(times, silence.start - REACH);
        i < times.length;
        i++
      ) {
        if (times[i]! > silence.end + REACH) break;
        if (cuts[i]! >= CUT_MIN) found.push({ at: times[i]!, cut: cuts[i]! });
        else if (cuts[i]! >= CUT_WEAK) weak.push(times[i]!);
      }
    }
    const still = found.length === 0;
    const at = still
      ? [(silence.start + silence.end) / 2]
      : found.sort((a, b) => b.cut - a.cut).map((c) => c.at);
    const inside = at.filter((t) => t > 0 && t < duration);
    if (inside.length > 0) out.push({ silence, cuts: inside, still, weak });
  }
  return out;
}

/** 境目の位置 (無音ごとにいちばん強い切れ目)。時刻の順で、近すぎるものは1つに */
function points(candidates: Boundary[]): number[] {
  const out: number[] = [];
  for (const at of candidates.map((b) => b.cuts[0]!).sort((a, b) => a - b)) {
    if (out.length === 0 || at - out.at(-1)! > 0.5) out.push(at);
  }
  return out;
}

/** 番組の尺の窓の端を、どれだけ離れた無音まで寄せるか (秒) */
const SNAP = 5;
/** 切れ目の無い無音を、どれだけ遠いとみなすか (秒) */
const STILL_PENALTY = 1.5;

/** `at` にいちばん近い無音の、いちばん強い切れ目。`SNAP` 秒より遠ければ `at` のまま (番組の尺の窓の端) */
function snap(at: number, candidates: Boundary[]): number {
  let best = at;
  let distance = SNAP;
  for (const b of candidates) {
    const d = Math.abs(b.cuts[0]! - at) + (b.still ? STILL_PENALTY : 0);
    if (d < distance) {
      distance = d;
      best = b.cuts[0]!;
    }
  }
  return best;
}

/** ロゴの点の変わり方をみる幅 (秒) */
const CHANGE_WINDOW = 1;
/** 消えた側の点が残った側のこの割合より大きければ、ロゴが替わったとは見ない (明るい場面で点が下がっただけ) */
const CHANGE_RATIO = 0.5;

/**
 * 切れ目の前後でロゴの点がどれだけ変わったか (`way` が 1 なら上がった量、-1 なら下がった量)。
 * ロゴの出入りの判定 (`logo-detect.logoSpans`) はならすぶん遅れ、ロゴに似た字 (番宣の放送時刻) に
 * 引きずられることもある。点が実際に大きく替わった切れ目のほうが確か (実機の日テレの番宣で 5 秒)
 */
function logoChange(
  input: CmInput,
  way: 1 | -1,
): ((t: number) => number) | undefined {
  const { times, logoScores } = input;
  if (
    times === undefined ||
    logoScores === undefined ||
    logoScores.length === 0
  )
    return undefined;
  const mean = (from: number, to: number) => {
    let sum = 0;
    let count = 0;
    for (
      let i = lowerBound(times, from);
      i < times.length && times[i]! < to;
      i++
    ) {
      sum += logoScores[i] ?? 0;
      count++;
    }
    return count > 0 ? sum / count : 0;
  };
  return (t) => {
    const [lit, dark] =
      way > 0
        ? [mean(t, t + CHANGE_WINDOW), mean(t - CHANGE_WINDOW, t)]
        : [mean(t - CHANGE_WINDOW, t), mean(t, t + CHANGE_WINDOW)];
    return dark <= lit * CHANGE_RATIO ? lit - dark : 0;
  };
}

/** `range` のうちロゴが出ていた割合 */
function coverage(logo: Range[], range: Range): number {
  let lit = 0;
  for (const span of logo)
    lit += Math.max(
      0,
      Math.min(span.end, range.end) - Math.max(span.start, range.start),
    );
  return range.end > range.start ? lit / (range.end - range.start) : 0;
}

/** 番組の間で CM とみなす、ロゴの消えている最短 (秒)。これより短いのはアイキャッチなど */
const GAP_MIN = 14.5;
/** 番組の置き場所として同じくらい良いとみなす差 (ロゴの出ている秒) */
const WINDOW_SLACK = 0.5;
/** 録画の端で切れているとみなす幅 (秒) */
const EDGE = 1;
/**
 * 番組の置き場所を番組表どおりの頭からずらすときの減点 (1 秒ずらすごとに、ロゴの出ている秒で)。
 *
 * **ロゴの秒数だけで比べると、尻の次の番組に引っぱられる。** 実機のテレ東のアニメで、頭のロゴが 7.6 秒しか拾えず
 * (アバンの途中でロゴを見失った)、尻に入った次の番組のロゴが 10 秒あったため、窓を 13 秒後ろへずらして
 * 番組の頭の 30 秒を CM にしていた。番組表の頭はふつう数秒しか外れない。大きくずれた放送 (延長など) は、
 * ずらしたぶんだけロゴが入るので、この減点を上回る
 */
const DRIFT_COST = 0.5;

/**
 * **番組表の尺に収まる所だけを番組にする。** 録画は番組の前後を少し余分に録るので、同じ局の
 * 前の番組の終わり・次の番組の頭にもロゴが出る (CM を挟まずに続くこともある)。
 *
 * 尺の窓を、ロゴの出始めから始まる所・ロゴの消え際で終わる所に置いてみて、**ロゴがいちばん多く入る所**を採る。
 * 番組表どおりの頭 (`programStart`) から離れるほど減点し (`DRIFT_COST`)、同じくらいなら近い所。窓の外のロゴは前後の番組として外し、窓の端は近くの無音の切れ目に寄せる。
 * ロゴの無い所は窓の中でも外でも CM なので、窓が少しずれても番組は削れない
 */
function withinProgram(
  spans: Range[],
  input: CmInput,
  candidates: Boundary[],
): Range[] {
  const { duration, programLength: length } = input;
  const programStart = input.programStart ?? 0;
  // 番組表どおりの頭が分からなければ、離れても減点しない
  const drift = input.programStart === undefined ? 0 : DRIFT_COST;
  if (length === undefined || !(length > 0) || length >= duration) return spans;
  const covered = (from: number) =>
    coverage(spans, { start: from, end: from + length }) * length;
  /*
   * 置き場所の候補: ロゴの出始めから始まる・ロゴの消え際で終わる所 (番組はたいていロゴと一緒に始まり、終わる)。
   * 録画の端で切れているロゴは、そこで出始めた・消えたのではないので使わない
   */
  const places = spans
    .flatMap((span) => [
      ...(span.start > EDGE ? [span.start] : []),
      ...(span.end < duration - EDGE ? [span.end - length] : []),
    ])
    .filter((at) => at >= 0 && at <= duration - length);
  const scores = (
    places.length > 0
      ? places
      : [Math.min(Math.max(0, programStart), duration - length)]
  ).map((at) => ({
    at,
    value: covered(at) - drift * Math.abs(at - programStart),
  }));
  const best = Math.max(...scores.map((s) => s.value));
  let head = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const { at, value } of scores) {
    if (value < best - WINDOW_SLACK || Math.abs(at - programStart) >= distance)
      continue;
    distance = Math.abs(at - programStart);
    head = at;
  }
  /*
   * 置き場所の手がかりが番組表だけのときは、頭は切らない。録画が遅れて始まると番組表どおりの頭は
   * 実際より後ろになり、番組の頭を削ってしまう (尻の次の番組は削っても番組は減らない)
   */
  const start = places.length > 0 ? snap(head, candidates) : 0;
  const end = snap(head + length, candidates);
  return spans
    .map((span) => ({
      start: Math.max(span.start, start),
      end: Math.min(span.end, end),
    }))
    .filter((span) => span.end > span.start);
}

/*
 * ここから、ロゴで決めるときの点数 (`byLogo`)。区間ごとの点 (CM の尺・ロゴの出ている秒) と、番組と CM が替わる
 * 境目の点 (切れ目・無音・ロゴの出入りからの距離) の和。規則を順に当てると、継ぎ目が 0.3〜0.5 秒ずれただけで先が崩れる
 */

/** 番組: ロゴの出ている 1 秒ごとの点 */
const PROGRAM_LOGO = 1;
/**
 * 番組: ロゴの無い 1 秒ごとの減点。CM の尺に合わない所の減点 (`CM_MISFIT`) とつり合わせて、
 * 番組の間の 14.5 秒より短いロゴの途切れ (アイキャッチ) は番組に残す
 */
const PROGRAM_BARE = 0.5;
/** CM: 尺が 15 秒の倍数にぴったりのときの 1 秒ごとの点。ずれると減り、`CM_TOLERANCE` で 0 */
const CM_FIT = 1;
/** CM: 尺がどの倍数にも合わない (外れが `CM_TOLERANCE` 以上の) 区間の減点。ロゴの無い 14.5 秒の番組と同じ */
const CM_MISFIT = GAP_MIN * PROGRAM_BARE;
/** CM: ロゴの出ている 1 秒ごとの減点。番組の点 (`PROGRAM_LOGO`) と CM の点 (`CM_FIT`) の和より大きく */
const CM_LOGO = 3;
/** 局の短い告知の尺 (秒)。CM の尺 (15 秒) より短い。CM の続きでだけ CM とみる */
const SPOTS = [5, 10];
/** 告知: ぴったりのときの 1 秒ごとの点。15 秒の倍数より低い */
const SPOT_FIT = 0.5;
/** 告知の尺とみなす誤差 (秒)。実機の BS-TBS で 5.47 秒の告知があった */
const SPOT_TOLERANCE = 0.6;
/**
 * CM に挟まれた短い所 (`ISLAND_MAX` 秒以内のロゴの出ている所) の頭の告知の点。局の 5 秒の告知はロゴを出したまま流れ、
 * 次回予告との間に無音が無いことがある (実機で 5 秒の告知 → 次回予告 → 提供)。ロゴの減点はせず、番組にしたときと同じ点にこれを足す
 */
const SPOT_ISLAND = 4;
/** CM に挟まれた短い所の最長 (秒)。番組の終わりの次回予告と提供など */
const ISLAND_MAX = 60;
/** 告知を除いたあとに残す、ロゴの出ている所の最短 (秒) */
const ISLAND_REST = 15;
/** 提供の尺 (秒) と誤差 */
const CREDITS = 10;
const CREDIT_TOLERANCE = 0.4;
/**
 * 提供を番組に残す点。番組の直後、または番組の終わりから CM の並びをたどった先の 10 秒と、
 * 並びの外にある番組が戻る直前の 10 秒。告知 (10 秒) を CM にしたときの点とロゴの無い 10 秒の減点の和より大きく。
 * 並びの外の提供には 10 秒のうちロゴの無い割合だけ付け (`creditBonus`)、提供のあとに続く CM が 15 秒の倍数か告知のときだけ付ける
 */
const CREDIT = 14;
/**
 * 境目の減点 (ぴったりの境目は 0)。番組と CM が替わる所だけに付く。強い切れ目 (`CUT_FULL` 以上) と
 * 長い無音 (`SILENCE_FULL` 秒以上) は減点なし。ロゴの点が大きく替わった切れ目 (`CHANGE_FULL` 以上) も同じ
 */
const CUT_COST = 2;
const CUT_FULL = 20;
const SILENCE_COST = 1;
const SILENCE_FULL = 1;
const CHANGE_COST = 1.5;
const CHANGE_FULL = 0.5;
/**
 * ロゴの出入りから離れた境目の減点 (1 秒ごと)。**近いうちはほとんど減らさず** (`EDGE_NEAR`)、ロゴが消える側は 5 秒、
 * 戻る側は 8 秒を超えると大きく減らす (`EDGE_FAR`)。ロゴは番組が戻ってから遅れて出ることがあり、
 * 明るい場面で始まると判定も遅れる (実機で 4.7〜5.9 秒)
 */
const EDGE_NEAR = 0.1;
const EDGE_FAR = 2;
const EDGE_FLAT_FALL = 5;
const EDGE_FLAT_RISE = 8;
/** ロゴの出入りが1つも無いときの減点の上限 */
const EDGE_CAP = 30;

/**
 * 無音1つから採る切れ目の数 (強いほうから)。動いている場面の無音には弱い切れ目がいくつも並ぶので、比べる数を抑える
 */
const PER_SILENCE = 4;

/** 候補の種類。`mark` は無音の中、`end` は録画の頭と尻、`bare` は無音の外の強い切れ目、`logo` はロゴの出入りそのもの */
type Kind = "mark" | "end" | "bare" | "logo";

interface Candidate {
  at: number;
  /** 切れ目の強さ (無ければ 0) */
  cut: number;
  /** 無音の長さ (秒。無ければ 0) */
  silence: number;
  kind: Kind;
}

/**
 * 境目の候補。**無音の中の切れ目を強いものも弱いものも** (継ぎ目の無音に切れ目が2つあると、強いほうが継ぎ目とは限らない)。
 * 無音1つにつき強いほうから `PER_SILENCE` 個まで。切れ目が無ければ無音の真ん中。ほかに、
 *
 * - 録画の頭と尻
 * - 無音の候補からちょうど 5・10 秒の、無音の外の強い切れ目 (`bare`)。CM に挟まれた短い所の頭の告知の終わりにだけ使う
 * - 最初のロゴの出始めと最後の消え際 (`logo`)。録画の頭と尻の CM の端にだけ使う (前後の番組との境目は無音を挟まないことがある)
 */
function candidates(
  input: CmInput,
  logo: Range[],
  silences: Boundary[],
): Candidate[] {
  const { duration, times, cuts } = input;
  const strength = (t: number) => {
    if (times === undefined || cuts === undefined) return 0;
    const i = lowerBound(times, t - 1e-6);
    return i < times.length && Math.abs(times[i]! - t) < 1e-6 ? cuts[i]! : 0;
  };
  const out: Candidate[] = [];
  for (const b of silences) {
    const silence = b.silence.end - b.silence.start;
    const middle = (b.silence.start + b.silence.end) / 2;
    const found = [...b.cuts, ...b.weak]
      .filter((t) => !b.still || t !== middle)
      .map((t) => ({ at: t, cut: strength(t) }))
      .sort((x, y) => y.cut - x.cut)
      .slice(0, PER_SILENCE);
    if (b.still) found.push({ at: middle, cut: 0 });
    for (const { at, cut } of found)
      if (at > 0 && at < duration) out.push({ at, cut, silence, kind: "mark" });
  }
  if (times !== undefined && cuts !== undefined) {
    const marks = out.map((c) => c.at).sort((a, b) => a - b);
    const near = (t: number) => {
      const k = lowerBound(marks, t - 0.5);
      return k < marks.length && marks[k]! < t + 0.5;
    };
    for (const from of marks) {
      for (const spot of SPOTS) {
        for (
          let i = lowerBound(times, from + spot - 0.25);
          i < times.length;
          i++
        ) {
          if (times[i]! > from + spot + 0.25) break;
          const t = times[i]!;
          if (cuts[i]! >= CUT_MIN && t < duration && !near(t))
            out.push({ at: t, cut: cuts[i]!, silence: 0, kind: "bare" });
        }
      }
    }
  }
  const first = logo[0];
  const last = logo.at(-1);
  if (first !== undefined && first.start > EDGE)
    out.push({ at: first.start, cut: 0, silence: 0, kind: "logo" });
  if (last !== undefined && last.end < duration - EDGE)
    out.push({ at: last.end, cut: 0, silence: 0, kind: "logo" });
  out.sort((a, b) => a.at - b.at);
  // 同じ時刻は1つに (無音が重なっていた・ロゴの出入りが切れ目と同じ)。強いほうを残す
  const merged: Candidate[] = [{ at: 0, cut: 0, silence: 0, kind: "end" }];
  const rank = { end: 3, mark: 2, bare: 1, logo: 0 };
  for (const c of out) {
    const prev = merged.at(-1)!;
    if (c.at - prev.at < 1e-3) {
      if (prev.kind === "end") continue;
      if (rank[c.kind] > rank[prev.kind]) prev.kind = c.kind;
      prev.cut = Math.max(prev.cut, c.cut);
      prev.silence = Math.max(prev.silence, c.silence);
    } else {
      merged.push({ ...c });
    }
  }
  if (duration - merged.at(-1)!.at < 1e-3) merged.pop();
  merged.push({ at: duration, cut: 0, silence: 0, kind: "end" });
  return merged;
}

/** 15 秒の倍数への合い方 (ぴったりで 1、`CM_TOLERANCE` 外れて 0)。15〜180 秒の外は 0 */
function fit15(seconds: number): number {
  if (!isCmLength(seconds)) return 0;
  return 1 - Math.abs(seconds - Math.round(seconds / 15) * 15) / CM_TOLERANCE;
}

/** 告知の尺 (5・10 秒) への合い方 */
function fitSpot(seconds: number): number {
  let best = 0;
  for (const spot of SPOTS)
    best = Math.max(best, 1 - Math.abs(seconds - spot) / SPOT_TOLERANCE);
  return best;
}

/**
 * 分け方の途中の状態 (いま終わった区間が何だったか)。CM が 15 秒の倍数で並んでいるか、提供の手前が何だったかで
 * 次の区間の点が変わる
 */
const State = {
  /** 番組 */
  Program: 0,
  /** CM。番組の終わりから 15 秒の倍数ばかりで並んでいる */
  Chain: 1,
  /** CM。直前の区間が 15 秒の倍数 */
  Fit: 2,
  /** CM。それ以外 (尺の合わないもの・告知・録画の端) */
  Other: 3,
  /** CM。番組のあとに告知だけ (このまま番組に戻るなら尺の合わない CM とみる) */
  Spot: 4,
  /** CM。無音の外の切れ目で終わった告知 (次は番組) */
  Bare: 5,
  /** 提供 (番組)。その手前が番組 / 並び / 15 秒の倍数 / それ以外の CM */
  CreditAfterProgram: 6,
  CreditAfterChain: 7,
  CreditAfterFit: 8,
  CreditAfterOther: 9,
} as const;
type State = (typeof State)[keyof typeof State];
const STATES = 10;

const isCm = (s: State) => s >= State.Chain && s <= State.Bare;
const isCredit = (s: State) => s >= State.CreditAfterProgram;

/**
 * 提供として番組に残す点。次の区間 (`next` が CM か) で決まる。
 * 番組の直後・番組の終わりからの CM の並びの先の 10 秒は、次が CM なら提供。並びの外にある 10 秒は、次が番組なら提供。
 * 15 秒の倍数の CM に続いて番組に戻る 10 秒は局の番宣 (CM) なので点を付けない
 *
 * **並びの外の提供には、10 秒のうちロゴの無い割合 (`bare`) だけ付ける。** ロゴの出ている 10 秒は、点が無くても番組になる。
 * 次が CM の提供の点は、呼ぶ側で続く CM が 15 秒の倍数か告知のときだけ足す。どちらも無いと、本編の中でロゴが数秒だけ
 * 途切れた所が、前後 10 秒に無音と切れ目があるだけで「提供と尺の合わない CM」になっていた
 * (実機のフジテレビのアニメで 2.5・4.3・10.8 秒の CM)
 */
function creditBonus(state: State, nextIsCm: boolean, bare: number): number {
  if (nextIsCm)
    return state === State.CreditAfterProgram ||
      state === State.CreditAfterChain
      ? CREDIT
      : 0;
  return state === State.CreditAfterOther ? CREDIT * bare : 0;
}

/** ロゴの出ている区間から作る、出ている秒の数え方とロゴの出入り */
function logoIndex(spans: Range[], duration: number) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const s of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && s.start <= last.end)
      last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const starts = merged.map((s) => s.start);
  const before = [0];
  for (const s of merged) before.push(before.at(-1)! + s.end - s.start);
  /** 0 から `t` までにロゴが出ていた秒 */
  const litTo = (t: number) => {
    const k = lowerBound(starts, t + 1e-9) - 1;
    if (k < 0) return 0;
    const s = merged[k]!;
    return before[k]! + Math.max(0, Math.min(t, s.end) - s.start);
  };
  // 録画の端で切れているロゴは、そこで出入りしたのではない
  const rises = merged.map((s) => s.start).filter((t) => t > EDGE);
  const falls = merged.map((s) => s.end).filter((t) => t < duration - EDGE);
  return {
    merged,
    lit: (a: number, b: number) => litTo(b) - litTo(a),
    rises,
    falls,
  };
}

/** `edges` (並んだ時刻) のうち `t` にいちばん近いものまでの距離 */
function nearest(edges: number[], t: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const e of edges) best = Math.min(best, Math.abs(e - t));
  return best;
}

/** ロゴの出入りから `distance` 秒離れた境目の減点 */
function edgeCost(distance: number, flat: number): number {
  if (!Number.isFinite(distance)) return EDGE_CAP;
  const cost =
    distance <= flat
      ? distance * EDGE_NEAR
      : flat * EDGE_NEAR + (distance - flat) * EDGE_FAR;
  return Math.min(EDGE_CAP, cost);
}

/**
 * ロゴの出ていない所を CM にする。**分け方を全部比べて、点数の合計がいちばん高いものを選ぶ** (動的計画法)。
 * 点数は上の定数 (docs/cm.md の「境目の決め方」)。隣り合う CM の区間は1つにまとめて返す
 */
function byLogo(input: CmInput, logo: Range[]): Range[] {
  const { duration } = input;
  const silences = boundaries(input);
  const spans = withinProgram(
    [...logo].sort((a, b) => a.start - b.start),
    input,
    silences,
  );
  const index = logoIndex(spans, duration);
  const nodes = candidates(input, index.merged, silences);
  const n = nodes.length;
  const fall = logoChange(input, -1);
  const rise = logoChange(input, 1);
  const fallChange = nodes.map((c) =>
    fall === undefined || c.kind === "end" ? 0 : fall(c.at),
  );
  const riseChange = nodes.map((c) =>
    rise === undefined || c.kind === "end" ? 0 : rise(c.at),
  );
  const scored = fall !== undefined;

  /**
   * 境目の減点。`starts` は CM の頭か (偽なら CM の終わり)。`also` は提供の反対の端 (近いほうのロゴの出入りで測る)。
   * 番組の終わりから CM の並びをたどった先の提供は、ロゴの消えている所の中にあるので、ロゴの出入りからの距離は見ない (`also` が null)
   */
  const boundaryCost = (
    i: number,
    starts: boolean,
    also?: number | null,
  ): number => {
    const c = nodes[i]!;
    if (c.kind === "end") return 0;
    const at = c.at;
    const edges = starts ? index.falls : index.rises;
    let distance = also === null ? 0 : nearest(edges, at);
    if (also !== undefined && also !== null)
      distance = Math.min(distance, nearest(edges, also));
    const change = starts ? fallChange[i]! : riseChange[i]!;
    return (
      CUT_COST * (1 - Math.min(1, c.cut / CUT_FULL)) +
      SILENCE_COST * (1 - Math.min(1, c.silence / SILENCE_FULL)) +
      (scored ? CHANGE_COST * (1 - Math.min(1, change / CHANGE_FULL)) : 0) +
      edgeCost(distance, starts ? EDGE_FLAT_FALL : EDGE_FLAT_RISE)
    );
  };
  const program = (a: number, b: number) => {
    const lit = index.lit(a, b);
    return PROGRAM_LOGO * lit - PROGRAM_BARE * (b - a - lit);
  };
  /** CM に挟まれた短い所の頭か (告知のあとに `ISLAND_REST` 秒以上ロゴが残る) */
  const island = (a: number, b: number) =>
    index.merged.some(
      (s) =>
        s.start >= a - EDGE &&
        s.start <= a + EDGE &&
        s.end - s.start <= ISLAND_MAX &&
        s.end - b >= ISLAND_REST - CREDIT_TOLERANCE,
    );

  const value = Array.from({ length: n }, () =>
    new Float64Array(STATES).fill(Number.NEGATIVE_INFINITY),
  );
  /** 戻り道: 前の候補 × STATES + 前の状態 */
  const from = Array.from({ length: n }, () => new Int32Array(STATES).fill(-1));
  const relax = (j: number, s: State, v: number, i: number, prev: State) => {
    if (v > value[j]![s]!) {
      value[j]![s] = v;
      from[j]![s] = i * STATES + prev;
    }
  };
  /** いま終わった提供 (候補 `i` で終わった状態 `s`) のうちロゴの無い割合。頭は戻り道から引く */
  const creditBare = (i: number, s: State) => {
    const start = nodes[Math.floor(from[i]![s]! / STATES)]!.at;
    const end = nodes[i]!.at;
    return end > start ? 1 - index.lit(start, end) / (end - start) : 0;
  };
  /** 告知だけの CM のまま番組に戻るときの減点 (告知の点を取り消し、尺の合わない CM とみる) */
  const SOLO = SPOT_FIT * CREDITS + CM_MISFIT;
  value[0]![State.Program] = 0;

  for (let i = 0; i < n - 1; i++) {
    const a = nodes[i]!;
    for (let k = 0; k < STATES; k++) {
      const s = k as State;
      const here = value[i]![s]!;
      if (here === Number.NEGATIVE_INFINITY) continue;

      // 番組へ (隣の候補まで。番組どうしは足し算なので、長い番組は隣ずつつなげば同じ)
      {
        let v = here + program(a.at, nodes[i + 1]!.at);
        if (isCm(s))
          v -= boundaryCost(i, false) + (s === State.Spot ? SOLO : 0);
        if (isCredit(s)) v += creditBonus(s, false, creditBare(i, s));
        relax(i + 1, State.Program, v, i, s);
      }

      // 提供へ (10 秒の番組)
      for (
        let j = i + 1;
        j < n && nodes[j]!.at - a.at <= CREDITS + CREDIT_TOLERANCE;
        j++
      ) {
        const length = nodes[j]!.at - a.at;
        if (length < CREDITS - CREDIT_TOLERANCE) continue;
        let v = here + program(a.at, nodes[j]!.at);
        let next: State = State.CreditAfterProgram;
        if (isCm(s)) {
          v -=
            boundaryCost(i, false, s === State.Chain ? null : nodes[j]!.at) +
            (s === State.Spot ? SOLO : 0);
          next =
            s === State.Chain
              ? State.CreditAfterChain
              : s === State.Fit
                ? State.CreditAfterFit
                : State.CreditAfterOther;
        }
        if (isCredit(s)) v += creditBonus(s, false, creditBare(i, s));
        relax(j, next, v, i, s);
      }

      // CM へ。無音の外の切れ目とロゴの出入りからは始めない。告知が無音の外で終わったら次は番組
      if (s === State.Bare || a.kind === "bare") continue;
      const entering = s === State.Program || isCredit(s);
      let base = here;
      // 提供の点は、続く CM が 15 秒の倍数か告知 (か録画の尻まで) のときだけ足す。尺の合わない短い CM を提供の点で CM にさせない
      let credit = 0;
      if (entering) {
        base -= boundaryCost(
          i,
          true,
          s === State.CreditAfterChain
            ? null
            : isCredit(s)
              ? a.at - CREDITS
              : undefined,
        );
        if (isCredit(s)) credit = creditBonus(s, true, creditBare(i, s));
      }
      const head = i === 0;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        const length = b.at - a.at;
        const tail = j === n - 1;
        if (!head && !tail && length > 180 + CM_TOLERANCE) {
          // 尻に接する区間だけは長さを問わない
          j = n - 2;
          continue;
        }
        const lit = index.lit(a.at, b.at);
        // ロゴの出入りそのものは、録画の頭と尻の CM の端にだけ
        if ((a.kind === "logo" && !tail) || (b.kind === "logo" && !head))
          continue;
        if (head || tail) {
          if (b.kind === "bare") continue;
          relax(j, State.Other, base + credit - CM_LOGO * lit, i, s);
          continue;
        }
        const spot = fitSpot(length);
        if (b.kind === "bare") {
          // 無音の外の切れ目で終わるのは、CM に挟まれた短い所の頭の告知だけ
          if (spot > 0 && !entering && s !== State.Spot && island(a.at, b.at))
            relax(
              j,
              State.Bare,
              base + SPOT_ISLAND * spot + PROGRAM_LOGO * lit,
              i,
              s,
            );
          continue;
        }
        const fit = fit15(length);
        const logoCost = CM_LOGO * lit;
        const cm = CM_FIT * length * fit - CM_MISFIT * (1 - fit) - logoCost;
        const next =
          fit === 0
            ? State.Other
            : entering || s === State.Chain
              ? State.Chain
              : State.Fit;
        relax(j, next, base + cm + (fit > 0 ? credit : 0), i, s);
        if (spot > 0) {
          const short = SPOT_FIT * length * spot - CM_MISFIT * (1 - spot);
          // 番組のあとの告知は、そのあとに CM が続くときだけ (`State.Spot`)
          relax(
            j,
            entering || s === State.Spot ? State.Spot : State.Other,
            base + short - logoCost + credit,
            i,
            s,
          );
          if (!entering && s !== State.Spot && island(a.at, b.at))
            relax(
              j,
              State.Other,
              base + SPOT_ISLAND * spot + PROGRAM_LOGO * lit,
              i,
              s,
            );
        }
      }
    }
  }

  // いちばん点の高い終わり方から戻る
  let best: State = State.Program;
  for (let k = 0; k < STATES; k++)
    if (value[n - 1]![k]! > value[n - 1]![best]!) best = k as State;
  const out: Range[] = [];
  let j = n - 1;
  let s: State = best;
  while (j > 0) {
    const back = from[j]![s]!;
    if (back < 0) break;
    const i = Math.floor(back / STATES);
    if (isCm(s)) {
      const first = out[0];
      if (first !== undefined && first.start === nodes[j]!.at)
        first.start = nodes[i]!.at;
      else out.unshift({ start: nodes[i]!.at, end: nodes[j]!.at });
    }
    s = (back % STATES) as State;
    j = i;
  }
  return out.filter((r) => r.end - r.start > 0.5);
}

/** ロゴを使わないとき、CM ブロックとして採る最短 (秒)。単発の 15 秒は本編のコーナーと紛らわしい */
const BLOCK_MIN = 30;

/** CMの尺は15秒の倍数 (15〜180秒) */
export function isCmLength(seconds: number, tolerance = CM_TOLERANCE): boolean {
  if (seconds < 15 - tolerance || seconds > 180 + tolerance) return false;
  const units = Math.round(seconds / 15);
  return Math.abs(seconds - units * 15) <= tolerance;
}

/**
 * ロゴを使わずに決める。境目と境目の間が CM の尺 (15秒の倍数) になっているところが続けば CM。
 * 本編の「間」に当たることがあるので、30秒以上続いたものだけ
 */
function byLength(input: CmInput, candidates: Boundary[]): Range[] {
  const edges = [0, ...points(candidates), input.duration];
  const blocks: Range[] = [];
  let current: Range | null = null;
  for (let i = 0; i < edges.length - 1; i++) {
    const segment = { start: edges[i]!, end: edges[i + 1]! };
    if (isCmLength(segment.end - segment.start)) {
      current =
        current === null ? segment : { start: current.start, end: segment.end };
    } else if (current !== null) {
      blocks.push(current);
      current = null;
    }
  }
  if (current !== null) blocks.push(current);
  return blocks.filter((b) => b.end - b.start >= BLOCK_MIN);
}

/** CM の区間を決める。ロゴがあればロゴで、無ければ CM の尺だけで */
export function decideCm(input: CmInput): Range[] {
  const { logo } = input;
  return logo !== undefined && logo !== null && logo.length > 0
    ? byLogo(input, logo)
    : byLength(input, boundaries(input, SILENCE_MIN_ALONE));
}
