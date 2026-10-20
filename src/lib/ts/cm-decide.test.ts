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

    test('近くに無音の無いロゴの消え際は CM の端にしない (途切れの中に境目が無ければ番組)', () => {
        // 番組の途中 1000 でロゴが判定できなくなり、1016.4 の無音から先はまた出ている
        const broken = [
            { start: 10.2, end: 1000 },
            { start: 1016.4, end: 1789.7 },
        ];
        const cm = decideCm(recording(1800, [10, 1016.4, 1790, 1805], broken));
        expect(round(cm)).toEqual([
            { start: 0, end: 10 },
            { start: 1790, end: 1800 },
        ]);
    });

    test('近くに無音の無いロゴの消え際からは、途切れの中の最初の境目から CM', () => {
        // ロゴは 590 で消える (無音は無い)。CM は 600 の無音から 660 まで
        const early = [{ start: 10.2, end: 590 }, logo[1]!];
        expect(round(decideCm(recording(1800, joints, early)))[1]).toEqual({ start: 600, end: 660 });
    });

    test('録画の尻に接する消え際は、近くに無音が無くてもそこから CM (次の番組との境目)', () => {
        const tail = [logo[0]!, { start: 660.3, end: 1780 }];
        expect(round(decideCm(recording(1800, joints.slice(0, -2), tail))).at(-1)).toEqual({
            start: 1780,
            end: 1800,
        });
    });

    test('番組が戻る直前の 10 秒でも、CM の並びに続くものは番宣 (CM)', () => {
        // CM 600〜645 の後、645〜655 は 10 秒の番宣、655 でロゴが戻る
        const promo = [10, ...every15(600, 645), 655, 1790, 1805];
        const lit = [logo[0]!, { start: 655.3, end: 1789.7 }];
        expect(round(decideCm(recording(1800, promo, lit)))[1]).toEqual({ start: 600, end: 655 });
    });

    test('CM の並びの外にある、番組が戻る直前の 10 秒は提供', () => {
        // CM 600〜645、7 秒の局の告知、652〜662 は CM の並びに乗らない 10 秒、662 でロゴが戻る
        const credits = [10, ...every15(600, 645), 652, 662, 1790, 1805];
        const lit = [logo[0]!, { start: 662.3, end: 1789.7 }];
        expect(round(decideCm(recording(1800, credits, lit)))[1]).toEqual({ start: 600, end: 652 });
    });
});

