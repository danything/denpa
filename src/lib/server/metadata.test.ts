import { describe, expect, test } from 'bun:test';
import { config } from './config';
import { buildThumbnailArgs, sidecarPaths, thumbnailPlace } from './metadata';

describe('sidecarPaths', () => {
    test('拡張子を差し替えたパスになる (サムネは -poster.jpg)', () => {
        const paths = sidecarPaths('/library/番組/番組 - 2026-08-01 - 2130.mkv');
        expect(paths.thumbnail).toBe('/library/番組/番組 - 2026-08-01 - 2130-poster.jpg');
        expect(paths.dataBroadcast).toBe('/library/番組/番組 - 2026-08-01 - 2130.bml.jsonl');
    });
});

describe('buildThumbnailArgs', () => {
    test('位置ぴったりではなく thumbnail フィルタで代表のコマを選ぶ (CM明けの黒コマを掴まない)', () => {
        const args = buildThumbnailArgs('/library/番組/a.mkv', '/library/番組/a-poster.jpg', { at: 130 });
        const i = args.indexOf('-vf');
        // 片方のフィールド → 正方形の画素に縮小 → 選ぶ (候補を全部持つフィルタなので、1080pのままだとGB単位で食う)
        expect(args[i + 1]).toMatch(/^field=top,setsar=[^,]+,scale=\d+:[^,]+,setsar=1,thumbnail=\d+$/);
        expect(args).toContain('130');
        expect(args).not.toContain('-t');
        expect(args.at(-1)).toBe('/library/番組/a-poster.jpg');
    });

    test('負の位置は0に丸める', () => {
        expect(buildThumbnailArgs('/a.mkv', '/a-poster.jpg', { at: -5 })).toContain('0');
    });

    test('読む長さと探りは入力より前に置く', () => {
        const args = buildThumbnailArgs('/a.ts', '/a-poster.jpg', { at: 10, limit: 20 }, ['-probesize', '1']);
        const input = args.indexOf('-i');
        expect(args.indexOf('-ss')).toBeLessThan(input);
        expect(args[args.indexOf('-t') + 1]).toBe('20');
        expect(args.indexOf('-t')).toBeLessThan(input);
        expect(args.indexOf('-probesize')).toBeLessThan(input);
    });
});

describe('thumbnailPlace (生TSの時刻で決める)', () => {
    const position = config.thumbnailPosition;

    test('CM 無し: 頭を捨てた所から数える', () => {
        expect(thumbnailPlace(1800, { skip: 0.93, kept: null, content: null })).toEqual({
            at: 0.93 + position,
        });
        // 短い番組は尺の1/3
        expect(thumbnailPlace(60, { skip: 0.5, kept: null, content: null })).toEqual({ at: 20.5 });
        // 生TSを渡さない (エンコードしない録画) なら動画の頭から
        expect(thumbnailPlace(1800)).toEqual({ at: position });
    });

    test('CM を切った: 残した区間をつないで数え、その区間の終わりまで読む', () => {
        // 焼いたものの頭は 30 秒 (前の CM と捨てた頭は入らない)
        const kept = [
            { start: 30, end: 30 + position / 2 },
            { start: 400, end: 1700 },
        ];
        const place = thumbnailPlace(1800, { skip: 0.93, kept, content: null });
        // 1つ目の区間で position/2 秒使い、残りを2つ目の頭から
        expect(place.at).toBeCloseTo(400 + position / 2);
        expect(place.limit).toBeCloseTo(1700 - (400 + position / 2));
    });

    test('CM を切った: 1つ目の区間で届くならそこから', () => {
        const place = thumbnailPlace(1800, { skip: 0, kept: [{ start: 12, end: 900 }], content: null });
        expect(place).toEqual({ at: 12 + position, limit: 900 - 12 - position });
    });

    test('CM を切った: 全部足しても届かなければ最後の区間の真ん中', () => {
        const place = thumbnailPlace(1800, {
            skip: 0,
            kept: [
                { start: 10, end: 20 },
                { start: 50, end: 70 },
            ],
            content: null,
        });
        expect(place).toEqual({ at: 60, limit: 10 });
    });

    test('CM を残した: 本編の最初の区間の頭から測り、区間の終わりまで読む', () => {
        expect(thumbnailPlace(1800, { skip: 0.93, kept: null, content: { start: 95.5, end: 700 } })).toEqual({
            at: 95.5 + position,
            limit: 700 - 95.5 - position,
        });
        // 区間が短ければ真ん中
        expect(thumbnailPlace(1800, { skip: 0.93, kept: null, content: { start: 100, end: 140 } })).toEqual({
            at: 120,
            limit: 20,
        });
    });

    test('切った区間があればそちらを使う (本編の区間より優先)', () => {
        const place = thumbnailPlace(1800, {
            skip: 0,
            kept: [{ start: 30, end: 900 }],
            content: { start: 500, end: 600 },
        });
        expect(place.at).toBe(30 + position);
    });
});
