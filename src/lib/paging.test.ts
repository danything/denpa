import { describe, expect, test } from 'bun:test';
import { ends, matches, normalize, revealed, shownUpTo, sideStep } from './paging';

describe('一覧の絞り込み', () => {
    test('空なら全部残す', () => {
        expect(matches('', 'なんでも')).toBe(true);
        expect(matches('   ', 'なんでも')).toBe(true);
    });

    test('空白で区切った語をすべて含むものだけ', () => {
        expect(matches('名探偵 NHK', '名探偵コナン / NHK総合')).toBe(true);
        expect(matches('名探偵 TBS', '名探偵コナン / NHK総合')).toBe(false);
    });

    test('大文字小文字と全角英数は揃えて比べる', () => {
        expect(matches('nhk', 'NHK総合')).toBe(true);
        expect(matches('ＮＨＫ', 'NHK総合')).toBe(true);
        expect(normalize('ＡＢＣ１２３')).toBe('abc123');
    });

    test('外字は規格の字のまま持っていても、昔の書き方で当たる', () => {
        expect(matches('吉野家', '𠮷野家')).toBe(true);
        expect(matches('[新]', '🈟アニメ')).toBe(true);
        expect(matches('末廣亭', '末廣𠅘')).toBe(true);
        // 逆向き (規格の字で探して、昔の書き方の録画に当てる) も
        expect(matches('𠮷野家', '吉野家')).toBe(true);
    });
});

describe('頭と尻を切り出す (録画の枠)', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);

    test('間を空けて両端を出す。残りは間の件数', () => {
        expect(ends(items, 3, 2)).toEqual({ head: [0, 1, 2], tail: [8, 9], rest: 5 });
    });

    test('重なったら間は無く、全部を頭に (同じ行を2度描かない)', () => {
        expect(ends(items, 6, 6)).toEqual({ head: items, tail: [], rest: 0 });
        expect(ends(items, 5, 5)).toEqual({ head: items, tail: [], rest: 0 });
    });

    test('尻が 0 件なら頭からだけ (まとめて表示)', () => {
        expect(ends(items, 4, 0)).toEqual({ head: [0, 1, 2, 3], tail: [], rest: 6 });
        expect(ends([], 4, 0)).toEqual({ head: [], tail: [], rest: 0 });
    });
});

describe('少しずつ出す一覧の行数', () => {
    test('片側に足す数は、両端から出すときは半分 (切り上げ)', () => {
        expect(sideStep(60, false)).toBe(60);
        expect(sideStep(60, true)).toBe(30);
        expect(sideStep(61, true)).toBe(31);
    });

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
