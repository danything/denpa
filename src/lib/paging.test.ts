import { describe, expect, test } from 'bun:test';
import { ends, matches, normalize } from './paging';

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
