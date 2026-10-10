import { describe, expect, test } from 'bun:test';
import { boundaries, type CmInput, decideCm, isCmLength, type Range } from './cm-decide';

/**
 * CM の境目の決め方 (`cm-decide.ts`)。材料は合成したもの — コマは 30 コマ/秒で並べ、
 * CM の継ぎ目には無音 (前後 0.5 秒) と強い切れ目を置く
 */

const FPS = 30;

/** `duration` 秒ぶんのコマ。`cuts` の秒に切れ目 (強さ 30)、`weak` の秒に弱い切れ目 (強さ 5) */
function frames(duration: number, cuts: number[], weak: number[] = []) {
    const times = Array.from({ length: Math.round(duration * FPS) }, (_, i) => i / FPS);
    const scores = times.map(() => 0.1);
    const at = (t: number) => Math.round(t * FPS);
    for (const t of cuts) scores[at(t)] = 30;
    for (const t of weak) scores[at(t)] = 5;
    return { times, cuts: scores };
}

/** 継ぎ目ごとに、前後 0.5 秒の無音 */
const silencesAt = (points: number[]): Range[] => points.map((t) => ({ start: t - 0.5, end: t + 0.5 }));

/** CM の継ぎ目を 15 秒おきに並べる (`from` から `to` まで) */
const every15 = (from: number, to: number) =>
    Array.from({ length: Math.round((to - from) / 15) + 1 }, (_, i) => from + i * 15);

/** 継ぎ目のある録画。`logo` はロゴの出ている区間 */
function recording(
    duration: number,
    joints: number[],
    logo: Range[] | null,
    extra: Partial<CmInput> = {},
): CmInput {
    return { duration, silences: silencesAt(joints), ...frames(duration, joints), logo, ...extra };
}

const round = (ranges: Range[]) =>
    ranges.map((r) => ({ start: +r.start.toFixed(2), end: +r.end.toFixed(2) }));

describe('境目の候補', () => {
    test('無音の中の切れ目を強い順に。切れ目が無ければ無音の真ん中', () => {
        const material = frames(100, [10], [50.2]);
        material.cuts[Math.round(10.3 * FPS)] = 40;
        const found = boundaries({
            duration: 100,
            silences: [
                { start: 9.5, end: 10.5 },
                { start: 49.5, end: 50.5 },
            ],
            ...material,
        });
        expect(found[0]!.cuts.map((t) => +t.toFixed(2))).toEqual([10.3, 10]);
        expect(found[0]!.still).toBe(false);
        // 弱い切れ目だけなら、真ん中を置いて弱い切れ目は別に持つ
        expect(found[1]!.cuts).toEqual([50]);
        expect(found[1]!.still).toBe(true);
        expect(found[1]!.weak.map((t) => +t.toFixed(2))).toEqual([50.2]);
    });

    test('短すぎる無音は見ない (本編の息継ぎ)', () => {
        expect(boundaries({ duration: 100, silences: [{ start: 10, end: 10.1 }] })).toEqual([]);
    });
});

