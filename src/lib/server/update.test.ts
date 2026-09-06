import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { config } from './config';
import { checkForUpdate, updateAvailable } from './update';

const original = { commit: config.commit, githubApi: config.githubApi };
afterEach(() => {
    Object.assign(config, original);
});

type Status = 'ahead' | 'behind' | 'identical' | 'diverged';

/**
 * GitHub の代わり。最新のリリースと、動いているコミットから見た前後を決めて渡す。
 * `release` が null なら「1 つも無い」(404)
 */
function github(release: Record<string, unknown> | null, status: Status = 'ahead') {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
        asked.push(url);
        if (url.endsWith('/releases/latest')) {
            return release === null ? new Response('', { status: 404 }) : Response.json(release);
        }
        if (url.includes('/compare/')) return Response.json({ status });
        return new Response('', { status: 500 });
    };
    return Object.assign(fetcher, { asked });
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    html_url: `https://github.com/danything/denpa/releases/tag/${tag}`,
    ...extra,
});

describe('新しい版の知らせ', () => {
    test('最新のリリースが動いているコミットより先なら出る。含んでいれば出ない', async () => {
        config.commit = 'abc1234';
        const gh = github(release('v1.8.0'), 'ahead');
        expect(await checkForUpdate(gh)).toEqual({
            version: 'v1.8.0',
            url: 'https://github.com/danything/denpa/releases/tag/v1.8.0',
        });
        expect(updateAvailable()?.version).toBe('v1.8.0');
        // 訊き方: 自分のコミット...リリースの札
        expect(gh.asked[1]).toContain('/compare/abc1234...v1.8.0');

        // main のほうが先 (リリースの後の main を動かしている) / 同じコミット
        expect(await checkForUpdate(github(release('v1.8.0'), 'behind'))).toBeNull();
        expect(await checkForUpdate(github(release('v1.8.0'), 'identical'))).toBeNull();
        // 枝分かれ (別の枝から出したリリース) は数えない
        expect(await checkForUpdate(github(release('v1.8.0'), 'diverged'))).toBeNull();
    });

    // リリースを消すと「最新」は 1 つ前になる。そこで知らせが引っ込む
    test('リリースが消えれば引っ込む。1 つも無ければ (404) も同じ', async () => {
        config.commit = 'abc1234';
        await checkForUpdate(github(release('v1.8.0'), 'ahead'));
        expect(updateAvailable()).not.toBeNull();
        expect(await checkForUpdate(github(release('v1.7.1'), 'behind'))).toBeNull();

        await checkForUpdate(github(release('v1.8.0'), 'ahead'));
        expect(await checkForUpdate(github(null))).toBeNull();
    });

    test('dev では見に行かない。試し版・下書きは数えない', async () => {
        config.commit = 'dev';
        const gh = github(release('v9.9.9'));
        expect(await checkForUpdate(gh)).toBeNull();
        expect(gh.asked).toHaveLength(0);

        config.commit = 'abc1234';
        const draft = github(release('v2.0.0', { draft: true }));
        expect(await checkForUpdate(draft)).toBeNull();
        expect(await checkForUpdate(github(release('v2.0.0', { prerelease: true })))).toBeNull();
        // 下書きなら compare まで訊かない
        expect(draft.asked).toHaveLength(1);
    });

    test('繋がらないことは 1 回だけ言い、いちど繋がれば (404 でも) また言う', async () => {
        config.commit = 'abc1234';
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
        config.commit = 'abc1234';
        await checkForUpdate(github(release('v1.8.0')));
        const failing = async () => {
            throw new Error('繋がらない');
        };
        expect((await checkForUpdate(failing))?.version).toBe('v1.8.0');
        expect((await checkForUpdate(github({ tag: 'v1.9.0' })))?.version).toBe('v1.8.0');
        const odd = async () => Response.json({ status: 'sideways' });
        expect((await checkForUpdate(odd))?.version).toBe('v1.8.0');
    });
});
