import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { config } from './config';
import { checkForUpdate, newer, parseVersion, updateAvailable } from './update';

const original = { version: config.version, githubApi: config.githubApi };
afterEach(() => {
    Object.assign(config, original);
});

/** GitHub の代わり。最新のリリースを決めて渡す。null なら「1 つも無い」(404) */
function github(release: Record<string, unknown> | null) {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
        asked.push(url);
        return release === null ? new Response('', { status: 404 }) : Response.json(release);
    };
    return Object.assign(fetcher, { asked });
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
        const gh = github(release('v1.8.0'));
        expect(await checkForUpdate(gh)).toEqual({
            version: 'v1.8.0',
            url: 'https://github.com/danything/denpa/releases/tag/v1.8.0',
        });
        expect(updateAvailable()?.version).toBe('v1.8.0');
        expect(gh.asked[0]).toBe(`${config.githubApi}/releases/latest`);
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
        expect(await checkForUpdate(github(null))).toBeNull();
    });

    test('dev では見に行かない。試し版・下書きは数えない', async () => {
        config.version = 'dev';
        const gh = github(release('v9.9.9'));
        expect(await checkForUpdate(gh)).toBeNull();
        expect(gh.asked).toHaveLength(0);

        config.version = 'v1.7.1';
        expect(await checkForUpdate(github(release('v2.0.0', { prerelease: true })))).toBeNull();
        expect(await checkForUpdate(github(release('v2.0.0', { draft: true })))).toBeNull();
        expect(await checkForUpdate(github(release('v2.0.0-rc1')))).toBeNull();
    });

    test('繋がらないことは 1 回だけ言い、いちど繋がれば (404 でも) また言う', async () => {
        config.version = 'v1.7.1';
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const failing = async () => {
                throw new Error('繋がらない');
            };
            await checkForUpdate(failing);
            await checkForUpdate(failing);
            expect(warn).toHaveBeenCalledTimes(1);
            await checkForUpdate(github(null));
            await checkForUpdate(failing);
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    test('繋がらない・形が違うときは、前に分かっていたことを持つ', async () => {
        config.version = 'v1.7.1';
        await checkForUpdate(github(release('v1.8.0')));
        const failing = async () => {
            throw new Error('繋がらない');
        };
        expect((await checkForUpdate(failing))?.version).toBe('v1.8.0');
        expect((await checkForUpdate(github({ tag: 'v1.9.0' })))?.version).toBe('v1.8.0');
        const odd = async () => new Response('', { status: 500 });
        expect((await checkForUpdate(odd))?.version).toBe('v1.8.0');
    });
});
