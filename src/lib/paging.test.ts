import { describe, expect, test } from 'bun:test';
import { matches, normalize } from './paging';

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
});
