import { describe, expect, test } from 'bun:test';
import { compareEuc, decodeEuc, encodeEuc, eucCode, fromEucCode, isDrcs, toDisplay } from './euc';

const bytes = (...list: number[]): Uint8Array => Uint8Array.from(list);

describe('EUC-JP', () => {
    test('1〜84 区は TextDecoder と同じ字', () => {
        expect(decodeEuc(bytes(0xa4, 0xa2, 0x41, 0xb4, 0xc1))).toBe('あA漢');
    });

    test('追加記号 (90 区) は IBM 拡張漢字にせず、1 字 1 単位で持って描くときに開く', () => {
        // 90 区 1 点 = ⛌ (U+26CC)、92 区 16 点 = 🄀 は 2 単位の字
        const text = decodeEuc(bytes(0xfa, 0xa1, 0xfc, 0xb0));
        expect(text.length).toBe(2);
        expect(toDisplay(text)).toBe('⛌🄀');
        expect(eucCode(text.charCodeAt(0))).toBe(0xfaa1);
    });

    test('87・88 区は DRCS。開かずに残す', () => {
        const text = decodeEuc(bytes(0xf7, 0xa1));
        expect(isDrcs(text.charCodeAt(0))).toBe(true);
        expect(toDisplay(text)).toBe(text);
    });

    test('符号は往復する', () => {
        for (const code of [0xa1a1, 0xa4a2, 0xb0a1, 0xf4a6, 0xfaa1, 0xfefe]) {
            expect(eucCode(fromEucCode(code).charCodeAt(0))).toBe(code);
        }
        expect(fromEucCode(0x41)).toBe('A');
        // 中の持ち方でない本当の追加記号は知らない字 (〓)
        expect([...encodeEuc('あA⛌')].length).toBe(5);
        expect(encodeEuc(decodeEuc(bytes(0xa4, 0xa2, 0xfa, 0xa1)))).toEqual(bytes(0xa4, 0xa2, 0xfa, 0xa1));
    });

    test('知らない字は 〓 (0xA2AE)', () => {
        expect(eucCode('😀'.charCodeAt(0))).toBe(0xa2ae);
    });

    test('大小は EUC-JP の符号の順', () => {
        expect(compareEuc('ア', 'あ')).toBeGreaterThan(0);
        expect(compareEuc('あ', 'あい')).toBeLessThan(0);
        expect(compareEuc('Z', 'あ')).toBeLessThan(0);
    });
});

describe('EUC-JP の符号 (全角英数・記号・半角カナ・空き点)', () => {
    test('往復する', () => {
        for (const code of [0xa3c1, 0xa1aa, 0xa1ef, 0xa3f0, 0x8eb1, 0xf4a7, 0xa9a1]) {
            expect(eucCode(fromEucCode(code).charCodeAt(0))).toBe(code);
        }
    });

    test('全角英数は画面でもそのまま、空き点は 〓', () => {
        expect(toDisplay(decodeEuc(bytes(0xa3, 0xc1, 0xa1, 0xaa)))).toBe('Ａ！');
        expect(toDisplay(decodeEuc(bytes(0xa9, 0xa1)))).toBe('〓');
    });
});
