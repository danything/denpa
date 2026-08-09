import { describe, expect, test } from 'bun:test';
import { fitRect } from './paint';

describe('映像が枠のどこに出るか', () => {
    test('横に余るときは左右に振り分ける', () => {
        // 16:9 の絵を 4:3 の枠に入れると、上下に帯が付く
        expect(fitRect(800, 800, 1920, 1080)).toEqual({ left: 0, top: 175, width: 800, height: 450 });
    });

    test('縦に余るときは上下に振り分ける', () => {
        const rect = fitRect(1600, 600, 1920, 1080);
        expect(rect.top).toBe(0);
        expect(rect.height).toBe(600);
        expect(rect.width).toBeCloseTo(1066.67, 1);
        expect(rect.left).toBeCloseTo(266.67, 1);
    });

    test('ぴったりなら余りは出ない', () => {
        expect(fitRect(1920, 1080, 1920, 1080)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    });

    /** 尺が分かる前に呼ばれる。**枠いっぱいに落とす** (黒いままにしない) */
    test('大きさが分からないときは枠そのまま', () => {
        expect(fitRect(100, 50, 0, 0)).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    });
});
