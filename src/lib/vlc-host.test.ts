import { describe, expect, test } from 'bun:test';
import { normalizeVlcHost } from './vlc-host';

describe('normalizeVlcHost', () => {
    test('素のIPにはVLCの既定ポート (8080) を補う', () => {
        expect(normalizeVlcHost('192.168.1.20')).toBe('192.168.1.20:8080');
    });

    test('ポート付きはそのまま', () => {
        expect(normalizeVlcHost('192.168.1.20:9000')).toBe('192.168.1.20:9000');
    });

    test('http:// 付きで貼っても剥がす。ポート補完もその後に効く', () => {
        // ブラウザのアドレス欄からの貼り付けで一番よくある形
        expect(normalizeVlcHost('http://192.168.1.20')).toBe('192.168.1.20:8080');
        expect(normalizeVlcHost('https://192.168.1.20:8443/')).toBe('192.168.1.20:8443');
    });

    test('後ろのパスは落とす', () => {
        expect(normalizeVlcHost('192.168.1.20:8080/play')).toBe('192.168.1.20:8080');
    });

    test('読める形にならなければ空', () => {
        expect(normalizeVlcHost('')).toBe('');
        expect(normalizeVlcHost('  ')).toBe('');
        expect(normalizeVlcHost(':8080')).toBe('');
        expect(normalizeVlcHost('http://')).toBe('');
    });

    test('設定の書式の区切り (, = #) が混ざったものは読めない扱い', () => {
        // 通すと保存 → 読み直しでカンマで割れてゴミに化ける (parseTargets)
        expect(normalizeVlcHost('a,b')).toBe('');
        expect(normalizeVlcHost('a=b')).toBe('');
        expect(normalizeVlcHost('a#ts')).toBe('');
    });
});
