import { describe, expect, test } from 'bun:test';
import { buildThumbnailArgs, sidecarPaths } from './metadata';

describe('sidecarPaths', () => {
    test('拡張子を差し替えたパスになる (サムネは -poster.jpg)', () => {
        const paths = sidecarPaths('/library/番組/番組 - 2026-08-01 - 2130.mkv');
        expect(paths.thumbnail).toBe('/library/番組/番組 - 2026-08-01 - 2130-poster.jpg');
        expect(paths.dataBroadcast).toBe('/library/番組/番組 - 2026-08-01 - 2130.bml.jsonl');
        // .nfo はもう書かないが、置いてあった頃のものを片付けるために名前は覚えている
        expect(paths.nfo).toBe('/library/番組/番組 - 2026-08-01 - 2130.nfo');
    });
});

describe('buildThumbnailArgs', () => {
    test('位置ぴったりではなく thumbnail フィルタで代表のコマを選ぶ (CM明けの黒コマを掴まない)', () => {
        const args = buildThumbnailArgs('/library/番組/a.mkv', '/library/番組/a-poster.jpg', 130);
        const i = args.indexOf('-vf');
        // 縮小が先 (候補を全部持つフィルタなので、1080pのままだとGB単位で食う)
        expect(args[i + 1]).toMatch(/^scale=\d+:-1,thumbnail=\d+$/);
        expect(args).toContain('130');
        expect(args.at(-1)).toBe('/library/番組/a-poster.jpg');
    });

    test('負の位置は0に丸める', () => {
        expect(buildThumbnailArgs('/a.mkv', '/a-poster.jpg', -5)).toContain('0');
    });
});
