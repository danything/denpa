import { describe, expect, test } from 'bun:test';
import { boxAverage, halvingSteps } from './downscale';

describe('コマを小さく縮める', () => {
    test('半分ずつ縮めるのは、幅が 128 以下になるまで', () => {
        expect(halvingSteps(1920, 1080, 128)).toEqual([
            [960, 540],
            [480, 270],
            [240, 135],
            [120, 68],
        ]);
        expect(halvingSteps(1280, 720, 128)).toEqual([
            [640, 360],
            [320, 180],
            [160, 90],
            [80, 45],
        ]);
        expect(halvingSteps(100, 56, 128)).toEqual([]);
    });

    test('面積で平均する。割り切れない大きさでも、重なった割合で数える', () => {
        // 0・100・200 の 3x1 を 2x1 に。真ん中の画素は半分ずつ両方に入る
        const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
        const out = boxAverage(data, 3, 1, 2, 1);
        expect([...out]).toEqual([33, 33, 33, 255, 167, 167, 167, 255]);
    });

    test('止まった絵に写すたびにちがう雑音が乗っても、縮めた色はほとんど変わらない', () => {
        const width = 960;
        const height = 540;
        const noisy = () => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    const n = (Math.random() - 0.5) * 24;
                    data.set([(x / width) * 200 + n, 80 + n, (y / height) * 200 + n, 255], i);
                }
            }
            return data;
        };
        const a = boxAverage(noisy(), width, height, 32, 18);
        const b = boxAverage(noisy(), width, height, 32, 18);
        let worst = 0;
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
        // 1画素あたり元の 900 画素を平均するので、±12 の雑音は 1 段にも届かない (点で拾うと ±12 のまま揺れる)
        expect(worst).toBeLessThanOrEqual(2);
    });
});
