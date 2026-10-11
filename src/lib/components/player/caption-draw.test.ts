import { describe, expect, test } from 'bun:test';
import type { CaptionPage, CaptionRun } from '../../caption-text';
import { inkSpan, textStyle } from './caption-draw';

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

describe('字の載っている縦の範囲 (inkSpan)', () => {
    const run = (y: number, h: number): CaptionRun => ({
        x: 0,
        y,
        w: 36,
        h,
        fx: 0,
        fy: 0,
        size: 36,
        scaleX: 1,
        text: 'あ',
        fg: '#fff',
        bg: 'transparent',
    });
    const page = (runs: CaptionRun[]): CaptionPage => ({ v: 1, plane: [960, 540], duration: null, runs });

    test('いちばん上の区画の上から、いちばん下の区画の下まで (面の高さの割合)', () => {
        expect(inkSpan(page([run(405, 54), run(459, 54)]))).toEqual([0.75, 0.95]);
    });

    test('字が無ければ [0, 0]、面からはみ出すぶんは切る', () => {
        expect(inkSpan(page([]))).toEqual([0, 0]);
        expect(inkSpan(page([run(-10, 20), run(530, 30)]))).toEqual([0, 1]);
    });
});
