import { describe, expect, test } from 'bun:test';
import { FONT_IMMUTABLE, fontCacheControl } from './font.js';

describe('fontCacheControl', () => {
    test('版が入っている字と合えば1年持たせる', () => {
        expect(fontCacheControl('v2.1', 'v2.1')).toBe(FONT_IMMUTABLE);
        expect(FONT_IMMUTABLE).toBe('public, max-age=31536000, immutable');
    });

    test('版なしの URL は毎回確かめさせる (古い字が残らないように)', () => {
        expect(fontCacheControl(null, 'v2.1')).toBe('no-cache');
        expect(fontCacheControl('', 'v2.1')).toBe('no-cache');
    });

    test('版が食い違えば毎回確かめさせる', () => {
        expect(fontCacheControl('v2.0', 'v2.1')).toBe('no-cache');
    });

    test('入っている版が分からなければ毎回確かめさせる', () => {
        expect(fontCacheControl('v2.1', null)).toBe('no-cache');
        expect(fontCacheControl('', '')).toBe('no-cache');
    });
});
