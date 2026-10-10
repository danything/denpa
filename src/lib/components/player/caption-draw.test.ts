import { describe, expect, test } from 'bun:test';
import { textStyle } from './caption-draw';

const VS15 = String.fromCodePoint(0xfe0e);

describe('字幕の字を字で描く (textStyle)', () => {
    test('絵文字になりうる外字には VS15 を足す', () => {
        for (const char of ['⚡', '⛅', '🈚', '♨', '☎', '🅿', '❗', '⁉'])
            expect(textStyle(char)).toBe(`${char}${VS15}`);
    });

    test('ふつうの字と ASCII (数字や #) には足さない', () => {
        for (const char of ['あ', '日', '𠮷', 'A', '1', '#', '*', '→']) expect(textStyle(char)).toBe(char);
    });
});
