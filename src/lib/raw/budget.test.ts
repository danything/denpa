import { describe, expect, test } from 'bun:test';
import { DecodeBudget, STRIKES, WINDOW } from './budget';

/** 1秒ぶん、決まった重さで解いたことにする */
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

    test('解く時間が軽くても、絵が遅れ続けていれば諦める', () => {
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
