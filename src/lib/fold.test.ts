import { describe, expect, test } from 'bun:test';
import { FOLD, foldForSearch, likePieces } from './fold';

const VS15 = String.fromCodePoint(0xfe0e);
const VS16 = String.fromCodePoint(0xfe0f);

describe('探すときの寄せ (foldForSearch)', () => {
    test('規格の字を、外字を開いていた頃の書き方に寄せる', () => {
        expect(foldForSearch('𠮷野家')).toBe('吉野家');
        expect(foldForSearch('末廣𠅘')).toBe('末廣亭');
        expect(foldForSearch('🈟アニメ🈑🈞')).toBe('[新]アニメ[字][再]');
        expect(foldForSearch('⚾中継')).toBe('○中継');
        expect(foldForSearch('⛄ ⛉⛊ ⛋⨀')).toBe('(雪) ▽▼ ⌺⦿');
        expect(foldForSearch('½')).toBe('1/2');
    });

    test('互換漢字は統合漢字に', () => {
        expect(foldForSearch(String.fromCodePoint(0xfa6b))).toBe('恵');
        expect(foldForSearch(String.fromCodePoint(0xfa10))).toBe('塚');
    });

    test('異体字セレクタは落とす', () => {
        expect(foldForSearch(`⚡${VS15}注意報`)).toBe('⚡注意報');
        expect(foldForSearch(`☎${VS16}`)).toBe('☎');
    });

    test('寄せ先に寄せ元の字は無い (1回通せば済む)', () => {
        for (const folded of FOLD.values()) expect(foldForSearch(folded)).toBe(folded);
    });

    test('それ以外は触らない', () => {
        expect(foldForSearch('名探偵コナン #1')).toBe('名探偵コナン #1');
    });
});

describe('LIKE に掛けられる切れ端 (likePieces)', () => {
    test('寄せ先と関わらない語はそのまま', () => {
        expect(likePieces('名探偵')).toEqual(['名探偵']);
        expect(likePieces('nhk')).toEqual(['nhk']);
    });

    test('寄せ先の字 (吉 ← 𠮷) は抜く', () => {
        expect(likePieces('吉野家')).toEqual(['野家']);
        expect(likePieces('大吉日')).toEqual(['大', '日']);
    });

    test('寄せ先がまるごと入っている所 ([新] ← 🈟) は抜く', () => {
        expect(likePieces('[新]アニメ')).toEqual(['アニメ']);
    });

    test('寄せ先の途中で切れている語は絞れない', () => {
        // 「新」は「[新]」の中にあるので、🈟 だけの番組名にも当たりうる
        expect(likePieces('新')).toEqual([]);
        expect(likePieces('[新')).toEqual([]);
    });

    test('寄せ先の頭・尻と重なる端だけ抜く', () => {
        // 「ha」(㏊) の尻と重なる a、「fax」(℻) の頭と重なる f
        expect(likePieces('anf')).toEqual(['n']);
        // 新番組 の「新」は「[新]」の真ん中とは並び方が合わないので残す
        expect(likePieces('新番組')).toEqual(['新番組']);
    });
});