describe('ロゴで決める', () => {
    // 番組 10〜600 と 660〜1790、間に 60 秒の CM。録画は 1800 秒
    const joints = [10, ...every15(600, 660), 1790, 1805];
    const logo = [
        { start: 10.2, end: 599.8 },
        { start: 660.3, end: 1789.7 },
    ];

    test('ロゴの消えている所が CM。境目は近くの無音の切れ目に寄せる', () => {
        expect(round(decideCm(recording(1800, joints, logo)))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 660 },
            { start: 1790, end: 1800 },
        ]);
    });

    test('番組の中の短いロゴの切れ目 (アイキャッチ) は CM にしない', () => {
        const broken = [
            { start: 10.2, end: 300 },
            { start: 305, end: 599.8 },
            { start: 660.3, end: 1789.7 },
        ];
        expect(round(decideCm(recording(1800, [...joints, 300, 305], broken)))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 660 },
            { start: 1790, end: 1800 },
        ]);
    });

    test('ロゴが番組より数秒遅れて出ても、番組が戻った切れ目で終わる', () => {
        const late = [logo[0]!, { start: 664.5, end: 1789.7 }];
        expect(round(decideCm(recording(1800, joints, late)))[1]).toEqual({ start: 600, end: 660 });
    });

    test('近くに無音の無いロゴの出だしは当てにせず、CM の並びが止まった所まで', () => {
        // 番組は 660 に戻っているが、ロゴは 675 まで出ない (間に無音も無い)
        const late = [logo[0]!, { start: 675, end: 1789.7 }];
        expect(round(decideCm(recording(1800, joints, late)))[1]).toEqual({ start: 600, end: 660 });
    });

    test('CM の前のロゴの無いアイキャッチは番組に残す', () => {
        // ロゴは 596 で消えるが、CM の並び (15 秒おき) は 600 から
        const early = [{ start: 10.2, end: 595.9 }, logo[1]!];
        expect(round(decideCm(recording(1800, [...joints, 596], early)))[1]).toEqual({
            start: 600,
            end: 660,
        });
    });

    test('継ぎ目の無音に切れ目が2つあれば、ロゴの点が落ちたほうを採る', () => {
        // 600 の無音の中に、もっと強い切れ目 (600.4)。ロゴの点は 600 で落ちている
        const material = frames(1800, joints);
        material.cuts[Math.round(600.4 * FPS)] = 60;
        const logoScores = material.times.map((t) => ((t > 10 && t < 600) || t > 660 ? 0.8 : 0));
        const input = { duration: 1800, silences: silencesAt(joints), ...material, logo, logoScores };
        expect(round(decideCm(input))[1]).toEqual({ start: 600, end: 660 });
    });

    test('番組の直後の 10 秒は提供として番組に残す', () => {
        // 600 でロゴが消え、610 まで提供、そこから CM 45 秒
        const withCredits = [10, 600, ...every15(610, 655), 655, 1790, 1805];
        const lit = [logo[0]!, { start: 655.3, end: 1789.7 }];
        expect(round(decideCm(recording(1800, withCredits, lit)))[1]).toEqual({ start: 610, end: 655 });
    });

    test('番組の終わりから CM の並びをたどった先の 10 秒も提供', () => {
        // 1790 で番組が終わり、CM 60 秒、提供 10 秒、CM が録画の尻まで
        const tail = [10, ...every15(600, 660), ...every15(1790, 1850), 1860, 1875, 1890];
        expect(round(decideCm(recording(1900, tail, logo))).slice(-2)).toEqual([
            { start: 1790, end: 1850 },
            { start: 1860, end: 1900 },
        ]);
    });

    test('CM の並びの中の 10 秒 (局の番宣) は CM のまま', () => {
        // CM 600〜645 に 5 秒の局の告知、650〜660 は 10 秒の番宣、660〜675 は CM
        const promo = [10, 600, 615, 630, 645, 650, 660, 675, 1790, 1805];
        const lit = [logo[0]!, { start: 675.3, end: 1789.7 }];
        expect(round(decideCm(recording(1800, promo, lit)))[1]).toEqual({ start: 600, end: 675 });
    });

    test('番組が戻る直前の 10 秒も提供', () => {
        const credits = [10, ...every15(600, 645), 655, 1790, 1805];
        const lit = [logo[0]!, { start: 655.3, end: 1789.7 }];
        expect(round(decideCm(recording(1800, credits, lit)))[1]).toEqual({ start: 600, end: 645 });
    });
});

describe('番組表の尺で前後の番組を外す', () => {
    test('尺より後に出た次の番組のロゴは CM の側', () => {
        // 番組は 10〜1810 (尺 1800)。1812 から次の番組 (ロゴあり)
        const joints = [10, ...every15(600, 660), 1810, 1812];
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 660.3, end: 1809.8 },
            { start: 1812.3, end: 1824.5 },
        ];
        const cm = decideCm(recording(1825, joints, logo, { programLength: 1800, programStart: 10 }));
        expect(round(cm).at(-1)).toEqual({ start: 1810, end: 1825 });
    });

    test('CM を挟まずに続く次の番組も、尺の終わりの無音で切る', () => {
        const joints = [10, ...every15(600, 660), 1810];
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 660.3, end: 1824.5 },
        ];
        const cm = decideCm(recording(1825, joints, logo, { programLength: 1800, programStart: 10 }));
        expect(round(cm).at(-1)).toEqual({ start: 1810, end: 1825 });
    });

    test('尺が分からなければ外さない', () => {
        const joints = [10, ...every15(600, 660), 1810];
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 660.3, end: 1824.5 },
        ];
        expect(round(decideCm(recording(1825, joints, logo))).at(-1)).toEqual({ start: 600, end: 660 });
    });
});

describe('ロゴを使わずに決める (CM の尺だけ)', () => {
    /** ロゴを使わないときは 0.8 秒以上の無音だけを見る */
    const long = (points: number[]): Range[] => points.map((t) => ({ start: t - 0.5, end: t + 0.5 }));

    test('15 秒の倍数で区切られた 30 秒以上の並びが CM', () => {
        expect(decideCm({ duration: 1800, silences: long([300, 330, 360, 390]) })).toEqual([
            { start: 300, end: 390 },
        ]);
    });

    test('単発の 15 秒は本編のコーナーと区別が付かないので拾わない', () => {
        expect(decideCm({ duration: 1800, silences: long([300, 315]) })).toEqual([]);
    });

    test('短い無音は見ない', () => {
        const short = [300, 330, 360].map((t) => ({ start: t - 0.2, end: t + 0.2 }));
        expect(decideCm({ duration: 1800, silences: short })).toEqual([]);
    });
});

test('CM の尺は 15 秒の倍数 (15〜180 秒)', () => {
    expect(isCmLength(15)).toBe(true);
    expect(isCmLength(59.7)).toBe(true);
    expect(isCmLength(90)).toBe(true);
    expect(isCmLength(22)).toBe(false);
    expect(isCmLength(14.6, 0.25)).toBe(false);
    // 本編は 15 の倍数に乗っても長すぎるので弾く
    expect(isCmLength(600)).toBe(false);
});
