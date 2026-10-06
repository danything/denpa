import { BS_NO_LOGO } from '../fake/services';
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
        // いま放送中の番組。偽の番組表はいまを跨ぐ番組を持っているので、どこかの局には付く
        const now = services.find((s: { now: unknown }) => s.now !== null)?.now;
        expect(now).toMatchObject({
            id: expect.any(Number),
            title: expect.any(String),
            startAt: expect.any(Number),
            endAt: expect.any(Number),
            // 録画ボタンの印 (`POST /api/services/<id>/record`)
            reserved: expect.any(Boolean),
            recording: expect.any(Boolean),
        });
        // 選べる音声。番組表が何も言っていなくても「そのまま出す」1つは入る
        expect(now.audios.length).toBeGreaterThan(0);
        expect(now.audios[0]).toMatchObject({
            id: expect.any(String),
            stream: expect.any(Number),
            side: expect.stringMatching(/^(main|sub|both)$/),
            label: expect.any(String),
        });
        expect(now.startAt).toBeLessThanOrEqual(Date.now());
        expect(now.endAt).toBeGreaterThan(Date.now());

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

    /*
     * 録れる側 (予約が入る・2度押しても1本) は record-airing.test.ts が押さえる。ここで録らせると、
     * 同じ組の試験がチューナーを取り合う
     */
    test('いまの番組を録る口は、番組表に無ければ 404 と理由を返す', async ({ request }) => {
        await syncEpg(request);
        const json = { 'content-type': 'application/json' };
        const missing = await request.post(`/api/services/${BS_NO_LOGO.id}/record`, { headers: json });
        expect(missing.status()).toBe(404);
        expect((await missing.json()).message).toBe('いま流れている番組が番組表に見つかりません');
        expect((await request.post('/api/services/x/record', { headers: json })).status()).toBe(400);
    });

    test('録画の一覧は配列で、files はコーデック付き', async ({ request }) => {
        const res = await request.get('/api/recordings?limit=5');
        expect(res.status()).toBe(200);
        const recordings = await res.json();
        expect(Array.isArray(recordings)).toBe(true);
        for (const rec of recordings) {
            expect(rec.audio).toBe(`api/recordings/${rec.id}/file?audio=only`);
            // 続きの位置は、無ければ null (鍵ごと消さない)
            expect(rec).toHaveProperty('resumeMs');
            // 放送の音声の構成 (追っかけの ?audio=<id> で選ぶ)。空にはならない
            expect(rec.audios.length).toBeGreaterThan(0);
            expect(rec.audios[0]).toMatchObject({ id: expect.any(String), stream: expect.any(Number) });
            // 番組の中身は別の口 (テレビのアプリの詳細)
            const one = await (await request.get(`/api/recordings/${rec.id}/detail`)).json();
            expect(one).toMatchObject({
                id: rec.id,
                description: expect.any(String),
                extended: expect.any(Object),
            });
            for (const file of rec.files) {
                expect(['av1', 'h264', 'mpeg2']).toContain(file.codec);
                expect(file.url).toBe(`api/recordings/${rec.id}/file?source=${file.source}`);
            }
        }
    });
});
