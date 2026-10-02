import { describe, expect, test } from 'bun:test';
import { shotName } from './snapshot';

describe('切り抜きのファイル名', () => {
    const at = new Date(2026, 9, 2, 9, 5, 7);

    test('番組名_YYYYMMDD-HHMMSS.png', () => {
        expect(shotName('ニュース7', at)).toBe('ニュース7_20261002-090507.png');
    });

    test('ファイル名に使えない半角の字は _ に替える。全角はそのまま', () => {
        expect(shotName('劇場版 A/B: 第1話 "前編" ／後編?', at)).toBe(
            '劇場版 A_B_ 第1話 _前編_ ／後編__20261002-090507.png',
        );
    });

    test('空白は1つに詰め、末尾の点と空白は落とす', () => {
        expect(shotName('  遠い  星の…  ', at)).toBe('遠い 星の…_20261002-090507.png');
        expect(shotName('おわり...', at)).toBe('おわり_20261002-090507.png');
    });

    test('長い名前は 60 字で切る', () => {
        const name = shotName('あ'.repeat(200), at);
        expect(name).toBe(`${'あ'.repeat(60)}_20261002-090507.png`);
    });

    test('名前が残らなければ denpa', () => {
        expect(shotName('', at)).toBe('denpa_20261002-090507.png');
        expect(shotName(' . ', at)).toBe('denpa_20261002-090507.png');
    });
});
