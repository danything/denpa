import { afterEach, describe, expect, test } from 'bun:test';
import type { Fetched } from './bml-network';
import { forgetGrants, grant, relayAsset } from './hc-relay';

/*
 * 中継の通る道。取りに行く先を差し替え、合言葉の配信元の同じ経路を取ること・返りに sandbox の CSP を付けること・
 * 失敗の返りを溜めないことを見る
 */
const fetched: string[] = [];
const fetcher =
    (status: number) =>
    async (url: string): Promise<Fetched> => {
        fetched.push(url);
        return { status, contentType: 'text/javascript', body: new TextEncoder().encode('ok()') };
    };

afterEach(() => {
    forgetGrants();
    fetched.length = 0;
});

describe('Hybridcast の中継', () => {
    test('合言葉の配信元の同じ経路を取り、sandbox の CSP と nosniff を付けて返す', async () => {
        const response = await relayAsset(grant('http://hc.example.jp'), 'p/index.js', '?v=2', fetcher(200));
        expect(fetched).toEqual(['http://hc.example.jp/p/index.js?v=2']);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok()');
        expect(response.headers.get('content-type')).toBe('text/javascript');
        expect(response.headers.get('content-security-policy')).toBe('sandbox');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    });

    test('配信元の失敗の返りは溜めない', async () => {
        const response = await relayAsset(grant('http://hc.example.jp'), 'p/index.js', '', fetcher(503));
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    test('知らない合言葉では取りに行かない', async () => {
        await expect(relayAsset('0'.repeat(32), 'p/index.js', '', fetcher(200))).rejects.toMatchObject({
            status: 404,
        });
        expect(fetched).toEqual([]);
    });
});
