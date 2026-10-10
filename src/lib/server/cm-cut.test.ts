import { describe, expect, test } from 'bun:test';
import { chapterArgs, cutArgs, cutList, cutPoints, parseKeyframes, planCut } from './cm-cut';

/**
 * 焼いたものから CM を切る段取り (`cm-cut.ts`)。ffmpeg は動かさず、キーフレームの拾い方・
 * 切る所の決め方・concat に渡す一覧だけを見る
 */
const frame = 1001 / 30000;
const limits = { offset: 0, tolerance: 1.5 * frame, margin: 0.8, duration: 1800 };
const key = (pts: number, lag = 0) => ({ pts, dts: pts - lag });

describe('キーフレームを拾う', () => {
    test('K の付いたパケットと、いちばん早いコマの時刻', () => {
        const csv = ['0.701,0.634,___', '0.634,N/A,K__', '0.668,0.668,___', '12.079,12.012,K__', ''].join(
            '\n',
        );
        expect(parseKeyframes(csv)).toEqual({
            keys: [
                { pts: 0.634, dts: 0.634 },
                { pts: 12.079, dts: 12.012 },
            ],
            first: 0.634,
        });
    });
});

describe('切る所を決める', () => {
    test('境目にキーフレームがあればそこで切る。尻は dts で読み終える', () => {
        const keys = [key(0), key(100.1, 0.067), key(190.2, 0.067), key(500, 0.067)];
        const plan = planCut(
            [
                { start: 0, end: 100.1 },
                { start: 190.2, end: 1800 },
            ],
            keys,
            limits,
        );
        expect(plan?.pieces).toEqual([
            { start: 0, end: 100.1, outpoint: 100.1 - 0.067 },
            { start: 190.2, end: null, outpoint: null },
        ]);
        expect(plan?.errors.map((e) => Math.round(e * 1000))).toEqual([0, 0]);
    });

    test('1コマずれたキーフレームでも同じ境目とみなす', () => {
        const plan = planCut([{ start: 190.2, end: 1800 }], [key(0), key(190.2 + frame)], limits);
        expect(plan?.pieces[0]?.start).toBeCloseTo(190.2 + frame, 6);
    });

    test('近くに無ければ CM 側へ寄せる (頭は前・尻は後ろ)。本編は削らない', () => {
        const keys = [key(0), key(99.7), key(100.5), key(189.9), key(190.6)];
        const plan = planCut(
            [
                { start: 0, end: 100.1 },
                { start: 190.2, end: 1800 },
            ],
            keys,
            limits,
        );
        expect(plan?.pieces.map((p) => [p.start, p.end])).toEqual([
            [0, 100.5],
            [189.9, null],
        ]);
    });

    test('CM 側にも無ければ切れない (境目を指して焼き直す)', () => {
        expect(planCut([{ start: 190.2, end: 1800 }], [key(0), key(185), key(191.5)], limits)).toBeNull();
    });

    test('焼いたものの時刻のずれ (muxer が頭をずらしたぶん) を足して探す', () => {
        const plan = planCut([{ start: 190.2, end: 1800 }], [key(0), key(190.186)], {
            ...limits,
            offset: -0.014,
            tolerance: 0.004,
        });
        expect(plan?.pieces[0]?.start).toBe(190.186);
    });

    test('録画の頭から残すなら最初のキーフレームから', () => {
        const plan = planCut([{ start: 0, end: 1800 }], [key(0.634), key(10)], limits);
        expect(plan?.pieces).toEqual([{ start: 0.634, end: null, outpoint: null }]);
    });
});

describe('concat に渡す一覧', () => {
    test('同じファイルを切れの数だけ並べ、長さは pts で書く', () => {
        const list = cutList("/lib/a'b.mkv", [
            { start: 0.634, end: 100.1, outpoint: 100.033 },
            { start: 190.2, end: null, outpoint: null },
        ]);
        expect(list).toBe(
            [
                'ffconcat version 1.0',
                "file '/lib/a'\\''b.mkv'",
                'inpoint 0.634',
                'outpoint 100.033',
                'duration 99.466',
                "file '/lib/a'\\''b.mkv'",
                'inpoint 190.200',
                '',
            ].join('\n'),
        );
    });

    test('繋ぐのもチャプターを足すのも焼き直さない', () => {
        expect(cutArgs('/l.ffconcat', '/o.mkv').join(' ')).toContain(
            '-f concat -safe 0 -i /l.ffconcat -map 0 -c copy',
        );
        expect(chapterArgs('/a.mkv', '/c.txt', '/o.mkv').join(' ')).toContain(
            '-map 0 -map_chapters 1 -c copy',
        );
    });
});

describe('キーフレームを置く所', () => {
    test('残す区間の頭と尻。録画の頭と尻は除く', () => {
        expect(
            cutPoints(
                [
                    { start: 0, end: 100 },
                    { start: 190, end: 1800 },
                ],
                1800,
            ),
        ).toEqual([100, 190]);
    });
});
