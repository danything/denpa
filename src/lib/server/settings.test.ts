import { describe, expect, test } from 'bun:test';
import { normalizePostalCode } from './settings';

/*
 * **郵便番号は、7桁揃っていなければ入れないほうがよい。**
 *
 * 放送のアプリはこれを読んで天気や地域のニュースの場所を決める
 * (`nvram://receiverinfo/zipcode`)。途中まで入った番号を渡すと
 * 「入っているが違う場所」として扱われるので、**空のほうがまだ分かる**。
 */
describe('郵便番号', () => {
    test('数字7桁はそのまま', () => {
        expect(normalizePostalCode('1000001')).toBe('1000001');
    });

    test('ハイフン付きでも同じに読む', () => {
        expect(normalizePostalCode('100-0001')).toBe('1000001');
        // 全角や空白を混ぜても、数字だけ拾えば同じ
        expect(normalizePostalCode(' 100 - 0001 ')).toBe('1000001');
    });

    test('7桁でなければ空にする', () => {
        expect(normalizePostalCode('100')).toBe('');
        expect(normalizePostalCode('10000012')).toBe('');
        expect(normalizePostalCode('')).toBe('');
        // 数字が1つも無いものも同じ
        expect(normalizePostalCode('とうきょう')).toBe('');
    });
});
