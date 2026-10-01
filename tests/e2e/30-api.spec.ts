import { expect, syncEpg, test } from './helpers';

/**
 * **外から使う口** (docs/api.md)。形を保つと約束しているので、名前と型をここで押さえる
 */
test.describe('外から使う口', () => {
    test('局の一覧と、ライブを HTTP で流す口', async ({ request, baseURL }) => {
        await syncEpg(request);
        const res = await request.get('/api/services');
        expect(res.status()).toBe(200);
        const services = await res.json();
        expect(services.length).toBeGreaterThan(0);
        const [first] = services;
        expect(first).toMatchObject({
            id: expect.any(Number),
            type: expect.any(String),
            name: expect.any(String),
        });
        expect(first.live).toBe(`api/services/${first.id}/live`);

        // 生の TS は焼かずに流す。頭は同期バイト 0x47
        const controller = new AbortController();
        const raw = await fetch(`${baseURL}/${first.live}?codec=raw`, { signal: controller.signal });
        expect(raw.status).toBe(200);
        expect(raw.headers.get('content-type')).toBe('video/mp2t');
        const reader = raw.body!.getReader();
        const { value } = await reader.read();
        expect(value?.[0]).toBe(0x47);
        controller.abort();

        /*
         * 焼くもの (h264 / av1 / ?audio=only) はここでは流さない。偽の ffmpeg は TS をそのまま返すだけで
         * fMP4 を作らないので、何も届かない。焼き方の引数は live.test.ts が押さえている
         */
        expect((await request.get('/api/services/1/live')).status()).toBe(404);
    });

    test('録画の一覧は配列で、files はコーデック付き', async ({ request }) => {
        const res = await request.get('/api/recordings?limit=5');
        expect(res.status()).toBe(200);
        const recordings = await res.json();
        expect(Array.isArray(recordings)).toBe(true);
        for (const rec of recordings) {
            expect(rec.audio).toBe(`api/recordings/${rec.id}/file?audio=only`);
            for (const file of rec.files) {
                expect(['av1', 'h264', 'mpeg2']).toContain(file.codec);
                expect(file.url).toBe(`api/recordings/${rec.id}/file?source=${file.source}`);
            }
        }
    });
});