describe('実機の並び (フジテレビの 30 分番組。ロゴが戻る直前の番宣)', () => {
    /*
     * 実機の録画で、無音・切れ目 (無音ごとにいちばん強いもの)・ロゴの出ている区間を写したもの (秒は入れ物の頭から)。
     * 真ん中は目で確かめた: CM 715〜775、ロゴの出ている提供 775〜785、CM 785〜905、局の番宣 905〜915 (CM)、
     * 915 から番組 (ロゴは 914.98 から)
     */
    const duration = 1824.47;
    // 無音の頭と終わりを交互に
    const flat = [
        8.47, 9.49, 13.48, 14.57, 17.05, 17.23, 18.98, 19.87, 25.11, 25.32, 26.34, 26.58, 31.9, 32.13, 33.2,
        33.44, 38.08, 38.79, 60.54, 61.02, 62.5, 63.31, 63.87, 64.19, 65.43, 66, 67.64, 67.94, 69.25, 70.48,
        70.79, 70.99, 71.39, 72.13, 224.19, 224.37, 224.39, 226.24, 235.4, 236.51, 265.49, 266.52, 267.1,
        267.51, 280.51, 281.53, 282.11, 282.59, 294.86, 296.5, 310.45, 311.52, 325.51, 326.48, 330.26, 330.41,
        332.82, 333.23, 335.86, 336.3, 336.4, 336.76, 338.6, 339.11, 339.62, 339.8, 349.4, 349.55, 352.16,
        352.5, 353.3, 353.45, 442.11, 442.36, 500.81, 501, 517.67, 517.9, 528.62, 528.8, 529.09, 529.29,
        536.69, 536.86, 545.17, 545.53, 546.93, 547.35, 550.99, 551.16, 553.17, 553.7, 556.87, 557.1, 557.1,
        557.31, 557.31, 557.56, 557.6, 557.77, 579.78, 580.15, 667.36, 667.53, 670.43, 670.93, 672.9, 673.24,
        673.32, 673.71, 674.18, 675.57, 679.51, 679.86, 681.29, 681.48, 685.12, 685.28, 685.8, 686.5, 714.23,
        715.54, 729.53, 730.52, 744.44, 745.53, 746.11, 746.53, 759.52, 760.51, 761.09, 761.5, 774.51, 775.38,
        784.3, 785.49, 799.5, 800.5, 806.69, 806.88, 810.78, 811.37, 814.49, 815.52, 829.47, 830.52, 844.49,
        845.53, 859.49, 860.5, 874.49, 875.52, 889.52, 890.49, 904.5, 905.48, 914.49, 915.5, 1022.2, 1022.48,
        1023.35, 1024, 1150.09, 1151.08, 1285.47, 1286.01, 1287.35, 1288.43, 1289.29, 1289.89, 1290.85,
        1291.58, 1291.95, 1292.5, 1292.81, 1293.2, 1439.06, 1439.78, 1441.02, 1441.84, 1442.31, 1445.38,
        1584.02, 1584.18, 1585.26, 1585.58, 1610.85, 1611.03, 1612.13, 1612.3, 1638.44, 1639.5, 1683.48,
        1684.01, 1688.98, 1689.46, 1703.43, 1704.48, 1718.25, 1719.52, 1733.48, 1734.51, 1748.51, 1749.49,
        1763.48, 1764.52, 1765.34, 1765.52, 1778.51, 1779.52, 1808.41, 1809.15,
    ];
    const silences: Range[] = Array.from({ length: flat.length / 2 }, (_, i) => ({
        start: flat[2 * i]!,
        end: flat[2 * i + 1]!,
    }));
    const cuts = [
        8.99, 13.98, 18.99, 63.16, 65.78, 70.04, 71.95, 225.83, 235.99, 266, 267.5, 281.01, 282.52, 296,
        311.01, 325.99, 333.13, 336.55, 338.64, 352.57, 442.41, 553.19, 557.74, 580.05, 672.94, 674.94,
        679.65, 686.49, 715, 730, 745.01, 746.51, 759.99, 761.46, 774.99, 784.98, 800, 811.08, 815.01, 830,
        845.01, 859.99, 875.01, 889.99, 904.99, 914.98, 1023.86, 1150.98, 1289.87, 1439.1, 1445.36, 1638.97,
        1683.98, 1689.45, 1703.97, 1718.98, 1734, 1748.98, 1764, 1779.01, 1808.99,
    ];
    const logo = [
        { start: 8.99, end: 235.99 },
        { start: 325.99, end: 463.06 },
        { start: 468.57, end: 715 },
        { start: 774.99, end: 786.79 },
        { start: 914.98, end: 1716.65 },
        { start: 1811.44, end: 1823.97 },
    ];

    test('提供はロゴの出ている側で番組、ロゴが戻る直前の 10 秒は CM', () => {
        // 尻の 1811.44〜 は次の番組のロゴ。番組表の尺 (30 分) で外す
        const input = {
            duration,
            silences,
            ...frames(duration, cuts),
            logo,
            programLength: 1800,
            programStart: 10,
        };
        // 頭の境目はロゴの点 (ここには入れていない) で決まるので見ない。コマを 1/30 秒に丸めたぶん、0.1 秒で比べる
        const cm = decideCm(input).map((r) => ({ start: +r.start.toFixed(1), end: +r.end.toFixed(1) }));
        expect(cm.slice(1)).toEqual([
            { start: 236, end: 326 },
            { start: 715, end: 775 },
            { start: 785, end: 915 },
            { start: 1719, end: 1824.5 },
        ]);
    });
});

