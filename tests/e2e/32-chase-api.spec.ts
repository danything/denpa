import { expect, reserveSoon, syncEpg, test } from './helpers';

/**
 * 追っかけ再生を HTTP で流す口 (`GET /api/recordings/<id>/chase`)。テレビのアプリ向け。
 *
 * 録っている最中の録画が一覧 (`GET /api/recordings`) に `recording: true` で出て、
 * その `chase` を開くと、生TSなら伸びているファイルを追い読みして流し続ける。
 * 焼き直し (`h264`) は画面の追っかけと同じ器を HTTP の fMP4 で流す
 */
test.describe('追っかけ再生の口', () => {
    test('録画中の録画が一覧に出て、生TSを追い読みで流し続ける', async ({ page, request, baseURL }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        await reserveSoon(page, request, 'BS');

        // 録り始めると、録画中のものとして一覧に出る
        type Item = { id: number; recording: boolean; chase: string | null; cmReliable: boolean };
        let item: Item | undefined;
        await expect(async () => {
            const list = (await (await request.get('/api/recordings')).json()) as Item[];
            item = list.find((rec) => rec.recording);
            expect(item).toBeDefined();
        }).toPass({ timeout: 120_000, intervals: [500] });
        const rec = item!;
        expect(rec.chase).toBe(`api/recordings/${rec.id}/chase`);
        // CM の判定はまだ走っていない (null) ので、観はじめに飛ばしてよい
        expect(rec.cmReliable).toBe(true);

        // 生TS: 頭は同期バイト 0x47。録っている間は伸びたぶんも届き続ける
        const controller = new AbortController();
        const raw = await fetch(`${baseURL}/${rec.chase}?codec=raw`, { signal: controller.signal });
        expect(raw.status).toBe(200);
        expect(raw.headers.get('content-type')).toBe('video/mp2t');
        const reader = raw.body!.getReader();
        const first = await reader.read();
        expect(first.value?.[0]).toBe(0x47);
        let bytes = first.value?.length ?? 0;
        const until = Date.now() + 3_000;
        while (Date.now() < until) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
        }
        expect(bytes).toBeGreaterThan(first.value?.length ?? 0);
        controller.abort();

        // 焼き直し: 画面の追っかけと同じ器 (fMP4)
        const encoded = new AbortController();
        const h264 = await fetch(`${baseURL}/${rec.chase}`, { signal: encoded.signal });
        expect(h264.status).toBe(200);
        expect(h264.headers.get('content-type')).toBe('video/mp4');
        encoded.abort();

        // 無い録画は 404
        expect((await request.get('/api/recordings/999999/chase')).status()).toBe(404);
    });
});
