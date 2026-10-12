import { describe, expect, test } from 'bun:test';
import { DecodeBudget, QUEUE_STUCK, STRIKES, WINDOW } from './budget';

/** 1秒ぶん、決まった重さでデコードしたことにする */
function second(budget: DecodeBudget, at: number, ms: number, late = 0): boolean {
    for (let i = 0; i < 30; i++) budget.record(ms);
    return budget.tick(at, 33.4, late);
}

describe('DecodeBudget', () => {
    test('間に合っていれば諦めない', () => {
        const budget = new DecodeBudget();
        budget.tick(0, 33.4, 0);
        for (let s = 1; s <= 20; s++) expect(second(budget, s * WINDOW, 10)).toBe(false);
        expect(budget.p95).toBe(10);
    });

    test('重いのが5秒続いたら諦める。**1回の重さでは戻さない**', () => {
        const budget = new DecodeBudget();
        budget.tick(0, 33.4, 0);
        const results = [1, 2, 3, 4, 5].map((s) => second(budget, s * WINDOW, 30));
        expect(results).toEqual([false, false, false, false, true]);
        expect(STRIKES).toBe(5);
    });

    test('途中で間に合えば数え直す', () => {
        const budget = new DecodeBudget();
        budget.tick(0, 33.4, 0);
        for (const s of [1, 2, 3, 4]) second(budget, s * WINDOW, 30);
        expect(second(budget, 5 * WINDOW, 10)).toBe(false);
        for (const s of [6, 7, 8, 9]) expect(second(budget, s * WINDOW, 30)).toBe(false);
        expect(second(budget, 10 * WINDOW, 30)).toBe(true);
    });

    test('デコードする時間が軽くても、映像が遅れ続けていれば諦める', () => {
        const budget = new DecodeBudget();
        budget.tick(0, 33.4, 0);
        const results = [1, 2, 3, 4, 5].map((s) => second(budget, s * WINDOW, 5, 0.5));
        expect(results.at(-1)).toBe(true);
    });

    test('止めている間 (コマが来ない) は数えない', () => {
        const budget = new DecodeBudget();
        budget.tick(0, 33.4, 0);
        for (let s = 1; s <= 10; s++) expect(budget.tick(s * WINDOW, 33.4, 1)).toBe(false);
    });
});

describe('DecodeBudget (WebCodecs の経路)', () => {
    /** 1秒ぶん。`queued` は刻みごとの詰まり */
    function webSecond(budget: DecodeBudget, at: number, ms: number, queued: number[]): boolean {
        for (let i = 0; i < 30; i++) budget.record(ms);
        let result = false;
        for (const [i, q] of queued.entries())
            result = budget.tick(at - WINDOW + ((i + 1) * WINDOW) / queued.length, 16.7, 0, q);
        return result;
    }

    test('1コマの時間が長くても (GPU 経由の溜め) 詰まっていなければ諦めない', () => {
        const budget = new DecodeBudget(false);
        budget.tick(0, 16.7, 0, 0);
        for (let s = 1; s <= 10; s++) expect(webSecond(budget, s * WINDOW, 60, [2, 0, 1, 2])).toBe(false);
        expect(budget.p95).toBe(60);
    });

    test('窓の間ずっと捌けきらないのが5秒続いたら諦める', () => {
        const budget = new DecodeBudget(false);
        budget.tick(0, 16.7, 0, QUEUE_STUCK);
        const results = [1, 2, 3, 4, 5].map((s) =>
            webSecond(budget, s * WINDOW, 5, [QUEUE_STUCK, QUEUE_STUCK + 2]),
        );
        expect(results).toEqual([false, false, false, false, true]);
    });
});
