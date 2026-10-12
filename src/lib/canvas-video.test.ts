import { describe, expect, test } from 'bun:test';
import { decide, isTesla } from './canvas-video';

const TESLA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2026.32.1-abc123';
const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('互換モード (canvas で描く) を使うか', () => {
    test('テスラの印は `Tesla/<数字>`', () => {
        expect(isTesla(TESLA)).toBe(true);
        expect(isTesla(CHROME)).toBe(false);
        // 数字の付かない言葉だけでは印と見ない
        expect(isTesla(`${CHROME} TeslaFan/x`)).toBe(false);
        expect(isTesla(`${CHROME} Tesla/`)).toBe(false);
    });

    test('明示が無ければテスラだけ入', () => {
        expect(decide(null, TESLA)).toBe(true);
        expect(decide(null, CHROME)).toBe(false);
    });

    test('明示した値が UA の既定より勝つ', () => {
        expect(decide('off', TESLA)).toBe(false);
        expect(decide('on', CHROME)).toBe(true);
    });
});
