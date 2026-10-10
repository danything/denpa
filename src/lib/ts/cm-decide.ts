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
    /** 弱い切れ目 (明るい絵どうしの切り替わり)。ロゴが替わった所を探すときだけ見る */
    weak: number[];
}

/** 境目として見る無音の最短 (秒)。ロゴがあれば短い無音も拾う (CM の継ぎ目でも 0.35 秒のことがある) */
const SILENCE_MIN = 0.2;
/**
 * ロゴを使わないときの無音の最短 (秒)。本編の「間」を拾わないよう長めに取る。
 * 実機 16 本で 0.4 秒にすると余分 67・抜け 42、0.8 秒で余分 37・抜け 32 (境目 123 のうち)
 */
const SILENCE_MIN_ALONE = 0.8;
/** 無音の前後どれだけまで切れ目を探すか (秒)。切れ目は無音の少し外に来ることがある */
const REACH = 0.2;
/** これより弱い切れ目は切れ目と見ない */
const CUT_MIN = 8;
/** ロゴが替わった所を探すときに見る、弱い切れ目の下限 */
const CUT_WEAK = 3;

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
 * 無音ごとに、その中 (と少し外) の切れ目を拾う。CM の継ぎ目は必ず無音と切れ目が重なる。
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
            for (let i = lowerBound(times, silence.start - REACH); i < times.length; i++) {
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

/**
 * ロゴの境目からどれだけ離れた無音まで寄せるか (秒)。ロゴは番組が戻ってから数秒遅れて出ることがあり
 * (局がロゴを後から重ねる・判定がならしのぶん遅れる)、実機では 4.7 秒遅れていた (BSテレ東)
 */
const SNAP = 5;
/** 切れ目の無い無音を、どれだけ遠いとみなすか (秒) */
const STILL_PENALTY = 1.5;

/**
 * ロゴの出入り `at` に寄せる境目。**近くの切れ目のうち、ロゴの点が大きく替わったもの** (`change`)、
 * 無ければロゴの出入りにいちばん近い無音の、いちばん強い切れ目。継ぎ目の無音に切れ目が2つあるとき
 * (番組の絵 → 番宣のフェード)、強いほうではなくロゴが替わったほうが境目。
 * 切れ目の無い無音 (真ん中を置いたもの) は、切れ目のあるものより遠いとみなす (CM の継ぎ目にはふつう切れ目がある)。
 * 近くに無音が無ければ (無音を挟まずに CM へ入る) ロゴの出入りそのもの (`snapped` が偽)
 */
function snap(
    at: number,
    candidates: Boundary[],
    change?: (t: number) => number,
): { at: number; snapped: boolean } {
    let best = at;
    let distance = SNAP;
    let biggest = CHANGE_MIN;
    let changed: number | null = null;
    for (const b of candidates) {
        if (b.silence.end + REACH < at - SNAP || b.silence.start - REACH > at + SNAP) continue;
        if (change !== undefined) {
            for (const cut of [...(b.still ? [] : b.cuts), ...b.weak]) {
                const c = Math.abs(cut - at) < SNAP ? change(cut) : 0;
                if (c > biggest) {
                    biggest = c;
                    changed = cut;
                }
            }
        }
        // 無音ごとにいちばん強い切れ目で比べる
        const d = Math.abs(b.cuts[0]! - at) + (b.still ? STILL_PENALTY : 0);
        if (d < distance) {
            distance = d;
            best = b.cuts[0]!;
        }
    }
    if (changed !== null) return { at: changed, snapped: true };
    return { at: best, snapped: distance < SNAP };
}

/** ロゴの点の変わり方をみる幅 (秒) */
const CHANGE_WINDOW = 1;
/**
 * ロゴが替わったとみなす点の差。これに届く切れ目が無ければ、ロゴの出入りにいちばん近いもの。
 * 消えた側の点は残った側の半分以下 (`CHANGE_RATIO`)。明るい場面に替わって点が下がっただけの所を拾わない
 */
const CHANGE_MIN = 0.2;
const CHANGE_RATIO = 0.5;

/**
 * 切れ目の前後でロゴの点がどれだけ変わったか (`way` が 1 なら上がった量、-1 なら下がった量)。
 * ロゴの出入りの判定 (`logo-detect.logoSpans`) はならすぶん遅れ、ロゴに似た字 (番宣の放送時刻) に
 * 引きずられることもある。点が実際に大きく替わった切れ目のほうが確か (実機の日テレの番宣で 5 秒)
 */
function logoChange(input: CmInput, way: 1 | -1): ((t: number) => number) | undefined {
    const { times, logoScores } = input;
    if (times === undefined || logoScores === undefined) return undefined;
    const mean = (from: number, to: number) => {
        let sum = 0;
        let count = 0;
        for (let i = lowerBound(times, from); i < times.length && times[i]! < to; i++) {
            sum += logoScores[i]!;
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
        lit += Math.max(0, Math.min(span.end, range.end) - Math.max(span.start, range.start));
    return range.end > range.start ? lit / (range.end - range.start) : 0;
}

/** 番組の間で CM とみなす、ロゴの消えている最短 (秒)。これより短いのはアイキャッチなど */
const GAP_MIN = 14.5;
/** 番組の置き場所として同じくらい良いとみなす差 (ロゴの出ている秒) */
const WINDOW_SLACK = 0.5;
/** 録画の端で切れているとみなす幅 (秒) */
const EDGE = 1;

/**
 * **番組表の尺に収まる所だけを番組にする。** 録画は番組の前後を少し余分に録るので、同じ局の
 * 前の番組の終わり・次の番組の頭にもロゴが出る (CM を挟まずに続くこともある)。
 *
 * 尺の窓を、ロゴの出始めから始まる所・ロゴの消え際で終わる所に置いてみて、**ロゴがいちばん多く入る所**を採る。
 * 同じくらいなら番組表どおりの頭 (`programStart`) に近い所。窓の外のロゴは前後の番組として外し、窓の端は近くの無音の切れ目に寄せる。
 * ロゴの無い所は窓の中でも外でも CM なので、窓が少しずれても番組は削れない
 */
function withinProgram(spans: Range[], input: CmInput, candidates: Boundary[]): Range[] {
    const { duration, programLength: length, programStart = 0 } = input;
    if (length === undefined || !(length > 0) || length >= duration) return spans;
    const covered = (from: number) => coverage(spans, { start: from, end: from + length }) * length;
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
        places.length > 0 ? places : [Math.min(Math.max(0, programStart), duration - length)]
    ).map((at) => ({ at, lit: covered(at) }));
    const best = Math.max(...scores.map((s) => s.lit));
    let head = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (const { at, lit } of scores) {
        if (lit < best - WINDOW_SLACK || Math.abs(at - programStart) >= distance) continue;
        distance = Math.abs(at - programStart);
        head = at;
    }
    /*
     * 置き場所の手がかりが番組表だけのときは、頭は切らない。録画が遅れて始まると番組表どおりの頭は
     * 実際より後ろになり、番組の頭を削ってしまう (尻の次の番組は削っても番組は減らない)
     */
    const start = places.length > 0 ? snap(head, candidates).at : 0;
    const end = snap(head + length, candidates).at;
    return spans
        .map((span) => ({ start: Math.max(span.start, start), end: Math.min(span.end, end) }))
        .filter((span) => span.end > span.start);
}

/** ロゴの出ていない所を CM にする。境目は近くの無音の切れ目に寄せ、CM の並び (15秒の倍数) で詰める */
function byLogo(input: CmInput, logo: Range[], candidates: Boundary[]): Range[] {
    const { duration } = input;
    const spans = withinProgram(
        [...logo].sort((a, b) => a.start - b.start),
        input,
        candidates,
    );
    const gaps: Range[] = [];
    let cursor = 0;
    for (const span of spans) {
        gaps.push({ start: cursor, end: span.start });
        cursor = Math.max(cursor, span.end);
    }
    gaps.push({ start: cursor, end: duration });

    // CM の並びをたどるときは、無音の中の切れ目を全部候補にする (いちばん強い切れ目が継ぎ目とは限らない)
    const marks = candidates.flatMap((b) => b.cuts).sort((a, b) => a - b);
    const fall = logoChange(input, -1);
    const rise = logoChange(input, 1);
    const out: Range[] = [];
    for (const gap of gaps) {
        // 録画の頭と尻は前後の番組。それ以外は番組の終わりから始まり、番組の頭で終わる
        const afterProgram = gap.start > 0;
        const beforeProgram = gap.end < duration;
        const start = afterProgram ? snap(gap.start, candidates, fall) : { at: 0, snapped: true };
        const end = beforeProgram ? snap(gap.end, candidates, rise) : { at: duration, snapped: true };
        if (end.at - start.at <= 0.5) continue;
        // 頭と尻は短くても CM。番組の間は CM の尺に足りなければ番組
        if (afterProgram && beforeProgram && end.at - start.at < GAP_MIN) continue;
        out.push(...arrange(start, end, marks, afterProgram, beforeProgram));
    }
    return out;
}

/**
 * CM の並びをたどるときの、15秒の倍数とみなす誤差 (秒)。境目は切れ目のコマで取れているので狭くてよい
 * (実機の CM の継ぎ目どうしは 0.05 秒以内)。広いと番組の中の無音まで並びに入る
 */
const CHAIN_TOLERANCE = 0.25;

/**
 * `from` から境目を CM の尺 (15秒の倍数) ずつたどって、どこまで行けるか。`step` は向き (1 / -1)。
 * CM の中の無音 (場面の切れ目) は飛ばして、次に尺の合う境目へ進む
 */
function chain(from: number, limit: number, step: 1 | -1, marks: number[]): number {
    let at = from;
    for (;;) {
        const next = (step > 0 ? marks : [...marks].reverse()).find(
            (t) =>
                (t - at) * step > 0 &&
                (limit - t) * step >= -0.5 &&
                isCmLength((t - at) * step, CHAIN_TOLERANCE),
        );
        if (next === undefined) return at;
        at = next;
    }
}

/** 提供の尺 (秒) */
const CREDITS = 10;
/** 提供の尺とみなす誤差 (秒) */
const CREDIT_TOLERANCE = 0.4;

/**
 * ロゴの消えている所を、CM の並びで詰める。`afterProgram`・`beforeProgram` は番組に接している側。
 *
 * - **ロゴが遅れて出る・先に消える**所は CM ではない。片側から CM の尺でたどった並びが
 *   反対側の手前で止まり、残りが CM の尺に足りなければ、そこは番組 (アイキャッチ・ロゴの無い頭)
 * - **提供は番組に残す。** 番組に接する所、または番組の終わりから CM の並びをたどった先にある
 *   10 秒は提供 (CM は 15 秒の倍数)。番組の絵に字を重ねていることが多く、削ると番組が欠ける。
 *   番組が戻る手前の並びの中の 10 秒は局の番宣
 */
function arrange(
    from: { at: number; snapped: boolean },
    to: { at: number; snapped: boolean },
    all: number[],
    afterProgram: boolean,
    beforeProgram: boolean,
): Range[] {
    let start = from.at;
    let end = to.at;
    const marks = all.filter((t) => t >= start - 0.5 && t <= end + 0.5);
    // たどり始めるのは無音の切れ目から (寄せられなかったロゴの出入りからは、尺がたまたま合っても数えない)
    const forward = afterProgram && from.snapped ? chain(start, end, 1, marks) : start;
    const backward = beforeProgram && to.snapped ? chain(end, start, -1, marks) : end;
    // 両側からの並びが出会えば、ロゴの消えている所がそのまま CM
    if (backward > forward + 0.5) {
        // 近くに無音の無かったロゴの出入りは当てにしない。CM の並びが止まった所まで
        const both = afterProgram && beforeProgram;
        if (beforeProgram && !to.snapped && forward > start) end = forward;
        else if (afterProgram && !from.snapped && backward < end) start = backward;
        else if (both && forward > start && end - forward < GAP_MIN) end = forward;
        else if (both && backward < end && backward - start < GAP_MIN) start = backward;
    }
    const credit = (from: number, to: number) => Math.abs(to - from - CREDITS) <= CREDIT_TOLERANCE;
    const inner = marks.filter((t) => t > start + 0.5 && t < end - 0.5);
    const out: Range[] = [];
    if (afterProgram) {
        // 番組の終わりから CM の並びをたどった先 (0 本なら番組の直後)
        const reach = chain(start, end, 1, inner);
        const next = inner.find((t) => t > reach + 0.5);
        if (next !== undefined && credit(reach, next)) {
            if (reach - start > 0.5) out.push({ start, end: reach });
            start = next;
        }
    }
    if (beforeProgram) {
        // 番組が戻る直前だけ
        const previous = inner.filter((t) => t > start + 0.5).at(-1);
        if (previous !== undefined && credit(previous, end)) end = previous;
    }
    if (end - start > 0.5) out.push({ start, end });
    return out;
}

/** 「15秒の倍数」とみなす誤差 (秒) */
const CM_TOLERANCE = 0.6;
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
 * 本編の「間」を拾うことがあるので、30秒以上続いたものだけ
 */
function byLength(input: CmInput, candidates: Boundary[]): Range[] {
    const edges = [0, ...points(candidates), input.duration];
    const blocks: Range[] = [];
    let current: Range | null = null;
    for (let i = 0; i < edges.length - 1; i++) {
        const segment = { start: edges[i]!, end: edges[i + 1]! };
        if (isCmLength(segment.end - segment.start)) {
            current = current === null ? segment : { start: current.start, end: segment.end };
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
        ? byLogo(input, logo, boundaries(input))
        : byLength(input, boundaries(input, SILENCE_MIN_ALONE));
}