describe('実機の並び (TOKYO MX の 30 分番組の後半)', () => {
    /*
     * 実機の録画で、ロゴの途切れ・無音・切れ目の時刻を写したもの (秒は入れ物の頭から)。
     * ロゴは 1527.99 で場面の途中で消え (近くに無音も切れ目も無い)、1544.41 の無音から 1558.46 まで出る。
     * 1559.93 から CM、1618.42〜1628.43 はロゴの出ている提供、そこから録画の尻まで CM
     */
    const duration = 1825.657;
    const silences: Range[] = [
        { start: 8.0, end: 8.9 },
        ...every15(142.4, 202.4).map((t) => ({ start: t - 0.5, end: t + 0.5 })),
        ...every15(932.4, 992.4).map((t) => ({ start: t - 0.5, end: t + 0.5 })),
        { start: 1454.581, end: 1455.121 },
        { start: 1542.702, end: 1544.433 },
        // 切れ目の無い無音 (番組の終わりの黒)
        { start: 1556.632, end: 1558.934 },
        { start: 1559.884, end: 1560.244 },
        { start: 1587.758, end: 1588.929 },
        { start: 1602.911, end: 1604.48 },
        { start: 1617.888, end: 1618.475 },
        { start: 1627.25, end: 1628.938 },
        { start: 1642.865, end: 1643.952 },
        { start: 1646.773, end: 1647.535 },
        { start: 1672.759, end: 1673.951 },
        { start: 1702.847, end: 1703.943 },
        { start: 1717.907, end: 1718.963 },
        { start: 1732.903, end: 1733.889 },
        { start: 1747.81, end: 1748.921 },
        { start: 1762.903, end: 1763.922 },
        { start: 1777.921, end: 1778.944 },
        { start: 1792.893, end: 1793.933 },
        { start: 1807.861, end: 1808.982 },
    ];
    const cuts = [
        8.44,
        ...every15(142.4, 202.4),
        ...every15(932.4, 992.4),
        1454.386,
        1544.41,
        1559.925,
        1588.42,
        1588.921,
        1603.435,
        1604.436,
        1618.417,
        1628.427,
        1643.442,
        1647.479,
        1673.438,
        1703.435,
        1718.417,
        1733.432,
        1748.413,
        1763.428,
        1778.443,
        1793.425,
        1808.44,
    ];
    const logo = [
        { start: 8.6, end: 142.2 },
        { start: 202.6, end: 932.2 },
        { start: 992.458, end: 1460.526 },
        { start: 1474.807, end: 1481.247 },
        { start: 1493.626, end: 1527.993 },
        { start: 1544.41, end: 1558.457 },
        { start: 1618.484, end: 1628.427 },
    ];

    test('場面の途中でロゴが消えた所は番組。CM は無音のある所から', () => {
        const cm = decideCm({ duration, silences, ...frames(duration, cuts), logo });
        expect(round(cm)).toEqual([
            { start: 0, end: 8.43 },
            { start: 142.4, end: 202.4 },
            { start: 932.4, end: 992.4 },
            { start: 1559.93, end: 1618.43 },
            { start: 1628.43, end: 1825.66 },
        ]);
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

describe('CM に挟まれた短い所の頭の告知', () => {
    // 番組 10〜600、CM 600〜675、ロゴの出ている 30 秒 (告知 5 秒・次回予告・提供)、705 から CM が録画の尻まで
    const joints = [10, ...every15(600, 675), ...every15(705, 795)];
    const logo = [
        { start: 10.2, end: 599.8 },
        { start: 675.3, end: 704.7 },
    ];
    /** `cut` の秒に、無音の無い強い切れ目を足す */
    const withCut = (cut: number, lit = logo) => recording(800, joints, lit, frames(800, [...joints, cut]));

    test('CM の終わりからちょうど 5 秒の切れ目までは CM (ロゴの出ている局の告知)', () => {
        expect(round(decideCm(withCut(680)))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 680 },
            { start: 705, end: 800 },
        ]);
    });

    test('5 秒・10 秒から外れた切れ目では伸ばさない', () => {
        expect(round(decideCm(withCut(683)))[1]).toEqual({ start: 600, end: 675 });
    });

    test('長い番組の頭は、5 秒の所に切れ目があっても伸ばさない', () => {
        const long = [logo[0]!, { start: 675.3, end: 789.7 }];
        const tail = [10, ...every15(600, 675), 790, 805];
        const input = recording(800, tail, long, frames(800, [...tail, 680]));
        expect(round(decideCm(input))[1]).toEqual({ start: 600, end: 675 });
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

    test('単発の 15 秒は本編のコーナーと区別が付かないので CM とみなさない', () => {
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

describe('ロゴが遅れて戻る', () => {
    // 実機の TOKYO MX の並びを写したもの。番組 10〜600、CM 600〜659.7 (15 秒おき)、659.7 の無音で番組が戻るが、
    // 明るい場面でロゴが見えるのは 665.6 から (5.9 秒遅れ)。630・645 の継ぎ目は無音の中の切れ目が 0.5 秒ほどずれ、
    // 番組が戻る無音には強い切れ目が無い (真ん中を置く)。どの継ぎ目からも 15 秒の倍数でたどれない
    const silences = silencesAt([10, 600, 615, 630, 645, 1790, 1805]).concat({ start: 659.2, end: 660.2 });
    const cuts = [10, 600, 615, 629.53, 644.55, 1790, 1805];
    const logo = [
        { start: 13.4, end: 596.6 },
        { start: 665.6, end: 1789.7 },
    ];
    const input = (lit: Range[]): CmInput => ({ duration: 1800, silences, ...frames(1800, cuts), logo: lit });

    test('ロゴの戻りが番組の戻った無音から 8 秒以内なら、そこまでを CM にする (15 秒で切らない)', () => {
        expect(round(decideCm(input(logo)))[1]).toEqual({ start: 600, end: 659.7 });
    });

    test('8 秒より遅れたロゴの戻りでも、間に無音の無いロゴの無い所は CM の続き', () => {
        /*
         * 前は「8 秒より遅れたロゴの戻りには寄せず、CM の並びが止まった 615 まで」としていた。そうすると 615〜668.6 の
         * ロゴの無い 53 秒が番組に残る。659.7 の無音のあとロゴが戻るまで無音も切れ目も無いので、番組が戻ったのは 659.7。
         * 点数で比べる今のやり方では、ロゴの無い 53 秒を番組にする減点のほうが、境目がロゴの戻りから 8.9 秒離れている減点より大きい
         */
        const late = [logo[0]!, { start: 668.6, end: 1789.7 }];
        expect(round(decideCm(input(late)))[1]).toEqual({ start: 600, end: 659.7 });
    });
});

describe('CM の端は尺が 15 秒の倍数になる切れ目', () => {
    // 実機の TOKYO MX の並びを写したもの。CM は 599.5〜659.5 の 60 秒。頭の継ぎ目 (599.5) は明るい本編から明るい CM への
    // 替わりで弱く、同じ無音の中の 600 (CM の中の場面の替わり) のほうが強い
    const joints = [10, 614.5, 629.5, 644.5, 659.5, 1790, 1805];
    const silences = [...silencesAt(joints), { start: 599, end: 600.5 }];
    const logo = [
        { start: 10.2, end: 597 },
        { start: 662, end: 1789.7 },
    ];
    const input = (): CmInput => ({
        duration: 1800,
        silences,
        ...frames(1800, [...joints, 600], [599.5]),
        logo,
    });

    test('強い切れ目で尺が 0.5 秒外れるなら、同じ無音の中の弱い継ぎ目を CM の頭にする', () => {
        expect(round(decideCm(input()))[1]).toEqual({ start: 599.5, end: 659.5 });
    });

    test('尺が合っていれば強い切れ目のまま', () => {
        // 継ぎ目が 600 からの 15 秒おき (600 の強い切れ目が本当の継ぎ目)。弱い 599.5 には寄せない
        const shifted = joints.map((t) => (t > 600 && t < 1700 ? t + 0.5 : t));
        const ok: CmInput = {
            duration: 1800,
            silences: [...silencesAt(shifted), { start: 599, end: 600.5 }],
            ...frames(1800, [...shifted, 600], [599.5]),
            logo,
        };
        expect(round(decideCm(ok))[1]).toEqual({ start: 600, end: 660 });
    });
});

describe('番組が戻る直前の 10 秒の番宣 (並びの境目が少しずれている)', () => {
    // 実機の BS-TBS の並びを写したもの。CM 600〜660 (60 秒)、5.5 秒の告知、14.65 秒の CM、9.9 秒の番宣、
    // 690 で番組が戻る (ロゴは 690.3 から)
    const joints = [10, ...every15(600, 660), 665.47, 680.12, 690.03, 1790, 1805];
    const logo = [
        { start: 10.2, end: 599.8 },
        { start: 690.3, end: 1789.7 },
    ];

    test('手前の境目から 15 秒の倍数に 0.6 秒以内で届くなら、最後の 10 秒も CM', () => {
        expect(round(decideCm(recording(1800, joints, logo)))[1]).toEqual({ start: 600, end: 690.03 });
    });
});

describe('実機の並び (点数で比べる)', () => {
    test('録画 474: ロゴが 5.9 秒遅れて戻り、2 つの継ぎ目の切れ目が 0.5 秒ずつずれていても 60 秒の CM', () => {
        // 継ぎ目は 600・615・630・645・660 (無音はその前後 0.5 秒)。615 と 645 の無音の中の切れ目は 0.5 秒ずれている。
        // ロゴは 665.9 まで戻らない
        const joints = [10, 600, 615, 630, 645, 660, 1790, 1805];
        const cuts = [10, 600, 614.5, 630, 645.5, 660, 1790, 1805];
        const input: CmInput = {
            duration: 1800,
            silences: silencesAt(joints),
            ...frames(1800, cuts),
            logo: [
                { start: 10.2, end: 599.8 },
                { start: 665.9, end: 1789.7 },
            ],
        };
        expect(round(decideCm(input))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 660 },
            { start: 1790, end: 1800 },
        ]);
    });

    test('録画 474: 同じ無音の中で、強い切れ目の 0.5 秒前の弱い切れ目が本当の継ぎ目 (CM の頭)', () => {
        // CM は 599.5〜659.5。頭の無音には弱い 599.5 (継ぎ目) と、もっと強い 600 (CM の中の場面の替わり)
        const joints = [10, 614.5, 629.5, 644.5, 659.5, 1790, 1805];
        const silences = [...silencesAt(joints), { start: 599, end: 600.5 }];
        const material = frames(1800, [...joints, 600], [599.5]);
        material.cuts[Math.round(600 * FPS)] = 60;
        const logo = [
            { start: 10.2, end: 598 },
            { start: 662, end: 1789.7 },
        ];
        expect(round(decideCm({ duration: 1800, silences, ...material, logo }))[1]).toEqual({
            start: 599.5,
            end: 659.5,
        });
    });

    test('録画 474: 同じ無音の中で、強い切れ目の 0.5 秒前の弱い切れ目が本当の継ぎ目 (CM の終わり)', () => {
        // CM は 600〜660。終わりの無音には弱い 660 (番組が戻った所) と、もっと強い 660.5 (番組の中の場面の替わり)
        const joints = [10, 600, 615, 630, 645, 1790, 1805];
        const silences = [...silencesAt(joints), { start: 659.6, end: 661 }];
        const material = frames(1800, [...joints, 660.5], [660]);
        material.cuts[Math.round(660.5 * FPS)] = 60;
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 663, end: 1789.7 },
        ];
        expect(round(decideCm({ duration: 1800, silences, ...material, logo }))[1]).toEqual({
            start: 600,
            end: 660,
        });
    });

    test('録画 467: CM 60 秒 + 告知 5.5 秒 + 14.65 秒 + 番宣 9.9 秒で、ひと続きの 90 秒の CM', () => {
        const joints = [10, ...every15(600, 660), 665.5, 680.15, 690.05, 1790, 1805];
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 690.4, end: 1789.7 },
        ];
        expect(round(decideCm(recording(1800, joints, logo)))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 690.07 },
            { start: 1790, end: 1800 },
        ]);
    });

    test('録画 469: ロゴの出ている 30 秒 (局の告知 5 秒 + 次回予告 15 秒 + 提供 10 秒) の告知だけ CM', () => {
        // CM 600〜675、告知 675〜680 (ロゴあり、次回予告との間に無音が無い)、次回予告 680〜695、提供 695〜705、705 から CM
        const joints = [10, ...every15(600, 675), 695, ...every15(705, 795)];
        const logo = [
            { start: 10.2, end: 599.8 },
            { start: 675.3, end: 704.7 },
        ];
        const input = recording(800, joints, logo, frames(800, [...joints, 680]));
        expect(round(decideCm(input))).toEqual([
            { start: 0, end: 10 },
            { start: 600, end: 680 },
            { start: 705, end: 800 },
        ]);
    });
});
