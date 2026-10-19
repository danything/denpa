import { describe, expect, test } from 'bun:test';
import { revealed, shownUpTo } from './paging';

describe('少しずつ出す一覧の行数', () => {
    test('続きを足しても全体を越えない', () => {
        expect(revealed(60, 60, 300)).toBe(120);
        expect(revealed(240, 60, 250)).toBe(250);
        expect(revealed(250, 60, 250)).toBe(250);
    });

    test('映したい行まで出す数は、足す単位に切り上げる', () => {
        // 61 行目 → 2 単位ぶん (120)
        expect(shownUpTo(60, 61, 60, 300)).toBe(120);
        // 単位ちょうどならそのまま
        expect(shownUpTo(60, 120, 60, 300)).toBe(120);
        expect(shownUpTo(60, 121, 60, 300)).toBe(180);
    });

    test('いま出している数より減らさず、全体を越えない', () => {
        // 0 行目 (先頭) や、もう描いてある所なら変えない
        expect(shownUpTo(60, 0, 60, 300)).toBe(60);
        expect(shownUpTo(180, 61, 60, 300)).toBe(180);
        // 全体より先を指しても全体まで
        expect(shownUpTo(60, 500, 60, 250)).toBe(250);
        // 全体が単位より少なければ全体
        expect(shownUpTo(0, 10, 60, 25)).toBe(25);
    });
});
