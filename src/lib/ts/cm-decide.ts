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
    /** 弱い切れ目 (明るい映像どうしの切り替わり)。ロゴが替わった所を探すときだけ見る */
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
/**
 * **ロゴが戻る側だけ、もう少し遠くまで寄せる** (秒)。番組が戻った直後が明るい場面だと、ロゴが地に紛れて
 * 判定が遅れる。実機の TOKYO MX で、番組が戻った無音から 5.6 秒遅れてロゴが出て、寄せられずに
 * CM が 60 秒から 15 秒に縮んでいた。消える側は広げない (番組の終わりを削るおそれがある)
 */
const SNAP_RISE = 8;
/** 切れ目の無い無音を、どれだけ遠いとみなすか (秒) */
const STILL_PENALTY = 1.5;

/**
 * ロゴの出入り `at` に寄せる境目。**近くの切れ目のうち、ロゴの点が大きく替わったもの** (`change`)、
 * 無ければロゴの出入りにいちばん近い無音の、いちばん強い切れ目。継ぎ目の無音に切れ目が2つあるとき
 * (番組の映像 → 番宣のフェード)、強いほうではなくロゴが替わったほうが境目。
 * 切れ目の無い無音 (真ん中を置いたもの) は、切れ目のあるものより遠いとみなす (CM の継ぎ目にはふつう切れ目がある)。
 * 近くに無音が無ければロゴの出入りそのもの (`snapped` が偽)。番組の間では、そこを CM の端にはしない (`arrange`)
 */
