import { describe, expect, test } from 'bun:test';
import { cmRedo, encodeSource } from './source';

describe('エンコードの元', () => {
    test('生TSがあればそれ', () => {
        expect(encodeSource({ ts_path: '/recorded/a.m2ts' })).toBe('/recorded/a.m2ts');
    });

    test('生TSが無ければ録り直せない', () => {
        // エンコード済みを元に録り直しても画質は戻らないので、ボタン自体を出さない
        expect(encodeSource({ ts_path: null })).toBeNull();
    });
});

describe('CM検出のやり直し', () => {
    const ts = '/recorded/a.m2ts';
    const mkv = '/encoded/a.mkv';

    test('生TSか焼いたものがあれば押せる', () => {
        expect(cmRedo({ ts_path: ts, library_path: null, cm_kept: null }).state).toBe('ok');
        expect(cmRedo({ ts_path: null, library_path: mkv, cm_kept: null }).state).toBe('ok');
    });

    test('読む元が無ければ出さない', () => {
        expect(cmRedo({ ts_path: null, library_path: null, cm_kept: null }).state).toBe('hidden');
    });

    test('CM を切って焼いたものは、生TSがあれば再エンコードを促し、無ければ理由を出して押せない', () => {
        const kept = [{ start: 0, end: 100 }];
        expect(cmRedo({ ts_path: ts, library_path: mkv, cm_kept: kept }).state).toBe('prompt');
        const blocked = cmRedo({ ts_path: null, library_path: mkv, cm_kept: kept });
        expect(blocked.state).toBe('disabled');
        expect('reason' in blocked && blocked.reason).toContain('生TS');
    });
});
