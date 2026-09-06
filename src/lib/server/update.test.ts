import { afterEach, describe, expect, test } from 'bun:test';
import { config } from './config';
import { checkForUpdate, newer, parseVersion, updateAvailable } from './update';

const original = { version: config.version, releasesUrl: config.releasesUrl };
afterEach(() => {
    Object.assign(config, original);
});

/** GitHub の代わり。1 回ぶんの答えを決めて渡す */
function github(body: unknown, status = 200) {
    return async () => (status === 200 ? Response.json(body) : new Response('', { status }));
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    html_url: `https://github.com/danything/denpa/releases/tag/${tag}`,
    ...extra,
});

describe('版の札', () => {
    test('v 付きでも無しでも読む。試し版と dev は読めない', () => {
        expect(parseVersion('v1.7.1')).toEqual([1, 7, 1]);
        expect(parseVersion('1.10.0')).toEqual([1, 10, 0]);
        expect(parseVersion('v2.0.0-rc1')).toBeNull();
        expect(parseVersion('dev')).toBeNull();
    });

    test('数で比べる (文字の並びではない)', () => {
        expect(newer([1, 10, 0], [1, 9, 9])).toBe(true);
        expect(newer([1, 7, 1], [1, 7, 1])).toBe(false);
        expect(newer([1, 7, 0], [1, 7, 1])).toBe(false);
    });
});

describe('新しい版の知らせ', () => {
    test('向こうが新しければ出る。同じ・古ければ出ない', async () => {
        config.version = 'v1.7.1';
        expect(await checkForUpdate(github(release('v1.8.0')))).toEqual({
            version: 'v1.8.0',
            url: 'https://github.com/danything/denpa/releases/tag/v1.8.0',
        });
        expect(updateAvailable()?.version).toBe('v1.8.0');
        expect(await checkForUpdate(github(release('v1.7.1')))).toBeNull();
        expect(await checkForUpdate(github(release('v1.7.0')))).toBeNull();
    });

    // リリースを消すと「最新」は 1 つ前になる。そこで知らせが引っ込む
    test('リリースが消えれば引っ込む。1 つも無ければ (404) も同じ', async () => {
        config.version = 'v1.7.1';
        await checkForUpdate(github(release('v1.8.0')));
        expect(updateAvailable()).not.toBeNull();
        expect(await checkForUpdate(github(release('v1.7.1')))).toBeNull();

        await checkForUpdate(github(release('v1.8.0')));
        expect(await checkForUpdate(github(null, 404))).toBeNull();
    });

    test('dev では見に行かない。試し版・下書きは数えない', async () => {
        config.version = 'dev';
        let asked = 0;
        const counting = async () => {
            asked++;
            return Response.json(release('v9.9.9'));
        };
        expect(await checkForUpdate(counting)).toBeNull();
        expect(asked).toBe(0);

        config.version = 'v1.7.1';
        expect(await checkForUpdate(github(release('v2.0.0', { prerelease: true })))).toBeNull();
        expect(await checkForUpdate(github(release('v2.0.0', { draft: true })))).toBeNull();
        expect(await checkForUpdate(github(release('v2.0.0-rc1')))).toBeNull();
    });

    test('繋がらない・形が違うときは、前に分かっていたことを持つ', async () => {
        config.version = 'v1.7.1';
        await checkForUpdate(github(release('v1.8.0')));
        const failing = async () => {
            throw new Error('繋がらない');
        };
        expect((await checkForUpdate(failing))?.version).toBe('v1.8.0');
        expect((await checkForUpdate(github({ tag: 'v1.9.0' })))?.version).toBe('v1.8.0');
        expect((await checkForUpdate(github(null, 500)))?.version).toBe('v1.8.0');
    });
});
