import { describe, expect, test } from 'bun:test';
import { downloadRequests, fetchId, kindOf, parseFetchId } from './offline-db';

describe('Background Fetch の登録ID', () => {
    test('作って読み戻せる', () => {
        expect(parseFetchId(fetchId(42, 'encoded'))).toEqual({ id: 42, source: 'encoded' });
        expect(parseFetchId(fetchId(7, 'alt'))).toEqual({ id: 7, source: 'alt' });
    });

    test('よそのIDは読まない', () => {
        expect(parseFetchId('rec-abc-encoded')).toBeNull();
        expect(parseFetchId('other-1-encoded')).toBeNull();
        expect(parseFetchId('rec-1-ts')).toBeNull();
    });
});

describe('落とすものの仕分け', () => {
    test('落とす一覧の全部が仕分けできる (取りこぼすと保存されない)', () => {
        for (const url of downloadRequests(42, 'encoded')) {
            expect(kindOf(url)).not.toBeNull();
        }
    });

    test('URL から種類が分かる', () => {
        expect(kindOf('https://x/api/recordings/42/file?source=encoded')).toBe('video');
        expect(kindOf('https://x/api/recordings/42/captions.sup')).toBe('captions');
        expect(kindOf('https://x/api/recordings/42/chapters')).toBe('chapters');
        expect(kindOf('https://x/api/recordings/42/databroadcast')).toBe('databroadcast');
        expect(kindOf('https://x/api/recordings/42/poster')).toBe('poster');
        expect(kindOf('https://x/api/recordings/42/frame')).toBeNull();
    });
});
