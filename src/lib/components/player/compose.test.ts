import { describe, expect, test } from 'bun:test';
import { canCompose, captionDrawn, compose } from './compose';

/** 字幕の canvas の代わり。見るのは印と大きさだけ */
function canvas(drawn: boolean, width = 1920, height = 1080): HTMLCanvasElement {
    return { dataset: drawn ? { drawn: '' } : {}, width, height } as unknown as HTMLCanvasElement;
}

describe('小窓へ字幕を重ねる', () => {
    test('描いている印があり、大きさのある canvas だけ重ねる', () => {
        expect(captionDrawn(canvas(true))).toBe(true);
        expect(captionDrawn(canvas(false))).toBe(false);
        expect(captionDrawn(canvas(true, 0, 0))).toBe(false);
        expect(captionDrawn(null)).toBe(false);
    });

    test('口の無い環境では重ねない (字幕無しの小窓のまま)', () => {
        expect(canCompose()).toBe(false);
        expect(compose({} as MediaStreamTrack, () => null)).toBeNull();
    });
});