function snap(
    at: number,
    candidates: Boundary[],
    change?: (t: number) => number,
    reach = SNAP,
): { at: number; snapped: boolean } {
    let best = at;
    let distance = reach;
    let biggest = CHANGE_MIN;
    let changed: number | null = null;
    for (const b of candidates) {
        if (b.silence.end + REACH < at - reach || b.silence.start - REACH > at + reach) continue;
        if (change !== undefined) {
            for (const cut of [...(b.still ? [] : b.cuts), ...b.weak]) {
                const c = Math.abs(cut - at) < reach ? change(cut) : 0;
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
    return { at: best, snapped: distance < reach };
}

/** ロゴの点の変わり方をみる幅 (秒) */
const CHANGE_WINDOW = 1;
/**
 * ロゴが替わったとみなす点の差。これに届く切れ目が無ければ、ロゴの出入りにいちばん近いもの。
 * 消えた側の点は残った側の半分以下 (`CHANGE_RATIO`)。明るい場面に替わって点が下がっただけの所は数えない
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
        const end = beforeProgram
            ? snap(gap.end, candidates, rise, SNAP_RISE)
            : { at: duration, snapped: true };
        if (end.at - start.at <= 0.5) continue;
        // 頭と尻は短くても CM。番組の間は CM の尺に足りなければ番組
        if (afterProgram && beforeProgram && end.at - start.at < GAP_MIN) continue;
        out.push(...arrange(start, end, marks, afterProgram, beforeProgram));
    }
    return trimSpots(input, alignLengths(out, candidates, input.duration));
}

/** CM の尺から外れているとみなして寄せ直す、ずれの上限 (秒)。これより大きくずれたものは CM の並びの外 (提供など) */
const ALIGN_MAX = 1;

/**
 * **CM の端は、尺が 15 秒の倍数になる切れ目を選ぶ。** 継ぎ目の無音の中に切れ目が 2 つあると、強いほう
 * (`Boundary.cuts` の先頭) が継ぎ目とは限らない。明るい本編の終わりから明るい CM の頭へ替わる所は切れ目が弱く、
 * その 0.5 秒後の CM の中の場面の替わりのほうが強かった (実機の TOKYO MX で、CM の頭の白い 0.5 秒が本編の側に残り、
 * 映ってから飛んでいた)。
 *
 * 番組の間の CM で、尺が 15 秒の倍数から少し (`ALIGN_MAX` まで) 外れているとき、端の無音の中のほかの切れ目
 * (弱いものも) で尺が合うものがあれば、そちらへ寄せる。頭を先に試し、合わなければ尻。録画の頭と尻に接するものは
 * 前後の番組なので触らない
 */
function alignLengths(cm: Range[], candidates: Boundary[], duration: number): Range[] {
    const within = (t: number) =>
        candidates.find((b) => t >= b.silence.start - REACH && t <= b.silence.end + REACH);
    const fit = (length: number) => isCmLength(length, CHAIN_TOLERANCE);
    return cm.map((range) => {
        const length = range.end - range.start;
        if (range.start <= 0 || range.end >= duration || fit(length)) return range;
        const units = Math.round(length / 15);
        if (units < 1 || Math.abs(length - units * 15) > ALIGN_MAX) return range;
        const pick = (at: number, other: number, way: 1 | -1) => {
            const b = within(at);
            if (b === undefined) return null;
            const found = [...b.cuts, ...b.weak]
                .filter((t) => t !== at && fit((other - t) * way))
                .sort((x, y) => Math.abs(x - at) - Math.abs(y - at));
            return found[0] ?? null;
        };
        const start = pick(range.start, range.end, 1);
        if (start !== null) return { start, end: range.end };
        const end = pick(range.end, range.start, -1);
        return end !== null ? { start: range.start, end } : range;
    });
}

/** CM に挟まれた、ロゴの出ている短い所の最長 (秒)。番組の終わりの次回予告と提供など */
const ISLAND_MAX = 60;
/** 局の短い告知の尺 (秒)。CM の尺 (15 秒) より短い */
const SPOTS = [5, 10];
/** 告知の尺とみなす誤差 (秒) */
const SPOT_TOLERANCE = 0.25;
/** 告知を除いたあとに残す、ロゴの出ている所の最短 (秒) */
const ISLAND_REST = 15;

/**
 * **CM に挟まれた短い所の頭の、ロゴの出ている告知は CM にする。** 局の 5 秒の告知はロゴを出したまま流れ、
 * 次回予告との間に無音が無いことがあるので、CM がその手前で終わってしまう (実機で 5 秒の告知 → 次回予告 → 提供)。
 * CM の終わりからちょうど 5 秒・10 秒の所に強い切れ目があれば、そこまで CM を伸ばす。
 * 番組の本編 (長い所) には手を出さない — 本編の頭の数秒にもよく切れ目がある
 */
function trimSpots(input: CmInput, cm: Range[]): Range[] {
    const { times, cuts } = input;
    if (times === undefined || cuts === undefined) return cm;
    return cm.map((range, i) => {
        const next = cm[i + 1];
        if (next === undefined || next.start - range.end > ISLAND_MAX) return range;
        for (const spot of SPOTS) {
            const at = range.end + spot;
            if (next.start - at < ISLAND_REST) break;
            for (let f = lowerBound(times, at - SPOT_TOLERANCE); f < times.length; f++) {
                if (times[f]! > at + SPOT_TOLERANCE) break;
                if (cuts[f]! >= CUT_MIN) return { start: range.start, end: times[f]! };
            }
        }
        return range;
    });
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
 * - **番組の間では、無音の無いロゴの出入りを CM の端にしない。** CM は途切れの中の境目から境目まで
 * - **提供は番組に残す。** 番組の直後、または番組の終わりから CM の並びをたどった先にある
 *   10 秒は提供 (CM は 15 秒の倍数)。番組の映像に字を重ねていることが多く、削ると番組が欠ける
 * - **提供の後には CM が続く。** 番組が戻る直前の 10 秒でも、CM の並び (15 秒おき) に続くものは局の番宣で CM
 *   (実機のフジテレビで、CM 120 秒の後、ロゴが戻る直前の 10 秒が番宣だった)。並びの外にあるものだけ提供とみる
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
    const credit = (from: number, to: number) => Math.abs(to - from - CREDITS) <= CREDIT_TOLERANCE;
    /*
     * 番組の間で、近くに無音も切れ目も無いロゴの出入りは CM の端にしない。ロゴが場面の途中で消えただけ
     * (背景に紛れてロゴが判定できなくなった) のことがある (実機の TOKYO MX で、本編の 16 秒が CM になっていた)。
     * CM は途切れの中の最初の境目から始まり、最後の境目で終わる。境目が無ければ途切れごと番組。
     * 録画の頭と尻の途切れは、無音が無くてもロゴの出入りから (前後の番組との境目は無音を挟まないことがある)
     */
    if (afterProgram && beforeProgram && (!from.snapped || !to.snapped)) {
        const inside = marks.filter((t) => t >= start && t <= end);
        if (inside.length === 0) return [];
        if (!from.snapped) start = inside[0]!;
        if (!to.snapped) end = inside.at(-1)!;
        if (end - start < GAP_MIN) return [];
    }
    // たどり始めるのは無音の切れ目から (寄せられなかったロゴの出入りからは、尺がたまたま合っても数えない)
    const forward = afterProgram && from.snapped ? chain(start, end, 1, marks) : start;
    const backward = beforeProgram && to.snapped ? chain(end, start, -1, marks) : end;
    // 両側からの並びが出会えば、ロゴの消えている所がそのまま CM
    if (backward > forward + 0.5) {
        // 近くに無音の無かったロゴの出入りは当てにしない。CM の並びが止まった所まで
        const both = afterProgram && beforeProgram;
        if (beforeProgram && !to.snapped && forward > start) end = forward;
        else if (afterProgram && !from.snapped && backward < end) start = backward;
        // 並びの先に残った 10 秒は番組が戻る前の番宣 (提供の後には CM が続く)。番組には戻さない
        else if (both && forward > start && end - forward < GAP_MIN && !credit(forward, end)) end = forward;
        else if (both && backward < end && backward - start < GAP_MIN) start = backward;
    }
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
        /*
         * 番組が戻る直前だけ。手前に CM の尺 (15 秒の倍数) で届く境目があれば、並びに続く番宣。
         * **ここは誤差を広めに見る** (`CM_TOLERANCE`)。継ぎ目の無音の中の切れ目が少しずれていると、
         * 並びに続く番宣を提供と取り違えて番組に残す (実機の BS-TBS で、手前の境目から 14.65 秒 (0.35 秒ずれ) の
         * 所で並びが切れ、最後の 10 秒の番宣が番組の側に残っていた)
         */
        const previous = inner.filter((t) => t > start + 0.5).at(-1);
        const chained = (at: number) =>
            marks.some((t) => t >= start - 0.5 && t < at - 0.5 && isCmLength(at - t, CM_TOLERANCE));
        if (previous !== undefined && credit(previous, end) && !chained(previous)) end = previous;
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
 * 本編の「間」に当たることがあるので、30秒以上続いたものだけ
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
